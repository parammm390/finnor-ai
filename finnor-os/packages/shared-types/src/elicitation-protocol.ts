import type { ExperimentRef } from './experiments';
import type { AllocationEnvelope, AllocationReservation } from './allocation';
import type { EvidenceDependency } from './evidence-execution';

/** Reduced integers, positive denominator. Never a floating money amount. */
export interface ElicitationRational { numerator: string; denominator: string }
export interface ElicitationType {
  id: string;
  values: Record<string, ElicitationRational>;
  dateMultipliers: Record<string, ElicitationRational>;
  outsideOptions: Array<{ otherReports: string[]; utility: ElicitationRational }>;
}
export interface ElicitationParty {
  id: string; entityType: string; entityId: string; reportingPrincipalId: string;
  rightsRef: string; sourceRef: ExperimentRef; assumptionRef: ExperimentRef;
  types: ElicitationType[];
  payments: Array<{ dateId: string; minimum: ElicitationRational; maximum: ElicitationRational }>;
  liabilityCap: ElicitationRational;
}
export interface ElicitationDate {
  id: string; at: string; period: number; trigger: 'DUE_TIME';
  observableBy: 'OWNER_CLOCK'; contractRef: ExperimentRef;
  defaultCondition: 'RETAIN_OUTSTANDING_LIABILITY';
  grossOutflowCap: ElicitationRational; escrowCap: ElicitationRational;
}
export interface ElicitationResource {
  ref: ExperimentRef; resourceId: string; unit: string;
  kind: 'STOCK' | 'FLOW' | 'OCCUPANCY' | 'CUMULATIVE_EXPENDITURE' | 'EXPOSURE';
  horizon: { startAt: string; periodMs: number; periods: number };
  availability: ElicitationRational[]; baseline: ElicitationRational[];
  minimumBaseline: ElicitationRational[]; safetyMargin: ElicitationRational;
}
export interface ElicitationOutcome {
  id: string; meaningRef: ExperimentRef;
  eligibility: 'ALL_REPORTS' | string[][];
  demands: Record<string, ElicitationRational[]>;
  costs: ElicitationRational[]; liabilities: ElicitationRational[];
}
export interface ElicitationProblem {
  schema: 'finnor.r3.problem.v1';
  binding: {
    tenantId: string; principalId: string; workId: string; workRevision: string;
    workDigest: string; root: { entityType: string; entityId: string };
    preferenceRef: ExperimentRef; mandateRef: ExperimentRef; domainRef: ExperimentRef;
    paymentContractRef: ExperimentRef; rightsRef: string;
    backendDigest: string; checkerDigest: string; producerDigest: string;
    schemaDigest: string; sourceManifestDigest: string;
    programTarget?: { grammar: 'r3-m3-report-extension-v1'; queryId: string;
      programRef: ExperimentRef; candidateDigest: string; policyRef: ExperimentRef };
  };
  model: { utility: 'SUPPLIED_QUASILINEAR'; participation: 'EX_POST_ALL_OTHER_REPORTS';
    events: 'UNCONDITIONAL_DUE_TIME'; guarantee: 'INDIVIDUAL_WEAK_DSIC' };
  money: { currency: string; unit: string; valuationDate: string; ownerId: string;
    timeConvention: string; discountConvention: string;
    ownerDateMultipliers: Record<string, ElicitationRational>; ownerPeriodMultipliers: ElicitationRational[] };
  parties: ElicitationParty[]; dates: ElicitationDate[]; outcomes: ElicitationOutcome[];
  resources: ElicitationResource[];
  covenants: Array<{ id: string; sourceRef: ExperimentRef; unit: string; periods: number[];
    terms: Array<{ resourceId: string; coefficient: ElicitationRational }>;
    maximum: ElicitationRational; safetyMargin: ElicitationRational }>;
  constraints: { cashResourceId: string; netTransferMinimum: ElicitationRational;
    netTransferMaximum: ElicitationRational; incomingPromisesMayFund: false;
    ownerLiabilityCap: ElicitationRational };
  mandateLimits: { dimensions: Array<{ resourceId: string; unit: string; totalLimit: ElicitationRational; capacity: ElicitationRational }>;
    couplings: Array<{ id: string; weights: Record<string, ElicitationRational>; maximum: ElicitationRational }> };
  objective: { kind: 'MAXIMIN' | 'EXPECTED_QUALIFIED_JOINT';
    valueByProfile: Record<string, Record<string, ElicitationRational>>;
    weights: ElicitationRational[] | null; distributionRef: ExperimentRef | null;
    range: [ElicitationRational, ElicitationRational]; normalization: ElicitationRational;
    minimumValue: ElicitationRational;
    tieConvention: 'NO_STRICT_TRUTH_OR_CONSENT_FROM_TIES' };
  assumptions: string[];
  /** An explicitly registered reference grid, never silently applied in general. */
  referenceGrid?: ElicitationRational[];
}
export interface ElicitationRuleRow {
  reports: string[]; outcomeId: string;
  schedule: Array<{ partyId: string; dateId: string; amount: ElicitationRational;
    eventId: string; currency: string; unit: string; dueAt: string }>;
}
export interface ElicitationRule {
  schema: 'finnor.r3.rule.v1'; inputDigest: string;
  binding: ElicitationProblem['binding']; table: ElicitationRuleRow[];
  search: { status: string; numericalSemantics: 'SCIP_FLOAT64_PROPOSAL';
    optimum: 'UNKNOWN' | 'ORIGINAL_ANALYTIC_BOUND_ATTAINED';
    claimedObjective: ElicitationRational; claimedUpper: ElicitationRational | null;
    proof: null; trace: Record<string, unknown> };
}
export interface ElicitationCheck {
  schema: 'finnor.r3.check.v1'; accepted: boolean; inputDigest: string; ruleDigest: string | null;
  checker: { sourceDigest: string; pythonVersion: string; implementation: 'INDEPENDENT_FRACTION_V1' };
  basis: 'MODEL_RELATIVE_EXACT' | 'UNKNOWN' | 'UNSUPPORTED';
  counts: { profiles: number; deviations: number; participation: number };
  failures: Array<Record<string, unknown>>;
  objective: ElicitationRational | null; upper: ElicitationRational | null;
  optimizationGap: ElicitationRational | null; optimum: 'CHECKED_ANALYTIC' | 'UNKNOWN';
  minimumIncentiveMargin: ElicitationRational | null;
  minimumParticipationMargin: ElicitationRational | null;
  maximumDeviationGain: ElicitationRational | null;
  envelopes: AllocationEnvelope[]; assumptions: string[];
  consentEstablished: false; executionAuthorityGranted: false; behavioralTruthEstablished: false;
}
export interface ElicitationArtifactEnvelope {
  id: string; kind: 'ElicitationProtocol'; schemaRevision: 1;
  tenantId: string; principalId: string;
  work: { id: string; revision: string; digest: string };
  baseline: { commit: string; tree: string; manifestDigest: string };
  producer: { codeDigest: string; lockDigest: string; admissionRef: null };
  ownerInputs: Array<{ ref: ExperimentRef; asOf: string; rightsRef: string }>;
  domainRef: ExperimentRef; grammar: 'r3-elicitation-use-v1';
  checkBasis: 'MODEL_RELATIVE_EXACT';
  claims: Array<{ statement: string; domainRef: ExperimentRef; checkerReceipt: ExperimentRef }>;
  gaps: Array<{ reason: string; affectedClaims: string[]; status: 'UNKNOWN' | 'BLOCKED_EXTERNAL' }>;
  budgetGrantRef: ExperimentRef; resourceReceipts: Array<Record<string, unknown>>;
  invalidationDependencies: EvidenceDependency[];
  lifecycle: { state: 'development-verified'; historyRefs: ExperimentRef[];
    domainQualified: false; s8Admitted: false; active: false };
}
export interface ElicitationProtocol {
  schema: 'finnor.elicitation-protocol.v1'; ref: ExperimentRef;
  envelope: ElicitationArtifactEnvelope; problem: ElicitationProblem;
  rule: ElicitationRule; check: ElicitationCheck;
  reporting: { schema: 'r3-authorized-report-v1'; corrections: 'BEFORE_CLOSE_ONLY';
    closing: 'ALL_REPORTS_OR_NO_AGREEMENT'; tableFixedBeforeReports: true };
  usePolicyRef: ExperimentRef | null; reservation: AllocationReservation | null;
  proposedSchedulesRef: ExperimentRef | null;
  agreementEstablished: false; settlementEstablished: false; executionAuthorityGranted: false;
}
