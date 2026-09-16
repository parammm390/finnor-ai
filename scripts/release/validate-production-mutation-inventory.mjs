import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8")
const inventory = JSON.parse(read("infra/deployment/production-mutation-inventory.json"))
const contract = JSON.parse(read("infra/deployment/production.contract.json"))
const fail = (message) => { throw new Error(message) }
const requireInvariant = (condition, message) => { if (!condition) fail(message) }

requireInvariant(inventory.schema === "finnor-production-mutation-inventory.v1", "unsupported production mutation inventory schema")
requireInvariant(inventory.breakGlassRetained === false, "an unreviewed BREAK_GLASS path is retained")
requireInvariant(inventory.globalConcurrencyGroup === contract.release.concurrencyGroup, "inventory lock differs from the deployment contract")

const paths = new Map()
for (const entry of inventory.entries) {
  requireInvariant(["READ_ONLY", "PRODUCTION_MUTATOR", "ONE_TIME_MUTATOR", "BREAK_GLASS"].includes(entry.classification), `invalid classification for ${entry.id}`)
  const classifiedPaths = [...(entry.paths ?? [entry.path]), ...(entry.supportingPaths ?? [])]
  for (const path of classifiedPaths) {
    requireInvariant(!paths.has(path), `${path} is classified more than once`)
    paths.set(path, entry)
    if (entry.state === "RETIRED") requireInvariant(!existsSync(resolve(repoRoot, path)), `retired writer still exists: ${path}`)
    else requireInvariant(existsSync(resolve(repoRoot, path)), `inventory path is missing: ${path}`)
  }
}

const auditRoots = [".github/workflows", "scripts/release", "finnor-os/scripts/release", "infra/deployment", "infra/aws"]
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [relative(repoRoot, path)]
  })
}
for (const path of auditRoots.flatMap((root) => filesUnder(resolve(repoRoot, root)))) {
  requireInvariant(paths.has(path), `release/governance dependency closure contains unclassified path: ${path}`)
}

const activeMutators = inventory.entries.filter((entry) => entry.classification === "PRODUCTION_MUTATOR" && entry.state === "ACTIVE")
requireInvariant(activeMutators.length === 6, "active production writer inventory changed; classify and authorize the new mechanism")
for (const entry of activeMutators.filter((candidate) => candidate.path.endsWith(".mjs") || candidate.path.endsWith(".ts"))) {
  const source = read(entry.path)
  requireInvariant(source.includes("authorizeProductionMutation"), `${entry.path} does not consume the common production mutation guard`)
  for (const operation of entry.operations) requireInvariant(source.includes(operation), `${entry.path} omits declared operation ${operation}`)
}

const workflow = read(".github/workflows/production-release.yml")
requireInvariant(workflow.includes(`group: ${contract.release.concurrencyGroup}`), "production release does not hold the global production mutation lock")
requireInvariant(!workflow.includes("workflow_dispatch:"), "production release permits arbitrary manual ref dispatch")
requireInvariant(workflow.includes("post-merge-certification"), "production release lacks exact post-merge certification")
requireInvariant(workflow.includes("production-mutation-guard.mjs issue"), "production release does not issue common mutation authorization")
const mutationGuard = read("scripts/release/production-mutation-guard.mjs")
requireInvariant(mutationGuard.includes("verifyGitHubOidcJwtSignature") && mutationGuard.includes("ref_protected"), "production guard lacks cryptographic protected-ref OIDC identity")
requireInvariant(mutationGuard.includes("productionMutationCapabilities = new WeakMap") && mutationGuard.includes("assertProductionMutationCapability"), "production helper authorization is forgeable or unbranded")
requireInvariant(read("scripts/release/p8-water-retirement-store.mjs").includes("assertProductionMutationCapability"), "product-authority write helpers do not consume the common authorization capability")
requireInvariant(read("finnor-os/scripts/release/workspace-v3-repair.ts").includes("assertProductionMutationCapability"), "database repair helper does not consume the common authorization capability")
requireInvariant(contract.release.mutationAuthorization.oidcAudience === "finnor-production-mutation.v1", "production mutation OIDC audience changed")
for (const operation of contract.release.mutationAuthorization.allowedOperations) {
  requireInvariant(inventory.entries.some((entry) => entry.operations?.some((candidate) => candidate === operation || candidate.endsWith(":*") && operation.startsWith(candidate.slice(0, -1)))), `contract operation is not inventoried: ${operation}`)
}

for (const file of ["deploy-production.mjs", "configure-vercel-realtime.mjs", "deploy-aws-worker.mjs", "run-p8-production-water-retirement.mjs"]) {
  requireInvariant(!read(`scripts/release/${file}`).includes("process.loadEnvFile"), `${file} loads every protected secret into its process environment`)
}
requireInvariant(!workflow.includes("codex-governed-release"), "silent local production release source remains")
requireInvariant(!read("scripts/release/deploy-production.mjs").includes("codex-governed-release"), "local Vercel production deployment fallback remains")
const vercelDeploy = read("scripts/release/deploy-production.mjs")
requireInvariant(!workflow.includes("--token") && !vercelDeploy.includes("--token"), "Vercel token is passed through process arguments instead of the step-scoped environment")
requireInvariant(vercelDeploy.includes('run("vercel", ["pull", "--yes", "--environment=production"], pullDir, withoutSecrets(env, ["VERCEL_TOKEN"]))'), "Vercel pull receives unrelated release credentials or writes full secrets into the build workspace")
requireInvariant(vercelDeploy.includes('sanitizeVercelBuildEnvironment(join(pullDir, ".vercel", ".env.production.local")') && vercelDeploy.includes('cpSync(join(pullDir, ".vercel"), join(buildDir, ".vercel"), { recursive: true })'), "Vercel build configuration is copied before production secrets are sanitized")
requireInvariant(workflow.includes('docker logout "$registry"'), "ECR registry credentials are not removed before unrelated release steps")
requireInvariant((workflow.match(/inline-session-policy:/g) ?? []).length === 3, "AWS ECR, read-only preflight, and ECS sessions are not independently least-privileged")
const preflightSessionAt = workflow.indexOf("Authenticate exact AWS project with GitHub OIDC for preflight")
const preflightStepAt = workflow.indexOf("Preflight every AWS, Vercel, and database production target", preflightSessionAt)
const preflightSession = workflow.slice(preflightSessionAt, preflightStepAt)
requireInvariant(preflightSessionAt >= 0 && preflightStepAt > preflightSessionAt && !/(PutImage|UpdateService|RegisterTaskDefinition|PassRole)/.test(preflightSession), "AWS preflight session retains production mutation authority")
requireInvariant(!workflow.includes("finnor-os/apps/api/.vercel/.env.production.local") && !workflow.includes("apps/api/.vercel/.env.production.local"), "the full production database environment is stored inside a build workspace")
requireInvariant(workflow.includes("FINNOR_PROTECTED_DATABASE_ENV=$protected_env") && vercelDeploy.includes('"FINNOR_PROTECTED_DATABASE_ENV"'), "protected database configuration is not isolated from Vercel build subprocesses")
requireInvariant(workflow.indexOf("Build commit-locked production artifacts before any database or AWS credential") < workflow.indexOf("Pull protected production database configuration"), "production artifacts are built after database credentials become available")

const workflowFiles = [...paths.entries()].filter(([path, entry]) => path.startsWith(".github/workflows/") && path !== ".github/workflows/production-release.yml" && entry.state !== "RETIRED")
for (const [path] of workflowFiles) {
  const source = read(path)
  requireInvariant(!/^\s*environment:\s*production\s*$/m.test(source), `${path} independently holds production environment authority`)
  requireInvariant(!/^\s*id-token:\s*write\s*$/m.test(source), `${path} independently holds AWS OIDC authority`)
  requireInvariant(!/(deploy-production\.mjs|deploy-aws-worker\.mjs|migrate-production|configure-vercel-realtime\.mjs --apply|run-p8-production-water-retirement\.mjs)/.test(source), `${path} contains an unclassified production mutation path`)
}
for (const workflowName of ["production-release.yml", "marketing-ci.yml", "security.yml", "planner-live-evals.yml", "k6-nightly-lite.yml", "tenant-isolation-nightly.yml", "dealer-zero-replay.yml"]) {
  for (const line of read(`.github/workflows/${workflowName}`).split("\n").filter((candidate) => candidate.includes("${{ secrets."))) {
    requireInvariant(/^\s{10,}[A-Z0-9_]+:\s*\$\{\{ secrets\./.test(line), `${workflowName} exposes a live secret above an exact step environment`)
  }
}

const verdict = read(".github/workflows/pr-verdict.yml")
requireInvariant(/^on:\n\s+pull_request:\n\s+branches: \[main\]/m.test(verdict), "universal PR verdict trigger changed")
requireInvariant(!/^\s+paths(?:-ignore)?:/m.test(verdict.split("jobs:")[0]), "universal PR verdict has a top-level path filter")
requireInvariant(verdict.includes("name: required-pr-verdict"), "stable required-pr-verdict check is missing")
requireInvariant(read("scripts/release/pr-verdict-policy.mjs").includes('applicability: "N/A"'), "non-applicable PR scopes do not produce structured N/A")
requireInvariant(read(".github/workflows/security.yml").includes("workflow_call:"), "security gates are not composed by the universal verdict")
requireInvariant(verdict.includes("uses: ./.github/workflows/security.yml"), "universal verdict does not run gitleaks on every PR")

for (const path of [
  "finnor-os/packages/db/migrate.ts",
  "finnor-os/packages/db/drizzle.config.ts",
  "finnor-os/packages/db/seed.ts",
  "finnor-os/packages/orchestration/src/graph/setup.ts",
  "finnor-os/scripts/configure-a5-preview-app-role.ts",
  "finnor-os/scripts/create-user.ts",
  "finnor-os/scripts/install-vertical-fixture-seam.ts",
  "finnor-os/scripts/guard-staging.ts",
  "finnor-os/scripts/seed-phase9-e2e.ts",
  "finnor-os/scripts/restore-drill-from-backup.ts",
]) requireInvariant(read(path).includes("Production") || read(path).includes("production-target-guard") || read(path).includes("assertDisposableDatabaseTarget"), `${path} lacks a canonical production-target guard`)
const retiredHttpMigration = read("finnor-os/apps/api/app/api/admin/migrate/route.ts")
requireInvariant(retiredHttpMigration.includes("status: 410") && !/(\bmigrate\(|\bseed\(|\.setup\()/.test(retiredHttpMigration), "retired HTTP migration endpoint regained write capability")

const secretLines = workflow.split("\n").filter((line) => line.includes("${{ secrets."))
requireInvariant(secretLines.length > 0, "production secret wiring unexpectedly disappeared")
requireInvariant(secretLines.every((line) => /^\s{10,}[A-Z0-9_]+:\s*\$\{\{ secrets\./.test(line)), "a production secret is not scoped to a step environment")
const releaseStepBlock = (stepName) => {
  const at = workflow.lastIndexOf(`- name: ${stepName}`)
  requireInvariant(at >= 0, `missing release step ${stepName}`)
  const next = workflow.indexOf("\n      - ", at + 1)
  return workflow.slice(at, next < 0 ? undefined : next)
}
for (const installOrBuild of ["Install pinned Vercel CLI", "Install frontend dependencies", "Install API/workspace dependencies", "Frontend quality gate", "API typecheck gate"]) {
  const block = releaseStepBlock(installOrBuild)
  requireInvariant(!block.includes("${{ secrets."), `${installOrBuild} receives production secrets`)
}
for (const unprivilegedStep of [
  "Install pinned Vercel CLI",
  "Install frontend dependencies",
  "Install API/workspace dependencies",
  "Verify dependency manifests remain source-locked",
  "Validate canonical deployment truth",
  "Release governance regression tests",
  "Derive commit-locked release metadata",
  "Verify clean canonical Git source",
  "Frontend quality gate",
  "API typecheck gate",
  "Prepare disposable worker smoke database",
  "Build and smoke-test exact worker image without production credentials",
  "Verify product-runtime release policy without production credentials",
  "Build commit-locked production artifacts before any database or AWS credential",
  "Clear ECR AWS credentials before non-AWS steps",
  "Pull protected production database configuration",
  "Preflight every AWS, Vercel, and database production target",
  "Clear preflight AWS credentials before non-AWS mutation steps",
  "Verify Private Equity supplier canary app",
  "Verify Private Equity supplier canary auth",
  "Verify frontend deployment",
  "Verify API deployment",
  "Clear ECS AWS credentials",
  "Verify cross-runtime release and migration parity",
  "Verify final PE product authority readiness",
]) {
  const block = releaseStepBlock(unprivilegedStep)
  requireInvariant(block.includes('ACTIONS_ID_TOKEN_REQUEST_TOKEN: ""') && block.includes('ACTIONS_ID_TOKEN_REQUEST_URL: ""'), `${unprivilegedStep} can mint a production OIDC identity`)
}
for (const action of [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
]) {
  const at = workflow.lastIndexOf(`- uses: ${action}`)
  requireInvariant(at >= 0, `missing pinned release action ${action}`)
  const next = workflow.indexOf("\n      - ", at + 1)
  const block = workflow.slice(at, next < 0 ? undefined : next)
  requireInvariant(block.includes('ACTIONS_ID_TOKEN_REQUEST_TOKEN: ""') && block.includes('ACTIONS_ID_TOKEN_REQUEST_URL: ""'), `${action} can mint a production OIDC identity`)
}

console.log(JSON.stringify({
  ok: true,
  schema: inventory.schema,
  classifiedMechanisms: inventory.entries.length,
  activeProductionMutators: activeMutators.map((entry) => entry.id),
  retiredOneTimeMutators: inventory.entries.filter((entry) => entry.classification === "ONE_TIME_MUTATOR").map((entry) => entry.id),
  breakGlassRetained: inventory.breakGlassRetained,
  globalConcurrencyGroup: inventory.globalConcurrencyGroup,
}, null, 2))
