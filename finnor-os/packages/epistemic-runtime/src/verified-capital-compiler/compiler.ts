import {
  canonicalSerialize, compileUnderwritingModel, deepFreeze, executeUnderwritingModel,
  sealInputSnapshot, semanticHash,
} from "../../../underwriting/src/index";
import type { ResolvedInput, UnderwritingInputSnapshot } from "../../../underwriting/src/types";
import { R6_PROFILE, R6_VERSION, type DecisionProof, type R6Disposition } from "../../../shared-types/src/decision-proof";
import type { ExperimentRef } from "../../../shared-types/src/experiments";
import type {
  R6CurrentDependencies, R6ProofPacket, R6ResolvedProblem, R6RunRequest, R6RunResponse,
} from "./contracts";
import { R6_LIMITS } from "./contracts";
import { checkDecisionProof } from "./checker";
import { assertR6NativeNumericPolicy } from "./native";

class R6Unsupported extends Error {
  constructor(readonly predicate: string, message: string) { super(message); }
}
function ref(id: string, digest: string): ExperimentRef {
  return { owner: "@finnor/epistemic-runtime", id, version: R6_VERSION, contentDigest: digest };
}

export function r6FixedInputMetadataDigest(snapshot: UnderwritingInputSnapshot): string {
  return semanticHash({
    schemaVersion: snapshot.schemaVersion, investmentCaseId: snapshot.investmentCaseId,
    worldAt: snapshot.worldAt,
    values: Object.fromEntries(Object.entries(snapshot.values).map(([id, input]) => {
      const { value: _quantity, ...fixedMetadata } = input;
      return [id, fixedMetadata];
    })),
  });
}

/** Builds a candidate, never a self-issued acceptance. The existing compiler
 * and executor supply the actual native artifacts and nonempty witness run. */
export function proposeDecisionProof(problem: R6ResolvedProblem, checkpoint?: () => void): R6ProofPacket {
  checkpoint?.();
  assertR6NativeNumericPolicy();
  for (const model of [problem.programme, problem.reference.model]) {
    if (model.periodDefinition.count > R6_LIMITS.horizon) {
      throw new R6Unsupported("HORIZON", "The original R6 horizon bound is twelve periods");
    }
    const specializedV2 = model.runtime?.kind === "standard_lbo_v1"
      && model.runtime.returnMethod === "decimal34_horner_npv_v2";
    if (model.runtime && !specializedV2) {
      throw new R6Unsupported("SPECIALIZED_RUNTIME",
        "Native standard_lbo_v1 schedules, tolerance/fixed-point/IRR/XIRR semantics lack an independently accepted all-input reference proof");
    }
    if (model.circularBlocks.length && !specializedV2) {
      throw new R6Unsupported("GENERIC_CIRCULAR_BLOCK",
        "Generic native execution does not implement the declared circular solver semantics; no all-input claim is made");
    }
  }
  const compiledProgramme = compileUnderwritingModel(problem.programme, checkpoint);
  const compiledReference = compileUnderwritingModel(problem.reference.model, checkpoint);
  const witness = sealInputSnapshot(problem.witness);
  const referenceValues: Record<string, ResolvedInput> = {};
  for (const input of problem.domain.inputs) {
    const value = witness.values[input.programmeNodeId];
    if (value) referenceValues[input.referenceNodeId] = { ...structuredClone(value), nodeId: input.referenceNodeId };
  }
  const referenceSnapshot = sealInputSnapshot({
    schemaVersion: "underwriting-input-snapshot.v1",
    investmentCaseId: witness.investmentCaseId, worldAt: witness.worldAt, values: referenceValues,
  });
  const nativeWitness = {
    programme: executeUnderwritingModel(compiledProgramme, witness),
    reference: executeUnderwritingModel(compiledReference, referenceSnapshot),
    referenceSnapshot,
  };
  const programmeByLedger = new Map(problem.programmeBindings.map(binding => [
    canonicalSerialize(binding.ledgerRef), binding,
  ]));
  const proof = {
    schema: "finnor.r6.translation-proof.v1" as const,
    rule: "ORDERED_NATIVE_TERM_CONGRUENCE_WITH_UNIVERSAL_VALIDITY" as const,
    programmeDigest: semanticHash(problem.programme),
    referenceDigest: semanticHash(problem.reference),
    domainDigest: semanticHash(problem.domain),
    bindingsDigest: semanticHash(problem.programmeBindings),
    compiledProgrammeDigest: semanticHash(compiledProgramme),
    compiledReferenceDigest: semanticHash(compiledReference),
    nativeIdentityDigest: semanticHash(problem.nativeIdentity),
    witnessDigest: semanticHash(witness),
    statements: problem.reference.stateInventory.map(state => ({
      ledgerRef: state.ledgerRef,
      programmeNodeId: programmeByLedger.get(canonicalSerialize(state.ledgerRef))?.nodeId ?? "",
      referenceNodeId: state.nodeId,
      rule: "CONGRUENCE" as const,
    })),
    axioms: [] as never[], unresolvedGoals: [] as never[],
    coverage: "EVERY_DECLARED_INPUT_EVERY_APPLICABLE_BRANCH" as const,
  };
  checkpoint?.();
  const packet: R6ProofPacket = {
    ...structuredClone(problem), schema: "finnor.r6.proof-packet.v1", witness,
    compiledProgramme, compiledReference, nativeWitness, proof,
  };
  if (Buffer.byteLength(canonicalSerialize(packet)) > R6_LIMITS.packetBytes) {
    throw new R6Unsupported("PACKET_BYTES", "The complete native proof packet exceeds the explicit byte bound; no truncation is permitted");
  }
  return deepFreeze(packet) as R6ProofPacket;
}

/** Hash only existing owner fields, not mutable display/receipt/lifecycle data.
 * At consumption these fields must be re-resolved by their actual owners. */
export function r6OwnerEnvelopeCommitmentsDigest(envelope: Pick<DecisionProof["envelope"],
  "work_ref" | "tenant_ref" | "baseline_manifest_ref" | "producer_ref" | "input_refs"
  | "domain_ref" | "assumptions_ref" | "programme_grammar_ref" | "budget_grant_ref">): string {
  return semanticHash({
    work_ref: envelope.work_ref, tenant_ref: envelope.tenant_ref,
    baseline_manifest_ref: envelope.baseline_manifest_ref, producer_ref: envelope.producer_ref,
    input_refs: envelope.input_refs, domain_ref: envelope.domain_ref,
    assumptions_ref: envelope.assumptions_ref, programme_grammar_ref: envelope.programme_grammar_ref,
    budget_grant_ref: envelope.budget_grant_ref,
  });
}

function currentVector(proof: Pick<DecisionProof, "envelope" | "proofObject">): R6CurrentDependencies {
  return {
    workRevision: proof.envelope.work_revision,
    ownerEnvelopeDigest: r6OwnerEnvelopeCommitmentsDigest(proof.envelope),
    programmeDigest: proof.proofObject.programmeDigest,
    bindingsDigest: proof.proofObject.bindingsDigest,
    referenceDigest: proof.proofObject.referenceDigest,
    domainDigest: proof.proofObject.domainDigest,
    nativeIdentityDigest: proof.proofObject.nativeIdentityDigest,
    dependencies: proof.envelope.invalidation_dependency_refs,
  };
}

/** Only compares independently owner-resolved current commitments. It does not
 * resolve rights, release grants, settle S6 obligations or issue admission. */
export function checkDecisionProofCurrentness(proof: DecisionProof, current: R6CurrentDependencies): {
  status: "CURRENT" | "INVALIDATED"; reason: string | null; certifiedLabelPermitted: false;
} {
  if (proof.currentnessDigest !== semanticHash(currentVector(proof))
    || proof.currentnessDigest !== semanticHash(current)) {
    return { status: "INVALIDATED", reason: "Exact Work/input/reference/domain/rights/method/checker dependency vector changed", certifiedLabelPermitted: false };
  }
  return { status: "CURRENT", reason: null, certifiedLabelPermitted: false };
}

/** Common producer entry point. This leaf has no approved-reference/checker
 * authority resolver, so it cannot turn development evidence into R6 COMPLETE.
 * The serial owner must separately implement the protected qualification seam. */
export async function runVerifiedCapitalCompiler(request: R6RunRequest): Promise<R6RunResponse> {
  const started = performance.now(), cpu = process.cpuUsage();
  const empty = (status: R6Disposition, reason: string): R6RunResponse => ({
    artifact_ref: null, status, incumbent_ref: null, unresolved_claim_refs: [request.problem_ref],
    resource_receipt_refs: request.envelope_inputs.resource_receipt_refs,
    proof: null, packet: null, receipt: null, reason,
  });
  if (request.existing_work_revision !== request.envelope_inputs.work_revision
    || canonicalSerialize(request.budget_grant_ref) !== canonicalSerialize(request.envelope_inputs.budget_grant_ref)
    || canonicalSerialize(request.domain_profile_ref) !== canonicalSerialize(request.problem.domain.ref)
    || request.envelope_inputs.producer_ref.code_digest !== request.problem.nativeIdentity.producerDigest
    || request.envelope_inputs.producer_ref.dependency_lock_digest !== request.problem.nativeIdentity.dependencyLockDigest
    || request.envelope_inputs.producer_ref.admission_ref !== null) {
    return empty("INVALIDATED", "Owner Work/grant/domain/code/lock commitments do not match the exact proposed proof");
  }
  const deadline = new Date(request.checker.deadlineAt).getTime();
  const checkpoint = (): void => {
    if (request.checker.signal?.aborted || !Number.isFinite(deadline) || Date.now() >= deadline) {
      throw new Error("Original deadline or cancellation prevents producer continuation");
    }
  };
  let packet: R6ProofPacket;
  try { packet = proposeDecisionProof(request.problem, checkpoint); }
  catch (error) {
    return empty(error instanceof R6Unsupported ? "UNSUPPORTED" : "UNKNOWN",
      error instanceof R6Unsupported ? `${error.predicate}: ${error.message}` : String(error));
  }
  const receipt = await checkDecisionProof(packet, request.checker);
  try { checkpoint(); }
  catch (error) {
    return { ...empty("UNKNOWN", String(error)), packet, receipt };
  }
  const status: R6Disposition = receipt.disposition === "UNSUPPORTED" ? "UNSUPPORTED"
    : receipt.disposition === "UNKNOWN" ? "UNKNOWN" : "INCOMPLETE";
  const certifiedGaps = [
    { kind: "REFERENCE_APPROVAL", reason: "No independently accepted current financial reference/interpretation receipt has been resolved", affected_claim_ids: ["R6_TRANSLATION"] },
    { kind: "CHECKER_ADMISSION", reason: "New native congruence/Fraction checker is ordinary development evidence; no independent protected checker qualification/admission is installed", affected_claim_ids: ["R6_TRANSLATION"] },
  ];
  if (receipt.disposition !== "ACCEPTED") certifiedGaps.push({
    kind: receipt.predicate, reason: receipt.reason ?? "Independent universal financial proof not accepted",
    affected_claim_ids: ["R6_TRANSLATION"],
  });
  const artifactDigest = semanticHash({ proof: packet.proof, receipt });
  const checkerRef = ref("r6-independent-check", semanticHash(receipt));
  const theoremRef = ref("r6-conditional-all-input-translation", semanticHash(packet.proof));
  const envelope: DecisionProof["envelope"] = {
    ...structuredClone(request.envelope_inputs),
    artifact_id: artifactDigest, artifact_kind: "DecisionProof",
    artifact_schema_revision: "finnor.decision-proof.v1",
    check_basis: receipt.disposition === "ACCEPTED" ? "MODEL_RELATIVE_EXACT" : "UNKNOWN",
    claims: receipt.disposition === "ACCEPTED" ? [{
      claim_id: "R6_TRANSLATION", statement_ref: theoremRef,
      domain_ref: request.problem.domain.ref, checker_receipt_ref: checkerRef,
    }] : [],
    gaps: certifiedGaps,
  };
  const usage = process.cpuUsage(cpu);
  const proof: DecisionProof = {
    schema: "finnor.decision-proof.v1", version: R6_VERSION,
    profile: R6_PROFILE, status, envelope, theoremRef,
    specificationRef: request.problem.reference.ref,
    programmeDigest: packet.proof.programmeDigest, inputDomainDigest: packet.proof.domainDigest,
    proofObject: packet.proof,
    nonemptyDomainWitness: { digest: packet.proof.witnessDigest, inputSnapshotDigest: packet.witness.semanticHash! },
    checkedInvariants: receipt.checkedInvariants,
    assumptionInventory: request.problem.reference.assumptions,
    independentCheckerReceipt: receipt, nativeIdentity: request.problem.nativeIdentity,
    excludedSemantics: [
      ...(request.problem.programme.runtime?.returnMethod === "decimal34_horner_npv_v2"
        ? ["Unrepaired v1 returns and specialized native parameter/domain configurations outside the checked v2 invariant profile"]
        : ["standard_lbo_v1 specialized schedules, fixed-point and IRR/XIRR all-input proof"]),
      "generic circular blocks, arbitrary arithmetic equivalence and unresolved interval predicates",
      "unmodeled floating-point, FX, tax, calendar or contractual behavior",
      "undeclared real-world cash/liabilities, legal/reference interpretation, source truth and causal adequacy",
      "policy optimality, S5 reservations, S6 authority/settlement, admission and economic returns",
    ],
    currentnessDigest: semanticHash(currentVector({ envelope, proofObject: packet.proof })),
    qualification: {
      referenceApproval: "NOT_ESTABLISHED", checkerAdmission: "NOT_ESTABLISHED",
      protectedGain: "NOT_RUN", economicRelease: "NOT_RUN", activation: "NOT_GRANTED",
    },
    executionAuthorityGranted: false, reservationGranted: false,
    resourceUsage: {
      elapsedMs: Math.round(performance.now() - started),
      producerCpuUserMicros: usage.user, producerCpuSystemMicros: usage.system,
      processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      checkerReceiptDigest: semanticHash(receipt),
      usd: null, humanSeconds: null, aggregateSimultaneousPeakBytes: null,
      moneyStatus: "UNMETERED", retentionStatus: "CALLER_OWNED_NOT_VERIFIED",
    },
  };
  return {
    artifact_ref: null, status, incumbent_ref: null,
    unresolved_claim_refs: certifiedGaps.map(gap => ref(gap.kind, semanticHash(gap))),
    resource_receipt_refs: envelope.resource_receipt_refs,
    proof: deepFreeze(proof) as DecisionProof, packet, receipt,
    reason: receipt.disposition === "ACCEPTED"
      ? "Conditional all-input mechanics accepted independently; reference/checker authority and serial owner integration remain open"
      : `${receipt.predicate}: ${receipt.reason ?? receipt.disposition}`,
  };
}
