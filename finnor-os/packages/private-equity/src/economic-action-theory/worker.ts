import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,type ComputeResourceLease} from '@finnor/db';
import type {PoolClient} from 'pg';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {PROFILE,PROFILE_DIGEST,Y1_VERSION,JobSchema,digest,reference,fail,type EconomicJob,type TheoryRow,type EconomicActionTheory,
 type ConstructionResult,type IndependentCheck,type ConstructionStatus} from './contracts';
import {construct} from './compiler';
import {dependencyGraph} from './finite';
import {independentlyCheck} from './process';
import {transaction,theoryTx,currentChangesTx,invalidateTx,eventTx,developmentOnly} from './store';

async function physical(c:PoolClient,p:EconomicJob,e:Readonly<JobExecutionContext>,leases:ComputeResourceLease[]){
 const result=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.tenant_id=j.tenant_id AND d.job_id=j.id
  WHERE j.id=$1 AND j.tenant_id=$2 AND j.type='construct_economic_action_theory_v1' AND j.status='running'
   AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()
   AND d.id=$5 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.finished_at IS NULL
   AND j.payload=$6::jsonb FOR SHARE OF j,d`,[e.jobId,p.tenantId,e.claimToken,e.claimFence,e.deliveryAttemptId,JSON.stringify(p)]);
 if(result.rowCount!==1)fail('Y1_PHYSICAL_DELIVERY_FENCE');
 for(const lease of leases){
  const live=await c.query('SELECT resource_key FROM finnor_os.compute_resource_leases WHERE resource_key=$1 AND lease_token=$2 AND fence=$3 AND owner_id=$4 AND released_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',
   [lease.resourceKey,lease.token,lease.fence,lease.ownerId]);
  if(live.rowCount!==1)fail('Y1_PHYSICAL_COMPUTE_FENCE');
 }
}
/** The actual durable registration uses this entry. A direct function call has
 * neither a queue claim nor a native resource lease and cannot publish. */
export async function constructEconomicActionTheoryJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=JobSchema.parse(raw);developmentOnly();
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('Y1_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}},
  started=performance.now(),cpu=process.cpuUsage(),abort=new AbortController();
 let leases:ComputeResourceLease[]=[],original:TheoryRow|undefined,check:IndependentCheck|undefined,
  disposition='UNKNOWN',attemptRegistered=false;
 async function owned(c:PoolClient){
  const row=await theoryTx(ctx,c,p.theoryId);await physical(c,p,e,leases);
  if(row.generation!==p.generation||row.cancelled||['CHECKED','INFEASIBLE','UNIDENTIFIED','UNSUPPORTED','INVALIDATED','CANCELLED'].includes(row.status))return null;
  const changes=await currentChangesTx(ctx,c,row);
  if(changes.length){await invalidateTx(c,row,changes);return null;}
  return row;
 }
 async function heartbeat(){
  const renewed=await renewComputeResourceLeases(leases);
  if(!renewed){abort.abort();return false;}
  try{const current=await transaction(ctx,async c=>!!await owned(c));if(!current)abort.abort();return current;}
  catch{abort.abort();return false;}
 }
 try{
  const initial=await transaction(ctx,c=>owned(c));if(!initial)return;
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:y1-construction'],
   requiredResourceKeys:['native:y1-construction'],workloadClass:'INTERACTIVE',ownerId:'y1:'+e.deliveryAttemptId});
  e.registerHeartbeat(heartbeat);
  original=await transaction(ctx,async c=>{
   const row=await owned(c);if(!row)return undefined;
   if(row.attempts_used>=PROFILE.maxAttempts)fail('Y1_ORIGINAL_ATTEMPT_BOUND');
   // Conservative native-work occupation is retained even if this process dies.
   await c.query(`UPDATE finnor_os.y1_episodes SET attempts_used=attempts_used+1,
    search_steps_used=search_steps_used+$3,semantic_applications_used=semantic_applications_used+$4
    WHERE tenant_id=$1 AND id=$2`,[p.tenantId,row.episode_id,row.candidate?0:PROFILE.maxSearchSteps,PROFILE.maxSemanticApplications]);
   await eventTx(c,row,'NATIVE_ATTEMPT_REGISTERED','native-attempt:'+e.deliveryAttemptId,{jobId:e.jobId,workerId:e.workerId,
    deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,originalEpisodeId:row.episode_id,
    constructorCheckpointReused:!!row.candidate,searchOccupation:row.candidate?0:PROFILE.maxSearchSteps,
    applicationOccupation:PROFILE.maxSemanticApplications,occupationIsNotBilling:true});
   await c.query("UPDATE finnor_os.y1_requests SET status=$3 WHERE tenant_id=$1 AND id=$2",[p.tenantId,row.id,row.candidate?'CHECKING':'CONSTRUCTING']);
   attemptRegistered=true;return theoryTx(ctx,c,row.id);
  });
  if(!original)return;
  let construction:ConstructionResult=original.construction??construct(original.request.problem,
   performance.now()+Math.min(PROFILE.maxCheckerWallMs,original.deadline_at.getTime()-Date.now()));
  if(!original.candidate&&construction.candidate){
   await transaction(ctx,async c=>{
    const live=await owned(c);if(!live)fail('Y1_CANDIDATE_CHECKPOINT_FENCED');
    await c.query("UPDATE finnor_os.y1_requests SET candidate=$3::jsonb,construction=$4::jsonb,status='CHECKING' WHERE tenant_id=$1 AND id=$2",
     [p.tenantId,p.theoryId,JSON.stringify(construction.candidate),JSON.stringify(construction)]);
    await eventTx(c,live,'CANDIDATE_CHECKPOINT','candidate:'+digest(construction.candidate),{candidateDigest:digest(construction.candidate),
     sourceDigest:live.runtime.semanticCodeDigest,searchSteps:construction.searchSteps,semanticApplications:construction.semanticApplications});
   });
  }
  if(construction.status==='CANDIDATE'){
   if(!await heartbeat())fail('Y1_CHECKER_DISPATCH_FENCED');
   check=await independentlyCheck(original.request.problem,construction.candidate,original.deadline_at.getTime(),original.runtime,abort.signal);
   const status:ConstructionStatus=check.status==='CHECKED'?'CHECKED':check.status==='INFEASIBLE'?'INFEASIBLE':
    check.status==='INCOMPLETE'?'INCOMPLETE':'UNKNOWN';
   construction={...construction,status,reasons:[...construction.reasons,...(check.reason?[check.reason]:[])]};
  }
  disposition=construction.status;
  await transaction(ctx,async c=>{
   const row=await owned(c);if(!row)fail('Y1_FINAL_PUBLICATION_FENCE');
   const body=construction.candidate,status=construction.status,elapsed=performance.now()-started,usage=process.cpuUsage(cpu),
    parent=row.request.parentTheoryId?await theoryTx(ctx,c,row.request.parentTheoryId,false):null;
   const reused=parent?.artifact?.body&&body&&digest(parent.artifact.body.operators)===digest(body.operators);
   const artifact:EconomicActionTheory={schema:'finnor.economic-action-theory.v1',problem:row.request.problem,body,construction,
    envelope:{schema:'finnor.postx-artifact-envelope.v1',artifactKind:'EconomicActionTheory',id:row.id,
     tenantId:row.tenant_id,principalId:row.principal_id,contentRef:reference('Y1','economic-action-theory',{problem:row.request.problem,body}),
     parents:parent?.artifact?[parent.artifact.envelope.contentRef]:[],
     work:{id:row.work_id,inputId:row.work_input_id,inputDigest:row.work_input_digest},
     goal:{id:row.request.problem.goal.id,digest:digest(row.request.problem.goal)},sourceBindings:row.request.problem.meanings,
     rights:{revision:row.rights_revision,principalId:row.principal_id},
     validityDomain:{profileId:PROFILE.id,profileDigest:PROFILE_DIGEST,problemDigest:digest(row.request.problem),finiteOnly:true,validUntil:row.deadline_at.toISOString()},
     provenance:{producerVersion:Y1_VERSION,runtime:row.runtime,checkerDigest:row.runtime.checkerDigest,profileFrozenBeforeEvaluation:true},
     dependencies:body?dependencyGraph(row.request.problem,body):[],
     resourceEnvelope:{episodeId:row.episode_id,maxAttempts:PROFILE.maxAttempts,deadlineAt:row.deadline_at.toISOString(),
      maxSearchSteps:PROFILE.maxSearchSteps*PROFILE.maxAttempts,maxSemanticApplications:PROFILE.maxSemanticApplications*PROFILE.maxAttempts,
      attemptsUsed:row.attempts_used,searchStepsUsed:row.search_steps_used,semanticApplicationsUsed:row.semantic_applications_used,retainedBytes:row.retained_bytes},
     independentChecks:check?[check]:[],admission:{domain:'ECONOMIC_ACTION_THEORY',status:'UNADMITTED',ref:null,protectedAdmission:false,executionAuthorityGranted:false},
     lowering:{owningInterfaces:['P1','S4','S5','S6','S7'],adapter:'S5_RESERVATION_RIGHT_TRANSITION_V1',externalEffectsSupported:false},
     recovery:{originalEpisodeRetained:true,unknownEffectsRetained:true,replayIdentity:'ORIGINAL_REQUEST_AND_OWNER_KEYS'},
     uncertainty:{missingMeaningKeys:construction.reasons.filter(x=>x.startsWith('MISSING_MEANING:')).map(x=>x.slice(16)),
      externalSettlement:'UNESTABLISHED',financialEfficacy:'UNESTABLISHED'},
     comparison:{classification:reused?'REUSED':'CONSTRUCTED_DEVELOPMENT_UNQUALIFIED',protectedNoveltyEstablished:false,baselineQualification:'UNESTABLISHED'},
     costs:{wallMs:elapsed,cpuMs:(usage.user+usage.system)/1000+(check?.cpuMs??0),peakRssBytes:process.resourceUsage().maxRSS*1024,
      moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,status:'PARTIALLY_METERED',attemptsRetained:true},
     status,qualifications:['FINITE_RELATIONAL_HYPOTHESIS_ONLY','SUPPLIED_MEANING_NOT_LEGAL_OR_ECONOMIC_TRUTH',
      'S8_PROTECTED_ADMISSION_UNESTABLISHED','PUBLIC_FIXTURES_NOT_PROTECTED_NOVELTY','RESOURCE_COUNTERS_CONSERVATIVE_OCCUPATION_NOT_BILLING',
      'FULL_NATIVE_COST_TAIL_IN_APPEND_ONLY_EVENTS'],createdAt:new Date().toISOString()}};
   if(Buffer.byteLength(JSON.stringify(artifact))>PROFILE.maxArtifactBytes)fail('Y1_ARTIFACT_BOUND');
   await c.query('UPDATE finnor_os.y1_requests SET status=$3,construction=$4::jsonb,artifact=$5::jsonb WHERE tenant_id=$1 AND id=$2',
    [row.tenant_id,row.id,status,JSON.stringify(construction),JSON.stringify(artifact)]);
   await eventTx(c,row,'PUBLISHED','published',{status,contentRef:artifact.envelope.contentRef,candidateDigest:body?digest(body):null,
    independentCheck:check??null,physicalJobId:e.jobId,claimFence:e.claimFence,originalEpisodeId:row.episode_id});
  });
 }catch(error){
  disposition=(error as Error).message;
  if(original)await transaction(ctx,async c=>{
   const row=await theoryTx(ctx,c,p.theoryId);
   await eventTx(c,row,'NATIVE_FAILURE','native-failure:'+e.deliveryAttemptId,{predicate:/^[A-Z0-9_:]+$/.test(disposition)?disposition:'Y1_NATIVE_FAILURE',
    deliveryAttemptId:e.deliveryAttemptId,checkpointRetained:!!row.candidate,originalEpisodeRetained:true});
   if(row.generation===p.generation&&!row.cancelled&&!row.artifact)await c.query("UPDATE finnor_os.y1_requests SET status='UNKNOWN' WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
  });
  throw error;
 }finally{
  abort.abort();
  try{if(attemptRegistered)await transaction(ctx,async c=>{
   const row=await theoryTx(ctx,c,p.theoryId),usage=process.cpuUsage(cpu);
   await eventTx(c,row,'NATIVE_COST','native-cost:'+e.deliveryAttemptId,{deliveryAttemptId:e.deliveryAttemptId,disposition,
    wallMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000,checkerCpuMs:check?.cpuMs??null,
    peakProcessRssBytes:process.resourceUsage().maxRSS*1024,checkerPeakRssBytes:check?.peakRssBytes??null,
    moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,originalEpisodeId:row.episode_id,
    sourceDigest:row.runtime.semanticCodeDigest,failedAttemptsRetained:true});
  });}finally{await releaseComputeResourceLeases(leases,'y1_construction_delivery_finished');}
 }
}
