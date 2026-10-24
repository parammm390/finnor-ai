/** Failure-first isolated contracts. These literals are not authenticated Work. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = import.meta.dirname;
const output = resolve(process.env.FINNOR_Z0_EVIDENCE_DIR
    ?? resolve(root, "observed"));
const source = resolve(root, "runtime/semantics.mjs");
const cases = [];
const add = (id, expected, run) => cases.push({ id, expected, run });
const workId = "11111111-1111-4111-8111-111111111111";
const inputId = "22222222-2222-4222-8222-222222222222";
const programmeId = "33333333-3333-4333-8333-333333333333";
const foreign = "44444444-4444-4444-8444-444444444444";
const queries = [
    { intent: "harness_program_v1", workId, programId: programmeId },
    { intent: "economic_programme_v1", workId, programmeId },
    { intent: "confidential_economic_computation_v1", workId },
];
for (const request of queries)
    add(`original-input:${request.intent}`, "same original input", api => assert.deepEqual(api.nativeObservationRequest(request, { workId, workInputId: inputId }), { request, workId, workInputId: inputId }));
add("missing-semantic-work", "refused", api => assert.throws(() => api.nativeObservationRequest({ intent: "confidential_economic_computation_v1" }, { workId })));
add("missing-envelope-work", "refused", api => assert.throws(() => api.nativeObservationRequest(queries[0], {})));
add("conflicting-envelope-work", "refused", api => assert.throws(() => api.nativeObservationRequest(queries[0], { workId: foreign })));
add("malformed-work", "refused", api => assert.throws(() => api.nativeObservationRequest({ ...queries[0], workId: "not-a-uuid" }, { workId: "not-a-uuid" })));
add("extra-tenant-selector", "refused", api => assert.throws(() => api.nativeObservationRequest({ ...queries[0], tenantId: foreign }, { workId })));
add("extra-steering-envelope", "refused", api => assert.throws(() => api.nativeObservationRequest(queries[0], { workId, instruction: "complete Work" })));
add("non-native-query", "refused", api => assert.throws(() => api.nativeObservationRequest({ intent: "work_list" }, { workId })));
const envelope = [
    { resourceId: "compute", unit: "request", quantities: ["520", "0"] },
    { resourceId: "human", unit: "seconds", quantities: ["900", "0"] },
];
const charges = [
    { resourceId: "compute", unit: "request", units: "27" },
    { resourceId: "compute", unit: "request", units: "6" },
    { resourceId: "human", unit: "seconds", units: "4" },
];
add("sum-original-and-child-charges", "520 - 27 - 6 = 487, child ceiling 200", api => assert.deepEqual(api.remainingInstitutionBudget(envelope, charges, [{ resourceId: "compute", unit: "request", amount: "200" }]), [{ resourceId: "compute", unit: "request", limit: "520", used: "33", remaining: "487", ceiling: "200" }]));
add("no-new-parent-budget", "488 > 487 refused", api => assert.throws(() => api.remainingInstitutionBudget(envelope, charges, [{ resourceId: "compute", unit: "request", amount: "488" }])));
add("duplicate-demand", "refused", api => assert.throws(() => api.remainingInstitutionBudget(envelope, charges, [{ resourceId: "compute", unit: "request", amount: "1" }, { resourceId: "compute", unit: "request", amount: "1" }])));
add("unit-reinterpretation", "refused", api => assert.throws(() => api.remainingInstitutionBudget(envelope, charges, [{ resourceId: "compute", unit: "seconds", amount: "1" }])));
add("fractional-requests", "refused", api => assert.throws(() => api.remainingInstitutionBudget(envelope, charges, [{ resourceId: "compute", unit: "request", amount: "1.5" }])));
add("unknown-charge-amount", "refused, not zero", api => assert.throws(() => api.remainingInstitutionBudget(envelope, [{ resourceId: "compute", unit: "request", units: null }], [{ resourceId: "compute", unit: "request", amount: "1" }])));
add("original-overdrawn", "refused", api => assert.throws(() => api.remainingInstitutionBudget(envelope, [{ resourceId: "compute", unit: "request", units: "521" }], [{ resourceId: "compute", unit: "request", amount: "1" }])));
const deadline = {
    requestedDeadlineAt: "2026-10-24T15:00:20.000Z", originalDeadlineAt: "2026-10-24T15:01:00.000Z",
    wallDeadlineAt: "2026-10-24T15:00:30.000Z", responsibilityDeadlineAt: "2026-10-24T15:00:40.000Z",
    programmeDeadlineAt: "2026-10-24T15:00:25.000Z", nowMs: Date.parse("2026-10-24T15:00:00.000Z"),
};
add("remaining-original-deadline", "same requested attenuated deadline", api => assert.equal(api.assertInheritedDeadline(deadline), deadline.requestedDeadlineAt));
for (const key of ["originalDeadlineAt", "wallDeadlineAt", "responsibilityDeadlineAt", "programmeDeadlineAt"]) {
    add(`deadline-extension:${key}`, "refused", api => assert.throws(() => api.assertInheritedDeadline({ ...deadline, [key]: "2026-10-24T15:00:19.000Z" })));
}
add("expired-original-deadline", "refused", api => assert.throws(() => api.assertInheritedDeadline({ ...deadline, nowMs: Date.parse(deadline.requestedDeadlineAt) })));
const charge = { parentLimit: "520", parentUsed: "519", childLimit: "200", childUsed: "10",
    units: 1, recovery: false, phase: "ACQUISITION" };
add("last-original-unit", "520 used, child 11 used", api => assert.deepEqual(api.assertInheritedCharge(charge), { parentUsedAfter: "520", childUsedAfter: "11" }));
add("original-charge-exhaustion", "refused", api => assert.throws(() => api.assertInheritedCharge({ ...charge, units: 2 })));
add("child-charge-exhaustion", "refused", api => assert.throws(() => api.assertInheritedCharge({ ...charge, childUsed: "200" })));
add("same-original-recovery-charge", "520 used, child 11 used", api => assert.deepEqual(api.assertInheritedCharge({ ...charge, recovery: true, phase: "RECOVERY" }), { parentUsedAfter: "520", childUsedAfter: "11" }));
add("no-forward-recovery-authority", "refused", api => assert.throws(() => api.assertInheritedCharge({ ...charge, recovery: true, phase: "EXECUTION" })));
add("unsafe-numeric-charge", "refused", api => assert.throws(() => api.assertInheritedCharge({ ...charge, parentUsed: 9007199254740992 })));
const started = performance.now();
let api, loadFailure = null;
try {
    api = await import(pathToFileURL(source).href);
}
catch {
    loadFailure = "OWNED_SEMANTICS_INTERFACE_UNAVAILABLE";
}
const observed = cases.map(test => {
    try {
        if (loadFailure)
            throw Error(loadFailure);
        test.run(api);
        return { id: test.id, expected: test.expected, status: "PASS" };
    }
    catch (error) {
        return { id: test.id, expected: test.expected, status: "FAIL",
            predicate: error instanceof assert.AssertionError ? error.code : loadFailure ?? "CONTRACT_FAILURE" };
    }
});
const baseline = process.argv.includes("--baseline");
await mkdir(output, { recursive: true });
const bytes = await readFile(import.meta.filename);
const receipt = {
    schema: "finnor.project-z.z0.isolated-contract-sweep.v1", baseline, observedAt: new Date().toISOString(),
    evidenceClass: "ISOLATED_LITERAL_CONTRACTS_NOT_AUTHENTICATED_PRODUCT_E2E", node: process.version,
    runnerSha256: createHash("sha256").update(bytes).digest("hex"),
    semanticsSha256: await readFile(source).then(value => createHash("sha256").update(value).digest("hex")).catch(() => null),
    fixtures: "literal synthetic IDs and original integer arithmetic, no real tenant or credentials",
    observed, pass: observed.filter(item => item.status === "PASS").length,
    fail: observed.filter(item => item.status === "FAIL").length,
    costs: { elapsedMs: performance.now() - started, money: null, aggregateMemory: null },
    authenticatedHttp: "NOT_RUN", databaseOwners: "NOT_RUN", mountedWork: "NOT_RUN", physicalRecovery: "NOT_RUN",
    rerun: "FINNOR_Z0_EVIDENCE_DIR=/absolute/owned/evidence node --import tsx finnor-os/scripts/project-z/z0/verify-contracts.mts",
};
await writeFile(resolve(output, baseline ? "contracts-before.json" : "contracts-after.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ pass: receipt.pass, fail: receipt.fail, evidenceClass: receipt.evidenceClass }));
if (receipt.fail)
    process.exitCode = 1;
