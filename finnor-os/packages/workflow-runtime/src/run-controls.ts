// Phase 2 (§2.7): run controls — pause/resume/cancel/retry/escalate. Each is a guarded
// state transition: an atomic UPDATE conditioned on both the expected `version`
// (optimistic concurrency — two concurrent control calls can't both believe they made
// the transition) and the allowed FROM status (an illegal transition, e.g. pausing an
// already-completed run, is rejected, never silently accepted). Every call opens its
// own DecisionReceipt (workflowStepId null — this is a run-level action, not a step
// execution) so "who paused this and when" is answerable the same way any other
// consequential action in this system is.

import { actionLog, businessEffects, commands, domainActions, reconciliationCases, withTenant, workflowRuns, workflowSteps, reconcileWorkStatus, resolveTenantVertical } from "@finnor/db";
import type { Db } from "@finnor/db";
import { and, eq, sql, inArray } from "drizzle-orm";
import { redriveNextPendingStepTx } from "./steps";
import { openReceiptTx, finalizeReceiptTx } from "./receipts";
import { isRetiredWaterWorkflow, RetiredVerticalError } from "@finnor/shared-types";

export type RunControlVerb = "pause" | "resume" | "cancel" | "retry" | "escalate";

export type RunControlFailureReason = "not_found" | "version_conflict" | "illegal_transition";
export type RunControlResult =
  | { ok: true; run: typeof workflowRuns.$inferSelect }
  | { ok: false; reason: RunControlFailureReason };

type WorkflowRunStatus = (typeof workflowRuns.$inferSelect)["status"];

interface TransitionSpec {
  verb: RunControlVerb;
  fromStatuses: WorkflowRunStatus[];
  toStatus: WorkflowRunStatus;
}

const TRANSITIONS: Record<RunControlVerb, TransitionSpec> = {
  pause: { verb: "pause", fromStatuses: ["running"], toStatus: "paused" },
  resume: { verb: "resume", fromStatuses: ["paused"], toStatus: "running" },
  cancel: { verb: "cancel", fromStatuses: ["running", "paused"], toStatus: "cancelled" },
  retry: { verb: "retry", fromStatuses: ["failed"], toStatus: "running" },
  escalate: { verb: "escalate", fromStatuses: ["running", "failed"], toStatus: "escalated" },
};

async function assertActiveRun(tenantId: string, runId: string): Promise<void> {
  await resolveTenantVertical(tenantId);
  const [run] = await withTenant(tenantId, (db) => db.select({ workflowType: workflowRuns.workflowType }).from(workflowRuns).where(and(
    eq(workflowRuns.tenantId, tenantId),
    eq(workflowRuns.id, runId),
  )).limit(1));
  if (run && isRetiredWaterWorkflow(run.workflowType)) throw new RetiredVerticalError("water");
}

async function recordRunControlReceiptTx(
  db: Db,
  tenantId: string,
  run: typeof workflowRuns.$inferSelect,
  requestedBy: string,
  objective: string,
  proposedAction: Record<string, unknown>,
): Promise<void> {
  const { receiptId } = await openReceiptTx(db, {
    tenantId,
    workId: run.workId ?? undefined,
    workflowRunId: run.id,
    objective,
    evidence: [{ source: "workflow_runs", ref: run.id, timestamp: new Date().toISOString() }],
    policyApplied: null,
    riskTier: "medium",
    proposedAction,
    approval: { required: true, approvedBy: requestedBy, at: new Date().toISOString() },
    expectedResult: { status: run.status },
  });
  await finalizeReceiptTx(db, tenantId, receiptId, { actualResult: { status: run.status, version: run.version } });
}

async function applyTransition(
  tenantId: string,
  runId: string,
  expectedVersion: number,
  spec: TransitionSpec,
  requestedBy: string,
  afterTransition?: (db: Db, run: typeof workflowRuns.$inferSelect) => Promise<void>,
): Promise<RunControlResult> {
  await assertActiveRun(tenantId, runId);
  const updated = await withTenant(tenantId, async (db) => {
    const [row] = await db
      .update(workflowRuns)
      .set({ status: spec.toStatus, version: sql`${workflowRuns.version} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.tenantId, tenantId),
          eq(workflowRuns.version, expectedVersion),
          inArray(workflowRuns.status, spec.fromStatuses),
        ),
      )
      .returning();
    if (row && afterTransition) await afterTransition(db, row);
    if (row) await recordRunControlReceiptTx(
      db,
      tenantId,
      row,
      requestedBy,
      `${spec.verb} workflow run ${runId}`,
      { verb: spec.verb, fromStatuses: spec.fromStatuses, toStatus: spec.toStatus },
    );
    return row ?? null;
  });

  if (!updated) {
    // Distinguish WHY the conditional update matched nothing — not found, a stale
    // version (someone else already transitioned it), or a from-status this verb
    // simply doesn't allow (e.g. pausing an already-completed run).
    const [current] = await withTenant(tenantId, (db) => db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId))));
    if (!current) return { ok: false, reason: "not_found" };
    if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };
    return { ok: false, reason: "illegal_transition" };
  }

  if (updated.workId) await reconcileWorkStatus(tenantId, updated.workId);

  return { ok: true, run: updated };
}

export async function pauseRun(tenantId: string, runId: string, expectedVersion: number, requestedBy: string): Promise<RunControlResult> {
  return applyTransition(tenantId, runId, expectedVersion, TRANSITIONS.pause, requestedBy);
}

export async function resumeRun(tenantId: string, runId: string, expectedVersion: number, requestedBy: string): Promise<RunControlResult> {
  return applyTransition(tenantId, runId, expectedVersion, TRANSITIONS.resume, requestedBy, async (db) => {
    // The old delivery may already have completed as a no-op while the run was paused.
    // Advance the generation and insert its replacement atomically with the resume.
    await redriveNextPendingStepTx(db, tenantId, runId);
  });
}

export async function cancelRun(tenantId: string, runId: string, expectedVersion: number, requestedBy: string): Promise<RunControlResult> {
  await assertActiveRun(tenantId, runId);
  const updated = await withTenant(tenantId, async (db) => {
    const [run] = await db.update(workflowRuns).set({ status: "cancelled", version: sql`${workflowRuns.version} + 1`, updatedAt: new Date() })
      .where(and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.tenantId, tenantId),
        eq(workflowRuns.version, expectedVersion),
        inArray(workflowRuns.status, ["running", "paused"]),
      )).returning();
    if (!run) return null;
    const steps = await db.select().from(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.workflowRunId, runId)));
    const crossedCommitPoint = steps.some((step) => Boolean(step.effectCommitAt)
      || ["commit_started", "awaiting_observation", "reconciling", "verified", "failed_after_possible_effect", "cancellation_requested"].includes(step.executionState));
    const now = new Date();
    await db.update(commands).set({ status: "cancelled", cancellationRequestedAt: now, updatedAt: now })
      .where(and(eq(commands.tenantId, tenantId), eq(commands.id, run.commandId), inArray(commands.status, ["approved", "running"])));

    const active = steps.filter((step) => step.status === "pending" || step.status === "leased");
    const beforeEffectIds = active.filter((step) => !step.effectCommitAt && ["authorized", "claimed"].includes(step.executionState)).map((step) => step.id);
    if (beforeEffectIds.length > 0) {
      await db.update(workflowSteps).set({
        status: "failed",
        executionState: "cancelled_before_effect",
        cancellationRequestedAt: now,
        terminalReason: "Cancelled before the effect commit point",
        leaseExpiresAt: null,
        updatedAt: now,
      }).where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.id, beforeEffectIds)));
    }
    const afterPossibleIds = active.filter((step) => step.effectCommitAt || !["authorized", "claimed"].includes(step.executionState)).map((step) => step.id);
    if (afterPossibleIds.length > 0) {
      await db.update(workflowSteps).set({ executionState: "cancellation_requested", cancellationRequestedAt: now, updatedAt: now })
        .where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.id, afterPossibleIds)));
    }

    const effectIds = [...new Set(steps.map((step) => step.businessEffectId).filter((id): id is string => Boolean(id)))];
    const actionIds = [...new Set(steps.map((step) => step.domainActionId).filter((id): id is string => Boolean(id)))];
    if (effectIds.length > 0) {
      if (crossedCommitPoint) {
        await db.update(businessEffects).set({ status: "reconciliation_required" })
          .where(and(eq(businessEffects.tenantId, tenantId), inArray(businessEffects.id, effectIds), inArray(businessEffects.status, ["authorized", "executing", "failed", "partially_verified", "unverified"])));
        for (const effectId of effectIds) {
          const [existing] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(and(
            eq(reconciliationCases.tenantId, tenantId),
            eq(reconciliationCases.businessEffectId, effectId),
            eq(reconciliationCases.status, "open"),
          )).limit(1);
          if (!existing) await db.insert(reconciliationCases).values({ tenantId, businessEffectId: effectId, caseType: "unknown_delivery", details: { runId, reason: "cancellation_after_effect_commit_point" } });
        }
      } else {
        await db.update(businessEffects).set({ status: "cancelled" })
          .where(and(eq(businessEffects.tenantId, tenantId), inArray(businessEffects.id, effectIds), eq(businessEffects.status, "authorized")));
      }
    }
    if (actionIds.length > 0) {
      await db.update(domainActions).set({ status: crossedCommitPoint ? "needs_human_review" : "rejected", executionStartedAt: null })
        .where(and(eq(domainActions.tenantId, tenantId), inArray(domainActions.id, actionIds), eq(domainActions.status, "executing")));
      await db.insert(actionLog).values(actionIds.map((actionId) => ({
        tenantId,
        domainActionId: actionId,
        step: crossedCommitPoint ? "cancellation_requested" : "cancelled_before_effect",
        input: { requestedBy, workflowRunId: runId },
        output: { crossedEffectCommitPoint: crossedCommitPoint, reconciliationRequired: crossedCommitPoint },
      })));
    }
    await recordRunControlReceiptTx(
      db,
      tenantId,
      run,
      requestedBy,
      `cancel workflow run ${runId}`,
      { verb: "cancel", effectSemantics: "stop before commit; reconcile after possible effect" },
    );
    return run;
  });

  if (!updated) {
    const [current] = await withTenant(tenantId, (db) => db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId))));
    if (!current) return { ok: false, reason: "not_found" };
    if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };
    return { ok: false, reason: "illegal_transition" };
  }
  if (updated.workId) await reconcileWorkStatus(tenantId, updated.workId);
  return { ok: true, run: updated };
}

/** Retry only makes sense from 'failed' — and unlike the other verbs, actually has
 *  work to do beyond the status flip: the step that broke the chain is still sitting
 *  in 'failed' status (workflow_steps has no auto-reset), so retry resets it back to
 *  'pending' and re-drives the run via the same advanceWorkflow() every step
 *  completion already calls. Never resets a step that's genuinely still in flight
 *  ('leased') — only ones that terminally failed. */
export async function retryRun(tenantId: string, runId: string, expectedVersion: number, requestedBy: string): Promise<RunControlResult> {
  await assertActiveRun(tenantId, runId);
  const updated = await withTenant(tenantId, async (db) => {
    const steps = await db.select().from(workflowSteps).where(and(
      eq(workflowSteps.tenantId, tenantId),
      eq(workflowSteps.workflowRunId, runId),
    ));
    const failed = steps.filter((step) => step.status === "failed");
    // Retry is a local-processing/provider-redelivery operation only when the prior
    // result is known not to have produced an effect. Unknown delivery, divergence,
    // cancellation-after-commit, and authority/precondition blocks require explicit
    // reconciliation or a replacement EffectSet instead.
    const safelyRetryable = failed.length > 0 && failed.every((step) =>
      (["authorized", "failed_before_effect"].includes(step.executionState)
        || (step.executionState === "claimed" && !step.effectCommitAt))
      && !["reconciling", "failed_after_possible_effect", "cancellation_requested", "blocked"].includes(step.executionState),
    );
    if (!safelyRetryable) return null;
    const effectIds = [...new Set(failed.map((step) => step.businessEffectId).filter((id): id is string => Boolean(id)))];
    if (effectIds.length > 0) {
      const effects = await db.select({ status: businessEffects.status }).from(businessEffects).where(and(
        eq(businessEffects.tenantId, tenantId),
        inArray(businessEffects.id, effectIds),
      ));
      if (effects.length !== effectIds.length || effects.some((effect) => effect.status !== "failed")) return null;
    }
    const [run] = await db.update(workflowRuns).set({
      status: "running",
      version: sql`${workflowRuns.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(workflowRuns.id, runId),
      eq(workflowRuns.tenantId, tenantId),
      eq(workflowRuns.version, expectedVersion),
      eq(workflowRuns.status, "failed"),
    )).returning();
    if (!run) return null;
    await db.update(commands).set({ status: "running", cancellationRequestedAt: null, updatedAt: new Date() })
      .where(and(eq(commands.tenantId, tenantId), eq(commands.id, run.commandId), eq(commands.status, "failed")));
    await db.update(workflowSteps).set({
      status: "pending",
      executionState: "authorized",
      terminalReason: null,
      leaseExpiresAt: null,
      effectCommitAt: null,
      cancellationRequestedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.id, failed.map((step) => step.id))));
    const actionIds = [...new Set(failed.map((step) => step.domainActionId).filter((id): id is string => Boolean(id)))];
    if (actionIds.length > 0) {
      await db.update(domainActions).set({ status: "executing", executionStartedAt: new Date() })
        .where(and(
          eq(domainActions.tenantId, tenantId),
          inArray(domainActions.id, actionIds),
          inArray(domainActions.status, ["failed", "blocked_integration_unavailable"]),
        ));
      await db.insert(actionLog).values(actionIds.map((actionId) => ({
        tenantId,
        domainActionId: actionId,
        step: "execution_retry_authorized",
        input: { requestedBy, workflowRunId: runId, expectedVersion },
        output: { safeKnownFailure: true, effectIds },
      })));
    }
    await redriveNextPendingStepTx(db, tenantId, runId);
    await recordRunControlReceiptTx(
      db,
      tenantId,
      run,
      requestedBy,
      `retry workflow run ${runId}`,
      { verb: "retry", fromStatuses: ["failed"], toStatus: "running", safeKnownFailure: true },
    );
    return run;
  });

  if (!updated) {
    const [current] = await withTenant(tenantId, (db) => db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId))));
    if (!current) return { ok: false, reason: "not_found" };
    if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };
    return { ok: false, reason: "illegal_transition" };
  }
  if (updated.workId) await reconcileWorkStatus(tenantId, updated.workId);
  return { ok: true, run: updated };
}

export async function escalateRun(tenantId: string, runId: string, expectedVersion: number, requestedBy: string): Promise<RunControlResult> {
  await assertActiveRun(tenantId, runId);
  return applyTransition(tenantId, runId, expectedVersion, TRANSITIONS.escalate, requestedBy);
}
