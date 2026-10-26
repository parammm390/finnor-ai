import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runPythonEngine } from "../../packages/tools/src/capabilities/python-runner";

const output = resolve(process.env.FINNOR_CAPABILITY_EVIDENCE_DIR ?? "../docs/release/generated/capability-causal");
await mkdir(output, { recursive: true });
let seed = 117;
const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) + 0.5) / 4294967296;
const rows: string[] = ["t,y,x,z"];
for (let index = 0; index < 500; index++) {
  const x = random() * 2 - 1, z = random() * 2 - 1, t = random() < 0.5 + x * 0.08 ? 1 : 0;
  rows.push([t, 2 * t + 0.5 * x + 0.2 * z + (random() - 0.5) * 0.1, x, z].join(","));
}
const csv = rows.join("\n") + "\n", bytes = Buffer.from(csv), digest = createHash("sha256").update(bytes).digest("hex");
const request = { bytesBase64: bytes.toString("base64"), sha256: digest, format: "csv", source: { documentId: "synthetic", versionId: "fixed-117", sha256: digest },
  treatment: "t", outcome: "y", commonCauses: ["x", "z"], effectModifiers: ["x"], estimator: "linear", seed: 11,
  assumptions: [{ statement: "Synthetic treatment assignment uses only x and independent random noise; no interference; contrast zero to one.", evidenceRef: "generator-source-and-input.csv" }] };
await writeFile(join(output, "input.csv"), csv);
const sourcePaths = ["packages/tools/src/capabilities/python/pywhy_engine.py", "packages/tools/src/capabilities/python-runner.ts", "scripts/release/run-capability-causal-e2e.mts", "packages/tools/src/capabilities/python/requirements-causal.lock.txt"];
const cut = async () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
const before = await cut(), cases: Array<{ id: string; status: "PASS" | "FAIL"; observed?: unknown; error?: string }> = [];
async function check(id: string, run: () => Promise<unknown>) {
  try { cases.push({ id, status: "PASS", observed: await run() }); } catch (error) { cases.push({ id, status: "FAIL", error: String(error) }); }
  await writeFile(join(output, "partial-results.json"), JSON.stringify({ before, cases }, null, 2));
  console.log(JSON.stringify({ id, status: cases.at(-1)?.status, error: cases.at(-1)?.error }));
}
const resultSchema = z.object({ estimation: z.object({ averageEffect: z.number().finite(), confidenceInterval95: z.array(z.number().finite()).length(2) }).passthrough(),
  backend: z.record(z.string()), refutations: z.array(z.unknown()).length(3), causalClaimEstablished: z.literal(false), admission: z.object({ status: z.literal("BLOCKED_EXTERNAL") }).passthrough() }).passthrough();
for (const estimator of ["linear", "double_ml", "causal_forest"]) {
  await check(`real-pywhy-${estimator}-known-effect`, async () => {
    const execution = await runPythonEngine("pywhy", { ...request, estimator }, { deadlineAt: Date.now() + 120_000 });
    const result = resultSchema.parse(execution.result);
    assert(Math.abs(result.estimation.averageEffect - 2) < 0.4, JSON.stringify(result.estimation));
    return { result, identity: execution.identity, expectedSyntheticEffect: 2, maximumAbsoluteError: 0.4 };
  });
}
await check("causal-variable-role-leakage-refused", async () => {
  await assert.rejects(runPythonEngine("pywhy", { ...request, commonCauses: ["y"] }, { deadlineAt: Date.now() + 30_000 }), { code: "PYWHY_VARIABLE_ROLES_INVALID" });
  return { code: "PYWHY_VARIABLE_ROLES_INVALID" };
});
await check("causal-source-tampering-refused", async () => {
  await assert.rejects(runPythonEngine("pywhy", { ...request, sha256: "0".repeat(64) }, { deadlineAt: Date.now() + 30_000 }), { code: "PYWHY_SOURCE_INVALID" });
  return { code: "PYWHY_SOURCE_INVALID" };
});
await check("causal-perfect-treatment-separation-refused", async () => {
  const altered = Buffer.from(rows.map((row, index) => index === 0 ? row : row.split(",").map((cell, column) => column === 0 ? String(Number(row.split(",")[2]) > 0 ? 1 : 0) : cell).join(",")).join("\n") + "\n");
  await assert.rejects(runPythonEngine("pywhy", { ...request, bytesBase64: altered.toString("base64"), sha256: createHash("sha256").update(altered).digest("hex") }, { deadlineAt: Date.now() + 30_000 }), { code: "PYWHY_OVERLAP_UNSUPPORTED" });
  return { code: "PYWHY_OVERLAP_UNSUPPORTED" };
});
const after = await cut(), sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after), failed = !sourcesUnchanged || cases.some(c => c.status === "FAIL");
await writeFile(join(output, "results.json"), JSON.stringify({ schema: "finnor.capability-causal-e2e.v1", before, after, sourcesUnchanged, cases, failed,
  inputs: { request: { ...request, bytesBase64: "SEE_INPUT_CSV" }, generatorSeed: 117, rows: 500 }, qualification: "REAL_LOCAL_DOWHY_ECONML_CHILD; SYNTHETIC_KNOWN_EFFECT_ONLY; NO_BUSINESS_CAUSAL_OR_NATIVE_ADMISSION_CLAIM",
  rerun: "FINNOR_CAPABILITY_PYTHON=$PWD/.capability-venv/bin/python FINNOR_CAPABILITY_EVIDENCE_DIR=<fresh-directory> node --import=tsx scripts/release/run-capability-causal-e2e.mts" }, null, 2) + "\n");
process.exitCode = failed ? 1 : 0;
