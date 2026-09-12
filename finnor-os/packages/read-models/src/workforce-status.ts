import {
  agentProfileRevisions,
  agentProfiles,
  learningObservations,
  learningProposals,
  learningRevisions,
  workforceAssignments,
  withTenant,
} from "@finnor/db";
import type {
  WorkforceAssignmentSummary,
  WorkforceLearningProposalSummary,
  WorkforceLearningRevisionSummary,
  WorkforceMetricSummary,
  WorkforceRuntimeStatus,
  WorkforceStatusResult,
  WorkforceWorkerSummary,
} from "@finnor/shared-types";
import {
  computeLearningMetrics,
  type AgentAutonomyLimits,
  type AgentCapabilityGrant,
  type AgentModelRoute,
  type LearningObservation,
} from "@finnor/workforce";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ASSIGNMENT_HISTORY_LIMIT = 2_000;
const OBSERVATION_LIMIT = 10_000;
const PROPOSAL_LIMIT = 500;
const LEARNING_REVISION_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_ASSIGNMENT_STATES = ["queued", "claimed", "running", "waiting"] as const;
const ACTIVE_ASSIGNMENTS = new Set<string>(ACTIVE_ASSIGNMENT_STATES);
const LOAD_BEARING_ASSIGNMENTS = ["queued", "claimed", "running"] as const;
const BLOCKING_FAILURE_CODES = new Set([
  "AUTONOMY_BUDGET_EXHAUSTED",
  "HUMAN_REQUIRED",
  "HUMAN_ONLY_BOUNDARY",
  "NO_ELIGIBLE_AGENT",
  "NO_ELIGIBLE_AI_WORKER",
  "PLAN_SUPERSEDED",
  "POLICY_PROHIBITED",
]);

function requestedLimit(page: { limit?: number } | undefined): number {
  const limit = page?.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error("Workforce status page limit must be an integer from 1 to 100");
  }
  return limit;
}

function assignmentSummary(row: typeof workforceAssignments.$inferSelect): WorkforceAssignmentSummary {
  return {
    id: row.id,
    workId: row.workId,
    planRevisionId: row.planRevisionId,
    planNodeId: row.planNodeId,
    objectiveLoopId: row.objectiveLoopId,
    objectiveStepId: row.objectiveStepId,
    agentProfileId: row.agentProfileId,
    agentRevisionId: row.agentRevisionId,
    capability: row.capability,
    nodeKind: row.nodeKind,
    state: row.state,
    attempt: row.attempt,
    assignmentReason: row.assignmentReason,
    previousAssignmentId: row.previousAssignmentId,
    reassignmentReason: row.reassignmentReason,
    domainActionId: row.domainActionId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    failure: row.failure as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

function metricSummary(metric: ReturnType<typeof computeLearningMetrics>[number]): WorkforceMetricSummary {
  return {
    agentRevisionId: metric.agentRevisionId,
    capability: metric.capability,
    nodeKind: metric.nodeKind,
    contextClass: metric.contextClass,
    attemptCount: metric.attemptCount,
    qualityAttemptCount: metric.qualityAttemptCount,
    verifiedCompletionCount: metric.verifiedCompletionCount,
    qualityFailureCount: metric.qualityFailureCount,
    humanRejectionCount: metric.humanRejectionCount,
    providerOutageCount: metric.providerOutageCount,
    externalFailureCount: metric.externalFailureCount,
    replanCount: metric.replanCount,
    recoveryCount: metric.recoveryCount,
    sampleState: metric.sampleState,
    verifiedCompletionRate: metric.verifiedCompletionRate,
    qualityFailureRate: metric.qualityFailureRate,
    humanRejectionRate: metric.humanRejectionRate,
    medianLatencyMs: metric.medianLatencyMs,
    p95LatencyMs: metric.p95LatencyMs,
    knownCostUsd: metric.knownCostUsd,
  };
}

function statusFor(
  profile: typeof agentProfiles.$inferSelect,
  revision: typeof agentProfileRevisions.$inferSelect | undefined,
  latest: WorkforceAssignmentSummary | undefined,
): WorkforceRuntimeStatus {
  if (profile.status === "disabled" || !revision) return "unavailable";
  if (!latest) return "idle";
  if (["queued", "claimed", "running"].includes(latest.state)) return "working";
  if (latest.state === "waiting") return "waiting";
  if (latest.state === "failed" || latest.state === "reassigned") {
    const code = typeof latest.failure?.code === "string" ? latest.failure.code : latest.reassignmentReason;
    return code && BLOCKING_FAILURE_CODES.has(code) ? "blocked" : "failed";
  }
  return "idle";
}

/** Source-backed P7 projection. It never inventizes a worker, a status, or a
 * performance claim: an empty table is returned explicitly as unconfigured. */
export async function workforceStatus(
  tenantId: string,
  request: { page?: { limit?: number; cursor?: string } } = {},
  now = new Date(),
): Promise<WorkforceStatusResult> {
  const limit = requestedLimit(request.page);
  const cursor = request.page?.cursor;
  if (cursor !== undefined && !UUID.test(cursor)) throw new Error("Workforce status cursor must be an AgentProfile UUID");
  const rows = await withTenant(tenantId, async (db) => {
    const [[profileCount], rawProfileRows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(agentProfiles).where(eq(agentProfiles.tenantId, tenantId)),
      db.select().from(agentProfiles).where(and(
        eq(agentProfiles.tenantId, tenantId),
        cursor ? gt(agentProfiles.id, cursor) : undefined,
      )).orderBy(asc(agentProfiles.id)).limit(limit + 1),
    ]);
    const profileRows = rawProfileRows.slice(0, limit);
    const profilesTruncated = rawProfileRows.length > limit;
    const profileIds = profileRows.map((row) => row.id);
    if (profileIds.length === 0) {
      return {
        profileCount: profileCount?.count ?? 0,
        profileRows,
        profilesTruncated,
        revisionRows: [], assignmentRows: [], currentAssignmentRows: [], latestAssignmentRows: [], loadRows: [], observationRows: [], proposalRows: [], learningRows: [],
        assignmentsTruncated: false, observationsTruncated: false, proposalsTruncated: false, learningTruncated: false,
      };
    }
    const [revisionRows, rawAssignmentRows, currentAssignmentRows, latestAssignmentRows, loadRows, rawProposalRows, rawLearningRows] = await Promise.all([
      db.select().from(agentProfileRevisions).where(and(
        eq(agentProfileRevisions.tenantId, tenantId),
        inArray(agentProfileRevisions.agentProfileId, profileIds),
        eq(agentProfileRevisions.status, "active"),
      )).orderBy(asc(agentProfileRevisions.agentProfileId)),
      db.select().from(workforceAssignments).where(and(
        eq(workforceAssignments.tenantId, tenantId),
        inArray(workforceAssignments.agentProfileId, profileIds),
      )).orderBy(desc(workforceAssignments.createdAt), desc(workforceAssignments.id)).limit(ASSIGNMENT_HISTORY_LIMIT + 1),
      db.select().from(workforceAssignments).where(and(
        eq(workforceAssignments.tenantId, tenantId),
        inArray(workforceAssignments.agentProfileId, profileIds),
        inArray(workforceAssignments.state, ACTIVE_ASSIGNMENT_STATES),
      )).orderBy(desc(workforceAssignments.createdAt), desc(workforceAssignments.id)),
      db.selectDistinctOn([workforceAssignments.agentProfileId]).from(workforceAssignments).where(and(
        eq(workforceAssignments.tenantId, tenantId),
        inArray(workforceAssignments.agentProfileId, profileIds),
      )).orderBy(asc(workforceAssignments.agentProfileId), desc(workforceAssignments.createdAt), desc(workforceAssignments.id)),
      db.select({ agentProfileId: workforceAssignments.agentProfileId, count: sql<number>`count(*)::int` }).from(workforceAssignments).where(and(
        eq(workforceAssignments.tenantId, tenantId),
        inArray(workforceAssignments.agentProfileId, profileIds),
        inArray(workforceAssignments.state, [...LOAD_BEARING_ASSIGNMENTS]),
      )).groupBy(workforceAssignments.agentProfileId),
      db.select().from(learningProposals).where(and(
        eq(learningProposals.tenantId, tenantId),
        inArray(learningProposals.targetId, profileIds),
      )).orderBy(desc(learningProposals.createdAt), desc(learningProposals.id)).limit(PROPOSAL_LIMIT + 1),
      db.select().from(learningRevisions).where(and(
        eq(learningRevisions.tenantId, tenantId),
        inArray(learningRevisions.targetAgentProfileId, profileIds),
      )).orderBy(desc(learningRevisions.createdAt), desc(learningRevisions.id)).limit(LEARNING_REVISION_LIMIT + 1),
    ]);
    const assignmentRows = rawAssignmentRows.slice(0, ASSIGNMENT_HISTORY_LIMIT);
    const proposalRows = rawProposalRows.slice(0, PROPOSAL_LIMIT);
    const learningRows = rawLearningRows.slice(0, LEARNING_REVISION_LIMIT);
    const revisionIds = revisionRows.map((row) => row.id);
    const rawObservationRows = revisionIds.length === 0 ? [] : await db.select().from(learningObservations).where(and(
      eq(learningObservations.tenantId, tenantId),
      inArray(learningObservations.agentRevisionId, revisionIds),
    )).orderBy(desc(learningObservations.occurredAt), desc(learningObservations.id)).limit(OBSERVATION_LIMIT + 1);
    const observationRows = rawObservationRows.slice(0, OBSERVATION_LIMIT);
    return {
      profileCount: profileCount?.count ?? 0, profileRows, profilesTruncated, revisionRows, assignmentRows, currentAssignmentRows,
      latestAssignmentRows, loadRows, observationRows, proposalRows, learningRows,
      assignmentsTruncated: rawAssignmentRows.length > ASSIGNMENT_HISTORY_LIMIT,
      observationsTruncated: rawObservationRows.length > OBSERVATION_LIMIT,
      proposalsTruncated: rawProposalRows.length > PROPOSAL_LIMIT,
      learningTruncated: rawLearningRows.length > LEARNING_REVISION_LIMIT,
    };
  });

  const revisions = new Map(rows.revisionRows.map((row) => [row.agentProfileId, row]));
  const assignments = rows.assignmentRows.map(assignmentSummary);
  const latestAssignments = new Map(rows.latestAssignmentRows.map((row) => [row.agentProfileId, assignmentSummary(row)]));
  const currentLoad = new Map(rows.loadRows.map((row) => [row.agentProfileId, row.count]));
  const metrics = computeLearningMetrics(rows.observationRows.map(observationShape));
  const metricsByProfile = new Map<string, WorkforceMetricSummary[]>();
  for (const metric of metrics) {
    metricsByProfile.set(metric.agentProfileId, [...(metricsByProfile.get(metric.agentProfileId) ?? []), metricSummary(metric)]);
  }
  const workers: WorkforceWorkerSummary[] = rows.profileRows.map((profile) => {
    const revision = revisions.get(profile.id);
    const latest = latestAssignments.get(profile.id);
    return {
      id: profile.id,
      key: profile.key,
      name: profile.name,
      profileStatus: profile.status,
      runtimeStatus: statusFor(profile, revision, latest),
      currentLoad: currentLoad.get(profile.id) ?? 0,
      activeRevision: revision ? {
        id: revision.id,
        revision: revision.revision,
        modelRoute: revision.modelRoute as AgentModelRoute,
        capabilityGrants: revision.capabilityGrants as AgentCapabilityGrant[],
        maxConcurrentAssignments: revision.maxConcurrentAssignments,
        autonomyLimits: revision.autonomyLimits as AgentAutonomyLimits,
        planningHints: revision.planningHints as Record<string, unknown>,
        learningRevisionId: revision.learningRevisionId,
        configHash: revision.configHash,
        createdAt: revision.createdAt.toISOString(),
      } : null,
      latestAssignment: latest ?? null,
      metrics: metricsByProfile.get(profile.id) ?? [],
    };
  });
  const proposals: WorkforceLearningProposalSummary[] = rows.proposalRows.map((row) => ({
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    targetAgentRevisionId: row.targetAgentRevisionId,
    capability: row.capability,
    evidenceWindow: row.evidenceWindow as Record<string, unknown>,
    sampleSize: row.sampleSize,
    proposedChange: row.proposedChange as Record<string, unknown>,
    confidenceClass: row.confidenceClass,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
  const revisionHistory: WorkforceLearningRevisionSummary[] = rows.learningRows.map((row) => ({
    id: row.id,
    targetAgentProfileId: row.targetAgentProfileId,
    revision: row.revision,
    parentRevisionId: row.parentRevisionId,
    sourceProposalId: row.sourceProposalId,
    semanticHash: row.semanticHash,
    promotedBy: row.promotedBy,
    createdAt: row.createdAt.toISOString(),
  }));
  const currentAssignments = rows.currentAssignmentRows.map(assignmentSummary);
  const completedAssignments = assignments.filter((row) => row.state === "completed");
  const blockedOrFailedAssignments = assignments.filter((row) => row.state === "failed" || row.state === "reassigned");
  const asOf = now.toISOString();
  const tables = ["agent_profiles", "agent_profile_revisions", "workforce_assignments", "learning_observations", "learning_proposals", "learning_revisions"] as const;
  const source = { kind: "canonical_postgres" as const, tables: [...tables] };
  const hasMore = rows.profilesTruncated;
  const truncatedSources: WorkforceStatusResult["sourceStatus"]["truncatedSources"] = [
    ...(hasMore ? ["agent_profiles" as const] : []),
    ...(rows.assignmentsTruncated ? ["workforce_assignments" as const] : []),
    ...(rows.observationsTruncated ? ["learning_observations" as const] : []),
    ...(rows.proposalsTruncated ? ["learning_proposals" as const] : []),
    ...(rows.learningTruncated ? ["learning_revisions" as const] : []),
  ];
  const anyTruncated = truncatedSources.length > 0;
  return {
    kind: "operational_query_result",
    status: anyTruncated ? "partial" : "ok",
    version: 1,
    intent: "workforce_status",
    source,
    asOf,
    count: workers.length,
    truncated: anyTruncated,
    page: { limit, returned: workers.length, totalCount: rows.profileCount, totalCountExact: true, hasMore, nextCursor: hasMore ? workers.at(-1)?.id ?? null : null, truncated: hasMore },
    meta: { version: 1, source, asOf },
    configurationState: rows.profileCount === 0 ? "unconfigured" : "configured",
    workers,
    assignments,
    currentAssignments,
    completedAssignments,
    blockedOrFailedAssignments,
    proposals,
    learningRevisions: revisionHistory,
    sourceStatus: {
      status: anyTruncated ? "partial" : "complete",
      asOf,
      tables,
      truncatedSources,
      bounds: {
        agentProfiles: { returned: workers.length, totalCount: rows.profileCount, limit, truncated: hasMore },
        workforceAssignments: { returned: assignments.length, limit: ASSIGNMENT_HISTORY_LIMIT, truncated: rows.assignmentsTruncated },
        learningObservations: { returned: rows.observationRows.length, limit: OBSERVATION_LIMIT, truncated: rows.observationsTruncated },
        learningProposals: { returned: proposals.length, limit: PROPOSAL_LIMIT, truncated: rows.proposalsTruncated },
        learningRevisions: { returned: revisionHistory.length, limit: LEARNING_REVISION_LIMIT, truncated: rows.learningTruncated },
      },
    },
    data: { workers, assignments, currentAssignments, completedAssignments, blockedOrFailedAssignments, proposals, learningRevisions: revisionHistory },
  };
}
