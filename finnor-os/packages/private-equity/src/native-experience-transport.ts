/** Ordinary native semantic-owner integration. Prepared records are unchanged;
 * separate S6 commitments authenticate transport, never science or execution. */
import {withTenantTransaction} from '@finnor/db';
import type {BeliefView} from '@finnor/shared-types';
import {ownerTransportRoute,ownerTransportHash,verifyOwnerDeliveryOrigin} from '../../governed-execution/src/owner-transport';
import {enqueueOwnerDeliveryInTransaction} from '../../governed-execution/src/owner-delivery-store';
import {referencePreimageDigest,LedgerFault} from '../../governed-execution/src/protocol';
import type {PeMutationContext,PeWorldState} from './types';

export interface NativeTransportReference {id:string;owner:string;version:string;contentDigest:string;content:any;digestEncoding?:'NATIVE_UTF8_SHA256_V1'}
const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const scope=(ctx:PeMutationContext,semanticOwner:string)=>({semanticOwner,tenantId:ctx.auth.tenantId,principalId:actor(ctx)});
export const nativeOwnerTransportConfigured=async(ctx:PeMutationContext,owner:string)=>!!process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG&&!!await ownerTransportRoute(scope(ctx,owner));
const normalize=(v:unknown)=>JSON.parse(JSON.stringify(v));
export const nativeReference=(owner:string,id:string,content:unknown,version='native-owner-preimage-v1'):NativeTransportReference=>{const value=normalize(content);return {owner,id,version,contentDigest:ownerTransportHash(value),content:value};};
export function nativeRecordReference(value:any):NativeTransportReference|null{
 if(!value?.ref)return null;const {ref,...content}=value;
 return ownerTransportHash(normalize(content))===ref.contentDigest?{...ref,content:normalize(content)}:null;
}

/** One bounded cut, signed by the actual original owner, preserves every native
 * ID/encoding/preimage. Unknown foreign owner routes confer no append authority. */
export async function enqueueNativeReferences(ctx:PeMutationContext,references:readonly NativeTransportReference[],rightsRefs:readonly string[]){
 if(!process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG||references.length===0)return;
 const owners=new Map<string,Map<string,NativeTransportReference>>();
 for(const reference of references){
  if(referencePreimageDigest(reference)!==reference.contentDigest)throw new LedgerFault(503,'NATIVE_OWNER_PREIMAGE_MISMATCH');
  const group=owners.get(reference.owner)??new Map<string,NativeTransportReference>();
  if(group.has(reference.id)&&ownerTransportHash(group.get(reference.id))!==ownerTransportHash(reference))throw new LedgerFault(503,'NATIVE_OWNER_REFERENCE_CONFLICT');
  group.set(reference.id,reference);owners.set(reference.owner,group);
 }
 const rights=[...new Set(rightsRefs)].sort();
 for(const [owner,group] of owners){
  const identity=scope(ctx,owner),route=await ownerTransportRoute(identity);if(!route)continue;
  const candidates=[...group.values()].sort((a,b)=>a.id.localeCompare(b.id));
  await withTenantTransaction(identity.tenantId,{userId:identity.principalId},async(_db,c)=>{
   // Reuse the exact original signed preimage, including its original access
   // labels. A later rights revision must not relabel an immutable reference.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['s6-owner-transport',identity])]);
   const prior=await c.query(`SELECT DISTINCT ON (r.reference->>'id') r.reference,o.envelope,o.signature,o.payload_digest
    FROM finnor_os.s6_owner_delivery_origins o
    CROSS JOIN LATERAL (SELECT o.envelope #> '{payload,reference}' AS reference
     UNION ALL SELECT value FROM jsonb_array_elements(COALESCE(o.envelope #> '{payload,relatedReferences}','[]'::jsonb))) r
    WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.semantic_owner=$3 AND o.kind='REFERENCE'
     AND r.reference->>'id'=ANY($4::text[])
    ORDER BY r.reference->>'id',o.created_at,o.identity`,[identity.tenantId,identity.principalId,owner,candidates.map(r=>r.id)]);
   const known=new Set<string>();
   for(const row of prior.rows){
    verifyOwnerDeliveryOrigin(route,row.envelope,row.signature);
    if(ownerTransportHash(row.envelope.payload)!==row.payload_digest)throw new LedgerFault(503,'OWNER_ORIGIN_STORAGE_BINDING_INVALID');
    const candidate=group.get(row.reference.id);
    if(!candidate||ownerTransportHash(candidate)!==ownerTransportHash(row.reference))throw new LedgerFault(503,'NATIVE_OWNER_REFERENCE_CONFLICT');
    known.add(candidate.id);
   }
   const original=candidates.filter(r=>!known.has(r.id));
   for(let offset=0;offset<original.length;offset+=255){
    const relatedReferences=original.slice(offset,offset+255);
    if(relatedReferences.length===1){const reference=relatedReferences[0]!;await enqueueOwnerDeliveryInTransaction(c,identity,{kind:'REFERENCE',identity:reference.id,payload:{reference,rightsRefs:rights}});continue;}
    const content={schema:'finnor.s6.native-owner-reference-cut.v1',...identity,rightsRefs:rights,references:relatedReferences.map(({content,...ref})=>ref)};
    const reference=nativeReference(owner,'native-owner-cut:'+ownerTransportHash(content),content,'native-owner-reference-cut-v1');
    await enqueueOwnerDeliveryInTransaction(c,identity,{kind:'REFERENCE',identity:reference.id,payload:{reference,relatedReferences,rightsRefs:rights}});
   }
  });
 }
}

export async function enqueueNativePreparedEvents(ctx:PeMutationContext,owner:string,events:readonly any[]){
 const identity=scope(ctx,owner);if(!process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG||!await ownerTransportRoute(identity))return;
 await withTenantTransaction(identity.tenantId,{userId:identity.principalId},async(_db,c)=>{
  for(const event of events){
   if(event.semanticOwner!==owner||event.tenantId!==identity.tenantId||event.principalId!==identity.principalId)throw new LedgerFault(503,'NATIVE_OWNER_EVENT_SCOPE_INVALID');
   await enqueueOwnerDeliveryInTransaction(c,identity,{kind:'EVENT',identity:event.eventId,payload:{event:normalize(event),references:[]}});
  }
 });
}

export async function enqueueNativeBelief(ctx:PeMutationContext,view:BeliefView,world:PeWorldState,extraReferences:readonly NativeTransportReference[]=[],event=view.experience.event){
 if(!process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG||!await ownerTransportRoute(scope(ctx,'S1')))return;
 const {evaluatedAt,...rights}=view.rights;
 const content={schema:view.schema,semanticOwner:view.semanticOwner,interpretationVersion:view.interpretationVersion,tenantId:view.tenantId,principalId:view.principalId,root:view.root,validAt:view.validAt,knowledgeAt:view.knowledgeAt,rights,sourceCuts:view.sourceCuts,claims:view.claims,contradictions:view.contradictions,coverage:view.coverage,dependencyDigest:view.dependencyDigest,resolution:view.resolution};
 const references:NativeTransportReference[]=[{...nativeReference('S1',view.id,content,view.interpretationVersion),contentDigest:view.contentDigest},nativeReference('S1',event.freshnessRef,view.sourceCuts,'s1-source-cut-v1'),nativeReference('S1',view.dependencyDigest,{dependencyRefs:view.experience.event.dependencyRefs,rightsRevision:view.rights.revision,interpretation:view.interpretationVersion,coverage:view.coverage,sourceCuts:view.sourceCuts.map(({knownThrough,...cut})=>cut)},'s1-dependency-cut-v1'),...extraReferences];
 for(const claim of world.beliefView?.claims??view.claims){
  const ref=claim.ownerRef;let reference:NativeTransportReference;
  const evidence=world.evidence.find(e=>String(e.versionId)===ref.revisionId);
  if(evidence)reference={...nativeReference(ref.owner,ref.revisionId,{content:evidence.contentHash,snapshot:evidence.snapshotHash},'evidence-version-hash-pair-v1'),contentDigest:ref.contentDigest};
  else{if(!claim.exactSnapshotJson)throw new LedgerFault(503,'NATIVE_SNAPSHOT_PREIMAGE_UNAVAILABLE');reference={owner:ref.owner,id:ref.revisionId,version:'canonical-snapshot-v1',contentDigest:ref.contentDigest,content:claim.exactSnapshotJson,digestEncoding:'NATIVE_UTF8_SHA256_V1'};}
  references.push(reference);
  const alias=`${ref.owner}:${ref.revisionId}:${ref.contentDigest}`;if(event.dependencyRefs.includes(alias))references.push({...reference,id:alias});
  if(evidence){const id=`evidence:${evidence.versionId}:${evidence.contentHash}:${evidence.snapshotHash}`;if(event.dependencyRefs.includes(id))references.push({...reference,id});}
 }
 const providerCoverage=world.sourceCoverage.map(({asOf, freshness,...descriptor})=>{const {ageMs,...stableFreshness}=freshness as Record<string,unknown>;return {...descriptor,freshness:stableFreshness};});
 for(const value of [providerCoverage,world.temporalCompleteness]){const id=(value===providerCoverage?'provider-coverage:':'canonical-coverage:')+ownerTransportHash(normalize(value));if(event.dependencyRefs.includes(id))references.push(nativeReference('S1',id,value,'s1-coverage-cut-v1'));}
 await enqueueNativeReferences(ctx,references,[view.rights.ref]);await enqueueNativePreparedEvents(ctx,'S1',[event]);
}

export async function enqueueNativeS3Model(ctx:PeMutationContext,model:any){
 if(!await nativeOwnerTransportConfigured(ctx,'S3'))return;
 const reference=nativeRecordReference(model);if(!reference)throw new LedgerFault(503,'NATIVE_MODEL_ORIGIN_INVALID');
 await enqueueNativeReferences(ctx,[reference,nativeReference('S3','fit-request:'+ownerTransportHash(model.request),model.request,'s3-fit-request-v1'),nativeReference('S3',model.compute.id,model.compute,'model-compute-v1'),...model.request.mechanisms.map((m:any)=>nativeReference('S3','mechanism:'+ownerTransportHash(m),m,'s3-mechanism-v1'))],model.beliefBindings.map((b:any)=>b.rightsRef));
}

export async function enqueueNativeMandate(ctx:PeMutationContext,mandate:any){
 if(!await nativeOwnerTransportConfigured(ctx,'BUSINESS_OWNER'))return;
 if(ctx.auth.role!=='owner'||mandate.tenantId!==ctx.auth.tenantId||mandate.principalId!==actor(ctx)||mandate.businessOwnerRef?.owner!=='BUSINESS_OWNER'||mandate.businessOwnerRef.id!==actor(ctx))throw new LedgerFault(503,'NATIVE_MANDATE_OWNER_INVALID');
 const reference=nativeRecordReference(mandate);if(!reference)throw new LedgerFault(503,'NATIVE_MANDATE_ORIGIN_INVALID');
 const references=[reference];if(ownerTransportHash(mandate.utility)===mandate.utilityRef.contentDigest)references.push({...mandate.utilityRef,content:mandate.utility});
 await enqueueNativeReferences(ctx,references,[mandate.rightsRef]);
}
