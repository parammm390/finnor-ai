import assert from "node:assert/strict"
import test from "node:test"
import { classifyPullRequestFiles, decodeChangedFiles, encodeChangedFiles, evaluateRequiredPrVerdict } from "./pr-verdict-policy.mjs"

function evaluate(files, results = {}) {
  const scope = classifyPullRequestFiles(files)
  return evaluateRequiredPrVerdict({
    files,
    classifyResult: "success",
    backendApplicable: scope.backend,
    backendResult: scope.backend ? "success" : "skipped",
    rootApplicable: scope.root,
    rootResult: scope.root ? "success" : "skipped",
    dependencyApplicable: scope.dependencies,
    securityResult: "success",
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
})

test("an applicable failure or universal secret-scan failure fails the stable verdict", () => {
  assert.deepEqual(evaluate(["finnor-os/index.ts"], { backendResult: "failure" }).failures, ["backend"])
  assert.deepEqual(evaluate(["README.md"], { securityResult: "failure" }).failures, ["universal security/gitleaks"])
})

test("changed-file evidence is lossless even for unusual Git filenames", () => {
  const files = ["docs/name with spaces.md", "docs/line\nbreak.md", "finnor-os/ü.ts"]
  assert.deepEqual(decodeChangedFiles(encodeChangedFiles(files)), files)
  assert.throws(() => decodeChangedFiles(Buffer.from("{}", "utf8").toString("base64")), /invalid/)
})
