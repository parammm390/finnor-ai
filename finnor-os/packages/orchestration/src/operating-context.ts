import {
  CANONICAL_ENTITY_TYPES,
  canonicalEntityRefToPartyRef,
  OPERATING_INTERACTION_PRECEDENCE,
  OPERATING_TRUTH_PRECEDENCE,
  type CanonicalEntityRef,
  type EmployeeConversationContext,
  type MemorySnapshot,
  type OperatingCompanyDirectory,
  type OperatingContext,
  type OperatingInteractionContext,
  type OperatingSourceRef,
  type PartyRef,
  type TenantContext,
} from "@finnor/shared-types";
import { OperatingInteractionContextSchema } from "@finnor/policy-schema";
import {
  tenantOperatingProfiles,
  tenants,
  userOperatingProfiles,
  users,
  withTenant,
  workEntityLinks,
  works,
  acknowledgementRequests,
  delegations,
  internalEventParticipants,
  internalEvents,
  orgUnitMemberships,
  tenantSettings,
  canonicalTruthRegistry,
  resolveTenantVertical,
} from "@finnor/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { buildMemorySnapshot } from "@finnor/memory";
import { loadOperatingDirectoryContext, resolveHouseholdMention } from "@finnor/read-models";
import { buildPlanningHealthContext } from "./planning-health";
import { listAvailableIdentityAccess } from "@finnor/security";
import { resolvePrivateEquityDealReference } from "@finnor/private-equity";
import { executeTenantOperationalQuery } from "./operational-query-runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 20)
    : [];
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function emptyMemory(): MemorySnapshot {
  return { shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null };
}

function profileSource(source: string, ref: string, asOf: string | null): OperatingSourceRef {
  return { kind: "PROFILE", source, ref, asOf: asOf ?? new Date().toISOString(), role: "context_only" };
}

function emptyCompanyDirectory(): OperatingCompanyDirectory {
  return {
    employee: null,
    teams: [],
    locations: [],
    reporting: { manager: null, reports: [], backups: [], assistants: [] },
    currentWork: [],
    currentTasks: [],
    authorityRoles: [],
    referencedParties: [],
    sourceTables: [],
  };
}

function emptyIdentityAccess(): OperatingContext["identityAccess"] {
  return { communicationIdentities: [], applicationAccounts: [], authProfiles: [] };
}

function emptyUniversalActions(): OperatingContext["universalActions"] {
  return {
    capabilities: { allowedChannels: ["internal", "email", "sms", "voice"], allowChannelFallback: false, maxGroupRecipients: 50, externalDocumentSharing: false, externalCalendarMode: "internal_only", browserExecutable: false, computerExecutable: false },
    activeDelegations: [],
    pendingAcknowledgements: [],
    upcomingInternalEvents: [],
  };
}

export interface AssembleOperatingContextOptions {
  instruction: string;
  workId?: string;
  sessionId?: string;
  householdId?: string;
  activeContext?: OperatingInteractionContext | Record<string, unknown>;
  conversationContext?: EmployeeConversationContext;
  /** Semantic memory is deliberately omitted for deterministic live-state reads. */
  includeMemory?: boolean;
  includeSemanticMemory?: boolean;
  /** A bounded current-state summary for the general planner, never for fast reads. */
  includeCanonicalBusinessState?: boolean;
}

export interface AssembledOperatingContext {
  context: OperatingContext;
  memory: MemorySnapshot;
  resolvedHouseholdId?: string;
  mentionedHousehold: { householdId: string; label: string } | null;
}

/**
 * Assemble the authenticated operating frame before planning. Every dependency is
 * fail-visible and bounded: a missing profile remains null, a failed source is listed
 * in context.health, and no lower-precedence source is promoted to canonical truth.
 */
export async function assembleOperatingContext(
  ctx: TenantContext,
  opts: AssembleOperatingContextOptions,
): Promise<AssembledOperatingContext> {
  const assembledAt = new Date().toISOString();
  const errors: string[] = [];
  const missing: string[] = [];
  const sources: OperatingSourceRef[] = [];
  let tenantRow: { id: string; name: string; timezone: string } | undefined;
  let tenantProfile: typeof tenantOperatingProfiles.$inferSelect | undefined;
  let userRow: { id: string; displayName: string | null; role: string } | undefined;
  let userProfile: typeof userOperatingProfiles.$inferSelect | undefined;
  let workRow: typeof works.$inferSelect | undefined;
  let linkedEntities: Array<{ entityType: string; entityId: string }> = [];
  let companyDirectory: OperatingCompanyDirectory = emptyCompanyDirectory();
  let identityAccess: OperatingContext["identityAccess"] = emptyIdentityAccess();
  let universalActions: OperatingContext["universalActions"] = emptyUniversalActions();
  let vertical: Awaited<ReturnType<typeof resolveTenantVertical>> | undefined;
  let registeredEntityTypes = new Set<string>(CANONICAL_ENTITY_TYPES);

  try {
    vertical = await resolveTenantVertical(ctx.tenantId);
  } catch (error) {
    errors.push(`tenant vertical unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const loaded = await withTenant(ctx.tenantId, async (db) => {
      const [tenantResult] = await db
        .select({ id: tenants.id, name: tenants.name, timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId))
        .limit(1);
      const [companyProfile] = await db
        .select()
        .from(tenantOperatingProfiles)
        .where(eq(tenantOperatingProfiles.tenantId, ctx.tenantId))
        .limit(1);
      const [employee] = UUID.test(ctx.userId)
        ? await db
            .select({ id: users.id, displayName: users.displayName, role: users.role })
            .from(users)
            .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.userId)))
            .limit(1)
        : [];
      const [employeeProfile] = UUID.test(ctx.userId)
        ? await db
            .select()
            .from(userOperatingProfiles)
            .where(and(eq(userOperatingProfiles.tenantId, ctx.tenantId), eq(userOperatingProfiles.userId, ctx.userId)))
            .limit(1)
        : [];
      const [activeWork] = opts.workId
        ? await db
            .select()
            .from(works)
            .where(and(eq(works.tenantId, ctx.tenantId), eq(works.id, opts.workId)))
            .limit(1)
        : [];
      const entities = opts.workId
        ? await db
            .select({ entityType: workEntityLinks.entityType, entityId: workEntityLinks.entityId })
            .from(workEntityLinks)
            .where(and(eq(workEntityLinks.tenantId, ctx.tenantId), eq(workEntityLinks.workId, opts.workId)))
        : [];
      const registrations = vertical
        ? await db.select({ entityType: canonicalTruthRegistry.entityType }).from(canonicalTruthRegistry).where(or(
            isNull(canonicalTruthRegistry.verticalKey),
            eq(canonicalTruthRegistry.verticalKey, vertical.verticalKey),
          ))
        : [];
      return { tenantResult, companyProfile, employee, employeeProfile, activeWork, entities, registrations };
    }, UUID.test(ctx.userId) ? ctx.userId : undefined);
    tenantRow = loaded.tenantResult;
    tenantProfile = loaded.companyProfile;
    userRow = loaded.employee;
    userProfile = loaded.employeeProfile;
    workRow = loaded.activeWork;
    linkedEntities = loaded.entities;
    if (loaded.registrations.length > 0) registeredEntityTypes = new Set(loaded.registrations.map((row) => row.entityType));
  } catch (error) {
    errors.push(`profile/work context unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const actorId = ctx.employeeId ?? (UUID.test(ctx.userId) ? ctx.userId : undefined);
    const loaded = await withTenant(ctx.tenantId, async (db) => {
      const [settings] = await db.select({ config: tenantSettings.universalActionConfig, computerConfig: tenantSettings.computerConfig }).from(tenantSettings).where(eq(tenantSettings.tenantId, ctx.tenantId)).limit(1);
      const scope = [
        ...(opts.workId ? [eq(delegations.workId, opts.workId)] : []),
        ...(actorId ? [or(
          and(eq(delegations.targetType, "employee"), eq(delegations.targetId, actorId)),
          sql`${delegations.targetType}='team' AND EXISTS (
            SELECT 1 FROM ${orgUnitMemberships} membership
            WHERE membership.tenant_id=${ctx.tenantId}::uuid
              AND membership.org_unit_id=${delegations.targetId}
              AND membership.employee_id=${actorId}::uuid
              AND membership.active=true
          )`,
        )!] : []),
      ];
      const delegationRows = scope.length > 0 ? await db.select().from(delegations).where(and(
        eq(delegations.tenantId, ctx.tenantId),
        sql`${delegations.status} NOT IN ('completed','declined','cancelled')`,
        or(...scope)!,
      )).orderBy(asc(delegations.acknowledgementDeadline), asc(delegations.completionDeadline)).limit(20) : [];
      const acknowledgementScope = [
        ...(opts.workId ? [eq(acknowledgementRequests.workId, opts.workId)] : []),
        ...(actorId ? [or(
          and(eq(acknowledgementRequests.recipientType, "employee"), eq(acknowledgementRequests.recipientId, actorId)),
          sql`${acknowledgementRequests.recipientType}='team' AND EXISTS (
            SELECT 1 FROM ${orgUnitMemberships} membership
            WHERE membership.tenant_id=${ctx.tenantId}::uuid
              AND membership.org_unit_id=${acknowledgementRequests.recipientId}
              AND membership.employee_id=${actorId}::uuid
              AND membership.active=true
          )`,
        )!] : []),
      ];
      const acknowledgementRows = acknowledgementScope.length > 0 ? await db.select().from(acknowledgementRequests).where(and(
        eq(acknowledgementRequests.tenantId, ctx.tenantId),
        sql`${acknowledgementRequests.status} IN ('requested','delivered')`,
        or(...acknowledgementScope)!,
      )).orderBy(asc(acknowledgementRequests.deadline)).limit(20) : [];
      const eventRows = (opts.workId || actorId) ? await db.select({
        id: internalEvents.id,
        title: internalEvents.title,
        status: internalEvents.status,
        startsAt: internalEvents.startsAt,
        endsAt: internalEvents.endsAt,
      }).from(internalEvents)
        .where(and(
          eq(internalEvents.tenantId, ctx.tenantId),
          sql`${internalEvents.status} IN ('scheduled','rescheduled')`,
          sql`${internalEvents.endsAt} >= now()`,
          or(
            ...(opts.workId ? [eq(internalEvents.workId, opts.workId)] : []),
            ...(actorId ? [sql`EXISTS (
              SELECT 1 FROM ${internalEventParticipants} participant
              WHERE participant.tenant_id=${ctx.tenantId}::uuid
                AND participant.internal_event_id=${internalEvents.id}
                AND (
                  (participant.party_type='employee' AND participant.party_id=${actorId}::uuid)
                  OR (participant.party_type='team' AND EXISTS (
                    SELECT 1 FROM ${orgUnitMemberships} membership
                    WHERE membership.tenant_id=${ctx.tenantId}::uuid
                      AND membership.org_unit_id=participant.party_id
                      AND membership.employee_id=${actorId}::uuid
                      AND membership.active=true
                  ))
                )
            )`] : []),
          )!,
        )).orderBy(asc(internalEvents.startsAt)).limit(20) : [];
      const participantCounts = eventRows.length > 0 ? await db.select({
        internalEventId: internalEventParticipants.internalEventId,
        count: sql<number>`count(*)::int`,
      }).from(internalEventParticipants).where(and(
        eq(internalEventParticipants.tenantId, ctx.tenantId),
        inArray(internalEventParticipants.internalEventId, eventRows.map((row) => row.id)),
      )).groupBy(internalEventParticipants.internalEventId) : [];
      const countByEvent = new Map(participantCounts.map((row) => [row.internalEventId, row.count]));
      return { settings, delegationRows, acknowledgementRows, eventRows: eventRows.map((row) => ({ ...row, participantCount: countByEvent.get(row.id) ?? 0 })) };
    });
    const root = record(loaded.settings?.config);
    const communications = record(root.communication);
    const scheduling = record(root.scheduling);
    const sharing = record(root.documentSharing);
    const computer = record(loaded.settings?.computerConfig);
    const allowedChannels = stringArray(communications.allowedChannels).filter((channel) => ["internal", "email", "sms", "voice"].includes(channel));
    universalActions = {
      capabilities: {
        allowedChannels: allowedChannels.length > 0 ? allowedChannels : ["internal", "email", "sms", "voice"],
        allowChannelFallback: communications.allowChannelFallback === true,
        maxGroupRecipients: Number.isInteger(communications.maxGroupRecipients) ? Math.min(500, Math.max(1, Number(communications.maxGroupRecipients))) : 50,
        externalDocumentSharing: sharing.allowExternal === true,
        externalCalendarMode: scheduling.externalCalendarMode === "when_available" ? "when_available" : "internal_only",
        browserExecutable: false,
        computerExecutable: computer.enabled === true && computer.provider === "steel",
      },
      activeDelegations: loaded.delegationRows.map((row) => ({ delegationRef: { delegationId: row.id }, target: { partyType: row.targetType as PartyRef["partyType"], partyId: row.targetId }, objective: row.objective.slice(0, 500), status: row.status, workRef: row.workId ? { workId: row.workId } : null, taskRef: row.taskId ? { taskId: row.taskId } : null, acknowledgementDeadline: iso(row.acknowledgementDeadline), completionDeadline: iso(row.completionDeadline) })),
      pendingAcknowledgements: loaded.acknowledgementRows.map((row) => ({ acknowledgementRequestId: row.id, recipient: { partyType: row.recipientType as PartyRef["partyType"], partyId: row.recipientId }, status: row.status, deadline: iso(row.deadline), delegationRef: row.delegationId ? { delegationId: row.delegationId } : null })),
      upcomingInternalEvents: loaded.eventRows.map((row) => ({ internalEventRef: { internalEventId: row.id }, title: row.title, status: row.status, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), participantCount: row.participantCount })),
    };
    sources.push({ kind: "CANONICAL", source: "universal_action_state", asOf: assembledAt, role: "context_only" });
  } catch (error) {
    errors.push(`universal action state unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!tenantRow) missing.push("tenant.identity");
  if (!tenantProfile?.industry && !tenantProfile?.niche) missing.push("tenant.profile.industry_or_niche");
  if (stringArray(tenantProfile?.primaryGeographies).length === 0) missing.push("tenant.profile.primaryGeographies");
  if (!userRow) missing.push("employee.identity");
  if (!tenantProfile) missing.push("tenant.profile");
  if (!userProfile) missing.push("employee.profile");
  if (tenantRow) sources.push(profileSource("tenant", tenantRow.id, assembledAt));
  if (tenantProfile) sources.push(profileSource("tenant_operating_profile", tenantProfile.tenantId, iso(tenantProfile.updatedAt)));
  if (userRow) sources.push(profileSource("authenticated_employee", userRow.id, assembledAt));
  if (userProfile) sources.push(profileSource("user_operating_profile", userProfile.userId, iso(userProfile.updatedAt)));
  if (workRow) sources.push({ kind: "WORK", source: "works", ref: workRow.id, asOf: iso(workRow.updatedAt) ?? assembledAt, role: "context_only" });

  let mentionedHousehold: { householdId: string; label: string } | null = null;
  const interactionParsed = OperatingInteractionContextSchema.safeParse(opts.activeContext ?? workRow?.activeContext);
  const interactionContext: OperatingInteractionContext | null = interactionParsed.success ? interactionParsed.data : null;
  const explicitHousehold = [
    ...(interactionContext?.selectedEntities ?? []),
    ...(interactionContext?.focusedEntity ? [interactionContext.focusedEntity] : []),
  ].find((ref) => ref.entityType === "household" && !interactionContext?.excludedEntities.some((excluded) => excluded.entityType === ref.entityType && excluded.entityId === ref.entityId));
  let resolvedHouseholdId = explicitHousehold?.entityId ?? opts.householdId;
  // Household resolution is Water-owned. A PE tenant must not turn a generic
  // noun or an optional legacy household id into a Water reference in its
  // planner context; PE anchors come from the Deal/Work registry below.
  if ((vertical?.verticalKey === "water" || !vertical) && opts.includeMemory && !resolvedHouseholdId) {
    try {
      const resolved = await resolveHouseholdMention(ctx.tenantId, opts.instruction);
      if (resolved) {
        mentionedHousehold = { householdId: resolved.householdId, label: resolved.label };
        resolvedHouseholdId = resolved.householdId;
      }
    } catch (error) {
      errors.push(`household reference unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let memory = emptyMemory();
  if (opts.includeMemory) {
    try {
      memory = await buildMemorySnapshot({
        tenantId: ctx.tenantId,
        employeeId: ctx.employeeId,
        canonicalThreadId: opts.conversationContext?.thread.id,
        sessionId: opts.sessionId,
        householdId: resolvedHouseholdId,
        // Phase-6 human turns use employee-owned exact history and Zep facts from
        // conversationContext. The legacy tenant-wide semantic conversation index
        // is not a safe source for private reference resolution.
        semanticQuery: opts.includeSemanticMemory === false || opts.conversationContext ? undefined : opts.instruction,
        semanticLimit: 5,
      });
      if (memory.shortTerm) sources.push({ kind: "SESSION", source: "session_memory", ref: opts.sessionId, asOf: assembledAt, role: "context_only" });
      if (memory.semantic.length > 0) sources.push({ kind: "MEMORY", source: "semantic_memory", asOf: assembledAt, role: "context_only" });
      if (memory.episodic.length > 0) sources.push({ kind: "WORK", source: "execution_history", asOf: assembledAt, role: "context_only" });
    } catch (error) {
      errors.push(`memory unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let integrationHealth: OperatingContext["integrationHealth"] = {};
  try {
    integrationHealth = await buildPlanningHealthContext(ctx.tenantId);
  } catch (error) {
    errors.push(`integration health unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const canonicalSummaries: OperatingContext["canonicalSummaries"] = [];
  let epistemicWarnings: NonNullable<OperatingContext["epistemicWarnings"]> = [];
  if (opts.includeCanonicalBusinessState) {
    try {
      if (vertical?.verticalKey === "private_equity") {
        const resolution = await resolvePrivateEquityDealReference(ctx.tenantId, opts.instruction, { workId: opts.workId, userId: ctx.userId });
        if (resolution.status !== "resolved") throw new Error(`PE Deal reference is ${resolution.status}`);
        const [dealContext, closingReadiness] = await Promise.all([
          executeTenantOperationalQuery(ctx.tenantId, { intent: "deal_context", dealId: resolution.dealId }, { userId: ctx.userId, employeeId: ctx.employeeId }),
          executeTenantOperationalQuery(ctx.tenantId, { intent: "closing_readiness", dealId: resolution.dealId }, { userId: ctx.userId, employeeId: ctx.employeeId }),
        ]);
        canonicalSummaries.push({
          name: "deal_context",
          asOf: dealContext.asOf,
          source: dealContext.source.kind,
          data: { status: dealContext.status, deal: dealContext.deal, counts: dealContext.counts },
        }, {
          name: "closing_readiness",
          asOf: closingReadiness.asOf,
          source: closingReadiness.source.kind,
          data: {
            eligible: closingReadiness.eligible,
            blockingConditions: closingReadiness.blockingConditions,
            failedConditions: closingReadiness.failedConditions,
            unverifiedClosingItems: closingReadiness.unverifiedClosingItems,
            blockingDependencies: closingReadiness.blockingDependencies,
            decisionReadiness: closingReadiness.decisionReadiness,
          },
        });
        epistemicWarnings = [...dealContext.epistemicWarnings, ...closingReadiness.epistemicWarnings]
          .filter((warning, index, all) => all.findIndex((candidate) => candidate.propositionId === warning.propositionId && candidate.status === warning.status) === index);
        sources.push({ kind: "CANONICAL", source: "operational_query:deal_context", asOf: dealContext.asOf, role: "context_only" });
        sources.push({ kind: "CANONICAL", source: "operational_query:closing_readiness", asOf: closingReadiness.asOf, role: "context_only" });
      } else {
        const current = await executeTenantOperationalQuery(ctx.tenantId, { intent: "business_state" });
        canonicalSummaries.push({
          name: "business_state",
          asOf: current.asOf,
          source: current.source.kind,
          data: { status: current.status, count: current.count, data: record(current.data) },
        });
        sources.push({ kind: "CANONICAL", source: "operational_query:business_state", asOf: current.asOf, role: "context_only" });
      }
    } catch (error) {
      errors.push(`canonical business state unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const refs = new Map<string, CanonicalEntityRef<string>>();
  for (const item of linkedEntities) {
    if (registeredEntityTypes.has(item.entityType) && UUID.test(item.entityId)) {
      const ref = { entityType: item.entityType, entityId: item.entityId };
      refs.set(`${ref.entityType}:${ref.entityId}`, ref);
    }
  }
  if (resolvedHouseholdId && registeredEntityTypes.has("household") && UUID.test(resolvedHouseholdId)) {
    refs.set(`household:${resolvedHouseholdId}`, { entityType: "household", entityId: resolvedHouseholdId });
  }
  for (const ref of opts.conversationContext?.resolution.resolvedReferences ?? []) {
    if (registeredEntityTypes.has(ref.entityType) && UUID.test(ref.entityId)) {
      refs.set(`${ref.entityType}:${ref.entityId}`, { entityType: ref.entityType, entityId: ref.entityId });
    }
  }
  const trustedPartyRefs = new Map<string, PartyRef>();
  const excludedInteractionRefs = new Set((interactionContext?.excludedEntities ?? []).map((ref) => `${ref.entityType}:${ref.entityId}`));
  const directInteractionRefs = [
    ...(interactionContext?.selectedEntities ?? []),
    ...(interactionContext?.focusedEntity ? [interactionContext.focusedEntity] : []),
  ];
  for (const ref of directInteractionRefs) {
    if (excludedInteractionRefs.has(`${ref.entityType}:${ref.entityId}`)) continue;
    refs.set(`${ref.entityType}:${ref.entityId}`, ref);
    const partyRef = canonicalEntityRefToPartyRef(ref as CanonicalEntityRef);
    if (partyRef) trustedPartyRefs.set(`${partyRef.partyType}:${partyRef.partyId}`, partyRef);
  }
  // Read-only compatibility for historical Work created before the versioned
  // interaction contract. New API intake never accepts this shape.
  const legacyActive = record(workRow?.activeContext);
  if (!interactionContext && Array.isArray(legacyActive.entityRefs)) {
    for (const candidate of legacyActive.entityRefs) {
      const value = record(candidate);
      if (typeof value.entityType === "string" && registeredEntityTypes.has(value.entityType) && typeof value.entityId === "string" && UUID.test(value.entityId)) {
        const legacyRef = { entityType: value.entityType, entityId: value.entityId };
        refs.set(`${legacyRef.entityType}:${legacyRef.entityId}`, legacyRef);
        const partyRef = canonicalEntityRefToPartyRef(legacyRef as CanonicalEntityRef);
        if (partyRef) trustedPartyRefs.set(`${partyRef.partyType}:${partyRef.partyId}`, partyRef);
      }
    }
  }
  for (const candidate of linkedEntities) {
    if (!registeredEntityTypes.has(candidate.entityType) || !UUID.test(candidate.entityId)) continue;
    const ref = { entityType: candidate.entityType, entityId: candidate.entityId };
    const partyRef = canonicalEntityRefToPartyRef(ref as CanonicalEntityRef);
    if (partyRef) trustedPartyRefs.set(`${partyRef.partyType}:${partyRef.partyId}`, partyRef);
  }

  try {
    companyDirectory = await loadOperatingDirectoryContext(ctx.tenantId, {
      ...(ctx.employeeId ? { employeeId: ctx.employeeId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(opts.workId ? { workId: opts.workId } : {}),
      now: new Date(assembledAt),
      referencedPartyRefs: [...trustedPartyRefs.values()],
    });
    sources.push({ kind: "CANONICAL", source: "company_directory", asOf: assembledAt, role: "context_only" });
  } catch (error) {
    errors.push(`company directory unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const actorId = ctx.employeeId ?? ctx.userId;
    identityAccess = await listAvailableIdentityAccess(ctx.tenantId, actorId);
    sources.push({ kind: "CANONICAL", source: "identity_access", asOf: assembledAt, role: "context_only" });
  } catch (error) {
    errors.push(`identity/access context unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const comparisonDefaults = record(tenantProfile?.comparisonDefaults);
  const context: OperatingContext = {
    version: 1,
    assembledAt,
    truthPrecedence: OPERATING_TRUTH_PRECEDENCE,
    interactionPrecedence: OPERATING_INTERACTION_PRECEDENCE,
    interactionContext,
    conversationContext: opts.conversationContext ?? null,
    personalMemory: opts.conversationContext?.personalMemories ?? [],
    tenant: {
      id: ctx.tenantId,
      companyName: tenantRow?.name ?? null,
      timezone: tenantRow?.timezone ?? null,
      ...(vertical ? { vertical } : {}),
      profile: {
        industry: tenantProfile?.industry ?? null,
        niche: tenantProfile?.niche ?? null,
        description: tenantProfile?.description ?? null,
        primaryGeographies: stringArray(tenantProfile?.primaryGeographies),
        foundedYear: tenantProfile?.foundedYear ?? null,
        idealCustomerProfile: record(tenantProfile?.idealCustomerProfile),
        businessFacts: record(tenantProfile?.businessFacts),
        comparisonDefaults: {
          ...(typeof comparisonDefaults.scaleMetric === "string" ? { scaleMetric: comparisonDefaults.scaleMetric } : {}),
          ...(typeof comparisonDefaults.performanceMetric === "string" ? { performanceMetric: comparisonDefaults.performanceMetric } : {}),
        },
        updatedAt: iso(tenantProfile?.updatedAt),
      },
    },
    employee: {
      userId: ctx.userId,
      employeeId: ctx.employeeId ?? userRow?.id ?? null,
      displayName: userRow?.displayName ?? null,
      role: userRow?.role ?? ctx.role,
      authorityRoles: companyDirectory.authorityRoles.length > 0 ? companyDirectory.authorityRoles : ctx.authorityRoles ?? [ctx.role],
      profile: {
        title: userProfile?.title ?? null,
        profileFacts: record(userProfile?.profileFacts),
        updatedAt: iso(userProfile?.updatedAt),
      },
    },
    activeWork: workRow ? {
      id: workRow.id,
      status: workRow.status,
      sessionId: workRow.sessionId,
      initialInstruction: workRow.initialInstruction,
      activeContext: record(workRow.activeContext),
      updatedAt: iso(workRow.updatedAt),
    } : null,
    companyDirectory,
    identityAccess,
    universalActions,
    referencedEntities: [...refs.values()],
    ...(epistemicWarnings.length > 0 ? { epistemicWarnings } : {}),
    canonicalSummaries,
    memory: {
      conversation: memory.shortTerm,
      semantic: memory.semantic.map((hit) => ({
        ...(hit.id ? { id: hit.id } : {}),
        sourceDocId: hit.sourceDocId,
        chunk: hit.chunk,
        similarity: hit.similarity,
        ...(hit.relevanceScore === undefined ? {} : { relevanceScore: hit.relevanceScore }),
        ...(hit.sourceKind ? { sourceKind: hit.sourceKind } : {}),
        ...(hit.occurredAt ? { occurredAt: hit.occurredAt } : {}),
        ...(hit.entityRefs ? { entityRefs: hit.entityRefs } : {}),
        ...(hit.provenance ? { provenance: hit.provenance } : {}),
      })),
      episodic: memory.episodic.slice(0, 10),
    },
    integrationHealth,
    authority: {
      principal: ctx.userId,
      employeeId: ctx.employeeId ?? userRow?.id ?? null,
      revision: ctx.authorityRevision ?? null,
      roles: ctx.authorityRoles ?? [ctx.role],
    },
    sources,
    health: {
      status: errors.length === 0 && missing.length === 0 ? "complete" : tenantRow ? "partial" : "unavailable",
      missing: [...new Set(missing)],
      errors: errors.map((error) => error.slice(0, 500)),
    },
  };
  return { context, memory, ...(resolvedHouseholdId ? { resolvedHouseholdId } : {}), mentionedHousehold };
}
