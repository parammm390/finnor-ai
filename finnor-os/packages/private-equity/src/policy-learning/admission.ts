import type {PeMutationContext} from '../types';
import {AdmissionSchema,CurrentSchema,parse,sha,fail} from './contracts';
import {tx,compilationTx,releaseTx,assertReleaseCurrentTx,eventTx,principal,rootOf,type EvaluationRow} from './store';
import type {CompilationRow} from './store';
import type {LearningRelease} from './types';
import {makeLearnedPolicyCandidate,type LearnedPolicyCandidate} from '../../../capability-evolution/src/learned-policy-port';
import {learnedPolicyConsumerPolicy,proposeLearnedPolicyCandidate,currentLearnedPolicyCandidate} from '../../../capability-evolution/src/learned-policy-consumer';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
function validityCurrent(candidate:LearnedPolicyCandidate,policy:{validAfter:string;validUntil:string}){
 const now=Date.now();
 return now>=Math.max(Date.parse(candidate.domain.validAfter),Date.parse(policy.validAfter))&&
  now<Math.min(Date.parse(candidate.domain.validUntil),Date.parse(policy.validUntil));
}
export function learningPayload(a:CompilationRow,r:LearningRelease,controllerRevision:'TRAINED'|'ORIGINAL_ABLATION'='TRAINED'){
 return {schema:'finnor.s8.learned-policy-payload.v1' as const,kind:'LearnedPolicyCapsule' as const,compilationId:a.id,releaseId:r.id,profile:'PE_FIRM_DELAYED_RECONCILIATION_V1' as const,
  controllerRevision,policyDigest:r.policyDigest,checkpointDigest:controllerRevision==='TRAINED'?r.checkpoint.digest:r.originalCheckpoint.digest,originalCheckpointDigest:r.originalCheckpoint.digest,experienceCutDigest:r.experience.cutDigest,
  rightsDigest:sha(r.experience.records.map(v=>v.consentRef)),partitionDigest:r.experience.partitionDigest,trainingConfigurationDigest:sha(r.training.configuration),
  sourceDigest:r.environment.sourceDigest,checkerDigest:r.environment.checkerDigest,lockDigest:r.environment.lockDigest,schemaDigest:r.environment.schemaDigest,runtimeDigest:sha(r.environment),
  runtime:'FINNOR_NODE_22_STRUCTURAL_SOFTMAX_V1' as const,effects:'NO_LEARNED_EFFECT_AUTHORITY' as const};
}
export async function resolveLearnedPolicyNativeProof(candidate:LearnedPolicyCandidate,evaluationId?:string){
 const ctx:PeMutationContext={auth:{tenantId:candidate.tenantId,userId:candidate.principalId,employeeId:candidate.principalId,role:'owner'}};
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,candidate.payload.compilationId),r=await releaseTx(c,a,candidate.payload.releaseId);
  const temporalBounds=await assertReleaseCurrentTx(ctx,c,a,r);
  if(a.owner_id!==candidate.principalId||sha(learningPayload(a,r,candidate.payload.controllerRevision))!==sha(candidate.payload)||candidate.rightsRef!==candidate.payload.rightsDigest||sha(rootOf(a))!==sha(candidate.domain.root))fail('X5_S8_NATIVE_PAYLOAD_SUBSTITUTION');
  if(!evaluationId){await assertAuthorityTemporalBoundsTx(c,temporalBounds);return {assignmentDigest:null,resultsDigest:null,disposition:null,evaluatorId:null};}
  const e=(await c.query<EvaluationRow>('SELECT * FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND compilation_id=$2 AND release_id=$3 AND id=$4',[a.tenant_id,a.id,r.id,evaluationId])).rows[0];
  if(!e||e.evaluator_id===a.owner_id)fail('X5_S8_NATIVE_INDEPENDENT_EVALUATION_REQUIRED');
  const evaluatorContext:PeMutationContext={auth:{tenantId:a.tenant_id,userId:e.evaluator_id,employeeId:e.evaluator_id,role:'owner'}};
  const evaluatorAuthority=await employeeAuthoritySnapshotTx(evaluatorContext.auth,c);
  if(evaluatorAuthority.validUntil)temporalBounds.push(evaluatorAuthority.validUntil);
  await compilationTx(evaluatorContext,c,a.id,'action:evaluate_learned_policy');
  const dispositions=e.result?.candidateDispositions as Record<string,string>|undefined;
  await assertAuthorityTemporalBoundsTx(c,temporalBounds);
  return {assignmentDigest:sha([...e.request.useIds,...e.request.retainedUseIds].sort()),resultsDigest:e.status==='COMPLETE'?sha(e.result):null,
   disposition:e.status==='COMPLETE'?dispositions?.[candidate.payload.checkpointDigest]??null:null,evaluatorId:e.evaluator_id};
 });
}
export async function proposeLearningAdmission(ctx:PeMutationContext,value:unknown){
 const input=parse(AdmissionSchema,value);
 const prepared=await tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:compile_learned_policy'),r=await releaseTx(c,a,input.releaseId);
  if(a.owner_id!==principal(ctx))fail('X5_ADMISSION_OWNER_REQUIRED',403);await assertReleaseCurrentTx(ctx,c,a,r);
  const prior=(await c.query("SELECT body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND idempotency_key=$3",[a.tenant_id,a.id,'s8-propose:'+input.idempotencyKey])).rows[0];
  if(prior&&prior.body.requestDigest!==sha(input))fail('X5_IDEMPOTENCY_CONFLICT');return {a,r,prior};
 });
 if(prepared.prior)return prepared.prior.body;
 const payload=learningPayload(prepared.a,prepared.r,input.controllerRevision),policy=await learnedPolicyConsumerPolicy({tenantId:prepared.a.tenant_id,principalId:prepared.a.owner_id,rightsRef:payload.rightsDigest});
 if(!policy)fail('X5_S8_INDEPENDENT_CONFIGURATION_REQUIRED',503);
 const candidate=makeLearnedPolicyCandidate({schema:'finnor.s8.learned-policy-candidate.v1',tenantId:prepared.a.tenant_id,principalId:prepared.a.owner_id,rightsRef:payload.rightsDigest,
  owningInterface:'x5-learned-policy-v1',payload,domain:{root:rootOf(prepared.a),validAfter:new Date(Math.max(Date.now(),Date.parse(policy.validAfter))).toISOString(),
   validUntil:new Date(Math.min(prepared.a.deadline_at.getTime(),Date.parse(policy.validUntil))).toISOString()},dependencies:policy.sourcePins,proposedAt:new Date().toISOString(),protectedAdmission:false,executionAuthorityGranted:false});
 const ref=await proposeLearnedPolicyCandidate(candidate,policy);
 const finalPolicy=await learnedPolicyConsumerPolicy({tenantId:prepared.a.tenant_id,principalId:prepared.a.owner_id,rightsRef:payload.rightsDigest});
 if(!finalPolicy||sha(finalPolicy)!==sha(policy))fail('X5_S8_ADMISSION_CONTEXT_CHANGED');
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:compile_learned_policy'),r=await releaseTx(c,a,input.releaseId);await assertReleaseCurrentTx(ctx,c,a,r);
  if(!validityCurrent(candidate,finalPolicy))fail('X5_S8_ADMISSION_CONTEXT_CHANGED');
  const result={releaseId:r.id,candidate,revisionRef:ref,requestDigest:sha(input),protectedAdmission:false,productionActive:false};
  await eventTx(c,a,principal(ctx),'S8_PROPOSED','s8-propose:'+input.idempotencyKey,result);return result;
 });
}
export async function readLearningAdmission(ctx:PeMutationContext,value:unknown){
 const input=parse(CurrentSchema,value);
 const pinned=await tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId),r=await releaseTx(c,a,input.releaseId);await assertReleaseCurrentTx(ctx,c,a,r);
  const rows=(await c.query<{body:{candidate:LearnedPolicyCandidate}}>("SELECT body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND kind='S8_PROPOSED'",[a.tenant_id,a.id])).rows;
  const candidate=rows.map(v=>v.body.candidate).find(v=>sha(v.ref)===sha(input.revisionRef));
  if(!candidate||sha(candidate.payload)!==sha(learningPayload(a,r,candidate.payload.controllerRevision)))fail('X5_S8_UNKNOWN_CANDIDATE');
  return {a,r,candidate};
 });
 const policy=await learnedPolicyConsumerPolicy({tenantId:pinned.a.tenant_id,principalId:pinned.a.owner_id,rightsRef:pinned.candidate.rightsRef});
 if(!policy)fail('X5_S8_INDEPENDENT_CONFIGURATION_REQUIRED',503);
 const admission=await currentLearnedPolicyCandidate(pinned.candidate,policy,'x5-current:'+crypto.randomUUID());
 let policyCurrent=false;
 try{const finalPolicy=await learnedPolicyConsumerPolicy({tenantId:pinned.a.tenant_id,principalId:pinned.a.owner_id,rightsRef:pinned.candidate.rightsRef});
  policyCurrent=!!finalPolicy&&sha(finalPolicy)===sha(policy)&&validityCurrent(pinned.candidate,finalPolicy);
 }catch{/* A stale signed owner reply cannot renew an expired/replaced policy. */}
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId);await assertReleaseCurrentTx(ctx,c,a,pinned.r);
  const current=!!admission&&policyCurrent&&validityCurrent(pinned.candidate,policy)&&Date.now()<Date.parse(admission.validUntil);
  return {current,admission:current?admission.ref:null,currentUntil:current?admission.validUntil:null,revisionRef:input.revisionRef,protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 });
}
