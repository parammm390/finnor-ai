/** Nonfinancial typed X5 sibling. A development admission never confers
 * protected custody, production activation, rewards or effect authority. */
import {z} from 'zod';
import {createPublicKey} from 'node:crypto';
import {assertSignature,byteDigest,digest,fault,RefSchema,type AuthorityKey,type CapabilityRef,type Signed} from './contracts';
import type {JournalEntry} from './journal';
const text=z.string().min(1).max(256),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
export const LearnedPolicyPayloadSchema=z.object({
 schema:z.literal('finnor.s8.learned-policy-payload.v1'),kind:z.literal('LearnedPolicyCapsule'),compilationId:z.string().uuid(),releaseId:z.string().uuid(),
 profile:z.literal('PE_FIRM_DELAYED_RECONCILIATION_V1'),policyDigest:hex,checkpointDigest:hex,originalCheckpointDigest:hex,
 controllerRevision:z.enum(['TRAINED','ORIGINAL_ABLATION']),
 experienceCutDigest:hex,rightsDigest:hex,partitionDigest:hex,trainingConfigurationDigest:hex,
 sourceDigest:hex,checkerDigest:hex,lockDigest:hex,schemaDigest:hex,runtimeDigest:hex,
 runtime:z.literal('FINNOR_NODE_22_STRUCTURAL_SOFTMAX_V1'),effects:z.literal('NO_LEARNED_EFFECT_AUTHORITY'),
}).strict();
const Domain=z.object({root:z.object({entityType:text,entityId:text}).strict(),validAfter:instant,validUntil:instant}).strict();
const Body=z.object({schema:z.literal('finnor.s8.learned-policy-candidate.v1'),tenantId:text,principalId:text,rightsRef:text,
 owningInterface:z.literal('x5-learned-policy-v1'),payload:LearnedPolicyPayloadSchema,domain:Domain,
 dependencies:z.array(z.object({path:z.string().min(1).max(4096),sha256:hex}).strict()).min(1).max(128),proposedAt:instant,
 protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
export type LearnedPolicyCandidate=z.infer<typeof Body>&{ref:CapabilityRef};
export const learnedPolicyRef=(kind:string,body:unknown):CapabilityRef=>({owner:'S8',id:'learned-policy-'+kind+':'+digest(body),version:'s8-learned-policy-v1',contentDigest:digest(body)});
export function parseLearnedPolicyCandidate(input:unknown):LearnedPolicyCandidate{
 if(Buffer.byteLength(JSON.stringify(input))>262144)fault('S8_LEARNED_POLICY_CANDIDATE_BOUND');
 const {ref,...rest}=z.object({ref:RefSchema}).passthrough().parse(input),body=Body.parse(rest);
 if(digest(ref)!==digest(learnedPolicyRef('candidate',body))||Date.parse(body.domain.validUntil)<=Date.parse(body.domain.validAfter)||
  Date.parse(body.proposedAt)>Date.now()||new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length)fault('S8_LEARNED_POLICY_CANDIDATE_BINDING');
 return {...body,ref};
}
export function makeLearnedPolicyCandidate(value:z.infer<typeof Body>){const body=Body.parse(value);return parseLearnedPolicyCandidate({...body,ref:learnedPolicyRef('candidate',body)});}
export const LearnedPolicyProtocolSchema=z.object({
 schema:z.literal('finnor.s8.learned-policy-protocol.v1'),revisionRef:RefSchema,evaluatorId:text,nativeEvaluationId:z.string().uuid(),
 assignmentDigest:hex,payloadDigest:hex,domainDigest:hex,registeredAt:instant,
 qualification:z.literal('PUBLIC_DEVELOPMENT_32_SCENARIOS_FOUR_ARMS_NOT_PROTECTED'),
}).strict();
export const LearnedPolicyEvaluationSchema=z.object({
 schema:z.literal('finnor.s8.learned-policy-evaluation.v1'),revisionRef:RefSchema,protocolRef:RefSchema,evaluatorId:text,nativeEvaluationId:z.string().uuid(),
 assignmentDigest:hex,payloadDigest:hex,domainDigest:hex,resultsDigest:hex,completedAt:instant,
 disposition:z.enum(['SUPPORTED_DEVELOPMENT','REFUSED_OR_INCOMPLETE']),protectedAdmission:z.literal(false),
}).strict();
const Admission=z.object({schema:z.literal('finnor.s8.learned-policy-admission.v1'),revisionRef:RefSchema,evaluationRef:RefSchema,
 payloadDigest:hex,domainDigest:hex,protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
const Revocation=z.object({schema:z.literal('finnor.s8.learned-policy-revocation.v1'),revisionRef:RefSchema,expectedAdmissionRef:RefSchema,reason:text}).strict();
type State={candidate:LearnedPolicyCandidate;protocol:Signed<z.infer<typeof LearnedPolicyProtocolSchema>>|null;protocolRef:CapabilityRef|null;
 evaluation:Signed<z.infer<typeof LearnedPolicyEvaluationSchema>>|null;evaluationRef:CapabilityRef|null;admission:Signed<z.infer<typeof Admission>>|null;admissionRef:CapabilityRef|null;revoked:boolean};
type Actor={id:string;principalId:string;roles:readonly string[]};
interface Policy{domain:string;tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];sourcePins:{path:string;sha256:string}[];maxEntries:number}
export class LearnedPolicyCapabilityPort{
 private states=new Map<string,State>();
 private assignments=new Set<string>();
 constructor(private policy:Policy){}
 replay(entry:JournalEntry){
  if(entry.operation==='LEARNED_POLICY_PROPOSE'){const candidate=parseLearnedPolicyCandidate(entry.body);this.states.set(candidate.ref.id,{candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false});return;}
  const body=entry.body?.body;if(!body)return;
  const s=this.state(body.revisionRef);
  if(entry.operation==='LEARNED_POLICY_REGISTER'){s.protocol=entry.body;s.protocolRef=entry.result.ref;this.assignments.add(body.assignmentDigest+':'+s.candidate.payload.checkpointDigest);}
  if(entry.operation==='LEARNED_POLICY_EVALUATE'){s.evaluation=entry.body;s.evaluationRef=entry.result.ref;}
  if(entry.operation==='LEARNED_POLICY_ADMIT'){s.admission=entry.body;s.admissionRef=entry.result.ref;}
  if(entry.operation==='LEARNED_POLICY_REVOKE')s.revoked=true;
 }
 private state(ref:CapabilityRef){const s=this.states.get(ref.id);if(!s||digest(s.candidate.ref)!==digest(ref))fault('S8_LEARNED_POLICY_NOT_FOUND',404);return s;}
 private sources(s:State){if(digest(s.candidate.dependencies)!==digest(this.policy.sourcePins))fault('S8_LEARNED_POLICY_SOURCE_SUBSTITUTION');}
 private async proof(s:State,evaluationId?:string){
  const {resolveLearnedPolicyNativeProof}=await import('../../private-equity/src/policy-learning/admission');
  return resolveLearnedPolicyNativeProof(s.candidate,evaluationId);
 }
 private domainCurrent(candidate:LearnedPolicyCandidate){
  const now=Date.now();
  return now>=Math.max(Date.parse(candidate.domain.validAfter),Date.parse(this.policy.validAfter))&&
   now<Math.min(Date.parse(candidate.domain.validUntil),Date.parse(this.policy.validUntil));
 }
 private currentAuthority(s:State){
  if(s.revoked||!s.admission||!s.evaluation||s.evaluation.body.disposition!=='SUPPORTED_DEVELOPMENT'||!this.domainCurrent(s.candidate))return null;
  const evaluator=assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
  const promoter=assertSignature(s.admission,this.policy.promotionKeys);
  return new Date(Math.min(Date.parse(s.candidate.domain.validUntil),Date.parse(this.policy.validUntil),Date.parse(evaluator.validUntil),Date.parse(promoter.validUntil))).toISOString();
 }
 private async current(s:State){
  const evaluation=s.evaluation;if(!evaluation||!this.currentAuthority(s))return null;
  const proof=await this.proof(s,evaluation.body.nativeEvaluationId);
  const until=this.currentAuthority(s);
  return proof.resultsDigest===evaluation.body.resultsDigest&&proof.disposition==='SUPPORTED_DEVELOPMENT'?until:null;
 }
 async command(actor:Actor,operation:string,input:any,commit:(ref:CapabilityRef,body:unknown)=>Promise<unknown>){
  const role=operation==='LEARNED_POLICY_PROPOSE'?'PROPOSER':['LEARNED_POLICY_ADMIT','LEARNED_POLICY_REVOKE'].includes(operation)?'PROMOTER':['LEARNED_POLICY_REGISTER','LEARNED_POLICY_EVALUATE'].includes(operation)?'EVALUATOR':null;
  if(role?!actor.roles.includes(role):operation!=='LEARNED_POLICY_CURRENT'||!actor.roles.some(r=>r==='CONSUMER'||r==='READER'))fault('S8_OPERATION_NOT_AUTHORIZED',403);
  if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_PROTECTED_LEARNED_POLICY_DOMAIN_UNADMITTED',403);
  if(operation==='LEARNED_POLICY_CURRENT'){
   const s=this.state(z.object({revisionRef:RefSchema}).strict().parse(input).revisionRef);this.sources(s);
   let currentUntil:string|null=null;try{currentUntil=await this.current(s);}catch{/* Invalidated native dependencies never return a reusable artifact. */}
   const current=!!currentUntil;
   return {readOnly:true,result:{current,currentUntil,revisionRef:s.candidate.ref,candidate:current?s.candidate:null,admissionRef:current?s.admissionRef:null,protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,executionAuthorityGranted:false}};
  }
  let ref:CapabilityRef,content:unknown;
  let finalAuthority=()=>{};
  if(operation==='LEARNED_POLICY_PROPOSE'){
   const candidate=parseLearnedPolicyCandidate(input);
   if(Date.now()<Date.parse(candidate.domain.validAfter)||Date.now()>=Date.parse(candidate.domain.validUntil))fault('S8_LEARNED_POLICY_DOMAIN_EXPIRED');
   if(candidate.tenantId!==this.policy.tenantId||candidate.principalId!==this.policy.principalId||candidate.rightsRef!==this.policy.rightsRef||actor.principalId!==candidate.principalId||this.states.has(candidate.ref.id))fault('S8_LEARNED_POLICY_SCOPE_OR_DUPLICATE',403);
   if(Date.parse(candidate.domain.validAfter)<Date.parse(this.policy.validAfter)||Date.parse(candidate.domain.validUntil)>Date.parse(this.policy.validUntil)||this.states.size>=this.policy.maxEntries)fault('S8_LEARNED_POLICY_DOMAIN_BOUND');
   const s:State={candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false};this.sources(s);await this.proof(s);
   finalAuthority=()=>{if(!this.domainCurrent(candidate))fault('S8_LEARNED_POLICY_DOMAIN_EXPIRED');};
   const {ref:_,...body}=candidate;ref=candidate.ref;content=body;
  }else{
   const signed=z.object({body:z.unknown(),keyId:text,signature:z.string().min(1).max(128)}).strict().parse(input);
   const schema=operation==='LEARNED_POLICY_REGISTER'?LearnedPolicyProtocolSchema:operation==='LEARNED_POLICY_EVALUATE'?LearnedPolicyEvaluationSchema:operation==='LEARNED_POLICY_ADMIT'?Admission:Revocation;
   const body=schema.parse(signed.body),s=this.state(body.revisionRef);this.sources(s);
   if(operation!=='LEARNED_POLICY_REVOKE'&&(Date.now()<Date.parse(s.candidate.domain.validAfter)||Date.now()>=Date.parse(s.candidate.domain.validUntil)))fault('S8_LEARNED_POLICY_DOMAIN_EXPIRED');
   if(s.revoked)fault('S8_LEARNED_POLICY_REVOKED',403);
   const evaluator=operation==='LEARNED_POLICY_REGISTER'||operation==='LEARNED_POLICY_EVALUATE',key=assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
   finalAuthority=()=>{
    if(operation!=='LEARNED_POLICY_REVOKE'&&!this.domainCurrent(s.candidate))fault('S8_LEARNED_POLICY_DOMAIN_EXPIRED');
    assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
    if(operation==='LEARNED_POLICY_ADMIT'&&s.evaluation)assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
   };
   const fp=(value:string)=>byteDigest(createPublicKey(value).export({type:'spki',format:'der'}));
   if(evaluator&&this.policy.promotionKeys.some(k=>fp(k.publicKey)===fp(key.publicKey)))fault('S8_AUTHORITY_NOT_SEPARATED',403);
   if(operation==='LEARNED_POLICY_REGISTER'){
    const p=LearnedPolicyProtocolSchema.parse(body),proof=await this.proof(s,p.nativeEvaluationId);
    if(s.protocol||p.evaluatorId!==actor.principalId||p.evaluatorId===s.candidate.principalId||p.evaluatorId!==proof.evaluatorId||p.assignmentDigest!==proof.assignmentDigest||this.assignments.has(p.assignmentDigest+':'+s.candidate.payload.checkpointDigest)||
     p.payloadDigest!==digest(s.candidate.payload)||p.domainDigest!==digest(s.candidate.domain)||Date.parse(p.registeredAt)<Date.parse(s.candidate.proposedAt)||Date.parse(p.registeredAt)>Date.now())fault('S8_LEARNED_POLICY_PROTOCOL_BINDING');
   }else if(operation==='LEARNED_POLICY_EVALUATE'){
    const e=LearnedPolicyEvaluationSchema.parse(body),proof=await this.proof(s,e.nativeEvaluationId);
    if(!s.protocol||!s.protocolRef||s.evaluation||e.evaluatorId!==actor.principalId||e.evaluatorId!==s.protocol.body.evaluatorId||e.nativeEvaluationId!==s.protocol.body.nativeEvaluationId||
     digest(e.protocolRef)!==digest(s.protocolRef)||e.assignmentDigest!==s.protocol.body.assignmentDigest||e.resultsDigest!==proof.resultsDigest||e.disposition!==proof.disposition||
     e.payloadDigest!==digest(s.candidate.payload)||e.domainDigest!==digest(s.candidate.domain)||Date.parse(e.completedAt)<Date.parse(s.protocol.body.registeredAt)||Date.parse(e.completedAt)>Date.now())fault('S8_LEARNED_POLICY_EVALUATION_BINDING');
   }else if(operation==='LEARNED_POLICY_ADMIT'){
    const a=Admission.parse(body);
    if(s.evaluation)assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
    const proof=await this.proof(s,s.evaluation?.body.nativeEvaluationId);
    if(s.admission||!s.evaluation||!s.evaluationRef||s.evaluation.body.disposition!=='SUPPORTED_DEVELOPMENT'||proof.disposition!=='SUPPORTED_DEVELOPMENT'||proof.resultsDigest!==s.evaluation.body.resultsDigest||
     digest(a.evaluationRef)!==digest(s.evaluationRef)||a.payloadDigest!==digest(s.candidate.payload)||a.domainDigest!==digest(s.candidate.domain))fault('S8_LEARNED_POLICY_ADMISSION_BINDING');
   }else{
    const r=Revocation.parse(body);if(!s.admissionRef||digest(r.expectedAdmissionRef)!==digest(s.admissionRef))fault('S8_LEARNED_POLICY_REVOCATION_BINDING');
   }
   content={...signed,body};ref=learnedPolicyRef(operation.replace('LEARNED_POLICY_','').toLowerCase(),content);
  }
  finalAuthority();
  const receipt=await commit(ref,content);return {readOnly:false,result:{ref,receipt,protectedAdmission:false,executionAuthorityGranted:false,qualification:'DEVELOPMENT_LEARNED_POLICY_NOT_PROTECTED_OR_PRODUCTION'}};
 }
}
