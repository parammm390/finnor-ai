import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { authorizeProductionMutation } from "./production-mutation-guard.mjs"
import { readProtectedEnv, sanitizeVercelBuildEnvironment } from "./protected-env.mjs"
import { worktreeStatus } from "./worktree-state.mjs"
import { apiBuildContext, normalizeApiProjectRoot, vercelBuildConfiguration, materializeApiFunctions } from "./vercel-build-context.mjs"

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
const isCanary = appName.startsWith("supplierCanary")
const isPrepared = isCanary || appName === "api"
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const excludedSource = /(^|[/\\])(?:\.vercel|\.next|node_modules|evidence|\.git|\.env(?:\.[^/\\]*)?)(?:[/\\]|$)/

function treeSha256(directory, { sourceOnly = false, skipNodeModules = false, outputBoundary } = {}) {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("Prepared artifact root must be a real directory")
  const entries = []
  function visit(folder) {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name)
      const key = relative(directory, path).split("\\").join("/")
      const emitted = outputBoundary && path.startsWith(`${outputBoundary}/`)
      if (sourceOnly && excludedSource.test(key) || skipNodeModules && !emitted && key.split("/").some(part => ["node_modules", ".next"].includes(part))) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        if (!emitted || isAbsolute(target) || !realpathSync(path).startsWith(`${outputBoundary}/`)) throw new Error(`Prepared artifact contains an unsafe symlink: ${key}`)
        entries.push([key, "symlink", target])
        continue
      }
      if (stat.isDirectory()) { entries.push([key, "directory"]); visit(path) }
      else if (stat.isFile()) entries.push([key, "file", stat.mode & 0o777, sha256(readFileSync(path))])
      else throw new Error(`Prepared artifact contains a special file: ${key}`)
    }
  }
  visit(directory)
  return sha256(JSON.stringify(entries))
}

let preparedDir
if (isPrepared) {
  const runnerTemp = process.env.RUNNER_TEMP
  if (!runnerTemp || !isAbsolute(runnerTemp) || !existsSync(runnerTemp)) throw new Error("Canary preparation/reuse requires an existing absolute RUNNER_TEMP")
  const runner = realpathSync(runnerTemp)
  if (runner === repoRoot || !relative(repoRoot, runner).startsWith("..")) throw new Error("Prepared canaries must be outside canonical source")
  const area = isCanary ? "finnor-prepared-canaries" : "finnor-prepared-api"
  preparedDir = join(runner, area, commitSha, appName)
  // Each existing ancestor must remain inside the owned runner root.
  for (const path of [join(runner, area), join(runner, area, commitSha), preparedDir]) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || !realpathSync(path).startsWith(`${runner}/`))) {
      throw new Error("Prepared canary path has an unsafe ancestor")
    }
  }
}
const canaryIdentity = isPrepared ? {
  schema: isCanary ? "finnor.canary-prepared-artifact.v1" : "finnor.api-prepared-artifact.v1", component: appName,
  organizationId: TEAM_ID, projectId: app.projectId, project: app.project,
  ...(isCanary ? { portalRole: target.portalRole } : {}), commitSha, buildId, version, environment, source,
} : undefined
const toolchain = isPrepared ? {
  node: process.version,
  vercel: execFileSync("vercel", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim(),
  rootLockSha256: sha256(readFileSync(join(repoRoot, "package-lock.json"))),
  workspaceLockSha256: sha256(readFileSync(join(repoRoot, "finnor-os/package-lock.json"))),
  deployerSha256: sha256(readFileSync(new URL(import.meta.url))),
  protectedEnvPolicySha256: sha256(readFileSync(new URL("./protected-env.mjs", import.meta.url))),
  contractSha256: sha256(readFileSync(join(repoRoot, "infra/deployment/production.contract.json"))),
} : undefined
if (isCanary && !["app", "auth"].includes(target.portalRole)) throw new Error("Canary portal role is not canonical")

function validateCanaryConfiguration(context) {
  const project = JSON.parse(readFileSync(join(context, ".vercel/project.json"), "utf8"))
  if (project.orgId !== TEAM_ID || project.projectId !== app.projectId) throw new Error("Prepared canary project binding differs from the canonical contract")
  const path = join(context, ".vercel/.env.production.local")
  const values = readProtectedEnv(path)
  if (isCanary && values.PORTAL_ROLE !== target.portalRole) throw new Error("Prepared canary portal role differs from the canonical contract")
  if (!isCanary && project.settings?.rootDirectory !== "finnor-os/apps/api") throw new Error("Prepared API root differs from the canonical context")
  for (const [key, value] of Object.entries(values)) {
    const secretReference = !isCanary && (
      ["FINNOR_SECRET_IDS", "FINNOR_TENANT_SECRET_PREFIX", "FINNOR_SYSTEM_CREDENTIAL_PROVIDERS"].includes(key)
      || key === "SECRETS_PROVIDER" && value === "aws-secrets-manager"
    )
    if (!secretReference && /SERVICE[_-]?ROLE|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL/i.test(key) || value.startsWith("sb_secret_")) {
      throw new Error(`Prepared canary environment contains a forbidden credential class: ${key}`)
    }
    if (value.split(".").length === 3) {
      let claims
      try {
        claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"))
      } catch { /* Not a JWT; still governed by the build-value allowlist. */ }
      if (claims?.role === "service_role") throw new Error("Prepared canary environment contains a service-role JWT")
    }
  }
  // Reapply the existing allowlist without ever copying the unsanitized pull.
  const before = readFileSync(path)
  const sanitized = sanitizeVercelBuildEnvironment(path, {
    FINNOR_COMMIT_SHA: commitSha, FINNOR_BUILD_ID: buildId, FINNOR_VERSION: version,
    FINNOR_ENVIRONMENT: environment, FINNOR_RELEASE_SOURCE: source,
  })
  if (sanitized.removed !== 0 || !readFileSync(path).equals(before)) throw new Error("Prepared canary environment is not the original sanitized build environment")
}

function canaryHashes(context) {
  context = realpathSync(context)
  const outputBoundary = appName === "api" ? join(context, ".vercel/output") : undefined
  const contextSha256 = treeSha256(context, { skipNodeModules: true, outputBoundary })
  return {
    sourceSha256: treeSha256(appDir, { sourceOnly: true }),
    outputSha256: treeSha256(join(context, ".vercel/output"), { outputBoundary }),
    configSha256: treeSha256(join(context, ".vercel"), { skipNodeModules: true, outputBoundary }),
    contextSha256,
    toolchainSha256: sha256(JSON.stringify(toolchain)),
  }
}

function verifyPreparedCanary() {
  if (!existsSync(preparedDir)) throw new Error("No durable prepared canary artifact for this component/SHA")
  if (lstatSync(preparedDir).isSymbolicLink() || lstatSync(join(preparedDir, "prepared.json")).isSymbolicLink()) throw new Error("Prepared canary receipt/path is a symlink")
  const receipt = JSON.parse(readFileSync(join(preparedDir, "prepared.json"), "utf8"))
  const receiptKeys = [...Object.keys(canaryIdentity), "sourceSha256", "outputSha256", "configSha256", "contextSha256", "toolchainSha256", "toolchain", "preparedAt"].sort()
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(receiptKeys)
    || JSON.stringify(receipt.toolchain) !== JSON.stringify(toolchain)
    || typeof receipt.preparedAt !== "string" || !Number.isFinite(Date.parse(receipt.preparedAt))) {
    throw new Error("Prepared canary receipt contains unbound fields or toolchain metadata")
  }
  for (const [key, value] of Object.entries(canaryIdentity)) if (receipt[key] !== value) throw new Error(`Prepared canary identity differs: ${key}`)
  const context = join(preparedDir, "context")
  // Hash before reading configuration so an escaped/symlinked file is never read.
  const hashes = canaryHashes(context)
  if (Object.entries(hashes).some(([key, value]) => receipt[key] !== value)) throw new Error("Prepared canary source/output/config/toolchain bytes changed")
  validateCanaryConfiguration(context)
  if (Object.entries(canaryHashes(context)).some(([key, value]) => receipt[key] !== value)) throw new Error("Prepared canary configuration changed during verification")
  return receipt
}

const reuseCanary = isPrepared && existsSync(preparedDir)
if (isPrepared && deployOnly && !reuseCanary) throw new Error("No durable prepared artifact for deploy-only")
// Vercel's local build bootstrap can discover the parent finnor-os workspace
// even when the canary project is rooted at this app directory. Its fallback
// `npm install` then rewrites the parent workspace lockfile. Build canaries in
// an isolated copy so that remote project settings cannot mutate canonical
// release source; the prebuilt output is still deployed to the exact contract
// project and verified below.
const isolateCanaryBuild = appName.startsWith("supplierCanary") && !deployOnly && !reuseCanary
let buildDir = isolateCanaryBuild ? mkdtempSync(join(tmpdir(), "finnor-vercel-canary-")) : isPrepared && reuseCanary ? join(preparedDir, "context") : appDir
if (appName === "api" && !reuseCanary) {
  const context = apiBuildContext(repoRoot)
  buildDir = context.directory
  process.on("exit", context.cleanup)
}
if (isolateCanaryBuild) {
  const scratchDir = buildDir
  process.on("exit", () => {
    try { rmSync(scratchDir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
  })
  cpSync(appDir, buildDir, {
    recursive: true,
    filter: (source) => !/(^|[/\\])(?:\.vercel|node_modules)(?:[/\\]|$)/.test(source) && !excludedSource.test(relative(appDir, source)),
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

let preparedReceipt
if (reuseCanary) preparedReceipt = verifyPreparedCanary()
if (!deployOnly && !reuseCanary) {
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
    if (appName === "api") {
      const path = join(buildDir, ".vercel/project.json")
      const project = normalizeApiProjectRoot(appName, JSON.parse(readFileSync(path, "utf8")), contract)
      writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`)
    }
  } finally {
    rmSync(pullDir, { recursive: true, force: true })
  }
  console.log(`Sanitized Vercel build environment: retained ${buildEnvironment.retained}, removed ${buildEnvironment.removed} non-build values`)
  if (isPrepared) {
    // Reject credentials smuggled through public/config naming before the build.
    validateCanaryConfiguration(buildDir)
  }
  const localConfig = join(buildDir, ".vercel", "finnor-release.vercel.json")
  let buildConfig = { installCommand: app.installCommand }
  if (isolateCanaryBuild) {
    const canonicalConfig = JSON.parse(readFileSync(join(appDir, "vercel.json"), "utf8"))
    if (!canonicalConfig || typeof canonicalConfig !== "object" || Array.isArray(canonicalConfig)) {
      throw new Error(`${appName} vercel.json must contain an object configuration`)
    }
    buildConfig = { ...canonicalConfig, installCommand: app.installCommand }
  }
  writeFileSync(localConfig, `${JSON.stringify(vercelBuildConfiguration(appName, buildConfig), null, 2)}\n`)
  run("vercel", ["build", "--prod", "--yes", "--local-config", localConfig], buildDir, withoutSecrets(env))
  if (appName === "api") materializeApiFunctions(buildDir)
  const buildChanges = worktreeStatus(repoRoot)
  if (buildChanges) throw new Error(`The ${appName} build changed release source:\n${buildChanges}`)
  if (isPrepared) {
    validateCanaryConfiguration(buildDir)
    preparedReceipt = { ...canaryIdentity, ...canaryHashes(buildDir), toolchain, preparedAt: new Date().toISOString() }
    const parent = resolve(preparedDir, "..")
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const publishing = mkdtempSync(join(parent, `.${appName}-`))
    try {
      cpSync(buildDir, join(publishing, "context"), {
        recursive: true,
        verbatimSymlinks: true,
        // Only discard the build installation, never a function's traced dependencies.
        filter: (path) => {
          const key = relative(buildDir, path).replaceAll("\\", "/")
          if (key.startsWith(".vercel/output/")) return true
          return !key.split("/").some(part => ["node_modules", ".next"].includes(part))
        },
      })
      writeFileSync(join(publishing, "prepared.json"), `${JSON.stringify(preparedReceipt, null, 2)}\n`, { mode: 0o600 })
      chmodSync(join(publishing, "context/.vercel/.env.production.local"), 0o600)
      // File-mode changes are part of the persisted byte-context proof.
      const hashes = canaryHashes(join(publishing, "context"))
      if (hashes.outputSha256 !== preparedReceipt.outputSha256) throw new Error("Canary output bytes changed while persisting the artifact")
      preparedReceipt = { ...preparedReceipt, ...hashes }
      writeFileSync(join(publishing, "prepared.json"), `${JSON.stringify(preparedReceipt, null, 2)}\n`, { mode: 0o600 })
      if (existsSync(preparedDir)) throw new Error("Prepared canary artifact already exists; refusing replacement")
      renameSync(publishing, preparedDir)
      buildDir = join(preparedDir, "context")
      preparedReceipt = verifyPreparedCanary()
    } finally {
      if (existsSync(publishing)) rmSync(publishing, { recursive: true, force: true })
    }
  }
}
if (prepareOnly) {
  console.log(JSON.stringify({ ok: true, app: appName, prepared: true, commitSha, buildId, version, environment, source, ...(isPrepared ? { preparedArtifact: { directory: preparedDir, receipt: preparedReceipt } } : {}) }, null, 2))
  process.exit(0)
}

await authorizeProductionMutation("vercel-production-deploy")
if (isPrepared) {
  // Authorization is async: recheck the exact bytes at the deployment boundary.
  if (worktreeStatus(repoRoot) || git(["rev-parse", "HEAD"]).toLowerCase() !== commitSha
    || git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0] !== commitSha) throw new Error("Canonical source changed before canary deployment")
  preparedReceipt = verifyPreparedCanary()
}
const deployArgs = [
  "deploy", "--prebuilt", "--prod", "--yes",
  // The pinned CLI chunks archives before upload, bounding deployment metadata
  // without dropping any attested API dependency or rebuilding prepared bytes.
  ...(appName === "api" ? ["--archive=tgz"] : []),
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
  ...(isPrepared ? { preparedArtifact: { directory: preparedDir, receiptSha256: sha256(readFileSync(join(preparedDir, "prepared.json"))), outputSha256: preparedReceipt.outputSha256 } } : {}),
}
if (outputFile) {
  writeFileSync(resolve(outputFile), `${JSON.stringify(result, null, 2)}\n`)
}
process.stdout.write(`\nFINNOR_DEPLOYMENT_URL=${deploymentUrl}\n`)
console.log(JSON.stringify(result, null, 2))
