/**
 * Upgrade 3: the deterministic operational query plane.
 *
 * These contracts deliberately describe a read request without an identity
 * selector. The authenticated caller supplies tenantId to the executor; putting
 * it in a request would make it too easy for a planner/tool payload to smuggle a
 * cross-tenant selector into a read path.
 */
import type { CanonicalEntityRef, CompanyContext, CompanyContextAnchor, PartyRef } from "./company-graph";

export const OPERATIONAL_QUERY_VERSION = 1 as const;

export const OPERATIONAL_QUERY_INTENTS = [
  "customer_lookup",
  "customer_cohort",
  "schedule_range",
  "money_summary",
  "work_list",
  "inventory_status",
  "agent_activity",
  "business_state",
  "company_context",
  "party_lookup",
  "party_context",
  "team_roster",
  "party_availability",
  "deal_context",
  "deal_workstreams",
  "open_requests",
  "open_findings",
  "open_deal_risks",
  "critical_dependencies",
  "closing_readiness",
] as const;

/** Phase 3 intentionally exposes a bounded Deal read surface. These are read
 * intents, not PE actions and not a connector/data-fabric registry. */
export const PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS = [
  "deal_context",
  "deal_workstreams",
  "open_requests",
  "open_findings",
  "open_deal_risks",
  "critical_dependencies",
  "closing_readiness",
] as const;
export type PrivateEquityOperationalQueryIntent = (typeof PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS)[number];

export type CanonicalOperationalQueryIntent = (typeof OPERATIONAL_QUERY_INTENTS)[number];
/** Legacy aliases are accepted only at the router compatibility seam and are
 * normalized to the canonical eight intents before SQL execution. */
export type OperationalQueryCompatibilityIntent = "inactivity_cohort" | "money" | "work" | "inventory";
export type OperationalQueryIntent = CanonicalOperationalQueryIntent | OperationalQueryCompatibilityIntent;

export interface OperationalQueryPageRequest {
  /** The executor clamps this to its bounded maximum. */
  limit?: number;
  /** Opaque, stable keyset cursor returned by the previous page. */
  cursor?: string;
}

export interface OperationalQueryRange {
  /** Inclusive UTC lower bound. */
  start: string;
  /** Exclusive UTC upper bound. */
  end: string;
}

export type OperationalLocalDateValue = string | "today" | "tomorrow";

export interface OperationalLocalDateRange {
  /** Tenant-local calendar day at 00:00:00. */
  startDate: OperationalLocalDateValue;
  /** Inclusive tenant-local calendar day; omitted means startDate only. */
  endDate?: OperationalLocalDateValue;
}

export interface CustomerLookupRequest {
  intent: "customer_lookup";
  /** Exact household id takes precedence over every text selector. */
  householdId?: string;
  /** A normalized name, address, phone, or email lookup phrase. */
  query?: string;
  /** Explicit selectors are useful to callers that already parsed a field. */
  name?: string;
  address?: string;
  contact?: string;
  /** Compatibility alias for callers that parsed a phone field. */
  phone?: string;
  page?: OperationalQueryPageRequest;
  /** Optional deterministic cutoff supplied by a trusted caller; metadata asOf remains execution time. */
  asOf?: string;
}

export interface CustomerCohortRequest {
  intent: "customer_cohort";
  cohort: "inactive";
  /** A never-active household uses createdAt as its inactivity baseline. */
  minDaysInactive: number;
  asOf?: string;
  page?: OperationalQueryPageRequest;
}

export interface ScheduleRangeRequest {
  intent: "schedule_range";
  /** The executor enforces this half-open UTC interval. */
  range?: OperationalQueryRange;
  /** Alternative typed local calendar range, resolved with tenants.timezone. */
  localDateRange?: OperationalLocalDateRange;
  page?: OperationalQueryPageRequest;
}

export interface MoneySummaryRequest {
  intent: "money_summary";
  /** Optional half-open UTC range. Omitted means all recorded ledger history. */
  range?: OperationalQueryRange;
  /** Direct start/end aliases keep the wire contract convenient for simple clients. */
  start?: string;
  end?: string;
  page?: OperationalQueryPageRequest;
}

export interface WorkListRequest {
  intent: "work_list";
  section?: "all" | "works" | "work_orders" | "tasks";
  /** Resolve each operational section's canonical open states. */
  openOnly?: boolean;
  /** Explicit literals are applied to each selected section as supplied. */
  statuses?: string[];
  /** Optional record filter; `workId` is reserved for durable Work attachment metadata. */
  recordId?: string;
  page?: OperationalQueryPageRequest;
}

export interface InventoryStatusRequest {
  intent: "inventory_status";
  sku?: string;
  lowStockOnly?: boolean;
  includeOpenProcurement?: boolean;
  page?: OperationalQueryPageRequest;
}

export interface AgentActivityRequest {
  intent: "agent_activity";
  /** Required bounded UTC interval for activity rows. */
  range?: OperationalQueryRange;
  /** Alternative tenant-local calendar range, resolved by the canonical executor. */
  localDateRange?: OperationalLocalDateRange;
  page?: OperationalQueryPageRequest;
}

export interface BusinessStateRequest {
  intent: "business_state";
  page?: OperationalQueryPageRequest;
}

export interface CompanyContextRequest {
  intent: "company_context";
  /** Exact typed anchor. tenantId is deliberately supplied only by the executor. */
  anchor?: CompanyContextAnchor;
  /** Convenience selectors for customer-first JARVIS journeys. */
  householdId?: string;
  query?: string;
}

export interface PartyLookupRequest {
  intent: "party_lookup";
  /** A canonical PartyRef takes precedence over text resolution. */
  ref?: PartyRef;
  /** Relationship phrases are resolved against authenticated employee/work context. */
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
  /** The team ref is optional when query names the team. */
  teamRef?: PartyRef;
  query?: string;
  page?: OperationalQueryPageRequest;
}

export interface PartyAvailabilityRequest {
  intent: "party_availability";
  ref?: PartyRef;
  query?: string;
  localDateRange?: OperationalLocalDateRange;
  includeCapacity?: boolean;
  page?: OperationalQueryPageRequest;
}

export interface DealScopedQueryRequest {
  /** Exact canonical Deal id. tenantId is supplied only by authenticated execution. */
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

export type CanonicalOperationalQueryRequest =
  | CustomerLookupRequest
  | CustomerCohortRequest
  | ScheduleRangeRequest
  | MoneySummaryRequest
  | WorkListRequest
  | InventoryStatusRequest
  | AgentActivityRequest
  | BusinessStateRequest
  | CompanyContextRequest
  | PartyLookupRequest
  | PartyContextRequest
  | TeamRosterRequest
  | PartyAvailabilityRequest
  | DealContextRequest
  | DealWorkstreamsRequest
  | OpenRequestsRequest
  | OpenFindingsRequest
  | OpenDealRisksRequest
  | CriticalDependenciesRequest
  | ClosingReadinessRequest;

export interface CustomerLookupCompatibilityRequest {
  intent: "customer_lookup";
  params: { householdId?: string; query?: string; name?: string; phone?: string; limit?: number };
}
export interface CustomerCohortCompatibilityRequest {
  intent: "customer_cohort" | "inactivity_cohort";
  params: { minDaysInactive: number; asOf?: string; limit?: number };
}
export interface ScheduleRangeCompatibilityRequest {
  intent: "schedule_range";
  params: { startDate: string; endDate?: string; technicianId?: string; limit?: number };
}
export interface MoneySummaryCompatibilityRequest {
  intent: "money_summary" | "money";
  params: { metric?: "cash_collections" | "invoices" | "payments" | "overdue"; limit?: number };
}
export interface WorkListCompatibilityRequest {
  intent: "work_list" | "work";
  params: { recordId?: string; status?: string; openOnly?: boolean; limit?: number };
}
export interface InventoryStatusCompatibilityRequest {
  intent: "inventory_status" | "inventory";
  params: { sku?: string; lowStockOnly?: boolean; limit?: number };
}
export interface AgentActivityCompatibilityRequest {
  intent: "agent_activity";
  params: { since?: string; limit?: number };
}
export interface BusinessStateCompatibilityRequest {
  intent: "business_state";
  params: { windowDays?: number };
}

export type OperationalQueryCompatibilityRequest =
  | CustomerLookupCompatibilityRequest
  | CustomerCohortCompatibilityRequest
  | ScheduleRangeCompatibilityRequest
  | MoneySummaryCompatibilityRequest
  | WorkListCompatibilityRequest
  | InventoryStatusCompatibilityRequest
  | AgentActivityCompatibilityRequest
  | BusinessStateCompatibilityRequest;

export type OperationalQueryRequest = CanonicalOperationalQueryRequest | OperationalQueryCompatibilityRequest;

export interface OperationalQuerySource {
  kind: "canonical_postgres";
  /** Canonical tables actually read for this result. */
  tables: string[];
}

export interface OperationalQueryPageInfo {
  limit: number;
  returned: number;
  /** Exact count is intentionally nullable when the query did not count all rows. */
  totalCount: number | null;
  totalCountExact: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  /** True whenever rows were omitted because the bounded page/cap was reached. */
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
  /** Compact compatibility envelope fields; typed rows remain authoritative. */
  kind: "operational_query_result";
  status: OperationalQueryResultStatus;
  data: Record<string, unknown>;
  version: typeof OPERATIONAL_QUERY_VERSION;
  intent: I;
  source: OperationalQuerySource;
  asOf: string;
  /** Convenience aliases for clients that do not unpack `page`. */
  count: number;
  truncated: boolean;
  page: OperationalQueryPageInfo;
  meta: OperationalQueryResultMeta;
  execution?: OperationalQueryExecutionRef;
}

export interface CustomerLookupContactMethod {
  methodType: string;
  value: string;
}

export interface CustomerLookupRow {
  householdId: string;
  displayName: string | null;
  address: string;
  contacts: Array<{
    id: string;
    name: string;
    role: string | null;
    methods: CustomerLookupContactMethod[];
  }>;
  matchedBy: Array<"name" | "address" | "phone" | "email" | "household_id">;
  createdAt: string;
}

export interface CustomerLookupResult extends OperationalQueryResultBase<"customer_lookup"> {
  resolution: "exact" | "unique" | "ambiguous" | "not_found";
  rows: CustomerLookupRow[];
}

export interface CustomerCohortRow {
  householdId: string;
  displayName: string | null;
  address: string;
  lastInteractionAt: string | null;
  qualifiesBecause: "never_active" | "before_cutoff";
}

export interface CustomerCohortResult extends OperationalQueryResultBase<"customer_cohort"> {
  cohort: "inactive";
  minDaysInactive: number;
  cutoff: string;
  rows: CustomerCohortRow[];
}

export interface ScheduleRow {
  kind: "appointment" | "service_visit" | "work_order";
  id: string;
  scheduledAt: string;
  status: string;
  technician: { id: string; name: string } | null;
  household: { id: string; displayName: string | null; address: string } | null;
  subjectType?: string;
  durationMinutes?: number | null;
}

export interface ScheduleRangeResult extends OperationalQueryResultBase<"schedule_range"> {
  range: OperationalQueryRange;
  timeZone: string;
  localDateRange?: OperationalLocalDateRange;
  rows: ScheduleRow[];
}

export interface MoneyStatusSummary {
  status: string;
  count: number;
  totalUsd: number;
}

export interface MoneySummaryResult extends OperationalQueryResultBase<"money_summary"> {
  range: OperationalQueryRange | null;
  /** Current/unbounded cash view count from payment-link workflow steps; ranged views return null. */
  paymentLinksAwaitingPayment: number | null;
  invoices: MoneyStatusSummary[];
  collections: MoneyStatusSummary[];
  totals: {
    invoicedUsd: number;
    collectedUsd: number;
    pendingCollectionUsd: number;
  };
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
  workOrders: Array<{
    id: string;
    household: { id: string; displayName: string | null; address: string } | null;
    technician: { id: string; name: string } | null;
    type: string;
    status: string;
    scheduledAt: string | null;
    createdAt: string;
  }>;
  tasks: Array<{
    id: string;
    subjectType: string;
    subjectId: string;
    title: string;
    dueAt: string | null;
    assigneeType: string | null;
    assigneeId: string | null;
    status: string;
    priority: string;
    createdAt: string;
  }>;
  sectionPages: {
    works: OperationalQueryPageInfo;
    workOrders: OperationalQueryPageInfo;
    tasks: OperationalQueryPageInfo;
  };
}

export interface InventoryStatusResult extends OperationalQueryResultBase<"inventory_status"> {
  items: Array<{
    id: string;
    sku: string;
    name: string;
    quantity: number;
    reorderThreshold: number;
    unitCostUsd: number | null;
    lowStock: boolean;
  }>;
  warehouseStock: Array<{
    id: string;
    warehouseId: string;
    warehouseName: string | null;
    sku: string;
    quantity: number;
    reorderThreshold: number;
    unitOfMeasure: string;
    lowStock: boolean;
  }>;
  openProcurement: Array<{
    id: string;
    warehouseId: string;
    warehouseName: string | null;
    sku: string;
    quantityOrdered: number;
    status: string;
    expectedAt: string | null;
    createdAt: string;
  }>;
  sectionPages: {
    items: OperationalQueryPageInfo;
    warehouseStock: OperationalQueryPageInfo;
    openProcurement: OperationalQueryPageInfo;
  };
}

export interface AgentActivityResult extends OperationalQueryResultBase<"agent_activity"> {
  range: OperationalQueryRange;
  timeZone: string;
  localDateRange?: OperationalLocalDateRange;
  users: Array<{ id: string; email: string; role: string; createdAt: string }>;
  technicians: Array<{ id: string; name: string }>;
  actions: Array<{ id: string; actionType: string; status: string; step: string | null; occurredAt: string }>;
  workflows: Array<{ id: string; workflowType: string; status: string; occurredAt: string }>;
  calls: Array<{ id: string; conversationId: string | null; direction: string; startedAt: string | null; endedAt: string | null; endedReason: string | null; occurredAt: string }>;
  sectionPages: {
    users: OperationalQueryPageInfo;
    technicians: OperationalQueryPageInfo;
    actions: OperationalQueryPageInfo;
    workflows: OperationalQueryPageInfo;
    calls: OperationalQueryPageInfo;
  };
}

export interface BusinessStateCount {
  status: string;
  count: number;
}

export interface BusinessStateResult extends OperationalQueryResultBase<"business_state"> {
  pipeline: {
    leads: BusinessStateCount[];
    quotes: BusinessStateCount[];
    proposals: BusinessStateCount[];
    opportunities: BusinessStateCount[];
  };
  operations: {
    appointments: BusinessStateCount[];
    workOrders: BusinessStateCount[];
    tasks: BusinessStateCount[];
    invoices: BusinessStateCount[];
    workflows: BusinessStateCount[];
    openProcurementOrders: number;
    lowStockItems: number;
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

export interface PartyAvailabilityWindow {
  dayOfWeek: number | null;
  startTime: string | null;
  endTime: string | null;
  maxConcurrentJobs: number | null;
}

export interface PartyAvailabilityResult extends OperationalQueryResultBase<"party_availability"> {
  resolution: "exact" | "unique" | "ambiguous" | "not_found" | "inactive";
  party: OperationalPartySummary | null;
  candidates: OperationalPartySummary[];
  availability: "available" | "unavailable" | "unknown";
  windows: PartyAvailabilityWindow[];
  capacity: { openAssignments: number; maxConcurrentJobs: number | null } | null;
  dispatchProfile: { workdayStart: string | null; workdayEnd: string | null; defaultSlaMinutes: number | null } | null;
  sourceTables: string[];
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
  acquisitionOptions: Array<{
    propositionId: string;
    adapterId: string;
    kind: string;
    reason: string;
  }>;
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
  rows: Array<Record<string, unknown> & {
    id: string;
    state: string;
    evidenceRefs: string[];
    riskRefs: string[];
    epistemicWarnings: PrivateEquityEpistemicWarning[];
  }>;
  epistemicWarnings: PrivateEquityEpistemicWarning[];
}

export interface OpenDealRisksResult extends OperationalQueryResultBase<"open_deal_risks"> {
  rows: Array<Record<string, unknown> & {
    id: string;
    state: string;
    evidenceRefs: string[];
    findingRefs: string[];
    epistemicWarnings: PrivateEquityEpistemicWarning[];
  }>;
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
  | CustomerLookupResult
  | CustomerCohortResult
  | ScheduleRangeResult
  | MoneySummaryResult
  | WorkListResult
  | InventoryStatusResult
  | AgentActivityResult
  | BusinessStateResult
  | CompanyContextResult
  | PartyLookupResult
  | PartyContextResult
  | TeamRosterResult
  | PartyAvailabilityResult
  | DealContextResult
  | DealWorkstreamsResult
  | OpenRequestsResult
  | OpenFindingsResult
  | OpenDealRisksResult
  | CriticalDependenciesResult
  | ClosingReadinessResult;

/** Compact result accepted by the router compatibility seam. Canonical executor
 * results also carry these fields through OperationalQueryResultBase. */
export interface OperationalQueryCompatibilityResult {
  kind: "operational_query_result";
  /** A loose transport envelope used only by legacy/router adapters. Canonical
   * executor calls still return the typed result union and never this shape. */
  intent: OperationalQueryIntent;
  status: OperationalQueryResultStatus;
  data: Record<string, unknown>;
  asOf: string;
  range?: OperationalQueryRange;
  timeZone?: string;
  rows?: ScheduleRow[];
  execution?: OperationalQueryExecutionRef;
}

export type OperationalQueryResultEnvelope = OperationalQueryResult | OperationalQueryCompatibilityResult;

export type OperationalQueryResultFor<R extends OperationalQueryRequest> =
  R extends CustomerLookupRequest ? CustomerLookupResult
    : R extends CustomerLookupCompatibilityRequest ? CustomerLookupResult
      : R extends CustomerCohortRequest ? CustomerCohortResult
        : R extends CustomerCohortCompatibilityRequest ? CustomerCohortResult
          : R extends ScheduleRangeRequest ? ScheduleRangeResult
            : R extends ScheduleRangeCompatibilityRequest ? ScheduleRangeResult
              : R extends MoneySummaryRequest ? MoneySummaryResult
                : R extends MoneySummaryCompatibilityRequest ? MoneySummaryResult
                  : R extends WorkListRequest ? WorkListResult
                    : R extends WorkListCompatibilityRequest ? WorkListResult
                      : R extends InventoryStatusRequest ? InventoryStatusResult
                        : R extends InventoryStatusCompatibilityRequest ? InventoryStatusResult
                          : R extends AgentActivityRequest ? AgentActivityResult
                            : R extends AgentActivityCompatibilityRequest ? AgentActivityResult
                              : R extends BusinessStateRequest ? BusinessStateResult
                                : R extends BusinessStateCompatibilityRequest ? BusinessStateResult
                                  : R extends CompanyContextRequest ? CompanyContextResult
                                    : R extends PartyLookupRequest ? PartyLookupResult
                                      : R extends PartyContextRequest ? PartyContextResult
                                        : R extends TeamRosterRequest ? TeamRosterResult
                                          : R extends PartyAvailabilityRequest ? PartyAvailabilityResult
                                            : R extends DealContextRequest ? DealContextResult
                                              : R extends DealWorkstreamsRequest ? DealWorkstreamsResult
                                                : R extends OpenRequestsRequest ? OpenRequestsResult
                                                  : R extends OpenFindingsRequest ? OpenFindingsResult
                                                    : R extends OpenDealRisksRequest ? OpenDealRisksResult
                                                      : R extends CriticalDependenciesRequest ? CriticalDependenciesResult
                                                        : R extends ClosingReadinessRequest ? ClosingReadinessResult
                                    : never;
