import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,withDatabaseExecutionDeadline,DatabaseExecutionDeadlineError,type ComputeResourceLease} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {resolveTotalTask,checkTotalTaskResult} from '../allocation-total-task';
import {assertTotalTaskSourceVisibilityTx} from '../allocation-total-episodes';
import {executeTotalAlgorithm} from '../../../epistemic-runtime/src/uniform-algorithms/total';
import {toolIdentity} from '../../../epistemic-runtime/src/uniform-algorithms/native';
import {TotalConsumeSchema} from './total-contracts';
import {digest,diagnosticProfile,fail} from './contracts';
import {uniformSourceRoot} from './source-cut';
import {tx,eventTx} from './store';
import {totalCutTx,totalDiscoveryTx,currentTotalTx,resolveTotalBinding,assertTotalResolutionTx,assertTotalTaskTx,totalCapsuleTx,type TotalDiscoveryRow} from './total-owner';

type TotalResolution=Awaited<ReturnType<typeof resolveTotalBinding>>;
// The checked path, its publication included, ends this long before the use deadline, so a checked
// publication that exhausts its clock still leaves time to record the use as a completed UNKNOWN.
const finalizationReserveMs=2000;

type TotalUseBody=({
 status:'CHECKED';actualMethod:'Y5_SAME_LEAN_TOTAL_DEFINITION';
 result:{value:string;operations:number};execution:Awaited<ReturnType<typeof executeTotalAlgorithm>>;
 originalCheck:ReturnType<typeof checkTotalTaskResult>;
}|{
 status:'UNKNOWN';actualMethod:'NONE';result:null;error:string;nativeReceipt:unknown;
 completedExecution:Awaited<ReturnType<typeof executeTotalAlgorithm>>|null;
 physicalCompletionUnknown:boolean;automaticReexecution:false;unknownPhysicalCostPossible:true;
});
interface TotalUseMetadata{
 schema:'finnor.s5.total-method-use.v2';completion:'COMPLETE';semanticOwner:'S5';useId:string;discoveryId:string;
 taskWorkId:string;taskBindingDigest:string;specificationDigest:string;capsuleDigest:string;
 cost:{startedAt:string;originalDeadline:string;wallMs:number;completeMoney:null;completeHumanSeconds:null;
  aggregatePeakBytes:null;pricingStatus:'UNMETERED_NOT_ZERO';allNativeReceiptsRetained:true};
 protectedAdmission:false;productionActive:false;executionAuthorityGranted:false;reservationCreated:false;s6EffectsCreated:never[];
 allocationOptimalityClaimed:false;
}
export type TotalCompletedUse=TotalUseMetadata&TotalUseBody&{digest:string};
export interface TotalInterruptedUse{
 completion:'INCOMPLETE';status:'UNKNOWN';useId:string;discoveryId:string;originalDeadline:string;
 reason:'DURABLE_STARTED_USE_NO_COMPLETION_NO_AUTOMATIC_REEXECUTION';automaticReexecution:false;
 unknownPhysicalCostPossible:true;executionAuthorityGranted:false;
}
export async function consumeTotalAlgorithm(ctx:PeMutationContext,value:unknown,invocationDeadlineAt=Date.now()+28500):Promise<TotalCompletedUse|TotalInterruptedUse>{
 return (await consumeTotalUse(ctx,value,invocationDeadlineAt)).use;
}
/** `admitted` hands over a CHECKED discovery and its owner binding that the caller resolved moments ago; the
 * registration transaction still fences it against the current owner state. `publication` is the binding
 * re-resolved after native work, returned only when this call published a CHECKED use. */
export async function consumeTotalUse(ctx:PeMutationContext,value:unknown,invocationDeadlineAt:number,
 options:{evaluationUseKey?:string;admitted?:{discovery:TotalDiscoveryRow;resolution:TotalResolution}}={},
):Promise<{use:TotalCompletedUse|TotalInterruptedUse;publication:TotalResolution|null}>{
 const startedAt=Date.now();invocationDeadlineAt=Math.min(invocationDeadlineAt,startedAt+28500);
 diagnosticProfile();const input=TotalConsumeSchema.parse(value);
 if(input.idempotencyKey.startsWith('total-independent-evaluation:')&&input.idempotencyKey!==options.evaluationUseKey)fail('Y5_RESERVED_EVALUATION_USE_KEY',403);
 if(options.admitted&&(options.admitted.discovery.id!==input.discoveryId||options.admitted.discovery.status!=='CHECKED'))
  fail('Y5_TOTAL_ADMITTED_BINDING_MISMATCH');
 const observed=options.admitted?.discovery??await tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,input.discoveryId);await currentTotalTx(ctx,c,a);
  if(a.status!=='CHECKED')fail('Y5_CHECKED_CAPSULE_REQUIRED');return a;
 });
 // A cold process spends seconds hashing the pinned toolchain; starting that pass here overlaps it
 // with owner resolution. The checker's own toolIdentity call still re-verifies before any native run.
 void toolIdentity().catch(()=>undefined);
 const root={entityType:observed.root_type,entityId:observed.root_id},
  binding=options.admitted?.resolution??await resolveTotalBinding(ctx,observed,'USE'),
  task=await resolveTotalTask(ctx,root,input.taskWorkId,binding.specification);
 const prepared=await tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,input.discoveryId,true);await currentTotalTx(ctx,c,a);
  await assertTotalResolutionTx(ctx,c,binding);await assertTotalTaskTx(ctx,c,root,task);
  if(a.status!=='CHECKED'||a.generation!==observed.generation)fail('Y5_CHECKED_CAPSULE_REQUIRED');
  const prior=(await c.query<{id:string;request_digest:string;body:TotalCompletedUse|null;content_digest:string|null;deadline_at:Date}>(
   'SELECT id,request_digest,body,content_digest,deadline_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND idempotency_key=$4',
   [a.tenant_id,a.principal_id,a.id,input.idempotencyKey])).rows[0];
  if(prior){
   if(prior.request_digest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');
   if(prior.body){
    const {digest:claimed,...body}=prior.body;
    if(body.completion!=='COMPLETE'||claimed!==prior.content_digest||digest(body)!==claimed)fail('Y5_IMMUTABLE_USE_INTEGRITY');
    if(body.taskBindingDigest!==digest(task)||body.specificationDigest!==digest(binding.specification))fail('Y5_TOTAL_REPLAY_TASK_CHANGED');
    return {a,replay:prior.body,capsule:null,id:null,deadlineAt:null};
   }
   const replay:TotalInterruptedUse={completion:'INCOMPLETE',status:'UNKNOWN',useId:prior.id,discoveryId:a.id,
    originalDeadline:prior.deadline_at.toISOString(),reason:'DURABLE_STARTED_USE_NO_COMPLETION_NO_AUTOMATIC_REEXECUTION',
    automaticReexecution:false,unknownPhysicalCostPossible:true,executionAuthorityGranted:false};
   return {a,replay,capsule:null,id:null,deadlineAt:null};
  }
  if(a.use_count>=a.max_uses)fail('Y5_ORIGINAL_USES_EXHAUSTED');
  const capsule=await totalCapsuleTx(c,a);if(!capsule)fail('Y5_CHECKED_CAPSULE_REQUIRED');
  const acceptance=binding.specification.acceptance;
  const id=randomUUID(),deadlineAt=new Date(Math.min(invocationDeadlineAt,
   ...('validUntil'in acceptance?[Date.parse(acceptance.validUntil)]:[])));
  if(Date.now()>=deadlineAt.getTime()-finalizationReserveMs)fail('Y5_ORIGINAL_INVOCATION_DEADLINE');
  await c.query("INSERT INTO finnor_os.y5_uses(tenant_id,principal_id,id,discovery_id,idempotency_key,request_digest,request,deadline_at,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'STARTED')",
   [a.tenant_id,a.principal_id,id,a.id,input.idempotencyKey,digest(input),JSON.stringify(input),deadlineAt]);
  await c.query('UPDATE finnor_os.y5_discoveries SET use_count=use_count+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
   [a.tenant_id,a.principal_id,a.id]);
  await eventTx(c,a,'use-start:'+id,'USE_STARTED',{useId:id,taskWorkId:task.workId,taskRef:task.sourceRef,
   taskBindingDigest:digest(task),specificationRef:binding.specification.sourceRef,methodDigest:capsule.digest,deadlineAt,
   campaignDeadlineNotRenewedOrInherited:true,allocationOptimalityClaimed:false,completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null});
  return {a,capsule,id,deadlineAt,replay:null};
 });
 if(prepared.replay)return {use:prepared.replay,publication:null};
 const {a,capsule,id,deadlineAt}=prepared;if(!capsule||!id||!deadlineAt)fail('Y5_USE_REGISTRATION_REQUIRED');
 const workDeadline=deadlineAt.getTime()-finalizationReserveMs;
 let leases:ComputeResourceLease[]=[],physicalCompletionUnknown=false;
 let completedExecution:Awaited<ReturnType<typeof executeTotalAlgorithm>>|null=null;
 let publication:TotalResolution|null=null;
 const current=()=>tx(ctx,async c=>{
  const fresh=await totalDiscoveryTx(ctx,c,a.id);await currentTotalTx(ctx,c,fresh);await assertTotalTaskTx(ctx,c,root,task);
  return fresh.generation===a.generation&&fresh.status==='CHECKED'&&Date.now()<workDeadline;
 });
 const unknown=(error:unknown,nativeReceipt:unknown):TotalUseBody=>({status:'UNKNOWN',actualMethod:'NONE',result:null,
  error:(error as Error).message,nativeReceipt,completedExecution,physicalCompletionUnknown,automaticReexecution:false,unknownPhysicalCostPossible:true});
 const complete=(useBody:TotalUseBody):TotalCompletedUse=>{
  const core:TotalUseMetadata&TotalUseBody={...useBody,schema:'finnor.s5.total-method-use.v2',completion:'COMPLETE',semanticOwner:'S5',
   useId:id,discoveryId:a.id,taskWorkId:task.workId,taskBindingDigest:digest(task),specificationDigest:digest(binding.specification),capsuleDigest:capsule.digest,
   cost:{startedAt:new Date(startedAt).toISOString(),originalDeadline:deadlineAt.toISOString(),wallMs:Date.now()-startedAt,
    completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,pricingStatus:'UNMETERED_NOT_ZERO',allNativeReceiptsRetained:true},
   protectedAdmission:false,productionActive:false,executionAuthorityGranted:false,reservationCreated:false,s6EffectsCreated:[],allocationOptimalityClaimed:false};
  return {...core,digest:digest(core)};
 };
 const publish=(outcome:TotalCompletedUse)=>tx(ctx,async c=>{
  const fresh=await totalDiscoveryTx(ctx,c,a.id,true);
  if(outcome.status==='CHECKED'){
   await currentTotalTx(ctx,c,fresh);await assertTotalTaskTx(ctx,c,root,task);
   if(!publication||fresh.generation!==a.generation||Date.now()>=deadlineAt.getTime())fail('Y5_TOTAL_USE_PUBLICATION_FENCE_CHANGED');
   await assertTotalResolutionTx(ctx,c,publication);
  }
  const updated=await c.query("UPDATE finnor_os.y5_uses SET status='COMPLETE',body=$4::jsonb,content_digest=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status='STARTED'",
   [a.tenant_id,a.principal_id,id,JSON.stringify(outcome),outcome.digest]);
  if(updated.rowCount!==1)fail('Y5_TOTAL_USE_COMPLETION_FENCE');
  await eventTx(c,a,'use-complete:'+id,'USE_COMPLETED',{useId:id,status:outcome.status,digest:outcome.digest,
   actualMethod:outcome.actualMethod,taskBindingDigest:digest(task),originalDeadline:deadlineAt,physicalCompletionUnknown,
   completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null});
 });
 const attempt=await withDatabaseExecutionDeadline(performance.now()+workDeadline-Date.now(),async()=>{
  let body:TotalUseBody;
  try{
   if(!await current())fail('Y5_ORIGINAL_INVOCATION_FENCE');
   leases=await acquireComputeResourceLeases({tenantId:a.tenant_id,resourceKeys:['native:y5-proof'],requiredResourceKeys:['native:y5-proof'],
    workloadClass:'HEAVY',ownerId:'y5-total-use:'+id});
   const heartbeat=async()=>!!await renewComputeResourceLeases(leases)&&current(),sourceRoot=await uniformSourceRoot();
   const execution=await executeTotalAlgorithm(capsule,binding.specification,[task.instance.values],
    {deadlineAt:workDeadline,scratch:join(sourceRoot,'.y5-scratch','total-uses',id),current:heartbeat});
   completedExecution=execution;
   // The semantic policy file and typed owner sources sit outside the publication transaction's source fence,
   // so they are re-resolved only after native work has finished.
   publication=await resolveTotalBinding(ctx,a,'USE');
   const result=execution.executions[0]!,originalCheck=checkTotalTaskResult(binding.specification,task,result.value);
   const freshTask=await resolveTotalTask(ctx,root,input.taskWorkId,publication.specification);
   if(digest(freshTask)!==digest(task)||!await heartbeat())fail('Y5_TOTAL_CONSUMPTION_TASK_OR_PHYSICAL_LEASE_CHANGED');
   body={status:'CHECKED',actualMethod:'Y5_SAME_LEAN_TOTAL_DEFINITION',result,execution,originalCheck};
  }catch(error){
   physicalCompletionUnknown=(error as {physicalCompletion?:string}).physicalCompletion==='UNKNOWN';
   body=unknown(error,(error as {receipt?:unknown}).receipt??null);
  }finally{if(!physicalCompletionUnknown)await releaseComputeResourceLeases(leases,'y5_total_use_children_closed').catch(()=>undefined);}
  const checked=complete(body);
  if(checked.status!=='CHECKED')return {outcome:checked,published:false,failure:null as unknown};
  try{await publish(checked);return {outcome:checked,published:true,failure:null as unknown};}
  catch(error){return {outcome:checked,published:false,failure:error};}
 });
 let outcome=attempt.outcome,durable=attempt.published;
 if(!durable&&attempt.failure!==null){
  // A publication whose acknowledgement failed may still have committed, and then that record stands. Otherwise
  // native work and lease release have finished, so the moved fence is recorded as a completed UNKNOWN use; left
  // STARTED, the use would replay as interrupted with no completion record.
  durable=await tx(ctx,async c=>(await c.query(
   "SELECT 1 FROM finnor_os.y5_uses WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status='COMPLETE' AND content_digest=$4",
   [a.tenant_id,a.principal_id,id,outcome.digest])).rowCount===1).catch(()=>false);
  if(!durable)outcome=complete(unknown(attempt.failure,null));
 }
 if(!durable)await publish(outcome);
 if(outcome.status==='UNKNOWN')try{
  const before=digest(await tx(ctx,c=>totalCutTx(ctx,c,root,a.work_id,input.taskWorkId)));
  const readable=await resolveTotalBinding(ctx,a,'READ');
  await tx(ctx,async c=>{
   await assertTotalTaskSourceVisibilityTx(ctx,c,{input:{root,workId:a.work_id,taskWorkId:input.taskWorkId},
    specificationWork:binding.work,specification:binding.specification,task});
   if(digest(await totalCutTx(ctx,c,root,a.work_id,input.taskWorkId))!==before)
    fail('Y5_TOTAL_FAILED_USE_SOURCE_PAYLOAD_WITHHELD');
   await assertTotalResolutionTx(ctx,c,readable);
  });
 }catch(error){
  // An exhausted request clock says nothing about whether the caller may read the payload; the UNKNOWN use is already durable.
  if(error instanceof DatabaseExecutionDeadlineError)throw error;
  fail('Y5_TOTAL_FAILED_USE_SOURCE_PAYLOAD_WITHHELD');
 }
 return {use:outcome,publication:outcome.status==='CHECKED'?publication:null};
}
