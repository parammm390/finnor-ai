const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i

export const P8_WATER_TENANT_DISPOSITIONS = Object.freeze([
  Object.freeze({
    tenantId: "00000000-0000-4000-8000-000000000001",
    name: "Test Dealer Water Co",
    classification: "TEST",
    sourceSystem: "migration:0104",
    createdBy: "system:legacy-water-default",
  }),
  Object.freeze({
    tenantId: "00000000-0000-4000-8000-0000000000d0",
    name: "Finnor Water Co. (Dealer Zero)",
    classification: "SYNTHETIC_REFERENCE",
    sourceSystem: "migration:0104",
    createdBy: "system:legacy-water-default",
    dealerZero: true,
    simulatorEnabled: true,
  }),
  Object.freeze({
    tenantId: "3540c78f-1c86-4843-9818-c3e4b11c0a67",
    name: "A5 Internal Security Tenant A",
    classification: "TEST",
    sourceSystem: "migration:0104",
    createdBy: "system:legacy-water-default",
  }),
  Object.freeze({
    tenantId: "08552873-e9c7-4099-a5da-70430d136347",
    name: "A5 Internal Security Tenant B",
    classification: "TEST",
    sourceSystem: "migration:0104",
    createdBy: "system:legacy-water-default",
  }),
])

function requireEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, observed ${String(actual)}`)
}

export function assertExactWaterTenantCensus(rows) {
  if (!Array.isArray(rows)) throw new Error("Water tenant census is unavailable")
  const expectedById = new Map(P8_WATER_TENANT_DISPOSITIONS.map((row) => [row.tenantId, row]))
  if (rows.length !== expectedById.size) {
    throw new Error(`Water tenant census changed: expected ${expectedById.size}, observed ${rows.length}`)
  }
  for (const row of rows) {
    const expected = expectedById.get(row.tenant_id)
    if (!expected) throw new Error(`Unclassified Water tenant ${row.tenant_id} is present`)
    requireEqual(`${row.tenant_id} name`, row.name, expected.name)
    requireEqual(`${row.tenant_id} vertical`, row.vertical_key, "water")
    requireEqual(`${row.tenant_id} source_system`, row.source_system, expected.sourceSystem)
    requireEqual(`${row.tenant_id} created_by`, row.created_by, expected.createdBy)
    if (expected.dealerZero !== undefined) requireEqual(`${row.tenant_id} is_dealer_zero`, row.is_dealer_zero, expected.dealerZero)
    if (expected.simulatorEnabled !== undefined) requireEqual(`${row.tenant_id} simulator_enabled`, row.simulator_enabled, expected.simulatorEnabled)
  }
  return P8_WATER_TENANT_DISPOSITIONS
}

export function assertReleaseIdentity(label, release, expected) {
  if (!release || typeof release !== "object") throw new Error(`${label} release evidence is unavailable`)
  for (const field of ["commitSha", "buildId", "version", "environment", "source"]) {
    requireEqual(`${label}.${field}`, release[field], expected[field])
  }
  if (release.traceable !== true) throw new Error(`${label} release is not traceable`)
  if (typeof release.deploymentId !== "string" || release.deploymentId.length === 0) {
    throw new Error(`${label} deployment identity is unavailable`)
  }
  if (!FULL_COMMIT_SHA.test(release.commitSha)) throw new Error(`${label} commit SHA is invalid`)
  return release
}

export function assertSupplierCanaryRelease(label, body, expected, target, migrationHead, minimumProtocol = 5) {
  if (body?.ok !== true || body?.service !== "supplier-canary") throw new Error(`${label} health is not ready`)
  requireEqual(`${label}.role`, body.role, target.portalRole)
  requireEqual(`${label}.migrationHead`, body.migrationHead, migrationHead)
  if (!Number.isInteger(body.cutoverProtocol) || body.cutoverProtocol < minimumProtocol) {
    throw new Error(`${label} cutover protocol ${String(body.cutoverProtocol)} is incompatible`)
  }
  return assertReleaseIdentity(label, body, expected)
}

export function blockerMap(rows) {
  return Object.fromEntries((rows ?? []).map((row) => [row.category, Number(row.blocking_count)]))
}

export function assertZeroWaterRetirementBlockers(rows) {
  const blockers = blockerMap(rows)
  const nonzero = Object.entries(blockers).filter(([, count]) => count !== 0)
  if (nonzero.length > 0) {
    throw new Error(`Water retirement safety census is not zero: ${JSON.stringify(blockers)}`)
  }
  return blockers
}
