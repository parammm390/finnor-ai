import {randomUUID} from 'node:crypto';
import type {PeMutationContext} from '../types';
import {resolveDecisionWork} from '../decision-slice/adapters';
import {resolveEnterpriseAllocationProblem,assertEnterpriseAllocationSourceVisibility,assertEnterpriseAllocationSourcesCurrent} from '../enterprise-allocation';
import {recognizeUniformAllocation,uniformProblemIdentity} from '../../../epistemic-runtime/src/uniform-algorithms/applicability';
import {affectedClosure} from '../live-recompilation/contracts';
import {SubmitSchema,ReadSchema,ListSchema,InvalidateSchema,diagnosticProfile,digest,fail,UniformOwnerError} from './contracts';
import {currentUniformEnvironment} from './source-cut';
import {tx,principal,authorizeTx,discoveryTx,commonDiscoveryTx,isTotalDiscovery,currentTx,problemCutTx,capsuleTx,enqueueTx,eventTx,type DiscoveryRow} from './store';
import {assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {TotalReadSchema} from './total-contracts';
import {readTotalDiscovery} from './total-service';
export {consumeUniformAlgorithm} from './consumer';

export async function submitUniformDiscovery(ctx:PeMutationContext,value:unknown){
 diagnosticProfile();const input=SubmitSchema.parse(value),environment=await currentUniformEnvironment();
 await resolveDecisionWork(ctx,input.workId);
 const originalCut=await tx(ctx,async c=>{await authorizeTx(ctx,c,input.root,input.workId);return problemCutTx(ctx,c,input.root,input.workId);});
 const originalProblem=await resolveEnterpriseAllocationProblem(ctx,input.allocation),problemIdentity=uniformProblemIdentity(originalProblem);
 return tx(ctx,async c=>{
  await authorizeTx(ctx,c,input.root,input.workId);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['y5:'+ctx.auth.tenantId+':'+principal(ctx)+':'+input.idempotencyKey]);
  const prior=(await c.query<DiscoveryRow>('SELECT * FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');return {discoveryId:prior.id,workId:prior.work_id,status:prior.status,replayed:true};}
  if(digest(await problemCutTx(ctx,c,input.root,input.workId))!==digest(originalCut))fail('Y5_ORIGINAL_SOURCE_MOVED_DURING_RESOLUTION');
  const exists=(await c.query('SELECT id FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND (work_id=$3 OR episode_id=$4)',
   [ctx.auth.tenantId,principal(ctx),input.workId,originalProblem.episodeId])).rows[0];
  if(exists)fail('Y5_ORIGINAL_WORK_OR_EPISODE_ALREADY_ALLOCATED');
  const binding={...originalCut,problemIdentity,originalProblem,environment};
  const deadlineAt=new Date(Math.min(Date.now()+input.limits.wallMs,Date.parse(originalProblem.validUntil)));
  const id=randomUUID(),a=(await c.query<DiscoveryRow>(`INSERT INTO finnor_os.y5_discoveries
   (tenant_id,principal_id,id,work_id,root_type,root_id,episode_id,request,request_digest,binding,deadline_at,max_attempts,max_uses,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14) RETURNING *`,
   [ctx.auth.tenantId,principal(ctx),id,input.workId,input.root.entityType,input.root.entityId,originalProblem.episodeId,
    JSON.stringify(input),digest(input),JSON.stringify(binding),deadlineAt,input.limits.maxAttempts,input.limits.maxUses,input.idempotencyKey])).rows[0]!;
  await currentTx(ctx,c,a);
  const jobId=await enqueueTx(c,{tenantId:a.tenant_id,principalId:a.principal_id,discoveryId:id,generation:1},a.max_attempts);
  await eventTx(c,a,'submitted','SUBMITTED',{jobId,problemIdentity,originalProblemRef:originalProblem.ref,
   applicability:recognizeUniformAllocation(originalProblem),deadlineAt,sourceDigest:environment.sourceDigest,
   specificationAcceptance:'AUTHENTICATED_SUPPLIED_ORIGINAL_MODEL_NOT_PROTECTED_ACCEPTANCE',baselineQualified:false,
   completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,protectedAdmission:false});
  return {discoveryId:id,workId:a.work_id,status:'QUEUED',jobId,replayed:false,protectedAdmission:false};
 });
}
export async function readUniformDiscovery(ctx:PeMutationContext,value:unknown){
 const input=TotalReadSchema.parse(value),kind=await tx(ctx,c=>commonDiscoveryTx(ctx,c,input.discoveryId));
 if(isTotalDiscovery(kind))return readTotalDiscovery(ctx,input);
 const {discoveryId}=ReadSchema.parse(value);
 const observed=await tx(ctx,async(c,authorityValidUntil)=>{
  const a=await discoveryTx(ctx,c,discoveryId);
  return {a,authorityValidUntil,cut:digest(await problemCutTx(ctx,c,{entityType:a.root_type,entityId:a.root_id},a.work_id))};
 });
 let sourceReadAllowed=false,ownerSourcesCurrent=false;
 try{await assertEnterpriseAllocationSourceVisibility(ctx,observed.a.binding.originalProblem);sourceReadAllowed=true;}catch{}
 if(sourceReadAllowed)try{await assertEnterpriseAllocationSourcesCurrent(ctx,observed.a.binding.originalProblem);ownerSourcesCurrent=true;}catch{}
 return tx(ctx,async c=>{
  const a=await discoveryTx(ctx,c,discoveryId);
  let sourcePayloadsVisible=sourceReadAllowed&&observed.cut===digest(await problemCutTx(ctx,c,{entityType:a.root_type,entityId:a.root_id},a.work_id));
  if(sourcePayloadsVisible&&observed.authorityValidUntil)try{await assertAuthorityTemporalBoundsTx(c,[observed.authorityValidUntil]);}catch{sourcePayloadsVisible=false;}
  let current=sourcePayloadsVisible&&ownerSourcesCurrent,reason:string|null=sourcePayloadsVisible?(ownerSourcesCurrent?null:'Y5_BOUND_ALLOCATION_SOURCES_NOT_CURRENT'):'Y5_BOUND_SOURCE_VISIBILITY_NOT_ESTABLISHED';
  if(current)try{await currentTx(ctx,c,a);}catch(error){current=false;reason=error instanceof UniformOwnerError?error.code:'Y5_CURRENT_OWNER_CONTEXT_NOT_ESTABLISHED';}
  const capsule=current?await capsuleTx(c,a):null;
  const historyColumns=sourcePayloadsVisible?'id::text,kind,created_at,body':'id::text,kind,created_at';
  const history=(await c.query('SELECT '+historyColumns+' FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 ORDER BY id DESC LIMIT 64',[a.tenant_id,a.principal_id,a.id])).rows;
  const costs={originalDeadline:a.deadline_at,attempts:a.attempt_count,maxAttempts:a.max_attempts,uses:a.use_count,maxUses:a.max_uses,completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,events:'y5_events'};
  return {discoveryId:a.id,workId:a.work_id,root:{entityType:a.root_type,entityId:a.root_id},status:a.status,current,currentnessReason:reason,capsule,
   sourceVisibility:sourcePayloadsVisible?'AUTHORIZED':'WITHHELD',historyPayloadsWithheld:!sourcePayloadsVisible,
   envelope:sourcePayloadsVisible?{artifact_id:a.result_digest,kind:'AlgorithmTheoryCapsule',schema_revision:'finnor.postx.y5.owner-envelope.v1',
    content_digest:a.result_digest,work_and_revision_refs:{workId:a.work_id,inputId:a.binding.work.id,inputDigest:a.binding.work.digest},
    tenant_and_participant_scope:{tenantId:a.tenant_id,principalId:a.principal_id,sharing:'CURRENT_S1_PRINCIPAL_ONLY'},
    baseline_manifest_ref:{ref:a.request.baselineManifestRef,qualified:false},
    producer_code_dependency_model_and_runtime_refs:{source:a.binding.environment,runtime:capsule?.runtime??null},
    source_revision_vector:a.binding.originalProblem.policies.map(p=>({ref:p.ref,demandDigest:p.demand.contentDigest})),
    knowledge_cut:a.binding.originalProblem.knowledgeAt,effective_time:a.binding.originalProblem.mandate.horizon.startAt,
    rights_and_authority_revision_refs:{rightsRef:a.binding.originalProblem.mandate.rightsRef,authorityRevision:a.binding.authorityRevision},
    mandate_ref:a.binding.originalProblem.mandate.ref,economic_semantics_and_domain_refs:{method:a.binding.originalProblem.methodVersion,problemIdentity:a.binding.problemIdentity,model:a.binding.originalProblem.jointModel.ref},
    claim_basis_and_independent_checker_refs:capsule?.checker??null,
    unresolved_assumptions_and_excluded_claims:['SUPPLIED_FINITE_JOINT_MODEL_UNADMITTED','INDEPENDENT_SPECIFICATION_AND_TRUST_POLICY_NOT_ESTABLISHED','PROTECTED_12_FAMILY_CAMPAIGN_NOT_RUN','NO_S8_PRODUCTION_ADMISSION','NO_OPERATIONAL_OR_S7_FINANCIAL_100X'],
    resource_reservation_and_complete_cost_refs:costs,
    invalidation_dependencies:{owner:'P7',theorem:['specification'],correspondence:['implementation','runtime'],applicability:['rights','instance'],admission:['admission']},
    admission_and_release_refs:{status:'UNADMITTED',protectedAdmission:false,productionActive:false},
    external_observation_and_s6_obligation_refs:{newEffects:[],newReservations:[],outstanding:a.binding.originalProblem.outstanding}}:
    {kind:'AlgorithmTheoryCapsule',schema_revision:'finnor.postx.y5.owner-envelope.v1',sourcePayloadsWithheld:true,
     reason:'Y5_BOUND_SOURCE_VISIBILITY_NOT_ESTABLISHED',resource_reservation_and_complete_cost_refs:costs},
   history,historyRetained:true,protectedAdmission:false,productionActive:false,executionAuthorityGranted:false,
   counters:{attempts:a.attempt_count,maxAttempts:a.max_attempts,uses:a.use_count,maxUses:a.max_uses,deadlineAt:a.deadline_at}};
 });
}
export async function listUniformDiscoveries(ctx:PeMutationContext,value:unknown){
 const input=ListSchema.parse(value);
 return tx(ctx,async c=>{await authorizeTx(ctx,c,input.root,input.workId);
  return {discoveries:(await c.query('SELECT id,status FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root_type=$4 AND root_id=$5 ORDER BY created_at DESC,id DESC LIMIT 32',[ctx.auth.tenantId,principal(ctx),input.workId,input.root.entityType,input.root.entityId])).rows};});
}
const graph=[{id:'specification',dependsOn:[]},{id:'theorem',dependsOn:['specification']},{id:'implementation',dependsOn:[]},{id:'runtime',dependsOn:[]},
 {id:'correspondence',dependsOn:['theorem','implementation','runtime']},{id:'rights',dependsOn:[]},{id:'instance',dependsOn:[]},
 {id:'applicability',dependsOn:['specification','rights','instance']},{id:'admission',dependsOn:['theorem','correspondence']},
 {id:'uses',dependsOn:['correspondence','applicability','admission']}];
export async function invalidateUniformDiscovery(ctx:PeMutationContext,value:unknown){
 const input=InvalidateSchema.parse(value);
 return tx(ctx,async c=>{
  const a=await commonDiscoveryTx(ctx,c,input.discoveryId,true),key='invalidate:'+input.idempotencyKey;
  const prior=(await c.query('SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4',[a.tenant_id,a.principal_id,a.id,key])).rows[0];
  if(prior){if(prior.body.requestDigest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');return prior.body;}
  const closure=affectedClosure(graph,[input.dependency]),body={requestDigest:digest(input),discoveryId:a.id,affected:closure.affectedNodes.map(n=>n.id),
   retained:closure.keptNodes.map(n=>n.id),reason:input.reason,theoremHistoryRetained:true,costHistoryRetained:true,effectsRolledBack:false};
  if(!['CANCELLED','INVALIDATED'].includes(a.status))await c.query("UPDATE finnor_os.y5_discoveries SET status='INVALIDATED',generation=generation+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[a.tenant_id,a.principal_id,a.id]);
  await eventTx(c,a,key,'P7_INVALIDATED',body);return body;
 });
}
export async function cancelUniformDiscovery(ctx:PeMutationContext,value:unknown){
 const input=ReadSchema.parse(value);
 return tx(ctx,async c=>{const a=await commonDiscoveryTx(ctx,c,input.discoveryId,true);
  const terminal=['CANCELLED','INVALIDATED'].includes(a.status);
  if(!terminal)await c.query("UPDATE finnor_os.y5_discoveries SET status='CANCELLED',generation=generation+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[a.tenant_id,a.principal_id,a.id]);
  await eventTx(c,a,'cancelled',terminal?'CANCEL_OBSERVED_TERMINAL':'CANCELLED',{originalDeadlineRetained:true,physicalCloseRequiredBeforeLeaseRelease:true,costsRetained:true});
  return {discoveryId:a.id,status:terminal?a.status:'CANCELLED',executionAuthorityGranted:false};});
}
