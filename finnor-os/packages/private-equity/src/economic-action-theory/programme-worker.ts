import {z} from 'zod';
import type {PoolClient} from 'pg';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,type ComputeResourceLease} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {programmeTx,readEconomicProgramme} from '../economic-control';
import {prepareEconomicObligation,executeEconomicObligation,reconcileEconomicObligation} from '../economic-obligations';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {developmentOnly,theoryTx,eventTx} from './store';
import {fail} from './contracts';
const Job=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),programmeId:z.string().uuid(),mode:z.enum(['RUN','RECONCILE'])}).strict();
/** Restricted ordinary queue claims only. One original native effect per step;
 * recovery observes committed transactions before any new internal transition. */
export async function runEconomicProgrammeJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 developmentOnly();const p=Job.parse(raw);
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('Y1_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}};
 let leases:ComputeResourceLease[]=[],disposition='UNKNOWN';
 const started=performance.now(),cpu=process.cpuUsage();
 async function fence(c:PoolClient){
  const result=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.tenant_id=j.tenant_id AND d.job_id=j.id
   WHERE j.tenant_id=$1 AND j.id=$2 AND j.type='run_economic_programme_v1' AND j.payload=$3::jsonb
   AND j.status='running' AND j.claim_token=$4 AND j.claim_fence=$5 AND j.lease_expires_at>clock_timestamp()
   AND d.id=$6 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.finished_at IS NULL FOR SHARE OF j,d`,
   [p.tenantId,e.jobId,JSON.stringify(p),e.claimToken,e.claimFence,e.deliveryAttemptId]);
  if(result.rowCount!==1)fail('Y1_PROGRAMME_PHYSICAL_DELIVERY_FENCE');
  for(const l of leases)if((await c.query('SELECT resource_key FROM finnor_os.compute_resource_leases WHERE resource_key=$1 AND lease_token=$2 AND fence=$3 AND owner_id=$4 AND released_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',
   [l.resourceKey,l.token,l.fence,l.ownerId])).rowCount!==1)fail('Y1_PROGRAMME_PHYSICAL_COMPUTE_FENCE');
 }
 const programme=await transaction(ctx,async c=>{await fence(c);return programmeTx(ctx,c,p.programmeId,false);});
 try{
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:y1-owner'],requiredResourceKeys:['native:y1-owner'],
   workloadClass:'INTERACTIVE',ownerId:'y1-owner:'+e.deliveryAttemptId});
  e.registerHeartbeat(async()=>{try{return await renewComputeResourceLeases(leases)&&await transaction(ctx,async c=>{await fence(c);return true;});}catch{return false;}}, { leaseSeconds: Math.min(...leases.map(lease => lease.leaseSeconds)) });
  await transaction(ctx,async c=>{
   await fence(c);const row=await theoryTx(ctx,c,programme.theoryId);
   await eventTx(c,row,'S6_PROGRAMME_NATIVE_ATTEMPT','programme-attempt:'+e.deliveryAttemptId,{programmeId:programme.id,jobId:e.jobId,
    deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,originalEpisodeId:programme.episodeId,mode:p.mode,
    hardKillCosts:'UNKNOWN_UNLESS_TERMINAL_NATIVE_COST_RECORDED',futureObservationStorageAlreadyReservedBeforeEffects:true});
  });
  for(let index=0;index<programme.steps.length;index++){
   const current=await readEconomicProgramme(ctx,programme.id),native=current.obligations.find(o=>o.body.stepIndex===index);
   if(native){
    const observed=await reconcileEconomicObligation(ctx,programme.id,index,fence);
    if(observed.status==='OBSERVED')continue;
    if(p.mode==='RECONCILE')continue;
   }else if(p.mode==='RECONCILE')continue;
   await prepareEconomicObligation(ctx,programme.id,index,fence);
   await executeEconomicObligation(ctx,programme.id,index,fence);
   const observed=await reconcileEconomicObligation(ctx,programme.id,index,fence);
   if(observed.status!=='OBSERVED')fail('Y1_ORIGINAL_EFFECT_OBSERVATION_REQUIRED');
  }
  disposition=(await readEconomicProgramme(ctx,programme.id)).status;
 }finally{
  const usage=process.cpuUsage(cpu);
  try{await transaction(ctx,async c=>{
   const row=await theoryTx(ctx,c,programme.theoryId);
   await eventTx(c,row,'S6_PROGRAMME_NATIVE_COST','programme-cost:'+e.deliveryAttemptId,{programmeId:programme.id,jobId:e.jobId,
    deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,mode:p.mode,disposition,wallMs:performance.now()-started,
    cpuMs:(usage.user+usage.system)/1000,peakProcessRssBytes:process.resourceUsage().maxRSS*1024,
    moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,originalEpisodeId:programme.episodeId,
    obligationsRetained:true,financialEfficacyEstablished:false});
  });}finally{await releaseComputeResourceLeases(leases,'y1_owner_delivery_finished');}
 }
}
