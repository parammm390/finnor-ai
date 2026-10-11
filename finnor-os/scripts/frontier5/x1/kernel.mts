import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile, FrontierArtifactEnvelope, InstitutionProgram } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type InstitutionCandidate, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";

const load = <T,>(relative: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as T;
const original = load<OriginalInstitutionEvidence>("./reference/original-input.json");
const expected = load<{
  materialMappings: unknown[]; materialQuantities: unknown[]; supportedObligations: unknown[];
  contradictions: unknown[]; denominators: { materialMappings: number; materialQuantities: number; supportedObligations: number };
}>("./reference/expected-ledger.json");
const base = load<InstitutionCandidate>("./reference/base-candidate.json");
const cases = load<{ cases: { id: string; path: string | null; value?: unknown; expected: string }[] }>("./reference/challenges.json");
const profile = DigitalInstitutionProfile.parse(load<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));

assert.equal(expected.materialMappings.length, expected.denominators.materialMappings);
assert.equal(expected.materialQuantities.length, expected.denominators.materialQuantities);
assert.equal(expected.supportedObligations.length, expected.denominators.supportedObligations);
assert.equal(expected.contradictions.length, 1);
assert.deepEqual(base.mappings.map(({ sourceId, recordId, canonicalRef, registrationId }) => ({ sourceId, recordId, canonicalRef, registrationId })), expected.materialMappings);
assert.deepEqual(base.quantities.map(({ sourceId, recordId, canonicalRef, value, currency, unit, period, basis }) =>
  ({ sourceId, recordId, canonicalRef, value, currency, unit, period, basis })), expected.materialQuantities);
assert.deepEqual(base.obligations.map(({ trigger, subjectRef, ruleId, deadlineAt, principalId, operation }) =>
  ({ trigger, subjectRef, ruleId, deadlineAt, principalId, operation })), expected.supportedObligations);
assert.deepEqual(base.contradictions, expected.contradictions);

// Explicit 14/34-field schemas reject missing/extra fields and undocumented nulls.
const programFields = Object.keys(InstitutionProgram.shape), envelopeFields = Object.keys(FrontierArtifactEnvelope.shape);
assert.equal(programFields.length, 14);
assert.equal(envelopeFields.length, 34);
const unknown = { status: "unknown", reason: "No current owner receipt in development fixture",
  affectedRefs: ["work-readiness"], requiredOwnerOrInput: "canonical owner readback" };
const envelope: Record<string, unknown> = {};
for (const field of envelopeFields) envelope[field] = structuredClone(unknown);
Object.assign(envelope, {
  artifact_id: "art-1", kind: "institution-program", schema_revision: "institution-program-v1",
  content_digest: "sha256:development-only", parent_artifact_refs: [], source_refs: [],
  source_revision_vector: original.current.sourceRevisions, knowledge_cut: original.knowledgeCut,
  application_fingerprints: [], model_refs: [], observed_claims: [], inferred_claims: [], predicted_claims: [],
  unresolved_claims: [], postcondition_contract_refs: [], independent_check_refs: [], S6_obligation_refs: [],
  provider_observation_refs: [], invalidation_dependencies: [], lifecycle_state: "PROPOSED", lifecycle_events: [],
  build_learning_compute_cost_refs: [], attributable_human_work_refs: [],
});
const program: Record<string, unknown> = {};
for (const field of programFields) program[field] = structuredClone(unknown);
Object.assign(program, {
  envelope, inferred_source_mapping_refs: [], canonical_entity_and_relation_refs: [],
  temporal_and_unit_constraints: [], obligation_derivation_rules: [], unresolved_interpretations: [],
  s6_obligation_refs: [],
});
assert.equal(InstitutionProgram.safeParse(program).success, true);
for (const field of programFields) {
  const missing = structuredClone(program); delete missing[field];
  assert.equal(InstitutionProgram.safeParse(missing).success, false, `missing programme field ${field}`);
}
for (const field of envelopeFields) {
  const missing = structuredClone(program) as { envelope: Record<string, unknown> };
  delete missing.envelope[field];
  assert.equal(InstitutionProgram.safeParse(missing).success, false, `missing envelope field ${field}`);
}
assert.equal(InstitutionProgram.safeParse({ ...program, s4_programme_ref: null }).success, false);
assert.equal(InstitutionProgram.safeParse({ ...program, unrecognized: true }).success, false);

const results = [];
for (const fixture of cases.cases) {
  const candidate = structuredClone(base) as InstitutionCandidate;
  if (fixture.path) {
    const parts = fixture.path.split(".");
    let target: Record<string, unknown> = candidate as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = fixture.value;
  }
  const check = independentlyCheckInstitutionModel(original, candidate, profile);
  const observed = check.disposition === "REJECTED" ? check.guard : "ACCEPTED";
  results.push({ id: fixture.id, expected: fixture.expected, observed, check });
  assert.equal(observed, fixture.expected, `${fixture.id} reached ${observed} instead of ${fixture.expected}`);
  if (check.disposition === "ACCEPTED_DEVELOPMENT") {
    assert.equal(check.mappingDenominator, expected.denominators.materialMappings);
    assert.equal(check.obligationDenominator, expected.denominators.supportedObligations);
  }
}
console.log(JSON.stringify({ basis: "offline-development-only", programFields: programFields.length,
  envelopeFields: envelopeFields.length, independentDenominators: expected.denominators, results }));
