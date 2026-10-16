import type { ExperimentRef } from './experiments';
import type { BeliefViewPin } from './enterprise-beliefs';
import type { AllocationEnvelope } from './allocation';
import type { EvidenceDependency, Phase2Envelope } from './evidence-execution';

/** Reduced signed numerator / positive denominator. Presentation is separate. */
export type AtlasRational = string;
export interface AtlasAffine { a: AtlasRational[]; b: AtlasRational }
export interface AtlasFacet { expression: AtlasAffine; relation: 'LE' | 'LT' | 'EQ' }
export interface AtlasParameter {
  id: string; unit: string; currency: string | null; owner: 'BUSINESS_OWNER' | 'S5';
  valueSource: 'AUTHENTICATED_OWNER_REVISION' | 'CURRENT_S5_AVAILABLE';
  resourceId: string | null; resourcePeriod: number | null;
  lower: AtlasRational; upper: AtlasRational;
}
export interface AtlasDomain { parameters: AtlasParameter[]; facets: AtlasFacet[] }
export interface AtlasMandate {
  ref: ExperimentRef; schema: 'finnor.economic-mandate.exact-affine.v1';
  tenantId: string; principalId: string; episodeId: string; rightsRef: string;
  knowledgeAt: string; validUntil: string; businessOwnerRef: ExperimentRef;
  utilityRef: ExperimentRef; accountingConventionRef: ExperimentRef;
  horizon: { startAt: string; periodMs: number; periods: number };
  quantityBasis: { unit: string; currency: string | null; ownershipRef: ExperimentRef;
    valuationAt: string; discountBasisRef: ExperimentRef };
  utility: { periodTerms: Array<{ variableId: string; unit: string; coefficient: AtlasRational; coefficientUnit: string }>;
    terminalTerms: Array<{ variableId: string; unit: string; coefficient: AtlasRational; coefficientUnit: string }>;
    discountFactors: AtlasRational[]; terminalLiability: AtlasRational };
  minimumUtility: AtlasRational; maxHumanSeconds: AtlasRational;
  dimensions: Array<{ id: string; unit: string; resourceClass: string;
    capacity: AtlasRational; totalLimit: AtlasRational; resourceId: string;
    component: 'TOTAL' | 'OCCUPANCY' }>;
  couplings: Array<{ id: string; weights: Record<string, AtlasRational>; maxPerPeriod: AtlasRational }>;
  funding: { costResourceId: string | null; liabilityResourceId: string | null; humanResourceId: string | null };
  ambiguity: 'ROBUST_FIXED_COMPLETE_WORLDS_NO_PROBABILITIES';
  authorization: 'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED';
}
export interface AtlasAction {
  id: string; kind: 'INQUIRE' | 'INTERVENE' | 'WAIT' | 'STOP';
  cost: AtlasAffine; costUnit: string; tailLiability: AtlasAffine; humanSeconds: AtlasAffine;
  resources: Record<string, AtlasAffine>; occupancy: Record<string, AtlasAffine>;
  exposures: Record<string, { unit: string; doses: AtlasAffine[] }>;
  occupationPeriods: number; earliestPeriod: number; lastPeriod: number; atMostOnce: boolean;
  protocolRef: ExperimentRef | null; informationDelayPeriods: number;
  precondition: { afterActionIds: string[]; observations: Array<{ instrumentId: string; tokens: string[] }> };
}
export interface AtlasObservation {
  instrumentId: string; token: string; availablePeriod: number;
}
export interface AtlasPolicyNode {
  id: string; period: number; actionId: string; actionHistory: string[];
  observations: AtlasObservation[]; children: string[];
}
export interface AtlasOriginalPolicy {
  id: string; ref: ExperimentRef; rootNodeId: string; actions: AtlasAction[]; nodes: AtlasPolicyNode[];
}
export interface AtlasWorld {
  id: string; mechanismRef: ExperimentRef; supportRef: ExperimentRef;
  paths: Array<{ policyId: string; nodeIds: string[]; states: Array<Record<string, AtlasAffine>> }>;
}
export interface AtlasHardPredicate extends AtlasFacet {
  id: string; policyId: string; worldId: string; period: number; unit: string;
  owner: 'S3' | 'S4' | 'S5' | 'BUSINESS_OWNER'; sourceRef: ExperimentRef;
}
/** Original supplied hypotheses, never decimal-printed fitted coefficients. */
export interface AffineFamilySource {
  schema: 'finnor.s3.affine-family-source.v1'; modelKey: string; familyKey: string;
  representation: 'SUPPLIED_COMPLETE_AFFINE_PATH_HYPOTHESIS';
  domain: AtlasDomain; mandate: AtlasMandate; stateUnits: Record<string, string>;
  policies: AtlasOriginalPolicy[]; worlds: AtlasWorld[]; hardPredicates: AtlasHardPredicate[];
  tieOrder: string[]; assumptions: string[]; qualification: 'MODEL_RELATIVE_EXACT_UNADMITTED';
  parameterValues: AtlasRational[];
}
export interface AtlasOwnerInput {
  source: AffineFamilySource; sourceRef: ExperimentRef; sourceBytesDigest: string;
  familyRef: ExperimentRef; modelRef: ExperimentRef; domainRef: ExperimentRef;
  work: { id: string; inputId: string; inputDigest: string };
  beliefPins: BeliefViewPin[]; dependencies: EvidenceDependency[]; rightsRevision: number;
  codeDigest: string; checkerDigest: string; schemaDigest: string;
}
export interface AtlasBuildBudget {
  maxNodes: number; maxDepth: number; maxFacets: number; maxBases: number;
  maxTotalBases: number; maxBytes: number; deadlineMs: number;
}
export type AtlasSplitReason =
  | { kind: 'CONSTRAINT'; policyId: string; constraintId: string }
  | { kind: 'WORLD'; policyId: string; leftWorldId: string; rightWorldId: string }
  | { kind: 'RANKING'; leftPolicyId: string; leftWorldId: string; rightPolicyId: string; rightWorldId: string };
export interface AtlasCellLabel {
  policies: Array<{ policyId: string; feasible: boolean; violatedConstraintId: string | null;
    worstWorldIds: string[]; bindingConstraintIds: string[] }>;
  winnerPolicyId: string | null; tiedPolicyIds: string[]; value: AtlasAffine | null;
  disposition: 'NAMED_FAMILY_OPTIMUM' | 'NAMED_FAMILY_INFEASIBLE';
}
export interface AtlasGeometry {
  basis: 'COMPLETE_BOUNDED_ACTIVE_BASIS_VERTICES_AND_COMMON_SLACK';
  vertices: AtlasRational[][]; witness: AtlasRational[]; slack: AtlasRational; affineDimension: number;
}
export type AtlasTreeNode =
  | { id: string; kind: 'SPLIT'; reason: AtlasSplitReason; expression: AtlasAffine; negative: string; zero: string; positive: string }
  | { id: string; kind: 'CELL'; geometry: AtlasGeometry; label: AtlasCellLabel }
  | { id: string; kind: 'EMPTY' }
  | { id: string; kind: 'GAP'; reason: string };
export interface AtlasProposal {
  schema: 'finnor.decision-atlas.proposal.v1'; inputDigest: string; checkerDigest: string;
  root: string; nodes: AtlasTreeNode[]; coverage: 'COMPLETE' | 'PARTIAL';
  boundaryRule: 'NEGATIVE_ZERO_POSITIVE_EXACT'; budget: AtlasBuildBudget;
  costs: { wallMs: number; bases: number; policyEvaluations: number; cells: number; gaps: number };
}
export interface AtlasCheckReceipt {
  schema: 'finnor.r7.original-input-check.v1'; status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  inputDigest: string; proposalDigest: string; checkerDigest: string;
  predicate: string; acceptedCellIds: string[]; gapIds: string[]; coverage: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
  wallMs: number; bases: number; independentOriginalReconstruction: true;
}
export interface AtlasPhysicalReceipt {
  invocationId: string; mode: 'BUILD' | 'CHECK' | 'FULL_FAMILY' | 'FULL_FAMILY_BATCH';
  pid: number | null; parentPid: number; wallMs: number; cpuMicros: number | null;
  peakRSSBytes: number | null; inputBytes: number; outputBytes: number;
  exitCode: number | null; signal: string | null; predicate: string | null;
  interpreterDigest: string; sourceDigest: string; leases: unknown[];
  money: null; costStatus: 'LOCAL_COST_UNMETERED';
}
export interface DecisionAtlas {
  schema: 'finnor.decision-atlas.v1'; ref: ExperimentRef;
  envelope: Omit<Phase2Envelope<
    { version: 'r7-exact-affine-v1'; digest: string; schemaDigest: string; checkerDigest: string },
    { kind: 'NAMED_FINITE_FAMILY_ATLAS'; admission: null },
    { entityScope: string[]; interface: 'r7-exact-affine-v1'; horizon: 'H1'; businessTruthCertified: false },
    'COMPLETE' | 'INCOMPLETE'
  >, 'mandate'> & {
    mandate: ExperimentRef; baseline: { commit: string; tree: string };
    ownerInputRefs: ExperimentRef[]; assumptions: string[]; grammar: 'NAMED_FAMILY_ONLY';
    checkBasis: AtlasCheckReceipt; claimGaps: string[]; lifecycleRefs: string[];
  };
  input: AtlasOwnerInput; proposal: AtlasProposal; check: AtlasCheckReceipt;
  physical: AtlasPhysicalReceipt[]; executionAuthorityGranted: false;
}
export interface AtlasProjectedChoice {
  schema: 'finnor.s4.exact-affine-choice.v1'; ref: ExperimentRef;
  familyRef: ExperimentRef; originalPolicyRef: ExperimentRef; policyId: string; nodeId: string;
  action: Omit<AtlasAction, 'cost' | 'tailLiability' | 'humanSeconds' | 'resources' | 'occupancy' | 'exposures'> & {
    cost: AtlasRational; tailLiability: AtlasRational; humanSeconds: AtlasRational;
    resources: Record<string, AtlasRational>; occupancy: Record<string, AtlasRational>;
    exposures: Record<string, { unit: string; doses: AtlasRational[] }>;
  };
  parameterRef: ExperimentRef; parameters: AtlasRational[]; robustValue: AtlasRational;
  tiedPolicyIds: string[]; worstWorldIds: string[]; exactDemand: AllocationEnvelope[];
  history: { period: number; actionHistory: string[]; observations: AtlasObservation[] };
  ownerChecks: { current: true; fullFamilyOptimizerInvoked: boolean };
  executionAuthorityGranted: false; protectedReceipt: null;
}
export type AtlasQueryDisposition = 'COVERED' | 'NAMED_FAMILY_INFEASIBLE' | 'GAP' | 'OUTSIDE_DOMAIN'
  | 'INVALIDATED' | 'UNSUPPORTED' | 'UNKNOWN' | 'FULL_FAMILY_CHECKED' | 'UNRESOLVED';
