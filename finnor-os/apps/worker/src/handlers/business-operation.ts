// Upgrade 6: durable customer win-back execution.
//
// The approval request only authorizes and queues the operation. This worker fans
// the frozen cohort into bounded jobs, re-checks consent/contact safety per target,
// and records truthful provider/native outcomes. It never runs a campaign as one
// request-time serial loop.

import {
  businessEvents,
  businessEffects,
  businessOperations,
  businessOperationEvents,
  businessOperationTargets,
  communicationsLog,
  decisionReceipts,
  domainActions,
  households,
  jobs,
  reconcileWorkStatus,
  works,
  withTenant,
  type Db,
} from "@finnor/db";
import {
  createDefaultRegistry,
  ScopedToolRegistry,
  reserveBudget,
  releaseBudget,
  DAILY_VAPI_CALL_CAP,
  resolveCapabilityBindingsForTenant,
  type ToolCallResult,
} from "@finnor/tools";
import { resolveCredentialContext } from "@finnor/security";
import type { BusinessEffectSet, ErrorKind, ExecutionResult } from "@finnor/shared-types";
import { nextCallingWindow } from "@finnor/plugin-bulk-notify";
import { revalidateActionExecution } from "@finnor/authority";
import { recordBusinessEffectOutcome, resumeObjectiveForAction } from "@finnor/orchestration";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

const SMS_DISPATCH_SIZE = 50;
const TARGET_LEASE_SECONDS = 45;

type OperationRow = typeof businessOperations.$inferSelect;
type TargetRow = typeof businessOperationTargets.$inferSelect;
type FailureClass = NonNullable<TargetRow["failureClass"]>;

let baseTools: ReturnType<typeof createDefaultRegistry> | null = null;
function tools() {
  baseTools ??= createDefaultRegistry();
  return baseTools;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validE164(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}

async function appendEventTx(db: Db, params: {
  tenantId: string;
  operationId: string;
  targetId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`SELECT id FROM ${businessOperations} WHERE ${businessOperations.id} = ${params.operationId} FOR UPDATE`);
  const [latest] = await db.select({ maxSequence: sql<number>`coalesce(max(${businessOperationEvents.sequence}), 0)::int` })
    .from(businessOperationEvents).where(eq(businessOperationEvents.operationId, params.operationId));
  await db.insert(businessOperationEvents).values({
    tenantId: params.tenantId,
    operationId: params.operationId,
    targetId: params.targetId ?? null,
    sequence: (latest?.maxSequence ?? 0) + 1,
    eventType: params.eventType,
    payload: params.payload ?? {},
  });
}

async function loadOperation(tenantId: string, operationId: string): Promise<OperationRow | null> {
  const [row] = await withTenant(tenantId, (db) => db.select().from(businessOperations)
    .where(and(eq(businessOperations.tenantId, tenantId), eq(businessOperations.id, operationId))).limit(1));
  return row ?? null;
}

async function actionAccessContext(tenantId: string, actionId: string): Promise<{
  actorId: string;
  purpose: string;
  communicationIdentityId?: string;
  authProfileRef?: string;
}> {
  const [action] = await withTenant(tenantId, (db) => db.select({
    initiatedBy: domainActions.initiatedBy,
    actionType: domainActions.actionType,
    payload: domainActions.payload,
  }).from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId))).limit(1));
  const draft = object(action?.payload);
  return {
    actorId: action?.initiatedBy ?? "system:business-operation",
    purpose: typeof draft.purpose === "string" ? draft.purpose : action?.actionType ?? "business_operation",
    ...(typeof draft.communicationIdentityId === "string" ? { communicationIdentityId: draft.communicationIdentityId } : {}),
    ...(typeof draft.authProfileRef === "string" ? { authProfileRef: draft.authProfileRef } : {}),
  };
}

async function operationAuthorityStillValid(operation: OperationRow): Promise<boolean> {
  const decision = await revalidateActionExecution(operation.tenantId, operation.domainActionId, "durable_operation", operation.id);
  if (decision.outcome === "allowed") {
    await withTenant(operation.tenantId, (db) => db.update(businessOperations).set({ authorityDecisionId: decision.id, authorityRevision: decision.authorityRevision, updatedAt: new Date() }).where(eq(businessOperations.id, operation.id)));
    return true;
  }
  await withTenant(operation.tenantId, async (db) => {
    await db.update(businessOperations).set({
      status: "needs_human_review",
      authorityDecisionId: decision.id,
      authorityRevision: decision.authorityRevision,
      failure: { errorKind: "auth", message: `Authority no longer permits this operation: ${decision.reasonCode}`, authorityDecisionId: decision.id },
      updatedAt: new Date(),
    }).where(eq(businessOperations.id, operation.id));
    await appendEventTx(db, { tenantId: operation.tenantId, operationId: operation.id, eventType: "authority_revalidation_failed", payload: { decisionId: decision.id, revision: decision.authorityRevision, reasonCode: decision.reasonCode } });
  });
  if (operation.workId) await reconcileWorkStatus(operation.tenantId, operation.workId);
  return false;
}

async function operationWorkStillActive(operation: OperationRow): Promise<boolean> {
  if (!operation.workId) return true;
  const result = await withTenant(operation.tenantId, async (db) => {
    // Match the effect/cancellation lock order: operation first, then parent Work.
    await db.execute(sql`SELECT id FROM ${businessOperations} WHERE ${businessOperations.id} = ${operation.id} AND ${businessOperations.tenantId} = ${operation.tenantId} FOR UPDATE`);
    await db.execute(sql`SELECT id FROM ${works} WHERE ${works.id} = ${operation.workId} AND ${works.tenantId} = ${operation.tenantId} FOR UPDATE`);
    const [work] = await db.select({ status: works.status }).from(works).where(and(
      eq(works.tenantId, operation.tenantId),
      eq(works.id, operation.workId!),
    )).limit(1);
    if (!work || (work.status !== "cancelled" && work.status !== "completed")) return { active: true as const };
    const [running] = await db.select({ count: sql<number>`count(*)::int` })
      .from(businessOperationTargets)
      .where(and(eq(businessOperationTargets.operationId, operation.id), eq(businessOperationTargets.status, "running")));
    const reconciliationRequired = (running?.count ?? 0) > 0;
    const [cancelled] = await db.update(businessOperations).set({
      status: "cancelled",
      completedAt: new Date(),
      finalOutcome: {
        kind: "cancelled",
        workStatus: work.status,
        reconciliationRequired,
        runningTargets: running?.count ?? 0,
      },
      updatedAt: new Date(),
    }).where(and(
      eq(businessOperations.tenantId, operation.tenantId),
      eq(businessOperations.id, operation.id),
      inArray(businessOperations.status, ["queued", "running"]),
    )).returning({ id: businessOperations.id });
    if (cancelled) {
      await db.update(domainActions).set({ status: "rejected", executionStartedAt: null }).where(and(
        eq(domainActions.tenantId, operation.tenantId),
        eq(domainActions.id, operation.domainActionId),
        inArray(domainActions.status, ["pending", "approved", "executing", "needs_human_review"]),
      ));
      await appendEventTx(db, {
        tenantId: operation.tenantId,
        operationId: operation.id,
        eventType: "operation_cancelled_by_work",
        payload: { workStatus: work.status, reconciliationRequired, runningTargets: running?.count ?? 0 },
      });
    }
    return { active: false as const };
  });
  if (!result.active) await reconcileWorkStatus(operation.tenantId, operation.workId);
  return result.active;
}

async function safetyCheck(tenantId: string, target: TargetRow): Promise<
  | { ok: true; phone: string }
  | { ok: false; status: "failed" | "skipped"; failureClass: FailureClass; errorKind: ErrorKind; message: string }
> {
  const [household] = await withTenant(tenantId, (db) => db.select({
    marketingConsent: households.marketingConsent,
    contactInfo: households.contactInfo,
  }).from(households).where(and(eq(households.tenantId, tenantId), eq(households.id, target.targetId))).limit(1));
  if (!household) return { ok: false, status: "failed", failureClass: "invalid_input", errorKind: "validation", message: "Approved household no longer exists." };
  if (!household.marketingConsent) return { ok: false, status: "skipped", failureClass: "policy", errorKind: "config", message: "Marketing consent is no longer active." };
  const frozenPhone = object(target.frozenSnapshot).phone;
  if (!validE164(frozenPhone)) return { ok: false, status: "failed", failureClass: "invalid_input", errorKind: "validation", message: "The approved target has no valid E.164 phone number." };
  const currentPhone = object(household.contactInfo).phone;
  if (currentPhone !== frozenPhone) {
    return { ok: false, status: "failed", failureClass: "human_review", errorKind: "needs_human", message: "The customer phone changed after the cohort was frozen; review is required before contacting the new destination." };
  }
  return { ok: true, phone: frozenPhone };
}

function failureFrom(result: ToolCallResult, attempts: number, maxAttempts: number): {
  status: "retry" | "failed";
  failureClass: FailureClass;
  errorKind: ErrorKind;
  retryAt?: Date;
} {
  const kind = result.errorKind ?? (result.integrationUnavailable ? "provider_down" : "terminal");
  if ((kind === "retryable" || kind === "provider_down") && attempts < maxAttempts) {
    return { status: "retry", failureClass: "retryable", errorKind: kind, retryAt: new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** attempts)) };
  }
  if (kind === "auth" || kind === "config") return { status: "failed", failureClass: "configuration", errorKind: kind };
  if (kind === "needs_human" || kind === "conflict") return { status: "failed", failureClass: "human_review", errorKind: kind };
  if (kind === "retryable" || kind === "provider_down") return { status: "failed", failureClass: "human_review", errorKind: "needs_human" };
  return { status: "failed", failureClass: "invalid_input", errorKind: kind };
}

async function claimTargetTx(db: Db, tenantId: string, operationId: string, targetId: string): Promise<TargetRow | null> {
  const now = new Date();
  const [row] = await db.update(businessOperationTargets).set({
    status: "running",
    attempts: sql`${businessOperationTargets.attempts} + 1`,
    startedAt: now,
    leaseExpiresAt: new Date(now.getTime() + TARGET_LEASE_SECONDS * 1_000),
    updatedAt: now,
  }).where(and(
    eq(businessOperationTargets.tenantId, tenantId),
    eq(businessOperationTargets.operationId, operationId),
    eq(businessOperationTargets.id, targetId),
    lte(businessOperationTargets.nextAttemptAt, now),
    or(
      inArray(businessOperationTargets.status, ["pending", "retry"]),
      and(eq(businessOperationTargets.status, "running"), lte(businessOperationTargets.leaseExpiresAt, now)),
    ),
  )).returning();
  return row ?? null;
}

/** Hold the parent operation row lock across the provider mutation. Cancellation
 * updates the same row, so either cancellation commits first and this returns
 * inactive without dispatching, or the already-started provider call finishes
 * before cancellation can truthfully commit. Do not also lock the parent Work
 * here: the provider adapters claim their external-operation row in a nested
 * tenant transaction, and the operational-delta FK must take a KEY SHARE lock
 * on Work while that transaction is open. Holding Work FOR UPDATE in this outer
 * transaction would self-deadlock that durable claim. */
async function withActiveOperationEffectFence<T>(
  tenantId: string,
  operationId: string,
  effect: (db: Db) => Promise<T>,
): Promise<{ active: true; value: T } | { active: false }> {
  return withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${businessOperations} WHERE ${businessOperations.tenantId}=${tenantId} AND ${businessOperations.id}=${operationId} FOR UPDATE`);
    const [operation] = await db.select({ status: businessOperations.status, workId: businessOperations.workId })
      .from(businessOperations)
      .where(and(eq(businessOperations.tenantId, tenantId), eq(businessOperations.id, operationId)))
      .limit(1);
    if (!operation || !["queued", "running"].includes(operation.status)) return { active: false as const };
    if (operation.workId) {
      const [work] = await db.select({ status: works.status }).from(works).where(and(
        eq(works.tenantId, tenantId),
        eq(works.id, operation.workId),
      )).limit(1);
      if (!work || work.status === "cancelled" || work.status === "completed") return { active: false as const };
    }
    return { active: true as const, value: await effect(db) };
  });
}

async function claimTarget(tenantId: string, operationId: string, targetId: string): Promise<TargetRow | null> {
  const fenced = await withActiveOperationEffectFence(tenantId, operationId, (db) => claimTargetTx(db, tenantId, operationId, targetId));
  return fenced.active ? fenced.value : null;
}

async function finishTarget(params: {
  tenantId: string;
  operation: OperationRow;
  target: TargetRow;
  status: "succeeded" | "failed" | "skipped" | "retry";
  failureClass?: FailureClass | null;
  errorKind?: ErrorKind | null;
  error?: string | null;
  retryAt?: Date;
  providerRef?: string | null;
  result?: Record<string, unknown>;
  evidence?: Array<Record<string, unknown>>;
  businessEventType?: string;
  communication?: { channel: string; content: string };
}): Promise<void> {
  const now = new Date();
  await withTenant(params.tenantId, async (db) => {
    const [updated] = await db.update(businessOperationTargets).set({
      status: params.status,
      failureClass: params.failureClass ?? null,
      errorKind: params.errorKind ?? null,
      lastError: params.error ?? null,
      nextAttemptAt: params.retryAt ?? now,
      leaseExpiresAt: null,
      jobKey: params.status === "retry" ? null : params.target.jobKey,
      providerRef: params.providerRef ?? null,
      result: params.result ?? null,
      evidence: params.evidence ?? [],
      completedAt: params.status === "retry" ? null : now,
      updatedAt: now,
    }).where(and(
      eq(businessOperationTargets.id, params.target.id),
      eq(businessOperationTargets.tenantId, params.tenantId),
      eq(businessOperationTargets.status, "running"),
    )).returning({ id: businessOperationTargets.id });
    if (!updated) return;
    if (params.businessEventType) {
      await db.insert(businessEvents).values({
        tenantId: params.tenantId,
        entityType: "household",
        entityId: params.target.targetId,
        eventType: params.businessEventType,
        payload: {
          operationId: params.operation.id,
          operationTargetId: params.target.id,
          channel: object(params.operation.configuration).channel,
          providerRef: params.providerRef ?? null,
          result: params.result ?? {},
        },
        source: `business_operation:${params.operation.id}`,
      });
    }
    if (params.communication) {
      await db.insert(communicationsLog).values({
        householdId: params.target.targetId,
        channel: params.communication.channel,
        direction: "outbound",
        content: params.communication.content,
      });
    }
    await appendEventTx(db, {
      tenantId: params.tenantId,
      operationId: params.operation.id,
      targetId: params.target.id,
      eventType: `target_${params.status}`,
      payload: {
        targetId: params.target.targetId,
        attempts: params.target.attempts,
        failureClass: params.failureClass ?? null,
        errorKind: params.errorKind ?? null,
        providerRef: params.providerRef ?? null,
      },
    });
  });
  await refreshOperation(params.tenantId, params.operation.id);
  if (params.status === "retry") {
    await scheduleDispatcher(params.tenantId, params.operation, `retry:${params.target.id}:${params.target.attempts}`, params.retryAt ?? new Date());
  }
}

async function refreshOperation(tenantId: string, operationId: string): Promise<void> {
  let workId: string | null = null;
  let objectiveActionId: string | null = null;
  let objectiveWakeDue = false;
  let terminalEffect: BusinessEffectSet | null = null;
  let terminalEffectResult: ExecutionResult | null = null;
  await withTenant(tenantId, async (db) => {
    const [operation] = await db.select().from(businessOperations)
      .where(and(eq(businessOperations.tenantId, tenantId), eq(businessOperations.id, operationId))).limit(1);
    if (!operation) return;
    workId = operation.workId;
    objectiveActionId = operation.domainActionId;
    const rows = await db.select({ status: businessOperationTargets.status, count: sql<number>`count(*)::int` })
      .from(businessOperationTargets).where(eq(businessOperationTargets.operationId, operationId)).groupBy(businessOperationTargets.status);
    const counts = Object.fromEntries(rows.map((row) => [row.status, row.count])) as Record<string, number>;
    const outcome = {
      targetCount: operation.targetCount,
      pending: counts.pending ?? 0,
      running: counts.running ?? 0,
      succeeded: counts.succeeded ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
      retry: counts.retry ?? 0,
    };
    const active = outcome.pending + outcome.running + outcome.retry;
    let status: OperationRow["status"] = operation.status === "queued" ? "running" : operation.status;
    let failure: Record<string, unknown> | null = null;
    let completedAt: Date | null = operation.completedAt;
    if (active === 0 && operation.status !== "cancelled") {
      const humanRows = await db.select({ id: businessOperationTargets.id }).from(businessOperationTargets).where(and(
        eq(businessOperationTargets.operationId, operationId),
        inArray(businessOperationTargets.failureClass, ["configuration", "human_review", "retryable"]),
      )).limit(1);
      status = humanRows.length > 0
        ? "needs_human_review"
        : outcome.failed > 0 || outcome.skipped > 0
          ? "completed_with_failures"
          : "completed";
      failure = status === "needs_human_review"
        ? { errorKind: "needs_human", message: "One or more targets require review before the operation can finish.", recoveryPath: `/api/operations/${operationId}/retry` }
        : status === "completed_with_failures"
          ? { errorKind: "validation", message: "The approved cohort completed with policy skips or invalid targets.", recoveryPath: "Inspect per-target outcomes; invalid inputs are not retried automatically." }
          : null;
      completedAt = status === "needs_human_review" ? null : new Date();
    }
    await db.update(businessOperations).set({
      status,
      pendingCount: outcome.pending,
      runningCount: outcome.running,
      succeededCount: outcome.succeeded,
      failedCount: outcome.failed,
      skippedCount: outcome.skipped,
      retryCount: outcome.retry,
      startedAt: operation.startedAt ?? (status === "running" ? new Date() : operation.startedAt),
      completedAt,
      finalOutcome: outcome,
      failure,
      updatedAt: new Date(),
    }).where(eq(businessOperations.id, operationId));
    await db.update(decisionReceipts).set({
      actualResult: { operationId, status, ...outcome },
      failure,
      finalizedAt: status === "completed" || status === "completed_with_failures" || status === "failed" ? new Date() : null,
    }).where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.operationId, operationId)));
    if (["completed", "completed_with_failures", "failed", "needs_human_review"].includes(status)) {
      const actionStatus = status === "needs_human_review" ? "needs_human_review" : status === "failed" ? "failed" : "completed";
      await db.update(domainActions).set({ status: actionStatus, executionStartedAt: null })
        .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, operation.domainActionId)));
      if (operation.status !== status) await appendEventTx(db, { tenantId, operationId, eventType: `operation_${status}`, payload: outcome });
      objectiveWakeDue = operation.status !== status;
      if (operation.businessEffectId && status !== "needs_human_review") {
        const [effectRow] = await db.select({ effect: businessEffects.effect }).from(businessEffects).where(and(
          eq(businessEffects.tenantId, tenantId),
          eq(businessEffects.id, operation.businessEffectId),
        )).limit(1);
        if (effectRow) {
          terminalEffect = effectRow.effect as BusinessEffectSet;
          terminalEffectResult = status === "completed"
            ? {
                status: "success",
                output: {
                  verified: true,
                  canonicalObserved: true,
                  businessOperationId: operation.id,
                  targetOutcomes: outcome,
                },
              }
            : {
                status: "failure",
                output: { businessOperationId: operation.id, targetOutcomes: outcome },
                error: failure?.message ? String(failure.message) : `Business operation ended ${status}`,
                errorKind: "validation",
              };
        }
      }
    }
  });
  if (terminalEffect && terminalEffectResult) {
    await recordBusinessEffectOutcome(tenantId, terminalEffect, terminalEffectResult);
  }
  if (workId) await reconcileWorkStatus(tenantId, workId);
  if (objectiveWakeDue && objectiveActionId) await resumeObjectiveForAction(tenantId, objectiveActionId).catch(() => false);
}

async function scheduleDispatcher(tenantId: string, operation: OperationRow, suffix: string, runAt: Date): Promise<void> {
  await withTenant(tenantId, (db) => db.insert(jobs).values({
    type: "dispatch_business_operation",
    payload: { tenantId, operationId: operation.id, actionId: operation.domainActionId },
    idempotencyKey: `business-operation:${operation.id}:dispatch:${suffix}`,
    runAt,
    lane: "batch",
    priority: 5,
  }).onConflictDoNothing({ target: jobs.idempotencyKey }));
}

async function screenTargets(operation: OperationRow, candidates: TargetRow[]): Promise<TargetRow[]> {
  const eligible: TargetRow[] = [];
  for (const target of candidates) {
    const check = await safetyCheck(operation.tenantId, target);
    if (check.ok) eligible.push(target);
    else {
      const claimed = await claimTarget(operation.tenantId, operation.id, target.id);
      if (claimed) await finishTarget({ tenantId: operation.tenantId, operation, target: claimed, ...check, error: check.message });
    }
  }
  return eligible;
}

export async function dispatchBusinessOperation(payload: Record<string, unknown>): Promise<void> {
  const tenantId = String(payload.tenantId ?? "");
  const operationId = String(payload.operationId ?? "");
  const operation = await loadOperation(tenantId, operationId);
  if (!operation || !["queued", "running"].includes(operation.status)) return;
  if (!(await operationWorkStillActive(operation))) return;
  if (!(await operationAuthorityStillValid(operation))) return;

  // A worker that died after claiming an SMS target leaves a short lease. Reclaim it
  // under the same per-target external-operation prefix, which can safely replay a
  // provider result without sending again. Call batches are different: their one
  // provider effect spans several targets and is keyed by the original batch
  // sequence. The generic job queue must retry that same payload/key; redispatching
  // the targets into a new batch could duplicate a campaign after an acknowledge
  // crash. If that original job is already terminal without target outcomes, require
  // human reconciliation instead of guessing whether the provider accepted it.
  const strandedCallTargets = await withTenant(tenantId, async (db) => {
    await db.update(businessOperationTargets).set({ status: "retry", jobKey: null, leaseExpiresAt: null, nextAttemptAt: new Date(), updatedAt: new Date(), failureClass: "retryable", errorKind: "retryable", lastError: "Target worker lease expired before a durable outcome was recorded." })
      .where(and(
        eq(businessOperationTargets.operationId, operationId),
        eq(businessOperationTargets.status, "running"),
        lte(businessOperationTargets.leaseExpiresAt, new Date()),
        or(sql`${businessOperationTargets.jobKey} IS NULL`, sql`${businessOperationTargets.jobKey} NOT LIKE ${`business-operation:${operationId}:call-batch:%`}`),
      ));
    return db.update(businessOperationTargets).set({
      status: "failed",
      failureClass: "human_review",
      errorKind: "needs_human",
      lastError: "The call-batch job ended without a durable target outcome. Reconcile the provider campaign before authorizing recovery.",
      leaseExpiresAt: null,
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(businessOperationTargets.operationId, operationId),
      eq(businessOperationTargets.status, "running"),
      lte(businessOperationTargets.leaseExpiresAt, new Date()),
      sql`${businessOperationTargets.jobKey} LIKE ${`business-operation:${operationId}:call-batch:%`}`,
      sql`EXISTS (
        SELECT 1 FROM ${jobs} recovery_job
        WHERE recovery_job.idempotency_key = ${businessOperationTargets.jobKey}
          AND recovery_job.status IN ('completed', 'dead_letter')
      )`,
    )).returning({ id: businessOperationTargets.id });
  });
  if (strandedCallTargets.length > 0) await refreshOperation(tenantId, operationId);

  const configuration = object(operation.configuration);
  const channel = configuration.channel === "call" ? "call" : "sms";
  const limit = channel === "call" ? DAILY_VAPI_CALL_CAP : SMS_DISPATCH_SIZE;
  const candidates = await withTenant(tenantId, (db) => db.select().from(businessOperationTargets).where(and(
    eq(businessOperationTargets.operationId, operationId),
    inArray(businessOperationTargets.status, ["pending", "retry"]),
    lte(businessOperationTargets.nextAttemptAt, new Date()),
    sql`${businessOperationTargets.jobKey} IS NULL`,
  )).orderBy(asc(businessOperationTargets.ordinal)).limit(limit));
  if (candidates.length === 0) {
    await refreshOperation(tenantId, operationId);
    // A target job can exhaust the generic queue after a worker crash before it
    // records a target outcome. Keep one cheap watchdog wake-up until the operation
    // is terminal; it reclaims only expired target leases and otherwise no-ops.
    await scheduleDispatcher(tenantId, operation, `watchdog:${operation.nextBatchSequence}`, new Date(Date.now() + 5 * 60_000));
    return;
  }
  const eligible = await screenTargets(operation, candidates);
  if (eligible.length === 0) {
    await scheduleDispatcher(tenantId, operation, `screened:${operation.nextBatchSequence}`, new Date());
    return;
  }

  if (channel === "sms") {
    const sequence = operation.nextBatchSequence;
    await withTenant(tenantId, async (db) => {
      await db.update(businessOperations).set({ status: "running", startedAt: operation.startedAt ?? new Date(), nextBatchSequence: sequence + 1, updatedAt: new Date() })
        .where(and(eq(businessOperations.id, operationId), eq(businessOperations.nextBatchSequence, sequence)));
      for (const target of eligible) {
        const jobKey = `business-operation:${operationId}:target:${target.id}:attempt:${target.attempts}`;
        await db.update(businessOperationTargets).set({ jobKey, updatedAt: new Date() })
          .where(and(eq(businessOperationTargets.id, target.id), sql`${businessOperationTargets.jobKey} IS NULL`));
        await db.insert(jobs).values({
          type: "execute_business_operation_target",
          payload: { tenantId, operationId, targetId: target.id, actionId: operation.domainActionId },
          idempotencyKey: jobKey,
          lane: "batch",
          priority: 5,
        }).onConflictDoNothing({ target: jobs.idempotencyKey });
      }
      await appendEventTx(db, { tenantId, operationId, eventType: "target_jobs_queued", payload: { channel, count: eligible.length, sequence } });
    });
    await scheduleDispatcher(tenantId, operation, `continuation:${sequence}`, new Date());
    return;
  }

  const timezone = String(object(eligible[0]!.frozenSnapshot).dealerTimezone ?? "America/Chicago");
  const window = nextCallingWindow(timezone, new Date(), 0);
  const sequence = operation.nextBatchSequence;
  const reservationKey = `${operationId}:batch:${sequence}`;
  const reservation = await reserveBudget(tenantId, "vapi", "call", DAILY_VAPI_CALL_CAP, eligible.length, window.localDate, reservationKey);
  if (reservation.granted === 0) {
    const next = nextCallingWindow(timezone, window.latestAt, 1);
    await scheduleDispatcher(tenantId, operation, `cap:${next.localDate}:${sequence}`, next.earliestAt);
    await withTenant(tenantId, (db) => appendEventTx(db, { tenantId, operationId, eventType: "calling_cap_deferred", payload: { remaining: eligible.length, resumeAt: next.earliestAt.toISOString(), cap: DAILY_VAPI_CALL_CAP } }));
    return;
  }
  const batch = eligible.slice(0, reservation.granted);
  const batchKey = `business-operation:${operationId}:call-batch:${sequence}`;
  await withTenant(tenantId, async (db) => {
    const claimed = await db.update(businessOperations).set({ status: "running", startedAt: operation.startedAt ?? new Date(), nextBatchSequence: sequence + 1, updatedAt: new Date() })
      .where(and(eq(businessOperations.id, operationId), eq(businessOperations.nextBatchSequence, sequence))).returning({ id: businessOperations.id });
    if (!claimed[0]) return;
    await db.update(businessOperationTargets).set({ jobKey: batchKey, updatedAt: new Date() }).where(inArray(businessOperationTargets.id, batch.map((target) => target.id)));
    await db.insert(jobs).values({
      type: "execute_business_operation_call_batch",
      payload: {
        tenantId,
        operationId,
        actionId: operation.domainActionId,
        targetIds: batch.map((target) => target.id),
        sequence,
        reservationKey,
        reservationDate: window.localDate,
        reserved: batch.length,
        earliestAt: window.earliestAt.toISOString(),
        latestAt: window.latestAt.toISOString(),
      },
      idempotencyKey: batchKey,
      runAt: window.earliestAt,
      lane: "batch",
      priority: 5,
    }).onConflictDoNothing({ target: jobs.idempotencyKey });
    await appendEventTx(db, { tenantId, operationId, eventType: "call_batch_queued", payload: { sequence, count: batch.length, localDate: window.localDate, earliestAt: window.earliestAt.toISOString() } });
  });
  const nextRun = reservation.granted < eligible.length ? nextCallingWindow(timezone, window.latestAt, 1).earliestAt : new Date();
  await scheduleDispatcher(tenantId, operation, `continuation:${sequence}`, nextRun);
}

export async function executeBusinessOperationTarget(payload: Record<string, unknown>): Promise<void> {
  const tenantId = String(payload.tenantId ?? "");
  const operationId = String(payload.operationId ?? "");
  const targetId = String(payload.targetId ?? "");
  const operation = await loadOperation(tenantId, operationId);
  if (!operation || !["queued", "running"].includes(operation.status)) return;
  if (!(await operationWorkStillActive(operation))) return;
  if (!(await operationAuthorityStillValid(operation))) return;
  const [candidate] = await withTenant(tenantId, (db) => db.select().from(businessOperationTargets).where(and(
    eq(businessOperationTargets.tenantId, tenantId),
    eq(businessOperationTargets.operationId, operationId),
    eq(businessOperationTargets.id, targetId),
  )).limit(1));
  if (!candidate) return;
  const check = await safetyCheck(tenantId, candidate);
  if (!check.ok) {
    const target = await claimTarget(tenantId, operationId, targetId);
    if (target) await finishTarget({ tenantId, operation, target, ...check, error: check.message });
    return;
  }
  const prepared = object(candidate.preparedPayload);
  const message = String(prepared.message ?? "");
  if (!message) {
    const target = await claimTarget(tenantId, operationId, targetId);
    if (target) await finishTarget({ tenantId, operation, target, status: "failed", failureClass: "invalid_input", errorKind: "validation", error: "The approved SMS preview is empty." });
    return;
  }
  const access = await actionAccessContext(tenantId, operation.domainActionId);
  const scoped = new ScopedToolRegistry(tools(), { tenantId, domainActionId: operation.domainActionId, ...access, operationKeyPrefix: `operation:${operationId}:target:${candidate.id}` });
  const fenced = await withActiveOperationEffectFence(tenantId, operationId, async (db) => {
    const target = await claimTargetTx(db, tenantId, operationId, targetId);
    if (!target) return null;
    const contact = await scoped.call("ghl_create_contact", { phone: check.phone, firstName: String(prepared.label ?? "Customer"), tenantId });
    const result = contact.ok
      ? await scoped.call("ghl_send_sms", { contactId: String(contact.output.contactId ?? ""), message, tenantId })
      : contact;
    return { target, result };
  });
  if (!fenced.active || !fenced.value) return;
  const { target, result } = fenced.value;
  if (!result.ok) {
    const failure = failureFrom(result, target.attempts, target.maxAttempts);
    await finishTarget({ tenantId, operation, target, ...failure, error: result.error ?? "SMS provider did not accept the message.", result: result.output });
    return;
  }
  const simulated = result.output.simulated === true;
  await finishTarget({
    tenantId,
    operation,
    target,
    status: "succeeded",
    providerRef: String(result.output.messageId ?? result.output.id ?? result.output.to ?? `target:${target.id}`),
    result: { providerAccepted: !simulated, simulated, output: result.output },
    evidence: [{ source: simulated ? "sandbox_outbox" : "ghl", ref: String(result.output.messageId ?? result.output.id ?? target.id), timestamp: new Date().toISOString() }],
    businessEventType: simulated ? "winback_sms_emulated" : "winback_sms_provider_accepted",
    // The native emulator already writes communications_log. A live provider result
    // needs the same canonical business projection after acceptance.
    communication: simulated ? undefined : { channel: "sms", content: message },
  });
}

export async function executeBusinessOperationCallBatch(payload: Record<string, unknown>): Promise<void> {
  const tenantId = String(payload.tenantId ?? "");
  const operationId = String(payload.operationId ?? "");
  const operation = await loadOperation(tenantId, operationId);
  if (!operation || !["queued", "running"].includes(operation.status)) return;
  if (!(await operationWorkStillActive(operation))) return;
  if (!(await operationAuthorityStillValid(operation))) return;
  const requestedIds = Array.isArray(payload.targetIds) ? payload.targetIds.filter((id): id is string => typeof id === "string") : [];
  const rows = requestedIds.length === 0 ? [] : await withTenant(tenantId, (db) => db.select().from(businessOperationTargets)
    .where(and(eq(businessOperationTargets.operationId, operationId), inArray(businessOperationTargets.id, requestedIds)))
    .orderBy(asc(businessOperationTargets.ordinal)));
  const claimed: TargetRow[] = [];
  for (const row of rows) {
    const check = await safetyCheck(tenantId, row);
    if (!check.ok) {
      const invalid = await claimTarget(tenantId, operationId, row.id);
      if (invalid) {
        await finishTarget({ tenantId, operation, target: invalid, ...check, error: check.message });
        await releaseBudget(tenantId, "vapi", "call", 1, String(payload.reservationDate), String(payload.reservationKey)).catch(() => undefined);
      }
      continue;
    }
    claimed.push(row);
  }
  if (claimed.length === 0) return;
  const preparedCustomers = claimed.map((target) => object(target.preparedPayload).customer).filter((customer): customer is Record<string, unknown> => Boolean(customer && typeof customer === "object"));
  if (preparedCustomers.length !== claimed.length) {
    for (const row of claimed) {
      const target = await claimTarget(tenantId, operationId, row.id);
      if (target) await finishTarget({ tenantId, operation, target, status: "failed", failureClass: "invalid_input", errorKind: "validation", error: "The approved call payload is incomplete." });
    }
    await releaseBudget(tenantId, "vapi", "call", Number(payload.reserved ?? claimed.length), String(payload.reservationDate), String(payload.reservationKey)).catch(() => undefined);
    return;
  }
  const configuration = object(operation.configuration);
  const persona = String(configuration.voicePersona ?? "winback");
  const bindings = await resolveCapabilityBindingsForTenant(tenantId);
  const access = await actionAccessContext(tenantId, operation.domainActionId);
  const assistantId = bindings.communications.mode === "vapi"
    ? await resolveCredentialContext(tenantId, access.actorId, "vapi", access.purpose, {
        channel: "voice",
        ...(access.communicationIdentityId ? { communicationIdentityId: access.communicationIdentityId } : {}),
      }).then((context) => context.credentials.assistantIds?.[persona] ?? (persona === "main" ? context.credentials.assistantId : ""))
    : "sandbox-emulator";
  if (!assistantId) {
    for (const target of claimed) await finishTarget({ tenantId, operation, target, status: "failed", failureClass: "configuration", errorKind: "config", error: "The Vapi win-back assistant is not configured." });
    await releaseBudget(tenantId, "vapi", "call", Number(payload.reserved ?? claimed.length), String(payload.reservationDate), String(payload.reservationKey)).catch(() => undefined);
    return;
  }
  const sequence = Number(payload.sequence ?? 0);
  const name = `finnor-winback-${operationId}-${String(payload.reservationDate)}-${sequence}`;
  const scoped = new ScopedToolRegistry(tools(), { tenantId, domainActionId: operation.domainActionId, ...access, operationKeyPrefix: `operation:${operationId}:call-batch:${sequence}` });
  const fenced = await withActiveOperationEffectFence(tenantId, operationId, async (db) => {
    const targets: TargetRow[] = [];
    for (const row of claimed) {
      const target = await claimTargetTx(db, tenantId, operationId, row.id);
      if (target) targets.push(target);
    }
    if (targets.length === 0) return null;
    const customers = targets.map((target) => object(target.preparedPayload).customer) as Record<string, unknown>[];
    const result = await scoped.call("vapi_create_campaign", {
      tenantId,
      name,
      assistantId,
      schedulePlan: { earliestAt: String(payload.earliestAt), latestAt: String(payload.latestAt) },
      customers,
    });
    return { targets, result };
  });
  if (!fenced.active || !fenced.value) {
    await releaseBudget(tenantId, "vapi", "call", Number(payload.reserved ?? claimed.length), String(payload.reservationDate), String(payload.reservationKey)).catch(() => undefined);
    return;
  }
  const { targets, result } = fenced.value;
  if (!result.ok) {
    await releaseBudget(tenantId, "vapi", "call", Number(payload.reserved ?? targets.length), String(payload.reservationDate), String(payload.reservationKey)).catch(() => undefined);
    for (const target of targets) {
      const failure = failureFrom(result, target.attempts, target.maxAttempts);
      await finishTarget({ tenantId, operation, target, ...failure, error: result.error ?? "Vapi did not accept the campaign batch.", result: result.output });
    }
    return;
  }
  const simulated = result.output.simulated === true;
  const providerRef = String(result.output.id ?? name);
  for (const target of targets) {
    await finishTarget({
      tenantId,
      operation,
      target,
      status: "succeeded",
      providerRef,
      result: { providerAccepted: !simulated, simulated, campaign: result.output },
      evidence: [{ source: simulated ? "sandbox_outbox" : "vapi_campaign", ref: providerRef, timestamp: new Date().toISOString() }],
      businessEventType: simulated ? "winback_call_emulated" : "winback_call_provider_queued",
    });
  }
}
