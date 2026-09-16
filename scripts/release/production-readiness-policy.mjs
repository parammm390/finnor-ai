export function evaluateProductionReadiness({ responseOk, status, body, expectedSha }) {
  const authority = body?.checks?.productAuthority?.detail
  const release = body?.checks?.runtimeRelease?.detail
  const provenance = body?.provenance

  const checks = {
    http: responseOk === true,
    ready: body?.ok === true,
    finalPeGateRequired: authority?.finalPeGateRequired === true,
    authorityStatus: authority?.status === "active",
    activeProductVertical: authority?.activeProductVertical === "private_equity",
    authorityCheck: body?.checks?.productAuthority?.ok === true,
    runtimeEpoch: body?.checks?.runtimeEpoch?.ok === true,
    runtimeRelease: body?.checks?.runtimeRelease?.ok === true,
    expectedRelease: release?.expectedReleaseSha === expectedSha,
    provenanceRelease: provenance?.commitSha === expectedSha && provenance?.traceable === true,
    migration: body?.checks?.migrations?.ok === true,
    workerFleet: body?.checks?.workerFleet?.ok === true,
  }
  const ok = Object.values(checks).every(Boolean)
  const stableChecks = [
    checks.finalPeGateRequired,
    checks.authorityStatus,
    checks.activeProductVertical,
    checks.authorityCheck,
    checks.runtimeEpoch,
    checks.expectedRelease,
    checks.provenanceRelease,
    checks.migration,
    checks.workerFleet,
  ]
  const releaseShas = Array.isArray(release?.releaseShas) ? release.releaseShas : []
  const mixedReleaseRuntimes = Number(release?.mixedRuntimes ?? 0)
  const mixedMigrationRuntimes = Number(release?.mixedMigrationRuntimes ?? 0)
  const incompatibleProtocolRuntimes = Number(release?.incompatibleProtocolRuntimes ?? 0)
  const retryable = !ok
    && status === 503
    && stableChecks.every(Boolean)
    && checks.runtimeRelease === false
    && releaseShas.includes(expectedSha)
    && (mixedReleaseRuntimes > 0 || mixedMigrationRuntimes > 0)
    && incompatibleProtocolRuntimes === 0

  return { ok, retryable, checks, authority, release, provenance }
}
