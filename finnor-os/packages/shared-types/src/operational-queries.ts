/**
 * Deterministic active query plane. Retired Water intents live only in the
 * Phase-5 deny ledger and are never part of this executable union.
 */
import type { CanonicalEntityRef, CompanyContext, CompanyContextAnchor, PartyRef } from "./company-graph";

export const OPERATIONAL_QUERY_VERSION = 1 as const;

export const CORE_OPERATIONAL_QUERY_INTENTS = [
  "work_list",
  "agent_activity",
  "company_context",
  "party_lookup",
  "party_context",
  "team_roster",
] as const;

export const PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS = [
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

export interface AgentActivityRequest {
  intent: "agent_activity";
  range?: OperationalQueryRange;
  localDateRange?: OperationalLocalDateRange;
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

export type CoreOperationalQueryRequest =
  | WorkListRequest
  | AgentActivityRequest
  | CompanyContextRequest
  | PartyLookupRequest
  | PartyContextRequest
  | TeamRosterRequest;

export type CanonicalOperationalQueryRequest =
  | CoreOperationalQueryRequest
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
export type OperationalQueryResultStatus = "ok" | "ambiguous" | "not_found" | "inactive";
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

export type OperationalQueryResult =
  | WorkListResult
  | AgentActivityResult
  | CompanyContextResult
  | PartyLookupResult
  | PartyContextResult
  | TeamRosterResult
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
    : R extends AgentActivityRequest ? AgentActivityResult
      : R extends CompanyContextRequest ? CompanyContextResult
        : R extends PartyLookupRequest ? PartyLookupResult
          : R extends PartyContextRequest ? PartyContextResult
            : R extends TeamRosterRequest ? TeamRosterResult
              : R extends DealContextRequest ? DealContextResult
                : R extends DealWorkstreamsRequest ? DealWorkstreamsResult
                  : R extends OpenRequestsRequest ? OpenRequestsResult
                    : R extends OpenFindingsRequest ? OpenFindingsResult
                      : R extends OpenDealRisksRequest ? OpenDealRisksResult
                        : R extends CriticalDependenciesRequest ? CriticalDependenciesResult
                          : R extends ClosingReadinessRequest ? ClosingReadinessResult
                            : never;
