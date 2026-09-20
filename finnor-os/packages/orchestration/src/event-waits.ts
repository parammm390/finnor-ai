import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import {
  ingestIntegrationEventTx,
  integrationEvents,
  processWorkEventWaitDeadlineTx,
  WORK_EVENT_WAIT_SETTLEMENT_MS,
  withTenant,
  workEventWaits,
  workWakeClaims,
  type IntegrationEventIngestResult,
  type IntegrationEventInput,
} from "@finnor/db";

export async function ingestIntegrationEvent(input: IntegrationEventInput): Promise<IntegrationEventIngestResult> {
  return withTenant(input.tenantId, (db) => ingestIntegrationEventTx(db, input));
}

export async function processWorkEventWaitDeadline(tenantId: string, waitId: string, now = new Date()) {
  return withTenant(tenantId, (db) => processWorkEventWaitDeadlineTx(db, tenantId, waitId, now));
}

/** Recovery is a backstop for a missing/dead-lettered targeted deadline job. The
 * normal path is the exact jobs.run_at row created with the wait. */
export async function recoverDueWorkEventWaits(tenantId: string, now = new Date(), limit = 100): Promise<number> {
  const settledBefore = new Date(now.getTime() - WORK_EVENT_WAIT_SETTLEMENT_MS);
  const waits = await withTenant(tenantId, (db) => db.select({ id: workEventWaits.id }).from(workEventWaits).where(and(
    eq(workEventWaits.tenantId, tenantId),
    eq(workEventWaits.status, "waiting"),
    lte(workEventWaits.deadlineAt, settledBefore),
  )).orderBy(asc(workEventWaits.deadlineAt)).limit(Math.min(Math.max(limit, 1), 500)));
  let claimed = 0;
  for (const wait of waits) {
    const result = await processWorkEventWaitDeadline(tenantId, wait.id, now);
    if (result.outcome === "satisfied" || result.outcome === "timed_out") claimed += 1;
  }
  return claimed;
}

export async function objectiveWakeContext(tenantId: string, objectiveLoopId: string): Promise<Record<string, unknown> | null> {
  return withTenant(tenantId, async (db) => {
    const [claim] = await db.select().from(workWakeClaims).where(and(
      eq(workWakeClaims.tenantId, tenantId),
      eq(workWakeClaims.objectiveLoopId, objectiveLoopId),
    )).orderBy(desc(workWakeClaims.claimedAt)).limit(1);
    if (!claim) return null;
    const [wait] = await db.select().from(workEventWaits).where(and(eq(workEventWaits.tenantId, tenantId), eq(workEventWaits.id, claim.waitId))).limit(1);
    const [event] = await db.select().from(integrationEvents).where(and(eq(integrationEvents.tenantId, tenantId), eq(integrationEvents.id, claim.integrationEventId))).limit(1);
    if (!wait || !event) return null;
    return {
      claim: { id: claim.id, cause: claim.cause, objectiveRevision: claim.objectiveRevision, claimedAt: claim.claimedAt.toISOString() },
      wait: {
        id: wait.id,
        status: wait.status,
        planRevisionId: wait.planRevisionId,
        planNodeId: wait.planNodeId,
        objectiveRevision: wait.objectiveRevision,
        expectedEventType: wait.expectedEventType,
        conditionSummary: wait.conditionSummary,
        deadlineAt: wait.deadlineAt?.toISOString() ?? null,
        subject: wait.subjectId ? { type: wait.subjectType, id: wait.subjectId } : null,
        resource: wait.resourceId ? { type: wait.resourceType, id: wait.resourceId } : null,
        delegationId: wait.delegationId,
        taskId: wait.taskId,
        acknowledgementRequestId: wait.acknowledgementRequestId,
        computerRunId: wait.computerRunId,
        domainActionId: wait.domainActionId,
        provider: wait.provider,
        providerConversationId: wait.providerConversationId,
        correlationId: wait.correlationId,
        continuationPolicy: wait.continuationPolicy,
      },
      event: {
        id: event.id,
        source: event.source,
        provider: event.provider,
        eventType: event.eventType,
        occurredAt: event.occurredAt.toISOString(),
        receivedAt: event.receivedAt.toISOString(),
        party: event.partyId ? { type: event.partyType, id: event.partyId } : null,
        resource: event.resourceId ? { type: event.resourceType, id: event.resourceId } : null,
        workId: event.workId,
        taskId: event.taskId,
        delegationId: event.delegationId,
        acknowledgementRequestId: event.acknowledgementRequestId,
        computerRunId: event.computerRunId,
        domainActionId: event.domainActionId,
        payload: event.payload,
        evidenceRefs: event.evidenceRefs,
        trustClass: event.trustClass,
        contentTreatment: event.contentTreatment,
        instructionEligible: false,
      },
    };
  });
}

export async function markObjectiveWakeConsumed(tenantId: string, objectiveLoopId: string, revision: number): Promise<void> {
  await withTenant(tenantId, (db) => db.update(workWakeClaims).set({ consumedAt: new Date() }).where(and(
    eq(workWakeClaims.tenantId, tenantId),
    eq(workWakeClaims.objectiveLoopId, objectiveLoopId),
    lte(workWakeClaims.objectiveRevision, revision),
    isNull(workWakeClaims.consumedAt),
  )));
}
