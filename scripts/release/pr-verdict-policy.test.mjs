import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { classifyPullRequestFiles, decodeChangedFiles, encodeChangedFiles, evaluateRequiredPrVerdict } from "./pr-verdict-policy.mjs"
import { evaluateDependencyScan } from "./verify-dependency-scan.mjs"

function evaluate(files, results = {}) {
  const scope = classifyPullRequestFiles(files)
  return evaluateRequiredPrVerdict({
    files,
    classifyResult: "success",
    sourceResult: scope.backend || scope.root ? "success" : "skipped",
    backendApplicable: scope.backend,
    backendResult: scope.backend ? "success" : "skipped",
    rootApplicable: scope.root,
    rootResult: scope.root ? "success" : "skipped",
    dependencyApplicable: scope.dependencies,
    securityResult: "success",
    replayResult: scope.backend ? "success" : "skipped",
    readinessResult: scope.backend ? "success" : "skipped",
    ...results,
  })
}

test("docs-only and unrelated pull requests still receive a passing verdict with explicit N/A", () => {
  for (const files of [["README.md"], ["docs/architecture.md"], ["LICENSE"]]) {
    const { verdict, failures } = evaluate(files)
    assert.equal(verdict.verdict, "PASS")
    assert.deepEqual(failures, [])
    assert.deepEqual(verdict.gates.backend, { applicability: "N/A", result: "not_applicable" })
    assert.deepEqual(verdict.gates.root, { applicability: "N/A", result: "not_applicable" })
    assert.deepEqual(verdict.gates.gitleaks, { applicability: "REQUIRED_EVERY_PR", result: "success" })
  }
})

test("backend, root, workflow, and dependency scopes select only their applicable gates", () => {
  assert.deepEqual(classifyPullRequestFiles(["finnor-os/apps/api/index.ts"]), { backend: true, root: false, dependencies: false })
  assert.deepEqual(classifyPullRequestFiles(["src/app/page.tsx"]), { backend: false, root: true, dependencies: false })
  assert.deepEqual(classifyPullRequestFiles([".github/workflows/new.yml"]), { backend: true, root: true, dependencies: false })
  assert.deepEqual(classifyPullRequestFiles(["package-lock.json"]), { backend: true, root: true, dependencies: true })
  for (const path of ["finnor-os/scripts/r3/requirements.lock", "finnor-os/scripts/r3/upstream-requirements.lock"]) {
    assert.deepEqual(classifyPullRequestFiles([path]), { backend: true, root: false, dependencies: true })
  }
})

test("an applicable failure or universal secret-scan failure fails the stable verdict", () => {
  assert.deepEqual(evaluate(["finnor-os/index.ts"], { backendResult: "failure" }).failures, ["backend"])
  assert.deepEqual(evaluate(["README.md"], { securityResult: "failure" }).failures, ["universal security/gitleaks"])
})

test("native Rust dependency and toolchain changes require the dependency gate", () => {
  for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", ".cargo/config.toml"]) {
    const path = `finnor-os/packages/epistemic-runtime/native/z4-execution-proof/${name}`
    assert.equal(classifyPullRequestFiles([path]).dependencies, true, path)
  }
  assert.equal(classifyPullRequestFiles(["finnor-os/packages/epistemic-runtime/native/z4-execution-proof/src/main.rs"]).dependencies, false)
})

test("dependency review scans the adopted Z4 Rust lockfile", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/security.yml", import.meta.url), "utf8")
  assert.match(workflow, /--lockfile=finnor-os\/packages\/epistemic-runtime\/native\/z4-execution-proof\/Cargo\.lock(?:\s|$)/)
})

test("dependency policy changes run the dependency gate", () => {
  assert.equal(classifyPullRequestFiles([".github/workflows/security.yml"]).dependencies, true)
  assert.equal(classifyPullRequestFiles(["scripts/release/verify-dependency-scan.mjs"]).dependencies, true)
})

test("OSV keeps the reviewed RustSec notice visible and blocks other matching findings", () => {
  const id = "RUSTSEC-2025-0141"
  const report = { results: [{
    source: { type: "lockfile", path: "finnor-os/packages/epistemic-runtime/native/z4-execution-proof/Cargo.lock" },
    packages: [{
      package: { name: "bincode", version: "2.0.1", ecosystem: "crates.io" },
      vulnerabilities: [{ id, affected: [{
        package: { name: "bincode", ecosystem: "crates.io" },
        database_specific: { informational: "unmaintained", source: `https://github.com/rustsec/advisory-db/blob/osv/crates/${id}.json` },
      }] }],
    }],
  }] }
  const finding = 'RUSTSEC-2025-0141 "bincode" "2.0.1"'
  assert.deepEqual(evaluateDependencyScan(report, "1"), { warnings: [finding], failures: [] })
  for (const change of [
    result => { result.source.path = "other/Cargo.lock" },
    result => { result.packages[0].package.version = "2.0.2" },
    result => { result.packages[0].vulnerabilities[0].aliases = ["GHSA-example"] },
    result => { result.packages[0].vulnerabilities[0].affected[0].database_specific.informational = null },
    result => { result.packages[0].vulnerabilities[0].affected[0].database_specific.cvss = "CVSS:3.1" },
  ]) {
    const changed = structuredClone(report)
    change(changed.results[0])
    assert.equal(evaluateDependencyScan(changed, "1").failures.length, 1)
  }
  assert.throws(() => evaluateDependencyScan(report, "0"), /disagree/)
  assert.throws(() => evaluateDependencyScan({ results: [] }, "1"), /disagree/)
  assert.throws(() => evaluateDependencyScan({ results: [] }, "128"), /invalid/)
})

test("changed-file evidence is lossless even for unusual Git filenames", () => {
  const files = ["docs/name with spaces.md", "docs/line\nbreak.md", "finnor-os/ü.ts"]
  assert.deepEqual(decodeChangedFiles(encodeChangedFiles(files)), files)
  assert.throws(() => decodeChangedFiles(Buffer.from("{}", "utf8").toString("base64")), /invalid/)
})
