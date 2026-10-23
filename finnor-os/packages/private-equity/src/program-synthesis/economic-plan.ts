import type {PoolClient} from 'pg';
import {transactionDb,beginWorkPlannerAttemptTx,persistSelectedWorkPlanTx,finishWorkPlannerAttemptTx} from '@finnor/db';
import {buildGoalSpec,buildConstraintSet,buildPlanningWorldSnapshot,compileAndSelectPlans,DEFAULT_PLAN_BUDGETS,
 type CandidatePlan,type CandidateCompilationFacts,type PlanningSnapshotCapability} from '@finnor/planning';
import type {PeMutationContext} from '../types';
import {ECONOMIC_NATIVE_ACTION,economicNativeCapability,economicStepIntent,EconomicNativeIntent,type EconomicStep} from './economic-native';
import {digest,fail,type TheoryRow,type State,type EconomicRef} from '../economic-action-theory/contracts';
/** Native Work PlanGraph binds each exact S6 owner step and its observation.
 * These actions are never offered as permissive model/plugin opcodes. */
export async function selectEconomicProgrammePlanTx(ctx:PeMutationContext,c:PoolClient,row:TheoryRow,programmeId:string,
 reservationRef:EconomicRef,goalState:State,steps:EconomicStep[]){
 const db=transactionDb(c),attempt=await beginWorkPlannerAttemptTx(db,{tenantId:row.tenant_id,workId:row.work_id,
  workInputId:row.work_input_id,attemptKey:'y1-programme:'+programmeId}),query={intent:'economic_programme_v1' as const,programmeId,workId:row.work_id};
 const goal=buildGoalSpec({objective:row.request.problem.goal.title,workId:row.work_id,workInputId:row.work_input_id,
  targets:[{kind:'entity',type:row.root.entityType,id:row.root.entityId,sourceRef:'S1:authenticated-root'}],
  deadline:row.deadline_at.toISOString(),explicitNonGoals:['external_economic_effects','protected_admission','financial_efficacy'],
  successCondition:{version:1,statement:'Observe the exact compiled internal economic programme',source:'explicit',mode:'all',criteria:[
   {kind:'canonical_query',request:query,assertion:{path:['data','status'],operator:'eq',expected:'OBSERVED'}},
   {kind:'canonical_query',request:query,assertion:{path:['data','observedGoalDigest'],operator:'eq',expected:digest(goalState)}}]}});
 const capability:PlanningSnapshotCapability={capability:'query:economic_programme_v1',kind:'query',modelProposable:false,
  available:true,health:'available',risk:'low',irreversible:false,requiredReferences:['workId','programmeId'],effectClass:null,
  observationStrategy:'operational_query',reversibility:'read_only',supportedRecoveryModes:['retry'],externalSideEffect:false,authorityRequirement:'query'};
 const native=economicNativeCapability();
 if(!native.available)fail('P1_ECONOMIC_NATIVE_OWNER_UNAVAILABLE');
 const constraints=buildConstraintSet({tenantId:row.tenant_id,verticalKey:'private_equity',allowedCapabilities:[native.capability,capability.capability,'check:objective_success'],
  humanOnlyCapabilities:[],prohibitedCapabilities:[],authorityRevision:Number(row.rights_revision),
  budgets:{...DEFAULT_PLAN_BUDGETS,maxActions:steps.length,maxDepth:steps.length+3,maxNodes:steps.length+3},deadlineAt:row.deadline_at.toISOString(),softPreferences:[]});
 const snapshot=buildPlanningWorldSnapshot({tenantId:row.tenant_id,verticalKey:'private_equity',workId:row.work_id,
  workInputId:row.work_input_id,plannerAttemptId:attempt.id,capturedAt:new Date().toISOString(),decisionContextHash:digest({goalState,steps}),
  canonicalStateHash:row.work_input_digest,canonicalEntities:[{kind:'entity',type:row.root.entityType,id:row.root.entityId,
   versionHash:null,sourceRef:'S1:authenticated-root'}],authority:{revision:Number(row.rights_revision),roles:[ctx.auth.role],employeeId:row.principal_id},
  capabilities:[native,capability],currentEffects:[],sourceHealth:{status:'complete',missing:[]}});
 const candidate:CandidatePlan={version:1,candidateKey:'y1-exact-economic-programme-observation',
  nodes:[...steps.map((step,index)=>({key:'economic_step_'+index,kind:'action' as const,actionType:ECONOMIC_NATIVE_ACTION,
    payload:economicStepIntent(row.artifact!.envelope.contentRef,programmeId,reservationRef,index,step),
    dependsOn:index?['economic_step_'+(index-1)]:[],
    recovery:{version:1 as const,on:['failure' as const,'stale' as const,'timeout' as const],mode:'recover' as const,maxAttempts:1,neverReplayVerifiedIrreversibleEffect:true as const}})),
   {key:'observe_economic_programme',kind:'query',request:query,supports:goal.criteria.map(x=>x.id),dependsOn:['economic_step_'+(steps.length-1)]},
   ...goal.criteria.map((criterion,i)=>({key:'check_'+i,kind:'check' as const,criterionId:criterion.id,
    dependsOn:['observe_economic_programme'],observation:criterion.criterion}))]};
 const facts:CandidateCompilationFacts={candidateKey:candidate.candidateKey,nodes:Object.fromEntries(candidate.nodes.map(node=>[node.key,{
  capability:node.kind==='action'?native.capability:node.kind==='query'?capability.capability:'check:objective_success',
  registered:true,schemaValid:node.kind!=='action'||EconomicNativeIntent.safeParse(node.payload).success,schemaErrors:[],
  grounded:true,crossTenant:false,stale:false,authority:'allowed',health:'available',risk:node.kind==='action'?'medium':'low',irreversible:false,
  requiredReferences:node.kind==='action'?native.requiredReferences:node.kind==='query'?['workId','programmeId']:['criterionId'],
  estimatedCostMicros:null,estimatedLatencyMs:null,supportedRecoveryModes:node.kind==='action'?['recover','escalate']:['retry']}]))};
 const compiled=compileAndSelectPlans({candidates:[candidate],facts:[facts],goal,constraints,snapshot});
 if(!compiled.selected?.graph)fail('P1_ECONOMIC_NATIVE_PLAN_REJECTED');
 const parent=(await c.query<{id:string}>('SELECT id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision DESC LIMIT 1',[row.tenant_id,row.work_id])).rows[0];
 const plan=await persistSelectedWorkPlanTx(db,{tenantId:row.tenant_id,workId:row.work_id,workInputId:row.work_input_id,
  plannerAttemptId:attempt.id,parentRevisionId:parent?.id??null,reason:parent?'redirect':'initial',goalSpec:goal,constraintSet:constraints,
  planningSnapshot:snapshot,candidatePlans:[candidate],compilationResult:compiled,planGraph:compiled.selected.graph,
  score:compiled.selected.score,semanticHash:compiled.selected.graph.semanticHash});
 await finishWorkPlannerAttemptTx(db,{tenantId:row.tenant_id,attemptId:attempt.id,status:'succeeded',
  plannerResult:{planRevisionId:plan.id,programmeId,qualification:'EXACT_INTERNAL_OWNER_OBSERVATION_NOT_FINANCIAL_COMPLETION'}});
 return {...plan,economicSteps:steps.map((step,index)=>{
  const node=compiled.selected!.graph!.nodes.find(n=>n.kind==='action'&&n.payload.stepIndex===index);
  if(!node)fail('P1_ECONOMIC_EXACT_ACTION_NODE_REQUIRED');
  return {...step,planNodeId:node.id};
 })};
}
