/** S6 delivery on the existing command/workflow/job substrate. The worker carries
 * references and signatures; protected provider credentials remain in the broker. */
import {withTenantTransaction} from '@finnor/db';
import {claimStep,stepFence,heartbeatStepClaim,awaitStepObservation,completeStep,advanceWorkflow,redriveStepTx,type StepFence} from '@finnor/workflow-runtime';
import {readEnterpriseDurableObligation,executeEnterpriseDurableObligationRequest,settleEnterpriseAllocation,ObligationOperationSchemas,governedScheduledDelegation,type PeMutationContext} from '@finnor/private-equity';
import {epistemicHash} from '@finnor/epistemic-runtime';
import {RetryableJobError,type JobExecutionContext} from '../queue';
const same=(a:unknown,b:unknown)=>epistemicHash(a)===epistemicHash(b);

export async function runGovernedObligationStep(tenantId:string,stepId:string,generation:number,job:Readonly<JobExecutionContext>|undefined):Promise<void>{
 if(!job||job.tenantId!==tenantId||job.protocolVersion!==3)throw new Error('Governed obligation delivery requires a compatible physical job claim');
 const load=()=>withTenantTransaction(tenantId,{readOnly:true},async(_db,c)=>{
  const live=await c.query("SELECT j.attempts FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id WHERE j.tenant_id=$1 AND j.id=$2 AND a.id=$3 AND j.type='run_workflow_step_v3' AND j.status='running' AND j.protocol_version=3 AND j.claim_token=$4 AND j.claim_fence=$5 AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND j.lease_expires_at>clock_timestamp() AND a.finished_at IS NULL AND j.payload->>'workflowStepId'=$6 AND (j.payload->>'workflowStepGeneration')::int=$7",[tenantId,job.jobId,job.deliveryAttemptId,job.claimToken,job.claimFence,stepId,generation]);
  if(live.rowCount!==1)throw new Error('Physical governed delivery is stale or mismatched');
  const row=(await c.query("SELECT s.*,r.version AS run_version,r.status AS run_status,co.status AS command_status,co.payload AS command_payload,co.authorized_effect_hash,o.principal_id,o.body AS obligation FROM finnor_os.workflow_steps s JOIN finnor_os.workflow_runs r ON r.tenant_id=s.tenant_id AND r.id=s.workflow_run_id JOIN finnor_os.commands co ON co.tenant_id=r.tenant_id AND co.id=r.command_id JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=s.tenant_id AND o.effect_id=s.business_effect_id AND o.domain_action_id=s.domain_action_id WHERE s.tenant_id=$1 AND s.id=$2 AND s.step_type='execute_governed_obligation' AND s.protocol_version=3",[tenantId,stepId])).rows[0];
  if(!row)return null;
  if(row.payload.schema!=='finnor.s6.scheduled-delivery.v1'||!same(row.payload,row.command_payload)||!same(row.payload.obligationRef,row.obligation.ref)||row.payload.notBefore!==row.obligation.deadline.businessStartAt||row.authorized_effect_hash!==row.obligation.effectRef.semanticHash)throw new Error('Scheduled command no longer preserves its exact native obligation');
  return {...row,jobAttempts:live.rows[0].attempts};
 });
 let loaded=await load();if(!loaded||loaded.dispatch_generation!==generation||['completed','failed','compensated'].includes(loaded.status))return;
 const ctx:PeMutationContext={auth:{tenantId,userId:loaded.principal_id,role:'owner'}};
 const obligation=await readEnterpriseDurableObligation(ctx,loaded.obligation.ref),execution=ObligationOperationSchemas['schedule-request'].parse(loaded.payload.execution);
 if(!same(execution.request.ir.obligationRef,obligation.ref)||!same(execution.request.ir.effectRef,obligation.effectRef)||!same(loaded.payload.delegation,governedScheduledDelegation(obligation,execution.request.ref)))throw new Error('Scheduled request or parent attenuation identity changed; responsibility retained');
 if(loaded.status==='leased'){
  if(loaded.lease_expires_at?.getTime()>Date.now())throw new RetryableJobError('Another current workflow claim retains this obligation',1000);
  if(loaded.effect_commit_at){
   await withTenantTransaction(tenantId,{userId:ctx.auth.userId},async(_db,c)=>{
    const parked=await c.query("UPDATE finnor_os.workflow_steps SET status='waiting_observation',execution_state='reconciling',claim_token=NULL,claim_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,evidence=evidence||$6::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='leased' AND claim_fence=$3 AND dispatch_generation=$4 AND claim_token=$5 AND lease_expires_at<=clock_timestamp() RETURNING id",[tenantId,stepId,loaded.claim_fence,generation,loaded.claim_token,JSON.stringify({settlementEstablished:false,responsibilityRetained:true,recovery:'PROTECTED_ORIGINAL_MEMBER_CONTINUATION_AND_READBACK'})]);
    if(parked.rowCount)await c.query("UPDATE finnor_os.workflow_step_claims SET outcome='reconciliation_required',finished_at=clock_timestamp() WHERE tenant_id=$1 AND workflow_step_id=$2 AND claim_token=$3 AND finished_at IS NULL",[tenantId,stepId,loaded.claim_token]);
   });
  }else{
   await withTenantTransaction(tenantId,{userId:ctx.auth.userId},(db)=>redriveStepTx(db,tenantId,stepId));return;
  }
  loaded=await load();if(!loaded||loaded.status!=='waiting_observation')return;
 }
 let fence:StepFence|undefined;
 if(loaded.status==='pending'){
  if(loaded.run_status!=='running'||loaded.command_status!=='running'||loaded.cancellation_requested_at)return;
  const remaining=Date.parse(obligation.deadline.businessStartAt)-Date.now();if(remaining>0)throw new RetryableJobError('S4 business start is not due',remaining);
  const claimed=await claimStep(tenantId,stepId,generation,{workerId:job.workerId,jobDeliveryAttemptId:job.deliveryAttemptId,jobProtocolVersion:3,eligibilityEvidence:{version:1,source:'S4_S5_NATIVE_OBLIGATION_PROTECTED_REVALIDATION_REQUIRED',obligationRef:obligation.ref,requestRef:execution.request.ref,eligibleForDelivery:true,executionAuthorityGranted:false}});
  if(!claimed)return;fence=stepFence(claimed);job.registerHeartbeat(()=>heartbeatStepClaim(tenantId,stepId,fence!));
  const began=await withTenantTransaction(tenantId,{userId:ctx.auth.userId},async(_db,c)=>{
   const won=await c.query("UPDATE finnor_os.workflow_steps s SET execution_state='commit_started',effect_commit_at=clock_timestamp(),updated_at=clock_timestamp() FROM finnor_os.workflow_runs r WHERE s.tenant_id=$1 AND s.id=$2 AND s.workflow_run_id=r.id AND r.tenant_id=s.tenant_id AND r.status='running' AND r.version=$6 AND s.status='leased' AND s.execution_state='claimed' AND s.claim_token=$3 AND s.claim_fence=$4 AND s.dispatch_generation=$5 AND s.lease_expires_at>clock_timestamp() AND s.cancellation_requested_at IS NULL RETURNING s.id",[tenantId,stepId,fence!.claimToken,fence!.claimFence,generation,loaded.run_version]);
   if(won.rowCount)await c.query("UPDATE finnor_os.workflow_step_claims SET outcome='attempted',attempted_at=clock_timestamp() WHERE tenant_id=$1 AND workflow_step_id=$2 AND claim_token=$3 AND finished_at IS NULL",[tenantId,stepId,fence!.claimToken]);return won.rowCount===1;
  });
  if(!began)return;
 }else if(loaded.status!=='waiting_observation')return;
 const waiting=async(evidence:Record<string,unknown>)=>{
  const retained={...evidence,settlementEstablished:false,responsibilityRetained:true,automaticMutationRetry:false,recoveryBudget:loaded.jobAttempts>=64?'REQUIRES_OPERATOR':'QUALIFIED_UNATTEMPTED_MEMBERS_OR_READBACK_REMAINS',costs:{status:'UNMETERED',releaseSufficient:false}};
  if(fence)await awaitStepObservation(tenantId,stepId,retained,fence);
  else await withTenantTransaction(tenantId,{userId:ctx.auth.userId},(_db,c)=>c.query("UPDATE finnor_os.workflow_steps SET evidence=evidence||$4::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='waiting_observation' AND dispatch_generation=$3",[tenantId,stepId,generation,JSON.stringify(retained)]));
 };
 try{
  const delivery=fence?{workflowStepId:stepId,claimToken:fence.claimToken,claimFence:fence.claimFence,dispatchGeneration:generation,runVersion:loaded.run_version}:{kind:'RECOVERY' as const,workflowStepId:stepId,claimFence:Number(loaded.claim_fence),dispatchGeneration:generation,runVersion:loaded.run_version,jobId:job.jobId,jobDeliveryAttemptId:job.deliveryAttemptId,jobClaimToken:job.claimToken,jobClaimFence:Number(job.claimFence)};
  // Protected history prevents replay of any attempted member. A live recovery
  // delivery may finish only untouched original members, then use exact readback.
  const outcome=await executeEnterpriseDurableObligationRequest(ctx,{...execution,delivery});
  if(outcome.status!=='VERIFIED'){await waiting({protectedExecutionEventId:outcome.receipt.identity});throw new RetryableJobError('Protected obligation outcome remains unresolved; no attempted member replay',1000);}
  const settled=await settleEnterpriseAllocation(ctx,{allocationRef:obligation.allocationRef,consumptionRef:obligation.consumptionRef,settlementEventId:outcome.receipt.identity});
  await completeStep(tenantId,stepId,{status:'VERIFIED',obligationRef:obligation.ref,requestRef:execution.request.ref,protectedReceipt:outcome.receipt,settlementEstablished:true,allocationSettlement:settled,releaseGranted:false,causalAttribution:false},fence??{kind:'observation',dispatchGeneration:generation});
  await advanceWorkflow(tenantId,loaded.workflow_run_id);
 }catch(error){
  if(error instanceof RetryableJobError)throw error;
  await waiting({reason:error instanceof Error?error.message:'PROTECTED_DISPATCH_OR_SETTLEMENT_UNAVAILABLE'});
  throw new RetryableJobError('Possible governed delivery retained for protected readback',1000,{cause:error});
 }
}
