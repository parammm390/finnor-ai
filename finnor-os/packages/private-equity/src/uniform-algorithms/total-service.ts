import {randomUUID} from 'node:crypto';
import type {PeMutationContext} from '../types';
import {readAllocationEpisodeCut} from '../allocation-experience';
import {resolveTotalTask} from '../allocation-total-task';
import {matchingTotalTaskRequests} from '../allocation-total-episodes';
import {resolveTotalSpecification} from './specification';
import {currentUniformEnvironment} from './source-cut';
import {digest,diagnosticProfile,fail} from './contracts';
import {tx,principal,authorizeTx,commonDiscoveryTx,enqueueTx,eventTx} from './store';
import {TotalSubmitSchema,TotalReadSchema,validateTotalDiscovery,type TotalDiscoveryRow,type TotalOwnerBinding} from './total-contracts';
import {totalCutTx,totalDiscoveryTx,resolveTotalBinding,assertTotalResolutionTx,currentTotalTx,
 totalCapsuleTx,projectTotalDevelopment} from './total-owner';
export {consumeTotalAlgorithm} from './total-consumer';

export async function submitTotalDiscovery(ctx:PeMutationContext,value:unknown,invocationDeadlineAt=Date.now()+28500){
 diagnosticProfile();const input=TotalSubmitSchema.parse(value);
 const prior=await tx(ctx,async c=>{
  await authorizeTx(ctx,c,input.root,input.workId);await authorizeTx(ctx,c,input.root,input.taskWorkId);
  const a=(await c.query<{id:string;work_id:string;request_digest:string;status:string}>(
   'SELECT id,work_id,request_digest,status FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(a&&a.request_digest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');return a;
 });
 if(prior)return {discoveryId:prior.id,workId:prior.work_id,status:prior.status,replayed:true,protectedAdmission:false};
 const originalCut=await tx(ctx,c=>totalCutTx(ctx,c,input.root,input.workId,input.taskWorkId));
 const resolved=await resolveTotalSpecification(ctx,{root:input.root,workId:input.workId});
 if(resolved.status==='UNAVAILABLE')fail('Y5_TOTAL_AUTHENTICATED_SPECIFICATION_REQUIRED');
 const originalTask=await resolveTotalTask(ctx,input.root,input.taskWorkId,resolved.specification);
 if(digest(originalTask.work)!==digest(originalCut.taskWork))fail('Y5_TOTAL_TASK_CHANGED_DURING_SUBMISSION');
 const knowledgeCut=new Date().toISOString(),episodeCut=await readAllocationEpisodeCut(ctx,{knowledgeCut},invocationDeadlineAt),
  development=projectTotalDevelopment(episodeCut,originalTask),environment=await currentUniformEnvironment();
 const binding:TotalOwnerBinding={schema:'finnor.y5.total-owner-binding.v2',work:originalCut.work,
  authorityRevision:originalCut.authorityRevision,dependencies:originalCut.dependencies,
  specification:resolved.specification,originalTask,episodeCut,...development,environment};
 if(Buffer.byteLength(JSON.stringify(binding))>3932160)fail('Y5_TOTAL_COMPLETE_OWNER_BINDING_BOUND',413);
 if(Date.now()>=invocationDeadlineAt)fail('Y5_ORIGINAL_REQUEST_DEADLINE',408);
 const id=randomUUID(),deadlineAt=new Date(Date.now()+input.limits.wallMs),a:TotalDiscoveryRow={
  tenant_id:ctx.auth.tenantId,principal_id:principal(ctx),id,work_id:input.workId,root_type:input.root.entityType,
  root_id:input.root.entityId,episode_id:'total-task:'+input.taskWorkId,request:input,request_digest:digest(input),binding,
  deadline_at:deadlineAt,generation:1,attempt_count:0,use_count:0,max_attempts:input.limits.maxAttempts,max_uses:input.limits.maxUses,
  status:'QUEUED',result_digest:null};
 validateTotalDiscovery(a);
 const resolution=await resolveTotalBinding(ctx,a,'DISCOVERY');
 return tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['y5:'+a.tenant_id+':'+a.principal_id+':'+input.idempotencyKey]);
  await authorizeTx(ctx,c,input.root,input.workId);await authorizeTx(ctx,c,input.root,input.taskWorkId);
  const prior=(await c.query<TotalDiscoveryRow>('SELECT * FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [a.tenant_id,a.principal_id,input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==a.request_digest)fail('Y5_IDEMPOTENCY_CONFLICT');
   return {discoveryId:prior.id,workId:prior.work_id,status:prior.status,replayed:true,protectedAdmission:false};}
  const exists=(await c.query('SELECT id FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND (work_id=$3 OR episode_id=$4)',
   [a.tenant_id,a.principal_id,a.work_id,a.episode_id])).rows[0];
  if(exists)fail('Y5_ORIGINAL_WORK_OR_EPISODE_ALREADY_ALLOCATED');
  await currentTotalTx(ctx,c,a,'DISCOVERY');await assertTotalResolutionTx(ctx,c,resolution);
  if(Date.now()>=invocationDeadlineAt)fail('Y5_ORIGINAL_REQUEST_DEADLINE',408);
  await c.query(`INSERT INTO finnor_os.y5_discoveries
   (tenant_id,principal_id,id,work_id,root_type,root_id,episode_id,request,request_digest,binding,deadline_at,max_attempts,max_uses,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14)`,
   [a.tenant_id,a.principal_id,a.id,a.work_id,a.root_type,a.root_id,a.episode_id,JSON.stringify(input),a.request_digest,
    JSON.stringify(binding),deadlineAt,a.max_attempts,a.max_uses,input.idempotencyKey]);
  const jobId=await enqueueTx(c,{tenantId:a.tenant_id,principalId:a.principal_id,discoveryId:a.id,generation:a.generation},a.max_attempts);
  await eventTx(c,a,'submitted','SUBMITTED',{schema:input.schema,jobId,taskRef:originalTask.sourceRef,
   specificationRef:resolved.specification.sourceRef,definitionDigest:resolved.specification.definitionDigest,
   episodeCutDigest:episodeCut.cutDigest,selectionRule:episodeCut.selectionRule,episodes:episodeCut.episodes,
   recordKinds:[...new Set(episodeCut.records.map(r=>r.kind))],developmentProjectionDigest:digest(development),
   campaignDeadline:deadlineAt,theoremLifetime:'NOT_CAMPAIGN_DEADLINE_CURRENT_OWNER_FENCES_APPLY',
   sourceDigest:environment.sourceDigest,specificationAcceptance:resolved.specification.acceptance,
   completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,protectedAdmission:false,allocationOptimalityClaimed:false});
  return {discoveryId:a.id,workId:a.work_id,status:'QUEUED',jobId,replayed:false,protectedAdmission:false};
 });
}
export async function readTotalDiscovery(ctx:PeMutationContext,value:unknown){
 const input=TotalReadSchema.parse(value),observed=await tx(ctx,c=>totalDiscoveryTx(ctx,c,input.discoveryId));
 let resolution:Awaited<ReturnType<typeof resolveTotalBinding>>|null=null,reason:string|null=null;
 try{resolution=await resolveTotalBinding(ctx,observed,'READ');}catch{reason='Y5_BOUND_SOURCE_VISIBILITY_NOT_ESTABLISHED';}
 return tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,input.discoveryId);
  let visible=!!resolution,current=visible;
  if(resolution)try{await assertTotalResolutionTx(ctx,c,resolution);}catch{visible=false;current=false;reason='Y5_BOUND_SOURCE_VISIBILITY_NOT_ESTABLISHED';}
  if(current)try{await currentTotalTx(ctx,c,a,'READ');}catch{current=false;reason='Y5_CURRENTNESS_NOT_ESTABLISHED';}
  const capsule=current&&input.includeCapsule?await totalCapsuleTx(c,a):null;
  const history=input.includeHistory?(await c.query('SELECT id::text,kind,created_at'+
   (visible?",body - 'capsule' AS body":'')+
   ' FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 ORDER BY id DESC LIMIT 64',
   [a.tenant_id,a.principal_id,a.id])).rows:[];
  const episodeCut=visible?{cutDigest:a.binding.episodeCut.cutDigest,selectionRule:a.binding.episodeCut.selectionRule,
   knowledgeCut:a.binding.episodeCut.knowledgeCut,episodes:a.binding.episodeCut.episodes,
   recordKinds:[...new Set(a.binding.episodeCut.records.map(r=>r.kind))],
   recordCount:a.binding.episodeCut.records.length,acceptedModelEpisodes:[...new Set(
    matchingTotalTaskRequests(a.binding.episodeCut.records,a.binding.originalTask)
     .filter(r=>r.result.status==='MODEL_ACCEPTED').map(r=>r.record.body.episodeId))],
   allocationContextAcceptedModelEpisodes:[...new Set(a.binding.episodeCut.acceptedAllocations.map(x=>x.problem.episodeId))],
   ...(input.includeCapsule?{records:a.binding.episodeCut.records,futureKnowledgeExcluded:a.binding.episodeCut.futureKnowledgeExcluded}:{}),
   protectedFamilyCredit:false}:null;
  const costs={campaignDeadline:a.deadline_at,attempts:a.attempt_count,maxAttempts:a.max_attempts,uses:a.use_count,maxUses:a.max_uses,
   completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,events:'y5_events'};
  return {schema:'finnor.y5.total-owner-read.v2',discoveryId:a.id,workId:a.work_id,
   root:{entityType:a.root_type,entityId:a.root_id},status:a.status,current,currentnessReason:reason,
   capsule,capsuleAvailable:current&&a.result_digest!==null,capsuleDigest:visible?a.result_digest:null,
   specification:visible?a.binding.specification:null,episodeCut,
   originalTask:visible?{workId:a.binding.originalTask.workId,sourceRef:a.binding.originalTask.sourceRef,
    items:a.binding.originalTask.instance.values.length}:null,
   sourceVisibility:visible?'AUTHORIZED':'WITHHELD',historyPayloadsWithheld:!visible,history,historyRetained:true,
   envelope:{kind:'AlgorithmTheoryCapsule',schema_revision:'finnor.postx.y5.owner-envelope.v2',
    sourcePayloadsWithheld:!visible,resource_reservation_and_complete_cost_refs:costs,
    ...(visible?{content_digest:a.result_digest,work_and_revision_refs:{workId:a.work_id,...a.binding.work},
     producer_code_dependency_model_and_runtime_refs:{source:a.binding.environment,runtime:capsule?.runtime??null},
     claim_basis_and_independent_checker_refs:capsule?.checker??null,
     knowledge_cut:a.binding.episodeCut.knowledgeCut,semanticOwner:'S5',taskMeaning:'EXACT_LEAST_INITIAL_STATE_NOT_ALLOCATION_OPTIMUM',
     invalidation_dependencies:{owner:'P7',theorem:['specification'],correspondence:['implementation','runtime'],
      applicability:['rights','instance'],admission:['admission']}}:{}),
    unresolved_assumptions_and_excluded_claims:['PUBLIC_DEVELOPMENT_NO_PROTECTED_FAMILY_CREDIT','NO_PROTECTED_CUSTODY',
     'NO_INDEPENDENT_TRUST_POLICY_ACCEPTANCE','NO_S8_PRODUCTION_ADMISSION','NO_OPERATIONAL_OR_S7_FINANCIAL_100X']},
   protectedAdmission:false,productionActive:false,executionAuthorityGranted:false,
   counters:{attempts:a.attempt_count,maxAttempts:a.max_attempts,uses:a.use_count,maxUses:a.max_uses,deadlineAt:a.deadline_at}};
 });
}
