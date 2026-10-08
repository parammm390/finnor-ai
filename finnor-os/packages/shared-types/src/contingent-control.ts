import type { BeliefViewPin } from './enterprise-beliefs';
import type { ExperimentRef } from './experiments';
import type { InterventionSpecification } from './interventions';

export type PolicyResultState = 'POLICY_AVAILABLE' | 'INFEASIBLE' | 'MODEL_UNSUPPORTED' | 'UNCERTAINTY_UNRESOLVED' | 'SEARCH_EXHAUSTED' | 'BLOCKED_ALLOCATION' | 'BLOCKED_AUTHORITY' | 'STALE_INPUT' | 'NUMERICAL_FAILURE';
export interface EconomicMandate {
  schema: 'finnor.economic-mandate.v1'; ref: ExperimentRef;
  tenantId: string; principalId: string; episodeId: string; knowledgeAt: string; validUntil: string;
  businessOwnerRef: ExperimentRef; rightsRef: string; utilityRef: ExperimentRef;
  horizon: { startAt: string; periodMs: number; periods: number };
  utility: { unit: string; accountingConventionRef: ExperimentRef;
    periodTerms: Array<{ variableId: string; unit: string; coefficient: number }>;
    discountFactors: number[]; terminalTerms: Array<{ variableId: string; unit: string; coefficient: number }>;
    tail: { status: 'SUPPLIED_COMPLETE_FINITE_HORIZON'; terminalLiability: number; ref: ExperimentRef };
    /** Authenticated owner supplied finite utility, never a provider price. */
    deliberation?: { schema: 'finnor.s4.finite-deliberation-terms.v1'; scope: 'PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS';
      lossWithoutQualifiedResult: number; lossWithQualifiedResult: number; nativeAttemptCost: number;
      controllerMsCost: number; delayMsCost: number; unit: string;
      qualification: 'SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH' } };
  risk: { kind: 'HARD_WORST_PATH_UTILITY_FLOOR'; minimumUtility: number };
  ambiguity: { kind: 'ROBUST_FIXED_JOINT_SCENARIOS' | 'UNRESOLVED'; authorizationRef: ExperimentRef };
  resources: { dimensions: Array<{ id: string; unit: string; capacity: number; totalLimit: number; resourceClass?: import('./allocation').AllocationResourceClass }>;
    couplings: Array<{ id: string; weights: Record<string, number>; maxPerPeriod: number }> };
  search: { maxExpansions: number; deadlineMs: number; maxWorlds: number; maxPolicyNodes: number; maxHumanSeconds: number };
  scoring: { normalization: number; maxRegret: number };
  authorization: { basis: 'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED'; protectedReceipt: null };
}
export interface ControlObligation {
  ref: ExperimentRef; effectRef: ExperimentRef; actionId: string | null;
  status: 'KNOWN_PENDING' | 'UNKNOWN' | 'PARTIAL' | 'SETTLED';
  exposures: Record<string, number[]> | null; resources: Record<string, number> | null;
  occupancy: Record<string, number> | null;
  /** Only these channels replace baseline schedules. Unlocked schedules must
   * agree with the baseline. Resource demand is incremental to prefix usage. */
  lockedExposureIds: string[] | null;
  /** SETTLED releases resource/exposure occupation, not residual tail debt.
   * Unknown liability is null and withholds a justified continuation. */
  occupationUntilPeriod: number; terminalLiability: number | null;
}
/** S2 owns instrument meaning. This temporal coarsening does not assert IID or
 * calibrate an error distribution. Private state is not an observation. */
export interface ControlObservationInstrument {
  schema: 'finnor.s2.control-observation.v1'; id: string; sourceRef: ExperimentRef;
  variableId: string; unit: string; delayPeriods: number; afterActionIds: string[];
  bins: Array<{ category: string; lowerInclusive: number; upperExclusive: number }>;
  qualification: 'SUPPLIED_DETERMINISTIC_COARSENING_UNVERIFIED';
}
export interface ControlAction {
  id: string; kind: 'INQUIRE' | 'INTERVENE' | 'WAIT' | 'STOP'; cost: number; costUnit: string;
  resources: Record<string, number>; occupancy: Record<string, number>; occupationPeriods: number;
  tailLiability: number; earliestPeriod: number; lastPeriod: number; atMostOnce: boolean;
  exposures: Record<string, number[]>; protocolRef: ExperimentRef | null; informationDelayPeriods: number; humanSeconds: number;
  /** Conjunction over lawful, already available information, never private worlds. */
  precondition?: { afterActionIds: string[]; observations: Array<{ instrumentId: string; tokens: string[] }> };
}
export interface ControlProblem {
  schema: 'finnor.control-problem.v1'; id: string; episodeId: string; modelRef: ExperimentRef;
  context: string; regime: string; baselineExposures: Record<string, number[]>;
  actions: ControlAction[]; observations: ControlObservationInstrument[]; obligations: ControlObligation[]; validUntil: string;
  continuation?: { elapsedPeriods: number; actionHistory: string[];
    observations: Array<ControlObservation & { knowledgeAt: string; sourceRef: ExperimentRef }>;
    accruedUtility: { value: number; unit: string; sourceRef: ExperimentRef };
    usedResources: Record<string, number>; humanSeconds: number; accountingRef: ExperimentRef };
}
export interface ControlObservation { instrumentId: string; token: string; availablePeriod: number }
export interface ControlInstrumentSupport {
  protocolRef: ExperimentRef; tokensByMechanism: Record<string, string[]>;
  qualification: 'SUPPLIED_CONDITIONAL_UNCALIBRATED'; delayPeriods: number; completeCost: number; exposure: number;
}
/** Replaceable ordinary ModelComputeFabric adapter. Solver input contains
 * possible model worlds; selected policy inputs contain observable history only. */
export interface ControlWorld {
  id: string; mechanismId: string;
  history: Array<{ states: Record<string, number>; exposures: Record<string, number> }>;
  supported: boolean;
}
export interface ControlDynamicsAdapter {
  ref: ExperimentRef; stateUnits: Record<string, string>; stateRanges?: Record<string, [number, number]>; exposureIds: string[];
  qualification: 'S3_LEARNED_BOOTSTRAP_FINITE_SCENARIOS_UNADMITTED' | 'SUPPLIED_FINITE_REFERENCE_ONLY';
  initialWorlds: ControlWorld[]; advance: (world: ControlWorld, exposures: Record<string, number>, period: number) => ControlWorld;
  limitations: string[]; computeRefs?: string[];
}
export interface PolicyNode {
  id: string; period: number; actionHistory: string[]; observations: ControlObservation[]; actionId: string;
  valueBounds: [number, number]; branches: Array<{ observationKey: string; childId: string }>;
  alternatives: Array<{ actionId: string; status: PolicyResultState; valueBounds: [number, number] | null; reasons: string[] }>;
}
export interface ContingentResourceDemand {
  schema: 'finnor.contingent-resource-demand.v1'; semanticOwner: 'S4'; contentDigest: string;
  mandateRef: ExperimentRef; rightsRef: string; existingObligations: ControlObligation[];
  dimensions: EconomicMandate['resources']['dimensions']; couplings: EconomicMandate['resources']['couplings'];
  branches: Array<{ nodeId: string; parentNodeId: string | null; actionId: string; period: number;
    total: Record<string, number>; occupancy: Record<string, number>; occupationPeriods: number; mutuallyExclusiveSiblings: string[] }>;
  reservationGranted: false; portfolioFeasibilityEstablished: false;
}
export interface S4ExperienceEvent {
  schema: 'finnor.s4.experience.v1'; semanticOwner: 'S4'; eventId: string; episodeId: string;
  type: 'POLICY_SEARCH' | 'POLICY_REVISION' | 'BRANCH_CHOICE' | 'OBSERVATION' | 'INVALIDATION' | 'REJECTION' | 'OVERRIDE' | 'HANDOFF' | 'COMPUTE';
  tenantId: string; principalId: string; rightsRef: string; revisionRef: string; contentDigest: string;
  knowledgeAt: string; validAt: string; preparedParentRefs: string[]; causalParents: [];
  dependencyRefs: string[]; horizon: 'H1'; uncertainty: 'MODEL_CONDITIONAL_UNADMITTED';
  detail: Record<string, unknown>; protectedReceipt: null; appendAuthorityGranted: false;
}
export interface S4ComputeInvocation {
  schema: 'finnor.model-compute-invocation.v1'; semanticOwner: 'S4'; id: string;
  tenantId: string; principalId: string; rightsRef: string; inputRef: string; outputRefs: string[];
  requestedRoute: 'LOCAL_FIXED_SCENARIO_SEARCH'; actualRoute: 'LOCAL_FIXED_SCENARIO_SEARCH'; fallbacks: string[];
  backend: { name: 'finnor-nonanticipative-scenario-search'; version: 's4-finite-contingent-v1';
    sourceDigests: Array<{ path: string; sha256: string }>; nodeVersion: string; deterministicReplayClaimed: false };
  attempts: Array<{ startedAt: string; finishedAt: string; status: PolicyResultState }>;
  usage: { elapsedMs: number; cpuUserMicros: number; cpuSystemMicros: number; rssBeforeBytes: number; rssAfterBytes: number;
    expansions: number; transitionEvaluations: number; accountingScope: 'PROCESS_INTERVAL_INCLUSIVE_NOT_CONTAINER_PEAK' };
  cost: { money: null; pricebookRef: null; status: 'LOCAL_COST_UNMETERED'; externalCalls: 0 };
  upstreamComputeRefs: string[]; admission: { status: 'BLOCKED_EXTERNAL'; receipt: null };
}
export interface ContingentPolicy {
  schema: 'finnor.contingent-policy.v1'; semanticOwner: 'S4'; version: 's4-finite-contingent-v1'; ref: ExperimentRef;
  tenantId: string; principalId: string; episodeId: string; knowledgeAt: string; validUntil: string;
  mandateRef: ExperimentRef; mandate: EconomicMandate; problem: ControlProblem; priorPolicyRef: ExperimentRef | null; resultState: PolicyResultState;
  bindings: { modelRef: ExperimentRef; dynamicsRef: ExperimentRef; rightsRef: string; beliefPins: BeliefViewPin[];
    protocolRefs: ExperimentRef[]; inputArtifactRef: ExperimentRef | null; methodVersion: 's4-finite-contingent-v1'; obligationsDigest: string; allocationRefs: ExperimentRef[] };
  rootNodeId: string; nodes: PolicyNode[]; demand: ContingentResourceDemand;
  certificate: { basis: 'MODEL_RELATIVE_FINITE_ENUMERATION_FLOAT64'; ambiguity: 'FIXED_COMPLETE_SCENARIOS_NO_PROBABILITIES';
    valueBounds: [number, number]; optimalBounds: [number, number | null]; normalizedRegretBounds: [number, number | null]; completeSearch: boolean;
    finiteScenarioGapOnly: true; distributionAndIdentificationGap: 'UNKNOWN'; numericalTolerance: number;
    feasibleIncumbentChecked: boolean; worlds: number; riskSemantics: EconomicMandate['risk'] };
  compute: S4ComputeInvocation; limitations: string[];
  admission: { status: 'BLOCKED_EXTERNAL'; executionAuthorityGranted: false; appendAuthorityGranted: false; methodAdmitted: false; receipt: null };
}
export interface ControlDecisionInput {
  knowledgeAt: string; period: number; actionHistory: string[];
  observations: Array<ControlObservation & { knowledgeAt: string; sourceRef: ExperimentRef }>;
  rightsRef: string; obligations: ControlObligation[]; allocationRefs: ExperimentRef[];
}
export interface ControlDecision {
  schema: 'finnor.s4.branch-choice.v1'; ref: ExperimentRef; policyRef: ExperimentRef; status: PolicyResultState;
  nodeId: string | null; actionId: string | null; contextDigest: string; reasons: string[]; executionAuthorityGranted: false;
}
/** Resolved by the S5 owner, never issued by S4 or trusted from request JSON. */
export interface ResolvedPolicyAllocation {
  owner: 'S5'; ref: ExperimentRef; policyRef: ExperimentRef; mandateRef: ExperimentRef; demandDigest: string;
  rightsRef: string; validUntil: string; revoked: boolean;
}
export interface ContingentChoiceHandoff {
  schema: 'finnor.s4.choice-handoff.v1'; status: PolicyResultState; policyRef: ExperimentRef; decision: ControlDecision;
  allocationRef: ExperimentRef | null; demandDigest: string; intervention: InterventionSpecification | null;
  inquiryRef: ExperimentRef | null;
  interventionRef: ExperimentRef | null;
  /** Ordinary immutable S4 preparation, persisted before S5 intent; no receipt or authority. */
  preparationRef?: ExperimentRef | null;
  consumptionRef?: ExperimentRef | null;
  requiredContracts: Array<{ owner: 'BUSINESS_OWNER' | 'S5' | 'S6' | 'S7' | 'S8'; requirement: string }>;
  executionAuthorityGranted: false; effectRef: null; settlementRef: null; attributionGranted: false; protectedReceipt: null;
}
