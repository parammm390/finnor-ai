import type { BeliefOwnerRef, BeliefView, BeliefViewPin } from "./enterprise-beliefs";

/** References are supplied commitments, not signatures or execution grants. */
export interface ExperimentRef { owner: string; id: string; version: string; contentDigest: string }
export interface ExperimentQuantity { value: string; unit: string }
export interface ExperimentExact { numerator: string; denominator: string; display: string; unit: string }
export interface ExperimentHypothesis { ref: ExperimentRef; prior: string; meaning: string }
export interface ExperimentCandidate {
  id: string;
  instrumentRef: ExperimentRef;
  endpoint: { id: string; unit: string; categories: string[] };
  populationRef: ExperimentRef;
  measurementUnit: string;
  assignment: { kind: "OBSERVATIONAL"; unit: string; probability: "1" };
  timing: { startAt: string; endAt: string; minimumIntervalMs: number };
  process: {
    methodRef: ExperimentRef;
    instrumentError: "IN_LIKELIHOOD" | "UNKNOWN";
    missingness: "NONE" | "EXPLICIT_OUTCOME" | "INFORMATIVE" | "UNKNOWN";
    dependence: "CONDITIONAL_IID" | "CLUSTERED" | "UNKNOWN";
    interference: "NONE" | "PRESENT" | "UNKNOWN";
    reactivity: "NONE" | "PRESENT" | "UNKNOWN";
    nuisance: "FIXED_SUPPLIED" | "UNKNOWN";
  };
  likelihood: { status: "SUPPLIED_CONDITIONAL"; probabilities: string[][]; calibrationRef: ExperimentRef | null; assumptions: string[] }
    | { status: "UNKNOWN"; reasons: string[] };
  samples: number;
  stopping: { method: "FIXED_SAMPLE" | "ANYTIME_LR"; alpha: string; beta: string; minimumPower: string };
  /** Total protocol estimates. These are distinct from enforced limits and actual accounting. */
  costEstimate: { money: ExperimentQuantity | null; elapsedMs: number | null; humanSeconds: number | null;
    dataBytes: number | null; integrationUnits: number | null; computeMs: number | null };
  exposure: { unitsPerSample: string; privacyUnitsPerSample: string; riskAssumptions: string[] };
}
export interface ExperimentDesignRequest {
  schema: "finnor.s2.design-request.v1";
  inquiryId: string;
  episodeId: string;
  mandateRef: ExperimentRef;
  decisionContext: { ref: ExperimentRef; utilityRef: ExperimentRef; horizonEnd: string; lossUnit: string;
    actionIds: string[]; lossByHypothesis: string[][] };
  hypotheses: ExperimentHypothesis[];
  requiredClaimRefs: string[];
  validUntil: string;
  maxBeliefAgeMs: number;
  constraints: { maxSamples: number; maxElapsedMs: number; maxExposureUnits: string; maxPrivacyUnits: string;
    moneyLimit: ExperimentQuantity | null; permittedPopulationRefs: ExperimentRef[]; permittedInstrumentRefs: ExperimentRef[] };
  candidates: ExperimentCandidate[];
}
export interface ExperimentMetrics {
  basis: "EXACT_SUPPLIED_FINITE_MODEL";
  empiricallyCalibrated: false;
  baselineRisk: ExperimentExact;
  terminalRisk: ExperimentExact;
  riskReduction: ExperimentExact;
  expectedSamples: ExperimentExact;
  massByHypothesis: ExperimentExact[];
  rejectH0ByHypothesis: ExperimentExact[];
  rejectH1ByHypothesis: ExperimentExact[];
  inconclusiveByHypothesis: ExperimentExact[];
  criterion: "SUPPLIED_TERMINAL_BAYES_LOSS";
  discrimination: { method: "TWO_SIMPLE_LR" | "NOT_REGISTERED_FOR_COMPOSITE"; alpha: string; beta: string;
    threshold: "LR_GE_1_OVER_ALPHA_OR_RECIPROCAL_GE_1_OVER_BETA" | null; optionalStoppingValid: boolean; multiplicityScope: "ONE_REGISTERED_ENDPOINT_ONE_PROTOCOL" };
  numerical: { arithmetic: "BIGINT_RATIONAL"; displayAbsoluteErrorBound: string; approximation: "NONE_FOR_RATIONAL_TOTALS"; states: number };
  /** Exact compact distribution: P(counts,stop|h) = sequenceMultiplicity *
   * product_k P(category_k|h)^counts_k. Sequential multiplicity includes only
   * paths first absorbed at this state. Priors/losses remain in the protocol.
   * This is a complete distribution encoding, with no sampling approximation. */
  distributionEncoding: "EXACT_COUNTS_AND_SURVIVING_PATH_MULTIPLICITY";
  observations: Array<{ counts: number[]; sampleSize: number; stop: string; sequenceMultiplicity: string }>;
  limitations: string[];
}
/** Shared ModelComputeFabric provenance for a pure numerical invocation. It is
 * ordinary producer evidence until the real ExperienceLedger admits it. */
export interface ModelComputeInvocation {
  schema: "finnor.model-compute-invocation.v1";
  id: string;
  semanticOwner: "S2";
  tenantId: string;
  principalId: string;
  rightsRef: string;
  inputRef: string;
  outputRefs: string[];
  requestedRoute: "LOCAL_EXACT_FINITE";
  actualRoute: "LOCAL_EXACT_FINITE";
  fallbacks: [];
  backend: { name: "finnor-finite-rational"; version: string; sourceDigests: Array<{ path: string; sha256: string }>; identityBasis: "LOADED_SOURCE_SNAPSHOT" | "SOURCE_IDENTITY_UNAVAILABLE" };
  model: null;
  harness: { nodeVersion: string; platform: string; architecture: string; configuration: { domain: "s2-finite-v1"; maxSamples: 24; maxCandidates: 8 }; deterministicReplayClaimed: false };
  attempts: Array<{ startedAt: string; finishedAt: string; status: "COMPLETED" | "FAILED"; reason: string | null }>;
  randomness: { used: false; seed: null };
  usage: { elapsedMs: number; processCpuUserMicros: number; processCpuSystemMicros: number; rssBeforeBytes: number; rssAfterBytes: number;
    accountingScope: "PROCESS_INTERVAL_INCLUSIVE_NOT_ISOLATED_PEAK" };
  cost: { money: ExperimentQuantity | null; pricebookRef: null; status: "LOCAL_COST_UNMETERED"; externalCalls: 0 };
  admission: { status: "BLOCKED_EXTERNAL"; receipt: null };
}
export interface S2ExperienceEvent {
  schema: "finnor.s2.experience.v1";
  eventId: string;
  episodeId: string;
  semanticOwner: "S2";
  type: "PROPOSAL" | "DESIGN_REJECTION" | "SELECTION" | "ALLOCATION_REFERENCE" | "COLLECTION" | "STOPPING" | "DEVIATION" | "COST" | "CORRECTION" | "INVALIDATION" | "COMPUTE";
  tenantId: string;
  principalId: string;
  rightsRef: string;
  /** Prepared graph references have no protected append receipt. */
  preparedParentRefs: string[];
  causalParents: [];
  revisionRef: string;
  contentDigest: string;
  validAt: string;
  knowledgeAt: string;
  dependencyRefs: string[];
  freshnessRef: string;
  uncertainty: "MODEL_CONDITIONAL_NO_FIELD_CALIBRATION" | "SUPPLIED_UNAUTHENTICATED_TELEMETRY";
  horizon: "H1";
  provenanceRefs: ExperimentRef[];
  modelComputeRef: string | null;
  detail: Record<string, unknown>;
}
export interface ExperimentProtocol {
  schema: "finnor.experiment-protocol.v1";
  semanticOwner: "S2";
  id: string;
  contentDigest: string;
  version: "s2-finite-v1";
  inquiryId: string;
  episodeId: string;
  tenantId: string;
  principalId: string;
  knowledgeAt: string;
  validUntil: string;
  requestDigest: string;
  mandateRef: ExperimentRef;
  decisionContext: ExperimentDesignRequest["decisionContext"];
  hypotheses: ExperimentHypothesis[];
  candidate: ExperimentCandidate;
  constraints: ExperimentDesignRequest["constraints"];
  beliefBinding: { viewRef: string; contentDigest: string; dependencyDigest: string; pin: BeliefViewPin;
    rightsRef: string; coverage: BeliefView["coverage"]; claimRefs: BeliefOwnerRef[]; posteriorCalibrated: false; maxAgeMs: number };
  metrics: ExperimentMetrics;
  dependencies: ExperimentRef[];
  admissibility: { status: "PROPOSAL_ONLY"; prerequisites: string[]; estimatesAreEnforcedLimits: false };
  admission: { status: "BLOCKED_EXTERNAL"; appendAuthorityGranted: false; executionAuthorityGranted: false; receipt: null };
  experience: { event: S2ExperienceEvent; receipt: null; status: "BLOCKED_EXTERNAL" };
}
export interface ExperimentDesignBundle {
  schema: "finnor.s2.design-bundle.v1";
  designs: Array<{ candidateId: string; status: "SUPPORTED" | "UNINFORMATIVE" | "UNSUPPORTED" | "EXPOSURE_INSUFFICIENT" | "BUDGET_EXCEEDED";
    protocol: ExperimentProtocol | null; reasons: string[] }>;
  /** Best measurement design within this request. Not a decision to commission. */
  preferredDesignRef: string | null;
  compute: ModelComputeInvocation;
  experience: S2ExperienceEvent[];
  boundary: "S4_SELECTS_INQUIRY_S5_COMMITS_S6_EXECUTES_S7_ATTRIBUTES";
}
export type ExperimentTelemetryKind = "SELECTION" | "ALLOCATION" | "ASSIGNMENT" | "ATTEMPT" | "ACKNOWLEDGMENT" | "EXPOSURE" | "OBSERVATION" | "VERIFICATION" | "RECONCILIATION" | "COST" | "CORRECTION" | "BUSINESS_STOP";
export interface ExperimentTelemetry {
  schema: "finnor.s2.reference-telemetry.v1";
  id: string;
  tenantId: string;
  principalId: string;
  protocolRef: string;
  kind: ExperimentTelemetryKind;
  data: Record<string, unknown>;
  parents: string[];
  validAt: string;
  knowledgeAt: string;
  sourceRef: ExperimentRef;
  trust: "SUPPLIED_UNAUTHENTICATED";
  protectedReceipt: null;
}
export interface ExperimentRealization {
  schema: "finnor.experiment-realization.v1";
  semanticOwner: "S2_MEASUREMENT_PROJECTION";
  id: string;
  contentDigest: string;
  protocolRef: string;
  priorRealizationRef: string | null;
  tenantId: string;
  principalId: string;
  knowledgeAt: string;
  history: ExperimentTelemetry[];
  selections: ExperimentTelemetry[];
  allocations: ExperimentTelemetry[];
  assignments: ExperimentTelemetry[];
  attempts: ExperimentTelemetry[];
  acknowledgments: ExperimentTelemetry[];
  reconciliations: ExperimentTelemetry[];
  actualExposures: ExperimentTelemetry[];
  measuredObservations: ExperimentTelemetry[];
  analyzableSample: ExperimentTelemetry[];
  censored: ExperimentTelemetry[];
  failures: ExperimentTelemetry[];
  unknownOutcomes: ExperimentTelemetry[];
  deviations: Array<{ code: string; eventRefs: string[]; reason: string }>;
  actualCosts: Array<{ dimension: string; unit: string; amount: string | null; knownSubtotal: string; eventRefs: string[]; basis: "SUPPLIED_ACCOUNTING_UNVERIFIED" }>;
  accountingCoverage: { status: "PARTIAL" | "COMPLETE_SUPPLIED_UNVERIFIED"; missingDimensions: string[]; independentlyAudited: false };
  analysis: { valid: boolean; basis: "SUPPLIED_MODEL_AND_UNAUTHENTICATED_REFERENCE_TELEMETRY"; counts: number[];
    posteriorByHypothesis: ExperimentExact[] | null; conditionalLossByAction: ExperimentExact[] | null;
    steps: Array<{ observationRef: string; cumulativeSampleSize: number; counts: number[]; statisticalStop: string }>;
    statisticalStop: "CONTINUE" | "REJECT_H0" | "REJECT_H1" | "SAMPLE_LIMIT" | "INVALID"; reasons: string[] };
  collectionDisposition: "CONTINUE_REFERENCE" | "STATISTICAL_STOP" | "COLLECTION_LIMIT" | "BUSINESS_STOP" | "RECONCILE_UNKNOWN" | "DEVIATION_HALT";
  lineage: { hypothesisRefs: ExperimentRef[]; mandateRef: ExperimentRef; policyRefs: ExperimentRef[]; allocationRefs: ExperimentRef[];
    effectRefs: ExperimentRef[]; observationRefs: ExperimentRef[]; attributionGranted: false };
  experience: S2ExperienceEvent[];
  admission: { status: "BLOCKED_EXTERNAL"; protectedHistoryComplete: false; executionAuthorityGranted: false; receipt: null };
}
/** Bounded producer IR to be independently resolved/rechecked by S6. The absent
 * verifier is not implemented by S2 and this document cannot dispatch an effect. */
export interface ExperimentCollectionHandoff {
  schema: "finnor.s2.collection-handoff.v1";
  status: "BLOCKED_EXTERNAL";
  executionAuthorityGranted: false;
  receipt: null;
  protocolRef: string;
  realizationRef: string;
  nextOperation: "OBSERVE_REGISTERED_UNIT" | "RECONCILE_UNKNOWN" | "NO_FURTHER_COLLECTION";
  ir: { version: "s2-collection-ir-v1"; tenantId: string; principalId: string; rightsRef: string; beliefPin: BeliefViewPin;
    mandateRef: ExperimentRef; candidate: ExperimentCandidate; remainingSamples: number; maximumExposure: string;
    maximumPrivacy: string; moneyLimit: ExperimentQuantity | null; expiry: string };
  requiredContracts: Array<{ owner: "S4" | "S5" | "S6" | "S7"; requirement: string }>;
  outcomeRegistration: { protocolRef: string; realizationRef: string; assignmentRefs: string[]; actualExposureRefs: string[];
    measurementRefs: string[]; analyzableRefs: string[]; deviationRefs: string[]; costRefs: string[]; creditGranted: false };
}
