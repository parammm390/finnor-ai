/** Durable native delivery, not an agent loop. Reconcilable jobs stay quarantined
 * after process loss until an explicit original-observation resume is requested. */
import { z } from "zod";
import { originOf } from "../../../orchestration/src/project-z/z0-convergence/institution-origin";
import { acceptInstitutionApplicationModel, returnInstitutionApplicationToOriginal } from "../../../orchestration/src/project-z/z0-convergence/institution-consumer";
import { acquireComputeResourceLeases, renewComputeResourceLeases, releaseComputeResourceLeases, ComputeCapacityUnavailableError,
  transitionWorkTx, type ComputeResourceLease, type WorkStatus } from "@finnor/db";
import type { ApplicationActionModel, ApplicationModelCheck, ApplicationSnapshot } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { principal, tx } from "../evidence-execution/store";
import { executeApplicationOwnerOperation } from "../program-synthesis/owners";
import { assertApplicationModelUse } from "./checker";
import { applicationGoalEstablished } from "./composition";
import { ApplicationExecuteSchema } from "./native-contracts";
import { applicationDatabaseDiagnostic, applicationFailureReason, parseApplicationComposition, x2Digest, x2Fault, x2Ref } from "./contracts";
import { assertApplicationClaim } from "./obligations";
import { applicationArtifact, applicationEvent, applicationSession, canonicalApplicationActor,
  currentApplicationWork, retainApplicationArtifact, type ApplicationSessionRow } from "./store";
import { initializeApplicationValidities } from "./validity";
import { continueNativeApplicationComposition, NativeApplicationRuntime } from "./runtime";
import { beginSelectionConsumption, isGovernedChild, retainSelectionReceipt, settleSelectionFailure,
  staleLiveSelections } from "./governed";
import { executeGovernedApplicationStep } from "../program-synthesis/owners";

const PayloadSchema = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(),
  sessionId: z.string().uuid(), generation: z.number().int().positive().safe(),
  selectionId: z.string().uuid().optional() }).strict();
const terminal = new Set(["COMPLETED", "MODEL_READY"]);
const stopped = new Set(["CANCELLED", "FAILED", "STALE", "BLOCKED"]);
async function claim(ctx: PeMutationContext, row: ApplicationSessionRow, execution: Readonly<JobExecutionContext>) {
  return tx(ctx, async (c) => {
    const current = await applicationSession(ctx, row.id, c, true);
    if (current.generation !== row.generation) x2Fault("X2_DELIVERY_GENERATION_FENCED");
    const job = await c.query(
      "SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.tenant_id=j.tenant_id"
      + " WHERE j.tenant_id=$1 AND j.id=$2 AND j.type='run_application_semantics_v1' AND j.protocol_version=1"
      + " AND j.status='running' AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()"
      + " AND a.id=$5 AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND a.finished_at IS NULL"
      + " AND j.payload->>'sessionId'=$6 AND (j.payload->>'generation')::integer=$7 FOR SHARE OF j,a",
      [current.tenant_id, execution.jobId, execution.claimToken, execution.claimFence,
        execution.deliveryAttemptId, current.id, current.generation]);
    if (job.rowCount !== 1) x2Fault("X2_ACTUAL_DURABLE_DELIVERY_REQUIRED");
    const next = (await c.query<ApplicationSessionRow>(
      "UPDATE finnor_os.application_semantics_sessions SET claim_token=$3,claim_fence=$4,"
      + " started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [current.tenant_id, current.id, execution.claimToken, execution.claimFence])).rows[0]!;
    await applicationEvent(ctx, next, "PHYSICAL_DELIVERY_STARTED", { jobId: execution.jobId,
      deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence, workerId: execution.workerId,
      originalDeadline: next.parent.deadlineAt, newAllowance: false, money: null }, c);
    return next;
  });
}

async function changeStatus(ctx: PeMutationContext, row: ApplicationSessionRow, execution: Readonly<JobExecutionContext>,
  status: string, workStatus: WorkStatus | null, detail: Record<string, unknown> = {}) {
  return tx(ctx, async (c, db) => {
    const current = await applicationSession(ctx, row.id, c, true);
    await assertApplicationClaim(ctx, current, execution, c, stopped.has(status) || status === "UNKNOWN");
    if (stopped.has(current.status) && current.status !== status) return current;
    const next = (await c.query<ApplicationSessionRow>(
      "UPDATE finnor_os.application_semantics_sessions SET status=$3,reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [current.tenant_id, current.id, status, detail.reason ?? null])).rows[0]!;
    await applicationEvent(ctx, next, "NATIVE_SESSION_" + status, detail, c);
    await returnInstitutionApplicationToOriginal(ctx, next, c);
    if (workStatus && !originOf(current)) {
      const work = (await c.query<{ status: string }>("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
        [current.tenant_id, current.work_id])).rows[0];
      if (work && !["completed", "cancelled", "failed"].includes(work.status)) await transitionWorkTx(db,
        current.tenant_id, current.work_id, workStatus, "application_semantics_" + status.toLowerCase(), {
          sessionId: current.id, workInputId: current.work_input_id, ...detail,
        }, { expectedWorkInputId: current.work_input_id });
    }
    return next;
  });
}

async function publishModel(ctx: PeMutationContext, row: ApplicationSessionRow, execution: Readonly<JobExecutionContext>,
  model: ApplicationActionModel, check: ApplicationModelCheck) {
  assertApplicationModelUse(model, check);
  return tx(ctx, async (c, db) => {
    const current = await applicationSession(ctx, row.id, c, true);
    await assertApplicationClaim(ctx, current, execution, c);
    await currentApplicationWork(ctx, current, c);
    const retained = await applicationArtifact<Omit<ApplicationActionModel, "ref">>(ctx, model.ref, c);
    if (x2Digest(retained) !== model.ref.contentDigest || current.model_ref || current.check_ref) x2Fault("X2_FROZEN_MODEL_PUBLICATION_CONFLICT");
    await retainApplicationArtifact(ctx, model.ref, retained, false, c, [current.parent.rightsRevision]);
    const { ref: _checkRef, ...checkBody } = check;
    await retainApplicationArtifact(ctx, check.ref, checkBody, false, c, [current.parent.rightsRevision]);
    const next = (await c.query<ApplicationSessionRow>(
      "UPDATE finnor_os.application_semantics_sessions SET model_ref=$3::jsonb,check_ref=$4::jsonb,status='MODEL_READY',"
      + " finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [current.tenant_id, current.id, JSON.stringify(model.ref), JSON.stringify(check.ref)])).rows[0]!;
    await initializeApplicationValidities(ctx, next, model, check.ref, c);
    const evidence = await applicationEvent(ctx, next, "CHECKED_MODEL_FROZEN_BEFORE_FRESH_OBJECTIVE", {
      modelRef: model.ref, checkRef: check.ref, heldOutObjectiveKnown: false, protectedAdmission: false,
    }, c);
    const originalAcceptance = await acceptInstitutionApplicationModel(ctx, next, model, check, execution, c);
    if (!originalAcceptance) await transitionWorkTx(db, current.tenant_id, current.work_id, "completed", "application_model_independently_checked",
      { sessionId: current.id, workInputId: current.work_input_id, modelRef: model.ref, checkRef: check.ref, evidenceRef: evidence },
      { expectedWorkInputId: current.work_input_id, finalOutcome: { schema: "finnor.x2.model-work-result.v1",
        sessionId: current.id, modelRef: model.ref, checkRef: check.ref, evidenceRef: evidence,
        acquisitionCompleted: true, freshBusinessAssignmentCompleted: false, protectedAdmission: false, billing: "UNKNOWN" } });
    return next;
  });
}

async function publishAssignment(ctx: PeMutationContext, row: ApplicationSessionRow, execution: Readonly<JobExecutionContext>,
  final: ApplicationSnapshot) {
  return tx(ctx, async (c, db) => {
    const current = await applicationSession(ctx, row.id, c, true);
    await assertApplicationClaim(ctx, current, execution, c);
    await currentApplicationWork(ctx, current, c);
    const request = ApplicationExecuteSchema.parse(current.request);
    const finalRef = x2Ref("COMPUTER", "application-observation", final);
    const retained = await applicationArtifact<ApplicationSnapshot>(ctx, finalRef, c);
    if (retained.target.id !== request.targetId || !applicationGoalEstablished(request.goal, retained.state)
      || retained.scope.tenantId !== current.tenant_id || retained.scope.principalId !== current.principal_id
      || retained.observationQualification !== "LAWFUL_INDEPENDENT_READBACK") x2Fault("X2_NATIVE_INDEPENDENT_ASSIGNMENT_OBSERVATION_REQUIRED");
    const requests = (await c.query<{ status: string; effect_status: string; action_status: string; receipt_id: string | null }>(
      "SELECT r.status,e.status effect_status,d.status action_status,dr.id receipt_id FROM finnor_os.application_semantics_requests r"
      + " JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id"
      + " JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id"
      + " JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id"
      + " LEFT JOIN finnor_os.decision_receipts dr ON dr.tenant_id=d.tenant_id AND dr.domain_action_id=d.id"
      + " WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.session_id=$3 ORDER BY r.created_at,r.id",
      [ctx.auth.tenantId, principal(ctx), current.id])).rows;
    if (!requests.length || requests.length > 8 || requests.some((item) => item.status !== "VERIFIED"
      || item.effect_status !== "verified" || item.action_status !== "completed" || !item.receipt_id)) x2Fault("X2_CANONICAL_ALL_EFFECT_RECEIPTS_REQUIRED");
    const evidence = await applicationEvent(ctx, current, "INDEPENDENT_FRESH_ASSIGNMENT_COMPLETED", {
      modelRef: current.model_ref, checkRef: current.check_ref, compositionRef: current.composition_ref,
      finalObservationRef: finalRef, receiptIds: requests.map((item) => item.receipt_id),
      originalParentRef: current.original_parent_ref, originalDeadline: current.parent.deadlineAt,
      protectedAdmission: false, resourcesReleased: false, billing: "UNKNOWN",
    }, c);
    await c.query("UPDATE finnor_os.application_semantics_sessions SET status='COMPLETED',finished_at=clock_timestamp(),"
      + " updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [current.tenant_id, current.id]);
    await transitionWorkTx(db, current.tenant_id, current.work_id, "completed", "application_assignment_independently_observed",
      { sessionId: current.id, workInputId: current.work_input_id, evidenceRef: evidence },
      { expectedWorkInputId: current.work_input_id, finalOutcome: { schema: "finnor.x2.assignment-work-result.v1",
        sessionId: current.id, modelRef: current.model_ref, checkRef: current.check_ref, compositionRef: current.composition_ref,
        evidenceRef: evidence, finalObservationRef: finalRef, actualIndependentBusinessOutcome: true,
        originalParentRef: current.original_parent_ref, receiptIds: requests.map((item) => item.receipt_id),
        protectedAdmission: false, resourceReleaseGranted: false, billing: "UNKNOWN" } });
  });
}

/** A governed origin child is inert without a live Z3 selection. With one it
 * performs exactly that canonical step, retains the owner receipt and parks
 * again. The Work is never completed here: the original P1 owns it. */
async function runGovernedChild(ctx: PeMutationContext, start: ApplicationSessionRow, execution: Readonly<JobExecutionContext>,
  runtime: NativeApplicationRuntime, selectionId: string | undefined) {
  let row = start;
  const park = async () => {
    if (row.status !== "PLANNING") row = await changeStatus(ctx, row, execution, "PLANNING", null);
  };
  if (!selectionId) {
    await park();
    await applicationEvent(ctx, row, "Z3_GOVERNED_CHILD_PARKED_FOR_SELECTION", { compositionRef: row.composition_ref,
      s5ConsumptionS6S8OrWire: false, originalDeadline: row.parent.deadlineAt, newAllowance: false });
    return;
  }
  let selection = await beginSelectionConsumption(ctx, row, selectionId, execution);
  if (selection.status !== "CONSUMING") { await park(); return; }
  row = await changeStatus(ctx, row, execution, "EXECUTING", null);
  runtime.adoptCanonicalSession(row);
  const after = await executeGovernedApplicationStep(ctx, { sessionId: row.id, compositionRef: row.composition_ref!,
    stepId: selection.step_id }, execution, runtime);
  selection = await retainSelectionReceipt(ctx, row, selection, after, execution);
  const composition = parseApplicationComposition({ ...await applicationArtifact<object>(ctx, row.composition_ref!),
    ref: row.composition_ref! });
  if (selection.step_index === composition.steps.length - 1) {
    try {
      const final = await continueNativeApplicationComposition(ctx, row.id, composition, execution, runtime);
      row = await changeStatus(ctx, row, execution, "COMPLETED", null, { reason: "Z3_GOVERNED_GOAL_INDEPENDENTLY_ESTABLISHED",
        finalObservationRef: x2Ref("COMPUTER", "application-observation", final), workTransition: "NOT_PERFORMED_ORIGINAL_P1_OWNS_COMPLETION" });
      return;
    } catch (error) {
      if (applicationFailureReason(error) !== "X2_INDEPENDENT_BUSINESS_GOAL_NOT_ESTABLISHED") throw error;
      await applicationEvent(ctx, row, "Z3_GOVERNED_COMPOSITION_EXHAUSTED_GOAL_NOT_ESTABLISHED", {
        selectionId, goalSuccess: false, newAllowance: false });
    }
  }
  await park();
}

export async function runApplicationSemanticsJob(payload: Record<string, unknown>, actual?: Readonly<JobExecutionContext>): Promise<void> {
  const input = PayloadSchema.parse(payload);
  const claimFence = Number(actual?.claimFence);
  if (!actual || actual.tenantId !== input.tenantId || actual.protocolVersion !== 1 || actual.retrySafety !== "reconcilable"
    || !Number.isSafeInteger(claimFence) || claimFence < 1) x2Fault("X2_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED");
  const execution = Object.freeze({ ...actual, claimFence });
  const ctx = await canonicalApplicationActor(input.tenantId, input.principalId);
  let row = await applicationSession(ctx, input.sessionId);
  if (row.generation !== input.generation || terminal.has(row.status)) return;
  let runtime: NativeApplicationRuntime | null = null, leases: ComputeResourceLease[] = [], released = false;
  const started = performance.now(), usage = process.resourceUsage();
  try {
    row = await claim(ctx, row, execution);
    await currentApplicationWork(ctx, row, undefined, true);
    leases = await acquireComputeResourceLeases({ tenantId: row.tenant_id, resourceKeys: ["native:x2"],
      requiredResourceKeys: ["native:x2"], workloadClass: "INTERACTIVE", ownerId: `x2:${execution.deliveryAttemptId}` });
    execution.registerHeartbeat(async () => released || await renewComputeResourceLeases(leases));
    runtime = new NativeApplicationRuntime(ctx, row, execution);
    const recovered = await runtime.reconcilePossibleRequests();
    const unresolved = await tx(ctx, async (c) => (await c.query(
      "SELECT id FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3"
      + " AND possible_egress AND status NOT IN ('VERIFIED','DENIED') LIMIT 1",
      [row.tenant_id, row.principal_id, row.id])).rowCount, true);
    const expired = row.deadline_at.getTime() <= Date.now();
    if (stopped.has(row.status) || row.cancel_requested_at || expired) {
      if (!stopped.has(row.status)) row = await changeStatus(ctx, row, execution,
        row.cancel_requested_at ? "CANCELLED" : "BLOCKED", row.cancel_requested_at ? "cancelled" : "blocked",
        { reason: row.cancel_requested_at ? "X2_ORIGINAL_CANCELLED" : "X2_ORIGINAL_BUSINESS_DEADLINE_EXPIRED",
          resourcesReleased: false, newAllowance: false });
      await tx(ctx, c => returnInstitutionApplicationToOriginal(ctx, row, c));
      if (isGovernedChild(row)) await staleLiveSelections(ctx, row.id,
        row.cancel_requested_at ? "X2_ORIGINAL_CANCELLED" : "X2_ORIGINAL_BUSINESS_DEADLINE_EXPIRED");
      await applicationEvent(ctx, row, "STOPPED_ORIGINAL_OBSERVATION_FALLBACK", { recovered, unresolved,
        callee: "S6:NativeApplicationRuntime.reconcilePossibleRequests", actualMutations: 0, newAllowance: false });
      return;
    }
    if (unresolved) {
      row = await changeStatus(ctx, row, execution, "UNKNOWN", "waiting", { reason: "X2_ORIGINAL_EFFECT_RECONCILIATION_REQUIRED", recovered });
      return;
    }
    await currentApplicationWork(ctx, row);
    runtime.setPhase(row.id === row.parent_id ? "ACQUISITION" : "COMPOSITION");
    if (row.id === row.parent_id) {
      row = await changeStatus(ctx, row, execution, "ACQUIRING", "executing");
      runtime.adoptCanonicalSession(row);
      const learned = await runtime.acquire();
      row = await publishModel(ctx, row, execution, learned.model, learned.check);
      await applicationEvent(ctx, row, "S8_APPLICATION_ADMISSION_SEPARATE_PENDING", {
        modelRef: learned.model.ref, checkRef: learned.check.ref, protectedAdmission: false, executionAuthorityGranted: false,
      });
      return;
    }
    if (!row.composition_ref) {
      row = await changeStatus(ctx, row, execution, "PLANNING", "planning");
      runtime.adoptCanonicalSession(row);
      const initial = await runtime.freshInitial();
      await runtime.charge({ phase: "COMPOSITION", units: 1 });
      const selected = await executeApplicationOwnerOperation(ctx, { schema: "finnor.p1.application-owner-operation.v1",
        op: "compose_application_operations", sessionId: row.id, inputRef: x2Ref("COMPUTER", "application-observation", initial) }, execution, runtime);
      if (!("composition" in selected) || selected.status !== "DONE") {
        row = await changeStatus(ctx, row, execution, "BLOCKED", "blocked", { reason: "X2_S4_NO_EVIDENCED_COMPOSITION",
          fallback: "CURRENT_ORIGINAL_OBSERVATION_ONLY_NO_EFFECT_AUTHORITY" });
        return;
      }
      row = await tx(ctx, async (c) => {
        const current = await assertApplicationClaim(ctx, row, execution, c);
        return (await c.query<ApplicationSessionRow>("UPDATE finnor_os.application_semantics_sessions SET composition_ref=$3::jsonb,"
          + " updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND composition_ref IS NULL RETURNING *",
          [current.tenant_id, current.id, JSON.stringify(selected.reference)])).rows[0] ?? await applicationSession(ctx, current.id, c);
      });
    }
    if (isGovernedChild(row)) {
      await runGovernedChild(ctx, row, execution, runtime, input.selectionId);
      return;
    }
    row = await changeStatus(ctx, row, execution, "EXECUTING", "executing");
    runtime.adoptCanonicalSession(row);
    const continued = await executeApplicationOwnerOperation(ctx, { schema: "finnor.p1.application-owner-operation.v1",
      op: "continue_application_operations", sessionId: row.id, inputRef: row.composition_ref! }, execution, runtime);
    if (!("observation" in continued) || !continued.observation) x2Fault("X2_P1_ACTUAL_S6_OBSERVATION_REQUIRED");
    await publishAssignment(ctx, row, execution, continued.observation);
  } catch (error) {
    if (error instanceof ComputeCapacityUnavailableError && !runtime && !leases.length) {
      const current = await assertApplicationClaim(ctx, row, execution);
      await applicationEvent(ctx, current, "PHYSICAL_PREPARATION_CAPACITY_DEFERRED", {
        jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
        resourceKey: error.resourceKey, originalDeadline: current.parent.deadlineAt,
        providerProvisioned: false, newAllowance: false,
      });
      throw error;
    }
    const reason = applicationFailureReason(error);
    const current = await applicationSession(ctx, row.id);
    await applicationEvent(ctx, current, "FAILED_OR_FENCED_PHYSICAL_DELIVERY", { reason,
      diagnosticDigest: x2Digest({ name: error instanceof Error ? error.name : "UNKNOWN", reason }),
      databaseDiagnostic: applicationDatabaseDiagnostic(error),
      jobId: execution.jobId, claimFence: execution.claimFence, costUSD: null, responsibilitiesRetained: true });
    if (current.generation !== row.generation || current.claim_token !== execution.claimToken || stopped.has(current.status)) return;
    const possible = await tx(ctx, async (c) => (await c.query(
      "SELECT id FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3"
      + " AND possible_egress AND status NOT IN ('VERIFIED','DENIED') LIMIT 1", [row.tenant_id, row.principal_id, row.id])).rowCount, true);
    const status = possible ? "UNKNOWN" : /DRIFT|CHANGED|CURRENT|VALIDITY|INTERFERENCE/.test(reason) ? "STALE" : "FAILED";
    if (input.selectionId) await settleSelectionFailure(ctx, row.id, input.selectionId, reason, status === "STALE");
    await changeStatus(ctx, current, execution, status, possible ? "waiting" : "blocked", { reason,
      fallback: possible ? "EXPLICIT_ORIGINAL_REQUEST_OBSERVATION_RESUME" : "NO_ADMITTED_FORWARD_REPAIR" });
  } finally {
    await runtime?.close();
    released = true;
    if (leases.length) await releaseComputeResourceLeases(leases, "x2_owned_physical_delivery_finished");
    const after = process.resourceUsage();
    await applicationEvent(ctx, row, "PHYSICAL_DELIVERY_COST_METER", {
      jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, wallMs: performance.now() - started,
      userCpuMicros: after.userCPUTime - usage.userCPUTime, systemCpuMicros: after.systemCPUTime - usage.systemCPUTime,
      processMaximumRss: after.maxRSS, maximumRssCoverage: "PROCESS_LIFETIME_NOT_AGGREGATE_SIMULTANEOUS",
      aggregateSimultaneousMemory: null, providerBilling: null, humanWork: null, resourceReleaseGranted: false,
    });
  }
}
