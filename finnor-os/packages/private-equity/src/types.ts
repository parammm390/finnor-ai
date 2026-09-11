import type { CanonicalEntityRef, PartyRef, TenantContext, VerticalDefinition } from "@finnor/shared-types";

export const PRIVATE_EQUITY_VERTICAL_KEY = "private_equity" as const;

export const PE_ENTITY_TYPES = [
  "pe_strategy",
  "pe_opportunity",
  "pe_deal",
  "pe_investment_case",
  "pe_thesis",
  "pe_assumption",
  "pe_decision",
  "pe_deal_party",
  "pe_workstream",
  "pe_request",
  "pe_deliverable",
  "pe_finding",
  "pe_deal_risk",
  "pe_dependency",
  "pe_milestone",
  "pe_closing_condition",
  "pe_closing_item",
  "pe_document_link",
  "pe_evidence_link",
  "pe_finding_risk_link",
  "pe_ic_case",
  "pe_ic_memo",
  "pe_ic_question",
  "pe_ic_recommendation",
  "pe_ic_vote",
  "pe_ic_dissent",
  "pe_ic_condition",
  "pe_ic_decision_proposal",
] as const;

export type PeEntityType = (typeof PE_ENTITY_TYPES)[number];
export type PeEntityRef = CanonicalEntityRef<PeEntityType>;

export const PE_DEPENDENCY_ENDPOINT_TYPES = [
  "pe_workstream",
  "pe_request",
  "pe_deliverable",
  "pe_finding",
  "pe_deal_risk",
  "pe_milestone",
  "pe_closing_condition",
  "pe_closing_item",
] as const;
export type PeDependencyEndpointType = (typeof PE_DEPENDENCY_ENDPOINT_TYPES)[number];
export type PeDependencyEndpoint = CanonicalEntityRef<PeDependencyEndpointType>;

export type DealState = "active" | "closed" | "terminated";
export type DealPartyState = "active" | "removed";
export type WorkstreamState = "not_started" | "active" | "complete" | "cancelled";
export type RequestState = "open" | "acknowledged" | "fulfilled" | "cancelled";
export type DeliverableState = "expected" | "received" | "accepted" | "rejected" | "superseded" | "cancelled";
export type FindingState = "open" | "resolved" | "accepted" | "superseded";
export type DealRiskState = "open" | "mitigating" | "resolved" | "accepted";
export type MilestoneState = "pending" | "achieved" | "cancelled";
export type ClosingConditionState = "open" | "evidence_pending" | "satisfied" | "waived" | "failed";
export type ClosingItemState = "open" | "ready" | "verified" | "cancelled";
export type StrategyState = "draft" | "active" | "retired";
export type OpportunityState = "identified" | "screening" | "qualified" | "promoted" | "rejected";
export type InvestmentCaseState = "draft" | "active" | "superseded" | "archived";
export type ThesisState = "draft" | "active" | "superseded" | "retired";
export type AssumptionState = "active" | "superseded" | "invalidated";
export type DecisionState = "draft" | "final" | "superseded";
export type AssumptionValueType = "number" | "currency" | "percent" | "boolean" | "date" | "text" | "json";
export type PeWorldRootType = "pe_strategy" | "pe_opportunity" | "pe_deal";
export interface PeWorldRootRef { entityType: PeWorldRootType; entityId: string }

export type PeLifecycleName =
  | "strategy"
  | "opportunity"
  | "investment_case"
  | "thesis"
  | "assumption"
  | "decision"
  | "deal"
  | "deal_party"
  | "workstream"
  | "request"
  | "deliverable"
  | "finding"
  | "deal_risk"
  | "milestone"
  | "closing_condition"
  | "closing_item";

export type PeLifecycleState =
  | DealState | DealPartyState | WorkstreamState | RequestState | DeliverableState
  | FindingState | DealRiskState | MilestoneState | ClosingConditionState | ClosingItemState
  | StrategyState | OpportunityState | InvestmentCaseState | ThesisState | AssumptionState | DecisionState;

export const DEAL_PARTY_ROLES = [
  "buyer_sponsor","target_management","seller","sell_side_banker","lender",
  "buyer_legal_counsel","seller_legal_counsel","qoe_advisor","tax_advisor",
  "commercial_advisor","technology_advisor","insurance_advisor","other",
] as const;
export type DealPartyRole = (typeof DEAL_PARTY_ROLES)[number];

export const WORKSTREAM_KINDS = [
  "financial_diligence","legal","tax","commercial","technology","financing",
  "insurance","regulatory","closing","custom",
] as const;
export type WorkstreamKind = (typeof WORKSTREAM_KINDS)[number];

export type InternalPartyRef = PartyRef & { partyType: "employee" | "team" };
export type PePartyRef = PartyRef & { partyType: "employee" | "team" | "external_organization" | "external_contact" };

export interface PeProvenanceInput {
  sourceSystem?: string;
  externalId?: string;
  createdBy?: string;
  observedAt?: Date;
}

export interface PeMutationContext {
  auth: TenantContext;
  provenance?: PeProvenanceInput;
}

export interface GovernanceProof {
  authorityDecisionId: string;
  decisionReceiptId?: string;
}

export interface PeMutationResult<T extends Record<string, unknown> = Record<string, unknown>> {
  row: T;
  changed: boolean;
  idempotent: boolean;
}

export interface CloseConditionBlocker {
  id: string;
  condition: string;
  state: ClosingConditionState;
  reason?: string | null;
}

export interface ClosingItemBlocker {
  id: string;
  item: string;
  state: ClosingItemState;
}

export interface BlockingDependency {
  dependencyId: string;
  blocker: PeDependencyEndpoint;
  blocked: PeDependencyEndpoint;
  relation: "blocks";
}

export interface InvalidWaiver {
  id: string;
  condition: string;
  authorityDecisionId: string | null;
  decisionReceiptId: string | null;
}

export interface DealCloseEligibility {
  dealId: string;
  dealState: DealState;
  dealVersion: number;
  graphVersion: number;
  signedLoiPresent: boolean;
  eligible: boolean;
  blockingConditions: CloseConditionBlocker[];
  failedConditions: CloseConditionBlocker[];
  unverifiedClosingItems: ClosingItemBlocker[];
  blockingDependencies: BlockingDependency[];
  invalidWaivers: InvalidWaiver[];
  integrityErrors: string[];
}

export interface DealExecutionGraph {
  deal: Record<string, unknown>;
  dealParties: Record<string, unknown>[];
  workstreams: Record<string, unknown>[];
  requests: Array<Record<string, unknown> & { overdue: boolean }>;
  deliverables: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  dealRisks: Record<string, unknown>[];
  findingRiskLinks: Record<string, unknown>[];
  dependencies: Record<string, unknown>[];
  milestones: Array<Record<string, unknown> & { late: boolean }>;
  closingConditions: Record<string, unknown>[];
  closingItems: Record<string, unknown>[];
  documentLinks: Record<string, unknown>[];
  evidenceLinks: Record<string, unknown>[];
  workLinks: Record<string, unknown>[];
  taskLinks: Record<string, unknown>[];
  /** Core temporal/governance rows associated with the PE graph. */
  businessEvents: Record<string, unknown>[];
  authorityDecisions: Record<string, unknown>[];
  approvalRequests: Record<string, unknown>[];
  decisionReceipts: Record<string, unknown>[];
  asOf: string;
}

export type TemporalCompletenessStatus = "complete" | "partial" | "unavailable_before_baseline";

export interface PeWorldState {
  root: PeWorldRootRef;
  stateAt: string;
  temporalCompleteness: {
    status: TemporalCompletenessStatus;
    baselineAt: string | null;
    unavailableEntityTypes: PeEntityType[];
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
  /** Provider observations whose EvidenceVersions are historically visible in
   * this world. Payload content remains in Core Evidence, not duplicated here. */
  observedEvidence: Record<string, unknown>[];
  /** Exact source coverage facts as known at stateAt. */
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
  epistemicWarnings: Array<{
    propositionId: string;
    predicate: string;
    status: "UNKNOWN" | "STALE" | "CONFLICTING" | "UNCERTAIN" | "CONTRADICTED";
    reason: string;
    evidenceRefs: string[];
  }>;
  provenance: Array<{
    entityType: string;
    entityId: string;
    entityVersion: number;
    snapshotHash: string;
    recordedAt: string;
    origin: "mutation" | "baseline";
  }>;
}

export const privateEquityVerticalDefinition: VerticalDefinition<PeEntityType> = {
  key: PRIVATE_EQUITY_VERTICAL_KEY,
  displayName: "Private Equity",
  implementationOwner: "@finnor/private-equity",
  entityTypes: PE_ENTITY_TYPES,
};

export class PeDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PeDomainError";
  }
}

export class DealCloseRejectedError extends PeDomainError {
  constructor(public readonly eligibility: DealCloseEligibility) {
    super("PE_DEAL_NOT_CLOSE_ELIGIBLE", "Deal close rejected by canonical close eligibility", eligibility);
    this.name = "DealCloseRejectedError";
  }
}
