/** Narrow ordinary S8 payload. Never AllocationMethod, effect authority or production release. */
import {z} from 'zod';
import {createPublicKey} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {assertSignature,byteDigest,digest,fault,RefSchema,type AuthorityKey,type Signed,type CapabilityRef} from './contracts';
import {bounded,readModule,type GeneratedInterface} from '../../private-equity/src/interface-synthesis/contracts';
import type {JournalEntry} from './journal';
const text=z.string().min(1).max(256),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
export const InterfacePortRefSchema=RefSchema.extend({owner:z.literal('S8')}).strict();
export type InterfacePortRef=z.infer<typeof InterfacePortRefSchema>;
const ModuleSchema=z.object({format:z.enum(['BOUNDED_HTTP_IR','BOUNDED_UI_IR']),entrypoint:z.enum(['bind','interact']),bytes:z.string().min(1).max(8192),digest:hex}).strict();
export const InterfacePayloadSchema=z.object({schema:z.literal('finnor.s8.interface-payload.v1'),substrate:z.enum(['API','UI']),sourceDigest:hex,semanticDigest:hex,
 adapterModule:ModuleSchema,observerModule:ModuleSchema,interfaceVersion:text,recovery:z.literal('NO_MUTATION_REPLAY_AFTER_POSSIBLE_EGRESS'),runtime:z.literal('P5_DISPOSABLE_BOUNDED_IR_V1')}).strict();
export const InterfaceDomainSchema=z.object({account:text,entities:z.array(text).min(1).max(64),field:text,unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),nullable:z.boolean(),validAfter:instant,validUntil:instant}).strict();
const PinSchema=z.object({path:z.string().min(1).max(4096),sha256:hex}).strict();
export const InterfaceCandidateBodySchema=z.object({schema:z.literal('finnor.s8.interface-candidate.v1'),tenantId:text,principalId:text,rightsRef:text,
 owningInterface:z.literal('p5-disposable-interface-v1'),payload:InterfacePayloadSchema,domain:InterfaceDomainSchema,evidenceDigests:z.array(hex).min(1).max(64),dependencies:z.array(PinSchema).min(1).max(128),proposedAt:instant,
 executionAuthorityGranted:z.literal(false),protectedAdmission:z.literal(false)}).strict();
export type InterfaceCandidateBody=z.infer<typeof InterfaceCandidateBodySchema>;
export type InterfaceCandidate=InterfaceCandidateBody&{ref:InterfacePortRef};
export const interfaceRef=(kind:string,body:unknown):InterfacePortRef=>({owner:'S8',id:'interface-'+kind+':'+digest(body),version:'s8-interface-capability-v1',contentDigest:digest(body)});
export function makeInterfaceCandidate(input:{tenantId:string;principalId:string;rightsRef:string;generated:GeneratedInterface;domain:z.infer<typeof InterfaceDomainSchema>;evidenceDigests:string[];dependencies:Array<{path:string;sha256:string}>;proposedAt:string}):InterfaceCandidate{
 const {generated,...rest}=input;
 const payload=InterfacePayloadSchema.parse({schema:'finnor.s8.interface-payload.v1',substrate:generated.substrate,sourceDigest:generated.sourceDigest,semanticDigest:generated.semanticDigest,
  adapterModule:generated.adapterModule,observerModule:generated.observerModule,interfaceVersion:generated.interfaceVersion,
  recovery:'NO_MUTATION_REPLAY_AFTER_POSSIBLE_EGRESS',runtime:'P5_DISPOSABLE_BOUNDED_IR_V1'});
 const body=InterfaceCandidateBodySchema.parse({...rest,schema:'finnor.s8.interface-candidate.v1',owningInterface:'p5-disposable-interface-v1',payload,executionAuthorityGranted:false,protectedAdmission:false});
 return parseInterfaceCandidate({...body,ref:interfaceRef('candidate',body)});
}
export function parseInterfaceCandidate(input:unknown):InterfaceCandidate{
 bounded(input,262144);
 const candidate=z.object({ref:InterfacePortRefSchema}).passthrough().parse(input),{ref,...rest}=candidate,body=InterfaceCandidateBodySchema.parse(rest);
 if(digest(ref)!==digest(interfaceRef('candidate',body)))fault('S8_INTERFACE_CONTENT_IDENTITY');
 const adapter=readModule(body.payload.adapterModule),observer=readModule(body.payload.observerModule);
 if(observer.schema!=='finnor.p5.http-module.v1'||observer.kind!=='OBSERVER'||observer.field!==body.domain.field||observer.unit!==body.domain.unit||observer.currency!==body.domain.currency||observer.nullable!==body.domain.nullable||
  adapter.kind!=='ADAPTER'||adapter.field!==observer.field||adapter.unit!==observer.unit||adapter.currency!==observer.currency||adapter.decimalPlaces!==observer.decimalPlaces||
  body.payload.adapterModule.digest===body.payload.observerModule.digest||new Set(body.domain.entities).size!==body.domain.entities.length||
  !Number.isFinite(Date.parse(body.domain.validUntil))||Date.parse(body.domain.validUntil)<=Date.parse(body.domain.validAfter)||Date.parse(body.proposedAt)>Date.now()||
  new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length)fault('S8_INTERFACE_DOMAIN_OR_MODULE_INVALID');
 return {...body,ref};
}
export const InterfaceProtocolSchema=z.object({schema:z.literal('finnor.s8.interface-evaluation-protocol.v1'),tenantId:text,principalId:text,revisionRef:RefSchema,evaluatorId:text,
 registeredAt:instant,domainDigest:hex,payloadDigest:hex,caseCommitments:z.array(hex).min(1).max(4096),qualification:z.literal('PUBLIC_DEVELOPMENT_NOT_GATE_P5')}).strict();
export const InterfaceEvaluationSchema=z.object({schema:z.literal('finnor.s8.interface-evaluation.v1'),tenantId:text,principalId:text,revisionRef:RefSchema,protocolRef:RefSchema,evaluatorId:text,
 completedAt:instant,payloadDigest:hex,domainDigest:hex,caseCommitments:z.array(hex).min(1).max(4096),resultsDigest:hex,disposition:z.enum(['SUPPORTED_DISPOSABLE','REFUSED','INCONCLUSIVE']),
 falseVerifications:z.number().int().min(0),authorityViolations:z.number().int().min(0),protectedAdmission:z.literal(false)}).strict();
const AdmissionSchema=z.object({schema:z.literal('finnor.s8.interface-admission.v1'),revisionRef:RefSchema,evaluationRef:RefSchema,payloadDigest:hex,domainDigest:hex,
 protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),executionAuthorityGranted:z.literal(false)}).strict();
const RevocationSchema=z.object({schema:z.literal('finnor.s8.interface-revocation.v1'),revisionRef:RefSchema,reason:text,expectedAdmissionRef:RefSchema}).strict();
type Actor={id:string;principalId:string;roles:readonly string[]};
export interface InterfacePolicy {domain:string;tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;
 evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];sourcePins:Array<{path:string;sha256:string}>;maxEntries:number}
interface State {candidate:InterfaceCandidate;protocol:Signed<z.infer<typeof InterfaceProtocolSchema>>|null;protocolRef:CapabilityRef|null;
 evaluation:Signed<z.infer<typeof InterfaceEvaluationSchema>>|null;evaluationRef:CapabilityRef|null;admission:Signed<z.infer<typeof AdmissionSchema>>|null;admissionRef:CapabilityRef|null;revoked:boolean}
export class InterfaceCapabilityPort {
 private states=new Map<string,State>();
 private consumedCases=new Set<string>();
 constructor(private policy:InterfacePolicy){}
 replay(entry:JournalEntry){
  if(entry.operation==='INTERFACE_PROPOSE'){const candidate=parseInterfaceCandidate(entry.body);this.states.set(candidate.ref.id,{candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false});}
  if(entry.operation==='INTERFACE_REGISTER'){
   const state=this.state(entry.body.body.revisionRef);state.protocol=entry.body;state.protocolRef=entry.result.ref;
   for(const c of entry.body.body.caseCommitments)this.consumedCases.add(c);
  }
  if(entry.operation==='INTERFACE_EVALUATE'){const state=this.state(entry.body.body.revisionRef);state.evaluation=entry.body;state.evaluationRef=entry.result.ref;}
  if(entry.operation==='INTERFACE_ADMIT'){const state=this.state(entry.body.body.revisionRef);state.admission=entry.body;state.admissionRef=entry.result.ref;}
  if(entry.operation==='INTERFACE_REVOKE')this.state(entry.body.body.revisionRef).revoked=true;
 }
 private role(actor:Actor,role:string){if(!actor.roles.includes(role))fault('S8_OPERATION_NOT_AUTHORIZED',403);}
 private state(ref:CapabilityRef){const state=this.states.get(ref.id);if(!state||digest(state.candidate.ref)!==digest(ref))fault('S8_INTERFACE_NOT_FOUND',404);return state;}
 private scope(body:{tenantId:string;principalId:string;rightsRef?:string}){
  if(body.tenantId!==this.policy.tenantId||body.principalId!==this.policy.principalId||body.rightsRef!==undefined&&body.rightsRef!==this.policy.rightsRef)fault('S8_TENANT_OR_OWNER_MISMATCH',403);
 }
 private async dependencies(state:State){
  if(digest(state.candidate.dependencies)!==digest(this.policy.sourcePins))fault('S8_INTERFACE_SOURCE_CLOSURE_SUBSTITUTION');
  for(const pin of state.candidate.dependencies)if(byteDigest(await readFile(pin.path))!==pin.sha256)fault('S8_INTERFACE_SOURCE_CHANGED');
 }
 private current(state:State){
  this.scope(state.candidate);
  if(state.revoked||!state.admission||!state.evaluation||state.evaluation.body.disposition!=='SUPPORTED_DISPOSABLE'||
   Date.parse(state.candidate.domain.validAfter)>Date.now()||Date.parse(state.candidate.domain.validUntil)<=Date.now())return false;
  assertSignature(state.evaluation,this.policy.evaluatorKeys,state.evaluation.body.evaluatorId);
  assertSignature(state.admission,this.policy.promotionKeys);
  return true;
 }
 async command(actor:Actor,operation:string,body:any,commit:(ref:CapabilityRef,content:unknown)=>Promise<unknown>):Promise<{readOnly:boolean;result:any}>{
  if(operation==='INTERFACE_PROPOSE'||operation==='INTERFACE_REGISTER'||operation==='INTERFACE_EVALUATE'||operation==='INTERFACE_ADMIT'||operation==='INTERFACE_REVOKE'){
   const role=operation==='INTERFACE_PROPOSE'?'PROPOSER':operation==='INTERFACE_ADMIT'||operation==='INTERFACE_REVOKE'?'PROMOTER':'EVALUATOR';
   this.role(actor,role);
  }else if(operation==='INTERFACE_CURRENT'||operation==='INTERFACE_CATALOGUE'){
   if(!actor.roles.includes('CONSUMER')&&!actor.roles.includes('READER'))fault('S8_OPERATION_NOT_AUTHORIZED',403);
  }else fault('S8_OPERATION_UNSUPPORTED',404);
  if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_PROTECTED_INTERFACE_DOMAIN_UNADMITTED',403);
  let content:unknown,ref:CapabilityRef;
  if(operation==='INTERFACE_PROPOSE'){
   const candidate=parseInterfaceCandidate(body);this.scope(candidate);
   if(actor.principalId!==candidate.principalId)fault('S8_INTERFACE_PROPOSER_IDENTITY',403);
   if(this.states.has(candidate.ref.id))fault('S8_INTERFACE_ALREADY_PROPOSED');
   if(Date.parse(candidate.domain.validAfter)<Date.parse(this.policy.validAfter)||Date.parse(candidate.domain.validUntil)>Date.parse(this.policy.validUntil))fault('S8_INTERFACE_EXCEEDS_POLICY');
   const state:State={candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false};
   await this.dependencies(state);const {ref:ignored,...preimage}=candidate;content=preimage;ref=candidate.ref;
  }else if(operation==='INTERFACE_CURRENT'){
   const input=z.object({revisionRef:RefSchema}).strict().parse(body),state=this.state(input.revisionRef);await this.dependencies(state);
   const current=this.current(state);
   return {readOnly:true,result:{current,revisionRef:state.candidate.ref,candidate:current?state.candidate:null,admissionRef:current?state.admissionRef:null,
    protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedExecution:false,executionAuthorityGranted:false,qualification:'PUBLIC_DEVELOPMENT_NOT_GATE_P5'}};
  }else if(operation==='INTERFACE_CATALOGUE'){
   const input=z.object({account:text,field:text,unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),sourceDigest:hex,semanticDigest:hex}).strict().parse(body),reusable=[];
   for(const state of this.states.values()){
    if(!this.current(state))continue;const c=state.candidate;
    if(c.domain.account!==input.account||c.domain.field!==input.field||c.domain.unit!==input.unit||c.domain.currency!==input.currency||c.payload.sourceDigest!==input.sourceDigest||c.payload.semanticDigest!==input.semanticDigest)continue;
    await this.dependencies(state);reusable.push({revisionRef:c.ref,admissionRef:state.admissionRef,domain:c.domain,payload:c.payload});
   }
   return {readOnly:true,result:{reusable,protectedExecution:false}};
  }else{
   const schema=operation==='INTERFACE_REGISTER'?InterfaceProtocolSchema:operation==='INTERFACE_EVALUATE'?InterfaceEvaluationSchema:operation==='INTERFACE_ADMIT'?AdmissionSchema:RevocationSchema;
   const signed=z.object({body:z.unknown(),keyId:text,signature:z.string().min(1).max(128)}).strict().parse(body);
   const parsed=schema.parse(signed.body),state=this.state(parsed.revisionRef),candidate=state.candidate;
   const key=assertSignature({...signed,body:parsed},operation==='INTERFACE_REGISTER'||operation==='INTERFACE_EVALUATE'?this.policy.evaluatorKeys:this.policy.promotionKeys,actor.principalId);
   const promoterKeys=this.policy.promotionKeys.map(k=>byteDigest(createPublicKey(k.publicKey).export({type:'spki',format:'der'})));
   if((operation==='INTERFACE_REGISTER'||operation==='INTERFACE_EVALUATE')&&promoterKeys.includes(byteDigest(createPublicKey(key.publicKey).export({type:'spki',format:'der'}))))fault('S8_AUTHORITY_NOT_SEPARATED',403);
   await this.dependencies(state);
   if(state.revoked)fault('S8_INTERFACE_REVOKED',403);
   if(operation==='INTERFACE_REGISTER'){
    const p=InterfaceProtocolSchema.parse(parsed);this.scope(p);
    if(state.protocol||p.evaluatorId!==actor.principalId||p.evaluatorId===candidate.principalId||p.domainDigest!==digest(candidate.domain)||p.payloadDigest!==digest(candidate.payload)||
     Date.parse(p.registeredAt)<Date.parse(candidate.proposedAt)||Date.parse(p.registeredAt)>Date.now()||
     new Set(p.caseCommitments).size!==p.caseCommitments.length||p.caseCommitments.some(c=>this.consumedCases.has(c)))fault('S8_INTERFACE_EVALUATION_PROTOCOL_INVALID');
   }else if(operation==='INTERFACE_EVALUATE'){
    const e=InterfaceEvaluationSchema.parse(parsed);this.scope(e);
    if(!state.protocol||!state.protocolRef||state.evaluation||e.evaluatorId!==actor.principalId||e.evaluatorId!==state.protocol.body.evaluatorId||
     digest(e.protocolRef)!==digest(state.protocolRef)||digest(e.caseCommitments)!==digest(state.protocol.body.caseCommitments)||e.payloadDigest!==digest(candidate.payload)||e.domainDigest!==digest(candidate.domain)||
     Date.parse(e.completedAt)<Date.parse(state.protocol.body.registeredAt)||Date.parse(e.completedAt)>Date.now())fault('S8_INTERFACE_EVALUATION_BINDING_INVALID');
   }else if(operation==='INTERFACE_ADMIT'){
    const a=AdmissionSchema.parse(parsed);
    if(state.admission||!state.evaluation||!state.evaluationRef||state.evaluation.body.disposition!=='SUPPORTED_DISPOSABLE'||
     state.evaluation.body.falseVerifications!==0||state.evaluation.body.authorityViolations!==0||digest(a.evaluationRef)!==digest(state.evaluationRef)||
     a.payloadDigest!==digest(candidate.payload)||a.domainDigest!==digest(candidate.domain))fault('S8_INTERFACE_ADMISSION_BINDING_INVALID');
    assertSignature(state.evaluation,this.policy.evaluatorKeys,state.evaluation.body.evaluatorId);
   }else{
    const r=RevocationSchema.parse(parsed);if(!state.admissionRef||digest(r.expectedAdmissionRef)!==digest(state.admissionRef))fault('S8_INTERFACE_REVOCATION_BINDING_INVALID');
   }
   content={...signed,body:parsed};ref=interfaceRef(operation.replace('INTERFACE_','').toLowerCase(),content);
  }
  const receipt=await commit(ref,content);
  return {readOnly:false,result:{ref,receipt,protectedExecution:false,executionAuthorityGranted:false,qualification:'DISPOSABLE_INTERFACE_PORT_NOT_GATE_P5_OR_PRODUCTION_TRUST'}};
 }
}
