/** The evaluation owner freezes native assignments before execution. Clients
 * submit identities only, never expected values, grades or receipt bodies. */
import type {PoolClient} from 'pg';
import type {z} from 'zod';
import type {PeMutationContext} from '../types';
import type {ApplicationValues,ApplicationQuantity} from '../enterprise-applications/contracts';
import {applicationTx,releaseTx as nativeReleaseTx,recordTx,recordReference,valueSetsFactsTx,authorityTx,assertAuthorityTemporalBoundsTx,type ApplicationRow} from '../enterprise-applications/store';
import {AssignmentSchema,MODES,sha,fail} from './contracts';
import {tx,principal,compilationTx,releaseTx,assertReleaseCurrentTx,eventTx,newId,type CompilationRow} from './store';
import {DEVELOPMENT_CASES,DEVELOPMENT_PLAN,type DevelopmentCase} from './evaluation-plan';
import {originalMethod,children,sumField,number} from './outcome-contract';
type Method=NonNullable<ReturnType<typeof originalMethod>>;
export interface AssignmentReplica{
 mode:typeof MODES[number];applicationId:string;recordId:string;nativeReleaseId:string;
 state:string;values:ApplicationValues;revision:number;reference:ReturnType<typeof recordReference>;
 authorId:string;pendingEffectId:string|null;projection:Record<string,unknown>;projectionDigest:string;
}
export interface NativeAssignment{
 schema:'finnor.x5.native-assignment.v1';id:string;caseId:string;stratum:string;releaseId:string;
 evaluatorId:string;policyDigest:string;originalCheckpointDigest:string;checkpointDigest:string;
 sourceDigest:string;checkerDigest:string;planDigest:string;requestDigest:string;assignedAt:string;
 replicas:AssignmentReplica[];surroundingsDigest:string;
}
export function assignmentRef(body:NativeAssignment){return {owner:'X5_ASSIGNMENT' as const,id:body.id,revision:'1' as const,contentDigest:sha(body)};}
/** Normalize only resolved owner identities, never quantity values or flags. */
export async function nativeObservationValuesTx(ctx:PeMutationContext,c:PoolClient,target:ApplicationRow,input:ApplicationValues){
 const facts=await valueSetsFactsTx(ctx,c,target,[input]),values:Record<string,unknown>={};
 for(const [key,value] of Object.entries(input)){
  if(value&&typeof value==='object'&&'kind'in value&&value.kind==='EVIDENCE'){
   const version=(await c.query('SELECT version_number FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 AND id=$3',
    [target.tenant_id,value.sourceId,value.versionId])).rows[0];
   values[key]={kind:'EVIDENCE',contentDigest:value.contentDigest,versionNumber:version?.version_number??null,current:facts.currentEvidence.some(v=>sha(v)===sha(value))};
  }else values[key]=value;
 }
 return values;
}
function listAmounts(value:unknown){const v=value as {kind:string;entries:ApplicationQuantity[]};return v?.kind==='QUANTITY_LIST'?v.entries.map(q=>q.amount):null;}
export function literalInputsMatch(plan:DevelopmentCase,values:ApplicationValues,method:Method,initial:boolean){
 if(plan.id==='N06')return true; // Exact upstream S4/S5/S6 semantics are resolved separately.
 if(sha(listAmounts(values[method.left]))!==sha([...plan.lines]))return false;
 const right=values[method.right];
 if(initial&&plan.delayed){
  if(!right||typeof right!=='object'||!('kind'in right)||right.kind!=='UNKNOWN')return false;
 }else if(sha(listAmounts(right))!==sha([plan.total]))return false;
 for(const field of [method.left,method.right]){
  const v=values[field] as {kind:string;entries:ApplicationQuantity[]};
  if(v?.kind!=='QUANTITY_LIST')continue;
  for(const q of v.entries){
   const currency=plan.id==='N02'&&field===method.right?'INR':plan.currency;
   const date=plan.id==='N03'&&field===method.right?'2026-03-08T00:00:00.000Z':'2026-03-07T00:00:00.000Z';
   if(q.currency!==currency||q.units!=='minor'||q.accountingBasis!=='RECORDED_MINOR'||q.time.kind!=='AS_OF'||q.time.asOf!==date)return false;
  }
 }
 if(plan.id==='C01'||plan.id==='C02'){
  const fields=[...new Set(method.rec.guards.flatMap(g=>children(g.condition)).flatMap(e=>e.op==='same-quantity'?[sumField(e.left),sumField(e.right)]:[]))]
   .filter((v):v is string=>!!v&&v!==method.left&&v!==method.right);
  if(fields.length!==1||sha(listAmounts(values[fields[0]!]))!==sha([plan.id==='C01'?'4999':'5000']))return false;
 }
 return true;
}
export async function readAssignmentTx(c:PoolClient,a:CompilationRow,ref:{id:string;contentDigest:string}){
 const row=(await c.query<{body:NativeAssignment;actor_id:string;created_at:Date}>(`SELECT body,actor_id,created_at FROM finnor_os.x5_events
  WHERE tenant_id=$1 AND compilation_id=$2 AND kind='ASSIGNMENT_REGISTERED' AND body->>'id'=$3`,
  [a.tenant_id,a.id,ref.id])).rows[0];
 if(!row||sha(row.body)!==ref.contentDigest||row.body.evaluatorId!==row.actor_id||row.actor_id===a.owner_id)fail('X5_ASSIGNMENT_REFERENCE_INVALID');
 return row;
}
export async function assertUseAssignmentTx(c:PoolClient,a:CompilationRow,input:{
 releaseId:string;applicationId:string;recordId:string;mode:string;stratum:string;assignmentRef?:{id:string;contentDigest:string};
}){
 if(!input.assignmentRef)return;
 const {body}=await readAssignmentTx(c,a,input.assignmentRef);
 if(body.releaseId!==input.releaseId||body.stratum!==input.stratum||!body.replicas.some(v=>v.mode===input.mode&&v.applicationId===input.applicationId&&v.recordId===input.recordId))
  fail('X5_ASSIGNMENT_SUBSTITUTION');
}
export async function registerNativeLearningAssignment(ctx:PeMutationContext,input:z.infer<typeof AssignmentSchema>){
 return tx(ctx,async c=>{
  const a=await compilationTx(ctx,c,input.compilationId,'action:evaluate_learned_policy'),r=await releaseTx(c,a,input.releaseId);
  if(principal(ctx)===a.owner_id)fail('X5_INDEPENDENT_EVALUATOR_REQUIRED',403);
  const temporalBounds=await assertReleaseCurrentTx(ctx,c,a,r);
  const plan=DEVELOPMENT_CASES.find(v=>v.id===input.caseId);
  if(!plan)fail('X5_UNREGISTERED_DEVELOPMENT_CASE',400);
  const prior=(await c.query<{body:NativeAssignment}>(`SELECT body FROM finnor_os.x5_events
   WHERE tenant_id=$1 AND compilation_id=$2 AND idempotency_key=$3`,[a.tenant_id,a.id,'assignment:'+r.id+':'+plan.id])).rows[0];
  if(prior){
   if(prior.body.requestDigest!==sha(input)||prior.body.evaluatorId!==principal(ctx))fail('X5_ASSIGNMENT_REREGISTRATION_REFUSED');
   return {assignmentRef:assignmentRef(prior.body),caseId:plan.id,replayed:true};
  }
  if(new Set(input.replicas.map(v=>v.mode)).size!==4||new Set(input.replicas.map(v=>v.recordId)).size!==4)fail('X5_FOUR_DISTINCT_NATIVE_REPLICAS_REQUIRED');
  const source=await nativeReleaseTx(c,await applicationTx(ctx,c,r.selections[0]!.applicationId)),sourceMethod=originalMethod(source.specification,source.specification.model.entities[0]!.id);
  if(!sourceMethod)fail('X5_ASSIGNMENT_SOURCE_METHOD_UNAVAILABLE');
  const allocation={deadlineAt:a.deadline_at.toISOString(),maxUses:a.max_uses,remainingUses:a.max_uses-a.use_count,
   remainingAttempts:a.max_attempts-a.attempt_count,retainedBytes:Number(a.data_bytes),childWallMs:30000,decisionsPerArm:2,registeredAt:new Date().toISOString()};
  const replicas:AssignmentReplica[]=[];
  for(const replica of input.replicas){
   const target=await applicationTx(ctx,c,replica.applicationId),native=await nativeReleaseTx(c,target),record=await recordTx(c,target,replica.recordId);
   const method=originalMethod(native.specification,record.entity_id);
   if(!method||record.release_id!==target.head_release_id||record.schema_release_id!==target.head_release_id)fail('X5_ASSIGNMENT_NATIVE_METHOD_UNAVAILABLE');
   if(record.author_id===principal(ctx))fail('X5_EVALUATOR_CANNOT_AUTHOR_ASSIGNMENTS',403);
   const retention=r.selections.some(v=>v.applicationId===target.id);
   if(retention!==(plan.stratum==='RETENTION'))fail('X5_ASSIGNMENT_PARTITION_INVALID');
   if(!retention){
    const currentFields=(action:typeof method.rec)=>action.guards.flatMap(g=>children(g.condition)).flatMap(g=>
     g.op==='current-evidence'&&g.value.op==='field'&&g.value.source==='record'?[g.value.field]:[]);
    const booleans=(action:typeof method.rec)=>action.guards.flatMap(g=>children(g.condition)).flatMap(g=>
     g.op==='equal'&&g.left.op==='field'&&g.left.source==='record'&&g.right.op==='literal'&&g.right.value===true?[g.left.field]:[]);
    const evidence=currentFields(method.rec),boolean=booleans(method.rec);
    const threshold=method.check.approval!.requirements.some(v=>v.when.op==='currency-threshold'&&v.when.comparison==='gte'&&
     ['USD','INR'].every(currency=>v.when.op==='currency-threshold'&&v.when.thresholds.some(t=>t.currency===currency&&t.units==='minor'&&t.accountingBasis==='RECORDED_MINOR'&&t.timeMode==='AS_OF'&&number(t.amount)===number('50000'))));
    if(record.entity_id===sourceMethod.rec.entityId||method.rec.id===sourceMethod.rec.id||method.check.id===sourceMethod.check.id||
     native.specification.model.roles.some(v=>source.specification.model.roles.some(s=>s.canonicalRole===v.canonicalRole))||
     new Set(evidence).size<3||evidence.some(v=>!currentFields(method.check).includes(v))||
     !boolean.some(v=>booleans(method.check).includes(v)&&record.values[v]===true)||!threshold)
     fail('X5_PREREGISTERED_FRESH_TRANSFER_SEMANTICS_REQUIRED');
   }
   if((await c.query(`SELECT 1 FROM finnor_os.x5_uses WHERE tenant_id=$1 AND compilation_id=$2
    AND request->>'applicationId'=$3 AND request->>'recordId'=$4 LIMIT 1`,[a.tenant_id,a.id,target.id,record.id])).rowCount)fail('X5_ASSIGNMENT_MUST_PRECEDE_USE');
   if(!literalInputsMatch(plan,record.values,method,true))fail('X5_ASSIGNMENT_LITERAL_INPUT_MISMATCH');
   const expectedState=['N04','N05'].includes(plan.id)?method.rec.toState:method.initial;
   if(plan.id!=='N06'&&(record.state!==expectedState||record.approvals.length||record.pending_effect_id))fail('X5_ASSIGNMENT_PREACTION_STATE_INVALID');
   if(plan.id==='N06'&&!record.pending_effect_id)fail('X5_GENUINE_PENDING_RESPONSIBILITY_REQUIRED');
   const facts=await valueSetsFactsTx(ctx,c,target,[record.values]),author=await authorityTx(ctx,c,target,record.author_id);
   if(!author.authorityCurrent)fail('X5_ASSIGNMENT_AUTHOR_AUTHORITY_UNAVAILABLE');
   const refs=Object.values(record.values).filter(v=>v&&typeof v==='object'&&'kind'in v&&v.kind==='EVIDENCE');
   const stale=refs.filter(v=>!facts.currentEvidence.some(current=>sha(current)===sha(v))).length;
   if(stale!==(plan.stale?1:0))fail('X5_ASSIGNMENT_PREREGISTERED_SOURCE_CURRENTNESS_REQUIRED');
   const statuses=native.specification.model.entities.find(v=>v.id===record.entity_id)!.fields.filter(v=>v.type==='enum'&&v.options?.includes('KNOWN')&&v.options.includes('UNKNOWN')).map(v=>record.values[v.id]);
   if(statuses.filter(v=>v==='UNKNOWN').length!==(plan.delayed?1:0)||statuses.some(v=>v!=='KNOWN'&&v!=='UNKNOWN'))
    fail('X5_ASSIGNMENT_PREREGISTERED_KNOWNNESS_REQUIRED');
   const values=await nativeObservationValuesTx(ctx,c,target,record.values);
   const projection={state:record.state,values,concurrencyRevision:record.concurrency_revision,contentRevision:record.content_revision,authorId:record.author_id,authorRoles:[...author.canonicalRoles].sort(),
    pendingResponsibility:!!record.pending_effect_id,specificationDigest:sha(native.specification),nativeReleaseId:target.head_release_id,
    work:native.package.work,runtime:sha(native.environment),originalLearningAllocation:allocation};
   if(a.deadline_at.getTime()-Date.now()<30000||a.max_uses-a.use_count<8)fail('X5_ASSIGNMENT_ORIGINAL_HEADROOM_EXHAUSTED');
   replicas.push({mode:replica.mode,applicationId:target.id,recordId:record.id,nativeReleaseId:target.head_release_id!,
    state:record.state,values:record.values,revision:record.concurrency_revision,reference:recordReference(record),authorId:record.author_id,
    pendingEffectId:record.pending_effect_id,projection,projectionDigest:sha(projection)});
  }
  if(new Set(replicas.map(v=>v.projectionDigest)).size!==1)fail('X5_ARM_SURROUNDINGS_NOT_EQUIVALENT');
  const body:NativeAssignment={schema:'finnor.x5.native-assignment.v1',id:newId(),caseId:plan.id,stratum:plan.stratum,releaseId:r.id,
   evaluatorId:principal(ctx),policyDigest:r.policyDigest,originalCheckpointDigest:r.originalCheckpoint.digest,checkpointDigest:r.checkpoint.digest,
   sourceDigest:r.environment.sourceDigest,checkerDigest:r.environment.checkerDigest,planDigest:sha(DEVELOPMENT_PLAN),requestDigest:sha(input),
   assignedAt:new Date().toISOString(),replicas,surroundingsDigest:replicas[0]!.projectionDigest};
  await eventTx(c,a,principal(ctx),'ASSIGNMENT_REGISTERED','assignment:'+r.id+':'+plan.id,body);
  await assertAuthorityTemporalBoundsTx(c,temporalBounds);
  return {assignmentRef:assignmentRef(body),caseId:plan.id,replayed:false,replicaDigests:replicas.map(v=>v.projectionDigest)};
 });
}
