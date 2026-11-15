import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import type {PeMutationContext} from '../types';
import type {TotalAlgorithmTheoryCapsule} from '../../../shared-types/src/total-algorithm-theory';
import {makeUniformAlgorithmCandidate,parseUniformAlgorithmCandidate,type TotalAlgorithmCandidate} from '../../../capability-evolution/src/uniform-algorithm-port';
import {uniformAlgorithmConsumerPolicy,proposeUniformAlgorithmCandidate,currentUniformAlgorithmCandidate} from '../../../capability-evolution/src/uniform-algorithm-consumer';
import {toolIdentity} from '../../../epistemic-runtime/src/uniform-algorithms/native';
import {LedgerFault} from '../../../governed-execution/src/protocol';
import {checkTotalTaskResult} from '../allocation-total-task';
import {consumeTotalUse,type TotalCompletedUse} from './total-consumer';
import {tx,principal,authorizeTx,eventTx} from './store';
import {totalDiscoveryTx,currentTotalTx,resolveTotalBinding,assertTotalResolutionTx,totalCapsuleTx,type TotalDiscoveryRow} from './total-owner';
import {ReadSchema,digest,fail,diagnosticProfile,UniformOwnerError} from './contracts';

const id=z.string().uuid(),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime();
const AssignSchema=ReadSchema.extend({evaluatorId:id,idempotencyKey:z.string().min(1).max(256)}).strict();
const EvaluateSchema=z.object({evaluationId:id}).strict();
const ProposalSchema=ReadSchema.extend({idempotencyKey:z.string().min(1).max(256)}).strict();
const AdmissionSchema=ReadSchema.extend({revisionRef:z.object({owner:z.literal('S8'),id:z.string(),version:z.string(),contentDigest:hex}).strict()}).strict();
const AssignmentSchema=z.object({
 schema:z.literal('finnor.y5.total-evaluation-assignment.v2'),id,discoveryId:id,evaluatorId:id,
 capsuleDigest:hex,definitionDigest:hex,specificationDigest:hex,originalTaskDigest:hex,originalTaskWorkId:id,
 oracle:z.literal('ORIGINAL_TYPED_TASK_ALL_PREFIXES_AND_EXACT_OWNER_EXPECTED_KERNEL_TYPE'),
 nativeRoute:z.literal('Y5_SAME_LEAN_TOTAL_DEFINITION'),registeredAt:instant,validUntil:instant,
 invocationWallMs:z.literal(28500),useIdempotencyKey:z.string().min(1).max(256),
 counterfactualRefinementClaimed:z.literal(false),protectedCustody:z.literal(false),allocationOptimalityClaimed:z.literal(false),
}).strict();
type Assignment=z.infer<typeof AssignmentSchema>;
interface EvaluationRow{
 tenant_id:string;principal_id:string;id:string;discovery_id:string;evaluator_id:string;capsule_digest:string;
 assignment:Assignment;assignment_digest:string;request_digest:string;idempotency_key:string;result:TotalEvaluation|null;created_at:Date;
}
interface TotalEvaluation{
 schema:'finnor.y5.independent-total-evaluation.v2';evaluationId:string;evaluatorId:string;assignmentDigest:string;
 capsuleDigest:string;definitionDigest:string;originalTaskDigest:string;useId:string|null;useDigest:string|null;
 useCompletion:'COMPLETE'|'INCOMPLETE'|'NOT_STARTED';originalUseDeadline:string;
 status:'CHECKED_DEVELOPMENT'|'UNKNOWN';disposition:'SUPPORTED_DEVELOPMENT'|'REFUSED_OR_INCOMPLETE';
 oracle:{feasible:boolean;includesEmptyPrefix:boolean;prefixCount:number;referenceDigest:string|null;exactOwnerExpectedType:boolean;
  suppliedProofObjectReplayed:boolean;allocationOptimalityClaimed:false};
 incompleteReason:string|null;automaticReexecution:false;startedAt:string;completedAt:string;
 qualification:'PREREGISTERED_PUBLIC_NATIVE_KERNEL_AND_ORIGINAL_TYPED_TASK_NOT_PROTECTED';
 completeMoney:null;completeHumanSeconds:null;aggregatePeakBytes:null;protectedAdmission:false;executionAuthorityGranted:false;
}
async function s8Reply<T>(call:Promise<T>):Promise<T>{
 try{return await call;}
 catch(error){
  if(error instanceof LedgerFault||error instanceof UniformOwnerError||error instanceof z.ZodError)throw error;
  fail('Y5_S8_TRANSPORT_UNAVAILABLE',503);
 }
}
function ownerContext(ctx:PeMutationContext,ownerId:string):PeMutationContext{
 return {auth:{...ctx.auth,userId:ownerId,employeeId:ownerId,role:'owner'}};
}
function validateAssignment(e:EvaluationRow,a:TotalDiscoveryRow,capsule:TotalAlgorithmTheoryCapsule){
 const assignment=AssignmentSchema.parse(e.assignment);
 if(e.id!==assignment.id||e.discovery_id!==a.id||assignment.discoveryId!==a.id||e.principal_id!==a.principal_id||
  e.evaluator_id!==assignment.evaluatorId||e.evaluator_id===a.principal_id||e.capsule_digest!==capsule.digest||
  assignment.capsuleDigest!==capsule.digest||digest(assignment)!==e.assignment_digest||
  assignment.originalTaskWorkId!==a.request.taskWorkId||assignment.originalTaskDigest!==digest(a.binding.originalTask)||
  assignment.specificationDigest!==digest(a.binding.specification)||assignment.definitionDigest!==a.binding.specification.definitionDigest)
  fail('Y5_TOTAL_EVALUATION_ASSIGNMENT_BINDING');
 return assignment;
}
async function evaluatorTx(ctx:PeMutationContext,c:PoolClient,a:TotalDiscoveryRow,evaluatorId:string){
 if(evaluatorId===a.principal_id)fail('Y5_DISTINCT_EVALUATOR_REQUIRED');
 const evaluator=ownerContext(ctx,evaluatorId);
 await employeeAuthoritySnapshotTx(evaluator.auth,c);
 await authorizeTx(evaluator,c,{entityType:a.root_type,entityId:a.root_id},a.work_id);
 await authorizeTx(evaluator,c,{entityType:a.root_type,entityId:a.root_id},a.request.taskWorkId);
}
async function prepareOnce(ctx:PeMutationContext,discoveryId:string){
 const bound=await tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,discoveryId);await currentTotalTx(ctx,c,a,'ADMISSION');
  const capsule=await totalCapsuleTx(c,a);
  if(a.status!=='CHECKED'||!capsule)fail('Y5_CHECKED_CAPSULE_REQUIRED');return {a,capsule};
 });
 return {...bound,resolution:await resolveTotalBinding(ctx,bound.a,'ADMISSION')};
}
type Prepared=Awaited<ReturnType<typeof prepareOnce>>;
const preparing=new Map<string,{startedAt:number;result:Promise<Prepared>}>();
const sharedPreparationWindowMs=2000;
/** Requests for one discovery that arrive together would each repeat the same owner resolution on this process's
 * single event loop. A caller joins only a resolution that began moments ago, and each caller's own registration
 * transaction still fences the shared result, so a duplicate can act on nothing the first could not. */
function prepared(ctx:PeMutationContext,discoveryId:string):Promise<Prepared>{
 const {tenantId,userId,employeeId,role,deliverySession}=ctx.auth;
 const key=[tenantId,userId,employeeId??'',role,deliverySession?.sessionId??'',discoveryId].join('\u0000');
 const running=preparing.get(key);
 if(running&&Date.now()-running.startedAt<sharedPreparationWindowMs)return running.result;
 const entry={startedAt:Date.now(),result:prepareOnce(ctx,discoveryId)};
 preparing.set(key,entry);
 const settled=()=>{if(preparing.get(key)===entry)preparing.delete(key);};
 entry.result.then(settled,settled);
 return entry.result;
}
export function totalUniformPayload(a:TotalDiscoveryRow,c:TotalAlgorithmTheoryCapsule){
 if(c.schema!=='finnor.algorithm-theory-capsule.v2')fail('Y5_TOTAL_V2_CAPSULE_REQUIRED');
 const rightsDigest=digest({authorityRevision:a.binding.authorityRevision,dependencies:a.binding.dependencies,
  specificationWork:a.binding.work,taskWork:a.binding.originalTask.work,
  specificationRef:a.binding.specification.sourceRef,taskRef:a.binding.originalTask.sourceRef});
 return {schema:'finnor.s8.uniform-algorithm-payload.v2' as const,kind:'AlgorithmTheoryCapsule' as const,discoveryId:a.id,
  profile:'CLOSED_TOTAL_FOLD_INTEGER_LISTS_V2' as const,capsuleDigest:c.digest,theoremDigest:c.proofObjectDigest,
  implementationDigest:c.sourceDigest,specificationDigest:c.specification.definitionDigest,checkerDigest:digest(c.checker),
  runtimeDigest:c.runtime.identityDigest,sourceDigest:a.binding.environment.sourceDigest,rightsDigest,
  specificationSourceDigest:a.binding.specification.sourceRef.contentDigest,taskWorkId:a.request.taskWorkId,
  taskSourceDigest:a.binding.originalTask.sourceRef.contentDigest,episodeCutDigest:a.binding.episodeCut.cutDigest,
  interpreterDigest:c.interpreterDigest,interpreterProofObjectDigest:c.interpreterProofObjectDigest,
  runtime:'NATIVE_DARWIN_ARM64_LEAN_4_34_1' as const,effects:'NO_ALGORITHM_EFFECT_AUTHORITY' as const,
  quality:'EXACT_LEAST_INITIAL_STATE_NOT_ALLOCATION_OPTIMUM' as const};
}
export async function assignTotalEvaluation(ctx:PeMutationContext,value:unknown){
 diagnosticProfile();const input=AssignSchema.parse(value),bound=await prepared(ctx,input.discoveryId);
 return tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,input.discoveryId,true);await currentTotalTx(ctx,c,a,'ADMISSION');
  await assertTotalResolutionTx(ctx,c,bound.resolution);await evaluatorTx(ctx,c,a,input.evaluatorId);
  const old=(await c.query<EvaluationRow>('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND idempotency_key=$4',
   [a.tenant_id,a.principal_id,a.id,input.idempotencyKey])).rows[0];
  if(old){if(old.request_digest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');validateAssignment(old,a,bound.capsule);
   return {evaluationId:old.id,assignmentDigest:old.assignment_digest,protectedAdmission:false};}
  const evaluationId=randomUUID(),acceptance=a.binding.specification.acceptance;
  const validUntil=new Date(Math.min(Date.now()+3600000,...('validUntil'in acceptance?[Date.parse(acceptance.validUntil)]:[]))).toISOString();
  const assignment:Assignment={schema:'finnor.y5.total-evaluation-assignment.v2',id:evaluationId,discoveryId:a.id,evaluatorId:input.evaluatorId,
   capsuleDigest:bound.capsule.digest,definitionDigest:a.binding.specification.definitionDigest,specificationDigest:digest(a.binding.specification),
   originalTaskDigest:digest(a.binding.originalTask),originalTaskWorkId:a.request.taskWorkId,
   oracle:'ORIGINAL_TYPED_TASK_ALL_PREFIXES_AND_EXACT_OWNER_EXPECTED_KERNEL_TYPE',nativeRoute:'Y5_SAME_LEAN_TOTAL_DEFINITION',
   registeredAt:new Date().toISOString(),validUntil,invocationWallMs:28500,useIdempotencyKey:'total-independent-evaluation:'+evaluationId,
   counterfactualRefinementClaimed:false,protectedCustody:false,allocationOptimalityClaimed:false};
  await c.query('INSERT INTO finnor_os.y5_evaluations(tenant_id,principal_id,id,discovery_id,evaluator_id,capsule_digest,assignment,assignment_digest,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)',
   [a.tenant_id,a.principal_id,evaluationId,a.id,input.evaluatorId,bound.capsule.digest,JSON.stringify(assignment),digest(assignment),digest(input),input.idempotencyKey]);
  await eventTx(c,a,'assignment:'+evaluationId,'INDEPENDENT_TOTAL_ASSIGNMENT_REGISTERED',assignment);
  return {evaluationId,assignmentDigest:digest(assignment),protectedAdmission:false};
 });
}
function checkedUse(use:TotalCompletedUse,a:TotalDiscoveryRow,assignment:Assignment,capsule:TotalAlgorithmTheoryCapsule){
 const {digest:claimed,...body}=use;
 if(claimed!==digest(body)||use.schema!=='finnor.s5.total-method-use.v2'||use.completion!=='COMPLETE'||use.status!=='CHECKED'||
  use.actualMethod!=='Y5_SAME_LEAN_TOTAL_DEFINITION'||use.capsuleDigest!==assignment.capsuleDigest||
  use.taskBindingDigest!==assignment.originalTaskDigest||use.specificationDigest!==assignment.specificationDigest||
  use.taskWorkId!==assignment.originalTaskWorkId)fail('Y5_TOTAL_EVALUATION_NATIVE_USE_BINDING');
 const checker=use.execution.checked;
 if(!checker.exactOwnerExpectedType||!checker.suppliedProofObjectReplayed||!checker.loadBearingLemmaInProof||
  !checker.countedDenotationAgreement||!checker.allSizeOperationBound||checker.definitionDigest!==assignment.definitionDigest||
  use.execution.executions.length!==1||digest(use.execution.executions[0])!==digest(use.result))
  fail('Y5_TOTAL_EVALUATION_KERNEL_EXPECTED_TYPE_REQUIRED');
 const semanticFields=['schema','programDigest','propositionDigest','sourceDigest','proofObjectDigest','interpreterDigest',
  'interpreterProofObjectDigest','runtimeDigest','modelSourceCorrespondence','modelSourcePinDigest','importInventoryDigest',
  'imports','axioms','independentImplementation','protectedCustody','trustPolicyApproval'] as const;
 if(semanticFields.some(field=>digest(checker[field])!==digest(capsule.checker[field]))||
  checker.proofObjectDigest!==capsule.proofObjectDigest||checker.runtimeDigest!==capsule.runtime.identityDigest)
  fail('Y5_TOTAL_EVALUATION_SUPPLIED_CAPSULE_PROOF_OR_RUNTIME_SUBSTITUTION');
 const reference=checkTotalTaskResult(a.binding.specification,a.binding.originalTask,use.result.value);
 if(digest(reference)!==digest(use.originalCheck)||reference.prefixes.length!==a.binding.originalTask.instance.values.length+1)
  fail('Y5_TOTAL_EVALUATION_ORIGINAL_TYPED_ORACLE');
 return {feasible:reference.feasible,includesEmptyPrefix:true,prefixCount:reference.prefixes.length,
  referenceDigest:digest(reference),exactOwnerExpectedType:true,suppliedProofObjectReplayed:true,allocationOptimalityClaimed:false as const};
}
export async function evaluateTotalAlgorithm(ctx:PeMutationContext,value:unknown,invocationDeadlineAt=Date.now()+28500){
 const startedAt=Date.now(),input=EvaluateSchema.parse(value);diagnosticProfile();
 const assigned=await tx(ctx,async c=>{
  const e=(await c.query<EvaluationRow>('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND evaluator_id=$2 AND id=$3',
   [ctx.auth.tenantId,principal(ctx),input.evaluationId])).rows[0];
  if(!e)fail('Y5_EVALUATION_UNAVAILABLE',404);return e;
 });
 const owner=ownerContext(ctx,assigned.principal_id),bound=await prepared(owner,assigned.discovery_id),
  assignment=validateAssignment(assigned,bound.a,bound.capsule);
 const deadlineAt=Math.min(invocationDeadlineAt,startedAt+assignment.invocationWallMs,Date.parse(assignment.validUntil));
 const registration=await tx(owner,async c=>{
  const a=await totalDiscoveryTx(owner,c,bound.a.id,true);await currentTotalTx(owner,c,a,'ADMISSION');
  await assertTotalResolutionTx(owner,c,bound.resolution);await evaluatorTx(ctx,c,a,principal(ctx));
  const e=(await c.query<EvaluationRow>('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE',
   [a.tenant_id,a.principal_id,assigned.id])).rows[0];
  if(!e)fail('Y5_EVALUATION_UNAVAILABLE',404);validateAssignment(e,a,bound.capsule);
  if(e.result)return {replay:e.result,started:false,deadlineAt};
  const prior=(await c.query<{body:{startedAt:string;deadlineAt:string}}>('SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4',
   [a.tenant_id,a.principal_id,a.id,'total-evaluation-start:'+assigned.id])).rows[0];
  if(prior)return {replay:null,started:false,deadlineAt:Date.parse(prior.body.deadlineAt)};
  if(Date.now()>=deadlineAt)fail('Y5_TOTAL_EVALUATION_ORIGINAL_DEADLINE');
  await eventTx(c,a,'total-evaluation-start:'+assigned.id,'INDEPENDENT_TOTAL_EVALUATION_STARTED',
   {evaluationId:assigned.id,assignmentDigest:assigned.assignment_digest,evaluatorId:principal(ctx),startedAt:new Date(startedAt).toISOString(),
    deadlineAt:new Date(deadlineAt).toISOString(),automaticReexecution:false,originalFiniteUseAllowance:true});
  return {replay:null,started:true,deadlineAt};
 });
 if(registration.replay)return registration.replay;
 if(!registration.started)return {schema:'finnor.y5.interrupted-total-evaluation.v2',evaluationId:assigned.id,status:'UNKNOWN',
  disposition:'REFUSED_OR_INCOMPLETE',reason:'DURABLE_STARTED_EVALUATION_NO_RESULT_NO_AUTOMATIC_REEXECUTION',
  originalDeadline:new Date(registration.deadlineAt).toISOString(),automaticReexecution:false,unknownPhysicalCostPossible:true,protectedAdmission:false};
 let use:Awaited<ReturnType<typeof consumeTotalUse>>['use']|null=null,reason:string|null=null;
 let publication:Awaited<ReturnType<typeof consumeTotalUse>>['publication']=null;
 let oracle:TotalEvaluation['oracle']={feasible:false,includesEmptyPrefix:false,prefixCount:0,referenceDigest:null,
  exactOwnerExpectedType:false,suppliedProofObjectReplayed:false,allocationOptimalityClaimed:false};
 try{
  ({use,publication}=await consumeTotalUse(owner,{discoveryId:bound.a.id,taskWorkId:assignment.originalTaskWorkId,
   idempotencyKey:assignment.useIdempotencyKey},registration.deadlineAt,
   {evaluationUseKey:assignment.useIdempotencyKey,admitted:{discovery:bound.a,resolution:bound.resolution}}));
  if(use.completion!=='COMPLETE'||use.status!=='CHECKED')reason='ORIGINAL_TYPED_NATIVE_USE_NOT_CHECKED';
  else oracle=checkedUse(use,bound.a,assignment,bound.capsule);
 }catch(error){reason=(error as Error).message;}
 const supported=reason===null&&oracle.feasible&&Date.now()<registration.deadlineAt;
 if(!supported&&!reason)reason='ORIGINAL_TYPED_EVALUATION_DEADLINE';
 const result:TotalEvaluation={schema:'finnor.y5.independent-total-evaluation.v2',evaluationId:assigned.id,evaluatorId:principal(ctx),
  assignmentDigest:assigned.assignment_digest,capsuleDigest:bound.capsule.digest,definitionDigest:assignment.definitionDigest,
  originalTaskDigest:assignment.originalTaskDigest,useId:use?.useId??null,useDigest:use?.completion==='COMPLETE'?use.digest:null,
  useCompletion:use?.completion??'NOT_STARTED',originalUseDeadline:new Date(registration.deadlineAt).toISOString(),
  status:supported?'CHECKED_DEVELOPMENT':'UNKNOWN',disposition:supported?'SUPPORTED_DEVELOPMENT':'REFUSED_OR_INCOMPLETE',
  oracle,incompleteReason:reason,automaticReexecution:false,startedAt:new Date(startedAt).toISOString(),completedAt:new Date().toISOString(),
  qualification:'PREREGISTERED_PUBLIC_NATIVE_KERNEL_AND_ORIGINAL_TYPED_TASK_NOT_PROTECTED',
  completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,protectedAdmission:false,executionAuthorityGranted:false};
 // A CHECKED use re-resolved the owner binding after its native work and published on it moments ago.
 const resolution=publication??await resolveTotalBinding(owner,bound.a,'ADMISSION');
 return tx(owner,async c=>{
  const a=await totalDiscoveryTx(owner,c,bound.a.id,true);await currentTotalTx(owner,c,a,'ADMISSION');
  await assertTotalResolutionTx(owner,c,resolution);await evaluatorTx(ctx,c,a,principal(ctx));
  const e=(await c.query<EvaluationRow>('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE',
   [a.tenant_id,a.principal_id,assigned.id])).rows[0];
  if(!e)fail('Y5_EVALUATION_UNAVAILABLE',404);validateAssignment(e,a,bound.capsule);
  if(e.result)return e.result;
  if(supported&&(a.generation!==bound.a.generation||Date.now()>=registration.deadlineAt))fail('Y5_TOTAL_EVALUATION_PUBLICATION_FENCE');
  await c.query('UPDATE finnor_os.y5_evaluations SET result=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
   [a.tenant_id,a.principal_id,assigned.id,JSON.stringify(result)]);
  await eventTx(c,a,'evaluation:'+assigned.id,'INDEPENDENT_TOTAL_EVALUATION_COMPLETED',{result,resultDigest:digest(result)});
  return result;
 });
}
export async function resolveTotalNativeProof(candidate:TotalAlgorithmCandidate,evaluationId?:string){
 const ctx:PeMutationContext={auth:{tenantId:candidate.tenantId,userId:candidate.principalId,employeeId:candidate.principalId,role:'owner'}};
 const bound=await prepared(ctx,candidate.payload.discoveryId),{a,capsule}=bound;
 if(digest(totalUniformPayload(a,capsule))!==digest(candidate.payload)||candidate.rightsRef!==candidate.payload.rightsDigest||
  candidate.domain.root.entityId!==a.root_id||candidate.domain.root.entityType!==a.root_type)
  fail('Y5_S8_TOTAL_NATIVE_PAYLOAD_SUBSTITUTION');
 const semantic=a.binding.specification.acceptance;
 if('validUntil'in semantic&&Date.parse(candidate.domain.validUntil)>Date.parse(semantic.validUntil))fail('Y5_S8_TOTAL_SEMANTIC_VALIDITY');
 const evidence=await tx(ctx,async c=>{
  const current=await totalDiscoveryTx(ctx,c,a.id);await currentTotalTx(ctx,c,current,'ADMISSION');
  await assertTotalResolutionTx(ctx,c,bound.resolution);
  const e=evaluationId?(await c.query<EvaluationRow>('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND id=$4',
   [a.tenant_id,a.principal_id,a.id,evaluationId])).rows[0]:null;
  if(evaluationId&&!e)fail('Y5_S8_INDEPENDENT_EVALUATION_REQUIRED');
  if(e){
   const assignment=validateAssignment(e,current,capsule);await evaluatorTx(ctx,c,current,e.evaluator_id);
   if(Date.now()>=Date.parse(assignment.validUntil))fail('Y5_S8_TOTAL_ASSIGNMENT_EXPIRED');
   const started=(await c.query<{body:{startedAt:string;deadlineAt:string;assignmentDigest:string}}>(
    'SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4',
    [a.tenant_id,a.principal_id,a.id,'total-evaluation-start:'+e.id])).rows[0]?.body;
   if(e.result){
    const r=e.result;
    if(!started||started.assignmentDigest!==e.assignment_digest||r.schema!=='finnor.y5.independent-total-evaluation.v2'||
     r.evaluationId!==e.id||r.evaluatorId!==e.evaluator_id||r.assignmentDigest!==e.assignment_digest||
     r.capsuleDigest!==capsule.digest||r.originalTaskDigest!==assignment.originalTaskDigest||r.startedAt!==started.startedAt)
     fail('Y5_S8_TOTAL_EVALUATION_RESULT_BINDING');
    if(r.disposition==='SUPPORTED_DEVELOPMENT'){
     const u=(await c.query<{body:TotalCompletedUse;content_digest:string;request:{idempotencyKey:string};deadline_at:Date}>(
      'SELECT body,content_digest,request,deadline_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND id=$4 AND status=$5',
      [a.tenant_id,a.principal_id,a.id,r.useId,'COMPLETE'])).rows[0];
     if(!u||u.content_digest!==r.useDigest||u.body.digest!==r.useDigest||u.request.idempotencyKey!==assignment.useIdempotencyKey||
      u.deadline_at.toISOString()!==started.deadlineAt||r.originalUseDeadline!==started.deadlineAt||
      Date.parse(r.completedAt)>=Date.parse(started.deadlineAt)||digest(checkedUse(u.body,current,assignment,capsule))!==digest(r.oracle))
      fail('Y5_S8_TOTAL_EVALUATION_USE_OR_ORACLE_SUBSTITUTION');
    }
   }
  }
  return {e};
 });
 const tool=await toolIdentity(Date.now()+10000);
 if(tool.identityDigest!==candidate.payload.runtimeDigest)fail('Y5_S8_RUNTIME_CHANGED');
 const resolution=await resolveTotalBinding(ctx,a,'ADMISSION');
 const nativeStartedAt=await tx(ctx,async c=>{
  const fresh=await totalDiscoveryTx(ctx,c,a.id);await currentTotalTx(ctx,c,fresh,'ADMISSION');await assertTotalResolutionTx(ctx,c,resolution);
  if(fresh.generation!==a.generation)fail('Y5_S8_GENERATION_CHANGED');
  const e=evidence.e;if(!e)return null;await evaluatorTx(ctx,c,fresh,e.evaluator_id);
  const started=(await c.query<{body:{startedAt:string}}>(
   'SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4',
   [a.tenant_id,a.principal_id,a.id,'total-evaluation-start:'+e.id])).rows[0]?.body;
  const use=(await c.query<{created_at:Date}>(
   'SELECT created_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND idempotency_key=$4',
   [a.tenant_id,a.principal_id,a.id,e.assignment.useIdempotencyKey])).rows[0];
  return use&&(!started||use.created_at.getTime()<Date.parse(started.startedAt))?use.created_at.toISOString():started?.startedAt??null;
 });
 const {e}=evidence;
 return {assignmentDigest:e?.assignment_digest??null,resultsDigest:e?.result?digest(e.result):null,
  disposition:e?.result?.disposition??null,evaluatorId:e?.evaluator_id??null,assignmentRegisteredAt:e?.created_at?.toISOString()??null,
  nativeStartedAt,nativeCompletedAt:e?.result?.completedAt??null,
  validUntil:new Date(Math.min(Date.parse(candidate.domain.validUntil),...('validUntil'in semantic?[Date.parse(semantic.validUntil)]:[]),
   ...(e?[Date.parse(e.assignment.validUntil)]:[]))).toISOString()};
}
export async function proposeTotalAdmission(ctx:PeMutationContext,value:unknown){
 diagnosticProfile();const input=ProposalSchema.parse(value),bound=await prepared(ctx,input.discoveryId),
  payload=totalUniformPayload(bound.a,bound.capsule),scope={tenantId:bound.a.tenant_id,principalId:bound.a.principal_id,rightsRef:payload.rightsDigest};
 const policy=await uniformAlgorithmConsumerPolicy(scope);
 if(!policy)fail('Y5_S8_INDEPENDENT_CONFIGURATION_REQUIRED',503);
 if(policy.schema!=='finnor.s8.uniform-algorithm-consumer-policy.v2')fail('Y5_S8_TOTAL_TYPED_POLICY_REQUIRED');
 const registration=await tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,bound.a.id,true);await currentTotalTx(ctx,c,a,'ADMISSION');await assertTotalResolutionTx(ctx,c,bound.resolution);
  const old=(await c.query<{body:{candidate:TotalAlgorithmCandidate;requestDigest:string;policyDigest:string}}>(
   'SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4',
   [a.tenant_id,a.principal_id,a.id,'s8-proposal-register:'+input.idempotencyKey])).rows[0]?.body;
  if(old){
   if(old.requestDigest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');
   if(old.policyDigest!==digest(policy)||digest(old.candidate.payload)!==digest(payload))fail('Y5_S8_ORIGINAL_CONFIGURATION_CHANGED');
   return old.candidate;
  }
  const acceptance=a.binding.specification.acceptance,until=Math.min(Date.parse(policy.validUntil),
   ...('validUntil'in acceptance?[Date.parse(acceptance.validUntil)]:[]));
  const candidate=makeUniformAlgorithmCandidate({schema:'finnor.s8.uniform-algorithm-candidate.v2',...scope,
   owningInterface:'y5-total-algorithm-v2',payload,domain:{root:{entityType:a.root_type,entityId:a.root_id},
    validAfter:new Date(Math.max(Date.now(),Date.parse(policy.validAfter))).toISOString(),validUntil:new Date(until).toISOString()},
   dependencies:policy.sourcePins,proposedAt:new Date().toISOString(),protectedAdmission:false,executionAuthorityGranted:false});
  if(candidate.schema!=='finnor.s8.uniform-algorithm-candidate.v2')fail('Y5_S8_TOTAL_CANDIDATE_REQUIRED');
  await eventTx(c,a,'s8-proposal-register:'+input.idempotencyKey,'S8_TOTAL_PROPOSAL_REGISTERED',
   {candidate,requestDigest:digest(input),policyDigest:digest(policy)});return candidate;
 });
 const revisionRef=await s8Reply(proposeUniformAlgorithmCandidate(registration,policy)),freshPolicy=await uniformAlgorithmConsumerPolicy(scope),
  resolution=await resolveTotalBinding(ctx,bound.a,'ADMISSION');
 if(!freshPolicy||digest(freshPolicy)!==digest(policy))fail('Y5_S8_CONFIGURATION_CHANGED');
 return tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,bound.a.id,true);await currentTotalTx(ctx,c,a,'ADMISSION');await assertTotalResolutionTx(ctx,c,resolution);
  const old=(await c.query<{body:unknown}>('SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND event_key=$4',
   [a.tenant_id,a.principal_id,a.id,'s8-propose:'+input.idempotencyKey])).rows[0];
  if(old)return old.body;
  const body={candidate:registration,revisionRef,requestDigest:digest(input),protectedAdmission:false,productionActive:false};
  await eventTx(c,a,'s8-propose:'+input.idempotencyKey,'S8_UNIFORM_ALGORITHM_PROPOSED',body);return body;
 });
}
export async function readTotalAdmission(ctx:PeMutationContext,value:unknown){
 diagnosticProfile();const input=AdmissionSchema.parse(value),bound=await prepared(ctx,input.discoveryId);
 const candidate=await tx(ctx,async c=>{
  const rows=(await c.query<{body:{candidate:unknown}}>("SELECT body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND kind='S8_UNIFORM_ALGORITHM_PROPOSED'",
   [bound.a.tenant_id,bound.a.principal_id,bound.a.id])).rows;
  const found=rows.map(r=>parseUniformAlgorithmCandidate(r.body.candidate)).find(c=>digest(c.ref)===digest(input.revisionRef));
  if(!found||found.schema!=='finnor.s8.uniform-algorithm-candidate.v2'||
   digest(found.payload)!==digest(totalUniformPayload(bound.a,bound.capsule)))fail('Y5_S8_UNKNOWN_OR_SUBSTITUTED_TOTAL_CANDIDATE');
  return found;
 });
 const scope={tenantId:bound.a.tenant_id,principalId:bound.a.principal_id,rightsRef:candidate.rightsRef},
  policy=await uniformAlgorithmConsumerPolicy(scope);
 if(!policy)fail('Y5_S8_INDEPENDENT_CONFIGURATION_REQUIRED',503);
 const admission=await s8Reply(currentUniformAlgorithmCandidate(candidate,policy)),finalPolicy=await uniformAlgorithmConsumerPolicy(scope),
  resolution=await resolveTotalBinding(ctx,bound.a,'ADMISSION');
 return tx(ctx,async c=>{
  const a=await totalDiscoveryTx(ctx,c,bound.a.id);await currentTotalTx(ctx,c,a,'ADMISSION');await assertTotalResolutionTx(ctx,c,resolution);
  const current=!!admission&&!!finalPolicy&&digest(policy)===digest(finalPolicy)&&Date.now()<Date.parse(admission.validUntil);
  return {current,currentUntil:current?admission.validUntil:null,admission:current?admission.ref:null,revisionRef:input.revisionRef,
   protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 });
}
