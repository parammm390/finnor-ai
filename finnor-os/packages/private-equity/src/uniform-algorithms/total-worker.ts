import {join} from 'node:path';
import type {PoolClient} from 'pg';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,ComputeCapacityUnavailableError,type ComputeResourceLease} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {discoverTotalAlgorithm,checkTotalAlgorithm,type TotalDiscoveryResult} from '../../../epistemic-runtime/src/uniform-algorithms/total';
import {parseTotalCapsule} from '../../../epistemic-runtime/src/uniform-algorithms/total/capsule';
import type {UniformJob} from './contracts';
import {digest,diagnosticProfile,fail} from './contracts';
import {uniformSourceRoot} from './source-cut';
import {tx,eventTx} from './store';
import {totalDiscoveryTx,currentTotalTx,resolveTotalBinding,assertTotalResolutionTx,assertTotalCapsuleBinding} from './total-owner';

export async function discoverTotalAlgorithmJob(p:UniformJob,e:Readonly<JobExecutionContext>,ctx:PeMutationContext,
 physical:(c:PoolClient)=>Promise<void>){
 const owned=async(c:PoolClient,lock=false)=>{
  await physical(c);const a=await totalDiscoveryTx(ctx,c,p.discoveryId,lock);
  if(a.generation!==p.generation||['CANCELLED','INVALIDATED','CHECKED','INCOMPLETE'].includes(a.status))return null;
  await currentTotalTx(ctx,c,a,'DISCOVERY');return a;
 };
 let leases:ComputeResourceLease[]=[],physicalCompletionUnknown=false;
 try{
  diagnosticProfile();if(!await tx(ctx,c=>owned(c)))return;
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:y5-proof'],requiredResourceKeys:['native:y5-proof'],
   workloadClass:'HEAVY',ownerId:'y5:'+e.deliveryAttemptId});
  const heartbeat=async()=>!!await renewComputeResourceLeases(leases)&&tx(ctx,async c=>!!await owned(c));
  e.registerHeartbeat(heartbeat);
  const a=await tx(ctx,async c=>{
   const a=await owned(c,true);if(!a)return null;
   if(a.attempt_count>=a.max_attempts)fail('Y5_ORIGINAL_ATTEMPTS_EXHAUSTED');
   await c.query("UPDATE finnor_os.y5_discoveries SET status='RUNNING',attempt_count=attempt_count+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
    [a.tenant_id,a.principal_id,a.id]);a.attempt_count++;
   await eventTx(c,a,'start:'+e.deliveryAttemptId,'PHYSICAL_STARTED',{jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,
    claimFence:e.claimFence,campaignDeadline:a.deadline_at,attempt:a.attempt_count,priorPhysicalCostUnknown:a.attempt_count>1,
    completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,leases:leases.map(({token:_,...lease})=>lease)});
   return a;
  });if(!a)return;
  const binding=await resolveTotalBinding(ctx,a,'DISCOVERY'),root=await uniformSourceRoot(),
   scratch=join(root,'.y5-scratch','total-discovery',a.id,String(a.attempt_count));
  const accepted=await tx(ctx,async c=>{
   if(!await owned(c))return null;
   const row=(await c.query<{body:{contentDigest:string}}>("SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND kind='KERNEL_ACCEPTED' ORDER BY id DESC LIMIT 1",
    [a.tenant_id,a.principal_id,a.id])).rows[0];
   if(!row)return null;
   const stored=(await c.query<{body:unknown}>('SELECT body FROM finnor_os.y5_capsules WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND content_digest=$4',
    [a.tenant_id,a.principal_id,a.id,row.body.contentDigest])).rows[0];
   if(!stored||digest(stored.body)!==row.body.contentDigest)fail('Y5_TOTAL_DURABLE_ACCEPTED_CAPSULE_INTEGRITY');
   const capsule=parseTotalCapsule(stored.body);assertTotalCapsuleBinding(capsule,a);return capsule;
  });
  let result:TotalDiscoveryResult;
  if(accepted){
   const checker=await checkTotalAlgorithm(accepted,binding.specification,{scratch:join(scratch,'recovered-check'),
    deadlineAt:a.deadline_at.getTime(),current:heartbeat});
   result={status:'CHECKED',capsule:accepted,attempts:accepted.search.attempts,wallMs:0};
   await tx(ctx,async c=>{if(await owned(c))await eventTx(c,a,'recovered:'+e.deliveryAttemptId,'DURABLE_ACCEPTED_RECHECKED',
    {capsuleDigest:accepted.digest,checker,reconstructed:false});});
  }else{
   result=await discoverTotalAlgorithm(binding.specification,{scratch,deadlineAt:a.deadline_at.getTime(),current:heartbeat,
    developmentInputs:binding.developmentInputs,episodeCutDigest:binding.episodeCut.cutDigest,episodeSelectionRule:binding.episodeCut.selectionRule,
    limits:{maxPrograms:a.request.limits.maxPrograms,maxPropositions:a.request.limits.maxPropositions,
     maxProofAttempts:a.request.limits.maxProofAttempts,maxRetainedBytes:a.request.limits.maxRetainedBytes}});
   if(result.status==='CHECKED'){
    const capsule=result.capsule;assertTotalCapsuleBinding(capsule,a);
    await tx(ctx,async c=>{
     if(!await owned(c))return;
     const contentDigest=digest(capsule);
     await c.query('INSERT INTO finnor_os.y5_capsules(tenant_id,principal_id,discovery_id,content_digest,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
      [a.tenant_id,a.principal_id,a.id,contentDigest,JSON.stringify(capsule)]);
     await eventTx(c,a,'kernel:'+e.deliveryAttemptId,'KERNEL_ACCEPTED',{contentDigest,capsuleDigest:capsule.digest,
      definitionDigest:binding.specification.definitionDigest,episodeCutDigest:binding.episodeCut.cutDigest,
      sourceDigest:binding.environment.sourceDigest,protectedAdmission:false});
    });
   }
  }
  const fresh=await resolveTotalBinding(ctx,a,'DISCOVERY');
  if(!await heartbeat())fail('Y5_PUBLICATION_INPUT_OR_PHYSICAL_LEASE_CHANGED');
  await tx(ctx,async c=>{
   const current=await owned(c,true);if(!current)return;
   await assertTotalResolutionTx(ctx,c,fresh);
   const contentDigest=result.status==='CHECKED'?digest(result.capsule):null;
   await c.query('UPDATE finnor_os.y5_discoveries SET status=$4,result_digest=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
    [a.tenant_id,a.principal_id,a.id,result.status,contentDigest]);
   await eventTx(c,a,'published:'+e.deliveryAttemptId,'DISCOVERY_COMPLETED',{status:result.status,contentDigest,attempts:result.attempts,
    ...(result.status==='INCOMPLETE'?{reason:result.reason,programsExamined:result.programsExamined,propositionsExamined:result.propositionsExamined}:{}),
    mathematicalProof:result.status==='CHECKED',discoveryQualification:'COMPLETE_PRINCIPAL_CENSUS_PUBLIC_DEVELOPMENT_NOT_PROTECTED_NEW_STRUCTURE',
    campaignDeadline:a.deadline_at,theoremLifetime:'ALL_SIZE_NOT_CAMPAIGN_WALL_CURRENT_FENCES_REQUIRED',
    protectedAdmission:false,productionActive:false,allocationOptimalityClaimed:false,
    completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null});
  });
 }catch(error){
  physicalCompletionUnknown=(error as {physicalCompletion?:string}).physicalCompletion==='UNKNOWN';
  if(error instanceof ComputeCapacityUnavailableError)throw error;
  try{await tx(ctx,async c=>{
   await physical(c);const a=await totalDiscoveryTx(ctx,c,p.discoveryId,true);
   await eventTx(c,a,'failure:'+e.deliveryAttemptId,'PHYSICAL_FAILED',{error:(error as Error).message,
    receipt:(error as {receipt?:unknown}).receipt??null,physicalCompletionUnknown,
    unknownEarlierPhysicalCostPossible:true,originalDeadlineRetained:true,automaticNewGrant:false});
   if(a.generation===p.generation&&!['CANCELLED','INVALIDATED','CHECKED'].includes(a.status))
    await c.query("UPDATE finnor_os.y5_discoveries SET status='UNKNOWN' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[a.tenant_id,a.principal_id,a.id]);
  });}catch{}
  throw error;
 }finally{if(!physicalCompletionUnknown)await releaseComputeResourceLeases(leases,'y5_total_physical_children_closed').catch(()=>undefined);}
}
