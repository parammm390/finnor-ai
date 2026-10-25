import {and,eq} from 'drizzle-orm';
import type {PoolClient} from 'pg';
import {workObjectiveLoops,type Db} from '@finnor/db';
import type {ObjectiveSuccessCondition} from '@finnor/shared-types';
import type {EconomicRef,EconomicEvidenceResolution} from '../../../shared-types/src/economic-attribution';
import type {WorkEconomicAnchor,WorkEconomicContext,WorkEconomicPlanAvailability} from '../../../shared-types/src/work-economic';
import {economicHash,parseOutcomeEstimand} from '../../../epistemic-runtime/src/economic-attribution';
import {LedgerFault} from '../../../governed-execution/src/protocol';
import {peTransaction} from '../repository';
import {PeDomainError,type PeMutationContext} from '../types';
import {readReviewedAcquisitionRequest} from '../acquisition/reviewed-request';
import {authorizeEconomicActor,economicActor,listStoredWorkEconomicRecords,persistEconomicRecordTx,readStoredEconomicRecordTx,readEconomicReplay,type StoredEconomicRecord} from '../economic-store';
import {prepareOutcomeEstimandRegistration} from '../enterprise-economic-attribution';
import {WorkEconomicBindingSchema,WorkEconomicOperationSchemas} from './contracts';

function fail(code:string,status=409):never{throw new LedgerFault(status,code);}
const same=(a:unknown,b:unknown)=>economicHash(a)===economicHash(b);
const bindingContentionConstraints=[
 's7_economic_records_tenant_id_principal_id_kind_idempotency_key',
 's7_work_economic_initial_binding','s7_work_economic_binding_successor',
];
async function inspect(ctx:PeMutationContext,input:{workId:string;criterionIndex?:number},db:Db,c:PoolClient,lock=false){
 if(lock){
  await c.query('SELECT id FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2 FOR SHARE',[ctx.auth.tenantId,input.workId]);
  await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.auth.tenantId,input.workId]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s7-economic:'+ctx.auth.tenantId+':'+economicActor(ctx)]);
 }
 await authorizeEconomicActor(ctx,c,lock);
 const owned=(await c.query('SELECT 1 FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND coalesce(current_owner_id,created_by)=$3',[ctx.auth.tenantId,input.workId,economicActor(ctx)])).rowCount;
 if(!owned)fail('ECONOMIC_WORK_CONTEXT_UNAVAILABLE',404);
 let reviewed:Awaited<ReturnType<typeof readReviewedAcquisitionRequest>>;
 try{reviewed=await readReviewedAcquisitionRequest(ctx,input.workId,undefined,c);}
 catch(error){
  if(error instanceof Error&&/^REVIEWED_ACQUISITION_[A-Z_]+$/.test(error.message))fail(error.message);
  if(error instanceof PeDomainError)fail('ECONOMIC_WORK_CONTEXT_UNAVAILABLE',404);
  throw error;
 }
 const base:WorkEconomicContext={applicable:Boolean(reviewed),workId:input.workId,criteria:[],anchor:null,originalClause:null,state:'NOT_APPLICABLE',tracking:null,choices:[],originalBudget:null,completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false};
 if(!reviewed)return {context:base,records:[] as StoredEconomicRecord[],current:null as StoredEconomicRecord|null};
 const [loop]=await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId,ctx.auth.tenantId),eq(workObjectiveLoops.workId,input.workId))).limit(1);
 if(!loop||loop.createdBy!==economicActor(ctx))fail('ECONOMIC_WORK_CONTEXT_UNAVAILABLE',404);
 const condition=loop.successCondition as ObjectiveSuccessCondition;
 base.criteria=condition.criteria.flatMap((v,index)=>v.kind==='manual_verification'?[{index,reason:v.reason}]:[]);
 const index=input.criterionIndex??(base.criteria.length===1?base.criteria[0]!.index:undefined),criterion=index===undefined?undefined:condition.criteria[index];
 if(index!==undefined&&criterion?.kind!=='manual_verification')fail('ECONOMIC_WORK_MANUAL_REQUIREMENT_REQUIRED',400);
 base.originalBudget={deadlineAt:loop.deadlineAt.toISOString(),maxSteps:loop.maxSteps,maxActions:loop.maxActions,maxQueries:loop.maxQueries,stepCount:loop.stepCount,actionCount:loop.actionCount,queryCount:loop.queryCount};
 if(index===undefined||criterion?.kind!=='manual_verification'){base.state='SELECT_REQUIREMENT';return {context:base,records:[] as StoredEconomicRecord[],current:null as StoredEconomicRecord|null};}
 const {closingWorkGoalDigest}=await import('../../../orchestration/src/objective-loop');
 const anchor:WorkEconomicAnchor={workId:input.workId,workInputId:reviewed.acceptance.workInputId,objectiveLoopId:loop.id,objectiveRevision:loop.revision,objectiveDigest:closingWorkGoalDigest(loop),successConditionHash:economicHash(condition),criterionIndex:index,criterionHash:economicHash(criterion),dealId:reviewed.request.dealId,currency:reviewed.request.acquisition.bidDomain.currency};
 base.anchor=anchor;base.originalClause=criterion.reason;base.state='NOT_BOUND';
 const records=await listStoredWorkEconomicRecords(ctx,{workId:input.workId,workInputId:anchor.workInputId},c);
 const bindings=records.filter(r=>r.kind==='WORK_BINDING'&&WorkEconomicBindingSchema.parse(r.payload).anchor.criterionIndex===index);
 for(const r of bindings)if(!same(WorkEconomicBindingSchema.parse(r.payload).anchor,anchor))fail('ECONOMIC_WORK_ORIGINAL_ANCHOR_CHANGED');
 const heads=bindings.filter(r=>!bindings.some(child=>child.revisionOf===r.ref.id));
 if(heads.length>1)fail('ECONOMIC_WORK_BINDING_FORK',503);
 const current=heads[0]??null;
 for(const r of records.filter(r=>r.kind==='PREREGISTRATION'&&r.payload.mode==='PROSPECTIVE')){
  const e=parseOutcomeEstimand(r.payload.estimand);
  const linked=current?WorkEconomicBindingSchema.parse(current.payload):null;
  const until=new Date(Math.min(Date.parse(e.assignmentAt),Date.parse(e.outcomeAccessNotBefore))).toISOString();
  const availability:WorkEconomicPlanAvailability=linked&&same(linked.estimandRef,r.ref)?{kind:'CURRENT'}
   :e.currency!==anchor.currency?{kind:'CURRENCY_MISMATCH'}
   :linked&&!same(e.correctionOf,linked.estimandRef)?{kind:'CORRECTION_REQUIRED'}
   :Date.parse(until)<=Date.now()?{kind:'EXPOSURE_STARTED'}:{kind:'AVAILABLE',until};
  base.choices.push({ref:r.ref,key:e.key,currency:e.currency,assignmentKind:e.assignment.kind,assignmentAt:e.assignmentAt,endpointAt:e.endpointAt,availability});
 }
 if(current){
  const binding=WorkEconomicBindingSchema.parse(current.payload),original=await readStoredEconomicRecordTx(ctx,binding.estimandRef.id,c);
  if(original.kind!=='PREREGISTRATION'||!same(original.ref,binding.estimandRef)||original.payload.mode!=='PROSPECTIVE')fail('ECONOMIC_WORK_ESTIMAND_BINDING_INVALID',503);
  const e=parseOutcomeEstimand(original.payload.estimand),cut=original.payload.sourceCut as EconomicEvidenceResolution[];
  const gaps=cut.filter(v=>v.status!=='RESOLVED_AUTHENTICATED').map(v=>v.ref.id);
  base.tracking={bindingRef:current.ref,estimandRef:original.ref,assignmentKind:e.assignment.kind,currency:e.currency,assignmentAt:e.assignmentAt,endpointAt:e.endpointAt,registeredLooks:e.analysis.registeredLooks,sourceGaps:gaps,sourceQualification:String(original.payload.sourceQualification)};
  base.state=gaps.length?'TRACKING_SOURCE_GAPS':'TRACKING_REGISTERED';
 }
 return {context:base,records,current};
}
const inspectOwned=(ctx:PeMutationContext,input:{workId:string;criterionIndex?:number})=>peTransaction(ctx,(db,c)=>inspect(ctx,input,db,c),{readOnly:true});
export async function readWorkEconomicContext(ctx:PeMutationContext,value:unknown){return(await inspectOwned(ctx,WorkEconomicOperationSchemas['work-context'].parse(value))).context;}
function requireAnchor(expected:WorkEconomicAnchor,current:WorkEconomicAnchor|null){if(!current||!same(expected,current))fail('ECONOMIC_WORK_ANCHOR_CHANGED');}
function replacement(current:StoredEconomicRecord|null,ref:EconomicRef|undefined,digest:string){
 if(current&&WorkEconomicBindingSchema.parse(current.payload).requestDigest===digest)return current;
 if(current?!ref||!same(current.ref,ref):Boolean(ref))fail('ECONOMIC_WORK_EXPLICIT_CORRECTION_REQUIRED');
 return null;
}
function future(original:StoredEconomicRecord,anchor:WorkEconomicAnchor,now:number){
 if(original.kind!=='PREREGISTRATION'||original.payload.mode!=='PROSPECTIVE')fail('ECONOMIC_WORK_PROSPECTIVE_ESTIMAND_REQUIRED');
 const e=parseOutcomeEstimand(original.payload.estimand);
 if(e.currency!==anchor.currency)fail('ECONOMIC_WORK_OWNER_CURRENCY_REQUIRED');
 if(e.episodeId!==anchor.workId)fail('ECONOMIC_WORK_EXPLICIT_EPISODE_REQUIRED');
 if(Date.parse(e.assignmentAt)<=now||Date.parse(e.outcomeAccessNotBefore)<=now||Date.parse(original.knowledgeAt)>=Date.parse(e.assignmentAt))fail('ECONOMIC_WORK_BINDING_MUST_PRECEDE_EXPOSURE');
 return e;
}
async function commitBinding(ctx:PeMutationContext,anchor:WorkEconomicAnchor,original:StoredEconomicRecord,current:StoredEconomicRecord|null,key:string,digest:string,c:PoolClient){
 const now=Date.parse((await c.query('SELECT clock_timestamp()::text now')).rows[0].now),e=future(original,anchor,now);
 if(current&&!same(e.correctionOf,WorkEconomicBindingSchema.parse(current.payload).estimandRef))fail('ECONOMIC_WORK_CORRECTION_ESTIMAND_REQUIRED');
 const {record,semanticReplay}=await persistEconomicRecordTx(ctx,{kind:'WORK_BINDING',payload:WorkEconomicBindingSchema.parse({schema:'finnor.s7.work-economic-binding.v1',anchor,estimandRef:original.ref,requestDigest:digest,measurementScope:'FUTURE_INTERVENTION_FROM_REGISTERED_CUT',completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false}),
  rightsRef:String(original.event.rightsRef),idempotencyKey:key,semanticRequestDigest:digest,estimandId:original.ref.id,...(current?{revisionOf:current.ref.id}:{}),validAt:new Date(now).toISOString(),freezeBefore:e.assignmentAt,horizon:'H0',uncertainty:'TRACKING_ONLY_MEASUREMENTS_SETTLEMENT_COSTS_AND_REVIEW_REQUIRED',dependencies:[original.ref]},c);
 return {binding:record,semanticReplay,trackingRegistered:true,completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false};
}
export async function bindWorkEconomicTracking(ctx:PeMutationContext,value:unknown){
 const input=WorkEconomicOperationSchemas['bind-work'].parse(value),digest=economicHash({operation:'bind-work',anchor:input.anchor,estimandRef:input.estimandRef,replacesBindingRef:input.replacesBindingRef??null});
 const preflight=await inspectOwned(ctx,{workId:input.anchor.workId,criterionIndex:input.anchor.criterionIndex});requireAnchor(input.anchor,preflight.context.anchor);
 const replay=await readEconomicReplay(ctx,'WORK_BINDING',input.idempotencyKey,digest);
 if(replay)return {binding:replay.record,semanticReplay:true,trackingRegistered:true,completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false};
 return peTransaction(ctx,async(db,c)=>{
  const live=await inspect(ctx,{workId:input.anchor.workId,criterionIndex:input.anchor.criterionIndex},db,c,true);requireAnchor(input.anchor,live.context.anchor);
  const existing=replacement(live.current,input.replacesBindingRef,digest);if(existing)return {binding:existing,semanticReplay:true,trackingRegistered:true,completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false};
  const original=await readStoredEconomicRecordTx(ctx,input.estimandRef.id,c);if(!same(original.ref,input.estimandRef))fail('ECONOMIC_WORK_ESTIMAND_REFERENCE_CHANGED');
  return commitBinding(ctx,input.anchor,original,live.current,input.idempotencyKey,digest,c);
 },{retryUniqueConstraints:bindingContentionConstraints});
}
export async function registerWorkEconomicTracking(ctx:PeMutationContext,value:unknown){
 const input=WorkEconomicOperationSchemas['register-work'].parse(value),estimand=parseOutcomeEstimand(input.estimand),digest=economicHash({operation:'register-work',anchor:input.anchor,estimand,rightsRef:input.rightsRef,replacesBindingRef:input.replacesBindingRef??null});
 const preflight=await inspectOwned(ctx,{workId:input.anchor.workId,criterionIndex:input.anchor.criterionIndex});requireAnchor(input.anchor,preflight.context.anchor);
 const replay=await readEconomicReplay(ctx,'WORK_BINDING',input.idempotencyKey,digest);
 if(replay)return {binding:replay.record,semanticReplay:true,trackingRegistered:true,completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false};
 const existing=replacement(preflight.current,input.replacesBindingRef,digest);if(existing)return {binding:existing,semanticReplay:true,trackingRegistered:true,completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false};
 if(estimand.episodeId!==input.anchor.workId)fail('ECONOMIC_WORK_EXPLICIT_EPISODE_REQUIRED');
 if(estimand.currency!==input.anchor.currency)fail('ECONOMIC_WORK_OWNER_CURRENCY_REQUIRED');
 const prepared=await prepareOutcomeEstimandRegistration(ctx,{estimand,rightsRef:input.rightsRef,idempotencyKey:'work-estimand:'+input.idempotencyKey,mode:'PROSPECTIVE'});
 return peTransaction(ctx,async(db,c)=>{
  const live=await inspect(ctx,{workId:input.anchor.workId,criterionIndex:input.anchor.criterionIndex},db,c,true);requireAnchor(input.anchor,live.context.anchor);
  const concurrent=replacement(live.current,input.replacesBindingRef,digest);if(concurrent)return {binding:concurrent,semanticReplay:true,trackingRegistered:true,completionSatisfied:false,executionAuthorityGranted:false,causalCreditGranted:false};
  const original=await persistEconomicRecordTx(ctx,prepared,c);
  return commitBinding(ctx,input.anchor,original.record,live.current,input.idempotencyKey,digest,c);
 },{retryUniqueConstraints:bindingContentionConstraints});
}
