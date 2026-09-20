// Governed dead-letter replay/discard. These controls are tenant-scoped,
// Authority-backed, optimistic-versioned, and append-only audited. Replay never
// manufactures a new semantic effect and never bypasses unknown-outcome safety.

import {
  deadLetters,
  outboxEvents,
  resolveTenantVertical,
  runtimeSubstrateRetirements,
  withTenant,
  workflowRuns,
  workflowSteps,
} from "@finnor/db";
import { and, eq, sql } from "drizzle-orm";
import { isRetiredWaterAction, isRetiredWaterWorkflow, RetiredVerticalError } from "@finnor/shared-types";
import { recordRuntimeOperatorControlTx, type RuntimeOperatorControlRequest } from "./operator-controls";
import { redriveStepTx } from "./steps";

export type DeadLetterControlRequest = RuntimeOperatorControlRequest;

export type ReplayResult =
  | { replayed: true; workflowRunId: string | null; version: number }
  | { replayed: false; reason: "not_found" | "not_open" | "not_replayable" | "version_conflict" | "no_replay_target" | "substrate_retired" | "reconciliation_required" };

function controlEvidence(row: typeof deadLetters.$inferSelect | null, reasonCode: string) {
  return {
    reasonCode,
    errorKind: row?.errorKind ?? null,
    attempts: row?.attempts ?? null,
    replayable: row?.replayable ?? null,
    relatedOutboxEventId: row?.relatedOutboxEventId ?? null,
    relatedWorkflowStepId: row?.relatedWorkflowStepId ?? null,
  };
}

export async function replayDeadLetter(
  tenantId: string,
  deadLetterId: string,
  control: DeadLetterControlRequest,
): Promise<ReplayResult> {
  await resolveTenantVertical(tenantId);
  return withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${deadLetters}
      WHERE ${deadLetters.tenantId}=${tenantId} AND ${deadLetters.id}=${deadLetterId}::uuid FOR UPDATE`);
    const [row] = await db.select().from(deadLetters).where(and(
      eq(deadLetters.id, deadLetterId),
      eq(deadLetters.tenantId, tenantId),
    )).limit(1);
    const audit = async (
      outcome: "applied" | "conflict" | "rejected" | "blocked",
      reasonCode: string,
      observedFence?: number | null,
    ) => recordRuntimeOperatorControlTx(db, tenantId, {
      controlType: "dlq_replay",
      targetType: "dead_letter",
      targetId: deadLetterId,
      expectedVersion: control.expectedVersion,
      observedFence,
      actorId: control.actorId,
      authorityDecisionId: control.authorityDecisionId,
      reason: control.reason,
      evidence: controlEvidence(row ?? null, reasonCode),
      outcome,
      controlKey: control.controlKey,
    });

    if (!row) {
      await audit("rejected", "not_found");
      return { replayed: false, reason: "not_found" };
    }
    if (row.version !== control.expectedVersion) {
      await audit("conflict", "version_conflict");
      return { replayed: false, reason: "version_conflict" };
    }
    if (row.status !== "open") {
      await audit("rejected", "not_open");
      return { replayed: false, reason: "not_open" };
    }
    if (!row.replayable || ["auth", "validation", "terminal", "config", "unknown_outcome"].includes(row.errorKind)) {
      await audit("blocked", row.errorKind === "unknown_outcome" ? "reconciliation_required" : "not_replayable");
      return { replayed: false, reason: row.errorKind === "unknown_outcome" ? "reconciliation_required" : "not_replayable" };
    }

    if (row.relatedOutboxEventId) {
      const [retirement] = await db.select({ substrate: runtimeSubstrateRetirements.substrate })
        .from(runtimeSubstrateRetirements)
        .where(eq(runtimeSubstrateRetirements.substrate, "outbox"))
        .limit(1);
      if (retirement) {
        // Migration 0137 only retires after proving there are no unresolved outbox
        // obligations. A later replay may not resurrect the fake relay substrate.
        await audit("blocked", "substrate_retired");
        return { replayed: false, reason: "substrate_retired" };
      }
      const [outbox] = await db.select({ workflowStepId: outboxEvents.workflowStepId }).from(outboxEvents).where(and(
        eq(outboxEvents.tenantId, tenantId),
        eq(outboxEvents.id, row.relatedOutboxEventId),
      )).limit(1);
      if (!outbox) {
        await audit("rejected", "no_replay_target");
        return { replayed: false, reason: "no_replay_target" };
      }
      // This compatibility branch exists only for a pre-retirement deployment. It
      // keeps the original event identity; no new logical effect is created.
      await db.update(outboxEvents).set({
        status: "pending",
        nextAttemptAt: null,
        lastErrorKind: null,
      }).where(and(
        eq(outboxEvents.tenantId, tenantId),
        eq(outboxEvents.id, row.relatedOutboxEventId),
      ));
      const [updated] = await db.update(deadLetters).set({
        status: "replayed",
        resolvedAt: new Date(),
        version: sql`${deadLetters.version} + 1`,
      }).where(and(
        eq(deadLetters.tenantId, tenantId),
        eq(deadLetters.id, row.id),
        eq(deadLetters.status, "open"),
        eq(deadLetters.version, control.expectedVersion),
      )).returning({ version: deadLetters.version });
      if (!updated) throw new Error("Dead-letter replay lost its version fence");
      await audit("applied", "same_outbox_identity_requeued");
      return { replayed: true, workflowRunId: null, version: updated.version };
    }

    if (!row.relatedWorkflowStepId) {
      await audit("rejected", "no_replay_target");
      return { replayed: false, reason: "no_replay_target" };
    }
    const [step] = await db.select({
      id: workflowSteps.id,
      status: workflowSteps.status,
      executionState: workflowSteps.executionState,
      effectCommitAt: workflowSteps.effectCommitAt,
      dispatchGeneration: workflowSteps.dispatchGeneration,
      claimFence: workflowSteps.claimFence,
      workflowRunId: workflowSteps.workflowRunId,
      stepType: workflowSteps.stepType,
      workflowType: workflowRuns.workflowType,
    }).from(workflowSteps).innerJoin(workflowRuns, and(
      eq(workflowRuns.tenantId, tenantId),
      eq(workflowRuns.id, workflowSteps.workflowRunId),
    )).where(and(
      eq(workflowSteps.tenantId, tenantId),
      eq(workflowSteps.id, row.relatedWorkflowStepId),
    )).limit(1);
    if (!step) {
      await audit("rejected", "no_replay_target");
      return { replayed: false, reason: "no_replay_target" };
    }
    if (isRetiredWaterAction(step.stepType) || isRetiredWaterWorkflow(step.workflowType)) throw new RetiredVerticalError("water");
    const definitelyBeforeEffect = !step.effectCommitAt
      && ["authorized", "failed_before_effect", "claimed", "blocked"].includes(step.executionState);
    if (!definitelyBeforeEffect) {
      await audit("blocked", "reconciliation_required", step.claimFence);
      return { replayed: false, reason: "reconciliation_required" };
    }
    const redriven = await redriveStepTx(db, tenantId, step.id, {
      actorId: control.actorId,
      authorityDecisionId: control.authorityDecisionId,
      expectedVersion: step.dispatchGeneration,
      reason: `DLQ replay: ${control.reason}`,
      controlKey: control.controlKey ? `${control.controlKey}:step` : undefined,
    });
    if (!redriven) throw new Error("Dead-letter replay could not redrive the fenced workflow step");
    const [updated] = await db.update(deadLetters).set({
      status: "replayed",
      resolvedAt: new Date(),
      version: sql`${deadLetters.version} + 1`,
    }).where(and(
      eq(deadLetters.tenantId, tenantId),
      eq(deadLetters.id, row.id),
      eq(deadLetters.status, "open"),
      eq(deadLetters.version, control.expectedVersion),
    )).returning({ version: deadLetters.version });
    if (!updated) throw new Error("Dead-letter replay lost its version fence");
    await audit("applied", "pre_effect_step_redriven", step.claimFence);
    return { replayed: true, workflowRunId: step.workflowRunId, version: updated.version };
  });
}

export type DiscardResult =
  | { discarded: true; version: number }
  | { discarded: false; reason: "not_found" | "not_open" | "version_conflict" };

export async function discardDeadLetter(
  tenantId: string,
  deadLetterId: string,
  control: DeadLetterControlRequest,
): Promise<DiscardResult> {
  return withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${deadLetters}
      WHERE ${deadLetters.tenantId}=${tenantId} AND ${deadLetters.id}=${deadLetterId}::uuid FOR UPDATE`);
    const [row] = await db.select().from(deadLetters).where(and(
      eq(deadLetters.id, deadLetterId),
      eq(deadLetters.tenantId, tenantId),
    )).limit(1);
    const audit = (outcome: "applied" | "conflict" | "rejected", reasonCode: string) => recordRuntimeOperatorControlTx(db, tenantId, {
      controlType: "dlq_discard",
      targetType: "dead_letter",
      targetId: deadLetterId,
      expectedVersion: control.expectedVersion,
      actorId: control.actorId,
      authorityDecisionId: control.authorityDecisionId,
      reason: control.reason,
      evidence: controlEvidence(row ?? null, reasonCode),
      outcome,
      controlKey: control.controlKey,
    });
    if (!row) {
      await audit("rejected", "not_found");
      return { discarded: false, reason: "not_found" };
    }
    if (row.version !== control.expectedVersion) {
      await audit("conflict", "version_conflict");
      return { discarded: false, reason: "version_conflict" };
    }
    if (row.status !== "open") {
      await audit("rejected", "not_open");
      return { discarded: false, reason: "not_open" };
    }
    const [updated] = await db.update(deadLetters).set({
      status: "discarded",
      resolvedAt: new Date(),
      version: sql`${deadLetters.version} + 1`,
    }).where(and(
      eq(deadLetters.tenantId, tenantId),
      eq(deadLetters.id, row.id),
      eq(deadLetters.status, "open"),
      eq(deadLetters.version, control.expectedVersion),
    )).returning({ version: deadLetters.version });
    if (!updated) throw new Error("Dead-letter discard lost its version fence");
    await audit("applied", "discarded_without_deleting_history");
    return { discarded: true, version: updated.version };
  });
}
