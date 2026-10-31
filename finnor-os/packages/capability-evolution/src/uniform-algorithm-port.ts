import {z} from 'zod';
import {assertSignature,digest,fault,RefSchema,type CapabilityRef,type AuthorityKey,type Signed} from './contracts';
import type {JournalEntry} from './journal';
import {assertUniformAlgorithmSourceClosure,assertTotalUniformPinBounds,TOTAL_UNIFORM_SOURCE_LIMITS} from './source-closure';
const text=z.string().min(1).max(256),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
export const UniformAlgorithmPayloadSchema=z.object({
 schema:z.literal('finnor.s8.uniform-algorithm-payload.v1'),kind:z.literal('AlgorithmTheoryCapsule'),discoveryId:z.string().uuid(),
 profile:z.literal('INTEGER_ADDITIVE_BINARY_BOX_V1'),capsuleDigest:hex,theoremDigest:hex,implementationDigest:hex,
 specificationDigest:hex,checkerDigest:hex,runtimeDigest:hex,sourceDigest:hex,rightsDigest:hex,
 runtime:z.literal('NATIVE_DARWIN_ARM64_LEAN_4_34_1'),effects:z.literal('NO_ALGORITHM_EFFECT_AUTHORITY'),
}).strict();
export const TotalAlgorithmPayloadSchema=UniformAlgorithmPayloadSchema.extend({
 schema:z.literal('finnor.s8.uniform-algorithm-payload.v2'),profile:z.literal('CLOSED_TOTAL_FOLD_INTEGER_LISTS_V2'),
 specificationSourceDigest:hex,taskWorkId:z.string().uuid(),taskSourceDigest:hex,episodeCutDigest:hex,
 interpreterDigest:hex,interpreterProofObjectDigest:hex,
 quality:z.literal('EXACT_LEAST_INITIAL_STATE_NOT_ALLOCATION_OPTIMUM'),
}).strict();
const Domain=z.object({root:z.object({entityType:text,entityId:z.string().uuid()}).strict(),validAfter:instant,validUntil:instant}).strict();
const Body=z.object({schema:z.literal('finnor.s8.uniform-algorithm-candidate.v1'),tenantId:z.string().uuid(),principalId:z.string().uuid(),rightsRef:hex,
 owningInterface:z.literal('y5-uniform-algorithm-v1'),payload:UniformAlgorithmPayloadSchema,domain:Domain,
 dependencies:z.array(z.object({path:z.string().min(1).max(4096),sha256:hex}).strict()).min(1).max(256),proposedAt:instant,
 protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
const TotalBody=Body.extend({schema:z.literal('finnor.s8.uniform-algorithm-candidate.v2'),
 owningInterface:z.literal('y5-total-algorithm-v2'),payload:TotalAlgorithmPayloadSchema,
 dependencies:z.array(Body.shape.dependencies.element).min(1).max(TOTAL_UNIFORM_SOURCE_LIMITS.maxPins)}).strict();
export type TotalAlgorithmCandidate=z.infer<typeof TotalBody>&{ref:CapabilityRef};
export type UniformAlgorithmCandidate=(z.infer<typeof Body>&{ref:CapabilityRef})|TotalAlgorithmCandidate;
export const uniformAlgorithmRef=(kind:string,body:unknown):CapabilityRef=>{
 const value=body as {schema?:string;body?:{schema?:string}},schema=value.schema??value.body?.schema;
 return {owner:'S8',id:'uniform-algorithm-'+kind+':'+digest(body),version:schema?.endsWith('.v2')?'s8-total-algorithm-v2':'s8-uniform-algorithm-v1',contentDigest:digest(body)};
};
export function parseUniformAlgorithmCandidate(value:unknown):UniformAlgorithmCandidate{
 const total=!!value&&typeof value==='object'&&(value as {schema?:string}).schema==='finnor.s8.uniform-algorithm-candidate.v2';
 if(Buffer.byteLength(JSON.stringify(value))>(total?2097152:262144))fault('S8_UNIFORM_ALGORITHM_BOUND');
 const {ref,...rest}=z.object({ref:RefSchema}).passthrough().parse(value),body=(total?TotalBody:Body).parse(rest);
 if(total)assertTotalUniformPinBounds(body.dependencies);
 if(digest(ref)!==digest(uniformAlgorithmRef('candidate',body))||Date.parse(body.domain.validUntil)<=Date.parse(body.domain.validAfter)||
  Date.parse(body.proposedAt)>Date.now()||new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length)fault('S8_UNIFORM_ALGORITHM_BINDING');
 return {...body,ref};
}
export function makeUniformAlgorithmCandidate(value:z.infer<typeof Body>|z.infer<typeof TotalBody>){
 const body=(value.schema==='finnor.s8.uniform-algorithm-candidate.v2'?TotalBody:Body).parse(value);
 return parseUniformAlgorithmCandidate({...body,ref:uniformAlgorithmRef('candidate',body)});
}
export const UniformAlgorithmProtocolSchema=z.object({
 schema:z.literal('finnor.s8.uniform-algorithm-protocol.v1'),revisionRef:RefSchema,evaluatorId:z.string().uuid(),nativeEvaluationId:z.string().uuid(),
 assignmentDigest:hex,payloadDigest:hex,domainDigest:hex,registeredAt:instant,
 qualification:z.literal('PREREGISTERED_PUBLIC_NATIVE_KERNEL_AND_ORIGINAL_S5_REPLAY_NOT_PROTECTED'),
}).strict();
export const TotalAlgorithmProtocolSchema=UniformAlgorithmProtocolSchema.extend({
 schema:z.literal('finnor.s8.uniform-algorithm-protocol.v2'),
 qualification:z.literal('PREREGISTERED_PUBLIC_NATIVE_KERNEL_AND_ORIGINAL_TYPED_TASK_NOT_PROTECTED'),
}).strict();
export const UniformAlgorithmEvaluationSchema=z.object({
 schema:z.literal('finnor.s8.uniform-algorithm-evaluation.v1'),revisionRef:RefSchema,protocolRef:RefSchema,evaluatorId:z.string().uuid(),nativeEvaluationId:z.string().uuid(),
 assignmentDigest:hex,payloadDigest:hex,domainDigest:hex,resultsDigest:hex,completedAt:instant,
 disposition:z.enum(['SUPPORTED_DEVELOPMENT','REFUSED_OR_INCOMPLETE']),protectedAdmission:z.literal(false),
}).strict();
export const TotalAlgorithmEvaluationSchema=UniformAlgorithmEvaluationSchema.extend({schema:z.literal('finnor.s8.uniform-algorithm-evaluation.v2')}).strict();
const Admission=z.object({schema:z.literal('finnor.s8.uniform-algorithm-admission.v1'),revisionRef:RefSchema,evaluationRef:RefSchema,
 payloadDigest:hex,domainDigest:hex,protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
const Revocation=z.object({schema:z.literal('finnor.s8.uniform-algorithm-revocation.v1'),revisionRef:RefSchema,expectedAdmissionRef:RefSchema,reason:text}).strict();
const TotalAdmission=Admission.extend({schema:z.literal('finnor.s8.uniform-algorithm-admission.v2')}).strict();
const TotalRevocation=Revocation.extend({schema:z.literal('finnor.s8.uniform-algorithm-revocation.v2')}).strict();
type Protocol=z.infer<typeof UniformAlgorithmProtocolSchema>|z.infer<typeof TotalAlgorithmProtocolSchema>;
type Evaluation=z.infer<typeof UniformAlgorithmEvaluationSchema>|z.infer<typeof TotalAlgorithmEvaluationSchema>;
type State={candidate:UniformAlgorithmCandidate;protocol:Signed<Protocol>|null;protocolRef:CapabilityRef|null;protocolRecordedAt:string|null;
 evaluation:Signed<Evaluation>|null;evaluationRef:CapabilityRef|null;
 admission:Signed<z.infer<typeof Admission>|z.infer<typeof TotalAdmission>>|null;admissionRef:CapabilityRef|null;revoked:boolean};
type Actor={id:string;principalId:string;roles:readonly string[]};
interface Policy{domain:string;tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];sourcePins:Array<{path:string;sha256:string}>;maxEntries:number}
export class UniformAlgorithmCapabilityPort{
 private states=new Map<string,State>();
 constructor(private policy:Policy){}
 replay(entry:JournalEntry){
  if(entry.operation==='UNIFORM_ALGORITHM_PROPOSE'){const candidate=parseUniformAlgorithmCandidate(entry.body);this.states.set(candidate.ref.id,{candidate,protocol:null,protocolRef:null,protocolRecordedAt:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false});return;}
  const b=entry.body?.body;if(!b)return;const s=this.state(b.revisionRef);
  // The signed registeredAt is caller-supplied; the journal append time is the server's order witness.
  if(entry.operation==='UNIFORM_ALGORITHM_REGISTER'){s.protocol=entry.body;s.protocolRef=entry.result.ref;s.protocolRecordedAt=entry.knowledgeAt;}
  if(entry.operation==='UNIFORM_ALGORITHM_EVALUATE'){s.evaluation=entry.body;s.evaluationRef=entry.result.ref;}
  if(entry.operation==='UNIFORM_ALGORITHM_ADMIT'){s.admission=entry.body;s.admissionRef=entry.result.ref;}
  if(entry.operation==='UNIFORM_ALGORITHM_REVOKE')s.revoked=true;
 }
 private state(ref:CapabilityRef){const s=this.states.get(ref.id);if(!s||digest(s.candidate.ref)!==digest(ref))fault('S8_UNIFORM_ALGORITHM_NOT_FOUND',404);return s;}
 private async sources(s:State){
  if(s.candidate.schema==='finnor.s8.uniform-algorithm-candidate.v2'){
   if(this.policy.sourcePins.some(p=>!s.candidate.dependencies.some(d=>d.path===p.path&&d.sha256===p.sha256)))
    fault('S8_UNIFORM_ALGORITHM_SOURCE_SUBSTITUTION');
   await assertUniformAlgorithmSourceClosure(s.candidate.dependencies,'TOTAL_V2');return;
  }
  if(digest(s.candidate.dependencies)!==digest(this.policy.sourcePins))fault('S8_UNIFORM_ALGORITHM_SOURCE_SUBSTITUTION');
  await assertUniformAlgorithmSourceClosure(this.policy.sourcePins);
 }
 private async proof(s:State,evaluationId?:string){const {resolveUniformNativeProof}=await import('../../private-equity/src/uniform-algorithms/admission');return resolveUniformNativeProof(s.candidate,evaluationId);}
 private domainCurrent(c:UniformAlgorithmCandidate){const now=Date.now();return now>=Math.max(Date.parse(c.domain.validAfter),Date.parse(this.policy.validAfter))&&now<Math.min(Date.parse(c.domain.validUntil),Date.parse(this.policy.validUntil));}
 private authority(s:State,proofUntil?:string|null){
  if(s.revoked||!s.admission||!s.evaluation||s.evaluation.body.disposition!=='SUPPORTED_DEVELOPMENT'||!this.domainCurrent(s.candidate))return null;
  const e=assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId),p=assertSignature(s.admission,this.policy.promotionKeys);
  if(p.principalId===s.candidate.principalId||p.principalId===e.principalId)fault('S8_AUTHORITY_NOT_SEPARATED',403);
  const until=new Date(Math.min(Date.parse(s.candidate.domain.validUntil),Date.parse(this.policy.validUntil),Date.parse(e.validUntil),Date.parse(p.validUntil),
   ...(proofUntil?[Date.parse(proofUntil)]:[]))).toISOString();
  return proofUntil&&Date.now()>=Date.parse(until)?null:until;
 }
 async command(actor:Actor,operation:string,input:any,commit:(ref:CapabilityRef,body:unknown)=>Promise<unknown>){
  const role=operation==='UNIFORM_ALGORITHM_PROPOSE'?'PROPOSER':['UNIFORM_ALGORITHM_REGISTER','UNIFORM_ALGORITHM_EVALUATE'].includes(operation)?'EVALUATOR':['UNIFORM_ALGORITHM_ADMIT','UNIFORM_ALGORITHM_REVOKE'].includes(operation)?'PROMOTER':null;
  if(role?!actor.roles.includes(role):operation!=='UNIFORM_ALGORITHM_CURRENT'||!actor.roles.some(r=>r==='CONSUMER'||r==='READER'))fault('S8_OPERATION_NOT_AUTHORIZED',403);
  if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_PROTECTED_UNIFORM_ALGORITHM_UNADMITTED',403);
  if(operation==='UNIFORM_ALGORITHM_CURRENT'){
   const s=this.state(z.object({revisionRef:RefSchema}).strict().parse(input).revisionRef);let currentUntil:string|null=null;
   try{await this.sources(s);const proof=await this.proof(s,s.evaluation?.body.nativeEvaluationId);
    if(s.candidate.schema==='finnor.s8.uniform-algorithm-candidate.v2')await this.sources(s);
    if(proof.resultsDigest===s.evaluation?.body.resultsDigest&&proof.disposition==='SUPPORTED_DEVELOPMENT')currentUntil=this.authority(s,'validUntil'in proof?proof.validUntil:null);
   }catch{}
   return {readOnly:true,result:{current:!!currentUntil,currentUntil,revisionRef:s.candidate.ref,candidate:currentUntil?s.candidate:null,
    admissionRef:currentUntil?s.admissionRef:null,protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,executionAuthorityGranted:false}};
  }
  let ref:CapabilityRef,content:unknown;let final=()=>{};
  if(operation==='UNIFORM_ALGORITHM_PROPOSE'){
   const candidate=parseUniformAlgorithmCandidate(input);
   if(candidate.tenantId!==this.policy.tenantId||candidate.principalId!==this.policy.principalId||candidate.rightsRef!==this.policy.rightsRef||
    actor.principalId!==candidate.principalId||this.states.has(candidate.ref.id))fault('S8_UNIFORM_ALGORITHM_SCOPE_OR_DUPLICATE',403);
   if(!this.domainCurrent(candidate)||Date.parse(candidate.domain.validAfter)<Date.parse(this.policy.validAfter)||Date.parse(candidate.domain.validUntil)>Date.parse(this.policy.validUntil)||this.states.size>=this.policy.maxEntries)fault('S8_UNIFORM_ALGORITHM_DOMAIN_BOUND');
   const s:State={candidate,protocol:null,protocolRef:null,protocolRecordedAt:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false};
   await this.sources(s);await this.proof(s);final=()=>{if(!this.domainCurrent(candidate))fault('S8_UNIFORM_ALGORITHM_EXPIRED');};
   const {ref:_,...body}=candidate;ref=candidate.ref;content=body;
  }else{
   const signed=z.object({body:z.unknown(),keyId:text,signature:z.string().min(1).max(128)}).strict().parse(input);
   const s=this.state(z.object({revisionRef:RefSchema}).passthrough().parse(signed.body).revisionRef),total=s.candidate.schema==='finnor.s8.uniform-algorithm-candidate.v2';
   const ProtocolSchema=total?TotalAlgorithmProtocolSchema:UniformAlgorithmProtocolSchema,
    EvaluationSchema=total?TotalAlgorithmEvaluationSchema:UniformAlgorithmEvaluationSchema,
    AdmissionSchema=total?TotalAdmission:Admission,RevocationSchema=total?TotalRevocation:Revocation;
   const body=(operation==='UNIFORM_ALGORITHM_REGISTER'?ProtocolSchema:operation==='UNIFORM_ALGORITHM_EVALUATE'?EvaluationSchema:operation==='UNIFORM_ALGORITHM_ADMIT'?AdmissionSchema:RevocationSchema).parse(signed.body);
   await this.sources(s);
   if(s.revoked||operation!=='UNIFORM_ALGORITHM_REVOKE'&&!this.domainCurrent(s.candidate))fault('S8_UNIFORM_ALGORITHM_EXPIRED_OR_REVOKED');
   const evaluator=operation==='UNIFORM_ALGORITHM_REGISTER'||operation==='UNIFORM_ALGORITHM_EVALUATE';
   const key=assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
   if(key.principalId===s.candidate.principalId||!evaluator&&key.principalId===s.evaluation?.body.evaluatorId)fault('S8_AUTHORITY_NOT_SEPARATED',403);
   final=()=>{if(operation!=='UNIFORM_ALGORITHM_REVOKE'&&!this.domainCurrent(s.candidate))fault('S8_UNIFORM_ALGORITHM_EXPIRED');
    assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);};
   if(operation==='UNIFORM_ALGORITHM_REGISTER'){
    const p=ProtocolSchema.parse(body),proof=await this.proof(s,p.nativeEvaluationId);
    if(s.protocol||proof.evaluatorId!==p.evaluatorId||p.evaluatorId!==actor.principalId||p.assignmentDigest!==proof.assignmentDigest||
     p.payloadDigest!==digest(s.candidate.payload)||p.domainDigest!==digest(s.candidate.domain)||Date.parse(p.registeredAt)<Date.parse(s.candidate.proposedAt)||
     Date.parse(p.registeredAt)>Date.now()||proof.assignmentRegisteredAt===null||Date.parse(p.registeredAt)<Date.parse(proof.assignmentRegisteredAt)||
     proof.nativeStartedAt!==null)fault('S8_UNIFORM_ALGORITHM_PROTOCOL_BINDING');
   }else if(operation==='UNIFORM_ALGORITHM_EVALUATE'){
    const v=EvaluationSchema.parse(body),proof=await this.proof(s,v.nativeEvaluationId);
    if(!s.protocol||!s.protocolRef||s.evaluation||v.evaluatorId!==actor.principalId||v.evaluatorId!==s.protocol.body.evaluatorId||v.nativeEvaluationId!==s.protocol.body.nativeEvaluationId||
     digest(v.protocolRef)!==digest(s.protocolRef)||v.assignmentDigest!==s.protocol.body.assignmentDigest||v.resultsDigest!==proof.resultsDigest||v.disposition!==proof.disposition||
     v.payloadDigest!==digest(s.candidate.payload)||v.domainDigest!==digest(s.candidate.domain)||proof.nativeStartedAt===null||
     Date.parse(proof.nativeStartedAt)<Date.parse(s.protocol.body.registeredAt)||!s.protocolRecordedAt||
     Date.parse(proof.nativeStartedAt)<Date.parse(s.protocolRecordedAt)||v.completedAt!==proof.nativeCompletedAt||
     Date.parse(v.completedAt)<Date.parse(proof.nativeStartedAt)||Date.parse(v.completedAt)>Date.now())fault('S8_UNIFORM_ALGORITHM_EVALUATION_BINDING');
   }else if(operation==='UNIFORM_ALGORITHM_ADMIT'){
    const v=AdmissionSchema.parse(body);if(s.evaluation)assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
    const proof=await this.proof(s,s.evaluation?.body.nativeEvaluationId);
    if(s.admission||!s.evaluationRef||s.evaluation?.body.disposition!=='SUPPORTED_DEVELOPMENT'||proof.disposition!=='SUPPORTED_DEVELOPMENT'||proof.resultsDigest!==s.evaluation.body.resultsDigest||
     digest(v.evaluationRef)!==digest(s.evaluationRef)||v.payloadDigest!==digest(s.candidate.payload)||v.domainDigest!==digest(s.candidate.domain))fault('S8_UNIFORM_ALGORITHM_ADMISSION_BINDING');
   }else{const v=RevocationSchema.parse(body);if(!s.admissionRef||digest(v.expectedAdmissionRef)!==digest(s.admissionRef))fault('S8_UNIFORM_ALGORITHM_REVOCATION_BINDING');}
   content={...signed,body};ref=uniformAlgorithmRef(operation.replace('UNIFORM_ALGORITHM_','').toLowerCase(),content);
  }
  final();const receipt=await commit(ref,content);
  return {readOnly:false,result:{ref,receipt,protectedAdmission:false,executionAuthorityGranted:false,qualification:'DISPOSABLE_ENGINEERING_NOT_PROTECTED_DISCOVERY_OR_PRODUCTION'}};
 }
}
