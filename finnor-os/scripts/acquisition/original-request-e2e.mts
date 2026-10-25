import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {FinnorOrchestrator} from '@finnor/orchestration';
import {getUnderwritingRun} from '@finnor/private-equity';

export async function originalAcquisitionRequest(e:any){
 const {ctx,admin,root,work,output,request,http,worker,deadlineAt}=e,tenant=ctx.auth.tenantId,actor=ctx.auth.userId;
 const original=(await admin.query('SELECT instruction_id::text,instruction_text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND id=$2',[tenant,work.workInputId])).rows[0];assert(original);
 const economicRequirement={kind:'manual_verification',reason:'Realized economic outcome requires prospective S7 estimand and authenticated settlement, costs and measurements; synthetic financial profit is insufficient.'};
 const successCondition={version:1,statement:original.instruction_text,mode:'all',source:'explicit',criteria:[
  {kind:'no_open_execution'},
  {kind:'private_equity_ic_preparation',dealId:root.entityId,requireAcquisition:true,requireScenario:false},
  {kind:'canonical_query',request:{intent:'closing_readiness',dealId:root.entityId},assertion:{path:['verifiedClosing','status'],operator:'eq',expected:'CLOSED'}},
  economicRequirement,...(e.economicTracking?[{...economicRequirement}]:[]),
 ]};
 const budgets={maxSteps:96,maxActions:25,maxQueries:40,maxPlannerFailures:3,maxConsecutiveNoProgress:5,deadlineAt:new Date(deadlineAt).toISOString()};
 const input={mode:'approval',objective:original.instruction_text,subjectRefs:[root],successCondition,acquisitionRequest:request};
 const startBody={packId:'general_operator_objective',input,workId:work.workId,instructionId:original.instruction_id,idempotencyKey:'original-acquisition-'+original.instruction_id,channel:'console',budgets};
 // A reviewed request must not let its caller define away the original outcome
 // at first admission. Retry-only conflict checks cannot catch that boundary.
 const weakAdmissions=[];
 for(const criteria of [
  [{kind:'no_open_execution'}],
  successCondition.criteria.filter(c=>c.kind!=='private_equity_ic_preparation'),
  successCondition.criteria.map(c=>c.kind==='private_equity_ic_preparation'?{...c,requireAcquisition:false}:c),
  successCondition.criteria.filter(c=>c.kind!=='canonical_query'),
  successCondition.criteria.filter(c=>c.kind!=='manual_verification'),
 ]){
  const refused=await http.startPack({...startBody,input:{...input,successCondition:{...successCondition,criteria}}});
  weakAdmissions.push({criteria,refused});
  assert(refused.status>=400,JSON.stringify(refused));
  assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,0);
  assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.outcome_pack_runs WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,0);
 }
 await writeFile(join(output,'original-request-completion-refusals.json'),JSON.stringify(weakAdmissions,null,2));
 let missionSubmission:import('../../../src/components/centropy/thread/mission-submission').MissionSubmission|undefined;
 if(e.dropFirstPackResponse){
  const {MissionSubmission}=await import('../../../src/components/centropy/thread/mission-submission');
  const submission=new MissionSubmission({packId:startBody.packId,input,budgets},{threadId:undefined,dealId:root.entityId,instructionId:original.instruction_id,workId:work.workId});missionSubmission=submission;
  const body=submission.body;http.dropNextPackResponse();await assert.rejects(()=>http.startPack(body));
  submission.markUnconfirmed();assert(submission.isUnconfirmed);
  const retryBody=submission.body;assert.deepEqual(retryBody,body);Object.assign(startBody,retryBody);
  await writeFile(join(output,'guided-intake-failed-transport.json'),JSON.stringify({body,retryBody,observed:http.observed},null,2));
 }
 const accepted=await http.startPack(startBody);await writeFile(join(output,'original-request-admission.json'),JSON.stringify({startBody,accepted},null,2));
 assert([200,202].includes(accepted.status),JSON.stringify(accepted));
 if(missionSubmission){missionSubmission.confirm(accepted.body.outcomePack.workId);assert.equal(missionSubmission.acceptedWorkId,work.workId);assert.equal(missionSubmission.isUnconfirmed,false);assert.deepEqual(missionSubmission.body,startBody);}
 const pack=(await admin.query('SELECT * FROM finnor_os.outcome_pack_runs WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0];
 assert.deepEqual(pack.input.acquisitionRequest,request,'Original reviewed contract must survive actual API admission');
 assert.equal(pack.input.acquisitionAcceptance.workInputId,work.workInputId);assert.equal(pack.input.acquisitionAcceptance.principalId,actor);
 const loop=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0];assert(loop);
 const replay=await http.startPack(startBody);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.body.outcomePack.objectiveLoopId,loop.id);
 if(missionSubmission){assert.equal(missionSubmission.acceptedWorkId,work.workId);assert.equal(replay.body.outcomePack.workId,work.workId);assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.outcome_pack_runs WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,1);assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,1);}
 const conflicts=[];
 for(const body of [
  {...startBody,input:{...input,acquisitionRequest:{...request,acquisition:{...request.acquisition,bidDomain:{...request.acquisition.bidDomain,values:['1']}}}}},
  {...startBody,budgets:{...budgets,maxActions:24}},
  {...startBody,budgets:{...budgets,deadlineAt:new Date(deadlineAt+1000).toISOString()}},
  {...startBody,input:{...input,successCondition:{...successCondition,criteria:[{kind:'no_open_execution'}]}}},
  {...startBody,input:{...input,acquisitionAcceptance:{principalId:actor}}},
 ]){const refused=await http.startPack(body);conflicts.push(refused);assert(refused.status>=400,JSON.stringify(refused));}
 let immutable=false;
 try{await admin.query("UPDATE finnor_os.outcome_pack_runs SET input=jsonb_set(input,'{acquisitionRequest,acquisition,bidDomain,values}','[\"1\"]') WHERE tenant_id=$1 AND id=$2",[tenant,pack.id]);}catch{immutable=true;}
 assert(immutable,'Accepted acquisition request must be protected at durable owner');
 const approvals:any[]=[],workers:any[]=[],orchestrator=new FinnorOrchestrator();
 for(let batch=0;batch<20;batch++){
  const log=await worker();workers.push({batch,log});await appendFile(join(output,'original-controller-workers.log'),JSON.stringify(log)+'\n');
  const state=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2',[tenant,loop.id])).rows[0];
  const pending=(await admin.query("SELECT a.id,e.semantic_hash FROM finnor_os.domain_actions a JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id WHERE a.tenant_id=$1 AND a.work_id=$2 AND a.status='pending' ORDER BY a.created_at,a.id",[tenant,work.workId])).rows;
  for(const action of pending){const result=await orchestrator.decide(action.id,tenant,'approve',actor,{role:'owner',expectedEffectHash:action.semantic_hash,typedConfirmation:true});approvals.push({id:action.id,result});assert.equal(result.status,'success',JSON.stringify(result));}
  await writeFile(join(output,'original-controller-progress.json'),JSON.stringify({state,pending,approvals,workers},null,2));
  if(['blocked','failed','cancelled','completed'].includes(state.state))break;
  if(String(state.reason).includes('ACQUISITION_SOURCE_CUT_CHANGED'))break;
  if(state.state==='waiting'&&(await admin.query("SELECT 1 FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND deal_id=$2 AND state='READY_FOR_REVIEW'",[tenant,root.entityId])).rowCount)break;
 }
 const state=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2',[tenant,loop.id])).rows[0];
 const actions=(await admin.query('SELECT id,action_type,status,objective_step_id,plan_revision_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id',[tenant,work.workId])).rows;
 const steps=(await admin.query('SELECT * FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number,id',[tenant,loop.id])).rows;
 const queries=(await admin.query("SELECT * FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 AND execution_key LIKE $3 ORDER BY started_at,id",[tenant,work.workId,'objective:'+loop.id+':revision:%:step:%:decision-query'])).rows;
 const verificationQueries=(await admin.query("SELECT * FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 AND execution_key LIKE $3 ORDER BY started_at,id",[tenant,work.workId,'objective:'+loop.id+':step:%:success:%'])).rows;
 const decisions=(await admin.query('SELECT id::text FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows;
 const runtime={jobs:(await admin.query('SELECT id,type,status,last_error,attempts FROM finnor_os.jobs WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
  programmes:(await admin.query('SELECT id,status,reason,revision FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows,
  waits:(await admin.query('SELECT status,expected_event_type,matched_event_id,correlation_id FROM finnor_os.work_event_waits WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows,
  wakes:(await admin.query('SELECT id,cause,integration_event_id FROM finnor_os.work_wake_claims WHERE tenant_id=$1 AND objective_loop_id=$2',[tenant,loop.id])).rows};
 const findingRows=(await admin.query('SELECT id::text,body FROM finnor_os.v2_findings WHERE tenant_id=$1 AND programme_id=ANY($2::uuid[])',[tenant,runtime.programmes.map((p:any)=>p.id)])).rows;
 const sourceOwner=await import('../../packages/private-equity/src/primary-diligence/store');
 const dependencies=[];
 for(const f of findingRows){const expected=f.body.invalidationDependencies,current=await sourceOwner.tx(ctx,c=>sourceOwner.revisions(ctx,expected.map((d:any)=>d.key),c),true);
  let failure=null;try{await sourceOwner.currentFinding(ctx,f.id);}catch(error:any){failure={code:error.code??error.name,predicate:String(error.message).slice(0,240)};}
  dependencies.push({findingId:f.id,expected,current,failure});
 }
 const proof={accepted,replay,pack,conflicts,immutable,loop,state,actions,steps,queries,verificationQueries,decisions,approvals,workers,runtime,dependencies,qualification:'ACTUAL_ORIGINAL_CONTRACT_AND_KERNEL_QUEUE_CONTROLLER; CONTROLLED_PROMPT_ONLY_PROPOSER; NO_LIVE_INFERENCE_OR_REALIZED_PROFIT'};
 await writeFile(join(output,'original-request-controller.json'),JSON.stringify(proof,null,2));
 assert.equal(decisions.length,1,JSON.stringify({state,actions}));
 const observed=await e.call('acquisition-read',{decisionId:decisions[0].id});assert.equal(observed.status,'TESTED',JSON.stringify(observed));assert.equal(observed.result.maximumBid.value,'100000000');assert.equal(observed.result.maximumBid.financingCaseKey,'debt50');assert.equal(observed.result.candidates.length,12);
 const ic=(await admin.query('SELECT id::text,state FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND deal_id=$2',[tenant,root.entityId])).rows;assert.equal(ic.length,1);assert.equal(ic[0].state,'READY_FOR_REVIEW',JSON.stringify({state,actions,ic}));
 assert.equal(state.action_count,actions.length);assert.equal(state.query_count,queries.length+verificationQueries.length);assert(actions.every((a:any)=>a.objective_step_id&&a.plan_revision_id));assert(state.step_count>0&&state.step_count<=budgets.maxSteps);assert.notEqual(state.state,'completed');
 assert.deepEqual(state.success_condition,loop.success_condition);assert.equal(state.deadline_at.toISOString(),loop.deadline_at.toISOString());assert.equal(state.max_actions,loop.max_actions);
 const primary=(await admin.query('SELECT intake FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows;assert.equal(primary.length,1);assert.deepEqual(primary[0].intake.assertions,request.primary.assertions);assert(!JSON.stringify(request).includes('additional-facility-1'));assert(!JSON.stringify(request.primary).includes('5000000'));
 const base=(await admin.query("SELECT id::text FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND work_id=$2 AND scenario_id IS NULL ORDER BY computed_at,id",[tenant,work.workId])).rows;assert(base.length>=1);const run=await getUnderwritingRun(ctx,base[0].id);assert.equal((run.inputSnapshot as import('@finnor/underwriting').UnderwritingInputSnapshot).values.facility!.value,'5000000');
 assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,1);
 const icFinalized=e.finalizeIc?await(await import('./ic-finalized-e2e.mts')).finalizedAcquisitionIcE2E({ctx,admin,root,work,output,http,caseId:ic[0].id,loopId:loop.id}):undefined;
 const closingHandoff=e.closingHandoff?await(await import('./closing-handoff-e2e.mts')).acquisitionClosingHandoffE2E({ctx,admin,root,work,output,http,icFinalized}):undefined;
 const economicTracking=e.economicTracking?await(await import('./economic-work-e2e.mts')).acquisitionEconomicWorkE2E({ctx,admin,root,work,output,http}):undefined;
 const substitutions:any[]=[];
 const otherWork=await e.call('primary-open-work',{root,instruction:'Independent synthetic baseline substitution control',idempotencyKey:randomUUID()},201);
 for(const price of ['90000000','100000000']){
  const worldAt=new Date().toISOString();
  const alternative=await http.createRun({...request.underwriting,primaryAssertions:undefined,investmentCaseId:request.underwriting.investmentCaseId,modelVersionId:request.underwriting.modelVersionId,worldAt,workId:otherWork.workId,idempotencyKey:randomUUID(),explicitInputs:{...request.underwriting.explicitInputs,price:{value:price,truthClass:'MODEL_PARAMETER'},facility:{value:'1',truthClass:'OBSERVED_FACT'}}});
  assert.equal(alternative.status,201,JSON.stringify(alternative));
  assert.equal(typeof alternative.body.id,'string');
  const cloned=await http.createRun({investmentCaseId:request.underwriting.investmentCaseId,modelVersionId:request.underwriting.modelVersionId,worldAt,workId:work.workId,baseRunId:alternative.body.id,idempotencyKey:randomUUID()});assert.equal(cloned.status,201,JSON.stringify(cloned));
  const refused=await http.call('acquisition-evaluate',{...request.acquisition,dealId:request.dealId,workId:work.workId,baseRunId:cloned.body.id,idempotencyKey:randomUUID()});
  substitutions.push({alternative,cloned,refused});assert.equal(refused.status,409,JSON.stringify(refused));assert.equal(refused.body.code,price==='90000000'?'REVIEWED_ACQUISITION_BASE_PARAMETERS_CHANGED':'REVIEWED_ACQUISITION_BASE_PRIMARY_PROOF_REQUIRED');
 }
 let allowanceImmutable=false;
 try{await admin.query('UPDATE finnor_os.work_objective_loops SET max_actions=max_actions+1 WHERE tenant_id=$1 AND id=$2',[tenant,loop.id]);}catch{allowanceImmutable=true;}
 assert(allowanceImmutable);
 const {evaluateAuthority}=await import('@finnor/authority'),{terminateDeal}=await import('@finnor/private-equity');
 const authority=await evaluateAuthority(ctx.auth,{operation:'action',capability:'private_equity:terminate_deal',resource:{type:'pe_deal',id:root.entityId},risk:'high'});assert.equal(authority.outcome,'allowed');
 const before=(await admin.query('SELECT version,graph_version FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2',[tenant,root.entityId])).rows[0];
 const mutation=await terminateDeal(ctx,{dealId:root.entityId,expectedVersion:before.version,reason:'Explicit disposable material-state negative control after positive IC proof',governance:{authorityDecisionId:authority.id}});assert.equal(mutation.row.version,before.version+1);
 const materialRefusal=await http.call('acquisition-read',{decisionId:decisions[0].id});assert.equal(materialRefusal.status,409,JSON.stringify(materialRefusal));assert.equal(materialRefusal.body.code,'ACQUISITION_SOURCE_CUT_CHANGED');
 const final={...proof,observed,run,ic,icFinalized,closingHandoff,economicTracking,substitutions,allowanceImmutable,materialChange:{before,mutation,materialRefusal}};await writeFile(join(output,'original-request-controller.json'),JSON.stringify(final,null,2));
 return final;
}

export async function prepareOriginalAcquisitionAuthority(ctx:any,admin:any){
 const tenant=ctx.auth.tenantId,actor=ctx.auth.userId;
 const roleId=randomUUID();
 await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Original acquisition controller authority')",[roleId,tenant,'original-'+roleId]);
 await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{\"kind\":\"tenant\"}')",[tenant,actor,roleId]);
 await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'*','*','allow','high',false)",[tenant,roleId]);
 for(const action of ['start_primary_diligence','create_underwriting_run','start_acquisition_evaluation']){
  const id=randomUUID();await admin.query("INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation,version,effective_from) VALUES($1,$2,$3,'{}',false,1,now())",[id,tenant,action]);
  await admin.query("INSERT INTO finnor_os.domain_policy_revisions(id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from) VALUES($1,$2,$3,$4,1,'{}',false,now())",[randomUUID(),tenant,id,action]);
 }
 const {configureAgentProfile}=await import('../../packages/orchestration/src/workforce-runtime');
 const {createDefaultPluginRegistry}=await import('../../packages/orchestration/src/plugin-registry');
 await configureAgentProfile(tenant,createDefaultPluginRegistry(),{key:'disposable-original-acquisition',name:'Disposable original acquisition executor',actor:ctx.auth,
  capabilityGrants:[...['start_primary_diligence','create_underwriting_run','start_acquisition_evaluation'].map(capability=>({kind:'action' as const,capability})),
   ...['primary_diligence_v1','acquisition_decision_v1','closing_readiness','pe_world_state'].map(intent=>({kind:'query' as const,capability:'query:'+intent})),{kind:'check',capability:'check:objective_success'},{kind:'wait',capability:'wait:event'}],
  autonomyLimits:{maxActions:4,maxQueries:11,maxReplans:8,maxPlannerCalls:11,maxWallClockMs:3600000},maxConcurrentAssignments:4,
 });
}
