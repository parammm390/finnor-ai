/** Pre-implementation boundary controls. Synthetic receipt acceptance is only
 * parser coverage, never a native episode, installed qualification or release. */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
assert([4, 6].includes(args.length) && args[0] === "--source" && args[2] === "--output"
  && isAbsolute(args[1]) && isAbsolute(args[3]) && (args.length === 4 ||
    args[4] === "--legacy-sha" && /^[a-f0-9]{40}$/.test(args[5])), "ABSOLUTE_SOURCE_AND_NEW_OUTPUT_REQUIRED");
const [source, output] = [args[1], args[3]];
mkdirSync(output, { mode: 0o700 });
const yaml = createRequire(join(source, "package.json"))("js-yaml");
const sha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const legacySha = args[5] ?? sha;
const checks = [];
const check = async (id, run) => {
  try { await run(); checks.push({ id, status: "PASS" }); }
  catch (error) { checks.push({ id, status: "FAIL", code: error.code ?? error.name }); }
};
const digest = value => createHash("sha256").update(value).digest("hex");
const write = (root, path, value) => {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
const read = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const mutate = (root, path, change) => { const value = read(root, path); change(value); write(root, path, value); };
const shell = (body, environment, id) => spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", body], {
  cwd: source, encoding: "utf8", timeout: 3000, maxBuffer: 65536,
  env: { PATH: "/usr/bin:/bin", LANG: "C", GITHUB_SHA: sha, GITHUB_RUN_ID: "0", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_STEP_SUMMARY: join(output, id + ".summary"), GITHUB_OUTPUT: join(output, id + ".outputs"), ...environment },
});
const workflow = yaml.load(readFileSync(join(source, ".github/workflows/production-release.yml"), "utf8"));
const original = yaml.load(execFileSync("git", ["-C", source, "show", legacySha + ":.github/workflows/production-release.yml"], { encoding: "utf8" }));

await check("release-original-authority-and-prerequisites-preserved", () => {
  for (const key of ["on", "permissions", "concurrency"]) assert.deepEqual(workflow[key], original[key]);
  for (const name of ["source-release-gate", "backend-release-gate", "security-release-gate",
    "readiness-release-gate", "root-release-gate", "release"]) assert.deepEqual(workflow.jobs[name], original.jobs[name]);
});
await check("release-strict-gate-is-required-by-certification", () => {
  assert(workflow.jobs["release-profile"] && workflow.jobs["phase-w-release-gate"]);
  assert(workflow.jobs["post-merge-certification"].needs.includes("release-profile"));
  assert(workflow.jobs["post-merge-certification"].needs.includes("phase-w-release-gate"));
  assert(workflow.jobs["phase-w-release-gate"].if.includes("PHASE_W_FULL_PRD"));
});
const certification = workflow.jobs["post-merge-certification"].steps[0].run;
const base = { READINESS_RESULT: "success", ROOT_RESULT: "success", SOURCE_RESULT: "success",
  BACKEND_RESULT: "success", SECURITY_RESULT: "success", PROFILE_SELECTION_RESULT: "success",
  SELECTED_SOURCE_SHA: sha, RELEASE_PROFILE: "LEGACY_VERIFIED_MARKER_ABSENT", PHASE_W_RESULT: "skipped",
  NATIVE_CONTROLLED_DEV_RESULT: "PASS_CONTROLLED_SHARED_COMPANY_NATIVE_OWNERS" };
for (const [id, override, pass] of [
  ["legacy-verified-absent-still-certifies", {}, true],
  ["full-prd-only-real-strict-success-can-certify", { RELEASE_PROFILE: "PHASE_W_FULL_PRD", PHASE_W_RESULT: "success" }, true],
  ...["failure", "skipped", "cancelled", ""].map(result => ["full-prd-native-pass-does-not-replace-" + (result || "missing") + "-strict-gate",
    { RELEASE_PROFILE: "PHASE_W_FULL_PRD", PHASE_W_RESULT: result }, false]),
  ["failed-selector-never-falls-back", { PROFILE_SELECTION_RESULT: "failure" }, false],
  ["mismatched-source-sha-refuses", { SELECTED_SOURCE_SHA: "0".repeat(40) }, false],
  ["unknown-profile-never-falls-back", { RELEASE_PROFILE: "unknown" }, false],
  ["empty-profile-never-falls-back", { RELEASE_PROFILE: "" }, false],
  ...["READINESS_RESULT", "ROOT_RESULT", "SOURCE_RESULT", "BACKEND_RESULT", "SECURITY_RESULT"]
    .map(key => ["legacy-original-" + key.toLowerCase() + "-still-required", { [key]: "failure" }, false]),
]) await check(id, () => {
  const actual = shell(certification, { ...base, ...override }, id);
  assert.equal(actual.error, undefined); assert.equal(actual.status === 0, pass);
});
await check("full-prd-missing-proofs-actually-exits-blocked", () => {
  const hold = workflow.jobs["phase-w-release-gate"]?.steps.find(step => step.id === "hold");
  assert(hold?.run, "STRICT_RELEASE_HOLD_NOT_IMPLEMENTED");
  const result = shell(hold.run, { CANDIDATE_SHA: sha }, "strict-hold");
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
  assert((result.stdout + result.stderr).includes("PHASE_W_RELEASE_BLOCKED"));
});

let parse;
await check("release-marker-classifier-implemented", async () => {
  ({ parsePhaseWReleaseCandidate: parse } = await import(pathToFileURL(join(source, "scripts/release/phase-w-release-profile.mjs"))));
  assert.equal(typeof parse, "function");
});
if (parse) {
  const marker = { schema: "finnor.w.release-candidate.v1", releaseProfile: "PHASE_W_FULL_PRD" };
  await check("marker-absence-selects-verified-legacy-profile", () => assert.equal(parse(undefined), "LEGACY_VERIFIED_MARKER_ABSENT"));
  await check("marker-exact-full-prd-selects-phase-w", () => assert.equal(parse(JSON.stringify(marker)), "PHASE_W_FULL_PRD"));
  for (const [id, text] of [
    ["invalid-json", "{"], ["null", "null"], ["array", "[]"], ["empty", "{}"],
    ["unknown-schema", JSON.stringify({ ...marker, schema: "unknown" })],
    ["unknown-profile", JSON.stringify({ ...marker, releaseProfile: "NativeControlledDEV" })],
    ["extra-key", JSON.stringify({ ...marker, legacyFallback: true })],
    ["nonstring-profile", JSON.stringify({ ...marker, releaseProfile: false })],
    ["duplicate-key", '{"schema":"finnor.w.release-candidate.v1","releaseProfile":"PHASE_W_FULL_PRD","releaseProfile":"PHASE_W_FULL_PRD"}'],
  ]) await check("marker-" + id + "-refuses-no-fallback", () => assert.throws(() => parse(text)));
}

const engines = ["W1", "W2", "W3", "W4", "W5"];
const schemas = ["finnor.orchestration-policy-capsule.v1", "finnor.workforce-execution-program.v1",
  "finnor.real-world-service.v1", "finnor.market-validated-operating-program.v1", "finnor.organization-transformation-program.v1"];
const predicates = ["W049-W1-actual-capsule-native-consumption", "W049-W2-actual-workforce-native-consumption",
  "W049-W3-actual-service-native-consumption", "W049-W4-actual-market-native-consumption",
  "W049-W5-actual-organization-native-consumption", "W049-shared-business-original-custody"];
const caller = yaml.load(readFileSync(join(source, ".github/workflows/phase-w-verification.yml"), "utf8"));
const nativeWorkflow = yaml.load(readFileSync(join(source, ".github/workflows/phase-w-native-episode.yml"), "utf8"));
await check("native-main-and-integration-pr-route-not-w3-feature-only", () => {
  assert(caller.on.push.branches.includes("main"));
  assert(Object.hasOwn(caller.on, "workflow_call") && Object.hasOwn(caller.on, "pull_request"));
  assert(caller.on.pull_request.paths.includes("finnor-os/**") && caller.on.pull_request.paths.includes(".github/workflows/**"));
});
await check("native-caller-reuses-actual-existing-workflow-interfaces", () => {
  for (const job of Object.values(caller.jobs).filter(value => value.uses)) {
    assert(job.uses.startsWith("./.github/workflows/"));
    const child = yaml.load(readFileSync(join(source, job.uses), "utf8"));
    assert(Object.hasOwn(child.on, "workflow_call"));
    for (const input of Object.keys(job.with ?? {})) assert(Object.hasOwn(child.on.workflow_call.inputs, input));
    assert.equal(job["continue-on-error"], undefined);
    assert.equal(job.secrets, undefined);
  }
});
await check("native-artifact-upload-is-exact-two-safe-staged-projections", () => {
  const steps = nativeWorkflow.jobs.native.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.deepEqual(steps.map(step => step.with.path), [
    "${{ runner.temp }}/phase-w-native-public/native-ci-public.json",
    "${{ runner.temp }}/phase-w-native-public/types-ci-public.json"]);
  assert.equal(steps.length, 2);
  for (const step of steps) assert.equal(step.if, "${{ always() && steps.stage_public.outcome == 'success' }}");
  assert.equal(caller.jobs["w3-only-installed-headed-cold"].uses, "./.github/workflows/w3-owning-qualification.yml");
  assert(!caller.jobs["native-controlled-dev"].needs.includes("w3-only-installed-headed-cold"));
});
await check("native-public-staging-runs-independently-even-after-upstream-failure", () => {
  const stage = nativeWorkflow.jobs.native.steps.find(step => step.id === "stage_public");
  assert.equal(stage.if, "${{ always() }}");
  assert(stage.run.includes("scripts/postz/phase-w-ci/stage-native-evidence.mjs"));
  assert.equal(stage.env.NATIVE_OUTCOME, "${{ steps.native_run.outcome }}");
  assert.equal(stage.env.VERIFIER_OUTCOME, "${{ steps.native_receipts.outcome }}");
  assert.equal(stage.env.TYPES_OUTCOME, "${{ steps.owner_types.outcome }}");
  assert(nativeWorkflow.jobs.native.steps.some(step => step.id === "native_run"));
  assert(nativeWorkflow.jobs.native.steps.some(step => step.id === "native_receipts"));
  assert(nativeWorkflow.jobs.native.steps.some(step => step.id === "owner_types"));
});
await check("safe-staging-success-is-not-a-native-pass", () => {
  const gate = nativeWorkflow.jobs.native.steps.find(step => step.id === "public_verdict");
  assert.equal(gate.if, "${{ always() }}");
  assert.equal(gate.env.STAGING_RESULT, "${{ steps.stage_public.outcome }}");
  assert.equal(gate.env.NATIVE_STATUS, "${{ steps.stage_public.outputs.native_status }}");
  assert.equal(gate.env.TYPES_STATUS, "${{ steps.stage_public.outputs.types_status }}");
  for (const field of ["STAGING_RESULT", "NATIVE_STATUS", "TYPES_STATUS"]) {
    const base = { STAGING_RESULT: "success", NATIVE_STATUS: "PASS_CONTROLLED_NATIVE_RECEIPTS", TYPES_STATUS: "PASS_COMPLETE_PROGRAM_DIAGNOSTICS" };
    assert.equal(shell(gate.run, base, "public-verdict-positive-" + field).status, 0);
    for (const value of ["failure", "skipped", "cancelled", ""]) assert.notEqual(
      shell(gate.run, { ...base, [field]: value }, "public-verdict-negative-" + field + "-" + (value || "missing")).status, 0);
  }
});
await check("boundary-cli-is-mandatory-in-actual-workflow-graph", () => {
  const job = caller.jobs["ci-boundary-controls"];
  const step = job.steps.find(step => step.run?.includes("check-ci-boundaries.mjs"));
  assert(step && !step.if && !step["continue-on-error"]);
  assert(step.run.includes("--source") && step.run.includes("--output"));
  assert(caller.jobs["combined-native-owners"].needs.includes("ci-boundary-controls"));
});
await check("native-unused-workflow-and-job-output-plumbing-removed", () => {
  assert.equal(caller.on.workflow_call?.outputs, undefined);
  assert.equal(caller.jobs["native-controlled-dev"].outputs, undefined);
  assert(!caller.jobs["native-controlled-dev"].steps[0].run.includes("GITHUB_OUTPUT"));
});
const nativeInputs = { SOURCE_RESULT: "source-checks", CI_BOUNDARIES: "ci-boundary-controls", W1_POSITIVE: "w1-native-positive", W1_REGRESSIONS: "w1-owning-regressions",
  W2_POSITIVE: "w2-compensation-positive", W2_CONTROLS: "w2-compensation-controls", W3_FAST: "w3-fast-owner",
  W3_NATIVE: "w3-native-and-publication", COMBINED_NATIVE: "combined-native-owners" };
const nativeStep = caller.jobs["native-controlled-dev"].steps[0];
await check("native-controller-binds-each-actual-required-job-result", () => {
  assert.deepEqual([...caller.jobs["native-controlled-dev"].needs].sort(), Object.values(nativeInputs).sort());
  assert(caller.jobs["native-controlled-dev"].if.includes("always()"));
  for (const [name, job] of Object.entries(nativeInputs)) assert.equal(nativeStep.env[name], "${{ needs." + job + ".result }}");
});
const nativeSuccess = Object.fromEntries(Object.keys(nativeInputs).map(key => [key, "success"]));
await check("native-controller-actual-shell-all-success-only", () => {
  const result = shell(nativeStep.run, nativeSuccess, "native-controller-positive");
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
});
for (const name of Object.keys(nativeInputs)) for (const state of ["failure", "cancelled", "skipped", ""]) {
  const id = "native-controller-" + name.toLowerCase() + "-" + (state || "missing");
  await check(id, () => {
    const result = shell(nativeStep.run, { ...nativeSuccess, [name]: state }, id);
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
  });
}
const profile = { schema: "finnor.w.integrated-owner-profile.v1", requirements: "FINNOR-POSTZ-W-PRD-1.0.0",
  classification: "CONTROLLED_DEV_SHARED_COMPANY_REAL_NATIVE_OWNERS", aggregateSeconds: 7200,
  w3ObserverSeconds: 1200, w1ProgrammeObserverSeconds: 120,
  rationale: "Parser fixture only, no native owners were executed.", admitted: false, productionActive: false, fieldValidated: false };
const scope = { tenantId: randomUUID(), principalId: randomUUID(), companyId: randomUUID(),
  originalServiceWorkId: randomUUID(), originalServiceWorkInputId: randomUUID() };
const fixture = join(output, "fixture-only-base");
mkdirSync(fixture, { mode: 0o700 });
const outputs = engines.map((engine, index) => {
  const privatePath = "integrated/" + engine.toLowerCase() + "/private-native-output.json";
  const publicPath = "integrated/" + engine.toLowerCase() + "/actual-native-output.json";
  const native = { engine, schema: schemas[index], tenantId: scope.tenantId, principalId: scope.principalId, companyId: scope.companyId,
    workId: engine === "W3" ? scope.originalServiceWorkId : randomUUID(),
    workInputId: engine === "W3" ? scope.originalServiceWorkInputId : randomUUID(), requestId: randomUUID(),
    ref: { owner: engine, id: randomUUID(), version: "1", contentDigest: digest(engine) },
    consumedBy: { owner: engine + "/native-owner", fixtureWitnessId: randomUUID() },
    evidence: { fixtureOnly: true, actualNativeExecution: false } };
  write(fixture, privatePath, native);
  const { consumedBy, evidence: privateEvidence, ...identity } = native;
  assert(privateEvidence.fixtureOnly);
  const sanitized = { ...identity, consumedBy: { owner: consumedBy.owner, evidenceSha256: digest(JSON.stringify(consumedBy)) },
    privateEvidenceSha256: digest(readFileSync(join(fixture, privatePath))),
    qualification: "CONTROLLED_NATIVE_OWNER_CONSUMPTION_NOT_FIELD_OR_FULL_COST",
    completeMonetaryCost: null, independentProtectedCustody: false };
  write(fixture, publicPath, sanitized);
  return { ...sanitized, evidence: { path: publicPath, sha256: digest(readFileSync(join(fixture, publicPath))) } };
});
const results = predicates.map((id, index) => ({ id, status: "PASS",
  evidencePaths: [index === 5 ? "integrated/native-consumption.json" : outputs[index].evidence.path] }));
const cleanup = { status: "PASS", steps: ["owned-worker", "recipient", "authentication", "application-pool", "database-admin", "owned-postgres"]
  .map(name => ({ name, status: "PASS" })) };
write(fixture, "integrated/profile.json", profile);
write(fixture, "integrated/result.json", { schema: "finnor.w.integrated-native-e2e.v1", status: "PASS_CONTROLLED_SHARED_COMPANY_NATIVE_OWNERS",
  startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:01.000Z", elapsedMs: 1000, exitCode: 0,
  profile, scope, outputs, results, cleanup, completionGate: "PHASE_W_RELEASE_BLOCKED",
  admitted: false, productionActive: false, fieldValidated: false, fullPrdW049Satisfied: false, w050ThroughW053Satisfied: false });
write(fixture, "integrated/native-consumption.json", { schema: "finnor.w.integrated-native-consumption.v1",
  status: "PASS_NATIVE_CONSUMPTION", profileClassification: profile.classification, scope, outputs, results,
  originalCustody: outputs.map(item => ({ engine: item.engine, workId: item.workId, workInputId: item.workInputId,
    workStatus: "ACTIVE", initialInstructionSha256: digest("fixture-instruction-" + item.engine),
    originalInputSha256: digest("fixture-input-" + item.engine) })),
  completeMonetaryCost: null, independentProtectedCustody: false, admitted: false, productionActive: false, fieldValidated: false });
let verify;
await check("native-receipt-verifier-implemented", async () => {
  ({ verifyNativeEvidence: verify } = await import(pathToFileURL(join(source, "finnor-os/scripts/postz/phase-w-ci/native-evidence.mjs"))));
  assert.equal(typeof verify, "function");
});
if (verify) {
  await check("fixture-only-consistent-receipts-parse-not-native-proof", async () => {
    const result = await verify(fixture);
    assert.equal(result.files.length, 8);
  });
  const mutations = [
    ["missing-terminal", root => unlinkSync(join(root, "integrated/result.json"))],
    ["missing-public-output", root => unlinkSync(join(root, "integrated/w4/actual-native-output.json"))],
    ["missing-private-output", root => unlinkSync(join(root, "integrated/w2/private-native-output.json"))],
    ["fail-closed-status", root => mutate(root, "integrated/result.json", v => { v.status = "FAIL_CLOSED"; })],
    ["nonzero-terminal-exit", root => mutate(root, "integrated/result.json", v => { v.exitCode = 1; })],
    ["missing-engine", root => mutate(root, "integrated/result.json", v => { v.outputs.pop(); })],
    ["duplicate-engine", root => mutate(root, "integrated/result.json", v => { v.outputs[4] = v.outputs[0]; })],
    ["reordered-engines", root => mutate(root, "integrated/result.json", v => { v.outputs.reverse(); })],
    ["wrong-w3-schema", root => mutate(root, "integrated/result.json", v => { v.outputs[2].schema = "finnor.real-world-service-program.v1"; })],
    ["missing-predicate", root => mutate(root, "integrated/result.json", v => { v.results.pop(); })],
    ["duplicate-predicate", root => mutate(root, "integrated/result.json", v => { v.results[5] = v.results[0]; })],
    ["not-run-predicate", root => mutate(root, "integrated/result.json", v => { v.results[4].status = "NOT_RUN"; })],
    ["wrong-evidence-path", root => mutate(root, "integrated/result.json", v => { v.results[0].evidencePaths = ["../../outside.json"]; })],
    ["public-hash-changed", root => mutate(root, "integrated/w1/actual-native-output.json", v => { v.ref.version = "2"; })],
    ["private-hash-changed", root => mutate(root, "integrated/w5/private-native-output.json", v => { v.evidence.extra = true; })],
    ["consumer-witness-changed", root => mutate(root, "integrated/result.json", v => { v.outputs[0].consumedBy.evidenceSha256 = "0".repeat(64); })],
    ["cross-company", root => mutate(root, "integrated/result.json", v => { v.outputs[4].companyId = randomUUID(); })],
    ["cross-tenant", root => mutate(root, "integrated/result.json", v => { v.outputs[1].tenantId = randomUUID(); })],
    ["cross-principal", root => mutate(root, "integrated/result.json", v => { v.outputs[2].principalId = randomUUID(); })],
    ["original-service-input-changed", root => mutate(root, "integrated/result.json", v => { v.scope.originalServiceWorkInputId = randomUUID(); })],
    ["missing-original-custody", root => mutate(root, "integrated/native-consumption.json", v => { v.originalCustody.pop(); })],
    ["original-work-input-changed", root => mutate(root, "integrated/native-consumption.json", v => { v.originalCustody[0].workInputId = randomUUID(); })],
    ["null-scope", root => mutate(root, "integrated/result.json", v => { v.scope = null; })],
    ["classification-changed", root => mutate(root, "integrated/result.json", v => { v.profile.classification = "production"; })],
    ["aggregate-bound-increased", root => mutate(root, "integrated/result.json", v => { v.profile.aggregateSeconds++; })],
    ["w3-bound-increased", root => mutate(root, "integrated/result.json", v => { v.profile.w3ObserverSeconds++; })],
    ["w1-bound-increased", root => mutate(root, "integrated/result.json", v => { v.profile.w1ProgrammeObserverSeconds++; })],
    ["cleanup-missing", root => mutate(root, "integrated/result.json", v => { v.cleanup.steps.pop(); })],
    ["cleanup-failed", root => mutate(root, "integrated/result.json", v => { v.cleanup.steps[0].status = "FAIL"; })],
    ["release-ready-claim", root => mutate(root, "integrated/result.json", v => { v.completionGate = "READY"; })],
    ["field-claim", root => mutate(root, "integrated/result.json", v => { v.fieldValidated = true; })],
    ["full-prd-claim", root => mutate(root, "integrated/result.json", v => { v.fullPrdW049Satisfied = true; })],
    ["completed-cost-claim", root => mutate(root, "integrated/native-consumption.json", v => { v.completeMonetaryCost = 0; })],
    ["protected-custody-claim", root => mutate(root, "integrated/native-consumption.json", v => { v.independentProtectedCustody = true; })],
    ["public-raw-data-field", root => mutate(root, "integrated/result.json", v => { v.outputs[0].rawSql = "fixture-only"; })],
    ["symlink-public-output", root => {
      const file = join(root, "integrated/w3/actual-native-output.json");
      unlinkSync(file); symlinkSync(join(fixture, "integrated/w3/actual-native-output.json"), file);
    }],
  ];
  for (const [id, change] of mutations) await check("native-" + id + "-refuses", async () => {
    const destination = join(output, "fixture-only-" + id);
    cpSync(fixture, destination, { recursive: true, errorOnExist: true, force: false });
    change(destination);
    await assert.rejects(() => verify(destination));
  });
}
let stage;
await check("independent-public-stager-implemented", async () => {
  ({ stageNativeEvidence: stage } = await import(pathToFileURL(join(source, "finnor-os/scripts/postz/phase-w-ci/native-evidence.mjs"))));
  assert.equal(typeof stage, "function");
});
const types = join(output, "fixture-only-types");
mkdirSync(types, { mode: 0o700 });
write(types, "report.json", { schema: "finnor.w3.bounded-full-context-typecheck.v1", status: "PASS_COMPLETE_PROGRAM_DIAGNOSTICS",
  fixtureOnly: true, actualNativeExecution: false });
const canary = "sk-fixture-only-NEVER-EXPORT-RAW-SQL-OR-AUTH";
const stageCase = async (id, change, eligible, expected) => {
  assert.equal(typeof stage, "function");
  const input = join(output, "staging-input-" + id), typeInput = join(output, "staging-types-" + id);
  cpSync(fixture, input, { recursive: true, errorOnExist: true, force: false });
  cpSync(types, typeInput, { recursive: true, errorOnExist: true, force: false });
  if (change) change(input, typeInput);
  const staging = join(output, "staged-public-" + id);
  const result = await stage({ output: input, typeOutput: typeInput, staging, sourceSha: sha,
    nativeOutcome: "success", verifierOutcome: "success", typesOutcome: "success", ...eligible });
  assert.deepEqual(readdirSync(staging).sort(), ["native-ci-public.json", "types-ci-public.json"]);
  const native = read(staging, "native-ci-public.json"), typeReceipt = read(staging, "types-ci-public.json");
  assert.equal(native.status, expected);
  assert.equal(result.native.status, native.status);
  assert.equal(result.types.status, typeReceipt.status);
  assert.deepEqual(Object.keys(typeReceipt).sort(), ["schema", "status", "sourceSha", "originalReceiptSha256", "qualification"].sort());
  assert.deepEqual(Object.keys(native).sort(), ["schema", "status", "sourceSha", "classification", "completionGate",
    "admitted", "productionActive", "fieldValidated", "fullPrdW049Satisfied", "w050ThroughW053Satisfied", "files"].sort());
  assert.equal(native.completionGate, "PHASE_W_RELEASE_BLOCKED");
  assert.equal(native.admitted, false); assert.equal(native.productionActive, false); assert.equal(native.fieldValidated, false);
  assert.equal(native.files.length, expected === "PASS_CONTROLLED_NATIVE_RECEIPTS" ? 8 : 0);
  const serialized = ["native-ci-public.json", "types-ci-public.json"].map(path => readFileSync(join(staging, path), "utf8")).join("\n");
  assert(!serialized.includes(canary) && !serialized.includes("rawSql") && !serialized.includes("authSecret"));
  assert(!serialized.includes(scope.tenantId) && !serialized.includes(scope.principalId));
};
await check("staging-valid-fixture-is-safe-metadata-not-owner-execution", () => stageCase("positive", null, {}, "PASS_CONTROLLED_NATIVE_RECEIPTS"));
for (const field of ["nativeOutcome", "verifierOutcome", "typesOutcome"]) for (const state of ["failure", "skipped", "cancelled", ""]) {
  const id = field + "-" + (state || "missing");
  await check("staging-" + id + "-safe-failure", () => stageCase(id, null, { [field]: state }, "FAIL_CLOSED"));
}
for (const [id, change] of [
  ["malformed-json", root => writeFileSync(join(root, "integrated/result.json"), '{"authSecret":"' + canary + '"')],
  ["missing-terminal", root => unlinkSync(join(root, "integrated/result.json"))],
  ["missing-public", root => unlinkSync(join(root, "integrated/w5/actual-native-output.json"))],
  ["missing-private", root => unlinkSync(join(root, "integrated/w2/private-native-output.json"))],
  ["partial-terminal", root => mutate(root, "integrated/result.json", value => { value.status = "FAIL_CLOSED"; value.outputs.pop(); })],
  ["raw-auth-key", root => mutate(root, "integrated/result.json", value => { value.authSecret = canary; value.rawSql = canary; })],
  ["malformed-types", (_root, typeRoot) => writeFileSync(join(typeRoot, "report.json"), '{"authSecret":"' + canary + '"')],
  ["missing-types", (_root, typeRoot) => unlinkSync(join(typeRoot, "report.json"))],
]) await check("staging-" + id + "-contains-only-safe-failure", () => stageCase(id, change, {}, "FAIL_CLOSED"));
await check("staging-secret-in-valid-rationale-never-copied", () => stageCase("secret-rationale", root => {
  mutate(root, "integrated/profile.json", value => { value.rationale = canary; });
  mutate(root, "integrated/result.json", value => { value.profile.rationale = canary; });
}, {}, "PASS_CONTROLLED_NATIVE_RECEIPTS"));
await check("staging-secret-in-valid-opaque-reference-never-copied", () => stageCase("secret-reference", root => {
  const privatePath = "integrated/w1/private-native-output.json", publicPath = "integrated/w1/actual-native-output.json";
  mutate(root, privatePath, value => { value.ref.version = canary; });
  const publicOutput = read(root, publicPath);
  publicOutput.ref.version = canary;
  publicOutput.privateEvidenceSha256 = digest(readFileSync(join(root, privatePath)));
  write(root, publicPath, publicOutput);
  const receipt = { ...publicOutput, evidence: { path: publicPath, sha256: digest(readFileSync(join(root, publicPath))) } };
  for (const path of ["integrated/result.json", "integrated/native-consumption.json"]) mutate(root, path, value => { value.outputs[0] = receipt; });
}, {}, "PASS_CONTROLLED_NATIVE_RECEIPTS"));
await check("staging-secret-type-diagnostics-never-copied", () => stageCase("secret-type-diagnostics", (_root, typeRoot) =>
  mutate(typeRoot, "report.json", value => { value.authSecret = canary; value.diagnostics = [{ message: canary }]; }),
{}, "PASS_CONTROLLED_NATIVE_RECEIPTS"));
await check("staging-existing-root-preserves-others-files", async () => {
  assert.equal(typeof stage, "function");
  const staging = join(output, "staging-already-owned");
  mkdirSync(staging, { mode: 0o700 }); writeFileSync(join(staging, "sentinel"), canary);
  await assert.rejects(() => stage({ output: fixture, typeOutput: types, staging, sourceSha: sha,
    nativeOutcome: "success", verifierOutcome: "success", typesOutcome: "success" }));
  assert.deepEqual(readdirSync(staging), ["sentinel"]);
  assert.equal(readFileSync(join(staging, "sentinel"), "utf8"), canary);
});
await check("staging-input-tree-is-never-an-upload-destination", async () => {
  assert.equal(typeof stage, "function");
  await assert.rejects(() => stage({ output: fixture, typeOutput: types, staging: join(fixture, "public-stage"), sourceSha: sha,
    nativeOutcome: "success", verifierOutcome: "success", typesOutcome: "success" }));
});
await check("staging-symlink-root-does-not-touch-the-target", async () => {
  assert.equal(typeof stage, "function");
  const staging = join(output, "staging-symlink");
  symlinkSync(fixture, staging);
  const before = digest(readFileSync(join(fixture, "integrated/result.json")));
  await assert.rejects(() => stage({ output: fixture, typeOutput: types, staging, sourceSha: sha,
    nativeOutcome: "success", verifierOutcome: "success", typesOutcome: "success" }));
  assert.equal(digest(readFileSync(join(fixture, "integrated/result.json"))), before);
});
const report = { schema: "finnor.w.ci-boundary-controls.v1", status: checks.every(item => item.status === "PASS") ? "PASS" : "FAIL",
  sourceSha: sha, legacyBaselineSha: legacySha, suiteSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  fixtureOnly: true, actualNativeEpisodesRun: 0, installedQualificationRun: false,
  releaseAuthorized: false, checks };
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ...report, checks: checks.filter(item => item.status === "FAIL"), totalChecks: checks.length }));
process.exitCode = report.status === "PASS" ? 0 : 1;
