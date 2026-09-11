import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  agentProfileRevisions,
  agentProfiles,
  learningObservations,
  learningProposals,
  learningRevisions,
  withTenant,
} from "@finnor/db";
import type { TenantContext } from "@finnor/shared-types";
import {
  assertSafeLearningChange,
  computeLearningMetrics,
  proposalChangeForMetric,
  type LearningObservation,
  type LearningProposedChange,
  type LearningRevision,
} from "@finnor/workforce";
import { canExerciseAuthority } from "@finnor/authority";
import { workforceHash } from "./workforce-runtime";

function observationShape(row: typeof learningObservations.$inferSelect): LearningObservation {
  return {
    ...row,
    sourceRefs: row.sourceRefs as LearningObservation["sourceRefs"],
    contextFeatures: row.contextFeatures as LearningObservation["contextFeatures"],
    measuredMetrics: row.measuredMetrics as LearningObservation["measuredMetrics"],
    occurredAt: row.occurredAt.toISOString(),
  };
}

export interface WorkforceLearningDigestResult {
  observationCount: number;
  metricSliceCount: number;
  createdProposalIds: string[];
  observationsTruncated: boolean;
  activeProposalsTruncated: boolean;
}

/** P7 extension of the existing learning_digest job. It is deterministic and
 * proposal-only: no configuration changes occur here. */
export async function generateWorkforceLearningProposals(tenantId: string, windowDays = 90): Promise<WorkforceLearningDigestResult> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  return withTenant(tenantId, async (db) => {
    const rawRows = await db.select().from(learningObservations).where(and(
      eq(learningObservations.tenantId, tenantId),
      eq(learningObservations.verified, true),
      gte(learningObservations.occurredAt, since),
    )).orderBy(asc(learningObservations.occurredAt), asc(learningObservations.id)).limit(10_001);
    const observationsTruncated = rawRows.length > 10_000;
    const rows = rawRows.slice(0, 10_000);
    const observations = rows.map(observationShape);
    const metrics = computeLearningMetrics(observations);
    const rawActiveProposalRows = await db.select({
      id: learningProposals.id,
      targetAgentRevisionId: learningProposals.targetAgentRevisionId,
      capability: learningProposals.capability,
      proposedChange: learningProposals.proposedChange,
    }).from(learningProposals).where(and(eq(learningProposals.tenantId, tenantId), inArray(learningProposals.status, ["proposed", "approved"]))).limit(2_001);
    const activeProposalsTruncated = rawActiveProposalRows.length > 2_000;
    const activeProposalRows = rawActiveProposalRows.slice(0, 2_000);
    const openKeys = new Set(activeProposalRows.map((proposal) => {
      const change = proposal.proposedChange as LearningProposedChange;
      return `${proposal.targetAgentRevisionId}:${proposal.capability ?? "*"}:${change.class}`;
    }));
    const createdProposalIds: string[] = [];
    // A partial evidence or de-duplication window must never silently create a
    // behavioral recommendation. Operators can see the bound and first archive
    // or narrow the source set; existing immutable observations remain intact.
    if (observationsTruncated || activeProposalsTruncated) {
      return { observationCount: observations.length, metricSliceCount: metrics.length, createdProposalIds, observationsTruncated, activeProposalsTruncated };
    }
    for (const metric of metrics) {
      const proposedChange = proposalChangeForMetric(metric);
      if (!proposedChange) continue;
      assertSafeLearningChange(proposedChange);
      const openKey = `${metric.agentRevisionId}:${metric.capability}:${proposedChange.class}`;
      if (openKeys.has(openKey)) continue;
      const evidence = observations.filter((observation) => observation.agentRevisionId === metric.agentRevisionId
        && observation.capability === metric.capability && observation.nodeKind === metric.nodeKind
        && observation.contextClass === metric.contextClass);
      if (evidence.length < 5) continue;
      const observationRefs = evidence.map((observation) => observation.id).sort();
      const evidenceWindow = { from: evidence[0]!.occurredAt, to: evidence.at(-1)!.occurredAt };
      const proposalHash = workforceHash({
        tenantId,
        targetId: metric.agentProfileId,
        targetAgentRevisionId: metric.agentRevisionId,
        capability: metric.capability,
        evidenceWindow,
        observationRefs,
        proposedChange,
      });
      const [created] = await db.insert(learningProposals).values({
        tenantId,
        targetType: "agent_capability",
        targetId: metric.agentProfileId,
        targetAgentRevisionId: metric.agentRevisionId,
        capability: metric.capability,
        evidenceWindow,
        sampleSize: observationRefs.length,
        observationRefs,
        proposedChange,
        confidenceClass: metric.qualityAttemptCount >= 20 ? "STRONG" : "SUPPORTED",
        status: "proposed",
        proposalHash,
      }).onConflictDoNothing().returning({ id: learningProposals.id });
      if (created) {
        createdProposalIds.push(created.id);
        openKeys.add(openKey);
      }
    }
    return { observationCount: observations.length, metricSliceCount: metrics.length, createdProposalIds, observationsTruncated, activeProposalsTruncated };
  });
}

function emptyGuidance(): LearningRevision["guidance"] {
  return {
    routingPreferences: {},
    capabilityReliabilityPriors: {},
    softPlanningHints: {},
    modelRoutePreferences: {},
    warnings: {},
  };
}

function applySoftChange(base: LearningRevision["guidance"], change: LearningProposedChange): LearningRevision["guidance"] {
  assertSafeLearningChange(change);
  const next: LearningRevision["guidance"] = {
    routingPreferences: { ...base.routingPreferences },
    capabilityReliabilityPriors: { ...base.capabilityReliabilityPriors },
    softPlanningHints: { ...base.softPlanningHints },
    modelRoutePreferences: { ...base.modelRoutePreferences },
    warnings: { ...base.warnings },
  };
  if (change.class === "routing_preference_adjustment") next.routingPreferences[change.capability] = change.weight;
  else if (change.class === "capability_quality_warning") next.warnings[change.capability] = change.warning;
  else if (change.class === "deprioritize_worker_recommendation") {
    next.routingPreferences[change.capability] = -0.2;
    next.warnings[change.capability] = change.reason;
  } else if (change.class === "soft_planning_hint_update") next.softPlanningHints[change.hintKey] = change.hint;
  else next.modelRoutePreferences[change.capability] = { provider: change.provider, model: change.model ?? null };
  return next;
}

export async function rejectLearningProposal(params: { tenantId: string; proposalId: string; actor: TenantContext }): Promise<typeof learningProposals.$inferSelect> {
  if (!params.actor.employeeId || params.actor.employeeId !== params.actor.userId || params.actor.tenantId !== params.tenantId) {
    throw new Error("Learning review requires an authenticated human employee in the same tenant");
  }
  const allowed = await canExerciseAuthority(params.actor, {
    operation: "action",
    capability: "workforce:promote_learning",
    resource: { type: "learning_proposal", id: params.proposalId },
    risk: "medium",
  }).catch(() => false);
  if (!allowed) throw new Error("Current human authority cannot review workforce learning");
  const actorId = params.actor.employeeId;
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${learningProposals} WHERE ${learningProposals.tenantId}=${params.tenantId} AND ${learningProposals.id}=${params.proposalId} FOR UPDATE`);
    const [proposal] = await db.select().from(learningProposals).where(and(eq(learningProposals.tenantId, params.tenantId), eq(learningProposals.id, params.proposalId))).limit(1);
    if (!proposal) throw new Error("LearningProposal was not found in the authenticated tenant");
    if (proposal.status === "rejected") return proposal;
    if (proposal.status !== "proposed") throw new Error(`LearningProposal cannot be rejected from ${proposal.status}`);
    const [updated] = await db.update(learningProposals).set({ status: "rejected", reviewedBy: actorId, reviewedAt: new Date() }).where(eq(learningProposals.id, proposal.id)).returning();
    if (!updated) throw new Error("LearningProposal review update was lost");
    return updated;
  });
}

export async function promoteLearningProposal(params: {
  tenantId: string;
  proposalId: string;
  actor: TenantContext;
}): Promise<{ proposal: typeof learningProposals.$inferSelect; learningRevision: typeof learningRevisions.$inferSelect; agentRevision: typeof agentProfileRevisions.$inferSelect }> {
  if (!params.actor.employeeId || params.actor.employeeId !== params.actor.userId || params.actor.tenantId !== params.tenantId) {
    throw new Error("Learning promotion requires an authenticated human employee in the same tenant");
  }
  const actorId = params.actor.employeeId;
  const allowed = await canExerciseAuthority(params.actor, {
    operation: "action",
    capability: "workforce:promote_learning",
    resource: { type: "learning_proposal", id: params.proposalId },
    risk: "medium",
  }).catch(() => false);
  if (!allowed) throw new Error("Current human authority cannot promote workforce learning");
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${learningProposals} WHERE ${learningProposals.tenantId}=${params.tenantId} AND ${learningProposals.id}=${params.proposalId} FOR UPDATE`);
    let [proposal] = await db.select().from(learningProposals).where(and(eq(learningProposals.tenantId, params.tenantId), eq(learningProposals.id, params.proposalId))).limit(1);
    if (!proposal) throw new Error("LearningProposal was not found in the authenticated tenant");
    if (proposal.status === "promoted") {
      const [learningRevision] = await db.select().from(learningRevisions).where(and(eq(learningRevisions.tenantId, params.tenantId), eq(learningRevisions.sourceProposalId, proposal.id))).limit(1);
      const [agentRevision] = learningRevision ? await db.select().from(agentProfileRevisions).where(and(eq(agentProfileRevisions.tenantId, params.tenantId), eq(agentProfileRevisions.learningRevisionId, learningRevision.id))).orderBy(desc(agentProfileRevisions.revision)).limit(1) : [];
      if (!learningRevision || !agentRevision) throw new Error("Promoted proposal is missing its immutable revision bindings");
      return { proposal, learningRevision, agentRevision };
    }
    if (proposal.status === "rejected") throw new Error("Rejected LearningProposal cannot be promoted");
    if (proposal.status === "proposed") {
      [proposal] = await db.update(learningProposals).set({ status: "approved", reviewedBy: actorId, reviewedAt: new Date() }).where(eq(learningProposals.id, proposal.id)).returning();
      if (!proposal) throw new Error("LearningProposal approval update was lost");
    }
    const change = proposal.proposedChange as LearningProposedChange;
    assertSafeLearningChange(change);
    await db.execute(sql`SELECT id FROM ${agentProfiles} WHERE ${agentProfiles.tenantId}=${params.tenantId} AND ${agentProfiles.id}=${proposal.targetId} FOR UPDATE`);
    const [profile] = await db.select().from(agentProfiles).where(and(eq(agentProfiles.tenantId, params.tenantId), eq(agentProfiles.id, proposal.targetId))).limit(1);
    if (!profile) throw new Error("LearningProposal target AgentProfile is missing");
    const [activeRevision] = await db.select().from(agentProfileRevisions).where(and(eq(agentProfileRevisions.tenantId, params.tenantId), eq(agentProfileRevisions.agentProfileId, profile.id), eq(agentProfileRevisions.status, "active"))).limit(1);
    if (!activeRevision) throw new Error("LearningProposal target has no active AgentProfileRevision");
    const [parent] = await db.select().from(learningRevisions).where(and(eq(learningRevisions.tenantId, params.tenantId), eq(learningRevisions.targetAgentProfileId, profile.id))).orderBy(desc(learningRevisions.revision)).limit(1);
    const guidance = applySoftChange((parent?.guidance as LearningRevision["guidance"] | undefined) ?? emptyGuidance(), change);
    const semanticHash = workforceHash({ targetAgentProfileId: profile.id, parentRevisionId: parent?.id ?? null, sourceProposalId: proposal.id, guidance });
    const [learningRevision] = await db.insert(learningRevisions).values({
      tenantId: params.tenantId,
      targetAgentProfileId: profile.id,
      revision: (parent?.revision ?? 0) + 1,
      parentRevisionId: parent?.id ?? null,
      sourceProposalId: proposal.id,
      guidance,
      semanticHash,
      promotedBy: actorId,
    }).returning();
    if (!learningRevision) throw new Error("Unable to persist LearningRevision");
    await db.update(agentProfileRevisions).set({ status: "superseded" }).where(eq(agentProfileRevisions.id, activeRevision.id));
    const config = {
      modelRoute: activeRevision.modelRoute,
      capabilityGrants: activeRevision.capabilityGrants,
      maxConcurrentAssignments: activeRevision.maxConcurrentAssignments,
      autonomyLimits: activeRevision.autonomyLimits,
      planningHints: activeRevision.planningHints,
      learningRevisionId: learningRevision.id,
    };
    const [agentRevision] = await db.insert(agentProfileRevisions).values({
      tenantId: params.tenantId,
      agentProfileId: profile.id,
      revision: activeRevision.revision + 1,
      modelRoute: activeRevision.modelRoute,
      capabilityGrants: activeRevision.capabilityGrants,
      maxConcurrentAssignments: activeRevision.maxConcurrentAssignments,
      autonomyLimits: activeRevision.autonomyLimits,
      planningHints: activeRevision.planningHints,
      learningRevisionId: learningRevision.id,
      status: "active",
      configHash: workforceHash(config),
      createdBy: actorId,
    }).returning();
    if (!agentRevision) throw new Error("Unable to persist promoted AgentProfileRevision");
    const [promoted] = await db.update(learningProposals).set({ status: "promoted", reviewedBy: actorId, reviewedAt: proposal.reviewedAt ?? new Date() }).where(and(eq(learningProposals.id, proposal.id), eq(learningProposals.status, "approved"))).returning();
    if (!promoted) throw new Error("LearningProposal promotion state update was lost");
    return { proposal: promoted, learningRevision, agentRevision };
  });
}
