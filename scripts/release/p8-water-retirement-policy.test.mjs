import assert from "node:assert/strict"
import test from "node:test"
import {
  P8_WATER_TENANT_DISPOSITIONS,
  assertExactWaterTenantCensus,
  assertSupplierCanaryRelease,
  assertZeroWaterRetirementBlockers,
} from "./p8-water-retirement-policy.mjs"

const expectedRelease = {
  commitSha: "a".repeat(40),
  buildId: `finnor-${"a".repeat(12)}`,
  version: `0.1.0+${"a".repeat(12)}`,
  environment: "production",
  source: "github-actions",
}

const census = P8_WATER_TENANT_DISPOSITIONS.map((expected) => ({
  tenant_id: expected.tenantId,
  name: expected.name,
  vertical_key: "water",
  source_system: expected.sourceSystem,
  created_by: expected.createdBy,
  is_dealer_zero: expected.dealerZero ?? false,
  simulator_enabled: expected.simulatorEnabled ?? false,
}))

test("the P8 disposition census accepts only the four audited historical fixtures", () => {
  assert.equal(assertExactWaterTenantCensus(census).length, 4)
  assert.throws(() => assertExactWaterTenantCensus(census.slice(1)), /census changed/)
  assert.throws(() => assertExactWaterTenantCensus([...census, { ...census[0], tenant_id: "10000000-0000-4000-8000-000000000001" }]), /census changed/)
  assert.throws(() => assertExactWaterTenantCensus(census.map((row, index) => index === 2 ? { ...row, name: "Customer" } : row)), /name/)
  assert.throws(() => assertExactWaterTenantCensus(census.map((row, index) => index === 1 ? { ...row, simulator_enabled: false } : row)), /simulator_enabled/)
})

test("supplier canary proof is exact-release, role, migration, and protocol locked", () => {
  const target = { portalRole: "app" }
  const body = {
    ok: true,
    service: "supplier-canary",
    role: "app",
    ...expectedRelease,
    deploymentId: "dpl_exact",
    traceable: true,
    migrationHead: "0130_phase8_cutover_runtime_head_compatibility.sql",
    cutoverProtocol: 5,
  }
  assert.equal(assertSupplierCanaryRelease("canary", body, expectedRelease, target, body.migrationHead), body)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, role: "auth" }, expectedRelease, target, body.migrationHead), /role/)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, commitSha: "b".repeat(40) }, expectedRelease, target, body.migrationHead), /commitSha/)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, migrationHead: "0129.sql" }, expectedRelease, target, body.migrationHead), /migrationHead/)
  assert.throws(() => assertSupplierCanaryRelease("canary", { ...body, cutoverProtocol: 4 }, expectedRelease, target, body.migrationHead), /cutover protocol/)
})

test("the activation census rejects any non-zero category", () => {
  assert.deepEqual(assertZeroWaterRetirementBlockers([
    { category: "tenant_disposition", blocking_count: "0" },
    { category: "water_domain_action", blocking_count: "0" },
  ]), { tenant_disposition: 0, water_domain_action: 0 })
  assert.throws(() => assertZeroWaterRetirementBlockers([
    { category: "water_domain_action", blocking_count: "1" },
  ]), /not zero/)
})
