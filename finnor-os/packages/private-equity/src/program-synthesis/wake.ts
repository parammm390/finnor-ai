/** Native wake handoff. No caller observation, private wait table or scheduler. */
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import {withTenantTransaction} from '@finnor/db';
import {principal,tx} from '../evidence-execution/store';
import {requestRow,assertProgramCurrent,enqueueProgram,trace} from './store';
import type {PeMutationContext} from '../types';
export async function resumeHarnessFromNativeWake(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 if(!execution||execution.protocolVersion!==1||typeof execution.tenantId!=='string'||execution.tenantId!==payload.tenantId||typeof payload.wakeWaitId!=='string')return;
 const tenantId=execution.tenantId;
 // First authenticate the actual native wake job and its exact immutable plan.
 const claim=await withTenantTransaction<{id:string;work_id:string;plan_revision_id:string;status:string;created_by:string;expected_event_type:string}|undefined>(tenantId,{readOnly:true},async(_db,c)=>(await c.query<any>(`SELECT cl.id,cl.work_id,w.plan_revision_id,w.status,l.created_by,w.expected_event_type FROM finnor_os.work_wake_claims cl JOIN finnor_os.work_event_waits w ON w.id=cl.wait_id AND w.tenant_id=cl.tenant_id JOIN finnor_os.work_objective_loops l ON l.id=cl.objective_loop_id AND l.tenant_id=cl.tenant_id JOIN finnor_os.jobs j ON j.id=cl.job_id AND j.tenant_id=cl.tenant_id WHERE cl.tenant_id=$1 AND cl.job_id=$2 AND cl.wait_id=$3 AND cl.objective_loop_id=$4 AND cl.integration_event_id=$5 AND j.status='running' AND j.claim_token=$6 AND j.claim_fence=$7 AND cl.objective_revision=l.revision`,[tenantId,execution.jobId,payload.wakeWaitId,payload.objectiveLoopId,payload.wakeEventId,execution.claimToken,execution.claimFence])).rows[0]);
 if(!claim||claim.work_id!==payload.workId||claim.expected_event_type==='p1.harness.checked')return;
 const ctx:PeMutationContext={auth:{tenantId,userId:claim.created_by,employeeId:claim.created_by,role:'owner'},provenance:{sourceSystem:'P1:native-event-wake',createdBy:claim.created_by}};
 const requests=await tx(ctx,async c=>(await c.query<{id:string}>("SELECT id FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND plan_revision_id=$4 AND status='WAITING' ORDER BY created_at DESC LIMIT 2",[tenantId,principal(ctx),claim.work_id,claim.plan_revision_id])).rows,true);
 if(requests.length!==1)return;const q=await requestRow(ctx,requests[0]!.id);await assertProgramCurrent(ctx,q);
 if(claim.status==='timed_out'){
  // The timer and its wake claim belong to the native event fabric. Retain the
  // already immutable PARTIAL head; no computation/publication is replayed.
  await tx(ctx,async c=>{const current=await requestRow(ctx,q.id,c,true);if(current.generation!==q.generation||current.status!=='WAITING')return;await trace(ctx,q,'BOUNDED_STOP',{predicate:'NATIVE_OBSERVATION_DEADLINE_REACHED',waitId:payload.wakeWaitId,wakeClaimId:claim.id,eventId:payload.wakeEventId,jobId:execution.jobId,goalSuccess:false,costsRetained:true},c);await c.query("UPDATE finnor_os.p1_requests SET status='PARTIAL',failure='NATIVE_OBSERVATION_DEADLINE_REACHED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[q.tenant_id,principal(ctx),q.id]);});return;
 }
 await tx(ctx,async c=>{const current=await requestRow(ctx,q.id,c,true);if(current.generation!==q.generation||current.status!=='WAITING')return;await trace(ctx,q,'NATIVE_WAIT_WAKE',{wakeClaimId:claim.id,waitId:payload.wakeWaitId,eventId:payload.wakeEventId,jobId:execution.jobId,status:claim.status},c);await enqueueProgram(ctx,q,'native-wake:'+claim.id,c);});
}
