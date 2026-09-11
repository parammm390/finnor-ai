import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentProfileRevisions,
  agentProfiles,
  businessEffects,
  decisionReceipts,
  domainActions,
  jobs,
  learningObservations,
  learningRevisions,
  workforceAssignments,
  workEventWaits,
  workObjectiveLoops,
  workObjectiveSteps,
  workPlanRevisions,
  workQueryExecutions,
  withTenant,
  resolveTenantVertical,
  type Db,
} from "@finnor/db";
import type { PlanNode, PlanningWorldSnapshot } from "@finnor/planning";
import { canExerciseAuthority } from "@finnor/authority";
import type { TenantContext } from "@finnor/shared-types";
import {
  computeLearningMetrics,
  attributeLearningOutcome,
  effectiveAutonomyLimits,
  learningObservationHash,
  evaluateAssignmentEligibility,
  rankEligibleWorkers,
  type AgentAutonomyLimits,
  type AgentCapabilityGrant,
  type AgentModelRoute,
  type AgentProfile,
  type AgentProfileRevision,
  type AssignmentScore,
  type LearningObservation,
  type LearningSourceRef,
  type PlanExecutionBoundary,
  type WorkforceCandidate,
} from "@finnor/workforce";
import { isProviderConfigured } from "./llm";
import type { PluginRegistry } from "./plugin-registry";
import { HUMAN_ONLY_PLANNING_CAPABILITIES, planningCapabilitiesForVertical } from "./plugin-registry";

const ACTIVE_ASSIGNMENT_STATES = ["queued", "claimed", "running", "waiting"] as const;
const RUNNING_ASSIGNMENT_STATES = ["queued", "claimed", "running"] as const;
const HUMAN_ONLY = new Set<string>(HUMAN_ONLY_PLANNING_CAPABILITIES);
export const WORKFORCE_LEASE_MS = 30_000;

export const WORKFORCE_REASSIGNMENT_REASONS = [
  "LEASE_EXPIRED",
  "AGENT_DISABLED",
  "AGENT_REVISION_SUPERSEDED",
  "MODEL_ROUTE_UNAVAILABLE",
  "AUTONOMY_BUDGET_EXHAUSTED",
  "REPEATED_WORKER_FAILURE",
  "PLAN_SUPERSEDED",
  "OPERATOR_REQUESTED",
] as const;
export type WorkforceReassignmentReason = (typeof WORKFORCE_REASSIGNMENT_REASONS)[number];

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}

export function workforceHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function capabilityForPlanNode(node: PlanNode): string {
  if (node.kind === "action") return node.actionType;
  if (node.kind === "query") {
    const intent = typeof node.request.intent === "string" ? node.request.intent : null;
    if (!intent) throw new Error("P6 query PlanNode has no exact operational-query intent");
    return `query:${intent}`;
  }
  if (node.kind === "wait") return "wait:event";
  return "check:objective_success";
}

function routeAvailable(route: AgentModelRoute): boolean {
  return route.provider === "orchestration_runtime" || isProviderConfigured(route.provider);
}

function profileShape(row: typeof agentProfiles.$inferSelect): AgentProfile {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function revisionShape(row: typeof agentProfileRevisions.$inferSelect): AgentProfileRevision {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentProfileId: row.agentProfileId,
    revision: row.revision,
    modelRoute: row.modelRoute as AgentModelRoute,
    capabilityGrants: row.capabilityGrants as AgentCapabilityGrant[],
    maxConcurrentAssignments: row.maxConcurrentAssignments,
    autonomyLimits: row.autonomyLimits as AgentAutonomyLimits,
    planningHints: row.planningHints as Record<string, unknown>,
    learningRevisionId: row.learningRevisionId,
    status: row.status,
    configHash: row.configHash,
    createdAt: row.createdAt.toISOString(),
  };
}

function observationShape(row: typeof learningObservations.$inferSelect): LearningObservation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentProfileId: row.agentProfileId,
    agentRevisionId: row.agentRevisionId,
    workforceAssignmentId: row.workforceAssignmentId,
    capability: row.capability,
    nodeKind: row.nodeKind,
    contextClass: row.contextClass,
    workId: row.workId,
    planRevisionId: row.planRevisionId,
    planNodeId: row.planNodeId,
    outcomeClass: row.outcomeClass,
    verified: row.verified,
    sourceRefs: row.sourceRefs as LearningObservation["sourceRefs"],
    contextFeatures: row.contextFeatures as LearningObservation["contextFeatures"],
    measuredMetrics: row.measuredMetrics as LearningObservation["measuredMetrics"],
    occurredAt: row.occurredAt.toISOString(),
    observationHash: row.observationHash,
  };
}

export interface ConfigureAgentProfileInput {
  profileId?: string;
  key: string;
  name: string;
  status?: "enabled" | "disabled";
  modelRoute?: AgentModelRoute;
  capabilityGrants: AgentCapabilityGrant[];
  maxConcurrentAssignments?: number;
  autonomyLimits?: Partial<AgentAutonomyLimits>;
  planningHints?: Record<string, unknown>;
  learningRevisionId?: string | null;
  actor: TenantContext;
}

export const DEFAULT_AGENT_AUTONOMY_LIMITS: AgentAutonomyLimits = Object.freeze({
  maxActions: 3,
  maxQueries: 8,
  maxReplans: 6,
  maxPlannerCalls: 8,
  maxWallClockMs: 86_400_000,
  maxKnownCostUsd: null,
  maxKnownTokens: null,
});

/** Human-governed configuration entry point. It validates grants against the
 * existing P6 registry and creates immutable revisions instead of patching one. */
export async function configureAgentProfile(
  tenantId: string,
  plugins: PluginRegistry,
  input: ConfigureAgentProfileInput,
): Promise<{ profile: typeof agentProfiles.$inferSelect; revision: typeof agentProfileRevisions.$inferSelect }> {
  if (!input.actor.employeeId || input.actor.employeeId !== input.actor.userId || input.actor.tenantId !== tenantId) {
    throw new Error("Agent configuration requires an authenticated human employee in the same tenant");
  }
  const allowed = await canExerciseAuthority(input.actor, {
    operation: "action",
    capability: "workforce:configure_agent",
    resource: { type: "agent_profile", ...(input.profileId ? { id: input.profileId } : {}) },
    risk: "medium",
  }).catch(() => false);
  if (!allowed) throw new Error("Current human authority cannot configure AI workers");
  const actorId = input.actor.employeeId;
  const vertical = await resolveTenantVertical(tenantId);
  const registry = new Map(planningCapabilitiesForVertical(plugins, vertical.verticalKey).map((item) => [`${item.kind}:${item.capability}`, item]));
  const grants = [...input.capabilityGrants].sort((left, right) => `${left.kind}:${left.capability}`.localeCompare(`${right.kind}:${right.capability}`));
  if (grants.length === 0) throw new Error("AgentProfileRevision requires at least one exact P6/Core capability grant");
  const seen = new Set<string>();
  for (const grant of grants) {
    const key = `${grant.kind}:${grant.capability}`;
    const capability = registry.get(key);
    if (!capability) throw new Error(`Unknown P6/Core capability grant ${key}`);
    if (HUMAN_ONLY.has(grant.capability) || capability.authorityRequirement === "human_attestation") {
      throw new Error(`Human-only capability ${grant.capability} cannot be granted to an AI worker`);
    }
    if (seen.has(key)) throw new Error(`Duplicate capability grant ${key}`);
    seen.add(key);
  }
  const autonomyLimits: AgentAutonomyLimits = { ...DEFAULT_AGENT_AUTONOMY_LIMITS, ...input.autonomyLimits };
  const modelRoute = input.modelRoute ?? { provider: "orchestration_runtime", model: null, purpose: "objective_execution" };
  const maxConcurrentAssignments = input.maxConcurrentAssignments ?? 1;
  const planningHints = input.planningHints ?? {};
  const boundedIntegers: Array<[string, number, number, number]> = [
    ["maxActions", autonomyLimits.maxActions, 1, 4],
    ["maxQueries", autonomyLimits.maxQueries, 1, 11],
    ["maxReplans", autonomyLimits.maxReplans, 1, 8],
    ["maxPlannerCalls", autonomyLimits.maxPlannerCalls, 1, 11],
    ["maxWallClockMs", autonomyLimits.maxWallClockMs, 1_000, 604_799_999],
    ["maxConcurrentAssignments", maxConcurrentAssignments, 1, 32],
  ];
  for (const [name, value, minimum, maximum] of boundedIntegers) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside the governed P7 bound`);
  }
  if (autonomyLimits.maxKnownCostUsd !== null && autonomyLimits.maxKnownCostUsd !== undefined
      && (!Number.isFinite(autonomyLimits.maxKnownCostUsd) || autonomyLimits.maxKnownCostUsd < 0)) {
    throw new Error("maxKnownCostUsd is outside the governed P7 bound");
  }
  if (autonomyLimits.maxKnownTokens !== null && autonomyLimits.maxKnownTokens !== undefined
      && (!Number.isInteger(autonomyLimits.maxKnownTokens) || autonomyLimits.maxKnownTokens < 0)) {
    throw new Error("maxKnownTokens is outside the governed P7 bound");
  }
  if (Buffer.byteLength(canonicalJson(planningHints), "utf8") > 32_768) throw new Error("planningHints exceed the governed P7 bound");
  const semanticConfig = { modelRoute, capabilityGrants: grants, maxConcurrentAssignments, autonomyLimits, planningHints, learningRevisionId: input.learningRevisionId ?? null };
  const configHash = workforceHash(semanticConfig);

  return withTenant(tenantId, async (db) => {
    let profile: typeof agentProfiles.$inferSelect | undefined;
    if (input.profileId) {
      await db.execute(sql`SELECT id FROM ${agentProfiles} WHERE ${agentProfiles.tenantId}=${tenantId} AND ${agentProfiles.id}=${input.profileId} FOR UPDATE`);
      [profile] = await db.select().from(agentProfiles).where(and(eq(agentProfiles.tenantId, tenantId), eq(agentProfiles.id, input.profileId))).limit(1);
      if (!profile) throw new Error("AgentProfile was not found in the authenticated tenant");
      if (profile.key !== input.key) throw new Error("AgentProfile durable key cannot be changed by a configuration revision");
      if (profile.name !== input.name || profile.status !== (input.status ?? profile.status)) {
        [profile] = await db.update(agentProfiles).set({ name: input.name, status: input.status ?? profile.status })
          .where(and(eq(agentProfiles.tenantId, tenantId), eq(agentProfiles.id, profile.id))).returning();
      }
    } else {
      [profile] = await db.insert(agentProfiles).values({ tenantId, key: input.key, name: input.name, status: input.status ?? "enabled" }).returning();
    }
    if (!profile) throw new Error("Unable to persist AgentProfile");
    const [same] = await db.select().from(agentProfileRevisions).where(and(
      eq(agentProfileRevisions.tenantId, tenantId), eq(agentProfileRevisions.agentProfileId, profile.id), eq(agentProfileRevisions.configHash, configHash),
    )).limit(1);
    if (same) return { profile, revision: same };
    const [latest] = await db.select().from(agentProfileRevisions).where(and(eq(agentProfileRevisions.tenantId, tenantId), eq(agentProfileRevisions.agentProfileId, profile.id)))
      .orderBy(desc(agentProfileRevisions.revision)).limit(1);
    if (latest?.status === "active") await db.update(agentProfileRevisions).set({ status: "superseded" }).where(eq(agentProfileRevisions.id, latest.id));
    const [revision] = await db.insert(agentProfileRevisions).values({
      tenantId,
      agentProfileId: profile.id,
      revision: (latest?.revision ?? 0) + 1,
      modelRoute,
      capabilityGrants: grants,
      maxConcurrentAssignments,
      autonomyLimits,
      planningHints,
      learningRevisionId: input.learningRevisionId ?? null,
      status: "active",
      configHash,
      createdBy: actorId,
    }).returning();
    if (!revision) throw new Error("Unable to persist AgentProfileRevision");
    return { profile, revision };
  });
}

export type WorkforceAssignmentRequestResult =
  | { status: "assigned"; assignment: typeof workforceAssignments.$inferSelect; score: AssignmentScore; created: boolean }
  | { status: "human_required" | "unassigned" | "blocked"; reason: string; ineligibility: Record<string, string[]> };

export async function requestWorkforceAssignment(params: {
  tenantId: string;
  workId: string;
  planRevisionId: string;
  node: PlanNode;
  objectiveLoop: typeof workObjectiveLoops.$inferSelect;
  objectiveStepId: string;
  plugins: PluginRegistry;
}): Promise<WorkforceAssignmentRequestResult> {
  const capability = capabilityForPlanNode(params.node);
  const vertical = await resolveTenantVertical(params.tenantId);
  const manifest = planningCapabilitiesForVertical(params.plugins, vertical.verticalKey);
  const metadata = manifest.find((item) => item.kind === params.node.kind && item.capability === capability);
  const explicitlyHumanOnly = HUMAN_ONLY.has(capability) || metadata?.authorityRequirement === "human_attestation";
  const boundary: PlanExecutionBoundary = {
    tenantId: params.tenantId,
    workId: params.workId,
    planRevisionId: params.planRevisionId,
    currentPlanRevisionId: params.planRevisionId,
    planNodeId: params.node.id,
    nodeKind: params.node.kind,
    capability,
    ready: true,
    preconditionsValid: metadata !== undefined,
    humanOnly: explicitlyHumanOnly,
    authorityRequirement: metadata?.authorityRequirement ?? "human_attestation",
    providerAvailable: Boolean(metadata?.available && metadata.health !== "unavailable"),
    policyAllowed: Boolean(metadata?.modelProposable),
  };

  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workPlanRevisions} WHERE ${workPlanRevisions.tenantId}=${params.tenantId} AND ${workPlanRevisions.id}=${params.planRevisionId} FOR UPDATE`);
    const [plan] = await db.select().from(workPlanRevisions).where(and(
      eq(workPlanRevisions.tenantId, params.tenantId), eq(workPlanRevisions.workId, params.workId), eq(workPlanRevisions.id, params.planRevisionId),
    )).limit(1);
    if (!plan || plan.status !== "active") return { status: "blocked", reason: "The selected P6 PlanRevision is no longer current.", ineligibility: { plan: ["PLAN_SUPERSEDED"] } };
    let [existing] = await db.select().from(workforceAssignments).where(and(
      eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.planRevisionId, params.planRevisionId),
      eq(workforceAssignments.planNodeId, params.node.id), inArray(workforceAssignments.state, [...ACTIVE_ASSIGNMENT_STATES]),
    )).limit(1);
    if (existing && (existing.state === "claimed" || existing.state === "running") && existing.leaseUntil && existing.leaseUntil <= new Date()) {
      await db.update(workforceAssignments).set({
        state: "reassigned", completedAt: new Date(), leaseOwner: null, leaseUntil: null,
        reassignmentReason: "LEASE_EXPIRED", failure: { code: "LEASE_EXPIRED", priorLeaseOwner: existing.leaseOwner }, updatedAt: new Date(),
      }).where(and(eq(workforceAssignments.id, existing.id), eq(workforceAssignments.state, existing.state)));
      existing = undefined;
    }
    const profiles = await db.select({ profile: agentProfiles, revision: agentProfileRevisions }).from(agentProfiles)
      .innerJoin(agentProfileRevisions, and(eq(agentProfileRevisions.agentProfileId, agentProfiles.id), eq(agentProfileRevisions.tenantId, agentProfiles.tenantId)))
      .where(and(eq(agentProfiles.tenantId, params.tenantId), eq(agentProfiles.status, "enabled"), eq(agentProfileRevisions.status, "active")))
      .orderBy(asc(agentProfiles.id));
    if (profiles.length > 0) {
      // Serializes capacity reservations across different Work/Plan locks without
      // creating a global scheduler or an eventually-consistent load counter.
      await db.select({ id: agentProfiles.id }).from(agentProfiles)
        .where(and(
          eq(agentProfiles.tenantId, params.tenantId),
          inArray(agentProfiles.id, profiles.map((row) => row.profile.id)),
        ))
        .orderBy(asc(agentProfiles.id))
        .for("update");
    }
    const learningIds = profiles.map((row) => row.revision.learningRevisionId).filter((id): id is string => Boolean(id));
    const [loadRows, observationRows, previousRows, historyRows, promotedLearningRows] = await Promise.all([
      db.select({ agentProfileId: workforceAssignments.agentProfileId, count: sql<number>`count(*)::int` }).from(workforceAssignments)
        .where(and(eq(workforceAssignments.tenantId, params.tenantId), inArray(workforceAssignments.state, [...RUNNING_ASSIGNMENT_STATES])))
        .groupBy(workforceAssignments.agentProfileId),
      db.select().from(learningObservations).where(eq(learningObservations.tenantId, params.tenantId))
        .orderBy(desc(learningObservations.occurredAt)).limit(2_000),
      db.select().from(workforceAssignments).where(and(eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.planRevisionId, params.planRevisionId), eq(workforceAssignments.planNodeId, params.node.id)))
        .orderBy(desc(workforceAssignments.createdAt)).limit(1),
      db.select({ agentProfileId: workforceAssignments.agentProfileId, state: workforceAssignments.state, failure: workforceAssignments.failure })
        .from(workforceAssignments).where(and(eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.planRevisionId, params.planRevisionId), eq(workforceAssignments.planNodeId, params.node.id)))
        .orderBy(desc(workforceAssignments.createdAt)).limit(100),
      learningIds.length > 0
        ? db.select().from(learningRevisions).where(and(eq(learningRevisions.tenantId, params.tenantId), inArray(learningRevisions.id, learningIds)))
        : Promise.resolve([]),
    ]);
    const loads = new Map(loadRows.map((row) => [row.agentProfileId, row.count]));
    const snapshot = plan.planningSnapshot as PlanningWorldSnapshot;
    const contextClass = `${typeof snapshot.verticalKey === "string" ? snapshot.verticalKey : "unknown"}:${params.node.kind}`;
    const metrics = computeLearningMetrics(observationRows.map(observationShape));
    const promotedLearning = new Map(promotedLearningRows.map((row) => [row.id, row.guidance as { routingPreferences?: Record<string, number> }]));
    const repeatedFailures = new Map<string, number>();
    for (const row of historyRows) {
      const code = row.failure && typeof row.failure === "object" && !Array.isArray(row.failure)
        ? String((row.failure as Record<string, unknown>).code ?? "") : "";
      if (row.state === "failed" && code === "WORKER_EXECUTION_FAILED") {
        repeatedFailures.set(row.agentProfileId, (repeatedFailures.get(row.agentProfileId) ?? 0) + 1);
      }
    }
    const candidates: WorkforceCandidate[] = profiles.map(({ profile, revision }) => {
      const shapedRevision = revisionShape(revision);
      const metric = metrics.find((item) => item.agentRevisionId === revision.id && item.capability === capability && item.nodeKind === params.node.kind && item.contextClass === contextClass) ?? null;
      return {
        profile: profileShape(profile),
        revision: shapedRevision,
        currentLoad: loads.get(profile.id) ?? 0,
        budgetUsage: {
          actions: params.objectiveLoop.actionCount,
          queries: params.objectiveLoop.queryCount,
          replans: Math.max(0, plan.revision - 1),
          plannerCalls: params.objectiveLoop.stepCount,
          wallClockMs: Math.max(0, Date.now() - params.objectiveLoop.createdAt.getTime()),
          knownCostUsd: null,
          knownTokens: null,
        },
        p6BudgetCeilings: {
          maxActions: params.objectiveLoop.maxActions,
          maxQueries: params.objectiveLoop.maxQueries,
          maxReplans: params.objectiveLoop.maxSteps,
          maxPlannerCalls: params.objectiveLoop.maxSteps,
          maxWallClockMs: Math.max(1, params.objectiveLoop.deadlineAt.getTime() - params.objectiveLoop.createdAt.getTime()),
          maxKnownCostUsd: null,
          maxKnownTokens: null,
        },
        metric,
        routeAvailable: routeAvailable(shapedRevision.modelRoute),
        repeatedWorkerFailures: repeatedFailures.get(profile.id) ?? 0,
        promotedRoutingPreference: shapedRevision.learningRevisionId
          ? promotedLearning.get(shapedRevision.learningRevisionId)?.routingPreferences?.[capability] ?? 0
          : 0,
      };
    });
    boundary.currentPlanRevisionId = plan.id;
    if (existing) {
      const currentCandidate = candidates.find((candidate) => candidate.profile.id === existing!.agentProfileId && candidate.revision.id === existing!.agentRevisionId);
      const existingCandidate = currentCandidate ? { ...currentCandidate, currentLoad: Math.max(0, currentCandidate.currentLoad - 1) } : null;
      const existingEligibility = existingCandidate ? evaluateAssignmentEligibility(boundary, existingCandidate) : null;
      if (existingEligibility?.eligible) {
        return { status: "assigned", assignment: existing, score: existing.assignmentScore as AssignmentScore, created: false };
      }
      const reasons = existingEligibility?.reasons ?? ["REVISION_INACTIVE"];
      const reassignmentReason: WorkforceReassignmentReason = reasons.includes("MODEL_ROUTE_UNAVAILABLE") ? "MODEL_ROUTE_UNAVAILABLE"
        : reasons.includes("AUTONOMY_BUDGET_EXHAUSTED") ? "AUTONOMY_BUDGET_EXHAUSTED"
          : reasons.includes("REPEATED_WORKER_FAILURE") ? "REPEATED_WORKER_FAILURE"
            : reasons.includes("PLAN_SUPERSEDED") ? "PLAN_SUPERSEDED"
              : "AGENT_REVISION_SUPERSEDED";
      await db.update(workforceAssignments).set({
        state: "reassigned", completedAt: new Date(), leaseOwner: null, leaseUntil: null,
        reassignmentReason, failure: { code: reassignmentReason, eligibility: reasons }, updatedAt: new Date(),
      }).where(and(eq(workforceAssignments.id, existing.id), inArray(workforceAssignments.state, [...ACTIVE_ASSIGNMENT_STATES])));
      existing = undefined;
      for (const candidate of candidates) {
        if (candidate.profile.id === currentCandidate?.profile.id) candidate.currentLoad = Math.max(0, candidate.currentLoad - 1);
      }
    }
    const evaluations = candidates.map((candidate) => ({ candidate, eligibility: evaluateAssignmentEligibility(boundary, candidate) }));
    const ranked = rankEligibleWorkers(boundary, candidates);
    if (ranked.length === 0) {
      const ineligibility = Object.fromEntries(evaluations.map(({ candidate, eligibility }) => [candidate.profile.id, eligibility.reasons]));
      return {
        status: explicitlyHumanOnly ? "human_required" : "unassigned",
        reason: explicitlyHumanOnly ? `PlanNode capability ${capability} is human-only.` : `No enabled AgentProfileRevision is eligible for ${capability}.`,
        ineligibility,
      };
    }
    const winner = ranked[0]!;
    const previous = previousRows[0];
    const [assignment] = await db.insert(workforceAssignments).values({
      tenantId: params.tenantId,
      workId: params.workId,
      planRevisionId: params.planRevisionId,
      planNodeId: params.node.id,
      objectiveLoopId: params.objectiveLoop.id,
      objectiveStepId: params.objectiveStepId,
      agentProfileId: winner.candidate.profile.id,
      agentRevisionId: winner.candidate.revision.id,
      capability,
      nodeKind: params.node.kind,
      state: "queued",
      budgetSnapshot: {
        p6: winner.candidate.p6BudgetCeilings,
        profile: winner.candidate.revision.autonomyLimits,
        usage: winner.candidate.budgetUsage,
      },
      assignmentReason: `Eligible exact capability ${capability}; deterministic lexicographic rank selected ${winner.candidate.profile.id}.`,
      assignmentScore: winner.score,
      previousAssignmentId: previous?.id ?? null,
      reassignmentReason: previous ? String(previous.reassignmentReason ?? (previous.failure && (previous.failure as Record<string, unknown>).code) ?? "PRIOR_ASSIGNMENT_TERMINAL") : null,
    }).returning();
    if (!assignment) throw new Error("Unable to persist WorkforceAssignment");
    await db.insert(jobs).values({
      type: "run_workforce_assignment",
      payload: {
        tenantId: params.tenantId,
        workId: params.workId,
        objectiveLoopId: params.objectiveLoop.id,
        expectedRevision: params.objectiveLoop.revision,
        expectedStepNumber: params.objectiveLoop.stepCount,
        workforceAssignmentId: assignment.id,
      },
      idempotencyKey: `workforce:${assignment.id}:attempt:1`,
      lane: "interactive",
      priority: 20,
    }).onConflictDoNothing();
    return { status: "assigned", assignment, score: winner.score, created: true };
  });
}

/** Human-governed relinquishment. The next ObjectiveLoop pass creates a new
 * immutable assignment by normal eligibility/ranking; ownership is never
 * overwritten and an in-flight old worker is fenced by assignment state. */
export async function reassignWorkforceAssignment(params: {
  tenantId: string;
  assignmentId: string;
  actor: TenantContext;
  note?: string;
}): Promise<typeof workforceAssignments.$inferSelect> {
  if (!params.actor.employeeId || params.actor.employeeId !== params.actor.userId || params.actor.tenantId !== params.tenantId) {
    throw new Error("Workforce reassignment requires an authenticated human employee in the same tenant");
  }
  const allowed = await canExerciseAuthority(params.actor, {
    operation: "action",
    capability: "workforce:reassign_agent",
    resource: { type: "workforce_assignment", id: params.assignmentId },
    risk: "medium",
  }).catch(() => false);
  if (!allowed) throw new Error("Current human authority cannot reassign AI workers");
  const note = params.note?.trim();
  if (note && Buffer.byteLength(note, "utf8") > 2_000) throw new Error("Workforce reassignment note exceeds the governed bound");
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workforceAssignments} WHERE ${workforceAssignments.tenantId}=${params.tenantId} AND ${workforceAssignments.id}=${params.assignmentId} FOR UPDATE`);
    const [assignment] = await db.select().from(workforceAssignments).where(and(
      eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.id, params.assignmentId),
    )).limit(1);
    if (!assignment) throw new Error("WorkforceAssignment was not found in the authenticated tenant");
    if (assignment.state === "reassigned" && assignment.reassignmentReason === "OPERATOR_REQUESTED") return assignment;
    if (![...ACTIVE_ASSIGNMENT_STATES].includes(assignment.state as (typeof ACTIVE_ASSIGNMENT_STATES)[number])) {
      throw new Error(`Terminal WorkforceAssignment cannot be reassigned from ${assignment.state}`);
    }
    const [updated] = await db.update(workforceAssignments).set({
      state: "reassigned",
      completedAt: new Date(),
      leaseOwner: null,
      leaseUntil: null,
      reassignmentReason: "OPERATOR_REQUESTED",
      failure: { code: "OPERATOR_REQUESTED", actorId: params.actor.employeeId, ...(note ? { note } : {}) },
      updatedAt: new Date(),
    }).where(and(eq(workforceAssignments.id, assignment.id), inArray(workforceAssignments.state, [...ACTIVE_ASSIGNMENT_STATES]))).returning();
    if (!updated) throw new Error("WorkforceAssignment reassignment lost its ownership race");
    if (updated.objectiveLoopId) {
      const [loop] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, params.tenantId), eq(workObjectiveLoops.id, updated.objectiveLoopId))).limit(1);
      const [step] = updated.objectiveStepId ? await db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.id, updated.objectiveStepId))).limit(1) : [];
      if (loop && !["blocked", "completed", "failed", "cancelled"].includes(loop.state)) {
        await db.insert(jobs).values({
          type: "run_objective_iteration",
          payload: {
            tenantId: params.tenantId,
            workId: updated.workId,
            objectiveLoopId: loop.id,
            expectedRevision: loop.revision,
            ...(!step?.completedAt && step ? { expectedStepNumber: step.stepNumber } : {}),
          },
          idempotencyKey: `workforce-operator-reassign:${updated.id}`,
          lane: "interactive",
          priority: 25,
        }).onConflictDoNothing();
      }
    }
    return updated;
  });
}

export type WorkforceClaimResult =
  | { status: "claimed"; assignment: typeof workforceAssignments.$inferSelect; leaseOwner: string }
  | { status: "busy" | "expired" | "reassigned" | "invalid" | "terminal"; reason: string };

export async function claimWorkforceAssignment(params: {
  tenantId: string;
  assignmentId: string;
  leaseOwner?: string;
}): Promise<WorkforceClaimResult> {
  const owner = params.leaseOwner ?? randomUUID();
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workforceAssignments} WHERE ${workforceAssignments.tenantId}=${params.tenantId} AND ${workforceAssignments.id}=${params.assignmentId} FOR UPDATE`);
    let [assignment] = await db.select().from(workforceAssignments).where(and(eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.id, params.assignmentId))).limit(1);
    if (!assignment) return { status: "invalid", reason: "Assignment is not in the authenticated tenant." };
    if (["completed", "failed", "cancelled", "reassigned"].includes(assignment.state)) return { status: "terminal", reason: `Assignment is ${assignment.state}.` };
    if ((assignment.state === "claimed" || assignment.state === "running") && assignment.leaseOwner !== owner) {
      if (assignment.leaseUntil && assignment.leaseUntil > new Date()) return { status: "busy", reason: "Assignment has a current lease owner." };
      await db.update(workforceAssignments).set({
        state: "reassigned", completedAt: new Date(), leaseOwner: null, leaseUntil: null,
        reassignmentReason: "LEASE_EXPIRED", failure: { code: "LEASE_EXPIRED", priorLeaseOwner: assignment.leaseOwner }, updatedAt: new Date(),
      }).where(eq(workforceAssignments.id, assignment.id));
      return { status: "expired", reason: "Expired assignment was preserved as reassignment history." };
    }
    const [scope] = await db.select({
      planStatus: workPlanRevisions.status,
      planRevision: workPlanRevisions.revision,
      profileStatus: agentProfiles.status,
      revisionStatus: agentProfileRevisions.status,
      revisionProfileId: agentProfileRevisions.agentProfileId,
      modelRoute: agentProfileRevisions.modelRoute,
      autonomyLimits: agentProfileRevisions.autonomyLimits,
      loopActionCount: workObjectiveLoops.actionCount,
      loopQueryCount: workObjectiveLoops.queryCount,
      loopStepCount: workObjectiveLoops.stepCount,
      loopMaxActions: workObjectiveLoops.maxActions,
      loopMaxQueries: workObjectiveLoops.maxQueries,
      loopMaxSteps: workObjectiveLoops.maxSteps,
      loopCreatedAt: workObjectiveLoops.createdAt,
      loopDeadlineAt: workObjectiveLoops.deadlineAt,
    }).from(workforceAssignments)
      .innerJoin(workPlanRevisions, eq(workPlanRevisions.id, workforceAssignments.planRevisionId))
      .innerJoin(agentProfiles, eq(agentProfiles.id, workforceAssignments.agentProfileId))
      .innerJoin(agentProfileRevisions, eq(agentProfileRevisions.id, workforceAssignments.agentRevisionId))
      .innerJoin(workObjectiveLoops, and(
        eq(workObjectiveLoops.id, workforceAssignments.objectiveLoopId),
        eq(workObjectiveLoops.tenantId, workforceAssignments.tenantId),
      ))
      .where(and(eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.id, assignment.id))).limit(1);
    if (!scope || scope.planStatus !== "active" || scope.profileStatus !== "enabled" || scope.revisionStatus !== "active" || scope.revisionProfileId !== assignment.agentProfileId) {
      await db.update(workforceAssignments).set({ state: "cancelled", completedAt: new Date(), leaseOwner: null, leaseUntil: null, failure: { code: "ASSIGNMENT_SCOPE_STALE" }, updatedAt: new Date() }).where(eq(workforceAssignments.id, assignment.id));
      return { status: "invalid", reason: "Assignment plan/profile/revision is no longer current." };
    }
    const limits = effectiveAutonomyLimits(
      scope.autonomyLimits as AgentAutonomyLimits,
      {
        maxActions: scope.loopMaxActions,
        maxQueries: scope.loopMaxQueries,
        maxReplans: scope.loopMaxSteps,
        maxPlannerCalls: scope.loopMaxSteps,
        maxWallClockMs: Math.max(1, scope.loopDeadlineAt.getTime() - scope.loopCreatedAt.getTime()),
        maxKnownCostUsd: null,
        maxKnownTokens: null,
      },
    );
    const budgetExhausted = (assignment.nodeKind === "action" && scope.loopActionCount >= limits.maxActions)
      || (assignment.nodeKind === "query" && scope.loopQueryCount >= limits.maxQueries)
      || Math.max(0, scope.planRevision - 1) >= limits.maxReplans
      || scope.loopStepCount >= limits.maxPlannerCalls
      || Math.max(0, Date.now() - scope.loopCreatedAt.getTime()) >= limits.maxWallClockMs;
    const reassignmentReason: WorkforceReassignmentReason | null = !routeAvailable(scope.modelRoute as AgentModelRoute)
      ? "MODEL_ROUTE_UNAVAILABLE"
      : budgetExhausted
        ? "AUTONOMY_BUDGET_EXHAUSTED"
        : null;
    if (reassignmentReason) {
      await db.update(workforceAssignments).set({
        state: "reassigned",
        completedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
        reassignmentReason,
        failure: { code: reassignmentReason, detectedAt: "claim" },
        updatedAt: new Date(),
      }).where(and(eq(workforceAssignments.id, assignment.id), inArray(workforceAssignments.state, [...ACTIVE_ASSIGNMENT_STATES])));
      return { status: "reassigned", reason: `Assignment relinquished at claim: ${reassignmentReason}.` };
    }
    const leaseUntil = new Date(Date.now() + WORKFORCE_LEASE_MS);
    if (assignment.state === "queued") {
      [assignment] = await db.update(workforceAssignments).set({ state: "claimed", attempt: assignment.attempt + 1, leaseOwner: owner, leaseUntil, startedAt: assignment.startedAt ?? new Date(), updatedAt: new Date() })
        .where(and(eq(workforceAssignments.id, assignment.id), eq(workforceAssignments.state, "queued"))).returning();
    }
    if (!assignment) return { status: "busy", reason: "Another worker claimed the assignment." };
    if (assignment.state === "claimed") {
      [assignment] = await db.update(workforceAssignments).set({ state: "running", leaseOwner: owner, leaseUntil, updatedAt: new Date() })
        .where(and(eq(workforceAssignments.id, assignment.id), eq(workforceAssignments.state, "claimed"), eq(workforceAssignments.leaseOwner, owner))).returning();
    }
    if (!assignment || assignment.leaseOwner !== owner) return { status: "busy", reason: "Another worker owns the assignment lease." };
    return { status: "claimed", assignment, leaseOwner: owner };
  });
}

export async function renewWorkforceAssignmentLease(tenantId: string, assignmentId: string, leaseOwner: string): Promise<boolean> {
  const rows = await withTenant(tenantId, (db) => db.update(workforceAssignments).set({ leaseUntil: new Date(Date.now() + WORKFORCE_LEASE_MS), updatedAt: new Date() }).where(and(
    eq(workforceAssignments.tenantId, tenantId), eq(workforceAssignments.id, assignmentId), eq(workforceAssignments.leaseOwner, leaseOwner),
    inArray(workforceAssignments.state, ["claimed", "running"]), sql`${workforceAssignments.leaseUntil} > now()`,
  )).returning({ id: workforceAssignments.id }));
  return rows.length === 1;
}

export async function isWorkforceAssignmentCurrent(params: { tenantId: string; assignmentId: string; leaseOwner: string; planRevisionId: string; planNodeId: string; agentRevisionId: string }): Promise<boolean> {
  const [row] = await withTenant(params.tenantId, (db) => db.select({ id: workforceAssignments.id }).from(workforceAssignments)
    .innerJoin(workPlanRevisions, and(eq(workPlanRevisions.id, workforceAssignments.planRevisionId), eq(workPlanRevisions.tenantId, workforceAssignments.tenantId)))
    .innerJoin(agentProfileRevisions, and(eq(agentProfileRevisions.id, workforceAssignments.agentRevisionId), eq(agentProfileRevisions.tenantId, workforceAssignments.tenantId)))
    .innerJoin(agentProfiles, and(eq(agentProfiles.id, workforceAssignments.agentProfileId), eq(agentProfiles.tenantId, workforceAssignments.tenantId)))
    .where(and(
      eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.id, params.assignmentId), eq(workforceAssignments.state, "running"),
      eq(workforceAssignments.leaseOwner, params.leaseOwner), sql`${workforceAssignments.leaseUntil} > now()`,
      eq(workforceAssignments.planRevisionId, params.planRevisionId), eq(workforceAssignments.planNodeId, params.planNodeId), eq(workforceAssignments.agentRevisionId, params.agentRevisionId),
      eq(workPlanRevisions.status, "active"), eq(agentProfileRevisions.status, "active"), eq(agentProfiles.status, "enabled"),
    )).limit(1));
  return Boolean(row);
}

export async function finalizeWorkforceAssignment(params: {
  tenantId: string;
  assignmentId: string;
  leaseOwner: string;
  objectiveOutcome?: string;
  thrownFailure?: unknown;
}): Promise<void> {
  await withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workforceAssignments} WHERE ${workforceAssignments.tenantId}=${params.tenantId} AND ${workforceAssignments.id}=${params.assignmentId} FOR UPDATE`);
    const [assignment] = await db.select().from(workforceAssignments).where(and(eq(workforceAssignments.tenantId, params.tenantId), eq(workforceAssignments.id, params.assignmentId))).limit(1);
    if (!assignment || assignment.state !== "running" || assignment.leaseOwner !== params.leaseOwner) return;
    const [step] = assignment.objectiveStepId ? await db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.id, assignment.objectiveStepId))).limit(1) : [];
    if (params.thrownFailure) {
      const error = params.thrownFailure instanceof Error ? { name: params.thrownFailure.name, message: params.thrownFailure.message } : { message: String(params.thrownFailure) };
      await db.update(workforceAssignments).set({ state: "failed", completedAt: new Date(), leaseOwner: null, leaseUntil: null, failure: { code: "WORKER_EXECUTION_FAILED", ...error }, updatedAt: new Date() }).where(eq(workforceAssignments.id, assignment.id));
      return;
    }
    if (!step?.completedAt) {
      // A true process crash never reaches this branch. A controlled early return
      // relinquishes only the assignment lease; exact ObjectiveStep identity remains.
      await db.update(workforceAssignments).set({ state: "queued", leaseOwner: null, leaseUntil: null, updatedAt: new Date() }).where(eq(workforceAssignments.id, assignment.id));
      return;
    }
    const outcome = params.objectiveOutcome ?? step.iterationOutcome;
    const waiting = outcome === "waiting" || outcome === "awaiting_approval";
    const failed = outcome === "failed" || outcome === "blocked" || Boolean(step.failure);
    const cancelled = outcome === "cancelled";
    const state = waiting ? "waiting" : cancelled ? "cancelled" : failed ? "failed" : "completed";
    await db.update(workforceAssignments).set({
      state,
      leaseOwner: null,
      leaseUntil: null,
      domainActionId: step.domainActionId,
      completedAt: waiting ? null : new Date(),
      failure: failed ? { code: outcome === "blocked" ? "OBJECTIVE_BLOCKED" : "OBJECTIVE_STEP_FAILED", detail: step.failure ?? {}, reason: step.decisionReason } : null,
      updatedAt: new Date(),
    }).where(eq(workforceAssignments.id, assignment.id));
  });
}

export async function completePriorWaitingAssignments(tenantId: string, objectiveLoopId: string, currentStepId: string): Promise<void> {
  const completedIds = await withTenant(tenantId, async (db) => {
    const rows = await db.select({ id: workforceAssignments.id }).from(workforceAssignments)
      .innerJoin(workObjectiveSteps, eq(workObjectiveSteps.id, workforceAssignments.objectiveStepId))
      .where(and(eq(workforceAssignments.tenantId, tenantId), eq(workforceAssignments.objectiveLoopId, objectiveLoopId), eq(workforceAssignments.state, "waiting"), sql`${workObjectiveSteps.id} <> ${currentStepId}`, sql`${workObjectiveSteps.completedAt} IS NOT NULL`));
    for (const row of rows) await db.update(workforceAssignments).set({ state: "completed", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(workforceAssignments.id, row.id), eq(workforceAssignments.state, "waiting")));
    return rows.map((row) => row.id);
  });
  for (const id of completedIds) await recordLearningObservationForAssignment(tenantId, id);
}

export async function enqueueAssignmentRecovery(tenantId: string, assignmentId: string): Promise<void> {
  await withTenant(tenantId, async (db) => {
    const [assignment] = await db.select().from(workforceAssignments).where(and(eq(workforceAssignments.tenantId, tenantId), eq(workforceAssignments.id, assignmentId))).limit(1);
    if (!assignment?.objectiveLoopId || !assignment.objectiveStepId) return;
    const [loop] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.id, assignment.objectiveLoopId))).limit(1);
    const [step] = await db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.id, assignment.objectiveStepId))).limit(1);
    if (!loop || !step || step.completedAt) return;
    await db.insert(jobs).values({
      type: "run_objective_iteration",
      payload: { tenantId, workId: assignment.workId, objectiveLoopId: loop.id, expectedRevision: loop.revision, expectedStepNumber: step.stepNumber },
      idempotencyKey: `workforce-recovery:${assignment.id}:attempt:${assignment.attempt}`,
      lane: "interactive",
      priority: 25,
    }).onConflictDoNothing();
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceRef(type: LearningSourceRef["type"], id: string, value?: unknown): LearningSourceRef {
  return { type, id, ...(value === undefined ? {} : { hash: workforceHash(value) }) };
}

/** Derives one immutable observation exclusively from durable P6/execution rows.
 * No model critique, rationale, self-rating, or free-form Work instruction is read. */
export async function recordLearningObservationForAssignment(tenantId: string, assignmentId: string): Promise<typeof learningObservations.$inferSelect | null> {
  return withTenant(tenantId, async (db) => {
    const [existing] = await db.select().from(learningObservations).where(and(eq(learningObservations.tenantId, tenantId), eq(learningObservations.workforceAssignmentId, assignmentId))).limit(1);
    if (existing) return existing;
    const [assignment] = await db.select().from(workforceAssignments).where(and(eq(workforceAssignments.tenantId, tenantId), eq(workforceAssignments.id, assignmentId))).limit(1);
    if (!assignment || !["completed", "failed", "cancelled", "reassigned"].includes(assignment.state) || !assignment.objectiveStepId) return null;
    const [step] = await db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.id, assignment.objectiveStepId))).limit(1);
    const [plan] = await db.select().from(workPlanRevisions).where(and(eq(workPlanRevisions.tenantId, tenantId), eq(workPlanRevisions.id, assignment.planRevisionId))).limit(1);
    if (!step?.completedAt || !plan) return null;
    const [action] = assignment.domainActionId ? await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, assignment.domainActionId))).limit(1) : [];
    const [query] = step.queryExecutionId ? await db.select().from(workQueryExecutions).where(and(eq(workQueryExecutions.tenantId, tenantId), eq(workQueryExecutions.id, step.queryExecutionId))).limit(1) : [];
    const [effectRows, receiptRows, waitRows] = await Promise.all([
      action ? db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.domainActionId, action.id))) : Promise.resolve([]),
      action ? db.select().from(decisionReceipts).where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.domainActionId, action.id))) : Promise.resolve([]),
      db.select().from(workEventWaits).where(and(eq(workEventWaits.tenantId, tenantId), eq(workEventWaits.objectiveStepId, step.id))),
    ]);
    const proof = record(plan.completionProof);
    const sourceRefs: LearningSourceRef[] = [
      sourceRef("objective_step", step.id, { outcome: step.iterationOutcome, failure: step.failure, observation: step.observation }),
      sourceRef("plan_node", assignment.planNodeId, { planRevisionId: assignment.planRevisionId, capability: assignment.capability }),
      ...(proof.verified === true ? [sourceRef("completion_proof" as const, plan.id, proof)] : []),
      ...(action ? [sourceRef("domain_action" as const, action.id, { status: action.status, businessEffectId: action.businessEffectId })] : []),
      ...effectRows.map((effect) => ({ type: "business_effect" as const, id: effect.id, hash: effect.semanticHash })),
      ...receiptRows.map((receipt) => sourceRef("decision_receipt", receipt.id, { finalizedAt: receipt.finalizedAt, failure: receipt.failure, verification: receipt.verification, executedEffectHash: receipt.executedEffectHash })),
      ...(query ? [sourceRef("query_execution" as const, query.id, { status: query.status, durationMs: query.durationMs, failure: query.failure })] : []),
      ...waitRows.filter((wait) => wait.matchedEventId || wait.status === "timed_out").map((wait) => sourceRef("work_event_wait", wait.id, { status: wait.status, matchedEventId: wait.matchedEventId })),
    ];
    const failure = canonicalJson({ assignment: assignment.failure, step: step.failure, stepReason: step.decisionReason, action: action ? { status: action.status } : null, query: query ? { status: query.status, failure: query.failure } : null, effects: effectRows.map((effect) => ({ status: effect.status })) }).toLowerCase();
    const waitSatisfied = waitRows.some((wait) => wait.status === "satisfied" && wait.matchedEventId);
    const durableSuccess = proof.verified === true
      || query?.status === "succeeded"
      || action?.status === "completed"
      || effectRows.some((effect) => effect.status === "verified")
      || waitSatisfied;
    const outcomeClass = attributeLearningOutcome({
      verifiedCompletion: assignment.state === "completed" && durableSuccess,
      userCancelled: assignment.state === "cancelled" || /user.?cancel|objective.?cancel/.test(failure),
      humanRejected: action?.status === "rejected" || /human.?reject|approval.?reject/.test(failure),
      humanCorrected: /human.?correct/.test(failure),
      authorityDenied: /authority.?denied|authority_denial/.test(failure),
      schemaOrCompileRejected: /schema|compile.?reject|plan.?compil/.test(failure),
      providerUnavailable: /provider.*(?:unavailable|down)|microsoft.*(?:unavailable|down)|blocked_integration_unavailable|circuit.?open/.test(failure),
      externalFailure: effectRows.some((effect) => ["divergent", "reconciliation_required", "failed"].includes(effect.status)) || /external.?failure/.test(failure),
      staleWorldOrReplan: /stale|supersed|replan|plan_changed/.test(failure),
      timedOut: /timed?.?out|deadline/.test(failure),
      businessOutcomeFailed: action?.status === "failed" || /business.?outcome.?fail/.test(failure),
      planningFailed: /planner|planning.?fail/.test(failure),
      recovered: /recover/.test(failure),
    });
    const verified = sourceRefs.length > 0 && (outcomeClass !== "verified_completion" || durableSuccess);
    const snapshot = record(plan.planningSnapshot);
    const occurredAt = assignment.completedAt ?? step.completedAt;
    const latencyMs = assignment.startedAt ? Math.max(0, occurredAt.getTime() - assignment.startedAt.getTime()) : null;
    const knownCosts = receiptRows.map((receipt) => receipt.llmCostUsd).filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost));
    const observationBody: Omit<LearningObservation, "id" | "observationHash"> = {
      tenantId,
      agentProfileId: assignment.agentProfileId,
      agentRevisionId: assignment.agentRevisionId,
      workforceAssignmentId: assignment.id,
      capability: assignment.capability,
      nodeKind: assignment.nodeKind,
      contextClass: `${typeof snapshot.verticalKey === "string" ? snapshot.verticalKey : "unknown"}:${assignment.nodeKind}`,
      workId: assignment.workId,
      planRevisionId: assignment.planRevisionId,
      planNodeId: assignment.planNodeId,
      outcomeClass,
      verified,
      sourceRefs,
      contextFeatures: {
        verticalKey: typeof snapshot.verticalKey === "string" ? snapshot.verticalKey : "unknown",
        nodeKind: assignment.nodeKind,
        capability: assignment.capability,
        planReason: plan.reason,
      },
      measuredMetrics: {
        latencyMs,
        knownCostUsd: knownCosts.length > 0 ? knownCosts.reduce((sum, cost) => sum + cost, 0) : null,
        knownTokens: null,
        replans: outcomeClass === "stale_world_replan" ? 1 : 0,
        recoveries: outcomeClass === "recovery" ? 1 : 0,
      },
      occurredAt: occurredAt.toISOString(),
    };
    const [created] = await db.insert(learningObservations).values({
      ...observationBody,
      occurredAt,
      observationHash: learningObservationHash(observationBody),
    }).onConflictDoNothing().returning();
    if (created) return created;
    const [raced] = await db.select().from(learningObservations).where(and(eq(learningObservations.tenantId, tenantId), eq(learningObservations.workforceAssignmentId, assignmentId))).limit(1);
    return raced ?? null;
  });
}

export async function learningRevisionForAgent(tenantId: string, agentProfileId: string) {
  const [row] = await withTenant(tenantId, (db) => db.select().from(learningRevisions).where(and(eq(learningRevisions.tenantId, tenantId), eq(learningRevisions.targetAgentProfileId, agentProfileId))).orderBy(desc(learningRevisions.revision)).limit(1));
  return row ?? null;
}
