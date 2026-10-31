/** Pre-code exact owning proof. Reference expectations come from original bytes. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { compileMetalevelPolicy } from "../../packages/epistemic-runtime/src/metalevel-policy/producer.ts";
import { checkMetalevelPolicy } from "../../packages/epistemic-runtime/src/metalevel-policy/checker.ts";
import { parseMetalevelModel } from "../../packages/epistemic-runtime/src/metalevel-policy/contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.FINNOR_TEST_PYTHON ?? "python3";
const defaultOutput = resolve(here, "../../../scope-postz/w1-economic-orchestration/evidence/exact");
const output = resolve(process.argv[2] ?? defaultOutput);
await mkdir(output, { recursive: true });
execFileSync(python, ["-B", resolve(here, "fixture-source.py"), resolve(here, "fixtures")]);
const cases: Array<{ name: string; status: "PASS" | "FAIL"; durationMs: number; detail: string }> = [];
async function proof(name: string, run: () => unknown | Promise<unknown>) {
  const started = performance.now();
  try {
    await run();
    cases.push({ name, status: "PASS", durationMs: performance.now() - started, detail: "Original independent predicate satisfied" });
  } catch (error) {
    cases.push({ name, status: "FAIL", durationMs: performance.now() - started, detail: error instanceof Error ? error.message : String(error) });
  }
}
for (const name of ["complementarity", "rational-tie", "boundary", "computation-boundary", "full-boundary"]) {
  await proof(name, async () => {
    const source = resolve(here, "fixtures", `${name}.json`);
    const bytes = await readFile(source, "utf8");
    const independent: unknown = JSON.parse(execFileSync(python, ["-B", resolve(here, "reference.py"), source], { encoding: "utf8" }));
    const actual = compileMetalevelPolicy(bytes);
    assert.deepEqual({ modelSha256: actual.modelSha256, rootStateId: actual.rootStateId, states: actual.states }, independent);
    const checked = checkMetalevelPolicy(bytes, actual);
    assert.equal(checked.status, "VALID");
    if (name === "complementarity") {
      assert.equal(actual.states.root?.value, "98");
      assert.equal(actual.states.root?.choiceValues.stop, "50");
      assert.equal(actual.states.root?.selectedChoiceId, "first");
      assert.equal(actual.states["first-result"]?.selectedChoiceId, "second");
    }
    if (name === "rational-tie") {
      assert.equal(actual.states.root?.value, "1/3");
      assert.deepEqual(actual.states.root?.optimalChoiceIds, ["equal", "stop"]);
      assert.equal(actual.states.root?.selectedChoiceId, "equal");
    }
    if (name === "boundary" || name === "full-boundary") {
      assert.equal(Object.keys(actual.states).length, 64);
      assert.equal(actual.states.root?.value, "92");
    }
    await writeFile(resolve(output, `${name}.policy.json`), `${JSON.stringify(actual, null, 2)}\n`);
    await writeFile(resolve(output, `${name}.reference.json`), `${JSON.stringify(independent, null, 2)}\n`);
  });
}
const original = await readFile(resolve(here, "fixtures/complementarity.json"), "utf8");
const valid = compileMetalevelPolicy(original);
async function referenceMutation(name: string, bytes: string) {
  const source = resolve(output, `${name}.model.json`);
  await writeFile(source, bytes);
  const result = spawnSync(python, ["-B", resolve(here, "reference.py"), source], { encoding: "utf8", timeout: 15_000 });
  await writeFile(resolve(output, `${name}.reference-run.json`), `${JSON.stringify({
    status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
  }, null, 2)}\n`);
  return { exitCode: result.status, body: JSON.parse(result.stdout) };
}
await proof("default-output-in-assigned-worktree", () => {
  assert.equal(defaultOutput, resolve(here, "../../../scope-postz/w1-economic-orchestration/evidence/exact"));
});
await proof("seventeen-computations-refused-without-truncation", async () => {
  const bytes = await readFile(resolve(here, "fixtures/unsupported-17-computations.json"), "utf8");
  const reference = await referenceMutation("seventeen-computations", bytes);
  assert.equal(reference.exitCode, 1);
  assert.equal(reference.body.reason, "UNSUPPORTED_CHOICE_BOUND");
  assert.throws(() => compileMetalevelPolicy(bytes));
});
for (const [name, bytes] of [
  ["fractional-original-horizon", original.replace('"maxDecisions": 2', '"maxDecisions": 1.99999999999999999')],
  ["fractional-original-depth", original.replace('"decisionIndex": 1', '"decisionIndex": 1.00000000000000001')],
] as const) {
  await proof(name, async () => {
    assert.notEqual(bytes, original);
    const reference = await referenceMutation(name, bytes);
    assert.equal(reference.exitCode, 1);
    assert.throws(() => compileMetalevelPolicy(bytes));
    assert.equal(checkMetalevelPolicy(bytes, valid).status, "INVALID");
  });
}
for (const token of ["2.0", "2e0"]) {
  await proof(`exact-integer-token-${token}`, async () => {
    const bytes = original.replace('"maxDecisions": 2', `"maxDecisions": ${token}`);
    const actual = compileMetalevelPolicy(bytes), reference = await referenceMutation(`exact-integer-${token}`, bytes);
    assert.equal(reference.exitCode, 0);
    assert.deepEqual({ modelSha256: actual.modelSha256, rootStateId: actual.rootStateId, states: actual.states }, reference.body);
    assert.equal(checkMetalevelPolicy(bytes, actual).status, "VALID");
  });
}
await proof("unaffordable-prototype-named-resource-refused", async () => {
  const bytes = original.replace(/"(remaining|reservation|consumption)": \{/g,
    (_match, field: string) => `"${field}": {"__proto__": "${field === "remaining" ? "0" : "1"}",`);
  const reference = await referenceMutation("unaffordable-prototype-resource", bytes);
  assert.equal(reference.exitCode, 1);
  assert.equal(reference.body.reason, "UNAFFORDABLE_RESERVATION");
  assert.throws(() => compileMetalevelPolicy(bytes));
});
await proof("affordable-prototype-named-resource-preserved", async () => {
  const bytes = original.replace(/"(remaining|reservation|consumption)": \{\s*"computeUnits": "([^"]+)"/g,
    (_match, field: string, amount: string) => `"${field}": {"__proto__": "${amount}", "computeUnits": "${amount}"`);
  const parsed = parseMetalevelModel(bytes);
  assert.equal(parsed.states.find(s => s.id === parsed.rootStateId)?.remaining["__proto__"], "2");
  const actual = compileMetalevelPolicy(bytes), reference = await referenceMutation("affordable-prototype-resource", bytes);
  assert.equal(reference.exitCode, 0);
  assert.deepEqual({ modelSha256: actual.modelSha256, rootStateId: actual.rootStateId, states: actual.states }, reference.body);
  assert.equal(checkMetalevelPolicy(bytes, actual).status, "VALID");
});
for (const [name, bytes] of [
  ["prototype-named-state", original.replace('"rootStateId": "root"', '"rootStateId": "__proto__"').replace('"id": "root"', '"id": "__proto__"')],
  ["prototype-named-choice", original.replaceAll('"first"', '"__proto__"')],
] as const) {
  await proof(name, async () => {
    const actual = compileMetalevelPolicy(bytes), reference = await referenceMutation(name, bytes);
    assert.equal(reference.exitCode, 0);
    assert.deepEqual({ modelSha256: actual.modelSha256, rootStateId: actual.rootStateId, states: actual.states }, reference.body);
    assert.equal(checkMetalevelPolicy(bytes, actual).status, "VALID");
  });
}
await proof("independent-reference-refuses-unexecuted-prerequisite", async () => {
  const bytes = original.replace('"dependsOn": []', '"dependsOn": ["second"]');
  assert.throws(() => compileMetalevelPolicy(bytes), /METALEVEL_UNMET_DEPENDENCY/);
  const reference = await referenceMutation("unexecuted-prerequisite", bytes);
  assert.equal(reference.exitCode, 1);
  assert.equal(reference.body.reason, "UNMET_DEPENDENCY");
});
await proof("checker-rejects-value-mutation", () => {
  const altered = structuredClone(valid);
  const root = altered.states.root;
  assert.ok(root);
  root.value = "99";
  assert.equal(checkMetalevelPolicy(original, altered).status, "INVALID");
});
await proof("checker-rejects-missing-state", () => {
  const altered = structuredClone(valid);
  delete altered.states.left;
  assert.equal(checkMetalevelPolicy(original, altered).status, "INVALID");
});
await proof("checker-rejects-illegal-choice", () => {
  const altered = structuredClone(valid);
  const root = altered.states.root;
  assert.ok(root);
  root.selectedChoiceId = "unavailable-cheap-agent";
  assert.equal(checkMetalevelPolicy(original, altered).status, "INVALID");
});
await proof("checker-rejects-original-byte-change", () => {
  assert.equal(checkMetalevelPolicy(`${original}\n`, valid).status, "INVALID");
});
for (const field of ["modelRef", "priceRef", "checkerRef", "outcomeRef", "parentGrantRef"]) {
  await proof(`checker-rejects-${field}-mutation`, () => {
    const changed = original.replace(`development:${field}`, `changed:${field}`);
    assert.notEqual(changed, original);
    assert.equal(checkMetalevelPolicy(changed, valid).status, "INVALID");
  });
}
await proof("invalid-probability", () => {
  const changed = original.replace('"probability": "1/2"', '"probability": "2/3"');
  assert.throws(() => parseMetalevelModel(changed));
});
await proof("omitted-cost", () => {
  const changed = original.replace('"utilityCost": "1",', "");
  assert.throws(() => parseMetalevelModel(changed));
});
await proof("resource-reset", () => {
  const changed = original.replace('"computeUnits": "2"', '"computeUnits": "3"');
  assert.throws(() => parseMetalevelModel(changed));
});
await proof("unsafe-accepted-stop", () => {
  const changed = original.replace('"disposition": "INCOMPLETE"', '"disposition": "ACCEPTED"');
  assert.throws(() => parseMetalevelModel(changed));
});
await proof("duplicate-json-key", () => {
  assert.throws(() => parseMetalevelModel(original.replace('"maxDecisions": 2', '"maxDecisions": 1, "maxDecisions": 2')));
});
await proof("unsupported-bound-is-not-truncated", () => {
  const changed = original.replace('"maxDecisions": 2', '"maxDecisions": 9');
  assert.throws(() => parseMetalevelModel(changed));
});
await proof("explicit-invalid-observation-required", () => {
  const changed = original.replace('"kind": "INVALID"', '"kind": "VALID"');
  assert.throws(() => parseMetalevelModel(changed));
});
const report = {
  schema: "finnor.postz.w1.exact-development-proof.v1", scope: "DEVELOPMENT_MODEL_RELATIVE_ONLY",
  source: "Original generated model bytes; independent Python Fraction recurrence",
  protectedCustody: false, nativeConsumerProof: "NOT_RUN",
  passed: cases.filter(c => c.status === "PASS").length,
  failed: cases.filter(c => c.status === "FAIL").length, cases,
};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(resolve(output, `run-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failed) process.exitCode = 1;
