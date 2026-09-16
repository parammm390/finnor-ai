import assert from "node:assert/strict"
import test from "node:test"
import { assertSupplierCanaryRelease } from "./release-evidence-policy.mjs"

const expectedRelease = {
  commitSha: "a".repeat(40),
  buildId: `finnor-${"a".repeat(12)}`,
  version: `0.1.0+${"a".repeat(12)}`,
  environment: "production",
  source: "github-actions",
}

test("supplier canary proof is exact-release, role, migration, and protocol locked", () => {
  const target = { portalRole: "app" }
  const migrationHead = "0131_private_equity_release_baseline.sql"
  const body = {
    ok: true,
    service: "supplier-canary",
    role: "app",
    ...expectedRelease,
    deploymentId: "dpl_exact",
    traceable: true,
    migrationHead,
    cutoverProtocol: 5,
  }
  assert.equal(assertSupplierCanaryRelease("canary", body, expectedRelease, target, migrationHead), body)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, role: "auth" }, expectedRelease, target, migrationHead), /role/)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, commitSha: "b".repeat(40) }, expectedRelease, target, migrationHead), /commitSha/)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, migrationHead: "0130.sql" }, expectedRelease, target, migrationHead), /migrationHead/)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, cutoverProtocol: 4 }, expectedRelease, target, migrationHead), /runtime protocol/)
})
