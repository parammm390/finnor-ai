import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { authorizeProductionMutation } from "./production-mutation-guard.mjs"
import { sanitizeVercelBuildEnvironment } from "./protected-env.mjs"
import { worktreeStatus } from "./worktree-state.mjs"

const appName = process.argv[2]
const prepareOnly = process.argv.includes("--prepare-only")
const deployOnly = process.argv.includes("--deploy-only")
const outputIndex = process.argv.indexOf("--output-file")
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
if (!["frontend", "api", "supplierCanaryApp", "supplierCanaryAuth"].includes(appName)) {
  console.error("Usage: node scripts/release/deploy-production.mjs <frontend|api|supplierCanaryApp|supplierCanaryAuth> [--prepare-only|--deploy-only] [--output-file path]")
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

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
}

function redactCommandArgs(args) {
  return args.map((arg, index) => {
    const previous = args[index - 1]
    if (previous === "--token") return "***"
    if (arg.startsWith("--token=")) return "--token=***"
    return arg
  })
}

function run(command, args, cwd, env) {
  console.log(`$ ${command} ${redactCommandArgs(args).join(" ")}`)
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
const dirty = worktreeStatus(repoRoot)
const remoteMain = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]
const buildId = process.env.FINNOR_BUILD_ID || `finnor-${commitSha.slice(0, 12)}`
const version = process.env.FINNOR_VERSION || `0.1.0+${commitSha.slice(0, 12)}`
const environment = "production"
const source = process.env.FINNOR_RELEASE_SOURCE || (prepareOnly ? "local-read-only" : "")
const vercelToken = process.env.VERCEL_TOKEN?.trim()

if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error(`HEAD is not a full commit SHA: ${commitSha}`)
if (dirty) throw new Error(`Refusing to deploy a dirty worktree:\n${dirty}`)
if (remoteMain !== commitSha) throw new Error(`Refusing to deploy ${commitSha}; origin/main is ${remoteMain || "missing"}`)
if (buildId !== `finnor-${commitSha.slice(0, 12)}`) throw new Error(`FINNOR_BUILD_ID must be commit-derived: ${buildId}`)
if (!version.endsWith(`+${commitSha.slice(0, 12)}`)) throw new Error(`FINNOR_VERSION must be commit-derived: ${version}`)
if (!prepareOnly && source !== "github-actions") throw new Error("Production deployment is restricted to the certified GitHub Actions release")
if (source === "github-actions" && !vercelToken) throw new Error("VERCEL_TOKEN is required by the certified GitHub Actions release")

function withVercelToken(args) {
  return vercelToken ? [...args, "--token", vercelToken] : args
}

const appDir = resolve(repoRoot, app.directory)
// Vercel's local build bootstrap can discover the parent finnor-os workspace
// even when the canary project is rooted at this app directory. Its fallback
// `npm install` then rewrites the parent workspace lockfile. Build canaries in
// an isolated copy so that remote project settings cannot mutate canonical
// release source; the prebuilt output is still deployed to the exact contract
// project and verified below.
const isolateCanaryBuild = appName.startsWith("supplierCanary") && !deployOnly
const buildDir = isolateCanaryBuild ? mkdtempSync(join(tmpdir(), "finnor-vercel-canary-")) : appDir
if (isolateCanaryBuild) {
  process.on("exit", () => {
    try { rmSync(buildDir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
  })
  cpSync(appDir, buildDir, {
    recursive: true,
    filter: (source) => !/(^|[/\\])(?:\.vercel|node_modules)(?:[/\\]|$)/.test(source),
  })
}
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
}
const secretNames = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "VERCEL_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "FINNOR_MUTATION_AUTHORIZATION",
  "FINNOR_PROTECTED_DATABASE_ENV",
  "VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET",
  "VERCEL_API_AUTOMATION_BYPASS_SECRET",
  "VERCEL_SUPPLIER_CANARY_APP_AUTOMATION_BYPASS_SECRET",
  "VERCEL_SUPPLIER_CANARY_AUTH_AUTOMATION_BYPASS_SECRET",
]
function withoutSecrets(sourceEnv, keep = []) {
  const result = { ...sourceEnv }
  for (const name of secretNames) if (!keep.includes(name)) delete result[name]
  return result
}

if (!deployOnly) {
  const pullDir = mkdtempSync(join(tmpdir(), "finnor-vercel-pull-"))
  let buildEnvironment
  try {
    run("vercel", withVercelToken(["pull", "--yes", "--environment=production"]), pullDir, withoutSecrets(env))
    buildEnvironment = sanitizeVercelBuildEnvironment(join(pullDir, ".vercel", ".env.production.local"), {
      FINNOR_COMMIT_SHA: commitSha,
      FINNOR_BUILD_ID: buildId,
      FINNOR_VERSION: version,
      FINNOR_ENVIRONMENT: environment,
      FINNOR_RELEASE_SOURCE: source,
    })
    rmSync(join(buildDir, ".vercel"), { recursive: true, force: true })
    cpSync(join(pullDir, ".vercel"), join(buildDir, ".vercel"), { recursive: true })
  } finally {
    rmSync(pullDir, { recursive: true, force: true })
  }
  console.log(`Sanitized Vercel build environment: retained ${buildEnvironment.retained}, removed ${buildEnvironment.removed} non-build values`)
  const localConfig = join(buildDir, ".vercel", "finnor-release.vercel.json")
  let buildConfig = { installCommand: app.installCommand }
  if (isolateCanaryBuild) {
    const canonicalConfig = JSON.parse(readFileSync(join(appDir, "vercel.json"), "utf8"))
    if (!canonicalConfig || typeof canonicalConfig !== "object" || Array.isArray(canonicalConfig)) {
      throw new Error(`${appName} vercel.json must contain an object configuration`)
    }
    buildConfig = { ...canonicalConfig, installCommand: app.installCommand }
  }
  writeFileSync(localConfig, `${JSON.stringify(buildConfig, null, 2)}\n`)
  run("vercel", ["build", "--prod", "--yes", "--local-config", localConfig], buildDir, withoutSecrets(env))
  const buildChanges = worktreeStatus(repoRoot)
  if (buildChanges) throw new Error(`The ${appName} build changed release source:\n${buildChanges}`)
}
if (prepareOnly) {
  console.log(JSON.stringify({ ok: true, app: appName, prepared: true, commitSha, buildId, version, environment, source }, null, 2))
  process.exit(0)
}

await authorizeProductionMutation("vercel-production-deploy")
const deployArgs = [
  "deploy", "--prebuilt", "--prod", "--yes",
  "--meta", `finnorCommitSha=${commitSha}`,
  "--meta", `finnorBuildId=${buildId}`,
  "--meta", `finnorVersion=${version}`,
  "--meta", `finnorEnvironment=${environment}`,
  "--meta", `finnorReleaseSource=${source}`,
  "--meta", "gitDirty=0",
  "--meta", "githubDeployment=1",
  "--meta", "githubCommitOrg=parammm390",
  "--meta", "githubCommitRepo=finnor-ai",
  "--meta", "githubCommitRef=main",
  "--meta", `githubCommitSha=${commitSha}`,
  "--env", `FINNOR_COMMIT_SHA=${commitSha}`,
  "--env", `FINNOR_BUILD_ID=${buildId}`,
  "--env", `FINNOR_VERSION=${version}`,
  "--env", `FINNOR_ENVIRONMENT=${environment}`,
  "--env", `FINNOR_RELEASE_SOURCE=${source}`,
]
const deployOutput = run("vercel", withVercelToken(deployArgs), buildDir, withoutSecrets(env))
const urls = [...deployOutput.matchAll(/https:\/\/[^\s)]+/g)].map((match) => match[0].replace(/[.,]+$/, ""))
const productionUrls = [...deployOutput.matchAll(/^\s*Production:\s+(https:\/\/[^\s)]+)/gm)].map((match) => match[1].replace(/[.,]+$/, ""))
const deploymentUrl = productionUrls.at(-1) ?? urls.findLast((url) => url.includes(".vercel.app"))
if (!deploymentUrl) throw new Error("Vercel did not return a deployment URL")
if (new URL(deploymentUrl).protocol !== "https:") throw new Error("Vercel returned a non-HTTPS deployment URL")

const result = {
  app: appName,
  project: app.project,
  projectId: app.projectId,
  commitSha,
  buildId,
  version,
  environment,
  source,
  dirty: false,
  remoteMain,
  deploymentUrl,
}
if (outputFile) {
  writeFileSync(resolve(outputFile), `${JSON.stringify(result, null, 2)}\n`)
}
process.stdout.write(`\nFINNOR_DEPLOYMENT_URL=${deploymentUrl}\n`)
console.log(JSON.stringify(result, null, 2))
if (isolateCanaryBuild) rmSync(buildDir, { recursive: true, force: true })
