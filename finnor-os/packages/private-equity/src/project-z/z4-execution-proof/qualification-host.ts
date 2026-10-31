/** One actual already-claimed native original, never an offline grant/owner. */
import type {JobExecutionContext} from '../../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../../types';
import type {ProofProduction} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/engine';
import type {NativeReceipt} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/native';
import {executeFreshQualification,type QualificationHost} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/qualification';
import {frozenPublicPopulation,PUBLIC_REGISTRATION_SHA256} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/public-population';
import {canonical,developmentOnly,ownerTargetInput,safePredicate,sha} from './contracts';
import {EVENT_LIMIT,claim,codeIdentity,current,event,job,original,principal,setState,tx,type JobRow,type Original} from './store';
import {nativeLimits} from './worker';

const COST_RESERVE=256*1024;
const COST_EVENT_RESERVE=128;
export async function qualifyClaimedNativeJob(ctx:PeMutationContext,initial:JobRow,o:Original,
 execution:Readonly<JobExecutionContext>){
 developmentOnly();
 if(execution.protocolVersion!==1||execution.retrySafety!=='locally_idempotent'||
  execution.tenantId!==ctx.auth.tenantId||execution.jobId!==o.sessionId||
  o.tenantId!==ctx.auth.tenantId||o.principalId!==principal(ctx)||sha(o)!==initial.payload.z4.originalDigest)
  throw Error('Z4_QUALIFICATION_ACTUAL_ORIGINAL_JOB_REQUIRED');
 const intent=o.request.qualification;
 if(!intent||intent.registrationSha256!==PUBLIC_REGISTRATION_SHA256||
  !Number.isFinite(Date.parse(o.createdAt))||Date.parse(intent.compilerFrozenAt)>Date.parse(o.createdAt))
  throw Error('Z4_QUALIFICATION_ACCEPTED_INTENT_REQUIRED');
 const compiler={digest:o.code.digest,frozenAt:intent.compilerFrozenAt};
 const population=await frozenPublicPopulation(compiler),registered=population.cases.find(c=>c.id===intent.caseId);
 if(!registered||canonical({...registered.request,binding:o.exact.binding})!==canonical(o.exact))
  throw Error('Z4_QUALIFICATION_ORIGINAL_REQUEST_MISMATCH');
 // The only mapping is the public dummy context -> existing native S5 context.
 // Programme, complete inputs, initial state and frozen equations are identical.
 const selected={...registered,request:structuredClone(o.exact)};
 const schedule={...population,cases:[selected],selectedFreshProofs:1};
 const attemptId=sha({originalDigest:initial.payload.z4.originalDigest,jobId:execution.jobId,
  deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,workerId:execution.workerId});
 const targetDigest=sha(ownerTargetInput(o.request.ownerContract));
 const ownerBindingDigest=sha({tenant:o.tenantId,principal:o.principalId,owner:o.request.ownerContract,
  workId:o.request.workId,workInputDigest:o.workInputDigest,ownerSourceDigest:o.ownerSourceDigest,
  rightsFingerprint:o.rightsFingerprint,rightsRevision:o.rightsRevision});
 const originalReservationDigest=sha({preparationRef:o.preparationRef,certificate:o.allocation.certificate,
  reservation:o.allocation.reservation.ref,consumption:o.allocation.rootConsumption.ref,deadline:o.request.deadlineAt});
 const ownerCurrent=async()=>{
  const actor=await tx(ctx,async c=>(await c.query<{role:string;status:string}>(
   'SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[o.tenantId,o.principalId])).rows[0],true);
  if(actor?.status!=='active'||actor.role!=='owner')throw Error('Z4_CURRENT_AUTHENTICATED_OWNER_REQUIRED');
  await current(ctx,o);
 };
 const active=async()=>{
  try{
   await ownerCurrent();
   const row=await claim(ctx,initial,execution),s=row.payload.z4,q=s.qualificationAttempt,a=s.activeAttempt;
   return s.status==='RUNNING'&&q?.attemptId===attemptId&&q.status!=='FAILED'&&q.costReserveRemaining>=32768&&
    q.costEventSlotsRemaining>=16&&
    a?.deliveryAttemptId===execution.deliveryAttemptId&&a.claimFence===execution.claimFence&&a.workerId===execution.workerId;
  }catch{return false;}
 };
 const costEvent=(kind:string,detail:unknown)=>event(ctx,o.sessionId,kind,{attemptId,caseId:selected.id,detail},undefined,
  {qualificationAttemptId:attemptId});
 const base=nativeLimits(ctx,o,active);
 // Leave the existing native supervisor/kill grace inside the 600s child cap.
 const limits={...base,deadlineAt:new Date(Math.min(Date.parse(o.request.deadlineAt),Date.now()+595000)).toISOString(),
  processGroup:async(notice:Parameters<NonNullable<typeof base.processGroup>>[0])=>{
   await costEvent('QUALIFICATION_PHYSICAL_PROCESS',notice);
   await base.processGroup?.(notice);
   if(!await base.current!()){
    await costEvent('QUALIFICATION_BOUNDARY_FENCED',{stage:notice.stage,group:notice.group,
     predicate:'Z4_QUALIFICATION_SOURCE_OR_CLAIM_CHANGED'});
    throw Error('Z4_QUALIFICATION_SOURCE_OR_CLAIM_CHANGED');
   }
  },
  observed:async(receipt:Parameters<NonNullable<typeof base.observed>>[0])=>{
   const summary='failure'in receipt?receipt:{operation:receipt.operation,meters:receipt.meters,
    binarySha256:receipt.binarySha256,sourceDigest:receipt.sourceDigest};
   await costEvent('QUALIFICATION_NATIVE_COST',summary);
   await base.observed!(receipt);
  }};
 const completion:{produced?:NativeReceipt<ProofProduction>}={};
 const host:QualificationHost={
  currentCompilerDigest:async()=>(await codeIdentity()).digest,
  claim:async(c,s)=>{
   if(s.kind!=='PUBLIC'||s.cases.length!==1||s.registrationDigest!==population.registrationDigest||
    canonical(s.compiler)!==canonical(compiler)||c.id!==selected.id||canonical(c)!==canonical(selected))
    throw Error('Z4_QUALIFICATION_UNRELATED_ORIGINAL');
   await ownerCurrent();
   const persisted=await original(ctx,await job(ctx,o.sessionId));
   if(sha(persisted)!==sha(o))throw Error('Z4_QUALIFICATION_ORIGINAL_CHANGED');
   await tx(ctx,async client=>{
    const row=await claim(ctx,initial,execution,client),state=row.payload.z4,a=state.activeAttempt;
    if(state.status!=='RUNNING'||state.attempts!==1||state.cpuReservedSeconds!==0||
     state.checkpointDigest||state.capsuleDigest||state.delivery||state.qualificationAttempt||
     a?.deliveryAttemptId!==execution.deliveryAttemptId||a.claimFence!==execution.claimFence||a.workerId!==execution.workerId)
     throw Error('Z4_QUALIFICATION_ORIGINAL_ATTEMPT_CONSUMED');
    if(state.cpuLimitSeconds!==o.request.maxCpuSeconds||state.retainedByteLimit!==o.request.maxRetainedBytes||
     state.retainedBytes+COST_RESERVE>state.retainedByteLimit||state.events.length+COST_EVENT_RESERVE>EVENT_LIMIT)
     throw Error('Z4_QUALIFICATION_ORIGINAL_REMAINING_BUDGET_REQUIRED');
    await setState(ctx,row,{...state,retainedBytes:state.retainedBytes+COST_RESERVE,qualificationAttempt:{
     attemptId,caseId:selected.id,registrationSha256:PUBLIC_REGISTRATION_SHA256,status:'STARTED',
     costReserveRemaining:COST_RESERVE,costEventSlotsRemaining:COST_EVENT_RESERVE}},client);
   });
   await costEvent('QUALIFICATION_STARTED',{originalDigest:initial.payload.z4.originalDigest,
    frozenRegistrationSha256:PUBLIC_REGISTRATION_SHA256,registeredRequestDigest:sha(registered.request),
    originalRequestDigest:sha(o.exact),contextMapping:'PUBLIC_DUMMY_BINDING_TO_EXISTING_ORIGINAL_S5_BINDING_ONLY',
    compilerDigest:o.code.digest,targetDigest,ownerBindingDigest,originalReservationDigest,
    originalDeadlineAt:o.request.deadlineAt,costReserveBytes:COST_RESERVE,costReserveEventSlots:COST_EVENT_RESERVE,
    originalEventLimit:EVENT_LIMIT,noNewReservation:true});
   if(!await active())throw Error('Z4_QUALIFICATION_SOURCE_OR_CLAIM_CHANGED');
   // Qualification's cap may shorten, never replace the original deadline.
   return {attemptId,requestDigest:sha(o.exact),compilerDigest:o.code.digest,targetDigest,ownerBindingDigest,
    originalReservationDigest,originalDeadlineAt:o.request.deadlineAt,limits:{...limits,deadlineAt:o.request.deadlineAt}};
  },
  retain:async record=>{
   let recordRef:string|null=null,storageFailure:unknown;
   try{recordRef=await event(ctx,o.sessionId,'QUALIFICATION_RECORD',{attemptId,record});}
   catch(error){storageFailure=error;}
   // No claim/currentness guard here: an old fence must retain its real costs.
   const q=(await job(ctx,o.sessionId)).payload.z4.qualificationAttempt;
   if(q?.attemptId===attemptId)
    await costEvent('QUALIFICATION_RECORD_COST',{status:record.status??null,mutation:record.mutation??null,
     interval:record.interval??null,predicate:typeof record.error==='string'?safePredicate(Error(record.error)):null,
     recordRef,storageFailure:storageFailure?safePredicate(storageFailure):null});
   else if(record.status!=='FAILED_STOPPED_NO_RETRY')throw Error('Z4_QUALIFICATION_COST_RESERVE_REQUIRED');
   // A refused claim has no reserve and launched no scientific operation.
   if(storageFailure)throw storageFailure;
   if(record.status==='FRESH_PROOF_AND_SEPARATE_AUDIT_COMPLETE'){
    const checked=record.checked as {processes:NativeReceipt[]};
    const proof=checked.processes.find(p=>p.operation==='prove');
    if(!proof)throw Error('Z4_QUALIFICATION_FRESH_PROVER_PROCESS_REQUIRED');
    completion.produced=proof as NativeReceipt<ProofProduction>;
   }
  },
 };
 try{
  const result=await executeFreshQualification(schedule,host);
  const produced=completion.produced;
  if(result.freshProofs!==1||!produced||!await active())throw Error('Z4_QUALIFICATION_FRESH_COMPLETION_REQUIRED');
  await tx(ctx,async client=>{
   const row=await claim(ctx,initial,execution,client),q=row.payload.z4.qualificationAttempt;
   if(q?.attemptId!==attemptId||q.status!=='STARTED')throw Error('Z4_QUALIFICATION_ATTEMPT_FENCED');
   await setState(ctx,row,{...row.payload.z4,qualificationAttempt:{...q,status:'COMPLETE'}},client);
  });
  await costEvent('QUALIFICATION_COMPLETE',{newProofs:1,registeredCase:selected.id,nativeOwnerConsumed:false,
   protectedAdmission:'NOT_RUN',eligibleReuseN:0,originalReservationDigest});
  return {produced,limits};
 }catch(error){
  let failureEvidence:'RECORDED'|'UNKNOWN'='UNKNOWN';
  try{
   const q=(await job(ctx,o.sessionId)).payload.z4.qualificationAttempt;
   if(q?.attemptId===attemptId){
    await costEvent('QUALIFICATION_FAILED',{predicate:safePredicate(error),
     previousRecordedCostsPreserved:true,unobservedCost:'UNKNOWN_NOT_ZERO',budgetReset:false});
    failureEvidence='RECORDED';
   }
  }catch{/* Retention outage is UNKNOWN, never a replacement successful result. */}
  try{
   await tx(ctx,async client=>{
    const row=await claim(ctx,initial,execution,client),attempt=row.payload.z4.qualificationAttempt;
    if(attempt?.attemptId===attemptId)
     await setState(ctx,row,{...row.payload.z4,qualificationAttempt:{...attempt,status:'FAILED',failureEvidence}},client);
   });
  }catch{/* A lost fence cannot change state; the old attempt's cost event remains. */}
  throw error;
 }
}
