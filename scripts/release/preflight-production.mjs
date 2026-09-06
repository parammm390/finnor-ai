import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertCanonicalRelease, assertResolvedTarget, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const outputIndex = process.argv.indexOf("--output-file")
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
const databaseEnvIndex = process.argv.indexOf("--database-env")
const databaseEnvPath = databaseEnvIndex >= 0 ? process.argv[databaseEnvIndex + 1] : undefined

if (!outputPath || !databaseEnvPath) {
  throw new Error("Usage: node scripts/release/preflight-production.mjs --database-env <path> --output-file <path>")
}
if (!existsSync(databaseEnvPath)) throw new Error(`protected database environment not found: ${databaseEnvPath}`)

const gitRelease = readGitRelease(repoRoot, contract)
assertCanonicalRelease(gitRelease)
const expected = expectedRelease(gitRelease.head, process.env.FINNOR_RELEASE_SOURCE || "github-actions")
for (const [name, value] of Object.entries({
  FINNOR_COMMIT_SHA: expected.commitSha,
  FINNOR_BUILD_ID: expected.buildId,
  FINNOR_VERSION: expected.version,
  FINNOR_ENVIRONMENT: expected.environment,
  FINNOR_RELEASE_SOURCE: expected.source,
})) {
  if (process.env[name] !== value) throw new Error(`${name} must be ${value}, got ${process.env[name] || "<missing>"}`)
}

const vercelToken = process.env.VERCEL_TOKEN
if (!vercelToken) throw new Error("VERCEL_TOKEN is required before production preflight")

async function vercel(path) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: { authorization: `Bearer ${vercelToken}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Vercel preflight failed (${response.status}) for ${path}`)
  return response.json()
}

const vercelTargets = {}
for (const component of ["frontend", "api"]) {
  const target = contract.topology[component]
  const project = await vercel(`/v9/projects/${target.projectId}?teamId=${target.organizationId}`)
  assertResolvedTarget(`Vercel ${component}`, target, {
    projectId: project.id,
    projectName: project.name,
    organizationId: project.accountId,
  }, ["projectId", "projectName", "organizationId"])
  vercelTargets[component] = { projectId: project.id, projectName: project.name, organizationId: project.accountId }
}

const apiTarget = contract.topology.api
const envResponse = await vercel(`/v10/projects/${apiTarget.projectId}/env?teamId=${apiTarget.organizationId}&decrypt=false`)
const productionEnvNames = new Set(
  (envResponse.envs ?? [])
    .filter((entry) => entry.target === "production" || entry.target?.includes?.("production"))
    .map((entry) => entry.key),
)
for (const name of ["MIGRATIONS_DATABASE_URL", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SECRETS_PROVIDER", "FINNOR_SECRET_IDS"]) {
  if (!productionEnvNames.has(name)) throw new Error(`Vercel API production environment is missing ${name}`)
}
const frontendTarget = contract.topology.frontend
const frontendEnvResponse = await vercel(`/v10/projects/${frontendTarget.projectId}/env?teamId=${frontendTarget.organizationId}&decrypt=false`)
const frontendProductionEnvNames = new Set(
  (frontendEnvResponse.envs ?? [])
    .filter((entry) => entry.target === "production" || entry.target?.includes?.("production"))
    .map((entry) => entry.key),
)
if (!frontendProductionEnvNames.has("JARVIS_SSE_GATEWAY_URL")) {
  throw new Error("Vercel frontend production environment is missing JARVIS_SSE_GATEWAY_URL")
}

const az = process.env.AZURE_CLI || "az"
function azJson(args) {
  const output = execFileSync(az, [...args, "--only-show-errors", "-o", "json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(output)
}

const worker = contract.topology.worker
const account = azJson(["account", "show"])
if (
  account.id?.toLowerCase() !== worker.subscriptionId.toLowerCase() ||
  account.tenantId?.toLowerCase() !== worker.tenantId.toLowerCase() ||
  process.env.AZURE_TENANT_ID?.toLowerCase() !== worker.tenantId.toLowerCase()
) {
  throw new Error("authenticated Azure account differs from the canonical contract")
}
const vm = azJson(["vm", "show", "--resource-group", worker.resourceGroup, "--name", worker.resourceName])
const instanceView = azJson([
  "vm",
  "get-instance-view",
  "--resource-group",
  worker.resourceGroup,
  "--name",
  worker.resourceName,
])
const instanceStatuses = instanceView.statuses ?? instanceView.instanceView?.statuses ?? []
const powerState = instanceStatuses.find((status) => status.code?.startsWith("PowerState/"))?.displayStatus
assertResolvedTarget("Azure worker", worker, {
  resourceId: vm.id,
  vmId: vm.vmId,
  location: vm.location,
  adminUsername: vm.osProfile?.adminUsername,
}, ["resourceId", "vmId", "location", "adminUsername"])
if (powerState !== "VM running") throw new Error(`Azure worker is not running (${powerState ?? "unknown"})`)

const remotePreflight = `set -eu
metadata=$(curl -fsS -H Metadata:true 'http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01')
node -e 'const m=JSON.parse(process.argv[1]); if(m.vmId.toLowerCase()!==process.argv[2].toLowerCase()||m.resourceGroupName!==process.argv[3]||m.name!==process.argv[4]) process.exit(1)' "$metadata" '${worker.vmId}' '${worker.resourceGroup}' '${worker.resourceName}'
systemctl cat '${worker.systemdUnit}' >/dev/null
unexpected_units=$(systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -Ei 'finnor|jarvis|orchestrator' | grep -Fvx '${worker.systemdUnit}' || true)
test -z "$unexpected_units" || { echo "unexpected FINNOR runtime unit(s): $unexpected_units" >&2; exit 1; }
test -r '${worker.secretEnvironmentFile}'
for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY SECRETS_PROVIDER FINNOR_SECRET_IDS; do
  grep -q "^$name=" '${worker.secretEnvironmentFile}' || { echo "missing worker environment: $name" >&2; exit 1; }
done
grep -Eq '^(AWS_REGION|AWS_BEDROCK_REGION)=' '${worker.secretEnvironmentFile}' || { echo "missing worker AWS region" >&2; exit 1; }
grep -Eq '^SECRETS_PROVIDER=(aws-secrets-manager|"aws-secrets-manager"|'"'"'aws-secrets-manager'"'"')$' '${worker.secretEnvironmentFile}' || { echo "worker managed-secret provider is not fail-closed" >&2; exit 1; }
grep -Eq '^FINNOR_SECRET_IDS=.+$' '${worker.secretEnvironmentFile}' || { echo "worker secret mapping is empty" >&2; exit 1; }
! grep -q '^AUTH_DEV_BYPASS=' '${worker.secretEnvironmentFile}' || { echo "worker contains forbidden production AUTH_DEV_BYPASS" >&2; exit 1; }
git ls-remote https://github.com/${contract.canonicalGit.repository}.git refs/heads/${contract.canonicalGit.branch} | grep -q '^${gitRelease.head}'
test "$(df -Pk /srv/finnor | awk 'NR==2 {print $4}')" -gt 524288
echo FINNOR_AZURE_PREFLIGHT_OK`
const runCommand = azJson([
  "vm", "run-command", "invoke",
  "--resource-group", worker.resourceGroup,
  "--name", worker.resourceName,
  "--command-id", "RunShellScript",
  "--scripts", remotePreflight,
])
const runOutput = (runCommand.value ?? []).map((entry) => entry.message ?? "").join("\n")
if (!runOutput.includes("FINNOR_AZURE_PREFLIGHT_OK")) throw new Error("Azure worker runtime preflight did not return its success marker")

process.loadEnvFile(resolve(databaseEnvPath))
const databaseUrl = process.env.MIGRATIONS_DATABASE_URL
if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is missing from the protected environment")
const parsedDatabaseUrl = new URL(databaseUrl)
if (parsedDatabaseUrl.hostname !== contract.topology.database.host) {
  throw new Error(`database host ${parsedDatabaseUrl.hostname} differs from the canonical contract`)
}

const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const pg = requireFromOs("pg")
const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 })
await client.connect()
let migrationHead
let businessCounts
try {
  await client.query("BEGIN READ ONLY")
  const migrations = await client.query("SELECT name FROM finnor_os._migrations ORDER BY name")
  const applied = migrations.rows.map((row) => row.name)
  migrationHead = applied.at(-1)
  const repoMigrations = readdirSync(resolve(repoRoot, "finnor-os/packages/db/migrations")).filter((name) => name.endsWith(".sql")).sort()
  const unknown = applied.filter((name) => !repoMigrations.includes(name))
  if (unknown.length) throw new Error(`production database contains migrations absent from the release: ${unknown.join(", ")}`)
  if (repoMigrations.at(-1) !== contract.release.requiredMigrationHead) {
    throw new Error(`repository migration head ${repoMigrations.at(-1)} differs from contract ${contract.release.requiredMigrationHead}`)
  }
  if (migrationHead && migrationHead > contract.release.requiredMigrationHead) {
    throw new Error(`production migration head ${migrationHead} is newer than this release`)
  }
  if (migrationHead && migrationHead >= "0080_declarative_client_imports.sql") {
    const shape = await client.query(`
      SELECT
        to_regclass('finnor_os.tenant_locations') IS NOT NULL AS tenant_locations,
        to_regclass('finnor_os.import_runs') IS NOT NULL AS import_runs,
        to_regclass('finnor_os.import_rows') IS NOT NULL AS import_rows,
        to_regclass('finnor_os.import_entity_refs') IS NOT NULL AS import_entity_refs,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='finnor_os' AND table_name='tenant_integrations' AND column_name='credential_ref'
        ) AS tenant_credentials
    `)
    if (Object.values(shape.rows[0] ?? {}).some((value) => value !== true)) throw new Error("production Phase 1–3 schema shape is inconsistent")
  }
  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM finnor_os.tenants) AS tenants,
      (SELECT count(*)::int FROM finnor_os.users) AS users,
      (SELECT count(*)::int FROM finnor_os.households) AS households,
      (SELECT count(*)::int FROM finnor_os.leads) AS leads,
      (SELECT count(*)::int FROM finnor_os.equipment) AS equipment,
      (SELECT count(*)::int FROM finnor_os.work_orders) AS work_orders
  `)
  businessCounts = counts.rows[0]
  await client.query("ROLLBACK")
} finally {
  await client.end()
}

const contractBytes = readFileSync(resolve(repoRoot, "infra/deployment/production.contract.json"))
const evidence = {
  ok: true,
  checkedAt: new Date().toISOString(),
  commitSha: gitRelease.head,
  remoteMain: gitRelease.remoteMain,
  contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
  vercel: vercelTargets,
  azure: { resourceId: vm.id, vmId: vm.vmId, location: vm.location, powerState },
  database: { host: parsedDatabaseUrl.hostname, migrationHead, businessCounts },
}
writeFileSync(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(evidence, null, 2))
