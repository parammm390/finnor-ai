import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [target, mode] = process.argv.slice(2);
if (!target || !["api", "worker"].includes(mode)) throw new Error("Installed target and api/worker mode are required");
const pack = resolve(target, "pack"), proof = resolve(target, "proof");
const runtime = await import(pathToFileURL(resolve(pack, "bin", mode+"-runtime.mjs")).href);
const product = await runtime.coalitionProductRuntime();
const save = async (name, value) => writeFile(resolve(proof, name), JSON.stringify(value, null, 2)+"\n", { flag: "wx" });
await save(mode+"-runtime.json", product);
if (mode === "api") {
  console.log(JSON.stringify({ mode, semanticDigest: product.semanticDigest, installedProcessOnly: true }));
} else {
  const cases = [];
  const record = (id, passed, observation) => cases.push({ id, passed, observation });
  const api = JSON.parse(await readFile(resolve(proof, "api-runtime.json"), "utf8"));
  record("api-worker-same-semantic-runtime", api.semanticDigest === product.semanticDigest,
    { api: api.semanticDigest, worker: product.semanticDigest });
  record("separate-emitted-execution-pins", api.digest !== product.digest &&
    api.executionOwnerPin.path !== product.executionOwnerPin.path,
    { api: api.executionOwnerPin, worker: product.executionOwnerPin });
  record("declared-installed-asset-closure",
    [...product.math.assets, ...api.math.assets].every(p => p.path.startsWith(pack+"/")) &&
    product.math.python.path === "/usr/bin/python3", { sourceFallbackUsed: false, interpreter: product.math.python });
  const zod = import.meta.resolve("zod");
  record("fresh-installed-dependency-resolution", zod.startsWith(pathToFileURL(resolve(pack, "node_modules")).href+"/"), { zod });
  const input = JSON.parse(await readFile(resolve(target, "inputs", "dynamic.json"), "utf8"));
  const deadline = Date.now()+input.budgetMs;
  const construction = await runtime.constructCoalitions(input.problem, deadline, product.math);
  await save("construction.json", construction);
  record("installed-authorized-construction", construction.status === "CANDIDATE" &&
    Object.values(construction.candidate?.policy ?? {}).every(p => p === "authorized"), { status: construction.status });
  const nativeRuntime = await runtime.nativeRuntimeIdentity();
  const native = await runtime.independentlyCheckNative(input.problem, construction.candidate, deadline, nativeRuntime);
  await save("native-check.json", native);
  record("fresh-full-native-y3-process", native.status === "CHECKED" && native.globalBeliefConsistency === true &&
    native.fullDeviationCoverage === true, { status: native.status, reason: native.reason });
  const checked = await runtime.independentlyCheckCoalitions(input.problem, construction, deadline, product.math);
  await save("coalition-check.json", checked);
  record("fresh-complete-coalition-process", checked.status === "CHECKED_CANDIDATE" &&
    checked.allModels === true && checked.allNonemptyCoalitions === true,
    { status: checked.status, reason: checked.reason, sameOriginalDeadline: deadline });
  for (const [file, name, status, reason] of [
    ["mixture.json", "exact-mixture-quarter", "COUNTEREXAMPLE", "Z2_CHECKED_PROFITABLE_CORRELATED_MIXTURE"],
    ["pooling.json", "private-pooling", "COUNTEREXAMPLE", "Z2_LOCAL_PLAN_DOMAIN"],
    ["native-floor.json", "weakened-native-floor", "COUNTEREXAMPLE", "Z2_NATIVE_FULL_Y3_FLOOR"],
    ["impossible.json", "whole-original-family", "CHECKED_INFEASIBLE", "Z2_ORIGINAL_FAMILY_INFEASIBILITY_CHECKED"]
  ]) {
    const request = JSON.parse(await readFile(resolve(target, "inputs", file), "utf8"));
    const result = await runtime.independentlyCheckCoalitions(request.problem, request.construction, Date.now()+20000, product.math);
    await save(name+".json", result);
    record("installed-"+name, result.status === status && result.reason === reason &&
      (name !== "exact-mixture-quarter" ||
        JSON.stringify(result.counterstrategy?.gains) === JSON.stringify(["1/4", "1/4"])),
      { status: result.status, reason: result.reason });
  }
  try {
    await runtime.constructCoalitions(input.problem, Date.now()-1, product.math);
    record("expired-original-deadline", false, "Unexpected construction");
  } catch (error) {
    record("expired-original-deadline", error.message === "Z2_ORIGINAL_DEADLINE_OR_ABORT", { code: error.message });
  }
  const checkerPath = resolve(pack, "finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions/checker.py");
  const bytes = await readFile(checkerPath);
  try {
    await appendFile(checkerPath, "\n# Owned disposable installed-runtime drift injection.\n");
    const changed = await runtime.coalitionProductRuntime();
    record("source-change-invalidates-marker-semantics", changed.semanticDigest !== product.semanticDigest,
      { original: product.semanticDigest, changed: changed.semanticDigest });
    try {
      await runtime.constructCoalitions(input.problem, Date.now()+20000, product.math);
      record("stale-runtime-dispatch-rejected", false, "Unexpected construction");
    } catch (error) {
      record("stale-runtime-dispatch-rejected", error.message === "Z2_RUNTIME_PIN_CHANGED", { code: error.message });
    }
  } finally { await writeFile(checkerPath, bytes); }
  record("owned-injection-restored", (await runtime.coalitionProductRuntime()).digest === product.digest, { restored: true });
  const report = { schema: "finnor.project-z.z2.installed-process-development.v1",
    cases, passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed).length,
    authenticatedOwner: "NOT_RUN", nativePhysicalRecovery: "NOT_RUN", mountedWork: "NOT_RUN",
    installedWholeOwnerReconstruction: "INCOMPLETE", protectedAdmission: false,
    scope: "Separately installed declared process/assets; not an authenticated native owner proof" };
  await save("report.json", report);
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, scope: report.scope }));
  process.exitCode = report.failed ? 1 : 0;
}
