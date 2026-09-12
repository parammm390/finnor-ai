/**
 * Deterministic active query plane. Retired Water intents live only in the
 * Phase-5 deny ledger and are never part of this executable union.
 */
import type { CanonicalEntityRef, CompanyContext, CompanyContextAnchor, PartyRef } from "./company-graph";

export const OPERATIONAL_QUERY_VERSION = 1 as const;

export const CORE_OPERATIONAL_QUERY_INTENTS = [
  "work_list",
  "attention_queue",
  "agent_activity",
  "workforce_status",
  "company_context",
  "party_lookup",
  "party_context",
  "team_roster",
] as const;

export const PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS = [
  "pe_world_state",
  "deal_context",
  "deal_workstreams",
  "open_requests",
  "open_findings",
  "open_deal_risks",
  "critical_dependencies",
  "closing_readiness",
] as const;

export const OPERATIONAL_QUERY_INTENTS = [
  ...CORE_OPERATIONAL_QUERY_INTENTS,
  ...PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
] as const;

export type CoreOperationalQueryIntent = (typeof CORE_OPERATIONAL_QUERY_INTENTS)[number];
export type PrivateEquityOperationalQueryIntent = (typeof PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS)[number];
export type CanonicalOperationalQueryIntent = (typeof OPERATIONAL_QUERY_INTENTS)[number];
export type OperationalQueryIntent = CanonicalOperationalQueryIntent;

export interface OperationalQueryPageRequest {
  limit?: number;
  cursor?: string;
}

export interface OperationalQueryRange {
  start: string;
  end: string;
}

export type OperationalLocalDateValue = string | "today" | "tomorrow";
export interface OperationalLocalDateRange {
  startDate: OperationalLocalDateValue;
  endDate?: OperationalLocalDateValue;
}

export interface WorkListRequest {
  intent: "work_list";
  section?: "all" | "works" | "tasks";
  openOnly?: boolean;
  statuses?: string[];
  recordId?: string;
  page?: OperationalQueryPageRequest;
}

/** The viewer is always injected from authenticated TenantContext. The wire
 * request intentionally has no employee/tenant selector. */
export interface AttentionQueueRequest {
  intent: "attention_queue";
  page?: OperationalQueryPageRequest;
}

export interface AgentActivityRequest {
  intent: "agent_activity";
  range?: OperationalQueryRange;
  localDateRange?: OperationalLocalDateRange;
  page?: OperationalQueryPageRequest;
}

/** Canonical P7 workforce truth. Tenant identity always comes from the
 * authenticated context; callers can only bound the returned page. */
export interface WorkforceStatusRequest {
  intent: "workforce_status";
  page?: OperationalQueryPageRequest;
}

export interface CompanyContextRequest {
  intent: "company_context";
  anchor?: CompanyContextAnchor;
  query?: string;
}

export interface PartyLookupRequest {
  intent: "party_lookup";
  ref?: PartyRef;
  query?: string;
  page?: OperationalQueryPageRequest;
}

export interface PartyContextRequest {
  intent: "party_context";
  ref?: PartyRef;
  query?: string;
  page?: OperationalQueryPageRequest;
}

export interface TeamRosterRequest {
  intent: "team_roster";
  teamRef?: PartyRef;
  query?: string;
  page?: OperationalQueryPageRequest;
}

export interface DealScopedQueryRequest {
  dealId: string;
  page?: OperationalQueryPageRequest;
}
export interface DealContextRequest extends DealScopedQueryRequest { intent: "deal_context" }
export interface DealWorkstreamsRequest extends DealScopedQueryRequest {
  intent: "deal_workstreams";
  states?: string[];
  owner?: PartyRef;
}
export interface OpenRequestsRequest extends DealScopedQueryRequest {
  intent: "open_requests";
  workstreamId?: string;
  requestedFrom?: PartyRef;
  dueState?: "any" | "overdue" | "not_overdue";
}
export interface OpenFindingsRequest extends DealScopedQueryRequest {
  intent: "open_findings";
  workstreamId?: string;
  severities?: Array<"low" | "medium" | "high" | "critical">;
}
export interface OpenDealRisksRequest extends DealScopedQueryRequest {
  intent: "open_deal_risks";
  workstreamId?: string;
  severities?: Array<"low" | "medium" | "high" | "critical">;
}
export interface CriticalDependenciesRequest extends DealScopedQueryRequest {
  intent: "critical_dependencies";
  includeResolved?: boolean;
}
export interface ClosingReadinessRequest extends DealScopedQueryRequest { intent: "closing_readiness" }
export interface PeWorldStateRequest {
  intent: "pe_world_state";
  root: { entityType: "pe_strategy" | "pe_opportunity" | "pe_deal"; entityId: string };
  at?: string;
}

export type CoreOperationalQueryRequest =
  | WorkListRequest
  | AttentionQueueRequest
  | AgentActivityRequest
  | WorkforceStatusRequest
  | CompanyContextRequest
  | PartyLookupRequest
  | PartyContextRequest
  | TeamRosterRequest;

export type CanonicalOperationalQueryRequest =
  | CoreOperationalQueryRequest
  | PeWorldStateRequest
  | DealContextRequest
  | DealWorkstreamsRequest
  | OpenRequestsRequest
  | OpenFindingsRequest
  | OpenDealRisksRequest
  | CriticalDependenciesRequest
  | ClosingReadinessRequest;

export type OperationalQueryRequest = CanonicalOperationalQueryRequest;

export interface OperationalQuerySource {
  kind: "canonical_postgres";
  tables: string[];
}
export interface OperationalQueryPageInfo {
  limit: number;
  returned: number;
  totalCount: number | null;
  totalCountExact: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  truncated: boolean;
}
export interface OperationalQueryExecutionRef {
  id: string;
  workId: string;
  workInputId: string | null;
  executionKey: string;
  status: "running" | "succeeded" | "failed";
}
export type OperationalQueryResultStatus = "ok" | "partial" | "unavailable" | "ambiguous" | "not_found" | "inactive";
export interface OperationalQueryResultMeta {
  version: typeof OPERATIONAL_QUERY_VERSION;
  source: OperationalQuerySource;
  asOf: string;
}
export interface OperationalQueryResultBase<I extends CanonicalOperationalQueryIntent> {
  kind: "operational_query_result";
  status: OperationalQueryResultStatus;
  data: Record<string, unknown>;
  version: typeof OPERATIONAL_QUERY_VERSION;
  intent: I;
  source: OperationalQuerySource;
  asOf: string;
  count: number;
  truncated: boolean;
  page: OperationalQueryPageInfo;
  meta: OperationalQueryResultMeta;
  execution?: OperationalQueryExecutionRef;
}

export interface WorkListResult extends OperationalQueryResultBase<"work_list"> {
  works: Array<{
    id: string;
    status: string;
    channel: string;
    sessionId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  tasks: Array<{
    id: string;
    subjectType: string;
    subjectId: string;
    title: string;
    dueAt: string | null;
    assignedPartyType: string | null;
    assignedPartyId: string | null;
    status: string;
    priority: string;
    createdAt: string;
  }>;
  sectionPages: { works: OperationalQueryPageInfo; tasks: OperationalQueryPageInfo };
}

export const ATTENTION_KINDS = [
  "work_recovery",
  "work_failure",
  "approval_required",
  "clarification_required",
  "human_attestation_required",
  "manual_verification_required",
  "deadline_overdue",
  "wait_timed_out",
  "plan_node_blocked",
  "p5_question_blocking",
  "p5_vote_required",
  "p5_decision_required",
  "p5_condition_active",
  "work_assigned",
  "ai_assignment_failed",
  "no_eligible_ai_worker",
  "worker_budget_exhausted",
  "learning_proposal_review",
  "human_only_boundary",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface AttentionRootRef {
  entityType: string;
  entityId: string;
  relationship: "about" | "target" | "result";
  source: string;
}

export interface AttentionCausalRef {
  kind: "work_completion" | "plan_node" | "goal_criterion" | "approval" | "event_wait" | "p5_boundary" | "workforce_assignment" | "learning_proposal";
  id: string;
}

export interface AttentionActor {
  employeeId: string;
  basis: "work_owner" | "work_assignment" | "approval_eligibility" | "committee_eligibility" | "authority" | "condition_owner" | "question_owner";
  capability: string | null;
}

export interface AttentionAuthorityBoundary {
  operation: "approval" | "human_attestation" | "manual_verification" | "governance";
  capability: string;
  resource: { type: string; id: string };
  authorityRevision: number | null;
  /** Reading or selecting this item never authorizes its mutation. */
  selectionGrantsAuthority: false;
}

export interface AttentionRecoveryBoundary {
  source: "work" | "plan_node" | "event_wait" | "business_effect";
  mode: "retry" | "replan" | "recover" | "compensate" | "escalate" | "manual_review";
  reasonCode: string;
}

export interface AttentionImpact {
  blocksWorkCompletion: boolean;
  downstreamPlanNodes: number;
  completionCriteria: number;
  sourceBackedMateriality: { classification: string; sourceRef: string } | null;
}

export interface AttentionEvidenceRef {
  type: string;
  id: string;
  hash?: string;
}

export interface AttentionHumanBoundary {
  kind: "approve" | "clarify" | "attest" | "verify" | "recover" | "resolve_question" | "vote" | "govern" | "resolve_condition" | "accept_assignment";
  description: string;
  capability: string | null;
  executable: false;
}

/** Lower tuple values sort first. Raw counts/slack remain alongside the tuple so
 * the UI can explain the ranking without reverse-engineering a score. */
export interface AttentionRankVector {
  safetyRecoveryRank: number;
  deadlineRank: number;
  slackMs: number | null;
  downstreamCompletionCriteria: number;
  downstreamPlanNodes: number;
  authorityBottleneckRank: number;
  materialityRank: number | null;
  ageMs: number;
  stableTieBreak: string;
  tuple: [number, number, number, number, number, number, number, number, string];
}

export interface AttentionItem {
  id: string;
  workId: string;
  planRevisionId?: string;
  planNodeId?: string;
  rootRefs: AttentionRootRef[];
  kind: AttentionKind;
  reason: string;
  assignedOrEligibleActor: AttentionActor;
  deadline: string | null;
  slackMs: number | null;
  blocks: AttentionCausalRef[];
  unblocks: AttentionCausalRef[];
  authorityBoundary: AttentionAuthorityBoundary | null;
  recoveryBoundary: AttentionRecoveryBoundary | null;
  impact: AttentionImpact;
  evidenceRefs: AttentionEvidenceRef[];
  nextHumanBoundary: AttentionHumanBoundary;
  rankVector: AttentionRankVector;
  rankReason: { primary: string; factors: string[] };
  createdAt: string;
}

export interface AttentionSourceStatus {
  status: "complete" | "partial" | "unavailable";
  sources: Array<{
    source: "identity" | "work" | "approval" | "objective" | "wait" | "business_effect" | "plan" | "root" | "private_equity" | "workforce";
    status: "available" | "unavailable" | "not_applicable";
    tables: string[];
    errorCode?: string;
  }>;
  unavailableSources: string[];
}

export interface AttentionQueueResult extends OperationalQueryResultBase<"attention_queue"> {
  items: AttentionItem[];
  viewer: { employeeId: string | null; authorityRevision: number | null };
  sourceStatus: AttentionSourceStatus;
}

export interface AgentActivityResult extends OperationalQueryResultBase<"agent_activity"> {
  range: OperationalQueryRange;
  timeZone: string;
  localDateRange?: OperationalLocalDateRange;
  users: Array<{ id: string; displayName: string | null; role: string; createdAt: string }>;
  actions: Array<{ id: string; actionType: string; status: string; step: string | null; occurredAt: string }>;
  workflows: Array<{ id: string; workflowType: string; status: string; occurredAt: string }>;
  sectionPages: {
    users: OperationalQueryPageInfo;
    actions: OperationalQueryPageInfo;
    workflows: OperationalQueryPageInfo;
  };
}

export type WorkforceRuntimeStatus = "idle" | "working" | "waiting" | "blocked" | "failed" | "unavailable";

export interface WorkforceAssignmentSummary {
  id: string;
  workId: string;
  planRevisionId: string;
  planNodeId: string;
  objectiveLoopId: string | null;
  objectiveStepId: string | null;
  agentProfileId: string;
  agentRevisionId: string;
  capability: string;
  nodeKind: "query" | "action" | "wait" | "check";
  state: "queued" | "claimed" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "reassigned";
  attempt: number;
  assignmentReason: string;
  previousAssignmentId: string | null;
  reassignmentReason: string | null;
  domainActionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failure: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkforceMetricSummary {
  agentRevisionId: string;
  capability: string;
  nodeKind: "query" | "action" | "wait" | "check";
  contextClass: string;
  attemptCount: number;
  qualityAttemptCount: number;
  verifiedCompletionCount: number;
  qualityFailureCount: number;
  humanRejectionCount: number;
  providerOutageCount: number;
  externalFailureCount: number;
  replanCount: number;
  recoveryCount: number;
  sampleState: "KNOWN" | "UNKNOWN";
  verifiedCompletionRate: number | null;
  qualityFailureRate: number | null;
  humanRejectionRate: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  knownCostUsd: number | null;
}

export interface WorkforceWorkerSummary {
  id: string;
  key: string;
  name: string;
  profileStatus: "enabled" | "disabled";
  runtimeStatus: WorkforceRuntimeStatus;
  currentLoad: number;
  activeRevision: null | {
    id: string;
    revision: number;
    modelRoute: { provider: string; model?: string | null; purpose: "objective_execution" };
    capabilityGrants: Array<{ capability: string; kind: "query" | "action" | "wait" | "check" }>;
    maxConcurrentAssignments: number;
    autonomyLimits: {
      maxActions: number;
      maxQueries: number;
      maxReplans: number;
      maxPlannerCalls: number;
      maxWallClockMs: number;
      maxKnownCostUsd?: number | null;
      maxKnownTokens?: number | null;
    };
    planningHints: Record<string, unknown>;
    learningRevisionId: string | null;
    configHash: string;
    createdAt: string;
  };
  latestAssignment: WorkforceAssignmentSummary | null;
  metrics: WorkforceMetricSummary[];
}

export interface WorkforceLearningProposalSummary {
  id: string;
  targetType: "agent_profile" | "agent_capability";
  targetId: string;
  targetAgentRevisionId: string;
  capability: string | null;
  evidenceWindow: Record<string, unknown>;
  sampleSize: number;
  proposedChange: Record<string, unknown>;
  confidenceClass: "SUPPORTED" | "STRONG";
  status: "proposed" | "approved" | "rejected" | "promoted";
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface WorkforceLearningRevisionSummary {
  id: string;
  targetAgentProfileId: string;
  revision: number;
  parentRevisionId: string | null;
  sourceProposalId: string;
  semanticHash: string;
  promotedBy: string;
  createdAt: string;
}

export interface WorkforceStatusResult extends OperationalQueryResultBase<"workforce_status"> {
  configurationState: "configured" | "unconfigured";
  workers: WorkforceWorkerSummary[];
  assignments: WorkforceAssignmentSummary[];
  currentAssignments: WorkforceAssignmentSummary[];
  completedAssignments: WorkforceAssignmentSummary[];
  blockedOrFailedAssignments: WorkforceAssignmentSummary[];
  proposals: WorkforceLearningProposalSummary[];
  learningRevisions: WorkforceLearningRevisionSummary[];
  sourceStatus: {
    status: "complete" | "partial";
    asOf: string;
    tables: readonly ["agent_profiles", "agent_profile_revisions", "workforce_assignments", "learning_observations", "learning_proposals", "learning_revisions"];
    truncatedSources: Array<"agent_profiles" | "workforce_assignments" | "learning_observations" | "learning_proposals" | "learning_revisions">;
    bounds: {
      agentProfiles: { returned: number; totalCount: number; limit: number; truncated: boolean };
      workforceAssignments: { returned: number; limit: number; truncated: boolean };
      learningObservations: { returned: number; limit: number; truncated: boolean };
      learningProposals: { returned: number; limit: number; truncated: boolean };
      learningRevisions: { returned: number; limit: number; truncated: boolean };
    };
  };
}

export interface CompanyContextResult extends OperationalQueryResultBase<"company_context"> {
  resolution: "exact" | "unique" | "ambiguous" | "not_found" | "inactive";
  context: CompanyContext | null;
}

export interface OperationalPartySummary {
  ref: PartyRef;
  displayName: string;
  status: "active" | "inactive" | "suspended";
  description: string | null;
  title?: string | null;
  role?: string | null;
  organizationName?: string | null;
  aliases?: string[];
  teamNames?: string[];
  locationNames?: string[];
}
export interface PartyLookupResult extends OperationalQueryResultBase<"party_lookup"> {
  resolution: "exact" | "unique" | "ambiguous" | "not_found" | "inactive";
  rows: OperationalPartySummary[];
}
export interface PartyRelationshipRow {
  relationship: string;
  from: PartyRef;
  to: PartyRef;
  label: string | null;
  status: string | null;
}
export interface PartyContextResult extends OperationalQueryResultBase<"party_context"> {
  resolution: "exact" | "unique" | "ambiguous" | "not_found" | "inactive";
  party: OperationalPartySummary | null;
  candidates: OperationalPartySummary[];
  teams: OperationalPartySummary[];
  locations: OperationalPartySummary[];
  relationships: PartyRelationshipRow[];
  currentWork: Array<{ id: string; status: string; instruction: string | null; updatedAt: string | null }>;
  currentTasks: Array<{ id: string; title: string; status: string; dueAt: string | null; authorityRole: string | null }>;
  authorityRoles: string[];
}
export interface TeamRosterResult extends OperationalQueryResultBase<"team_roster"> {
  resolution: "exact" | "unique" | "ambiguous" | "not_found" | "inactive";
  team: OperationalPartySummary | null;
  candidates: OperationalPartySummary[];
  members: Array<OperationalPartySummary & { membershipRole?: string | null }>;
}

export interface PrivateEquityEpistemicWarning {
  propositionId: string;
  predicate: string;
  status: "UNKNOWN" | "STALE" | "CONFLICTING" | "UNCERTAIN" | "CONTRADICTED";
  reason: string;
  evidenceRefs: string[];
}
export interface PrivateEquityDecisionReadiness {
  decisionId: string;
  decisionType: "closing_condition_satisfaction" | "closing_item_verification" | "deal_close" | "request_fulfillment";
  ready: boolean;
  unresolvedPropositionIds: string[];
  acquisitionOptions: Array<{ propositionId: string; adapterId: string; kind: string; reason: string }>;
}
export interface DealContextResult extends OperationalQueryResultBase<"deal_context"> {
  deal: Record<string, unknown> | null;
  target: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
  counts: Record<string, Record<string, number>>;
  workRefs: Array<{ workId: string; relationship: string }>;
  epistemicWarnings: PrivateEquityEpistemicWarning[];
}
export interface DealWorkstreamsResult extends OperationalQueryResultBase<"deal_workstreams"> {
  rows: Array<Record<string, unknown> & { id: string; state: string; blocking: boolean }>;
}
export interface OpenRequestsResult extends OperationalQueryResultBase<"open_requests"> {
  rows: Array<Record<string, unknown> & { id: string; state: string; overdue: boolean }>;
}
export interface OpenFindingsResult extends OperationalQueryResultBase<"open_findings"> {
  rows: Array<Record<string, unknown> & { id: string; state: string; evidenceRefs: string[]; riskRefs: string[]; epistemicWarnings: PrivateEquityEpistemicWarning[] }>;
  epistemicWarnings: PrivateEquityEpistemicWarning[];
}
export interface OpenDealRisksResult extends OperationalQueryResultBase<"open_deal_risks"> {
  rows: Array<Record<string, unknown> & { id: string; state: string; evidenceRefs: string[]; findingRefs: string[]; epistemicWarnings: PrivateEquityEpistemicWarning[] }>;
  epistemicWarnings: PrivateEquityEpistemicWarning[];
}
export interface CriticalDependenciesResult extends OperationalQueryResultBase<"critical_dependencies"> {
  rows: Array<{
    dependencyId: string;
    blocker: CanonicalEntityRef<string>;
    blocked: CanonicalEntityRef<string>;
    resolved: boolean;
    blockerState: string | null;
    blockedState: string | null;
    blockerDueAt: string | null;
    blockedDueAt: string | null;
    workRefs: Array<{ workId: string; entityType: string; entityId: string }>;
    ownerRefs: PartyRef[];
    paths: CanonicalEntityRef<string>[][];
  }>;
}
export interface ClosingReadinessResult extends OperationalQueryResultBase<"closing_readiness"> {
  dealId: string;
  eligible: boolean;
  eligibility: Record<string, unknown> | null;
  blockingConditions: Record<string, unknown>[];
  failedConditions: Record<string, unknown>[];
  unverifiedClosingItems: Record<string, unknown>[];
  blockingDependencies: Record<string, unknown>[];
  invalidWaivers: Record<string, unknown>[];
  integrityErrors: string[];
  criticalDependencies: CriticalDependenciesResult["rows"];
  relevantFindings: OpenFindingsResult["rows"];
  relevantDealRisks: OpenDealRisksResult["rows"];
  epistemicWarnings: PrivateEquityEpistemicWarning[];
  decisionReadiness: PrivateEquityDecisionReadiness[];
  queryTrace: PrivateEquityOperationalQueryIntent[];
}

export interface PeWorldStateResult extends OperationalQueryResultBase<"pe_world_state"> {
  root: PeWorldStateRequest["root"];
  stateAt: string;
  temporalCompleteness: {
    status: "complete" | "partial" | "unavailable_before_baseline";
    baselineAt: string | null;
    unavailableEntityTypes: string[];
    reasons: string[];
  };
  strategy: Record<string, unknown> | null;
  opportunity: Record<string, unknown> | null;
  deal: Record<string, unknown> | null;
  opportunities: Record<string, unknown>[];
  deals: Record<string, unknown>[];
  investmentCases: Record<string, unknown>[];
  theses: Record<string, unknown>[];
  assumptions: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  decisionEffectLinks: Record<string, unknown>[];
  dealParties: Record<string, unknown>[];
  workstreams: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  deliverables: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  dealRisks: Record<string, unknown>[];
  findingRiskLinks: Record<string, unknown>[];
  dependencies: Record<string, unknown>[];
  milestones: Record<string, unknown>[];
  closingConditions: Record<string, unknown>[];
  closingItems: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  observedEvidence: Record<string, unknown>[];
  sourceCoverage: Record<string, unknown>[];
  sourceCoverageWarnings: Record<string, unknown>[];
  unresolvedProviderObservations: number;
  ambiguousProviderObservations: number;
  providerFreshnessWarnings: Record<string, unknown>[];
  providerEvidenceCompleteness: {
    status: "complete" | "partial" | "not_configured";
    absenceClaimsPermitted: boolean;
    reasons: string[];
  };
  documentLinks: Record<string, unknown>[];
  evidenceLinks: Record<string, unknown>[];
  workLinks: Record<string, unknown>[];
  taskLinks: Record<string, unknown>[];
  businessEvents: Record<string, unknown>[];
  authorityDecisions: Record<string, unknown>[];
  approvalRequests: Record<string, unknown>[];
  decisionReceipts: Record<string, unknown>[];
  conflicts: Record<string, unknown>[];
  epistemicWarnings: PrivateEquityEpistemicWarning[];
  provenance: Record<string, unknown>[];
}

export type OperationalQueryResult =
  | WorkListResult
  | AttentionQueueResult
  | AgentActivityResult
  | WorkforceStatusResult
  | CompanyContextResult
  | PartyLookupResult
  | PartyContextResult
  | TeamRosterResult
  | PeWorldStateResult
  | DealContextResult
  | DealWorkstreamsResult
  | OpenRequestsResult
  | OpenFindingsResult
  | OpenDealRisksResult
  | CriticalDependenciesResult
  | ClosingReadinessResult;

export type OperationalQueryResultEnvelope = OperationalQueryResult;

export type OperationalQueryResultFor<R extends OperationalQueryRequest> =
  R extends WorkListRequest ? WorkListResult
    : R extends AttentionQueueRequest ? AttentionQueueResult
      : R extends AgentActivityRequest ? AgentActivityResult
      : R extends WorkforceStatusRequest ? WorkforceStatusResult
        : R extends CompanyContextRequest ? CompanyContextResult
          : R extends PartyLookupRequest ? PartyLookupResult
            : R extends PartyContextRequest ? PartyContextResult
              : R extends TeamRosterRequest ? TeamRosterResult
                : R extends PeWorldStateRequest ? PeWorldStateResult
                : R extends DealContextRequest ? DealContextResult
                  : R extends DealWorkstreamsRequest ? DealWorkstreamsResult
                    : R extends OpenRequestsRequest ? OpenRequestsResult
                      : R extends OpenFindingsRequest ? OpenFindingsResult
                        : R extends OpenDealRisksRequest ? OpenDealRisksResult
                          : R extends CriticalDependenciesRequest ? CriticalDependenciesResult
                            : R extends ClosingReadinessRequest ? ClosingReadinessResult
                              : never;
