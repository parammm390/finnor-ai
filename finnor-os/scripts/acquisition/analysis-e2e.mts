import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beginWorkPlannerAttempt,receiveWork} from '@finnor/db';
import {createUnderwritingModelVersion} from '@finnor/private-equity';
import {FinnorOrchestrator,LLMPlanner,startWorkObjective,parseObjectiveSuccessCondition} from '@finnor/orchestration';
import {selectAndMaterializePlan} from '../../packages/orchestration/src/plan-runtime';
import {assembleOperatingContext} from '../../packages/orchestration/src/operating-context';
import {driveDurableAction} from '../../tests/integration/helpers/durable-action';
import {submitAcquisitionDecision} from '../../packages/private-equity/src/acquisition/decision';

async function withoutDaytonaCredential<T>(read:()=>Promise<T>){
 const backend=process.env.FINNOR_P1_EXECUTOR,key=process.env.DAYTONA_API_KEY;
 try{process.env.FINNOR_P1_EXECUTOR='daytona';delete process.env.DAYTONA_API_KEY;return await read();}
 finally{if(backend===undefined)delete process.env.FINNOR_P1_EXECUTOR;else process.env.FINNOR_P1_EXECUTOR=backend;if(key===undefined)delete process.env.DAYTONA_API_KEY;else process.env.DAYTONA_API_KEY=key;}
}

/** One meaningful boundary: source analysis must change the acquisition's
 * financial inputs without replacing the selected parent's Work or plan.
 * The candidate proposer is explicit; no model intelligence is qualified. */
export async function acquisitionAnalysisE2E(e:any){
 const {ctx,tenant,actor,admin,api,evidence,story,sources,runWorker,upload}=e;
 const original={...story.request,...story.correction.revisedBase};
 const definition=structuredClone(story.definition);
 definition.modelVersion='2';
 definition.nodes.find((n:any)=>n.id==='operating_profit').allowedTruthClasses=['MODEL_PARAMETER','DERIVED_VALUE'];
 const model=(await admin.query('SELECT model_id::text FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND id=$2',[tenant,original.modelVersionId])).rows[0];
 const version=await createUnderwritingModelVersion(ctx,{modelId:model.model_id,definition});
 const post=(await import('../../apps/api/app/api/underwriting/runs/route')).POST;
 const baseResponse=await post(new Request('http://localhost/api/underwriting/runs',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':tenant,'x-user-id':actor},body:JSON.stringify({investmentCaseId:original.investmentCaseId,modelVersionId:version.id,worldAt:original.worldAt,idempotencyKey:'analysis-unverified-base',explicitInputs:{...story.request.explicitInputs,operating_profit:{value:'1164500',truthClass:'MODEL_PARAMETER',reason:'Explicit baseline awaiting the required source analysis'}}})}));
 const base=await baseResponse.json();assert.equal(baseResponse.status,201,JSON.stringify(base));
 const instruction='Verify the acquisition financial inputs from the selected source and determine maximum bid and financing.'+(process.env.FINNOR_ACQUISITION_IC_E2E==='1'?' Prepare IC from that exact checked acquisition.':'');
 const work=await receiveWork({tenantId:tenant,userId:actor,instruction,channel:'console',activeContext:{entityType:'pe_deal',entityId:story.mandate.dealId}});
 const successCondition=parseObjectiveSuccessCondition({version:1,statement:instruction,mode:'all',source:'explicit',criteria:[{kind:'no_open_execution'},{kind:'all_objective_effects_verified',minimumCount:1},{kind:'decision_evidence',minimumCount:1,accepted:['canonical_query']},...(process.env.FINNOR_ACQUISITION_IC_E2E==='1'?[{kind:'private_equity_ic_preparation',dealId:story.mandate.dealId,requireAcquisition:true}]:[])]});
 const loop=await startWorkObjective(instruction,ctx.auth,{workId:work.workId,workInputId:work.workInputId,instructionId:work.instructionId,channel:'console',successCondition,deferInitialIteration:true});
 const actionPayload={...story.mandate,baseRunId:base.id,analysis:{instruction:'Compute operating profit from source revenue plus accounting costs.',validAt:original.worldAt,sources,
  acceptance:{requiredSourceKeys:['revenue','costs'],targets:[{key:'operatingProfit',expression:{kind:'add',left:{kind:'input',key:'revenue'},right:{kind:'input',key:'costs'}},unit:'currency',currencyCode:'USD'}],deliverable:{kind:'analytical_draft',title:'Acquisition financial source check'}},bindings:{operating_profit:'operatingProfit'},limits:{maxSteps:1024,maxAttempts:4,maxCandidates:4,maxDepth:12,deadlineMs:300000}},limits:{deadlineMs:300000,maxCandidates:6}};
 delete actionPayload.workId;delete actionPayload.idempotencyKey;
 if(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='procedure'){
  (actionPayload.analysis as any).procedure=await (await import('./procedure-e2e.mts')).acquisitionProcedureFixture(e,actionPayload.analysis);
 }
 const roleId=randomUUID(),policyId=randomUUID();
 await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Acquisition analysis E2E authority')",[roleId,tenant,'acquisition-analysis-'+roleId]);
 await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)",[tenant,actor,roleId,JSON.stringify({kind:'tenant'})]);
 await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'*','*','allow','high',false)",[tenant,roleId]);
 await admin.query("INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation,version,effective_from) VALUES($1,$2,'start_acquisition_evaluation','{}',false,1,now())",[policyId,tenant]);
 await admin.query("INSERT INTO finnor_os.domain_policy_revisions(id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from) VALUES($1,$2,$3,'start_acquisition_evaluation',1,'{}',false,now())",[randomUUID(),tenant,policyId]);
 const icFixture=process.env.FINNOR_ACQUISITION_IC_E2E==='1'?await (await import('./ic-e2e.mts')).prepareAcquisitionIcFixture(e):null;
 if(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='search'){
  (actionPayload.analysis as any).ownerBindings=await (await import('./search-e2e.mts')).acquisitionSearchFixture(e,story.mandate.dealId);
  (actionPayload.analysis as any).computeSearch='P2_REQUIRED';
 }
 if(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='search'){const validity=await (await import('../../packages/private-equity/src/enterprise-control')).validateEnterpriseContingentPolicy(ctx,(actionPayload.analysis as any).ownerBindings.policyRef);await writeFile(join(evidence,'acquisition-search-grant-currentness.json'),JSON.stringify(validity,null,2));assert.equal(validity.status,'CURRENT',JSON.stringify(validity));}
 let captured:any;
 const provider:any={name:'acquisition-analysis-contract-fixture',complete:async(input:any)=>{
  captured=JSON.parse(input.user);
  return JSON.stringify({candidates:[{version:1,candidateKey:'source-analysis-acquisition',nodes:[{key:'evaluate',kind:'action',actionType:'start_acquisition_evaluation',payload:actionPayload,supports:captured.goal.criteria.map((c:any)=>c.id)},...captured.goal.criteria.map((c:any,i:number)=>({key:'check_'+i,kind:'check',criterionId:c.id,dependsOn:['evaluate']}))]}]});
 }};
 const orchestrator=new FinnorOrchestrator(),planner=new LLMPlanner(orchestrator.plugins,provider);
 const operating=await assembleOperatingContext(ctx.auth,{instruction,workId:work.workId,activeContext:{entityType:'pe_deal',entityId:story.mandate.dealId},includeMemory:false,includeSemanticMemory:false,includeCanonicalBusinessState:false});
 if(icFixture)await (await import('@finnor/orchestration')).executeTenantOperationalQuery(tenant,{intent:'pe_world_state',root:{entityType:'pe_deal',entityId:story.mandate.dealId}},{userId:actor,employeeId:actor,workId:work.workId});
 const initialInspection=icFixture?{queryExecutions:(await admin.query('SELECT id,intent,status FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows}:undefined;
 const attempt=await beginWorkPlannerAttempt({tenantId:tenant,workId:work.workId,workInputId:work.workInputId,attemptKey:'source-analysis-acquisition'});
 const planning=await planner.plan(instruction,ctx.auth,{shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null},{workId:work.workId,workInputId:work.workInputId,plannerAttemptId:attempt.id,successCondition,channel:'console',operatingContext:operating.context,planningContext:initialInspection});
 await writeFile(join(evidence,'acquisition-analysis-planning.json'),JSON.stringify({captured,planning,actionPayload,work,loop,expected:{baseOperatingProfit:'1164500',checkedOperatingProfit:'930000',maximumBid:null}},null,2));
 assert(captured,'The canonical proposer must receive the actual selected Work');
 assert(planning.compilation.selected,JSON.stringify(planning.compilation));
 const selected=await selectAndMaterializePlan({planning,tenantContext:ctx.auth,workId:work.workId,workInputId:work.workInputId,plannerAttemptId:attempt.id,objectiveLoopId:loop.objectiveLoopId});
 const actionNode=planning.compilation.selected.graph.nodes.find((n:any)=>n.kind==='action');assert(actionNode&&actionNode.kind==='action');
 assert.equal(actionNode.actionType,'start_acquisition_evaluation');
 const direct=await api('acquisition-evaluate',{...actionPayload,workId:work.workId,idempotencyKey:'untrusted-analysis-parent'});
 const rootRefusal=process.env.FINNOR_ACQUISITION_SEARCH_ROOT_REFUSAL==='1';
 assert.equal(direct.status,rootRefusal?422:409,JSON.stringify(direct));assert.equal(direct.body.code,rootRefusal?'P2_COMPUTE_RESOURCE_ROOT_NOT_PERMITTED':'ACQUISITION_ANALYSIS_SELECTED_ACTION_REQUIRED');
 const draft=()=>orchestrator.draftKnownAction('start_acquisition_evaluation',actionNode.groundedPayload,tenant,{actionId:selected.actions[0]!.id,workId:work.workId,initiatedBy:actor,source:'acquisition-analysis:e2e',planRevisionId:selected.planRevisionId,planNodeId:actionNode.id,plannerAttemptId:attempt.id});
 if(rootRefusal){
  const counts=async()=>(await admin.query("SELECT (SELECT count(*)::int FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND work_id=$2) decisions,(SELECT count(*)::int FROM finnor_os.p1_requests WHERE tenant_id=$1 AND work_id=$2) programs,(SELECT count(*)::int FROM finnor_os.p2_requests WHERE tenant_id=$1) searches,(SELECT COALESCE(sum(spent),0)::int FROM finnor_os.p2_grant_usage WHERE tenant_id=$1) spent",[tenant,work.workId])).rows[0];
  const before=await counts(),refused=await draft().then(()=>null,(error:any)=>({code:error.code,status:error.status}));
  assert.deepEqual(refused,{code:'P2_COMPUTE_RESOURCE_ROOT_NOT_PERMITTED',status:422});const after=await counts();assert.deepEqual(after,before);assert.deepEqual(after,{decisions:0,programs:0,searches:0,spent:0});
  const proof={direct,refused,before,after,work,selected,qualified:'GENUINE_S4_S5_GRANT_EXCLUDES_SELECTED_DEAL_NO_ADMISSION_OR_DEBIT'};await writeFile(join(evidence,'acquisition-search-root-refusal.json'),JSON.stringify(proof,null,2));return proof;
 }
 const drafted=await draft();
 const admission=await withoutDaytonaCredential(async()=>{
  const before=(await admin.query("SELECT count(*)::int n FROM finnor_os.acquisition_decisions WHERE tenant_id=$1",[tenant])).rows[0].n;
  const refused=await submitAcquisitionDecision(ctx,{...actionPayload,workId:work.workId,idempotencyKey:drafted.action.id},drafted.action.id).then(()=>null,(error:any)=>({code:error.code,status:error.status}));
  assert.deepEqual(refused,{code:'DAYTONA_CREDENTIAL_UNAVAILABLE',status:422});
  assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.acquisition_decisions WHERE tenant_id=$1",[tenant])).rows[0].n,before);
  return {refused,newDecisions:0,boundary:'SELECTED_NATIVE_ACTION_TO_ACQUISITION_OWNER'};
 });
 await writeFile(join(evidence,'acquisition-provider-admission.json'),JSON.stringify(admission,null,2));
 const executed=await driveDurableAction(tenant,drafted.action.id);assert.equal(executed.status,'success',JSON.stringify(executed));
 const decisionId=String(executed.output.canonicalState.decisionId);
 const admitted=(await admin.query(`SELECT a.analysis_program_id::text,p.work_id::text,p.work_input_id::text,p.plan_revision_id::text,p.episode_id::text,p.proposed->'bounds' bounds,p.proposed->'executionBinding' executor
  FROM finnor_os.acquisition_decisions a JOIN finnor_os.p1_requests p ON p.id=a.analysis_program_id AND p.tenant_id=a.tenant_id AND p.principal_id=a.principal_id
  WHERE a.tenant_id=$1 AND a.id=$2`,[tenant,decisionId])).rows[0];
 assert(admitted,'Parent acceptance must commit its exact analytical child before a worker can reselect configuration');
 assert.equal(admitted.work_id,work.workId);assert.equal(admitted.work_input_id,work.workInputId);assert.equal(admitted.plan_revision_id,selected.planRevisionId);assert.equal(admitted.executor.backend,process.env.FINNOR_P1_EXECUTOR??'local');
 await writeFile(join(evidence,'acquisition-atomic-analysis-admission.json'),JSON.stringify(admitted,null,2));
 if(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='cancel'){
  const pending=await api('acquisition-read',{decisionId});
  assert.equal(pending.body.status,'QUEUED',JSON.stringify(pending));assert.equal(pending.body.result,null);
  const programId=pending.body.analysis.programId;assert(programId);
  const cancelled=await api('program-cancel',{programId});assert.equal(cancelled.status,200,JSON.stringify(cancelled));assert.equal(cancelled.body.status,'CANCELLED');
  await runWorker();
  const stopped=await api('acquisition-read',{decisionId});assert.equal(stopped.status,200,JSON.stringify(stopped));assert.equal(stopped.body.status,'FAILED');assert.equal(stopped.body.reason,'ACQUISITION_REQUIRED_ANALYSIS_FAILED');assert.equal(stopped.body.result,null);
  const parent=(await admin.query('SELECT status FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',[tenant,selected.planRevisionId])).rows[0];assert.equal(parent.status,'active');
  const objective=(await admin.query('SELECT state FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2',[tenant,loop.objectiveLoopId])).rows[0];assert.notEqual(objective.state,'cancelled');
  const proof={work,selected,pending,cancelled,stopped,parent,objective,contract:'CANCELLED_REQUIRED_CHILD_CANNOT_PRODUCE_BID_OR_CANCEL_PARENT_OBJECTIVE',productionAuthenticationVerified:false};
  await writeFile(join(evidence,'cancelled-acquisition-child-proof.json'),JSON.stringify(proof,null,2));
  return proof;
 }
 await runWorker();
 const journal=(await admin.query("SELECT kind,generation,body,created_at FROM finnor_os.p1_events WHERE tenant_id=$1 AND request_id=$2 AND kind IN('P6_COMPONENTS_ADMITTED','P6_EXECUTABLE_TRANSFER','P6_FAILED_TRANSFER','P6_FRESH_FALLBACK','REMOTE_EXECUTOR_JOURNAL','ISOLATED_MODULE_EXECUTION','REMOTE_EXECUTION_WAIT','FAILED_OR_FENCED') ORDER BY created_at,id",[tenant,admitted.analysis_program_id])).rows;
 const owner=(await admin.query('SELECT p.status,p.generation,p.work_id,p.work_input_id,p.plan_revision_id,p.episode_id,p.proposed->\'bounds\' bounds,e.steps_used,e.attempts_used,e.candidates_used FROM finnor_os.p1_requests p JOIN finnor_os.p1_episodes e ON e.tenant_id=p.tenant_id AND e.principal_id=p.principal_id AND e.id=p.episode_id WHERE p.tenant_id=$1 AND p.id=$2',[tenant,admitted.analysis_program_id])).rows[0];
 await writeFile(join(evidence,'acquisition-analysis-owner-journal.json'),JSON.stringify({owner,journal},null,2));
 const observed=await api('acquisition-read',{decisionId});
 await writeFile(join(evidence,'acquisition-analysis-result.json'),JSON.stringify({selected,work,loop,executed,direct,observed},null,2));
 assert.equal(observed.status,200,JSON.stringify(observed));assert.equal(observed.body.status,'TESTED',JSON.stringify(observed));
 assert.equal(observed.body.workId,work.workId);assert.equal(observed.body.result.maximumBid.value,null);assert.equal(observed.body.result.maximumBid.qualification,'NO_FEASIBLE_CANDIDATE');
 const replay=await withoutDaytonaCredential(async()=>{
  const prior=(await admin.query('SELECT request,deadline_at FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND id=$2',[tenant,decisionId])).rows[0];
  const before=(await admin.query('SELECT count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1',[tenant])).rows[0].n;
  const current=await submitAcquisitionDecision(ctx,prior.request,drafted.action.id);assert.equal(current.decisionId,decisionId);assert.equal(current.replayed,true);
  const after=(await admin.query('SELECT deadline_at FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND id=$2',[tenant,decisionId])).rows[0];assert.deepEqual(after.deadline_at,prior.deadline_at);
  assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1',[tenant])).rows[0].n,before);
  return {current,originalDeadline:prior.deadline_at,newJobs:0};
 });
 await writeFile(join(evidence,'acquisition-provider-loss-replay.json'),JSON.stringify(replay,null,2));
 const analysis=observed.body.analysis;assert(analysis?.programId&&analysis.baseRunId);
 const program=await api('program-read',{programId:analysis.programId});assert.equal(program.status,200,JSON.stringify(program));assert.equal(program.body.status,'TESTED',JSON.stringify(program));
 assert.equal(program.body.program.result.values.operatingProfit.value,'930000');assert.equal(program.body.program.work.id,work.workId);assert.equal(program.body.program.work.revision,work.workInputId);assert.equal(program.body.program.work.planRevisionId,selected.planRevisionId);
 if(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='search'){
  assert.deepEqual(owner.bounds,admitted.bounds);assert.equal(owner.episode_id,admitted.episode_id);assert.equal(owner.attempts_used,3);
  const searches=(await admin.query('SELECT * FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND program_id=$3',[tenant,actor,analysis.programId])).rows;assert.equal(searches.length,1);const search=searches[0];assert.equal(search.status,'STOPPED');assert.equal(search.request.mode,'production_analysis');assert.equal(search.request.computeGrant.contentDigest,(actionPayload.analysis as any).ownerBindings.allocationRef.contentDigest);
  const attempts=(await admin.query('SELECT id,unit_id,status,body FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND search_id=$2 ORDER BY created_at,id',[tenant,search.id])).rows;assert.equal(attempts.length,2);assert(attempts.every((a:any)=>a.status==='COMPLETED'&&a.body.physicalOutcome==='RETURNED'));
  const ledger=(await admin.query('SELECT spent FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4',[tenant,actor,search.request.computeGrant.contentDigest,search.binding.resourceId])).rows;assert.equal(ledger.length,1);assert.equal(ledger[0].spent,2);
  const remote=journal.filter((event:any)=>event.kind==='ISOLATED_MODULE_EXECUTION').map((event:any)=>event.body);assert.equal(remote.length,1);assert.equal(remote[0].execution.provenance.binding.consumer.owner,'P2');assert.equal(remote[0].execution.provenance.binding.consumer.id,attempts.find((a:any)=>a.body.workKind==='EXECUTE_P1').id);
  const current=await api('compute-search-read',{searchId:search.id});assert.equal(current.status,200,JSON.stringify(current));assert(current.body.plan.incumbent.checks.every((c:any)=>c.status==='PASS'&&c.method==='POSTGRES_NUMERIC_ACCEPTED_EXPRESSION'));
  const reconciliationJobs=(await admin.query("SELECT id,status,attempts,protocol_version,claim_fence,payload FROM finnor_os.jobs WHERE tenant_id=$1 AND type='run_harness_program_v1' AND payload->>'programId'=$2 AND payload->>'stage' LIKE 'p2-reconcile:%' ORDER BY run_at,id",[tenant,analysis.programId])).rows;
  if(process.env.FINNOR_DAYTONA_PROTOCOL_LOST_ACK==='1'||process.env.FINNOR_DAYTONA_PROTOCOL_KILL==='1'){assert(reconciliationJobs.length>0&&reconciliationJobs.length<=64);assert(reconciliationJobs.every((j:any)=>j.protocol_version===1));assert(reconciliationJobs.some((j:any)=>j.status==='completed'&&Number(j.claim_fence)>0));}
  const nativeClaims=(await admin.query("SELECT id,status,claim_fence,payload FROM finnor_os.jobs WHERE tenant_id=$1 AND type='run_compute_search_unit_v1' AND payload->>'searchId'=$2 ORDER BY run_at,id",[tenant,search.id])).rows;
  if(process.env.FINNOR_DAYTONA_PROTOCOL_KILL==='1'){
   const execute=attempts.find((a:any)=>a.body.workKind==='EXECUTE_P1');assert.equal(nativeClaims.find((j:any)=>j.id===execute.body.jobId)?.status,'quarantined');assert.equal(nativeClaims.find((j:any)=>j.id===execute.body.reconnection.jobId)?.status,'completed');
  }
  await writeFile(join(evidence,'search-same-acquisition-proof.json'),JSON.stringify({search,attempts,ledger,remote,current,work,decisionId,admitted,owner,reconciliationJobs,nativeClaims},null,2));
 }
 if(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='procedure'){
  assert.equal(journal.filter((e:any)=>e.kind==='P6_COMPONENTS_ADMITTED').length,1,'Procedure execution grant must be admitted once on its original generation');
  const transfers=(await admin.query("SELECT kind,body FROM finnor_os.p1_events WHERE tenant_id=$1 AND request_id=$2 AND kind IN('P6_EXECUTABLE_TRANSFER','P6_FRESH_FALLBACK')",[tenant,analysis.programId])).rows;
  assert.equal(transfers.length,1,JSON.stringify(transfers));assert.equal(transfers[0].kind,'P6_EXECUTABLE_TRANSFER');
  const remote=program.body.program.costs.nativeInvocations.filter((v:any)=>v.execution?.provenance?.substrate==='DAYTONA_PRIVATE_ANALYSIS_V1');
  if(process.env.FINNOR_P1_EXECUTOR==='daytona')assert.deepEqual(remote.map((v:any)=>v.execution.provenance.binding.consumer.id.split(':').at(-1)).sort(),['CORE','RESIDUAL']);
  await writeFile(join(evidence,'procedure-same-acquisition-proof.json'),JSON.stringify({transfers,remote,work,decisionId},null,2));
 }
 const effective=(await admin.query('SELECT input_snapshot FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',[tenant,analysis.baseRunId])).rows[0];
 assert.equal(effective.input_snapshot.values.operating_profit.value,'930000');assert.equal(effective.input_snapshot.values.operating_profit.truthClass,'DERIVED_VALUE');assert.equal(effective.input_snapshot.values.operating_profit.provenance[0].kind,'harness_program');
 const parent=(await admin.query('SELECT status,goal_spec FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',[tenant,selected.planRevisionId])).rows[0];
 assert.equal(parent.status,'active');assert.equal(parent.goal_spec.statement,instruction);
 assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,1);
 assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.p1_requests WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,1);
 await runWorker();
 assert.equal((await api('acquisition-read',{decisionId})).body.result.inputHash,observed.body.result.inputHash);
 if(process.env.FINNOR_ACQUISITION_READ_PROBE)await (await import('./read-probe.mts')).acquisitionReadProbe({api,decisionId,observed,admin,tenant,evidence});
 const icProof=icFixture?await (await import('./ic-e2e.mts')).acquisitionIcE2E({...e,icFixture,orchestrator,work,instruction,loop,successCondition,selected,decisionId,observed}):null;
 let correctedInBrowser=false;
 if(process.env.FINNOR_ACQUISITION_BROWSER_FIXTURE==='1'){
  await (await import('../p1/browser-fixture.mts')).browserFixture({...e.browserFixtureContext,tickWorker:async()=>false,acquisition:{workId:work.workId,dealId:story.mandate.dealId,decisionId,correct:async()=>{assert(!correctedInBrowser);const correction=await upload({revenue:'900.00'},story.correction.corrected.file);correctedInBrowser=true;return {documentId:correction.file.documentId,versionId:correction.file.version.id,expected:'OLD_DECISION_UNAVAILABLE'};}}});
  process.env.AUTH_DEV_BYPASS='1';
  // The browser may revoke access after proving privacy. Restore fixture access
  // only to finish the independent owner proof, never a product authorization.
  await admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2",[tenant,actor]);
 }
 if(!correctedInBrowser)await upload({revenue:'900.00'},story.correction.corrected.file);
 const stale=await api('acquisition-read',{decisionId});assert.equal(stale.status,409,JSON.stringify(stale));assert.equal(stale.body.code,'ACQUISITION_SOURCE_CUT_CHANGED');assert(!stale.body.result);
 if(icProof){const refusal=await (await import('../../packages/private-equity/src/ic-repository')).getIcWorkspace(ctx,{icCaseId:icProof.caseId}).then(()=>null,(error:any)=>({code:error.code??error.message}));assert(refusal);await writeFile(join(evidence,'acquisition-ic-stale-source-refusal.json'),JSON.stringify(refusal,null,2));}
 const proof={work,loop,selected,executed,direct,observed,program,effective,parent,stale,modelInferenceQualified:false,hostedDaytonaQualified:false,financialQualification:'EXPLICIT_SOURCE_SELECTION_AND_DECLARED_MODEL_NOT_REALIZED_PROFIT'};
 await writeFile(join(evidence,'same-acquisition-analysis-proof.json'),JSON.stringify(proof,null,2));
 return proof;
}
