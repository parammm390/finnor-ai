import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type InstitutionCandidate, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import {
  X1_RESPONSIBILITY_VERSION,
  deriveInstitutionResponsibilities,
  institutionObligationIdentity,
} from "../../../packages/private-equity/src/institution-program/responsibility";
import {
  buildInstitutionResourceDemand,
  planInstitutionDemandCharge,
} from "../../../packages/private-equity/src/institution-program/resource-demand";

const load = <T,>(relative: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as T;
const original = load<OriginalInstitutionEvidence>("./reference/original-input.json");
const base = load<InstitutionCandidate>("./reference/base-candidate.json");
const expected = load<{
  lowering: {
    responsibilities: {
      trigger: { witness: string; sourceId: string; recordId: string; occurredAt: string; availableAt: string };
      rule: { id: string; mandateId: string; mandateRevision: string; triggerKind: string };
      materiality: string; priorityRank: number; originalDeadline: string; responsiblePrincipal: string;
      permissibleOperationClass: string; subjectRef: string; preconditionStatus: string;
      postconditionContractRef: string; observerRef: string; observerEntityType: string; observerDealId: string;
      effectKind: string; status: string;
    }[];
    programme: { responsibilityCount: number; unresolvedCount: number; dependencyGraphNodes: number;
      dependencyGraphEdges: number; parentDeadline: string; status: string; qualification: string };
  };
  demand: { input: { computeRequests: number; humanSeconds: number };
    lines: { resourceClass: string; unit: string; quantity: string }[];
    qualification: string;
    envelopes: { resourceId: string; unit: string; kind: string; quantities: string[] }[] };
}>("./reference/responsibility-expectations.json");
const profile = DigitalInstitutionProfile.parse(load<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));

const results: { id: string; observed: string }[] = [];
const record = (id: string, observed: string) => { results.push({ id, observed }); };

const check = await independentlyCheckInstitutionModel(original, base, profile);
assert.equal(check.disposition, "ACCEPTED_DEVELOPMENT", "fixture must reach the accepted independent check");
const admitted = base.mappings.map((mapping) => mapping.canonicalRef);
const authorized = original.current.authorizedOperations;

// R1: the accepted two-obligation candidate lowers into exactly the frozen
// typed responsibilities with every obligation field bound.
const lowering = deriveInstitutionResponsibilities({
  original, candidate: base, check, admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
});
assert.equal(lowering.programme.schema, "finnor.x1.institution-responsibility-programme.v1");
assert.equal(lowering.programme.version, X1_RESPONSIBILITY_VERSION);
assert.equal(lowering.programme.semanticOwner, "S4_P1");
assert.equal(lowering.responsibilities.length, expected.lowering.programme.responsibilityCount);
assert.equal(lowering.unresolved.length, expected.lowering.programme.unresolvedCount);
assert.equal(lowering.programme.parentEnvelope.deadlineAt, expected.lowering.programme.parentDeadline);
assert.equal(lowering.programme.parentEnvelope.wallSeconds, profile.bounds.episodeWallSeconds);
assert.equal(lowering.programme.parentEnvelope.humanSeconds, profile.bounds.episodeHumanSeconds);
assert.equal(lowering.programme.parentEnvelope.source, "FROZEN_PROFILE_NOT_S5_FUNDING");
assert.equal(lowering.programme.status, expected.lowering.programme.status);
assert.equal(lowering.programme.qualification, expected.lowering.programme.qualification);
assert.equal(lowering.programme.executionAuthorityGranted, false);
assert.equal(lowering.programme.protectedReceipt, null);
assert.equal(lowering.programme.dependencyGraph.nodes.length, expected.lowering.programme.dependencyGraphNodes);
assert.equal(lowering.programme.dependencyGraph.edges.length, expected.lowering.programme.dependencyGraphEdges);
assert.equal(lowering.programme.admission.originalDigest, check.inputDigest);
assert.equal(lowering.programme.admission.candidateDigest, check.candidateDigest);
assert.equal(lowering.programme.admission.checkerDigest, check.checkerRevision);
const sorted = [...lowering.responsibilities].sort((a, b) => a.obligation.priority.rank - b.obligation.priority.rank);
expected.lowering.responsibilities.forEach((frozen, index) => {
  const actual = sorted[index]!;
  assert.deepEqual(actual.obligation.trigger, frozen.trigger);
  assert.deepEqual(actual.obligation.rule, frozen.rule);
  assert.equal(actual.obligation.materiality, frozen.materiality);
  assert.equal(actual.obligation.priority.rank, frozen.priorityRank);
  assert.equal(actual.obligation.originalDeadline, frozen.originalDeadline);
  assert.equal(actual.obligation.responsiblePrincipal, frozen.responsiblePrincipal);
  assert.equal(actual.obligation.permissibleOperationClass, frozen.permissibleOperationClass);
  assert.equal(actual.obligation.preconditions.length, 1);
  assert.equal(actual.obligation.preconditions[0]!.ref, frozen.subjectRef);
  assert.equal(actual.obligation.preconditions[0]!.status, frozen.preconditionStatus);
  assert.equal(actual.obligation.postcondition.contractRef, frozen.postconditionContractRef);
  assert.equal(actual.obligation.independentObserver.ref, frozen.observerRef);
  assert.equal(actual.obligation.postcondition.structuralObserver.entityType, frozen.observerEntityType);
  assert.equal(actual.obligation.postcondition.structuralObserver.dealId, frozen.observerDealId);
  assert.equal(actual.obligation.effectBinding.kind, frozen.effectKind);
  assert.equal(actual.status, frozen.status);
  assert.match(actual.obligation.stableIdentity, /^x1-obligation:[0-9a-f]{64}$/);
  assert.match(actual.obligation.derivationRevision, /^[0-9a-f]{64}$/);
  assert.equal(actual.executionAuthorityGranted, false);
  assert.equal(actual.protectedReceipt, null);
  assert.equal(actual.qualification, "TYPED_OWNER_PROGRESSION_NOT_NUMERIC_S4_NOT_S3_CAUSAL");
});
record("R1-full-obligation-binding", "LOWERED_2_TYPED_RESPONSIBILITIES");

// R2: determinism and identity preimage binding. Identical inputs give
// identical identities; changing any identity preimage field changes the
// stable identity; changing only a material derivation input keeps the
// identity but changes the derivation revision.
const again = deriveInstitutionResponsibilities({
  original, candidate: base, check, admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
});
assert.deepEqual(again, lowering);
const first = sorted[0]!.obligation;
const preimage = {
  tenantId: original.tenantId, institutionId: original.institutionId, mandateId: original.mandate.id,
  ruleId: first.rule.id, subjectRef: first.preconditions[0]!.ref,
  sourceId: first.trigger.sourceId, recordId: first.trigger.recordId,
  occurredAt: first.trigger.occurredAt,
};
assert.equal(institutionObligationIdentity(preimage), first.stableIdentity);
assert.notEqual(institutionObligationIdentity({ ...preimage, occurredAt: "2026-10-10T08:00:01.000Z" }), first.stableIdentity);
assert.notEqual(institutionObligationIdentity({ ...preimage, ruleId: "other-rule" }), first.stableIdentity);
const revisedInput = { ...original, current: { ...original.current, rightsRevision: "rights-2" } };
const revisedCandidate: InstitutionCandidate = { ...base, dependencies: { ...base.dependencies, rightsRevision: "rights-2" } };
const staleSourceCheck = await independentlyCheckInstitutionModel(revisedInput, revisedCandidate, profile);
assert.equal(staleSourceCheck.disposition, "REJECTED");
if (staleSourceCheck.disposition === "REJECTED") assert.equal(staleSourceCheck.guard, "SOURCE_AUTHORITY");
record("R2-stale-source-rights", "SOURCE_AUTHORITY");
// The positive cut has refreshed owner source bindings, not a caller's new
// current label over retained rights-1 bytes.
revisedInput.sources = original.sources.map((source) => ({ ...source, rightsRevision: "rights-2" }));
const revisedCheck = await independentlyCheckInstitutionModel(revisedInput, revisedCandidate, profile);
assert.equal(revisedCheck.disposition, "ACCEPTED_DEVELOPMENT");
const revised = deriveInstitutionResponsibilities({
  original: revisedInput, candidate: revisedCandidate, check: revisedCheck,
  admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
});
const revisedFirst = revised.responsibilities.find((r) => r.obligation.stableIdentity === first.stableIdentity);
assert.ok(revisedFirst, "identity survives a material derivation revision change");
assert.notEqual(revisedFirst!.obligation.derivationRevision, first.derivationRevision);
record("R2-stable-identity-and-derivation-revision", "IDENTITY_STABLE_REVISION_MATERIAL");

// R2b: accepted cuts are independent. The readable slash witness collides
// across cuts, but typed original source/object pairs must never join.
const paired = async (sourceId: string, recordId: string) => {
  const input = structuredClone(original);
  const source = input.sources.find((item) => item.id === "work-1")!;
  const rows = JSON.parse(source.rawUtf8) as { id: string }[];
  rows[0]!.id = recordId;
  source.id = sourceId;
  source.rawUtf8 = JSON.stringify(rows);
  source.coverage.expectedObjectIds[0] = recordId;
  source.coverage.readObjectIds[0] = recordId;
  delete input.current.sourceRevisions["work-1"];
  input.current.sourceRevisions[sourceId] = source.revision;
  const candidate = structuredClone(base);
  candidate.coverage[2] = sourceId;
  candidate.obligations[0]!.trigger = `${sourceId}/${recordId}`;
  candidate.obligations[0]!.sourceId = sourceId;
  candidate.obligations[0]!.recordId = recordId;
  candidate.obligations[1]!.trigger = `${sourceId}/request-B`;
  candidate.obligations[1]!.sourceId = sourceId;
  delete candidate.dependencies.sourceRevisions["work-1"];
  candidate.dependencies.sourceRevisions[sourceId] = source.revision;
  const accepted = await independentlyCheckInstitutionModel(input, candidate, profile);
  assert.equal(accepted.disposition, "ACCEPTED_DEVELOPMENT", `independent cut ${sourceId}/${recordId}`);
  const lowered = deriveInstitutionResponsibilities({
    original: input, candidate, check: accepted,
    admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
  });
  return lowered.responsibilities.find((r) => r.obligation.trigger.recordId === recordId)!.obligation;
};
const cutA = await paired("work-1", "branch/request-A");
const cutB = await paired("work-1/branch", "request-A");
assert.equal(cutA.trigger.witness, cutB.trigger.witness);
assert.notEqual(cutA.stableIdentity, cutB.stableIdentity);
assert.notEqual(cutA.derivationRevision, cutB.derivationRevision);
record("R2b-cross-cut-source-record-identity", "DISTINCT_STABLE_DUTIES_SAME_DISPLAY_WITNESS");

// R3: authority lost at lowering time never dispatches and never drops the
// obligation; it stays unresolved with the exact reason.
const noAuthority = deriveInstitutionResponsibilities({
  original, candidate: base, check, admittedCanonicalRefs: admitted, authorizedOperations: [], profile,
});
assert.equal(noAuthority.responsibilities.length, 0);
assert.equal(noAuthority.unresolved.length, 2);
assert.ok(noAuthority.unresolved.every((entry) => entry.reason === "X1_OPERATION_NOT_CURRENTLY_AUTHORIZED"));
record("R3-authority-lost-at-lowering", "BOTH_UNRESOLVED_NONE_DROPPED");

// R4: an unadmitted subject is not an established canonical fact; the other
// independent obligation still lowers.
const partial = deriveInstitutionResponsibilities({
  original, candidate: base, check, admittedCanonicalRefs: [admitted[0]!], authorizedOperations: authorized, profile,
});
assert.equal(partial.responsibilities.length, 1);
assert.equal(partial.responsibilities[0]!.obligation.preconditions[0]!.ref, admitted[0]);
assert.equal(partial.unresolved.length, 1);
assert.equal(partial.unresolved[0]!.reason, "X1_SUBJECT_NOT_ESTABLISHED_CANONICAL_FACT");
record("R4-unadmitted-subject-unresolved", "INDEPENDENT_OBLIGATION_STILL_LOWERED");

// R5: a deal-scoped ordinary operation on a non-deal subject is unsupported,
// not reinterpreted.
const fundSubject = structuredClone(base);
fundSubject.obligations[1]!.subjectRef = "pe_fund:fund-1@v1";
const fundCheck = await independentlyCheckInstitutionModel(original, fundSubject, profile);
// The independent checker must already refuse a subject outside its canonical
// denominator; if a future checker admits it, lowering must still refuse.
if (fundCheck.disposition === "ACCEPTED_DEVELOPMENT") {
  const lowered = deriveInstitutionResponsibilities({
    original, candidate: fundSubject, check: fundCheck,
    admittedCanonicalRefs: [...admitted, "pe_fund:fund-1@v1"], authorizedOperations: authorized, profile,
  });
  assert.equal(lowered.responsibilities.length, 1);
  assert.equal(lowered.unresolved[0]!.reason, "X1_OPERATION_SUBJECT_KIND_UNSUPPORTED");
  record("R5-non-deal-subject", "LOWERING_REFUSED_UNSUPPORTED_SUBJECT");
} else {
  assert.equal(fundCheck.disposition, "REJECTED");
  record("R5-non-deal-subject", `CHECKER_REFUSED_${fundCheck.guard}`);
}

// R6: duplicate trigger/rule obligations cannot mint two identities.
const duplicate = structuredClone(base);
duplicate.obligations.push(structuredClone(duplicate.obligations[0]!));
const duplicateCheck = await independentlyCheckInstitutionModel(original, duplicate, profile);
assert.equal(duplicateCheck.disposition, "REJECTED", "checker owns the first duplicate guard");
assert.equal(duplicateCheck.disposition === "REJECTED" ? duplicateCheck.guard : "", "OBLIGATION");
assert.throws(() => deriveInstitutionResponsibilities({
  original, candidate: duplicate, check: {
    disposition: "ACCEPTED_DEVELOPMENT", checkerRevision: original.current.checkerRevision,
    inputDigest: "0".repeat(64), candidateDigest: "1".repeat(64), profileDigest: "2".repeat(64),
    mappingDenominator: 2, obligationDenominator: 2, basis: "ORIGINAL_SOURCE_MODEL_RELATIVE",
  }, admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
}), (error: unknown) => String(error).includes("X1_"));
record("R6-duplicate-obligation", "CHECKER_REJECTS_AND_LOWERNING_REFUSES_FORGED_CHECK");

// R7: the accepted check must match these exact original/candidate/profile
// inputs; a foreign or forged acceptance cannot lower anything.
assert.throws(() => deriveInstitutionResponsibilities({
  original, candidate: base, check: {
    disposition: "ACCEPTED_DEVELOPMENT", checkerRevision: original.current.checkerRevision,
    inputDigest: "f".repeat(64), candidateDigest: check.disposition === "ACCEPTED_DEVELOPMENT" ? check.candidateDigest : "0".repeat(64),
    profileDigest: "2".repeat(64), mappingDenominator: 2, obligationDenominator: 2, basis: "ORIGINAL_SOURCE_MODEL_RELATIVE",
  }, admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
}), /X1_CHECK_NOT_ACCEPTED_FOR_CANDIDATE/);
assert.throws(() => deriveInstitutionResponsibilities({
  original, candidate: base, check: { disposition: "REJECTED", guard: "OMISSION", witness: "w", affectedRefs: [] },
  admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
}), /X1_CHECK_NOT_ACCEPTED_FOR_CANDIDATE/);
record("R7-forged-or-stale-check", "REFUSED");

// R8: derived obligations beyond the frozen profile bound refuse explicitly.
const overflow = structuredClone(base);
overflow.obligations = Array.from({ length: profile.bounds.derivedObligations + 1 }, (_, index) => ({
  ...structuredClone(base.obligations[0]!), trigger: `work-1/request-${index}`, subjectRef: admitted[index % 2]!,
}));
assert.throws(() => deriveInstitutionResponsibilities({
  original, candidate: overflow, check, admittedCanonicalRefs: admitted, authorizedOperations: authorized, profile,
}), /X1_DERIVED_OBLIGATION_BOUND/);
record("R8-obligation-bound", "EXPLICIT_OVERFLOW_REFUSAL");

// R9: typed demand is declared accounting, never funding. Building it needs no
// reservation; charging it without a bound current S5 envelope refuses.
const programmeDigest = "a".repeat(64);
const responsibilityIdentities = lowering.responsibilities.map((r) => r.obligation.stableIdentity);
const demand = buildInstitutionResourceDemand({
  tenantId: original.tenantId, workId: original.workId, principalId: original.principalId,
  institutionId: original.institutionId, programmeDigest, responsibilityIdentities,
  ...expected.demand.input, originalDeadline: expected.lowering.programme.parentDeadline, profile,
});
assert.equal(demand.schema, "finnor.x1.institution-resource-demand.v1");
assert.equal(demand.semanticOwner, "S5");
assert.equal(demand.qualification, expected.demand.qualification);
assert.equal(demand.parentReservationRef, null);
assert.equal(demand.originalDeadline, expected.lowering.programme.parentDeadline);
assert.deepEqual(demand.lines, expected.demand.lines);
assert.equal(demand.executionAuthorityGranted, false);
assert.match(demand.demandDigest, /^[0-9a-f]{64}$/);
const unfunded = planInstitutionDemandCharge({
  demand, envelope: null, existingCharges: [],
  request: { responsibilityIdentity: responsibilityIdentities[0]!, phase: "EXECUTION", ordinal: 1, units: 1 },
});
assert.deepEqual(unfunded, { status: "REFUSED", reason: "X1_DEMAND_UNFUNDED" });
record("R9-demand-is-not-funding", "X1_DEMAND_UNFUNDED");

// R10: stable original-parent charges share one cumulative envelope across
// EXECUTION/RECOVERY/HUMAN with exact accounting, replay and conflict rules.
const envelope = expected.demand.envelopes;
const charges: { chargeKey: string; requestDigest: string; phase: string; ordinal: number; units: number; resourceId: string; unit: string }[] = [];
const charge = (phase: "EXECUTION" | "RECOVERY" | "HUMAN", ordinal: number, units: number, identity = 0) =>
  planInstitutionDemandCharge({
    demand, envelope, existingCharges: charges,
    request: { responsibilityIdentity: responsibilityIdentities[identity]!, phase, ordinal, units },
  });
const c1 = charge("EXECUTION", 1, 4);
assert.equal(c1.status, "PLANNED");
if (c1.status === "PLANNED") {
  assert.equal(c1.resourceId, "compute-pool");
  assert.equal(c1.usedAfter, "4");
  assert.match(c1.chargeKey, /^x1-charge:[0-9a-f]{64}$/);
  charges.push({ chargeKey: c1.chargeKey, requestDigest: c1.requestDigest, phase: "EXECUTION", ordinal: 1, units: 4, resourceId: c1.resourceId, unit: c1.unit });
}
const c2 = charge("RECOVERY", 1, 2);
assert.equal(c2.status, "PLANNED");
if (c2.status === "PLANNED") {
  assert.equal(c2.usedAfter, "6", "recovery draws down the same original parent envelope");
  charges.push({ chargeKey: c2.chargeKey, requestDigest: c2.requestDigest, phase: "RECOVERY", ordinal: 1, units: 2, resourceId: c2.resourceId, unit: c2.unit });
}
const c3 = charge("HUMAN", 1, 900);
assert.equal(c3.status, "PLANNED");
if (c3.status === "PLANNED") assert.equal(c3.usedAfter, "900");
const exhausted = charge("EXECUTION", 2, 3);
assert.deepEqual(exhausted, { status: "REFUSED", reason: "X1_CHARGE_BUDGET_EXHAUSTED" });
const replay = charge("EXECUTION", 1, 4);
assert.deepEqual(replay, { status: "REPLAY", chargeKey: c1.status === "PLANNED" ? c1.chargeKey : "" });
const conflict = charge("EXECUTION", 1, 5);
assert.deepEqual(conflict, { status: "REFUSED", reason: "X1_CHARGE_REPLAY_CONFLICT" });
const humanOnCompute = planInstitutionDemandCharge({
  demand, envelope: envelope.filter((entry) => entry.resourceId === "compute-pool"), existingCharges: [],
  request: { responsibilityIdentity: responsibilityIdentities[0]!, phase: "HUMAN", ordinal: 1, units: 10 },
});
assert.deepEqual(humanOnCompute, { status: "REFUSED", reason: "X1_CHARGE_CLASS_UNFUNDED" });
const foreign = planInstitutionDemandCharge({
  demand, envelope, existingCharges: [],
  request: { responsibilityIdentity: "x1-obligation:" + "9".repeat(64), phase: "EXECUTION", ordinal: 1, units: 1 },
});
assert.deepEqual(foreign, { status: "REFUSED", reason: "X1_CHARGE_RESPONSIBILITY_FOREIGN" });
for (const [ordinal, units] of [[0, 1], [65, 1], [1, 0], [1, 100001]] as const) {
  const invalid = charge("EXECUTION", ordinal, units);
  assert.equal(invalid.status, "REFUSED");
  if (invalid.status === "REFUSED") assert.match(invalid.reason, /^X1_CHARGE_(PHASE_OR_ORDINAL|UNITS)_INVALID$/);
}
record("R10-original-parent-charges", "SHARED_CUMULATIVE_ENVELOPE_REPLAY_CONFLICT_EXHAUSTION");

// R11: the typed responsibility domain never imports numeric S4 synthesis or
// S3 causal qualification. This scans the module sources, not behavior the
// producer claims.
for (const modulePath of ["responsibility.ts", "resource-demand.ts"]) {
  const source = readFileSync(fileURLToPath(new URL(`../../../packages/private-equity/src/institution-program/${modulePath}`, import.meta.url)), "utf8");
  assert.ok(!/synthesizeContingentControl|enterprise-control|resolveEnterpriseInterventionModel/.test(source),
    `${modulePath} must not import numeric S4 control`);
  assert.ok(!/causal qualification|S3_ADMITTED/.test(source),
    `${modulePath} must not claim S3 causal qualification`);
}
record("R11-no-numeric-s4-no-s3-causal", "MODULE_BOUNDARY_HELD");

console.log(JSON.stringify({ basis: "offline-development-only", cases: results }));
