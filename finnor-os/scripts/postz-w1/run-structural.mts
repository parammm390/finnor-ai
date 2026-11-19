/** Original-byte structural mechanism campaign. Its failure contract precedes this driver. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileMetalevelPolicy } from "../../packages/epistemic-runtime/src/metalevel-policy/producer";
import { checkMetalevelPolicy } from "../../packages/epistemic-runtime/src/metalevel-policy/checker";

const inputs = resolve(process.argv[2] ?? ""), output = resolve(process.argv[3] ?? "");
assert(process.argv[2] && process.argv[3], "FROZEN_INPUTS_AND_NEW_OUTPUT_REQUIRED");
const inventory = JSON.parse(await readFile(join(inputs, "inputs.json"), "utf8"));
assert.equal(inventory.schema, "finnor.w1.structural-inputs.v1");
assert.equal(inventory.families, 16);
assert.equal(inventory.casesPerFamily, 8);
assert.equal(inventory.cases.length, 128);
assert.equal(new Set(inventory.cases.map((row: any) => row.id)).size, 128);
await mkdir(output, { recursive: false });
const results: any[] = [], began = performance.now();
for (const row of inventory.cases) {
  const start = performance.now();
  const observed: any = { id: row.id, family: row.family, expectation: row.expectation, status: "NOT_RUN" };
  try {
    assert(performance.now() - began < 120_000, "STRUCTURAL_CAMPAIGN_120_SECOND_BOUND");
    const bytes = await readFile(join(inputs, row.path), "utf8");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256, "FROZEN_ORIGINAL_INPUT_BYTES");
    const run = spawnSync(process.env.FINNOR_TEST_PYTHON ?? "python3",
      [join(import.meta.dirname, "reference.py"), join(inputs, row.path)],
      { encoding: "utf8", timeout: 10_000 });
    observed.reference = { exitCode: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr };
    const reference = JSON.parse(run.stdout);
    if (row.expectation === "REJECT") {
      assert.equal(run.status, 1, "REFERENCE_MUST_REACH_REGISTERED_REJECTION");
      assert.equal(reference.reason, row.referenceReason, "EXACT_REFERENCE_REJECTION_BOUNDARY");
      let error: unknown;
      try { compileMetalevelPolicy(bytes); } catch (failure) { error = failure; }
      assert(error, "PRODUCER_MUST_REJECT_ORIGINAL_INVALID_MODEL");
      observed.productionRejection = String(error);
      if (row.productionError) assert(String(error).includes(row.productionError), "EXACT_PRODUCTION_REJECTION_BOUNDARY");
    } else {
      assert.equal(run.status, 0, "ORIGINAL_MODEL_REFERENCE_MUST_SUCCEED");
      const actual = compileMetalevelPolicy(bytes);
      assert.deepEqual({ modelSha256: actual.modelSha256, rootStateId: actual.rootStateId, states: actual.states }, reference,
        "FULL_STATE_ACTION_VALUE_AND_TIE_EQUALITY");
      assert.equal(checkMetalevelPolicy(bytes, actual).status, "VALID");
      const mutation = structuredClone(actual);
      mutation.states[mutation.rootStateId]!.value = "999999999";
      assert.equal(checkMetalevelPolicy(bytes, mutation).status, "INVALID", "VALUE_MUTATION_REACHES_INDEPENDENT_CHECKER");
      observed.policy = actual;
      observed.referenceFullEquality = true;
      observed.tamperedPolicyRejected = true;
    }
    observed.status = "PASS";
  } catch (error) {
    observed.status = "FAIL";
    observed.failure = String(error);
    observed.stack = error instanceof Error ? error.stack : null;
  }
  observed.durationMs = performance.now() - start;
  results.push(observed);
  await writeFile(join(output, row.id + ".result.json"), JSON.stringify(observed, null, 2) + "\n", { flag: "wx" });
}
const families = Array.from(new Set(results.map(row => row.family))).map(family => {
  const rows = results.filter(row => row.family === family);
  return { family, offered: rows.length, passed: rows.filter(row => row.status === "PASS").length,
    failed: rows.filter(row => row.status === "FAIL").length };
});
assert.equal(families.length, 16);
assert(families.every(family => family.offered === 8));
const report = { schema: "finnor.w1.structural-mechanism-campaign.v1",
  status: results.every(row => row.status === "PASS") ? "PASS_LOCAL_MECHANISM" : "FAIL",
  inputsSha256: createHash("sha256").update(await readFile(join(inputs, "inputs.json"))).digest("hex"),
  durationMs: performance.now() - began, families,
  results: results.map(({ policy, reference, ...row }) => ({ ...row, artifact: row.id + ".result.json" })),
  protectedCustody: false, domainQualified: false, paidProviderCalls: 0,
  qualification: "PUBLIC_FINITE_MODEL_MECHANISM_ONLY_NOT_NATIVE_TOPOLOGY_OR_EMPIRICAL_POPULATION" };
await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: report.status, families, durationMs: report.durationMs }));
if (report.status !== "PASS_LOCAL_MECHANISM") process.exitCode = 1;
