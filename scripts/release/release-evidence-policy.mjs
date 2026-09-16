const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i

function requireEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, observed ${String(actual)}`)
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
    throw new Error(`${label} runtime protocol ${String(body.cutoverProtocol)} is incompatible`)
  }
  return assertReleaseIdentity(label, body, expected)
}
