import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import { validateInstitutionDemand,chargeInstitutionDemand } from "../allocation-store";
import { authorize, principal, sha, stable, tx } from "../evidence-execution/store";
import type { InstitutionHarnessProgram } from "./contracts";
import { frozenDutyExpectation, readCanonicalDuty, matchesFrozenInstitutionIntent } from "./duty-observer";
import { assertProgramCurrent, enqueueProgram, nativeRequestRow, persistProgrammeHead, trace, type InstitutionProgramRow } from "./store";
import { persistInstitutionCompute } from "../institution-program/meter";

// PE creation reserves the canonical request ID from DomainAction.id. The
// mandate's frozen expectedEntityId is therefore also the durable action ID.
const actionId = (node: InstitutionHarnessProgram["nodes"][number]) => {
 if(!node.action)throw Error("X1_EXACT_REQUEST_ACTION_REQUIRED");
 return node.action.expectedEntityId;
};

/** The actual command/worker, not this P1 job, mutates PE. After dispatch,
 * subsequent deliveries only reconcile the same action and canonical row. */
export async function continueInstitutionProgram(ctx: PeMutationContext, q: InstitutionProgramRow, execution: Readonly<JobExecutionContext>) {
 const started=performance.now(),startedAt=new Date().toISOString();
 if(!["WAITING","RUNNING","QUEUED","FAILED","PARTIAL"].includes(q.status) || !q.head_id)
  throw Error("X1_CURRENT_CONTINUATION_HEAD_REQUIRED");
 const head=await tx(ctx,async c=>{
  const row=(await c.query<{body:InstitutionHarnessProgram;digest:string}>(`SELECT body,digest
   FROM finnor_os.p1_programs WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4`,
   [q.tenant_id,q.principal_id,q.head_id,q.id])).rows[0];
  if(!row||sha(row.body)!==row.digest||row.body.schema!=="finnor.institution-harness-program.v1"
    ||!["WAITING","PARTIAL"].includes(row.body.status)||row.body.work.revision!==q.work_input_id)
    throw Error("X1_WAITING_HEAD_CHANGED");
  return row.body;
 },true);
 const adoptClaim=async(c:PoolClient,row:Awaited<ReturnType<typeof nativeRequestRow>>)=>{
  const updated=await c.query(`UPDATE finnor_os.p1_requests
    SET status='RUNNING',claim_token=$4,claim_fence=$5,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3
      AND status IN('WAITING','RUNNING','QUEUED','FAILED','PARTIAL')`,
    [q.tenant_id,q.principal_id,q.id,execution.claimToken,execution.claimFence]);
  if(updated.rowCount!==1)throw Error("X1_CONTINUATION_CLAIM_FENCED");
  return {...row,status:"RUNNING",claim_token:execution.claimToken,claim_fence:execution.claimFence};
 };
 if(Date.now()>=Date.parse(head.bounds.deadlineAt)){
  // A terminal metadata stop does not re-open expired authority or re-dispatch
  // an uncertain native effect. Its receipt retains the last observed head.
  await tx(ctx,async c=>{
   const locked=await nativeRequestRow(ctx,q.id,c,true);
   const claim=(await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
    AND type='run_x1_institution_continuation_v1' AND status='running'
    AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
    [q.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
   if(!claim||locked.generation!==q.generation||locked.head_id!==q.head_id
    ||["OBSERVED","CANCELLED","INVALIDATED"].includes(locked.status))
    throw Error("X1_CONTINUATION_CLAIM_FENCED");
   const running=await adoptClaim(c,locked);
   await persistProgrammeHead(ctx,running,{...head,status:"PARTIAL"},"PARTIAL",
    "X1_ORIGINAL_OBSERVATION_DEADLINE_EXPIRED",c);
   await trace(ctx,locked,"X1_ORIGINAL_OBSERVATION_DEADLINE_EXPIRED",{
    originalDeadline:head.bounds.deadlineAt,observationsRetained:head.observedPostconditions,
    replacementActionCreated:false,originalEpisode:q.episode_id},c);
  });
  return;
 }
 await assertProgramCurrent(ctx,q);
 const resource=await validateInstitutionDemand(ctx,q.proposed.reservationRef);
 if(resource.status!=="CURRENT")
  throw Error("X1_P1_S5_PARENT_NOT_CURRENT");
 const executable=head.nodes.filter(node=>node.action);
 if(!executable.length)throw Error("X1_SUPPORTED_ACTION_POPULATION_REQUIRED");
 for(const node of executable){
  const expected=frozenDutyExpectation(q.tenant_id,node);
  const duty=q.request.institution.responsibilities.find(r=>r.obligation.stableIdentity===node.stableIdentity);
  if(!duty||duty.obligation.postcondition.structuralObserver.entityType!==expected.entityType
    ||duty.obligation.postcondition.structuralObserver.dealId!==expected.dealId
    ||node.postconditionRef!==duty.obligation.postcondition.contractRef
    ||node.observerRef!==duty.obligation.independentObserver.ref)
    throw Error("X1_REQUEST_DUTY_AND_CANONICAL_ROOT_MISMATCH");
 }
 const claimed=await tx(ctx,async c=>{
  const locked=await nativeRequestRow(ctx,q.id,c,true);
  const job=(await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
    AND type='run_x1_institution_continuation_v1' AND protocol_version=1 AND status='running'
    AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
   [q.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
  if(!job||locked.generation!==q.generation||locked.head_id!==q.head_id
    ||!["WAITING","RUNNING","QUEUED","FAILED","PARTIAL"].includes(locked.status))
    throw Error("X1_CONTINUATION_CLAIM_FENCED");
  const allowed=(await c.query(`SELECT id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1
    AND id=$2 AND work_id=$3 AND work_input_id=$4 AND status='active' FOR SHARE`,
   [q.tenant_id,q.plan_revision_id,q.work_id,q.work_input_id])).rows[0];
  if(!allowed)throw Error("X1_ACTIVE_PLAN_REQUIRED");
  const running=await adoptClaim(c,locked);
  const step=(await c.query<{steps_used:number}>(`UPDATE finnor_os.p1_episodes
    SET steps_used=steps_used+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3
      AND steps_used+1<=LEAST(max_steps,$4) AND deadline_at>clock_timestamp() RETURNING steps_used`,
    [q.tenant_id,q.principal_id,q.episode_id,q.request.institution.compilerRequestId?128:64])).rows[0];
  if(!step){
   await persistProgrammeHead(ctx,running,{...head,status:"PARTIAL"},"PARTIAL","X1_ORIGINAL_CONTINUATION_ENVELOPE_EXHAUSTED",c);
   await trace(ctx,locked,"X1_ORIGINAL_CONTINUATION_ENVELOPE_EXHAUSTED",{
    originalEpisode:q.episode_id,observationsRetained:head.observedPostconditions,possibleEffectsRetained:true},c);
   return null;
  }
  await trace(ctx,locked,"X1_CONTINUATION_CLAIMED",{jobId:execution.jobId,claimFence:execution.claimFence},c);
  return {...running,
    continuationOrdinal:step.steps_used} as InstitutionProgramRow & {continuationOrdinal:number};
 });
 if(!claimed)return;
 // A governed S6 origin is never sent through this protocol-2 ordinary action.
 // Check before drafting AND again inside publication, so later attachment cannot
 // silently turn the old ordinary path into a protected delivery.
 const noGovernedOrigin=async(id:string)=>tx(ctx,async c=>(await c.query(
  `SELECT 1 FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1 AND domain_action_id=$2`,
  [q.tenant_id,id])).rowCount===0,true);
 let resourceCharged=false;
 try{
  if(q.request.institution.compilerRequestId){
   const {compilerRow,compilerEpisode}=await import("../institution-program/store");
   const compiler=await compilerRow(ctx,q.request.institution.compilerRequestId);
   const episode=await compilerEpisode(ctx,compiler.episode_id);
   await chargeInstitutionDemand(ctx,head.reservationRef,{
    responsibilityIdentity:`x1-compiler-episode:${episode.id}`,phase:"RECOVERY",
    ordinal:claimed.continuationOrdinal,units:1});
  }else{
   // Legacy explicit institution requests charge their checked first duty.
   await chargeInstitutionDemand(ctx,head.reservationRef,{responsibilityIdentity:executable[0]!.stableIdentity,
    phase:"RECOVERY",ordinal:claimed.continuationOrdinal,units:1});
  }
  resourceCharged=true;
  const cursor=head.deliveryCursor??0,chunk=executable.slice(cursor,cursor+40);
  const interventions=[...(head.interventions??[])];
  for(const node of chunk){
   await assertProgramCurrent(ctx,claimed);
   const expected=frozenDutyExpectation(q.tenant_id,node);
   await authorize(ctx,{entityType:"pe_deal",entityId:expected.dealId},[{type:"work",id:q.work_id}]);
   const id=actionId(node);
   if(!await noGovernedOrigin(id))throw Error("X1_GOVERNED_ORIGIN_REQUIRES_PROTOCOL3");
   const existing=await tx(ctx,async c=>(await c.query<{
    work_id:string|null;initiated_by:string|null;action_type:string;
    payload:unknown;plan_revision_id:string|null;status:string;episode_id:string|null;authority_context:any
   }>(`SELECT a.work_id,a.initiated_by,a.action_type,a.payload,a.plan_revision_id,a.status,
      p.episode_id,a.authority_context FROM finnor_os.domain_actions a
     LEFT JOIN finnor_os.p1_requests p ON p.tenant_id=a.tenant_id
      AND p.plan_revision_id=a.plan_revision_id AND p.principal_id=a.initiated_by
     WHERE a.tenant_id=$1 AND a.id=$2`,[q.tenant_id,id])).rows[0],true);
   if(existing&&(existing.work_id!==q.work_id||existing.initiated_by!==q.principal_id
     ||existing.action_type!==node.operation||existing.episode_id!==q.episode_id
     ||existing.authority_context?.kind!=="institution_duty"
     ||existing.authority_context?.stableIdentity!==node.stableIdentity
     ||!matchesFrozenInstitutionIntent(node.action!.payload,existing.payload,q.work_id))){
    interventions.push({stableIdentity:node.stableIdentity,
     predicate:"X1_ORIGINAL_EFFECT_INTENT_CONFLICT_REQUIRES_DECISION",possibleEffect:true});
    await trace(ctx,claimed,"X1_ORIGINAL_EFFECT_RETAINED",{stableIdentity:node.stableIdentity,
     actionId:id,priorStatus:existing.status,predicate:"X1_ORIGINAL_EFFECT_INTENT_CONFLICT_REQUIRES_DECISION"});
    continue;
   }
   if(existing&&existing.plan_revision_id!==q.plan_revision_id&&existing.status==="draft"){
    interventions.push({stableIdentity:node.stableIdentity,
     predicate:"X1_PRIOR_DRAFT_PLAN_SUPERSEDED_REQUIRES_DECISION",possibleEffect:false});
    continue;
   }
   // Accepted/possibly submitted actions are reconciled in place. The native
   // runtime owns their retry/receipt path; P1 never creates a replacement ID.
   if(!existing||existing.status==="draft"){
    // The deterministic action ID makes uncertain delivery recoverable by the
    // native bridge. No self-supplied completion receipt is accepted.
    const { FinnorOrchestrator }=await import("../../../orchestration/src");
    await new FinnorOrchestrator().draftKnownAction(node.operation,node.action!.payload,q.tenant_id,{
     source:"x1_checked_institution_duty",actionId:id,workId:q.work_id,initiatedBy:principal(ctx),
     authorityContext:{principal:principal(ctx),kind:"institution_duty",programId:q.id,
      compilerRequestId:q.request.institution.compilerRequestId??null,
      stableIdentity:node.stableIdentity,workInputId:q.work_input_id},
     planRevisionId:q.plan_revision_id,reviewBeforeExecution:false,
    });
   }
  }
  await tx(ctx,async(c,db)=>{
   await c.query(`SELECT l.id FROM finnor_os.work_objective_loops l
    JOIN finnor_os.work_plan_revisions p ON p.objective_loop_id=l.id AND p.tenant_id=l.tenant_id
    WHERE l.tenant_id=$1 AND p.id=$2 FOR UPDATE OF l`,[q.tenant_id,q.plan_revision_id]);
   await assertProgramCurrent(ctx,claimed,c,true);
   const current=await nativeRequestRow(ctx,q.id,c,true);
   const job=(await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
    AND type='run_x1_institution_continuation_v1' AND status='running'
    AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
    [q.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
   if(!job||current.generation!==q.generation||current.status!=="RUNNING"
     ||current.claim_token!==execution.claimToken||current.claim_fence!==execution.claimFence)
    throw Error("X1_OBSERVATION_PUBLICATION_FENCED");
   const observed:InstitutionHarnessProgram["observedPostconditions"]=[...head.observedPostconditions];
   const previous=new Map(head.observedPostconditions.map(item=>[item.stableIdentity,item]));
   if(previous.size!==head.observedPostconditions.length)throw Error("X1_SAVED_CREATION_WITNESS_DUPLICATE");
   for(const prior of observed){
    const node=executable.find(item=>item.stableIdentity===prior.stableIdentity);
    if(!node)throw Error("X1_SAVED_CREATION_WITNESS_NO_DUTY");
    const expected=frozenDutyExpectation(q.tenant_id,node);
    if(prior.canonicalRef!==`${expected.entityType}:${expected.entityId}`
     ||!/^([a-f0-9]{64})$/.test(prior.observerDigest)
     ||prior.derivationRevision&&prior.derivationRevision!==node.derivationRevision
     ||prior.actionId&&prior.actionId!==actionId(node)
     ||prior.frozenIntentDigest&&prior.frozenIntentDigest!==sha(node.action))
     throw Error("X1_SAVED_CREATION_WITNESS_INTENT_CHANGED");
   }
   for(const node of executable){
    const id=actionId(node);
    const action=(await c.query<{status:string;effect_status:string|null;payload:unknown}>(
     `SELECT a.status,e.status effect_status,a.payload FROM finnor_os.domain_actions a
      LEFT JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id
        AND e.domain_action_id=a.id
      WHERE a.tenant_id=$1 AND a.id=$2 AND a.work_id=$3
        AND a.initiated_by=$4 AND EXISTS
        (SELECT 1 FROM finnor_os.p1_requests prior WHERE prior.tenant_id=a.tenant_id
          AND prior.plan_revision_id=a.plan_revision_id AND prior.work_id=a.work_id
          AND prior.principal_id=a.initiated_by AND prior.episode_id=$5)
        AND a.action_type=$6 AND NOT EXISTS
        (SELECT 1 FROM finnor_os.s6_obligation_origins o
          WHERE o.tenant_id=a.tenant_id AND o.domain_action_id=a.id)`,
     [q.tenant_id,id,q.work_id,q.principal_id,q.episode_id,node.operation])).rows[0];
    if(!action||!matchesFrozenInstitutionIntent(node.action!.payload,action.payload,q.work_id,true)
      ||action.status!=="completed"||action.effect_status!=="verified"){
     if(previous.has(node.stableIdentity))interventions.push({stableIdentity:node.stableIdentity,
      predicate:"X1_PRIOR_CREATION_EFFECT_REQUIRES_RECONCILIATION",possibleEffect:true});
     continue;
    }
    const prior=previous.get(node.stableIdentity);
    if(prior){
     // The immutable saved head binds legacy witnesses to these same nodes.
     // New observations also carry explicit derivation/action/intent bindings.
     continue;
    }
    const result=await readCanonicalDuty(c,q.tenant_id,node);
    if(result.observed&&result.observerDigest)observed.push({stableIdentity:node.stableIdentity,
     canonicalRef:result.canonicalRef,observerDigest:result.observerDigest,
     derivationRevision:node.derivationRevision,actionId:id,frozenIntentDigest:sha(node.action)});
   }
   const supportedComplete=observed.length===executable.length;
   const completed=supportedComplete&&executable.length===head.nodes.length
    &&head.institution.unresolved.length===0&&interventions.length===0;
   const deadlineExpired=Date.now()>=Date.parse(head.bounds.deadlineAt);
   const revised:InstitutionHarnessProgram={...head,observedPostconditions:observed,
    deliveryCursor:Math.min(cursor+chunk.length,executable.length),interventions,
    status:completed?"OBSERVED":supportedComplete||deadlineExpired?"PARTIAL":"WAITING",runtime:{...head.runtime,jobId:execution.jobId,
     workerId:execution.workerId,deliveryAttemptId:execution.deliveryAttemptId,
     claimFence:execution.claimFence}};
   await persistProgrammeHead(ctx,claimed,revised,revised.status,
    interventions[0]?.predicate??(deadlineExpired?"X1_ORIGINAL_OBSERVATION_DEADLINE_EXPIRED":
     supportedComplete&&!completed?"X1_UNRESOLVED_DUTIES_RETAINED":null),c);
   await trace(ctx,claimed,completed?"X1_CANONICAL_DUTIES_OBSERVED":"X1_CANONICAL_OBSERVATION_PENDING",
    {count:observed.length,total:head.nodes.length,deadlineAt:head.bounds.deadlineAt},c);
   if(completed){
    await (await import("../../../orchestration/src/objective-loop"))
     .schedulePreparedHarnessObjectiveTx(db,{tenantId:q.tenant_id,workId:q.work_id,planRevisionId:q.plan_revision_id});
   }else if(!supportedComplete&&!deadlineExpired){
    await c.query("UPDATE finnor_os.p1_requests SET poll_count=poll_count+1 WHERE tenant_id=$1 AND id=$2",
     [q.tenant_id,q.id]);
    // Exponential backoff reaches one minute. The final scheduled wake reaches
    // the original deadline; poll 60 is not a silent unscheduled WAITING state.
    const remaining=Date.parse(head.bounds.deadlineAt)-Date.now();
    const delay=Math.max(1,Math.min(remaining,60000,2000*2**Math.min(q.poll_count,5)));
    await enqueueProgram(ctx,claimed,"observe-"+(q.poll_count+1),c,delay);
   }
  });
 }catch(error){
  await tx(ctx,async c=>{
   const current=await nativeRequestRow(ctx,q.id,c,true);
   await trace(ctx,current,"X1_CONTINUATION_UNCERTAIN",{predicate:String((error as Error).message),
    possibleEffect:true,actionIds:executable.map(actionId)},c);
   if(current.generation===q.generation&&current.status==="RUNNING"
    &&current.claim_token===execution.claimToken&&current.claim_fence===execution.claimFence){
    if(!resourceCharged){
     await persistProgrammeHead(ctx,current,{...head,status:"PARTIAL"},"PARTIAL",
      "X1_ORIGINAL_RECOVERY_RESOURCE_REFUSED",c);
     await trace(ctx,current,"X1_ORIGINAL_RECOVERY_RESOURCE_REFUSED",{
      predicate:String((error as Error).message),replacementActionCreated:false,possibleEffectsRetained:true},c);
    }else await c.query(
    `UPDATE finnor_os.p1_requests SET status='WAITING',failure=$4,updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [q.tenant_id,q.principal_id,q.id,"X1_CONTINUATION_RECONCILIATION_REQUIRED"]);
   }
  });
  throw error;
 }finally{
  try{
   const compute=await persistInstitutionCompute(ctx,{requestId:q.id,workId:q.work_id,episodeId:q.episode_id,
    jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,parentReservation:head.reservationRef,
    rightsRevision:resource.reservation.rightsRevision,startedAt,
    elapsedMs:performance.now()-started,phase:"RECOVERY",status:"PHYSICAL_CONTINUATION_ATTEMPT",
    observedAcquisitionAttempts:0,observedCheckerAttempts:0});
   await trace(ctx,claimed,"X1_CONTINUATION_COMPUTE_ATTRIBUTED",{compute:compute.record.ref,
    ordinal:claimed.continuationOrdinal,originalEpisode:q.episode_id});
  }catch(error){
   await trace(ctx,claimed,"X1_CONTINUATION_METER_GAP",{jobId:execution.jobId,
    deliveryAttemptId:execution.deliveryAttemptId,elapsedMs:performance.now()-started,
    predicate:String((error as Error).message),money:null,humanSeconds:null,aggregatePeakMemoryBytes:null});
  }
 }
}
