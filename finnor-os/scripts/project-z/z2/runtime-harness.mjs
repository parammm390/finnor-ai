import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile), [root, bin, out] = process.argv.slice(2);
assert([root, bin, out].every(isAbsolute));
await mkdir(out, { recursive: false });
const a = await import(pathToFileURL(resolve(bin, "process-a.mjs")).href),
  b = await import(pathToFileURL(resolve(bin, "process-b.mjs")).href);
const ra = await a.coalitionProductRuntime(), rb = await b.coalitionProductRuntime();
assert.equal(ra.semanticDigest, rb.semanticDigest);
assert.notEqual(ra.executionOwnerPin.path, rb.executionOwnerPin.path);
assert(ra.executionOwnerPin.path.startsWith(bin+"/") && rb.executionOwnerPin.path.startsWith(bin+"/"));
assert(ra.math.assets.some(p => p.path === ra.executionOwnerPin.path));
assert(ra.ownerPins.some(p => p.path.includes("orchestration/")));
assert(ra.ownerPins.some(p => p.path.endsWith("InteractionProtocolPanel.tsx")));
const results = [];
for (const family of [1, 2, 3, 18, 30]) {
  const { stdout } = await run("/usr/bin/python3", ["-I", "-B",
    resolve(root, "finnor-os/scripts/project-z/z2/structural-fixtures.py"), "--family", String(family)],
    { env: { NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, maxBuffer: 4194304 });
  const problem = JSON.parse(stdout), deadline = Date.now()+120000;
  const construction = await b.constructCoalitions(problem, deadline, rb.math);
  const check = await a.independentlyCheckCoalitions(problem, construction, deadline, ra.math);
  assert.equal(check.status, family === 30 ? "CHECKED_INFEASIBLE" : "CHECKED_CANDIDATE");
  if (construction.candidate) {
    const native = await a.independentlyCheckNative(problem, construction.candidate, deadline, await a.nativeRuntimeIdentity());
    assert.equal(native.status, "CHECKED");
    await writeFile(resolve(out, family+"-native.json"), JSON.stringify(native, null, 2)+"\n");
  }
  await writeFile(resolve(out, family+"-construction.json"), JSON.stringify(construction, null, 2)+"\n");
  await writeFile(resolve(out, family+"-check.json"), JSON.stringify(check, null, 2)+"\n");
  results.push({ family, participants: problem.participants.length, status: check.status });
}
const profilePath = resolve(root, "finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions/profile.json"),
  original = await readFile(profilePath);
try {
  await writeFile(profilePath, Buffer.concat([original, Buffer.from("\n")]));
  const drift = await b.coalitionProductRuntime();
  assert.notEqual(drift.semanticDigest, rb.semanticDigest);
} finally { await writeFile(profilePath, original); }
assert.equal((await b.coalitionProductRuntime()).semanticDigest, rb.semanticDigest);
await writeFile(resolve(out, "report.json"), JSON.stringify({
  schema: "finnor.project-z.z2.installed-process-harness.v1", passed: true, results,
  apiLikeRuntime: ra, workerLikeRuntime: rb, actualOwnerServicesExecuted: false,
  immutableInputBoundary: true, dependencyInstall: "SEPARATE_LOCKED", authenticatedOwner: "NOT_RUN",
  physicalRecovery: "NOT_RUN", protectedAdmission: false }, null, 2)+"\n");
console.log(JSON.stringify({ passed: true, cases: results.length, semanticDigest: ra.semanticDigest }));
