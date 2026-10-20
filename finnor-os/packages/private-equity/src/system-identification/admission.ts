import type {PeMutationContext} from '../types';
import type {IdentifiedSystemRelease} from '@finnor/shared-types';
import {AdmissionSchema,CurrentSchema,parse,sha,fail,type IdentificationRow} from './contracts';
import {tx,identificationTx,modelTx,assertModelCurrentTx,consentTx,eventTx,principal,rootOf,experimentsTx} from './store';
import {makeIdentifiedSystemCandidate,type IdentifiedSystemCandidate} from '../../../capability-evolution/src/identified-system-port';
import {identifiedSystemConsumerPolicy,proposeIdentifiedSystemCandidate,currentIdentifiedSystemCandidate} from '../../../capability-evolution/src/identified-system-consumer';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
export function identificationPayload(a:IdentificationRow,m:IdentifiedSystemRelease,rightsDigest:string){
 return {schema:'finnor.s8.identified-system-payload.v1' as const,kind:'IdentifiedSystemModel' as const,identificationId:a.id,modelId:m.id,
  profile:'PE_FIRM_DIGITAL_RELATION_V1' as const,modelDigest:sha(m),domainDigest:sha(m.domain),familyDigest:m.familyDigest,checkDigest:m.checkDigest,rightsDigest,
  ...m.environment,runtime:'FINNOR_NODE_22_FINITE_DIGITAL_IDENTIFICATION_V1' as const,effects:'NO_MODEL_EFFECT_AUTHORITY' as const};
}
export async function resolveIdentifiedSystemNativeProof(candidate:IdentifiedSystemCandidate,assignmentId?:string){
 const ctx:PeMutationContext={auth:{tenantId:candidate.tenantId,userId:candidate.principalId,employeeId:candidate.principalId,role:'owner'}};
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,candidate.payload.identificationId),m=await modelTx(c,a,candidate.payload.modelId),
   current=await assertModelCurrentTx(ctx,c,a,m.body),rights=await consentTx(ctx,c,a.consent_id,a.root_id);
  if(a.owner_id!==candidate.principalId||sha(identificationPayload(a,m.body,rights.body_digest))!==sha(candidate.payload)||candidate.rightsRef!==rights.body_digest||
   sha(rootOf(a))!==sha(candidate.domain.root)||Date.parse(candidate.domain.validUntil)>Date.parse(m.body.validUntil))fail('X4_S8_NATIVE_PAYLOAD_SUBSTITUTION');
  if(!assignmentId)return {assignmentDigest:null,resultsDigest:null,disposition:null,evaluatorId:null,registeredAt:null};
  const assignment=(await c.query('SELECT * FROM finnor_os.x4_assignments WHERE tenant_id=$1 AND identification_id=$2 AND id=$3',[a.tenant_id,a.id,assignmentId])).rows[0];
  if(!assignment||assignment.actor_id===a.owner_id||assignment.status!=='COMPLETE'||!m.body.replicationRefs.some(r=>r.id===assignment.experiment_id))fail('X4_S8_NATIVE_INDEPENDENT_REPLICATION_REQUIRED');
  const replicaCtx:PeMutationContext={auth:{tenantId:a.tenant_id,userId:assignment.actor_id,employeeId:assignment.actor_id,role:'owner'}},
   authority=await employeeAuthoritySnapshotTx(replicaCtx.auth,c);
  await identificationTx(replicaCtx,c,a.id,'action:replicate_identified_system');
  const experiment=(await experimentsTx(c,a)).find(e=>e.id===assignment.experiment_id);
  if(!experiment||experiment.status!=='OBSERVED'||assignment.result?.checkDigest!==m.body.checkDigest)fail('X4_S8_NATIVE_REPLICATION_CHECK_MISMATCH');
  await assertAuthorityTemporalBoundsTx(c,[...current.bounds,m.body.validUntil,...(authority.validUntil?[authority.validUntil]:[])]);
  return {assignmentDigest:sha({request:assignment.request,protocolDigest:experiment.protocol_digest}),resultsDigest:sha({result:assignment.result,observation:experiment.result,checkDigest:m.body.checkDigest}),
   disposition:'SUPPORTED_DEVELOPMENT' as const,evaluatorId:assignment.actor_id as string,registeredAt:experiment.created_at.toISOString()};
 });
}
const validity=(c:IdentifiedSystemCandidate,p:{validAfter:string;validUntil:string})=>Date.now()>=Math.max(Date.parse(c.domain.validAfter),Date.parse(p.validAfter))&&Date.now()<Math.min(Date.parse(c.domain.validUntil),Date.parse(p.validUntil));
export async function proposeIdentificationAdmission(ctx:PeMutationContext,value:unknown){
 const input=parse(AdmissionSchema,value),prepared=await tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId,'action:run_system_identification'),m=await modelTx(c,a,input.modelId);
  if(a.owner_id!==principal(ctx))fail('X4_S8_OWNER_REQUIRED',403);
  await assertModelCurrentTx(ctx,c,a,m.body);const rights=await consentTx(ctx,c,a.consent_id,a.root_id);
  const prior=(await c.query("SELECT body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=$3",[a.tenant_id,a.id,'s8-propose:'+input.idempotencyKey])).rows[0];
  if(prior&&prior.body.requestDigest!==sha(input))fail('X4_IDEMPOTENCY_CONFLICT');return {a,m:m.body,rights,prior};
 });
 if(prepared.prior)return prepared.prior.body;
 const payload=identificationPayload(prepared.a,prepared.m,prepared.rights.body_digest),
  policy=await identifiedSystemConsumerPolicy({tenantId:prepared.a.tenant_id,principalId:prepared.a.owner_id,rightsRef:payload.rightsDigest});
 if(!policy)fail('X4_S8_INDEPENDENT_CONFIGURATION_REQUIRED',503);
 // Commit one immutable external intention before contacting S8. Recovery and
 // concurrent calls use the same candidate and signed transport request ID.
 const registered=await tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId,'action:run_system_identification');await assertModelCurrentTx(ctx,c,a,prepared.m);
  const prior=(await c.query("SELECT body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=$3",[a.tenant_id,a.id,'s8-proposal-register:'+input.idempotencyKey])).rows[0]?.body;
  if(prior){
   if(prior.requestDigest!==sha(input))fail('X4_IDEMPOTENCY_CONFLICT');
   if(prior.policyDigest!==sha(policy)||prior.candidate.payload.modelDigest!==sha(prepared.m)||!validity(prior.candidate,policy))fail('X4_S8_ADMISSION_CONTEXT_CHANGED');
   return prior as {candidate:IdentifiedSystemCandidate;policyDigest:string;requestDigest:string};
  }
  const candidate=makeIdentifiedSystemCandidate({schema:'finnor.s8.identified-system-candidate.v1',tenantId:a.tenant_id,principalId:a.owner_id,rightsRef:payload.rightsDigest,
   owningInterface:'x4-identified-system-v1',payload,domain:{root:rootOf(a),validAfter:new Date(Math.max(Date.now(),Date.parse(policy.validAfter))).toISOString(),
    validUntil:new Date(Math.min(Date.parse(prepared.m.validUntil),Date.parse(policy.validUntil))).toISOString()},dependencies:policy.sourcePins,proposedAt:new Date().toISOString(),protectedAdmission:false,executionAuthorityGranted:false});
  const result={candidate,policyDigest:sha(policy),requestDigest:sha(input)};
  await eventTx(c,a,principal(ctx),'S8_PROPOSAL_REGISTERED','s8-proposal-register:'+input.idempotencyKey,result);return result;
 });
 const candidate=registered.candidate;
 const ref=await proposeIdentifiedSystemCandidate(candidate,policy!),
  finalPolicy=await identifiedSystemConsumerPolicy({tenantId:prepared.a.tenant_id,principalId:prepared.a.owner_id,rightsRef:payload.rightsDigest});
 if(!finalPolicy||sha(finalPolicy)!==sha(policy)||!validity(candidate,finalPolicy))fail('X4_S8_ADMISSION_CONTEXT_CHANGED');
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId,'action:run_system_identification');await assertModelCurrentTx(ctx,c,a,prepared.m);
  if(!validity(candidate,finalPolicy!))fail('X4_S8_ADMISSION_CONTEXT_CHANGED');
  const prior=(await c.query("SELECT body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=$3",[a.tenant_id,a.id,'s8-propose:'+input.idempotencyKey])).rows[0]?.body;
  if(prior){if(prior.requestDigest!==sha(input)||sha(prior.candidate)!==sha(candidate))fail('X4_IDEMPOTENCY_CONFLICT');return prior;}
  const result={modelId:prepared.m.id,candidate,revisionRef:ref,requestDigest:sha(input),protectedAdmission:false,productionActive:false};
  await eventTx(c,a,principal(ctx),'S8_PROPOSED','s8-propose:'+input.idempotencyKey,result);return result;
 });
}
export async function readIdentificationAdmission(ctx:PeMutationContext,value:unknown){
 const input=parse(CurrentSchema,value),pinned=await tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId),m=await modelTx(c,a,input.modelId);
  const rows=(await c.query("SELECT body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND kind='S8_PROPOSED'",[a.tenant_id,a.id])).rows,
   candidate=rows.map(v=>v.body.candidate as IdentifiedSystemCandidate).find(v=>sha(v.ref)===sha(input.revisionRef));
  if(!candidate||candidate.payload.modelDigest!==sha(m.body))fail('X4_S8_UNKNOWN_CANDIDATE');
  return {a,m:m.body,candidate:candidate!};
 });
 let admission:Awaited<ReturnType<typeof currentIdentifiedSystemCandidate>>=null,policyCurrent=false;
 try{
  const policy=await identifiedSystemConsumerPolicy({tenantId:pinned.a.tenant_id,principalId:pinned.a.owner_id,rightsRef:pinned.candidate.rightsRef});
  if(policy){
   admission=await currentIdentifiedSystemCandidate(pinned.candidate,policy,'x4-current:'+crypto.randomUUID());
   const finalPolicy=await identifiedSystemConsumerPolicy({tenantId:pinned.a.tenant_id,principalId:pinned.a.owner_id,rightsRef:pinned.candidate.rightsRef});
   policyCurrent=!!finalPolicy&&sha(finalPolicy)===sha(policy)&&validity(pinned.candidate,finalPolicy);
  }
 }catch{/* Missing/replaced/expired authority is never a current artifact. */}
 return tx(ctx,async c=>{
  const a=await identificationTx(ctx,c,input.identificationId);let nativeCurrent=true;try{await assertModelCurrentTx(ctx,c,a,pinned.m);}catch{nativeCurrent=false;}
  const current=nativeCurrent&&policyCurrent&&!!admission&&Date.now()<Date.parse(admission.validUntil);
  return {current,admission:current?admission!.ref:null,currentUntil:current?admission!.validUntil:null,revisionRef:input.revisionRef,protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 });
}
