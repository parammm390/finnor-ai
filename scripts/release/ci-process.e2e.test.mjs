import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { changedPullRequestFiles, classifyPullRequestFiles, evaluateRequiredPrVerdict } from "./pr-verdict-policy.mjs"
import { verifyCiProcess } from "./ci-process-policy.mjs"
import { readGit } from "./worktree-state.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))
const records = []
const startedAt = new Date().toISOString()
test.after(() => {
  const evidence = process.env.FINNOR_CI_PROCESS_EVIDENCE_DIR
  if (!evidence) return
  const files = ["scripts/release/ci-process.e2e.test.mjs", "scripts/release/pr-verdict-policy.mjs", "scripts/release/ci-process-policy.mjs", "scripts/release/worktree-state.mjs"]
  const inputs = Object.fromEntries(files.map(path => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]))
  const receipt = { schema: "finnor.ci-process-e2e.v1", status: records.length === 4 ? "PASS" : "FAIL", startedAt, finishedAt: new Date().toISOString(), inputs, records, rerun: "FINNOR_CI_PROCESS_EVIDENCE_DIR=/absolute/new/evidence node --test scripts/release/ci-process.e2e.test.mjs", applicationTestsExecuted: false }
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, "process-e2e.json"), `${JSON.stringify(receipt, null, 2)}\n`)
})

test("actual Git PR diff excludes base drift and retains deleted and renamed code paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "finnor-ci-git-"))
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", timeout: 10_000 }).trim()
  const put = (path, bytes) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), bytes) }
  const commit = (message) => { git("add", "."); git("commit", "--quiet", "-m", message); return git("rev-parse", "HEAD") }
  try {
    git("init", "--quiet", "--initial-branch=main")
    git("config", "user.name", "FINNOR CI fixture")
    git("config", "user.email", "ci@example.invalid")
    put("src/renamed.ts", "export const original = 1\n")
    put("finnor-os/deleted.ts", "export const deleted = 1\n")
    const base = commit("base")
    git("checkout", "--quiet", "-b", "candidate")
    mkdirSync(join(directory, "docs"))
    git("mv", "src/renamed.ts", "docs/renamed.md")
    git("rm", "--quiet", "finnor-os/deleted.ts")
    put("docs/line\nbreak.md", "candidate\n")
    const head = commit("candidate")
    git("checkout", "--quiet", "main")
    put("public/base-only.txt", "base drift must not expand the PR\n")
    const movedBase = commit("base drift")
    const files = changedPullRequestFiles({ base: movedBase, head, cwd: directory })
    assert.deepEqual(files.sort(), ["docs/line\nbreak.md", "docs/renamed.md", "finnor-os/deleted.ts", "src/renamed.ts"].sort())
    assert.deepEqual(classifyPullRequestFiles(files), { backend: true, root: true, dependencies: false })
    assert.deepEqual(changedPullRequestFiles({ base, head: base, cwd: directory }), [])
    assert.throws(() => changedPullRequestFiles({ base: "main; exit 0", head, cwd: directory }), /full commit/)
    assert.throws(() => changedPullRequestFiles({ base: "a".repeat(40), head, cwd: directory }))
    records.push({ case: "real-git-diff", base, movedBase, head, observedFiles: files, renamedAndDeletedCodeRetained: true, baseDriftExcluded: true, invalidEndpointsRejected: true })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("stable verdict requires source checks and applicable Dealer Zero, including cancellation", () => {
  const input = { files: ["finnor-os/example.ts"], classifyResult: "success", sourceResult: "success", backendApplicable: true, backendResult: "success", rootApplicable: false, rootResult: "skipped", dependencyApplicable: false, securityResult: "success", replayResult: "success", readinessResult: "success" }
  assert.equal(evaluateRequiredPrVerdict(input).verdict.verdict, "PASS")
  for (const key of ["classifyResult", "sourceResult", "backendResult", "securityResult", "replayResult", "readinessResult"]) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.equal(evaluateRequiredPrVerdict({ ...input, [key]: result }).verdict.verdict, "FAIL", `${key}/${result}`)
    }
  }
  assert.equal(evaluateRequiredPrVerdict({ ...input, files: ["README.md"], backendApplicable: false, backendResult: "skipped", sourceResult: "skipped", replayResult: "skipped" }).verdict.verdict, "PASS")
  records.push({ case: "stable-verdict", successAccepted: true, applicableFailuresCancellationsAndSkipsRejected: 18, docsOnlyAccepted: true })
})

test("release Git reads succeed, refuse invalid repositories, and stop delayed subprocesses", () => {
  const directory = mkdtempSync(join(tmpdir(), "finnor-ci-git-deadline-"))
  try {
    assert.throws(() => readGit(["status", "--porcelain"], directory), /Git status failed/)
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory })
    assert.equal(readGit(["status", "--porcelain"], directory), "")
    const start = Date.now()
    const alias = `!exec "${process.execPath}" -e 'setTimeout(() => {}, 250)'`
    assert.throws(() => readGit(["-c", `alias.finnor-ci-delay=${alias}`, "finnor-ci-delay"], directory, { timeoutMs: 40 }), error => error.code === "ETIMEDOUT" && error.timedOut === true)
    const elapsedMs = Date.now() - start
    assert.ok(elapsedMs < 2_000, `Git deadline took ${elapsedMs}ms`)
    records.push({ case: "git-process-deadline", actualGitSuccess: true, invalidRepositoryRejected: true, timeoutMs: 40, observedMs: elapsedMs })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("actual process graph passes and damaged workflow copies are rejected", () => {
  assert.deepEqual(verifyCiProcess(root).failures, [])
  const mutations = [
    ["duplicate-main-trigger", "ci.yml", text => text.replace("  workflow_call:", "  push:\n    branches: [main]\n  workflow_call:")],
    ["unguarded-image-work", "pr-verdict.yml", text => text.replace("needs: [classify, source]", "needs: classify")],
    ["production-misses-security", "production-release.yml", text => text.replace(", security-release-gate", "")],
    ["production-cancelled", "production-release.yml", text => text.replace("cancel-in-progress: false", "cancel-in-progress: true")],
    ["missing-test-shard", "ci.yml", text => text.replace("shard: [1, 2, 3]", "shard: [1, 2]")],
    ["source-bypasses-workflow-validation", "source-checks.yml", text => text.replace("needs: validate", "needs: []")],
    ["missing-readiness-certification", "release-readiness.yml", text => text.replace("certification: [scope4, scope5]", "certification: [scope4]")],
  ]
  for (const [name, file, mutate] of mutations) {
    const directory = mkdtempSync(join(tmpdir(), `finnor-ci-${name}-`))
    try {
      cpSync(join(root, ".github/workflows"), join(directory, ".github/workflows"), { recursive: true })
      const path = join(directory, ".github/workflows", file)
      const before = readFileSync(path, "utf8")
      const after = mutate(before)
      assert.notEqual(before, after, `mutation ${name} must change its input`)
      writeFileSync(path, after)
      assert.ok(verifyCiProcess(directory).failures.length, name)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  records.push({ case: "actual-workflow-graph", baselineAccepted: true, rejectedMutations: mutations.map(([name]) => name) })
})
