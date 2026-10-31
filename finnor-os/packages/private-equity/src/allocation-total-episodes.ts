import {z} from 'zod';
import type {PoolClient} from 'pg';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import type {S5ExperienceEvent} from '../../shared-types/src/allocation';
import type {ExperimentRef} from '../../shared-types/src/experiments';
import type {ResolvedTotalSpecification} from '../../shared-types/src/total-algorithm-theory';
import {parseResolvedTotalSpecification} from '../../epistemic-runtime/src/uniform-algorithms/total/capsule';
import {parseWorkSpecification} from '../../epistemic-runtime/src/uniform-algorithms/total/syntax';
import {epistemicHash} from '../../epistemic-runtime/src/source-precedence';
import {ExperimentRefSchema} from '../../epistemic-runtime/src/experiments';
import {withS5PortfolioTransaction} from './allocation-store';
import {workCutTx,assertAuthorityTemporalBoundsTx} from './enterprise-applications/store';
import {applicationDigest} from './enterprise-applications/contracts';
import {revisions} from './owner-context';
import type {PeMutationContext} from './types';
import {resolveTotalTask,TotalTaskInstanceSchema,TotalTaskBindingSchema,evaluateTotalTaskModel,replayTotalTaskModel,totalReferenceBounds,
 type TotalTaskBinding,type TotalTaskModelResult} from './allocation-total-task';
import {resolveTotalSpecification} from './uniform-algorithms/specification';
import {authorizeTx,principal,tx} from './uniform-algorithms/store';
import {RootSchema,digest,diagnosticProfile,fail} from './uniform-algorithms/contracts';

export const RecordTotalTaskSchema=z.object({root:RootSchema,workId:z.string().uuid(),taskWorkId:z.string().uuid(),
 idempotencyKey:z.string().min(1).max(256)}).strict();
const requestDetailSchema=z.object({schema:z.literal('finnor.s5.total-task-request.v2'),
 input:RecordTotalTaskSchema,requestDigest:z.string().regex(/^[a-f0-9]{64}$/),
 specificationWork:z.object({id:z.string().uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 specification:z.unknown(),task:z.lazy(()=>TotalTaskBindingSchema),dependencies:z.array(z.object({
  key:z.string(),revision:z.number().int().nonnegative(),nodeIds:z.array(z.string()),digest:z.string().nullable(),
 }).strict()).max(32),qualification:z.literal('PUBLIC_OR_AUTHENTICATED_MODEL_TASK_NOT_INDEPENDENT_BUSINESS_QUALIFICATION')}).strict();
type RequestDetail=Omit<z.infer<typeof requestDetailSchema>,'specification'>&{specification:ResolvedTotalSpecification};
type EpisodeRecord={ref:ExperimentRef;kind:S5ExperienceEvent['type'];body:S5ExperienceEvent};
const integer=z.string().regex(/^(?:0|-?[1-9][0-9]*)$/).max(4097);
const referenceSchema=z.object({schema:z.literal('finnor.s5.total-task-exhaustive-reference.v2'),
 method:z.literal('S5_BOUNDED_EXHAUSTIVE_INTEGER_V1'),bounds:z.object({
  maxCandidates:z.literal(4096),maxExpressionSteps:z.literal(2000000),maxWallMs:z.literal(1000),
  maxEvidenceBytes:z.literal(1048576),maxIntegerDigits:z.literal(4096),
 }).strict(),lowerBound:z.object({value:integer,safeExpressionDigest:z.string(),
  rule:z.literal('NECESSARY_AFFINE_EMPTY_PREFIX_SAFETY_LOWER_BOUND')}).strict().nullable(),
 rejected:z.array(z.object({value:integer,firstUnsafePrefix:z.number().int().min(0).max(128),state:integer}).strict()).max(4096),
 prefixes:z.array(z.object({length:z.number().int().min(0).max(128),state:integer,safe:z.boolean()}).strict()).max(129),
 candidatesExamined:z.number().int().min(0).max(4096),expressionSteps:z.number().int().min(0).max(2000001),
 includesEmptyPrefix:z.literal(true),scope:z.literal('FINITE_TASK_MEANING_INTERPRETATION_NOT_DISCOVERED_ALGORITHM')}).strict();
const resultSchema=z.discriminatedUnion('status',[
 z.object({status:z.literal('MODEL_ACCEPTED'),value:integer,reason:z.null(),reference:referenceSchema}).strict(),
 z.object({status:z.enum(['REFUSED','UNKNOWN']),value:z.null(),reason:z.string().min(1).max(128),reference:referenceSchema}).strict(),
]);
const resultDetailSchema=z.object({schema:z.literal('finnor.s5.total-task-result.v2'),
 requestRef:ExperimentRefSchema,requestDigest:z.string(),result:resultSchema}).strict();
const costSchema=z.object({wallMs:z.number().nonnegative(),expressionSteps:z.number().int().nonnegative(),
 candidatesExamined:z.number().int().nonnegative(),money:z.null(),completeHumanSeconds:z.null(),
 aggregatePeakBytes:z.null(),externalCalls:z.literal(0),scope:z.literal('S5_OWNER_REFERENCE_NOT_COMPLETE_PHYSICAL_RESOURCE_ACCOUNTING')}).strict();
const costDetailSchema=z.object({schema:z.literal('finnor.s5.total-task-cost.v2'),
 requestRef:ExperimentRefSchema,resultRef:ExperimentRefSchema,cost:costSchema}).strict();
function eventRef(event:S5ExperienceEvent):ExperimentRef{
 return {owner:'S5',id:event.eventId,version:'s5-experience-v1',contentDigest:epistemicHash(event)};
}
function requestDetail(value:unknown):RequestDetail{
 const parsed=requestDetailSchema.parse(value),specification=parseResolvedTotalSpecification(parsed.specification);
 if(parsed.requestDigest!==digest(parsed.input)||parsed.task.workId!==parsed.input.taskWorkId||
  parsed.specificationWork.id!==specification.sourceRef.id||
  parsed.task.specificationDigest!==digest(specification)||
  digest(parsed.task.instance.specificationRef)!==digest(specification.sourceRef)||
  parsed.task.sourceRef.id!==parsed.task.work.id)fail('S5_TOTAL_TASK_IMMUTABLE_REQUEST_INVALID');
 return {...parsed,specification};
}
function immutableEvent(record:EpisodeRecord){
 const {eventId,...body}=record.body;
 if(record.body.schema!=='finnor.s5.experience.v1'||record.body.semanticOwner!=='S5'||
  record.ref.owner!=='S5'||record.ref.version!=='s5-experience-v1'||
  eventId!==record.ref.id||eventId!==`s5-event:${epistemicHash(body)}`||
  record.ref.contentDigest!==epistemicHash(record.body)||record.kind!==record.body.type||
  record.body.contentDigest!==epistemicHash(record.body.detail)||
  record.body.protectedReceipt!==null||record.body.appendAuthorityGranted!==false)
  fail('S5_TOTAL_TASK_IMMUTABLE_EVENT_INVALID');
}
export function matchingTotalTaskRequests(records:EpisodeRecord[],task?:TotalTaskBinding){
 const requests=records.filter(r=>r.kind==='TOTAL_TASK_REQUEST'),matched=[];
 for(const record of records)if(record.kind.startsWith('TOTAL_TASK_'))immutableEvent(record);
 for(const record of requests){
  const detail=requestDetail(record.body.detail);
  if(record.body.episodeId!=='total-task:'+detail.task.workId)fail('S5_TOTAL_TASK_EPISODE_ID_MISMATCH');
  const results=records.filter(r=>r.kind==='TOTAL_TASK_RESULT'&&r.body.detail.requestRef&&
   digest(r.body.detail.requestRef)===digest(record.ref));
  const costs=records.filter(r=>r.kind==='TOTAL_TASK_COST'&&r.body.detail.requestRef&&
   digest(r.body.detail.requestRef)===digest(record.ref));
  if(results.length!==1||costs.length!==1)fail('S5_TOTAL_TASK_COMPLETE_RESULT_AND_COST_REQUIRED');
  const result=resultDetailSchema.parse(results[0]!.body.detail),cost=costDetailSchema.parse(costs[0]!.body.detail);
  if(result.requestDigest!==detail.requestDigest||digest(cost.resultRef)!==digest(results[0]!.ref)||
   cost.cost.expressionSteps!==result.result.reference.expressionSteps||
   cost.cost.candidatesExamined!==result.result.reference.candidatesExamined||
   [results[0]!,costs[0]!].some(r=>r.body.episodeId!==record.body.episodeId||
    r.body.principalId!==record.body.principalId||r.body.tenantId!==record.body.tenantId)||
   digest(result.result.reference.bounds)!==digest(totalReferenceBounds))
   fail('S5_TOTAL_TASK_REFERENCE_PROVENANCE_CHANGED');
  if(result.result.status==='MODEL_ACCEPTED'){
   const replay=replayTotalTaskModel(detail.specification,detail.task,result.result.reference.expressionSteps);
   if(replay.status!=='MODEL_ACCEPTED'||digest(replay)!==digest(result.result))
    fail('S5_TOTAL_TASK_INDEPENDENT_REFERENCE_RECHECK_FAILED');
  }
  if(!task||detail.task.specificationDigest===task.specificationDigest&&
   digest(detail.task.instance.specificationRef)===digest(task.instance.specificationRef))
   matched.push({record,detail,result:result.result,resultRef:results[0]!.ref,cost:cost.cost});
 }
 for(const record of records)if(record.kind==='TOTAL_TASK_RESULT'||record.kind==='TOTAL_TASK_COST'){
  if(!requests.some(r=>digest(r.ref)===digest(record.body.detail.requestRef)))
   fail('S5_TOTAL_TASK_ORPHAN_RESULT_OR_COST');
 }
 return matched;
}
async function currentRequestTx(ctx:PeMutationContext,c:PoolClient,detail:RequestDetail,deadlineAt?:number){
 const {input,specification,task}=detail;
 await authorizeTx(ctx,c,input.root,input.workId);await authorizeTx(ctx,c,input.root,input.taskWorkId);
 if(digest(await revisions(ctx,detail.dependencies.map(d=>d.key),c,true))!==digest(detail.dependencies)||
  digest(await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:input.workId}))!==digest(detail.specificationWork)||
  digest(await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:input.taskWorkId}))!==digest(task.work))
  fail('S5_TOTAL_TASK_SOURCE_OR_RIGHTS_CHANGED');
 const works=(await c.query<{status:string;current_owner_id:string|null}>(`SELECT status,current_owner_id
  FROM finnor_os.works WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR SHARE`,
  [ctx.auth.tenantId,[input.workId,input.taskWorkId]])).rows;
 if(works.length!==new Set([input.workId,input.taskWorkId]).size||
  works.some(w=>['failed','cancelled','completed'].includes(w.status)||w.current_owner_id&&w.current_owner_id!==principal(ctx)))
  fail('S5_TOTAL_TASK_WORK_NOT_CURRENT');
 const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
 await assertAuthorityTemporalBoundsTx(c,[...(authority.validUntil?[authority.validUntil]:[]),
  ...(deadlineAt?[new Date(deadlineAt).toISOString()]:[]),
  ...('validUntil'in specification.acceptance?[specification.acceptance.validUntil]:[])]);
}
async function currentRequest(ctx:PeMutationContext,detail:RequestDetail,deadlineAt?:number){
 const {input,specification,task}=detail;
 const current=await resolveTotalSpecification(ctx,{root:input.root,workId:input.workId,expectedSourceRef:specification.sourceRef});
 if(current.status==='UNAVAILABLE'||digest(current.specification)!==digest(specification))
  fail('S5_TOTAL_TASK_SPECIFICATION_OR_POLICY_CHANGED');
 if(digest(await resolveTotalTask(ctx,input.root,input.taskWorkId,current.specification))!==digest(task))
  fail('S5_TOTAL_TASK_ORIGINAL_WORK_CHANGED');
 await tx(ctx,c=>currentRequestTx(ctx,c,detail,deadlineAt));
}
export async function assertTotalTaskSourceVisibilityTx(ctx:PeMutationContext,c:PoolClient,
 detail:Pick<RequestDetail,'specificationWork'|'specification'|'task'>&{
  input:Pick<RequestDetail['input'],'root'|'workId'|'taskWorkId'>}){
 // Recorded semantic acceptance is historical evidence, not renewed method eligibility.
 const {input,specification,task}=detail,sourceTexts:string[]=[];
 for(const source of [
  {workId:input.workId,work:detail.specificationWork,ref:specification.sourceRef,version:'y5-work-specification-v2',maxBytes:32768},
  {workId:input.taskWorkId,work:task.work,ref:task.sourceRef,version:'s5-total-task-instance-v2',maxBytes:131072},
 ]){
  await authorizeTx(ctx,c,input.root,source.workId);
  const row=(await c.query<{id:string;instruction_text:string;created_by:string;context_snapshot:unknown;context_snapshot_hash:string}>(
   `SELECT i.id,i.instruction_text,i.created_by,i.context_snapshot,i.context_snapshot_hash
    FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
    WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3 FOR SHARE OF w`,
   [ctx.auth.tenantId,source.workId,source.work.id])).rows[0];
  if(!row||Buffer.byteLength(row.instruction_text)>source.maxBytes)fail('S5_TOTAL_TASK_HISTORICAL_WORK_INPUT_UNAVAILABLE');
  const {created_by:_,...work}=row;
  if(source.ref.owner!=='WORK_INPUT'||source.ref.version!==source.version||source.ref.id!==row.id||
   source.ref.contentDigest!==digest(row)||source.work.digest!==applicationDigest(work))
   fail('S5_TOTAL_TASK_HISTORICAL_WORK_INPUT_CHANGED');
  sourceTexts.push(row.instruction_text);
 }
 const supplied=parseWorkSpecification(JSON.parse(sourceTexts[0]!)),
  instance=TotalTaskInstanceSchema.parse(JSON.parse(sourceTexts[1]!));
 if(digest(supplied.definition)!==specification.definitionDigest||digest(supplied.definition)!==digest(specification.definition)||
  task.workId!==input.taskWorkId||task.specificationDigest!==digest(specification)||
  digest(instance)!==digest(task.instance)||digest(instance.specificationRef)!==digest(specification.sourceRef))
  fail('S5_TOTAL_TASK_HISTORICAL_MEANING_CHANGED');
}
export async function assertTotalTypedSources(ctx:PeMutationContext,records:EpisodeRecord[],deadlineAt:number,
 mode:'CURRENT'|'READ'='CURRENT'){
 const requests=matchingTotalTaskRequests(records);
 for(const request of requests){
  if(Date.now()>=deadlineAt)fail('S5_TOTAL_TASK_ORIGINAL_READ_DEADLINE',408);
  if(request.record.body.tenantId!==ctx.auth.tenantId||request.record.body.principalId!==principal(ctx))
   fail('S5_TOTAL_TASK_AUTHENTICATED_PRINCIPAL_REQUIRED');
  if(mode==='READ')await tx(ctx,c=>assertTotalTaskSourceVisibilityTx(ctx,c,request.detail));
  else await currentRequest(ctx,request.detail,deadlineAt);
 }
}
async function priorTx(ctx:PeMutationContext,c:PoolClient,input:z.infer<typeof RecordTotalTaskSchema>){
 const rows=(await c.query<{body:S5ExperienceEvent}>(`SELECT body FROM finnor_os.s5_experience
  WHERE tenant_id=$1 AND principal_id=$2 AND body->>'type'='TOTAL_TASK_REQUEST'
  AND body#>>'{detail,input,idempotencyKey}'=$3 ORDER BY recorded_at,event_id LIMIT 2`,
  [ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows;
 if(rows.length>1)fail('S5_TOTAL_TASK_IDEMPOTENCY_AMBIGUOUS');
 if(!rows.length)return null;
 const detail=requestDetail(rows[0]!.body.detail);
 if(detail.requestDigest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');
 const children=(await c.query<{body:S5ExperienceEvent}>(`SELECT body FROM finnor_os.s5_experience
  WHERE tenant_id=$1 AND principal_id=$2 AND body#>>'{detail,requestRef,id}'=$3 ORDER BY recorded_at,event_id LIMIT 3`,
  [ctx.auth.tenantId,principal(ctx),rows[0]!.body.eventId])).rows;
 const events=[rows[0]!.body,...children.map(r=>r.body)];
 const match=matchingTotalTaskRequests(events.map(body=>({body,kind:body.type,ref:eventRef(body)})))[0];
 if(!match)fail('S5_TOTAL_TASK_IDEMPOTENT_EVIDENCE_UNAVAILABLE');
 return match;
}
function response(match:ReturnType<typeof matchingTotalTaskRequests>[number],replayed:boolean){
 return {schema:'finnor.s5.total-task-model-result.v2',requestRef:match.record.ref,resultRef:match.resultRef,
  result:match.result,cost:match.cost,replayed,
  qualification:'S5_MODEL_ONLY_PUBLIC_OR_AUTHENTICATED_TASK_NOT_INDEPENDENT_BUSINESS_QUALIFICATION',
  businessCompletionAccepted:false,protectedReceipt:null,protectedFamilyCredit:false,reservationCreated:false,
  s6EffectsCreated:[],executionAuthorityGranted:false};
}
export async function recordTotalTaskEpisode(ctx:PeMutationContext,value:unknown,deadlineAt=Date.now()+28500){
 diagnosticProfile();const input=RecordTotalTaskSchema.parse(value),started=Date.now();
 const initial=await tx(ctx,async c=>{
  await authorizeTx(ctx,c,input.root,input.workId);await authorizeTx(ctx,c,input.root,input.taskWorkId);
  return {prior:await priorTx(ctx,c,input),specificationWork:await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:input.workId}),
   dependencies:await revisions(ctx,[
   'rights:tenant','m3:root:'+input.root.entityType+':'+input.root.entityId,
   'canonical:'+input.root.entityType+':'+input.root.entityId,'work-inputs:'+input.workId,'work-inputs:'+input.taskWorkId],c,true)};
 });
 if(initial.prior){await currentRequest(ctx,initial.prior.detail,deadlineAt);return response(initial.prior,true);}
 const resolution=await resolveTotalSpecification(ctx,{root:input.root,workId:input.workId});
 if(resolution.status==='UNAVAILABLE')fail('S5_TOTAL_TASK_AUTHENTICATED_SPECIFICATION_REQUIRED');
 const specification=resolution.specification,task=await resolveTotalTask(ctx,input.root,input.taskWorkId,specification);
 const detail:RequestDetail={schema:'finnor.s5.total-task-request.v2',input,requestDigest:digest(input),
  specification,task,specificationWork:initial.specificationWork,dependencies:initial.dependencies,
  qualification:'PUBLIC_OR_AUTHENTICATED_MODEL_TASK_NOT_INDEPENDENT_BUSINESS_QUALIFICATION'};
 const result:TotalTaskModelResult=evaluateTotalTaskModel(specification,task,deadlineAt);
 await currentRequest(ctx,detail,deadlineAt);
 return withS5PortfolioTransaction(ctx,async c=>{
  await authorizeTx(ctx,c,input.root,input.workId);await authorizeTx(ctx,c,input.root,input.taskWorkId);
  const prior=await priorTx(ctx,c,input);
  if(prior){
   if(digest(prior.detail)!==digest(detail))fail('S5_TOTAL_TASK_CONCURRENT_SOURCE_CHANGED');
   await currentRequestTx(ctx,c,prior.detail,deadlineAt);
   return response(prior,true);
  }
  if(Date.now()>=deadlineAt)fail('S5_TOTAL_TASK_ORIGINAL_REQUEST_DEADLINE',408);
  await currentRequestTx(ctx,c,detail,deadlineAt);
  const at=new Date().toISOString(),events:S5ExperienceEvent[]=[];
  const event=(type:S5ExperienceEvent['type'],eventDetail:Record<string,unknown>)=>{
   const body:Omit<S5ExperienceEvent,'eventId'>={schema:'finnor.s5.experience.v1',semanticOwner:'S5',
    episodeId:'total-task:'+input.taskWorkId,type,tenantId:ctx.auth.tenantId,principalId:principal(ctx),
    rightsRef:'rights:tenant',revisionRef:task.sourceRef.id,contentDigest:epistemicHash(eventDetail),
    knowledgeAt:at,validAt:at,preparedParentRefs:events.map(e=>e.eventId),causalParents:[],
    dependencyRefs:[specification.sourceRef.id,task.sourceRef.id],horizon:'H0',uncertainty:'MODEL_CONDITIONAL_UNADMITTED',
    detail:eventDetail,protectedReceipt:null,appendAuthorityGranted:false};
   const value={...body,eventId:`s5-event:${epistemicHash(body)}`};events.push(value);return eventRef(value);
  };
  const requestRef=event('TOTAL_TASK_REQUEST',detail);
  const resultRef=event('TOTAL_TASK_RESULT',{schema:'finnor.s5.total-task-result.v2',requestRef,requestDigest:detail.requestDigest,result});
  const cost={wallMs:Date.now()-started,expressionSteps:result.reference.expressionSteps,
   candidatesExamined:result.reference.candidatesExamined,money:null,completeHumanSeconds:null,aggregatePeakBytes:null,
   externalCalls:0 as const,scope:'S5_OWNER_REFERENCE_NOT_COMPLETE_PHYSICAL_RESOURCE_ACCOUNTING' as const};
  event('TOTAL_TASK_COST',{schema:'finnor.s5.total-task-cost.v2',requestRef,resultRef,cost});
  for(const item of events){
   if(Buffer.byteLength(JSON.stringify(item))>2097152)fail('S5_TOTAL_TASK_EVENT_BYTES_BOUND',413);
   await c.query('INSERT INTO finnor_os.s5_experience(tenant_id,principal_id,event_id,body) VALUES($1,$2,$3,$4::jsonb)',
    [ctx.auth.tenantId,principal(ctx),item.eventId,JSON.stringify(item)]);
  }
  await currentRequestTx(ctx,c,detail,deadlineAt);
  return response({record:{ref:requestRef,kind:'TOTAL_TASK_REQUEST',body:events[0]!},detail,result,resultRef,cost},false);
 });
}
