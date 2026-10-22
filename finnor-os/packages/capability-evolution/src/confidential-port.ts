/** Commitment-only Y4 sibling. Development construction review is not protected qualification. */
import {z} from 'zod';
import {assertSignature,digest,fault,RefSchema,type CapabilityRef,type AuthorityKey,type Signed} from './contracts';
import type {JournalEntry} from './journal';
import {assertConfidentialSourceClosure} from './source-closure';
const text=z.string().min(1).max(512),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
const Payload=z.object({kind:z.literal('ConfidentialEconomicComputation'),computationId:z.string().uuid(),releaseId:z.string().uuid(),
 functionDigest:hex,protocolDigest:hex,profileDigest:hex,runtimeDigest:hex,correspondenceDigest:hex,
 artifactDigest:hex,outputCommitment:hex,effects:z.literal('NO_COMPUTATION_EFFECT_AUTHORITY')}).strict();
const Body=z.object({schema:z.literal('finnor.s8.confidential-candidate.v1'),tenantId:text,principalId:text,rightsRef:hex,
 owningInterface:z.literal('postx-y4-confidential-computation-v1'),payload:Payload,
 domain:z.object({root:z.object({entityType:text,entityId:text}).strict(),workId:z.string().uuid(),
  validAfter:instant,validUntil:instant}).strict(),
 dependencies:z.array(z.object({path:text,sha256:hex}).strict()).min(1).max(256),proposedAt:instant,
 protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
export type ConfidentialCandidate=z.infer<typeof Body>&{ref:CapabilityRef};
export const confidentialCapabilityRef=(kind:string,value:unknown):CapabilityRef=>({
 owner:'S8',id:'confidential-'+kind+':'+digest(value),version:'s8-confidential-v1',contentDigest:digest(value)});
export const confidentialCommitResult=(ref:CapabilityRef,receipt:unknown)=>({
 ref,receipt,protectedAdmission:false,executionAuthorityGranted:false,
 qualification:'NATIVE_CHECKED_CONSTRUCTION_DEVELOPMENT_NOT_PROTECTED_OR_ECONOMIC_QUALIFICATION',
});
export function parseConfidentialCandidate(value:unknown):ConfidentialCandidate{
 if(Buffer.byteLength(JSON.stringify(value))>262144)fault('S8_CONFIDENTIAL_BOUND');
 const {ref,...raw}=z.object({ref:RefSchema}).passthrough().parse(value),body=Body.parse(raw);
 if(digest(ref)!==digest(confidentialCapabilityRef('candidate',body))
  ||Date.parse(body.domain.validUntil)<=Date.parse(body.domain.validAfter)||Date.parse(body.proposedAt)>Date.now()
  ||new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length)fault('S8_CONFIDENTIAL_BINDING');
 return {...body,ref};
}
export function makeConfidentialCandidate(body:z.infer<typeof Body>){
 return parseConfidentialCandidate({...Body.parse(body),ref:confidentialCapabilityRef('candidate',body)});
}
const Review=z.object({schema:z.literal('finnor.s8.confidential-review.v1'),revisionRef:RefSchema,evaluatorId:text,
 evidenceDigest:hex,payloadDigest:hex,domainDigest:hex,registeredAt:instant,
 qualification:z.literal('POSTHOC_NATIVE_CONSTRUCTION_REVIEW_NOT_PROTECTED_CAMPAIGN')}).strict();
const Evaluation=z.object({schema:z.literal('finnor.s8.confidential-evaluation.v1'),revisionRef:RefSchema,protocolRef:RefSchema,
 evaluatorId:text,evidenceDigest:hex,payloadDigest:hex,domainDigest:hex,completedAt:instant,
 disposition:z.literal('CHECKED_CONSTRUCTION_ONLY'),protectedAdmission:z.literal(false)}).strict();
const Admission=z.object({schema:z.literal('finnor.s8.confidential-admission.v1'),revisionRef:RefSchema,evaluationRef:RefSchema,
 evidenceDigest:hex,payloadDigest:hex,domainDigest:hex,protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 scope:z.literal('RECIPIENT_LOCAL_ANALYTICAL_CONSTRUCTION_ONLY'),protectedAdmission:z.literal(false),
 executionAuthorityGranted:z.literal(false)}).strict();
const Revoke=z.object({schema:z.literal('finnor.s8.confidential-revocation.v1'),revisionRef:RefSchema,
 expectedAdmissionRef:RefSchema,reason:text}).strict();
type State={candidate:ConfidentialCandidate;review:Signed<z.infer<typeof Review>>|null;reviewRef:CapabilityRef|null;
 evaluation:Signed<z.infer<typeof Evaluation>>|null;evaluationRef:CapabilityRef|null;
 admission:Signed<z.infer<typeof Admission>>|null;admissionRef:CapabilityRef|null;revoked:boolean};
type Actor={id:string;principalId:string;roles:readonly string[]};
interface Policy{domain:string;tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;
 evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];sourcePins:Array<{path:string;sha256:string}>;maxEntries:number}
export class ConfidentialCapabilityPort{
 private states=new Map<string,State>();
 constructor(private policy:Policy){}
 replay(e:JournalEntry){
  if(e.operation==='CONFIDENTIAL_COMMIT_INTENT')return;
  if(e.operation==='CONFIDENTIAL_PROPOSE'){const c=parseConfidentialCandidate(e.body);
   this.states.set(c.ref.id,{candidate:c,review:null,reviewRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false});return;}
  const b=e.body?.body;if(!b)return;const s=this.state(b.revisionRef);
  if(e.operation==='CONFIDENTIAL_REGISTER'){s.review=e.body;s.reviewRef=e.result.ref;}
  if(e.operation==='CONFIDENTIAL_EVALUATE'){s.evaluation=e.body;s.evaluationRef=e.result.ref;}
  if(e.operation==='CONFIDENTIAL_ADMIT'){s.admission=e.body;s.admissionRef=e.result.ref;}
  if(e.operation==='CONFIDENTIAL_REVOKE')s.revoked=true;
 }
 private state(ref:CapabilityRef){const s=this.states.get(ref.id);
  if(!s||digest(s.candidate.ref)!==digest(ref))fault('S8_CONFIDENTIAL_NOT_FOUND',404);return s;}
 private current(s:State){const now=Date.now();return !s.revoked&&now>=Math.max(Date.parse(s.candidate.domain.validAfter),Date.parse(this.policy.validAfter))
  &&now<Math.min(Date.parse(s.candidate.domain.validUntil),Date.parse(this.policy.validUntil));}
 private async proof(s:State){
  if(digest(s.candidate.dependencies)!==digest(this.policy.sourcePins))fault('S8_CONFIDENTIAL_SOURCE_SUBSTITUTION');
  return (await import('../../private-equity/src/confidential-computation/admission')).resolveConfidentialNativeProof(s.candidate);
 }
 private authorize(actor:Actor,operation:string){
  const role=operation==='CONFIDENTIAL_PROPOSE'?'PROPOSER':
   ['CONFIDENTIAL_REGISTER','CONFIDENTIAL_EVALUATE'].includes(operation)?'EVALUATOR':
   ['CONFIDENTIAL_ADMIT','CONFIDENTIAL_REVOKE'].includes(operation)?'PROMOTER':null;
  if(role?!actor.roles.includes(role):operation!=='CONFIDENTIAL_CURRENT'||!actor.roles.some(r=>r==='CONSUMER'||r==='READER'))
   fault('S8_OPERATION_NOT_AUTHORIZED',403);
  if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_PROTECTED_CONFIDENTIAL_QUALIFICATION_REQUIRED',403);
 }
 async revalidateReplay(actor:Actor,operation:string,input:any){
  this.authorize(actor,operation);await assertConfidentialSourceClosure(this.policy.sourcePins);
  const s=this.state(operation==='CONFIDENTIAL_PROPOSE'?parseConfidentialCandidate(input).ref:input.body.revisionRef);
  if(operation==='CONFIDENTIAL_PROPOSE'){
   if(actor.principalId!==s.candidate.principalId)fault('S8_CONFIDENTIAL_SCOPE_OR_DOMAIN',403);
  }else{
   assertSignature(input,['CONFIDENTIAL_REGISTER','CONFIDENTIAL_EVALUATE'].includes(operation)?
    this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
  }
  if(operation!=='CONFIDENTIAL_REVOKE'){
   if(!this.current(s))fault('S8_CONFIDENTIAL_REVOKED_OR_EXPIRED');
   await this.proof(s);
  }
 }
 async command(actor:Actor,operation:string,input:any,commit:(ref:CapabilityRef,body:unknown)=>Promise<unknown>){
  this.authorize(actor,operation);
  await assertConfidentialSourceClosure(this.policy.sourcePins);
  if(operation==='CONFIDENTIAL_CURRENT'){
   const s=this.state(z.object({revisionRef:RefSchema}).strict().parse(input).revisionRef);
   let until:string|null=null;
   try{if(this.current(s)&&s.review&&s.evaluation&&s.admission){
    const e=assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId),
     p=assertSignature(s.admission,this.policy.promotionKeys),r=assertSignature(s.review,this.policy.evaluatorKeys,s.review.body.evaluatorId);
    const proof=await this.proof(s);
    assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
    assertSignature(s.admission,this.policy.promotionKeys);
    assertSignature(s.review,this.policy.evaluatorKeys,s.review.body.evaluatorId);
    if(this.current(s)&&proof.evidenceDigest===s.evaluation.body.evidenceDigest&&proof.evidenceDigest===s.admission.body.evidenceDigest)
     until=new Date(Math.min(Date.parse(s.candidate.domain.validUntil),Date.parse(this.policy.validUntil),
      Date.parse(e.validUntil),Date.parse(p.validUntil),Date.parse(r.validUntil))).toISOString();
   }}catch{/* No cached authority after native invalidation. */}
   return {readOnly:true,result:{current:!!until,currentUntil:until,revisionRef:s.candidate.ref,
    candidate:until?s.candidate:null,admissionRef:until?s.admissionRef:null,
    protectionDomain:'DISPOSABLE_TEST_AUTHORITY',scope:'RECIPIENT_LOCAL_ANALYTICAL_CONSTRUCTION_ONLY',
    protectedAdmission:false,executionAuthorityGranted:false}};
  }
  let ref:CapabilityRef,content:unknown,finalAuthority:()=>void=()=>{};
  if(operation==='CONFIDENTIAL_PROPOSE'){
   const c=parseConfidentialCandidate(input),s:State={candidate:c,review:null,reviewRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false};
   if(!this.current(s)||c.tenantId!==this.policy.tenantId||c.principalId!==this.policy.principalId
    ||c.principalId!==actor.principalId||c.rightsRef!==this.policy.rightsRef||this.states.has(c.ref.id)
    ||Date.parse(c.domain.validAfter)<Date.parse(this.policy.validAfter)||Date.parse(c.domain.validUntil)>Date.parse(this.policy.validUntil)
    ||this.states.size>=this.policy.maxEntries)fault('S8_CONFIDENTIAL_SCOPE_OR_DOMAIN',403);
   await this.proof(s);
   finalAuthority=()=>{if(!this.current(s))fault('S8_CONFIDENTIAL_REVOKED_OR_EXPIRED');};
   ref=c.ref;const {ref:_,...body}=c;content=body;
  }else{
   const signed=z.object({body:z.unknown(),keyId:text,signature:z.string().min(1).max(128)}).strict().parse(input);
   const schema=operation==='CONFIDENTIAL_REGISTER'?Review:operation==='CONFIDENTIAL_EVALUATE'?Evaluation:operation==='CONFIDENTIAL_ADMIT'?Admission:Revoke;
   const body=schema.parse(signed.body),s=this.state(body.revisionRef),
    evaluator=operation==='CONFIDENTIAL_REGISTER'||operation==='CONFIDENTIAL_EVALUATE';
   assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
   if(s.revoked||operation!=='CONFIDENTIAL_REVOKE'&&!this.current(s))fault('S8_CONFIDENTIAL_REVOKED_OR_EXPIRED');
   if(evaluator&&actor.principalId===s.candidate.principalId)fault('S8_SELF_ADMISSION_ROLE',403);
   if(operation==='CONFIDENTIAL_REVOKE'){
    if(!s.admissionRef||digest(Revoke.parse(body).expectedAdmissionRef)!==digest(s.admissionRef))fault('S8_CONFIDENTIAL_REVOCATION_BINDING');
   }else{
    const proof=await this.proof(s),b=body as z.infer<typeof Review>|z.infer<typeof Evaluation>|z.infer<typeof Admission>;
    if(b.evidenceDigest!==proof.evidenceDigest||b.payloadDigest!==digest(s.candidate.payload)||b.domainDigest!==digest(s.candidate.domain))
     fault('S8_CONFIDENTIAL_NATIVE_EVIDENCE_BINDING');
    if(operation==='CONFIDENTIAL_REGISTER'){
     const r=Review.parse(body);
     if(s.review||r.evaluatorId!==actor.principalId||Date.parse(r.registeredAt)<Date.parse(s.candidate.proposedAt)
      ||Date.parse(r.registeredAt)>Date.now())fault('S8_CONFIDENTIAL_REVIEW_BINDING');
    }else if(operation==='CONFIDENTIAL_EVALUATE'){
     const e=Evaluation.parse(body);
     if(!s.review||!s.reviewRef||s.evaluation||e.evaluatorId!==s.review.body.evaluatorId
      ||e.evaluatorId!==actor.principalId||digest(e.protocolRef)!==digest(s.reviewRef)
      ||Date.parse(e.completedAt)<Date.parse(s.review.body.registeredAt)||Date.parse(e.completedAt)>Date.now())
      fault('S8_CONFIDENTIAL_EVALUATION_BINDING');
     assertSignature(s.review,this.policy.evaluatorKeys,e.evaluatorId);
    }else{
     const a=Admission.parse(body);
     if(!s.evaluation||!s.evaluationRef||s.admission||digest(a.evaluationRef)!==digest(s.evaluationRef))
      fault('S8_CONFIDENTIAL_ADMISSION_BINDING');
     assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
    }
   }
   content={...signed,body};ref=confidentialCapabilityRef(operation.slice(13).toLowerCase(),content);
   finalAuthority=()=>{
    if(s.revoked||operation!=='CONFIDENTIAL_REVOKE'&&!this.current(s))fault('S8_CONFIDENTIAL_REVOKED_OR_EXPIRED');
    assertSignature({...signed,body},evaluator?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
    if(operation==='CONFIDENTIAL_EVALUATE')assertSignature(s.review!,this.policy.evaluatorKeys,s.review!.body.evaluatorId);
    if(operation==='CONFIDENTIAL_ADMIT')assertSignature(s.evaluation!,this.policy.evaluatorKeys,s.evaluation!.body.evaluatorId);
   };
  }
  finalAuthority();
  const receipt=await commit(ref,content);
  // The lifecycle durably records an accepted commitment before its final
  // current-use check. Expiry must not orphan an already accepted ledger ref.
  return {readOnly:false,result:confidentialCommitResult(ref,receipt)};
 }
}
