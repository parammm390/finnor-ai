import type { BeliefViewPin } from './enterprise-beliefs';
import type { ContingentPolicy, EconomicMandate } from './contingent-control';
import type { ExperimentRef } from './experiments';

/** Canonical finite decimals; never a FLOAT64 feasibility tolerance. */
export type ResourceQuantity = string;
export type AllocationResourceClass = 'CASH' | 'BORROWING_HEADROOM' | 'COMMITTED_CAPITAL' | 'OPERATIONAL_CAPACITY' | 'HUMAN_ATTENTION' | 'COMPUTE' | 'INQUIRY_EXPOSURE' | 'COUNTERPARTY_EXPOSURE' | 'OTHER_RESTRICTED';
export type AllocationResourceKind = 'STOCK' | 'FLOW' | 'OCCUPANCY' | 'CUMULATIVE_EXPENDITURE' | 'EXPOSURE';
export interface AllocationCovenant {
  id: string; sourceRef: ExperimentRef; rightsRef: string; unit: string;
  terms: Array<{ resourceId: string; coefficient: ResourceQuantity; coefficientUnit: string }>;
  periods: number[]; maximum: ResourceQuantity; safetyMargin: ResourceQuantity;
  /** Prefix usage follows each named resource's canonical kind. */
  basis: 'CANONICAL_RESOURCE_USAGE';
}
export interface AllocationResourceInput {
  schema: 'finnor.allocation-resource.v1'; resourceId: string; tenantId: string;
  ownerRef: ExperimentRef; legalEntityRef: ExperimentRef; scopeRef: ExperimentRef;
  permittedRoots: Array<{entityType:string;entityId:string}>;
  rightsRef: string; unit: string; currency: string | null; kind: AllocationResourceKind; resourceClass: AllocationResourceClass;
  horizon: EconomicMandate['horizon']; sourceRef: ExperimentRef; asOf: string;
  knowledgeAt: string; validUntil: string; beliefPins: BeliefViewPin[];
  availability: Array<{ amount: ResourceQuantity | null; basis: 'REPORTED_AVAILABLE' | 'UNCERTAIN_PROCEEDS' | 'UNKNOWN' }>;
  existingUse: ResourceQuantity[]; safetyMargin: ResourceQuantity;
  covenants: AllocationCovenant[]; revoked: boolean;
  qualification: 'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED';
}
export interface AllocationResource extends AllocationResourceInput {
  ref: ExperimentRef; revision: number; priorRef: ExperimentRef | null;
}
export interface AllocationDemandBinding {
  policyRef: ExperimentRef; dimensionId: string; component: 'TOTAL' | 'OCCUPANCY'; resourceId: string;
  conversion: 'IDENTICAL_UNIT_NO_CONVERSION';
}
export interface AllocationPolicyFunding {
  policyRef: ExperimentRef;
  /** Additional explicit funding of S4 cost/tail/human quantities, never inferred. */
  actionCostResourceId: string | null; terminalLiabilityResourceId: string | null; humanSecondsResourceId: string | null;
}
export interface JointAllocationModel {
  schema: 'finnor.joint-allocation-model.v1'; ref: ExperimentRef;
  tenantId: string; principalId: string; mandateRef: ExperimentRef; rightsRef: string;
  sourceRefs: ExperimentRef[]; knowledgeAt: string; validUntil: string;
  qualification: 'SUPPLIED_JOINT_FINITE_SCENARIOS_UNADMITTED';
  ambiguity: 'FIXED_COMPLETE_JOINT_PATHS_NO_PROBABILITIES';
  completeness: 'ALL_MATERIAL_INTERFERENCE_AND_COMPATIBILITY_DECLARED';
  assumptions: string[]; omittedModelGap: 'UNKNOWN'; identificationGap: 'UNKNOWN';
  scenarios: Array<{ id: string; sharedMechanismRef: ExperimentRef;
    policyPaths: Array<{ policyRef: ExperimentRef; nodeIds: string[] }>;
    baseValue: ResourceQuantity;
    /** A term applies iff all its policy IDs are selected. Includes joint interactions. */
    terms: Array<{ policyIds: string[]; value: ResourceQuantity; evidenceRef: ExperimentRef }>;
  }>;
  /** Supplied interference/concentration choice constraints, in addition to registry covenants. */
  choiceConstraints: Array<{ id: string; policyIds: string[]; minimum: number; maximum: number; sourceRef: ExperimentRef }>;
}
export interface AllocationClearingInput {
  mandate: unknown; policyRefs: ExperimentRef[]; resourceRefs: ExperimentRef[];
  jointModel: unknown; demandBindings: AllocationDemandBinding[]; funding: AllocationPolicyFunding[];
  idempotencyKey: string;
}
export interface AllocationEnvelope {
  resourceId: string; unit: string; kind: AllocationResourceKind; horizon: EconomicMandate['horizon'];
  /** Raw per-period incremental quantities; STOCK/CUMULATIVE checks take prefixes. */
  quantities: ResourceQuantity[];
  /** Lower simultaneous usage envelope; negative covenant coefficients use it. */
  minimumQuantities: ResourceQuantity[];
}
export interface AllocationOutstandingCommitment {
  reservationRef: ExperimentRef; certificateRef: ExperimentRef; envelopes: AllocationEnvelope[];
  status: 'RESERVED' | 'CONSUMPTION_PENDING' | 'UNKNOWN_OUTCOME' | 'PARTIALLY_RECONCILED' | 'SETTLED_RETAINED';
  policyRefs: ExperimentRef[]; effectRefs: ExperimentRef[];
}
export interface CanonicalAllocationProblem {
  schema: 'finnor.allocation-problem.v1'; ref: ExperimentRef;
  tenantId: string; principalId: string; episodeId: string; mandate: EconomicMandate;
  policies: ContingentPolicy[]; resources: AllocationResource[]; jointModel: JointAllocationModel;
  demandBindings: AllocationDemandBinding[]; funding: AllocationPolicyFunding[];
  outstanding: AllocationOutstandingCommitment[]; snapshotDigest: string;
  knowledgeAt: string; validUntil: string; methodVersion: 's5-joint-finite-v1';
}
export type AllocationResultState = 'FEASIBLE' | 'INFEASIBLE' | 'UNCERTAINTY_UNRESOLVED' | 'STALE_INPUT' | 'SEARCH_EXHAUSTED' | 'SOLVER_UNAVAILABLE' | 'NUMERICAL_FAILURE' | 'BLOCKED_AUTHORITY' | 'INVALID_CANDIDATE' | 'LIMIT_EXCEEDED';
export interface AllocationCheck {
  schema: 'finnor.allocation-check.v1'; problemRef: ExperimentRef; selectedPolicyIds: string[];
  feasible: boolean; reasons: string[]; objective: ResourceQuantity | null;
  scenarioValues: Array<{ scenarioId: string; value: ResourceQuantity }>;
  envelopes: AllocationEnvelope[];
  witnesses: Array<{ constraintId: string; scenarioId: string; period: number; used: ResourceQuantity; maximum: ResourceQuantity; margin: ResourceQuantity }>;
  numericalSemantics: 'EXACT_DECIMAL_RATIONAL_ZERO_FEASIBILITY_TOLERANCE';
  executionAuthorityGranted: false;
}
export interface AllocationDualProposal {
  schema:'finnor.s5.dual-proposal.v1';
  multipliers:Array<{rowId:string;side:'upper'|'lower';value:string}>;
}
export interface AllocationLagrangianProof {
  schema:'finnor.s5.lagrangian-bound.v1';problemRef:ExperimentRef;proposal:AllocationDualProposal;
  exactUpper:{numerator:string;denominator:string};roundedUpper:string;
  qualification:'EXACT_RATIONAL_CANONICAL_BOX_BOUND_NOT_SCARCITY_PRICE';
}
export interface AllocationOptimizationCertificate {
  objectiveUnit: string; incumbent: ResourceQuantity; upperBound: ResourceQuantity;
  gapUpperBound: ResourceQuantity; normalization: ResourceQuantity; normalizedGapUpperBound: ResourceQuantity;
  strength: 'EXACT_COMPLETE_SUBSET_CHECK' | 'EXACT_ANALYTIC_RELAXATION_BOUND' | 'EXACT_CANONICAL_LAGRANGIAN_BOUND';
  boundProof?: AllocationLagrangianProof;
  boundProposalDisposition?:'CHECKED_ADOPTED'|'CHECKED_NOT_STRONGER'|'REJECTED_HINT_ANALYTIC_RETAINED'|'NOT_PROVIDED';
  checkedSubsets: number; completeSearch: boolean; searchTermination: string;
  solverUpperBoundEstimate: number | null; solverEstimateQualification: 'FLOAT64_NUMERICAL_NOT_INDEPENDENT_PROOF';
  uncertaintyGap: 'UNKNOWN'; identificationGap: 'UNKNOWN'; omittedModelGap: 'UNKNOWN'; fieldEconomicValue: 'UNKNOWN';
  opportunityCosts: Array<{ policyId: string; exclusionValue: ResourceQuantity | null; displacement: ResourceQuantity | null; basis: 'EXACT_SAME_MODEL_EXCLUSION' | 'UNKNOWN' }>;
}
export interface S5ComputeInvocation {
  schema: 'finnor.model-compute-invocation.v1'; semanticOwner: 'S5'; id: string;
  tenantId: string; principalId: string; rightsRef: string; inputRef: ExperimentRef; outputRefs: string[];
  requestedRoute: string; actualRoute: string; fallbacks: string[];
  backend: { name: string; version: string | null; pythonVersion: string | null; scipyVersion: string | null;
    numpyVersion: string | null; sourceDigests: Array<{ path: string; sha256: string }>; deterministicReplayClaimed: false };
  harness: {nodeVersion:string;platform:string;architecture:string;configuration:{domain:'s5-joint-finite-v1';decisionDeadlineMs:number;nodeLimit:number;threads:1;memoryCeilingBytes:number;memoryEnforcement:'STRUCTURAL_LIMITS_AND_MEASURED_USAGE_NO_CONTAINER_LIMIT'}};
  attempts: Array<{ startedAt: string; finishedAt: string; status: string }>;
  usage: { elapsedMs: number; cpuUserMicros: number; cpuSystemMicros: number; rssBeforeBytes: number; rssAfterBytes: number; backend: Record<string, unknown>; accountingScope: 'PROCESS_AND_CHILD_INTERVAL_NOT_CONTAINER_PEAK' };
  cost: { money: null; pricebookRef: null; status: 'LOCAL_COST_UNMETERED'; externalCalls: 0 };
  admission: { status: 'BLOCKED_EXTERNAL'; receipt: null };
}
export interface AllocationCertificate {
  schema: 'finnor.allocation-certificate.v1'; semanticOwner: 'S5'; version: 's5-joint-finite-v1'; ref: ExperimentRef;
  tenantId: string; principalId: string; episodeId: string; mandateRef: ExperimentRef; rightsRef: string;
  policyBindings: Array<{ policyRef: ExperimentRef; demandDigest: string }>;
  jointModelRef: ExperimentRef; resourceRefs: ExperimentRef[]; obligationsDigest: string; snapshotDigest: string;
  problemRef: ExperimentRef; validFrom: string; validUntil: string; check: AllocationCheck;
  optimization: AllocationOptimizationCertificate; compute: S5ComputeInvocation;
  status: 'PROPOSED_CHECKED';
  qualification: 'MODEL_RELATIVE_FINITE_JOINT_PATHS_ORDINARY_RESERVATION';
  admission: { executionAuthorityGranted: false; appendAuthorityGranted: false; protectedReceipt: null; methodAdmitted: false };
}
export interface AllocationReservation {
  schema: 'finnor.allocation-reservation.v1'; ref: ExperimentRef; certificateRef: ExperimentRef;
  tenantId: string; principalId: string; idempotencyKey: string; requestDigest: string;
  createdAt: string; envelopes: AllocationEnvelope[];
  status: 'RESERVED' | 'CONSUMPTION_PENDING' | 'UNKNOWN_OUTCOME' | 'PARTIALLY_RECONCILED' | 'SETTLED_RETAINED' | 'RELEASED';
  revocationReason: string | null; revision: number;
  executionAuthorityGranted: false; protectedReceipt: null;
}
export interface AllocationConsumption {
  schema: 'finnor.allocation-consumption.v1'; ref: ExperimentRef; reservationRef: ExperimentRef;
  certificateRef: ExperimentRef; policyRef: ExperimentRef; demandDigest: string; nodeId: string;
  decisionRef: ExperimentRef; idempotencyKey: string; requestDigest: string; createdAt: string;
  status: 'INTENDED_PENDING_S6' | 'UNKNOWN_OUTCOME' | 'RECONCILED';
  compatibleScenarioIds: string[]; effectRef: ExperimentRef | null; envelope: AllocationEnvelope[];
  executionAuthorityGranted: false; protectedReceipt: null;
}
export interface S5ExperienceEvent {
  schema: 'finnor.s5.experience.v1'; semanticOwner: 'S5'; eventId: string; episodeId: string;
  type: 'REQUEST' | 'CANDIDATE' | 'REFUSAL' | 'RESERVATION' | 'INVALIDATION' | 'REVISION' | 'CONSUMPTION' | 'RECONCILIATION' | 'RELEASE' | 'COST' | 'OVERRIDE';
  tenantId: string; principalId: string; rightsRef: string; revisionRef: string; contentDigest: string;
  knowledgeAt: string; validAt: string; preparedParentRefs: string[]; causalParents: [];
  dependencyRefs: string[]; horizon: 'H0' | 'H1'; uncertainty: 'MODEL_CONDITIONAL_UNADMITTED';
  detail: Record<string, unknown>; protectedReceipt: null; appendAuthorityGranted: false;
}
export interface AllocationClearingResult {
  schema: 'finnor.s5.clearing-result.v1'; status: AllocationResultState; reasons: string[];
  certificate: AllocationCertificate | null; reservation: AllocationReservation | null;
  experience: S5ExperienceEvent[]; compute: S5ComputeInvocation | null;
  decisionUsage?: {elapsedMs:number;deadlineMs:number;scope:'WHOLE_S5_OWNER_INCLUDING_RESOLUTION_CONTENTION_COMMIT'};
  executionAuthorityGranted: false; protectedReceipt: null;
}
