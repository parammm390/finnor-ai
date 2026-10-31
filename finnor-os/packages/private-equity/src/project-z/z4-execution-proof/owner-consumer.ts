/** Real S3/S4 calls and separately executed proof verification on every guarded use. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {ExperimentRef,InterventionResponseBundle} from '@finnor/shared-types';
import type {PeMutationContext} from '../../types';
import {queryEnterpriseInterventionModel} from '../../enterprise-interventions';
import {chooseEnterpriseControlBranch,readEnterpriseControlBranchChoice} from '../../enterprise-control';
import {withS5PortfolioTransaction} from '../../allocation-store';
import {assertApplicationAllocationCurrent} from '../../application-semantics/allocation';
import {checkExecutionProof} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {exactInteger} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {nativeLimits} from './worker';
import {artifact,authorize,charge,codeIdentity,current,event,job,obligations,original,retain,setState,tx,workSnapshot,type Capsule,type Delivery,type Original} from './store';
import {assertDependencies} from '../../owner-context';
import {canonical,consumeSchema,developmentOnly,guardSchema,ownerTargetInput,sessionSchema,sha,type OwnerContract,type OwnerGuard} from './contracts';
import {wakeProofObjective} from './plan';
import {physicalRecoveryBoundary} from './recovery-boundary';

export function targetInput(c:OwnerContract){
 return ownerTargetInput(c);
}
function targetDigest(owner:'S3'|'S4',raw:unknown){
 if(!raw||typeof raw!=='object')throw Error('Z4_EXACT_OWNER_INVOCATION_REQUIRED');
 const v=raw as Record<string,unknown>;
 if(owner==='S3')return sha({modelRef:v.modelRef,query:v.query});
 if(v.confidentialGuard!==undefined)throw Error('Z4_UNSUPPORTED_UNBOUND_CONFIDENTIAL_GUARD');
 return sha({policyRef:v.policyRef,decision:v.decision,allocationRef:v.allocationRef??null,measurements:v.measurements??[]});
}
async function checkedCapsule(ctx:PeMutationContext,sessionId:string,capsuleDigest?:string){
 const row=await job(ctx,sessionId),o=await original(ctx,row);
 if(row.payload.z4.status!=='CHECKED'||!row.payload.z4.capsuleDigest||
  capsuleDigest!==undefined&&row.payload.z4.capsuleDigest!==capsuleDigest)throw Error('Z4_CURRENT_CHECKED_CAPSULE_REQUIRED');
 const capsule=await artifact<Capsule>(ctx,'capsule',row.payload.z4.capsuleDigest);
 if(capsule.schema!=='finnor.z4.execution-proof-capsule.v2'||capsule.checked.schema!=='finnor.z4.checked-execution.v2'||
  capsule.checked.originalExecutionReplayed!==false||capsule.originalDigest!==row.payload.z4.originalDigest||
  capsule.sessionId!==row.id||capsule.executionAuthorityGranted!==false||capsule.securityAdmission!=='NOT_RUN'||
  capsule.envelope.immutableArtifactDigest!==sha({originalDigest:capsule.originalDigest,checked:capsule.checked}))throw Error('Z4_IMMUTABLE_CAPSULE_CONTENT_BINDING');
 await current(ctx,o);
 return {row,o,capsule,digest:row.payload.z4.capsuleDigest};
}
async function verifyFresh(ctx:PeMutationContext,o:Original,capsule:Capsule,extra?:()=>Promise<boolean>){
 const alive=async()=>{
  try{
   const row=await job(ctx,o.sessionId);
   return row.payload.z4.status==='CHECKED'&&Date.parse(o.request.deadlineAt)>Date.now()&&(!extra||await extra());
  }catch{return false;}
 };
 await charge(ctx,o,'ORIGINAL_INPUT_BINDING_AND_PROOF_AUDIT',1);
 const checked=await checkExecutionProof(o.exact,{statement:capsule.checked.statement,artifact:capsule.checked.artifact},nativeLimits(ctx,o,alive));
 await current(ctx,o);return checked;
}
export async function auditProof(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const {sessionId}=sessionSchema.parse(raw),{o,capsule,digest}=await checkedCapsule(ctx,sessionId);
 const checked=await verifyFresh(ctx,o,capsule);
 await event(ctx,sessionId,'INDEPENDENT_AUDIT_VERIFIED',{capsuleDigest:digest,verifier:checked.verifier,
  correspondence:checked.correspondence,inputBinding:checked.inputBinding,
  verificationMode:checked.verificationMode,originalExecutionReplayed:false,executionAuthorityGranted:false});
 return {sessionId,capsuleDigest:digest,status:'VERIFIED_COMPUTATION_ONLY',statementDigest:checked.verifier.data.statementDigest,
  sourceDigest:checked.verifier.sourceDigest,binarySha256:checked.verifier.binarySha256,executionAuthorityGranted:false,securityAdmission:'NOT_RUN'};
}
/** Coordinator must mount this inside native S3/S4, before and after their
 * own evaluation. Undefined preserves unrelated ordinary owner behavior. */
export async function assertExecutionProofGuard(ctx:PeMutationContext,raw:unknown,owner:'S3'|'S4',nativeInput:unknown,stage:'BEFORE'|'AFTER'):Promise<void>{
 if(raw===undefined)return;
 developmentOnly();const guard=guardSchema.parse(raw);
 if(guard.owner!==owner||targetDigest(owner,nativeInput)!==guard.targetDigest)throw Error('Z4_OWNER_TARGET_BINDING_CHANGED');
 const {o,capsule,digest}=await checkedCapsule(ctx,guard.sessionId,guard.capsuleDigest),contract=o.request.ownerContract;
 if(contract.owner!==owner||guard.targetDigest!==sha(targetInput(contract)))throw Error('Z4_ORIGINAL_NATIVE_CONSUMER_CONTRACT_CHANGED');
 const live=async()=>{
  const d=(await job(ctx,o.sessionId)).payload.z4.delivery;
  return d?.useId===guard.useId&&d.state==='DELIVERING'&&d.capsuleDigest===digest&&Date.parse(d.leaseUntil)>Date.now();
 };
 if(!await live())throw Error('Z4_OWNER_DELIVERY_FENCED');
 const checked=await verifyFresh(ctx,o,capsule,live),g=contract.guard,value=exactInteger(checked.statement.finalState[g.register]!);
 if(checked.statement.program.registers[g.register]?.unit!==g.unit||value<exactInteger(g.minimum)||value>exactInteger(g.maximum))throw Error('Z4_CHECKED_INTEGER_OWNER_GUARD_REFUSED');
 await withS5PortfolioTransaction(ctx,async c=>{
  await authorize(ctx,o.request.root,[{type:'work',id:o.request.workId}],[],c);
  await workSnapshot(ctx,o.request,c);
  await assertApplicationAllocationCurrent(ctx,o.allocation.certificate.ref,c);
  const row=await job(ctx,o.sessionId,c,true),d=row.payload.z4.delivery;
  if(row.payload.z4.status!=='CHECKED'||d?.useId!==guard.useId||d.state!=='DELIVERING'||Date.parse(d.leaseUntil)<=Date.now())throw Error('Z4_OWNER_DELIVERY_FENCED');
  if(stage==='AFTER'&&!d.acks.includes('BEFORE'))throw Error('Z4_OWNER_PRECHECK_ACK_REQUIRED');
  await setState(ctx,row,{...row.payload.z4,delivery:{...d,acks:[...new Set([...d.acks,stage])]}},c);
 });
 await event(ctx,o.sessionId,'OWNER_BOUNDARY_VERIFIED',{owner,stage,useId:guard.useId,capsuleDigest:digest,targetDigest:guard.targetDigest,
  statementDigest:checked.verifier.data.statementDigest,originalIntegerGuard:true,actualBackendVerifier:true,executionAuthorityGranted:false});
}
async function readNativeResult(ctx:PeMutationContext,owner:'S3'|'S4',value:unknown){
 const r=value as {ref?:ExperimentRef};
 if(!r?.ref)throw Error('Z4_ACTUAL_NATIVE_OWNER_REFERENCE_REQUIRED');
 if(owner==='S4')return readEnterpriseControlBranchChoice(ctx,r.ref);
 const native=await import('../../enterprise-interventions') as unknown as {
  readEnterpriseInterventionResponse:(ctx:PeMutationContext,ref:ExperimentRef)=>Promise<InterventionResponseBundle>;
 };
 if(typeof native.readEnterpriseInterventionResponse!=='function')throw Error('Z4_NATIVE_S3_RESPONSE_READER_NOT_INSTALLED');
 return native.readEnterpriseInterventionResponse(ctx,r.ref);
}
async function deliveryCurrent(ctx:PeMutationContext,o:Original,c:PoolClient){
 if(Date.parse(o.request.deadlineAt)<=Date.now())throw Error('Z4_ORIGINAL_DEADLINE_EXHAUSTED');
 const rights=await authorize(ctx,o.request.root,[{type:'work',id:o.request.workId}],[],c);
 if(rights.revision!==o.rightsRevision)throw Error('Z4_RIGHTS_REVISED_OR_REVOKED');
 await assertDependencies(ctx,o.dependencies,c,true);
 if((await workSnapshot(ctx,o.request,c)).digest!==o.workInputDigest)throw Error('Z4_WORK_INPUT_CHANGED');
 const allocation=await assertApplicationAllocationCurrent(ctx,o.allocation.certificate.ref,c);
 if(sha(allocation.certificate)!==sha(o.allocation.certificate))throw Error('Z4_ORIGINAL_S5_ENVELOPE_CHANGED');
 if((await codeIdentity()).digest!==o.code.digest)throw Error('Z4_COMPILER_CHECKER_OR_NATIVE_CHANGED');
}
export async function consumeProof(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=consumeSchema.parse(raw),{row:initial,o,capsule,digest}=await checkedCapsule(ctx,input.sessionId,input.capsuleDigest),
  contract=o.request.ownerContract,target=targetInput(contract),targetHash=sha(target);
 const prior=initial.payload.z4.delivery;
 if(prior&&prior.idempotencyKey===input.idempotencyKey&&(prior.state==='ACKNOWLEDGED'||prior.resultDigest)){
  if(prior.targetDigest!==targetHash||prior.capsuleDigest!==digest||!prior.resultDigest)throw Error('Z4_NATIVE_DELIVERY_IDEMPOTENCY_CONFLICT');
  const saved=await artifact<{schema:string;sessionId:string;result:unknown;capsuleDigest:string;originalDigest:string;useId:string;owner:string}>(ctx,'delivery',prior.resultDigest);
  if(saved.schema!=='finnor.z4.native-owner-result.v1'||saved.sessionId!==o.sessionId||saved.capsuleDigest!==digest||saved.originalDigest!==initial.payload.z4.originalDigest||
   saved.useId!==prior.useId||saved.owner!==contract.owner||!prior.acks.includes('BEFORE')||!prior.acks.includes('AFTER'))
   throw Error('Z4_NATIVE_DELIVERY_CONTENT_BINDING');
  await verifyFresh(ctx,o,capsule);
  const result=await readNativeResult(ctx,contract.owner,saved.result);
  if(sha(result)!==sha(saved.result))throw Error('Z4_NATIVE_OWNER_OBSERVATION_CHANGED');
  if(prior.state!=='ACKNOWLEDGED'){
   await withS5PortfolioTransaction(ctx,async c=>{
    await deliveryCurrent(ctx,o,c);
    const row=await job(ctx,o.sessionId,c,true),d=row.payload.z4.delivery;
    if(row.payload.z4.status!=='CHECKED'||d?.useId!==prior.useId||d.resultDigest!==prior.resultDigest||
     d.idempotencyKey!==input.idempotencyKey||d.capsuleDigest!==digest||
     !d.acks.includes('BEFORE')||!d.acks.includes('AFTER'))throw Error('Z4_NATIVE_DELIVERY_FENCED');
    await setState(ctx,row,{...row.payload.z4,delivery:{...d,state:'ACKNOWLEDGED'}},c);
   });
   await event(ctx,o.sessionId,'NATIVE_OWNER_RESULT_INDEPENDENTLY_RECOVERED',{useId:prior.useId,
    resultDigest:prior.resultDigest,noNativeEvaluationRetried:true,originalReservationRef:o.allocation.reservation.ref});
  }
  await wakeProofObjective(ctx,o,digest,prior.resultDigest,prior.useId);
  return {sessionId:o.sessionId,capsuleDigest:digest,owner:contract.owner,nativeOwnerConsumed:true,ownerResult:result,replayed:true,
   executionAuthorityGranted:false,proofScope:'EXACT_HISTORY_GUARD_NOT_OWNER_FLOAT64_ALGORITHM'};
 }
 if(prior?.state==='ACKNOWLEDGED')throw Error('Z4_NATIVE_DELIVERY_IDEMPOTENCY_CONFLICT');
 if(prior?.state==='DELIVERING'&&Date.parse(prior.leaseUntil)>Date.now())throw Error('Z4_NATIVE_DELIVERY_LEASE_ACTIVE');
 if(prior?.state==='DELIVERING'||prior?.state==='UNKNOWN'){
  await tx(ctx,async c=>{
   const row=await job(ctx,o.sessionId,c,true),d=row.payload.z4.delivery;
   if(d?.useId===prior.useId&&d.state==='DELIVERING')
    await setState(ctx,row,{...row.payload.z4,delivery:{...d,state:'UNKNOWN'}},c);
  });
  await event(ctx,o.sessionId,'PRIOR_ANALYTICAL_DELIVERY_UNKNOWN',{
   previous:prior,unresolvedObligations:await obligations(ctx),noNativeEvaluationRetried:true,chargesRetained:true});
  throw Error('Z4_NATIVE_DELIVERY_UNKNOWN_REQUIRES_INDEPENDENT_RECONCILIATION');
 }
 const useId=randomUUID(),delivery:Delivery={useId,idempotencyKey:input.idempotencyKey,targetDigest:targetHash,owner:contract.owner,
  capsuleDigest:digest,state:'DELIVERING',leaseUntil:new Date(Math.min(Date.parse(o.request.deadlineAt),Date.now()+15*60000)).toISOString(),acks:[]};
 await tx(ctx,async c=>{
  const row=await job(ctx,o.sessionId,c,true),d=row.payload.z4.delivery;
  if(row.payload.z4.status!=='CHECKED'||d)throw Error('Z4_NATIVE_DELIVERY_FENCED');
  await setState(ctx,row,{...row.payload.z4,delivery},c);
 });
 await event(ctx,o.sessionId,'OWNER_DELIVERY_STARTED',{useId,owner:contract.owner,targetDigest:targetHash,capsuleDigest:digest,
  originalReservationRef:o.allocation.reservation.ref,originalDeadline:o.request.deadlineAt});
 const guard:OwnerGuard={schema:'finnor.z4.owner-guard.v1',sessionId:o.sessionId,useId,capsuleDigest:digest,owner:contract.owner,targetDigest:targetHash};
 try{
  await charge(ctx,o,'NATIVE_OWNER_EVALUATION',10);
  // The shared native functions themselves must invoke the guard and persist
  // their original output. Merely calling this adapter cannot create the acks.
  let output:unknown;
  if(contract.owner==='S3'){
   const call={modelRef:contract.modelRef,query:contract.query,executionProofGuard:guard};
   output=await queryEnterpriseInterventionModel(ctx,call);
  }else{
   const call={policyRef:contract.policyRef,decision:contract.decision,allocationRef:contract.allocationRef??undefined,measurements:[],executionProofGuard:guard};
   output=await chooseEnterpriseControlBranch(ctx,call);
  }
  const actual=await readNativeResult(ctx,contract.owner,output);
  if(sha(actual)!==sha(output))throw Error('Z4_NATIVE_OWNER_PERSISTED_OBSERVATION_MISMATCH');
  await current(ctx,o);
  const resultDigest=await retain(ctx,'delivery',{schema:'finnor.z4.native-owner-result.v1',sessionId:o.sessionId,
   originalDigest:initial.payload.z4.originalDigest,capsuleDigest:digest,useId,owner:contract.owner,result:actual,proofScope:'EXACT_HISTORY_GUARD_NOT_OWNER_NUMERICAL_MODEL'});
  await tx(ctx,async c=>{
   const row=await job(ctx,o.sessionId,c,true),d=row.payload.z4.delivery;
   if(row.payload.z4.status!=='CHECKED'||d?.useId!==useId||d.state!=='DELIVERING'||
    !d.acks.includes('BEFORE')||!d.acks.includes('AFTER')||Date.parse(d.leaseUntil)<=Date.now())throw Error('Z4_ACTUAL_NATIVE_OWNER_GUARD_ACKS_REQUIRED');
   await setState(ctx,row,{...row.payload.z4,delivery:{...d,resultDigest}},c);
  });
  await event(ctx,o.sessionId,'NATIVE_OWNER_RESULT_OBSERVED',{owner:contract.owner,useId,resultDigest,
   originalReservationRef:o.allocation.reservation.ref,unresolved:await obligations(ctx)});
  await physicalRecoveryBoundary(o.sessionId,'OWNER_RESULT');
  await current(ctx,o);
  await withS5PortfolioTransaction(ctx,async c=>{
   await deliveryCurrent(ctx,o,c);
   const row=await job(ctx,o.sessionId,c,true),d=row.payload.z4.delivery;
   if(row.payload.z4.status!=='CHECKED'||d?.useId!==useId||d.resultDigest!==resultDigest||
    !d.acks.includes('BEFORE')||!d.acks.includes('AFTER')||Date.parse(d.leaseUntil)<=Date.now())
    throw Error('Z4_ACTUAL_NATIVE_OWNER_GUARD_ACKS_REQUIRED');
   await setState(ctx,row,{...row.payload.z4,delivery:{...d,state:'ACKNOWLEDGED'}},c);
  });
  await event(ctx,o.sessionId,'NATIVE_OWNER_ACKNOWLEDGED',{owner:contract.owner,useId,resultDigest,capsuleDigest:digest,
   ownerRef:(actual as {ref:ExperimentRef}).ref,nativeCompute:(actual as {compute?:unknown}).compute??null,
   sharedS5Reservation:o.allocation.reservation.ref,unresolved:await obligations(ctx),executionAuthorityGranted:false});
  await physicalRecoveryBoundary(o.sessionId,'OWNER_ACK');
  await wakeProofObjective(ctx,o,digest,resultDigest,useId);
  return {sessionId:o.sessionId,capsuleDigest:digest,owner:contract.owner,nativeOwnerConsumed:true,ownerResult:actual,replayed:false,
   executionAuthorityGranted:false,proofScope:'EXACT_HISTORY_GUARD_NOT_OWNER_FLOAT64_ALGORITHM'};
 }catch(error){
  const acknowledged=await tx(ctx,async c=>{const row=await job(ctx,o.sessionId,c,true),d=row.payload.z4.delivery;
   if(d?.useId===useId&&d.state==='DELIVERING')await setState(ctx,row,{...row.payload.z4,delivery:{...d,state:'UNKNOWN'}},c);
   return d?.useId===useId&&d.state==='ACKNOWLEDGED';});
  await event(ctx,o.sessionId,acknowledged?'ACKNOWLEDGED_OWNER_FOLLOWUP_INCOMPLETE':'OWNER_DELIVERY_UNKNOWN',{
   useId,actualOwnerAcknowledgementRetained:acknowledged,unresolved:await obligations(ctx),claimsRetained:true,chargesRetained:true});
  throw error;
 }
}
