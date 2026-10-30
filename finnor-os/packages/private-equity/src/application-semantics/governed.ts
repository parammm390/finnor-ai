/** Application-owner side of a Z3-selected step. A viability-governed origin
 * child never runs the composition by itself: it executes exactly the one
 * canonical step that a retained, live selection names, under its own durable
 * claim, and retains the owner receipt that Z3 reads back. */
import type { PoolClient } from "pg";
import type { ApplicationSnapshot, ExperimentRef } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { principal, tx } from "../evidence-execution/store";
import { sameX2Ref, x2Digest, x2Fault, x2Ref } from "./contracts";
import { assertApplicationClaim } from "./obligations";
import { applicationArtifact, applicationEvent, applicationSession, retainApplicationArtifact, type ApplicationSessionRow } from "./store";

export const GOVERNED_ORIGIN_CHILD = "finnor.s4.z3-governed-origin-child.v1" as const;
export const Z3_STEP_RECEIPT = "finnor.s4.z3-application-step-receipt.v1" as const;
export type SelectionStatus = "SELECTED" | "CONSUMING" | "RESULT_RETAINED" | "REFUSED" | "STALE";
export interface ApplicationSelectionRow {
  id: string; tenant_id: string; principal_id: string; session_id: string; parent_session_id: string;
  work_id: string; work_input_id: string; composition_ref: ExperimentRef; composition_digest: string;
  step_id: string; step_index: number; operation_id: string; semantic_revision: string; original_grant_ref: ExperimentRef;
  z3_session_id: string; z3_edge_index: number; z3_cursor_digest: string; z3_map_digest: string;
  status: SelectionStatus; reason: string | null; receipt_ref: ExperimentRef | null; receipt_digest: string | null;
  x2_claim_fence: string | null; deadline_at: Date;
}
export const isGovernedChild = (row: ApplicationSessionRow) =>
  row.id !== row.parent_id && row.parent.viabilityGoverned?.schema === GOVERNED_ORIGIN_CHILD;

export async function applicationSelection(ctx: PeMutationContext, id: string, c: PoolClient, lock = false) {
  const row = (await c.query<ApplicationSelectionRow>(
    "SELECT * FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND principal_id=$2 AND id=$3" + (lock ? " FOR UPDATE" : ""),
    [ctx.auth.tenantId, principal(ctx), id])).rows[0];
  if (!row) x2Fault("Z3_APPLICATION_SELECTION_UNAVAILABLE");
  return row;
}

/** The application owner's own claim takes the selection. A selection that is
 * no longer live, or whose current owner bindings changed, is never consumed. */
export async function beginSelectionConsumption(ctx: PeMutationContext, row: ApplicationSessionRow,
  selectionId: string, execution: Readonly<JobExecutionContext>): Promise<ApplicationSelectionRow> {
  return tx(ctx, async (c) => {
    const current = await applicationSession(ctx, row.id, c, true);
    await assertApplicationClaim(ctx, current, execution, c);
    const selection = await applicationSelection(ctx, selectionId, c, true);
    if (selection.session_id !== current.id || selection.parent_session_id !== current.parent_id
      || selection.work_id !== current.work_id || selection.work_input_id !== current.work_input_id
      || !current.composition_ref || !sameX2Ref(selection.composition_ref, current.composition_ref)
      || selection.composition_digest !== current.composition_ref.contentDigest
      || selection.deadline_at.getTime() !== new Date(current.parent.deadlineAt).getTime()) {
      x2Fault("Z3_APPLICATION_SELECTION_SESSION_SUBSTITUTION");
    }
    if (selection.status !== "SELECTED" && selection.status !== "CONSUMING") return selection;
    const refuse = async (status: "REFUSED" | "STALE", reason: string) => {
      const next = (await c.query<ApplicationSelectionRow>(
        "UPDATE finnor_os.z3_application_selections SET status=$4,reason=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 RETURNING *",
        [ctx.auth.tenantId, principal(ctx), selection.id, status, reason])).rows[0]!;
      await applicationEvent(ctx, current, "Z3_SELECTION_" + status, { selectionId: selection.id, reason, newAllowance: false }, c);
      return next;
    };
    if (current.cancel_requested_at || ["CANCELLED", "FAILED", "STALE", "BLOCKED", "COMPLETED"].includes(current.status)) {
      return refuse("STALE", "Z3_SELECTION_APPLICATION_SESSION_NOT_LIVE");
    }
    if (current.deadline_at.getTime() <= Date.now()) return refuse("STALE", "X2_ORIGINAL_BUSINESS_DEADLINE_EXPIRED");
    const z3 = (await c.query<{ status: string }>(
      "SELECT status FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE",
      [ctx.auth.tenantId, principal(ctx), selection.z3_session_id])).rows[0];
    if (!z3 || ["STALE", "FAILED"].includes(z3.status)) return refuse("STALE", "Z3_SELECTING_VIABILITY_SESSION_NOT_CURRENT");
    return (await c.query<ApplicationSelectionRow>(
      "UPDATE finnor_os.z3_application_selections SET status='CONSUMING',x2_job_id=$4,x2_claim_token_digest=$5,x2_claim_fence=$6,"
      + " x2_delivery_attempt_id=$7,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 RETURNING *",
      [ctx.auth.tenantId, principal(ctx), selection.id, execution.jobId, x2Digest(execution.claimToken),
        execution.claimFence, execution.deliveryAttemptId])).rows[0]!;
  });
}

/** Retains the owner receipt only from a VERIFIED, independently observed S6
 * effect of exactly the selected step. Anything else stays CONSUMING (UNKNOWN
 * is reconciled by the S6 machinery, never replayed and never settled here). */
export async function retainSelectionReceipt(ctx: PeMutationContext, row: ApplicationSessionRow,
  selection: ApplicationSelectionRow, after: ApplicationSnapshot, execution: Readonly<JobExecutionContext>) {
  return tx(ctx, async (c) => {
    const current = await applicationSession(ctx, row.id, c, true);
    await assertApplicationClaim(ctx, current, execution, c);
    const locked = await applicationSelection(ctx, selection.id, c, true);
    if (locked.status === "RESULT_RETAINED") return locked;
    if (locked.status !== "CONSUMING") x2Fault("Z3_APPLICATION_SELECTION_NOT_CONSUMING");
    const request = (await c.query<{ id: string; request_ref: ExperimentRef; obligation_id: string; observation_ref: ExperimentRef | null;
      status: string; possible_egress: boolean }>(
      "SELECT id,request_ref,obligation_id,observation_ref,status,possible_egress FROM finnor_os.application_semantics_requests"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 AND node_id=$4",
      [ctx.auth.tenantId, principal(ctx), current.id, locked.step_id])).rows[0];
    if (!request || request.status !== "VERIFIED" || !request.possible_egress || !request.observation_ref
      || after.observationQualification !== "LAWFUL_INDEPENDENT_READBACK") x2Fault("Z3_SELECTED_STEP_INDEPENDENT_VERIFICATION_REQUIRED");
    const afterRef = x2Ref("COMPUTER", "application-observation", after);
    await applicationArtifact(ctx, afterRef, c);
    const body = { schema: Z3_STEP_RECEIPT, tenantId: ctx.auth.tenantId, principalId: principal(ctx),
      workId: current.work_id, workInputId: current.work_input_id, originalParentRef: current.original_parent_ref,
      sessionId: current.id, parentSessionId: current.parent_id, selectionId: locked.id,
      compositionRef: locked.composition_ref, stepId: locked.step_id, operationId: locked.operation_id,
      semanticRevision: locked.semantic_revision,
      z3: { sessionId: locked.z3_session_id, edgeIndex: locked.z3_edge_index, cursorDigest: locked.z3_cursor_digest,
        mapDigest: locked.z3_map_digest },
      requestRef: request.request_ref, obligationId: request.obligation_id, settlementRef: request.observation_ref,
      afterObservationRef: afterRef, afterState: after.state, disposition: "VERIFIED",
      originalDeadline: current.parent.deadlineAt, newAllowance: false, executionAuthorityGranted: false };
    const ref = x2Ref("S4", "z3-application-step-receipt", body);
    await retainApplicationArtifact(ctx, ref, body, true, c, [current.parent.rightsRevision]);
    const next = (await c.query<ApplicationSelectionRow>(
      "UPDATE finnor_os.z3_application_selections SET status='RESULT_RETAINED',receipt_ref=$4::jsonb,receipt_digest=$5,updated_at=clock_timestamp()"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 RETURNING *",
      [ctx.auth.tenantId, principal(ctx), locked.id, JSON.stringify(ref), ref.contentDigest])).rows[0]!;
    await applicationEvent(ctx, current, "Z3_SELECTED_STEP_RECEIPT_RETAINED", { selectionId: locked.id, stepId: locked.step_id,
      receiptRef: ref, originalDeadline: current.parent.deadlineAt, newAllowance: false }, c);
    return next;
  });
}

/** Cancellation and the inherited deadline end every selection that has not
 * egressed; one that did egress keeps its retained S6 identity. */
export async function staleLiveSelections(ctx: PeMutationContext, sessionId: string, reason: string) {
  const ids = await tx(ctx, async (c) => (await c.query<{ id: string }>(
    "SELECT id FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3"
    + " AND status IN('SELECTED','CONSUMING')", [ctx.auth.tenantId, principal(ctx), sessionId])).rows, true);
  for (const { id } of ids) await settleSelectionFailure(ctx, sessionId, id, reason, true);
}

/** A failed selected step that did not egress is a typed refusal of that
 * selection. An egressed one stays CONSUMING; its S6 identity is retained. */
export async function settleSelectionFailure(ctx: PeMutationContext, sessionId: string, selectionId: string,
  reason: string, stale: boolean) {
  await tx(ctx, async (c) => {
    const selection = await applicationSelection(ctx, selectionId, c, true);
    if (!["SELECTED", "CONSUMING"].includes(selection.status) || selection.session_id !== sessionId) return;
    const open = await c.query(
      "SELECT id FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3"
      + " AND node_id=$4 AND possible_egress AND status NOT IN('VERIFIED','DENIED')",
      [ctx.auth.tenantId, principal(ctx), sessionId, selection.step_id]);
    if (open.rowCount) return;
    await c.query("UPDATE finnor_os.z3_application_selections SET status=$4,reason=$5,updated_at=clock_timestamp()"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND id=$3", [ctx.auth.tenantId, principal(ctx), selectionId, stale ? "STALE" : "REFUSED", reason]);
  });
}
