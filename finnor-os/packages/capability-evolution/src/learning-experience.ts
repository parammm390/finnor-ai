/** Nonfinancial native operational evidence. No success labels, causal rewards,
 * financial-history widening or protected-custody claim. */
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../../private-equity/src/types';
import {applicationTx,releaseTx,recordReference,workCutTx,valueSetsFactsTx,approverAuthoritiesTx,authorityTx,actionLiterals,assertAuthorityTemporalBoundsTx,type RecordRow} from '../../private-equity/src/enterprise-applications/store';
import {applicationCanonical,type ApplicationValues} from '../../private-equity/src/enterprise-applications/contracts';
import {bindReconciliation,structuralState,lawfulStructuralLabel} from '../../private-equity/src/policy-learning/abstraction';
import {ConsentBodySchema,sha,fail,type ExperienceSelection,type StructuralSample} from '../../private-equity/src/policy-learning/contracts';
import type {AcceptedExperienceCut,ExperienceRecordCut,NativeCommandEvent} from '../../private-equity/src/policy-learning/types';
import {currentApplicationEnvironment,assertApplicationEnvironment} from '../../private-equity/src/enterprise-applications/source-cut';

export async function currentLearningConsentTx(ctx:PeMutationContext,c:PoolClient,consentId:string,applicationId:string,targetApplicationId=applicationId,temporalBounds?:string[]){
 // Immutable rights need no UPDATE privilege for row locking. Callers hold the
 // same tenant material-cut transaction lock as the revocation owner.
 const r=(await c.query<{id:string;owner_id:string;application_id:string;body:unknown;body_digest:string;created_at:Date}>('SELECT * FROM finnor_os.x5_training_rights WHERE tenant_id=$1 AND id=$2',[ctx.auth.tenantId,consentId])).rows[0];
 if(!r||r.application_id!==applicationId||sha(r.body)!==r.body_digest)fail('X5_TRAINING_CONSENT_REQUIRED',403);
 const body=ConsentBodySchema.parse(r.body),a=await applicationTx(ctx,c,applicationId);
 if(a.owner_id!==r.owner_id||a.status==='CANCELLED'||a.deadline_at.getTime()<=Date.now()||Date.parse(body.validUntil)<=Date.now())fail('X5_TRAINING_RIGHTS_EXPIRED_OR_OWNER_CHANGED',403);
 const revoked=(await c.query('SELECT consent_id FROM finnor_os.x5_rights_revocations WHERE tenant_id=$1 AND consent_id=$2',[ctx.auth.tenantId,consentId])).rowCount;
 if(revoked||targetApplicationId!==applicationId&&body.transfer!=='SAME_TENANT_COMPATIBLE_APPLICATIONS')fail('X5_TRAINING_OR_REUSE_RIGHTS_REVOKED',403);
 // A deactivated/unauthorized data owner cannot leave a transferable permission.
 temporalBounds?.push(body.validUntil,a.deadline_at.toISOString());
 const owner=await authorityTx(ctx,c,a,r.owner_id,temporalBounds);
 if(!owner.authorityCurrent)fail('X5_CONSENT_OWNER_AUTHORITY_REVOKED',403);
 return {ref:{owner:'X5_RIGHTS',id:r.id,revision:'1',contentDigest:r.body_digest},body,createdAt:r.created_at.toISOString()};
}
export async function nativeRecordHistoryTx(c:PoolClient,tenant:string,applicationId:string,recordId:string){
 const setting=(await c.query<{track_commit_timestamp:string}>('SHOW track_commit_timestamp')).rows[0];
 if(setting?.track_commit_timestamp!=='on')fail('X5_NATIVE_COMMIT_CLOCK_REQUIRED',503);
 const rows=(await c.query<NativeCommandEvent>(`SELECT h.id::text,h.actor_id,h.record_id,h.kind,h.body,h.request_digest,h.created_at,
  h.xmin::text transaction_id,pg_xact_commit_timestamp(h.xmin) committed_at
  FROM finnor_os.x3_events h WHERE h.tenant_id=$1 AND h.application_id=$2 AND h.record_id=$3 ORDER BY h.id LIMIT 65`,[tenant,applicationId,recordId])).rows;
 if(rows.length>64)fail('X5_COMPLETE_RECORD_HISTORY_BOUND');
 if(rows.some(e=>!e.committed_at))fail('X5_NATIVE_COMMIT_CLOCK_UNAVAILABLE',503);
 return rows;
}
function immutableEventRef(e:NativeCommandEvent){
 return {owner:'X3_EVENT',id:e.id,revision:'1',contentDigest:sha({id:e.id,actorId:e.actor_id,recordId:e.record_id,kind:e.kind,body:e.body,requestDigest:e.request_digest,createdAt:e.created_at.toISOString(),committedAt:e.committed_at!.toISOString()})};
}
export async function resolveAcceptedLearningExperienceTx(ctx:PeMutationContext,c:PoolClient,selections:ExperienceSelection[],knowledgeCut:string,temporalBounds?:string[]):Promise<AcceptedExperienceCut>{
 const bounds=temporalBounds??[];
 const cut=Date.parse(knowledgeCut);
 if(!Number.isFinite(cut)||cut>Date.now())fail('X5_KNOWLEDGE_CUT_INVALID',400);
 if(new Set(selections.map(s=>s.applicationId)).size!==selections.length)fail('X5_DUPLICATE_EXPERIENCE_APPLICATION',400);
 const records:ExperienceRecordCut[]=[],samples:StructuralSample[]=[];
 const nativeEnvironment=await currentApplicationEnvironment();
 for(const selection of selections){
  const a=await applicationTx(ctx,c,selection.applicationId),release=await releaseTx(c,a),work=await workCutTx(c,a);
  assertApplicationEnvironment(release.environment,nativeEnvironment);
  if(work.id!==release.package.work.revision||work.digest!==release.package.work.inputDigest)fail('X5_EXPERIENCE_WORK_CHANGED');
  const consent=await currentLearningConsentTx(ctx,c,selection.consentId,a.id,a.id,bounds);
  if(cut>Date.parse(consent.body.knowledgeCut))fail('X5_CONSENT_KNOWLEDGE_SCOPE_EXCEEDED',403);
  const universe=(await c.query<RecordRow>('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 AND created_at<=$3::timestamptz ORDER BY id LIMIT 257',[a.tenant_id,a.id,knowledgeCut])).rows;
  if(universe.length>256||records.length+universe.length>256)fail('X5_EXPERIENCE_UNIVERSE_BOUND');
  for(const missing of selection.recordIds.filter(id=>!universe.some(r=>r.id===id)))
   records.push({applicationId:a.id,recordId:missing,selected:true,status:'REJECTED',reason:'MISSING_CANONICAL_RECORD',historyRefs:[],futureRefs:[],acceptanceRef:null,reconciliationRef:null,consentRef:consent.ref,sourceRefs:[],partition:{institution:a.tenant_id,application:release.package.id,structure:sha(release.specification.model),time:knowledgeCut,dependenceGroup:a.id},qualification:'OPERATIONAL_CONTRACT_ONLY_NO_CAUSAL_OR_FINANCIAL_REWARD'});
  for(const record of universe){
   const selected=selection.recordIds.includes(record.id),history=await nativeRecordHistoryTx(c,a.tenant_id,a.id,record.id);
   const visible=history.filter(e=>e.created_at.getTime()<=cut&&e.committed_at!.getTime()<=cut),future=history.filter(e=>!visible.includes(e));
   const row:ExperienceRecordCut={applicationId:a.id,recordId:record.id,selected,status:'REJECTED',reason:'NOT_INDEPENDENTLY_ACCEPTED',historyRefs:visible.map(immutableEventRef),futureRefs:future.map(immutableEventRef),acceptanceRef:null,reconciliationRef:null,consentRef:consent.ref,sourceRefs:[],partition:{institution:a.tenant_id,application:release.package.id,structure:sha(release.specification.model),time:knowledgeCut,dependenceGroup:a.id},qualification:'OPERATIONAL_CONTRACT_ONLY_NO_CAUSAL_OR_FINANCIAL_REWARD'};
   records.push(row);
   if(!selected){row.reason='RETAINED_UNSELECTED_NATIVE_RECORD';continue;}
   try{
    const binding=bindReconciliation(release.specification);
    if(!binding.supported)fail('X5_TRAINING_DOMAIN_UNSUPPORTED');
    if(record.release_id!==release.package.id||record.schema_release_id!==release.package.id||record.entity_id!==binding.entityId)fail('X5_EXPERIENCE_RELEASE_CHANGED');
    if(future.length)fail('X5_FUTURE_OR_POSTCUT_HISTORY_PRESENT');
    if(record.state!==binding.acceptedState||record.pending_effect_id)fail('X5_CURRENT_ACCEPTED_OUTCOME_REQUIRED');
    if(!visible.length||visible.some(e=>(e.kind!=='BUSINESS_COMMAND'&&e.kind!=='BUSINESS_COMMAND_REFUSED')||sha(e.body.input)!==e.request_digest))fail('X5_NATIVE_COMMAND_PREIMAGE_INVALID');
    const reconciliations=visible.filter(e=>e.kind==='BUSINESS_COMMAND'&&e.body.input.actionId===binding.reconciliationAction&&e.body.result.decision.allowed&&e.body.before?.state===binding.initialState&&e.body.result.record?.state===binding.reconciledState);
    const acceptance=[...visible].reverse().find(e=>e.kind==='BUSINESS_COMMAND'&&e.body.input.actionId===binding.approvalAction&&e.body.result.decision.allowed&&e.body.result.record?.state===binding.acceptedState);
    const rec=reconciliations.at(-1);
    if(!rec||!acceptance||BigInt(rec.id)>=BigInt(acceptance.id)||acceptance.actor_id===record.author_id||
     rec.body.result.record?.reference.contentDigest!==record.content_digest||acceptance.body.result.record?.reference.contentDigest!==record.content_digest||
     visible.at(-1)!==acceptance||acceptance.body.result.record.revision!==record.concurrency_revision)fail('X5_INDEPENDENT_ACCEPTANCE_LINEAGE_REQUIRED');
    if(!rec.body.before||lawfulStructuralLabel(structuralState(binding,rec.body.before))!=='RECONCILE')fail('X5_RECONCILIATION_PRECONDITIONS_NOT_ESTABLISHED');
    const valueSets=[record.values,actionLiterals(release.built.program,binding.reconciliationAction,binding.entityId),
     actionLiterals(release.built.program,binding.approvalAction,binding.entityId)];
    const facts=await valueSetsFactsTx(ctx,c,a,valueSets),actor=await authorityTx(ctx,c,a,acceptance.actor_id,bounds);
    const authorities=await approverAuthoritiesTx(ctx,c,a,release.specification,record.approvals,actor,bounds);
    if(!actor.authorityCurrent||record.approvals.length===0||record.approvals.some(p=>p.principalId===record.author_id||p.recordDigest!==record.content_digest||p.releaseId!==release.package.id||
     p.actionId!==binding.approvalAction||p.tenantId!==a.tenant_id||p.scopeId!==a.root_id||sha(p.recordReference)!==sha(recordReference(record))||
     !authorities.some(v=>v.principalId===p.principalId&&v.current&&v.authorityRevision===p.authorityRevision&&v.canonicalRole===release.specification.model.roles.find(r=>r.id===p.role)?.canonicalRole))||
     new Set(record.approvals.map(p=>p.principalId)).size!==record.approvals.length)fail('X5_ACCEPTANCE_CHECKER_AUTHORITY_NOT_CURRENT',403);
    const values=valueSets.flatMap(v=>Object.values(v));
    const refs=[...new Map(values.filter((v):v is Extract<ApplicationValues[string],{kind:'EVIDENCE'}>=>!!v&&typeof v==='object'&&'kind'in v&&v.kind==='EVIDENCE')
     .map(v=>[applicationCanonical(v),v])).values()];
    if(refs.some(v=>!facts.currentEvidence.some(e=>applicationCanonical(e)===applicationCanonical(v))))fail('X5_ACCEPTED_SOURCE_CORRECTED_OR_STALE');
    const relations=[...new Map(values.filter((v):v is Extract<ApplicationValues[string],{kind:'RELATION'}>=>!!v&&typeof v==='object'&&'kind'in v&&v.kind==='RELATION')
     .map(v=>[applicationCanonical(v),v])).values()];
    if(relations.some(v=>!facts.currentRelations.some(current=>applicationCanonical(current)===applicationCanonical(v))))fail('X5_ACCEPTED_RELATION_CORRECTED_OR_STALE');
    row.status='ACCEPTED';row.reason='CURRENT_NATIVE_INDEPENDENT_APPROVAL_AFTER_MANDATORY_RECONCILIATION';
    row.acceptanceRef=immutableEventRef(acceptance);row.reconciliationRef=immutableEventRef(rec);
    row.sourceRefs=[...refs.map(v=>({owner:'S1_EVIDENCE',id:v.sourceId,revision:v.versionId,contentDigest:v.contentDigest})),...relations.map(v=>v.reference)];
    row.originalAssignment={workId:a.work_id,workInputId:work.id,workInputDigest:work.digest,specificationDigest:binding.specificationDigest,releaseId:release.package.id,checkerDigest:release.package.code.checkerDigest,runtimeDigest:sha(release.environment),authorPrincipalId:record.author_id,checkerPrincipalId:acceptance.actor_id,recordReference:recordReference(record),rightsRef:consent.ref,unresolvedObligations:[],effects:'NO_EXTERNAL_EFFECT_ACCEPTANCE',costs:release.package.resources};
    for(const event of visible){
     const states=[event.body.before,event.body.result.record].filter((s):s is NonNullable<typeof s>=>!!s);
     for(const state of states){
      const features=structuralState(binding,state);
      samples.push({features,label:lawfulStructuralLabel(features),evidenceDigest:immutableEventRef(event).contentDigest});
     }
    }
   }catch(error){row.reason=error instanceof Error?error.message:'X5_EXPERIENCE_UNAVAILABLE';}
  }
 }
 if(samples.length>4096)fail('X5_TRAINING_SAMPLE_BOUND');
 await assertAuthorityTemporalBoundsTx(c,bounds);
 const accepted=records.filter(r=>r.status==='ACCEPTED'),manifest={knowledgeCut,records};
 return {schema:'finnor.x5.accepted-native-experience.v1',knowledgeCut,records,samples,
  acceptedCount:accepted.length,cutDigest:sha(manifest),partitionDigest:sha(records.map(r=>r.partition)),
  positiveEvidenceRefs:accepted.map(r=>r.acceptanceRef!),failureLabelsRetained:true,protectedCustody:false,
  qualification:'CURRENT_RIGHTS_NATIVE_INDEPENDENT_OPERATIONAL_APPROVAL_NOT_CAUSAL_REWARD_OR_PROTECTED_CUSTODY'};
}
