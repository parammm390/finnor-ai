import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, lte, ne, sql } from "drizzle-orm";
import type { Db } from "./index";
import {
  integrationEvents,
  jobs,
  workEventWaits,
  workEvents,
  workObjectiveLoops,
  workPlanRevisions,
  workWakeClaims,
  works,
} from "./schema";

export interface CanonicalEventRef {
  type: string;
  id: string;
}

export interface IntegrationEventInput {
  tenantId: string;
  source: string;
  provider?: string | null;
  sourceEventId: string;
  eventType: string;
  occurredAt?: Date;
  party?: CanonicalEventRef | null;
  resource?: CanonicalEventRef | null;
  workId?: string | null;
  taskId?: string | null;
  delegationId?: string | null;
  acknowledgementRequestId?: string | null;
  computerRunId?: string | null;
  domainActionId?: string | null;
  providerConversationId?: string | null;
  providerMessageId?: string | null;
  applicationRef?: string | null;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  evidenceRefs?: unknown[];
  trustClass?: "untrusted_external" | "trusted_runtime";
}

export interface WorkEventWaitCriteria {
  eventType: string;
  subject?: CanonicalEventRef | null;
  resource?: CanonicalEventRef | null;
  delegationId?: string | null;
  taskId?: string | null;
  acknowledgementRequestId?: string | null;
  computerRunId?: string | null;
  domainActionId?: string | null;
  provider?: string | null;
  providerConversationId?: string | null;
  providerMessageId?: string | null;
  applicationRef?: string | null;
  correlationId?: string | null;
}

export interface CreateWorkEventWaitInput {
  tenantId: string;
  workId: string;
  objectiveLoopId: string;
  objectiveStepId: string;
  planRevisionId?: string | null;
  planNodeId?: string | null;
  objectiveRevision?: number | null;
  waitFor: WorkEventWaitCriteria;
  conditionSummary: string;
  earliestAt?: Date;
  deadlineAt?: Date | null;
}

export interface IntegrationEventIngestResult {
  eventId: string;
  duplicate: boolean;
  matchedWaitIds: string[];
  wakeClaimIds: string[];
}

type EventRow = typeof integrationEvents.$inferSelect;
type WaitRow = typeof workEventWaits.$inferSelect;

// A short durable settlement window lets an event transaction already in flight at
// the deadline commit before timeout arbitration. It is encoded in jobs.run_at and
// rechecked in Postgres-facing code; no in-memory timer owns the business deadline.
export const WORK_EVENT_WAIT_SETTLEMENT_MS = 2_000;

function boundedObject(value: Record<string, unknown> | undefined, maxBytes: number): Record<string, unknown> {
  const input = value ?? {};
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { return { bounded: true, unserializable: true }; }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes <= maxBytes) return input;
  return { bounded: true, bytes, sha256: createHash("sha256").update(encoded).digest("hex") };
}

function boundedEvidence(value: unknown[] | undefined, maxBytes: number): unknown[] {
  const input = value ?? [];
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { return [{ bounded: true, unserializable: true }]; }
  const bytes = Buffer.byteLength(encoded, "utf8");
  return bytes <= maxBytes ? input : [{ bounded: true, bytes, sha256: createHash("sha256").update(encoded).digest("hex") }];
}

function exact(optional: string | null, actual: string | null): boolean {
  return optional == null || optional === actual;
}

function hasStrongWaitCorrelation(wait: WorkEventWaitCriteria): boolean {
  return Boolean(
    wait.resource?.id || wait.delegationId || wait.taskId || wait.acknowledgementRequestId
    || wait.computerRunId || wait.domainActionId || wait.providerConversationId
    || wait.providerMessageId || wait.applicationRef || wait.correlationId,
  );
}

/** Exact refs only. A party name/id by itself is intentionally not strong enough to
 * cross Work boundaries; the event must also carry this Work or a resource-level
 * correlation such as DelegationRef, TaskRef, run id, provider conversation, or id. */
export function integrationEventMatchesWait(event: EventRow, wait: WaitRow): boolean {
  if (event.tenantId !== wait.tenantId || event.eventType !== wait.expectedEventType) return false;
  if (event.occurredAt < wait.earliestAt) return false;
  if (wait.deadlineAt && event.occurredAt > wait.deadlineAt) return false;
  if (event.workId && event.workId !== wait.workId) return false;
  if (!exact(wait.subjectType, event.partyType) || !exact(wait.subjectId, event.partyId)) return false;
  if (!exact(wait.resourceType, event.resourceType) || !exact(wait.resourceId, event.resourceId)) return false;
  if (!exact(wait.delegationId, event.delegationId)) return false;
  if (!exact(wait.taskId, event.taskId)) return false;
  if (!exact(wait.acknowledgementRequestId, event.acknowledgementRequestId)) return false;
  if (!exact(wait.computerRunId, event.computerRunId)) return false;
  if (!exact(wait.domainActionId, event.domainActionId)) return false;
  if (!exact(wait.provider, event.provider)) return false;
  if (!exact(wait.providerConversationId, event.providerConversationId)) return false;
  if (!exact(wait.providerMessageId, event.providerMessageId)) return false;
  if (!exact(wait.applicationRef, event.applicationRef)) return false;
  if (!exact(wait.correlationId, event.correlationId)) return false;
  const sameWork = event.workId === wait.workId;
  const strongCorrelation = Boolean(
    wait.resourceId || wait.delegationId || wait.taskId || wait.acknowledgementRequestId
    || wait.computerRunId || wait.domainActionId || wait.providerConversationId
    || wait.providerMessageId || wait.applicationRef || wait.correlationId,
  );
  return sameWork || strongCorrelation;
}

async function appendWakeWorkEventTx(db: Db, wait: WaitRow, event: EventRow, cause: "event" | "deadline"): Promise<void> {
  await db.execute(sql`SELECT id FROM ${works} WHERE ${works.tenantId}=${wait.tenantId} AND ${works.id}=${wait.workId} FOR UPDATE`);
  const [work] = await db.select().from(works).where(and(eq(works.tenantId, wait.tenantId), eq(works.id, wait.workId))).limit(1);
  if (!work) throw new Error("Event wait Work disappeared while claiming wake");
  const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${workEvents.seq}),0)::int` }).from(workEvents).where(eq(workEvents.workId, wait.workId));
  await db.update(works).set({ status: "executing", updatedAt: new Date() }).where(and(eq(works.tenantId, wait.tenantId), eq(works.id, wait.workId)));
  await db.insert(workEvents).values({
    tenantId: wait.tenantId,
    workId: wait.workId,
    seq: (latest?.maxSeq ?? 0) + 1,
    eventType: cause === "event" ? "objective_event_wake_claimed" : "objective_deadline_wake_claimed",
    fromStatus: work.status,
    toStatus: "executing",
    payload: { objectiveLoopId: wait.objectiveLoopId, waitId: wait.id, integrationEventId: event.id, eventType: event.eventType, cause },
  });
}

async function claimWaitWakeTx(
  db: Db,
  wait: WaitRow,
  event: EventRow,
  cause: "event" | "deadline",
): Promise<{ waitId: string; wakeClaimId: string } | null> {
  await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.tenantId}=${wait.tenantId} AND ${workObjectiveLoops.id}=${wait.objectiveLoopId} FOR UPDATE`);
  const [loop] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, wait.tenantId), eq(workObjectiveLoops.id, wait.objectiveLoopId))).limit(1);
  if (!loop) throw new Error("Event wait Objective Loop disappeared");
  const [activePlan] = wait.planRevisionId ? await db.select({ id: workPlanRevisions.id }).from(workPlanRevisions).where(and(
    eq(workPlanRevisions.tenantId, wait.tenantId),
    eq(workPlanRevisions.id, wait.planRevisionId),
    eq(workPlanRevisions.workId, wait.workId),
    eq(workPlanRevisions.status, "active"),
  )).limit(1) : [];
  const staleGeneration = (wait.objectiveRevision !== null && wait.objectiveRevision !== loop.revision)
    || (wait.planRevisionId !== null && !activePlan);
  if (["blocked", "completed", "failed", "cancelled"].includes(loop.state) || staleGeneration) {
    await db.update(workEventWaits).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workEventWaits.tenantId, wait.tenantId), eq(workEventWaits.id, wait.id), eq(workEventWaits.status, "waiting")));
    return null;
  }
  const terminalAt = new Date();
  const [claimedWait] = await db.update(workEventWaits).set(cause === "event"
    ? { status: "satisfied", matchedEventId: event.id, satisfiedAt: terminalAt, updatedAt: terminalAt }
    : { status: "timed_out", matchedEventId: event.id, timedOutAt: terminalAt, updatedAt: terminalAt })
    .where(and(eq(workEventWaits.tenantId, wait.tenantId), eq(workEventWaits.id, wait.id), eq(workEventWaits.status, "waiting")))
    .returning();
  if (!claimedWait) return null;
  const revision = loop.revision;
  const jobId = randomUUID();
  const [job] = await db.insert(jobs).values({
    id: jobId,
    tenantId: wait.tenantId,
    type: "run_objective_iteration",
    payload: {
      tenantId: wait.tenantId,
      workId: wait.workId,
      objectiveLoopId: wait.objectiveLoopId,
      expectedRevision: revision,
      expectedStepNumber: loop.stepCount + 1,
      wakeWaitId: wait.id,
      wakeEventId: event.id,
      wakeCause: cause,
      _correlationId: wait.workId,
    },
    idempotencyKey: `objective-wake:${wait.id}`,
    lane: "interactive",
    priority: 100,
  }).onConflictDoNothing({ target: jobs.idempotencyKey }).returning();
  if (!job) throw new Error("A wake job already exists without its semantic wake claim");
  const [updatedLoop] = await db.update(workObjectiveLoops).set({
    state: "continue",
    nextRunAt: new Date(),
    reason: cause === "event" ? `Matched ${event.eventType}; canonical state must be re-inspected.` : "The durable wait deadline was reached; canonical state must be re-inspected.",
    nextStep: "Reload current Work, authority, and bounded matched-event evidence; choose one next step.",
    leaseOwner: null,
    leaseUntil: null,
    updatedAt: new Date(),
  }).where(and(eq(workObjectiveLoops.tenantId, wait.tenantId), eq(workObjectiveLoops.id, wait.objectiveLoopId), eq(workObjectiveLoops.revision, loop.revision))).returning();
  if (!updatedLoop) throw new Error("Objective revision changed while claiming an event wake");
  const [wake] = await db.insert(workWakeClaims).values({
    tenantId: wait.tenantId,
    waitId: wait.id,
    integrationEventId: event.id,
    objectiveLoopId: wait.objectiveLoopId,
    workId: wait.workId,
    cause,
    objectiveRevision: revision,
    jobId: job.id,
  }).returning();
  if (!wake) throw new Error("Unable to persist semantic wake claim");
  await appendWakeWorkEventTx(db, wait, event, cause);
  return { waitId: wait.id, wakeClaimId: wake.id };
}

async function matchingWaitsForEventTx(db: Db, event: EventRow): Promise<WaitRow[]> {
  const candidates = await db.select().from(workEventWaits).where(and(
    eq(workEventWaits.tenantId, event.tenantId),
    eq(workEventWaits.status, "waiting"),
    eq(workEventWaits.expectedEventType, event.eventType),
    lte(workEventWaits.earliestAt, event.occurredAt),
  )).orderBy(asc(workEventWaits.createdAt));
  return candidates.filter((wait) => integrationEventMatchesWait(event, wait));
}

/** Caller already verified provider authenticity and deterministically resolved the
 * tenant. This transaction persists the canonical evidence before any wake claim. */
export async function ingestIntegrationEventTx(db: Db, input: IntegrationEventInput): Promise<IntegrationEventIngestResult> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.tenantId}, 904))`);
  const occurredAt = input.occurredAt ?? new Date();
  const [inserted] = await db.insert(integrationEvents).values({
    tenantId: input.tenantId,
    source: input.source.slice(0, 120),
    provider: input.provider?.slice(0, 120) ?? null,
    sourceEventId: input.sourceEventId.slice(0, 500),
    eventType: input.eventType.slice(0, 200),
    occurredAt,
    partyType: input.party?.type ?? null,
    partyId: input.party?.id ?? null,
    resourceType: input.resource?.type ?? null,
    resourceId: input.resource?.id ?? null,
    workId: input.workId ?? null,
    taskId: input.taskId ?? null,
    delegationId: input.delegationId ?? null,
    acknowledgementRequestId: input.acknowledgementRequestId ?? null,
    computerRunId: input.computerRunId ?? null,
    domainActionId: input.domainActionId ?? null,
    providerConversationId: input.providerConversationId?.slice(0, 500) ?? null,
    providerMessageId: input.providerMessageId?.slice(0, 500) ?? null,
    applicationRef: input.applicationRef?.slice(0, 500) ?? null,
    correlationId: input.correlationId?.slice(0, 500) ?? null,
    payload: boundedObject(input.payload, 60_000),
    evidenceRefs: boundedEvidence(input.evidenceRefs, 28_000),
    trustClass: input.trustClass ?? "untrusted_external",
    contentTreatment: "untrusted_evidence",
    instructionEligible: false,
    status: "received",
  }).onConflictDoNothing({ target: [integrationEvents.tenantId, integrationEvents.source, integrationEvents.sourceEventId] }).returning();
  const [event] = inserted ? [inserted] : await db.select().from(integrationEvents).where(and(
    eq(integrationEvents.tenantId, input.tenantId),
    eq(integrationEvents.source, input.source.slice(0, 120)),
    eq(integrationEvents.sourceEventId, input.sourceEventId.slice(0, 500)),
  )).limit(1);
  if (!event) throw new Error("Canonical integration event replay claim disappeared");
  const matches = await matchingWaitsForEventTx(db, event);
  const matchedWaitIds: string[] = [];
  const wakeClaimIds: string[] = [];
  for (const wait of matches) {
    const wake = await claimWaitWakeTx(db, wait, event, "event");
    if (wake) { matchedWaitIds.push(wake.waitId); wakeClaimIds.push(wake.wakeClaimId); }
  }
  const matched = matchedWaitIds.length > 0 || event.status === "matched";
  await db.update(integrationEvents).set({
    status: matched ? "matched" : "unmatched",
    matchedAt: matched ? (event.matchedAt ?? new Date()) : null,
    processedAt: new Date(),
  }).where(and(eq(integrationEvents.tenantId, input.tenantId), eq(integrationEvents.id, event.id)));
  return { eventId: event.id, duplicate: !inserted, matchedWaitIds, wakeClaimIds };
}

export async function createWorkEventWaitTx(db: Db, input: CreateWorkEventWaitInput): Promise<{ wait: WaitRow; wakeClaimId: string | null }> {
  if (!input.waitFor.eventType.trim()) throw new Error("Durable event wait requires an event type");
  if (input.waitFor.eventType !== "deadline.reached" && !hasStrongWaitCorrelation(input.waitFor)) {
    throw new Error("Durable event wait requires an exact Work/resource/delegation/task/run/provider correlation; a PartyRef alone is insufficient");
  }
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.tenantId}, 904))`);
  const deadlineAt = input.deadlineAt ?? null;
  const earliestAt = input.earliestAt ?? new Date();
  if (deadlineAt && deadlineAt < earliestAt) throw new Error("Durable event wait deadline precedes its earliest event time");
  const [wait] = await db.insert(workEventWaits).values({
    tenantId: input.tenantId,
    workId: input.workId,
    objectiveLoopId: input.objectiveLoopId,
    objectiveStepId: input.objectiveStepId,
    planRevisionId: input.planRevisionId ?? null,
    planNodeId: input.planNodeId ?? null,
    objectiveRevision: input.objectiveRevision ?? null,
    expectedEventType: input.waitFor.eventType.slice(0, 200),
    subjectType: input.waitFor.subject?.type ?? null,
    subjectId: input.waitFor.subject?.id ?? null,
    resourceType: input.waitFor.resource?.type ?? null,
    resourceId: input.waitFor.resource?.id ?? null,
    delegationId: input.waitFor.delegationId ?? null,
    taskId: input.waitFor.taskId ?? null,
    acknowledgementRequestId: input.waitFor.acknowledgementRequestId ?? null,
    computerRunId: input.waitFor.computerRunId ?? null,
    domainActionId: input.waitFor.domainActionId ?? null,
    provider: input.waitFor.provider?.slice(0, 120) ?? null,
    providerConversationId: input.waitFor.providerConversationId?.slice(0, 500) ?? null,
    providerMessageId: input.waitFor.providerMessageId?.slice(0, 500) ?? null,
    applicationRef: input.waitFor.applicationRef?.slice(0, 500) ?? null,
    correlationId: input.waitFor.correlationId?.slice(0, 500) ?? null,
    conditionSummary: input.conditionSummary.slice(0, 2000),
    continuationPolicy: { mode: "reinspect_current_state", maxDecisions: 1 },
    earliestAt,
    deadlineAt,
  }).onConflictDoNothing({ target: workEventWaits.objectiveStepId }).returning();
  const [stored] = wait ? [wait] : await db.select().from(workEventWaits).where(and(eq(workEventWaits.tenantId, input.tenantId), eq(workEventWaits.objectiveStepId, input.objectiveStepId))).limit(1);
  if (!stored) throw new Error("Unable to persist durable event wait");
  if (stored.deadlineAt && stored.status === "waiting") {
    await db.insert(jobs).values({
      tenantId: input.tenantId,
      type: "process_work_event_wait_deadline",
      payload: { tenantId: input.tenantId, waitId: stored.id, _correlationId: input.workId },
      runAt: new Date(stored.deadlineAt.getTime() + WORK_EVENT_WAIT_SETTLEMENT_MS),
      idempotencyKey: `work-event-wait:${stored.id}:deadline`,
      lane: "interactive",
      priority: 100,
      maxAttempts: 5,
    }).onConflictDoNothing({ target: jobs.idempotencyKey });
  }
  if (stored.status !== "waiting") return { wait: stored, wakeClaimId: null };
  const existingEvents = await db.select().from(integrationEvents).where(and(
    eq(integrationEvents.tenantId, input.tenantId),
    eq(integrationEvents.eventType, stored.expectedEventType),
    ne(integrationEvents.status, "ignored"),
    lte(integrationEvents.occurredAt, deadlineAt ?? new Date("9999-12-31T23:59:59.999Z")),
  )).orderBy(asc(integrationEvents.occurredAt), asc(integrationEvents.receivedAt));
  const existing = existingEvents.find((event) => integrationEventMatchesWait(event, stored));
  if (!existing) return { wait: stored, wakeClaimId: null };
  const wake = await claimWaitWakeTx(db, stored, existing, "event");
  if (wake) await db.update(integrationEvents).set({ status: "matched", matchedAt: new Date(), processedAt: new Date() }).where(eq(integrationEvents.id, existing.id));
  const [finalWait] = await db.select().from(workEventWaits).where(eq(workEventWaits.id, stored.id)).limit(1);
  return { wait: finalWait!, wakeClaimId: wake?.wakeClaimId ?? null };
}

/** Deadline processing rechecks canonical pre-deadline events under the same tenant
 * advisory lock. An acknowledgement whose occurred_at is before the deadline wins;
 * otherwise a canonical deadline event produces one timeout wake claim. */
export async function processWorkEventWaitDeadlineTx(db: Db, tenantId: string, waitId: string, now = new Date()): Promise<{ outcome: "not_due" | "satisfied" | "timed_out" | "terminal"; wakeClaimId?: string }> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 904))`);
  const [wait] = await db.select().from(workEventWaits).where(and(eq(workEventWaits.tenantId, tenantId), eq(workEventWaits.id, waitId))).limit(1);
  if (!wait || wait.status !== "waiting") return { outcome: "terminal" };
  if (!wait.deadlineAt || wait.deadlineAt.getTime() + WORK_EVENT_WAIT_SETTLEMENT_MS > now.getTime()) return { outcome: "not_due" };
  const candidates = await db.select().from(integrationEvents).where(and(
    eq(integrationEvents.tenantId, tenantId),
    eq(integrationEvents.eventType, wait.expectedEventType),
    ne(integrationEvents.status, "ignored"),
    lte(integrationEvents.occurredAt, wait.deadlineAt),
  )).orderBy(asc(integrationEvents.occurredAt), asc(integrationEvents.receivedAt));
  const winner = candidates.find((event) => integrationEventMatchesWait(event, wait));
  if (winner) {
    const wake = await claimWaitWakeTx(db, wait, winner, "event");
    if (wake) await db.update(integrationEvents).set({ status: "matched", matchedAt: new Date(), processedAt: new Date() }).where(eq(integrationEvents.id, winner.id));
    return wake ? { outcome: "satisfied", wakeClaimId: wake.wakeClaimId } : { outcome: "terminal" };
  }
  const sourceEventId = `wait:${wait.id}:deadline`;
  const [created] = await db.insert(integrationEvents).values({
    tenantId,
    source: "deadline",
    provider: null,
    sourceEventId,
    eventType: "deadline.reached",
    occurredAt: wait.deadlineAt,
    workId: wait.workId,
    resourceType: "work_event_wait",
    resourceId: wait.id,
    payload: { waitId: wait.id, expectedEventType: wait.expectedEventType, deadlineAt: wait.deadlineAt.toISOString() },
    evidenceRefs: [],
    trustClass: "trusted_runtime",
    contentTreatment: "untrusted_evidence",
    instructionEligible: false,
    status: "received",
  }).onConflictDoNothing({ target: [integrationEvents.tenantId, integrationEvents.source, integrationEvents.sourceEventId] }).returning();
  const [deadlineEvent] = created ? [created] : await db.select().from(integrationEvents).where(and(eq(integrationEvents.tenantId, tenantId), eq(integrationEvents.source, "deadline"), eq(integrationEvents.sourceEventId, sourceEventId))).limit(1);
  if (!deadlineEvent) throw new Error("Deadline event replay claim disappeared");
  const wake = await claimWaitWakeTx(db, wait, deadlineEvent, "deadline");
  if (wake) await db.update(integrationEvents).set({ status: "matched", matchedAt: new Date(), processedAt: new Date() }).where(eq(integrationEvents.id, deadlineEvent.id));
  return wake ? { outcome: "timed_out", wakeClaimId: wake.wakeClaimId } : { outcome: "terminal" };
}
