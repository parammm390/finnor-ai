/** Frozen final-head oracle: real prepared/approved/executing action and actual
 * restricted final SQL guard. No action/admission/effect row is manufactured. */
import assert from 'node:assert/strict';
import {execFileSync,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {withTenantTransaction} from '@finnor/db';
import {installedInstitutionCompilerIdentity} from '../../../packages/capability-evolution/src/institution-port';
import type {PeMutationContext} from '../../../packages/private-equity/src/types';
type Input={admin:pg.Client;adminUrl:string;ctx:PeMutationContext;workId:string;save:(name:string,value:unknown)=>Promise<unknown>};
export async function installFinalHeadFenceGate(input:Input){
 const gate=new pg.Client({connectionString:input.adminUrl});await gate.connect();
 await gate.query("SET statement_timeout='5s'");await gate.query('SELECT pg_advisory_lock(77151,1)');
 await input.admin.query(`CREATE FUNCTION finnor_os.x1_review_action_claim() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(77151,1);RETURN NEW;END $$;
  CREATE TRIGGER x1_review_action_claim BEFORE UPDATE OF status ON finnor_os.domain_actions
  FOR EACH ROW WHEN(NEW.status='executing' AND OLD.status='approved' AND NEW.authority_context->>'kind'='institution_duty')
  EXECUTE FUNCTION finnor_os.x1_review_action_claim()`);
 const gatePid=(await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 return {gate,gatePid,close:async()=>{
  await gate.query('SELECT pg_advisory_unlock_all()').catch(()=>{});await gate.end();
  await input.admin.query('DROP TRIGGER IF EXISTS x1_review_action_claim ON finnor_os.domain_actions; DROP FUNCTION IF EXISTS finnor_os.x1_review_action_claim()').catch(()=>{});
 }};
}
export async function reviewFinalHeadFence(input:Input&{
 gate:Awaited<ReturnType<typeof installFinalHeadFenceGate>>;worker:ChildProcess;requestId:string;
 submit:{workId:string;workInputId:string;grantIds:string[]};alternateGrantIds:string[];results:any[];
 api:(operation:string,body:unknown)=>Promise<{status:number;body:any}>;assertWithinEnvelope:()=>void}){
 const {admin,ctx,workId,save,gate,worker,requestId}=input,tenant=ctx.auth.tenantId;
 const wait=async<T,>(read:()=>Promise<T|undefined>,label:string,attempts=3600)=>{
  for(let poll=0;poll<attempts;poll++){input.assertWithinEnvelope();const value=await read();if(value)return value;
   await new Promise(resolve=>setTimeout(resolve,50));}throw Error('PHYSICAL_FINAL_HEAD_BOUNDARY_NOT_REACHED:'+label);};
 const claim=await wait(async()=>(await admin.query(`SELECT a.pid,a.query,a.wait_event,pg_blocking_pids(a.pid) blockers
  FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE l.locktype='advisory' AND l.classid=77151 AND l.objid=1
   AND NOT l.granted AND a.datname=current_database() AND a.usename='finnor_worker'`)).rows[0],'approved-action-claim');
 await gate.gate.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['s5-portfolio:'+tenant]);
 await gate.gate.query('SELECT pg_advisory_unlock(77151,1)');
 const finalWait=await wait(async()=>(await admin.query(`SELECT pid,query,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity
  WHERE datname=current_database() AND usename='finnor_worker' AND $1=ANY(pg_blocking_pids(pid))
   AND query LIKE '%x1_assert_effect_current%'`,[gate.gatePid])).rows[0],'actual-final-canonical-guard',100);
 const action=(await admin.query(`SELECT * FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2 AND status='executing'
  AND authority_context->>'compilerRequestId'=$3`,[tenant,workId,requestId])).rows[0];assert.ok(action,'Real approved-to-executing action must be committed');
 const original=(await admin.query('SELECT * FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2',[tenant,requestId])).rows[0];
 assert.ok(['WAITING','PARTIAL','RUNNING'].includes(original.status));assert.ok(original.admission_id&&original.artifact_id&&original.program_id);
 const oldProgram=(await admin.query('SELECT * FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2',[tenant,original.program_id])).rows[0];
 const oldPlan=(await admin.query('SELECT * FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',[tenant,oldProgram.plan_revision_id])).rows[0];assert.equal(oldPlan.status,'active');
 const episode=(await admin.query('SELECT * FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2',[tenant,original.episode_id])).rows[0];
 const effects=async()=>(await admin.query('SELECT id,deal_id,source_system,external_id FROM finnor_os.pe_requests WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
 const beforeEffects=await effects();assert.equal(beforeEffects.length,0,'Physical guard is before canonical mutation');
 assert.ok(worker.pid&&worker.kill('SIGSTOP'),'Stop only the exact owned worker at its proven final guard');
 let stopped='';for(let i=0;i<30;i++){stopped=execFileSync('ps',['-o','state=','-p',String(worker.pid)],{encoding:'utf8'}).trim();if(stopped.includes('T'))break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.ok(stopped.includes('T'),'SIGSTOP must be physically observed');
 const revisionInput={...input.submit,grantIds:input.alternateGrantIds,parentRequestId:requestId,idempotencyKey:'x1-head-fence:'+randomUUID()};
 assert.notDeepEqual([...revisionInput.grantIds].sort(),[...input.submit.grantIds].sort());
 const submitted=input.api('institution-revise',revisionInput);
 const current=await wait(async()=>(await admin.query(`SELECT * FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND principal_id=$2
  AND work_id=$3 AND revision=$4`,[tenant,ctx.auth.userId,workId,original.revision+1])).rows[0],'actual-new-head-acceptance',100);
 assert.equal(current.work_input_id,original.work_input_id);assert.equal(current.parent_request_id,requestId);
 assert.equal(current.episode_id,episode.id);assert.equal(current.status,'QUEUED');
 const killed=new Promise<void>(resolve=>worker.once('close',()=>resolve()));assert.ok(worker.kill('SIGKILL'));await killed;
 await gate.gate.query('SELECT pg_advisory_unlock_all()');
 const acknowledged=await submitted;assert.equal(acknowledged.status,202,JSON.stringify(acknowledged));assert.equal(acknowledged.body.requestId,current.id);
 const method=(await installedInstitutionCompilerIdentity()).ref.contentDigest;
 let guardResult:any;
 try{guardResult=await withTenantTransaction(tenant,{userId:ctx.auth.userId},async(_db,client)=>{
  const role=(await client.query('SELECT current_user role')).rows[0].role;assert.equal(role,'finnor_app');
  await client.query('SELECT finnor_os.x1_assert_effect_current($1::uuid,$2::text)',[action.id,method]);return {status:'ALLOW',role};
 });}catch(error){guardResult={status:'REFUSED',predicate:String((error as Error).message),code:(error as any).code??null};}
 const afterEffects=await effects();assert.deepEqual(afterEffects,beforeEffects);
 const ending=(await admin.query('SELECT * FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2',[tenant,episode.id])).rows[0];
 for(const key of ['parent_reservation','parent_demand','original_deadline','wall_deadline'])assert.deepEqual(ending[key],episode[key]);
 const expected='X1 compiler revision was superseded before canonical mutation';
 await save('final-canonical-head-fence.json',{claim,finalWait,action,original,oldProgram,oldPlan,episode,workerPid:worker.pid,
  stopState:stopped,killSignal:worker.signalCode,revisionInput,current,acknowledged,method,guardResult,beforeEffects,afterEffects,ending,
  expectedPredicate:expected,boundary:'ACTUAL_APPROVED_ACTION_RESTRICTED_PRODUCTION_FINAL_SQL_GUARD_NO_CANONICAL_MUTATION',
  fabricatedActionAdmissionOrOutcome:false,originalParentAndDeadlinesPreserved:true});
 input.results.push({id:'E-final-mutation-requires-latest-accepted-compiler-head',status:guardResult.status==='REFUSED'&&guardResult.predicate===expected?'PASS':'FAIL',
  observed:{guardResult,oldRequestId:requestId,newRequestId:current.id,workerPid:worker.pid,physicalFinalGuardWait:true},
  basis:'REAL_AUTHENTICATED_HEAD_ACCEPTANCE_ACTUAL_EXECUTING_ACTION_PHYSICAL_WORKER_INTERRUPTION_RESTRICTED_FINAL_OWNER_GUARD'});
}
