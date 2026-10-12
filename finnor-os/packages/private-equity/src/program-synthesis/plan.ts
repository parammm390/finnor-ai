import {beginWorkPlannerAttempt,beginWorkPlannerAttemptTx,persistSelectedWorkPlan,persistSelectedWorkPlanTx,finishWorkPlannerAttempt,finishWorkPlannerAttemptTx,type Db} from '@finnor/db';
import {buildGoalSpec,buildConstraintSet,buildPlanningWorldSnapshot,compileAndSelectPlans,DEFAULT_PLAN_BUDGETS,type CandidatePlan,type CandidatePlanNode,type CandidateCompilationFacts,type PlanningSnapshotCapability} from '@finnor/planning';
import {PROGRAM_OPERATIONAL_QUERY_INTENTS} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {sha,principal} from '../evidence-execution/store';
import {isInstitutionRequest,type HarnessRequest,type InstitutionHarnessRequest} from './contracts';
import {loadInstitutionProfile} from '../institution-program/store';

/** Canonical PlanGraph owns the ordinary query/check lifecycle. Harness nodes
 * are the implementation of this native query, never permissive DomainActions. */
export async function selectHarnessPlan(ctx:PeMutationContext,request:HarnessRequest|InstitutionHarnessRequest,binding:{programId:string;workId:string;inputId:string;inputDigest:string;parentRevisionId:string|null;rightsRevision:number;deadlineAt:string},db?:Db){
 if(isInstitutionRequest(request))return selectInstitutionPlan(ctx,request,binding,db);
 if(!PROGRAM_OPERATIONAL_QUERY_INTENTS.includes('harness_program_v1'))throw Error('HARNESS_QUERY_CAPABILITY_UNREGISTERED');
 const attempt=await beginWorkPlannerAttempt({tenantId:ctx.auth.tenantId,workId:binding.workId,workInputId:binding.inputId,attemptKey:'p1:'+binding.programId});
 const goal=buildGoalSpec({objective:request.instruction,workId:binding.workId,workInputId:binding.inputId,targets:[{kind:'entity',type:request.root.entityType,id:request.root.entityId,sourceRef:'S1:authenticated-root'}],deadline:binding.deadlineAt,explicitNonGoals:['external_effect_dispatch','IC_approval','S5_reservation','S8_admission'],successCondition:{version:1,statement:request.instruction,source:'explicit',mode:'all',criteria:[{kind:'canonical_query',request:{intent:'harness_program_v1',programId:binding.programId,workId:binding.workId},assertion:{path:['data','status'],operator:'eq',expected:'TESTED'}},{kind:'canonical_query',request:{intent:'harness_program_v1',programId:binding.programId,workId:binding.workId},assertion:{path:['data','program','acceptanceDigest'],operator:'eq',expected:sha(request.acceptance)}}]}});
 const capability:PlanningSnapshotCapability={capability:'query:harness_program_v1',kind:'query',modelProposable:false,available:true,health:'available',risk:'low',irreversible:false,requiredReferences:['workId','programId'],effectClass:null,observationStrategy:'operational_query',reversibility:'read_only',supportedRecoveryModes:['retry'],externalSideEffect:false,authorityRequirement:'query'};
 const waits=(request.operations??[]).filter(o=>o.op==='await_observation');
 const waitCapability:PlanningSnapshotCapability={capability:'wait:event',kind:'wait',modelProposable:false,available:true,health:'available',risk:'medium',irreversible:false,requiredReferences:['correlation'],effectClass:null,observationStrategy:'integration_event',reversibility:'read_only',supportedRecoveryModes:['replan','recover','escalate'],externalSideEffect:false,authorityRequirement:'policy'};
 const capabilities=waits.length?[capability,waitCapability]:[capability];
 const constraints=buildConstraintSet({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',allowedCapabilities:[...capabilities.map(c=>c.capability),'check:objective_success'],humanOnlyCapabilities:[],prohibitedCapabilities:[],authorityRevision:binding.rightsRevision,budgets:{...DEFAULT_PLAN_BUDGETS,maxActions:0},deadlineAt:binding.deadlineAt,softPreferences:[]});
 const snapshot=buildPlanningWorldSnapshot({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',workId:binding.workId,workInputId:binding.inputId,plannerAttemptId:attempt.id,capturedAt:new Date().toISOString(),decisionContextHash:sha(request.acceptance),canonicalStateHash:binding.inputDigest,canonicalEntities:[{kind:'entity',type:request.root.entityType,id:request.root.entityId,versionHash:null,sourceRef:'S1:authenticated-root'}],authority:{revision:binding.rightsRevision,roles:[ctx.auth.role],employeeId:principal(ctx)},capabilities,currentEffects:[],sourceHealth:{status:'complete',missing:[]}});
 const nodes:CandidatePlanNode[]=[];let previous:string|undefined;
 for(const operation of waits){const key='wait_'+operation.key;nodes.push({key,kind:'wait',waitFor:operation.waitFor,earliestAt:operation.earliestAt,deadlineAt:operation.deadlineAt,...(previous?{dependsOn:[previous]}:{}),recovery:{version:1,on:['failure','stale','timeout','divergence'],mode:'escalate',maxAttempts:1,neverReplayVerifiedIrreversibleEffect:true}});previous=key;}
 if(waits.length){nodes.push({key:'wait_checked_publication',kind:'wait',waitFor:{eventType:'p1.harness.checked',resource:{type:'work',id:binding.workId},correlationId:binding.programId},earliestAt:new Date().toISOString(),deadlineAt:binding.deadlineAt,dependsOn:previous?[previous]:[],recovery:{version:1,on:['failure','stale','timeout','divergence'],mode:'escalate',maxAttempts:1,neverReplayVerifiedIrreversibleEffect:true}});previous='wait_checked_publication';}
 nodes.push({key:'execute_harness',kind:'query',request:{intent:'harness_program_v1',programId:binding.programId,workId:binding.workId},supports:goal.criteria.map(c=>c.id),...(previous?{dependsOn:[previous]}:{})},...goal.criteria.map((c,i)=>({key:'check_'+i,kind:'check' as const,criterionId:c.id,dependsOn:['execute_harness'],observation:c.criterion})));
 const candidate:CandidatePlan={version:1,candidateKey:'p1-native-implementation',nodes};
 const facts:CandidateCompilationFacts={candidateKey:candidate.candidateKey,nodes:Object.fromEntries(candidate.nodes.map(n=>[n.key,{capability:n.kind==='query'?capability.capability:n.kind==='wait'?'wait:event':'check:objective_success',registered:true,schemaValid:true,schemaErrors:[],grounded:true,crossTenant:false,stale:false,authority:'allowed',health:'available',risk:n.kind==='wait'?'medium':'low',irreversible:false,requiredReferences:n.kind==='wait'?['correlation']:['workId','programId'],estimatedCostMicros:null,estimatedLatencyMs:null,supportedRecoveryModes:n.kind==='wait'?['replan','recover','escalate']:['retry']}]))};
 const compiled=compileAndSelectPlans({candidates:[candidate],facts:[facts],goal,constraints,snapshot});if(!compiled.selected?.graph){await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'failed',failure:{code:'P1_CANONICAL_PLAN_REJECTED',compiled}});throw Error('P1_CANONICAL_PLAN_REJECTED');}
 const objective=await (await import('../../../orchestration/src/objective-loop')).bindHarnessWorkObjective({tenantId:ctx.auth.tenantId,principalId:principal(ctx),workId:binding.workId,workInputId:binding.inputId,instruction:request.instruction,programId:binding.programId,acceptanceDigest:sha(request.acceptance),deadlineAt:binding.deadlineAt});
 const plan=await persistSelectedWorkPlan({tenantId:ctx.auth.tenantId,workId:binding.workId,workInputId:binding.inputId,plannerAttemptId:attempt.id,objectiveLoopId:objective.id,parentRevisionId:binding.parentRevisionId,reason:binding.parentRevisionId?'redirect':'initial',goalSpec:goal,constraintSet:constraints,planningSnapshot:snapshot,candidatePlans:[candidate],compilationResult:compiled,planGraph:compiled.selected.graph,score:compiled.selected.score,semanticHash:compiled.selected.graph.semanticHash});
 await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'succeeded',plannerResult:{planRevisionId:plan.id,qualification:'ORDINARY_HARNESS_IMPLEMENTATION_NOT_S4_BUSINESS_SELECTION'}});return {goal,planGraph:compiled.selected.graph,planRevisionId:plan.id};
}

/** Native selected action batches preserve the full responsibility population.
 * P1 owns deterministic action identities; Objective receives an observation-only
 * child once independently observed creation effects satisfy the whole goal. */
export function institutionPlanBatchSize(){
 const bounds=loadInstitutionProfile().bounds;
 const size=Math.min(bounds.nativePlanNodes-3,bounds.nodePreconditionsOrDependencies);
 if(!Number.isSafeInteger(size)||size<1)throw Error('X1_NATIVE_PLAN_PROFILE_UNSUPPORTED');
 return size;
}

export async function selectInstitutionPlan(ctx:PeMutationContext,request:InstitutionHarnessRequest,binding:{
 programId:string;workId:string;inputId:string;inputDigest:string;parentRevisionId:string|null;
 rightsRevision:number;deadlineAt:string;cursor?:number;
},db?:Db){
 const profile=loadInstitutionProfile(),cursor=binding.cursor??0;
 const actions=request.institution.responsibilities.flatMap(duty=>{
  const action=request.institution.actions?.find(a=>a.responsibilityIdentity===duty.obligation.stableIdentity);
  return action?[action]:[];
 });
 if(!Number.isSafeInteger(cursor)||cursor<0||cursor>actions.length
   ||actions.length>profile.bounds.derivedObligations)throw Error('X1_NATIVE_BATCH_POPULATION_INVALID');
 const batch=actions.slice(cursor,cursor+institutionPlanBatchSize());
 const objective=await (await import('../../../orchestration/src/objective-loop')).bindHarnessWorkObjective({
  tenantId:ctx.auth.tenantId,principalId:principal(ctx),workId:binding.workId,
  workInputId:binding.inputId,instruction:request.instruction,programId:binding.programId,
  acceptanceDigest:sha(request.institution),deadlineAt:binding.deadlineAt,expectedStatus:'OBSERVED'},db);
 const attemptParams={tenantId:ctx.auth.tenantId,workId:binding.workId,
  workInputId:binding.inputId,attemptKey:'p1:'+binding.programId+':batch:'+cursor};
 const attempt=db?await beginWorkPlannerAttemptTx(db,attemptParams):await beginWorkPlannerAttempt(attemptParams);
 const query={intent:'harness_program_v1' as const,programId:binding.programId,workId:binding.workId};
 const goal=buildGoalSpec({objective:request.instruction,workId:binding.workId,workInputId:binding.inputId,
  targets:[{kind:'entity',type:request.root.entityType,id:request.root.entityId,sourceRef:'S1:authenticated-root'}],
  deadline:binding.deadlineAt,explicitNonGoals:['fabricated_numerical_acceptance','unobserved_completion','protected_dispatch'],
  successCondition:{version:1,statement:request.instruction,source:'explicit',mode:'all',criteria:[
   {kind:'canonical_query',request:query,assertion:{path:['data','status'],operator:'eq',expected:'OBSERVED'}},
   {kind:'canonical_query',request:query,assertion:{path:['data','program','acceptanceDigest'],operator:'eq',expected:sha(request.institution)}},
  ]}});
 const {createDefaultPluginRegistry,planningCapabilitiesForVertical}=await import('../../../orchestration/src/plugin-registry');
 const {LLMPlanner}=await import('../../../orchestration/src/planner');
 const registry=createDefaultPluginRegistry(),manifest=planningCapabilitiesForVertical(registry,'private_equity');
 const allowed=new Set(['query:harness_program_v1','check:objective_success',...batch.map(a=>a.operation)]);
 const capabilities=manifest.filter(capability=>allowed.has(capability.capability));
 if(capabilities.length!==allowed.size)throw Error('X1_REGISTERED_NATIVE_CAPABILITY_REQUIRED');
 const constraints=buildConstraintSet({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',
  allowedCapabilities:[...allowed],humanOnlyCapabilities:[],prohibitedCapabilities:[],
  authorityRevision:binding.rightsRevision,budgets:{...DEFAULT_PLAN_BUDGETS,
   maxNodes:profile.bounds.nativePlanNodes,maxActions:institutionPlanBatchSize()},
  deadlineAt:binding.deadlineAt,softPreferences:[]});
 const {tx}=await import('../evidence-execution/store');
 const {sha256}=await import('@finnor/planning');
 const policies=await tx(ctx,async c=>(await c.query<{action_type:string;policy_id:string;version:number;policy:Record<string,unknown>;requires_confirmation:boolean}>(
  `SELECT DISTINCT ON(action_type) action_type,policy_id,version,policy,requires_confirmation
   FROM finnor_os.domain_policy_revisions WHERE tenant_id=$1 AND action_type=ANY($2::text[])
    AND effective_from<=clock_timestamp() ORDER BY action_type,effective_from DESC,version DESC`,
  [ctx.auth.tenantId,batch.map(a=>a.operation)])).rows,true);
 const policyRefs=policies.map(p=>({actionType:p.action_type,policyId:p.policy_id,version:p.version,
  semanticHash:sha256({actionType:p.action_type,policyId:p.policy_id,version:p.version,
   policy:p.policy,requiresConfirmation:p.requires_confirmation})}));
 const snapshot=buildPlanningWorldSnapshot({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',
  workId:binding.workId,workInputId:binding.inputId,plannerAttemptId:attempt.id,
  capturedAt:new Date().toISOString(),decisionContextHash:sha(request.institution),
  canonicalStateHash:binding.inputDigest,canonicalEntities:[{kind:'entity',
   type:request.root.entityType,id:request.root.entityId,versionHash:null,sourceRef:'S1:authenticated-root'}],
  authority:{revision:binding.rightsRevision,roles:[ctx.auth.role],employeeId:principal(ctx)},
  capabilities,policyRefs,currentEffects:[],sourceHealth:{status:request.institution.unresolved.length?'partial':'complete',
   missing:request.institution.unresolved.map(item=>item.stableIdentity)}});
 const actionNodes:CandidatePlanNode[]=batch.map(action=>({
  key:'duty_'+sha(action.responsibilityIdentity).slice(0,24),kind:'action',
  actionType:action.operation,payload:action.payload,
  expectedEffects:[{kind:'business_effect',assertion:{responsibilityIdentity:action.responsibilityIdentity,
   expectedEntityId:action.expectedEntityId,postconditionDigest:action.postconditionDigest}}],
 }));
 const candidate:CandidatePlan={version:1,candidateKey:'p1-institution-responsibility-v1-batch-'+cursor,
  nodes:[...actionNodes,{key:'observe_institution',kind:'query',request:query,
    dependsOn:actionNodes.map(node=>node.key),supports:goal.criteria.map(c=>c.id)},
   ...goal.criteria.map((c,i)=>({key:'check_'+i,kind:'check' as const,
    criterionId:c.id,dependsOn:['observe_institution'],observation:c.criterion}))]};
 const planning=await new LLMPlanner(registry).compileCandidatePlans({candidates:[candidate],
  tenantContext:ctx.auth,verticalKey:'private_equity',goal,constraints,snapshot,useDatabase:true,
  reservedActionIdentities:Object.fromEntries(actionNodes.map((node,i)=>[node.key,batch[i]!.expectedEntityId]))});
 const compiled=planning.compilation;
 const finish=async(params:Parameters<typeof finishWorkPlannerAttempt>[0])=>db
  ?finishWorkPlannerAttemptTx(db,params):finishWorkPlannerAttempt(params);
 if(!compiled.selected?.graph){await finish({tenantId:ctx.auth.tenantId,attemptId:attempt.id,
  status:'failed',failure:{code:'P1_CANONICAL_PLAN_REJECTED',compiled}});throw Error('P1_CANONICAL_PLAN_REJECTED');}
 for(const action of batch){
  const selected=compiled.selected.graph.nodes.filter(node=>node.kind==='action'
   &&node.actionType===action.operation&&sha(node.payload)===sha(action.payload));
  if(selected.length!==1||selected[0]!.kind!=='action'
    ||sha(selected[0]!.groundedPayload)!==sha(action.payload))
   throw Error('X1_NATIVE_SCHEMA_NORMALIZATION_REQUIRES_EXPLICIT_INTENT');
 }
 const params={tenantId:ctx.auth.tenantId,workId:binding.workId,workInputId:binding.inputId,
  plannerAttemptId:attempt.id,objectiveLoopId:objective.id,parentRevisionId:binding.parentRevisionId,
  reason:binding.parentRevisionId?'observation' as const:'initial' as const,
  goalSpec:goal,constraintSet:constraints,planningSnapshot:snapshot,candidatePlans:[candidate],
  compilationResult:compiled,planGraph:compiled.selected.graph,score:compiled.selected.score,
  semanticHash:compiled.selected.graph.semanticHash};
 const plan=db?await persistSelectedWorkPlanTx(db,params):await persistSelectedWorkPlan(params);
 await finish({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'succeeded',plannerResult:{
  planRevisionId:plan.id,batchStart:cursor,batchEnd:cursor+batch.length,totalActions:actions.length,
  qualification:batch.length?'TYPED_NATIVE_ACTION_BATCH_NOT_COMPLETION':'TYPED_INSTITUTION_OBSERVATION_NOT_COMPLETION'}});
 return {goal,planGraph:compiled.selected.graph,planRevisionId:plan.id};
}
