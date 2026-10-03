/** Ordinary owner transport. Pinned commitments authenticate bytes, not effect authority or truth. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { canonical, LedgerFault,referencePreimageDigest } from './protocol.js';

export interface OwnerTransportScope { semanticOwner:string; tenantId:string; principalId:string }
export interface OwnerOriginKey { id:string; publicKey:string; validAfter:string; validUntil:string; revoked:boolean }
interface ReceiptPin { signerPublicKey:string; releaseId:string; verifierDigest:string; policyDigest:string }
export interface OwnerTransportRoute extends OwnerTransportScope {
 rightsRefs:string[]; originKeys:OwnerOriginKey[]; originSigner?:{keyId:string;path:string};
 tokenPath:string; tokenSha256:string; ledger:{endpoint:string;acceptedReceipts:ReceiptPin[]};
 requestTimeoutMs:number; leaseMs:number;
}
export interface OwnerDeliveryEnvelope extends OwnerTransportScope {
 schema:'finnor.s6.owner-delivery.v1'; kind:'REFERENCE'|'EVENT'; identity:string;
 payload:Record<string,any>; signedAt:string; originKeyId:string;
}
function fail(code:string):never {throw new LedgerFault(503,code);}
const object=(v:any):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v:fail('OWNER_TRANSPORT_OBJECT_INVALID');
const text=(v:any,max=4096):string=>typeof v==='string'&&v.length>0&&v.length<=max?v:fail('OWNER_TRANSPORT_TEXT_INVALID');
const hex=(v:any):string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:fail('OWNER_TRANSPORT_DIGEST_INVALID');
const list=(v:any,max=256):any[]=>Array.isArray(v)&&v.length>0&&v.length<=max?v:fail('OWNER_TRANSPORT_LIST_INVALID');
const keys=(v:Record<string,any>,required:string[],optional:string[]=[])=>{if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))fail('OWNER_TRANSPORT_FIELD_SET_INVALID');};
const time=(v:any):number=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):fail('OWNER_TRANSPORT_TIME_INVALID');
export const ownerTransportHash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const bytesHash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const same=(a:unknown,b:unknown)=>ownerTransportHash(a)===ownerTransportHash(b);
function bounded(v:unknown){if(Buffer.byteLength(canonical(v))>8*1024*1024)fail('OWNER_TRANSPORT_BYTE_BOUND');}
function publicKey(v:any){const key=createPublicKey(text(v,8192));if(key.asymmetricKeyType!=='ed25519')fail('OWNER_TRANSPORT_KEY_TYPE_INVALID');return key;}
function signature(v:any){const encoded=text(v,256),bytes=Buffer.from(encoded,'base64');if(bytes.length!==64||bytes.toString('base64')!==encoded)fail('OWNER_TRANSPORT_SIGNATURE_ENCODING_INVALID');return bytes;}
function scope(v:any){object(v);text(v.semanticOwner,128);if(![v.tenantId,v.principalId].every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)))fail('OWNER_TRANSPORT_SCOPE_INVALID');}
const sameScope=(a:OwnerTransportScope,b:OwnerTransportScope)=>a.semanticOwner===b.semanticOwner&&a.tenantId===b.tenantId&&a.principalId===b.principalId;

/** Keep validation and read on the same no-follow descriptor; never expose secret bytes. */
async function privateFile(path:string):Promise<Buffer>{
 const fd=await open(text(path),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await fd.stat();if(!st.isFile()||st.size>8*1024*1024||(st.mode&0o077)!==0||st.uid!==process.getuid?.())fail('OWNER_TRANSPORT_PRIVATE_FILE_UNSAFE');return await fd.readFile();}
 finally{await fd.close();}
}

export async function ownerTransportRoute(identity:OwnerTransportScope):Promise<OwnerTransportRoute|null>{
 scope(identity);const path=process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG;if(!path)return null;
 const root=process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT;if(!root)fail('OWNER_TRANSPORT_ROOT_UNAVAILABLE');
 const config=object(JSON.parse((await privateFile(path)).toString()));keys(config,['policy','signature']);
 const policy=object(config.policy);bounded(policy);
 if(!verify(null,Buffer.from(canonical(policy)),publicKey(root),signature(config.signature)))fail('OWNER_TRANSPORT_CONFIGURATION_SIGNATURE_INVALID');
 keys(policy,['schema','domain','validAfter','validUntil','routes']);
 if(policy.schema!=='finnor.s6.owner-transport-policy.v1'||!['DISPOSABLE_TEST_AUTHORITY','REVIEWED_PROTECTED_DOMAIN'].includes(policy.domain))fail('OWNER_TRANSPORT_POLICY_UNSUPPORTED');
 const now=Date.now(),after=time(policy.validAfter),until=time(policy.validUntil);
 if(after>now||until<=now||until<=after)fail('OWNER_TRANSPORT_CONFIGURATION_EXPIRED');
 const routes=list(policy.routes),seen=new Set<string>();
 for(const value of routes){
  const route=object(value);keys(route,['semanticOwner','tenantId','principalId','rightsRefs','originKeys','tokenPath','tokenSha256','ledger','requestTimeoutMs','leaseMs'],['originSigner']);scope(route);
  const key=canonical([route.semanticOwner,route.tenantId,route.principalId]);if(seen.has(key))fail('OWNER_TRANSPORT_AMBIGUOUS_IDENTITY');seen.add(key);
  const rights=list(route.rightsRefs);rights.forEach(r=>text(r));if(new Set(rights).size!==rights.length)fail('OWNER_TRANSPORT_RIGHTS_AMBIGUOUS');
  const issuers=list(route.originKeys,8),issuerIds=new Set<string>();
  for(const raw of issuers){const issuer=object(raw);keys(issuer,['id','publicKey','validAfter','validUntil','revoked']);text(issuer.id,256);publicKey(issuer.publicKey);if(issuerIds.has(issuer.id)||typeof issuer.revoked!=='boolean'||time(issuer.validUntil)<=time(issuer.validAfter))fail('OWNER_TRANSPORT_ORIGIN_KEY_INVALID');issuerIds.add(issuer.id);}
  if(route.originSigner){keys(object(route.originSigner),['keyId','path']);text(route.originSigner.path);if(!issuerIds.has(route.originSigner.keyId))fail('OWNER_TRANSPORT_SIGNER_UNBOUND');}
  text(route.tokenPath);hex(route.tokenSha256);keys(object(route.ledger),['endpoint','acceptedReceipts']);
  const url=new URL(text(route.ledger.endpoint));
  if(url.origin!==route.ledger.endpoint||url.username||url.password||!(url.protocol==='https:'||policy.domain==='DISPOSABLE_TEST_AUTHORITY'&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))fail('OWNER_TRANSPORT_ENDPOINT_UNSUPPORTED');
  for(const raw of list(route.ledger.acceptedReceipts,8)){const pin=object(raw);keys(pin,['signerPublicKey','releaseId','verifierDigest','policyDigest']);publicKey(pin.signerPublicKey);text(pin.releaseId);hex(pin.verifierDigest);hex(pin.policyDigest);}
  if(!Number.isInteger(route.requestTimeoutMs)||route.requestTimeoutMs<1000||route.requestTimeoutMs>10000||!Number.isInteger(route.leaseMs)||route.leaseMs<3000||route.leaseMs>60000||route.leaseMs<=route.requestTimeoutMs+500)fail('OWNER_TRANSPORT_BUDGET_INVALID');
 }
 return routes.find(route=>sameScope(route,identity))??null;
}

export function verifyOwnerDeliveryOrigin(route:OwnerTransportRoute,envelope:OwnerDeliveryEnvelope,encodedSignature:string){
 object(envelope);bounded(envelope);keys(envelope,['schema','semanticOwner','tenantId','principalId','kind','identity','payload','signedAt','originKeyId']);
 if(envelope.schema!=='finnor.s6.owner-delivery.v1'||!sameScope(route,envelope)||!['REFERENCE','EVENT'].includes(envelope.kind))fail('OWNER_ORIGIN_SCOPE_INVALID');
 text(envelope.identity);const signedAt=time(envelope.signedAt),key=route.originKeys.find(k=>k.id===envelope.originKeyId);
 if(!key||key.revoked||signedAt<time(key.validAfter)||signedAt>=time(key.validUntil)||signedAt>Date.now())fail('OWNER_ORIGIN_KEY_REVOKED_OR_UNAVAILABLE');
 if(!verify(null,Buffer.from(canonical(envelope)),publicKey(key.publicKey),signature(encodedSignature)))fail('OWNER_ORIGIN_SIGNATURE_INVALID');
 const payload=object(envelope.payload);let rights:any[];
 if(envelope.kind==='REFERENCE'){
  keys(payload,['reference','rightsRefs'],['sealed','relatedReferences']);const ref=object(payload.reference);keys(ref,['id','owner','version','contentDigest','content'],['digestEncoding']);
  if(ref.id!==envelope.identity||ref.owner!==route.semanticOwner||referencePreimageDigest(ref as any)!==hex(ref.contentDigest))fail('OWNER_ORIGIN_REFERENCE_INVALID');text(ref.version);rights=list(payload.rightsRefs);
  const related=payload.relatedReferences??[];if(!Array.isArray(related)||related.length>255)fail('OWNER_ORIGIN_REFERENCE_BOUND');const ids=new Set([ref.id]);
  for(const raw of related){const item=object(raw);keys(item,['id','owner','version','contentDigest','content'],['digestEncoding']);text(item.id);text(item.version);if(item.owner!==route.semanticOwner||ids.has(item.id)||referencePreimageDigest(item as any)!==hex(item.contentDigest))fail('OWNER_ORIGIN_REFERENCE_INVALID');ids.add(item.id);}
 }else{
  keys(payload,['event','references'],['sealed']);const event=object(payload.event);
  if(event.eventId!==envelope.identity||event.semanticOwner!==route.semanticOwner||event.tenantId!==route.tenantId||event.principalId!==route.principalId)fail('OWNER_ORIGIN_EVENT_SCOPE_INVALID');
  const {eventId,...body}=event;if(eventId!==route.semanticOwner.toLowerCase()+'-event:'+ownerTransportHash(body))fail('OWNER_ORIGIN_EVENT_IDENTITY_INVALID');
  rights=event.rightsRefs??[event.rightsRef];if(!Array.isArray(payload.references)||payload.references.length>256)fail('OWNER_ORIGIN_REFERENCE_BOUND');
 }
 if(!rights.length||rights.length>256||rights.some(r=>!route.rightsRefs.includes(r)))fail('OWNER_ORIGIN_RIGHTS_INVALID');
 if(payload.sealed!==undefined&&typeof payload.sealed!=='boolean')fail('OWNER_ORIGIN_SEAL_INVALID');
}

export async function signOwnerDeliveryOrigin(route:OwnerTransportRoute,input:Omit<OwnerDeliveryEnvelope,'schema'|'signedAt'|'originKeyId'>){
 const signer=route.originSigner??fail('OWNER_ORIGIN_SIGNER_UNAVAILABLE');
 const key=createPrivateKey(await privateFile(signer.path));const expected=route.originKeys.find(k=>k.id===signer.keyId);
 if(key.asymmetricKeyType!=='ed25519'||!expected||createPublicKey(key).export({type:'spki',format:'pem'}).toString()!==publicKey(expected.publicKey).export({type:'spki',format:'pem'}).toString())fail('OWNER_ORIGIN_SIGNER_MISMATCH');
 const envelope:OwnerDeliveryEnvelope={schema:'finnor.s6.owner-delivery.v1',...input,signedAt:new Date().toISOString(),originKeyId:signer.keyId};
 const encoded=sign(null,Buffer.from(canonical(envelope)),key).toString('base64');verifyOwnerDeliveryOrigin(route,envelope,encoded);
 return {envelope,signature:encoded};
}

/** One native lease bounds the whole operation, including every parent read. */
function operationDeadline(route:OwnerTransportRoute,options:{deadlineAt?:number}):number{
 const now=Date.now(),requested=options.deadlineAt??now+route.leaseMs;
 if(!Number.isFinite(requested)||requested<=now)fail('OWNER_TRANSPORT_LEASE_DEADLINE_EXCEEDED');
 return Math.min(requested-500,now+30000);
}
async function request(route:OwnerTransportRoute,path:string,body?:unknown,deadlineAt=Date.now()+route.requestTimeoutMs):Promise<Record<string,any>>{
 if(Date.now()>=deadlineAt)fail('OWNER_TRANSPORT_LEASE_DEADLINE_EXCEEDED');
 const secret=await privateFile(route.tokenPath);if(bytesHash(secret)!==route.tokenSha256)fail('OWNER_TRANSPORT_TOKEN_CHANGED');
 const token=secret.toString();if(!/^[\x21-\x7e]{16,4096}$/.test(token))fail('OWNER_TRANSPORT_TOKEN_INVALID');
 const remaining=Math.min(route.requestTimeoutMs,deadlineAt-Date.now());
 if(remaining<=0)fail('OWNER_TRANSPORT_LEASE_DEADLINE_EXCEEDED');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
 try{
  const response=await fetch(route.ledger.endpoint+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},redirect:'error',signal:controller.signal,...(body===undefined?{}:{body:canonical(body)})});
  const reader=response.body?.getReader();if(!reader)fail('LEDGER_RESPONSE_UNAVAILABLE');
  const chunks:Uint8Array[]=[];let length=0;
  for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>8*1024*1024){await reader.cancel();fail('LEDGER_RESPONSE_BYTE_BOUND');}chunks.push(part.value);}
  const answer=object(JSON.parse(Buffer.concat(chunks).toString()));bounded(answer);
  if(!response.ok){const code=typeof answer.error==='string'&&/^[A-Z0-9_]{1,64}$/.test(answer.error)?answer.error:'LEDGER_HTTP_UNAVAILABLE';fail(code);}
  return answer;
 }catch(error){if(error instanceof LedgerFault)throw error;fail('LEDGER_TRANSPORT_UNAVAILABLE');}
 finally{clearTimeout(timer);}
}

export function verifyOwnerTransportReceipt(route:OwnerTransportRoute,raw:unknown,expected:{kind:'REFERENCE'|'EVENT';identity:string;request?:Record<string,any>;semanticOwner?:string;principalId?:string;event?:Record<string,any>}){
 const receipt=object(raw);bounded(receipt);const {signature:encoded,...body}=receipt;
 const pin=route.ledger.acceptedReceipts.find(p=>p.releaseId===body.releaseId&&p.verifierDigest===body.verifierDigest&&p.policyDigest===body.policyDigest)??fail('LEDGER_RECEIPT_RELEASE_UNADMITTED');
 if(!verify(null,Buffer.from(canonical(body)),publicKey(pin.signerPublicKey),signature(encoded)))fail('LEDGER_RECEIPT_SIGNATURE_INVALID');
 const {checkpointDigest,...preimage}=body;
 if(body.schema!=='finnor.s6.ledger-receipt.v1'||!['REFERENCE','EVENT'].includes(body.kind)||body.kind!==expected.kind||body.identity!==expected.identity||body.tenantId!==route.tenantId||expected.principalId!==undefined&&body.principalId!==expected.principalId||expected.semanticOwner!==undefined&&body.semanticOwner!==expected.semanticOwner||!Number.isSafeInteger(body.sequence)||body.sequence<1||body.sequence>100000||ownerTransportHash(preimage)!==checkpointDigest)fail('LEDGER_RECEIPT_BINDING_INVALID');
 if(!Array.isArray(body.rightsRefs)||!body.rightsRefs.length||body.rightsRefs.some((r:any)=>!route.rightsRefs.includes(r)))fail('LEDGER_RECEIPT_RIGHTS_INVALID');
 if(expected.event&&(body.eventId!==expected.event.eventId||body.eventDigest!==ownerTransportHash(expected.event)))fail('LEDGER_RECEIPT_EVENT_PREIMAGE_INVALID');
 if(expected.request){
  const payload=expected.request;const refs=body.kind==='REFERENCE'?[payload.reference,...(payload.relatedReferences??[])]:payload.references;
  const rights=body.kind==='REFERENCE'?payload.rightsRefs:(payload.event.rightsRefs??[payload.event.rightsRef]);
  const descriptors=refs.map(({content,...ref}:Record<string,any>)=>ref);
  if(body.requestDigest!==ownerTransportHash(payload)||!same(body.references,descriptors)||!same(body.rightsRefs,[...new Set(rights)].sort())||body.sealed!==(payload.sealed===true)||body.episodeId!==(body.kind==='EVENT'?payload.event.episodeId:null)||!same(body.parentCheckpoints,(payload.parents??[]).map((p:any)=>p.checkpointDigest)))fail('LEDGER_RECEIPT_REQUEST_PREIMAGE_INVALID');
 }
 return receipt;
}

/** Read-only S6 evidence; signatures confer no causal/economic attribution. */
export async function readOwnerTransportExecutionHandoff(identity:OwnerTransportScope,obligationId:string){
 const route=await ownerTransportRoute(identity);if(!route)fail('OWNER_TRANSPORT_CONFIGURATION_UNAVAILABLE');
 if(!['S6','S7','S8'].includes(identity.semanticOwner)||!/^durable-obligation:[a-f0-9]{64}$/.test(obligationId))fail('OWNER_HANDOFF_IDENTITY_INVALID');
 const answer=await request(route,'/execution-handoff/'+encodeURIComponent(obligationId)),handoff=object(answer.handoff),consumer=object(handoff.consumer),release=object(handoff.release);
 const pin=route.ledger.acceptedReceipts.find(p=>p.releaseId===release.releaseId&&p.verifierDigest===release.verifierDigest&&p.policyDigest===release.policyDigest)??fail('OWNER_HANDOFF_RELEASE_UNADMITTED');
 if(!verify(null,Buffer.from(canonical(handoff)),publicKey(pin.signerPublicKey),signature(answer.signature)))fail('OWNER_HANDOFF_SIGNATURE_INVALID');
 if(handoff.schema!=='finnor.s6.consumer-handoff.v1'||handoff.version!=='s6-consumer-handoff-v1'||handoff.semanticOwner!=='S6'||consumer.semanticOwner!==identity.semanticOwner||consumer.tenantId!==identity.tenantId||consumer.principalId!==identity.principalId||!same([...consumer.rightsRefs].sort(),[...route.rightsRefs].sort())||consumer.appendAuthorityGranted!==false||handoff.attributionGranted!==false||handoff.resourceReleaseGranted!==false||handoff.executionAuthorityGranted!==false)fail('OWNER_HANDOFF_SCOPE_OR_QUALIFICATION_INVALID');
 const obligation=object(handoff.obligation),{ref,...preimage}=obligation;
 if(ref?.id!==obligationId||ref.owner!=='S6'||ref.contentDigest!==ownerTransportHash(preimage)||obligation.tenantId!==identity.tenantId||obligation.principalId!==identity.principalId||!route.rightsRefs.includes(obligation.rightsRef))fail('OWNER_HANDOFF_OBLIGATION_PREIMAGE_INVALID');
 verifyOwnerTransportReceipt(route,handoff.obligationReceipt,{kind:'REFERENCE',identity:obligationId,semanticOwner:'S6',principalId:identity.principalId});
 let prior=0;for(const row of list(handoff.history,512)){object(row);object(row.event);const receipt=verifyOwnerTransportReceipt(route,row.receipt,{kind:'EVENT',identity:row.event.eventId,semanticOwner:'S6',principalId:identity.principalId,event:row.event});if(receipt.protectedExecution!==true||receipt.sequence<=prior||!same(row.event.detail?.obligationRef,ref))fail('OWNER_HANDOFF_HISTORY_BINDING_INVALID');prior=receipt.sequence;}
 if(!same(handoff.attempts,handoff.history.filter((row:any)=>row.event.type==='ATTEMPT'))||!same(handoff.observations,handoff.history.filter((row:any)=>row.event.type==='OBSERVATION'))||!same(handoff.settlements,handoff.history.filter((row:any)=>row.event.type==='VERIFICATION')))fail('OWNER_HANDOFF_PROJECTION_INVALID');
 return answer;
}

async function originalOwnerRequest(route:OwnerTransportRoute,envelope:OwnerDeliveryEnvelope,deadlineAt:number){
 const payload=structuredClone(envelope.payload);
 if(envelope.kind==='EVENT'){
  const event=object(payload.event),parents=new Map<string,any>();
  const causal=event.causalParents;if(!Array.isArray(causal)||causal.length>256||causal.some(id=>typeof id!=='string'))fail('OWNER_ORIGIN_PARENT_INVALID');
  const prepared=event.preparedParentRefs??[];if(!Array.isArray(prepared)||prepared.length>256||prepared.some(id=>typeof id!=='string'))fail('OWNER_ORIGIN_PARENT_INVALID');
  for(const id of new Set<string>([...causal,...prepared.filter((id:string)=>/^s[1-8]-event:/.test(id))])){
   const read=await request(route,'/events/'+encodeURIComponent(id),undefined,deadlineAt);const parentEvent=object(read.event);
   const receipt=verifyOwnerTransportReceipt(route,read.receipt,{kind:'EVENT',identity:id,event:parentEvent});
   if(causal.includes(id)&&parentEvent.episodeId!==event.episodeId||receipt.sealed&&!payload.sealed)fail('OWNER_ORIGIN_PARENT_SCOPE_INVALID');parents.set(id,receipt);
  }
  payload.parents=[...parents.values()];
 }
 bounded(payload);
 return payload;
}

async function preparedDelivery(identity:OwnerTransportScope,envelope:OwnerDeliveryEnvelope,originSignature:string,options:{deadlineAt?:number}){
 const route=await ownerTransportRoute(identity)??fail('OWNER_TRANSPORT_ROUTE_UNAVAILABLE');
 // Validate ordinary storage independently BEFORE opening a credential file.
 verifyOwnerDeliveryOrigin(route,envelope,originSignature);
 const deadlineAt=operationDeadline(route,options);
 const payload=await originalOwnerRequest(route,envelope,deadlineAt);
 // Re-read the externally signed route after parent resolution, including key revocation.
 const current=await ownerTransportRoute(identity)??fail('OWNER_TRANSPORT_ROUTE_UNAVAILABLE');verifyOwnerDeliveryOrigin(current,envelope,originSignature);
 return {route:current,payload,deadlineAt};
}

export async function deliverOwnerTransportIntent(identity:OwnerTransportScope,envelope:OwnerDeliveryEnvelope,originSignature:string,options:{deadlineAt?:number}={}){
 const {route,payload,deadlineAt}=await preparedDelivery(identity,envelope,originSignature,options);
 const response=await request(route,envelope.kind==='REFERENCE'?'/references':'/append',payload,deadlineAt);
 const receipt=verifyOwnerTransportReceipt(route,response.receipt,{kind:envelope.kind,identity:envelope.identity,request:payload,semanticOwner:identity.semanticOwner,principalId:identity.principalId,...(envelope.kind==='EVENT'?{event:payload.event}:{})});
 return {receipt,requestDigest:ownerTransportHash(payload)};
}

/** Exhausting append attempts permits only retrieval of the original commitment. */
export async function recoverOwnerTransportIntent(identity:OwnerTransportScope,envelope:OwnerDeliveryEnvelope,originSignature:string,options:{deadlineAt?:number}={}){
 const {route,payload,deadlineAt}=await preparedDelivery(identity,envelope,originSignature,options);
 const response=await request(route,(envelope.kind==='REFERENCE'?'/references/':'/events/')+encodeURIComponent(envelope.identity),undefined,deadlineAt);
 const committed=envelope.kind==='REFERENCE'?response.reference:response.event;
 if(!same(committed,envelope.kind==='REFERENCE'?payload.reference:payload.event))fail('LEDGER_RECOVERY_CONTENT_PREIMAGE_INVALID');
 const receipt=verifyOwnerTransportReceipt(route,response.receipt,{kind:envelope.kind,identity:envelope.identity,request:payload,semanticOwner:identity.semanticOwner,principalId:identity.principalId,...(envelope.kind==='EVENT'?{event:payload.event}:{})});
 return {receipt,requestDigest:ownerTransportHash(payload)};
}

export async function readOwnerTransportReference(identity:OwnerTransportScope,id:string){
 const route=await ownerTransportRoute(identity)??fail('OWNER_TRANSPORT_ROUTE_UNAVAILABLE');text(id);
 const answer=await request(route,'/references/'+encodeURIComponent(id));const reference=object(answer.reference);
 const receipt=verifyOwnerTransportReceipt(route,answer.receipt,{kind:answer.receipt.kind,identity:answer.receipt.identity});
 const {content,...descriptor}=reference;
 if(reference.id!==id||referencePreimageDigest(reference as any)!==reference.contentDigest||!Array.isArray(receipt.references)||!receipt.references.some((r:any)=>same(r,descriptor)))fail('LEDGER_REFERENCE_READBACK_INVALID');
 return {reference,receipt,executionAuthorityGranted:false as const,qualification:'AUTHENTICATED_CONTENT_AND_COMMITMENT_ONLY_NO_EFFECT_ADMISSION_OR_BUSINESS_TRUTH'};
}

/** Authenticated semantic-owner read, including the exact accepted event preimage. */
export async function readOwnerTransportEvent(identity:OwnerTransportScope,id:string){
 const route=await ownerTransportRoute(identity)??fail('OWNER_TRANSPORT_ROUTE_UNAVAILABLE');text(id);
 const answer=await request(route,'/events/'+encodeURIComponent(id)),event=object(answer.event);
 const receipt=verifyOwnerTransportReceipt(route,answer.receipt,{kind:'EVENT',identity:id,semanticOwner:event.semanticOwner,principalId:event.principalId,event});
 const {eventId,...body}=event;
 if(eventId!==id||event.tenantId!==identity.tenantId||event.principalId!==identity.principalId||eventId!==event.semanticOwner.toLowerCase()+'-event:'+ownerTransportHash(body))fail('LEDGER_EVENT_READBACK_PREIMAGE_INVALID');
 // S1 authenticates a view and S2 may authenticate a protocol/compute revision.
 // Their accepted full event preimage is already bound by the pinned receipt;
 // a detail digest belongs to the distinct S3–S6 typed contracts.
 if(['S3','S4','S5','S6'].includes(event.semanticOwner)&&ownerTransportHash(event.detail)!==event.contentDigest)fail('LEDGER_EVENT_READBACK_PREIMAGE_INVALID');
 return {event,receipt,qualification:'AUTHENTICATED_EXACT_EVENT_AND_PROTECTED_COMMITMENT'};
}

/** Ordinary delivery can only invoke the fixed protected route; provider secrets
 * remain in the broker. Independently read the returned accepted event afterward. */
export async function dispatchOwnerTransportRequest(identity:OwnerTransportScope,input:{request:Record<string,any>;authorization:Record<string,any>;delivery?:Record<string,any>},reconcile=false){
 if(identity.semanticOwner!=='S6')fail('DISPATCH_SEMANTIC_OWNER_REQUIRED');
 const transport=await ownerTransportRoute(identity)??fail('OWNER_TRANSPORT_ROUTE_UNAVAILABLE');
 const answer=await request(transport,reconcile?'/reconcile':'/dispatch',input,Date.now()+30000);
 if(!['VERIFIED','UNRESOLVED'].includes(answer.status)||!answer.receipt?.identity)fail('DISPATCH_RESPONSE_INVALID');
 const accepted=await readOwnerTransportEvent(identity,answer.receipt.identity),detail=accepted.event.detail;
 if(!same(accepted.receipt,answer.receipt)||accepted.receipt.protectedExecution!==true||accepted.receipt.semanticOwner!=='S6'||detail?.schema!=='finnor.s6.protected-execution.v1'||!same(detail.obligationRef,input.request.ir?.obligationRef)||!same(detail.requestRef,input.request.ref)||!same(detail.effectRef,input.request.ir?.effectRef))fail('DISPATCH_PROTECTED_EVENT_BINDING_INVALID');
 if(answer.status==='VERIFIED'&&(accepted.event.type!=='VERIFICATION'||detail.status!=='VERIFIED'||detail.memberCount!==input.request.ir?.members?.length))fail('DISPATCH_SETTLEMENT_NOT_ESTABLISHED');
 return {status:answer.status as 'VERIFIED'|'UNRESOLVED',receipt:accepted.receipt,...(answer.status==='VERIFIED'?{settlement:detail}: {responsibilityRetained:true,automaticMutationRetry:false}),semanticReplay:answer.semanticReplay===true,qualification:'PROTECTED_EXACT_EXECUTION_EVENT_CURRENT_ADMITTED_RELEASE_DOMAIN'};
}
