import {receiveWork,attachWorkEntity,beginWorkPlannerAttempt,finishWorkPlannerAttempt,persistSelectedWorkPlan} from '@finnor/db';
import {employeeAuthoritySnapshotTx,canExerciseAuthorityTx} from '@finnor/authority';
import {buildGoalSpec,buildConstraintSet,buildPlanningWorldSnapshot,DEFAULT_PLAN_BUDGETS,
 type CandidatePlan} from '@finnor/planning';
import type {PeMutationContext} from '../types';
import {authorize,unavailable} from '../owner-context';
import {workCutTx} from '../enterprise-applications/store';
import {IntakeSchema,PlanSchema,parse,sha,fail,workPlanReference} from './contracts';
import {tx,principal} from './store';

/** The typed request enters Core at its original, idempotent intake. It does
 * not rewrite an existing Work input or create a replacement after failure. */
export async function receiveConfidentialWork(ctx:PeMutationContext,value:unknown){
 const input=parse(IntakeSchema,value);
 if(Date.parse(input.limits.deadlineAt)<=Date.now()||Date.parse(input.limits.deadlineAt)>Date.now()+3600000)
  fail('Y4_ORIGINAL_ONE_HOUR_EPISODE_REQUIRED');
 await tx(ctx,async c=>{
  await authorize(ctx,input.root,[],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:confidential_economic_computation',
   resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
 });
 const acceptedDigest=sha({root:input.root,function:input.function,limits:input.limits});
 const intake=await receiveWork({tenantId:ctx.auth.tenantId,userId:principal(ctx),
  instruction:input.function.purpose,channel:'console',
  idempotencyKey:'y4-intake:'+sha({principal:principal(ctx),key:input.idempotencyKey}),
  requireExactIntake:true,activeContext:{focusedEntity:input.root,confidentialAcceptedRequestDigest:acceptedDigest}});
 await attachWorkEntity(ctx.auth.tenantId,intake.workId,{...input.root,source:'Y4:original-authenticated-root'});
 return {...intake,acceptedRequestDigest:acceptedDigest,originalDeadlineAt:input.limits.deadlineAt,
  protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
}

/** Select only the analytical objective already accepted by the native input.
 * No existing objective, deadline, resource grant or success condition is
 * replaced. The query returns metadata, never outputs or their opening nonce. */
export async function selectConfidentialPlan(ctx:PeMutationContext,value:unknown){
 const input=parse(PlanSchema,value),acceptedDigest=sha({root:input.root,function:input.function,limits:input.limits});
 const request={intent:'confidential_economic_computation_v1' as const,workId:input.workId};
 const successCondition={version:1 as const,statement:input.function.purpose,source:'explicit' as const,mode:'all' as const,
  criteria:[
   {kind:'canonical_query' as const,request,assertion:{path:['data','status'],operator:'eq' as const,expected:'COMPUTED'}},
   {kind:'canonical_query' as const,request,assertion:{path:['data','definitionDigest'],operator:'eq' as const,expected:sha(input.function)}},
   {kind:'canonical_query' as const,request,assertion:{path:['data','recipientReleaseImported'],operator:'eq' as const,expected:true}},
   {kind:'canonical_query' as const,request,assertion:{path:['data','typedConsumerCurrent'],operator:'eq' as const,expected:true}},
  ]};
 const binding=await tx(ctx,async c=>{
  await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:confidential_economic_computation',
   resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  const cut=await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:input.workId});
  const native=(await c.query(`SELECT i.instruction_id,i.instruction_text,i.context_snapshot,w.created_by,w.status
   FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
   WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3`,[ctx.auth.tenantId,input.workId,input.workInputId])).rows[0];
  if(cut.id!==input.workInputId||!native||native.created_by!==principal(ctx)
   ||native.instruction_text!==input.function.purpose
   ||native.context_snapshot?.confidentialAcceptedRequestDigest!==acceptedDigest
   ||['completed','failed','cancelled'].includes(native.status))fail('Y4_ORIGINAL_TYPED_WORK_OBJECTIVE_REQUIRED');
  if(Date.parse(input.limits.deadlineAt)<=Date.now()||Date.parse(input.limits.deadlineAt)>Date.now()+3600000)
   fail('Y4_ORIGINAL_ONE_HOUR_EPISODE_REQUIRED');
  const prior=(await c.query(`SELECT id,revision,semantic_hash,status,work_input_id,goal_spec FROM finnor_os.work_plan_revisions
   WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision DESC LIMIT 1`,[ctx.auth.tenantId,input.workId])).rows[0];
  if(prior){
   const criteria=prior.goal_spec?.criteria;
   if(prior.status!=='active'||prior.work_input_id!==input.workInputId||!Array.isArray(criteria)
    ||!criteria.some((item:any)=>item.criterion?.kind==='canonical_query'
     &&item.criterion.request.intent==='confidential_economic_computation_v1'
     &&item.criterion.assertion?.path?.join('.')==='data.definitionDigest'
     &&item.criterion.assertion.expected===sha(input.function)))fail('Y4_ORIGINAL_PLAN_NOT_REPLACEABLE');
   return {prior,cut,instructionId:native.instruction_id,authorityRevision:0};
  }
  const originalObjective=(await c.query(`SELECT objective,success_condition,deadline_at,created_by,state
   FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2`,
   [ctx.auth.tenantId,input.workId])).rows[0];
  // Core startWorkObjective reuses the existing loop. Never replace its bounds.
  if(originalObjective&&(originalObjective.objective!==input.function.purpose
   ||sha(originalObjective.success_condition)!==sha(successCondition)
   ||originalObjective.deadline_at.getTime()!==Date.parse(input.limits.deadlineAt)
   ||originalObjective.created_by!==principal(ctx)
   ||['completed','failed','cancelled'].includes(originalObjective.state)))fail('Y4_ORIGINAL_OBJECTIVE_NOT_REPLACEABLE');
  const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
  return {prior:null,cut,instructionId:native.instruction_id,authorityRevision:Number(authority.revision)};
 });
 if(binding.prior)return {workRevisionRef:workPlanReference(binding.prior),replayed:true};
 const goal=buildGoalSpec({objective:input.function.purpose,workId:input.workId,workInputId:input.workInputId,
  targets:[{kind:'entity',type:input.root.entityType,id:input.root.entityId,sourceRef:'S1:authenticated-root'}],
  deadline:input.limits.deadlineAt,explicitNonGoals:['source_truth','S4_business_selection','S5_reservation',
   'S6_effect_dispatch','S8_admission','protected_qualification','production_activation'],successCondition});
 const {createDefaultPluginRegistry,planningCapabilitiesForVertical}=await import('../../../orchestration/src/plugin-registry');
 const {LLMPlanner}=await import('../../../orchestration/src/planner');
 const registry=createDefaultPluginRegistry(),allowed=['query:confidential_economic_computation_v1','check:objective_success'];
 const capabilities=planningCapabilitiesForVertical(registry,'private_equity').filter(c=>allowed.includes(c.capability));
 if(capabilities.length!==allowed.length)fail('Y4_REGISTERED_NATIVE_CAPABILITY_REQUIRED');
 const attempt=await beginWorkPlannerAttempt({tenantId:ctx.auth.tenantId,workId:input.workId,workInputId:input.workInputId,
  attemptKey:'y4-plan:'+acceptedDigest});
 try{
  const constraints=buildConstraintSet({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',allowedCapabilities:allowed,
   humanOnlyCapabilities:[],prohibitedCapabilities:[],authorityRevision:binding.authorityRevision,
   budgets:{...DEFAULT_PLAN_BUDGETS,maxActions:0},deadlineAt:input.limits.deadlineAt,softPreferences:[]});
  const snapshot=buildPlanningWorldSnapshot({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',workId:input.workId,
   workInputId:input.workInputId,plannerAttemptId:attempt.id,capturedAt:new Date().toISOString(),
   decisionContextHash:acceptedDigest,canonicalStateHash:binding.cut.digest,
   canonicalEntities:[{kind:'entity',type:input.root.entityType,id:input.root.entityId,versionHash:null,sourceRef:'S1:authenticated-root'}],
   authority:{revision:binding.authorityRevision,roles:[ctx.auth.role],employeeId:principal(ctx)},capabilities,
   currentEffects:[],sourceHealth:{status:'complete',missing:[]}});
  const candidate:CandidatePlan={version:1,candidateKey:'y4-native-analytical-query',nodes:[
   {key:'observe_confidential',kind:'query',request,supports:goal.criteria.map(c=>c.id)},
   ...goal.criteria.map((c,i)=>({key:'check_'+i,kind:'check' as const,criterionId:c.id,
    dependsOn:['observe_confidential'],observation:c.criterion})),
  ]};
  const result=await new LLMPlanner(registry).compileCandidatePlans({candidates:[candidate],tenantContext:ctx.auth,
   verticalKey:'private_equity',goal,constraints,snapshot,useDatabase:true}),compiled=result.compilation;
  if(!compiled.selected?.graph)fail('Y4_CANONICAL_PLAN_REJECTED');
  const objective=await (await import('../../../orchestration/src/objective-loop')).startWorkObjective(input.function.purpose,
   ctx.auth,{workId:input.workId,workInputId:input.workInputId,instructionId:binding.instructionId,channel:'console',
    successCondition,maxSteps:12,maxActions:0,maxQueries:12,deadlineAt:new Date(input.limits.deadlineAt),
    deferInitialIteration:true,initialNativeWait:true});
  const plan=await persistSelectedWorkPlan({tenantId:ctx.auth.tenantId,workId:input.workId,workInputId:input.workInputId,
   plannerAttemptId:attempt.id,objectiveLoopId:objective.objectiveLoopId,parentRevisionId:null,reason:'initial',
   goalSpec:goal,constraintSet:constraints,planningSnapshot:snapshot,candidatePlans:[candidate],compilationResult:compiled,
   planGraph:compiled.selected.graph,score:compiled.selected.score,semanticHash:compiled.selected.graph.semanticHash});
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'succeeded',
   plannerResult:{planRevisionId:plan.id,qualification:'ANALYTICAL_QUERY_NOT_S4_SELECTION_OR_COMPLETION'}});
  return {workRevisionRef:workPlanReference({id:plan.id,revision:plan.revision,semantic_hash:plan.semanticHash}),
   objectiveLoopId:objective.objectiveLoopId,replayed:false};
 }catch(error){
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'failed',
   failure:{code:'Y4_CANONICAL_PLAN_NOT_SELECTED'}});throw error;
 }
}
