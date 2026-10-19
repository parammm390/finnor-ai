import {z} from 'zod';
import {receiveWork} from '@finnor/db';
import {canExerciseAuthorityTx} from '@finnor/authority';
import type {LearnedPolicyCapsule,VReference} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {authorize,unavailable} from '../owner-context';
import {applicationTx,workCutTx,recordTx as nativeRecordTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {currentLearningConsentTx,resolveAcceptedLearningExperienceTx} from '../../../capability-evolution/src/learning-experience';
import {affectedClosure} from '../live-recompilation/contracts';
import {ConsentBodySchema,ConsentRevokeSchema,SubmitSchema,ReadSchema,ListSchema,ExecuteSchema,EvaluateSchema,ControlSchema,RetrainSchema,RollbackSchema,parse,sha,fail,unknown,FEATURE_ORDER} from './contracts';
import {currentLearningEnvironment} from './source-cut';
import {tx,principal,newId,compilationTx,releaseTx,assertAllocation,assertWorkTx,assertReleaseCurrentTx,eventTx,enqueueTx,rootOf,type CompilationRow} from './store';
import type {LearningRelease} from './types';
import {assertUseAssignmentTx} from './assignments';

export async function grantTrainingRights(ctx:PeMutationContext,value:unknown){
 const input=parse(ConsentBodySchema,value);
 if(Date.parse(input.validUntil)<=Date.now())fail('X5_CONSENT_EXPIRY_INVALID',400);
 if(Date.parse(input.knowledgeCut)>Date.now()||Date.parse(input.knowledgeCut)>Date.parse(input.validUntil))fail('X5_CONSENT_KNOWLEDGE_CUT_INVALID',400);
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:grant_learning_rights');
  if(a.owner_id!==principal(ctx))fail('X5_DATA_OWNER_CONSENT_REQUIRED',403);
  if(Date.parse(input.validUntil)>a.deadline_at.getTime())fail('X5_CONSENT_EXCEEDS_SOURCE_ALLOCATION');
  const prior=(await c.query('SELECT id,body_digest FROM finnor_os.x5_training_rights WHERE tenant_id=$1 AND owner_id=$2 AND body->>\'idempotencyKey\'=$3',[a.tenant_id,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.body_digest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return {consentId:prior.id,ref:{owner:'X5_RIGHTS',id:prior.id,revision:'1',contentDigest:prior.body_digest},replayed:true};}
  const id=newId();
  await c.query('INSERT INTO finnor_os.x5_training_rights(tenant_id,id,application_id,owner_id,body,body_digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[a.tenant_id,id,a.id,principal(ctx),JSON.stringify(input),sha(input)]);
  await assertAuthorityTemporalBoundsTx(c,[input.validUntil,a.deadline_at.toISOString()]);
  return {consentId:id,ref:{owner:'X5_RIGHTS',id,revision:'1',contentDigest:sha(input)},replayed:false,protectedAuthority:false};
 });
}
export async function revokeTrainingRights(ctx:PeMutationContext,value:unknown){
 const input=parse(ConsentRevokeSchema,value);
 return tx(ctx,async c=>{
  const row=(await c.query<{application_id:string;owner_id:string}>('SELECT application_id,owner_id FROM finnor_os.x5_training_rights WHERE tenant_id=$1 AND id=$2',[ctx.auth.tenantId,input.consentId])).rows[0];
  if(!row||row.owner_id!==principal(ctx))throw unavailable();
  await applicationTx(ctx,c,row.application_id,'action:grant_learning_rights');
  const prior=(await c.query('SELECT * FROM finnor_os.x5_rights_revocations WHERE tenant_id=$1 AND consent_id=$2',[ctx.auth.tenantId,input.consentId])).rows[0];
  if(prior&&(prior.reason!==input.reason||prior.idempotency_key!==input.idempotencyKey))fail('X5_IDEMPOTENCY_CONFLICT');
  if(!prior)await c.query('INSERT INTO finnor_os.x5_rights_revocations(tenant_id,consent_id,actor_id,reason,idempotency_key) VALUES($1,$2,$3,$4,$5)',[ctx.auth.tenantId,input.consentId,principal(ctx),input.reason,input.idempotencyKey]);
  return {consentId:input.consentId,revoked:true,derivedUseRevoked:true,weightsUnlearned:false,historyRetained:true};
 });
}
export async function inspectLearningExperience(ctx:PeMutationContext,value:unknown){
 const input=parse(SubmitSchema.pick({experience:true,knowledgeCut:true}),value);
 return tx(ctx,async c=>{
  const cut=await resolveAcceptedLearningExperienceTx(ctx,c,input.experience,input.knowledgeCut);
  return {...cut,samples:undefined,sampleCount:cut.samples.length};
 });
}
export async function submitLearning(ctx:PeMutationContext,value:unknown){
 const input=parse(SubmitSchema,value),environment=await currentLearningEnvironment();
 if(Date.parse(input.knowledgeCut)>Date.now())fail('X5_KNOWLEDGE_CUT_INVALID',400);
 await tx(ctx,async c=>{
  await authorize(ctx,input.root,[],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:compile_learned_policy',resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  for(const s of input.experience)await currentLearningConsentTx(ctx,c,s.consentId,s.applicationId);
 });
 const work=input.workId?{workId:input.workId,workInputId:input.workInputId}:await receiveWork({
  tenantId:ctx.auth.tenantId,userId:principal(ctx),channel:'console',
  instruction:'Compile a bounded learned reconciliation policy from current independently accepted consented experience. Development only; no protected promotion or external effects.',
  idempotencyKey:'x5-work:'+principal(ctx)+':'+input.idempotencyKey,requireExactIntake:true,
  activeContext:{entityRefs:[input.root],experienceSelectionDigest:sha(input.experience)},
  entityAttachments:[{...input.root,source:'X5:accepted-experience-compilation'}],
 });
 return tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['x5-submit:'+ctx.auth.tenantId+':'+principal(ctx)+':'+input.idempotencyKey]);
  await authorize(ctx,input.root,[{type:'work',id:work.workId}],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:compile_learned_policy',resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  const prior=(await c.query<CompilationRow>('SELECT * FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND owner_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return {compilationId:prior.id,workId:prior.work_id,status:prior.status,replayed:true};}
  if((await c.query('SELECT id FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND work_id=$2 LIMIT 1',[ctx.auth.tenantId,work.workId])).rowCount)
   fail('X5_ORIGINAL_WORK_ALREADY_ALLOCATED');
  const current=await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:work.workId});
  if(work.workInputId&&work.workInputId!==current.id)fail('X5_WORK_INPUT_CHANGED');
  const id=newId(),a=(await c.query<CompilationRow>(`INSERT INTO finnor_os.x5_compilations
   (tenant_id,id,owner_id,root_type,root_id,work_id,work_input_id,work_input_digest,request,request_digest,environment,deadline_at,max_attempts,max_uses,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15) RETURNING *`,
   [ctx.auth.tenantId,id,principal(ctx),input.root.entityType,input.root.entityId,work.workId,current.id,current.digest,JSON.stringify(input),sha(input),JSON.stringify(environment),new Date(Date.now()+input.limits.deadlineMs),input.limits.maxAttempts,input.limits.maxUses,input.idempotencyKey])).rows[0]!;
  const jobId=await enqueueTx(c,{stage:'TRAIN',tenantId:a.tenant_id,principalId:a.owner_id,compilationId:id,generation:1},'x5-train:'+id+':1');
  const result={compilationId:id,workId:a.work_id,workInputId:current.id,jobId,status:'QUEUED',replayed:false};
  await eventTx(c,a,principal(ctx),'SUBMITTED','submit',result);return result;
 });
}
export async function submitLearningUse(ctx:PeMutationContext,value:unknown){
 const input=parse(ExecuteSchema,value);
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:execute_learned_policy'),r=await releaseTx(c,a,input.releaseId);
  await assertUseAssignmentTx(c,a,input);
  const temporalBounds=await assertReleaseCurrentTx(ctx,c,a,r,input.applicationId);
  await applicationTx(ctx,c,input.applicationId,'action:operate_enterprise_application');
  const record=await nativeRecordTx(c,await applicationTx(ctx,c,input.applicationId),input.recordId);
  const prior=(await c.query('SELECT id,request_digest,status FROM finnor_os.x5_uses WHERE tenant_id=$1 AND compilation_id=$2 AND principal_id=$3 AND idempotency_key=$4',[a.tenant_id,a.id,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return {useId:prior.id,status:prior.status,replayed:true};}
  if(a.use_count>=a.max_uses)fail('X5_ORIGINAL_USE_BUDGET_EXHAUSTED');
  if(record.concurrency_revision!==input.expectedRevision)fail('X5_FRESH_INPUT_CHANGED');
  const id=newId(),checkpoint=input.mode==='COMPILED_ORIGINAL'?r.originalCheckpoint:r.checkpoint;
  await c.query('UPDATE finnor_os.x5_compilations SET use_count=use_count+1 WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.id]);
  await c.query(`INSERT INTO finnor_os.x5_uses(tenant_id,id,compilation_id,release_id,principal_id,request,request_digest,idempotency_key,checkpoint_digest,policy_digest)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,[a.tenant_id,id,a.id,r.id,principal(ctx),JSON.stringify(input),sha(input),input.idempotencyKey,checkpoint.digest,r.policyDigest]);
  const jobId=await enqueueTx(c,{stage:'EXECUTE',tenantId:a.tenant_id,principalId:principal(ctx),compilationId:a.id,generation:a.generation,useId:id},'x5-use:'+id);
  const result={useId:id,jobId,status:'QUEUED',releaseId:r.id,checkpointDigest:checkpoint.digest,policyDigest:r.policyDigest,replayed:false};
  await eventTx(c,a,principal(ctx),'USE_ASSIGNED','use-assigned:'+id,result);await assertAuthorityTemporalBoundsTx(c,temporalBounds);return result;
 });
}
export async function retrainLearning(ctx:PeMutationContext,value:unknown){
 const input=parse(RetrainSchema,value);
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:compile_learned_policy');
  if(a.owner_id!==principal(ctx))throw unavailable();
  assertAllocation(a);await assertWorkTx(c,a);
  const key='retrain:'+input.idempotencyKey,prior=(await c.query('SELECT body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND idempotency_key=$3',[a.tenant_id,a.id,key])).rows[0];
  if(prior){if(prior.body.requestDigest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return prior.body;}
  if(!['DEVELOPMENT_READY','FAILED'].includes(a.status)||a.attempt_count>=a.max_attempts)fail('X5_RETRAIN_ORIGINAL_ALLOCATION_EXHAUSTED');
  const temporalBounds=[a.deadline_at.toISOString()];
  await resolveAcceptedLearningExperienceTx(ctx,c,input.experience,input.knowledgeCut,temporalBounds);
  const generation=a.generation+1;
  await c.query("UPDATE finnor_os.x5_compilations SET status='QUEUED',generation=$3 WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,generation]);
  await c.query("UPDATE finnor_os.x5_uses SET status='CANCELLED',result=jsonb_build_object('error','X5_EXPLICITLY_ABORTED_FOR_RETRAIN','originalIdentityRetained',true) WHERE tenant_id=$1 AND compilation_id=$2 AND status IN('QUEUED','RUNNING')",[a.tenant_id,a.id]);
  const jobId=await enqueueTx(c,{stage:'TRAIN',tenantId:a.tenant_id,principalId:a.owner_id,compilationId:a.id,generation},'x5-train:'+a.id+':'+generation);
  const result={compilationId:a.id,experience:input.experience,knowledgeCut:input.knowledgeCut,reason:input.reason,requestDigest:sha(input),generation,jobId,status:'QUEUED',
   resourcesReplenished:false,originalDeadlineAt:a.deadline_at.toISOString(),previousReleasesRetained:true,pendingCalls:'EXPLICITLY_ABORTED_WITH_ORIGINAL_IDENTITY'};
  await eventTx(c,a,principal(ctx),'RETRAIN_REQUESTED',key,result);await assertAuthorityTemporalBoundsTx(c,temporalBounds);return result;
 });
}
export async function submitLearningEvaluation(ctx:PeMutationContext,value:unknown){
 const input=parse(EvaluateSchema,value);
 if(new Set([...input.useIds,...input.retainedUseIds]).size!==input.useIds.length+input.retainedUseIds.length)fail('X5_EVALUATION_PARTITIONS_OVERLAP',400);
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:evaluate_learned_policy'),r=await releaseTx(c,a,input.releaseId);
  if(principal(ctx)===a.owner_id)fail('X5_INDEPENDENT_EVALUATOR_REQUIRED',403);
  const temporalBounds=await assertReleaseCurrentTx(ctx,c,a,r);
  const prior=(await c.query('SELECT id,status,request_digest FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND compilation_id=$2 AND evaluator_id=$3 AND idempotency_key=$4',[a.tenant_id,a.id,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return {evaluationId:prior.id,status:prior.status,replayed:true};}
  const id=newId();
  await c.query('INSERT INTO finnor_os.x5_evaluations(tenant_id,id,compilation_id,release_id,evaluator_id,request,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[a.tenant_id,id,a.id,r.id,principal(ctx),JSON.stringify(input),sha(input),input.idempotencyKey]);
  const jobId=await enqueueTx(c,{stage:'EVALUATE',tenantId:a.tenant_id,principalId:principal(ctx),compilationId:a.id,generation:a.generation,evaluationId:id},'x5-evaluation:'+id);
  await eventTx(c,a,principal(ctx),'EVALUATION_REGISTERED','evaluation-registered:'+id,{evaluationId:id,assignmentDigest:sha({useIds:input.useIds,retainedUseIds:input.retainedUseIds}),jobId,feedback:'PUBLIC_DEVELOPMENT_AGGREGATES_NOT_PROTECTED'});
  await assertAuthorityTemporalBoundsTx(c,temporalBounds);
  return {evaluationId:id,jobId,status:'QUEUED',replayed:false};
 });
}
function vref(owner:string,id:string,digest:string,revision='1'):VReference{return {owner,id,revision,contentDigest:digest};}
async function capsuleTx(c:import('pg').PoolClient,a:CompilationRow,r:LearningRelease):Promise<LearnedPolicyCapsule>{
 const e=(await c.query<{count:string;through:string|null}>('SELECT count(*)::text count,max(id)::text through FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2',[a.tenant_id,a.id])).rows[0]!;
 const events={owner:'@finnor/db' as const,table:'x5_events' as const,tenantId:a.tenant_id,compilationId:a.id,throughEventId:e.through,count:e.count,read:{operation:'learning-read' as const,compilationId:a.id}};
 const evaluation=(await c.query('SELECT id,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND compilation_id=$2 AND release_id=$3 AND status=\'COMPLETE\' ORDER BY created_at DESC,id DESC LIMIT 1',[a.tenant_id,a.id,r.id])).rows[0];
 const evalRef=evaluation?vref('X5_EVALUATION',evaluation.id,sha(evaluation.result)):unknown('Fresh independently implemented native outcome evaluation has not completed.');
 const proposal=(await c.query("SELECT body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND kind='S8_PROPOSED' AND body->>'releaseId'=$3 ORDER BY id DESC LIMIT 1",[a.tenant_id,a.id,r.id])).rows[0]?.body;
 const positive=r.experience.records.filter(v=>v.status==='ACCEPTED'),sources=[...r.experience.positiveEvidenceRefs,...positive.flatMap(v=>v.sourceRefs)],rights=[...new Map(positive.map(v=>[v.consentRef.id,v.consentRef])).values()];
 const bodyRef=vref('X5_RELEASE',r.id,sha(r)),policyRef=vref('X5_POLICY',r.id,r.policyDigest),modelRef=vref('X5_CHECKPOINT',r.checkpoint.digest,r.checkpoint.digest);
 const environment=vref('B_live',a.id,sha(r.environment),'X5_RUNTIME_CUT_V1'),work=vref('WORK',a.work_id,a.work_input_digest,a.work_input_id);
 const money=unknown('Complete acquisition, preparation, compilation, failed training, evaluation, hosting, serving, fallback, invalidation, repair and recovery money is not independently metered.');
 const human=unknown('Complete human preparation, interpretation, supervision, engineering and rescue seconds/cost are not independently metered.');
 const admission=unknown('Current S8 admission must be resolved live. Training and stored proposals are not admission or activation.');
 return {schema:'finnor.learned-policy-capsule.v1',envelope:{
  artifact_id:r.id,kind:'LearnedPolicyCapsule',schema_revision:'finnor.frontier-artifact-envelope.v1',content_digest:sha(r),content_digest_basis:'IMMUTABLE_X5_RELEASE_BODY_V1',
  tenant_ref:{owner:'@finnor/db',table:'tenants',id:a.tenant_id},work_ref:work,institutional_program_ref:unknown('No compatible immutable X1 institutional-program handoff was supplied.'),
  parent_artifact_refs:[],producer_revision:vref('SOURCE','X5_PRODUCER',r.environment.sourceDigest),baseline_manifest_ref:environment,
  authority_grant_ref:unknown('Current canonical activity authority is enforced; this development profile emits no immutable authority-grant receipt.'),
  rights_revision:sha(rights),resource_grant_ref:vref('X5_ORIGINAL_ALLOCATION',a.id,sha({requestDigest:a.request_digest,deadlineAt:a.deadline_at.toISOString(),maxAttempts:a.max_attempts,maxUses:a.max_uses})),
  source_refs:sources,source_revision_vector:Object.fromEntries(sources.map(v=>[v.owner+':'+v.id,v.revision])),
  knowledge_cut:{at:r.experience.knowledgeCut,experienceCutDigest:r.experience.cutDigest,qualification:r.experience.qualification},admitted_domain_ref:admission,
  application_fingerprints:positive.map(v=>vref('X3_RELEASE',v.originalAssignment!.releaseId,v.originalAssignment!.specificationDigest)),
  model_refs:[vref('X5_CHECKPOINT',r.originalCheckpoint.digest,r.originalCheckpoint.digest),modelRef],
  dependency_lock_digest:r.environment.lockDigest,runtime_digest:sha(r.environment),
  observed_claims:[{claim:'ACTUAL_CPU_TRAINING_AND_SAFE_CHECKPOINT',basis:bodyRef,scope:'Development structural controller; task acceptance and protected parameter endpoint remain separate.'}],
  inferred_claims:[],predicted_claims:[],unresolved_claims:[{claim:'COMPLETE_COST',value:money},{claim:'HUMAN_WORK',value:human},{claim:'PROTECTED_ADMISSION',value:admission}],
  postcondition_contract_refs:[policyRef],independent_check_refs:evaluation?[evalRef as VReference]:[],
  S6_obligation_refs:unknown('This profile performs no consequential dispatch; existing pending effects block use and are never cleared by learning.'),
  provider_observation_refs:unknown('No provider/business-effect observation is established by training or local reconciliation approval.'),
  invalidation_dependencies:{owner:'P7',refs:[...sources,...rights,policyRef,modelRef,environment],currentOwnerChecksRequired:true},
  lifecycle_state:{state:a.status,developmentOnly:true,protectedAdmission:false,productionActive:false},lifecycle_events:events,
  build_learning_compute_cost_refs:{events,completeMoney:money,aggregateMemory:unknown('Child peak RSS and sampled command process trees do not attest exact aggregate simultaneous memory.'),failedAttemptsRetained:true},
  attributable_human_work_refs:human,
 },independently_accepted_training_evidence_refs:r.experience.positiveEvidenceRefs,
 transferable_state_abstraction:{format:'STRUCTURAL_BOOLEANS_8_V1',features:[...FEATURE_ORDER],excludes:['IDENTIFIERS','PRIVATE_FACTS','CREDENTIALS','OLD_PERMISSIONS','EXACT_BUSINESS_AMOUNTS']},
 typed_policy_or_procedure_program:r.policy,
 application_and_institution_binding_requirements:{profile:'PE_FIRM_DELAYED_RECONCILIATION_V1',tenantBinding:'FRESH_CURRENT',operationBinding:'FRESH_NATIVE_X3_SEMANTICS',permissions:'CURRENT_OWNER_AUTHORITY_NOT_TRAINING_GRANTS',unsupported:['CROSS_TENANT_WITHOUT_COMPATIBLE_HANDOFF','PORTFOLIO_COMPANY_OPERATION','ARBITRARY_CODE','UNKNOWN_EFFECT_REPLAY','PROTECTED_OR_PRODUCTION_ACTIVATION']},
 trained_component_architecture_and_checkpoint:{original:r.originalCheckpoint,trained:r.checkpoint,inference:'SAFE_JSON_F64_CPU',externalWeights:false},
 training_data_rights_and_partition_manifest:{rightsRefs:rights,partitionDigest:r.experience.partitionDigest,knowledgeCut:r.experience.knowledgeCut,qualification:'PUBLIC_DEVELOPMENT_NOT_PROTECTED',noCausalReward:true},
 training_algorithm_and_resource_receipts:{algorithm:r.training.configuration.algorithm,configuration:{...r.training.configuration},sampleCount:r.training.sampleCount,samplesDigest:r.training.samplesDigest,parameterChange:r.training.parameterChange,physicalJobRef:vref('JOB_DELIVERY',r.job.deliveryAttemptId,sha(r.job)),wallMs:r.resources.wallMs,cpuMicros:r.resources.cpuMicros,peakProcessRSSBytes:r.resources.peakProcessRSSBytes,money,human},
 validity_guard_and_failure_monitor:{guard:r.policy.guard,failureMonitor:r.policy.failureMonitor,deadlineAt:a.deadline_at.toISOString(),currentnessRequired:true},
 accepted_action_and_effect_interfaces:{operations:r.policy.operations,effectAuthorityGranted:false,pendingEffects:'BLOCK_NO_REPLAY'},
 independent_transfer_and_retention_results:evalRef,procedure_and_parameter_ablation_results:evalRef,
 amortization_and_invalidation_record:{eligibleDevelopmentDemand:32,horizon:'REGISTERED_FINITE_DEVELOPMENT_CAMPAIGN',completeLifecycleCost:money,reasoningConsumption:unknown('Provider-reported frontier reasoning and complete lifecycle comparison are unavailable; zero calls is not a reasoning reduction.'),invalidation:'REVOKE_DEPENDENT_USE_NO_UNLEARNING_OR_EXTERNAL_EFFECT_ROLLBACK'},
 s8_admission_and_promotion_refs:{proposal:proposal?.candidate?{owner:proposal.candidate.ref.owner,id:proposal.candidate.ref.id,revision:proposal.candidate.ref.version,contentDigest:proposal.candidate.ref.contentDigest}:unknown('No S8 proposal has been recorded.'),admission,protectedAdmission:false,productionActive:false}};
}
export async function readLearning(ctx:PeMutationContext,value:unknown){
 const input=parse(ReadSchema,value);
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId),r=a.head_release_id?await releaseTx(c,a):null;
  let current=!!r,reason:string|null=null;
  if(r)try{await assertReleaseCurrentTx(ctx,c,a,r);}catch(error){current=false;reason=error instanceof Error?error.message:'X5_CURRENTNESS_UNAVAILABLE';}
  const uses=(await c.query(`SELECT id,release_id,principal_id,status,checkpoint_digest,policy_digest,
   request->>'mode' mode,result->>'disposition' disposition,result->>'fallback' fallback,result->>'nativeInvoked' native_invoked,result->>'error' error
   FROM finnor_os.x5_uses WHERE tenant_id=$1 AND compilation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 256`,[a.tenant_id,a.id])).rows;
  const evaluations=(await c.query('SELECT id,release_id,evaluator_id,status,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND compilation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 16',[a.tenant_id,a.id])).rows;
  const history=(await c.query("SELECT h.id::text,h.kind,h.actor_id,h.created_at,h.body->>'error' error FROM finnor_os.x5_events h WHERE h.tenant_id=$1 AND h.compilation_id=$2 ORDER BY h.id DESC LIMIT 64",[a.tenant_id,a.id])).rows;
  return {compilationId:a.id,workId:a.work_id,root:rootOf(a),status:a.status,current,currentnessReason:reason,headReleaseId:a.head_release_id,
   identity:r?{releaseId:r.id,policyDigest:r.policyDigest,originalCheckpointDigest:r.originalCheckpoint.digest,checkpointDigest:r.checkpoint.digest,sourceDigest:r.environment.sourceDigest}:null,
   capsule:r&&current?await capsuleTx(c,a,r):null,uses,evaluations,history,
   counters:{attempts:a.attempt_count,maxAttempts:a.max_attempts,uses:a.use_count,maxUses:a.max_uses,dataBytes:Number(a.data_bytes),deadlineAt:a.deadline_at.toISOString()},
   developmentOnly:true,protectedAdmission:false,productionActive:false};
 });
}
export async function listLearning(ctx:PeMutationContext,value:unknown){
 const input=parse(ListSchema,value);
 return tx(ctx,async c=>{
  await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'query',capability:'query:learned_policy',resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  return {compilations:(await c.query('SELECT id,status,head_release_id FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND root_type=$2 AND root_id=$3 AND work_id=$4 ORDER BY created_at DESC,id DESC LIMIT 64',[ctx.auth.tenantId,input.root.entityType,input.root.entityId,input.workId])).rows};
 });
}
export async function controlLearning(ctx:PeMutationContext,value:unknown,operation:'CANCEL'|'INVALIDATE'|'RETRY'){
 const input=parse(ControlSchema,value);
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:compile_learned_policy');if(a.owner_id!==principal(ctx))throw unavailable();
  const key=operation+':'+input.idempotencyKey,prior=(await c.query('SELECT body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND idempotency_key=$3',[a.tenant_id,a.id,key])).rows[0];
  if(prior){if(prior.body.requestDigest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return prior.body;}
  const next=operation==='RETRY'?'QUEUED':operation==='CANCEL'?'CANCELLED':'INVALIDATED';
  if(operation==='RETRY'){assertAllocation(a);if(a.status!=='FAILED'||a.attempt_count>=a.max_attempts)fail('X5_RETRY_ORIGINAL_ALLOCATION_EXHAUSTED');}
  const graph=[{id:'evidence',dependsOn:[]},{id:'rights',dependsOn:[]},{id:'policy',dependsOn:['evidence','rights']},{id:'checkpoint',dependsOn:['policy']},{id:'evaluation',dependsOn:['checkpoint']},{id:'use',dependsOn:['evaluation']}];
  const closure=affectedClosure(graph,['evidence','rights']);
  await c.query('UPDATE finnor_os.x5_compilations SET status=$3,generation=generation+1 WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.id,next]);
  await c.query("UPDATE finnor_os.x5_uses SET status='CANCELLED',result=jsonb_build_object('error',$3::text,'originalIdentityRetained',true) WHERE tenant_id=$1 AND compilation_id=$2 AND status IN('QUEUED','RUNNING')",[a.tenant_id,a.id,'X5_'+next]);
  const result={operation,status:next,requestDigest:sha(input),reason:input.reason,affectedNodes:closure.affectedNodes.map(n=>n.id),historyRetained:true,resourcesReplenished:false,externalEffectsUndone:false};
  await eventTx(c,a,principal(ctx),operation,key,result);
  if(operation==='RETRY')await enqueueTx(c,{stage:'TRAIN',tenantId:a.tenant_id,principalId:a.owner_id,compilationId:a.id,generation:a.generation+1},'x5-train:'+a.id+':'+(a.generation+1));
  return result;
 });
}
export async function rollbackLearning(ctx:PeMutationContext,value:unknown){
 const input=parse(RollbackSchema,value);
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:compile_learned_policy');if(a.owner_id!==principal(ctx))throw unavailable();
  const r=await releaseTx(c,a,input.releaseId),temporalBounds=await assertReleaseCurrentTx(ctx,c,a,r);
  const key='rollback:'+input.idempotencyKey,prior=(await c.query('SELECT body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND idempotency_key=$3',[a.tenant_id,a.id,key])).rows[0];
  if(prior){if(prior.body.requestDigest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return prior.body;}
  await c.query('UPDATE finnor_os.x5_compilations SET head_release_id=$3 WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.id,r.id]);
  const result={releaseId:r.id,checkpointDigest:r.checkpoint.digest,requestDigest:sha(input),externalEffectsUndone:false,failedAssignmentsErased:false,revokedRightsRestored:false};
  await eventTx(c,a,principal(ctx),'COMPATIBLE_EARLIER_RELEASE_SELECTED',key,result);await assertAuthorityTemporalBoundsTx(c,temporalBounds);return result;
 });
}
