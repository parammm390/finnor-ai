/** Exact application-intent adapter. S4, S5 and S6 remain preparation,
 * reservation and obligation owners. This module never dispatches. */
import {z} from 'zod';
import {ExperimentRefSchema} from '@finnor/epistemic-runtime';
import type {PeMutationContext} from '../types';
import {readEnterpriseContingentHandoffPreparation} from '../enterprise-control';
import {prepareEnterpriseDurableObligation,readEnterpriseDurableObligationPreparation} from '../enterprise-obligations';
import {VReferenceSchema} from '../../../shared-types/src/primary-diligence';
import {ApplicationFault,applicationDigest,applicationCanonical,assertApplicationData,type ApplicationQuantity} from './contracts';
import {runApplicationProgram,type ActionDecision} from './program';
import {applicationExactCompare} from './exact';
import {currentApplicationEnvironment,assertApplicationEnvironment} from './source-cut';
import {applicationTx,recordTx,releaseTx,authorityTx,approverAuthoritiesTx,assertAuthorityTemporalBoundsTx,actionLiterals,valueSetsFactsTx,recordReference,assertAllocation,eventTx,priorEventTx,tx,principal,fail,newId,workCutTx,type ApplicationRow,type RecordRow} from './store';
export const ApplicationEffectSchema=z.object({applicationId:z.string().uuid(),recordId:z.string().uuid(),expectedRevision:z.number().int().positive(),expectedReference:VReferenceSchema,
 preparationRef:ExperimentRefSchema,allocationRef:ExperimentRefSchema,consumptionRef:ExperimentRefSchema,idempotencyKey:z.string().min(1).max(160)}).strict();
async function currentIntent(ctx:PeMutationContext,c:import('pg').PoolClient,a:ApplicationRow,r:RecordRow,temporalBounds:string[]){
 const release=await releaseTx(c,a),intent=r.prepared_intent as ActionDecision['preparedEffectIntent'];
 assertApplicationEnvironment(release.environment,await currentApplicationEnvironment());
 if(!intent||intent.kind!=='S4_EXACT_CONDITIONAL_DOSE'||r.release_id!==a.head_release_id)fail('EXACT_APPLICATION_INTENT_REQUIRED');
 const work=await workCutTx(c,a);
 if(work.id!==release.package.work.revision||work.digest!==release.package.work.inputDigest)fail('APPLICATION_WORK_CHANGED');
 const committed=(await c.query<{body:any}>(`SELECT body FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND record_id=$3
  AND kind='BUSINESS_COMMAND' AND body#>>'{result,decision,preparedEffectIntent,idempotencyKey}'=$4 ORDER BY id DESC LIMIT 1`,
  [a.tenant_id,a.id,r.id,intent.idempotencyKey])).rows[0]?.body;
 const before=committed?.before,after=committed?.result?.record;
 if(!before||before.id!==r.id||!after||after.state!==r.state||
  applicationCanonical(before.reference)!==applicationCanonical(recordReference(r))||
  applicationCanonical(after.reference)!==applicationCanonical(recordReference(r))||
  applicationCanonical(after.preparedIntent)!==applicationCanonical(intent))fail('COMMITTED_APPLICATION_INTENT_REQUIRED');
 const actor=await authorityTx(ctx,c,a,principal(ctx),temporalBounds),facts=await valueSetsFactsTx(ctx,c,a,[r.values,actionLiterals(release.built.program,intent.binding.actionId,r.entity_id)]);
 const currentAuthorities=await approverAuthoritiesTx(ctx,c,a,release.specification,r.approvals,actor,temporalBounds);
 const decision=runApplicationProgram(release.built.program,{entityId:r.entity_id,actionId:intent.binding.actionId,installedReleaseId:a.head_release_id,
  tenantId:a.tenant_id,scopeId:a.root_id,actor,record:{entityId:r.entity_id,state:before.state,values:r.values,authorPrincipalId:r.author_id,recordDigest:r.content_digest,reference:recordReference(r),releaseId:r.release_id},
  expectedRecordDigest:r.content_digest,expectedRecordReference:recordReference(r),input:{},approvals:before.approvals,currentAuthorities,currentEvidence:facts.currentEvidence,currentRelations:facts.currentRelations});
 if(!decision.allowed||decision.nextState!==r.state||!decision.preparedEffectIntent||applicationCanonical(decision.preparedEffectIntent)!==applicationCanonical(intent))fail(decision.outcome||'APPLICATION_INTENT_NOT_CURRENT');
 return intent;
}
export async function prepareApplicationEffect(ctx:PeMutationContext,value:unknown){
 assertApplicationData(value,128*1024);const parsed=ApplicationEffectSchema.safeParse(value);if(!parsed.success)throw new ApplicationFault('INVALID_APPLICATION_EFFECT_REQUEST','Exact owner references and record preconditions are required',400);
 const input=parsed.data,digest=applicationDigest(input),operationKey='s6:'+input.idempotencyKey;
 const start=await tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:operate_enterprise_application');assertAllocation(a);
  const done=await priorEventTx(c,a,principal(ctx),operationKey+':complete',digest);if(done)return {done};
  const r=await recordTx(c,a,input.recordId),prior=await priorEventTx(c,a,principal(ctx),operationKey+':start',digest);
  if(!prior&&(r.concurrency_revision!==input.expectedRevision||applicationCanonical(recordReference(r))!==applicationCanonical(input.expectedReference)))fail('COMMIT_CONFLICT');
  const temporalBounds:string[]=[],intent=await currentIntent(ctx,c,a,r,temporalBounds),operationId=prior?.operationId??newId();
  if(r.pending_effect_id&&r.pending_effect_id!==operationId)fail('CANONICAL_EFFECT_PREPARATION_PENDING');
  assertAllocation(a);await assertAuthorityTemporalBoundsTx(c,temporalBounds);
  return {a,intent,operationId,started:!!prior};
 });
 if('done' in start)return start.done;
 const prepared=await readEnterpriseContingentHandoffPreparation(ctx,input.preparationRef),intervention=prepared.handoff.intervention;
 const values=start.intent!.binding.values,q=values.quantity as ApplicationQuantity|undefined;
 // Public adapter codec: a single exact conditional dose, including the full
 // currency/unit/accounting/time meaning. No inferred FX, rounding or netting.
 if(!intervention||intervention.channels.length!==1||!q||q.kind!=='QUANTITY')fail('UNSUPPORTED_APPLICATION_EFFECT_CODEC');
 const channel=intervention.channels[0]!;
 if(channel.doses.length!==1||channel.target.entityId!==start.a!.root_id||q.entity.id!==start.a!.root_id||
  values.operation!==channel.operation||values.channel!==channel.exposureId||channel.unit!==`${q.currency}:${q.units}:${q.accountingBasis}`||
  q.time.kind!=='AS_OF'||q.time.asOf!==intervention.timing.startAt||
  !applicationExactCompare(q.amount,String(channel.doses[0]),'eq')||
  applicationCanonical(prepared.handoff.allocationRef)!==applicationCanonical(input.allocationRef))fail('APPLICATION_S4_EXACT_BINDING_MISMATCH');
 // S6 owns the exact S4/S5 preparation contract. Resolve it before reserving a
 // fresh local operation, including the real consumption and every binding.
 // A prior uncertain operation instead replays the canonical idempotent owner;
 // an already-created obligation must not be rejected as a fresh consumption.
 if(!start.started)await readEnterpriseDurableObligationPreparation(ctx,{preparationRef:input.preparationRef,allocationRef:input.allocationRef,consumptionRef:input.consumptionRef});
 // Pure owner-reference/codec refusals cannot create an in-doubt obligation.
 // Reserve only after those checks, then recheck the original CAS and intent
 // under the lock before the first potentially consequential owner call.
 const reserved=await tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:operate_enterprise_application');assertAllocation(a);
  const done=await priorEventTx(c,a,principal(ctx),operationKey+':complete',digest);if(done)return {done};
  const r=await recordTx(c,a,input.recordId),prior=await priorEventTx(c,a,principal(ctx),operationKey+':start',digest);
  if(!prior&&(r.concurrency_revision!==input.expectedRevision||applicationCanonical(recordReference(r))!==applicationCanonical(input.expectedReference)))fail('COMMIT_CONFLICT');
  const temporalBounds:string[]=[],intent=await currentIntent(ctx,c,a,r,temporalBounds),operationId=prior?.operationId??start.operationId;
  if(applicationCanonical(intent)!==applicationCanonical(start.intent))fail('APPLICATION_EFFECT_COMMIT_FENCE');
  if(r.pending_effect_id&&r.pending_effect_id!==operationId)fail('CANONICAL_EFFECT_PREPARATION_PENDING');
  if(!prior){
   await c.query('UPDATE finnor_os.x3_records SET pending_effect_id=$4,concurrency_revision=concurrency_revision+1 WHERE tenant_id=$1 AND application_id=$2 AND id=$3',[a.tenant_id,a.id,r.id,operationId]);
   await eventTx(c,a,principal(ctx),'S6_BIND_STARTED',operationKey+':start',digest,{operationId,recordReference:recordReference(r),releaseId:r.release_id,ownerReferences:{preparationRef:input.preparationRef,allocationRef:input.allocationRef,consumptionRef:input.consumptionRef}},r.id,null,true);
  }
  assertAllocation(a);await assertAuthorityTemporalBoundsTx(c,temporalBounds);
  return {operationId};
 });
 if('done' in reserved)return reserved.done;
 const obligation=await prepareEnterpriseDurableObligation(ctx,{preparationRef:input.preparationRef,allocationRef:input.allocationRef,consumptionRef:input.consumptionRef},{workId:start.a!.work_id});
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:operate_enterprise_application');assertAllocation(a);
  const prior=await priorEventTx(c,a,principal(ctx),operationKey+':complete',digest);if(prior)return prior;
  const r=await recordTx(c,a,input.recordId),temporalBounds:string[]=[],intent=await currentIntent(ctx,c,a,r,temporalBounds);
  if(r.pending_effect_id!==reserved.operationId||applicationCanonical(intent)!==applicationCanonical(start.intent))fail('APPLICATION_EFFECT_COMMIT_FENCE');
  const result={status:'PREPARED_UNADMITTED',operationId:reserved.operationId,obligationRef:obligation.ref,preparationRef:input.preparationRef,
   allocationRef:input.allocationRef,consumptionRef:input.consumptionRef,executionAuthorityGranted:false,settlementEstablished:false};
  await c.query('UPDATE finnor_os.x3_records SET pending_effect_id=NULL,concurrency_revision=concurrency_revision+1 WHERE tenant_id=$1 AND application_id=$2 AND id=$3',[a.tenant_id,a.id,r.id]);
  await eventTx(c,a,principal(ctx),'S6_BOUND',operationKey+':complete',digest,result,r.id);
  assertAllocation(a);await assertAuthorityTemporalBoundsTx(c,temporalBounds);return result;
 });
}
