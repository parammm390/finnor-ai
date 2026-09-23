import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertCanonicalRelease, assertRuntimeParity, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"
import { assertSupplierCanaryRelease } from "./p8-water-retirement-policy.mjs"
import { vercelProtectionHeaders } from "./vercel-protection.mjs"
import { readProtectedEnvValue } from "./protected-env.mjs"
import { COMPUTE_CLASSES } from "./compute-plane-policy.mjs"
import { pgConnectionConfig } from "../../finnor-os/packages/db/postgres-connection.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const databaseEnvIndex = process.argv.indexOf("--database-env")
const databaseEnvPath = databaseEnvIndex >= 0 ? process.argv[databaseEnvIndex + 1] : undefined
if (!databaseEnvPath) throw new Error("Usage: node scripts/release/verify-production-parity.mjs --database-env <path>")

const gitRelease = readGitRelease(repoRoot, contract)
assertCanonicalRelease(gitRelease)
const expected = expectedRelease(gitRelease.head, process.env.FINNOR_RELEASE_SOURCE || "github-actions")

async function fetchRelease(component) {
  const target = contract.topology[component]
  const response = await fetch(`${target.productionUrl}${target.releasePath}`, {
    headers: vercelProtectionHeaders(component),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new Error(`${component} release endpoint failed with HTTP ${response.status}`)
  return body
}

const [frontend, api, supplierCanaryApp, supplierCanaryAuth] = await Promise.all([
  fetchRelease("frontend"),
  fetchRelease("api"),
  fetchRelease("supplierCanaryApp"),
  fetchRelease("supplierCanaryAuth"),
])
assertSupplierCanaryRelease("supplierCanaryApp", supplierCanaryApp, expected, contract.topology.supplierCanaryApp, contract.release.requiredMigrationHead)
assertSupplierCanaryRelease("supplierCanaryAuth", supplierCanaryAuth, expected, contract.topology.supplierCanaryAuth, contract.release.requiredMigrationHead)

const databaseUrl = readProtectedEnvValue(databaseEnvPath, "MIGRATIONS_DATABASE_URL")
const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const pg = requireFromOs("pg")
const client = new pg.Client({ ...pgConnectionConfig(databaseUrl), connectionTimeoutMillis: 15_000 })
await client.connect()
const computeReleases = {}
let migrationHead
try {
  const heartbeatDeadline = Date.now() + 120_000
  let lastHeartbeatObservation = "missing compute services"
  while (true) {
    const heartbeat = await client.query(`
      SELECT service,release_sha,build_id,version,release_source,core_certification_id,
             migration_head,deployment_id,capabilities,environment,instance_id,
             extract(epoch FROM (now()-last_beat_at))::int AS age_seconds
        FROM finnor_os.service_release_heartbeats
       WHERE service=ANY($1::text[]) AND last_beat_at>now()-interval '120 seconds'
       ORDER BY service,instance_id
    `, [COMPUTE_CLASSES.map((workloadClass) => contract.topology.computePlane.classes[workloadClass].heartbeatService).concat("worker")])
    const staleLegacy = heartbeat.rows.filter((row) => row.service === "worker")
    const failures = []
    const candidateReleases = {}
    for (const workloadClass of COMPUTE_CLASSES) {
      const profile = contract.topology.computePlane.classes[workloadClass]
      const rows = heartbeat.rows.filter((row) => row.service === profile.heartbeatService)
      if (rows.length < profile.minTasks) failures.push(`${workloadClass}: ${rows.length} fresh task heartbeats`)
      for (const row of rows) {
        const release = {
          commitSha: row.release_sha, buildId: row.build_id, version: row.version,
          source: row.release_source, coreCertificationId: row.core_certification_id,
          migrationHead: row.migration_head, deploymentId: row.deployment_id,
          capabilities: row.capabilities, environment: row.environment, traceable: true,
        }
        if (release.commitSha !== expected.commitSha || release.buildId !== expected.buildId
          || release.version !== expected.version || release.source !== expected.source
          || release.environment !== expected.environment || release.migrationHead !== contract.release.requiredMigrationHead
          || !row.instance_id?.startsWith("ecs:arn:aws:ecs:") || !Number.isFinite(Number(row.age_seconds))
          || Number(row.age_seconds) > 45) failures.push(`${workloadClass}: mixed, stale, or untraceable task release`)
        if (!candidateReleases[workloadClass]) candidateReleases[workloadClass] = release
      }
    }
    if (staleLegacy.length) failures.push(`${staleLegacy.length} legacy worker heartbeat(s) still fresh`)
    lastHeartbeatObservation = failures.join("; ") || "all four classes converged"
    if (failures.length === 0) { Object.assign(computeReleases, candidateReleases); break }
    if (Date.now() >= heartbeatDeadline) {
      throw new Error(`compute fleet heartbeat parity did not converge within 120s (${lastHeartbeatObservation})`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
  }
  const migrations = await client.query("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1")
  migrationHead = migrations.rows[0]?.name
} finally {
  await client.end()
}

// The AWS deployer must prove the immutable image, exact ECS tasks, and ALB
// target health before this independent DB + public HTTPS parity check runs.
const worker = contract.topology.worker
const gatewayResponse = await fetch(`${worker.sseGatewayUrl}/healthz`, {
  headers: { accept: "application/json", "cache-control": "no-cache" },
  signal: AbortSignal.timeout(20_000),
})
const gateway = await gatewayResponse.json().catch(() => null)
if (!gatewayResponse.ok || gateway?.ok !== true || gateway?.realtime !== true || gateway?.release?.commitSha !== expected.commitSha) {
  throw new Error(`REALTIME SSE gateway parity failed with HTTP ${gatewayResponse.status}`)
}
for (const [field, value] of [
  ["buildId", expected.buildId],
  ["version", expected.version],
  ["environment", expected.environment],
]) {
  if (gateway?.release?.[field] !== value) {
    throw new Error(`REALTIME SSE gateway ${field} mismatch: expected ${value}, observed ${gateway?.release?.[field] ?? "<missing>"}`)
  }
}
for (const capability of ["jobs", "realtime", "sse"]) {
  if (!gateway.capabilities?.includes(capability)) throw new Error(`REALTIME SSE gateway is missing ${capability} capability`)
}
if (gateway.capabilities?.includes("orchestration")) throw new Error("REALTIME gateway must not claim orchestration ownership")

const observed = { frontend, api, supplierCanaryApp, supplierCanaryAuth, migrationHead,
  computeRealtime: computeReleases.REALTIME, computeInteractive: computeReleases.INTERACTIVE,
  computeBackground: computeReleases.BACKGROUND, computeHeavy: computeReleases.HEAVY }
assertRuntimeParity(contract, expected, observed)
console.log(JSON.stringify({
  ok: true,
  commitSha: expected.commitSha,
  frontend: { service: frontend.service, commitSha: frontend.commitSha, deploymentId: frontend.deploymentId },
  api: { service: api.service, commitSha: api.commitSha, deploymentId: api.deploymentId },
  supplierCanaryApp: { commitSha: supplierCanaryApp.commitSha, deploymentId: supplierCanaryApp.deploymentId, role: supplierCanaryApp.role },
  supplierCanaryAuth: { commitSha: supplierCanaryAuth.commitSha, deploymentId: supplierCanaryAuth.deploymentId, role: supplierCanaryAuth.role },
  compute: Object.fromEntries(COMPUTE_CLASSES.map((workloadClass) => [workloadClass, {
    commitSha: computeReleases[workloadClass]?.commitSha,
    capabilities: computeReleases[workloadClass]?.capabilities,
  }])),
  realtimeGateway: { url: worker.sseGatewayUrl, commitSha: gateway.release.commitSha, capabilities: gateway.capabilities },
  orchestrator: { mode: contract.topology.orchestrator.mode, releaseIdentity: contract.topology.orchestrator.releaseIdentity },
  migrationHead,
}, null, 2))
