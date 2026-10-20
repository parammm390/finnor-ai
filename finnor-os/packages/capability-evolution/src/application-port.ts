/** X3 is a typed S8 domain, never an allocation method or P5 interface payload.
 * Public development admission is explicitly not the protected 20/60 gate. */
import {z} from 'zod';
import {createPublicKey} from 'node:crypto';
import {assertSignature,byteDigest,digest,fault,RefSchema,type AuthorityKey,type CapabilityRef,type Signed} from './contracts';
import type {JournalEntry} from './journal';
const text=z.string().min(1).max(256),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
export const ApplicationPayloadSchema=z.object({
 schema:z.literal('finnor.s8.application-payload.v1'),applicationId:text,releaseId:text,profile:z.literal('PE_FIRM_TYPED_APPLICATION_V1'),
 specificationDigest:hex,programDigest:hex,formsDigest:hex,sourceDigest:hex,lockDigest:hex,checkerDigest:hex,schemaDigest:hex,
 runtime:z.literal('FINNOR_API_NODE_22_X3_STACK_V1'),currentness:z.literal('EXACT_INSTALLED_RELEASE_REQUIRED'),effects:z.literal('PREPARED_INTENT_ONLY'),
}).strict();
export const ApplicationDomainSchema=z.object({root:z.object({entityType:text,entityId:text}).strict(),applicationId:text,validAfter:instant,validUntil:instant}).strict();
const CandidateBody=z.object({schema:z.literal('finnor.s8.application-candidate.v1'),tenantId:text,principalId:text,rightsRef:text,
 owningInterface:z.literal('x3-enterprise-application-v1'),payload:ApplicationPayloadSchema,domain:ApplicationDomainSchema,
 evidenceDigests:z.array(hex).min(1).max(128),dependencies:z.array(z.object({path:z.string().min(1).max(4096),sha256:hex}).strict()).min(1).max(128),
 proposedAt:instant,protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
export type ApplicationCandidate=z.infer<typeof CandidateBody>&{ref:CapabilityRef};
export const applicationCapabilityRef=(kind:string,body:unknown):CapabilityRef=>({owner:'S8',id:'application-'+kind+':'+digest(body),version:'s8-application-capability-v1',contentDigest:digest(body)});
export function parseApplicationCandidate(input:unknown):ApplicationCandidate{
 if(Buffer.byteLength(JSON.stringify(input))>262144)fault('S8_APPLICATION_CANDIDATE_BOUND');
 const candidate=z.object({ref:RefSchema}).passthrough().parse(input),{ref,...rest}=candidate,body=CandidateBody.parse(rest);
 if(digest(ref)!==digest(applicationCapabilityRef('candidate',body))||body.payload.applicationId!==body.domain.applicationId||
  Date.parse(body.domain.validUntil)<=Date.parse(body.domain.validAfter)||Date.parse(body.proposedAt)>Date.now()||
  new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length)fault('S8_APPLICATION_CANDIDATE_BINDING');
 return {...body,ref};
}
export function makeApplicationCandidate(body:z.infer<typeof CandidateBody>):ApplicationCandidate{
 const parsed=CandidateBody.parse(body);return parseApplicationCandidate({...parsed,ref:applicationCapabilityRef('candidate',parsed)});
}
export const ApplicationProtocolSchema=z.object({schema:z.literal('finnor.s8.application-evaluation-protocol.v1'),tenantId:text,principalId:text,
 revisionRef:RefSchema,evaluatorId:text,registeredAt:instant,payloadDigest:hex,domainDigest:hex,
 applicationCommitments:z.array(hex).min(1).max(20),lifecycleCommitments:z.array(hex).min(1).max(60),
 qualification:z.literal('PUBLIC_DEVELOPMENT_NOT_PROTECTED_X3_20_60')}).strict();
export const ApplicationEvaluationSchema=z.object({schema:z.literal('finnor.s8.application-evaluation.v1'),tenantId:text,principalId:text,
 revisionRef:RefSchema,protocolRef:RefSchema,evaluatorId:text,completedAt:instant,payloadDigest:hex,domainDigest:hex,
 applicationCommitments:z.array(hex).min(1).max(20),lifecycleCommitments:z.array(hex).min(1).max(60),resultsDigest:hex,
 completeApplicationPasses:z.number().int().min(0).max(20),completeLifecyclePasses:z.number().int().min(0).max(60),
 criticalViolations:z.number().int().min(0),authorityViolations:z.number().int().min(0),
 disposition:z.enum(['SUPPORTED_DEVELOPMENT','REFUSED','INCONCLUSIVE']),protectedAdmission:z.literal(false)}).strict();
const Admission=z.object({schema:z.literal('finnor.s8.application-admission.v1'),revisionRef:RefSchema,evaluationRef:RefSchema,payloadDigest:hex,domainDigest:hex,
 protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),executionAuthorityGranted:z.literal(false),protectedAdmission:z.literal(false)}).strict();
const Revocation=z.object({schema:z.literal('finnor.s8.application-revocation.v1'),revisionRef:RefSchema,expectedAdmissionRef:RefSchema,reason:text}).strict();
type Actor={id:string;principalId:string;roles:readonly string[]};
type Protocol=z.infer<typeof ApplicationProtocolSchema>;
type Evaluation=z.infer<typeof ApplicationEvaluationSchema>;
interface State{candidate:ApplicationCandidate;protocol:Signed<Protocol>|null;protocolRef:CapabilityRef|null;evaluation:Signed<Evaluation>|null;evaluationRef:CapabilityRef|null;admission:Signed<z.infer<typeof Admission>>|null;admissionRef:CapabilityRef|null;revoked:boolean}
interface Policy{domain:string;tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];sourcePins:{path:string;sha256:string}[];maxEntries:number}
export class ApplicationCapabilityPort{
 private states=new Map<string,State>();
 private consumed=new Set<string>();
 constructor(private policy:Policy){}
 replay(entry:JournalEntry){
  if(entry.operation==='APPLICATION_PROPOSE'){const candidate=parseApplicationCandidate(entry.body);this.states.set(candidate.ref.id,{candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false});return;}
  const body=entry.body?.body;if(!body)return;
  const state=this.state(body.revisionRef);
  if(entry.operation==='APPLICATION_REGISTER'){state.protocol=entry.body;state.protocolRef=entry.result.ref;for(const c of [...body.applicationCommitments,...body.lifecycleCommitments])this.consumed.add(c);}
  if(entry.operation==='APPLICATION_EVALUATE'){state.evaluation=entry.body;state.evaluationRef=entry.result.ref;}
  if(entry.operation==='APPLICATION_ADMIT'){state.admission=entry.body;state.admissionRef=entry.result.ref;}
  if(entry.operation==='APPLICATION_REVOKE')state.revoked=true;
 }
 private state(ref:CapabilityRef){const s=this.states.get(ref.id);if(!s||digest(s.candidate.ref)!==digest(ref))fault('S8_APPLICATION_NOT_FOUND',404);return s;}
 private scope(body:{tenantId:string;principalId:string;rightsRef?:string}){
  if(body.tenantId!==this.policy.tenantId||body.principalId!==this.policy.principalId||body.rightsRef!==undefined&&body.rightsRef!==this.policy.rightsRef)fault('S8_APPLICATION_SCOPE',403);
 }
 private sources(s:State){
  // CapabilityEvolution.command verifies current policy files once per request.
  if(digest(s.candidate.dependencies)!==digest(this.policy.sourcePins))fault('S8_APPLICATION_SOURCE_CLOSURE_SUBSTITUTION');
 }
 private current(s:State){
  this.scope(s.candidate);
  if(s.revoked||!s.admission||!s.evaluation||s.evaluation.body.disposition!=='SUPPORTED_DEVELOPMENT'||Date.parse(s.candidate.domain.validAfter)>Date.now()||Date.parse(s.candidate.domain.validUntil)<=Date.now())return false;
  assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);assertSignature(s.admission,this.policy.promotionKeys);
  return true;
 }
 async command(actor:Actor,operation:string,input:any,commit:(ref:CapabilityRef,body:unknown)=>Promise<unknown>){
  const role=operation==='APPLICATION_PROPOSE'?'PROPOSER':['APPLICATION_ADMIT','APPLICATION_REVOKE'].includes(operation)?'PROMOTER':
   ['APPLICATION_REGISTER','APPLICATION_EVALUATE'].includes(operation)?'EVALUATOR':null;
  if(role?!actor.roles.includes(role):!['APPLICATION_CURRENT','APPLICATION_CATALOGUE'].includes(operation)||!actor.roles.some(r=>r==='CONSUMER'||r==='READER'))fault('S8_OPERATION_NOT_AUTHORIZED',403);
  if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_PROTECTED_APPLICATION_DOMAIN_UNADMITTED',403);
  if(operation==='APPLICATION_CURRENT'){
   const body=z.object({revisionRef:RefSchema}).strict().parse(input),s=this.state(body.revisionRef);this.sources(s);
   const current=this.current(s);return {readOnly:true,result:{current,revisionRef:s.candidate.ref,candidate:current?s.candidate:null,admissionRef:current?s.admissionRef:null,protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,executionAuthorityGranted:false}};
  }
  if(operation==='APPLICATION_CATALOGUE'){
   const body=z.object({applicationId:text,root:ApplicationDomainSchema.shape.root,specificationDigest:hex}).strict().parse(input),reusable=[];
   for(const s of this.states.values())if(s.candidate.domain.applicationId===body.applicationId&&digest(s.candidate.domain.root)===digest(body.root)&&s.candidate.payload.specificationDigest===body.specificationDigest&&this.current(s)){
    this.sources(s);reusable.push({revisionRef:s.candidate.ref,admissionRef:s.admissionRef,payload:s.candidate.payload,domain:s.candidate.domain});
   }
   return {readOnly:true,result:{reusable,protectedAdmission:false,executionAuthorityGranted:false}};
  }
  let content:unknown,ref:CapabilityRef;
  if(operation==='APPLICATION_PROPOSE'){
   const candidate=parseApplicationCandidate(input);this.scope(candidate);
   if(actor.principalId!==candidate.principalId||this.states.has(candidate.ref.id))fault('S8_APPLICATION_PROPOSER_OR_DUPLICATE',403);
   if(Date.parse(candidate.domain.validAfter)<Date.parse(this.policy.validAfter)||Date.parse(candidate.domain.validUntil)>Date.parse(this.policy.validUntil))fault('S8_APPLICATION_EXCEEDS_POLICY');
   if(this.states.size>=this.policy.maxEntries)fault('S8_APPLICATION_ENTRY_BOUND');
   const s:State={candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false};this.sources(s);
   const {ref:ignored,...body}=candidate;content=body;ref=candidate.ref;
  }else{
   const signed=z.object({body:z.unknown(),keyId:text,signature:z.string().min(1).max(128)}).strict().parse(input);
   const schema=operation==='APPLICATION_REGISTER'?ApplicationProtocolSchema:operation==='APPLICATION_EVALUATE'?ApplicationEvaluationSchema:operation==='APPLICATION_ADMIT'?Admission:Revocation;
   const body=schema.parse(signed.body),s=this.state(body.revisionRef);this.sources(s);if(s.revoked)fault('S8_APPLICATION_REVOKED',403);
   const evaluator=operation==='APPLICATION_REGISTER'||operation==='APPLICATION_EVALUATE';
   const k=assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
   const fp=(v:string)=>byteDigest(createPublicKey(v).export({type:'spki',format:'der'}));
   if(evaluator&&this.policy.promotionKeys.some(p=>fp(p.publicKey)===fp(k.publicKey)))fault('S8_AUTHORITY_NOT_SEPARATED',403);
   if(operation==='APPLICATION_REGISTER'){
    const p=ApplicationProtocolSchema.parse(body);this.scope(p);
    const commitments=[...p.applicationCommitments,...p.lifecycleCommitments];
    if(s.protocol||p.evaluatorId!==actor.principalId||p.evaluatorId===s.candidate.principalId||p.payloadDigest!==digest(s.candidate.payload)||p.domainDigest!==digest(s.candidate.domain)||
     Date.parse(p.registeredAt)<Date.parse(s.candidate.proposedAt)||Date.parse(p.registeredAt)>Date.now()||new Set(commitments).size!==commitments.length||commitments.some(c=>this.consumed.has(c)))fault('S8_APPLICATION_PROTOCOL_BINDING');
   }else if(operation==='APPLICATION_EVALUATE'){
    const e=ApplicationEvaluationSchema.parse(body);this.scope(e);
    if(!s.protocol||!s.protocolRef||s.evaluation||e.evaluatorId!==actor.principalId||e.evaluatorId!==s.protocol.body.evaluatorId||digest(e.protocolRef)!==digest(s.protocolRef)||
     digest(e.applicationCommitments)!==digest(s.protocol.body.applicationCommitments)||digest(e.lifecycleCommitments)!==digest(s.protocol.body.lifecycleCommitments)||
     e.completeApplicationPasses>e.applicationCommitments.length||e.completeLifecyclePasses>e.lifecycleCommitments.length||
     e.payloadDigest!==digest(s.candidate.payload)||e.domainDigest!==digest(s.candidate.domain)||Date.parse(e.completedAt)<Date.parse(s.protocol.body.registeredAt)||Date.parse(e.completedAt)>Date.now())fault('S8_APPLICATION_EVALUATION_BINDING');
   }else if(operation==='APPLICATION_ADMIT'){
    const a=Admission.parse(body),e=s.evaluation?.body;
    if(s.evaluation)assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
    if(s.admission||!s.evaluationRef||!e||e.disposition!=='SUPPORTED_DEVELOPMENT'||e.criticalViolations!==0||e.authorityViolations!==0||
     e.completeApplicationPasses!==e.applicationCommitments.length||e.completeLifecyclePasses!==e.lifecycleCommitments.length||
     digest(a.evaluationRef)!==digest(s.evaluationRef)||a.payloadDigest!==digest(s.candidate.payload)||a.domainDigest!==digest(s.candidate.domain))fault('S8_APPLICATION_ADMISSION_BINDING');
   }else{
    const r=Revocation.parse(body);if(!s.admissionRef||digest(r.expectedAdmissionRef)!==digest(s.admissionRef))fault('S8_APPLICATION_REVOCATION_BINDING');
   }
   content={...signed,body};ref=applicationCapabilityRef(operation.replace('APPLICATION_','').toLowerCase(),content);
  }
  const receipt=await commit(ref,content);
  return {readOnly:false,result:{ref,receipt,protectedAdmission:false,executionAuthorityGranted:false,qualification:'DEVELOPMENT_APPLICATION_PORT_NOT_PROTECTED_X3_20_60_OR_PRODUCTION'}};
 }
}
