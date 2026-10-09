// Real builder and emitted-runtime checks, not mocked Vercel commands.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { apiBuildContext, normalizeApiProjectRoot, vercelBuildConfiguration, materializeApiFunctions } from "./vercel-build-context.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const evidence = process.env.FINNOR_ARTIFACT_EVIDENCE_DIR
assert.ok(evidence && resolve(evidence) === evidence, "An absolute evidence directory is required")
mkdirSync(evidence, { recursive: true })
for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "VERCEL_TOKEN", "FINNOR_PROTECTED_DATABASE_ENV", "AUTH_DEV_BYPASS"]) {
  assert.ok(!process.env[key], `Artifact E2E must not receive ${key}`)
}
const git = (...args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const sha = git("rev-parse", "HEAD")
const metadata = {
  FINNOR_COMMIT_SHA: sha, FINNOR_BUILD_ID: `finnor-${sha.slice(0, 12)}`,
  FINNOR_VERSION: `0.1.0+${sha.slice(0, 12)}`, FINNOR_ENVIRONMENT: "production",
  FINNOR_RELEASE_SOURCE: "github-actions", NEXT_TELEMETRY_DISABLED: "1",
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const contract = JSON.parse(readFileSync(join(root, "infra/deployment/production.contract.json"), "utf8"))
const buildSettings = JSON.parse(readFileSync(join(root, "infra/deployment/vercel-build-settings.json"), "utf8"))
const receipt = {
  schema: "finnor.production-artifact-e2e.v1", commitSha: sha,
  node: process.version, platform: process.platform, status: "FAIL",
  startedAt: new Date().toISOString(), sourceDiffSha256: hash(git("diff", "HEAD")),
  commands: [], probes: [], providerDeploymentProof: false,
  rerun: "FINNOR_ARTIFACT_EVIDENCE_DIR=/absolute/new/evidence node scripts/release/production-artifact.e2e.mjs",
}
const persist = () => writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
function emittedApiCustody(outputDirectory) {
  const functions = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name.endsWith(".func")) functions.push(path)
      else visit(path)
    }
  }
  visit(join(outputDirectory, "functions"))
  assert.ok(functions.length, "No emitted API functions")
  for (const directory of functions) {
    const config = JSON.parse(readFileSync(join(directory, ".vc-config.json"), "utf8"))
    if (config.runtime?.startsWith("nodejs")) assert.equal(config.runtime, "nodejs22.x")
  }
  const native = functions.find(directory => existsSync(join(directory, "finnor-os/packages/source-custody/index.cjs")))
  assert.ok(native, "Emitted functions did not retain the canonical native source layout")
  run(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { resolve } from 'node:path';
    const require = createRequire(pathToFileURL(resolve('finnor-os/packages/source-custody/index.cjs')));
    const custody = require('./index.cjs');
    const evidence = await import(custody.sourceURL('finnor-os/packages/private-equity/src/evidence-execution/store.ts'));
    const challenge = await import(custody.sourceURL('finnor-os/packages/private-equity/src/counterexample-search/service.ts'));
    const adapters = await import(custody.sourceURL('finnor-os/packages/private-equity/src/branch-fabric/producer-adapters.ts'));
    const p4 = await evidence.codeIdentity(), m4 = await challenge.codeIdentity();
    const ports = await adapters.initializeAuthenticProducerPorts();
    if (ports.length !== 2 || p4.files.length < 700 || m4.files.length < 700) throw Error('INCOMPLETE_NATIVE_SOURCE_CUSTODY');
    console.log(JSON.stringify({p4Sources:p4.files.length,m4Sources:m4.files.length,producerOwners:ports.map(p=>p.owner),onlyEmittedFunctionInputs:true}));
  `], native, "api-emitted-native-custody")
  receipt.probes.push({ emittedNativeFunction: native, originalCheckoutDependencies: false })
}
function run(command, args, cwd, name, component) {
  console.log(`Artifact E2E: ${name}`)
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...metadata }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 600_000 })
  const log = (result.stdout || "") + (result.stderr || "")
  writeFileSync(join(evidence, `${name}.log`), log)
  receipt.commands.push({ command, args, cwd: cwd.startsWith(root) ? cwd.slice(root.length) || "." : cwd, exitCode: result.status, logSha256: hash(log) })
  persist()
  assert.equal(result.status, 0, `${name} failed, see ${join(evidence, `${name}.log`)}\n${log.slice(-5000)}`)
}
function vercelArtifacts() {
  let apiDirectory
  const version = spawnSync("vercel", ["--version"], { encoding: "utf8" })
  assert.equal(version.status, 0)
  const toolchain = JSON.parse(readFileSync(join(root, "infra/deployment/release-toolchain.json"), "utf8"))
  assert.equal(version.stdout.trim(), toolchain.vercelCliVersion)
  receipt.toolchainSha256 = hash(readFileSync(join(root, "infra/deployment/release-toolchain.json")))
  const initialDiff = git("diff", "HEAD")
  for (const [component, settings] of Object.entries(buildSettings.components)) {
    const target = contract.topology[component]
    const canonical = resolve(root, target.releaseWorkingDirectory)
    const canary = component.startsWith("supplierCanary")
    const cwd = component === "api" ? apiBuildContext(root).directory : canary ? mkdtempSync(join(tmpdir(), `finnor-${component}-build-`)) : canonical
    if (component === "api") apiDirectory = join(cwd, "finnor-os/apps/api")
    if (canary) cpSync(canonical, cwd, { recursive: true, filter: path => !/(?:^|\/)(?:node_modules|\.vercel|\.env(?:\.[^/]*)?)(?:\/|$)/.test(path) })
    const vercel = join(cwd, ".vercel")
    mkdirSync(vercel, { recursive: true })
    writeFileSync(join(vercel, "project.json"), JSON.stringify(normalizeApiProjectRoot(component, { orgId: target.organizationId, projectId: target.projectId, projectName: target.projectName, settings: { ...settings, installCommand: target.installCommand, directoryListing: false } }, contract), null, 2))
    const values = { ...metadata, ...(canary ? { PORTAL_ROLE: target.portalRole, APP_ORIGIN: contract.topology.supplierCanaryApp.productionUrl, AUTH_ORIGIN: contract.topology.supplierCanaryAuth.productionUrl } : {}) }
    writeFileSync(join(vercel, ".env.production.local"), Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 })
    const config = { ...(canary ? JSON.parse(readFileSync(join(canonical, "vercel.json"), "utf8")) : {}), installCommand: target.installCommand }
    const localConfig = join(vercel, "finnor-release.vercel.json")
    writeFileSync(localConfig, JSON.stringify(vercelBuildConfiguration(component, config), null, 2))
    run("vercel", ["build", "--prod", "--yes", "--local-config", localConfig], cwd, `${component}-vercel-build`, component)
    const output = join(vercel, "output/config.json")
    assert.equal(JSON.parse(readFileSync(output, "utf8")).version, 3)
    if (component === "api") {
      receipt.probes.push({ materializedApiFiles: materializeApiFunctions(cwd) })
      emittedApiCustody(join(vercel, "output"))
    }
    assert.equal(git("diff", "HEAD"), initialDiff, `${component} mutated canonical tracked source`)
    receipt.probes.push({ component, buildOutputVersion: 3, configSha256: hash(readFileSync(output)), settingsSha256: hash(JSON.stringify(settings)), realVercelBuilder: true, remoteEnvironmentProof: false })
    persist()
    const cache = join(cwd, settings.rootDirectory || ".", ".next/cache")
    if (component === "frontend") rmSync(cache, { recursive: true, force: true })
  }
  return apiDirectory
}
async function apiRuntime(app) {
  const backend = resolve(app, "../..")
  const child = spawn(process.execPath, [join(backend, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3198"], {
    cwd: app, env: { ...process.env, ...metadata, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  child.stdout.on("data", bytes => { log += bytes })
  child.stderr.on("data", bytes => { log += bytes })
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })))
  try {
    let ready = false
    for (let n = 0; n < 60; n++) {
      if (child.exitCode !== null) throw new Error(`Compiled API exited early: ${log}`)
      try {
        const response = await fetch("http://127.0.0.1:3198/api/release", { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          const body = await response.json()
          assert.equal(body.commitSha, sha)
          assert.equal(body.buildId, metadata.FINNOR_BUILD_ID)
          receipt.probes.push({ path: "/api/release", status: response.status, body })
          ready = true
          break
        }
      } catch { /* poll until bounded startup deadline */ }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.ok(ready, `Compiled API never served exact release metadata: ${log}`)
    for (const [path, method] of [
      ["/api/actions/human", "POST"], ["/api/company-brain/evidence_query", "POST"],
      ["/api/branches/query", "POST"], ["/api/policies/00000000-0000-4000-8000-000000000001/general", "GET"],
      ["/api/policies/00000000-0000-4000-8000-000000000001/general/simulate", "POST"],
    ]) {
      const response = await fetch(`http://127.0.0.1:3198${path}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(10_000) })
      assert.ok([401, 403].includes(response.status), `${path} must fail closed, not fail importing native runtime (${response.status})`)
      receipt.probes.push({ path, status: response.status })
    }
    assert.doesNotMatch(log, /ENOENT|ERR_MODULE_NOT_FOUND|Cannot find module|LOADED_RUNTIME_SOURCE_IDENTITY_CHANGED/)
  } finally {
    child.kill("SIGTERM")
    await closed
    writeFileSync(join(evidence, "api-runtime.log"), log)
    persist()
  }
}
try {
  const apiDirectory = vercelArtifacts()
  assert.ok(existsSync(join(apiDirectory, ".next/BUILD_ID")))
  await apiRuntime(apiDirectory)
  receipt.status = "PASS"
} finally {
  receipt.finishedAt = new Date().toISOString()
  persist()
}
