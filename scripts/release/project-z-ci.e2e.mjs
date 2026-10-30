import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { classifyPullRequestFiles, evaluateRequiredPrVerdict } from "./pr-verdict-policy.mjs"
import { verifyCiProcess, workflowJob } from "./ci-process-policy.mjs"

// Failure-first workflow process exercise. This does not claim hosted execution.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
for (const path of ["scope-z/phase-evidence/z3/frozen-public-cases-v2.json",
  "scripts/project-z/run-ci.mjs", "docs/centropy/project-z-delivery-failure-modes.md"]) {
  assert.equal(classifyPullRequestFiles([path]).backend, true, "PROJECT_Z_INPUT_CHANGE_MUST_REQUIRE_BACKEND_PROCESS_CHECKS: " + path)
}
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
const nativeJob = workflowJob(ci, "project-z-owner-smoke")
assert.ok(nativeJob.includes("node scripts/project-z/run-native-ci.mjs"), "PROJECT_Z_REAL_OWNER_PROCESS_JOB_MISSING")
assert.ok(!/^ {4}if:/m.test(nativeJob), "PROJECT_Z_REAL_OWNER_JOB_MUST_NOT_BE_OPTIONAL")
const job = workflowJob(ci, "project-z-public")
assert.ok(job.includes("node scripts/project-z/run-ci.mjs"), "PROJECT_Z_REQUIRED_PROCESS_JOB_MISSING")
assert.ok(job.includes("phase: [z1, z2, z3, z4]"), "PROJECT_Z_COMPLETE_PUBLIC_MATRIX_MISSING")
assert.ok(job.includes("fail-fast: false"), "PROJECT_Z_INDEPENDENT_RESULTS_MUST_BE_COLLECTED")
assert.ok(!/^\s{4}if:/m.test(job), "PROJECT_Z_REQUIRED_JOB_MUST_NOT_BE_OPTIONAL")
assert.deepEqual(verifyCiProcess(root).failures, [])
const input = {
  files: ["finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/engine.ts"],
  classifyResult: "success", sourceResult: "success", backendApplicable: true,
  backendResult: "success", rootApplicable: false, rootResult: "skipped",
  dependencyApplicable: false, securityResult: "success", replayResult: "success", readinessResult: "success",
}
assert.equal(evaluateRequiredPrVerdict(input).verdict.verdict, "PASS")
const rows = []
for (const outcome of ["failure", "cancelled", "skipped", undefined]) {
  assert.equal(evaluateRequiredPrVerdict({ ...input, backendResult: outcome }).verdict.verdict, "FAIL")
  rows.push({ case: "required-backend-project-z-" + String(outcome), rejected: true })
}
const damaged = mkdtempSync(join(tmpdir(), "finnor-project-z-workflow-"))
mkdirSync(join(damaged, ".github/workflows"), { recursive: true })
for (const file of readdirSync(join(root, ".github/workflows"))) {
  if (!/\.ya?ml$/.test(file)) continue
  const body = readFileSync(join(root, ".github/workflows", file), "utf8")
  writeFileSync(join(damaged, ".github/workflows", file), file === "ci.yml"
    ? body.replace(/^  project-z-public:\n[\s\S]*?(?=^  [\w-]+:|(?![\s\S]))/m, "") : body)
}
assert.ok(verifyCiProcess(damaged).failures.some(value => value.includes("Project Z")))
rows.push({ case: "removed-project-z-job", rejected: true })
const receipt = {
  schema: "finnor.project-z.ci-process-e2e.v1", status: "PASS",
  workflowSha256: createHash("sha256").update(ci).digest("hex"),
  rows, hostedExecutionClaimed: false, nativeAcceptanceClaimed: false, wholePhaseAccepted: false,
}
const evidence = process.env.FINNOR_CI_PROCESS_EVIDENCE_DIR
if (evidence) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, "project-z-ci-process.json"), JSON.stringify(receipt, null, 2) + "\n")
}
console.log(JSON.stringify(receipt))
