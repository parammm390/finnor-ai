/** Typed nonfinancial S8 sibling. It never parses an allocation revision or
 * supplies execution, protected-evaluation or production authority. */
import {z} from 'zod';
import {createPublicKey} from 'node:crypto';
import {assertSignature,byteDigest,digest,fault,RefSchema,type CapabilityRef,type AuthorityKey,type Signed} from './contracts';
import type {JournalEntry} from './journal';
import {assertIdentifiedSystemSourceClosure} from './source-closure';
const text=z.string().min(1).max(256),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
export const IdentifiedSystemPayloadSchema=z.object({
 schema:z.literal('finnor.s8.identified-system-payload.v1'),kind:z.literal('IdentifiedSystemModel'),identificationId:z.string().uuid(),modelId:z.string().uuid(),
 profile:z.literal('PE_FIRM_DIGITAL_RELATION_V1'),modelDigest:hex,domainDigest:hex,familyDigest:hex,checkDigest:hex,rightsDigest:hex,
 sourceDigest:hex,checkerDigest:hex,lockDigest:hex,schemaDigest:hex,runtimeDigest:hex,
 runtime:z.literal('FINNOR_NODE_22_FINITE_DIGITAL_IDENTIFICATION_V1'),effects:z.literal('NO_MODEL_EFFECT_AUTHORITY'),
}).strict();
const Domain=z.object({root:z.object({entityType:z.literal('pe_deal'),entityId:z.string().uuid()}).strict(),validAfter:instant,validUntil:instant}).strict();
const Body=z.object({schema:z.literal('finnor.s8.identified-system-candidate.v1'),tenantId:text,principalId:text,rightsRef:hex,
 owningInterface:z.literal('x4-identified-system-v1'),payload:IdentifiedSystemPayloadSchema,domain:Domain,
 dependencies:z.array(z.object({path:z.string().min(1).max(4096),sha256:hex}).strict()).min(1).max(256),proposedAt:instant,
 protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
export type IdentifiedSystemCandidate=z.infer<typeof Body>&{ref:CapabilityRef};
export const identifiedSystemRef=(kind:string,body:unknown):CapabilityRef=>({owner:'S8',id:'identified-system-'+kind+':'+digest(body),version:'s8-identified-system-v1',contentDigest:digest(body)});
export function parseIdentifiedSystemCandidate(value:unknown):IdentifiedSystemCandidate{
 if(Buffer.byteLength(JSON.stringify(value))>262144)fault('S8_IDENTIFIED_SYSTEM_BOUND');
 const {ref,...rest}=z.object({ref:RefSchema}).passthrough().parse(value),body=Body.parse(rest);
 if(digest(ref)!==digest(identifiedSystemRef('candidate',body))||Date.parse(body.domain.validUntil)<=Date.parse(body.domain.validAfter)||
  Date.parse(body.proposedAt)>Date.now()||new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length)fault('S8_IDENTIFIED_SYSTEM_BINDING');
 return {...body,ref};
}
export function makeIdentifiedSystemCandidate(value:z.infer<typeof Body>){const b=Body.parse(value);return parseIdentifiedSystemCandidate({...b,ref:identifiedSystemRef('candidate',b)});}
export const IdentifiedSystemProtocolSchema=z.object({
 schema:z.literal('finnor.s8.identified-system-protocol.v1'),revisionRef:RefSchema,evaluatorId:text,nativeAssignmentId:z.string().uuid(),
 assignmentDigest:hex,payloadDigest:hex,domainDigest:hex,registeredAt:instant,nativeRegisteredAt:instant,
 qualification:z.literal('PREEXISTING_PREREGISTERED_NATIVE_REPLICATION_DEVELOPMENT_NOT_PROTECTED'),
}).strict();
export const IdentifiedSystemEvaluationSchema=z.object({
 schema:z.literal('finnor.s8.identified-system-evaluation.v1'),revisionRef:RefSchema,protocolRef:RefSchema,evaluatorId:text,nativeAssignmentId:z.string().uuid(),
 assignmentDigest:hex,payloadDigest:hex,domainDigest:hex,resultsDigest:hex,completedAt:instant,
 disposition:z.enum(['SUPPORTED_DEVELOPMENT','REFUSED_OR_INCOMPLETE']),protectedAdmission:z.literal(false),
}).strict();
const Admission=z.object({schema:z.literal('finnor.s8.identified-system-admission.v1'),revisionRef:RefSchema,evaluationRef:RefSchema,
 payloadDigest:hex,domainDigest:hex,protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
const Revocation=z.object({schema:z.literal('finnor.s8.identified-system-revocation.v1'),revisionRef:RefSchema,expectedAdmissionRef:RefSchema,reason:text}).strict();
type State={candidate:IdentifiedSystemCandidate;protocol:Signed<z.infer<typeof IdentifiedSystemProtocolSchema>>|null;protocolRef:CapabilityRef|null;
 evaluation:Signed<z.infer<typeof IdentifiedSystemEvaluationSchema>>|null;evaluationRef:CapabilityRef|null;
 admission:Signed<z.infer<typeof Admission>>|null;admissionRef:CapabilityRef|null;revoked:boolean};
type Actor={id:string;principalId:string;roles:readonly string[]};
interface Policy{domain:string;tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];sourcePins:Array<{path:string;sha256:string}>;maxEntries:number}
export class IdentifiedSystemCapabilityPort{
 private states=new Map<string,State>();
 constructor(private policy:Policy){}
 replay(entry:JournalEntry){
  if(entry.operation==='IDENTIFIED_SYSTEM_PROPOSE'){
   const candidate=parseIdentifiedSystemCandidate(entry.body);this.states.set(candidate.ref.id,{candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false});return;
  }
  const b=entry.body?.body;if(!b)return;const s=this.state(b.revisionRef);
  if(entry.operation==='IDENTIFIED_SYSTEM_REGISTER'){s.protocol=entry.body;s.protocolRef=entry.result.ref;}
  if(entry.operation==='IDENTIFIED_SYSTEM_EVALUATE'){s.evaluation=entry.body;s.evaluationRef=entry.result.ref;}
  if(entry.operation==='IDENTIFIED_SYSTEM_ADMIT'){s.admission=entry.body;s.admissionRef=entry.result.ref;}
  if(entry.operation==='IDENTIFIED_SYSTEM_REVOKE')s.revoked=true;
 }
 private state(ref:CapabilityRef){const s=this.states.get(ref.id);if(!s||digest(s.candidate.ref)!==digest(ref))fault('S8_IDENTIFIED_SYSTEM_NOT_FOUND',404);return s;}
 private sources(s:State){if(digest(s.candidate.dependencies)!==digest(this.policy.sourcePins))fault('S8_IDENTIFIED_SYSTEM_SOURCE_SUBSTITUTION');}
 private async proof(s:State,assignment?:string){const {resolveIdentifiedSystemNativeProof}=await import('../../private-equity/src/system-identification/admission');return resolveIdentifiedSystemNativeProof(s.candidate,assignment);}
 private domainCurrent(c:IdentifiedSystemCandidate){const now=Date.now();return now>=Math.max(Date.parse(c.domain.validAfter),Date.parse(this.policy.validAfter))&&now<Math.min(Date.parse(c.domain.validUntil),Date.parse(this.policy.validUntil));}
 private authority(s:State){
  if(s.revoked||!s.admission||!s.evaluation||s.evaluation.body.disposition!=='SUPPORTED_DEVELOPMENT'||!this.domainCurrent(s.candidate))return null;
  const evaluator=assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId),promoter=assertSignature(s.admission,this.policy.promotionKeys);
  return new Date(Math.min(Date.parse(s.candidate.domain.validUntil),Date.parse(this.policy.validUntil),Date.parse(evaluator.validUntil),Date.parse(promoter.validUntil))).toISOString();
 }
 async command(actor:Actor,operation:string,input:any,commit:(ref:CapabilityRef,body:unknown)=>Promise<unknown>){
  const role=operation==='IDENTIFIED_SYSTEM_PROPOSE'?'PROPOSER':['IDENTIFIED_SYSTEM_REGISTER','IDENTIFIED_SYSTEM_EVALUATE'].includes(operation)?'EVALUATOR':
   ['IDENTIFIED_SYSTEM_ADMIT','IDENTIFIED_SYSTEM_REVOKE'].includes(operation)?'PROMOTER':null;
  if(role?!actor.roles.includes(role):operation!=='IDENTIFIED_SYSTEM_CURRENT'||!actor.roles.some(r=>r==='CONSUMER'||r==='READER'))fault('S8_OPERATION_NOT_AUTHORIZED',403);
  if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_PROTECTED_IDENTIFIED_SYSTEM_UNADMITTED',403);
  await assertIdentifiedSystemSourceClosure(this.policy.sourcePins);
  if(operation==='IDENTIFIED_SYSTEM_CURRENT'){
   const s=this.state(z.object({revisionRef:RefSchema}).strict().parse(input).revisionRef);this.sources(s);
   let currentUntil:string|null=null;
   try{if(this.authority(s)&&s.evaluation){const proof=await this.proof(s,s.evaluation.body.nativeAssignmentId);if(proof.resultsDigest===s.evaluation.body.resultsDigest&&proof.disposition==='SUPPORTED_DEVELOPMENT')currentUntil=this.authority(s);}}catch{/* Every current serve consults live native owners. */}
   return {readOnly:true,result:{current:!!currentUntil,currentUntil,revisionRef:s.candidate.ref,candidate:currentUntil?s.candidate:null,admissionRef:currentUntil?s.admissionRef:null,protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,executionAuthorityGranted:false}};
  }
  let ref:CapabilityRef,content:unknown,finalAuthority=()=>{};
  if(operation==='IDENTIFIED_SYSTEM_PROPOSE'){
   const candidate=parseIdentifiedSystemCandidate(input);
   if(!this.domainCurrent(candidate))fault('S8_IDENTIFIED_SYSTEM_DOMAIN_EXPIRED');
   if(candidate.tenantId!==this.policy.tenantId||candidate.principalId!==this.policy.principalId||candidate.rightsRef!==this.policy.rightsRef||actor.principalId!==candidate.principalId||this.states.has(candidate.ref.id))fault('S8_IDENTIFIED_SYSTEM_SCOPE_OR_DUPLICATE',403);
   if(Date.parse(candidate.domain.validAfter)<Date.parse(this.policy.validAfter)||Date.parse(candidate.domain.validUntil)>Date.parse(this.policy.validUntil)||this.states.size>=this.policy.maxEntries)fault('S8_IDENTIFIED_SYSTEM_DOMAIN_BOUND');
   const s:State={candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false};this.sources(s);await this.proof(s);
   finalAuthority=()=>{if(!this.domainCurrent(candidate))fault('S8_IDENTIFIED_SYSTEM_DOMAIN_EXPIRED');};
   const {ref:_,...body}=candidate;ref=candidate.ref;content=body;
  }else{
   const signed=z.object({body:z.unknown(),keyId:text,signature:z.string().min(1).max(128)}).strict().parse(input);
   const schema=operation==='IDENTIFIED_SYSTEM_REGISTER'?IdentifiedSystemProtocolSchema:operation==='IDENTIFIED_SYSTEM_EVALUATE'?IdentifiedSystemEvaluationSchema:operation==='IDENTIFIED_SYSTEM_ADMIT'?Admission:Revocation;
   const body=schema.parse(signed.body),s=this.state(body.revisionRef);this.sources(s);
   if(s.revoked)fault('S8_IDENTIFIED_SYSTEM_REVOKED',403);
   if(operation!=='IDENTIFIED_SYSTEM_REVOKE'&&!this.domainCurrent(s.candidate))fault('S8_IDENTIFIED_SYSTEM_DOMAIN_EXPIRED');
   const evaluator=operation==='IDENTIFIED_SYSTEM_REGISTER'||operation==='IDENTIFIED_SYSTEM_EVALUATE',
    key=assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
   const fingerprint=(v:string)=>byteDigest(createPublicKey(v).export({type:'spki',format:'der'}));
   if(evaluator&&this.policy.promotionKeys.some(k=>fingerprint(k.publicKey)===fingerprint(key.publicKey)))fault('S8_AUTHORITY_NOT_SEPARATED',403);
   finalAuthority=()=>{
    if(operation!=='IDENTIFIED_SYSTEM_REVOKE'&&!this.domainCurrent(s.candidate))fault('S8_IDENTIFIED_SYSTEM_DOMAIN_EXPIRED');
    assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
    if(operation==='IDENTIFIED_SYSTEM_ADMIT'&&s.evaluation)assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
   };
   if(operation==='IDENTIFIED_SYSTEM_REGISTER'){
    const p=IdentifiedSystemProtocolSchema.parse(body),proof=await this.proof(s,p.nativeAssignmentId);
    if(s.protocol||p.evaluatorId!==actor.principalId||p.evaluatorId===s.candidate.principalId||p.evaluatorId!==proof.evaluatorId||p.assignmentDigest!==proof.assignmentDigest||
     p.nativeRegisteredAt!==proof.registeredAt||p.payloadDigest!==digest(s.candidate.payload)||p.domainDigest!==digest(s.candidate.domain)||
     Date.parse(p.registeredAt)<Date.parse(s.candidate.proposedAt)||Date.parse(p.registeredAt)>Date.now())fault('S8_IDENTIFIED_SYSTEM_PROTOCOL_BINDING');
   }else if(operation==='IDENTIFIED_SYSTEM_EVALUATE'){
    const e=IdentifiedSystemEvaluationSchema.parse(body),proof=await this.proof(s,e.nativeAssignmentId);
    if(!s.protocol||!s.protocolRef||s.evaluation||e.evaluatorId!==actor.principalId||e.evaluatorId!==s.protocol.body.evaluatorId||e.nativeAssignmentId!==s.protocol.body.nativeAssignmentId||
     digest(e.protocolRef)!==digest(s.protocolRef)||e.assignmentDigest!==s.protocol.body.assignmentDigest||e.resultsDigest!==proof.resultsDigest||e.disposition!==proof.disposition||
     e.payloadDigest!==digest(s.candidate.payload)||e.domainDigest!==digest(s.candidate.domain)||Date.parse(e.completedAt)<Date.parse(s.protocol.body.registeredAt)||Date.parse(e.completedAt)>Date.now())fault('S8_IDENTIFIED_SYSTEM_EVALUATION_BINDING');
   }else if(operation==='IDENTIFIED_SYSTEM_ADMIT'){
    const a=Admission.parse(body);
    if(s.evaluation)assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
    const proof=await this.proof(s,s.evaluation?.body.nativeAssignmentId);
    if(s.admission||!s.evaluation||!s.evaluationRef||proof.disposition!=='SUPPORTED_DEVELOPMENT'||proof.resultsDigest!==s.evaluation.body.resultsDigest||
     digest(a.evaluationRef)!==digest(s.evaluationRef)||a.payloadDigest!==digest(s.candidate.payload)||a.domainDigest!==digest(s.candidate.domain))fault('S8_IDENTIFIED_SYSTEM_ADMISSION_BINDING');
   }else if(!s.admissionRef||digest(Revocation.parse(body).expectedAdmissionRef)!==digest(s.admissionRef))fault('S8_IDENTIFIED_SYSTEM_REVOCATION_BINDING');
   content={...signed,body};ref=identifiedSystemRef(operation.replace('IDENTIFIED_SYSTEM_','').toLowerCase(),content);
  }
  finalAuthority();const receipt=await commit(ref,content);
  return {readOnly:false,result:{ref,receipt,protectedAdmission:false,executionAuthorityGranted:false,qualification:'DEVELOPMENT_SCIENTIFIC_MODEL_NOT_PROTECTED_OR_PRODUCTION'}};
 }
}
