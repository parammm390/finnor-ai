import type {JobExecutionContext} from '../../../../../apps/worker/src/queue';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,type ComputeResourceLease} from '@finnor/db';
import {randomUUID} from 'node:crypto';
import type {PeMutationContext} from '../../types';
import {checkExecutionProof,type ExecutionLimits,type ProofProduction} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {originalExecution} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/original';
import {checkCorrespondence} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/correspondence';
import {runNative} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/native';
import {artifact,charge,claim,current,event,failureEvent,job,obligations,observe,original,principal,retain,setState,tx,type Capsule,type Original} from './store';
import {PRODUCT_LOCK,VERSION,canonical,developmentOnly,safePredicate,sha} from './contracts';
import {nativeReplayProcessObserver,physicalRecoveryBoundary} from './recovery-boundary';

export const cpuCeiling=(op:string)=>op==='prove'?600:op==='verify'?60:10;
export function nativeLimits(ctx:PeMutationContext,o:Original,stillCurrent:()=>Promise<boolean>):ExecutionLimits{
 let leases:ComputeResourceLease[]=[];
 return {deadlineAt:o.request.deadlineAt,maxMemoryBytes:o.request.maxMemoryBytes,cpuSeconds:cpuCeiling,
  processGroup:nativeReplayProcessObserver(o.sessionId),
  current:async()=>await stillCurrent()&&(!leases.length||await renewComputeResourceLeases(leases)),
  charge:(op,cpu)=>charge(ctx,o,op,cpu).then(()=>undefined),
  capacity:async operation=>{
   if(leases.length)throw Error('Z4_CONCURRENT_PROCESS_ON_ONE_ORIGINAL_LIMITS');
   leases=await acquireComputeResourceLeases({tenantId:o.tenantId,resourceKeys:['native:z4-execution-proof'],
    requiredResourceKeys:['native:z4-execution-proof'],workloadClass:'HEAVY',ownerId:`z4:${o.sessionId}:${operation}:${randomUUID()}`});
   const owned=leases;
   return async()=>{leases=[];await releaseComputeResourceLeases(owned,'Z4_PHYSICAL_PROCESS_REAPED_OR_NOT_STARTED');};
  },observed:r=>observe(ctx,o,r)};
}
export async function runExecutionProofJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>):Promise<void>{
 if(!execution||execution.protocolVersion!==1||execution.retrySafety!=='locally_idempotent'||
  typeof payload.tenantId!=='string'||typeof payload.principalId!=='string'||typeof payload.sessionId!=='string'||
  execution.tenantId!==payload.tenantId||execution.jobId!==payload.sessionId)throw Error('Z4_ACTUAL_DURABLE_JOB_CLAIM_REQUIRED');
 developmentOnly();
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'},
  provenance:{sourceSystem:'Z4:actual-native-job-claim',createdBy:payload.principalId}};
 const actor=await tx(ctx,async c=>(await c.query<{role:string;status:string}>('SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',
  [ctx.auth.tenantId,principal(ctx)])).rows[0],true);
 if(actor?.status!=='active'||actor.role!=='owner')throw Error('Z4_CURRENT_AUTHENTICATED_OWNER_REQUIRED');
 const initial=await job(ctx,execution.jobId),o=await original(ctx,initial);
 if(['CANCELLED','STALE'].includes(initial.payload.z4.status))return;
 const alive=async()=>{
  try{
   await claim(ctx,initial,execution);
   const revision=await tx(ctx,async c=>(await c.query<{revision:number}>('SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1',
    [ctx.auth.tenantId])).rows[0]?.revision,true);
   return Number(revision)===o.rightsRevision&&Date.parse(o.request.deadlineAt)>Date.now();
  }catch{return false;}
 };
 execution.registerHeartbeat(alive);
 const limits=nativeLimits(ctx,o,alive);
 try{
  await current(ctx,o);
  if(initial.payload.z4.status==='CHECKED'){
   const saved=await artifact<Capsule>(ctx,'capsule',initial.payload.z4.capsuleDigest??'');
   if(saved.originalDigest!==initial.payload.z4.originalDigest)throw Error('Z4_DUPLICATE_CAPSULE_BINDING');
   await checkExecutionProof(o.exact,{statement:saved.checked.statement,artifact:saved.checked.artifact},limits);
   await event(ctx,o.sessionId,'DUPLICATE_CHECKED_REDELIVERY',{deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,
    originalReservationRef:o.allocation.reservation.ref,originalDeadline:o.request.deadlineAt});return;
  }
  if(initial.payload.z4.activeAttempt&&initial.payload.z4.activeAttempt.deliveryAttemptId!==execution.deliveryAttemptId){
   await event(ctx,o.sessionId,'LOST_PHYSICAL_ATTEMPT',{previous:initial.payload.z4.activeAttempt,finalPhysicalCostUnknown:true,
    chargesRetained:true,originalReservationRef:o.allocation.reservation.ref,unresolvedObligations:await obligations(ctx)});
   await charge(ctx,o,'RECOVERY');
  }
  await tx(ctx,async c=>{
   const row=await claim(ctx,initial,execution,c),state=row.payload.z4;
   if(state.attempts>=o.request.maxAttempts)throw Error('Z4_ORIGINAL_ATTEMPT_BUDGET_EXHAUSTED');
   await setState(ctx,row,{...state,status:'RUNNING',attempts:state.attempts+1,
    activeAttempt:{deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,workerId:execution.workerId,startedAt:new Date().toISOString()}},c);
  });
  await event(ctx,o.sessionId,'CLAIMED',{jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,
   workerId:execution.workerId,originalReservationRef:o.allocation.reservation.ref,originalDeadline:o.request.deadlineAt});
  await physicalRecoveryBoundary(o.sessionId,'CLAIM');
  const state=(await job(ctx,o.sessionId)).payload.z4;
  let production:ProofProduction;
  if(state.checkpointDigest){
   const checkpoint=await artifact<{schema:string;sessionId:string;originalDigest:string;production:ProofProduction}>(ctx,'checkpoint',state.checkpointDigest);
   if(checkpoint.schema!=='finnor.z4.prover-checkpoint.v1'||checkpoint.sessionId!==o.sessionId||checkpoint.originalDigest!==state.originalDigest)
    throw Error('Z4_ORIGINAL_CHECKPOINT_FENCED');
   production=checkpoint.production;
   await event(ctx,o.sessionId,'CHECKPOINT_RECHECK_STARTED',{checkpointDigest:state.checkpointDigest,claimFence:execution.claimFence,noNewReservation:true});
  }else{
   await charge(ctx,o,'ORIGINAL_INTEGER_INTERPRETER',1);const full=originalExecution(o.exact);
   await event(ctx,o.sessionId,'ORIGINAL_INTEGER_EXECUTED',{finalState:full.finalState,steps:full.steps,wallMs:full.wallMs,
    sourceIdentity:o.code.digest,checkedScope:'ORIGINAL_INTEGER_NOT_FIELD_REPLAY'});
   const plan=await runNative('plan',o.exact,limits);checkCorrespondence(o.exact.program,o.exact.binding,plan.data);
   const produced=await runNative<ProofProduction>('prove',o.exact,limits);
   production=produced.data;
   const checkpointDigest=await retain(ctx,'checkpoint',{schema:'finnor.z4.prover-checkpoint.v1',sessionId:o.sessionId,
    originalDigest:state.originalDigest,production,proverProcess:{meters:produced.meters,binarySha256:produced.binarySha256,sourceDigest:produced.sourceDigest}});
   await tx(ctx,async c=>{const row=await claim(ctx,initial,execution,c);await setState(ctx,row,{...row.payload.z4,checkpointDigest},c);});
   await event(ctx,o.sessionId,'PROVER_CHECKPOINT_PERSISTED',{checkpointDigest,independentVerifierComplete:false,claimFence:execution.claimFence});
   await physicalRecoveryBoundary(o.sessionId,'CHECKPOINT');
  }
  await current(ctx,o);
  const checked=await checkExecutionProof(o.exact,production,limits),createdAt=new Date().toISOString(),source=await current(ctx,o);
  const unresolved=await obligations(ctx),contentDigest=sha({originalDigest:state.originalDigest,checked});
  const capsule:Capsule={schema:'finnor.z4.execution-proof-capsule.v1',sessionId:o.sessionId,originalDigest:state.originalDigest,checked,createdAt,
   executionAuthorityGranted:false,protectedAdmission:'NOT_RUN',securityAdmission:'NOT_RUN',envelope:{
    schemaVersion:'finnor.z4.execution-proof-envelope.v1',phase:'Z4',principalOutputType:'ExecutionProofCapsule',
    immutableArtifactDigest:contentDigest,artifactDigestBasis:'CONTENT_ORIGINAL_DIGEST_AND_CHECKED_EXECUTION_EXCLUDING_ENVELOPE',
    productLockDigest:PRODUCT_LOCK,sourceCommit:o.code.sourceCommit,sourceTree:o.code.sourceTree,producerBuildIdentity:o.code,
    originalTenant:o.tenantId,principal:o.principalId,Work:{id:o.request.workId,inputId:o.request.workInputId,inputDigest:o.workInputDigest,
     planRevisionRef:o.request.workRevisionRef},mandate:source.mandate,assignment:null,
    parentReservation:o.allocation.reservation.ref,originalDeadline:o.request.deadlineAt,
    remainingBudgetReference:{allocationRef:o.allocation.certificate.ref,consumptionRef:o.allocation.rootConsumption.ref,
     canonicalCharges:'finnor_os.s5_governed_resource_charges'},
    unresolvedObligationReferences:{original:o.obligations,current:unresolved},
    inputSemanticsAndRevisionReferences:{ownerContract:o.request.ownerContract,originalRequestDigest:sha(o.exact),dependencies:o.dependencies,
     sourceRefs:source.sourceRefs,inputCommitment:checked.statement.inputCommitment},
    rightsAndPermittedUseFingerprint:{rightsRef:o.rightsRef,fingerprint:o.rightsFingerprint,revision:o.rightsRevision},
    supportedDomain:{profile:checked.statement.profile,instructions:16,registers:8,inputBits:32,intermediateBits:64,
     exactSteps:checked.statement.steps,rounding:'EXACT_NO_CONVERSION',nativeMeaning:'RECORDED_INTEGER_HISTORY_GUARD_NOT_FLOAT64_MODEL'},
    unsupportedConditions:['ARBITRARY_TYPESCRIPT','FLOATS','UNBOUNDED_CODE','IMPLICIT_SCALE_CONVERSION','SECRET_INPUT_SECURITY','PROTECTED_OR_EFFECT_AUTHORITY'],
    claimAndEvidenceClasses:{exactIntegerExecution:'deterministic',proofSoundness:'assumption-conditional-not-admitted',costValue:'unknown'},
    checkerIdentityAndResultReferences:{sourceDigest:o.code.digest,native:checked.verifier.sourceDigest,binarySha256:checked.verifier.binarySha256,
     correspondence:checked.correspondence,verifierStatementDigest:checked.verifier.data.statementDigest},
    currentnessDependencies:{ownerSourceDigest:o.ownerSourceDigest,rightsFingerprint:o.rightsFingerprint,workInputDigest:o.workInputDigest,
     compilerAndVerifier:o.code.digest,planHash:checked.artifact.planHash,parameters:checked.artifact.parameterHash},
    securityAndConfidentialityProfile:{backend:checked.statement.backend,curveCycle:'Pallas/Vesta',commitment:'Pedersen/IPA both curves',
     trustedSetup:false,zeroKnowledgeClaim:false,endToEndExponent:null,privateTransport:'PRINCIPAL_PRIVATE_ORDINARY_STORE_ONLY'},
    ownerConsumerContractVersion:VERSION,costAndResourceReceiptReferences:{sessionId:o.sessionId,canonicalCharges:'S5',ordinaryMeters:'S7:linked-business-events',
     money:null,humanSeconds:null,aggregateRSS:null},gaps:['NO_INDEPENDENT_SECURITY_ADMISSION','NO_PROTECTED_CUSTODY','NO_FINANCIAL_QUALIFICATION',
     ...(source.mandate?[]:['S3_GUARD_HAS_NO_S4_MANDATE']), 'NO_SEPARATE_NATIVE_ASSIGNMENT_RECEIPT'],
    reconstructionReference:{script:'finnor-os/scripts/project-z/z4/reconstruct.py',sourceDigest:o.code.digest,nativeSourceDigest:o.code.native.sourceDigest},
   }};
  const capsuleDigest=await retain(ctx,'capsule',capsule);
  await current(ctx,o);
  await tx(ctx,async c=>{const row=await claim(ctx,initial,execution,c);await setState(ctx,row,{...row.payload.z4,status:'CHECKED',capsuleDigest},c);});
  await event(ctx,o.sessionId,'CAPSULE_CHECKED_PUBLISHED',{capsuleDigest,claimFence:execution.claimFence,
   statementDigest:checked.verifier.data.statementDigest,executionAuthorityGranted:false,securityAdmission:'NOT_RUN'});
 }catch(error){
  const predicate=safePredicate(error);
  try{
   if(await alive()){
    if(/TIMEOUT|PROCESS_FAILED|CPU_BOUND|MEMORY/.test(predicate)){
     try{
      await current(ctx,o);await charge(ctx,o,'FULL_ORIGINAL_FALLBACK',1);
      const full=originalExecution(o.exact),other=await runNative<{finalState:string[]}>('interpret',o.exact,limits);
      if(canonical(full.finalState)!==canonical(other.data.finalState))throw Error('Z4_FULL_FALLBACK_ORIGINAL_MISMATCH');
      await event(ctx,o.sessionId,'FULL_CHECKING_FALLBACK_OBSERVED',{finalState:full.finalState,wallMs:full.wallMs,meters:other.meters,
       compactProof:false,eligibleCapsule:false,originalReservationRef:o.allocation.reservation.ref});
     }catch(fallback){await event(ctx,o.sessionId,'FULL_FALLBACK_INCOMPLETE',{predicate:safePredicate(fallback),budgetReset:false});}
    }
    await failureEvent(ctx,o.sessionId,error);
    await tx(ctx,async c=>{const row=await claim(ctx,initial,execution,c);await setState(ctx,row,{...row.payload.z4,
     status:/CHANGED|REVOKED|STALE|SOURCE|RIGHTS/.test(predicate)?'STALE':'INCOMPLETE',failure:predicate},c);});
   }
  }catch{/* The old fence cannot publish; native costs and original reservations remain. */}
  throw error;
 }
}
