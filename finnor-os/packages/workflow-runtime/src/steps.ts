// Step claim/complete/fail/recover — mirrors domain_actions' proven atomic
// UPDATE...WHERE status=<expected> concurrency boundary (runAction()/decide() in
// packages/orchestration/src/index.ts). Step execution is driven through the existing
// Postgres job queue (apps/worker/src/queue.ts, job type "run_workflow_step") — this
// file's lease_expires_at is an additional, finer-grained atomic claim on top of the
// job-level lease, not a second queue system.

import { withTenant, enqueueJob, workflowSteps, workflowRuns, commands, jobs, integrationOperations, reconciliationCases, domainActions, domainPolicies, domainPolicyRevisions, businessEffects, decisionReceipts, reconcileWorkStatus, resolveTenantVertical, transitionWorkTx, type Db } from "@finnor/db";
import { and, eq, lt, sql, desc, inArray, or } from "drizzle-orm";
import { maybeChaosKill } from "./chaos";
import { openReconciliationCase } from "./reconciliation";
import { openReceiptTx, finalizeReceiptTx, findReceiptByStep, findReceiptByStepTx } from "./receipts";
import { ingestReceipt } from "./memory-ingest";
import { isRetiredWaterAction, isRetiredWaterWorkflow, RetiredVerticalError, type ReceiptEvidence } from "@finnor/shared-types";
import { workflowStepJobKey } from "./job-identity";

// Overridable (FINNOR_STEP_LEASE_SECONDS) so the chaos-test script can prove real
// lease-expiry recovery in seconds rather than waiting out the production default.
function leaseSeconds(): number {
  const override = process.env.FINNOR_STEP_LEASE_SECONDS;
  return override ? Number(override) : 300;
}

export type WorkflowStepRow = typeof workflowSteps.$inferSelect;

const ACTIONABLE_JOB_STATUSES = ["queued", "running"] as const;

async function assertActiveStepTx(db: Db, tenantId: string, step: Pick<WorkflowStepRow, "stepType" | "workflowRunId">): Promise<void> {
  if (isRetiredWaterAction(step.stepType)) throw new RetiredVerticalError("water");
  const [run] = await db.select({ workflowType: workflowRuns.workflowType }).from(workflowRuns).where(and(
    eq(workflowRuns.tenantId, tenantId),
    eq(workflowRuns.id, step.workflowRunId),
  )).limit(1);
  if (!run) throw new Error("Workflow run not found");
  if (isRetiredWaterWorkflow(run.workflowType)) throw new RetiredVerticalError("water");
}

async function enqueueWorkflowStepJobTx(
  db: Db,
  step: Pick<WorkflowStepRow, "id" | "tenantId" | "dispatchGeneration" | "correlationId">,
): Promise<void> {
  const payload = step.correlationId
    ? { tenantId: step.tenantId, workflowStepId: step.id, workflowStepGeneration: step.dispatchGeneration, _correlationId: step.correlationId }
    : { tenantId: step.tenantId, workflowStepId: step.id, workflowStepGeneration: step.dispatchGeneration };
  await db.insert(jobs).values({
    type: "run_workflow_step",
    payload,
    idempotencyKey: workflowStepJobKey(step.tenantId, step.id, step.dispatchGeneration),
    lane: "interactive",
    priority: 100,
  }).onConflictDoNothing({ target: jobs.idempotencyKey });
}

export async function enqueueStep(tenantId: string, stepId: string, idempotencyKey: string): Promise<void> {
  void idempotencyKey; // retained for source compatibility; delivery identity is step + generation.
  await resolveTenantVertical(tenantId);
  await withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workflowSteps} WHERE ${workflowSteps.tenantId}=${tenantId} AND ${workflowSteps.id}=${stepId}::uuid FOR UPDATE`);
    const [step] = await db.select().from(workflowSteps).where(and(
      eq(workflowSteps.tenantId, tenantId),
      eq(workflowSteps.id, stepId),
      eq(workflowSteps.status, "pending"),
    )).limit(1);
    if (!step) return;
    await assertActiveStepTx(db, tenantId, step);
    const [run] = await db.select({ status: workflowRuns.status }).from(workflowRuns).where(and(
      eq(workflowRuns.tenantId, tenantId),
      eq(workflowRuns.id, step.workflowRunId),
    )).limit(1);
    if (run?.status !== "running") return;

    const currentKey = workflowStepJobKey(tenantId, step.id, step.dispatchGeneration);
    const [currentJob] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.idempotencyKey, currentKey)).limit(1);
    if (currentJob && ACTIONABLE_JOB_STATUSES.includes(currentJob.status as typeof ACTIONABLE_JOB_STATUSES[number])) return;

    const dispatchGeneration = currentJob ? step.dispatchGeneration + 1 : step.dispatchGeneration;
    const [dispatchable] = dispatchGeneration === step.dispatchGeneration
      ? [step]
      : await db.update(workflowSteps).set({ dispatchGeneration, updatedAt: new Date() }).where(and(
          eq(workflowSteps.tenantId, tenantId),
          eq(workflowSteps.id, step.id),
          eq(workflowSteps.status, "pending"),
          eq(workflowSteps.dispatchGeneration, step.dispatchGeneration),
        )).returning();
    if (dispatchable) await enqueueWorkflowStepJobTx(db, dispatchable);
  });
}

/** Explicit recovery consumes a new generation even if the old job is still queued
 * or running. The step-row lock, generation update, and replacement job insert share
 * one transaction, so a crash cannot expose a reset step without an executable job. */
export async function redriveStepTx(db: Db, tenantId: string, stepId: string): Promise<WorkflowStepRow | null> {
  await db.execute(sql`SELECT id FROM ${workflowSteps} WHERE ${workflowSteps.tenantId}=${tenantId} AND ${workflowSteps.id}=${stepId}::uuid FOR UPDATE`);
  const [step] = await db.select().from(workflowSteps).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.id, stepId),
  )).limit(1);
  if (!step || !["pending", "leased", "failed"].includes(step.status)) return null;
  await assertActiveStepTx(db, tenantId, step);

  const dispatchGeneration = step.dispatchGeneration + 1;
  const [redriven] = await db.update(workflowSteps).set({
    status: "pending",
    dispatchGeneration,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.id, stepId),
    eq(workflowSteps.dispatchGeneration, step.dispatchGeneration),
  )).returning();
  if (!redriven) return null;

  const [run] = await db.select({ status: workflowRuns.status }).from(workflowRuns).where(and(
    eq(workflowRuns.tenantId, tenantId),
    eq(workflowRuns.id, redriven.workflowRunId),
  )).limit(1);
  if (run?.status === "running") await enqueueWorkflowStepJobTx(db, redriven);
  return redriven;
}

export async function redriveNextPendingStepTx(db: Db, tenantId: string, workflowRunId: string): Promise<WorkflowStepRow | null> {
  const [run] = await db.select({ workflowType: workflowRuns.workflowType }).from(workflowRuns).where(and(
    eq(workflowRuns.tenantId, tenantId),
    eq(workflowRuns.id, workflowRunId),
  )).limit(1);
  if (!run) throw new Error("Workflow run not found");
  if (isRetiredWaterWorkflow(run.workflowType)) throw new RetiredVerticalError("water");
  const steps = await db.select().from(workflowSteps).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.workflowRunId, workflowRunId),
  )).orderBy(workflowSteps.sequence);
  const next = steps.find((step) => step.status === "pending");
  if (!next) return null;
  const context: Record<string, unknown> = {};
  for (const step of steps) {
    if (step.status === "completed" && step.evidence) {
      const evidence = step.evidence as Record<string, unknown>;
      context[step.stepType] = "output" in evidence ? evidence.output : evidence;
    }
  }
  await db.update(workflowSteps).set({ payload: { ...(next.payload as Record<string, unknown>), context } }).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.id, next.id),
    eq(workflowSteps.status, "pending"),
  ));
  return redriveStepTx(db, tenantId, next.id);
}

/** The receipt claim is part of the same transaction as pending -> leased. A failure
 * rolls the claim back, so no provider effect can begin without durable evidence. */
async function openReceiptForClaimTx(db: Db, tenantId: string, step: WorkflowStepRow): Promise<void> {
  if (await findReceiptByStepTx(db, step.id)) return;
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, step.workflowRunId)));
  const [command] = run ? await db.select().from(commands).where(and(eq(commands.tenantId, tenantId), eq(commands.id, run.commandId))) : [undefined];
  let policyApplied: { id: string; version: number } | null = null;
  if (step.domainActionId) {
    const [action] = await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, step.domainActionId)));
    if (action?.policyId) {
      const [revision] = action.policyVersion
        ? await db.select({ policyId: domainPolicyRevisions.policyId, version: domainPolicyRevisions.version }).from(domainPolicyRevisions).where(and(
            eq(domainPolicyRevisions.tenantId, tenantId),
            eq(domainPolicyRevisions.policyId, action.policyId),
            eq(domainPolicyRevisions.version, action.policyVersion),
          )).limit(1)
        : [];
      if (revision) policyApplied = { id: revision.policyId, version: revision.version };
      else {
        const [policy] = await db.select().from(domainPolicies).where(and(
          eq(domainPolicies.tenantId, tenantId),
          eq(domainPolicies.id, action.policyId),
          eq(domainPolicies.active, true),
        ));
        if (policy) policyApplied = { id: policy.id, version: policy.version };
      }
    }
  }
  const [effect] = step.businessEffectId
    ? await db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, step.businessEffectId))).limit(1)
    : [undefined];
  await openReceiptTx(db, {
    tenantId,
    workflowRunId: step.workflowRunId,
    workflowStepId: step.id,
    objective: `${run?.workflowType ?? "workflow"}: ${step.stepType}`,
    evidence: [{ source: "workflow_step", ref: step.id, timestamp: new Date().toISOString() }],
    policyApplied,
    riskTier: "medium",
    proposedAction: effect ? effect.effect as Record<string, unknown> : { stepType: step.stepType, payload: step.payload },
    approval: { required: true, approvedBy: command?.requestedBy ?? undefined, at: command?.createdAt.toISOString() },
    correlationId: step.correlationId ?? undefined,
    domainActionId: step.domainActionId ?? undefined,
    businessEffectId: effect?.id,
    intendedEffectHash: effect?.semanticHash,
    authorizedEffectHash: effect?.semanticHash,
    expectedResult: effect ? ((effect.effect as { expected?: Record<string, unknown> }).expected ?? undefined) : undefined,
    workId: run?.workId ?? undefined,
  });
}

/** Atomic claim — mirrors runAction()'s UPDATE...WHERE status=<expected> pattern.
 *  Returns null if the step is already leased/completed (duplicate job delivery safe). */
export async function claimStep(tenantId: string, stepId: string, requestedGeneration = 0): Promise<WorkflowStepRow | null> {
  await resolveTenantVertical(tenantId);
  maybeChaosKill("pre_commit");
  const claimed = await withTenant(tenantId, async (db) => {
    const [candidate] = await db.select({ stepType: workflowSteps.stepType, workflowRunId: workflowSteps.workflowRunId }).from(workflowSteps).where(and(
      eq(workflowSteps.id, stepId),
      eq(workflowSteps.tenantId, tenantId),
    )).limit(1);
    if (candidate) await assertActiveStepTx(db, tenantId, candidate);
    const [claimed] = await db
      .update(workflowSteps)
      .set({
        status: "leased",
        executionState: "claimed",
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + leaseSeconds() * 1000),
        attempts: sql`${workflowSteps.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowSteps.id, stepId),
          eq(workflowSteps.tenantId, tenantId),
          eq(workflowSteps.status, "pending"),
          eq(workflowSteps.dispatchGeneration, requestedGeneration),
          // §2.7: a paused/cancelled/escalated run must genuinely stop making progress,
          // not just display a different status label — this is the actual enforcement
          // point, checked atomically in the same UPDATE as the claim itself.
          sql`${workflowSteps.workflowRunId} NOT IN (SELECT id FROM ${workflowRuns} WHERE status IN ('paused', 'cancelled', 'escalated'))`,
        ),
      )
      .returning();
    if (claimed) await openReceiptForClaimTx(db, tenantId, claimed);
    return claimed ?? null;
  });
  return claimed;
}

/** §5.3: a plugin execution may report the real sources it relied on — hybridRetrieve's
 *  structured facts + semantic hits, for an answer action — under `output.citations`.
 *  Pulled out here so any completed step's real evidence (not just answer actions)
 *  overwrites the open-time placeholder when present. */
function extractCitations(actualResult: Record<string, unknown>): ReceiptEvidence[] | undefined {
  const output = (actualResult.output ?? actualResult) as Record<string, unknown> | undefined;
  const citations = output?.citations;
  return Array.isArray(citations) && citations.length > 0 ? (citations as ReceiptEvidence[]) : undefined;
}

async function finalizeReceiptForStepTx(db: Db, tenantId: string, stepId: string, result: { actualResult: Record<string, unknown> } | { errorKind: import("@finnor/shared-types").ErrorKind; message: string; recoveryPath: string }): Promise<void> {
  const receipt = await findReceiptByStepTx(db, stepId);
  if (!receipt) throw new Error(`Workflow step ${stepId} has no DecisionReceipt`);
  await finalizeReceiptTx(
    db,
    tenantId,
    receipt.id,
    "actualResult" in result
      ? { actualResult: result.actualResult, evidence: extractCitations(result.actualResult) }
      : { failure: { errorKind: result.errorKind, message: result.message, recoveryPath: result.recoveryPath } },
  );
}

/** §5.2: auto-ingest into semantic memory — every completed step becomes real, cited
 *  memory the moment its receipt is finalized. Uses the already-fetched receipt fields
 *  rather than re-querying (findReceiptByStep just ran inside finalizeReceiptForStep's
 *  caller) — see memory-ingest.ts, shared with scripts/backfill-embeddings.ts so the
 *  live path and the historical backfill can never render a chunk differently. */
async function ingestStepReceipt(tenantId: string, stepId: string, evidence: Record<string, unknown>): Promise<void> {
  const receipt = await findReceiptByStep(tenantId, stepId);
  if (!receipt) return; // no receipt to cite — nothing honest to ingest
  await ingestReceipt(tenantId, { ...receipt, actualResult: evidence, finalizedAt: new Date() });
}

export async function completeStep(tenantId: string, stepId: string, evidence: Record<string, unknown>): Promise<void> {
  const completed = await withTenant(tenantId, async (db) => {
    const [row] = await db
      .update(workflowSteps)
      .set({ status: "completed", executionState: "verified", evidence, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(
        eq(workflowSteps.tenantId, tenantId),
        eq(workflowSteps.id, stepId),
        inArray(workflowSteps.status, ["leased", "waiting_observation"]),
      ))
      .returning({ id: workflowSteps.id });
    if (!row) return null;
    await finalizeReceiptForStepTx(db, tenantId, stepId, { actualResult: evidence });
    return row;
  });
  if (!completed) return;
  await ingestStepReceipt(tenantId, stepId, evidence).catch((err) =>
    console.error(`[memory] auto-ingest failed for step ${stepId}`, err),
  );
}

/** Provider acknowledgement has crossed the local commit boundary but is not final
 * remote/business truth. Park the durable step without finalizing its receipt or
 * advancing the run; an authenticated provider event or bounded read-back settles it. */
export async function awaitStepObservation(tenantId: string, stepId: string, evidence: Record<string, unknown>): Promise<void> {
  await withTenant(tenantId, (db) => db.update(workflowSteps).set({
    status: "waiting_observation",
    executionState: "awaiting_observation",
    evidence,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.id, stepId),
    eq(workflowSteps.status, "leased"),
  )));
}

export async function failStep(
  tenantId: string,
  stepId: string,
  terminalReason: string,
  // failStep is this step's terminal outcome for the current attempt — nothing resets
  // a 'failed' step back to pending except recoverStaleSteps' own stale-lease branch,
  // so "terminal" (not "retryable") is the right default: it accurately reflects THIS
  // attempt's finality, not whether the workflow as a whole might still recover. Callers
  // with a more specific classification (e.g. the §2.5 runtime bridge distinguishing a
  // plugin's "integration_unavailable" from a plain failure) may pass it explicitly.
  errorKind: import("@finnor/shared-types").ErrorKind = "terminal",
): Promise<void> {
  const failed = await withTenant(tenantId, async (db) => {
    const [row] = await db
      .update(workflowSteps)
      .set({ status: "failed", terminalReason, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(
        eq(workflowSteps.tenantId, tenantId),
        eq(workflowSteps.id, stepId),
        or(
          inArray(workflowSteps.status, ["leased", "waiting_observation"]),
          and(eq(workflowSteps.status, "failed"), eq(workflowSteps.executionState, "blocked")),
        ),
      ))
      .returning({ id: workflowSteps.id });
    if (!row) return null;
    await finalizeReceiptForStepTx(db, tenantId, stepId, { errorKind, message: terminalReason, recoveryPath: "review via GET /api/workflows/runs and retry or escalate the run" });
    if (errorKind === "terminal") {
      const [step] = await db
        .select({ domainActionId: workflowSteps.domainActionId, workId: workflowRuns.workId })
        .from(workflowSteps)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.workflowRunId))
        .where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowRuns.tenantId, tenantId), eq(workflowSteps.id, stepId)));
      if (step?.workId) {
        await transitionWorkTx(db, tenantId, step.workId, "recovery", "workflow_step_failed", {
          workflowStepId: stepId,
          domainActionId: step.domainActionId,
          errorKind,
          message: terminalReason,
        }, { recovery: { status: "queued", workflowStepId: stepId, domainActionId: step.domainActionId } });
      }
      if (step?.domainActionId) {
        await db.insert(jobs).values({
          type: "repair_plan_after_terminal_failure",
          payload: { tenantId, domainActionId: step.domainActionId, workflowStepId: stepId },
          idempotencyKey: `plan-repair:${step.domainActionId}`,
          lane: "batch",
          priority: 0,
        }).onConflictDoNothing({ target: jobs.idempotencyKey });
      }
    }
    return row;
  });
  if (!failed) return;
}

/** Enqueues the next pending step in sequence, or marks the workflow_run (and its
 *  parent command) completed once every step has finished. Before enqueueing, merges
 *  every already-completed step's evidence into the next step's payload under
 *  `context.<stepType>` — a later step can reference an earlier step's output without
 *  the caller having known it in advance at submitCommand() time. */
export async function advanceWorkflow(tenantId: string, workflowRunId: string): Promise<void> {
  await resolveTenantVertical(tenantId);
  maybeChaosKill("mid_multi_step");
  const [activeRun] = await withTenant(tenantId, (db) => db.select({ workflowType: workflowRuns.workflowType }).from(workflowRuns).where(and(
    eq(workflowRuns.tenantId, tenantId),
    eq(workflowRuns.id, workflowRunId),
  )).limit(1));
  if (activeRun && isRetiredWaterWorkflow(activeRun.workflowType)) throw new RetiredVerticalError("water");
  const allSteps = await withTenant(tenantId, (db) =>
    db.select().from(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.workflowRunId, workflowRunId))).orderBy(workflowSteps.sequence),
  );
  const next = allSteps.find((s) => s.status === "pending");
  if (next) {
    const context: Record<string, unknown> = {};
    for (const s of allSteps) {
      if (s.status === "completed" && s.evidence) {
        const evidence = s.evidence as Record<string, unknown>;
        context[s.stepType] = "output" in evidence ? evidence.output : evidence;
      }
    }
    await withTenant(tenantId, (db) =>
      db.update(workflowSteps).set({ payload: { ...(next.payload as Record<string, unknown>), context } }).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, next.id))),
    );
    await enqueueStep(tenantId, next.id, next.idempotencyKey);
    return;
  }

  const steps = allSteps;
  const allCompleted = steps.length > 0 && steps.every((s) => s.status === "completed");
  const anyFailed = steps.some((s) => s.status === "failed");
  const finalStatus = allCompleted ? "completed" : anyFailed ? "failed" : "running";
  if (finalStatus === "running") return; // still has leased/compensating steps in flight

  // §2.7: only transition a run that's actually still 'running' — a paused/cancelled/
  // escalated run must never be silently flipped to completed/failed by a step that
  // was already in flight when the control action landed.
  const [run] = await withTenant(tenantId, (db) =>
    db
      .update(workflowRuns)
      .set({ status: finalStatus, version: sql`${workflowRuns.version} + 1`, updatedAt: new Date() })
      .where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, "running")))
      .returning(),
  );
  if (run) {
    await withTenant(tenantId, (db) =>
      db.update(commands).set({ status: finalStatus, updatedAt: new Date() }).where(and(eq(commands.tenantId, tenantId), eq(commands.id, run.commandId))),
    );
    const effectIds = [...new Set(steps.map((step) => step.businessEffectId).filter((id): id is string => Boolean(id)))];
    // A single_action run is only the durable dispatch envelope. Its worker records
    // the real plugin observation, or deliberately leaves the effect executing while
    // a child workflow/computer run owns observation. Never turn "queued child" into
    // a fabricated verified business outcome here.
    if (effectIds.length > 0 && run.workflowType !== "single_action") {
      const checkedAt = new Date();
      const uncertain = steps.some((step) => ["reconciling", "failed_after_possible_effect", "cancellation_requested"].includes(step.executionState));
      const verification = {
        state: allCompleted ? "verified" : uncertain ? "reconciliation_required" : "unverified",
        basis: allCompleted
          ? "Every durable workflow step completed with a recorded result."
          : uncertain
            ? "A workflow step may have crossed its effect commit point without a conclusive observation."
            : "At least one durable workflow step failed before a successful observed outcome.",
        checkedAt: checkedAt.toISOString(),
        observed: {
          workflowRunId,
          steps: steps.map((step) => ({ id: step.id, type: step.stepType, status: step.status })),
        },
      } as const;
      await withTenant(tenantId, async (db) => {
        const effects = await db
          .select({ id: businessEffects.id, semanticHash: businessEffects.semanticHash })
          .from(businessEffects)
          .where(and(eq(businessEffects.tenantId, tenantId), inArray(businessEffects.id, effectIds)));
        for (const effect of effects) {
          await db
            .update(businessEffects)
            .set({
              status: allCompleted ? "verified" : uncertain ? "reconciliation_required" : "failed",
              observedResult: verification.observed,
              verification,
              observedAt: checkedAt,
            })
            .where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, effect.id)));
          await db
            .update(decisionReceipts)
            .set({ executedEffectHash: effect.semanticHash, verification })
            .where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.businessEffectId, effect.id)));
        }
      });
      const actionIds = [...new Set(steps.map((step) => step.domainActionId).filter((id): id is string => Boolean(id)))];
      if (actionIds.length > 0) {
        await withTenant(tenantId, (db) => db.update(domainActions).set({
          status: allCompleted ? "completed" : uncertain ? "needs_human_review" : "failed",
          executionStartedAt: null,
        }).where(and(eq(domainActions.tenantId, tenantId), inArray(domainActions.id, actionIds), eq(domainActions.status, "executing"))));
      }
    }
    if (run.workId) await reconcileWorkStatus(tenantId, run.workId);
  }
}

/**
 * Reclaims steps whose lease has expired — called at the top of the run_workflow_step
 * job handler, exactly like recoverExpiredRunningJobs() in apps/worker/src/queue.ts.
 * The matching integration_operations row is the source of truth for what to do:
 *  - no claim row yet:  nothing external happened — safe to reset and re-enqueue.
 *  - status 'succeeded': the real effect happened, only the bookkeeping write was lost —
 *    mark the step completed and resume (exactly-once, resumed correctly).
 *  - status 'running':  crashed mid-call, delivery unknown — NEVER blindly retry; open
 *    a reconciliation_case instead (the blueprint's own rule).
 *  - status 'failed':   a failed attempt delivered nothing — safe to reset and retry.
 */
export async function recoverStaleSteps(tenantId: string): Promise<{ recovered: number; reconciled: number }> {
  await resolveTenantVertical(tenantId);
  const stale = await withTenant(tenantId, (db) =>
    db
      .select()
      .from(workflowSteps)
      .where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.status, "leased"), lt(workflowSteps.leaseExpiresAt, new Date()))),
  );

  let recovered = 0;
  let reconciled = 0;

  for (const step of stale) {
    const [claimRow] = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(integrationOperations)
        .where(and(eq(integrationOperations.tenantId, tenantId), eq(integrationOperations.workflowStepId, step.id)))
        .orderBy(desc(integrationOperations.createdAt))
        .limit(1),
    );

    if (!claimRow) {
      await withTenant(tenantId, (db) => redriveStepTx(db, tenantId, step.id));
      recovered++;
      continue;
    }

    if (claimRow.status === "succeeded") {
      await completeStep(tenantId, step.id, { operationKey: claimRow.operationKey, resumedFromRecovery: true });
      await advanceWorkflow(tenantId, step.workflowRunId);
      recovered++;
      continue;
    }

    if (claimRow.status === "running" || claimRow.status === "unknown") {
      // Idempotent: recoverStaleSteps() can legitimately be called many times while a
      // step sits stuck (every job-queue poll, every retry loop iteration) — a stale
      // leased step with no lease bump must only ever open ONE open reconciliation_case,
      // never one per call.
      const [existingCase] = await withTenant(tenantId, (db) =>
        db
          .select()
          .from(reconciliationCases)
          .where(and(eq(reconciliationCases.tenantId, tenantId), eq(reconciliationCases.relatedStepId, step.id), eq(reconciliationCases.status, "open"))),
      );
      if (!existingCase) {
        await openReconciliationCase(tenantId, {
          caseType: "unknown_delivery",
          relatedStepId: step.id,
          businessEffectId: step.businessEffectId ?? undefined,
          details: { operationKey: claimRow.operationKey, capability: claimRow.capability },
        });
        reconciled++;
      }
      await withTenant(tenantId, async (db) => {
        if (claimRow.status === "running") {
          await db.update(integrationOperations).set({ status: "unknown", updatedAt: new Date() })
            .where(and(eq(integrationOperations.id, claimRow.id), eq(integrationOperations.status, "running")));
        }
        await db.update(workflowSteps).set({ executionState: "reconciling", leaseExpiresAt: null, updatedAt: new Date() })
          .where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, step.id)));
        if (step.businessEffectId) {
          await db.update(businessEffects).set({ status: "reconciliation_required" })
            .where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, step.businessEffectId), eq(businessEffects.status, "executing")));
        }
        if (step.domainActionId) {
          await db.update(domainActions).set({ status: "needs_human_review", executionStartedAt: null })
            .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, step.domainActionId), eq(domainActions.status, "executing")));
        }
      });
      continue;
    }

    // A known failed attempt did not deliver an effect and is safe to retry.
    await withTenant(tenantId, (db) => redriveStepTx(db, tenantId, step.id));
    recovered++;
  }

  return { recovered, reconciled };
}
