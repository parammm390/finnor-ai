import type {PoolClient} from 'pg';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,ComputeCapacityUnavailableError,type ComputeResourceLease} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {resolveEnterpriseAllocationProblem} from '../enterprise-allocation';
import {discoverUniformAlgorithm,checkUniformAlgorithm,type AlgorithmTheoryCapsule} from '../../../epistemic-runtime/src/uniform-algorithms';
import {recognizeUniformAllocation,uniformProblemIdentity} from '../../../epistemic-runtime/src/uniform-algorithms/applicability';
import {join} from 'node:path';
import {JobSchema,diagnosticProfile,digest,fail,type UniformJob} from './contracts';
import {uniformSourceRoot} from './source-cut';
import {tx,discoveryTx,commonDiscoveryTx,isTotalDiscovery,currentTx,eventTx,type DiscoveryRow} from './store';
import {discoverTotalAlgorithmJob} from './total-worker';

async function physical(c:PoolClient,e:Readonly<JobExecutionContext>,p:UniformJob){
 const r=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
  WHERE j.id=$1 AND j.tenant_id=$2 AND j.type='discover_uniform_algorithm_v1' AND j.status='running'
  AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()
  AND d.id=$5 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.outcome='running'
  AND j.payload=$6::jsonb FOR SHARE OF j,d`,[e.jobId,p.tenantId,e.claimToken,e.claimFence,e.deliveryAttemptId,JSON.stringify(p)]);
 if(r.rowCount!==1)fail('Y5_PHYSICAL_DELIVERY_FENCE');
}
async function owned(ctx:PeMutationContext,c:PoolClient,p:UniformJob,e:Readonly<JobExecutionContext>,lock=false){
 const a=await discoveryTx(ctx,c,p.discoveryId,lock);await physical(c,e,p);
 if(a.generation!==p.generation||['CANCELLED','INVALIDATED','CHECKED','INCOMPLETE'].includes(a.status))return null;
 await currentTx(ctx,c,a);return a;
}
export async function discoverUniformAlgorithmJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=JobSchema.parse(raw);
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('Y5_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}};
 const kind=await tx(ctx,async c=>{await physical(c,e,p);return commonDiscoveryTx(ctx,c,p.discoveryId);});
 if(isTotalDiscovery(kind))return discoverTotalAlgorithmJob(p,e,ctx,c=>physical(c,e,p));
 let leases:ComputeResourceLease[]=[],physicalCompletionUnknown=false;
 try{
  diagnosticProfile();const initial=await tx(ctx,c=>owned(ctx,c,p,e));if(!initial)return;
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:y5-proof'],requiredResourceKeys:['native:y5-proof'],workloadClass:'HEAVY',ownerId:'y5:'+e.deliveryAttemptId});
  const heartbeat=async()=>!!await renewComputeResourceLeases(leases)&&tx(ctx,async c=>!!await owned(ctx,c,p,e));
  e.registerHeartbeat(heartbeat);
  const a=await tx(ctx,async c=>{
   const a=await owned(ctx,c,p,e,true);if(!a)return null;
   if(a.attempt_count>=a.max_attempts)fail('Y5_ORIGINAL_ATTEMPTS_EXHAUSTED');
   await c.query("UPDATE finnor_os.y5_discoveries SET status='RUNNING',attempt_count=attempt_count+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[a.tenant_id,a.principal_id,a.id]);a.attempt_count++;
   await eventTx(c,a,'start:'+e.deliveryAttemptId,'PHYSICAL_STARTED',{jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,
    originalDeadline:a.deadline_at,attempt:a.attempt_count,priorPhysicalCostUnknown:a.attempt_count>1,completeMoney:null,aggregatePeakBytes:null,
    leases:leases.map(({token:_,...lease})=>lease)});return a;
  });if(!a)return;
  const original=await resolveEnterpriseAllocationProblem(ctx,a.request.allocation);
  if(uniformProblemIdentity(original)!==a.binding.problemIdentity)fail('Y5_ORIGINAL_INSTANCE_CHANGED');
  const applicability=recognizeUniformAllocation(original),root=await uniformSourceRoot(),scratch=join(root,'.y5-scratch','discovery',a.id,String(a.attempt_count));
  let result:{status:'CHECKED'|'INCOMPLETE';capsule:AlgorithmTheoryCapsule|null;attempts:unknown[]};
  if(!applicability.applicable)result={status:'INCOMPLETE',capsule:null,attempts:[{stage:'STRUCTURE_RECOGNITION',status:'UNSUPPORTED',applicability}]};
  else{
   const accepted=await tx(ctx,async c=>{
    if(!await owned(ctx,c,p,e))return null;
    return (await c.query<{body:{capsule:AlgorithmTheoryCapsule}}>("SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND kind='KERNEL_ACCEPTED' ORDER BY id DESC LIMIT 1",[a.tenant_id,a.principal_id,a.id])).rows[0]?.body.capsule??null;
   });
   if(accepted){
    const checker=await checkUniformAlgorithm(accepted,{scratch:join(scratch,'recovered-check'),deadlineAt:a.deadline_at.getTime(),current:heartbeat});
    result={status:'CHECKED',capsule:accepted,attempts:[{stage:'DURABLE_ACCEPTED_CHILD_RECHECKED_NO_RECONSTRUCTION',checker}]};
   }else result=await discoverUniformAlgorithm({scratch,deadlineAt:a.deadline_at.getTime(),current:heartbeat,
    developmentWeights:[applicability.integerWeights.slice(0,10),[-1n,0n,1n].map(String),[]]});
   if(result.capsule)await tx(ctx,async c=>{const current=await owned(ctx,c,p,e);if(current)await eventTx(c,current,'kernel:'+e.deliveryAttemptId,'KERNEL_ACCEPTED',{capsule:result.capsule,
    originalProblemIdentity:a.binding.problemIdentity,sourceDigest:a.binding.environment.sourceDigest,protectedAdmission:false});});
  }
  const fresh=await resolveEnterpriseAllocationProblem(ctx,a.request.allocation);
  if(uniformProblemIdentity(fresh)!==a.binding.problemIdentity||!await heartbeat())fail('Y5_PUBLICATION_INPUT_OR_PHYSICAL_LEASE_CHANGED');
  await tx(ctx,async c=>{
   const current=await owned(ctx,c,p,e,true);if(!current)return;
   const contentDigest=result.capsule?digest(result.capsule):null;
   if(result.capsule)await c.query('INSERT INTO finnor_os.y5_capsules(tenant_id,principal_id,discovery_id,content_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',[a.tenant_id,a.principal_id,a.id,contentDigest,JSON.stringify(result.capsule)]);
   await c.query('UPDATE finnor_os.y5_discoveries SET status=$4,result_digest=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[a.tenant_id,a.principal_id,a.id,result.status,contentDigest]);
   await eventTx(c,a,'published:'+e.deliveryAttemptId,'DISCOVERY_COMPLETED',{status:result.status,contentDigest,attempts:result.attempts,
    mathematicalProof:!!result.capsule,discoveryQualification:'PUBLIC_DEVELOPMENT_FIXED_TYPED_FAMILY_NOT_PROTECTED_NEW_STRUCTURE',
    originalDeadline:a.deadline_at,protectedAdmission:false,productionActive:false,completeMoney:null,aggregatePeakBytes:null});
  });
 }catch(error){
  physicalCompletionUnknown=(error as {physicalCompletion?:string}).physicalCompletion==='UNKNOWN';
  if(error instanceof ComputeCapacityUnavailableError)throw error;
  try{await tx(ctx,async c=>{
   await physical(c,e,p);
   const a=(await c.query<DiscoveryRow>('SELECT * FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE',[p.tenantId,p.principalId,p.discoveryId])).rows[0];
   if(!a)return;
   await eventTx(c,a,'failure:'+e.deliveryAttemptId,'PHYSICAL_FAILED',{error:(error as Error).message,
    receipt:(error as {receipt?:unknown}).receipt??null,physicalCompletionUnknown,unknownEarlierPhysicalCostPossible:true,originalDeadlineRetained:true,automaticNewGrant:false});
   if(a.generation===p.generation&&!['CANCELLED','INVALIDATED','CHECKED'].includes(a.status))
    await c.query("UPDATE finnor_os.y5_discoveries SET status='UNKNOWN' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[a.tenant_id,a.principal_id,a.id]);
  });}catch{}
  throw error;
 }finally{if(!physicalCompletionUnknown)await releaseComputeResourceLeases(leases,'y5_physical_children_closed').catch(()=>undefined);}
}
