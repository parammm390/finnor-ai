/** Native evidence resolver for S8. No private opening is sent to S8. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PeMutationContext} from '../types';
import {makeConfidentialCandidate,type ConfidentialCandidate} from '../../../capability-evolution/src/confidential-port';
import {confidentialConsumerPolicy,proposeConfidentialCandidate,currentConfidentialCandidate} from '../../../capability-evolution/src/confidential-consumer';
import {parse,sha,fail,RefSchema} from './contracts';
import {tx,computationTx,releaseTx,principal,eventTx,reserveCpuTx,type ComputationRow} from './store';
import {runPublicChild} from './process';
export const S8ProposalSchema=z.object({computationId:z.string().uuid(),releaseId:z.string().uuid(),
 idempotencyKey:z.string().min(1).max(120)}).strict();
export const S8CurrentSchema=z.object({computationId:z.string().uuid(),releaseId:z.string().uuid(),revisionRef:RefSchema}).strict();
async function checkAgain(q:ComputationRow){
 const r=await runPublicChild({action:'check',function:q.request.function,protocol:q.protocol,
  limits:{...q.request.limits,maxCpuSeconds:2,maxMemoryBytes:1024**3}},
 Math.min(q.deadline_at.getTime(),Date.now()+3000));
 if(r.status!=='CHECKED'||sha(r)!==sha(q.correspondence))fail('Y4_S8_CORRESPONDENCE_SUBSTITUTION');
 return r;
}
async function nativeProof(ctx:PeMutationContext,computationId:string,releaseId:string){
 const basis=await tx(ctx,async c=>{
  const q=await computationTx(ctx,c,computationId),release=await releaseTx(ctx,c,q,releaseId);
  if(release.schema!=='finnor.confidential-economic-computation.v2')fail('Y4_COMPLETE_PRINCIPAL_ARTIFACT_REQUIRED');
  if(!q.protocol||!q.correspondence||!q.runtime_receipt||!q.session)fail('Y4_NATIVE_COMPLETION_BASIS_REQUIRED');
  const receipts=q.runtime_receipt.receipts as Array<Record<string,any>>,ids=q.request.function.participants.map(p=>p.id);
  if(!Array.isArray(receipts)||receipts.length!==ids.length||new Set(receipts.map(r=>r.participantId)).size!==ids.length
   ||receipts.some(r=>!ids.includes(r.participantId)||r.state!=='COMPLETED'||r.nativeIndependentlyReconstructed!==true
    ||r.outputCommitments?.[release.envelope.tenant_and_participant_scope.recipientId]!==release.outputCommitment))
   fail('Y4_S8_AUTHENTICATED_NATIVE_COMMITMENTS_REQUIRED');
  // Commit incurred checker allocation before starting the fallible child.
  // A failed native check or later revocation must never refund this budget.
  await reserveCpuTx(c,q,2);
  return {q,release};
 });
 const checked=await checkAgain(basis.q);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,computationId),release=await releaseTx(ctx,c,q,releaseId);
  if(!q.protocol||!q.runtime_receipt)fail('Y4_NATIVE_COMPLETION_BASIS_REQUIRED');
  if(sha(release)!==sha(basis.release)||sha(q.protocol)!==sha(basis.q.protocol)
   ||sha(q.correspondence)!==sha(basis.q.correspondence)||sha(q.runtime_receipt)!==sha(basis.q.runtime_receipt)
   ||sha(q.environment)!==sha(basis.q.environment))fail('Y4_S8_NATIVE_BASIS_CHANGED_DURING_CHECK');
  if(release.schema!=='finnor.confidential-economic-computation.v2')fail('Y4_COMPLETE_PRINCIPAL_ARTIFACT_REQUIRED');
  const payload={kind:'ConfidentialEconomicComputation' as const,computationId:q.id,releaseId,
   functionDigest:q.protocol.functionDigest,protocolDigest:sha(q.protocol),profileDigest:q.protocol.profileDigest,
   runtimeDigest:sha(q.environment),correspondenceDigest:sha(checked),artifactDigest:sha(release),
   outputCommitment:release.outputCommitment,effects:'NO_COMPUTATION_EFFECT_AUTHORITY' as const};
  return {payload,rightsRef:sha(q.request.function.release),root:{entityType:q.root_type,entityId:q.root_id},
   workId:q.work_id,deadlineAt:q.deadline_at.toISOString(),
   evidenceDigest:sha({payload,correspondence:checked,nativeReceipts:q.runtime_receipt}),
   independentFreshChecker:true,protectedAdmission:false as const};
 });
}
export async function resolveConfidentialNativeProof(candidate:ConfidentialCandidate){
 const ctx:PeMutationContext={auth:{tenantId:candidate.tenantId,userId:candidate.principalId,
  employeeId:candidate.principalId,role:'owner'},provenance:{sourceSystem:'S8:recipient-native-construction-review',createdBy:candidate.principalId}};
 const proof=await nativeProof(ctx,candidate.payload.computationId,candidate.payload.releaseId);
 if(sha(proof.payload)!==sha(candidate.payload)||proof.rightsRef!==candidate.rightsRef
  ||sha(proof.root)!==sha(candidate.domain.root)||proof.workId!==candidate.domain.workId
  ||Date.parse(candidate.domain.validUntil)>Date.parse(proof.deadlineAt))fail('Y4_S8_NATIVE_PAYLOAD_OR_DOMAIN_CHANGED');
 return {evidenceDigest:proof.evidenceDigest,independentFreshChecker:true,protectedAdmission:false};
}
export async function proposeConfidentialAdmission(ctx:PeMutationContext,raw:unknown){
 const input=parse(S8ProposalSchema,raw),proof=await nativeProof(ctx,input.computationId,input.releaseId),
  policy=await confidentialConsumerPolicy({tenantId:ctx.auth.tenantId,principalId:principal(ctx),rightsRef:proof.rightsRef});
 const candidate=await tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId);await releaseTx(ctx,c,q,input.releaseId);
  const key='s8-register:'+principal(ctx)+':'+input.idempotencyKey;
  const prior=(await c.query('SELECT body FROM finnor_os.y4_events WHERE tenant_id=$1 AND computation_id=$2 AND idempotency_key=$3',
   [q.tenant_id,q.id,key])).rows[0]?.body;
  if(prior){
   if(prior.releaseId!==input.releaseId||sha(prior.candidate.payload)!==sha(proof.payload))fail('Y4_IDEMPOTENCY_CONFLICT');
   return prior.candidate as ConfidentialCandidate;
  }
  const at=new Date().toISOString(),candidate=makeConfidentialCandidate({
   schema:'finnor.s8.confidential-candidate.v1',tenantId:q.tenant_id,principalId:principal(ctx),rightsRef:proof.rightsRef,
   owningInterface:'postx-y4-confidential-computation-v1',payload:proof.payload,
   domain:{root:proof.root,workId:proof.workId,validAfter:at,
    validUntil:new Date(Math.min(Date.parse(proof.deadlineAt),Date.parse(policy.validUntil))).toISOString()},
   dependencies:policy.sourcePins,proposedAt:at,protectedAdmission:false,executionAuthorityGranted:false});
  await eventTx(c,q,principal(ctx),'S8_CONFIDENTIAL_PROPOSAL_REGISTERED',key,{releaseId:input.releaseId,candidate});
  return candidate;
 });
 const ref=await proposeConfidentialCandidate(candidate,policy);
 await tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId);await releaseTx(ctx,c,q,input.releaseId);
  await eventTx(c,q,principal(ctx),'S8_CONFIDENTIAL_PROPOSED','s8-propose:'+candidate.ref.contentDigest,{releaseId:input.releaseId,revisionRef:ref});
 });
 return {candidate,revisionRef:ref,protectedAdmission:false,executionAuthorityGranted:false};
}
export async function readConfidentialAdmission(ctx:PeMutationContext,raw:unknown){
 const input=parse(S8CurrentSchema,raw);
 const candidate=await tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId);await releaseTx(ctx,c,q,input.releaseId);
  const records=(await c.query(`SELECT body->'candidate' candidate FROM finnor_os.y4_events
   WHERE tenant_id=$1 AND computation_id=$2 AND actor_id=$3 AND kind='S8_CONFIDENTIAL_PROPOSAL_REGISTERED'
    AND body->'candidate'->'ref'->>'contentDigest'=$4 LIMIT 2`,
  [q.tenant_id,q.id,principal(ctx),input.revisionRef.contentDigest])).rows;
  if(records.length!==1||sha(records[0].candidate.ref)!==sha(input.revisionRef)
   ||records[0].candidate.payload.releaseId!==input.releaseId)fail('Y4_RECIPIENT_S8_CANDIDATE_UNAVAILABLE');
  return records[0].candidate as ConfidentialCandidate;
 });
 const policy=await confidentialConsumerPolicy({tenantId:ctx.auth.tenantId,principalId:principal(ctx),rightsRef:candidate.rightsRef}),
  admission=await currentConfidentialCandidate(candidate,policy,'y4-current:'+randomUUID());
 return {current:!!admission,revisionRef:candidate.ref,admission,protectedAdmission:false,
  domainQualification:'NOT_ISSUED',executionAuthorityGranted:false};
}
