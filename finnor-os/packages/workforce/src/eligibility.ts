import type {
  AgentAutonomyLimits,
  AgentProfile,
  AgentProfileRevision,
  AssignmentEligibility,
  AssignmentIneligibilityReason,
  AssignmentScore,
  LearningMetricSlice,
  WorkforceCapabilityKind,
} from "./contracts";

export const MIN_ROUTING_SAMPLE_SIZE = 5;

export interface P6BudgetCeilings {
  maxActions: number;
  maxQueries: number;
  maxReplans: number;
  maxPlannerCalls: number;
  maxWallClockMs: number;
  maxKnownCostUsd?: number | null;
  maxKnownTokens?: number | null;
}

export interface AssignmentBudgetUsage {
  actions: number;
  queries: number;
  replans: number;
  plannerCalls: number;
  wallClockMs: number;
  knownCostUsd?: number | null;
  knownTokens?: number | null;
}

export interface PlanExecutionBoundary {
  tenantId: string;
  workId: string;
  planRevisionId: string;
  currentPlanRevisionId: string | null;
  planNodeId: string;
  nodeKind: WorkforceCapabilityKind;
  capability: string;
  ready: boolean;
  preconditionsValid: boolean;
  humanOnly: boolean;
  authorityRequirement: "query" | "policy" | "approval" | "typed_approval" | "human_attestation";
  providerAvailable: boolean;
  policyAllowed: boolean;
}

export interface WorkforceCandidate {
  profile: AgentProfile;
  revision: AgentProfileRevision;
  currentLoad: number;
  budgetUsage: AssignmentBudgetUsage;
  p6BudgetCeilings: P6BudgetCeilings;
  metric: LearningMetricSlice | null;
  routeAvailable: boolean;
  /** Exact terminal execution failures for this profile on the selected node.
   * Two failures is a deterministic hard stop; provider/human/system outcomes
   * never increment this value. */
  repeatedWorkerFailures: number;
  /** Human-promoted, revision-pinned, bounded soft evidence only. */
  promotedRoutingPreference: number;
}

export interface RankedEligibleWorker {
  candidate: WorkforceCandidate;
  eligibility: AssignmentEligibility;
  score: AssignmentScore;
}

export function effectiveAutonomyLimits(profile: AgentAutonomyLimits, p6: P6BudgetCeilings): AgentAutonomyLimits {
  const minKnown = (left?: number | null, right?: number | null): number | null => {
    const values = [left, right].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return values.length > 0 ? Math.min(...values) : null;
  };
  return {
    maxActions: Math.min(profile.maxActions, p6.maxActions),
    maxQueries: Math.min(profile.maxQueries, p6.maxQueries),
    maxReplans: Math.min(profile.maxReplans, p6.maxReplans),
    maxPlannerCalls: Math.min(profile.maxPlannerCalls, p6.maxPlannerCalls),
    maxWallClockMs: Math.min(profile.maxWallClockMs, p6.maxWallClockMs),
    maxKnownCostUsd: minKnown(profile.maxKnownCostUsd, p6.maxKnownCostUsd),
    maxKnownTokens: minKnown(profile.maxKnownTokens, p6.maxKnownTokens),
  };
}

function budgetAvailable(candidate: WorkforceCandidate, nodeKind: WorkforceCapabilityKind): boolean {
  const limits = effectiveAutonomyLimits(candidate.revision.autonomyLimits, candidate.p6BudgetCeilings);
  const usage = candidate.budgetUsage;
  return (nodeKind !== "action" || usage.actions < limits.maxActions)
    && (nodeKind !== "query" || usage.queries < limits.maxQueries)
    && usage.replans < limits.maxReplans
    && usage.plannerCalls < limits.maxPlannerCalls
    && usage.wallClockMs < limits.maxWallClockMs
    && (limits.maxKnownCostUsd == null || (usage.knownCostUsd ?? 0) < limits.maxKnownCostUsd)
    && (limits.maxKnownTokens == null || (usage.knownTokens ?? 0) < limits.maxKnownTokens);
}

/** Hard filters only. Neither metrics nor model text participates here. */
export function evaluateAssignmentEligibility(boundary: PlanExecutionBoundary, candidate: WorkforceCandidate): AssignmentEligibility {
  const reasons: AssignmentIneligibilityReason[] = [];
  if (candidate.profile.status !== "enabled") reasons.push("AGENT_DISABLED");
  if (candidate.profile.tenantId !== boundary.tenantId || candidate.revision.tenantId !== boundary.tenantId) reasons.push("CROSS_TENANT");
  if (candidate.revision.status !== "active") reasons.push("REVISION_INACTIVE");
  if (!candidate.revision.capabilityGrants.some((grant) => grant.capability === boundary.capability && grant.kind === boundary.nodeKind)) reasons.push("CAPABILITY_NOT_GRANTED");
  if (boundary.humanOnly || boundary.authorityRequirement === "human_attestation") reasons.push("HUMAN_REQUIRED");
  if (boundary.currentPlanRevisionId !== boundary.planRevisionId) reasons.push("PLAN_SUPERSEDED");
  if (!boundary.ready) reasons.push("NODE_NOT_READY");
  if (!boundary.preconditionsValid) reasons.push("PRECONDITIONS_INVALID");
  if (!budgetAvailable(candidate, boundary.nodeKind)) reasons.push("AUTONOMY_BUDGET_EXHAUSTED");
  if (candidate.currentLoad >= candidate.revision.maxConcurrentAssignments) reasons.push("CONCURRENCY_LIMIT_REACHED");
  if (!boundary.providerAvailable || !candidate.routeAvailable) reasons.push("MODEL_ROUTE_UNAVAILABLE");
  if (!boundary.policyAllowed) reasons.push("POLICY_PROHIBITED");
  if (candidate.repeatedWorkerFailures >= 2) reasons.push("REPEATED_WORKER_FAILURE");
  return { eligible: reasons.length === 0, reasons, capability: boundary.capability };
}

export function assignmentScore(candidate: WorkforceCandidate, capability: string): AssignmentScore {
  const metric = candidate.metric?.capability === capability && candidate.metric.sampleState === "KNOWN"
    && candidate.metric.qualityAttemptCount >= MIN_ROUTING_SAMPLE_SIZE ? candidate.metric : null;
  return {
    exactCapabilityMatch: 1,
    historicalEvidence: metric ? "KNOWN" : "UNKNOWN",
    sampleSize: metric?.qualityAttemptCount ?? candidate.metric?.qualityAttemptCount ?? 0,
    verifiedCompletionRate: metric?.verifiedCompletionRate ?? null,
    promotedRoutingPreference: Math.max(-0.25, Math.min(0.25, candidate.promotedRoutingPreference)),
    currentLoad: candidate.currentLoad,
    qualityFailureRate: metric?.qualityFailureRate ?? null,
    humanRejectionRate: metric?.humanRejectionRate ?? null,
    medianLatencyMs: metric?.medianLatencyMs ?? null,
    knownCostUsd: metric?.knownCostUsd ?? null,
    stableTieBreak: candidate.profile.id,
  };
}

function compareNullableKnown(left: number | null, right: number | null, direction: "asc" | "desc"): number {
  if (left === null || right === null) return 0;
  return direction === "asc" ? left - right : right - left;
}

export function compareAssignmentScores(left: AssignmentScore, right: AssignmentScore): number {
  if (left.exactCapabilityMatch !== right.exactCapabilityMatch) return right.exactCapabilityMatch - left.exactCapabilityMatch;
  if (left.historicalEvidence !== right.historicalEvidence) return left.historicalEvidence === "KNOWN" ? -1 : 1;
  let compared = compareNullableKnown(left.verifiedCompletionRate, right.verifiedCompletionRate, "desc");
  if (compared !== 0) return compared;
  if (left.promotedRoutingPreference !== right.promotedRoutingPreference) return right.promotedRoutingPreference - left.promotedRoutingPreference;
  if (left.currentLoad !== right.currentLoad) return left.currentLoad - right.currentLoad;
  compared = compareNullableKnown(left.qualityFailureRate, right.qualityFailureRate, "asc");
  if (compared !== 0) return compared;
  compared = compareNullableKnown(left.humanRejectionRate, right.humanRejectionRate, "asc");
  if (compared !== 0) return compared;
  compared = compareNullableKnown(left.knownCostUsd, right.knownCostUsd, "asc");
  if (compared !== 0) return compared;
  compared = compareNullableKnown(left.medianLatencyMs, right.medianLatencyMs, "asc");
  if (compared !== 0) return compared;
  return left.stableTieBreak.localeCompare(right.stableTieBreak);
}

export function rankEligibleWorkers(boundary: PlanExecutionBoundary, candidates: WorkforceCandidate[]): RankedEligibleWorker[] {
  return candidates.map((candidate) => ({
    candidate,
    eligibility: evaluateAssignmentEligibility(boundary, candidate),
    score: assignmentScore(candidate, boundary.capability),
  })).filter((item) => item.eligibility.eligible).sort((left, right) => compareAssignmentScores(left.score, right.score));
}
