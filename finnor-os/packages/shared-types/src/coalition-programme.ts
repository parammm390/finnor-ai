import type { ExperimentRef } from "./experiments";
import type { R2Request } from "./robust-programme-search";
import type {EvidenceDependency} from "./evidence-execution";
import type {AllocationCheck,AllocationResource,AllocationOutstandingCommitment} from "./allocation";
import type {EconomicMandate} from "./contingent-control";

export const R5_VERSION = "r5-joint-coalition-rational-v1" as const;
export const R5_PROFILE = "EIGHT_PARTIES_FINITE_JOINT_GRAMMAR_OBSERVABLE_DIVISION" as const;
export type CoalitionRational = string;
export type CoalitionStatus = "COMPLETE" | "INCOMPLETE" | "INFEASIBLE" | "UNSUPPORTED" | "INVALIDATED" | "UNKNOWN";

export interface CoalitionParty {
  id: string;
  partyRef: ExperimentRef;
  rightsRef: ExperimentRef;
  outsideOptionRef: ExperimentRef;
  fundingRef: ExperimentRef;
  requiredConsentRef: ExperimentRef;
  /** Exact values on the common supplied world index, never inferred zeros. */
  outsideOptions: Record<string, CoalitionRational>;
  settledCash: Record<string, CoalitionRational[]>;
  ownerObjectiveWeight: CoalitionRational;
}

export type CoalitionAtom =
  | { kind: "CONSTANT" }
  | { kind: "TERM"; id: string }
  | { kind: "GRANT"; resourceId: string; date: number }
  | { kind: "MEMBER"; partyId: string }
  | { kind: "MEMBER_PAIR"; parties: [string, string] };
export type CoalitionFeature = CoalitionAtom | {
  kind: "PRODUCT";
  left: CoalitionAtom;
  right: CoalitionAtom;
};

export interface CoalitionEquation {
  itemId: string;
  ownerPartyId: string;
  /** Cash is a settled flow; residual assets/liabilities belong to terminal value. */
  kind: "CASH" | "RESIDUAL_ASSET" | "LIABILITY";
  unit: string;
  currency: string;
  date: number;
  terms: Array<{ coefficientId: string; feature: CoalitionFeature }>;
}

export interface CoalitionOperator {
  id: string;
  operationRef: ExperimentRef;
  modelRef: ExperimentRef;
  kind: "INTERVENE" | "WAIT" | "STOP";
  eligibleParties: string[];
  requiredParties: string[];
  minMembers: number;
  maxMembers: number;
  /** All admitted finite choices, not a producer's candidate shortlist. */
  termChoices: Array<Record<string, CoalitionRational>>;
  grantChoices: Array<Record<string, CoalitionRational[]>>;
  equations: CoalitionEquation[];
  costs: CoalitionEquation[];
  requiresAfter: string[];
  exclusiveItems: string[];
  consentRequired: string[];
}

export interface CoalitionWorld {
  id: string;
  coefficients: Record<string, CoalitionRational>;
  eventTokens: Record<string, string>;
}

export interface CoalitionEvent {
  id: string;
  eventRef: ExperimentRef;
  availableDate: number;
  tokens: string[];
}

export interface CoalitionTransferRule {
  eventId: string;
  token: string;
  date: number;
  operationRef: ExperimentRef;
  /** Positive pays the party; negative identifies its funding responsibility. */
  bounds: Record<string, [CoalitionRational, CoalitionRational]>;
}

export interface CoalitionProblem {
  schema: "finnor.r5.original.v1";
  version: typeof R5_VERSION;
  profile: typeof R5_PROFILE;
  parties: CoalitionParty[];
  worlds: CoalitionWorld[];
  dates: string[];
  unit: string;
  currency: string;
  valuationDate: string;
  discountFactors: CoalitionRational[];
  events: CoalitionEvent[];
  transfers: CoalitionTransferRule[];
  grammar: {
    ref: ExperimentRef;
    operators: CoalitionOperator[];
    maxSteps: number;
    admittedCoalitions: "ALL_ELIGIBLE_NONEMPTY_SUBSETS";
  };
  model: {
    ref: ExperimentRef;
    qualification: "SUPPLIED_FINITE_MODEL_UNADMITTED";
    noStrategicSpillover: "SUPPLIED_NO_CROSS_COALITION_SPILLOVER";
    omittedMechanisms: string[];
  };
  objective:
    | { kind: "ROBUST"; mandateRef: ExperimentRef }
    | { kind: "EXPECTED"; mandateRef: ExperimentRef; qualifiedLawRef: ExperimentRef; probabilities: Record<string, CoalitionRational> };
  resources: Array<{
    id: string;
    sourceRef: ExperimentRef;
    unit: string;
    /** Current original S5 availability, including retained commitments. */
    available: Record<string, CoalitionRational[]>;
    kind: "CUMULATIVE_EXPENDITURE" | "OCCUPANCY" | "FLOW";
  }>;
  obligationsRef: ExperimentRef;
  /** Explicit original S4 demand meaning. Its absence permits mathematical
   * component checking, never canonical owner clearance. */
  controlDemand?: {
    schema:"finnor.r5.control-demand.v1";
    dimensions:Array<{dimensionId:string;totalResourceId:string|null;occupancyResourceId:string|null}>;
    humanSecondsByOperator:Record<string,CoalitionRational>;
    staffing:"NO_EXISTING_EMPLOYMENT_OR_BENEFIT_CHANGE";
    terminalLiabilityResourceId:string|null;
  };
  canonicalAllocation?:CoalitionCanonicalAllocationBasis;
  owner: {
    tenantId: string;
    principalId: string;
    workId: string;
    workRevision: string;
    originalEpisodeId: string;
    originalBudgetGrantRef: ExperimentRef;
    originalDeadline: string;
    dependencies: Array<{ key: string; revision: number }>;
  };
  limits: {
    maxProgrammeOptions: number;
    maxEncodingBytes: number;
    native: R2Request["budget"];
  };
}

export interface CoalitionCanonicalAllocationBasis {
  schema:"finnor.r5.canonical-allocation-basis.v1";
  mandate:EconomicMandate;resources:AllocationResource[];
  outstanding:AllocationOutstandingCommitment[];
  snapshotDigest:string;knowledgeAt:string;
}

export interface CoalitionStep {
  operatorId: string;
  terms: Record<string, CoalitionRational>;
  grants: Record<string, CoalitionRational[]>;
}

export interface CoalitionProgrammeOption {
  id: string;
  members: string[];
  steps: CoalitionStep[];
  /** Reconstructed original item identities, never additional value credit. */
  itemIds: string[];
  exclusiveItems: string[];
  grossPayoffs: Record<string, Record<string, CoalitionRational>>;
  cashFlows: Record<string, Record<string, CoalitionRational[]>>;
  /** Gross original outgoing cash, before any modeled collection/netting. */
  cashOutflows: Record<string, Record<string, CoalitionRational[]>>;
  resourceUse: Record<string, CoalitionRational[]>;
  requiredConsents: string[];
}

export interface CoalitionDivision {
  eventId: string;
  token: string;
  date: number;
  operationRef: ExperimentRef;
  amounts: Record<string, CoalitionRational>;
}

export interface CoalitionCandidate {
  schema: "finnor.r5.candidate.v1";
  originalDigest: string;
  programmeOptions: CoalitionProgrammeOption[];
  selectedOptionIds: string[];
  division: CoalitionDivision[];
  objective: CoalitionRational;
  family: { complete: boolean; generatedOptions: number; unresolved: string[] };
  nativeBasis: {
    runtimeRef: ExperimentRef;
    originalEncodingDigest: string;
    modelSha256: string;
    proofSha256: string | null;
    viprRef: ExperimentRef | null;
    physicalRefs: ExperimentRef[];
  };
}

export interface CoalitionCheck {
  schema: "finnor.r5.independent-check.v1";
  originalDigest: string;
  candidateDigest: string;
  disposition: "ACCEPTED" | "REJECTED" | "INCOMPLETE";
  feasible: boolean;
  lower: CoalitionRational | null;
  upper: CoalitionRational | null;
  claims: string[];
  witnesses: Array<{ boundary: string; coordinate: string; observed: string; required: string }>;
  coverage: { parties: number; worlds: number; partitions: number | null; programmeOptions: number; transferVariables: number };
  provenance?: { runtimeRef: ExperimentRef; physicalRef: ExperimentRef; checkerIdentity: { path: string; sha256: string };
    nativeProofRefs: ExperimentRef[] };
}

export interface CoalitionProgramme {
  schema: "finnor.coalition-programme.v1";
  version: typeof R5_VERSION;
  ref: ExperimentRef;
  status: CoalitionStatus;
  originalRef: ExperimentRef;
  original: CoalitionProblem;
  candidate: CoalitionCandidate | null;
  checker: CoalitionCheck | null;
  nativeComponentRef?: ExperimentRef;
  lower: CoalitionRational | null;
  upper: CoalitionRational | null;
  gap: CoalitionRational | null;
  consents: Array<{
    partyId: string;
    proposalVersion: string;
    requirementRef: ExperimentRef;
    status: "PROPOSED" | "ACCEPTED" | "DECLINED" | "NO_RESPONSE" | "WITHDRAWN";
    evidenceRef: ExperimentRef | null;
  }>;
  owners: {
    s4SelectionRef: ExperimentRef | null;
    s5JointReservationRef: ExperimentRef | null;
    s6ProposedScheduleRef: ExperimentRef | null;
    p1ProgrammeRef: ExperimentRef | null;
  };
  unresolvedClaims: Array<{ claim: string; reason: string }>;
  lifecycle: Array<{ state: string; at: string; reason: string }>;
  executionAuthorityGranted: false;
  admission: { status: "UNQUALIFIED"; receipt: null };
  costs: { physicalRefs: ExperimentRef[]; cpuMs: number; aggregateSampledPeakBytes: number; money: null };
}

/** S4's ordinary exact model-relative choice. It is not a legacy FLOAT64
 * ContingentPolicy or an authorization to execute participant terms. */
export interface CoalitionSelection {
  schema: "finnor.s4.coalition-selection.v1"; version: typeof R5_VERSION; ref: ExperimentRef;
  tenantId: string; principalId: string; workId: string; workRevision: string;
  rightsRef:string; source:{sourceId:string;versionId:string;contentDigest:string};
  sourceRoot:{entityType:string;entityId:string}; dependencies:EvidenceDependency[];
  resourceSnapshotDigest:string; runtimeRef:ExperimentRef;
  original: CoalitionProblem; originalRef: ExperimentRef; candidate: CoalitionCandidate; checker: CoalitionCheck;
  incumbentPolicyRef: ExperimentRef; mandateRef: ExperimentRef; nativeComponentRef: ExperimentRef;
  selectedOptionIds: string[]; value: CoalitionRational; demandDigest: string;
  tie: { rule: string; originalCandidateDigest: string; checkerIdentity: {path:string;sha256:string}; physicalRef: ExperimentRef };
  validUntil: string; knowledgeAt: string; qualification: "EXACT_SUPPLIED_JOINT_MODEL_UNADMITTED";
  programmeExecutableQualified: false; executionAuthorityGranted: false; reservationGranted: false;
}

/** A versioned S5 adapter, not a legacy ContingentPolicy certificate. */
export interface CoalitionAllocationProblem {
  schema:"finnor.s5.coalition-allocation-problem.v1";ref:ExperimentRef;
  tenantId:string;principalId:string;selection:CoalitionSelection;mandate:EconomicMandate;
  resources:AllocationResource[];outstanding:AllocationOutstandingCommitment[];snapshotDigest:string;
}
export interface CoalitionAllocationCertificate {
  schema:"finnor.s5.coalition-allocation-certificate.v1";ref:ExperimentRef;
  tenantId:string;principalId:string;selectionRef:ExperimentRef;problemRef:ExperimentRef;
  mandateRef:ExperimentRef;rightsRef:string;snapshotDigest:string;validUntil:string;
  policyBindings:Array<{policyRef:ExperimentRef;demandDigest:string}>;
  check:AllocationCheck;qualification:"ORIGINAL_CANONICAL_POINT_NOT_CONSTRAINED_FAMILY_OPTIMUM";
  executionAuthorityGranted:false;protectedReceipt:null;
}

export interface CoalitionProposedSchedule {
  schema:"finnor.s6.coalition-proposed-schedule.v1";ref:ExperimentRef;
  tenantId:string;principalId:string;workId:string;workRevision:string;rightsRef:string;
  selectionRef:ExperimentRef;allocationRef:ExperimentRef;reservationRef:ExperimentRef;consumptionRef:ExperimentRef;
  proposalVersion:string;originalRef:ExperimentRef;candidateDigest:string;validUntil:string;
  selectedProgrammes:CoalitionProgrammeOption[];
  payments:Array<{event:CoalitionEvent;dateAt:string;division:CoalitionDivision;
    legs:Array<{partyId:string;targetRef:ExperimentRef;fundingRef:ExperimentRef;amount:CoalitionRational}>;
    proposedEffectIdentity:string;requiredObservation:"INDEPENDENT_CONTRACT_EVENT_AND_EXACT_PAYMENT_READBACK";
    admission:"PAYMENT_SIGNING_PROVIDER_OPERATION_UNADMITTED"}>;
  accounting:{unit:string;currency:string;valuationDate:string;discountFactors:CoalitionRational[]};
  requiredConsents:Array<{partyId:string;requirementRef:ExperimentRef;status:"PROPOSED";acceptanceObserved:false}>;
  status:"PROPOSED_UNADMITTED";executionAuthorityGranted:false;settlementEstablished:false;protectedReceipt:null;
}

export interface CoalitionP1Module {
  schema:"finnor.p1.coalition-owner-programme.v1";
  originalDigest:string;candidateDigest:string;selectionRef:ExperimentRef;
  programmes:CoalitionProgrammeOption[];division:CoalitionDivision[];
  stages:readonly ["READ_S4_SELECTION","RESERVE_SINGLE_S5","INTEND_SINGLE_S5_CONSUMPTION","PROPOSE_S6_SCHEDULE","STOP_UNADMITTED_EFFECT"];
  quantityEncoding:"ORIGINAL_CANONICAL_RATIONAL_STRINGS";
  qualification:"ORDINARY_SELECTED_OWNER_PLANNING_NOT_BUSINESS_EXECUTION";
  executionAuthorityGranted:false;
}
