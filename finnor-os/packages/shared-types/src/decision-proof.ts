import type { ExperimentRef } from "./experiments";
import type { ControlRational, R1ArtifactEnvelope } from "./certified-state-reduction";
import type { FinancialSemantics } from "./evidence-execution";

/** R6 is ordinary mechanical evidence. None of these references grants
 * reference approval, checker admission, reservation or execution authority. */
export const R6_VERSION = "r6-native-ir-congruence-v1" as const;
export const R6_PROFILE = "UNDERWRITING_MODEL_IR_V1_HORIZON_LE_12" as const;
export type R6Disposition =
  | "COMPLETE" | "INCOMPLETE" | "INFEASIBLE" | "UNSUPPORTED"
  | "INVALIDATED" | "UNKNOWN";

export interface R6SourcePin { path: string; sha256: string }
export type R6ScalarDomain =
  | { kind: "DECIMAL_LATTICE"; minimum: string; maximum: string; decimalPlaces: number }
  | { kind: "ENUMERATION"; values: Array<string | boolean> };

export interface R6InputDomain {
  schema: "finnor.r6.input-domain.v1";
  ref: ExperimentRef;
  /** D varies only quantities/allowed enum values. Native InvestmentCase,
   * truth status/class, provenance and as-of metadata are fixed to this exact
   * InputSnapshot metadata preimage, not silently assumed KNOWN. Tenant is
   * separately bound by the existing owner envelope; it is not a snapshot field. */
  fixedInputMetadataDigest: string;
  inputs: Array<{
    ownerRef: ExperimentRef;
    programmeNodeId: string;
    referenceNodeId: string;
    valueType: "decimal" | "date" | "boolean" | "text";
    unit: string;
    currency: string | null;
    shape: "scalar" | "series";
    components: Record<string, R6ScalarDomain>;
  }>;
}

/** A projection of existing owner state, not another financial IR or ledger. */
export type R6StateRole = "CASH" | "LIABILITY" | "CONSTRAINT" | "OBJECTIVE" | "TIMING";
export type R6Timing =
  | { kind: "AS_OF"; date: string }
  | { kind: "PERIOD_END" }
  | { kind: "NODE"; nodeId: string };
export interface R6ReferenceState {
  ledgerRef: ExperimentRef;
  role: R6StateRole;
  nodeId: string;
  timing: R6Timing;
  obligationRef: ExperimentRef | null;
  obligationStatus: "NOT_APPLICABLE" | "REPRESENTED" | "UNKNOWN";
  sourceClauseRefs: ExperimentRef[];
}
export interface R6ProgrammeState {
  ledgerRef: ExperimentRef;
  nodeId: string;
  timing: R6Timing;
}
export interface R6MoneyConvention {
  currency: string;
  semantics: FinancialSemantics;
  valuationDate: string;
  ownerShare: ControlRational;
  discountConventionRef: ExperimentRef;
  timeBasis: "EXACT_NATIVE_FINANCIAL_PERIODS";
}

export interface R6NativeIdentity {
  schema: "finnor.r6.native-semantics.v1";
  engineVersion: "finnor-underwriting-engine/1.0.0";
  irSchema: "underwriting-model-ir.v1";
  decimalPolicy: {
    precision: 34; rounding: "ROUND_HALF_EVEN";
    maxInputCharacters: 128; maxAbsoluteExponent: 100;
  };
  sourcePins: R6SourcePin[];
  dependencyLockDigest: string;
  decimalModuleDigest: string;
  decimalPackageVersion: string;
  checkerDigest: string;
  /** V2 independently loaded helpers are currentness dependencies too. */
  nativeReturnMethod?: "decimal34_horner_npv_v2";
  checkerDependencyPins?: R6SourcePin[];
  producerDigest: string;
}

export interface R6ProofObject {
  schema: "finnor.r6.translation-proof.v1";
  rule: "ORDERED_NATIVE_TERM_CONGRUENCE_WITH_UNIVERSAL_VALIDITY";
  programmeDigest: string;
  referenceDigest: string;
  domainDigest: string;
  bindingsDigest: string;
  compiledProgrammeDigest: string;
  compiledReferenceDigest: string;
  nativeIdentityDigest: string;
  witnessDigest: string;
  statements: Array<{
    ledgerRef: ExperimentRef;
    programmeNodeId: string;
    referenceNodeId: string;
    rule: "CONGRUENCE";
  }>;
  axioms: never[];
  unresolvedGoals: never[];
  coverage: "EVERY_DECLARED_INPUT_EVERY_APPLICABLE_BRANCH";
}

export interface R6CheckerReceipt {
  schema: "finnor.r6.independent-check.v1";
  disposition: "ACCEPTED" | "REJECTED" | "INCOMPLETE" | "UNSUPPORTED" | "UNKNOWN";
  predicate: string;
  reason: string | null;
  packetDigest: string;
  proofDigest: string;
  checkerDigest: string;
  nativeIdentityDigest: string;
  allInputEquivalence: boolean;
  universallyValid: boolean;
  nonemptyDomain: boolean;
  domainCardinality: string | null;
  checkedInvariants: string[];
  coverage: { nativeNodes: number; financialStates: number; periods: number; terms: number };
  witnessValues: Record<string, unknown> | null;
  witnessChecks: Array<{ nodeId: string; passed: boolean }>;
  basis: "INDEPENDENT_ORDERED_TERM_CONGRUENCE_EXACT_FRACTION_ENCLOSURES";
  qualification: "ORDINARY_DEVELOPMENT_EVIDENCE_NOT_ADMITTED";
  physical: {
    pid: number; parentPid: number; pythonVersion: string;
    executable: string; executableDigest: string; platform: string;
    elapsedMs: number; cpuUserMicros: number; cpuSystemMicros: number;
    maxRssNative: number; maxRssUnit: "PLATFORM_NATIVE";
    aggregateSimultaneousPeakKnown: false; usd: null;
  } | null;
}

/** Reuse the existing logical Work/artifact owner field contract. R6 changes
 * the family discriminants only; it does not fork tenant or dependency rules. */
export interface R6ArtifactEnvelope extends Omit<R1ArtifactEnvelope,
  "schema" | "artifact_kind" | "artifact_schema_revision"> {
  schema: "finnor.r6.artifact-envelope.v1";
  artifact_kind: "DecisionProof";
  artifact_schema_revision: "finnor.decision-proof.v1";
}

export interface DecisionProof {
  schema: "finnor.decision-proof.v1";
  version: typeof R6_VERSION;
  profile: typeof R6_PROFILE;
  status: R6Disposition;
  envelope: R6ArtifactEnvelope;
  theoremRef: ExperimentRef;
  specificationRef: ExperimentRef;
  programmeDigest: string;
  inputDomainDigest: string;
  proofObject: R6ProofObject;
  nonemptyDomainWitness: { digest: string; inputSnapshotDigest: string };
  checkedInvariants: string[];
  assumptionInventory: Array<{ ref: ExperimentRef; statement: string; qualification: "SUPPLIED_MODEL_RELATIVE" }>;
  independentCheckerReceipt: R6CheckerReceipt;
  nativeIdentity: R6NativeIdentity;
  excludedSemantics: string[];
  currentnessDigest: string;
  qualification: {
    referenceApproval: "NOT_ESTABLISHED";
    checkerAdmission: "NOT_ESTABLISHED";
    protectedGain: "NOT_RUN";
    economicRelease: "NOT_RUN";
    activation: "NOT_GRANTED";
  };
  executionAuthorityGranted: false;
  reservationGranted: false;
  resourceUsage: {
    elapsedMs: number; producerCpuUserMicros: number; producerCpuSystemMicros: number;
    processMaxRssBytes: number; checkerReceiptDigest: string;
    usd: null; humanSeconds: null; aggregateSimultaneousPeakBytes: null;
    moneyStatus: "UNMETERED"; retentionStatus: "CALLER_OWNED_NOT_VERIFIED";
  };
}
