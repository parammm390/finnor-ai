import {receiveWork,reserveIdentificationResourceTx} from '@finnor/db';
import {evaluateAuthorityTx} from '@finnor/authority';
import type {PeMutationContext} from '../types';
import {authorize,revisions,unavailable} from '../owner-context';
import {workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {digitalProviderBindings,digitalProviderBinding,digitalProviderTarget,publicDigitalBinding,requireDisposableIdentification} from '../../../tools/src/identification-provider';
import {affectedClosure} from '../live-recompilation/contracts';
import type {IdentificationEnvelope,IdentifiedSystemModel,IdentifiedSystemRelease} from '@finnor/shared-types';
import {ConsentSchema,RevokeSchema,SubmitSchema,ReplicateSchema,UseSchema,ReadSchema,HistorySchema,ListSchema,TargetSchema,ControlSchema,InvalidateSchema,ExperimentReadSchema,
 parse,sha,fail,assertDomain,unknown,type IdentificationRow} from './contracts';
import {currentIdentificationEnvironment} from './source-cut';
import {commitIdentificationDecisionTx} from './consumer';
import {tx,principal,newId,rootOf,capabilityTx,consentTx,identificationTx,assertAllocation,assertRunCurrentTx,assertModelCurrentTx,modelTx,experimentsTx,eventTx,enqueueTx,vref,allocationRef} from './store';
export const IDENTIFICATION_GRAPH=[
 {id:'domain',dependsOn:[]},{id:'rights',dependsOn:[]},{id:'work',dependsOn:[]},{id:'runtime',dependsOn:[]},{id:'checker',dependsOn:[]},
 {id:'hypotheses',dependsOn:['domain','runtime']},{id:'instrument',dependsOn:['rights','runtime']},
 {id:'protocols',dependsOn:['hypotheses','rights','work']},{id:'observations',dependsOn:['instrument','protocols']},
 {id:'replication',dependsOn:['observations']},{id:'model',dependsOn:['replication','checker']},
 {id:'finding',dependsOn:['model']},{id:'decision',dependsOn:['finding']},{id:'admission',dependsOn:['model']},
];
export async function identificationTargets(ctx:PeMutationContext,value:unknown){
 const input=parse(TargetSchema,value);
 return tx(ctx,async c=>{await capabilityTx(ctx,c,input.root,'query:identified_system');return {targets:(await digitalProviderBindings({tenantId:ctx.auth.tenantId,rootId:input.root.entityId,principalId:principal(ctx)})).map(publicDigitalBinding),
  replicaSelection:'EXACT_CONSENTED_TARGET_ID_FROM_INDEPENDENT_ADMINISTRATOR',productionSupported:false};});
}
export async function grantIdentificationRights(ctx:PeMutationContext,value:unknown){
 requireDisposableIdentification();
 const input=parse(ConsentSchema,value);assertDomain(input.domain);
 if(new Set(input.targetIds).size!==input.targetIds.length||new Set(input.actorIds).size!==input.actorIds.length||
  !input.actorIds.includes(principal(ctx))||Date.parse(input.validUntil)<=Date.now()||Date.parse(input.validUntil)>Date.now()+3600000)fail('X4_FINITE_CONSENT_SCOPE_REQUIRED',400);
 return tx(ctx,async c=>{
  await capabilityTx(ctx,c,input.root,'action:grant_identification_rights');
  const actors=(await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='active'",[ctx.auth.tenantId,input.actorIds])).rows;
  if(actors.length!==input.actorIds.length)throw unavailable();
  for(const targetId of input.targetIds){
   const target=await digitalProviderTarget({tenantId:ctx.auth.tenantId,rootId:input.root.entityId,targetId});
   if(target.role!==input.domain.role||target.applicationVersion!==input.domain.applicationVersion)fail('X4_CONSENT_APPLICATION_DOMAIN_MISMATCH');
  }
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['x4-consent:'+ctx.auth.tenantId+':'+principal(ctx)+':'+input.idempotencyKey]);
  const prior=(await c.query('SELECT id,body_digest FROM finnor_os.x4_consents WHERE tenant_id=$1 AND owner_id=$2 AND body->>\'idempotencyKey\'=$3',[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.body_digest!==sha(input))fail('X4_IDEMPOTENCY_CONFLICT');return {consentId:prior.id,ref:vref('X4_RIGHTS',prior.id,prior.body_digest),replayed:true};}
  const id=newId();
  await c.query('INSERT INTO finnor_os.x4_consents(tenant_id,id,owner_id,root_id,body,body_digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[ctx.auth.tenantId,id,principal(ctx),input.root.entityId,JSON.stringify(input),sha(input)]);
  await assertAuthorityTemporalBoundsTx(c,[input.validUntil]);
  return {consentId:id,ref:vref('X4_RIGHTS',id,sha(input)),replayed:false,protectedAuthority:false};
 });
}
export async function submitIdentification(ctx:PeMutationContext,value:unknown){
 requireDisposableIdentification();
 const input=parse(SubmitSchema,value),environment=await currentIdentificationEnvironment();assertDomain(input.domain);
 if(input.sourceTargetId===input.replicationTargetId)fail('X4_DISTINCT_REPLICA_TARGET_REQUIRED',400);
 const admitted=await tx(ctx,async c=>{
  await capabilityTx(ctx,c,input.root,'action:run_system_identification');
  const consent=await consentTx(ctx,c,input.consentId,input.root.entityId);
  if(sha(input.domain)!==sha(consent.body.domain)||!consent.body.targetIds.includes(input.sourceTargetId)||!consent.body.targetIds.includes(input.replicationTargetId))fail('X4_EXACT_SCOPED_EXPERIMENT_RIGHTS_REQUIRED',403);
  const source=await digitalProviderBinding({tenantId:ctx.auth.tenantId,principalId:principal(ctx),rootId:input.root.entityId,targetId:input.sourceTargetId}),
   replica=await digitalProviderTarget({tenantId:ctx.auth.tenantId,rootId:input.root.entityId,targetId:input.replicationTargetId});
  if(source.instanceId===replica.instanceId||source.role!==input.domain.role||replica.role!==input.domain.role||source.applicationVersion!==input.domain.applicationVersion||replica.applicationVersion!==input.domain.applicationVersion)fail('X4_REPLICATION_INSTANCE_OR_DOMAIN_INVALID');
  return {targetDigests:{[source.id]:source.bindingDigest,[replica.id]:replica.bindingDigest}};
 });
 const work=input.workId?{workId:input.workId,workInputId:input.workInputId}:await receiveWork({
  tenantId:ctx.auth.tenantId,userId:principal(ctx),channel:'console',instruction:input.question.text+'\nTarget: '+input.question.target+'\nAffected decision: '+input.question.affectedDecision+'\nRequested claim: '+input.question.requestedClaimClass+'\nDevelopment digital experiments only.',
  idempotencyKey:'x4-work:'+principal(ctx)+':'+input.idempotencyKey,requireExactIntake:true,
  activeContext:{entityRefs:[input.root],identificationRequestDigest:sha(input)},
  entityAttachments:[{...input.root,source:'X4:authenticated-operational-question'}],
 });
 return tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['x4-submit:'+ctx.auth.tenantId+':'+principal(ctx)+':'+input.idempotencyKey]);
  await capabilityTx(ctx,c,input.root,'action:run_system_identification');
  await authorize(ctx,input.root,[{type:'work',id:work.workId},{type:'pe_workstream',id:input.decision.workstreamId},{type:'pe_investment_case',id:input.decision.investmentCaseId}],[],c);
  const prior=(await c.query<IdentificationRow>('SELECT * FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND owner_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==sha(input))fail('X4_IDEMPOTENCY_CONFLICT');return {identificationId:prior.id,workId:prior.work_id,status:prior.status,replayed:true};}
  if((await c.query('SELECT id FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND work_id=$2',[ctx.auth.tenantId,work.workId])).rowCount)fail('X4_ORIGINAL_WORK_ALREADY_ALLOCATED');
  const cut=await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:work.workId});
  if(work.workInputId&&cut.id!==work.workInputId)fail('X4_WORK_INPUT_CHANGED');
  const ws=(await c.query('SELECT id FROM finnor_os.pe_workstreams WHERE tenant_id=$1 AND id=$2 AND deal_id=$3',[ctx.auth.tenantId,input.decision.workstreamId,input.root.entityId])).rowCount,
   ic=(await c.query('SELECT id FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2 AND deal_id=$3',[ctx.auth.tenantId,input.decision.investmentCaseId,input.root.entityId])).rowCount;
  if(ws!==1||ic!==1)throw unavailable();
  const consent=await consentTx(ctx,c,input.consentId,input.root.entityId);
  const authority=await evaluateAuthorityTx(ctx.auth,{operation:'action',capability:'action:run_system_identification',resource:{type:'pe_deal',id:input.root.entityId},risk:'low'},c);
  if(authority.outcome!=='allowed')throw unavailable();
  const dependencies=await revisions(ctx,['rights:tenant','work-inputs:'+work.workId],c,true);
  const id=newId(),a=(await c.query<IdentificationRow>(`INSERT INTO finnor_os.x4_identifications
   (tenant_id,id,owner_id,root_id,work_id,work_input_id,work_input_digest,consent_id,request,request_digest,authority_binding,environment,dependencies,target_digests,deadline_at,max_experiments,max_observations,max_analysis,max_uses,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20) RETURNING *`,
   [ctx.auth.tenantId,id,principal(ctx),input.root.entityId,work.workId,cut.id,cut.digest,input.consentId,JSON.stringify(input),sha(input),
    JSON.stringify({id:authority.id,digest:sha(JSON.parse(JSON.stringify(authority))),revision:authority.authorityRevision}),JSON.stringify(environment),JSON.stringify(dependencies),JSON.stringify(admitted.targetDigests),
    new Date(Date.now()+input.limits.deadlineMs),input.limits.maxExperiments,input.limits.maxObservationCalls,input.limits.maxAnalysisJobs,input.limits.maxUses,input.idempotencyKey])).rows[0]!;
  await assertRunCurrentTx(ctx,c,a);
  // Completed transport children are not completion of the scientific Work.
  // The native Work owner keeps this occupation waiting for checked use or
  // explicit continuation, without granting business/financial completion.
  await c.query("INSERT INTO finnor_os.work_programme_occupations(tenant_id,work_id,owner,programme_id,status,revision) VALUES($1,$2,'X4_IDENTIFICATION',$3,'WAITING',1)",[a.tenant_id,a.work_id,a.id]);
  const jobId=await enqueueTx(c,{stage:'DISCOVER',tenantId:a.tenant_id,principalId:a.owner_id,identificationId:a.id,generation:a.generation},'x4-discover:'+id+':1');
  const result={identificationId:id,workId:a.work_id,workInputId:cut.id,jobId,status:'QUEUED',replayed:false};
  await eventTx(c,a,principal(ctx),'SUBMITTED','submit',{...result,question:input.question,requestDigest:a.request_digest,authorityRef:vref('S1_AUTHORITY_DECISION',authority.id,a.authority_binding.digest,String(authority.authorityRevision)),
   consentRef:vref('X4_RIGHTS',a.consent_id,consent.body_digest),originalDeadlineAt:a.deadline_at.toISOString(),originalLimits:input.limits,qualification:'DEVELOPMENT_NOT_PROTECTED'});
  return result;
 });
}
export async function submitIdentificationReplication(ctx:PeMutationContext,value:unknown){
 const input=parse(ReplicateSchema,value);
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId,'action:replicate_identified_system');
  if(principal(ctx)===a.owner_id)fail('X4_INDEPENDENT_PRINCIPAL_REQUIRED',403);
  await assertRunCurrentTx(ctx,c,a);
  const prior=(await c.query('SELECT id,status,request_digest FROM finnor_os.x4_assignments WHERE tenant_id=$1 AND identification_id=$2 AND actor_id=$3 AND idempotency_key=$4',[a.tenant_id,a.id,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==sha(input))fail('X4_IDEMPOTENCY_CONFLICT');return {assignmentId:prior.id,status:prior.status,replayed:true};}
  if(!['AWAITING_REPLICATION','DEVELOPMENT_READY'].includes(a.status)||a.head_model_id!==input.expectedModelId)fail('X4_REPLICATION_ASSIGNMENT_CHANGED');
  await digitalProviderBinding({tenantId:a.tenant_id,rootId:a.root_id,targetId:a.request.replicationTargetId,principalId:principal(ctx)});
  const id=newId();
  await c.query('INSERT INTO finnor_os.x4_assignments(tenant_id,id,identification_id,actor_id,request,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[a.tenant_id,id,a.id,principal(ctx),JSON.stringify(input),sha(input),input.idempotencyKey]);
  await c.query("UPDATE finnor_os.x4_identifications SET status='REPLICATING' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
  const jobId=await enqueueTx(c,{stage:'REPLICATE',tenantId:a.tenant_id,principalId:principal(ctx),identificationId:a.id,generation:a.generation,assignmentId:id},'x4-replicate:'+id);
  await eventTx(c,a,principal(ctx),'INDEPENDENT_REPLICATION_ASSIGNED','replica:'+id,{assignmentId:id,jobId,targetId:a.request.replicationTargetId,principalId:principal(ctx),expectedModelId:input.expectedModelId,predictions:'IMMUTABLE_BEFORE_DISPATCH'});
  return {assignmentId:id,jobId,status:'QUEUED',replayed:false};
 });
}
export async function submitIdentificationUse(ctx:PeMutationContext,value:unknown){
 const input=parse(UseSchema,value);
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId,'action:use_identified_system'),m=await modelTx(c,a,input.modelId);
  if(principal(ctx)!==a.owner_id)fail('X4_CURRENT_ORIGINAL_DECISION_PRINCIPAL_REQUIRED',403);
  const prior=(await c.query('SELECT id,status,request_digest FROM finnor_os.x4_uses WHERE tenant_id=$1 AND identification_id=$2 AND actor_id=$3 AND idempotency_key=$4',[a.tenant_id,a.id,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==sha(input))fail('X4_IDEMPOTENCY_CONFLICT');return {useId:prior.id,status:prior.status,replayed:true};}
  let guard:string|null=null;try{await assertModelCurrentTx(ctx,c,a,m.body);}catch(e){guard=e instanceof Error&&/^X4_[A-Z0-9_]+$/.test(e.message)?e.message:'X4_MODEL_NOT_CURRENT';}
  const id=newId();
  if(!guard)await reserveIdentificationResourceTx(c,{tenantId:a.tenant_id,identificationId:a.id,principalId:principal(ctx),kind:'USE',idempotencyKey:'use:'+id,detail:{modelId:m.id,useId:id}});
  await c.query('INSERT INTO finnor_os.x4_uses(tenant_id,id,identification_id,model_id,actor_id,request,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[a.tenant_id,id,a.id,m.id,principal(ctx),JSON.stringify(input),sha(input),input.idempotencyKey]);
  if(guard){
   // A denied guard performs no scientific analysis, experiment or allocated
   // use. Persist the actual decision owner's WAIT and its retained audit cost.
   const decision=await commitIdentificationDecisionTx(ctx,c,a,m.body,id,null,guard);
   await eventTx(c,a,principal(ctx),'MODEL_USE_REFUSED_BEFORE_ALLOCATION','refused-use:'+id,{useId:id,reason:guard,
    scientificUseCharged:false,externalOperationCreated:false,retainedStorageCharged:true,clientComputeLeaseCharged:true,money:unknown('No complete API money meter is available.')});
   return {useId:id,status:'WAIT',...decision,externalOperationCreated:false,replayed:false};
  }
  const jobId=await enqueueTx(c,{stage:'USE',tenantId:a.tenant_id,principalId:principal(ctx),identificationId:a.id,generation:a.generation,useId:id},'x4-use:'+id);
  await eventTx(c,a,principal(ctx),'DECISION_USE_ASSIGNED','use:'+id,{useId:id,modelId:m.id,jobId});
  return {useId:id,jobId,status:'QUEUED',replayed:false};
 });
}
async function envelopeTx(c:import('pg').PoolClient,a:IdentificationRow,m:IdentifiedSystemRelease,current:boolean):Promise<IdentificationEnvelope>{
 const events=(await c.query<{id:string;kind:string;body:any}>("SELECT id::text,kind,body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND kind IN('CHILD_RESOURCES','PHYSICAL_OPERATION','OBSERVATION_ATTEMPT','OPERATION_FAILED') ORDER BY id",[a.tenant_id,a.id])).rows;
 const costs=events.map(e=>vref('X4_EVENT',e.id,sha(e.body)));
 const consent=(await c.query('SELECT body_digest FROM finnor_os.x4_consents WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.consent_id])).rows[0]!;
 const allocation=allocationRef(a);
 const sourceRefs=[...m.instrumentRefs,...m.observationRefs],s6=(await experimentsTx(c,a)).map(e=>vref('S6_BUSINESS_EFFECT',e.protocol.effect.businessEffectId,sha(e.protocol.effect)));
 const baseline=vref('B_live',a.id,sha(a.environment),'X4_RUNTIME_CUT_V1'),modelRef=vref('S3_IDENTIFIED_SYSTEM',m.id,sha(m));
 return {artifact_id:m.id,kind:'IdentifiedSystemModel',schema_revision:'finnor.frontier-artifact-envelope.v1',content_digest:sha(m),content_digest_basis:'IMMUTABLE_X4_RELEASE_BODY_V1',
  tenant_ref:{owner:'@finnor/db',table:'tenants',id:a.tenant_id},principal_ref:{owner:'@finnor/db',table:'users',tenantId:a.tenant_id,id:a.owner_id},
  work_ref:vref('WORK_INPUT',a.work_id,a.work_input_digest,a.work_input_id),institutional_program_ref:unknown('No compatible immutable X1 institutional programme was supplied.'),parent_artifact_refs:[],
  producer_revision:vref('SOURCE','X4_PRODUCER',m.environment.sourceDigest),baseline_manifest_ref:baseline,baseline_manifest_kind:'B_live',
  authority_grant_ref:vref('S1_AUTHORITY_DECISION',a.authority_binding.id,a.authority_binding.digest,String(a.authority_binding.revision)),
  rights_revision:consent.body_digest,resource_grant_ref:allocation,resource_lease_refs:events.filter(e=>e.kind==='PHYSICAL_OPERATION').flatMap(e=>(e.body.leases??[]).map((l:any)=>vref('S5_COMPUTE_LEASE',l.ownerId,sha(l),String(l.fence)))),
  source_refs:sourceRefs,source_revision_vector:Object.fromEntries(sourceRefs.map(r=>[r.owner+':'+r.id,r.revision])),
  knowledge_cut:{at:m.createdAt,meaning:'REGISTERED_RAW_EXPERIMENT_AND_CONTROL_EVIDENCE',observationRefs:m.observationRefs},
  admitted_domain_ref:unknown('A current S8 development admission must be read live; protected admission and production remain unestablished.'),
  application_fingerprints:Object.entries(a.target_digests).map(([id,digest])=>vref('X4_ROLE_BOUND_APPLICATION',id,digest)),
  model_refs:[modelRef],model_use:'CHECKED_FINITE_EXECUTABLE_PROGRAMMES',dependency_lock_digest:m.environment.lockDigest,runtime_digest:m.environment.runtimeDigest,
  observed_claims:[{claim:'PHYSICALLY_DELIVERED_AND_COMPLETELY_OBSERVED_REGISTERED_EXPERIMENTS',basis:vref('S3_INDEPENDENT_CHECK',m.id,m.checkDigest),scope:'Exact finite consented development domain, not unique mechanism'}],
  inferred_claims:[{claim:m.achievedClaimClass,basis:modelRef,assumptions:Object.keys(m.domain.assumptions)}],
  predicted_claims:m.freshPredictionRefs.map(r=>({claim:'FRESH_REGISTERED_PREDICTION_MATCHED',protocolRef:r,observed:true})),
  unresolved_claims:[{claim:'UNIQUE_HIDDEN_MECHANISM',critical:m.question.requestedClaimClass==='MECHANISM_SPECIFIC',value:unknown('Remaining syntax classes and out-of-domain mechanisms are not distinguished.')},
   {claim:'PROTECTED_36_SYSTEM_QUALIFICATION',critical:true,value:unknown('Original protected population, independent custody and qualified equipped baseline were not supplied.')},
   {claim:'COMPLETE_LIFECYCLE_COST',critical:true,value:unknown('Provider money, complete human effort and exact aggregate simultaneous memory were not independently metered.')}],
  postcondition_contract_refs:m.experimentRefs,independent_check_refs:[vref('S3_INDEPENDENT_CHECK',m.id,m.checkDigest)],
  S6_obligation_refs:s6,provider_observation_refs:m.observationRefs,
  invalidation_dependencies:{owner:'P7',refs:[...sourceRefs,vref('X4_RIGHTS',a.consent_id,consent.body_digest),baseline,allocation,modelRef],currentOwnerChecksRequired:true},
  lifecycle_state:{state:a.status,current,developmentOnly:true,protectedAdmission:false,productionActive:false},
  lifecycle_events:{owner:'@finnor/db',table:'x4_events',identificationId:a.id,read:{operation:'identification-history',identificationId:a.id}},
  build_learning_compute_cost_refs:{events:costs,money:unknown('No complete matched money denominator is available.'),aggregateMemory:unknown('Per-process RSS is not exact aggregate simultaneous memory.'),failedAndInterruptedAttemptsRetained:true},
  attributable_human_work_refs:unknown('Preparation, interpretation, engineering, supervision and rescue effort have no complete independent time record.')};
}
export async function readIdentification(ctx:PeMutationContext,value:unknown){
 const input=parse(ReadSchema,value);
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId);let model:IdentifiedSystemModel|null=null,current=false,currentnessReason:string|null=null;
  if(a.head_model_id){
   const m=await modelTx(c,a);try{await assertModelCurrentTx(ctx,c,a,m.body);current=true;}catch(e){currentnessReason=e instanceof Error&&/^X4_[A-Z_]+$/.test(e.message)?e.message:'X4_CURRENT_OWNER_PROOF_UNAVAILABLE';}
   model={...m.body,envelope:await envelopeTx(c,a,m.body,current)};
  }
  const experiments=(await experimentsTx(c,a)).map(e=>({id:e.id,phase:e.phase,status:e.status,condition:e.protocol.condition,protocolDigest:e.protocol_digest,registeredAt:e.created_at.toISOString(),
   effect:e.protocol.effect,observation:e.result,evidenceRef:e.evidence_source_id?vref('CORE_EVIDENCE_VERSION',e.evidence_source_id,e.evidence_digest!,e.evidence_version_id!):null}));
  const assignments=(await c.query('SELECT id,actor_id,status,experiment_id,result,created_at FROM finnor_os.x4_assignments WHERE tenant_id=$1 AND identification_id=$2 ORDER BY created_at,id',[a.tenant_id,a.id])).rows,
   uses=(await c.query('SELECT id,model_id,actor_id,status,experiment_id,decision_id,result,created_at FROM finnor_os.x4_uses WHERE tenant_id=$1 AND identification_id=$2 ORDER BY created_at,id',[a.tenant_id,a.id])).rows;
  const family=(await c.query('SELECT body,body_digest FROM finnor_os.x4_families WHERE tenant_id=$1 AND identification_id=$2',[a.tenant_id,a.id])).rows[0],
   instruments=(await c.query('SELECT id,body,body_digest FROM finnor_os.x4_instruments WHERE tenant_id=$1 AND identification_id=$2 ORDER BY created_at,id',[a.tenant_id,a.id])).rows;
  if(family&&sha(family.body)!==family.body_digest||instruments.some(i=>sha(i.body)!==i.body_digest))fail('X4_SCIENTIFIC_HISTORY_INTEGRITY');
  return {identificationId:a.id,workId:a.work_id,workInputId:a.work_input_id,ownerId:a.owner_id,status:a.status,generation:a.generation,question:a.request.question,
   root:rootOf(a),mode:a.request.mode,current,currentnessReason,model,family:family?.body??null,instruments,experiments,assignments,uses,
   guard:current?'CURRENT_DEVELOPMENT_ONLY':'WAIT_NO_COMPLETION',limits:{deadlineAt:a.deadline_at.toISOString(),original:a.request.limits,spent:{experiments:a.experiment_count,observations:a.observation_count,analysisJobs:a.analysis_count,uses:a.use_count,retainedBytes:a.data_bytes}},
   qualification:'DEVELOPMENT_NOT_PROTECTED',protectedAdmission:false,productionActive:false};
 });
}
export async function listIdentifications(ctx:PeMutationContext,value:unknown){
 const input=parse(ListSchema,value);
 return tx(ctx,async c=>{
  await capabilityTx(ctx,c,input.root,'query:identified_system');await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
  const rows=(await c.query<IdentificationRow>('SELECT * FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND root_id=$2 AND work_id=$3',[ctx.auth.tenantId,input.root.entityId,input.workId])).rows;
  const result=[];
  for(const a of rows){await consentTx(ctx,c,a.consent_id,a.root_id,false);result.push({identificationId:a.id,status:a.status,modelId:a.head_model_id,workId:a.work_id});}
  return {identifications:result};
 });
}
export async function identificationHistory(ctx:PeMutationContext,value:unknown){
 const input=parse(HistorySchema,value);
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId),rows=(await c.query('SELECT id::text,kind,actor_id,body,created_at FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND ($3::bigint IS NULL OR id<$3::bigint) ORDER BY id DESC LIMIT $4',[a.tenant_id,a.id,input.before??null,input.limit+1])).rows;
  return {events:rows.slice(0,input.limit),next:rows.length>input.limit?rows[input.limit-1]!.id:null};
 });
}
export async function readIdentificationExperiment(ctx:PeMutationContext,value:unknown){
 const input=parse(ExperimentReadSchema,value);
 return tx(ctx,async c=>{const a=await identificationTx(ctx,c,input.identificationId),e=(await c.query('SELECT * FROM finnor_os.x4_experiments WHERE tenant_id=$1 AND identification_id=$2 AND id=$3',[a.tenant_id,a.id,input.experimentId])).rows[0];if(!e)throw unavailable();return e;});
}
export async function controlIdentification(ctx:PeMutationContext,value:unknown,mode:'CANCEL'|'INVALIDATE'|'RETRY'){
 const input=mode==='INVALIDATE'?parse(InvalidateSchema,value):parse(ControlSchema,value);
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId,'action:run_system_identification');
  if(a.owner_id!==principal(ctx))throw unavailable();
  const key=mode.toLowerCase()+':'+input.idempotencyKey,prior=(await c.query('SELECT body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=$3',[a.tenant_id,a.id,key])).rows[0];
  if(prior){if(prior.body.requestDigest!==sha(input))fail('X4_IDEMPOTENCY_CONFLICT');return prior.body;}
  if(mode==='RETRY'){
   await assertRunCurrentTx(ctx,c,a);
   if(!['FAILED','WAITING'].includes(a.status)||a.analysis_count>=a.max_analysis||a.observation_count>=a.max_observations)fail('X4_ORIGINAL_RECOVERY_ALLOCATION_EXHAUSTED');
   const generation=a.generation+1;
   await c.query("UPDATE finnor_os.x4_identifications SET generation=$3,status='QUEUED' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,generation]);
   const jobId=await enqueueTx(c,{stage:'DISCOVER',tenantId:a.tenant_id,principalId:a.owner_id,identificationId:a.id,generation},'x4-discover:'+a.id+':'+generation);
   const result={identificationId:a.id,jobId,generation,requestDigest:sha(input),originalDeadlineAt:a.deadline_at.toISOString(),resourcesReplenished:false,recovery:'ORIGINAL_EXPERIMENT_READBACK_ONLY_IF_POSSIBLY_DELIVERED'};
   await eventTx(c,a,principal(ctx),'RETRY_ORIGINAL_IDENTITY',key,result);return result;
  }
  const changed=mode==='INVALIDATE'?(input as ReturnType<typeof InvalidateSchema.parse>).changed:['work'];
  const closure=affectedClosure(IDENTIFICATION_GRAPH,changed);
  await c.query("UPDATE finnor_os.x4_identifications SET status=CASE WHEN status IN('CANCELLED','INVALIDATED') THEN status ELSE $3 END,generation=generation+1 WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,mode==='CANCEL'?'CANCELLED':'INVALIDATED']);
  if(mode==='INVALIDATE')await c.query('INSERT INTO finnor_os.x4_invalidations(tenant_id,id,identification_id,actor_id,model_id,reason,body,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
   [a.tenant_id,newId(),a.id,principal(ctx),a.head_model_id,input.reason,JSON.stringify({changed,affectedNodes:closure.affectedNodes.map(n=>n.id),keptNodes:closure.keptNodes.map(n=>n.id)}),key]);
  const result={identificationId:a.id,status:mode==='CANCEL'?'CANCELLED':'INVALIDATED',requestDigest:sha(input),reason:input.reason,
   affectedNodes:closure.affectedNodes.map(n=>n.id),keptNodes:closure.keptNodes.map(n=>n.id),externalEffectsUndone:false,historyRetained:true,resourcesReplenished:false};
  await eventTx(c,a,principal(ctx),mode==='CANCEL'?'CANCELLED':'P7_DEPENDENCY_CLOSURE_INVALIDATED',key,result);return result;
 });
}
export async function revokeIdentificationRights(ctx:PeMutationContext,value:unknown){
 const input=parse(RevokeSchema,value);
 return tx(ctx,async c=>{
  const row=(await c.query('SELECT * FROM finnor_os.x4_consents WHERE tenant_id=$1 AND id=$2',[ctx.auth.tenantId,input.consentId])).rows[0];
  if(!row||row.owner_id!==principal(ctx))throw unavailable();
  await capabilityTx(ctx,c,{entityType:'pe_deal',entityId:row.root_id},'action:grant_identification_rights');
  const prior=(await c.query('SELECT * FROM finnor_os.x4_consent_revocations WHERE tenant_id=$1 AND consent_id=$2',[ctx.auth.tenantId,input.consentId])).rows[0];
  if(prior&&(prior.reason!==input.reason||prior.idempotency_key!==input.idempotencyKey))fail('X4_IDEMPOTENCY_CONFLICT');
  if(!prior)await c.query('INSERT INTO finnor_os.x4_consent_revocations(tenant_id,consent_id,actor_id,reason,idempotency_key) VALUES($1,$2,$3,$4,$5)',[ctx.auth.tenantId,input.consentId,principal(ctx),input.reason,input.idempotencyKey]);
  const rows=(await c.query<IdentificationRow>('SELECT * FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND consent_id=$2 FOR UPDATE',[ctx.auth.tenantId,input.consentId])).rows;
  for(const a of rows){
   await c.query("UPDATE finnor_os.x4_identifications SET status=CASE WHEN status='CANCELLED' THEN status ELSE 'INVALIDATED' END,generation=generation+1 WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
   await eventTx(c,a,principal(ctx),'RIGHTS_REVOKED','rights-revoked:'+input.consentId,{consentId:input.consentId,reason:input.reason,externalEffectsUndone:false,auditHistoryRetained:true,futureModelUse:false});
  }
  return {consentId:input.consentId,revoked:true,futureUseRevoked:true,externalEffectsUndone:false,historyRetained:true};
 });
}
