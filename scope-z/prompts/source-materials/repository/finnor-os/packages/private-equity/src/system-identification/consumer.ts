/** S4/P1 plans and actual canonical decision consumption. A checked model is an
 * input to a conditional decision, never an authority or completion receipt. */
import {beginWorkPlannerAttempt,finishWorkPlannerAttempt,persistSelectedWorkPlan,activeWorkPlanRevision} from '@finnor/db';
import {employeeAuthoritySnapshotTx,canExerciseAuthorityTx} from '@finnor/authority';
import {buildGoalSpec,buildConstraintSet,buildPlanningWorldSnapshot,DEFAULT_PLAN_BUDGETS} from '../../../planning/src/builders';
import {compileAndSelectPlans,DETERMINISTIC_PLAN_COMPILER_VERSION} from '../../../planning/src/compiler';
import type {CandidatePlan,PlanningSnapshotCapability} from '../../../planning/src/contracts';
import type {DigitalExperimentProtocol,DigitalCondition,IdentifiedSystemRelease,DigitalObservation} from '@finnor/shared-types';
import {digitalConditions,forecastDigitalCondition,unanimousDigitalForecast,digitalForecastMatches} from '../../../epistemic-runtime/src/identification';
import {recordDecisionTx,finalizeDecisionTx} from '../world-repository';
import {attachEvidenceTx} from '../repository';
import type {PeMutationContext} from '../types';
import type {PoolClient} from 'pg';
import {sha,fail,type IdentificationRow,type ExperimentRow} from './contracts';
import {tx,principal,assertRunCurrentTx,assertModelCurrentTx,rootOf,eventTx,newId,vref,evidenceTx} from './store';
export async function bindIdentificationPlan(ctx:PeMutationContext,a:IdentificationRow,p:DigitalExperimentProtocol,current:()=>Promise<boolean>,owned:(c:PoolClient)=>Promise<IdentificationRow|null>){
 const prepared=await tx(ctx,async c=>{
  if(!await owned(c))fail('X4_PLAN_PHYSICAL_FENCE');
  const existing=(await c.query<{id:string;nodeId:string;digest:string;payload:unknown}>('SELECT r.id,d.plan_node_id AS "nodeId",r.semantic_hash AS digest,d.payload FROM finnor_os.domain_actions d JOIN finnor_os.work_plan_revisions r ON r.tenant_id=d.tenant_id AND r.id=d.plan_revision_id WHERE d.tenant_id=$1 AND d.id=$2',[a.tenant_id,p.effect.domainActionId])).rows[0];
  if(existing){
   if(sha(existing.payload)!==sha({protocol:p,protocolDigest:sha(p)}))fail('X4_ORIGINAL_SELECTED_ACTION_CHANGED');
   return {existing,authority:null};
  }
  const authority=await employeeAuthoritySnapshotTx(ctx.auth,c),allowed=await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:digital_identification_experiment',resource:{type:'pe_deal',id:a.root_id},risk:'low'},c);
  if(!allowed)fail('X4_EXPERIMENT_ACTION_AUTHORITY_REQUIRED',403);
  return {existing:null,authority};
 });
 if(prepared.existing)return {...prepared.existing,alreadyBound:true};
 const facts=prepared.authority!;
 const previous=await activeWorkPlanRevision(a.tenant_id,a.work_id);
 const previousSelection=previous?.candidateSummary as {selected?:{candidateKey?:string}}|undefined;
 if(previous&&(!previousSelection?.selected?.candidateKey?.startsWith('x4:')||previous.workInputId!==a.work_input_id))fail('X4_EXISTING_CANONICAL_PLAN_INCOMPATIBLE');
 const attempt=await beginWorkPlannerAttempt({tenantId:a.tenant_id,workId:a.work_id,workInputId:a.work_input_id,attemptKey:'x4:'+p.trial.id,
  decisionContext:{question:a.request.question,domainDigest:sha(a.request.domain),protocolDigest:sha(p),selection:p.selection}});
 const goal=buildGoalSpec({objective:a.request.question.affectedDecision,workId:a.work_id,workInputId:a.work_input_id,
  successCondition:{source:'explicit',criteria:[{kind:'x4_exact_experiment',trialId:p.trial.id,requires:'DELIVERY_AND_COMPLETE_RAW_OBSERVATION'}]},
  explicitNonGoals:['No unique hidden mechanism, protected admission, production transport or financial completion is inferred']});
 // This non-model-proposable action is owned by the fixed X4 queue handler,
 // not added to the general plugin proposal/dispatch surface.
 const capabilities=['digital_identification_experiment','check:objective_success'];
 const constraints=buildConstraintSet({tenantId:a.tenant_id,verticalKey:'private_equity',allowedCapabilities:capabilities,humanOnlyCapabilities:[],prohibitedCapabilities:[],
  authorityRevision:facts.revision,budgets:DEFAULT_PLAN_BUDGETS,softPreferences:[]});
 const payload={protocol:p,protocolDigest:sha(p)};
 const snapshot=buildPlanningWorldSnapshot({workId:a.work_id,workInputId:a.work_input_id,plannerAttemptId:attempt.id,tenantId:a.tenant_id,verticalKey:'private_equity',
  capturedAt:new Date().toISOString(),decisionContextHash:sha({question:a.request.question,protocolDigest:sha(p)}),canonicalStateHash:sha({workInputDigest:a.work_input_digest,protocol:p}),
  authority:{employeeId:principal(ctx),revision:facts.revision,roles:facts.roles},
  capabilities:capabilities.map<PlanningSnapshotCapability>(capability=>({capability,kind:capability==='digital_identification_experiment'?'action':'check',modelProposable:false,available:true,health:'available',
   risk:'low',irreversible:false,requiredReferences:[],effectClass:capability==='digital_identification_experiment'?'external_side_effect':null,
   observationStrategy:capability==='digital_identification_experiment'?'provider_observation':'objective_success',reversibility:capability==='digital_identification_experiment'?'unknown_provider_dependent':'read_only',
   supportedRecoveryModes:['recover'],externalSideEffect:capability==='digital_identification_experiment',authorityRequirement:capability==='digital_identification_experiment'?'policy':'query'})),
  currentEffects:[],sourceHealth:{status:'partial',missing:['Scientific acceptance requires independent fresh prediction and principal/instance replication'] }});
 const candidate:CandidatePlan={version:1,candidateKey:'x4:'+p.trial.id,nodes:[
  {key:'experiment',kind:'action',actionType:'digital_identification_experiment',payload,supports:goal.criteria.map(v=>v.id),recovery:{version:1,on:['failure','timeout','stale','divergence'],mode:'recover',maxAttempts:1,neverReplayVerifiedIrreversibleEffect:true}},
  {key:'observe',kind:'check',dependsOn:['experiment'],criterionId:goal.criteria[0]!.id,observation:{kind:'x4_exact_experiment',trialId:p.trial.id,requires:'DELIVERY_AND_COMPLETE_RAW_OBSERVATION'}},
 ]};
 const fact={registered:true,schemaValid:true,schemaErrors:[],grounded:true,crossTenant:false,stale:false,authority:'allowed' as const,health:'available' as const,
  risk:'low' as const,irreversible:false,preconditionsSatisfied:true,supportedRecoveryModes:['recover' as const],estimatedCostMicros:null,estimatedLatencyMs:null};
 const compilation=compileAndSelectPlans({goal,constraints,snapshot,candidates:[candidate],facts:[{candidateKey:candidate.candidateKey,nodes:{experiment:fact,observe:fact}}]});
 if(!compilation.selected?.graph)fail('X4_CANONICAL_PLANNER_REFUSED');
 try{
  if(!await current())fail('X4_PLAN_PHYSICAL_FENCE');
  const selected=compilation.selected,revision=await persistSelectedWorkPlan({tenantId:a.tenant_id,workId:a.work_id,workInputId:a.work_input_id,
   plannerAttemptId:attempt.id,parentRevisionId:previous?.id,reason:previous?'observation':'initial',goalSpec:goal,constraintSet:constraints,planningSnapshot:snapshot,
   candidatePlans:[candidate],compilationResult:compilation,planGraph:selected.graph!,score:selected.score,semanticHash:selected.graph!.semanticHash,compilerVersion:DETERMINISTIC_PLAN_COMPILER_VERSION});
  await finishWorkPlannerAttempt({tenantId:a.tenant_id,attemptId:attempt.id,status:'succeeded',plannerResult:{selectedPlanRevisionId:revision.id,protocolDigest:sha(p),effectAuthority:'CURRENT_OWNER_AND_CONSENT_STILL_REQUIRED'}});
  return {id:revision.id,nodeId:selected.graph!.nodes.find(n=>n.kind==='action')!.id,digest:revision.semanticHash,alreadyBound:false};
 }catch(error){await finishWorkPlannerAttempt({tenantId:a.tenant_id,attemptId:attempt.id,status:'failed',failure:{code:'X4_PLAN_REFUSED'}});throw error;}
}
/** Registered export-completeness decision: maximize the actually predicted
 * finite record count, minimize registered cost/exposure, preserve ties. */
export function chooseModelDecisionCondition(m:IdentifiedSystemRelease){
 const candidates=digitalConditions(m.domain).flatMap(c=>{
  const forecast=forecastDigitalCondition(m.family,m.analysis,m.domain,c);
  if(!unanimousDigitalForecast(forecast))return [];
  const mask=BigInt('0x'+forecast.inclusion[0]!.mask),count=m.domain.records.filter((_,i)=>(mask&(1n<<BigInt(i)))!==0n).length;
  return [{condition:c,forecast,count}];
 }).sort((a,b)=>b.count-a.count||a.condition.costUnits-b.condition.costUnits||a.condition.exposure-b.condition.exposure||a.condition.id.localeCompare(b.condition.id));
 return m.requestedClaimSatisfied&&candidates[0]?.count===m.domain.records.length?candidates[0]:null;
}
export async function commitIdentificationDecisionTx(ctx:PeMutationContext,c:PoolClient,a:IdentificationRow,m:IdentifiedSystemRelease,useId:string,
 experiment:ExperimentRow|null,waitReason?:string){
 let current=true;
 try{await assertModelCurrentTx(ctx,c,a,m);}catch{current=false;}
 const choice=current?chooseModelDecisionCondition(m):null;
 const supports=!waitReason&&current&&choice&&experiment?.result&&experiment.phase==='DECISION_USE'&&experiment.protocol.condition.id===choice.condition.id&&
  digitalForecastMatches(experiment.protocol.forecast,experiment.protocol.trial,experiment.result.records);
 const decision=await recordDecisionTx(c,ctx,{dealId:a.root_id,investmentCaseId:a.request.decision.investmentCaseId,
  decisionType:'x4_export_reconciliation',title:supports?'Use checked finite-domain export':'Wait for current complete checked export',
  decision:supports?'PROCEED_WITH_SCOPED_TEST_RECONCILIATION':'WAIT_NO_COMPLETION',
  rationale:JSON.stringify({modelRef:vref('S3_IDENTIFIED_SYSTEM',m.id,sha(m)),findingRef:m.canonicalFindingRef,current,
   actualExperimentId:experiment?.id??null,conditionId:choice?.condition.id??null,
   reason:supports?'CURRENT_CHECKED_MODEL_PREDICTION_MATCHED_ACTUAL_COMPLETE_FRESH_EXPORT':waitReason??'MODEL_CLAIM_DOMAIN_OR_COMPLETENESS_UNSUPPORTED',
   productionOrFinancialCompletion:false})});
 const decisionId=String(decision.row.id);
 await finalizeDecisionTx(c,ctx,{decisionId,expectedVersion:Number(decision.row.version),decidedBy:{partyType:'employee',partyId:principal(ctx)}});
 if(experiment?.evidence_source_id)await attachEvidenceTx(c,ctx,{dealId:a.root_id,entity:{entityType:'pe_decision',entityId:decisionId},
  evidenceSourceId:experiment.evidence_source_id,evidenceVersionId:experiment.evidence_version_id!,relationship:'verifies'});
 const result={decisionId,choice:supports?'PROCEED_WITH_SCOPED_TEST_RECONCILIATION':'WAIT_NO_COMPLETION',modelId:m.id,findingRef:m.canonicalFindingRef,
  modelActuallyResolved:true,currentModelValidated:current,modelActuallyUsed:!!supports,actualExperimentId:experiment?.id??null,
  reason:supports?'CURRENT_CHECKED_MODEL_PREDICTION_MATCHED_ACTUAL_COMPLETE_FRESH_EXPORT':waitReason??'MODEL_CLAIM_DOMAIN_OR_COMPLETENESS_UNSUPPORTED',
  physicalObservation:experiment?.result?'RETAINED_COMPLETE_OBSERVATION':'UNRESOLVED_NO_COMPLETION',originalEffectsRetained:true,
  qualification:'DEVELOPMENT_TEST_RECONCILIATION_NOT_BUSINESS_SUCCESS',completionGranted:false};
 await c.query("UPDATE finnor_os.x4_uses SET status=$3,decision_id=$4,experiment_id=$5,result=$6::jsonb WHERE tenant_id=$1 AND id=$2 AND status IN('QUEUED','RUNNING')",
  [a.tenant_id,useId,supports?'COMPLETE':'WAIT',decisionId,experiment?.id??null,JSON.stringify(result)]);
 await eventTx(c,a,principal(ctx),'CANONICAL_DECISION_CONSUMED','decision:'+useId,result);
 return result;
}
