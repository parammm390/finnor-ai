export const AGENT_PROFILE_STATUSES = ["enabled", "disabled"] as const;
export type AgentProfileStatus = (typeof AGENT_PROFILE_STATUSES)[number];

export const AGENT_REVISION_STATUSES = ["active", "superseded", "disabled"] as const;
export type AgentRevisionStatus = (typeof AGENT_REVISION_STATUSES)[number];

export type WorkforceCapabilityKind = "query" | "action" | "wait" | "check";

/** A grant is an exact reference to a capability already owned by P6/Core. */
export interface AgentCapabilityGrant {
  capability: string;
  kind: WorkforceCapabilityKind;
}

export interface AgentModelRoute {
  provider: string;
  model?: string | null;
  purpose: "objective_execution";
}

export interface AgentAutonomyLimits {
  maxActions: number;
  maxQueries: number;
  maxReplans: number;
  maxPlannerCalls: number;
  maxWallClockMs: number;
  maxKnownCostUsd?: number | null;
  maxKnownTokens?: number | null;
}

export interface AgentProfile {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  status: AgentProfileStatus;
  createdAt: string;
}

export interface AgentProfileRevision {
  id: string;
  tenantId: string;
  agentProfileId: string;
  revision: number;
  modelRoute: AgentModelRoute;
  capabilityGrants: AgentCapabilityGrant[];
  maxConcurrentAssignments: number;
  autonomyLimits: AgentAutonomyLimits;
  planningHints: Record<string, unknown>;
  learningRevisionId: string | null;
  status: AgentRevisionStatus;
  configHash: string;
  createdAt: string;
}

export const WORKFORCE_ASSIGNMENT_STATES = [
  "queued", "claimed", "running", "waiting", "completed", "failed", "cancelled", "reassigned",
] as const;
export type WorkforceAssignmentState = (typeof WORKFORCE_ASSIGNMENT_STATES)[number];

export interface AssignmentScore {
  exactCapabilityMatch: 1;
  historicalEvidence: "KNOWN" | "UNKNOWN";
  sampleSize: number;
  verifiedCompletionRate: number | null;
  promotedRoutingPreference: number;
  currentLoad: number;
  qualityFailureRate: number | null;
  humanRejectionRate: number | null;
  medianLatencyMs: number | null;
  knownCostUsd: number | null;
  stableTieBreak: string;
}

export interface WorkforceAssignment {
  id: string;
  tenantId: string;
  workId: string;
  planRevisionId: string;
  planNodeId: string;
  objectiveLoopId: string | null;
  objectiveStepId: string | null;
  agentProfileId: string;
  agentRevisionId: string;
  capability: string;
  state: WorkforceAssignmentState;
  attempt: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  budgetSnapshot: Record<string, unknown>;
  assignmentReason: string;
  assignmentScore: AssignmentScore;
  previousAssignmentId: string | null;
  reassignmentReason: string | null;
  domainActionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failure: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export const ASSIGNMENT_INELIGIBILITY_REASONS = [
  "AGENT_DISABLED",
  "CROSS_TENANT",
  "REVISION_INACTIVE",
  "CAPABILITY_NOT_GRANTED",
  "HUMAN_REQUIRED",
  "PLAN_SUPERSEDED",
  "NODE_NOT_READY",
  "PRECONDITIONS_INVALID",
  "AUTONOMY_BUDGET_EXHAUSTED",
  "CONCURRENCY_LIMIT_REACHED",
  "MODEL_ROUTE_UNAVAILABLE",
  "POLICY_PROHIBITED",
  "REPEATED_WORKER_FAILURE",
] as const;
export type AssignmentIneligibilityReason = (typeof ASSIGNMENT_INELIGIBILITY_REASONS)[number];

export interface AssignmentEligibility {
  eligible: boolean;
  reasons: AssignmentIneligibilityReason[];
  capability: string;
}

export const LEARNING_OUTCOME_CLASSES = [
  "verified_completion",
  "agent_planning_failure",
  "schema_compile_rejection",
  "authority_denial",
  "human_rejection",
  "human_correction",
  "provider_outage",
  "external_failure",
  "stale_world_replan",
  "business_outcome_failure",
  "timeout",
  "user_cancellation",
  "recovery",
  "unknown",
] as const;
export type LearningOutcomeClass = (typeof LEARNING_OUTCOME_CLASSES)[number];

export interface LearningSourceRef {
  type: "completion_proof" | "business_effect" | "decision_receipt" | "domain_action" | "plan_node" | "objective_step" | "query_execution" | "work_event_wait" | "replan" | "human_decision" | "provider_event" | "attention_item";
  id: string;
  hash?: string | null;
}

export interface LearningObservation {
  id: string;
  tenantId: string;
  agentProfileId: string;
  agentRevisionId: string;
  capability: string;
  nodeKind: WorkforceCapabilityKind;
  contextClass: string;
  workId: string;
  planRevisionId: string;
  planNodeId: string;
  workforceAssignmentId: string;
  outcomeClass: LearningOutcomeClass;
  verified: boolean;
  sourceRefs: LearningSourceRef[];
  contextFeatures: Record<string, string | number | boolean | null>;
  measuredMetrics: {
    latencyMs?: number | null;
    knownCostUsd?: number | null;
    knownTokens?: number | null;
    replans?: number;
    recoveries?: number;
  };
  occurredAt: string;
  observationHash: string;
}

export const LEARNING_PROPOSAL_CLASSES = [
  "routing_preference_adjustment",
  "capability_quality_warning",
  "deprioritize_worker_recommendation",
  "soft_planning_hint_update",
  "model_route_recommendation",
] as const;
export type LearningProposalClass = (typeof LEARNING_PROPOSAL_CLASSES)[number];

export type LearningProposedChange =
  | { class: "routing_preference_adjustment"; capability: string; adjustment: "deprioritize" | "prefer"; weight: number }
  | { class: "capability_quality_warning"; capability: string; warning: string }
  | { class: "deprioritize_worker_recommendation"; capability: string; reason: string }
  | { class: "soft_planning_hint_update"; hintKey: string; hint: string }
  | { class: "model_route_recommendation"; capability: string; provider: string; model?: string | null };

export interface LearningProposal {
  id: string;
  tenantId: string;
  targetType: "agent_profile" | "agent_capability";
  targetId: string;
  capability: string | null;
  evidenceWindow: { from: string; to: string };
  sampleSize: number;
  observationRefs: string[];
  proposedChange: LearningProposedChange;
  confidenceClass: "SUPPORTED" | "STRONG";
  status: "proposed" | "approved" | "rejected" | "promoted";
  createdAt: string;
}

export interface LearningRevision {
  id: string;
  tenantId: string;
  revision: number;
  parentRevisionId: string | null;
  sourceProposalId: string;
  guidance: {
    routingPreferences: Record<string, number>;
    capabilityReliabilityPriors: Record<string, { sampleSize: number; verifiedCompletionRate: number }>;
    softPlanningHints: Record<string, string>;
    modelRoutePreferences: Record<string, { provider: string; model?: string | null }>;
    warnings: Record<string, string>;
  };
  semanticHash: string;
  promotedBy: string;
  createdAt: string;
}

export interface LearningMetricSlice {
  agentProfileId: string;
  agentRevisionId: string;
  capability: string;
  nodeKind: WorkforceCapabilityKind;
  contextClass: string;
  attemptCount: number;
  verifiedCompletionCount: number;
  qualityAttemptCount: number;
  qualityFailureCount: number;
  humanRejectionCount: number;
  humanCorrectionCount: number;
  providerOutageCount: number;
  externalFailureCount: number;
  replanCount: number;
  recoveryCount: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  knownCostUsd: number | null;
  sampleState: "KNOWN" | "UNKNOWN";
  verifiedCompletionRate: number | null;
  qualityFailureRate: number | null;
  humanRejectionRate: number | null;
}
