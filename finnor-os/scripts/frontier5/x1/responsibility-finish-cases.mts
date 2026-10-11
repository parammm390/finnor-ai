import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type InstitutionCandidate, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { deriveInstitutionResponsibilities } from "../../../packages/private-equity/src/institution-program/responsibility";
import { buildInstitutionResourceDemand, planInstitutionDemandCharge } from "../../../packages/private-equity/src/institution-program/resource-demand";
import { parseHarnessRequest } from "../../../packages/private-equity/src/program-synthesis/contracts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const original = JSON.parse(read("./reference/original-input.json")) as OriginalInstitutionEvidence;
const candidate = JSON.parse(read("./reference/base-candidate.json")) as InstitutionCandidate;
const profile = DigitalInstitutionProfile.parse(JSON.parse(read("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json")));
const check = await independentlyCheckInstitutionModel(original, candidate, profile);
assert.equal(check.disposition, "ACCEPTED_DEVELOPMENT");
const lowered = deriveInstitutionResponsibilities({
  original, candidate, check, admittedCanonicalRefs: candidate.mappings.map(m => m.canonicalRef),
  authorizedOperations: original.current.authorizedOperations, profile,
});
const duty = lowered.responsibilities[0]!;
// The checked owner seal covers every persisted duty and unresolved liability.
// Neither an altered observer/derivation nor an omitted unresolved entry can
// keep a valid admission seal by merely recomputing the programme/demand hash.
assert.match((lowered.programme as typeof lowered.programme & {dutyPopulationDigest?:string}).dutyPopulationDigest ?? "",
  /^[a-f0-9]{64}$/, "checked lowering must seal its entire duty population");
const { verifyInstitutionDutyPopulation } = await import("../../../packages/private-equity/src/institution-program/responsibility");
const sealed = verifyInstitutionDutyPopulation(lowered.programme, lowered.responsibilities, lowered.unresolved);
assert.equal(sealed.length, 64);
// SQL jsonb and bounded Zod decoding may reorder object properties. They must
// preserve the admitted duty seal; semantic field mutations below must not.
const reorderedJson = (value: unknown): any => Array.isArray(value) ? value.map(reorderedJson)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorderedJson(item)])) : value;
const roundTrip = reorderedJson(lowered) as typeof lowered;
assert.doesNotThrow(() => verifyInstitutionDutyPopulation(roundTrip.programme,
  roundTrip.responsibilities, roundTrip.unresolved), "owner serialization must preserve the checked population seal");
for (const mutate of [
  (v: typeof lowered) => { v.responsibilities[0]!.obligation.independentObserver.ref = "wrong-observer"; },
  (v: typeof lowered) => { v.responsibilities[0]!.obligation.postcondition.contractRef = "wrong-postcondition"; },
  (v: typeof lowered) => { v.responsibilities[0]!.obligation.derivationRevision = "wrong-derivation"; },
]) {
  const changed = structuredClone(lowered);
  mutate(changed);
  assert.throws(() => verifyInstitutionDutyPopulation(
    changed.programme, changed.responsibilities, changed.unresolved,
  ), /X1_P1_CHECKED_DUTY_POPULATION_MISMATCH/);
}
const blocked = deriveInstitutionResponsibilities({
  original, candidate, check, admittedCanonicalRefs: candidate.mappings.map(m => m.canonicalRef),
  authorizedOperations: [], profile,
});
assert.ok(blocked.unresolved.length);
const omitted = structuredClone(blocked);
omitted.unresolved.pop();
assert.throws(() => verifyInstitutionDutyPopulation(
  omitted.programme, omitted.responsibilities, omitted.unresolved,
), /X1_P1_CHECKED_DUTY_POPULATION_MISMATCH/);
const demand = buildInstitutionResourceDemand({
  tenantId: original.tenantId, workId: original.workId, principalId: original.principalId,
  institutionId: original.institutionId, programmeDigest: "a".repeat(64),
  responsibilityIdentities: lowered.responsibilities.map(r => r.obligation.stableIdentity),
  computeRequests: 8, humanSeconds: 900, originalDeadline: duty.obligation.originalDeadline, profile,
});

// Observable: identical charge semantics replay regardless of JS insertion order.
// The old raw JSON.stringify preimage incorrectly produces REPLAY_CONFLICT.
const envelope = [{ resourceId: "compute-pool", kind: "CUMULATIVE_EXPENDITURE", unit: "request", quantities: ["8"] }];
const request = { responsibilityIdentity: duty.obligation.stableIdentity, phase: "EXECUTION" as const, ordinal: 1, units: 2 };
const first = planInstitutionDemandCharge({ demand, envelope, existingCharges: [], request });
assert.equal(first.status, "PLANNED");
if (first.status === "PLANNED") {
  const reordered = { units: 2, ordinal: 1, phase: "EXECUTION" as const, responsibilityIdentity: request.responsibilityIdentity };
  assert.deepEqual(planInstitutionDemandCharge({
    demand, envelope,
    existingCharges: [{ chargeKey: first.chargeKey, requestDigest: first.requestDigest, phase: "EXECUTION", ordinal: 1, units: 2, resourceId: first.resourceId, unit: first.unit }],
    request: reordered,
  }), { status: "REPLAY", chargeKey: first.chargeKey });
}

// Observable: the same independently checked duty can target each registered
// canonical entity; a Request-shaped observer would falsely reject two of them.
for (const [operation, entityType] of [["create_deal_request", "pe_request"], ["open_workstream", "pe_workstream"], ["record_finding", "pe_finding"]] as const) {
  const changed = structuredClone(original);
  changed.mandate.rules[0]!.operation = operation;
  changed.current.authorizedOperations = [...new Set([...changed.current.authorizedOperations, operation])];
  const proposed = structuredClone(candidate);
  proposed.dependencies.authorizedOperations = changed.current.authorizedOperations;
  proposed.obligations.forEach(obligation => { obligation.operation = operation; });
  const accepted = await independentlyCheckInstitutionModel(changed, proposed, profile);
  assert.equal(accepted.disposition, "ACCEPTED_DEVELOPMENT");
  const result = deriveInstitutionResponsibilities({ original: changed, candidate: proposed, check: accepted,
    admittedCanonicalRefs: proposed.mappings.map(m => m.canonicalRef), authorizedOperations: changed.current.authorizedOperations, profile });
  assert.equal(result.responsibilities[0]!.obligation.postcondition.structuralObserver.entityType, entityType);
}

// Existing native S5 relation grammar must store institution occupants, intents
// and charges under the same parent FK. Static boundary only; the live packet
// owns RLS-role and two-principal contention evidence.
const sql = read("../../../packages/db/migrations/0173_x1_institution_s5_reservations.sql");
assert.doesNotMatch(sql, /CREATE TABLE finnor_os\.s5_institution_(reservations|charges)/);
assert.match(sql, /INSERT INTO finnor_os\.s5_reservation_origins/);
assert.match(sql, /INSERT INTO finnor_os\.s5_consumptions/);
assert.match(sql, /SECURITY DEFINER/);
assert.match(sql, /s5_institution_occupancy/);
assert.match(sql, /REVOKE ALL ON FUNCTION/);
assert.match(sql, /s5_institution_owner_guard/);
assert.match(sql, /s5_institution_reservation_privacy/);
assert.match(sql, /s5_institution_state_guard/);
assert.match(sql, /s5_release_untouched_institution/);
assert.match(sql, /s5_invalidate_institution_resource/);
assert.match(sql, /FOR SHARE OF m/);
assert.match(sql, /FOR SHARE OF a/);
assert.match(sql, /jsonb_array_elements_text\(v_envelope->'quantities'\)/);
assert.match(sql, /v_envelope->'quantities'->>0 IS DISTINCT FROM v_line->>'quantity'/);
assert.doesNotMatch(sql, /GRANT SELECT,INSERT,UPDATE ON finnor_os\.s5_institution_/);

// P1 grammar must accept the checked institution variant without an
// analytical target, while a sparse duty stays blocked for missing payload.
const institution = {
  schema: "finnor.harness-request.v1", kind: "institution_responsibility_v1",
  instruction: "Maintain exact admitted duty", root: { entityType: "pe_deal", entityId: "00000000-0000-4000-8000-000000000001" },
  workId: "00000000-0000-4000-8000-000000000002", workInputId: "00000000-0000-4000-8000-000000000003",
  idempotencyKey: "x1-owner-case", validAt: "2026-10-11T00:00:00.000Z", mode: "ordinary_disposable",
  institution: { programme: lowered.programme, responsibilities: lowered.responsibilities,
    unresolved: lowered.unresolved, demand, reservationRef: { owner: "S5", id: "institution-reservation:abc", version: "s5-allocation-v1", contentDigest: "b".repeat(64) } },
};
const parsed = parseHarnessRequest(institution);
assert.equal(parsed.kind, "institution_responsibility_v1");
const store = read("../../../packages/private-equity/src/allocation-store.ts");
assert.match(store, /p\.demand IS NOT NULL[\s\S]*institutionState/);
assert.doesNotMatch(store, /institution-occupancy['"`]/);
assert.match(store, /readStoredAllocation[\s\S]*stored/);
console.log(JSON.stringify({ basis: "offline-development-only", cases: [
  "charge-semantic-replay", "three-operation-observer", "native-s5-grammar-owner-boundary", "p1-institution-request",
] }));
