import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { validateInstitutionDemand } from "../allocation-store";
import { authorize, principal, sha, stable, tx } from "../evidence-execution/store";
import type { InstitutionHarnessProgram } from "./contracts";
import { frozenDutyExpectation, readCanonicalDuty, matchesFrozenInstitutionIntent } from "./duty-observer";
import { assertProgramCurrent, enqueueProgram, nativeRequestRow, persistProgrammeHead, trace, type InstitutionProgramRow } from "./store";

// PE creation reserves the canonical request ID from DomainAction.id. The
// mandate's frozen expectedEntityId is therefore also the durable action ID.
const actionId = (node: InstitutionHarnessProgram["nodes"][number]) => {
 if(!node.action)throw Error("X1_EXACT_REQUEST_ACTION_REQUIRED");
 return node.action.expectedEntityId;
};

/** The actual command/worker, not this P1 job, mutates PE. After dispatch,
 * subsequent deliveries only reconcile the same action and canonical row. */
export async function continueInstitutionProgram(ctx: PeMutationContext, q: InstitutionProgramRow, execution: Readonly<JobExecutionContext>) {
 if(q.status!=="WAITING" || !q.head_id)throw Error("X1_CURRENT_WAITING_HEAD_REQUIRED");
 await assertProgramCurrent(ctx,q);
 if((await validateInstitutionDemand(ctx,q.proposed.reservationRef)).status!=="CURRENT")
  throw Error("X1_P1_S5_PARENT_NOT_CURRENT");
 const head=await tx(ctx,async c=>{
  const row=(await c.query<{body:InstitutionHarnessProgram;digest:string}>(`SELECT body,digest
   FROM finnor_os.p1_programs WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4`,
   [q.tenant_id,q.principal_id,q.head_id,q.id])).rows[0];
  if(!row||sha(row.body)!==row.digest||row.body.schema!=="finnor.institution-harness-program.v1"
    ||row.body.status!=="WAITING"||row.body.work.revision!==q.work_input_id)throw Error("X1_WAITING_HEAD_CHANGED");
  return row.body;
 },true);
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
    AND claim_token=$3 AND claim_fence=$4 FOR SHARE`,
   [q.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
  if(!job||locked.generation!==q.generation||locked.head_id!==q.head_id
    ||locked.status!=="WAITING")throw Error("X1_CONTINUATION_CLAIM_FENCED");
  const allowed=(await c.query(`SELECT id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1
    AND id=$2 AND work_id=$3 AND work_input_id=$4 AND status='active' FOR SHARE`,
   [q.tenant_id,q.plan_revision_id,q.work_id,q.work_input_id])).rows[0];
  if(!allowed)throw Error("X1_ACTIVE_PLAN_REQUIRED");
  const updated=await c.query(`UPDATE finnor_os.p1_requests
    SET status='RUNNING',claim_token=$4,claim_fence=$5,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status='WAITING'`,
   [q.tenant_id,q.principal_id,q.id,execution.claimToken,execution.claimFence]);
  if(updated.rowCount!==1)throw Error("X1_CONTINUATION_CLAIM_FENCED");
  await trace(ctx,locked,"X1_CONTINUATION_CLAIMED",{jobId:execution.jobId,claimFence:execution.claimFence},c);
  return {...locked,status:"RUNNING",claim_token:execution.claimToken,claim_fence:execution.claimFence} as InstitutionProgramRow;
 });
 // A governed S6 origin is never sent through this protocol-2 ordinary action.
 // Check before drafting AND again inside publication, so later attachment cannot
 // silently turn the old ordinary path into a protected delivery.
 const noGovernedOrigin=async(id:string)=>tx(ctx,async c=>(await c.query(
  `SELECT 1 FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1 AND domain_action_id=$2`,
  [q.tenant_id,id])).rowCount===0,true);
 try{
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
    AND claim_token=$3 AND claim_fence=$4 FOR SHARE`,
    [q.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
   if(!job||current.generation!==q.generation||current.status!=="RUNNING"
     ||current.claim_token!==execution.claimToken||current.claim_fence!==execution.claimFence)
    throw Error("X1_OBSERVATION_PUBLICATION_FENCED");
   const observed:InstitutionHarnessProgram["observedPostconditions"]=[];
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
      ||action.status!=="completed"||action.effect_status!=="verified")continue;
    const result=await readCanonicalDuty(c,q.tenant_id,node);
    if(result.observed&&result.observerDigest)observed.push({stableIdentity:node.stableIdentity,
     canonicalRef:result.canonicalRef,observerDigest:result.observerDigest});
   }
   const supportedComplete=observed.length===executable.length;
   const completed=supportedComplete&&executable.length===head.nodes.length
    &&head.institution.unresolved.length===0&&interventions.length===0;
   const revised:InstitutionHarnessProgram={...head,observedPostconditions:observed,
    deliveryCursor:Math.min(cursor+chunk.length,executable.length),interventions,
    status:completed?"OBSERVED":supportedComplete?"PARTIAL":"WAITING",runtime:{...head.runtime,jobId:execution.jobId,
     workerId:execution.workerId,deliveryAttemptId:execution.deliveryAttemptId,
     claimFence:execution.claimFence}};
   await persistProgrammeHead(ctx,claimed,revised,revised.status,
    interventions[0]?.predicate??(supportedComplete&&!completed?"X1_UNRESOLVED_DUTIES_RETAINED":null),c);
   await trace(ctx,claimed,completed?"X1_CANONICAL_DUTIES_OBSERVED":"X1_CANONICAL_OBSERVATION_PENDING",
    {count:observed.length,total:head.nodes.length,deadlineAt:head.bounds.deadlineAt},c);
   if(completed){
    await (await import("../../../orchestration/src/objective-loop"))
     .schedulePreparedHarnessObjectiveTx(db,{tenantId:q.tenant_id,workId:q.work_id,planRevisionId:q.plan_revision_id});
   }else if(!supportedComplete){
    await c.query("UPDATE finnor_os.p1_requests SET poll_count=poll_count+1 WHERE tenant_id=$1 AND id=$2",
     [q.tenant_id,q.id]);
    if(q.poll_count<60&&Date.now()<Date.parse(head.bounds.deadlineAt))
     await enqueueProgram(ctx,claimed,"observe-"+(q.poll_count+1),c,2000);
   }
  });
 }catch(error){
  await tx(ctx,async c=>{
   const current=await nativeRequestRow(ctx,q.id,c,true);
   await trace(ctx,current,"X1_CONTINUATION_UNCERTAIN",{predicate:String((error as Error).message),
    possibleEffect:true,actionIds:executable.map(actionId)},c);
   if(current.generation===q.generation&&current.status==="RUNNING"
    &&current.claim_token===execution.claimToken)await c.query(
    `UPDATE finnor_os.p1_requests SET status='WAITING',failure=$4,updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [q.tenant_id,q.principal_id,q.id,"X1_CONTINUATION_RECONCILIATION_REQUIRED"]);
  });
  throw error;
 }
}
