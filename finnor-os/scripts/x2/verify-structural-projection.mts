/** Finite literal reference fixed before the structural projection kernel.
 * Not external application law, native Work, mounted or installed proof. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectApplicationSnapshot } from "../../packages/private-equity/src/application-semantics/observation";

const destination = process.argv[2];
if (!destination?.startsWith("/")) throw Error("FRESH_ABSOLUTE_OUTPUT_DIRECTORY_REQUIRED");
await mkdir(destination, { mode: 0o700 });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ref = { owner: "REFERENCE", id: "original-observer", version: "1", contentDigest: "a".repeat(64) };
const quantity = { kind: "quantity", decimal: "9007199254740993.01", currency: "EUR", entity: "entity",
  unit: "thousands", time: "2027-06-30", basis: "accrual" };
const identity = { kind: "identity", application: "application", account: "account", entity: "entity", id: "record" };
const field = (path: string, kind = "text") => ({ path, kind, nullable: true, observedValues: [], observationRefs: [ref] });
const base = {
  schema: "finnor.x2.application-snapshot.v1",
  scope: { tenantId: "tenant", principalId: "principal", application: "application", account: "account",
    role: "editor", grantRef: ref, rightsRef: "rights" },
  target: identity, applicationRevision: "revision", recordRevision: "1", schemaDigest: "b".repeat(64),
  sourceRef: ref, observedAt: "2026-10-15T00:00:00.000Z", state: {}, unavailableFields: [],
  observationQualification: "LAWFUL_INDEPENDENT_READBACK",
};
const witness = {
  schema: "finnor.x2.structural-observation-witness.v1", observerContractRef: ref, publishedSchemaDigest: null,
  leaves: {}, leafKinds: {}, availablePaths: ["draft", "flag", "name", "reference"],
  unavailablePaths: [], nullPrefixes: [], optionalAbsentPaths: [],
};
const cases = [
  { id: "actual-text", fields: [field("name")], patch: { leaves: { name: "VALUE" }, leafKinds: { name: "text" } }, expected: { name: "VALUE" }, unavailable: [] },
  { id: "actual-boolean", fields: [field("flag", "boolean")], patch: { leaves: { flag: false }, leafKinds: { flag: "boolean" } }, expected: { flag: false }, unavailable: [] },
  { id: "actual-exact-quantity", fields: [field("draft.reporting", "quantity")], patch: { leaves: { "draft.reporting": quantity }, leafKinds: { "draft.reporting": "quantity" } }, expected: { "draft.reporting": quantity }, unavailable: [] },
  { id: "actual-identity", fields: [field("reference", "identity")], patch: { leaves: { reference: identity }, leafKinds: { reference: "identity" } }, expected: { reference: identity }, unavailable: [] },
  { id: "covered-null-ancestor", fields: [field("draft.reporting", "quantity")], patch: { nullPrefixes: ["draft"] }, expected: { "draft.reporting": null }, unavailable: [] },
  { id: "schema-optional-absence", fields: [field("draft.reporting", "quantity")], patch: { publishedSchemaDigest: "c".repeat(64), optionalAbsentPaths: ["draft"] }, expected: { "draft.reporting": null }, unavailable: [] },
  { id: "optional-without-schema", fields: [field("draft.reporting", "quantity")], patch: { optionalAbsentPaths: ["draft"] }, expected: {}, unavailable: ["draft.reporting"] },
  { id: "negative-overrides-null", fields: [field("draft.reporting", "quantity")], patch: { nullPrefixes: ["draft"], unavailablePaths: ["draft.reporting"] }, expected: {}, unavailable: ["draft.reporting"] },
  { id: "negative-overrides-leaf", fields: [field("name")], patch: { leaves: { name: "VALUE" }, leafKinds: { name: "text" }, unavailablePaths: ["name"] }, expected: {}, unavailable: ["name"] },
  { id: "no-positive-coverage", fields: [field("name")], patch: { leaves: { name: "VALUE" }, leafKinds: { name: "text" }, availablePaths: [] }, expected: {}, unavailable: ["name"] },
  { id: "required-or-unknown-omission", fields: [field("draft.reporting", "quantity")], patch: {}, expected: {}, unavailable: ["draft.reporting"] },
  { id: "incompatible-kind", fields: [field("name", "boolean")], patch: { leaves: { name: "VALUE" }, leafKinds: { name: "text" } }, expected: {}, unavailable: ["name"] },
  { id: "malformed-atomic-quantity", fields: [field("draft.reporting", "quantity")], patch: { leaves: { "draft.reporting": { ...quantity, decimal: "1e20" } }, leafKinds: { "draft.reporting": "quantity" } }, expected: {}, unavailable: ["draft.reporting"] },
  { id: "no-rounded-number-quantity", fields: [field("draft.reporting", "quantity")], patch: { leaves: { "draft.reporting": { ...quantity, decimal: 9007199254740993 } }, leafKinds: { "draft.reporting": "quantity" } }, expected: {}, unavailable: ["draft.reporting"] },
  { id: "legacy-actual-leaf", fields: [field("name")], legacy: { name: "VALUE" }, patch: {}, expected: { name: "VALUE" }, unavailable: [] },
  { id: "legacy-no-invented-child", fields: [field("draft.reporting", "quantity")], legacy: { draft: null }, patch: {}, expected: {}, unavailable: ["draft.reporting"] },
] as const;
const inputs = cases.map(input => {
  const w = { ...witness, ...input.patch };
  const snapshot = "legacy" in input ? { ...base, state: input.legacy }
    : { ...base, state: w.leaves, structuralWitness: w };
  return { id: input.id, snapshot, fields: input.fields, expected: input.expected, unavailable: input.unavailable };
});
await writeFile(resolve(destination, "reference-inputs.json"), JSON.stringify(inputs, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const results = inputs.map(input => {
  const before = hash(input.snapshot), fieldsBefore = hash(input.fields);
  try {
    const actual = projectApplicationSnapshot(input.snapshot, input.fields);
    assert.deepEqual(actual.state, input.expected);
    assert.deepEqual(actual.unavailableFields, input.unavailable);
    assert.equal(hash(input.snapshot), before, "ORIGINAL_SNAPSHOT_MUTATED");
    assert.equal(hash(input.fields), fieldsBefore, "DECLARED_FIELD_CONTRACT_MUTATED");
    return { id: input.id, pass: true, actual, originalDigest: before, fieldsDigest: fieldsBefore };
  } catch (error) {
    return { id: input.id, pass: false, code: error instanceof Error && "code" in error ? String(error.code) : "REFERENCE_MISMATCH",
      originalUnchanged: hash(input.snapshot) === before, fieldsUnchanged: hash(input.fields) === fieldsBefore };
  }
});
const pins: Record<string, string> = {}, root = resolve(import.meta.dirname, "../../..");
for (const path of ["finnor-os/packages/private-equity/src/application-semantics/observation.ts",
  "finnor-os/packages/private-equity/src/application-semantics/contracts.ts",
  "finnor-os/scripts/x2/verify-structural-projection.mts",
  "scope-frontier5/x2-software-semantics-compiler/structural-observation-contract.md"]) {
  pins[path] = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
}
const failed = results.filter(result => !result.pass).length;
await writeFile(resolve(destination, "result.json"), JSON.stringify({
  schema: "finnor.x2.structural-projection-finite-reference.v1",
  qualification: "FINITE_LITERAL_REFERENCE_NOT_EXTERNAL_CONFORMANCE_NATIVE_WORK_MOUNTED_OR_INSTALLATION",
  pins, node: process.version, results, passed: results.length - failed, failed,
  rerun: "cd <absolute-checkout>/finnor-os && node --import=tsx scripts/x2/verify-structural-projection.mts <fresh-absolute-output>",
}, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ status: failed ? "FAIL" : "PASS_FINITE_REFERENCE_ONLY", passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
