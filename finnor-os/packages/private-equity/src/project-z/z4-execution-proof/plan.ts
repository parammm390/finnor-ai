import {receiveWork,attachWorkEntity,beginWorkPlannerAttempt,finishWorkPlannerAttempt,persistSelectedWorkPlan} from '@finnor/db';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {buildGoalSpec,buildConstraintSet,buildPlanningWorldSnapshot,DEFAULT_PLAN_BUDGETS,type CandidatePlan} from '@finnor/planning';
import type {CanonicalOperationalQueryRequest} from '@finnor/shared-types';
import type {PeMutationContext} from '../../types';
import {authorize,principal,tx} from '../../owner-context';
import {intakeSchema,planSchema,acceptedDefinition,developmentOnly,planReference,sha} from './contracts';
import {ownerSource} from './source';
import type {Original} from './store';
import type {Db} from '@finnor/db';

export async function intakeProofWork(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=intakeSchema.parse(raw);
 if(Date.parse(input.deadlineAt)<=Date.now()||Date.parse(input.deadlineAt)>Date.now()+3600000)throw Error('Z4_ORIGINAL_ONE_HOUR_DEADLINE_REQUIRED');
 await ownerSource(ctx,input);
 const acceptedDigest=sha(acceptedDefinition(input));
 const intake=await receiveWork({tenantId:ctx.auth.tenantId,userId:principal(ctx),instruction:input.purpose,channel:'console',
  idempotencyKey:'z4-intake:'+sha({principal:principal(ctx),key:input.idempotencyKey}),requireExactIntake:true,
  activeContext:{focusedEntity:input.root,executionProofAcceptedRequestDigest:acceptedDigest}});
 await attachWorkEntity(ctx.auth.tenantId,intake.workId,{...input.root,source:'Z4:original-authenticated-proof-request'});
 return {...intake,acceptedRequestDigest:acceptedDigest,originalDeadlineAt:input.deadlineAt,executionAuthorityGranted:false};
}
export async function selectProofPlan(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=planSchema.parse(raw),definitionDigest=sha(acceptedDefinition(input));
 const bound=await tx(ctx,async c=>{
  await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
  const native=(await c.query(`SELECT i.instruction_id,i.context_snapshot,i.instruction_text,w.created_by,w.status,
    (SELECT id FROM finnor_os.work_inputs n WHERE n.tenant_id=i.tenant_id AND n.work_id=i.work_id ORDER BY n.created_at DESC,n.id DESC LIMIT 1) latest_id
    FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
    WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3 FOR SHARE OF i,w`,[ctx.auth.tenantId,input.workId,input.workInputId])).rows[0];
  if(!native||native.latest_id!==input.workInputId||native.created_by!==principal(ctx)||native.instruction_text!==input.purpose||
   native.context_snapshot?.executionProofAcceptedRequestDigest!==definitionDigest||['completed','failed','cancelled'].includes(native.status))throw Error('Z4_ORIGINAL_TYPED_WORK_OBJECTIVE_REQUIRED');
  const prior=(await c.query(`SELECT id,revision,semantic_hash,status,work_input_id,goal_spec,constraint_set FROM finnor_os.work_plan_revisions
   WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision DESC LIMIT 1`,[ctx.auth.tenantId,input.workId])).rows[0];
  if(prior){
   if(prior.status!=='active'||prior.work_input_id!==input.workInputId||prior.constraint_set?.deadlineAt!==input.deadlineAt||
    !prior.goal_spec?.criteria?.some((x:{criterion?:{request?:{intent?:string};assertion?:{expected?:unknown;path?:string[]}}})=>
     x.criterion?.request?.intent==='execution_proof_capsule_v1'&&x.criterion.assertion?.path?.join('.')==='data.definitionDigest'&&x.criterion.assertion.expected===definitionDigest))
    throw Error('Z4_ORIGINAL_PLAN_CANNOT_BE_REPLACED');
   return {prior,instructionId:native.instruction_id,authorityRevision:0,snapshotDigest:sha(native)};
  }
  if((await c.query('SELECT 1 FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',[ctx.auth.tenantId,input.workId])).rowCount)throw Error('Z4_ORIGINAL_OBJECTIVE_CANNOT_BE_REPLACED');
  return {prior:null,instructionId:native.instruction_id,authorityRevision:Number((await employeeAuthoritySnapshotTx(ctx.auth,c)).revision),snapshotDigest:sha(native)};
 });
 if(bound.prior)return {workRevisionRef:planReference(bound.prior),replayed:true};
 // This explicit cast crosses only the coordinator-owned additive query union.
 // The real registry/compiler below must contain and validate the exact intent.
 const request={intent:'execution_proof_capsule_v1',workId:input.workId} as unknown as CanonicalOperationalQueryRequest&Record<string,unknown>;
 const successCondition={version:1 as const,statement:input.purpose,source:'explicit' as const,mode:'all' as const,
  criteria:Object.entries({status:'CHECKED',definitionDigest,nativeOwnerConsumed:true}).map(([field,expected])=>({
   kind:'canonical_query' as const,request,assertion:{path:['data',field],operator:'eq' as const,expected},
  }))};
 const goal=buildGoalSpec({objective:input.purpose,workId:input.workId,workInputId:input.workInputId,
  targets:[{kind:'entity',type:input.root.entityType,id:input.root.entityId,sourceRef:'S1:authenticated-root'}],
  deadline:input.deadlineAt,explicitNonGoals:['S3_float64_solver_proof','source_truth','S6_effect_dispatch','S8_security_admission','protected_qualification','production_activation'],successCondition});
 const {createDefaultPluginRegistry,planningCapabilitiesForVertical}=await import('../../../../orchestration/src/plugin-registry');
 const {LLMPlanner}=await import('../../../../orchestration/src/planner');
 const registry=createDefaultPluginRegistry(),allowed=['query:execution_proof_capsule_v1','check:objective_success'];
 const capabilities=planningCapabilitiesForVertical(registry,'private_equity').filter(c=>allowed.includes(c.capability));
 if(capabilities.length!==allowed.length)throw Error('Z4_REGISTERED_NATIVE_CAPABILITY_REQUIRED');
 const attempt=await beginWorkPlannerAttempt({tenantId:ctx.auth.tenantId,workId:input.workId,workInputId:input.workInputId,attemptKey:'z4-plan:'+definitionDigest});
 try{
  const constraints=buildConstraintSet({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',allowedCapabilities:allowed,
   humanOnlyCapabilities:[],prohibitedCapabilities:[],authorityRevision:bound.authorityRevision,
   budgets:{...DEFAULT_PLAN_BUDGETS,maxActions:0},deadlineAt:input.deadlineAt,softPreferences:[]});
  const snapshot=buildPlanningWorldSnapshot({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',workId:input.workId,
   workInputId:input.workInputId,plannerAttemptId:attempt.id,capturedAt:new Date().toISOString(),decisionContextHash:definitionDigest,
   canonicalStateHash:bound.snapshotDigest,canonicalEntities:[{kind:'entity',type:input.root.entityType,id:input.root.entityId,versionHash:null,sourceRef:'S1:authenticated-root'}],
   authority:{revision:bound.authorityRevision,roles:[ctx.auth.role],employeeId:principal(ctx)},capabilities,
   currentEffects:[],sourceHealth:{status:'complete',missing:[]}});
  const candidate:CandidatePlan={version:1,candidateKey:'z4-native-proof-observation',nodes:[
   {key:'observe_execution_proof',kind:'query',request,supports:goal.criteria.map(c=>c.id)},
   ...goal.criteria.map((c,i)=>({key:'check_'+i,kind:'check' as const,criterionId:c.id,dependsOn:['observe_execution_proof'],observation:c.criterion})),
  ]};
  const result=await new LLMPlanner(registry).compileCandidatePlans({candidates:[candidate],tenantContext:ctx.auth,verticalKey:'private_equity',goal,constraints,snapshot,useDatabase:true});
  if(!result.compilation.selected?.graph)throw Error('Z4_CANONICAL_PLAN_REJECTED');
  const objective=await (await import('../../../../orchestration/src/objective-loop')).startWorkObjective(input.purpose,ctx.auth,
   {workId:input.workId,workInputId:input.workInputId,instructionId:bound.instructionId,channel:'console',successCondition,
    maxSteps:12,maxActions:0,maxQueries:12,deadlineAt:new Date(input.deadlineAt),deferInitialIteration:true,initialNativeWait:true});
  const selected=result.compilation.selected,plan=await persistSelectedWorkPlan({tenantId:ctx.auth.tenantId,workId:input.workId,workInputId:input.workInputId,
   plannerAttemptId:attempt.id,objectiveLoopId:objective.objectiveLoopId,parentRevisionId:null,reason:'initial',goalSpec:goal,constraintSet:constraints,
   planningSnapshot:snapshot,candidatePlans:[candidate],compilationResult:result.compilation,planGraph:selected.graph!,score:selected.score,semanticHash:selected.graph!.semanticHash});
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'succeeded',plannerResult:{planRevisionId:plan.id,executionAuthorityGranted:false}});
  return {workRevisionRef:planReference({id:plan.id,revision:plan.revision,semantic_hash:plan.semanticHash}),objectiveLoopId:objective.objectiveLoopId,replayed:false};
 }catch(error){
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'failed',failure:{code:'Z4_CANONICAL_PLAN_NOT_SELECTED'}});throw error;
 }
}
/** Wake the original registered objective only after actual native readback. */
export async function wakeProofObjective(ctx:PeMutationContext,o:Original,capsuleDigest:string,resultDigest:string,useId:string){
 const native=await import('../../../../orchestration/src/objective-loop') as unknown as {
  schedulePreparedExecutionProofObjectiveTx?:(db:Db,params:{tenantId:string;workId:string;planRevisionId:string;sessionId:string;
   definitionDigest:string;capsuleDigest:string;resultDigest:string;useId:string})=>Promise<void>;
 };
 if(!native.schedulePreparedExecutionProofObjectiveTx)throw Error('Z4_NATIVE_OBJECTIVE_WAKE_NOT_INSTALLED');
 await tx(ctx,async(_c,db)=>native.schedulePreparedExecutionProofObjectiveTx!(db,{tenantId:ctx.auth.tenantId,workId:o.request.workId,
  planRevisionId:o.request.workRevisionRef.id,sessionId:o.sessionId,definitionDigest:sha(acceptedDefinition(o.request)),capsuleDigest,resultDigest,useId}));
}
