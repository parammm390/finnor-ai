// Dead-letter queue operations (§2.3): replay/discard. Kept out of the API route files
// so the route stays a thin auth+params wrapper, matching this repo's convention
// (packages/orchestration's decide() playing the same role for actions/:id/confirm).

import { withTenant, deadLetters, outboxEvents, resolveTenantVertical, workflowRuns, workflowSteps } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { isRetiredWaterAction, isRetiredWaterWorkflow, RetiredVerticalError } from "@finnor/shared-types";

export type ReplayResult =
  // Replaying an outbox event does not create a second workflow run: it reuses the
  // original idempotency key. Return that original run when there is one so the UI
  // can take an owner straight back to the affected theater without implying a new
  // run was created.
  | { replayed: true; workflowRunId: string | null }
  | { replayed: false; reason: "not_found" | "not_open" | "not_replayable" | "no_linked_outbox_event" };

/** Re-enqueues the dead letter's linked outbox event by resetting it to `pending` —
 *  the event row's own id is the idempotency key relayOutboxEvents() already passes to
 *  the deliverer (see outbox.ts), so this genuinely replays with the SAME key, not a
 *  new one, satisfying the "replay re-enqueues with the same idempotency key" rule
 *  without needing a second identifier anywhere. */
export async function replayDeadLetter(tenantId: string, deadLetterId: string): Promise<ReplayResult> {
  await resolveTenantVertical(tenantId);
  return withTenant(tenantId, async (db) => {
    const [row] = await db.select().from(deadLetters).where(and(eq(deadLetters.id, deadLetterId), eq(deadLetters.tenantId, tenantId)));
    if (!row) return { replayed: false, reason: "not_found" };
    if (row.status !== "open") return { replayed: false, reason: "not_open" };
    if (!row.replayable) return { replayed: false, reason: "not_replayable" };
    if (!row.relatedOutboxEventId) return { replayed: false, reason: "no_linked_outbox_event" };

    const [outbox] = await db
      .select({ workflowStepId: outboxEvents.workflowStepId })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, row.relatedOutboxEventId));
    const stepId = row.relatedWorkflowStepId ?? outbox?.workflowStepId;
    const [step] = stepId
      ? await db.select({
          workflowRunId: workflowSteps.workflowRunId,
          stepType: workflowSteps.stepType,
          workflowType: workflowRuns.workflowType,
        }).from(workflowSteps)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.workflowRunId))
          .where(and(eq(workflowSteps.id, stepId), eq(workflowSteps.tenantId, tenantId), eq(workflowRuns.tenantId, tenantId)))
      : [];
    if (step && (isRetiredWaterAction(step.stepType) || isRetiredWaterWorkflow(step.workflowType))) {
      throw new RetiredVerticalError("water");
    }

    await db
      .update(outboxEvents)
      .set({ status: "pending", nextAttemptAt: null, lastErrorKind: null })
      .where(eq(outboxEvents.id, row.relatedOutboxEventId));
    await db.update(deadLetters).set({ status: "replayed", resolvedAt: new Date() }).where(eq(deadLetters.id, deadLetterId));
    return { replayed: true, workflowRunId: step?.workflowRunId ?? null };
  });
}

export type DiscardResult = { discarded: true } | { discarded: false; reason: "not_found" | "not_open" };

export async function discardDeadLetter(tenantId: string, deadLetterId: string): Promise<DiscardResult> {
  return withTenant(tenantId, async (db) => {
    const [row] = await db.select().from(deadLetters).where(and(eq(deadLetters.id, deadLetterId), eq(deadLetters.tenantId, tenantId)));
    if (!row) return { discarded: false, reason: "not_found" };
    if (row.status !== "open") return { discarded: false, reason: "not_open" };
    await db.update(deadLetters).set({ status: "discarded", resolvedAt: new Date() }).where(eq(deadLetters.id, deadLetterId));
    return { discarded: true };
  });
}
