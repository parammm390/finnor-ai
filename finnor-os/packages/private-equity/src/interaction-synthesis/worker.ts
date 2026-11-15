import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,type ComputeResourceLease} from '@finnor/db';
import type {PoolClient} from 'pg';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {Y3_VERSION,PROFILE_DIGEST,digest,fail,type Check,type ConstructionResult,type RuntimeIdentity} from './contracts';
import {construct} from './producer';
import {independentlyCheck} from './process';
import {productRuntimeIdentity} from './product-runtime';
import {JobSchema,LIMITS,reference,type InteractionJob,type ProtocolRow,type InteractionProtocol} from './product-contracts';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {protocolTx,currentChangesTx,invalidateTx,eventTx,developmentOnly,dependencyGraph} from './store';

async function physical(c:PoolClient,p:InteractionJob,e:Readonly<JobExecutionContext>,leases:ComputeResourceLease[]){
 const live=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d
  ON d.tenant_id=j.tenant_id AND d.job_id=j.id WHERE j.id=$1 AND j.tenant_id=$2
  AND j.type='construct_interaction_protocol_v1' AND j.status='running' AND j.payload=$3::jsonb
  AND j.claim_token=$4 AND j.claim_fence=$5 AND j.lease_expires_at>clock_timestamp()
  AND d.id=$6 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.finished_at IS NULL FOR SHARE OF j,d`,
 [e.jobId,p.tenantId,JSON.stringify(p),e.claimToken,e.claimFence,e.deliveryAttemptId]);
 if(live.rowCount!==1)fail('Y3_PHYSICAL_DELIVERY_FENCE');
 for(const lease of leases)if((await c.query(`SELECT resource_key FROM finnor_os.compute_resource_leases
  WHERE resource_key=$1 AND lease_token=$2 AND fence=$3 AND owner_id=$4 AND released_at IS NULL
  AND expires_at>clock_timestamp() FOR SHARE`,[lease.resourceKey,lease.token,lease.fence,lease.ownerId])).rowCount!==1)
  fail('Y3_PHYSICAL_COMPUTE_FENCE');
}
export async function constructInteractionProtocolJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 developmentOnly();const p=JobSchema.parse(raw);
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('Y3_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}},
  started=performance.now(),cpu=process.cpuUsage(),abort=new AbortController();
 let leases:ComputeResourceLease[]=[],original:ProtocolRow|undefined,check:Check|undefined,
  executionRuntime:RuntimeIdentity|undefined,registered=false,disposition='UNKNOWN';
 async function owned(c:PoolClient){
  const row=await protocolTx(ctx,c,p.protocolId);await physical(c,p,e,leases);
  if(row.generation!==p.generation||row.cancelled||row.artifact||['INVALIDATED','CANCELLED'].includes(row.status))return null;
  const changes=await currentChangesTx(ctx,c,row);
  if(changes.length){await invalidateTx(c,row,changes);return null;}
  return row;
 }
 async function heartbeat(){
  try{
   if(!await renewComputeResourceLeases(leases)){abort.abort();return false;}
   const live=await transaction(ctx,async c=>!!await owned(c));if(!live)abort.abort();return live;
  }catch{abort.abort();return false;}
 }
 try{
  if(!await transaction(ctx,c=>owned(c)))return;
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:y3-construction'],
   requiredResourceKeys:['native:y3-construction'],workloadClass:'INTERACTIVE',ownerId:'y3:'+e.deliveryAttemptId});
  e.registerHeartbeat(heartbeat, { leaseSeconds: Math.min(...leases.map(lease => lease.leaseSeconds)) });
  original=await transaction(ctx,async c=>{
   const row=await owned(c);if(!row)return undefined;
   if(row.attempts_used>=LIMITS.maxAttempts){
    await c.query("UPDATE finnor_os.y3_requests SET status='INCOMPLETE' WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
    await eventTx(c,row,'NATIVE_ATTEMPT_NOT_STARTED','exhausted:'+e.deliveryAttemptId,{
     predicate:'Y3_ORIGINAL_ATTEMPT_BOUND',jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,
     originalEpisodeId:row.episode_id,attemptsUsed:row.attempts_used,newAllocation:false,searchOccupation:0,
     wallMs:performance.now()-started,cpuMs:(process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000,moneyUsd:null,humanSeconds:null});
    disposition='INCOMPLETE';return undefined;
   }
   await c.query(`UPDATE finnor_os.y3_episodes SET attempts_used=attempts_used+1,search_steps_used=search_steps_used+$3
    WHERE tenant_id=$1 AND id=$2`,[p.tenantId,row.episode_id,row.candidate?0:LIMITS.maxSearchSteps]);
   await eventTx(c,row,'NATIVE_ATTEMPT_REGISTERED','attempt:'+e.deliveryAttemptId,{jobId:e.jobId,workerId:e.workerId,
    deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,originalEpisodeId:row.episode_id,
    checkpointReused:!!row.candidate,searchOccupation:row.candidate?0:LIMITS.maxSearchSteps,
    occupationIsNotBilling:true,hardKillCostTail:'UNKNOWN_UNLESS_TERMINAL_COST_RECORDED'});
   await c.query("UPDATE finnor_os.y3_requests SET status=$3 WHERE tenant_id=$1 AND id=$2",
    [p.tenantId,row.id,row.candidate?'CHECKING':'CONSTRUCTING']);
   registered=true;return protocolTx(ctx,c,row.id);
  });
  if(!original)return;
  const native=await productRuntimeIdentity();
  if(native.semanticDigest!==original.runtime.semanticDigest)fail('Y3_NATIVE_RUNTIME_CHANGED');
  executionRuntime=native.math;
  const construction:ConstructionResult=original.candidate&&original.construction?original.construction:
   await construct(original.request.problem,original.deadline_at.getTime(),executionRuntime,abort.signal);
  if(!original.candidate&&construction.candidate)await transaction(ctx,async c=>{
   const row=await owned(c);if(!row)fail('Y3_CANDIDATE_CHECKPOINT_FENCED');
   await c.query("UPDATE finnor_os.y3_requests SET candidate=$3::jsonb,construction=$4::jsonb,status='CHECKING' WHERE tenant_id=$1 AND id=$2",
    [p.tenantId,p.protocolId,JSON.stringify(construction.candidate),JSON.stringify(construction)]);
   await eventTx(c,row,'CANDIDATE_CHECKPOINT','candidate:'+digest(construction.candidate),{candidateDigest:digest(construction.candidate),
    search:construction.search,executionRuntime,originalEpisodeId:row.episode_id,executionAuthorityGranted:false});
  });
  if(construction.status==='CANDIDATE'||construction.status==='INFEASIBLE'){
   if(!await heartbeat())fail('Y3_CHECKER_DISPATCH_FENCED');
   check=await independentlyCheck(original.request.problem,construction.candidate,original.deadline_at.getTime(),executionRuntime,abort.signal);
  }
  const status=check?.status==='CHECKED'?'CHECKED':check?.status==='INFEASIBLE'?'INFEASIBLE':
   check?.status==='INCOMPLETE'||construction.status==='INCOMPLETE'?'INCOMPLETE':construction.status==='UNSUPPORTED'?'UNSUPPORTED':'UNKNOWN';
  disposition=status;
  if(!['CHECKED','INFEASIBLE','UNSUPPORTED'].includes(status)){
   await transaction(ctx,async c=>{
    const row=await owned(c);if(!row)fail('Y3_ATTEMPT_PUBLICATION_FENCE');
    await c.query('UPDATE finnor_os.y3_requests SET status=$3,construction=$4::jsonb WHERE tenant_id=$1 AND id=$2',
     [row.tenant_id,row.id,status,JSON.stringify(construction)]);
    await eventTx(c,row,'ATTEMPT_CHECK','attempt-check:'+e.deliveryAttemptId,{status,construction,check:check??null,
     checkpointRetained:!!construction.candidate,originalEpisodeId:row.episode_id,notAnAdmission:true});
   });
   return;
  }
  await transaction(ctx,async c=>{
   const row=await owned(c);if(!row)fail('Y3_FINAL_PUBLICATION_FENCE');
   const parent=row.request.parentProtocolId?await protocolTx(ctx,c,row.request.parentProtocolId):null,
    body=construction.candidate,usage=process.cpuUsage(cpu),artifact:InteractionProtocol={
     schema:'finnor.interaction-protocol.v1',problem:row.request.problem,body,construction,
     envelope:{schema:'finnor.postx-artifact-envelope.v1',artifactKind:'InteractionProtocol',id:row.id,tenantId:row.tenant_id,principalId:row.principal_id,
      contentRef:reference('Y3','interaction-protocol',{problem:row.request.problem,body}),parents:parent?.artifact?[parent.artifact.envelope.contentRef]:[],
      work:{id:row.work_id,inputId:row.work_input_id,inputDigest:row.work_input_digest},goal:{id:row.request.problem.id,digest:digest(row.request.problem.goal)},
      validityDomain:{profileDigest:PROFILE_DIGEST,problemDigest:digest(row.request.problem),finiteOnly:true,validUntil:row.deadline_at.toISOString()},
      provenance:{producerVersion:Y3_VERSION,runtime:row.runtime,executionRuntime:executionRuntime!,profileFrozenBeforeEvaluation:true,
       governingOriginalSourceParity:'UNKNOWN'},sourceBindings:row.request.sources,rights:{revision:row.rights_revision,principalId:row.principal_id},
      dependencies:dependencyGraph(row.request),independentChecks:check?[check]:[],
      resourceEnvelope:{episodeId:row.episode_id,deadlineAt:row.deadline_at.toISOString(),maxAttempts:LIMITS.maxAttempts,
       attemptsUsed:row.attempts_used,searchStepsOccupied:row.search_steps_used,retainedBytes:row.retained_bytes},
      admission:{domain:'INTERACTION_PROTOCOL',status:'UNADMITTED',protectedAdmission:false,executionAuthorityGranted:false},
      lowering:{ownerInterfaces:['S1','P1','S4','S5','S6','S7','S8','P7'],adapter:'S5_RESERVATION_RIGHT_TRANSITION_V1',
       fixedY1TheoryRef:row.request.lowering.theoryRef,externalEffectsSupported:false},
      recovery:{originalEpisodeRetained:true,unknownEffectsRetained:true,replayIdentity:'ORIGINAL_REQUEST_TERMS_AND_NATIVE_EFFECT'},
      comparison:{classification:parent?.candidate&&body&&digest(parent.candidate)===digest(body)?'REUSED':'CONSTRUCTED_DEVELOPMENT_UNQUALIFIED',
       protectedNoveltyEstablished:false,equippedBaseline:'UNESTABLISHED'},
      costs:{wallMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000+(check?.cpuMs??0),
       peakProcessRssBytes:process.resourceUsage().maxRSS*1024,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,
       status:'PARTIALLY_METERED',failedAttemptsRetained:true},status,
      qualifications:['EXACT_SUPPLIED_FINITE_MODELS_NOT_FIELD_IDENTIFICATION','FULL_CONTINGENT_DEVIATIONS_AND_GLOBAL_BELIEFS',
       'BOUNDED_GRID_SEARCH_INCOMPLETENESS_RETAINED','NO_PROTECTED_QUALIFICATION_OR_EXECUTION_AUTHORITY',
       'ASSERTIONS_ARE_NOT_FACTS','NO_FINANCIAL_EFFICACY_OR_EXTERNAL_SETTLEMENT','NATIVE_COST_TAIL_IN_APPEND_ONLY_EVENTS'],
      createdAt:new Date().toISOString()}
    };
   if(Buffer.byteLength(JSON.stringify(artifact))>LIMITS.maxArtifactBytes)fail('Y3_ARTIFACT_BYTE_BOUND');
   await c.query('UPDATE finnor_os.y3_requests SET status=$3,construction=$4::jsonb,artifact=$5::jsonb WHERE tenant_id=$1 AND id=$2',
    [row.tenant_id,row.id,status,JSON.stringify(construction),JSON.stringify(artifact)]);
   await eventTx(c,row,'PUBLISHED','published',{status,contentRef:artifact.envelope.contentRef,check:check??null,
    physicalJobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,originalEpisodeId:row.episode_id});
  });
 }catch(error){
  const message=error instanceof Error?error.message:'Y3_NATIVE_FAILURE';disposition=/^Y3_[A-Z0-9_]+$/.test(message)?message:'Y3_NATIVE_FAILURE';
  if(original)await transaction(ctx,async c=>{
   await eventTx(c,original!,'NATIVE_FAILURE','failure:'+e.deliveryAttemptId,{predicate:disposition,deliveryAttemptId:e.deliveryAttemptId,
    originalEpisodeId:original!.episode_id,checkpointRetained:true,unknownEffectsRetained:true});
   await c.query(`UPDATE finnor_os.y3_requests r SET status='UNKNOWN' WHERE r.tenant_id=$1 AND r.id=$2
    AND r.generation=$3 AND NOT r.cancelled AND r.artifact IS NULL AND r.status IN('CONSTRUCTING','CHECKING')
    AND EXISTS(SELECT 1 FROM finnor_os.jobs WHERE id=$4 AND claim_token=$5 AND claim_fence=$6 AND lease_expires_at>clock_timestamp())`,
   [p.tenantId,p.protocolId,p.generation,e.jobId,e.claimToken,e.claimFence]);
  });
  throw error;
 }finally{
  abort.abort();
  try{
   if(registered&&original)await transaction(ctx,async c=>{
    const usage=process.cpuUsage(cpu);
    await eventTx(c,original!,'NATIVE_COST','cost:'+e.deliveryAttemptId,{deliveryAttemptId:e.deliveryAttemptId,disposition,
     originalEpisodeId:original!.episode_id,wallMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000,
     checkerCpuMs:check?.cpuMs??null,checkerPeakRssBytes:check?.peakRssBytes??null,peakProcessRssBytes:process.resourceUsage().maxRSS*1024,
     moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,failedAttemptsRetained:true});
   });
  }finally{await releaseComputeResourceLeases(leases,'y3_construction_delivery_finished');}
 }
}
