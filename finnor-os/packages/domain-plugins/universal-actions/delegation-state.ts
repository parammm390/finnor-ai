import { acknowledgementRequests, delegationEvents, delegations, ingestIntegrationEventTx, orgUnitMemberships, users, withTenant, type Db } from "@finnor/db";
import type { DelegationStatus } from "@finnor/shared-types";
import { and, eq, sql } from "drizzle-orm";

const ALLOWED_TRANSITIONS: Readonly<Record<DelegationStatus, readonly DelegationStatus[]>> = {
  created: ["sent", "failed_delivery", "escalated", "cancelled"],
  sent: ["delivered", "failed_delivery", "overdue", "escalated", "cancelled"],
  delivered: ["acknowledged", "overdue", "escalated", "cancelled"],
  acknowledged: ["accepted", "declined", "overdue", "escalated", "cancelled"],
  accepted: ["completed", "overdue", "escalated", "cancelled"],
  overdue: ["escalated", "completed", "cancelled"],
  escalated: ["completed", "cancelled"],
  failed_delivery: ["escalated", "cancelled"],
  completed: [],
  declined: [],
  cancelled: [],
};

export function canTransitionDelegation(from: DelegationStatus, to: DelegationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface DelegationTransitionResult {
  delegationId: string;
  from: DelegationStatus;
  to: DelegationStatus;
  eventSequence: number | null;
  duplicate: boolean;
}

async function assertDelegationResponderTx(db: Db, tenantId: string, delegationId: string, actorId: string | undefined): Promise<void> {
  if (!actorId) throw new Error("Delegation acknowledgement or acceptance requires an authenticated employee");
  const [delegation] = await db.select({ targetType: delegations.targetType, targetId: delegations.targetId })
    .from(delegations).where(and(eq(delegations.tenantId, tenantId), eq(delegations.id, delegationId))).limit(1);
  if (!delegation) throw new Error("Delegation not found");
  if (delegation.targetType === "employee") {
    if (delegation.targetId !== actorId) throw new Error("Only the delegated employee may acknowledge or accept this objective");
    const [employee] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, actorId), eq(users.status, "active"))).limit(1);
    if (!employee) throw new Error("Delegation responder is not an active employee");
    return;
  }
  if (delegation.targetType === "team") {
    const [membership] = await db.select({ id: orgUnitMemberships.id }).from(orgUnitMemberships)
      .innerJoin(users, and(eq(users.tenantId, tenantId), eq(users.id, orgUnitMemberships.employeeId), eq(users.status, "active")))
      .where(and(
        eq(orgUnitMemberships.tenantId, tenantId),
        eq(orgUnitMemberships.orgUnitId, delegation.targetId),
        eq(orgUnitMemberships.employeeId, actorId),
        eq(orgUnitMemberships.active, true),
      )).limit(1);
    if (!membership) throw new Error("Only an active member of the delegated team may acknowledge or accept this objective");
    return;
  }
  throw new Error("Delegation target cannot acknowledge or accept this objective");
}

export async function lockDelegationTransitionsTx(db: Db, tenantId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 904))`);
}

async function transitionDelegationTx(
  db: Db,
  params: {
    tenantId: string;
    delegationId: string;
    to: DelegationStatus;
    eventType: string;
    actorId?: string;
    evidence?: Record<string, unknown>;
  },
): Promise<DelegationTransitionResult> {
  // All event-producing P2 transitions take the same tenant lock before their
  // canonical rows. A simultaneous deadline therefore has one deterministic order:
  // acknowledgement-before-deadline or deadline-before-acknowledgement, never both.
  await lockDelegationTransitionsTx(db, params.tenantId);
  await db.execute(sql`SELECT id FROM ${delegations} WHERE ${delegations.tenantId}=${params.tenantId} AND ${delegations.id}=${params.delegationId} FOR UPDATE`);
  const [row] = await db.select().from(delegations).where(and(eq(delegations.tenantId, params.tenantId), eq(delegations.id, params.delegationId))).limit(1);
  if (!row) throw new Error("Delegation not found");
  const from = row.status as DelegationStatus;
  if (from === params.to) return { delegationId: row.id, from, to: params.to, eventSequence: null, duplicate: true };
  if (!canTransitionDelegation(from, params.to)) throw new Error(`Invalid delegation transition ${from} -> ${params.to}`);

  const now = new Date();
  const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${delegationEvents.seq}),0)::int` })
    .from(delegationEvents).where(eq(delegationEvents.delegationId, row.id));
  const seq = (latest?.maxSeq ?? 0) + 1;
  await db.update(delegations).set({
    status: params.to,
    updatedAt: now,
    ...(params.to === "acknowledged" ? { acknowledgedAt: now } : {}),
    ...(params.to === "accepted" ? { acceptedAt: now } : {}),
    ...(params.to === "completed" ? { completedAt: now } : {}),
    ...(params.to === "cancelled" ? { cancelledAt: now } : {}),
  }).where(and(eq(delegations.tenantId, params.tenantId), eq(delegations.id, row.id)));
  await db.insert(delegationEvents).values({
    tenantId: params.tenantId,
    delegationId: row.id,
    seq,
    eventType: params.eventType,
    fromStatus: from,
    toStatus: params.to,
    actorId: params.actorId ?? null,
    evidence: params.evidence ?? {},
  });
  const [acknowledgement] = await db.select({ id: acknowledgementRequests.id }).from(acknowledgementRequests).where(and(
    eq(acknowledgementRequests.tenantId, params.tenantId),
    eq(acknowledgementRequests.delegationId, row.id),
  )).limit(1);
  await ingestIntegrationEventTx(db, {
    tenantId: params.tenantId,
    source: "delegation_runtime",
    sourceEventId: `delegation:${row.id}:event:${seq}`,
    eventType: `delegation.${params.to}`,
    occurredAt: now,
    party: { type: row.targetType, id: row.targetId },
    resource: { type: "delegation", id: row.id },
    workId: row.workId,
    taskId: row.taskId,
    delegationId: row.id,
    acknowledgementRequestId: acknowledgement?.id ?? null,
    domainActionId: row.domainActionId,
    correlationId: row.workId ?? row.id,
    payload: { fromStatus: from, toStatus: params.to, actorId: params.actorId ?? null },
    evidenceRefs: [{ type: "delegation_event", delegationId: row.id, seq }],
    trustClass: "trusted_runtime",
  });
  return { delegationId: row.id, from, to: params.to, eventSequence: seq, duplicate: false };
}

export async function transitionDelegation(params: {
  tenantId: string;
  delegationId: string;
  to: DelegationStatus;
  eventType: string;
  actorId?: string;
  evidence?: Record<string, unknown>;
}): Promise<DelegationTransitionResult> {
  return withTenant(params.tenantId, (db) => transitionDelegationTx(db, params));
}

/** Inbound acknowledgement processing is a separate API/service seam. It changes the
 * acknowledgement row and delegation state atomically from the caller's perspective,
 * but does not imply acceptance or completion. */
export async function acknowledgeDelegation(params: {
  tenantId: string;
  delegationId: string;
  acknowledgementRequestId: string;
  actorId?: string;
  evidence?: Record<string, unknown>;
}): Promise<DelegationTransitionResult> {
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${params.tenantId}, 904))`);
    await db.execute(sql`SELECT id FROM ${acknowledgementRequests} WHERE ${acknowledgementRequests.tenantId}=${params.tenantId} AND ${acknowledgementRequests.id}=${params.acknowledgementRequestId} AND ${acknowledgementRequests.delegationId}=${params.delegationId} FOR UPDATE`);
    const [row] = await db.select().from(acknowledgementRequests).where(and(
      eq(acknowledgementRequests.tenantId, params.tenantId),
      eq(acknowledgementRequests.id, params.acknowledgementRequestId),
      eq(acknowledgementRequests.delegationId, params.delegationId),
    )).limit(1);
    if (!row) throw new Error("Acknowledgement request not found for delegation");
    await assertDelegationResponderTx(db, params.tenantId, params.delegationId, params.actorId);
    if (row.status !== "acknowledged") {
      if (row.status !== "requested" && row.status !== "delivered") throw new Error(`Acknowledgement cannot be recorded from ${row.status}`);
      await db.update(acknowledgementRequests).set({ status: "acknowledged", acknowledgedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(acknowledgementRequests.tenantId, params.tenantId), eq(acknowledgementRequests.id, row.id)));
    }
    return transitionDelegationTx(db, { ...params, to: "acknowledged", eventType: "acknowledged" });
  });
}

export async function acceptDelegation(params: { tenantId: string; delegationId: string; actorId?: string; evidence?: Record<string, unknown> }) {
  return withTenant(params.tenantId, async (db) => {
    await assertDelegationResponderTx(db, params.tenantId, params.delegationId, params.actorId);
    return transitionDelegationTx(db, { ...params, to: "accepted", eventType: "accepted" });
  });
}

export async function completeDelegation(params: { tenantId: string; delegationId: string; actorId?: string; evidence?: Record<string, unknown> }) {
  return transitionDelegation({ ...params, to: "completed", eventType: "completed" });
}

export async function completeTaskDelegationTx(db: Db, params: { tenantId: string; taskId: string; actorId?: string }): Promise<void> {
  const [linked] = await db.select({ id: delegations.id, status: delegations.status, acceptedAt: delegations.acceptedAt })
    .from(delegations).where(and(eq(delegations.tenantId, params.tenantId), eq(delegations.taskId, params.taskId))).limit(1).for("update");
  if (!linked) return;
  const accepted = linked.status === "accepted"
    || (linked.acceptedAt && (linked.status === "escalated" || linked.status === "overdue"));
  if (!accepted) return;
  await transitionDelegationTx(db, {
    tenantId: params.tenantId, delegationId: linked.id, to: "completed", eventType: "completed",
    actorId: params.actorId, evidence: { taskId: params.taskId },
  });
}
