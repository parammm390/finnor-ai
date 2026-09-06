import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const appName = process.argv[2]
const prepareOnly = process.argv.includes("--prepare-only")
const deployOnly = process.argv.includes("--deploy-only")
const outputIndex = process.argv.indexOf("--output-file")
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
if (!["frontend", "api"].includes(appName)) {
  console.error("Usage: node scripts/release/deploy-production.mjs <frontend|api> [--prepare-only|--deploy-only] [--output-file path]")
  process.exit(2)
}
if (prepareOnly && deployOnly) throw new Error("--prepare-only and --deploy-only are mutually exclusive")

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const contract = JSON.parse(readFileSync(join(repoRoot, "infra/deployment/production.contract.json"), "utf8"))
const target = contract.topology[appName]
if (target?.provider !== "vercel") throw new Error(`${appName} is not a Vercel target in the canonical deployment contract`)
const app = {
  project: target.projectName,
  projectId: target.projectId,
  directory: target.releaseWorkingDirectory,
  installCommand: target.installCommand,
}
if (!app.directory || app.installCommand !== "npm ci") throw new Error(`${appName} has an unsafe or incomplete canonical build contract`)
const TEAM_ID = target.organizationId
if (process.env.VERCEL_ORG_ID && process.env.VERCEL_ORG_ID !== TEAM_ID) {
  throw new Error(`VERCEL_ORG_ID differs from the canonical deployment contract`)
}
if (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== app.projectId) {
  throw new Error(`VERCEL_PROJECT_ID differs from the canonical ${appName} project`)
}

const CORE_GATE_KEYS = [
  "source_provenance", "typecheck_build", "unit_integration", "migrations",
  "tenant_rls_security", "action_contracts", "policy_approval_boundaries",
  "workflow_runtime_recovery", "queue_idempotency", "load_latency_reliability",
  "release_deployment_invariants",
]
function stable(value) {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(",")}}`
}
function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex")
}
function loadCoreCertification(path, expectedSha) {
  if (!path) throw new Error("FINNOR_CORE_CERTIFICATION_FILE is required for a production deploy")
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8"))
  if (artifact.schema !== "finnor.core-certification/v1" || artifact.status !== "PASS") throw new Error("Production deploy requires a PASS FINNOR core certification")
  if (artifact.canonicalCoreSha !== expectedSha) throw new Error(`Core certification is for ${artifact.canonicalCoreSha || "unknown"}, not ${expectedSha}`)
  if (!Array.isArray(artifact.gates) || artifact.gates.length !== CORE_GATE_KEYS.length) throw new Error("Core certification gate set is incomplete")
  const gates = [...artifact.gates].sort((a, b) => String(a.gate).localeCompare(String(b.gate)))
  if (new Set(gates.map((gate) => gate.gate)).size !== CORE_GATE_KEYS.length || CORE_GATE_KEYS.some((key) => !gates.some((gate) => gate.gate === key && gate.status === "PASS"))) throw new Error("Core certification contains a non-PASS or missing gate")
  for (const gate of gates) if (gate.evidenceHash !== sha256(gate.evidence)) throw new Error(`Core certification gate evidence was modified: ${gate.gate}`)
  const suiteHash = sha256({ version: "phase6-core-v1", gates: CORE_GATE_KEYS })
  const evidenceHash = sha256(gates.map(({ gate, status, evidenceHash }) => ({ gate, status, evidenceHash })))
  const identityHash = sha256({ canonicalCoreSha: expectedSha, coreSourceTreeHash: artifact.coreSourceTreeHash, suiteHash, evidenceHash })
  if (artifact.suiteHash !== suiteHash || artifact.evidenceHash !== evidenceHash || artifact.certificationId !== `corecert-${identityHash}`) throw new Error("Core certification identity/integrity verification failed")
  return artifact
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
}

function run(command, args, cwd, env) {
  const safeArgs = args.map((arg, index) => args[index - 1] === "--token" ? "<redacted>" : arg === "--token" ? arg : arg)
  console.log(`$ ${command} ${safeArgs.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status || 1)
  return result.stdout || ""
}

const commitSha = git(["rev-parse", "HEAD"]).toLowerCase()
const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"])
const remoteMain = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]
const buildId = process.env.FINNOR_BUILD_ID || `finnor-${commitSha.slice(0, 12)}`
const version = process.env.FINNOR_VERSION || `0.1.0+${commitSha.slice(0, 12)}`
const environment = "production"
const source = process.env.FINNOR_RELEASE_SOURCE || (process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "codex-governed-release")
const coreCertification = loadCoreCertification(process.env.FINNOR_CORE_CERTIFICATION_FILE, commitSha)

if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error(`HEAD is not a full commit SHA: ${commitSha}`)
if (dirty) throw new Error(`Refusing to deploy a dirty worktree:\n${dirty}`)
if (remoteMain !== commitSha) throw new Error(`Refusing to deploy ${commitSha}; origin/main is ${remoteMain || "missing"}`)
if (buildId !== `finnor-${commitSha.slice(0, 12)}`) throw new Error(`FINNOR_BUILD_ID must be commit-derived: ${buildId}`)
if (!version.endsWith(`+${commitSha.slice(0, 12)}`)) throw new Error(`FINNOR_VERSION must be commit-derived: ${version}`)

const appDir = resolve(repoRoot, app.directory)
const tokenArgs = process.env.VERCEL_TOKEN ? ["--token", process.env.VERCEL_TOKEN] : []
const env = {
  ...process.env,
  // Vercel treats VERCEL_ORG_ID and VERCEL_PROJECT_ID as a pair. Scope every
  // link/pull/build/deploy invocation to the exact project in the contract.
  VERCEL_ORG_ID: TEAM_ID,
  VERCEL_PROJECT_ID: app.projectId,
  FINNOR_COMMIT_SHA: commitSha,
  FINNOR_BUILD_ID: buildId,
  FINNOR_VERSION: version,
  FINNOR_ENVIRONMENT: environment,
  FINNOR_RELEASE_SOURCE: source,
  FINNOR_CORE_CERTIFICATION_ID: coreCertification.certificationId,
}

if (!deployOnly) {
  run("vercel", ["pull", "--yes", "--environment=production", ...tokenArgs], appDir, env)
  const localConfig = join(appDir, ".vercel", "finnor-release.vercel.json")
  writeFileSync(localConfig, `${JSON.stringify({ installCommand: app.installCommand }, null, 2)}\n`)
  run("vercel", ["build", "--prod", "--yes", "--local-config", localConfig, ...tokenArgs], appDir, env)
}
if (prepareOnly) {
  console.log(JSON.stringify({ ok: true, app: appName, prepared: true, commitSha, buildId, version, environment, source }, null, 2))
  process.exit(0)
}

const deployArgs = [
  "deploy", "--prebuilt", "--prod", "--yes",
  "--meta", `finnorCommitSha=${commitSha}`,
  "--meta", `finnorBuildId=${buildId}`,
  "--meta", `finnorVersion=${version}`,
  "--meta", `finnorEnvironment=${environment}`,
  "--meta", `finnorReleaseSource=${source}`,
  "--meta", `finnorCoreCertificationId=${coreCertification.certificationId}`,
  "--meta", "gitDirty=0",
  "--meta", "githubDeployment=1",
  "--meta", "githubCommitOrg=parammm390",
  "--meta", "githubCommitRepo=JARVIS",
  "--meta", "githubCommitRef=main",
  "--meta", `githubCommitSha=${commitSha}`,
  "--env", `FINNOR_COMMIT_SHA=${commitSha}`,
  "--env", `FINNOR_BUILD_ID=${buildId}`,
  "--env", `FINNOR_VERSION=${version}`,
  "--env", `FINNOR_ENVIRONMENT=${environment}`,
  "--env", `FINNOR_RELEASE_SOURCE=${source}`,
  "--env", `FINNOR_CORE_CERTIFICATION_ID=${coreCertification.certificationId}`,
  ...tokenArgs,
]
const deployOutput = run("vercel", deployArgs, appDir, env)
const urls = [...deployOutput.matchAll(/https:\/\/[^\s)]+/g)].map((match) => match[0].replace(/[.,]+$/, ""))
const deploymentUrl = urls.at(-1)
if (!deploymentUrl) throw new Error("Vercel did not return a deployment URL")

const result = {
  app: appName,
  project: app.project,
  projectId: app.projectId,
  commitSha,
  buildId,
  version,
  environment,
  source,
  coreCertificationId: coreCertification.certificationId,
  dirty: false,
  remoteMain,
  deploymentUrl,
}
if (outputFile) {
  writeFileSync(resolve(outputFile), `${JSON.stringify(result, null, 2)}\n`)
}
console.log(`FINNOR_DEPLOYMENT_URL=${deploymentUrl}`)
console.log(JSON.stringify(result, null, 2))
