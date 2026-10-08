import type { BeliefOwnerRef, BeliefView, BeliefViewPin } from './enterprise-beliefs';
import type { ExperimentRef } from './experiments';

export interface InterventionRoot { entityType: string; entityId: string }
export type InterventionOperation = 'PRICE_CHANGE' | 'WORKING_CAPITAL' | 'SUPPLIER_SWITCH' | 'FINANCING_CHANGE' | 'DISCLOSURE';
export interface InterventionSpecification {
  schema: 'finnor.intervention-specification.v1';
  vocabularyVersion: 's3-intervention-v1';
  targets: InterventionRoot[];
  context: string;
  timing: { startAt: string; periodMs: number; durationMs: number };
  channels: Array<{ exposureId: string; operation: InterventionOperation; unit: string; target: InterventionRoot;
    doses: number[]; intendedExposure: 'REGISTERED_DOSE'; permittedRefinements: [] }>;
}
export interface InterventionSpecificationRef extends ExperimentRef { owner: 'S3'; version: 's3-intervention-v1' }
export type InterventionFeatureAtom = { kind: 'CONSTANT' } | { kind: 'STATE' | 'EXPOSURE'; id: string; lag: number };
export type InterventionFeature = InterventionFeatureAtom | { kind: 'PRODUCT'; left: InterventionFeatureAtom; right: InterventionFeatureAtom };
export type InterventionAssumptionCategory = 'SEQUENTIAL_EXCHANGEABILITY' | 'POSITIVITY' | 'CONSISTENCY' | 'MEASUREMENT' | 'SELECTION' | 'INTERFERENCE' | 'STATIONARITY' | 'FUNCTIONAL_FORM' | 'ACTOR_INFORMATION';
export interface InterventionAssumption {
  id: string; category: InterventionAssumptionCategory; status: 'DECLARED' | 'UNKNOWN' | 'CONTRADICTED';
  meaning: string; evidenceRefs: ExperimentRef[];
}
export interface InterventionMechanism {
  id: string; meaning: string; origin: 'SUPPLIED_HYPOTHESIS'; assumptions: InterventionAssumption[];
  equations: Array<{ variableId: string; features: InterventionFeature[] }>;
  counterparties: Array<{ variableId: string; actorRef: ExperimentRef; objectives: string[]; informationExposureIds: string[];
    constraints: string[]; responseAssumption: 'LEARNED_LAGGED_RESPONSE' | 'UNKNOWN' }>;
}
export interface InterventionFitRequest {
  schema: 'finnor.s3.fit-request.v1'; modelKey: string; episodeId: string; roots: InterventionRoot[];
  stateVariables: Array<{ id: string; root: InterventionRoot; seriesId: string; unit: string; range: [number, number]; role: 'ENTERPRISE_STATE' | 'COUNTERPARTY' }>;
  exposures: Array<{ id: string; root: InterventionRoot; seriesId: string; unit: string; operation: InterventionOperation;
    measurement: { status: 'MEASURED_ACTUAL' | 'INTENDED' | 'UNKNOWN'; methodRef: ExperimentRef; qualification: 'SUPPLIED_OWNER_MEASUREMENT_UNVERIFIED' } }>;
  time: { startAt: string; endAt: string; periodMs: number; trainingThrough: string };
  validity: { validUntil: string; maxBeliefAgeMs: number; regimes: string[]; contexts: string[]; maximumHorizon: number };
  measurementPolicy: { selection: 'COMPLETE_RECORDED_GRID_ASSUMED' | 'UNKNOWN'; missingness: 'NONE' | 'INFORMATIVE' | 'UNKNOWN'; instrumentError: 'ASSUMED_NEGLIGIBLE' | 'UNKNOWN' };
  mechanisms: InterventionMechanism[];
  numerical: { bootstrapDraws: number; blockLength: number; seed: number };
}
export interface InterventionHistoryRow {
  period: number; startAt: string; endAt: string;
  states: Record<string, number>; exposures: Record<string, number>;
  measurementRefs: BeliefOwnerRef[];
}
export interface InterventionFit {
  mechanismId: string; status: 'FITTED' | 'NUMERICAL_FAILURE'; reason: string | null;
  equations: Array<{ variableId: string; features: InterventionFeature[]; coefficients: number[]; rank: number; conditionNumber: number;
    trainingRmse: number; holdoutRmse: number; normalizedHoldoutRmse: number; holdoutMeanResidual: number }>;
  parameterDraws: number[][][];
  residuals: number[][];
  residualCovariance: number[][];
  refutations: Array<{ test: string; status: 'NOT_FALSIFIED' | 'FALSIFIED' | 'UNAVAILABLE'; value: number | null; threshold: number; reason: string }>;
  qualification: 'FITTED_CONDITIONAL_LAW_NOT_CAUSAL_PROOF';
}
export interface S3ModelComputeInvocation {
  schema: 'finnor.model-compute-invocation.v1'; id: string; semanticOwner: 'S3'; tenantId: string; principalId: string;
  rightsRefs: string[]; inputRef: string; outputRefs: string[];
  requestedRoute: 'LOCAL_TEMPORAL_NUMERICAL'; actualRoute: 'LOCAL_TEMPORAL_NUMERICAL' | 'UNAVAILABLE'; fallbacks: [];
  backend: { name: 'statsmodels-arch-scipy'; versions: Record<string, string>; sourceDigests: Array<{ path: string; sha256: string }>;
    identityBasis: 'LOADED_SOURCE_AND_INSTALLED_VERSIONS' | 'SOURCE_IDENTITY_UNAVAILABLE'; reproducibilityAttestation: null };
  model: { method: 's3-temporal-linear-v1'; capabilityAdmission: 'BLOCKED_EXTERNAL' };
  harness: { nodeVersion: string; pythonVersion: string | null; platform: string; architecture: string; configuration: Record<string, unknown>; deterministicReplayClaimed: false };
  attempts: Array<{ startedAt: string; finishedAt: string; status: 'COMPLETED' | 'FAILED' | 'REJECTED_BUSY'; reason: string | null }>;
  randomness: { used: true; seed: number };
  usage: { elapsedMs: number; parentCpuUserMicros: number; parentCpuSystemMicros: number; parentRssBeforeBytes: number; parentRssAfterBytes: number;
    childMaxRssBytes: number | null; childCpuUserSeconds: number | null; childCpuSystemSeconds: number | null;
    accountingScope: 'PARENT_INCLUSIVE_INTERVAL_CHILD_PROCESS_MAX_NOT_CONTAINER_PEAK' };
  cost: { money: null; pricebookRef: null; status: 'LOCAL_COST_UNMETERED'; externalCalls: 0 };
  admission: { status: 'BLOCKED_EXTERNAL'; receipt: null };
}
export interface S3ExperienceEvent {
  schema: 'finnor.s3.experience.v1'; eventId: string; episodeId: string; semanticOwner: 'S3';
  type: 'HYPOTHESIS' | 'IDENTIFICATION' | 'FIT' | 'MODEL_REVISION' | 'SIMULATION' | 'REFUTATION' | 'VALIDITY_CHANGE' | 'CORRECTION' | 'HUMAN_OVERRIDE' | 'REJECTION' | 'COMPUTE';
  tenantId: string; principalId: string; rightsRefs: string[]; preparedParentRefs: string[]; causalParents: [];
  revisionRef: string; contentDigest: string; validAt: string; knowledgeAt: string; dependencyRefs: string[]; freshnessRefs: string[];
  uncertainty: 'ASSUMPTION_CONDITIONAL_UNADMITTED_H1'; horizon: 'H1'; provenanceRefs: BeliefOwnerRef[];
  modelComputeRef: string | null; detail: Record<string, unknown>;
}
export interface InterventionModel {
  schema: 'finnor.intervention-model.v1'; semanticOwner: 'S3'; version: 's3-temporal-linear-v1'; ref: ExperimentRef;
  tenantId: string; principalId: string; knowledgeAt: string; request: InterventionFitRequest;
  beliefBindings: Array<{ viewRef: string; contentDigest: string; dependencyDigest: string; pin: BeliefViewPin; rightsRef: string;
    coverage: BeliefView['coverage']; selectedSeriesRefs: BeliefOwnerRef[]; selectedObservationRefs: BeliefOwnerRef[] }>;
  history: { periods: number; trainingPeriods: number; holdoutPeriods: number; inputDigest: string; rows: InterventionHistoryRow[];
    measurementQualification: 'OWNER_MEASUREMENTS_UNVERIFIED'; causalExposureVerification: 'UNKNOWN'; omittedRows: 0 };
  fits: InterventionFit[];
  compute: S3ModelComputeInvocation;
  uncertainty: { parameter: 'SYNCHRONIZED_MOVING_BLOCK_BOOTSTRAP_APPROXIMATE'; stochastic: 'JOINT_RESIDUAL_BLOCKS';
    mechanism: 'UNWEIGHTED_COMPETING_HYPOTHESES'; measurement: 'ASSUMPTION_CONDITIONAL'; identification: 'QUERY_SPECIFIC';
    transport: 'NO_AUTOMATIC_TRANSFER'; numerical: 'FLOAT64_MONTE_CARLO_NOT_EXACT' };
  admission: { status: 'BLOCKED_EXTERNAL'; methodAdmitted: false; receipt: null; appendAuthorityGranted: false; executionAuthorityGranted: false };
}
export interface InterventionFitBundle {
  schema: 'finnor.s3.fit-bundle.v1'; status: 'FITTED' | 'REJECTED' | 'FAILED'; model: InterventionModel | null;
  reasons: string[]; compute: S3ModelComputeInvocation | null; experience: S3ExperienceEvent[];
  admission: InterventionModel['admission'];
}
export interface InterventionResponseQuery {
  schema: 'finnor.s3.response-query.v1'; id: string; episodeId: string;
  kind: 'POPULATION_INTERVENTION' | 'OBSERVATIONAL_FORECAST' | 'UNIT_COUNTERFACTUAL';
  targets: InterventionRoot[]; context: string; regime: string; horizon: number;
  intervention: InterventionSpecification; comparator: InterventionSpecification; simulations: number; seed: number;
}
export interface InterventionIdentification {
  status: 'CONDITIONALLY_IDENTIFIED' | 'BOUNDED' | 'UNRESOLVED';
  estimand: 'POPULATION_INTERVENTIONAL_STATE_CONTRAST'; reasons: string[];
  method: 'SEQUENTIAL_G_FORMULA_UNDER_DECLARED_ASSUMPTIONS'; graphTruthEstablished: false; fieldIdentified: false;
  mechanismAssessments: Array<{ mechanismId: string; status: 'CONDITIONALLY_IDENTIFIED' | 'UNRESOLVED'; assumptionRefs: string[]; reasons: string[] }>;
}
export interface InterventionResponse {
  mechanismId: string; meaning: 'ASSUMPTION_CONDITIONAL_POPULATION_SIMULATION';
  periods: Array<{ period: number; stateMean: Record<string, number>; comparatorMean: Record<string, number>; effectMean: Record<string, number>;
    stateIntervals: Record<string, Record<string, [number, number]>>; effectParameterIntervals: Record<string, Record<string, [number, number]>>;
    stateCovariance: number[][]; unsupportedFraction: number; unsupportedMassUpper95: number;
    meanBounds: Record<string, [number, number]>; effectBounds: Record<string, [number, number]> }>;
  support: { basis: 'TRAINING_FEATURE_CONVEX_HULL'; failures: number; checks: number; monteCarloUncertainty: true;
    equations: Array<{ variableId: string; status: 'AVAILABLE' | 'UNAVAILABLE'; reason: string | null; affineRank: number }> };
  numerical: { arithmetic: 'FLOAT64'; simulations: number; approximation: 'DEPENDENT_BOOTSTRAP_AND_MONTE_CARLO'; errorCertificate: null; compoundingErrorQualified: false };
}
export interface InterventionResponseBundle {
  /** Resolves the query and both immutable schedules behind their commitments. */
  query: InterventionResponseQuery;
  schema: 'finnor.s3.response-bundle.v1'; ref: ExperimentRef; modelRef: ExperimentRef; queryRef: string;
  identification: InterventionIdentification; responses: InterventionResponse[]; compute: S3ModelComputeInvocation | null;
  lineage: { modelRef: ExperimentRef; interventionRef: InterventionSpecificationRef; comparatorRef: InterventionSpecificationRef;
    policyRef: null; allocationRef: null; authorityRef: null; effectRef: null; actualExposureRef: null; outcomeEstimandRef: null;
    attributionGranted: false; stages: ['MODELED'] | ['MODELED', 'SIMULATED'] };
  handoffs: { S2: { inquiryNeeds: string[]; iidLikelihoodGranted: false }; S4: { responseRef: string; executionAuthorityGranted: false };
    S5: { jointResponseRef: string; reservationGranted: false }; S7: { evidenceRef: string; creditGranted: false }; S8: { methodAdmission: 'BLOCKED_EXTERNAL' } };
  experience: S3ExperienceEvent[]; admission: InterventionModel['admission']; limitations: string[];
}
