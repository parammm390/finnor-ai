import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { assertCanonicalRelease, assertDeploymentPlan, assertResolvedTarget, assertRuntimeParity, expectedRelease, loadContract } from "./release-policy.mjs"

const contract = loadContract()
const sha = "a".repeat(40)
const release = { ...expectedRelease(sha), traceable: true }
const productionWorkflow = readFileSync(new URL("../../.github/workflows/production-release.yml", import.meta.url), "utf8")

test("production release from a non-main SHA is rejected", () => {
  assert.throws(() => assertCanonicalRelease({ head: sha, remoteMain: "b".repeat(40), dirty: "" }), /not canonical remote main/)
})

test("dirty production release is rejected", () => {
  assert.throws(() => assertCanonicalRelease({ head: sha, remoteMain: sha, dirty: " M file" }), /clean worktree/)
})

test("worker omission rejects the release", () => {
  assert.throws(() => assertDeploymentPlan(contract, ["frontend", "api"]), /worker/)
})

test("separate orchestrator omission rejects the release", () => {
  const separate = structuredClone(contract)
  separate.topology.orchestrator.separateDeployment = true
  assert.throws(() => assertDeploymentPlan(separate, ["frontend", "api", "worker"]), /orchestrator/)
})

test("stale or unknown deployment target is rejected", () => {
  const expected = contract.topology.worker
  assert.throws(
    () => assertResolvedTarget("Azure worker", expected, { ...expected, resourceName: "stale-worker" }, ["resourceId", "resourceName", "vmId"]),
    /differs from canonical contract/,
  )
})

test("runtime SHA mismatch rejects parity", () => {
  const observed = {
    frontend: release,
    api: { ...release, commitSha: "b".repeat(40) },
    worker: { ...release, capabilities: ["orchestration"] },
    migrationHead: contract.release.requiredMigrationHead,
  }
  assert.throws(() => assertRuntimeParity(contract, expectedRelease(sha), observed), /api.commitSha/)
})

test("complete canonical parity passes", () => {
  const observed = {
    frontend: release,
    api: release,
    worker: { ...release, capabilities: ["orchestration"] },
    migrationHead: contract.release.requiredMigrationHead,
  }
  assert.doesNotThrow(() => assertRuntimeParity(contract, expectedRelease(sha), observed))
})

test("production release installs both locked dependency trees with npm ci", () => {
  assert.equal(productionWorkflow.includes("npm install --no-package-lock"), false)
  assert.equal((productionWorkflow.match(/run: npm ci --no-audit --no-fund/g) ?? []).length, 2)
})

test("production preparation consumes the exact commit core-certification artifact", () => {
  const produce = productionWorkflow.indexOf("Produce commit-locked FINNOR core certification")
  const upload = productionWorkflow.indexOf("Export core certification to the release job")
  const download = productionWorkflow.indexOf("Download commit-locked FINNOR core certification")
  const bind = productionWorkflow.indexOf("FINNOR_CORE_CERTIFICATION_FILE=")
  const prepare = productionWorkflow.indexOf("deploy-production.mjs frontend --prepare-only")
  assert.ok(produce > -1 && upload > produce)
  assert.ok(download > upload && bind > download && prepare > bind)
  assert.match(productionWorkflow, /release:certify -- core --core-sha="\$RELEASE_COMMIT_SHA"/)
  assert.match(productionWorkflow, /artifact\.canonicalCoreSha!==process\.env\.RELEASE_COMMIT_SHA/)
})
