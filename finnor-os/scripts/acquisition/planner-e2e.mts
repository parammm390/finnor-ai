import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {LLMPlanner,executeTenantOperationalQuery} from '@finnor/orchestration';
import {beginWorkPlannerAttempt,receiveWork} from '@finnor/db';
import {attachWorkToDealGraph,createInvestmentCase,createUnderwritingModel,createUnderwritingModelVersion,getUnderwritingRun} from '@finnor/private-equity';
import {startWorkObjective,parseObjectiveSuccessCondition,LLMObjectiveDecisionPlanner} from '@finnor/orchestration';
import {inspectPrivateEquityIcBasis} from '../../packages/orchestration/src/private-equity-ic-basis';
import {selectAndMaterializePlan} from '../../packages/orchestration/src/plan-runtime';
import {driveDurableAction} from '../../tests/integration/helpers/durable-action';
import {assembleOperatingContext} from '../../packages/orchestration/src/operating-context';

/** The previous action E2E supplied a known action directly. It cannot detect
 * the main planner advertising a reader but withholding every runnable request.
 * This provider fixture selects a query, never supplies financial evidence. The
 * operating context, compiler, authorization and query owner are all production. */
export async function acquisitionPlannerE2E(e:any){
 const {ctx,orchestrator,objective,work,dealId,decisionId,successCondition,admin,tenant,evidence}=e;
 let captured:any=null;
 const wanted={intent:'acquisition_decision_v1' as const,dealId,workId:work.workId,decisionId};
 const provider:any={name:'planner-contract-fixture',complete:async(input:any)=>{
  captured=JSON.parse(input.user);const criteria=captured.goal.criteria;
  return JSON.stringify({candidates:[{version:1,candidateKey:'native-acquisition-read',nodes:[
   {key:'read',kind:'query',request:wanted,supports:criteria.filter((c:any)=>c.criterion.kind==='decision_evidence').map((c:any)=>c.id)},
   ...criteria.map((c:any,i:number)=>({key:'check_'+i,kind:'check',criterionId:c.id,dependsOn:['read']})),
  ]}]});
 }};
 const operating=await assembleOperatingContext(ctx.auth,{instruction:objective,workId:work.workId,activeContext:{entityType:'pe_deal',entityId:dealId},includeMemory:false,includeSemanticMemory:false,includeCanonicalBusinessState:false});
 const effects=(await admin.query('SELECT e.id,e.status,e.effect,e.verification FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a ON a.tenant_id=e.tenant_id AND a.id=e.domain_action_id WHERE e.tenant_id=$1 AND a.work_id=$2',[tenant,work.workId])).rows;
 const planner=new LLMPlanner(orchestrator.plugins,provider);
 const planning=await planner.plan(objective,ctx.auth,{shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null},{workId:work.workId,workInputId:work.workInputId,successCondition,channel:'console',operatingContext:operating.context,planningContext:{businessEffects:effects}});
 await writeFile(join(evidence,'canonical-planner-discovery.json'),JSON.stringify({captured,planning,wanted,modelInferenceQualified:false},null,2));
 assert(captured,'The actual main candidate proposer must be exercised');
 const reads=captured.snapshot.availableReads.map((r:any)=>r.request);
 assert(reads.some((r:any)=>r.intent==='acquisition_decision_v1'&&r.workId===work.workId&&r.dealId===dealId&&!r.decisionId),'The current financial workspace must be discoverable');
 assert(reads.some((r:any)=>r.intent===wanted.intent&&r.workId===wanted.workId&&r.dealId===wanted.dealId&&r.decisionId===wanted.decisionId),'The exact verified start receipt must make its decision readable');
 assert(planning.compilation.selected,JSON.stringify(planning.compilation));
 const graph=planning.compilation.selected.graph;assert(graph);
 const node=graph.nodes.find(n=>n.kind==='query');assert(node?.kind==='query');assert.deepEqual(node.request,wanted);
 const observed=await executeTenantOperationalQuery(tenant,node.request,{userId:ctx.auth.userId,employeeId:ctx.auth.employeeId,workId:work.workId,workInputId:work.workInputId});
 assert.equal(observed.data.decisionId,decisionId);assert.equal(observed.data.status,'QUEUED');assert.equal(observed.data.result,null);
 return {planning,observed,modelInferenceQualified:false};
}

export async function acquisitionParentDeadlineE2E(e:any){
 if(process.env.FINNOR_ACQUISITION_RECOVERY_CASE_FILTER&&process.env.FINNOR_ACQUISITION_RECOVERY_CASE_FILTER!=='parent-deadline')return;
 const {admin,ctx,tenant,actor,request,orchestrator,runWorker,evidence,results}=e;
 const objective='Evaluate the declared acquisition within the original plan deadline';
 const work=await receiveWork({tenantId:tenant,userId:actor,instruction:objective,channel:'console',activeContext:{entityType:'pe_deal',entityId:request.dealId}});
 await attachWorkToDealGraph(ctx,{dealId:request.dealId,workId:work.workId,entities:[{entityType:'pe_deal',entityId:request.dealId,relationship:'about'}]});
 const deadlineAt=new Date(Date.now()+30000);
 const successCondition=parseObjectiveSuccessCondition({version:1,statement:objective,mode:'all',source:'explicit',criteria:[{kind:'no_open_execution'},{kind:'decision_evidence',minimumCount:1,accepted:['canonical_query']}]});
 const loop=await startWorkObjective(objective,ctx.auth,{workId:work.workId,workInputId:work.workInputId,instructionId:work.instructionId,channel:'console',successCondition,deferInitialIteration:true,deadlineAt});
 const {workId:_work,idempotencyKey:_key,...mandate}=request;
 const payload={...mandate,bidDomain:{...request.bidDomain,values:['90']},financingCases:[request.financingCases[0]],limits:{deadlineMs:120000,maxCandidates:1}};
 const provider:any={name:'explicit-deadline-contract-proposer',complete:async(input:any)=>{
  const captured=JSON.parse(input.user);
  return JSON.stringify({candidates:[{version:1,candidateKey:'original-deadline',nodes:[
   {key:'evaluate',kind:'action',actionType:'start_acquisition_evaluation',payload,supports:captured.goal.criteria.map((c:any)=>c.id)},
   ...captured.goal.criteria.map((c:any,i:number)=>({key:'check_'+i,kind:'check',criterionId:c.id,dependsOn:['evaluate']})),
  ]}]});
 }};
 const operating=await assembleOperatingContext(ctx.auth,{instruction:objective,workId:work.workId,activeContext:{entityType:'pe_deal',entityId:request.dealId},includeMemory:false,includeSemanticMemory:false,includeCanonicalBusinessState:false});
 const attempt=await beginWorkPlannerAttempt({tenantId:tenant,workId:work.workId,workInputId:work.workInputId,attemptKey:'original-acquisition-deadline'});
 const planning=await new LLMPlanner(orchestrator.plugins,provider).plan(objective,ctx.auth,{shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null},{workId:work.workId,workInputId:work.workInputId,plannerAttemptId:attempt.id,planDeadlineAt:deadlineAt.toISOString(),successCondition,channel:'console',operatingContext:operating.context});
 assert(planning.compilation.selected,JSON.stringify(planning.compilation));
 const selected=await selectAndMaterializePlan({planning,tenantContext:ctx.auth,workId:work.workId,workInputId:work.workInputId,plannerAttemptId:attempt.id,objectiveLoopId:loop.objectiveLoopId,reason:'initial'});
 const node=planning.compilation.selected.graph?.nodes.find(n=>n.kind==='action');assert(node?.kind==='action');
 const actionId=selected.actions[0]!.id;
 const drafted=await orchestrator.draftKnownAction('start_acquisition_evaluation',node.groundedPayload,tenant,{actionId,workId:work.workId,initiatedBy:actor,source:'controlled-deadline-planner',planRevisionId:selected.planRevisionId,planNodeId:node.id,plannerAttemptId:attempt.id});
 const pending=(await admin.query('SELECT status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2',[tenant,actionId])).rows[0];
 if(pending.status==='pending'){
  const effect=(await admin.query('SELECT semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2',[tenant,actionId])).rows[0];
  const approved=await orchestrator.decide(actionId,tenant,'approve',actor,{role:'owner',expectedEffectHash:effect.semantic_hash,typedConfirmation:true});assert.equal(approved.status,'success',JSON.stringify(approved));
 }
 const executed=await driveDurableAction(tenant,actionId);assert.equal(executed.status,'success',JSON.stringify({drafted,executed}));
 const accepted=(await admin.query('SELECT id,request,deadline_at,parent_action_id,parent_plan_revision_id,analysis_program_id FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,actionId])).rows[0];assert(accepted);
 const parent=(await admin.query('SELECT constraint_set FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',[tenant,selected.planRevisionId])).rows[0];
 const proof:any={id:'parent-deadline',status:'RUNNING',work,actionId,selected,executed,accepted,parent,expected:{deadlineAt:deadlineAt.toISOString(),terminalStatus:'FAILED',failure:'ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED',candidateRuns:0,analysisPrograms:0},modelInferenceQualified:false};
 await writeFile(join(evidence,'parent-deadline.json'),JSON.stringify(proof,null,2));
 await new Promise(yes=>setTimeout(yes,Math.max(0,deadlineAt.getTime()-Date.now()+25)));
 await runWorker();
 const observed=(await admin.query('SELECT status,result,failure,deadline_at,parent_action_id,parent_plan_revision_id,analysis_program_id FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND id=$2',[tenant,accepted.id])).rows[0];
 const candidateRuns=(await admin.query('SELECT count(*)::int n FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n;
 Object.assign(proof,{status:observed.status==='FAILED'&&observed.failure==='ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED'&&candidateRuns===0?'PASS':'FAIL',observed,candidateRuns});
 results.push(proof);await writeFile(join(evidence,'parent-deadline.json'),JSON.stringify(proof,null,2));
 assert.equal(observed.status,'FAILED',JSON.stringify(proof));assert.equal(observed.failure,'ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED');assert.equal(observed.result,null);
 assert.equal(candidateRuns,0);assert.equal(accepted.analysis_program_id,null);assert.equal(accepted.parent_action_id,actionId);assert.equal(accepted.parent_plan_revision_id,selected.planRevisionId);
 assert(new Date(accepted.deadline_at).getTime()<=deadlineAt.getTime());
}

export async function acquisitionFinancialContextE2E(e:any){
 if(process.env.FINNOR_ACQUISITION_RECOVERY_CASE_FILTER&&process.env.FINNOR_ACQUISITION_RECOVERY_CASE_FILTER!=='financial-context')return;
 const {ctx,tenant,actor,request,orchestrator,evidence,results,definition}=e;
 const privateText='buyer@test.invalid; +1 (515) 555-0199; 123-45-6789';
 const investment=await createInvestmentCase(ctx,{dealId:request.dealId,title:'Billion-dollar financials '+privateText});
 const investmentCaseId=String(investment.row.id),modelKey='billion_financial_context';
 const model=await createUnderwritingModel(ctx,{investmentCaseId,modelKey,name:'Exact billion-dollar financial input'});
 const shape={valueType:'decimal' as const,unit:'money' as const,currency:'USD',shape:'scalar' as const};
 const modelDefinition={...definition,modelKey,nodes:[
  {id:'operating.revenue_explicit',kind:'input' as const,...shape,required:true,dependencies:[],source:{kind:'model_parameter' as const}},
  {id:'revenue_output',kind:'output' as const,...shape,dependencies:['operating.revenue_explicit'],sourceNodeId:'operating.revenue_explicit'},
 ]};
 const version=await createUnderwritingModelVersion(ctx,{modelId:String(model.id),definition:modelDefinition});
 const objective='Evaluate the exact registered billion-dollar financial input. Contact reference +1 (212) 555-0100.';
 const work=await receiveWork({tenantId:tenant,userId:actor,instruction:objective,channel:'console',activeContext:{entityType:'pe_deal',entityId:request.dealId}});
 await attachWorkToDealGraph(ctx,{dealId:request.dealId,workId:work.workId,entities:[{entityType:'pe_deal',entityId:request.dealId,relationship:'about'}]});
 const successCondition=parseObjectiveSuccessCondition({version:1,statement:objective,mode:'all',source:'explicit',criteria:[{kind:'decision_evidence',minimumCount:1,accepted:['canonical_query']}]});
 await startWorkObjective(objective,ctx.auth,{workId:work.workId,workInputId:work.workInputId,instructionId:work.instructionId,channel:'console',successCondition,deferInitialIteration:true});
 const input={investmentCaseId,modelVersionId:String(version.id),workId:work.workId,worldAt:new Date().toISOString(),idempotencyKey:'billion-financial-context',explicitInputs:{'operating.revenue_explicit':{value:'1000000000',truthClass:'MODEL_PARAMETER'}}};
 const post=(await import('../../apps/api/app/api/underwriting/runs/route')).POST;
 const response=await post(new Request('http://localhost/api/underwriting/runs',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':tenant,'x-user-id':actor},body:JSON.stringify(input)}));
 const persisted=await response.json();assert.equal(response.status,201,JSON.stringify(persisted));
 const run=await getUnderwritingRun(ctx,persisted.id);assert.equal((run.inputSnapshot as any).values['operating.revenue_explicit'].value,'1000000000');
 const basis=await inspectPrivateEquityIcBasis(ctx.auth,request.dealId,work.workId);
 const priorIterations=[{decisionKind:'complete',decision:{kind:'complete',outcome:{nodeId:'untrusted_model_output',valueType:'decimal',unit:'money',currency:'USD',shape:'scalar',value:'5155550199'}}}];
 let captured:any,objectiveCaptured:any,capturedSystem='',objectiveSystem='';
 const provider:any={name:'explicit-financial-context-proposer',complete:async(value:any)=>{
  captured=JSON.parse(value.user);capturedSystem=value.system;return JSON.stringify({candidates:[{version:1,candidateKey:'financial-workspace-read',nodes:[
   {key:'read',kind:'query',request:{intent:'acquisition_decision_v1',dealId:request.dealId,workId:work.workId,investmentCaseId},supports:captured.goal.criteria.map((c:any)=>c.id)},
   ...captured.goal.criteria.map((c:any,i:number)=>({key:'check_'+i,kind:'check',criterionId:c.id,dependsOn:['read']})),
  ]}]});
 }};
 const operating=await assembleOperatingContext(ctx.auth,{instruction:objective,workId:work.workId,activeContext:{entityType:'pe_deal',entityId:request.dealId},includeMemory:false,includeSemanticMemory:false,includeCanonicalBusinessState:false});
 const planning=await new LLMPlanner(orchestrator.plugins,provider).plan(objective,ctx.auth,{shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null},{workId:work.workId,workInputId:work.workInputId,successCondition,channel:'console',operatingContext:operating.context,planningContext:{privateEquityIcBasis:basis,priorIterations}});
 const objectiveProvider:any={name:'explicit-objective-financial-context',complete:async(value:any)=>{
  objectiveCaptured=JSON.parse(value.user);objectiveSystem=value.system;
  const instructionToken=objectiveCaptured.objective.match(/\[[^\]]+\]/)?.[0];assert(instructionToken);
  return JSON.stringify({kind:'block',reason:objectiveCaptured.canonicalInspection.priorIterations[0].decision.outcome.value,recovery:instructionToken});
 }};
 const inspection={inspectedAt:new Date().toISOString(),work:{...work},objective:{successCondition},companyGraph:{},businessState:run,privateEquityIcBasis:basis,executionAccess:{},computerRuns:[],delegations:[],acknowledgementRequests:[],eventWake:null,eventWaits:[],integrationEvents:[],queryExecutions:[],actions:[],businessEffects:[],operations:[],receipts:[],priorIterations};
 const objectiveDecision=await new LLMObjectiveDecisionPlanner(objectiveProvider).decide({objective,inspection,allowedActionTypes:[],actionPayloadSpec:'',remaining:{steps:1,actions:0,queries:1},tenantId:tenant,workId:work.workId,channel:'console'});
 const shown=captured?.planningContext?.privateEquityIcBasis?.recentRuns?.find((r:any)=>r.id===run.id)?.revenueInput;
 const objectiveShown=objectiveCaptured?.canonicalInspection?.privateEquityIcBasis?.recentRuns?.find((r:any)=>r.id===run.id)?.revenueInput;
 const rawControls=['buyer@test.invalid','515) 555-0199','123-45-6789','5155550199','212) 555-0100'];
 const privacy={planner:rawControls.every(v=>!(JSON.stringify(captured)+capturedSystem).includes(v)),objective:rawControls.every(v=>!(JSON.stringify(objectiveCaptured)+objectiveSystem).includes(v))};
 const computationInstant=new Date(run.computedAt as string).getTime();
 const freshness={planner:Date.parse(captured.planningContext.privateEquityIcBasis.recentRuns.find((r:any)=>r.id===run.id).computedAt)===computationInstant,objective:Date.parse(objectiveCaptured.canonicalInspection.privateEquityIcBasis.recentRuns.find((r:any)=>r.id===run.id).computedAt)===computationInstant,nativeDate:Date.parse(objectiveCaptured.canonicalInspection.businessState.computedAt)===computationInstant};
 assert.equal(objectiveDecision.kind,'block');
 const tokenIsolation={history:objectiveDecision.reason==='[PHONE_1]',instruction:objectiveDecision.kind==='block'&&objectiveDecision.recovery==='+1 (212) 555-0100'};
 const proof={id:'financial-context',status:shown?.value==='1000000000'&&objectiveShown?.value==='1000000000'&&privacy.planner&&privacy.objective&&Object.values(freshness).every(Boolean)&&Object.values(tokenIsolation).every(Boolean)?'PASS':'FAIL',input,run,captured,capturedSystem,objectiveCaptured,objectiveSystem,shown,objectiveShown,privacy,freshness,objectiveDecision,tokenIsolation,modelInferenceQualified:false,qualification:'Actual underwriting API and canonical IC-basis reader into actual production model-provider boundaries; supplied candidate and block response only, no live model or automatic-controller qualification.'};
 results.push(proof);await writeFile(join(evidence,'financial-context.json'),JSON.stringify(proof,null,2));
 assert.deepEqual(tokenIsolation,{history:true,instruction:true});
 assert.equal(shown?.value,'1000000000');assert.equal(objectiveShown?.value,'1000000000');assert.equal(privacy.planner,true);assert.equal(privacy.objective,true);
 assert.deepEqual(freshness,{planner:true,objective:true,nativeDate:true});
 assert(planning.compilation.selected,JSON.stringify(planning.compilation));
}
