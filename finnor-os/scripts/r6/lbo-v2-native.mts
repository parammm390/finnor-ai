import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as uw from "../../packages/underwriting/src/index";
import { assertR6NativeNumericPolicy, r6Sha256 } from "../../packages/epistemic-runtime/src/verified-capital-compiler/index";
import type { R6InputDomain, R6ReferenceState } from "../../packages/shared-types/src/decision-proof";
const args = process.argv.slice(2);
const evidence = resolve(args[args.indexOf("--evidence") + 1]!);
const source = resolve(args[args.indexOf("--source-evidence") + 1]!);
const repo = resolve(process.env.R6_REPOSITORY_ROOT!);
const owned = join(repo, "scope-r/r6-verified-capital-compiler/evidence-private/");
assert(source.startsWith(owned) && evidence.startsWith(owned) && evidence !== source);
const results: Array<Record<string, unknown>> = [];
let bytes = 0;
async function retain(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n"; bytes += Buffer.byteLength(serialized);
  assert(bytes <= 64 * 1024 * 1024);
  await writeFile(path, serialized, { flag: "wx" });
}
type Original = {
  config: uw.StandardLboModelConfig; model: uw.UnderwritingModelIR; compiled: uw.CompiledUnderwritingModel;
  snapshot: uw.UnderwritingInputSnapshot; domain: R6InputDomain; inventory: R6ReferenceState[];
  result: uw.UnderwritingRunResult;
};
async function main(): Promise<void> {
  const disk = await statfs(repo);
  assert(Number(disk.bavail) * Number(disk.bsize) >= 160 * 1024 * 1024);
  assertR6NativeNumericPolicy();
  assert.equal(r6Sha256(await readFile(join(repo, "finnor-os/packages/underwriting/src/returns.ts"))),
    "9e82a4316ccddfaa360fc80996f572d5ad26d6401d21611c97777f72938e89de");
  assert.equal(r6Sha256(await readFile(join(repo, "finnor-os/packages/underwriting/src/decimal.ts"))),
    "301604f5f53b92b1908db00e12d600716bc8f3ab1e5233fb7516e8630282b572");
  await retain(join(evidence, "source-cut.json"), {
    head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    status: execFileSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" }),
    method: uw.NATIVE_RETURN_V2_POLICY, runnerSha256: r6Sha256(await readFile(new URL(import.meta.url))),
    nativePins: await Promise.all(["compiler", "types", "index", "standard-lbo", "result", "returns", "returns-v2", "decimal"].map(async name => ({
      path: `finnor-os/packages/underwriting/src/${name}.ts`,
      sha256: r6Sha256(await readFile(join(repo, `finnor-os/packages/underwriting/src/${name}.ts`))),
    }))),
  });
  for (const id of ["retained-original-one-period", "annual-9-late-exit", "annual-12-late-exit",
    "quarterly-12-late-exit", "monthly-12-late-exit", "average-balance-12-late-exit"]) {
    const original = JSON.parse(await readFile(join(source, id, "native.json"), "utf8")) as Original;
    const defaultModel = uw.createStandardLboModel(original.config);
    const defaultCompiled = uw.compileUnderwritingModel(defaultModel);
    const defaultResult = uw.executeUnderwritingModel(defaultCompiled, original.snapshot);
    assert.equal(uw.canonicalSerialize(defaultModel), uw.canonicalSerialize(original.model));
    assert.equal(uw.canonicalSerialize(defaultCompiled), uw.canonicalSerialize(original.compiled));
    assert.equal(uw.canonicalSerialize(defaultResult), uw.canonicalSerialize(original.result),
      "Default v1 bytes/results must remain exactly compatible");
    const config: uw.StandardLboModelConfig = {
      ...original.config, modelVersion: `${original.config.modelVersion}+decimal34_horner_npv_v2`,
      returnMethod: uw.NATIVE_RETURN_METHOD_V2,
    };
    const model = uw.createStandardLboModel(config);
    const compiled = uw.compileUnderwritingModel(model);
    const result = uw.executeUnderwritingModel(compiled, original.snapshot);
    const dir = join(evidence, id); await mkdir(dir);
    await retain(join(dir, "native.json"), { config, model, compiled, snapshot: original.snapshot,
      domain: original.domain, inventory: original.inventory, result });
    await retain(join(dir, "v1-compatibility.json"), {
      exactModelCompatible: true, exactCompiledCompatible: true, exactResultCompatible: true,
      originalResultDigest: original.result.resultSemanticHash, observedV1Status: defaultResult.status,
      observedV1Failure: defaultResult.failure?.code ?? null, originalNativeRecordSha256: r6Sha256(await readFile(join(source, id, "native.json"))),
    });
    assert.notEqual(compiled.semanticHash, defaultCompiled.semanticHash);
    assert.equal(uw.canonicalSerialize(model.nodes), uw.canonicalSerialize(original.model.nodes));
    assert.equal(result.inputSemanticHash, original.result.inputSemanticHash);
    assert.equal(result.status, "SUCCEEDED", JSON.stringify(result.failure));
    assert.equal(result.validity, "VALID", JSON.stringify(result.checks));
    assert.equal(result.checks.length, 10); assert.equal(Object.keys(result.outputs).length, 33);
    assert.equal(result.returnSolverTraces?.length, 2);
    results.push({ id, nativeV2Status: result.status, nativeV2Validity: result.validity,
      v1Status: defaultResult.status, v1Failure: defaultResult.failure?.code ?? null,
      nativeModelDigest: compiled.semanticHash, inputDigest: result.inputSemanticHash,
      resultDigest: result.resultSemanticHash, nodes: model.nodes.length, checks: result.checks.length,
      outputs: Object.keys(result.outputs).length, domainDigest: uw.semanticHash(original.domain),
      exitChoices: original.domain.inputs.find(b => b.programmeNodeId === "exit.period_id")!.components.$scalar });
    console.log(`${id}: v1 ${defaultResult.status}; explicit v2 ${result.status}/${result.validity}`);
  }
  // Negative compiler identity, not an alternate financial convention.
  const original = JSON.parse(await readFile(join(source, "annual-12-late-exit/native.json"), "utf8")) as Original;
  const unknown = structuredClone(original.model);
  (unknown.runtime as unknown as { returnMethod: string }).returnMethod = "unregistered_return";
  assert.throws(() => uw.compileUnderwritingModel(unknown), /Unknown versioned native return operation/);
  assertR6NativeNumericPolicy();
}
let failure: unknown = null;
try { await main(); } catch (error) { failure = error; console.error(error); }
await retain(join(evidence, "summary.json"), {
  schema: "finnor.r6.versioned-lbo-native-e2e.v1", engineeringChecks: failure ? "FAIL" : "PASS_NATIVE_COMPATIBILITY_AND_WITNESSES_ONLY",
  cases: results, failure: failure ? String(failure) : null, retainedBytes: bytes,
  wholeDomainProof: "NOT_YET_CHECKED", originalFailuresRetained: true, noSampledUniversalClaim: true,
});
if (failure) process.exitCode = 1;
