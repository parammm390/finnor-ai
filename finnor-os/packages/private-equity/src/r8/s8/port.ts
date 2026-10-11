import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {assertSignature,byteDigest,digest,fault,RefSchema,type Signed,type CapabilityRef} from '../../../../capability-evolution/src/contracts';
import type {InterfacePolicy} from '../../../../capability-evolution/src/interface-port';
import type {JournalEntry} from '../../../../capability-evolution/src/journal';
import {parseSolverCandidate,solverPortRef,SolverReviewSchema,SolverEvaluationSchema,SolverAdmissionSchema,
 SolverActivationSchema,SolverRevocationSchema,SolverUseSchema,type SolverCandidate,type SolverUseLease} from './contracts';
import {verifyCompleteDomain} from '../../../../epistemic-runtime/src/solver-synthesis/checker';
import {assertSourceIdentity,loadRuntime} from '../../../../epistemic-runtime/src/solver-synthesis/runtime';
import {hash} from '../../../../epistemic-runtime/src/solver-synthesis/contracts';
import {solverReviewDependencies} from './source-closure';

type Actor={id:string;principalId:string;roles:readonly string[]};
type Review=z.infer<typeof SolverReviewSchema>;
export type SolverInterfacePolicy=InterfacePolicy&{maxTotalUses:number;solverReview?:{
 contract:'s8-r8-solver-module-review-v1';sourcePins:Array<{path:string;sha256:string}>;
}};
interface State {candidate:SolverCandidate;protocol:Signed<Review>|null;protocolRef:CapabilityRef|null;
 evaluation:Record<string,unknown>|null;evaluationRef:CapabilityRef|null;admission:unknown;admissionRef:CapabilityRef|null;
 activation:z.infer<typeof SolverActivationSchema>|null;revoked:boolean;uses:number}
/** Signed-journal ordinary owner. The evaluator registers the immutable review;
 * the owner runs its own complete checker before issuing diagnostic admission.
 * No producer-supplied receipt or performance claim can skip that operation. */
export class SolverCapabilityPort {
 private states=new Map<string,State>();private uses=new Map<string,SolverUseLease>();
 private active:string|null=null;private generation=0;
 constructor(private policy:SolverInterfacePolicy){}
 replay(entry:JournalEntry){
  const operation=entry.operation,body=entry.body,result=entry.result;
  if(operation==='SOLVER_PROPOSE'){const candidate=parseSolverCandidate(body);this.states.set(candidate.ref.id,
   {candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,activation:null,revoked:false,uses:0});}
  else if(operation==='SOLVER_REGISTER'){const state=this.state(body.body.revisionRef);state.protocol=body;state.protocolRef=result.ref;}
  else if(operation==='SOLVER_EVALUATE'){const state=this.state(body.body.revisionRef);state.evaluation=result.evaluation;state.evaluationRef=result.ref;}
  else if(operation==='SOLVER_ADMIT'){const state=this.state(body.body.revisionRef);state.admission=body;state.admissionRef=result.ref;}
  else if(operation==='SOLVER_ACTIVATE'){const state=this.state(body.body.revisionRef);state.activation=body.body;this.active=state.candidate.ref.id;this.generation++;}
  else if(operation==='SOLVER_REVOKE'){this.state(body.body.revisionRef).revoked=true;this.active=body.body.predecessorRef?.id??null;this.generation++;}
  else if(operation==='SOLVER_USE'){const lease=result.lease as SolverUseLease;this.uses.set(lease.ref.id,lease);this.state(lease.revisionRef).uses++;}
 }
 private state(ref:CapabilityRef){const state=this.states.get(ref.id);if(!state||hash(state.candidate.ref)!==hash(ref))fault('S8_SOLVER_NOT_FOUND',404);return state;}
 private scope(input:{tenantId:string;principalId:string;rightsRef?:string}){
  if(input.tenantId!==this.policy.tenantId||input.principalId!==this.policy.principalId||
   input.rightsRef!==undefined&&input.rightsRef!==this.policy.rightsRef)fault('S8_SOLVER_SCOPE_MISMATCH',403);
 }
 private async dependencies(state:State){
  const expected=solverReviewDependencies(this.policy.sourcePins,this.policy.solverReview?.sourcePins??[]);
  if(hash(state.candidate.dependencies)!==hash(expected))fault('S8_SOLVER_OWNER_CLOSURE_SUBSTITUTION');
  for(const pin of state.candidate.dependencies)if(byteDigest(await readFile(pin.path))!==pin.sha256)fault('S8_SOLVER_OWNER_SOURCE_CHANGED');
  await assertSourceIdentity(state.candidate.capsule.semanticSourcePins);
 }
 private current(state:State,active=false){
  const now=Date.now(),c=state.candidate;
  if(state.revoked||!state.admissionRef||!state.evaluationRef||!state.protocol||
   now<Date.parse(c.domain.validAfter)||now>=Date.parse(c.domain.validUntil)||
   now<Date.parse(this.policy.validAfter)||now>=Date.parse(this.policy.validUntil)||
   active&&(!state.activation||this.active!==c.ref.id||now>=Date.parse(state.activation.validUntil)))fault('S8_SOLVER_UNADMITTED_REVOKED_OR_INACTIVE',403);
  assertSignature(state.protocol,this.policy.evaluatorKeys,state.protocol.body.evaluatorId);
  assertSignature(state.admission as Signed<unknown>,this.policy.promotionKeys);
 }
 async currentLease(lease:SolverUseLease){
  const retained=this.uses.get(lease.ref.id),state=this.state(lease.revisionRef);
  if(!retained||hash(retained)!==hash(lease)||lease.generation!==this.generation||Date.parse(lease.expiresAt)<=Date.now())
   fault('S8_SOLVER_LEASE_EXPIRED_OR_FENCED',403);
  this.current(state,true);await this.dependencies(state);
  return state;
 }
 async command(actor:Actor,operation:string,body:unknown,commit:(ref:CapabilityRef,content:unknown)=>Promise<unknown>):
 Promise<{readOnly:boolean;result:Record<string,unknown>}> {
  const role=operation==='SOLVER_PROPOSE'?'PROPOSER':['SOLVER_REGISTER','SOLVER_EVALUATE'].includes(operation)?'EVALUATOR':
   ['SOLVER_ADMIT','SOLVER_ACTIVATE','SOLVER_REVOKE'].includes(operation)?'PROMOTER':'CONSUMER';
  if(!actor.roles.includes(role)&&!(role==='CONSUMER'&&actor.roles.includes('READER')&&operation==='SOLVER_READ'))fault('S8_OPERATION_NOT_AUTHORIZED',403);
  if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_PROTECTED_SOLVER_MODULE_DOMAIN_UNADMITTED',403);
  if(this.policy.solverReview?.contract!=='s8-r8-solver-module-review-v1')fault('S8_SOLVER_VERSIONED_REVIEW_POLICY_UNAVAILABLE',503);
  if(operation==='SOLVER_READ'){
   return {readOnly:true,result:{generation:this.generation,active:this.active,revisions:[...this.states.values()].map(s=>({
    ref:s.candidate.ref,capsuleRef:s.candidate.capsule.ref,admissionRef:s.admissionRef,evaluationRef:s.evaluationRef,
    status:s.revoked?'REVOKED':s.activation?'DIAGNOSTIC_ACTIVE':s.admissionRef?'DIAGNOSTIC_ADMITTED':s.evaluationRef?'DEVELOPMENT_REVIEWED':'PROPOSED',
    uses:s.uses})),uses:[...this.uses.values()],protectedExecution:false}};
  }
  if(operation==='SOLVER_CURRENT'){
   const input=z.object({lease:z.unknown()}).strict().parse(body),lease=input.lease as SolverUseLease,state=await this.currentLease(lease);
   return {readOnly:true,result:{current:true,lease,capsuleRef:state.candidate.capsule.ref,protectedExecution:false}};
  }
  let ref:CapabilityRef,content:unknown,extra:Record<string,unknown>={};
  if(operation==='SOLVER_PROPOSE'){
   const candidate=parseSolverCandidate(body);this.scope(candidate);
   if(candidate.principalId!==actor.principalId||this.states.has(candidate.ref.id)||
    Date.parse(candidate.proposedAt)>Date.now()||Date.parse(candidate.domain.validAfter)<Date.parse(this.policy.validAfter)||
    Date.parse(candidate.domain.validUntil)>Date.parse(this.policy.validUntil))fault('S8_SOLVER_PROPOSAL_IDENTITY_OR_VALIDITY');
   const state:State={candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,activation:null,revoked:false,uses:0};
   await this.dependencies(state);const {ref:ignored,...preimage}=candidate;ref=candidate.ref;content=preimage;
  }else if(operation==='SOLVER_USE'){
   const input=SolverUseSchema.parse(body);this.scope(input);const state=this.state(input.revisionRef);this.current(state,true);await this.dependencies(state);
   if(hash(input.admissionRef)!==hash(state.admissionRef)||state.uses>=state.candidate.limits.maxUses||
    [...this.states.values()].reduce((total,entry)=>total+entry.uses,0)>=this.policy.maxTotalUses||
    Date.parse(input.originalDeadlineAt)<=Date.now())fault('S8_SOLVER_USE_BOUND_OR_ADMISSION_CHANGED',403);
   const leaseBody={schema:'finnor.s8.solver-use.v1' as const,useId:randomUUID(),revisionRef:state.candidate.ref,admissionRef:state.admissionRef!,
    capsuleRef:state.candidate.capsule.ref,payloadDigest:state.candidate.payloadDigest,inputDigest:input.inputDigest,
    workInputDigest:input.workInputDigest,rightsRef:input.rightsRef,generation:this.generation,
    expiresAt:new Date(Math.min(Date.parse(input.originalDeadlineAt),Date.parse(state.activation!.validUntil),
     Date.now()+state.candidate.limits.maxUseWallMs)).toISOString(),mode:'DIAGNOSTIC' as const,protectedExecution:false as const,executionAuthorityGranted:false as const};
   ref=solverPortRef('use',leaseBody);const lease={...leaseBody,ref};content=leaseBody;extra={lease};
  }else{
   const signed=z.object({body:z.unknown(),keyId:z.string().min(1).max(256),signature:z.string().min(1).max(128)}).strict().parse(body);
   const schema=operation==='SOLVER_REGISTER'?SolverReviewSchema:operation==='SOLVER_EVALUATE'?SolverEvaluationSchema:
    operation==='SOLVER_ADMIT'?SolverAdmissionSchema:operation==='SOLVER_ACTIVATE'?SolverActivationSchema:operation==='SOLVER_REVOKE'?SolverRevocationSchema:null;
   if(!schema)fault('S8_SOLVER_OPERATION_UNSUPPORTED',404);
   const parsed=schema.parse(signed.body),state=this.state(parsed.revisionRef),candidate=state.candidate;
   assertSignature({...signed,body:parsed},role==='EVALUATOR'?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
   if(actor.principalId===candidate.principalId)fault('S8_SOLVER_SELF_ADMISSION',403);
   await this.dependencies(state);if(state.revoked)fault('S8_SOLVER_REVOKED',403);
   if(operation==='SOLVER_REGISTER'){
    const p=SolverReviewSchema.parse(parsed);this.scope(p);
    if(state.protocol||p.evaluatorId!==actor.principalId||p.payloadDigest!==candidate.payloadDigest||
     p.domainDigest!==hash(candidate.domain)||p.checkerDigest!==candidate.capsule.receipt.checkerDigest||
     p.runtimeDigest!==candidate.capsule.runtime.identityDigest||Date.parse(p.registeredAt)<Date.parse(candidate.proposedAt)||Date.parse(p.registeredAt)>Date.now())
     fault('S8_SOLVER_FIXED_REVIEW_BINDING');
   }else if(operation==='SOLVER_EVALUATE'){
    const e=SolverEvaluationSchema.parse(parsed);
    if(!state.protocol||!state.protocolRef||state.evaluation||e.evaluatorId!==actor.principalId||
     e.evaluatorId!==state.protocol.body.evaluatorId||hash(e.protocolRef)!==hash(state.protocolRef)||
     e.payloadDigest!==candidate.payloadDigest||e.domainDigest!==hash(candidate.domain)||
     e.expectedSemanticReceiptDigest!==hash(candidate.capsule.receipt)||Date.parse(e.completedAt)>Date.now()||
     Date.parse(e.completedAt)<Date.parse(state.protocol.body.registeredAt))fault('S8_SOLVER_EVALUATION_PREIMAGE_SUBSTITUTION');
    const runtime=await loadRuntime();if(hash(runtime)!==candidate.capsule.runtime.identityDigest)fault('S8_SOLVER_REVIEW_RUNTIME_CHANGED');
    const receipt=await verifyCompleteDomain({program:candidate.capsule.program,module:candidate.capsule.module,runtime,
     sourcePins:candidate.capsule.semanticSourcePins,deadlineAt:Math.min(Date.parse(candidate.capsule.envelope.originalDeadlineAt),Date.now()+600000)});
    extra={evaluation:{signedEvidence:{...signed,body:parsed},receipt,receiptDigest:hash(receipt),
     disposition:'SUPPORTED_DISPOSABLE',protectedAdmission:false,qualification:'OWNER_EXECUTED_FULL_ORIGINAL_D_NOT_PROTECTED_OR_PERFORMANCE_ADMISSION'}};
    await this.dependencies(state);
   }else if(operation==='SOLVER_ADMIT'){
    const a=SolverAdmissionSchema.parse(parsed);
    if(state.admission||!state.evaluationRef||!state.evaluation||a.payloadDigest!==candidate.payloadDigest||
     actor.principalId===state.protocol?.body.evaluatorId||
     a.domainDigest!==hash(candidate.domain)||hash(a.evaluationRef)!==hash(state.evaluationRef))fault('S8_SOLVER_ADMISSION_BINDING');
   }else if(operation==='SOLVER_ACTIVATE'){
    const a=SolverActivationSchema.parse(parsed);this.current(state);
    if(hash(a.admissionRef)!==hash(state.admissionRef)||a.expectedGeneration!==this.generation||
     a.predecessorRef?.id!==(this.active??undefined)||Date.parse(a.validUntil)>Date.parse(candidate.domain.validUntil)||
     Date.parse(a.validUntil)<=Date.now())fault('S8_SOLVER_ACTIVATION_FENCE_OR_ADMISSION');
   }else{
    const r=SolverRevocationSchema.parse(parsed);
    if(hash(r.expectedAdmissionRef)!==hash(state.admissionRef)||r.expectedGeneration!==this.generation||this.active!==candidate.ref.id)
     fault('S8_SOLVER_REVOCATION_FENCE');
    if(r.predecessorRef){const predecessor=this.state(r.predecessorRef);this.current(predecessor);await this.dependencies(predecessor);}
   }
   content=extra.evaluation??{...signed,body:parsed};ref=solverPortRef(operation.slice(7).toLowerCase(),content);
  }
  const receipt=await commit(ref,content);
  return {readOnly:false,result:{ref,receipt,...extra,protectedExecution:false,executionAuthorityGranted:false,
   qualification:'DISPOSABLE_SOLVER_MODULE_OWNER_PROTOCOL_NOT_PROTECTED_R8_M5_P8_M6_OR_BUSINESS_AUTHORITY'}};
 }
}
