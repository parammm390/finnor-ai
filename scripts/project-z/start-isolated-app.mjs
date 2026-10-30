import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

// Ordinary disposable development setup only. This grants no phase admission.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const backend = join(root, "finnor-os")
const require = createRequire(join(backend, "package.json"))
const state = process.argv.find(arg => arg.startsWith("--state="))?.slice(8)
assert.ok(state && isAbsolute(state) && realpathSync(state) === state)
assert.ok(state.startsWith(join(root, ".centropy-certification") + "/"))
const attempt = process.argv.find(arg => arg.startsWith("--attempt="))?.slice(10) ?? "01"
assert.match(attempt, /^[0-9]{2}$/)
const prefixFile = process.argv.find(arg => arg.startsWith("--continue-from="))?.slice(16)
const stateFile = join(state, attempt === "01" ? "native-app-state.json" : `native-app-state-${attempt}.json`)
assert.ok(!existsSync(stateFile), "New application attempt required")
const authState = JSON.parse(readFileSync(join(state, "state.json"), "utf8"))
assert.equal(authState.status, "READY_REAL_LOCAL_AUTH_AND_DATABASE")
assert.equal(authState.authBypass, false)
const environmentFile = join(state, "environment.private.json")
assert.equal(statSync(environmentFile).mode & 0o777, 0o600)
const isolated = JSON.parse(readFileSync(environmentFile, "utf8"))
assert.equal(isolated.SUPABASE_URL, "http://127.0.0.1:54321")
assert.equal(isolated.NEXT_PUBLIC_SUPABASE_URL, isolated.SUPABASE_URL)
assert.ok(!isolated.AUTH_DEV_BYPASS)
assert.equal(isolated.FINNOR_ENVIRONMENT, "ordinary_disposable")
assert.ok(isolated.TEST_OWNER_EMAIL.endsWith("@verification.invalid"))
for (const file of [join(root, ".env.local"), join(backend, ".env"), join(backend, "apps/api/.env.local")]) {
  assert.ok(!existsSync(file), "Refusing implicit repository environment loading")
}
const adminUrl = new URL(isolated.DATABASE_URL)
assert.equal(adminUrl.hostname, "127.0.0.1")
assert.equal(adminUrl.port, "55441")
assert.equal(adminUrl.pathname, "/finnor")
const appUrl = new URL(adminUrl)
appUrl.username = "finnor_app"
appUrl.password = "finnor_app"
const adminEnv = { ...isolated, RAYON_NUM_THREADS: "2", TSX_DISABLE_CACHE: "1" }
// Opt-in phase profiles reach only the application processes, never migrate/seed.
const profiles = new Set(process.argv.filter(arg => arg.startsWith("--profile=")).flatMap(arg => arg.slice(10).split(",")))
assert.ok([...profiles].every(profile => ["z1", "z2", "x1", "z3", "z5"].includes(profile)), "Unknown launcher profile")
// The Z3 runtime pins the producer bundle by digest itself; only its location is supplied here.
const z3Producer = process.argv.find(arg => arg.startsWith("--z3-producer="))?.slice(14)
assert.ok(!profiles.has("z3") || (z3Producer && isAbsolute(z3Producer) && realpathSync(z3Producer) === z3Producer),
  "Z3 producer bundle path required")
const ownsWorker = process.argv.includes("--no-worker")
// BEGIN z5-native
// Root keys are created here so the application processes can verify, from their first request, configuration
// that the scenario signs later (the S6 ledger and S8 lifecycle processes do not exist yet). Private halves stay
// 0600 under the 0700 state directory; the application receives only public keys and the deterministic file paths.
const z5Dir = join(state, "z5-private")
const z5Env = {}
if (profiles.has("z5")) {
  mkdirSync(z5Dir, { mode: 0o700, recursive: true })
  chmodSync(z5Dir, 0o700)
  for (const [name, envName] of [["transport-root", "FINNOR_S6_OWNER_TRANSPORT_ROOT"], ["consumer-root", "FINNOR_Z5_S8_CONSUMER_ROOT"]]) {
    const pair = generateKeyPairSync("ed25519")
    writeFileSync(join(z5Dir, name + ".key"), pair.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 })
    z5Env[envName] = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  }
  // The S3 fit route runs the pinned numerics inside the API process; the S3/S4 stores are shared with the
  // S8 lifecycle process and the scenario-owned worker through this private environment file.
  const z5Python = process.argv.find(arg => arg.startsWith("--z5-s3-python="))?.slice(15)
  assert.ok(z5Python && isAbsolute(z5Python) && existsSync(z5Python), "Z5_PROFILE_REQUIRES_ABSOLUTE_S3_PYTHON")
  for (const store of ["models", "policies"]) mkdirSync(join(state, "z5-stores", store), { mode: 0o700, recursive: true })
  Object.assign(z5Env, { FINNOR_S3_PYTHON: z5Python, FINNOR_S3_MODEL_STORE: join(state, "z5-stores/models"),
    FINNOR_S4_POLICY_STORE: join(state, "z5-stores/policies") })
  Object.assign(z5Env, { FINNOR_Z5_PROFILE: "ordinary_disposable",
    FINNOR_S6_OWNER_TRANSPORT_CONFIG: join(z5Dir, "transport.json"), FINNOR_Z5_S8_CONSUMER_CONFIG: join(z5Dir, "s8-consumer.json") })
}
// END z5-native
const profileEnv = {
  ...(profiles.has("z1") ? { FINNOR_Z1_PROFILE: "ordinary_disposable", P3_GOVERNORS: "1" } : {}),
  ...(profiles.has("z2") ? { FINNOR_Z2_DISPOSABLE_E2E: "1", FINNOR_Z2_CONVERGED_DEVELOPMENT: "1",
    FINNOR_Y1_PROFILE: "ordinary_disposable", FINNOR_Y3_PROFILE: "ordinary_disposable" } : {}),
  ...(profiles.has("x1") ? { FINNOR_P4_PROFILE: "ordinary_disposable" } : {}),
  ...(profiles.has("z3") ? { FINNOR_Z3_PRODUCER_BUNDLE: z3Producer,
    FINNOR_Z3_CHECKER_SOURCE: join(backend, "packages/epistemic-runtime/src/project-z/z3-viability/checker.py") } : {}),
  ...z5Env, // z5-native
}
const appEnv = { ...adminEnv, ...profileEnv, DATABASE_URL: appUrl.toString(), CENTROPY_E2E_DB_ADMIN_URL: adminUrl.toString() }
const receipt = {
  schema: "finnor.project-z.isolated-native-app.v1", status: "STARTING", stage: "MIGRATION",
  startedAt: new Date().toISOString(), sourceRoot: root, state,
  mode: "ORDINARY_DISPOSABLE_DEVELOPMENT_NOT_INSTALLED_ADMISSION",
  authUserId: authState.authUserId, authBypass: false, inheritedEnvironment: false,
  externalCredentials: false, application: "NOT_READY", phasesAccepted: [], steps: [], pids: { harness: process.pid },
  ...(profiles.size ? { profiles: [...profiles].sort(), profileEnvNames: Object.keys(profileEnv).sort() } : {}),
}
function save() { writeFileSync(stateFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }) }
const children = []
let stopping = false
function child(label, args, cwd, env) {
  const log = createWriteStream(join(state, `${label}-${attempt}.private.log`), { flags: "wx", mode: 0o600 })
  const proc = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  proc.stdout.pipe(log, { end: false })
  proc.stderr.pipe(log, { end: false })
  proc.once("close", () => log.end())
  children.push(proc)
  receipt.pids[label] = proc.pid ?? null
  save()
  return proc
}
async function stop(code, reason) {
  if (stopping) return
  stopping = true
  receipt.status = code ? "FAILED_RETAINED_NO_AUTOMATIC_RETRY" : "STOPPED"
  receipt.reason = reason
  receipt.stoppedAt = new Date().toISOString()
  save()
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(-proc.pid, "SIGTERM") } catch {}
  }
  await delay(2000)
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(-proc.pid, "SIGKILL") } catch {}
  }
  process.exit(code)
}
process.once("SIGINT", () => void stop(0, "OPERATOR_STOP"))
process.once("SIGTERM", () => void stop(0, "OPERATOR_STOP"))
setTimeout(() => void stop(1, "ORDINARY_SETUP_RUNTIME_BUDGET_EXPIRED"), 1800000).unref()
async function step(label, script) {
  receipt.stage = label
  save()
  const start = new Date().toISOString()
  const proc = child(label, ["--import", require.resolve("tsx"), join(backend, script)], backend, adminEnv)
  const timer = setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL") } catch {} }, 600000)
  const result = await new Promise(done => {
    proc.once("error", () => done({ code: null, signal: "SPAWN_ERROR" }))
    proc.once("exit", (code, signal) => done({ code, signal }))
  })
  clearTimeout(timer)
  receipt.steps.push({ label, script, start, end: new Date().toISOString(), ...result })
  save()
  assert.equal(result.code, 0, "OWNED_NATIVE_SETUP_STEP_FAILED")
  assert.equal(result.signal, null)
}
async function waitFor(url, allowedStatuses) {
  const deadline = Date.now() + 180000
  let previousStatus
  let unexpectedResponses = 0
  while (Date.now() < deadline) {
    assert.ok(children.every(proc => proc.exitCode === null || proc.exitCode === 0), "OWNED_PROCESS_EXITED")
    let response
    try { response = await fetch(url, { signal: AbortSignal.timeout(10000) }) } catch {}
    if (response) {
      if (allowedStatuses.includes(response.status)) return response.status
      unexpectedResponses = previousStatus === response.status ? unexpectedResponses + 1 : 1
      previousStatus = response.status
      assert.ok(unexpectedResponses < 3, "OWNED_APPLICATION_RETURNED_WRONG_HTTP_STATUS")
    }
    await delay(500)
  }
  throw new Error("OWNED_APPLICATION_READINESS_TIMEOUT")
}
save()
try {
  if (prefixFile) {
    assert.equal(dirname(prefixFile), state)
    assert.notEqual(prefixFile, stateFile)
    const bytes = readFileSync(prefixFile)
    const prefix = JSON.parse(bytes)
    assert.equal(prefix.status, "FAILED_RETAINED_NO_AUTOMATIC_RETRY")
    assert.equal(prefix.stage, "REAL_OWNER_DATABASE_BINDING")
    assert.equal(prefix.authUserId, authState.authUserId)
    assert.deepEqual(prefix.steps.map(row => [row.label, row.code, row.signal]),
      [["migrate", 0, null], ["seed", 0, null], ["owner-fixture", 0, null]])
    receipt.retainedBootstrap = { file: prefixFile, sha256: createHash("sha256").update(bytes).digest("hex"), steps: prefix.steps }
    save()
  } else {
    await step("migrate", "packages/db/migrate.ts")
    await step("seed", "packages/db/seed.ts")
    await step("owner-fixture", "scripts/seed-phase9-e2e.ts")
  }
  receipt.stage = "REAL_OWNER_DATABASE_BINDING"
  save()
  const { Pool } = require("pg")
  const pool = new Pool({ connectionString: appEnv.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
  try {
    const binding = await pool.query("select * from finnor_os.resolve_authenticated_identity($1)", [isolated.TEST_OWNER_EMAIL])
    assert.equal(binding.rowCount, 1, "REAL_TEST_OWNER_BINDING_MISSING")
    assert.equal(binding.rows[0].user_role, "owner", "REAL_TEST_OWNER_ROLE_REQUIRED")
    assert.equal(binding.rows[0].employee_status, "active", "REAL_TEST_OWNER_MUST_BE_ACTIVE")
    receipt.ownerBinding = { userId: binding.rows[0].user_id, tenantId: binding.rows[0].tenant_id,
      role: binding.rows[0].user_role, authorityRevision: binding.rows[0].authority_revision }
  } finally { await pool.end() }
  receipt.stage = "WORKER_DATABASE_ROLE"
  save()
  // RLS on jobs/job_delivery_attempts/compute_tenant_claim_state shows finnor_app
  // only rows of the current request tenant, so a worker connected as finnor_app
  // sees an empty queue. Global claim authority is granted only to finnor_worker
  // (migration 0171), which must stay separate from the application role.
  const workerUrl = new URL(adminUrl)
  workerUrl.username = "finnor_worker"
  workerUrl.password = "finnor_worker"
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 10000 })
  try {
    const role = await adminPool.query(`SELECT rolsuper, rolbypassrls,
      pg_has_role('finnor_app', 'finnor_worker', 'MEMBER') AS app_inherits_worker
      FROM pg_roles WHERE rolname = 'finnor_worker'`)
    assert.equal(role.rowCount, 1, "WORKER_DATABASE_ROLE_MISSING")
    assert.ok(role.rows[0].rolsuper === false && role.rows[0].rolbypassrls === false
      && role.rows[0].app_inherits_worker === false, "WORKER_DATABASE_ROLE_SEPARATION_REQUIRED")
    await adminPool.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'finnor_worker'")
  } finally { await adminPool.end() }
  const workerPool = new Pool({ connectionString: workerUrl.toString(), max: 1, connectionTimeoutMillis: 10000 })
  try {
    const identity = await workerPool.query("SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
    assert.ok(identity.rows[0]?.role === "finnor_worker" && identity.rows[0].rolsuper === false
      && identity.rows[0].rolbypassrls === false, "WORKER_DATABASE_ROLE_SEPARATION_REQUIRED")
  } finally { await workerPool.end() }
  receipt.workerDatabaseRole = "finnor_worker"
  const workerEnv = { ...appEnv, DATABASE_URL: workerUrl.toString() }
  receipt.environmentFile = `native-environment-${attempt}.private.json`
  // A scenario that must kill and restart the worker at durable boundaries owns
  // the worker lifecycle itself. It reads the worker role connection from the
  // private file only; the application processes never receive it.
  writeFileSync(join(state, receipt.environmentFile), JSON.stringify(ownsWorker
    ? { ...appEnv, FINNOR_WORKER_DATABASE_URL: workerUrl.toString() } : appEnv) + "\n", { flag: "wx", mode: 0o600 })
  receipt.workerLifecycle = ownsWorker ? "OWNED_BY_SCENARIO_NOT_STARTED_BY_LAUNCHER" : "STOCK_WORKER_STARTED_BY_LAUNCHER"
  receipt.stage = "LOOPBACK_SERVERS"
  save()
  const api = child("api", [join(backend, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", "3101"], join(backend, "apps/api"), appEnv)
  const frontend = child("frontend", [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", "3001"], root, appEnv)
  const worker = ownsWorker ? null : child("worker", ["--import", require.resolve("tsx"), join(backend, "apps/worker/src/index.ts")], backend, workerEnv)
  for (const proc of [api, frontend, ...(worker ? [worker] : [])]) {
    proc.once("exit", () => { if (!stopping) void stop(1, "OWNED_APPLICATION_PROCESS_EXITED") })
    proc.once("error", () => { if (!stopping) void stop(1, "OWNED_APPLICATION_PROCESS_START_FAILED") })
  }
  receipt.readiness = {
    apiUnauthenticated: await waitFor("http://127.0.0.1:3101/api/me", [401]),
    frontendLogin: await waitFor("http://127.0.0.1:3001/centropy/login", [200]),
  }
  Object.assign(receipt, { status: "READY_REAL_AUTHENTICATED_NATIVE_TARGET", stage: "READY",
    application: "READY_FOR_MOUNTED_OWNER_SMOKE_NOT_PHASE_ADMISSION", readyAt: new Date().toISOString() })
  save()
  console.log(JSON.stringify({ status: receipt.status, state, pids: receipt.pids, authBypass: false, phasesAccepted: [] }))
} catch (error) {
  receipt.failureCode = /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : error?.code ?? "SETUP_ASSERTION_FAILED"
  console.error("ISOLATED_APPLICATION_SETUP_FAILED_INSPECT_PRIVATE_LOCAL_LOGS")
  await stop(1, "ISOLATED_APPLICATION_SETUP_FAILED_INSPECT_PRIVATE_LOCAL_LOGS")
}
