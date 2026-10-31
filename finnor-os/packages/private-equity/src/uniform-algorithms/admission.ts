import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PeMutationContext} from '../types';
import type {AlgorithmTheoryCapsule} from '../../../shared-types/src/algorithm-theory';
import {resolveEnterpriseAllocationProblem} from '../enterprise-allocation';
import {makeUniformAlgorithmCandidate,type UniformAlgorithmCandidate} from '../../../capability-evolution/src/uniform-algorithm-port';
import {uniformAlgorithmConsumerPolicy,proposeUniformAlgorithmCandidate,currentUniformAlgorithmCandidate} from '../../../capability-evolution/src/uniform-algorithm-consumer';
import {toolIdentity} from '../../../epistemic-runtime/src/uniform-algorithms/native';
import {allocationDerivedQuantity as q,allocationDecimal} from '../../../epistemic-runtime/src/allocation-contracts';
import {prepareCanonicalAllocationSubsetEvaluator} from '../../../epistemic-runtime/src/allocation-checker';
import {uniformProblemIdentity} from '../../../epistemic-runtime/src/uniform-algorithms/applicability';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {consumeUniformAlgorithm} from './consumer';
import {ReadSchema,digest,fail,diagnosticProfile} from './contracts';
import {tx,principal,authorizeTx,discoveryTx,commonDiscoveryTx,isTotalDiscovery,currentTx,capsuleTx,eventTx,type DiscoveryRow} from './store';
import {assignTotalEvaluation,evaluateTotalAlgorithm,proposeTotalAdmission,readTotalAdmission,resolveTotalNativeProof} from './total-admission';
export const AssignSchema=ReadSchema.extend({evaluatorId:z.string().uuid(),idempotencyKey:z.string().min(1).max(256)}).strict();
export const EvaluateSchema=z.object({evaluationId:z.string().uuid()}).strict();
export const AdmissionRequestSchema=ReadSchema.extend({idempotencyKey:z.string().min(1).max(256)}).strict();
export const AdmissionCurrentSchema=ReadSchema.extend({revisionRef:z.object({owner:z.literal('S8'),id:z.string(),version:z.string(),contentDigest:z.string()}).strict()}).strict();
export function uniformPayload(a:DiscoveryRow,c:AlgorithmTheoryCapsule){
 const rightsDigest=digest({rightsRef:a.binding.originalProblem.mandate.rightsRef,authorityRevision:a.binding.authorityRevision,work:a.binding.work});
 return {schema:'finnor.s8.uniform-algorithm-payload.v1' as const,kind:'AlgorithmTheoryCapsule' as const,discoveryId:a.id,
  profile:'INTEGER_ADDITIVE_BINARY_BOX_V1' as const,capsuleDigest:c.digest,theoremDigest:c.proofObjectDigest,implementationDigest:c.sourceDigest,
  specificationDigest:c.specification.digest,checkerDigest:digest(c.checker),runtimeDigest:c.runtime.identityDigest,sourceDigest:a.binding.environment.sourceDigest,rightsDigest,
  runtime:'NATIVE_DARWIN_ARM64_LEAN_4_34_1' as const,effects:'NO_ALGORITHM_EFFECT_AUTHORITY' as const};
}
export async function resolveUniformNativeProof(candidate:UniformAlgorithmCandidate,evaluationId?:string){
 if(candidate.schema==='finnor.s8.uniform-algorithm-candidate.v2')return resolveTotalNativeProof(candidate,evaluationId);
 const ctx:PeMutationContext={auth:{tenantId:candidate.tenantId,userId:candidate.principalId,employeeId:candidate.principalId,role:'owner'}};
 const bound=await tx(ctx,async client=>{
  const a=await discoveryTx(ctx,client,candidate.payload.discoveryId);await currentTx(ctx,client,a);const c=await capsuleTx(client,a);
  if(!c||a.status!=='CHECKED'||digest(uniformPayload(a,c))!==digest(candidate.payload)||candidate.rightsRef!==candidate.payload.rightsDigest||
   candidate.domain.root.entityId!==a.root_id||candidate.domain.root.entityType!==a.root_type||Date.parse(candidate.domain.validUntil)>a.deadline_at.getTime())fail('Y5_S8_NATIVE_PAYLOAD_SUBSTITUTION');
  const e=evaluationId?(await client.query("SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND id=$4",[a.tenant_id,a.principal_id,a.id,evaluationId])).rows[0]:null;
  if(evaluationId&&(!e||e.evaluator_id===a.principal_id||e.capsule_digest!==c.digest))fail('Y5_S8_INDEPENDENT_EVALUATION_REQUIRED');
  if(e){
   const evaluator={...ctx,auth:{...ctx.auth,userId:e.evaluator_id,employeeId:e.evaluator_id}};
   await employeeAuthoritySnapshotTx(evaluator.auth,client);
   await authorizeTx(evaluator,client,{entityType:a.root_type,entityId:a.root_id},a.work_id);
  }
  return {a,c,e};
 });
 const tool=await toolIdentity(Math.min(bound.a.deadline_at.getTime(),Date.now()+10000));
 if(tool.identityDigest!==candidate.payload.runtimeDigest)fail('Y5_S8_RUNTIME_CHANGED');
 const original=await resolveEnterpriseAllocationProblem(ctx,bound.a.request.allocation);
 if(uniformProblemIdentity(original)!==bound.a.binding.problemIdentity)fail('Y5_S8_ORIGINAL_INSTANCE_CHANGED');
 const nativeStartedAt=await tx(ctx,async c=>{const a=await discoveryTx(ctx,c,bound.a.id);await currentTx(ctx,c,a);
  if(a.generation!==bound.a.generation)fail('Y5_S8_GENERATION_CHANGED');
  if(!bound.e)return null;
  const use=(await c.query<{created_at:Date}>('SELECT created_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND idempotency_key=$4',
   [a.tenant_id,a.principal_id,a.id,'independent-evaluation:'+bound.e.id])).rows[0];
  if(bound.e.result&&!use)fail('Y5_S8_NATIVE_USE_REQUIRED');
  return use?.created_at.toISOString()??null;
 });
 const {e}=bound;
 return {assignmentDigest:e?.assignment_digest??null,resultsDigest:e?.result?digest(e.result):null,
  disposition:e?.result?.disposition??null,evaluatorId:e?.evaluator_id??null,assignmentRegisteredAt:e?.created_at?.toISOString()??null,
  nativeStartedAt,nativeCompletedAt:e?.result?.completedAt??null};
}
export async function assignUniformEvaluation(ctx:PeMutationContext,value:unknown){
 diagnosticProfile();const input=AssignSchema.parse(value);
 if(isTotalDiscovery(await tx(ctx,c=>commonDiscoveryTx(ctx,c,input.discoveryId))))return assignTotalEvaluation(ctx,input);
 return tx(ctx,async c=>{
  const a=await discoveryTx(ctx,c,input.discoveryId,true);await currentTx(ctx,c,a);const capsule=await capsuleTx(c,a);
  if(!capsule||input.evaluatorId===a.principal_id)fail('Y5_DISTINCT_EVALUATOR_REQUIRED');
  const evaluator={...ctx,auth:{...ctx.auth,userId:input.evaluatorId,employeeId:input.evaluatorId}};
  await employeeAuthoritySnapshotTx(evaluator.auth,c);await authorizeTx(evaluator,c,{entityType:a.root_type,entityId:a.root_id},a.work_id);
  const old=(await c.query('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND idempotency_key=$4',[a.tenant_id,a.principal_id,a.id,input.idempotencyKey])).rows[0];
  if(old){if(old.request_digest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');return {evaluationId:old.id,assignmentDigest:old.assignment_digest};}
  const id=randomUUID(),assignment={id,discoveryId:a.id,evaluatorId:input.evaluatorId,capsuleDigest:capsule.digest,
   originalProblemIdentity:a.binding.problemIdentity,oracle:'COMPLETE_ORIGINAL_CANONICAL_SUBSET_CHECK_MAX_20_MIN_CARDINALITY_TIE',
   nativeRoute:'Y5_SAME_LEAN_DEFINITION',counterfactualRefinementClaimed:false,protectedCustody:false};
  await c.query('INSERT INTO finnor_os.y5_evaluations(tenant_id,principal_id,id,discovery_id,evaluator_id,capsule_digest,assignment,assignment_digest,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)',
   [a.tenant_id,a.principal_id,id,a.id,input.evaluatorId,capsule.digest,JSON.stringify(assignment),digest(assignment),digest(input),input.idempotencyKey]);
  await eventTx(c,a,'assignment:'+id,'INDEPENDENT_DEVELOPMENT_ASSIGNMENT_REGISTERED',assignment);
  return {evaluationId:id,assignmentDigest:digest(assignment),protectedAdmission:false};
 });
}
export async function evaluateUniformAlgorithm(ctx:PeMutationContext,value:unknown,invocationDeadlineAt=Date.now()+30000){
 const startedAt=Date.now(),invocationDeadline=Math.min(invocationDeadlineAt,startedAt+30000);
 diagnosticProfile();const input=EvaluateSchema.parse(value);
 const assigned=await tx(ctx,async c=>{
  const e=(await c.query('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND evaluator_id=$2 AND id=$3 FOR UPDATE',[ctx.auth.tenantId,principal(ctx),input.evaluationId])).rows[0];
  if(!e)fail('Y5_EVALUATION_UNAVAILABLE',404);
  return e;
 });
 const owner:PeMutationContext={auth:{...ctx.auth,userId:assigned.principal_id,employeeId:assigned.principal_id}};
 if(isTotalDiscovery(await tx(owner,c=>commonDiscoveryTx(owner,c,assigned.discovery_id))))
  return evaluateTotalAlgorithm(ctx,input,invocationDeadline);
 const initial=await tx(owner,async c=>{const a=await discoveryTx(owner,c,assigned.discovery_id);await currentTx(owner,c,a);
  await authorizeTx(ctx,c,{entityType:a.root_type,entityId:a.root_id},a.work_id);return a;});
 if(assigned.result)return assigned.result;
 const deadlineAt=Math.min(invocationDeadline,initial.deadline_at.getTime());
 const useKey='independent-evaluation:'+assigned.id;
 const use=await consumeUniformAlgorithm(owner,{discoveryId:initial.id,allocation:initial.request.allocation,idempotencyKey:useKey,fallback:'NONE'},deadlineAt,useKey);
 let maximum:ReturnType<typeof q>|null=null,minimumCardinality=Infinity,checked=0;
 let complete=false,supported=false,preparationCount=0,oracleWallMs=0;
 let identity=assigned.assignment.originalProblemIdentity as string;
 let incompleteReason:string|null=use.completion==='INCOMPLETE'?use.reason:use.status==='CHECKED'?null:'ORIGINAL_NATIVE_USE_NOT_CHECKED';
 if(use.completion==='COMPLETE'&&use.status==='CHECKED'){
  const p=use.originalProblem,policies=p.policies;identity=uniformProblemIdentity(p);
  const oracleDeadlineAt=Math.min(deadlineAt,Date.parse(use.cost.originalDeadline));
  complete=policies.length<=20&&Date.now()<oracleDeadlineAt;
  const oracleStartedAt=Date.now();
  if(complete){
   const oracle=prepareCanonicalAllocationSubsetEvaluator(p);preparationCount=oracle.preparationCount;
   for(let mask=0;mask<2**policies.length;mask++){
    if(Date.now()>=oracleDeadlineAt){complete=false;break;}
    if(mask&&mask%64===0){
     await new Promise<void>(yes=>setImmediate(yes));
     if(Date.now()>=oracleDeadlineAt){complete=false;break;}
    }
    const selected=policies.filter((_,i)=>mask&2**i).map(policy=>policy.ref.id),check=oracle.check(selected);checked++;
    if(!check.feasible||check.objective===null)continue;const objective=q(check.objective);
    if(maximum===null||objective.compare(maximum)>0){maximum=objective;minimumCardinality=selected.length;}
    else if(objective.compare(maximum)===0)minimumCardinality=Math.min(minimumCardinality,selected.length);
   }
  }
  complete=complete&&Date.now()<oracleDeadlineAt;
  oracleWallMs=Date.now()-oracleStartedAt;
  supported=complete&&identity===assigned.assignment.originalProblemIdentity&&maximum!==null&&use.result.check.objective!==null&&q(use.result.check.objective).compare(maximum)===0&&use.result.check.selectedPolicyIds.length===minimumCardinality&&use.execution.checker.kernelReplay===true;
  if(!supported)incompleteReason=complete?'ORIGINAL_ORACLE_OR_NATIVE_CORRESPONDENCE_NOT_ESTABLISHED':'ORIGINAL_ORACLE_LIMIT_OR_DEADLINE';
 }
 const result={schema:'finnor.y5.independent-native-evaluation.v1',evaluationId:assigned.id,evaluatorId:principal(ctx),
  assignmentDigest:assigned.assignment_digest,useId:use.useId,useDigest:use.completion==='COMPLETE'?use.digest:null,useCompletion:use.completion,originalProblemIdentity:identity,
  originalUseDeadline:use.completion==='COMPLETE'?use.cost.originalDeadline:use.originalDeadline,
  status:supported?'CHECKED_DEVELOPMENT':'UNKNOWN',incompleteReason,automaticReexecution:false,
  oracle:{checkedSubsets:checked,complete,preparationCount,wallMs:oracleWallMs,maximum:maximum?allocationDecimal(maximum):null,minimumCardinality:Number.isFinite(minimumCardinality)?minimumCardinality:null},
  disposition:supported?'SUPPORTED_DEVELOPMENT':'REFUSED_OR_INCOMPLETE',startedAt:new Date(startedAt).toISOString(),completedAt:new Date().toISOString(),
  qualification:'PREREGISTERED_PUBLIC_NATIVE_KERNEL_AND_ORIGINAL_S5_REPLAY_NOT_PROTECTED',
  completeMoney:null,aggregatePeakBytes:null,protectedAdmission:false,executionAuthorityGranted:false};
 return tx(owner,async c=>{
  const a=await discoveryTx(owner,c,initial.id,true);await currentTx(owner,c,a);await authorizeTx(ctx,c,{entityType:a.root_type,entityId:a.root_id},a.work_id);
  const e=(await c.query('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE',[a.tenant_id,a.principal_id,assigned.id])).rows[0];
  if(e.result)return e.result;
  await c.query('UPDATE finnor_os.y5_evaluations SET result=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[a.tenant_id,a.principal_id,assigned.id,JSON.stringify(result)]);
  await eventTx(c,a,'evaluation:'+assigned.id,'INDEPENDENT_DEVELOPMENT_EVALUATION_COMPLETED',result);return result;
 });
}
export async function proposeUniformAdmission(ctx:PeMutationContext,value:unknown){
 diagnosticProfile();const input=AdmissionRequestSchema.parse(value);
 if(isTotalDiscovery(await tx(ctx,c=>commonDiscoveryTx(ctx,c,input.discoveryId))))return proposeTotalAdmission(ctx,input);
 const prepared=await tx(ctx,async c=>{const a=await discoveryTx(ctx,c,input.discoveryId);await currentTx(ctx,c,a);const capsule=await capsuleTx(c,a);if(!capsule)fail('Y5_CHECKED_CAPSULE_REQUIRED');return {a,capsule};});
 const {a,capsule}=prepared,payload=uniformPayload(a,capsule),scope={tenantId:a.tenant_id,principalId:a.principal_id,rightsRef:payload.rightsDigest};
 const policy=await uniformAlgorithmConsumerPolicy(scope);if(!policy)fail('Y5_S8_INDEPENDENT_CONFIGURATION_REQUIRED',503);
 const registration=await tx(ctx,async c=>{
  const fresh=await discoveryTx(ctx,c,a.id,true);await currentTx(ctx,c,fresh);
  const row=(await c.query("SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4",
   [a.tenant_id,a.principal_id,a.id,'s8-proposal-register:'+input.idempotencyKey])).rows[0];
  if(row){
   if(row.body.requestDigest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');
   if(row.body.policyDigest!==digest(policy)||digest(row.body.candidate.payload)!==digest(payload))fail('Y5_S8_ORIGINAL_CONFIGURATION_CHANGED');
   return row.body as {candidate:UniformAlgorithmCandidate;requestDigest:string;policyDigest:string};
  }
  const candidate=makeUniformAlgorithmCandidate({schema:'finnor.s8.uniform-algorithm-candidate.v1',...scope,owningInterface:'y5-uniform-algorithm-v1',payload,
   domain:{root:{entityType:a.root_type,entityId:a.root_id},validAfter:new Date(Math.max(Date.now(),Date.parse(policy.validAfter))).toISOString(),
    validUntil:new Date(Math.min(a.deadline_at.getTime(),Date.parse(policy.validUntil))).toISOString()},
   dependencies:policy.sourcePins,proposedAt:new Date().toISOString(),protectedAdmission:false,executionAuthorityGranted:false});
  const body={candidate,requestDigest:digest(input),policyDigest:digest(policy)};
  await eventTx(c,a,'s8-proposal-register:'+input.idempotencyKey,'S8_PROPOSAL_REGISTERED',body);return body;
 });
 const {candidate}=registration;
 const revisionRef=await proposeUniformAlgorithmCandidate(candidate,policy);
 const freshPolicy=await uniformAlgorithmConsumerPolicy(scope);if(!freshPolicy||digest(freshPolicy)!==digest(policy))fail('Y5_S8_CONFIGURATION_CHANGED');
 return tx(ctx,async c=>{const fresh=await discoveryTx(ctx,c,a.id,true);await currentTx(ctx,c,fresh);
  const prior=(await c.query("SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4",
   [a.tenant_id,a.principal_id,a.id,'s8-propose:'+input.idempotencyKey])).rows[0];
  if(prior){if(prior.body.requestDigest!==digest(input)||digest(prior.body.candidate)!==digest(candidate))fail('Y5_IDEMPOTENCY_CONFLICT');return prior.body;}
  const body={candidate,revisionRef,requestDigest:digest(input),protectedAdmission:false,productionActive:false};
  await eventTx(c,a,'s8-propose:'+input.idempotencyKey,'S8_UNIFORM_ALGORITHM_PROPOSED',body);return body;});
}
export async function readUniformAdmission(ctx:PeMutationContext,value:unknown){
 diagnosticProfile();const input=AdmissionCurrentSchema.parse(value);
 if(isTotalDiscovery(await tx(ctx,c=>commonDiscoveryTx(ctx,c,input.discoveryId))))return readTotalAdmission(ctx,input);
 const pinned=await tx(ctx,async c=>{const a=await discoveryTx(ctx,c,input.discoveryId);await currentTx(ctx,c,a);
  const rows=(await c.query<{body:{candidate:UniformAlgorithmCandidate}}>("SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND kind='S8_UNIFORM_ALGORITHM_PROPOSED'",[a.tenant_id,a.principal_id,a.id])).rows;
  const candidate=rows.map(r=>r.body.candidate).find(c=>digest(c.ref)===digest(input.revisionRef));if(!candidate)fail('Y5_S8_UNKNOWN_CANDIDATE');return {a,candidate};});
 const scope={tenantId:pinned.a.tenant_id,principalId:pinned.a.principal_id,rightsRef:pinned.candidate.rightsRef},policy=await uniformAlgorithmConsumerPolicy(scope);
 if(!policy)fail('Y5_S8_INDEPENDENT_CONFIGURATION_REQUIRED',503);
 const admission=await currentUniformAlgorithmCandidate(pinned.candidate,policy),finalPolicy=await uniformAlgorithmConsumerPolicy(scope);
 return tx(ctx,async c=>{const a=await discoveryTx(ctx,c,pinned.a.id);await currentTx(ctx,c,a);
  const current=!!admission&&!!finalPolicy&&digest(finalPolicy)===digest(policy)&&Date.now()<Date.parse(admission.validUntil);
  return {current,currentUntil:current?admission.validUntil:null,admission:current?admission.ref:null,revisionRef:input.revisionRef,
   protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};});
}
