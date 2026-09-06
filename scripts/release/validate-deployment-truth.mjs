import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadContract } from "./release-policy.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const failures = []
const fail = (message) => failures.push(message)

if (contract.schemaVersion !== 2 || contract.environment !== "production") fail("contract schema/environment is invalid")
if (contract.canonicalGit.branch !== "main" || contract.canonicalGit.remote !== "origin") fail("canonical Git target must be origin/main")
if (!contract.canonicalGit.requireCleanWorktree) fail("production contract must require a clean worktree")
if (contract.release.concurrencyGroup !== "finnor-production-release") fail("production concurrency lock changed")
if (!/^\d{4}_.+\.sql$/.test(contract.release.requiredMigrationHead)) fail("required migration head is invalid")

for (const name of ["frontend", "api", "worker", "orchestrator", "database"]) {
  if (!contract.topology[name]) fail(`topology is missing ${name}`)
}
if (contract.topology.frontend.provider !== "vercel" || contract.topology.api.provider !== "vercel") fail("frontend/API provider must be Vercel")
for (const name of ["frontend", "api"]) {
  const target = contract.topology[name]
  if (!target.releaseWorkingDirectory || target.installCommand !== "npm ci") fail(`${name} must use a source-locked npm ci build contract`)
}
if (contract.topology.worker.provider !== "azure-vm") fail("worker provider must be Azure VM")
for (const key of ["tenantId", "subscriptionId", "resourceGroup", "resourceName", "resourceId", "vmId", "systemdUnit"]) {
  if (!contract.topology.worker[key]) fail(`Azure worker contract is missing ${key}`)
}
if (contract.topology.orchestrator.separateDeployment === false && contract.topology.orchestrator.mode !== "embedded-worker") {
  fail("non-separate orchestrator must be embedded in the worker")
}
if (!contract.release.requiredComponents.includes("worker")) fail("worker must be required for every production release")

const migrationPath = join(repoRoot, "finnor-os/packages/db/migrations", contract.release.requiredMigrationHead)
if (!existsSync(migrationPath)) fail(`required migration does not exist: ${relative(repoRoot, migrationPath)}`)

for (const obsolete of ["finnor-os/railway.json", "finnor-os/railway.staging.json", "finnor-os/infra/deployment/worker-service.yaml"]) {
  if (existsSync(join(repoRoot, obsolete))) fail(`obsolete deployment surface still exists: ${obsolete}`)
}

const scanRoots = [
  ".github/workflows",
  "scripts/release",
  "infra/deployment",
]
const textExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".json", ".yml", ".yaml", ".md"])
const forbidden = /railway|render\.com|render[- ]class|render blueprint|(?:provider|platform|host)(?:\s+is|\s*[:=])\s*["']?render\b/i

function scan(path) {
  if (!existsSync(path)) return
  const info = statSync(path)
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name === ".git" || name === "migrations-bundle.ts") continue
      scan(join(path, name))
    }
    return
  }
  if (!textExtensions.has(extname(path))) return
  const rel = relative(repoRoot, path)
  if (["infra/deployment/production.contract.json", "scripts/release/validate-deployment-truth.mjs"].includes(rel)) return
  const content = readFileSync(path, "utf8")
  if (forbidden.test(content)) fail(`active deployment truth mentions a retired provider: ${rel}`)
}
for (const entry of scanRoots) scan(join(repoRoot, entry))

const workflow = readFileSync(join(repoRoot, ".github/workflows/production-release.yml"), "utf8")
const vercelDeployScript = readFileSync(join(repoRoot, "scripts/release/deploy-production.mjs"), "utf8")
const azureDeployScript = readFileSync(join(repoRoot, "scripts/release/azure/deploy-worker.sh"), "utf8")
const parityScript = readFileSync(join(repoRoot, "scripts/release/verify-production-parity.mjs"), "utf8")
for (const invariant of [
  'sudo -u finnor git -C "$staging_dir" rev-parse HEAD',
  'sudo -u finnor git -C "$staging_dir" status --porcelain=v1 --untracked-files=all',
  'sudo -u finnor git -C "$release_dir" rev-parse HEAD',
  'sudo -u finnor git -C "$release_dir" status --porcelain=v1 --untracked-files=all',
]) {
  if (!azureDeployScript.includes(invariant)) fail(`Azure release verification lost runtime-owner Git guard: ${invariant}`)
}
if (!parityScript.includes("sudo -u finnor git -C '${worker.currentSymlink}' rev-parse HEAD")) {
  fail("Azure parity verification must inspect the runtime-owned checkout as finnor")
}
if (!parityScript.includes("heartbeatDeadline = Date.now() + 120_000") || !parityScript.includes("observedCommit === expected.commitSha")) {
  fail("runtime parity must wait for a fresh heartbeat carrying the canonical release SHA")
}
if (/\b(?:prj_|team_)[A-Za-z0-9]+/.test(workflow)) {
  fail("production workflow must resolve Vercel target IDs from the canonical contract")
}
if (!workflow.includes("production.contract.json').topology.api") || !vercelDeployScript.includes("infra/deployment/production.contract.json")) {
  fail("Vercel release stages must consume the canonical deployment contract")
}
if (!/VERCEL_ORG_ID:\s*TEAM_ID/.test(vercelDeployScript) || !/VERCEL_PROJECT_ID:\s*app\.projectId/.test(vercelDeployScript)) {
  fail("Vercel release commands must be scoped to the exact canonical organization and project IDs")
}
for (const invariant of [
  "node scripts/release/preflight-production.mjs",
  "npm run release:migrate:production",
  "node scripts/release/deploy-production.mjs frontend",
  "node scripts/release/deploy-production.mjs api",
  "node scripts/release/deploy-azure-worker.mjs",
  "node scripts/release/verify-production-parity.mjs",
]) {
  if (!workflow.includes(invariant)) fail(`production workflow omits guarded stage: ${invariant}`)
}
if (!/concurrency:\s*[\s\S]*group:\s*finnor-production-release/.test(workflow)) fail("production workflow lost its concurrency lock")
const preflightAt = workflow.indexOf("preflight-production.mjs")
const migrationAt = workflow.indexOf("release:migrate:production")
if (preflightAt < 0 || migrationAt < 0 || preflightAt > migrationAt) fail("migration can run before production preflight")
for (const component of ["frontend", "api"]) {
  const deployAt = workflow.indexOf(`deploy-production.mjs ${component} --deploy-only`)
  if (deployAt < migrationAt) fail(`${component} deployment is missing or can run before migration`)
}

if (failures.length) {
  console.error(`Deployment truth validation failed:\n- ${failures.join("\n- ")}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, contract: "infra/deployment/production.contract.json", topology: contract.topology }, null, 2))
