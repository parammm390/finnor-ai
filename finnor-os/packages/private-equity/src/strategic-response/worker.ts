import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,type ComputeResourceLease} from '@finnor/db';
import type {PoolClient} from 'pg';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import type {StrategicIndependentCheck,StrategicResponseModel} from '../../../shared-types/src/strategic-response';
import {fitStrategicResponses,predictStrategicResponses} from '../../../epistemic-runtime/src/strategic-response/learner';
import {checkStrategicResponse} from '../../../epistemic-runtime/src/strategic-response/process';
import {synthesizeEnterpriseStrategicControl,retainEnterpriseStrategicControl,unresolvedEffects} from '../enterprise-control';
import {parseEconomicMandate,parseControlProblem} from '../../../epistemic-runtime/src/control-contracts';
import {PROFILE,PROFILE_DIGEST,VERSION,JobSchema,DecisionRequest,digest,reference,fail,type StrategicJob,type ModelRow,type UseRow} from './contracts';
import {transaction,modelTx,useTx,currentChangesTx,invalidateTx,eventTx,developmentOnly,dependencyGraph,resolveCurrentModelTx} from './store';

async function physical(c:PoolClient,p:StrategicJob,e:Readonly<JobExecutionContext>,leases:ComputeResourceLease[]){
 const result=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.tenant_id=j.tenant_id AND d.job_id=j.id
  WHERE j.id=$1 AND j.tenant_id=$2 AND j.type=$3 AND j.status='running' AND j.claim_token=$4 AND j.claim_fence=$5
   AND j.lease_expires_at>clock_timestamp() AND d.id=$6 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence
   AND d.finished_at IS NULL AND j.payload=$7::jsonb FOR SHARE OF j,d`,
  [e.jobId,p.tenantId,p.useId?'evaluate_strategic_response_v1':'learn_strategic_response_model_v1',
   e.claimToken,e.claimFence,e.deliveryAttemptId,JSON.stringify(p)]);
 if(result.rowCount!==1)fail('Y2_PHYSICAL_DELIVERY_FENCE');
 for(const lease of leases){
  const result=await c.query('SELECT resource_key FROM finnor_os.compute_resource_leases WHERE resource_key=$1 AND lease_token=$2 AND fence=$3 AND owner_id=$4 AND released_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',
   [lease.resourceKey,lease.token,lease.fence,lease.ownerId]);
  if(result.rowCount!==1)fail('Y2_PHYSICAL_COMPUTE_FENCE');
 }
}
export async function strategicResponseJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=JobSchema.parse(raw);developmentOnly();
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('Y2_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}},
  started=performance.now(),cpu=process.cpuUsage(),abort=new AbortController();
 let leases:ComputeResourceLease[]=[],original:ModelRow|undefined,originalUse:UseRow|undefined,check:StrategicIndependentCheck|undefined,
  registered=false,disposition='UNKNOWN';
 async function owned(c:PoolClient){
  const row=await modelTx(ctx,c,p.modelId);await physical(c,p,e,leases);
  let use:UseRow|undefined;
  if(p.useId){
   const head=(await c.query<{requested_model_id:string}>('SELECT requested_model_id FROM finnor_os.y2_uses WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[p.tenantId,p.principalId,p.useId])).rows[0];
   if(!head)fail('Y2_ORIGINAL_USE_REQUIRED');
   use=await useTx(ctx,c,head.requested_model_id,p.useId);
   if(use.model_id!==row.id||use.generation!==p.generation||use.cancelled||use.artifact||use.status==='INVALIDATED'||use.model_generation!==row.generation)return null;
  }else if(row.generation!==p.generation||row.artifact||row.cancelled||['INVALIDATED','CANCELLED'].includes(row.status))return null;
  const changes=await currentChangesTx(ctx,c,row);
  if(row.cancelled||row.status==='INVALIDATED'||changes.length){await invalidateTx(c,row,changes);return null;}
  if(use)await resolveCurrentModelTx(ctx,c,row.id);
  return {row,use};
 }
 async function heartbeat(){
  if(!await renewComputeResourceLeases(leases)){abort.abort();return false;}
  try{const live=await transaction(ctx,async c=>!!await owned(c));if(!live)abort.abort();return live;}
  catch{abort.abort();return false;}
 }
 try{
  if(!await transaction(ctx,c=>owned(c)))return;
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:y2-strategic-response'],
   requiredResourceKeys:['native:y2-strategic-response'],workloadClass:'INTERACTIVE',ownerId:'y2:'+e.deliveryAttemptId});
  e.registerHeartbeat(heartbeat);
  const initial=await transaction(ctx,async c=>{
   const live=await owned(c);if(!live)return null;
   const {row,use}=live;
   if(use){
    if(use.attempts_used>=PROFILE.maximumAttempts||row.use_attempts_used>=PROFILE.maximumUses*PROFILE.maximumAttempts)fail('Y2_ORIGINAL_USE_ATTEMPT_LIMIT');
    await c.query('UPDATE finnor_os.y2_uses SET attempts_used=attempts_used+1,status=$3 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,use.id,use.candidate?'CHECKING':'EVALUATING']);
    await c.query('UPDATE finnor_os.y2_episodes SET use_attempts_used=use_attempts_used+1,semantic_applications_used=semantic_applications_used+$3 WHERE tenant_id=$1 AND id=$2',
     [row.tenant_id,row.episode_id,PROFILE.maximumSemanticApplicationsPerAttempt]);
   }else{
    if(row.attempts_used>=PROFILE.maximumAttempts)fail('Y2_ORIGINAL_FIT_ATTEMPT_LIMIT');
    await c.query('UPDATE finnor_os.y2_episodes SET attempts_used=attempts_used+1,semantic_applications_used=semantic_applications_used+$3 WHERE tenant_id=$1 AND id=$2',
     [row.tenant_id,row.episode_id,PROFILE.maximumSemanticApplicationsPerAttempt]);
    await c.query('UPDATE finnor_os.y2_models SET status=$3 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id,row.candidate?'CHECKING':'FITTING']);
   }
   await eventTx(c,row,'NATIVE_ATTEMPT_REGISTERED','attempt:'+e.deliveryAttemptId,{jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,
    useId:use?.id??null,originalEpisodeId:row.episode_id,checkpointRetained:!!(use?.candidate??row.candidate),
    semanticOccupation:PROFILE.maximumSemanticApplicationsPerAttempt,occupationIsNotBilling:true});
   registered=true;return {row:await modelTx(ctx,c,row.id),use};
  });
  if(!initial)return;
  original=initial.row;originalUse=initial.use;
  if(!originalUse){
   const body=original.candidate??fitStrategicResponses(original.request.problem,original.deadline_at.getTime());
   if(!original.candidate)await transaction(ctx,async c=>{
    const live=await owned(c);if(!live)fail('Y2_FITTED_CHECKPOINT_FENCED');
    await c.query("UPDATE finnor_os.y2_models SET candidate=$3::jsonb,status='CHECKING' WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.modelId,JSON.stringify(body)]);
    await eventTx(c,live.row,'FITTED_CHECKPOINT','candidate:'+digest(body),{candidateDigest:digest(body),hypotheses:body.hypotheses.length,
     sourceDigest:live.row.runtime.semanticCodeDigest,semanticApplications:body.semanticApplications});
   });
   if(!await heartbeat())fail('Y2_CHECKER_DISPATCH_FENCED');
   check=await checkStrategicResponse('FIT',{problem:original.request.problem},body,original.deadline_at.getTime(),original.runtime,abort.signal);
   const status=check.status==='CHECKED'?body.status==='FITTED'?'CHECKED':body.status:'UNKNOWN';disposition=status;
   await transaction(ctx,async c=>{
    const live=await owned(c);if(!live)fail('Y2_FINAL_MODEL_PUBLICATION_FENCE');
    const row=live.row;
    if(status==='UNKNOWN'){
     await c.query("UPDATE finnor_os.y2_models SET status='UNKNOWN' WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
     await eventTx(c,row,'CHECKER_UNRESOLVED','check:'+e.deliveryAttemptId,{check,originalEpisodeId:row.episode_id,checkpointRetained:true});return;
    }
    const usage=process.cpuUsage(cpu),parent=row.request.parentModelId?await modelTx(ctx,c,row.request.parentModelId,false):null;
    const artifact:StrategicResponseModel={schema:'finnor.strategic-response-model.v1',problem:row.request.problem,body,envelope:{
     schema:'finnor.postx-strategic-artifact-envelope.v1',artifactKind:'StrategicResponseModel',id:row.id,tenantId:row.tenant_id,principalId:row.principal_id,
     contentRef:reference('S3','strategic-response-model',{problem:row.request.problem,body}),parents:parent?.artifact?[parent.artifact.envelope.contentRef]:[],
     work:{id:row.work_id,inputId:row.work_input_id,inputDigest:row.work_input_digest},goal:{kind:'OWN_FIRM_STRATEGIC_RESPONSE',problemDigest:digest(row.request.problem)},
     sourceBindings:[row.request.evidence],rights:{revision:row.rights_revision,principalId:row.principal_id},
     validityDomain:{profileId:PROFILE.id,profileDigest:PROFILE_DIGEST,validUntil:row.deadline_at.toISOString(),finiteOnly:true},
     provenance:{producerVersion:VERSION,semanticCodeDigest:row.runtime.semanticCodeDigest,sourcePins:row.runtime.sourcePins},
     dependencies:dependencyGraph({...row,candidate:body}),resourceEnvelope:{episodeId:row.episode_id,deadlineAt:row.deadline_at.toISOString(),
      attemptsUsed:row.attempts_used,semanticApplicationsOccupied:Number(row.semantic_applications_used),retainedBytes:Number(row.retained_bytes),usesUsed:row.uses_used},
     independentChecks:[check!],admission:{domain:'STRATEGIC_RESPONSE_MODEL_SET',status:'UNADMITTED',protectedAdmission:false,executionAuthorityGranted:false},
     lowering:{owningInterfaces:['S3','S4','S5','S6','S7','S8','P7'],adapter:'ACTOR_LOCAL_STRATEGIC_JOINT_V1',externalEffectsSupported:false},
     recovery:{originalEpisodeRetained:true,priorCommitmentsRetained:true,fallbackId:row.fallback_id},
     uncertainty:{omittedModelGap:'UNKNOWN',fieldIdentificationEstablished:false,empiricalCalibrationEstablished:false},
     comparison:{classification:'CONSTRUCTED_DEVELOPMENT_UNQUALIFIED',qualifiedEquippedBaseline:'UNESTABLISHED'},
     costs:{wallMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000,peakProcessRssBytes:process.resourceUsage().maxRSS*1024,
      checkerCpuMs:check!.cpuMs??null,checkerPeakRssBytes:check!.peakRssBytes??null,moneyUsd:null,humanSeconds:null,
      aggregatePeakMemoryBytes:null,status:'PARTIALLY_METERED',failedAttemptsRetained:true},
     status,qualifications:['CONDITIONAL_FINITE_STRUCTURAL_IDENTIFIED_SET','NO_MODEL_PROBABILITIES_OR_UNIQUE_EQUILIBRIUM_CLAIM',
      'S1_SUPPLIED_MEANING_NOT_ESTABLISHED_FIELD_TRUTH','PUBLIC_SYNTHETIC_EXPERIMENT_NOT_PROTECTED_OR_S2_FIELD_QUALIFICATION',
      'FULL_FAILED_ATTEMPT_COST_TAIL_IN_APPEND_ONLY_EVENTS','NO_EXTERNAL_EFFECT_OR_FINANCIAL_EFFICACY'],createdAt:new Date().toISOString()}};
    if(Buffer.byteLength(JSON.stringify(artifact))>PROFILE.maximumArtifactBytes)fail('Y2_ARTIFACT_BOUND');
    await c.query('UPDATE finnor_os.y2_models SET status=$3,artifact=$4::jsonb WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id,status,JSON.stringify(artifact)]);
    await eventTx(c,row,'PUBLISHED','published',{status,contentRef:artifact.envelope.contentRef,candidateDigest:digest(body),independentCheck:check,
     originalEpisodeId:row.episode_id,physicalJobId:e.jobId,claimFence:e.claimFence});
   });
  }else{
   const use=originalUse,query=use.request.query;
   let candidate=use.candidate;
   if(!candidate){
    if(use.kind==='PREDICT')candidate=predictStrategicResponses(original.request.problem,original.candidate!,query);
    else{
     const decision=DecisionRequest.parse(use.request);
     candidate=await synthesizeEnterpriseStrategicControl(ctx,{modelId:original.id,query,
      mandate:decision.mandate,problem:decision.problem,actionRules:decision.actionRules});
    }
    await transaction(ctx,async c=>{
     const live=await owned(c);if(!live)fail('Y2_USE_CHECKPOINT_FENCED');
     await c.query("UPDATE finnor_os.y2_uses SET candidate=$3::jsonb,status='CHECKING' WHERE tenant_id=$1 AND id=$2",[p.tenantId,use.id,JSON.stringify(candidate)]);
     await eventTx(c,live.row,'USE_CHECKPOINT','use-candidate:'+use.id,{useId:use.id,candidateDigest:digest(candidate),originalEpisodeId:live.row.episode_id});
    });
   }
   if(!await heartbeat())fail('Y2_USE_CHECKER_DISPATCH_FENCED');
   const decision=use.kind==='DECISION'?DecisionRequest.parse(use.request):null;
   const input={problem:original.request.problem,model:original.candidate!,query,...(decision?{
    mandate:parseEconomicMandate(decision.mandate),control:parseControlProblem(decision.problem),actionRules:decision.actionRules}:{})};
   const result=candidate as Awaited<ReturnType<typeof synthesizeEnterpriseStrategicControl>>;
   check=use.kind==='DECISION'&&!result.policy?{schema:'finnor.strategic-independent-check.v1',operation:'DECISION',status:'UNKNOWN',
    reason:'Y2_S4_HAS_NO_INDEPENDENTLY_CHECKABLE_COMPLETE_PROGRAMME',executionAuthorityGranted:false,protectedQualification:false}:
    await checkStrategicResponse(use.kind,input,use.kind==='PREDICT'?candidate:result.policy,original.deadline_at.getTime(),original.runtime,abort.signal);
   const status=check.status==='CHECKED'?'CHECKED':'UNKNOWN';disposition=status;
   if(status==='CHECKED'&&use.kind==='DECISION'){
    await transaction(ctx,async c=>{
     const live=await owned(c);if(!live)fail('Y2_S4_PREPARATION_FENCE');
     if(await unresolvedEffects(ctx,c))fail('Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
     await c.query('UPDATE finnor_os.y2_episodes SET retained_bytes=retained_bytes+$3 WHERE tenant_id=$1 AND id=$2',
      [p.tenantId,live.row.episode_id,Buffer.byteLength(JSON.stringify(candidate))*4+16384]);
    });
    await retainEnterpriseStrategicControl(ctx,result);
   }
   await transaction(ctx,async c=>{
    const live=await owned(c);if(!live)fail('Y2_FINAL_USE_PUBLICATION_FENCE');
    if(use.kind==='DECISION'&&await unresolvedEffects(ctx,c))
     fail('Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
    const row=live.row,usage=process.cpuUsage(cpu);
    const artifact=status==='CHECKED'?{schema:'finnor.y2.response-use-artifact.v1',kind:use.kind,modelId:row.id,
     requestedModelId:use.requested_model_id,useId:use.id,modelRef:row.artifact!.envelope.contentRef,admissionRef:row.admission!.ref,
     originalEpisodeId:row.episode_id,deadlineAt:row.deadline_at.toISOString(),query,result:candidate,independentCheck:check,
     semanticCodeDigest:row.runtime.semanticCodeDigest,executionAuthorityGranted:false,protectedQualification:false,
     costs:{wallMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000,checkerCpuMs:check!.cpuMs??null,
      peakProcessRssBytes:process.resourceUsage().maxRSS*1024,checkerPeakRssBytes:check!.peakRssBytes??null,moneyUsd:null,humanSeconds:null,
      aggregatePeakMemoryBytes:null,status:'PARTIALLY_METERED',failedAttemptsRetained:true}}:null;
    if(artifact&&Buffer.byteLength(JSON.stringify(artifact))>PROFILE.maximumArtifactBytes)fail('Y2_USE_ARTIFACT_BOUND');
    await c.query('UPDATE finnor_os.y2_uses SET status=$3,check_result=$4::jsonb,artifact=$5::jsonb WHERE tenant_id=$1 AND id=$2',
     [p.tenantId,use.id,status,JSON.stringify(check),artifact?JSON.stringify(artifact):null]);
    await eventTx(c,row,'USE_RESULT','use-result:'+use.id+':'+e.deliveryAttemptId,{useId:use.id,status,check,candidateDigest:digest(candidate),
     originalEpisodeId:row.episode_id,physicalJobId:e.jobId,claimFence:e.claimFence});
   });
  }
 }catch(error){
  const reason=(error as Error).message;disposition=/^[A-Z0-9_:]{1,256}$/.test(reason)?reason:'Y2_NATIVE_FAILURE';
  if(original)await transaction(ctx,async c=>{
   const row=await modelTx(ctx,c,p.modelId);
   await eventTx(c,row,'NATIVE_FAILURE','failure:'+e.deliveryAttemptId,{predicate:disposition,useId:p.useId??null,
    deliveryAttemptId:e.deliveryAttemptId,originalEpisodeRetained:true,checkpointRetained:!!(originalUse?.candidate??row.candidate)});
   if(p.useId)await c.query("UPDATE finnor_os.y2_uses SET status=$4 WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND NOT cancelled AND artifact IS NULL AND status<>'INVALIDATED'",
    [p.tenantId,p.useId,p.generation,/INCOMPLETE|BOUND|LIMIT/.test(disposition)?'INCOMPLETE':'UNKNOWN']);
   else await c.query("UPDATE finnor_os.y2_models SET status=$4 WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND NOT cancelled AND artifact IS NULL AND status<>'INVALIDATED'",
    [p.tenantId,p.modelId,p.generation,/INCOMPLETE|BOUND|LIMIT/.test(disposition)?'INCOMPLETE':'UNKNOWN']);
  });
  throw error;
 }finally{
  abort.abort();
  try{
   if(registered)await transaction(ctx,async c=>{
    const row=await modelTx(ctx,c,p.modelId),usage=process.cpuUsage(cpu);
    await eventTx(c,row,'NATIVE_COST','cost:'+e.deliveryAttemptId,{useId:p.useId??null,deliveryAttemptId:e.deliveryAttemptId,disposition,
     originalEpisodeId:row.episode_id,wallMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000,checkerCpuMs:check?.cpuMs??null,
     peakProcessRssBytes:process.resourceUsage().maxRSS*1024,checkerPeakRssBytes:check?.peakRssBytes??null,moneyUsd:null,humanSeconds:null,
     aggregatePeakMemoryBytes:null,failedAttemptsRetained:true,sourceDigest:row.runtime.semanticCodeDigest});
   });
  }finally{await releaseComputeResourceLeases(leases,'y2_strategic_delivery_finished');}
 }
}
