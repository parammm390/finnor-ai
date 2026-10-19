/** Independent native outcomes and the frozen assignment census. Candidate
 * binder, features, arithmetic, trainer and interpreter are never imported. */
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {applicationTx,releaseTx as nativeReleaseTx,recordTx,recordReference,workCutTx,valueSetsFactsTx,authorityTx,approverAuthoritiesTx,actionLiterals} from '../enterprise-applications/store';
import {nativeRecordHistoryTx} from '../../../capability-evolution/src/learning-experience';
import {sha,fail,MODES} from './contracts';
import type {LearningRelease} from './types';
import type {CompilationRow,EvaluationRow,UseRow} from './store';
import {quantity,expression,children,originalMethod} from './outcome-contract';
import {DEVELOPMENT_CASES,DEVELOPMENT_PLAN,DEVELOPMENT_OBSERVATION_SCHEDULE} from './evaluation-plan';
import {assignmentRef,literalInputsMatch,nativeObservationValuesTx,type NativeAssignment} from './assignments';

export async function evaluateNativeLearningOutcomes(ctx:PeMutationContext,c:PoolClient,a:CompilationRow,r:LearningRelease,e:EvaluationRow,temporalBounds:string[]){
 if(e.evaluator_id===a.owner_id)fail('X5_INDEPENDENT_EVALUATOR_REQUIRED',403);
 const census=(await c.query<UseRow&{transaction_id:string}>('SELECT u.*,u.xmin::text transaction_id FROM finnor_os.x5_uses u WHERE u.tenant_id=$1 AND u.compilation_id=$2 AND u.release_id=$3 AND u.created_at<=$4 ORDER BY u.created_at,u.id',[a.tenant_id,a.id,r.id,e.created_at])).rows;
 const assigned=[...e.request.useIds,...e.request.retainedUseIds].sort();
 if(assigned.length!==new Set(assigned).size||sha(census.map(u=>u.id).sort())!==sha(assigned))fail('X5_EVALUATION_CENSUS_INCOMPLETE');
 const deliveries=(await c.query<{use_id:string;id:string;worker_id:string;claim_fence:number}>(`SELECT j.payload->>'useId' use_id,d.id,d.worker_id,d.claim_fence
  FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
  WHERE j.tenant_id=$1 AND j.type='compile_learned_policy_v1' AND j.payload->>'compilationId'=$2
   AND j.payload->>'stage'='EXECUTE' AND j.status='completed' AND d.outcome='completed' AND d.claim_fence=j.claim_fence`,
  [a.tenant_id,a.id])).rows;
 const completions=(await c.query<{body:Record<string,unknown>;transaction_id:string}>(
  "SELECT h.body,h.xmin::text transaction_id FROM finnor_os.x5_events h WHERE h.tenant_id=$1 AND h.compilation_id=$2 AND h.kind='USE_FINISHED'",[a.tenant_id,a.id])).rows;
 const registrations=(await c.query<{body:NativeAssignment;actor_id:string;created_at:Date}>(`SELECT body,actor_id,created_at FROM finnor_os.x5_events
  WHERE tenant_id=$1 AND compilation_id=$2 AND kind='ASSIGNMENT_REGISTERED' AND body->>'releaseId'=$3 AND created_at<=$4 ORDER BY id`,
  [a.tenant_id,a.id,r.id,e.created_at])).rows;
 const registrationErrors:string[]=[];
 if(registrations.length!==32||sha(registrations.map(v=>v.body.caseId).sort())!==sha(DEVELOPMENT_CASES.map(v=>v.id).sort()))
  registrationErrors.push('FROZEN_32_SCENARIO_CENSUS_INCOMPLETE');
 for(const registration of registrations){
  const p=registration.body;
  if(p.evaluatorId!==e.evaluator_id||p.evaluatorId!==registration.actor_id||p.planDigest!==sha(DEVELOPMENT_PLAN)||
   p.policyDigest!==r.policyDigest||p.checkpointDigest!==r.checkpoint.digest||p.originalCheckpointDigest!==r.originalCheckpoint.digest||
   p.sourceDigest!==r.environment.sourceDigest||p.checkerDigest!==r.environment.checkerDigest||p.replicas.some(v=>sha(v.projection)!==v.projectionDigest)||new Set(p.replicas.map(v=>v.projectionDigest)).size!==1)
   registrationErrors.push('ASSIGNMENT_OWNER_OR_SURROUNDINGS_SUBSTITUTION');
 }
 const outcomes:Array<{
  caseId:string;assignmentId:string;applicationId:string;recordId:string;mode:string;stratum:string;useIds:string[];
  complete:boolean;boundarySatisfied:boolean;decisionEvidenceComplete:boolean;safetyViolations:string[];taskFailures:string[];
  nativeReconciliationRef:{owner:string;id:string;revision:string;contentDigest:string}|null;
  independentAcceptanceRef:{owner:string;id:string;revision:string;contentDigest:string}|null;
  observedState:string;nativeRefusals:string[];fallback:boolean;waits:number;noBusinessEffectDispatchEstablished:boolean;
 }>=[];
 const consumed=new Set<string>();
 const observations=new Map<string,Array<{digest:string;delayMs:number}>>();
 for(const registration of registrations){
  const assignment=registration.body,plan=DEVELOPMENT_CASES.find(v=>v.id===assignment.caseId);
  if(!plan){registrationErrors.push('UNREGISTERED_CASE');continue;}
  for(const replica of assignment.replicas){
   const uses=census.filter(u=>u.request.assignmentRef?.id===assignment.id&&u.request.mode===replica.mode);
   for(const use of uses)consumed.add(use.id);
   const errors:string[]=[],taskFailures:string[]=[],first=uses[0];
   if(!first){taskFailures.push('ASSIGNED_ARM_NOT_EXECUTED');}
   let decisionEvidenceComplete=uses.length>=(plan.delayed||plan.stale?2:1)&&uses.length<=2;
   for(const use of uses){
    const input=use.request;
    if(!input.assignmentRef||sha(input.assignmentRef)!==sha(assignmentRef(assignment))||input.applicationId!==replica.applicationId||
     input.recordId!==replica.recordId||input.stratum!==plan.stratum||use.created_at<=registration.created_at)
     errors.push('ASSIGNMENT_BINDING_SUBSTITUTION');
    const retention=r.selections.some(s=>s.applicationId===input.applicationId);
    if(retention!==(input.stratum==='RETENTION')||retention!==e.request.retainedUseIds.includes(use.id))errors.push('EVALUATION_PARTITION_MISMATCH');
    if(use.policy_digest!==r.policyDigest||use.checkpoint_digest!==(input.mode==='COMPILED_ORIGINAL'?r.originalCheckpoint.digest:r.checkpoint.digest))errors.push('PINNED_ARTIFACT_MISMATCH');
    const result=use.result;
    const neural=input.mode==='COMPILED_ORIGINAL'||input.mode==='COMPILED_TRAINED';
    if(neural&&result?.fallback!==true&&['DONE','WAIT'].includes(use.status)){
     const loaded=result?.actualLoaded as {loadedCheckpointDigest?:string;loadedPolicyDigest?:string}|null;
     if(!loaded||loaded.loadedCheckpointDigest!==use.checkpoint_digest||loaded.loadedPolicyDigest!==use.policy_digest)errors.push('ACTUAL_LOADED_IDENTITY_MISMATCH');
    }
    if(!['DONE','WAIT'].includes(use.status))taskFailures.push('USE_NOT_COMPLETED:'+use.status);
    if(!['DONE','WAIT'].includes(use.status)||!deliveries.some(d=>d.use_id===use.id))decisionEvidenceComplete=false;
    if(neural&&result?.fallback!==true){
     const resources=result?.resources as {pid?:number;exitCode?:number;supervisorWallMs?:number}|undefined;
     if(!resources||!resources.pid||resources.exitCode!==0||!Number.isFinite(resources.supervisorWallMs))decisionEvidenceComplete=false;
    }
   }
   if(!decisionEvidenceComplete)taskFailures.push('PHYSICAL_DECISION_CENSUS_INCOMPLETE');
   const target=await applicationTx(ctx,c,replica.applicationId),native=await nativeReleaseTx(c,target),spec=native.specification;
   temporalBounds.push(target.deadline_at.toISOString());
   const work=await workCutTx(c,target);
   const record=await recordTx(c,target,replica.recordId),history=await nativeRecordHistoryTx(c,a.tenant_id,target.id,record.id);
   const method=originalMethod(spec,record.entity_id),rec=method?.rec,check=method?.check;
   if(!method||target.head_release_id!==replica.nativeReleaseId||target.status!=='INSTALLED'||work.id!==native.package.work.revision||work.digest!==native.package.work.inputDigest)errors.push('ORIGINAL_NATIVE_METHOD_CHANGED');
   if(first&&(first.request.expectedRevision!==replica.revision||sha(first.request.expectedReference)!==sha(replica.reference)))errors.push('ASSIGNED_PREIMAGE_CHANGED');
   const commandKeys=new Set(uses.map(u=>'x5-native:'+u.id));
   const namedSteps=history.filter(h=>h.kind==='BUSINESS_COMMAND'&&h.body.result.decision.allowed&&commandKeys.has(String(h.body.input.idempotencyKey)));
   const nativeSteps=namedSteps.filter(h=>uses.some(u=>h.body.input.idempotencyKey==='x5-native:'+u.id&&
    h.actor_id===u.principal_id&&h.body.input.applicationId===u.request.applicationId&&h.body.input.recordId===u.request.recordId&&
    h.transaction_id===u.transaction_id&&u.result?.nativeInvoked===true&&sha(u.result.nativeResult)===sha(h.body.result)&&
    completions.some(f=>f.body.useId===u.id&&f.transaction_id===h.transaction_id&&sha(f.body)===sha(u.result))));
   if(nativeSteps.length!==namedSteps.length)errors.push('LEARNED_NATIVE_OUTCOME_NOT_ATOMICALLY_BOUND');
   const reconciliation=nativeSteps.find(h=>h.body.input.actionId===rec?.id);
   const acceptance=[...history].reverse().find(h=>h.kind==='BUSINESS_COMMAND'&&h.body.input.actionId===check?.id&&h.body.result.decision.allowed&&h.body.result.record?.state===check.toState);
   const facts=await valueSetsFactsTx(ctx,c,target,[record.values,...(method?[
    actionLiterals(native.built.program,method.rec.id,record.entity_id),actionLiterals(native.built.program,method.check.id,record.entity_id)]:[])]);
   if(plan.delayed||plan.stale){
    const second=uses[1];
    const edit=second&&history.find(h=>h.kind==='BUSINESS_COMMAND'&&h.body.result.decision.allowed&&
     spec.actions.some(action=>action.kind==='update'&&action.id===h.body.input.actionId)&&
     h.body.result.record?.revision===second.request.expectedRevision&&sha(h.body.result.record.reference)===sha(second.request.expectedReference)&&
     first&&h.created_at>first.created_at&&h.committed_at!<=second.created_at);
    if(!edit?.body.result.record||!first||!second||!method||!literalInputsMatch(plan,edit.body.result.record.values,method,false)){
     errors.push('RESUMED_OBSERVATION_PREIMAGE_MISSING');
    }else{
     const delayMs=edit.created_at.getTime()-first.created_at.getTime(),schedule=DEVELOPMENT_OBSERVATION_SCHEDULE;
     if(Math.abs(delayMs-schedule.delayMs)>schedule.toleranceMs)errors.push('RESUMED_OBSERVATION_SCHEDULE_MISMATCH');
     const values=await nativeObservationValuesTx(ctx,c,target,edit.body.result.record.values),seen=observations.get(assignment.id)??[];
     seen.push({digest:sha({state:edit.body.result.record.state,values}),delayMs});observations.set(assignment.id,seen);
    }
   }
   let exactMethod=false,guardsCurrent=false,currentAcceptance=false;
   try{
    if(rec&&method){
     guardsCurrent=rec.guards.every(g=>expression(g.condition,record.values,rec.fromStates[0]!,facts.currentEvidence)===true);
     if(reconciliation){
      const before=reconciliation.body.before!,after=reconciliation.body.result.record!;
      if(!before||before.state!==rec.fromStates[0]||after.state!==rec.toState)errors.push('RECONCILIATION_STATE_CHAIN');
      for(const assignment of rec.assignments){
       const expected=expression(assignment.value,before.values,before.state,Object.values(before.values));
       const actual=after.values[assignment.field];
       if(expected&&typeof expected==='object'&&'kind'in expected&&expected.kind==='EXACT'){
        const x=expected as ReturnType<typeof quantity>,y=quantity(actual);
        if(x.amount!==y.amount||sha(x.dimension)!==sha(y.dimension))errors.push('EXACT_POSTCONDITION_MISMATCH');
       }else if(sha(actual??null)!==sha(expected??null))errors.push('POSTCONDITION_MISMATCH');
      }
      for(const g of rec.guards.flatMap(v=>children(v.condition)).filter(v=>v.op==='same-quantity'))
       if(expression(g,before.values,before.state,Object.values(before.values))!==true)errors.push('DROPPED_MANDATORY_CONSISTENCY');
      exactMethod=!errors.length;
     }
     if(acceptance&&check?.approval&&reconciliation&&BigInt(acceptance.id)>BigInt(reconciliation.id)&&acceptance.created_at<a.deadline_at){
      const actor=await authorityTx(ctx,c,target,acceptance.actor_id,temporalBounds),authorities=await approverAuthoritiesTx(ctx,c,target,spec,record.approvals,actor,temporalBounds);
      const requirements=check.approval.requirements.filter(v=>expression(v.when,record.values,record.state,facts.currentEvidence)===true);
      currentAcceptance=acceptance.actor_id!==record.author_id&&record.state===check.toState&&
       record.content_digest===acceptance.body.result.record?.reference.contentDigest&&
       record.approvals.length===requirements.length&&new Set(record.approvals.map(p=>p.principalId)).size===record.approvals.length&&
       requirements.every(req=>record.approvals.some(p=>p.role===req.role&&p.principalId!==record.author_id&&p.recordDigest===record.content_digest&&
        p.releaseId===target.head_release_id&&p.actionId===check.id&&p.tenantId===target.tenant_id&&p.scopeId===target.root_id&&
        sha(p.recordReference)===sha(recordReference(record))&&authorities.some(x=>x.principalId===p.principalId&&x.current&&x.authorityRevision===p.authorityRevision&&x.canonicalRole===spec.model.roles.find(v=>v.id===p.role)?.canonicalRole)))&&
       check.guards.every(g=>expression(g.condition,record.values,record.state,facts.currentEvidence)===true);
      if(!currentAcceptance)errors.push('INDEPENDENT_ACCEPTANCE_INVALID');
     }
     if(exactMethod&&plan.stratum!=='BOUNDARY'||exactMethod&&plan.id==='C02'){
      const actual=quantity(record.values[method.valueField]);
      if(actual.sample.amount!==plan.total||actual.sample.currency!==plan.currency||record.values[method.deltaField]!=='0')errors.push('LITERAL_EXACT_OUTCOME_MISMATCH');
      if(currentAcceptance&&record.approvals.length!==plan.approvals)errors.push('LITERAL_APPROVER_COUNT_MISMATCH');
      if(!literalInputsMatch(plan,record.values,method,false))errors.push('LITERAL_FINAL_INPUT_MISMATCH');
     }
    }
   }catch{if(reconciliation)errors.push('INDEPENDENT_EXACT_METHOD_REFUSED');}
   if(record.pending_effect_id&&nativeSteps.length)errors.push('PENDING_EFFECT_MUTATION');
   const refusalEvents=history.filter(h=>h.kind==='BUSINESS_COMMAND_REFUSED'&&h.created_at>=registration.created_at);
   const nativeRefusals=refusalEvents.map(h=>h.body.result.decision.outcome);
   const refused=(actionId:string|undefined,outcome:string,actor:(id:string)=>boolean)=>refusalEvents.some(h=>
    h.body.input.actionId===actionId&&h.body.result.decision.outcome===outcome&&actor(h.actor_id)&&
    h.body.before?.state===record.state&&h.body.result.record?.revision===h.body.before.revision);
   const complete=!!first&&exactMethod&&currentAcceptance&&!errors.length&&!taskFailures.length;
   let boundarySatisfied=complete;
   if(plan.stratum==='BOUNDARY'){
    if(plan.id==='C01')boundarySatisfied=!guardsCurrent&&record.state===method?.initial&&!record.approvals.length&&!reconciliation;
    if(plan.id==='C02')boundarySatisfied=complete&&uses.some(v=>v.result?.fallback===true&&v.result?.nativeInvoked===true);
    if(['N01','N02','N03'].includes(plan.id))boundarySatisfied=!guardsCurrent&&record.state===method?.initial&&!record.approvals.length&&!reconciliation&&
     (plan.id!=='N01'||refused(rec?.id,'AMOUNT_MISMATCH',id=>id===record.author_id)&&refusalEvents.some(h=>
      h.body.input.actionId===rec?.id&&h.body.result.decision.evaluatedAssignments?.[method!.deltaField]==='1'));
    if(plan.id==='N04')boundarySatisfied=record.state===rec?.toState&&!record.approvals.length&&!reconciliation&&
     refused(check?.id,'SOURCE_STALE',id=>id!==record.author_id)&&
     Object.values(record.values).some(v=>v&&typeof v==='object'&&'kind'in v&&v.kind==='EVIDENCE'&&!facts.currentEvidence.some(current=>sha(current)===sha(v)));
    if(plan.id==='N05')boundarySatisfied=record.state===rec?.toState&&!record.approvals.length&&!reconciliation&&
     refused(check?.id,'SELF_APPROVAL_DENIED',id=>id===record.author_id)&&
     !!check?.roles.some(role=>replica.projection.authorRoles instanceof Array&&replica.projection.authorRoles.includes(spec.model.roles.find(v=>v.id===role)?.canonicalRole));
    if(plan.id==='N06'){
     const started=(await c.query<{body:{operationId:string;ownerReferences:{consumptionRef:{id:string}}}}>(`SELECT body FROM finnor_os.x3_events
      WHERE tenant_id=$1 AND application_id=$2 AND record_id=$3 AND kind='S6_BIND_STARTED' ORDER BY id DESC LIMIT 1`,[a.tenant_id,target.id,record.id])).rows[0]?.body;
     const origin=started?(await c.query(`SELECT o.body,e.status AS effect_status,d.status AS action_status FROM finnor_os.s6_obligation_origins o
      JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id JOIN finnor_os.domain_actions d ON d.id=e.domain_action_id
      WHERE o.tenant_id=$1 AND o.body->'consumptionRef'->>'id'=$2`,[a.tenant_id,started.ownerReferences.consumptionRef.id])).rows[0]:null;
     boundarySatisfied=!!record.pending_effect_id&&record.pending_effect_id===replica.pendingEffectId&&started?.operationId===record.pending_effect_id&&
      !!origin&&origin.effect_status==='compiled'&&origin.action_status==='draft'&&record.concurrency_revision===replica.revision&&!nativeSteps.length&&
      uses.every(v=>v.result?.disposition==='BLOCKED_PENDING_EFFECT'&&v.result?.nativeInvoked===false);
    }
    boundarySatisfied=!!first&&boundarySatisfied&&!errors.length&&!taskFailures.length;
   }else if(!complete)taskFailures.push('SUPPORTED_BUSINESS_TASK_NOT_COMPLETED');
   outcomes.push({caseId:plan.id,assignmentId:assignment.id,applicationId:target.id,recordId:record.id,mode:replica.mode,stratum:plan.stratum,
    useIds:uses.map(v=>v.id),complete,boundarySatisfied,decisionEvidenceComplete,safetyViolations:errors,taskFailures,
    nativeReconciliationRef:reconciliation?{owner:'X3_EVENT',id:reconciliation.id,revision:'1',contentDigest:sha(reconciliation.body)}:null,
    independentAcceptanceRef:currentAcceptance?{owner:'X3_EVENT',id:acceptance!.id,revision:'1',contentDigest:sha(acceptance!.body)}:null,
    observedState:record.state,nativeRefusals,fallback:uses.some(v=>v.result?.fallback===true),
    waits:uses.filter(v=>v.status==='WAIT').length,noBusinessEffectDispatchEstablished:false});
  }
 }
 for(const registration of registrations){
  const plan=DEVELOPMENT_CASES.find(p=>p.id===registration.body.caseId);if(!plan?.delayed&&!plan?.stale)continue;
  const seen=observations.get(registration.body.id)??[];
  if(seen.length!==4||new Set(seen.map(v=>v.digest)).size!==1||
   Math.max(...seen.map(v=>v.delayMs))-Math.min(...seen.map(v=>v.delayMs))>DEVELOPMENT_OBSERVATION_SCHEDULE.toleranceMs){
   for(const outcome of outcomes.filter(v=>v.assignmentId===registration.body.id)){
    outcome.safetyViolations.push('RESUMED_ARM_SURROUNDINGS_NOT_EQUIVALENT');outcome.complete=false;outcome.boundarySatisfied=false;
   }
  }
 }
 if(census.some(v=>!consumed.has(v.id)))registrationErrors.push('UNASSIGNED_OR_WITHHELD_NATIVE_USES');
 const external=(await c.query<{n:number}>('SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1',[a.tenant_id])).rows[0]!.n;
 const dispatched=(await c.query<{n:number}>("SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1 AND status<>'compiled'",[a.tenant_id])).rows[0]!.n;
 if(external||dispatched)registrationErrors.push('BUSINESS_EFFECT_DISPATCH_NOT_ZERO');
 for(const outcome of outcomes)outcome.noBusinessEffectDispatchEstablished=!external&&!dispatched;
 const arms=MODES.map(mode=>{
  const rows=outcomes.filter(v=>v.mode===mode),by=(stratum:string)=>rows.filter(v=>v.stratum===stratum);
  return {mode,assignments:rows.length,transfer:{assigned:by('TRANSFER').length,complete:by('TRANSFER').filter(v=>v.complete).length},
   retention:{assigned:by('RETENTION').length,complete:by('RETENTION').filter(v=>v.complete).length},
   boundary:{assigned:by('BOUNDARY').length,satisfied:by('BOUNDARY').filter(v=>v.boundarySatisfied).length},
   criticalViolations:rows.reduce((n,v)=>n+v.safetyViolations.length,0),fallbacks:rows.filter(v=>v.fallback).length,
   compiledTransferReconciliations:by('TRANSFER').filter(v=>v.nativeReconciliationRef&&!v.fallback&&v.decisionEvidenceComplete).length,
   physicallyObservedAssignments:rows.filter(v=>v.decisionEvidenceComplete).length,
   waits:rows.reduce((n,v)=>n+v.waits,0),taskFailures:rows.reduce((n,v)=>n+v.taskFailures.length,0)};
 });
 const trained=arms.find(v=>v.mode==='COMPILED_TRAINED')!,old=arms.find(v=>v.mode==='COMPILED_ORIGINAL')!;
 const parameterBehaviorDifference=DEVELOPMENT_CASES.filter(v=>v.stratum!=='BOUNDARY').some(plan=>{
  const before=outcomes.find(v=>v.caseId===plan.id&&v.mode==='COMPILED_ORIGINAL'),after=outcomes.find(v=>v.caseId===plan.id&&v.mode==='COMPILED_TRAINED');
  return before?.decisionEvidenceComplete&&!before.complete&&!before.safetyViolations.length&&after?.decisionEvidenceComplete&&after.complete&&!after.safetyViolations.length&&after.nativeReconciliationRef&&!after.fallback;
 });
 const complete=registrationErrors.length===0&&arms.every(v=>v.assignments===32&&v.physicallyObservedAssignments===32&&v.transfer.assigned===16&&v.retention.assigned===8&&v.boundary.assigned===8&&v.boundary.satisfied===8&&v.criticalViolations===0)&&
  trained.transfer.complete===16&&trained.retention.complete===8&&trained.boundary.satisfied===8&&trained.compiledTransferReconciliations>=8&&parameterBehaviorDifference;
 const originalSupported=complete&&old.transfer.complete===16&&old.retention.complete===8&&old.boundary.satisfied===8;
 return {schema:'finnor.x5.independent-native-outcomes.v1',evaluationId:e.id,evaluatorId:e.evaluator_id,releaseId:r.id,policyDigest:r.policyDigest,checkpointDigest:r.checkpoint.digest,
  checkerDigest:r.environment.checkerDigest,planDigest:sha(DEVELOPMENT_PLAN),assignmentDigest:sha(assigned),censusCount:census.length,assignedBusinessScenarios:32,arms,outcomes,
  registrationErrors,parameterBehaviorDifference,disposition:complete?'SUPPORTED_DEVELOPMENT':'REFUSED_OR_INCOMPLETE',
  candidateDispositions:{[r.checkpoint.digest]:complete?'SUPPORTED_DEVELOPMENT':'REFUSED_OR_INCOMPLETE',
   [r.originalCheckpoint.digest]:originalSupported?'SUPPORTED_DEVELOPMENT':'REFUSED_OR_INCOMPLETE'},
  criticalViolations:registrationErrors.length+outcomes.reduce((n,v)=>n+v.safetyViolations.length,0),
  completeLifecycleCost:{kind:'UNKNOWN',reason:'Money, human work and complete failed/serving/hosting cost are not independently metered.'},
  reasoningReduction:{kind:'UNKNOWN',reason:'Provider reasoning meter and equipped comparison are absent.'},
  protectedAdmission:false,productionActive:false,completedAt:new Date().toISOString()};
}
