import {
  acknowledgementRequests,
  businessEvents,
  communicationDeliveries,
  communicationIdentities,
  delegations,
  delegationEvents,
  documentShares,
  documents,
  handoffWork,
  internalEventEvents,
  internalEventParticipants,
  internalEvents,
  tasks,
  tenantSettings,
  universalActionEvents,
  users,
  withTenant,
} from "@finnor/db";
import { employeeAuthoritySnapshot } from "@finnor/authority";
import { resolveParty } from "@finnor/read-models";
import { listAvailableIdentityAccess } from "@finnor/security";
import {
  decideUniversalActionRoute,
  type DelegationStatus,
  type ExecutionRouteDecision,
  type PartyRef,
  type UniversalActionType,
  type UniversalCommunicationChannel,
} from "@finnor/shared-types";
import type { ToolRegistry } from "@finnor/tools";
import { and, eq, sql } from "drizzle-orm";
import { expandInternalRecipients, resolveCommunicationTargets } from "./endpoint-resolver";
import { completeDelegation, transitionDelegation } from "./delegation-state";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL_PARTIES = new Set<PartyRef["partyType"]>(["employee", "team", "location"]);

interface RuntimeScope {
  tenantId: string;
  domainActionId: string;
  actorId?: string;
  communicationIdentityId?: string;
}

interface UniversalConfig {
  communication: { allowedChannels: UniversalCommunicationChannel[]; allowChannelFallback: boolean; maxGroupRecipients: number };
  acknowledgements: { defaultDeadlineMinutes: number };
  delegations: { defaultAckDeadlineMinutes: number; defaultCompletionHours: number };
  scheduling: { externalCalendarMode: "internal_only" | "when_available" };
  documentSharing: { allowExternal: boolean };
}

const DEFAULT_CONFIG: UniversalConfig = {
  communication: { allowedChannels: ["internal", "email", "sms", "voice"], allowChannelFallback: false, maxGroupRecipients: 50 },
  acknowledgements: { defaultDeadlineMinutes: 240 },
  delegations: { defaultAckDeadlineMinutes: 240, defaultCompletionHours: 24 },
  scheduling: { externalCalendarMode: "internal_only" },
  documentSharing: { allowExternal: false },
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
}

async function readConfig(tenantId: string): Promise<UniversalConfig> {
  const [row] = await withTenant(tenantId, (db) => db.select({ config: tenantSettings.universalActionConfig }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1));
  const root = object(row?.config);
  const communication = object(root.communication);
  const acknowledgements = object(root.acknowledgements);
  const delegation = object(root.delegations);
  const scheduling = object(root.scheduling);
  const sharing = object(root.documentSharing);
  const allowed = Array.isArray(communication.allowedChannels)
    ? communication.allowedChannels.filter((item): item is UniversalCommunicationChannel => ["internal", "email", "sms", "voice"].includes(String(item)))
    : DEFAULT_CONFIG.communication.allowedChannels;
  return {
    communication: {
      allowedChannels: allowed.length > 0 ? [...new Set(allowed)] : DEFAULT_CONFIG.communication.allowedChannels,
      allowChannelFallback: communication.allowChannelFallback === true,
      maxGroupRecipients: positiveInt(communication.maxGroupRecipients, DEFAULT_CONFIG.communication.maxGroupRecipients, 500),
    },
    acknowledgements: { defaultDeadlineMinutes: positiveInt(acknowledgements.defaultDeadlineMinutes, DEFAULT_CONFIG.acknowledgements.defaultDeadlineMinutes, 43_200) },
    delegations: {
      defaultAckDeadlineMinutes: positiveInt(delegation.defaultAckDeadlineMinutes, DEFAULT_CONFIG.delegations.defaultAckDeadlineMinutes, 43_200),
      defaultCompletionHours: positiveInt(delegation.defaultCompletionHours, DEFAULT_CONFIG.delegations.defaultCompletionHours, 8_760),
    },
    scheduling: { externalCalendarMode: scheduling.externalCalendarMode === "when_available" ? "when_available" : "internal_only" },
    documentSharing: { allowExternal: sharing.allowExternal === true },
  };
}

function requireScope(tools: ToolRegistry): RuntimeScope {
  const runtime = tools.runtimeContext();
  if (!runtime?.tenantId || !UUID.test(runtime.tenantId) || !runtime.domainActionId || !UUID.test(runtime.domainActionId)) {
    throw new Error("Universal actions require a trusted gated execution scope");
  }
  return {
    tenantId: runtime.tenantId,
    domainActionId: runtime.domainActionId,
    ...(runtime.actorId && UUID.test(runtime.actorId) ? { actorId: runtime.actorId } : {}),
    ...(runtime.communicationIdentityId && UUID.test(runtime.communicationIdentityId) ? { communicationIdentityId: runtime.communicationIdentityId } : {}),
  };
}

async function requireParty(scope: RuntimeScope, ref: PartyRef): Promise<void> {
  const outcome = await resolveParty(scope.tenantId, { ref }, { requesterEmployeeId: scope.actorId });
  if (outcome.status !== "resolved") throw new Error(`PartyRef is not an active unambiguous party in this tenant (${outcome.status})`);
}

async function requireCanonicalEntity(tenantId: string, ref: { entityType: string; entityId: string }): Promise<void> {
  const result = await withTenant(tenantId, (db) => db.execute<{ tenant_id: string | null }>(sql`
    SELECT finnor_os.canonical_entity_tenant(${ref.entityType},${ref.entityId}::uuid) tenant_id
  `));
  if (result.rows[0]?.tenant_id !== tenantId) throw new Error("Canonical entity reference does not exist in this tenant");
}

async function appendUniversalEvent(params: {
  scope: RuntimeScope;
  actionType: UniversalActionType;
  eventType: string;
  route?: ExecutionRouteDecision["route"];
  subject?: { type: string; id: string };
  communicationIdentityId?: string | null;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  await withTenant(params.scope.tenantId, async (db) => {
    const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${universalActionEvents.seq}),0)::int` })
      .from(universalActionEvents).where(eq(universalActionEvents.domainActionId, params.scope.domainActionId));
    await db.insert(universalActionEvents).values({
      tenantId: params.scope.tenantId,
      domainActionId: params.scope.domainActionId,
      seq: (latest?.maxSeq ?? 0) + 1,
      actionType: params.actionType,
      eventType: params.eventType,
      route: params.route ?? null,
      subjectType: params.subject?.type ?? null,
      subjectId: params.subject?.id ?? null,
      actorId: params.scope.actorId ?? null,
      communicationIdentityId: params.communicationIdentityId === undefined
        ? params.scope.communicationIdentityId ?? null
        : params.communicationIdentityId,
      evidence: params.evidence ?? {},
    });
  });
}

async function routeForCommunication(
  scope: RuntimeScope,
  actionType: "send_message" | "notify_group" | "place_call",
  channel: UniversalCommunicationChannel,
  recipient: PartyRef,
  explicitIdentityId?: string,
): Promise<ExecutionRouteDecision> {
  let explicitIdentity: Awaited<ReturnType<typeof listAvailableIdentityAccess>>["communicationIdentities"][number] | undefined;
  if (explicitIdentityId) {
    if (!scope.actorId) throw new Error("An explicit communication identity requires an authenticated employee");
    const access = await listAvailableIdentityAccess(scope.tenantId, scope.actorId);
    explicitIdentity = access.communicationIdentities.find((identity) => identity.id === explicitIdentityId && identity.status === "active" && identity.channel === channel);
    if (!explicitIdentity) throw new Error("Explicit communication identity is not available to this actor for the requested channel");
  }
  if (channel === "internal") {
    if (explicitIdentity) throw new Error("Internal messages do not accept an external communication identity");
    return INTERNAL_PARTIES.has(recipient.partyType)
      ? decideUniversalActionRoute({ actionType, channel, recipient })
      : { route: "manual", executable: false, reasonCode: "manual_required", provider: null, hierarchyRank: 4 };
  }
  if (explicitIdentity) {
    const compatible = (channel === "email" && explicitIdentity.provider === "gmail")
      || (channel === "voice" && explicitIdentity.provider === "vapi");
    return decideUniversalActionRoute({
      actionType,
      channel,
      recipient,
      apiAvailable: compatible,
      provider: explicitIdentity.provider,
    });
  }
  let provider: string | null = channel === "email" ? "gmail" : channel === "voice" ? "vapi" : null;
  let available = false;
  if (scope.actorId) {
    const access = await listAvailableIdentityAccess(scope.tenantId, scope.actorId).catch(() => null);
    const identity = access?.communicationIdentities.find((item) => item.channel === channel && item.status === "active");
    available = Boolean(identity && (
      (channel === "email" && identity.provider === "gmail")
      || (channel === "voice" && identity.provider === "vapi")
    ));
    provider = available ? identity?.provider ?? provider : provider;
  }
  return decideUniversalActionRoute({ actionType, channel, recipient, apiAvailable: available, provider });
}

interface CommunicationPlan {
  channel: UniversalCommunicationChannel;
  route: ExecutionRouteDecision;
  targets: Array<{ recipient: PartyRef; endpoint?: string }>;
}

async function planCommunicationChannel(params: {
  scope: RuntimeScope;
  actionType: "send_message" | "notify_group" | "place_call";
  recipient: PartyRef;
  channel: UniversalCommunicationChannel;
  explicitIdentityId?: string;
}): Promise<CommunicationPlan> {
  const route = await routeForCommunication(params.scope, params.actionType, params.channel, params.recipient, params.explicitIdentityId);
  if (!route.executable) return { channel: params.channel, route, targets: [{ recipient: params.recipient }] };
  if (params.channel === "internal") {
    const recipients = params.actionType === "notify_group"
      ? await expandInternalRecipients(params.scope.tenantId, params.recipient)
      : [params.recipient];
    return { channel: params.channel, route, targets: recipients.map((recipient) => ({ recipient })) };
  }
  const targets = await resolveCommunicationTargets(params.scope.tenantId, params.recipient, params.channel, params.scope.actorId);
  return { channel: params.channel, route, targets: targets.map((target) => ({ recipient: target.recipient, endpoint: target.endpoint })) };
}

async function ensureDelivery(params: {
  scope: RuntimeScope;
  recipient: PartyRef;
  channel: UniversalCommunicationChannel;
  route: ExecutionRouteDecision;
  workId?: string;
}) {
  return withTenant(params.scope.tenantId, async (db) => {
    const [created] = await db.insert(communicationDeliveries).values({
      tenantId: params.scope.tenantId,
      domainActionId: params.scope.domainActionId,
      workId: params.workId ?? null,
      recipientType: params.recipient.partyType,
      recipientId: params.recipient.partyId,
      channel: params.channel,
      route: params.route.route,
      status: params.route.executable ? "queued" : "failed",
      provider: params.route.provider,
      communicationIdentityId: null,
      errorCode: params.route.executable ? null : params.route.reasonCode,
    }).onConflictDoNothing().returning();
    if (created) return created;
    const [existing] = await db.select().from(communicationDeliveries).where(and(
      eq(communicationDeliveries.domainActionId, params.scope.domainActionId),
      eq(communicationDeliveries.recipientType, params.recipient.partyType),
      eq(communicationDeliveries.recipientId, params.recipient.partyId),
      eq(communicationDeliveries.channel, params.channel),
    )).limit(1);
    if (!existing) throw new Error("Communication delivery idempotency row was not found");
    return existing;
  });
}

function providerReference(output: Record<string, unknown>): string | null {
  for (const key of ["messageId", "callId", "id"]) if (typeof output[key] === "string") return String(output[key]);
  return null;
}

async function dispatchOne(params: {
  scope: RuntimeScope;
  tools: ToolRegistry;
  actionType: "send_message" | "notify_group" | "place_call";
  recipient: PartyRef;
  endpoint?: string;
  channel: UniversalCommunicationChannel;
  route: ExecutionRouteDecision;
  body: string;
  subject?: string;
  workId?: string;
}) {
  const delivery = await ensureDelivery(params);
  if (["sent", "delivered"].includes(delivery.status)) {
    return { deliveryId: delivery.id, recipient: params.recipient, status: delivery.status, route: params.route.route, communicationIdentityId: delivery.communicationIdentityId, duplicate: true };
  }
  if (delivery.status === "unknown") {
    return { deliveryId: delivery.id, recipient: params.recipient, status: "unknown", route: params.route.route, communicationIdentityId: delivery.communicationIdentityId, duplicate: true };
  }
  if (!params.route.executable) {
    return { deliveryId: delivery.id, recipient: params.recipient, status: "failed", route: params.route.route, reasonCode: params.route.reasonCode };
  }
  if (params.channel === "internal") {
    await withTenant(params.scope.tenantId, (db) => db.update(communicationDeliveries).set({ status: "delivered", updatedAt: new Date() }).where(eq(communicationDeliveries.id, delivery.id)));
    return { deliveryId: delivery.id, recipient: params.recipient, status: "delivered", route: "native" as const };
  }
  if (!params.endpoint) throw new Error("No execution endpoint was resolved for the requested channel");

  const result = params.channel === "email"
    ? await params.tools.callIdempotent("send_email", { to: params.endpoint, subject: params.subject!, body: params.body }, `delivery:${delivery.id}`)
    : params.channel === "sms"
      ? await params.tools.callIdempotent("send_sms_to_number", { phoneNumber: params.endpoint, message: params.body }, `delivery:${delivery.id}`)
      : await params.tools.callIdempotent("vapi_place_call", { phoneNumber: params.endpoint, instructions: params.body, purpose: params.actionType }, `delivery:${delivery.id}`);
  const status = result.ok ? "sent" : result.errorKind === "unknown_outcome" ? "unknown" : "failed";
  const ref = result.ok ? providerReference(result.output) : null;
  const communicationIdentityId = result.ok && typeof result.output.communicationIdentityId === "string" ? result.output.communicationIdentityId : null;
  await withTenant(params.scope.tenantId, (db) => db.update(communicationDeliveries).set({
    status,
    communicationIdentityId: communicationIdentityId ?? delivery.communicationIdentityId,
    providerMessageRef: ref,
    errorCode: result.ok ? null : result.errorKind ?? "provider_failure",
    updatedAt: new Date(),
  }).where(eq(communicationDeliveries.id, delivery.id)));
  return { deliveryId: delivery.id, recipient: params.recipient, status, route: params.route.route, providerRef: ref, communicationIdentityId, errorKind: result.errorKind };
}

async function executeCommunication(actionType: "send_message" | "notify_group" | "place_call", payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const config = await readConfig(scope.tenantId);
  const recipient = (actionType === "notify_group" ? payload.teamRef : payload.recipient) as PartyRef;
  const requestedChannel: UniversalCommunicationChannel = actionType === "place_call" ? "voice" : payload.channel as UniversalCommunicationChannel;
  await requireParty(scope, recipient);
  if (!config.communication.allowedChannels.includes(requestedChannel) && !config.communication.allowChannelFallback) {
    return { status: "failure" as const, output: { recipient, requestedChannel }, error: `Channel ${requestedChannel} is not allowed by tenant policy`, errorKind: "config" as const };
  }
  const identityId = object(payload.communicationIdentityRef).communicationIdentityId;
  const supportedChannels: UniversalCommunicationChannel[] = actionType === "place_call" ? ["voice"] : ["internal", "email", "sms"];
  // An explicit identity is an exact sender/provider choice. Do not silently route
  // around it even when general tenant fallback is enabled.
  const fallbackChannels = config.communication.allowChannelFallback && typeof identityId !== "string"
    ? config.communication.allowedChannels.filter((candidate) => supportedChannels.includes(candidate) && candidate !== requestedChannel)
    : [];
  const candidateChannels = [requestedChannel, ...fallbackChannels];
  const routeAttempts: Array<{ channel: UniversalCommunicationChannel; route: ExecutionRouteDecision; recipientCount: number }> = [];
  let plan: CommunicationPlan | null = null;
  for (const candidate of candidateChannels) {
    if (!config.communication.allowedChannels.includes(candidate)) continue;
    const candidatePlan = await planCommunicationChannel({
      scope,
      actionType,
      recipient,
      channel: candidate,
      explicitIdentityId: typeof identityId === "string" ? identityId : undefined,
    });
    routeAttempts.push({ channel: candidate, route: candidatePlan.route, recipientCount: candidatePlan.targets.length });
    if (!plan) plan = candidatePlan;
    if (candidatePlan.route.executable && candidatePlan.targets.length > 0) {
      plan = candidatePlan;
      break;
    }
  }
  if (!plan) {
    return { status: "failure" as const, output: { recipient, requestedChannel, routeAttempts }, error: "No tenant-allowed channel is available for this communication", errorKind: "config" as const };
  }
  const { channel, route, targets } = plan;
  const fallbackApplied = channel !== requestedChannel;
  const workId = object(payload.workRef).workId as string | undefined;
  const body = String(actionType === "place_call" ? payload.script ?? payload.objective : payload.body);
  if (targets.length === 0) {
    return { status: "failure" as const, output: { recipient, requestedChannel, channel, fallbackApplied, route, routeAttempts }, error: "No active recipient has an endpoint for any eligible channel", errorKind: "validation" as const };
  }
  if (targets.length > config.communication.maxGroupRecipients) {
    return { status: "failure" as const, output: { recipient, channel, recipientCount: targets.length }, error: "Resolved group exceeds the tenant recipient cap", errorKind: "config" as const };
  }
  const deliveries = [];
  for (const target of targets) {
    deliveries.push(await dispatchOne({ scope, tools, actionType, recipient: target.recipient, endpoint: target.endpoint, channel, route, body, subject: payload.subject ? String(payload.subject) : undefined, workId }));
  }
  const counts = deliveries.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
  const usedIdentityIds = [...new Set(deliveries.map((row) => row.communicationIdentityId).filter((id): id is string => typeof id === "string"))];
  await appendUniversalEvent({ scope, actionType, eventType: "communication_dispatched", route: route.route, subject: { type: recipient.partyType, id: recipient.partyId }, communicationIdentityId: usedIdentityIds.length === 1 ? usedIdentityIds[0] : null, evidence: { requestedChannel, selectedChannel: channel, fallbackApplied, requestedCommunicationIdentityId: typeof identityId === "string" ? identityId : null, routeAttempts, recipientCount: targets.length, counts, deliveryIds: deliveries.map((row) => row.deliveryId), communicationIdentityIds: usedIdentityIds } });
  const unavailable = deliveries.some((row) => row.status === "failed" || row.status === "unknown");
  return unavailable
    ? { status: "integration_unavailable" as const, output: { recipient, requestedChannel, channel, fallbackApplied, route, routeAttempts, deliveries, counts }, error: deliveries.some((row) => row.status === "unknown") ? "A provider outcome is unknown and requires reconciliation" : `The selected route could not deliver to every recipient`, errorKind: deliveries.some((row) => row.status === "unknown") ? "unknown_outcome" as const : "config" as const }
    : { status: "success" as const, output: { recipient, requestedChannel, channel, fallbackApplied, route, routeAttempts, deliveries, counts }, expected: { deliveryCount: deliveries.length } };
}

async function executeRequestAcknowledgement(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const config = await readConfig(scope.tenantId);
  const recipient = payload.recipient as PartyRef;
  await requireParty(scope, recipient);
  const deadline = payload.deadline ? new Date(String(payload.deadline)) : new Date(Date.now() + config.acknowledgements.defaultDeadlineMinutes * 60_000);
  const workId = object(payload.workRef).workId as string | undefined;
  const taskId = object(payload.taskRef).taskId as string | undefined;
  const delegationId = object(payload.delegationRef).delegationId as string | undefined;
  const internal = INTERNAL_PARTIES.has(recipient.partyType);
  const route: ExecutionRouteDecision = internal
    ? { route: "native", executable: true, reasonCode: "native_system_of_record", provider: null, hierarchyRank: 0 }
    : { route: "manual", executable: false, reasonCode: "manual_required", provider: null, hierarchyRank: 4 };
  const requestRow = await withTenant(scope.tenantId, async (db) => {
    const [prior] = await db.select().from(acknowledgementRequests).where(eq(acknowledgementRequests.domainActionId, scope.domainActionId)).limit(1);
    if (prior) return prior;
    let deliveryId: string | null = null;
    if (internal) {
      const [createdDelivery] = await db.insert(communicationDeliveries).values({
        tenantId: scope.tenantId,
        domainActionId: scope.domainActionId,
        workId: workId ?? null,
        recipientType: recipient.partyType,
        recipientId: recipient.partyId,
        channel: "internal",
        route: "native",
        status: "delivered",
        provider: null,
      }).onConflictDoNothing().returning();
      if (createdDelivery) deliveryId = createdDelivery.id;
      else {
        const [existingDelivery] = await db.select({ id: communicationDeliveries.id }).from(communicationDeliveries).where(and(
          eq(communicationDeliveries.domainActionId, scope.domainActionId),
          eq(communicationDeliveries.recipientType, recipient.partyType),
          eq(communicationDeliveries.recipientId, recipient.partyId),
          eq(communicationDeliveries.channel, "internal"),
        )).limit(1);
        if (!existingDelivery) throw new Error("Acknowledgement delivery idempotency row was not found");
        deliveryId = existingDelivery.id;
      }
    }
    const [created] = await db.insert(acknowledgementRequests).values({
      tenantId: scope.tenantId,
      domainActionId: scope.domainActionId,
      deliveryId,
      delegationId: delegationId ?? null,
      workId: workId ?? null,
      taskId: taskId ?? null,
      recipientType: recipient.partyType,
      recipientId: recipient.partyId,
      request: String(payload.request),
      status: internal ? "delivered" : "requested",
      deadline,
    }).onConflictDoNothing().returning();
    if (created) return created;
    const [existing] = await db.select().from(acknowledgementRequests).where(eq(acknowledgementRequests.domainActionId, scope.domainActionId)).limit(1);
    if (!existing) throw new Error("Acknowledgement idempotency row was not found");
    return existing;
  });
  await appendUniversalEvent({ scope, actionType: "request_acknowledgement", eventType: internal ? "acknowledgement_request_delivered" : "acknowledgement_request_pending_manual", route: route.route, subject: { type: recipient.partyType, id: recipient.partyId }, evidence: { acknowledgementRequestId: requestRow.id, deliveryId: requestRow.deliveryId, status: requestRow.status, acknowledged: false, deadline: requestRow.deadline?.toISOString() ?? null } });
  return internal
    ? { status: "success" as const, output: { acknowledgementRequestId: requestRow.id, deliveryRef: requestRow.deliveryId ? { communicationDeliveryId: requestRow.deliveryId } : null, recipient, status: requestRow.status, deadline: requestRow.deadline?.toISOString() ?? null, route }, expected: { delivered: true, acknowledged: false } }
    : { status: "integration_unavailable" as const, output: { acknowledgementRequestId: requestRow.id, deliveryRef: null, recipient, status: requestRow.status, deadline: requestRow.deadline?.toISOString() ?? null, route }, error: "External acknowledgement request requires an explicit delivery channel", errorKind: "config" as const };
}

async function executeCreateTask(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const subject = payload.subjectRef as { entityType: string; entityId: string };
  await requireCanonicalEntity(scope.tenantId, subject);
  const assignee = payload.assigneeRef as PartyRef | undefined;
  if (assignee) await requireParty(scope, assignee);
  const workId = object(payload.workRef).workId as string | undefined;
  const row = await withTenant(scope.tenantId, async (db) => {
    const [created] = await db.insert(tasks).values({
      tenantId: scope.tenantId,
      subjectType: subject.entityType,
      subjectId: subject.entityId,
      title: String(payload.title),
      dueAt: payload.dueAt ? new Date(String(payload.dueAt)) : null,
      assignedPartyType: assignee?.partyType === "employee" || assignee?.partyType === "team" ? assignee.partyType : null,
      assignedPartyId: assignee?.partyId ?? null,
      assigneeType: assignee?.partyType === "employee" ? "user" : null,
      assigneeId: assignee?.partyType === "employee" ? assignee.partyId : null,
      workId: workId ?? null,
      sourceDomainActionId: scope.domainActionId,
      priority: payload.priority as "low" | "normal" | "high",
    }).onConflictDoNothing().returning();
    if (created) {
      await db.insert(businessEvents).values({ tenantId: scope.tenantId, entityType: "task", entityId: created.id, eventType: "task_created", payload: { domainActionId: scope.domainActionId, assignee: assignee ?? null }, source: "universal_action" });
      return created;
    }
    const [existing] = await db.select().from(tasks).where(eq(tasks.sourceDomainActionId, scope.domainActionId)).limit(1);
    if (!existing) throw new Error("Task idempotency row was not found");
    return existing;
  });
  await appendUniversalEvent({ scope, actionType: "create_task", eventType: "task_created", route: "native", subject: { type: "task", id: row.id }, evidence: { taskId: row.id, workId: row.workId, assignee: assignee ?? null } });
  return { status: "success" as const, output: { taskRef: { taskId: row.id }, status: row.status, assignee: assignee ?? null, route: decideUniversalActionRoute({ actionType: "create_task" }) }, expected: { taskId: row.id } };
}

async function executeAssignTask(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const taskId = String(object(payload.taskRef).taskId);
  const assignee = payload.assigneeRef as PartyRef;
  await requireParty(scope, assignee);
  const row = await withTenant(scope.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${tasks} WHERE ${tasks.tenantId}=${scope.tenantId} AND ${tasks.id}=${taskId}::uuid FOR UPDATE`);
    const [updated] = await db.update(tasks).set({
      assignedPartyType: assignee.partyType as "employee" | "team",
      assignedPartyId: assignee.partyId,
      assigneeType: assignee.partyType === "employee" ? "user" : null,
      assigneeId: assignee.partyType === "employee" ? assignee.partyId : null,
      updatedAt: new Date(),
    }).where(and(eq(tasks.tenantId, scope.tenantId), eq(tasks.id, taskId))).returning();
    if (!updated) throw new Error("Task not found");
    await db.insert(businessEvents).values({ tenantId: scope.tenantId, entityType: "task", entityId: updated.id, eventType: "task_assigned", payload: { domainActionId: scope.domainActionId, assignee }, source: "universal_action" });
    return updated;
  });
  await appendUniversalEvent({ scope, actionType: "assign_task", eventType: "task_assigned", route: "native", subject: { type: "task", id: row.id }, evidence: { taskId: row.id, assignee } });
  return { status: "success" as const, output: { taskRef: { taskId: row.id }, assignee, route: decideUniversalActionRoute({ actionType: "assign_task" }) }, expected: { assigned: true } };
}

async function executeUpdateTask(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const taskId = String(object(payload.taskRef).taskId);
  const row = await withTenant(scope.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${tasks} WHERE ${tasks.tenantId}=${scope.tenantId} AND ${tasks.id}=${taskId}::uuid FOR UPDATE`);
    const [existing] = await db.select().from(tasks).where(and(eq(tasks.tenantId, scope.tenantId), eq(tasks.id, taskId))).limit(1);
    if (!existing) throw new Error("Task not found");
    const [updated] = await db.update(tasks).set({
      ...(payload.title !== undefined ? { title: String(payload.title) } : {}),
      ...(payload.dueAt !== undefined ? { dueAt: payload.dueAt === null ? null : new Date(String(payload.dueAt)) } : {}),
      ...(payload.status !== undefined ? { status: payload.status as "open" | "done" | "cancelled" } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority as "low" | "normal" | "high" } : {}),
      updatedAt: new Date(),
    }).where(and(eq(tasks.tenantId, scope.tenantId), eq(tasks.id, taskId))).returning();
    await db.insert(businessEvents).values({ tenantId: scope.tenantId, entityType: "task", entityId: taskId, eventType: "task_updated", payload: { domainActionId: scope.domainActionId, status: updated!.status }, source: "universal_action" });
    return updated!;
  });
  if (row.status === "done") {
    const [linked] = await withTenant(scope.tenantId, (db) => db.select({ id: delegations.id, status: delegations.status }).from(delegations).where(and(eq(delegations.tenantId, scope.tenantId), eq(delegations.taskId, row.id))).limit(1));
    if (linked?.status === "accepted") await completeDelegation({ tenantId: scope.tenantId, delegationId: linked.id, actorId: scope.actorId, evidence: { taskId: row.id } });
  }
  await appendUniversalEvent({ scope, actionType: "update_task", eventType: "task_updated", route: "native", subject: { type: "task", id: row.id }, evidence: { taskId: row.id, status: row.status, priority: row.priority } });
  return { status: "success" as const, output: { taskRef: { taskId: row.id }, status: row.status, priority: row.priority, dueAt: row.dueAt?.toISOString() ?? null, route: decideUniversalActionRoute({ actionType: "update_task" }) }, expected: { updated: true } };
}

async function executeHandoffWork(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  if (!scope.actorId) throw new Error("Work handoff requires an authenticated employee");
  const workId = String(object(payload.workRef).workId);
  const target = payload.targetEmployeeRef as PartyRef;
  await requireParty(scope, target);
  const authority = await employeeAuthoritySnapshot({ tenantId: scope.tenantId, userId: scope.actorId, employeeId: scope.actorId, role: "owner" });
  const result = await handoffWork({ tenantId: scope.tenantId, workId, actorId: scope.actorId, targetEmployeeId: target.partyId, note: payload.note ? String(payload.note) : undefined, authorityContext: { revision: authority.revision, roles: authority.roles } });
  await appendUniversalEvent({ scope, actionType: "handoff_work", eventType: "work_handed_off", route: "native", subject: { type: "work", id: workId }, evidence: { previousOwnerId: result.previousOwnerId, currentOwnerId: result.currentOwnerId, workEventSequence: result.eventSequence } });
  return { status: "success" as const, output: { workRef: { workId }, targetEmployeeRef: target, duplicate: result.duplicate, route: decideUniversalActionRoute({ actionType: "handoff_work" }) }, expected: { currentOwnerId: target.partyId } };
}

async function executeDelegateObjective(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const config = await readConfig(scope.tenantId);
  const target = payload.targetRef as PartyRef;
  await requireParty(scope, target);
  const workId = String(object(payload.workRef).workId);
  const requestedTaskId = object(payload.taskRef).taskId as string | undefined;
  const objectiveLoopId = object(payload.objectiveLoopRef).objectiveLoopId as string | undefined;
  const acknowledgementDeadline = payload.acknowledgementDeadline ? new Date(String(payload.acknowledgementDeadline)) : new Date(Date.now() + config.delegations.defaultAckDeadlineMinutes * 60_000);
  const completionDeadline = payload.completionDeadline ? new Date(String(payload.completionDeadline)) : new Date(Date.now() + config.delegations.defaultCompletionHours * 3_600_000);
  const escalation = payload.escalationTargetRef as PartyRef | undefined;
  if (escalation) await requireParty(scope, escalation);
  const evidenceRefs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [];
  for (const evidenceRef of evidenceRefs) await requireCanonicalEntity(scope.tenantId, evidenceRef as { entityType: string; entityId: string });

  const row = await withTenant(scope.tenantId, async (db) => {
    const [existing] = await db.select().from(delegations).where(eq(delegations.domainActionId, scope.domainActionId)).limit(1);
    if (existing) return existing;
    let taskId = requestedTaskId;
    if (taskId) {
      const [task] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.tenantId, scope.tenantId), eq(tasks.id, taskId))).limit(1);
      if (!task) throw new Error("Delegation task does not exist in this tenant");
    } else {
      const [task] = await db.insert(tasks).values({
        tenantId: scope.tenantId,
        subjectType: "work",
        subjectId: workId,
        title: String(payload.objective),
        dueAt: completionDeadline,
        assignedPartyType: target.partyType as "employee" | "team",
        assignedPartyId: target.partyId,
        assigneeType: target.partyType === "employee" ? "user" : null,
        assigneeId: target.partyType === "employee" ? target.partyId : null,
        workId,
        sourceDomainActionId: scope.domainActionId,
        priority: "high",
      }).returning();
      taskId = task!.id;
    }
    const [created] = await db.insert(delegations).values({
      tenantId: scope.tenantId,
      domainActionId: scope.domainActionId,
      workId,
      taskId,
      objectiveLoopId: objectiveLoopId ?? null,
      createdBy: scope.actorId ?? null,
      targetType: target.partyType,
      targetId: target.partyId,
      objective: String(payload.objective),
      intent: { objective: String(payload.objective), target },
      status: "created",
      acknowledgementDeadline,
      completionDeadline,
      escalationTargetType: escalation?.partyType ?? null,
      escalationTargetId: escalation?.partyId ?? null,
      escalationRule: { onAcknowledgementDeadline: "overdue", onCompletionDeadline: "overdue" },
      evidenceRefs,
    }).returning();
    await db.insert(delegationEvents).values({ tenantId: scope.tenantId, delegationId: created!.id, seq: 1, eventType: "created", fromStatus: null, toStatus: "created", actorId: scope.actorId ?? null, evidence: { workId, taskId, objectiveLoopId: objectiveLoopId ?? null } });
    const [delivery] = await db.insert(communicationDeliveries).values({ tenantId: scope.tenantId, domainActionId: scope.domainActionId, workId, recipientType: target.partyType, recipientId: target.partyId, channel: "internal", route: "native", status: "delivered", provider: null }).returning();
    await db.insert(acknowledgementRequests).values({ tenantId: scope.tenantId, domainActionId: scope.domainActionId, delegationId: created!.id, deliveryId: delivery!.id, workId, taskId, recipientType: target.partyType, recipientId: target.partyId, request: `Acknowledge delegated objective: ${String(payload.objective)}`, status: "delivered", deadline: acknowledgementDeadline });
    await db.insert(businessEvents).values({ tenantId: scope.tenantId, entityType: "delegation", entityId: created!.id, eventType: "delegation_created", payload: { domainActionId: scope.domainActionId, workId, taskId, target }, source: "universal_action" });
    return created!;
  });
  let status = row.status as DelegationStatus;
  if (status === "created") status = (await transitionDelegation({ tenantId: scope.tenantId, delegationId: row.id, to: "sent", eventType: "sent", actorId: scope.actorId, evidence: { route: "native" } })).to;
  if (status === "sent") status = (await transitionDelegation({ tenantId: scope.tenantId, delegationId: row.id, to: "delivered", eventType: "delivered", actorId: scope.actorId, evidence: { route: "native" } })).to;
  await appendUniversalEvent({ scope, actionType: "delegate_objective", eventType: "objective_delegated", route: "native", subject: { type: "delegation", id: row.id }, evidence: { delegationId: row.id, workId: row.workId, taskId: row.taskId, target, status } });
  return { status: "success" as const, output: { delegationRef: { delegationId: row.id }, workRef: { workId }, taskRef: row.taskId ? { taskId: row.taskId } : null, target, delegationStatus: status, acknowledgementDeadline: row.acknowledgementDeadline?.toISOString() ?? acknowledgementDeadline.toISOString(), completionDeadline: row.completionDeadline?.toISOString() ?? completionDeadline.toISOString(), route: decideUniversalActionRoute({ actionType: "delegate_objective" }) }, expected: { acknowledged: false, accepted: false, completed: false } };
}

async function executeEscalateWork(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const delegationId = String(object(payload.delegationRef).delegationId);
  const target = payload.targetRef as PartyRef | undefined;
  if (target) await requireParty(scope, target);
  const evidenceRefs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [];
  for (const evidenceRef of evidenceRefs) await requireCanonicalEntity(scope.tenantId, evidenceRef as { entityType: string; entityId: string });
  await withTenant(scope.tenantId, async (db) => {
    const [row] = await db.select().from(delegations).where(and(eq(delegations.tenantId, scope.tenantId), eq(delegations.id, delegationId))).limit(1);
    if (!row) throw new Error("Delegation not found");
    await db.update(delegations).set({ escalationTargetType: target?.partyType ?? row.escalationTargetType, escalationTargetId: target?.partyId ?? row.escalationTargetId, evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : row.evidenceRefs, updatedAt: new Date() }).where(eq(delegations.id, row.id));
  });
  const transition = await transitionDelegation({ tenantId: scope.tenantId, delegationId, to: "escalated", eventType: "escalated", actorId: scope.actorId, evidence: { reason: payload.reason, target: target ?? null, evidenceRefs } });
  await appendUniversalEvent({ scope, actionType: "escalate_work", eventType: "delegation_escalated", route: "native", subject: { type: "delegation", id: delegationId }, evidence: { delegationId, target: target ?? null, eventSequence: transition.eventSequence } });
  return { status: "success" as const, output: { delegationRef: { delegationId }, delegationStatus: "escalated", target: target ?? null, route: decideUniversalActionRoute({ actionType: "escalate_work" }) }, expected: { escalated: true } };
}

async function executeCancelDelegation(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const delegationId = String(object(payload.delegationRef).delegationId);
  const transition = await transitionDelegation({ tenantId: scope.tenantId, delegationId, to: "cancelled", eventType: "cancelled", actorId: scope.actorId, evidence: { reason: payload.reason } });
  await withTenant(scope.tenantId, (db) => db.update(acknowledgementRequests).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(acknowledgementRequests.tenantId, scope.tenantId), eq(acknowledgementRequests.delegationId, delegationId), sql`${acknowledgementRequests.status} IN ('requested','delivered')`)));
  await appendUniversalEvent({ scope, actionType: "cancel_delegation", eventType: "delegation_cancelled", route: "native", subject: { type: "delegation", id: delegationId }, evidence: { delegationId, eventSequence: transition.eventSequence } });
  return { status: "success" as const, output: { delegationRef: { delegationId }, delegationStatus: "cancelled", duplicate: transition.duplicate, route: decideUniversalActionRoute({ actionType: "cancel_delegation" }) }, expected: { cancelled: true } };
}

async function executeScheduleInternalEvent(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const participants = payload.participants as PartyRef[];
  for (const participant of participants) await requireParty(scope, participant);
  const workId = object(payload.workRef).workId as string | undefined;
  const locationId = object(payload.locationRef).locationId as string | undefined;
  if (locationId) await requireParty(scope, { partyType: "location", partyId: locationId });
  const row = await withTenant(scope.tenantId, async (db) => {
    const [existing] = await db.select().from(internalEvents).where(eq(internalEvents.originDomainActionId, scope.domainActionId)).limit(1);
    if (existing) return existing;
    const [created] = await db.insert(internalEvents).values({ tenantId: scope.tenantId, originDomainActionId: scope.domainActionId, lastDomainActionId: scope.domainActionId, workId: workId ?? null, locationId: locationId ?? null, title: String(payload.title), purpose: payload.purpose ? String(payload.purpose) : null, startsAt: new Date(String(payload.startsAt)), endsAt: new Date(String(payload.endsAt)), status: "scheduled", revision: 1, createdBy: scope.actorId ?? null }).returning();
    for (const participant of [...new Map(participants.map((item) => [`${item.partyType}:${item.partyId}`, item])).values()]) {
      await db.insert(internalEventParticipants).values({ tenantId: scope.tenantId, internalEventId: created!.id, partyType: participant.partyType, partyId: participant.partyId }).onConflictDoNothing();
    }
    await db.insert(internalEventEvents).values({ tenantId: scope.tenantId, internalEventId: created!.id, domainActionId: scope.domainActionId, seq: 1, eventType: "scheduled", payload: { startsAt: payload.startsAt, endsAt: payload.endsAt, participantCount: participants.length } });
    await db.insert(businessEvents).values({ tenantId: scope.tenantId, entityType: "internal_event", entityId: created!.id, eventType: "internal_event_scheduled", payload: { domainActionId: scope.domainActionId, workId: workId ?? null }, source: "universal_action" });
    return created!;
  });
  await appendUniversalEvent({ scope, actionType: "schedule_internal_event", eventType: "internal_event_scheduled", route: "native", subject: { type: "internal_event", id: row.id }, evidence: { internalEventId: row.id, revision: row.revision, participantCount: participants.length } });
  return { status: "success" as const, output: { internalEventRef: { internalEventId: row.id }, status: row.status, revision: row.revision, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), participantCount: participants.length, route: decideUniversalActionRoute({ actionType: "schedule_internal_event" }) }, expected: { scheduled: true } };
}

async function executeRescheduleInternalEvent(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const eventId = String(object(payload.internalEventRef).internalEventId);
  const row = await withTenant(scope.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${internalEvents} WHERE ${internalEvents.tenantId}=${scope.tenantId} AND ${internalEvents.id}=${eventId}::uuid FOR UPDATE`);
    const [prior] = await db.select().from(internalEvents).where(and(eq(internalEvents.tenantId, scope.tenantId), eq(internalEvents.id, eventId))).limit(1);
    if (!prior) throw new Error("Internal event not found");
    const [duplicate] = await db.select().from(internalEventEvents).where(eq(internalEventEvents.domainActionId, scope.domainActionId)).limit(1);
    if (duplicate) return prior;
    if (prior.status === "cancelled" || prior.status === "completed") throw new Error(`Cannot reschedule an event in ${prior.status} state`);
    const revision = prior.revision + 1;
    const [updated] = await db.update(internalEvents).set({ startsAt: new Date(String(payload.startsAt)), endsAt: new Date(String(payload.endsAt)), status: "rescheduled", revision, lastDomainActionId: scope.domainActionId, updatedAt: new Date() }).where(eq(internalEvents.id, prior.id)).returning();
    const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${internalEventEvents.seq}),0)::int` }).from(internalEventEvents).where(eq(internalEventEvents.internalEventId, prior.id));
    await db.insert(internalEventEvents).values({ tenantId: scope.tenantId, internalEventId: prior.id, domainActionId: scope.domainActionId, seq: (latest?.maxSeq ?? 0) + 1, eventType: "rescheduled", payload: { priorStartsAt: prior.startsAt.toISOString(), priorEndsAt: prior.endsAt.toISOString(), startsAt: payload.startsAt, endsAt: payload.endsAt, reason: payload.reason, revision } });
    return updated!;
  });
  await appendUniversalEvent({ scope, actionType: "reschedule_internal_event", eventType: "internal_event_rescheduled", route: "native", subject: { type: "internal_event", id: row.id }, evidence: { internalEventId: row.id, revision: row.revision } });
  return { status: "success" as const, output: { internalEventRef: { internalEventId: row.id }, status: row.status, revision: row.revision, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), route: decideUniversalActionRoute({ actionType: "reschedule_internal_event" }) }, expected: { rescheduled: true } };
}

async function executeShareDocument(payload: Record<string, unknown>, tools: ToolRegistry) {
  const scope = requireScope(tools);
  const config = await readConfig(scope.tenantId);
  const documentId = String(object(payload.documentRef).documentId);
  const recipient = payload.recipient as PartyRef;
  await requireParty(scope, recipient);
  const [document] = await withTenant(scope.tenantId, (db) => db.select({ id: documents.id }).from(documents).where(and(eq(documents.tenantId, scope.tenantId), eq(documents.id, documentId))).limit(1));
  if (!document) throw new Error("Document not found in this tenant");
  const internal = INTERNAL_PARTIES.has(recipient.partyType);
  // Phase 2 has no browser/computer executor and no provider-neutral document ACL API.
  // External sharing therefore stays manual even when policy permits it.
  const route = internal
    ? decideUniversalActionRoute({ actionType: "share_document", recipient })
    : decideUniversalActionRoute({ actionType: "share_document", recipient, externalSharingAllowed: config.documentSharing.allowExternal, apiAvailable: false });
  const row = await withTenant(scope.tenantId, async (db) => {
    const [created] = await db.insert(documentShares).values({ tenantId: scope.tenantId, domainActionId: scope.domainActionId, documentId, recipientType: recipient.partyType, recipientId: recipient.partyId, accessLevel: payload.accessLevel as "view" | "comment", route: route.route, status: route.executable ? "shared" : "pending_manual" }).onConflictDoNothing().returning();
    if (created) return created;
    const [existing] = await db.select().from(documentShares).where(eq(documentShares.domainActionId, scope.domainActionId)).limit(1);
    if (!existing) throw new Error("Document share idempotency row was not found");
    return existing;
  });
  await appendUniversalEvent({ scope, actionType: "share_document", eventType: route.executable ? "document_shared" : "document_share_pending_manual", route: route.route, subject: { type: "document_share", id: row.id }, evidence: { documentShareId: row.id, documentId, recipient, accessLevel: row.accessLevel, status: row.status } });
  return route.executable
    ? { status: "success" as const, output: { documentShareRef: { documentShareId: row.id }, documentRef: { documentId }, recipient, accessLevel: row.accessLevel, status: row.status, route }, expected: { shared: true } }
    : { status: "integration_unavailable" as const, output: { documentShareRef: { documentShareId: row.id }, documentRef: { documentId }, recipient, accessLevel: row.accessLevel, status: row.status, route }, error: route.reasonCode === "external_sharing_disallowed" ? "External document sharing is disabled by tenant policy" : "No executable external document-sharing adapter is configured", errorKind: "config" as const };
}

export async function executeUniversalAction(actionType: UniversalActionType, payload: Record<string, unknown>, tools: ToolRegistry) {
  switch (actionType) {
    case "send_message":
    case "notify_group":
    case "place_call": return executeCommunication(actionType, payload, tools);
    case "request_acknowledgement": return executeRequestAcknowledgement(payload, tools);
    case "create_task": return executeCreateTask(payload, tools);
    case "assign_task": return executeAssignTask(payload, tools);
    case "update_task": return executeUpdateTask(payload, tools);
    case "handoff_work": return executeHandoffWork(payload, tools);
    case "delegate_objective": return executeDelegateObjective(payload, tools);
    case "escalate_work": return executeEscalateWork(payload, tools);
    case "cancel_delegation": return executeCancelDelegation(payload, tools);
    case "schedule_internal_event": return executeScheduleInternalEvent(payload, tools);
    case "reschedule_internal_event": return executeRescheduleInternalEvent(payload, tools);
    case "share_document": return executeShareDocument(payload, tools);
  }
}
