import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {migrate} from '../../packages/db/migrate';
import {closePool,configureTenantVertical,receiveWork,withTenant,createWorkEventWaitTx} from '@finnor/db';
import {createDeal,createInvestmentCase,createUnderwritingModel,createUnderwritingModelVersion,createUnderwritingRun,attachWorkToDealGraph} from '@finnor/private-equity';
import {FinnorOrchestrator,executeTenantOperationalQuery,startWorkObjective,evaluateObjectiveSuccessCondition,inspectCurrentObjectiveSuccessState,parseObjectiveSuccessCondition} from '@finnor/orchestration';
import {driveDurableAction} from '../../tests/integration/helpers/durable-action';

const directory=await mkdtemp(join(tmpdir(),'finnor-acquisition-'));
const evidence=resolve(process.env.FINNOR_ACQUISITION_EVIDENCE??join(directory,'evidence'));
await mkdir(evidence,{recursive:true});
const results:Array<Record<string,unknown>>=[];
const tenant=randomUUID(),actor=randomUUID(),target=randomUUID();
const ctx={auth:{tenantId:tenant,userId:actor,employeeId:actor,role:'owner' as const},provenance:{sourceSystem:'acquisition:e2e',createdBy:actor}};
const execute=promisify(execFile);
let postgres:EmbeddedPostgres|undefined,admin:pg.Client|undefined;
try{
 process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';process.env.NODE_ENV='test';process.env.AUTH_DEV_BYPASS='1';
 const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>a&&typeof a!=='string'?yes(a.port):no(Error('PORT_UNAVAILABLE')));});});
 postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'fixture',port,persistent:false,onLog:()=>undefined});
 await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('acquisition');
 const base=`127.0.0.1:${port}/acquisition`;
 async function runWorker(){const child=await execute(process.execPath,['--import=tsx','scripts/acquisition/decision-worker.mts'],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',DATABASE_URL:`postgres://finnor_worker:worker_fixture@${base}`},timeout:90000,maxBuffer:1048576});await appendFile(join(evidence,'workers.log'),child.stdout+child.stderr);await writeFile(join(evidence,'jobs.json'),JSON.stringify((await admin!.query('SELECT type,status,last_error,attempts FROM finnor_os.jobs WHERE tenant_id=$1',[tenant])).rows,null,2));}
 await migrate(`postgres://finnor:fixture@${base}`);
 admin=new pg.Client({connectionString:`postgres://finnor:fixture@${base}`});await admin.connect();
 await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'fixture';ALTER ROLE finnor_worker LOGIN PASSWORD 'worker_fixture'");
 await admin.query("SET app.test_vertical_mode='explicit'");
 await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Acquisition decision E2E')",[tenant,randomUUID()]);
 await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[actor,tenant,`${actor}@test.invalid`]);
 await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'atlas','Atlas Software','other')",[target,tenant]);
 process.env.DATABASE_URL=`postgres://finnor_app:fixture@${base}`;await closePool();
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:actor,sourceSystem:'acquisition:e2e'});
 const deal=await createDeal(ctx,{targetOrganizationId:target,name:'Atlas acquisition',dealLeadEmployeeId:actor,signedLoiAt:new Date('2026-01-01'),targetClosingAt:new Date('2026-12-31')});
 const dealId=String(deal.row.id),investment=await createInvestmentCase(ctx,{dealId,title:'Atlas acquisition decision'});
 const investmentCaseId=String(investment.row.id);
 const model=await createUnderwritingModel(ctx,{investmentCaseId,modelKey:'acquisition_cashflows',name:'One-period acquisition cash flows'});
 const shape={valueType:'decimal' as const,unit:'money' as const,currency:'USD',shape:'scalar' as const};
 const input=(id:string)=>({id,kind:'input' as const,...shape,required:true,dependencies:[],source:{kind:'model_parameter' as const}});
 const ref=(nodeId:string)=>({op:'ref' as const,nodeId});
 const subtract=(id:string,a:string,b:string)=>({id,kind:'expression' as const,...shape,dependencies:[a,b],expression:{op:'subtract' as const,args:[ref(a),ref(b)]}});
 const definition={schemaVersion:'underwriting-model-ir.v1' as const,modelKey:'acquisition_cashflows',modelVersion:'1',financialConventionVersion:'finnor-pe-lbo/1.0.0',minimumEngineVersion:'finnor-underwriting-engine/1.0.0',periodDefinition:{frequency:'annual' as const,forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[input('price'),input('debt'),input('financing_cost'),{id:'exit_value',kind:'constant' as const,...shape,dependencies:[],value:'150',truthClass:'MODEL_PARAMETER' as const},subtract('entry_equity','price','debt'),subtract('exit_equity','exit_value','debt'),subtract('before_cost','exit_equity','entry_equity'),subtract('profit','before_cost','financing_cost'),{id:'profit_output',kind:'output' as const,...shape,dependencies:['profit'],sourceNodeId:'profit'},{id:'equity_output',kind:'output' as const,...shape,dependencies:['entry_equity'],sourceNodeId:'entry_equity'}]};
 const version=await createUnderwritingModelVersion(ctx,{modelId:String(model.id),definition:definition as Parameters<typeof createUnderwritingModelVersion>[1]['definition']});
 const worldAt=new Date().toISOString();
 const baseRun=await createUnderwritingRun(ctx,{investmentCaseId,modelVersionId:String(version.id),worldAt,idempotencyKey:'acquisition-base',explicitInputs:{price:{value:'100',truthClass:'MODEL_PARAMETER'},debt:{value:'0',truthClass:'MODEL_PARAMETER'},financing_cost:{value:'0',truthClass:'MODEL_PARAMETER'}}});
 const objective='Evaluate Atlas, determine maximum bid and compare financing under the stated constraints';
 const work=await receiveWork({tenantId:tenant,userId:actor,instruction:objective,channel:'console',activeContext:{entityType:'pe_deal',entityId:dealId}});
 const successCondition=parseObjectiveSuccessCondition({version:1,statement:objective,mode:'all',source:'explicit',criteria:[{kind:'no_open_execution'},{kind:'all_objective_effects_verified',minimumCount:0},{kind:'decision_evidence',minimumCount:1,accepted:['canonical_query','business_effect']}]});
 const loop=await startWorkObjective(objective,ctx.auth,{workId:work.workId,workInputId:work.workInputId,instructionId:work.instructionId,channel:'console',successCondition,deferInitialIteration:true});
 const request={dealId,workId:work.workId,baseRunId:baseRun.id,idempotencyKey:'same-acquisition-decision',bidDomain:{nodeId:'price',currency:'USD',values:['90','100','110','120']},financingCases:[{key:'cash',name:'Cash only',overrides:[{nodeId:'debt',value:'0',reason:'Declared cash case'},{nodeId:'financing_cost',value:'0',reason:'No borrowing cost'}]},{key:'debt50',name:'Debt50 with cost5',overrides:[{nodeId:'debt',value:'50',reason:'Declared financing case'},{nodeId:'financing_cost',value:'5',reason:'Declared financing cost'}]},{key:'debt70',name:'Debt70 with cost12',overrides:[{nodeId:'debt',value:'70',reason:'Declared financing case'},{nodeId:'financing_cost',value:'12',reason:'Declared financing cost'}]}],constraints:[{outputNodeId:'profit_output',operator:'gte',threshold:'35',unit:'money',currency:'USD'},{outputNodeId:'equity_output',operator:'lte',threshold:'60',unit:'money',currency:'USD'}]};
 const post=(await import('../../apps/api/app/api/company-brain/[operation]/route')).POST;
 const api=async(operation:string,body:unknown)=>{const response=await post(new Request('http://localhost/api/company-brain/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':tenant,'x-user-id':actor},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});return {status:response.status,body:await response.json()};};
 await writeFile(join(evidence,'inputs.json'),JSON.stringify({definition,request,expected:{maximumBid:'110',financing:'debt50',candidateCount:12},roleBoundary:{api:'finnor_app',worker:'finnor_worker'}},null,2));
 const submitted=await api('acquisition-evaluate',request);assert.equal(submitted.status,202,JSON.stringify(submitted));
 const replay=await api('acquisition-evaluate',request);assert.equal(replay.status,202);assert.equal(replay.body.decisionId,submitted.body.decisionId);
 await runWorker();
 const observed=await api('acquisition-read',{decisionId:submitted.body.decisionId});
 assert.equal(observed.status,200,JSON.stringify(observed));assert.equal(observed.body.status,'TESTED',JSON.stringify(observed));
 assert.equal(observed.body.result.maximumBid.value,'110');assert.equal(observed.body.result.maximumBid.financingCaseKey,'debt50');
 assert.equal(observed.body.result.maximumBid.qualification,'MAXIMUM_IN_DECLARED_FINITE_DOMAIN');
 assert.equal(observed.body.result.candidates.length,12);
 assert.equal(observed.body.result.candidates.find((c:any)=>c.bid==='120'&&c.financingCaseKey==='debt50').feasible,false);
 assert.equal(observed.body.result.executionAuthorityGranted,false);
 assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.acquisition_decisions WHERE tenant_id=$1',[tenant])).rows[0].n,1);
 const changed=await api('acquisition-evaluate',{...request,constraints:[{...request.constraints[0],threshold:'999'}]});assert.equal(changed.status,409);
 results.push({id:'financial-decision-through-api-and-worker',status:'PASS',submitted,replay,observed,changed});
 await (await import('./recovery-e2e.mts')).acquisitionRecoveryE2E({admin,ctx,tenant,actor,request,baseRun,work,api,runWorker,results});
 // Independent contract: a governed start action creates a queued analysis,
 // never a completed investment decision. The registered current-Work reader
 // must expose the actual financial worker's result, with no new Work lifecycle.
 const roleId=randomUUID(),policyId=randomUUID();
 await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Acquisition E2E authority')",[roleId,tenant,'acquisition-'+roleId]);
 await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)",[tenant,actor,roleId,JSON.stringify({kind:'tenant'})]);
 await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'*','*','allow','high',false)",[tenant,roleId]);
 await admin.query("INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation,version,effective_from) VALUES($1,$2,'start_acquisition_evaluation','{}',false,1,now())",[policyId,tenant]);
 await admin.query("INSERT INTO finnor_os.domain_policy_revisions(id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from) VALUES($1,$2,$3,'start_acquisition_evaluation',1,'{}',false,now())",[randomUUID(),tenant,policyId]);
 await attachWorkToDealGraph(ctx,{dealId,workId:work.workId,entities:[{entityType:'pe_deal',entityId:dealId,relationship:'about'}]});
 const queryOptions={userId:actor,employeeId:actor,workId:work.workId,workInputId:work.workInputId};
 const workspace=await executeTenantOperationalQuery(tenant,{intent:'acquisition_decision_v1',dealId,workId:work.workId,investmentCaseId},queryOptions);
 assert.equal(workspace.status,'ok');assert.equal(workspace.data.status,'WORKSPACE');assert(workspace.execution?.id);
 await assert.rejects(executeTenantOperationalQuery(tenant,{intent:'acquisition_decision_v1',dealId,workId:work.workId},{}),/AUTHENTICATED/);
 const {workId:_workId,idempotencyKey:_key,...actionPayload}=request;
 const orchestrator=new FinnorOrchestrator();
 const drafted=await orchestrator.draftKnownAction('start_acquisition_evaluation',actionPayload,tenant,{workId:work.workId,initiatedBy:actor,source:'acquisition:e2e'});
 assert.equal(drafted.result.status,'success',JSON.stringify(drafted));assert.equal(drafted.result.output.queued,true);
 const executed=await driveDurableAction(tenant,drafted.action.id);
 await writeFile(join(evidence,'governed-action-trace.json'),JSON.stringify({actionId:drafted.action.id,executed,receipts:(await admin.query('SELECT * FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND domain_action_id=$2',[tenant,drafted.action.id])).rows,effect:(await admin.query('SELECT effect,verification FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2',[tenant,drafted.action.id])).rows},null,2));
 assert.equal(executed.status,'success',JSON.stringify(executed));
 assert.equal(executed.output.canonicalMutationOwner,'submitAcquisitionDecision');assert.equal(executed.output.workAttachment,'acquisition_decision_work_id');
 const queued=executed.output.canonicalState as Record<string,unknown>;
 assert.equal(queued.status,'QUEUED');assert.equal(queued.result,null);assert.equal(queued.workId,work.workId);
 const decisionId=String(queued.decisionId);
 const plannerDiscovery=await (await import('./planner-e2e.mts')).acquisitionPlannerE2E({ctx,orchestrator,objective,work,dealId,decisionId,successCondition,admin,tenant,evidence});
 results.push({id:'canonical-planner-reader-discovery',status:'PASS',...plannerDiscovery});
 const effect=(await admin.query('SELECT id FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2',[tenant,drafted.action.id])).rows[0];assert(effect);
 const verify=async(evidence:any[],stepNumber:number)=>evaluateObjectiveSuccessCondition({tenantId:tenant,workId:work.workId,loopId:loop.objectiveLoopId,stepNumber,condition:successCondition,inspection:await inspectCurrentObjectiveSuccessState(tenant,work.workId,loop.objectiveLoopId),evidence});
 // The actual durable action has a verified canonical receipt here. That proves
 // enqueue, not a financial outcome; a weak existence query cannot upgrade it.
 const acknowledgement=await verify([{kind:'business_effect',businessEffectId:effect.id}],1);
 assert.equal(acknowledgement.state,'unsatisfied',JSON.stringify(acknowledgement));
 const queryRequest={intent:'acquisition_decision_v1',dealId,workId:work.workId,decisionId};
 const pendingCompletion=await verify([{kind:'canonical_query',request:queryRequest,assertion:{path:['data','decisionId'],operator:'exists'}}],2);
 assert.equal(pendingCompletion.state,'unsatisfied',JSON.stringify(pendingCompletion));
 const stepId=randomUUID();
 await admin.query("INSERT INTO finnor_os.work_objective_steps(id,tenant_id,objective_loop_id,work_id,step_number,idempotency_key,phase,decision_kind,execution_state) VALUES($1,$2,$3,$4,1,'acquisition-native-wait','finished','wait','waiting')",[stepId,tenant,loop.objectiveLoopId,work.workId]);
 assert.deepEqual(queued.completionEvent,{eventType:'analysis.acquisition.terminal',resource:{type:'work',id:work.workId},correlationId:'acquisition:'+decisionId});
 const waiting=await withTenant(tenant,db=>createWorkEventWaitTx(db,{tenantId:tenant,workId:work.workId,objectiveLoopId:loop.objectiveLoopId,objectiveStepId:stepId,waitFor:queued.completionEvent as any,conditionSummary:'Read the exact acquisition result after its worker finishes',deadlineAt:new Date(String(queued.deadlineAt))}));
 // The wait and source-bound analysis outlive this API process's DB pool.
 await closePool();
 await runWorker();
 const selected=await executeTenantOperationalQuery(tenant,{intent:'acquisition_decision_v1',dealId,workId:work.workId,decisionId},queryOptions);
 assert.equal(selected.status,'ok',JSON.stringify(selected));assert.equal(selected.data.status,'TESTED');assert(selected.execution?.id);
 const financial=selected.data.result as Record<string,any>;
 assert.equal(financial.maximumBid.value,'110');assert.equal(financial.maximumBid.financingCaseKey,'debt50');assert.equal(financial.executionAuthorityGranted,false);
 const receipt=(await admin.query("SELECT finalized_at IS NOT NULL finalized,verification->>'state' state FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND domain_action_id=$2 ORDER BY created_at DESC LIMIT 1",[tenant,drafted.action.id])).rows[0];
 assert.deepEqual(receipt,{finalized:true,state:'verified'});
 const completed=await verify([{kind:'canonical_query',request:queryRequest,assertion:{path:['data','status'],operator:'eq',expected:'TESTED'}}],3);
 assert.equal(completed.state,'verified',JSON.stringify(completed));
 const wake=(await admin.query("SELECT w.status,e.event_type,e.resource_id::text,e.correlation_id,e.payload,count(c.id)::int claims,count(j.id)::int jobs FROM finnor_os.work_event_waits w JOIN finnor_os.integration_events e ON e.tenant_id=w.tenant_id AND e.id=w.matched_event_id JOIN finnor_os.work_wake_claims c ON c.tenant_id=w.tenant_id AND c.wait_id=w.id JOIN finnor_os.jobs j ON j.tenant_id=c.tenant_id AND j.id=c.job_id WHERE w.tenant_id=$1 AND w.id=$2 GROUP BY w.status,e.event_type,e.resource_id,e.correlation_id,e.payload",[tenant,waiting.wait.id])).rows[0];
 assert(wake,'The completed worker must atomically publish the durable wake');assert.equal(wake.status,'satisfied');assert.equal(wake.event_type,'analysis.acquisition.terminal');assert.equal(wake.resource_id,work.workId);assert.equal(wake.correlation_id,'acquisition:'+decisionId);assert.equal(wake.payload.status,'TESTED');assert.equal(wake.claims,1);assert.equal(wake.jobs,1);
 results.push({id:'governed-action-and-current-work-query',status:'PASS',actionId:drafted.action.id,workspace,executed,selected,receipt,acknowledgement,pendingCompletion,completed,waiting,wake,naturalLanguagePlannerVerified:false});
 await (await import('./planner-e2e.mts')).acquisitionParentDeadlineE2E({admin,ctx,tenant,actor,request,orchestrator,runWorker,evidence,results});
 await (await import('./planner-e2e.mts')).acquisitionFinancialContextE2E({ctx,tenant,actor,request,orchestrator,evidence,results,definition});
 if(process.env.FINNOR_ACQUISITION_REVIEW_BROWSER_FIXTURE==='1'){
  await (await import('../p1/browser-fixture.mts')).browserFixture({tenant,actor,ctx,companies:{A:target},series:{},observations:{},sourceRef:null,queue:null,repo:resolve(process.cwd(),'..'),admin,tickWorker:runWorker,
   acquisition:{dealId,workId:work.workId,decisionId,correct:()=>receiveWork({tenantId:tenant,userId:actor,workId:work.workId,instruction:'Replace the acquisition mandate after the held successful read',channel:'console',idempotencyKey:'browser-source-correction'})}});
 }else{
 // A queue delay must consume the original deadline. A worker may not restart
 // the time grant or leave an expired financial decision looking RUNNING.
 const expired=await api('acquisition-evaluate',{...request,idempotencyKey:'expired-acquisition',limits:{deadlineMs:1000,maxCandidates:12}});
 assert.equal(expired.status,202);
 await new Promise(resolve=>setTimeout(resolve,1100));
 await runWorker();
 const expiredRead=await api('acquisition-read',{decisionId:expired.body.decisionId});
 assert.equal(expiredRead.status,200);assert.equal(expiredRead.body.status,'FAILED',JSON.stringify(expiredRead));
 assert.equal(expiredRead.body.result,null);assert.equal(expiredRead.body.reason,'ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED');
 results.push({id:'original-deadline-survives-queue-delay',status:'PASS',expired,expiredRead});
 const invalidated=await api('acquisition-evaluate',{...request,idempotencyKey:'work-revision-before-claim'});assert.equal(invalidated.status,202);
 const next=await receiveWork({tenantId:tenant,userId:actor,workId:work.workId,instruction:'Change the acquisition mandate',channel:'console'});assert.notEqual(next.workInputId,work.workInputId);
 await runWorker();
 const invalidatedState=(await admin.query('SELECT status,result,failure FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND id=$2',[tenant,invalidated.body.decisionId])).rows[0];
 assert.equal(invalidatedState.status,'INVALIDATED');assert.equal(invalidatedState.result,null);assert.equal(invalidatedState.failure,'ACQUISITION_WORK_REVISION_CHANGED');
 const stale=await api('acquisition-read',{decisionId:submitted.body.decisionId});assert.equal(stale.status,409,JSON.stringify(stale));
 await assert.rejects(executeTenantOperationalQuery(tenant,{intent:'acquisition_decision_v1',dealId,workId:work.workId,decisionId},queryOptions),/WORK_REVISION_CHANGED/);
 results.push({id:'current-work-fence',status:'PASS',stale,invalidatedState});
 }
}catch(error){results.push({status:'FAIL',message:String(error),stack:(error as Error).stack});process.exitCode=1;}
finally{
 await writeFile(join(evidence,'results.json'),JSON.stringify({schema:'finnor.acquisition-decision-e2e.v1',command:'node --import=tsx scripts/acquisition/run-decision-e2e.mts',results,financialQualification:'MODEL_RELATIVE_FINITE_DOMAIN_NOT_REALIZED_PROFIT',productionAuthenticationVerified:false},null,2));
 await closePool();await admin?.end();await postgres?.stop().catch(()=>undefined);await rm(directory,{recursive:true,force:true});
 process.exitCode=results.some(r=>r.status==='FAIL')?1:0;console.log(JSON.stringify({evidence,status:process.exitCode?'FAIL':'PASS_LOCAL'}));
 if(process.exitCode)process.exit(process.exitCode);
}
