import type {
  CompiledUnderwritingModel, UnderwritingInputSnapshot, UnderwritingModelIR,
  UnderwritingRunResult,
} from "../../../underwriting/src/types";
import type { ExperimentRef } from "../../../shared-types/src/experiments";
import type {
  DecisionProof, R6ArtifactEnvelope, R6CheckerReceipt, R6Disposition,
  R6InputDomain, R6MoneyConvention, R6NativeIdentity, R6ProgrammeState,
  R6ProofObject, R6ReferenceState,
} from "../../../shared-types/src/decision-proof";

export const R6_LIMITS = Object.freeze({
  horizon: 12,
  packetBytes: 8 * 1024 * 1024,
  proofTerms: 250_000,
  checkerWallMs: 30_000,
});

export interface R6ReferenceSpecification {
  schema: "finnor.r6.reference-specification.v1";
  ref: ExperimentRef;
  /** Exactly the existing executable underwriting IR, not a second IR. */
  model: UnderwritingModelIR;
  stateInventory: R6ReferenceState[];
  inventoryBasis: "ALL_DECLARED_REFERENCE_ITEMS_NOT_ALL_REAL_WORLD_OBLIGATIONS";
  moneyConventions: R6MoneyConvention[];
  assumptions: DecisionProof["assumptionInventory"];
  approval: null;
}

export interface R6ResolvedProblem {
  programme: UnderwritingModelIR;
  reference: R6ReferenceSpecification;
  domain: R6InputDomain;
  programmeBindings: R6ProgrammeState[];
  witness: UnderwritingInputSnapshot;
  nativeIdentity: R6NativeIdentity;
}

export interface R6ProofPacket extends R6ResolvedProblem {
  schema: "finnor.r6.proof-packet.v1";
  compiledProgramme: CompiledUnderwritingModel;
  compiledReference: CompiledUnderwritingModel;
  nativeWitness: {
    programme: UnderwritingRunResult;
    reference: UnderwritingRunResult;
    referenceSnapshot: UnderwritingInputSnapshot;
  };
  proof: R6ProofObject;
}

export interface R6CheckerOptions {
  repositoryRoot: string;
  pythonExecutable: string;
  decimalModulePath: string;
  /** One absolute original owner deadline; never restarted for checking. */
  deadlineAt: string;
  signal?: AbortSignal;
  /** Owner process metering/fault observer, never a checker implementation. */
  onChildStarted?: (pid: number) => void;
  /** Full raw process transcript goes to the caller's retained evidence. */
  retainTranscript?: (transcript: R6CheckerTranscript) => void | Promise<void>;
}

export interface R6CheckerTranscript {
  packetDigest: string;
  command: string[];
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  disposition: R6CheckerReceipt["disposition"];
}

export interface R6RunRequest {
  envelope_inputs: Omit<R6ArtifactEnvelope,
    "artifact_id" | "artifact_kind" | "artifact_schema_revision" | "claims" | "gaps" | "check_basis">;
  problem_ref: ExperimentRef;
  existing_work_revision: string;
  domain_profile_ref: ExperimentRef;
  budget_grant_ref: ExperimentRef;
  cancellation_ref: ExperimentRef;
  problem: R6ResolvedProblem;
  checker: R6CheckerOptions;
}
export interface R6RunResponse {
  artifact_ref: null;
  status: R6Disposition;
  incumbent_ref: null;
  unresolved_claim_refs: ExperimentRef[];
  resource_receipt_refs: ExperimentRef[];
  proof: DecisionProof | null;
  packet: R6ProofPacket | null;
  receipt: R6CheckerReceipt | null;
  reason: string | null;
}

export interface R6CurrentDependencies {
  workRevision: string;
  ownerEnvelopeDigest: string;
  programmeDigest: string;
  bindingsDigest: string;
  referenceDigest: string;
  domainDigest: string;
  nativeIdentityDigest: string;
  dependencies: R6ArtifactEnvelope["invalidation_dependency_refs"];
}

export interface R6DomainMembership {
  status: "INSIDE_DECLARED_DOMAIN" | "OUTSIDE_DECLARED_DOMAIN" | "UNKNOWN";
  reason: string | null;
  inputSnapshotDigest: string | null;
  domainDigest: string;
  certifiedLabelPermitted: false;
}
