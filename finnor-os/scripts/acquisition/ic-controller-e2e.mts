import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ensureObjectiveIterationDelivery} from '../../packages/orchestration/src/objective-loop';

export async function acquisitionIcController(e:any){
 const {tenant,actor,admin,work,loop,evidence,orchestrator}=e;
 assert(e.workerDatabaseUrl);const before=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2',[tenant,loop.objectiveLoopId])).rows[0];
 const original={workId:before.work_id,createdBy:before.created_by,revision:before.revision,maxSteps:before.max_steps,maxActions:before.max_actions,maxQueries:before.max_queries,deadlineAt:before.deadline_at,successCondition:before.success_condition};
 await ensureObjectiveIterationDelivery(tenant,loop.objectiveLoopId);
 const approvals:any[]=[],workers:any[]=[];let current=before;
 for(let batch=0;batch<12;batch++){
  const env=Object.fromEntries(['HOME','PATH','TMPDIR','FINNOR_M1_PROFILE','FINNOR_M1_STORE','FINNOR_S3_MODEL_STORE','FINNOR_S3_PYTHON','FINNOR_S4_POLICY_STORE','FINNOR_S5_PYTHON'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]!]));
  Object.assign(env,{NODE_ENV:'test',CI:'1',LOG_LEVEL:'silent',SECRETS_PROVIDER:'env',DATABASE_URL:e.workerDatabaseUrl,FINNOR_IC_CONTROLLER_TENANT:tenant,FINNOR_IC_CONTROLLER_LOOP:loop.objectiveLoopId});
  const child=await promisify(execFile)(process.execPath,['--import=tsx','scripts/acquisition/ic-controller-worker.mts'],{cwd:resolve(import.meta.dirname,'../..'),env,timeout:120000,maxBuffer:2097152}).catch(async(error:any)=>{
   await appendFile(join(evidence,'acquisition-ic-controller-worker.log'),String(error.stdout??'')+String(error.stderr??''));
   const state=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2',[tenant,loop.objectiveLoopId])).rows[0];
   const actions=(await admin.query('SELECT id,action_type,status,objective_step_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id',[tenant,work.workId])).rows;
   const steps=(await admin.query('SELECT * FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number,id',[tenant,loop.objectiveLoopId])).rows;
   await writeFile(join(evidence,'acquisition-ic-controller-worker-failure.json'),JSON.stringify({batch,code:error.code,signal:error.signal,killed:error.killed,state,actions,steps},null,2));
   throw error;
  });
  workers.push({batch,stdout:child.stdout,stderr:child.stderr});await appendFile(join(evidence,'acquisition-ic-controller-worker.log'),child.stdout+child.stderr);
  current=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2',[tenant,loop.objectiveLoopId])).rows[0];
  const snapshot={original,current,workers,approvals,actions:(await admin.query('SELECT id,action_type,status,objective_step_id,plan_revision_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id',[tenant,work.workId])).rows,
   steps:(await admin.query('SELECT * FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number,id',[tenant,loop.objectiveLoopId])).rows,
   jobs:(await admin.query("SELECT j.id,j.type,j.status,j.attempts,j.protocol_version,j.claim_fence,j.payload,j.last_error FROM finnor_os.jobs j WHERE j.tenant_id=$1 AND (j.payload->>'workId'=$2 OR j.payload->>'objectiveLoopId'=$3 OR EXISTS(SELECT 1 FROM finnor_os.workflow_steps s JOIN finnor_os.domain_actions a ON a.tenant_id=s.tenant_id AND a.id=s.domain_action_id WHERE s.tenant_id=j.tenant_id AND s.id::text=j.payload->>'workflowStepId' AND a.work_id::text=$2)) ORDER BY j.run_at,j.id",[tenant,work.workId,loop.objectiveLoopId])).rows};
  await writeFile(join(evidence,'acquisition-ic-controller-progress.json'),JSON.stringify(snapshot,null,2));
  if(['completed','cancelled','failed','blocked'].includes(current.state))break;
  const pending=(await admin.query("SELECT a.id,a.action_type,e.semantic_hash FROM finnor_os.domain_actions a JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.id=a.business_effect_id WHERE a.tenant_id=$1 AND a.work_id=$2 AND a.status='pending' AND a.objective_step_id IS NOT NULL ORDER BY a.created_at,a.id",[tenant,work.workId])).rows;
  for(const action of pending){
   const approval=await orchestrator.decide(action.id,tenant,'approve',actor,{role:'owner',expectedEffectHash:action.semantic_hash,typedConfirmation:true});
   approvals.push({action,approval});assert.equal(approval.status,'success',JSON.stringify(approval));
  }
  if(!pending.length&&current.state==='awaiting_approval')throw Error('NATIVE_CONTROLLER_APPROVAL_HAS_NO_PENDING_EFFECT');
 }
 const actions=(await admin.query("SELECT id,action_type,status,objective_step_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2 AND action_type<>'start_acquisition_evaluation' ORDER BY created_at,id",[tenant,work.workId])).rows;
 const plans=(await admin.query('SELECT id,status,completion_proof FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision,id',[tenant,work.workId])).rows;
 const queries=(await admin.query('SELECT id,work_id,work_input_id,intent,request,status,result_summary FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,current.success_verification?.queryExecutionIds??[]])).rows;
 const completionQueries=(await admin.query("SELECT id,work_id,work_input_id,intent,request,status,result_summary FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 AND execution_key LIKE $3 ORDER BY started_at,id",[tenant,work.workId,'objective:'+loop.objectiveLoopId+':step:%:success:%'])).rows;
 const proof={original,current,workers,approvals,actions,plans,queries,completionQueries,qualification:'AUTOMATIC_NATIVE_OBJECTIVE_CONTROLLER_AND_RESTRICTED_QUEUE_HANDLERS; EXISTING_DETERMINISTIC_PLANNER; DISPOSABLE_HUMAN_APPROVAL; NO_LIVE_MODEL_OR_PRODUCTION_AUTH'};
 await writeFile(join(evidence,'acquisition-ic-controller-proof.json'),JSON.stringify(proof,null,2));
 assert.equal(current.state,'completed',JSON.stringify({reason:current.reason,state:current.state,actions}));assert.equal(current.success_verification.state,'verified');
 const request={intent:'acquisition_decision_v1',workId:work.workId,dealId:e.observed.body.request.dealId,decisionId:e.decisionId};
 assert(current.query_count>0&&current.query_count<=original.maxQueries);assert(queries.length>0);
 assert.equal(current.query_count,completionQueries.length);
 for(const q of completionQueries){assert.equal(q.work_id,work.workId);assert.equal(q.work_input_id,work.workInputId);assert.equal(q.status,'succeeded');assert.deepEqual(q.request,request);}
 assert.deepEqual(current.success_verification.evidence,[{kind:'canonical_query',request,assertion:{path:['data','status'],operator:'eq',expected:'TESTED'}}]);
 assert.deepEqual({workId:current.work_id,createdBy:current.created_by,revision:current.revision,maxSteps:current.max_steps,maxActions:current.max_actions,maxQueries:current.max_queries,deadlineAt:current.deadline_at,successCondition:current.success_condition},original);
 assert.deepEqual(actions.map((a:any)=>a.action_type).sort(),['open_ic_case','begin_ic_preparation','create_ic_memo_draft','select_ic_memo_version','prepare_ic_recommendation','request_ic_memo_review'].sort());assert(actions.every((a:any)=>a.status==='completed'&&a.objective_step_id));
 assert(plans.some((p:any)=>p.status==='completed'&&p.completion_proof?.verified===true));
 const links=(await admin.query("SELECT DISTINCT entity_id::text FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2 AND entity_type='pe_ic_case'",[tenant,work.workId])).rows;assert.equal(links.length,1);
 return {caseId:links[0].entity_id,steps:actions,controller:proof};
}
