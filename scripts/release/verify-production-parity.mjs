import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertCanonicalRelease, assertRuntimeParity, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"

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
    headers: { accept: "application/json", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new Error(`${component} release endpoint failed with HTTP ${response.status}`)
  return body
}

const [frontend, api] = await Promise.all([fetchRelease("frontend"), fetchRelease("api")])

process.loadEnvFile(resolve(databaseEnvPath))
const databaseUrl = process.env.MIGRATIONS_DATABASE_URL
if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is missing")
const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const pg = requireFromOs("pg")
const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 })
await client.connect()
let workerRelease
let migrationHead
let heartbeatAgeSeconds
try {
  const heartbeatDeadline = Date.now() + 120_000
  let lastHeartbeatObservation = "missing"
  while (true) {
    const heartbeat = await client.query(`
      SELECT release_sha,build_id,version,release_source,core_certification_id,
             migration_head,deployment_id,capabilities,environment,
             extract(epoch FROM (now()-last_beat_at))::int AS age_seconds
        FROM finnor_os.service_release_heartbeats
       WHERE service='worker'
       ORDER BY last_beat_at DESC
       LIMIT 1
    `)
    if (heartbeat.rowCount === 1) {
      const row = heartbeat.rows[0]
      workerRelease = {
        commitSha: row.release_sha,
        buildId: row.build_id,
        version: row.version,
        source: row.release_source,
        coreCertificationId: row.core_certification_id,
        migrationHead: row.migration_head,
        deploymentId: row.deployment_id,
        capabilities: row.capabilities,
        environment: row.environment,
        traceable: true,
      }
      heartbeatAgeSeconds = Number(row.age_seconds)
      const observedCommit = workerRelease.commitSha ?? "<missing>"
      lastHeartbeatObservation = `commit=${observedCommit}, age=${heartbeatAgeSeconds}s`
      if (observedCommit === expected.commitSha && Number.isFinite(heartbeatAgeSeconds) && heartbeatAgeSeconds <= 120) break
    }
    if (Date.now() >= heartbeatDeadline) {
      throw new Error(`worker heartbeat did not become fresh for ${expected.commitSha} within 120s (${lastHeartbeatObservation})`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
  }
  const migrations = await client.query("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1")
  migrationHead = migrations.rows[0]?.name
} finally {
  await client.end()
}

const worker = contract.topology.worker
const azureVerifyScript = `set -eu
systemctl is-active --quiet '${worker.systemdUnit}'
test "$(readlink -f '${worker.currentSymlink}')" = '${worker.releaseRoot}/${expected.commitSha}'
test "$(sudo -u finnor git -C '${worker.currentSymlink}' rev-parse HEAD)" = '${expected.commitSha}'
grep -qx 'FINNOR_COMMIT_SHA=${expected.commitSha}' '${worker.releaseEnvironmentFile}'
echo FINNOR_AZURE_PARITY_OK`
const az = process.env.AZURE_CLI || "az"
const azureRaw = execFileSync(az, [
  "vm", "run-command", "invoke",
  "--resource-group", worker.resourceGroup,
  "--name", worker.resourceName,
  "--command-id", "RunShellScript",
  "--scripts", azureVerifyScript,
  "--only-show-errors",
  "-o", "json",
], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
const azureResult = JSON.parse(azureRaw)
const azureMessage = (azureResult.value ?? []).map((entry) => entry.message ?? "").join("\n")
if (!azureMessage.includes("FINNOR_AZURE_PARITY_OK")) throw new Error(`Azure source/service parity verification failed:\n${azureMessage}`)

const observed = { frontend, api, worker: workerRelease, migrationHead }
assertRuntimeParity(contract, expected, observed)
console.log(JSON.stringify({
  ok: true,
  commitSha: expected.commitSha,
  frontend: { service: frontend.service, commitSha: frontend.commitSha, deploymentId: frontend.deploymentId },
  api: { service: api.service, commitSha: api.commitSha, deploymentId: api.deploymentId },
  worker: { commitSha: workerRelease.commitSha, heartbeatAgeSeconds, capabilities: workerRelease.capabilities },
  orchestrator: { mode: contract.topology.orchestrator.mode, releaseIdentity: contract.topology.orchestrator.releaseIdentity },
  migrationHead,
}, null, 2))
