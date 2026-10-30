import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {readApplicationRecord,commandApplicationWithBoundary,projectRecord} from '../enterprise-applications/service';
import {applicationTx,releaseTx as applicationReleaseTx,recordTx as applicationRecordTx,workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {bindReconciliation,structuralState} from './abstraction';
import {loadController} from './controller';
import {sha,fail,type ControllerClass} from './contracts';
import {compilationTx,releaseTx,assertReleaseCurrentTx,eventTx,tx,type CompilationRow,type UseRow} from './store';
import {runLearningChild} from './process';
import type {LearningRelease} from './types';
import type {PhysicalChildResult} from './process';
import {assertUseAssignmentTx} from './assignments';

export async function executeLearnedUse(ctx:PeMutationContext,a:CompilationRow,u:UseRow,r:LearningRelease,
 physical:(c:PoolClient)=>Promise<void>,heartbeat:()=>Promise<boolean>){
 const input=u.request;
 const prepared=await tx(ctx,async c=>{
  const current=await compilationTx(ctx,c,a.id,'action:execute_learned_policy');await physical(c);
  await assertUseAssignmentTx(c,current,input);
  await assertReleaseCurrentTx(ctx,c,current,r,input.applicationId);
  const target=await applicationTx(ctx,c,input.applicationId,'action:operate_enterprise_application'),release=await applicationReleaseTx(c,target);
  const record=await applicationRecordTx(c,target,input.recordId),binding=bindReconciliation(release.specification),work=await workCutTx(c,target);
  if(record.entity_id!==binding.entityId||record.release_id!==target.head_release_id||record.schema_release_id!==target.head_release_id)fail('X5_FRESH_APPLICATION_BINDING_REQUIRED');
  if(record.concurrency_revision!==input.expectedRevision||sha(recordReference(record))!==sha(input.expectedReference))fail('X5_FRESH_INPUT_CHANGED');
  if(work.id!==release.package.work.revision||work.digest!==release.package.work.inputDigest)fail('X5_TARGET_WORK_CHANGED');
  return {binding,targetReleaseId:target.head_release_id!,targetWork:{id:target.work_id,inputId:work.id,digest:work.digest}};
 });
 const before=await readApplicationRecord(ctx,{applicationId:input.applicationId,recordId:input.recordId}),features=structuralState(prepared.binding,before);
 if(before.revision!==input.expectedRevision||sha(before.reference)!==sha(input.expectedReference))fail('X5_FRESH_INPUT_CHANGED');
 let decision:ControllerClass='WAIT',inference:Record<string,unknown>|null=null,child:PhysicalChildResult|null=null;
 const neural=input.mode==='COMPILED_ORIGINAL'||input.mode==='COMPILED_TRAINED';
 if(neural&&prepared.binding.supported){
  const checkpoint=input.mode==='COMPILED_ORIGINAL'?r.originalCheckpoint:r.checkpoint;
  child=await runLearningChild({operation:'INFER',deadline:a.deadline_at.getTime(),checkpoint,expectedDigest:u.checkpoint_digest,
   policy:r.policy,policyDigest:u.policy_digest,features},a.deadline_at.getTime(),heartbeat);
  if(!child.ok||!child.result)fail(child.error??'X5_INFERENCE_FAILED');
  inference=child.result as Record<string,unknown>;
  const reference=loadController(checkpoint,u.checkpoint_digest).infer(features);
  if(sha(inference)!==sha({...reference,loadedPolicyDigest:r.policyDigest}))fail('X5_ACTUAL_LOADED_CONTROLLER_MISMATCH');
  decision=reference.decision;
 }else{
  decision=features[7]?'STOP_ACCEPTED':features[6]?'REQUEST_INDEPENDENT_CHECK':features[5]?'RECONCILE':'WAIT';
 }
 const fallback=!prepared.binding.supported,nativeRequested=decision==='RECONCILE';
 const base={useId:u.id,mode:input.mode,releaseId:r.id,policyDigest:r.policyDigest,checkpointDigest:u.checkpoint_digest,
  actualLoaded:inference,features,binding:prepared.binding,targetReleaseId:prepared.targetReleaseId,targetWork:prepared.targetWork,
  beforeReference:before.reference,beforeRevision:before.revision,beforeState:before.state,pendingEffectId:before.pendingEffectId,decision,fallback,
  fallbackMethod:fallback?'CURRENT_INSTALLED_X3_TYPED_INTERPRETER':null,resources:child?.resources??null,
  productionActive:false,protectedAdmission:false,acceptedBusinessCompletion:false,completedAt:new Date().toISOString()};
 let temporalBounds:string[]=[];
 const finalize=async(c:PoolClient,result:unknown,status:'WAIT'|'DONE')=>{
  await c.query("UPDATE finnor_os.x5_uses SET status=$3,result=$4::jsonb WHERE tenant_id=$1 AND id=$2 AND status IN('QUEUED','RUNNING')",[a.tenant_id,u.id,status,JSON.stringify(result)]);
  await eventTx(c,a,u.principal_id,'USE_FINISHED','use-finished:'+u.id,result);
  await assertAuthorityTemporalBoundsTx(c,temporalBounds);
 };
 const beforeTx=async(c:PoolClient)=>{
  const current=await compilationTx(ctx,c,a.id,'action:execute_learned_policy');await physical(c);
  const pinned=await releaseTx(c,current,u.release_id);
  if(pinned.policyDigest!==u.policy_digest||(input.mode==='COMPILED_ORIGINAL'?pinned.originalCheckpoint.digest:pinned.checkpoint.digest)!==u.checkpoint_digest)fail('X5_PINNED_USE_IDENTITY_CHANGED');
  temporalBounds=await assertReleaseCurrentTx(ctx,c,current,pinned,input.applicationId);
  const target=await applicationTx(ctx,c,input.applicationId,'action:operate_enterprise_application'),release=await applicationReleaseTx(c,target);
  if(target.head_release_id!==prepared.targetReleaseId||sha(bindReconciliation(release.specification))!==sha(prepared.binding))fail('X5_OPERATION_SEMANTICS_CHANGED');
  const record=await applicationRecordTx(c,target,input.recordId);
  if(record.pending_effect_id!==before.pendingEffectId)fail('X5_PENDING_EFFECT_RECONCILIATION_REQUIRED');
 };
 if(nativeRequested&&!before.pendingEffectId){
  return commandApplicationWithBoundary(ctx,{applicationId:input.applicationId,entityId:prepared.binding.entityId,actionId:prepared.binding.reconciliationAction,
   recordId:input.recordId,expectedRevision:input.expectedRevision,expectedReference:input.expectedReference,input:{},idempotencyKey:'x5-native:'+u.id},{
   beforeTx,resultTx:async(c,native)=>{
    const result={...base,nativeInvoked:true,nativeResult:native,
     disposition:'NATIVE_RECONCILIATION_DECISION_NOT_INDEPENDENT_ACCEPTANCE'};
    await finalize(c,result,'DONE');
   }});
 }
 return tx(ctx,async c=>{
  await beforeTx(c);
  const latest=await applicationRecordTx(c,await applicationTx(ctx,c,input.applicationId),input.recordId);
  if(latest.concurrency_revision!==input.expectedRevision||sha(recordReference(latest))!==sha(input.expectedReference))fail('X5_FRESH_INPUT_CHANGED');
  const result={...base,nativeInvoked:false,disposition:before.pendingEffectId?'BLOCKED_PENDING_EFFECT':decision==='REQUEST_INDEPENDENT_CHECK'?'WAIT_CURRENT_INDEPENDENT_APPROVER':decision==='STOP_ACCEPTED'?'STOP_ALREADY_ACCEPTED_NOT_FRESH_COMPLETION':'WAIT_OBSERVATION_OR_CONTROLLER'};
  await finalize(c,result,'WAIT');return result;
 });
}
function recordReference(r:Parameters<typeof projectRecord>[0]){return {owner:'X3',id:r.id,revision:String(r.content_revision),contentDigest:r.content_digest};}
