/**
 * P3 is a planning-time, read-only epistemic layer. These contracts describe what
 * FINNOR knows and which observations would improve a decision. They are never a
 * BusinessEffect, Authority decision, Work mutation, provider operation, or second
 * source of canonical truth.
 */

export const EPISTEMIC_STATE_VERSION = 1 as const;
export const EPISTEMIC_HEURISTIC_VERSION = "p3-information-value-v1" as const;
export const EPISTEMIC_TRACE_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type PropositionStatus = "KNOWN" | "UNKNOWN" | "STALE" | "CONFLICTING" | "UNCERTAIN";

export type EvidenceKind =
  | "CANONICAL_DB"
  | "ACTIVE_WORK"
  | "EXPLICIT_USER_INPUT"
  | "PROFILE"
  | "SESSION"
  | "MEMORY"
  | "DOCUMENT"
  | "PROVIDER_OBSERVATION"
  | "COMPUTER_OBSERVATION"
  | "WEB_RESEARCH"
  | "DERIVED";

/** Exact P0 operating-context precedence vocabulary. New P3 evidence kinds map to
 * one of these classes; they do not silently insert a new truth tier. */
export type ExistingTruthClass = "CANONICAL" | "WORK" | "PROFILE" | "SESSION" | "MEMORY" | "WEB";

export type SourceAuthority =
  | "CANONICAL_OWNER"
  | "WORK_LEDGER"
  | "USER_INTENT_OWNER"
  | "CONFIGURED_PROFILE"
  | "CURRENT_SESSION"
  | "GOVERNED_OBSERVATION"
  | "DURABLE_EVIDENCE"
  | "SEMANTIC_MEMORY"
  | "PUBLIC_RESEARCH"
  | "DERIVED_ONLY";

export type InformationSensitivity =
  | "PUBLIC"
  | "TENANT_INTERNAL"
  | "CUSTOMER_DATA"
  | "PII"
  | "FINANCIAL"
  | "CREDENTIAL_BOUND"
  | "SECRET"
  | "UNCLASSIFIED";

export type FreshnessStatus = "FRESH" | "STALE" | "EXPIRED" | "UNKNOWN";
export type ConfidenceLevel = "VERIFIED" | "HIGH" | "MEDIUM" | "LOW" | "UNSUPPORTED";

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  /** A bounded heuristic label, never a calibrated probability. */
  basis: "DETERMINISTIC_SOURCE" | "SOURCE_ASSERTION" | "CORROBORATED" | "SINGLE_OBSERVATION" | "DERIVED_HEURISTIC" | "NO_SUPPORT";
  heuristicVersion: typeof EPISTEMIC_HEURISTIC_VERSION;
  reasonCodes: string[];
}

export interface PropositionSubject {
  kind: "entity" | "party" | "work" | "objective" | "provider" | "document" | "user_intent" | "system" | "external";
  type: string;
  id?: string;
  /** Human-readable labels are kept out of redacted traces. */
  label?: string;
}

export interface PropositionPredicate {
  name: string;
  path?: string;
  operator?: "exists" | "not_exists" | "eq" | "not_eq" | "gte" | "lte" | "contains" | "available";
}

export type PropositionValue =
  | { kind: "DETERMINISTIC"; value: JsonValue }
  | { kind: "ALTERNATIVES"; alternatives: Array<{ value: JsonValue; evidenceRefs: string[] }> }
  | { kind: "UNAVAILABLE" };

export interface EvidenceSource {
  kind: EvidenceKind;
  /** Actual audited owner/capability name, for example operational_query:money_summary. */
  owner: string;
  ref: string;
  authority: SourceAuthority;
  truthClass: ExistingTruthClass;
  /** Preserves the existing OperatingSourceRef distinction. */
  role: "answer_evidence" | "context_only";
}

export interface EvidenceFreshness {
  status: FreshnessStatus;
  maxAgeMs?: number;
  ageMs?: number;
  reason: string;
}

export interface EvidenceProvenance {
  sourceRef: string;
  parentEvidenceRefs: string[];
  dependencyRefs: string[];
  derivation?: { ruleId: string; version: string };
}

/** Evidence is append-only. Belief recomputation may stop selecting an old record,
 * but it never edits or deletes historical evidence. */
export interface EvidenceRecord {
  id: string;
  propositionId: string;
  tenantId: string;
  source: EvidenceSource;
  observedAt: string;
  validAt?: string;
  ingestedAt: string;
  value: JsonValue;
  confidence: ConfidenceAssessment;
  freshness: EvidenceFreshness;
  sensitivity: InformationSensitivity;
  provenance: EvidenceProvenance;
  /** True only for a deterministic record read from an existing canonical owner. */
  canonical: boolean;
  /** A canonical fact can explicitly retract/supersede an older canonical record. */
  supersedesEvidenceRefs?: string[];
  immutable: true;
}

/** Canonical truth remains a separate deterministic projection. P3 may select it,
 * cite it, or notice conflicting lower evidence; it may never rewrite it. */
export interface CanonicalTruthRecord {
  propositionId: string;
  evidenceRef: string;
  owner: string;
  sourceRef: string;
  value: JsonValue;
  observedAt: string;
  validAt?: string;
}

export interface Proposition {
  id: string;
  subject: PropositionSubject;
  predicate: PropositionPredicate;
  status: PropositionStatus;
  value: PropositionValue;
  source?: EvidenceSource;
  sourceAuthority?: SourceAuthority;
  observedAt?: string;
  validAt?: string;
  freshness: EvidenceFreshness;
  confidence: ConfidenceAssessment;
  evidenceRefs: string[];
  dependencyRefs: string[];
  /** Lower-authority contradictory evidence remains visible here even when a
   * canonical winner keeps the proposition KNOWN. */
  contradictingEvidenceRefs: string[];
}

export interface PropositionDefinition {
  id: string;
  subject: PropositionSubject;
  predicate: PropositionPredicate;
  dependencyRefs?: string[];
}

export type ConflictResolution = "UNRESOLVED" | "HIGHER_AUTHORITY_WINS" | "FRESHER_SAME_AUTHORITY_WINS" | "EXPLICIT_SUPERSESSION";

export interface EvidenceConflict {
  id: string;
  propositionId: string;
  evidenceRefs: string[];
  resolution: ConflictResolution;
  winningEvidenceRefs: string[];
  reasonCode: string;
}

export interface UnknownProposition {
  propositionId: string;
  reason: "NO_EVIDENCE" | "ONLY_STALE_EVIDENCE" | "CONFLICT_UNRESOLVED" | "LOW_CONFIDENCE" | "UNOBSERVABLE";
}

export interface PropositionFreshness {
  propositionId: string;
  status: FreshnessStatus;
  evaluatedAt: string;
  newestEvidenceAt?: string;
  maxAgeMs?: number;
}

export interface PropositionProvenance {
  propositionId: string;
  evidenceRefs: string[];
  selectedEvidenceRefs: string[];
  dependencyRefs: string[];
  complete: boolean;
}

export interface PropositionDependency {
  id: string;
  propositionId: string;
  dependsOnPropositionId: string;
  kind: "DERIVED_FROM" | "DECISION_REQUIRES" | "P2_REQUIRES";
}

export interface EpistemicScope {
  tenantId: string;
  principalId: string;
  workId?: string;
  decisionId: string;
}

export interface EpistemicState {
  version: typeof EPISTEMIC_STATE_VERSION;
  scope: EpistemicScope;
  asOf: string;
  propositions: Proposition[];
  /** Separate deterministic canonical projection; never inferred from confidence. */
  canonicalTruth: CanonicalTruthRecord[];
  evidence: EvidenceRecord[];
  conflicts: EvidenceConflict[];
  unknowns: UnknownProposition[];
  freshness: PropositionFreshness[];
  provenance: PropositionProvenance[];
  dependencies: PropositionDependency[];
  /** Replayable transition summaries only; historical evidence lives above. */
  transitions: BeliefTransition[];
}

export type UncertaintyCategory =
  | "MISSING"
  | "AMBIGUOUS"
  | "STALE"
  | "CONFLICTING"
  | "LOW_CONFIDENCE"
  | "UNOBSERVABLE"
  | "EXTERNAL_UNKNOWN"
  | "PERMISSION_BLOCKED";

export type DecisionCriticality = "INFORMATIONAL" | "OPERATIONAL" | "CONSEQUENTIAL" | "SAFETY_LEGAL";

export interface AcquisitionOption {
  kind: InformationActionKind;
  adapterId: InformationAdapterId;
  reason: string;
  expectedAuthority: SourceAuthority;
}

export interface DecisionRequirement {
  propositionId: string;
  decisionId: string;
  description: string;
  criticality: DecisionCriticality;
  mandatory: boolean;
  acceptableStatuses: PropositionStatus[];
  minimumAuthority?: SourceAuthority[];
  maximumAgeMs?: number;
  minimumConfidence?: Exclude<ConfidenceLevel, "UNSUPPORTED">;
  consequenceIfUnresolved: string;
  acquisitionOptions: AcquisitionOption[];
  /** Preserves an exact upstream unresolved classification (for example a P2
   * entity ambiguity) while the proposition is still UNKNOWN. It is a reason
   * hint only and cannot make the requirement resolved. */
  unresolvedCategoryHint?: UncertaintyCategory;
  unresolvedReasonCodes?: string[];
}

export interface Uncertainty {
  id: string;
  category: UncertaintyCategory;
  requiredPropositionId: string;
  whyUnresolved: string;
  reasonCodes: string[];
  decisionDependency: { decisionId: string; criticality: DecisionCriticality; mandatory: boolean };
  possibleAcquisitionActions: AcquisitionOption[];
  consequenceOfActingWithoutResolution: string;
}

export type InformationActionKind = "READ" | "RETRIEVE" | "ASK" | "INSPECT" | "RESEARCH" | "WAIT";

/** Names actual current seams without binding epistemic semantics to a vendor. */
export type InformationAdapterId =
  | "CANONICAL_OPERATIONAL_QUERY"
  | "OPERATING_CONTEXT_READ"
  | "HYBRID_RETRIEVAL"
  | "EVIDENCE_CORPUS_RETRIEVAL"
  | "CLARIFICATION_REQUEST"
  | "SOURCE_TRUTH_OBSERVATION"
  | "COMPUTER_READ_ONLY_OBSERVATION"
  | "WEB_RESEARCH"
  | "WORK_EVENT_WAIT";

export type InformationBoundary = "CANONICAL_INTERNAL" | "TENANT_INTERNAL" | "USER" | "CONFIGURED_PROVIDER" | "COMPUTER_APPLICATION" | "PUBLIC_WEB" | "EVENT_STREAM";

export interface InformationActionInput {
  propositionIds: string[];
  query: JsonObject;
  sensitivity: InformationSensitivity[];
  tenantId: string;
  principalId: string;
}

export interface ExpectedInformation {
  propositionIds: string[];
  possibleStatuses: PropositionStatus[];
  evidenceKind: EvidenceKind;
  schema: string;
}

export interface InformationCost {
  monetaryUnits: number;
  toolUnits: number;
  provenance: "BOUNDED_HEURISTIC" | "CONFIGURED";
}

export interface InformationLatency {
  expectedMs: number;
  maximumMs: number;
}

export interface UserInterruption {
  required: boolean;
  units: number;
  promptFields: string[];
}

export interface PrivacyExposure {
  boundary: InformationBoundary;
  sensitivity: InformationSensitivity[];
  units: number;
  declassified: boolean;
  authorizationEvidenceRefs: string[];
}

export interface InformationFailureMode {
  code: string;
  recoverable: boolean;
  riskUnits: number;
}

export interface FreshnessGain {
  expected: "NONE" | "REFRESH" | "NEW_OBSERVATION";
  validityMs?: number;
}

export interface InformationActionEstimate {
  decisionQualityImprovement: number;
  expectedUncertaintyReduction: number;
  decisionRelevance: number;
  safetyLegalityPriority: number;
  failureRisk: number;
  provenance: "BOUNDED_HEURISTIC" | "CONFIGURED";
  heuristicVersion: typeof EPISTEMIC_HEURISTIC_VERSION;
  reasonCodes: string[];
}

export interface InformationAction {
  id: string;
  kind: InformationActionKind;
  adapterId: InformationAdapterId;
  scope: EpistemicScope;
  requiredInput: InformationActionInput;
  expectedInformation: ExpectedInformation;
  sourceAuthority: SourceAuthority;
  cost: InformationCost;
  latency: InformationLatency;
  userInterruption: UserInterruption;
  privacyExposure: PrivacyExposure;
  failureModes: InformationFailureMode[];
  freshnessGain: FreshnessGain;
  decisionDependency: { decisionId: string; propositionIds: string[]; criticality: DecisionCriticality };
  estimate: InformationActionEstimate;
  /** Information actions are structurally incapable of a business mutation. */
  mutability: "READ_ONLY";
}

export interface InformationActionScore {
  actionId: string;
  eligible: boolean;
  safetyLegality: number;
  decisionRelevance: number;
  uncertaintyReduction: number;
  userInterruptionPenalty: number;
  latencyPenalty: number;
  costPenalty: number;
  privacyPenalty: number;
  failureRiskPenalty: number;
  netUtility: number;
  heuristicVersion: typeof EPISTEMIC_HEURISTIC_VERSION;
  reasonCodes: string[];
}

export interface InformationObservation {
  actionId: string;
  adapterId: InformationAdapterId;
  tenantId: string;
  observedAt: string;
  evidence: EvidenceRecord[];
  /** An empty list is valid and records a failed/no-result observation. */
  propositionIds: string[];
  outcome: "OBSERVED" | "NO_RESULT" | "FAILED" | "WAITING" | "PERMISSION_BLOCKED";
  failureCode?: string;
}

export interface AcquisitionBudget {
  maxActions: number;
  maxUserInterruptions: number;
  maxLatencyMs: number;
  maxCostUnits: number;
  deadline: string;
}

export interface AcquisitionUsage {
  actions: number;
  userInterruptions: number;
  latencyMs: number;
  costUnits: number;
  selectedActionFingerprints: string[];
}

export type StopReason =
  | "CONTINUE_ACQUISITION"
  | "DECISION_CRITICAL_RESOLVED"
  | "NON_POSITIVE_INFORMATION_VALUE"
  | "NO_LEGAL_ACTION"
  | "BUDGET_EXHAUSTED"
  | "DEADLINE_REACHED"
  | "NO_PROGRESS"
  | "P2_REJECTED"
  | "P2_ADMISSIBLE";

export interface StopDecision {
  stop: boolean;
  reason: StopReason;
  unresolvedMandatory: string[];
  bestActionId?: string;
  bestNetUtility?: number;
  reasonCodes: string[];
}

export interface BeliefTransition {
  id: string;
  propositionId: string;
  from: PropositionStatus;
  to: PropositionStatus;
  evidenceRefs: string[];
  occurredAt: string;
  reasonCode: string;
}

export interface StaticAdmissibilityIssueLike {
  status: "REJECTED" | "UNRESOLVED";
  reasonCode: string;
  nodeId: string;
  path: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface StaticAdmissibilityResultLike {
  status: "ADMISSIBLE" | "REJECTED" | "UNRESOLVED";
  reasonCodes: string[];
  issues: StaticAdmissibilityIssueLike[];
}

export type SemanticDiffClassification = "EQUIVALENT" | "STRICTER_SAFE" | "BETTER_INFORMATION" | "REGRESSION" | "UNSUPPORTED" | "FIXTURE_INVALID";

export interface EpistemicBehaviorSummary {
  requiredFacts: string[];
  factsAvailable: string[];
  /** Canonical facts present in the evaluated state, whether or not selected. */
  canonicalFactsAvailable: string[];
  missingFacts: string[];
  sourcePrecedence: ExistingTruthClass[];
  clarificationNecessary: boolean;
  selectedSource: EvidenceSource | null;
  freshness: FreshnessStatus;
  conflicts: string[];
  decisionCriticalUncertainty: string[];
  stopCondition: StopReason;
  consequentialDecisionAllowed: boolean;
  p2Status?: StaticAdmissibilityResultLike["status"];
}

export interface EpistemicSemanticDiff {
  classification: SemanticDiffClassification;
  reasonCodes: string[];
  fields: {
    requiredFacts: "SAME" | "P3_STRICTER" | "DIFFERENT";
    factsAvailable: "SAME" | "P3_MORE" | "P3_LESS" | "DIFFERENT";
    missingFacts: "SAME" | "P3_MORE" | "P3_LESS" | "DIFFERENT";
    sourcePrecedence: "SAME" | "P3_STRICTER" | "DIFFERENT";
    clarificationNecessity: "SAME" | "P3_AVOIDS" | "P3_ADDS";
    selectedSource: "SAME" | "P3_HIGHER" | "P3_LOWER" | "DIFFERENT";
    freshness: "SAME" | "P3_FRESHER" | "P3_STALER" | "DIFFERENT";
    conflicts: "SAME" | "P3_EXPOSES" | "P3_HIDES" | "DIFFERENT";
    decisionCriticalUncertainty: "SAME" | "P3_EXPOSES" | "P3_HIDES" | "DIFFERENT";
    stopCondition: "SAME" | "P3_SAFER" | "P3_WEAKER" | "DIFFERENT";
  };
}

export interface RedactedEpistemicTrace {
  version: typeof EPISTEMIC_TRACE_VERSION;
  traceId: string;
  decisionId: string;
  startedAt: string;
  completedAt: string;
  initialPropositions: Array<{ id: string; status: PropositionStatus; evidenceCount: number }>;
  uncertainties: Array<{ propositionId: string; category: UncertaintyCategory; reasonCodes: string[] }>;
  candidates: Array<{ actionId: string; kind: InformationActionKind; adapterId: InformationAdapterId; score: InformationActionScore }>;
  selectedActions: Array<{ actionId: string; kind: InformationActionKind; adapterId: InformationAdapterId; outcome: InformationObservation["outcome"] }>;
  beliefUpdates: BeliefTransition[];
  stopDecisions: StopDecision[];
  finalPropositions: Array<{ id: string; status: PropositionStatus; evidenceCount: number }>;
  p2Statuses: StaticAdmissibilityResultLike["status"][];
  semanticDiff?: EpistemicSemanticDiff;
  /** Proves this trace intentionally excludes values, prompts, credentials and CoT. */
  redaction: "STRUCTURED_DECISIONS_ONLY";
}
