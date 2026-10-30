import {beginWorkPlannerAttempt,finishWorkPlannerAttempt,persistSelectedWorkPlan,type Db} from '@finnor/db';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {buildGoalSpec,buildConstraintSet,buildPlanningWorldSnapshot,DEFAULT_PLAN_BUDGETS,type CandidatePlan} from '@finnor/planning';
import {PrimaryIntakeSchema,type CanonicalOperationalQueryRequest,type PrimaryMandate} from '@finnor/shared-types';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {actor,authorize,governance,hash,tx,unavailable} from './store';

const INTENT='primary_diligence_v1';
const FIELDS=['status','current','definitionDigest','nativeOwnerConsumed'] as const;
const safe=(e:unknown)=>String((e as Error)?.message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'R12_PREDICATE_UNPASSED';

function developmentOnly(){
 if(process.env.NODE_ENV==='production'||process.env.FINNOR_V2_PROFILE!=='ordinary_disposable')throw Error('LIVE_PRIMARY_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');
}
const planReference=(p:{id:string;revision:string|number;semantic_hash:string})=>
 ({owner:'WorkPlanRevision',id:p.id,version:String(p.revision),contentDigest:p.semantic_hash.replace(/^sha256:/,'')});

/** Success is the frozen all-of criterion set over the typed owner reader. The definition digest is the
 * digest of the exact accepted intake, so another Work's, another intake's or a replayed programme cannot satisfy it. */
function successFor(objective:string,workId:string,definitionDigest:string){
 const request={intent:INTENT,workId} as unknown as CanonicalOperationalQueryRequest&Record<string,unknown>;
 const expected={status:'COMPLETE',current:true,definitionDigest,nativeOwnerConsumed:true};
 return {request,condition:{version:1 as const,statement:objective,source:'explicit' as const,mode:'all' as const,
  criteria:FIELDS.map(field=>({kind:'canonical_query' as const,request,assertion:{path:['data',field],operator:'eq' as const,expected:expected[field]}}))}};
}

/** Selects the one objective plan on the ORIGINAL Work for an exact primary-diligence intake. It adds no input,
 * funding, authority or programme: the programme is still created only by primary-submit. */
export async function selectPrimaryPlan(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const intake=PrimaryIntakeSchema.parse(raw);
 if(intake.mode!=='ordinary_disposable')throw Error('LIVE_PRIMARY_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');
 if(new Set(intake.assertions.map(a=>a.assertionId)).size!==intake.assertions.length)throw Error('DUPLICATE_FROZEN_ASSERTION_ID');
 await authorize(ctx,intake.root as PeWorldRootRef,intake.workId);
 const definitionDigest=hash(intake);
 const mandate=await governance<PrimaryMandate>(ctx,intake.mandateRef,'finnor.primary-mandate.v1');
 if(mandate.issuingPrincipalId!==actor(ctx))throw unavailable();
 const deadlineAt=new Date(mandate.stopping.deadline).toISOString();
 if(Date.parse(deadlineAt)<=Date.now())throw Error('ORIGINAL_PRIMARY_DEADLINE_EXHAUSTED');
 const bound=await tx(ctx,async c=>{
  const native=(await c.query(`SELECT i.instruction_id,i.instruction_text,w.created_by,w.status,
    (SELECT id FROM finnor_os.work_inputs n WHERE n.tenant_id=i.tenant_id AND n.work_id=i.work_id ORDER BY n.created_at DESC,n.id DESC LIMIT 1) latest_id
    FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
    WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3 FOR SHARE OF i,w`,[ctx.auth.tenantId,intake.workId,intake.expectedWorkInputId])).rows[0];
  if(!native||native.latest_id!==intake.expectedWorkInputId||native.created_by!==actor(ctx)||['completed','failed','cancelled'].includes(native.status))throw Error('R12_ORIGINAL_CURRENT_WORK_INPUT_REQUIRED');
  const prior=(await c.query(`SELECT id,revision,semantic_hash,status,work_input_id,goal_spec,constraint_set FROM finnor_os.work_plan_revisions
   WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision DESC LIMIT 1`,[ctx.auth.tenantId,intake.workId])).rows[0];
  if(prior){
   const same=prior.status==='active'&&prior.work_input_id===intake.expectedWorkInputId&&prior.constraint_set?.deadlineAt===deadlineAt&&
    prior.goal_spec?.criteria?.some((x:{criterion?:{request?:{intent?:string};assertion?:{expected?:unknown;path?:string[]}}})=>
     x.criterion?.request?.intent===INTENT&&x.criterion.assertion?.path?.join('.')==='data.definitionDigest'&&x.criterion.assertion.expected===definitionDigest);
   if(!same)throw Error('R12_ORIGINAL_PLAN_CANNOT_BE_REPLACED');
   return {prior,instruction:native,authorityRevision:0};
  }
  if((await c.query('SELECT 1 FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',[ctx.auth.tenantId,intake.workId])).rowCount)throw Error('R12_ORIGINAL_OBJECTIVE_CANNOT_BE_REPLACED');
  return {prior:null,instruction:native,authorityRevision:Number((await employeeAuthoritySnapshotTx(ctx.auth,c)).revision)};
 });
 if(bound.prior){
  await wakePrimaryObjective(ctx,intake.workId);
  return {workRevisionRef:planReference(bound.prior),definitionDigest,deadlineAt,replayed:true};
 }
 const objectiveText=String(bound.instruction.instruction_text),{request,condition}=successFor(objectiveText,intake.workId,definitionDigest);
 const goal=buildGoalSpec({objective:objectiveText,workId:intake.workId,workInputId:intake.expectedWorkInputId,
  targets:[{kind:'entity',type:intake.root.entityType,id:intake.root.entityId,sourceRef:'S1:authenticated-root'}],
  deadline:deadlineAt,explicitNonGoals:['source_truth','S6_effect_dispatch','S8_security_admission','protected_qualification','production_activation','live_primary_acquisition'],successCondition:condition});
 const {createDefaultPluginRegistry,planningCapabilitiesForVertical}=await import('../../../orchestration/src/plugin-registry');
 const {LLMPlanner}=await import('../../../orchestration/src/planner');
 const registry=createDefaultPluginRegistry(),allowed=['query:'+INTENT,'check:objective_success'];
 const capabilities=planningCapabilitiesForVertical(registry,'private_equity').filter(c=>allowed.includes(c.capability));
 if(capabilities.length!==allowed.length)throw Error('R12_REGISTERED_NATIVE_CAPABILITY_REQUIRED');
 const attempt=await beginWorkPlannerAttempt({tenantId:ctx.auth.tenantId,workId:intake.workId,workInputId:intake.expectedWorkInputId,attemptKey:'r12-plan:'+definitionDigest});
 try{
  const constraints=buildConstraintSet({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',allowedCapabilities:allowed,
   humanOnlyCapabilities:[],prohibitedCapabilities:[],authorityRevision:bound.authorityRevision,
   budgets:{...DEFAULT_PLAN_BUDGETS,maxActions:0},deadlineAt,softPreferences:[]});
  const snapshot=buildPlanningWorldSnapshot({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',workId:intake.workId,
   workInputId:intake.expectedWorkInputId,plannerAttemptId:attempt.id,capturedAt:new Date().toISOString(),decisionContextHash:definitionDigest,
   canonicalStateHash:hash({workId:intake.workId,workInputId:intake.expectedWorkInputId,instruction:bound.instruction.instruction_id}),
   canonicalEntities:[{kind:'entity',type:intake.root.entityType,id:intake.root.entityId,versionHash:null,sourceRef:'S1:authenticated-root'}],
   authority:{revision:bound.authorityRevision,roles:[ctx.auth.role],employeeId:actor(ctx)},capabilities,
   currentEffects:[],sourceHealth:{status:'complete',missing:[]}});
  const candidate:CandidatePlan={version:1,candidateKey:'r12-native-primary-diligence-observation',nodes:[
   {key:'observe_primary_diligence',kind:'query',request,supports:goal.criteria.map(c=>c.id)},
   ...goal.criteria.map((c,i)=>({key:'check_'+i,kind:'check' as const,criterionId:c.id,dependsOn:['observe_primary_diligence'],observation:c.criterion})),
  ]};
  const result=await new LLMPlanner(registry).compileCandidatePlans({candidates:[candidate],tenantContext:ctx.auth,verticalKey:'private_equity',goal,constraints,snapshot,useDatabase:true});
  if(!result.compilation.selected?.graph)throw Error('R12_CANONICAL_PLAN_REJECTED');
  const objective=await (await import('../../../orchestration/src/objective-loop')).startWorkObjective(objectiveText,ctx.auth,
   {workId:intake.workId,workInputId:intake.expectedWorkInputId,instructionId:bound.instruction.instruction_id,channel:'console',successCondition:condition,
    maxSteps:12,maxActions:0,maxQueries:12,deadlineAt:new Date(deadlineAt),deferInitialIteration:true,initialNativeWait:true});
  const selected=result.compilation.selected,plan=await persistSelectedWorkPlan({tenantId:ctx.auth.tenantId,workId:intake.workId,workInputId:intake.expectedWorkInputId,
   plannerAttemptId:attempt.id,objectiveLoopId:objective.objectiveLoopId,parentRevisionId:null,reason:'initial',goalSpec:goal,constraintSet:constraints,
   planningSnapshot:snapshot,candidatePlans:[candidate],compilationResult:result.compilation,planGraph:selected.graph!,score:selected.score,semanticHash:selected.graph!.semanticHash});
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'succeeded',plannerResult:{planRevisionId:plan.id,executionAuthorityGranted:false}});
  // A consumption that completed before the plan existed cannot wake a loop that did not exist then.
  await wakePrimaryObjective(ctx,intake.workId);
  return {workRevisionRef:planReference({id:plan.id,revision:plan.revision,semantic_hash:plan.semanticHash}),objectiveLoopId:objective.objectiveLoopId,definitionDigest,deadlineAt,replayed:false};
 }catch(error){
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'failed',failure:{code:'R12_CANONICAL_PLAN_NOT_SELECTED'}});throw error;
 }
}

/** Schedules a waiting original objective only from durable owner rows (a COMPLETE programme whose finding is bound to an
 * S3 underwriting run). It never records success: the loop still observes the typed reader. A refused precondition leaves
 * the loop waiting and is reported, never thrown into the already persisted consumer. */
export async function wakePrimaryObjective(ctx:PeMutationContext,workId:string):Promise<{woken:boolean;reason:string}>{
 try{
  const found=await tx(ctx,async c=>{
   const plan=(await c.query("SELECT id::text FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 AND status='active' ORDER BY revision DESC LIMIT 1",[ctx.auth.tenantId,workId])).rows[0];
   const row=(await c.query(`SELECT p.id::text programme_id,p.intake_digest,d.consumer_id::text run_id FROM finnor_os.v2_programmes p
    JOIN finnor_os.v2_findings f ON f.tenant_id=p.tenant_id AND f.principal_id=p.principal_id AND f.programme_id=p.id
    JOIN finnor_os.v2_consumer_dependencies d ON d.tenant_id=f.tenant_id AND d.finding_id=f.id AND d.consumer_type='underwriting_run'
    JOIN finnor_os.underwriting_runs r ON r.tenant_id=d.tenant_id AND r.id=d.consumer_id AND r.work_id=p.work_id
    WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.work_id=$3 ORDER BY d.created_at DESC,d.consumer_id DESC LIMIT 1`,[ctx.auth.tenantId,actor(ctx),workId])).rows[0];
   return {plan:plan?.id as string|undefined,row};
  },true);
  if(!found.plan)return {woken:false,reason:'NO_ACTIVE_PLAN'};
  if(!found.row)return {woken:false,reason:'NOT_CONSUMED'};
  const native=await import('../../../orchestration/src/objective-loop') as unknown as {
   schedulePreparedPrimaryDiligenceObjectiveTx?:(db:Db,params:{tenantId:string;workId:string;planRevisionId:string;programmeId:string;
    definitionDigest:string;underwritingRunId:string})=>Promise<void>;
  };
  if(!native.schedulePreparedPrimaryDiligenceObjectiveTx)throw Error('R12_NATIVE_OBJECTIVE_WAKE_NOT_INSTALLED');
  await tx(ctx,async(_c,db)=>native.schedulePreparedPrimaryDiligenceObjectiveTx!(db,{tenantId:ctx.auth.tenantId,workId,planRevisionId:found.plan!,
   programmeId:found.row.programme_id,definitionDigest:found.row.intake_digest,underwritingRunId:found.row.run_id}));
  return {woken:true,reason:'OWNER_CONSUMPTION_OBSERVED'};
 }catch(error){return {woken:false,reason:safe(error)};}
}
