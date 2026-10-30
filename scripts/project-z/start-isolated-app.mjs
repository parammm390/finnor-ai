import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
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
assert.ok([...profiles].every(profile => ["z1", "z2", "x1", "z3", "z4"].includes(profile)), "Unknown launcher profile")
// The Z3 runtime pins the producer bundle by digest itself; only its location is supplied here.
const z3Producer = process.argv.find(arg => arg.startsWith("--z3-producer="))?.slice(14)
assert.ok(!profiles.has("z3") || (z3Producer && isAbsolute(z3Producer) && realpathSync(z3Producer) === z3Producer),
  "Z3 producer bundle path required")
const ownsWorker = process.argv.includes("--no-worker")
// BEGIN --auth-tls-origin / --production-build / z4 profile (inert unless given)
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const authTlsOrigin = option("auth-tls-origin")
const authTlsCertificate = option("auth-tls-cert")
const authTlsState = option("auth-tls-state")
const productionBuild = process.argv.includes("--production-build")
const s3Python = option("s3-python")
assert.ok(!("NODE_TLS_REJECT_UNAUTHORIZED" in process.env), "NODE_TLS_REJECT_UNAUTHORIZED_REFUSED")
assert.ok(!profiles.has("z4") || (s3Python && isAbsolute(s3Python) && existsSync(s3Python)), "Z4_PROFILE_REQUIRES_S3_PYTHON")
// BEGIN z1 S3/S4 owner chain (the unresolved S6 obligation Z1 must preserve needs real upstream owners)
const z1Chain = profiles.has("z1") && s3Python !== undefined
assert.ok(!z1Chain || (isAbsolute(s3Python) && existsSync(s3Python)), "Z1_CHAIN_REQUIRES_EXISTING_ABSOLUTE_S3_PYTHON")
// A longer native episode (three physical kills, seven stages) needs more than the 30 minute default; bounded either way.
const setupBudgetMs = Number(option("budget-ms") ?? (productionBuild ? 3000000 : 1800000))
assert.ok(Number.isInteger(setupBudgetMs) && setupBudgetMs >= 600000 && setupBudgetMs <= 7200000, "SETUP_BUDGET_OUT_OF_RANGE")
// END
let authTlsReceipt
if (authTlsOrigin) {
  assert.ok(authTlsCertificate && authTlsState && isAbsolute(authTlsCertificate) && isAbsolute(authTlsState), "AUTH_TLS_ARGUMENTS_REQUIRED")
  const front = JSON.parse(readFileSync(join(authTlsState, "state.json"), "utf8"))
  assert.equal(front.status, "READY_LOOPBACK_TLS_AUTH_FRONT")
  assert.equal(front.origin, authTlsOrigin)
  assert.match(authTlsOrigin, /^https:\/\/127\.0\.0\.1:[0-9]{4,5}$/)
  assert.equal(front.certificateFile, authTlsCertificate)
  assert.equal(createHash("sha256").update(readFileSync(authTlsCertificate)).digest("hex"), front.certificateSha256, "AUTH_TLS_CERTIFICATE_CHANGED")
  authTlsReceipt = { origin: authTlsOrigin, certificateFile: authTlsCertificate, certificateSha256: front.certificateSha256, spkiSha256: front.spkiSha256 }
} else {
  assert.ok(!authTlsCertificate && !authTlsState, "AUTH_TLS_ORIGIN_REQUIRED")
}
const z4Stores = profiles.has("z4") || z1Chain ? ["models", "policies", "capsules"].map(name => {
  const directory = join(state, "z4-stores", name)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}) : []
// END
const profileEnv = {
  ...(profiles.has("z1") ? { FINNOR_Z1_PROFILE: "ordinary_disposable", P3_GOVERNORS: "1" } : {}),
  // BEGIN z1 S3/S4 owner chain environment
  ...(z1Chain ? { FINNOR_S3_MODEL_STORE: z4Stores[0], FINNOR_S4_POLICY_STORE: z4Stores[1], FINNOR_S3_PYTHON: s3Python } : {}),
  // END
  ...(profiles.has("z2") ? { FINNOR_Z2_DISPOSABLE_E2E: "1", FINNOR_Z2_CONVERGED_DEVELOPMENT: "1",
    FINNOR_Y1_PROFILE: "ordinary_disposable", FINNOR_Y3_PROFILE: "ordinary_disposable" } : {}),
  ...(profiles.has("x1") ? { FINNOR_P4_PROFILE: "ordinary_disposable" } : {}),
  ...(profiles.has("z3") ? { FINNOR_Z3_PRODUCER_BUNDLE: z3Producer,
    FINNOR_Z3_CHECKER_SOURCE: join(backend, "packages/epistemic-runtime/src/project-z/z3-viability/checker.py") } : {}),
  // BEGIN z4 and auth-tls environment
  ...(profiles.has("z4") ? { FINNOR_ENVIRONMENT: "staging", FINNOR_Z4_PROFILE: "ordinary_disposable",
    FINNOR_S3_MODEL_STORE: z4Stores[0], FINNOR_S4_POLICY_STORE: z4Stores[1], FINNOR_Z4_CAPSULE_STORE: z4Stores[2],
    FINNOR_S3_PYTHON: s3Python } : {}),
  ...(authTlsReceipt ? { SUPABASE_URL: authTlsReceipt.origin, NEXT_PUBLIC_SUPABASE_URL: authTlsReceipt.origin,
    NODE_EXTRA_CA_CERTS: authTlsReceipt.certificateFile } : {}),
  // END
}
const appEnv = { ...adminEnv, ...profileEnv, DATABASE_URL: appUrl.toString(), CENTROPY_E2E_DB_ADMIN_URL: adminUrl.toString() }
const receipt = {
  schema: "finnor.project-z.isolated-native-app.v1", status: "STARTING", stage: "MIGRATION",
  startedAt: new Date().toISOString(), sourceRoot: root, state,
  mode: "ORDINARY_DISPOSABLE_DEVELOPMENT_NOT_INSTALLED_ADMISSION",
  authUserId: authState.authUserId, authBypass: false, inheritedEnvironment: false,
  externalCredentials: false, application: "NOT_READY", phasesAccepted: [], steps: [], pids: { harness: process.pid },
  ...(profiles.size ? { profiles: [...profiles].sort(), profileEnvNames: Object.keys(profileEnv).sort() } : {}),
  ...(authTlsReceipt ? { authTls: authTlsReceipt } : {}),
  ...(productionBuild ? { productionBuild: { requested: true, stage: "NOT_BUILT" } } : {}),
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
setTimeout(() => void stop(1, "ORDINARY_SETUP_RUNTIME_BUDGET_EXPIRED"), setupBudgetMs).unref()
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
// BEGIN production build (own pass per run; never reuses a pre-existing build directory)
async function buildProduction() {
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const dirty = execFileSync("git", ["-C", root, "diff", "--name-only", "HEAD", "--", ".", ":(exclude)next-env.d.ts",
    ":(exclude)finnor-os/apps/api/next-env.d.ts", ":(exclude)finnor-os/apps/web/next-env.d.ts"], { encoding: "utf8" }).trim()
  assert.equal(dirty, "", "PRODUCTION_BUILD_REQUIRES_COMMITTED_SOURCE")
  const buildId = `pz-${head.slice(0, 12)}-${state.split("/").pop()}`
  const apiNext = join(backend, "node_modules/next/dist/bin/next")
  const frontendNext = join(root, "node_modules/next/dist/bin/next")
  const targets = { api: { cwd: join(backend, "apps/api"), next: apiNext }, frontend: { cwd: root, next: frontendNext } }
  for (const target of Object.values(targets)) {
    assert.ok(realpathSync(target.next).startsWith(realpathSync(root) + "/"), "PRODUCTION_BUILD_DONOR_NEXT_REFUSED")
    assert.ok(!existsSync(join(target.cwd, ".next")), "PRODUCTION_BUILD_DIRECTORY_MUST_NOT_PRE_EXIST")
  }
  const buildEnv = { ...appEnv, NODE_ENV: "production", FINNOR_BUILD_ID: buildId, CI: "1" }
  // The browser bundle inlines NEXT_PUBLIC_* at build time, so the Auth URL it will use is fixed here.
  const frontendEnv = { ...buildEnv, NEXT_PUBLIC_OS_API_URL: isolated.NEXT_PUBLIC_OS_API_URL }
  receipt.productionBuild = { requested: true, stage: "BUILDING", buildId, sourceCommit: head }
  for (const [label, env] of [["api", buildEnv], ["frontend", frontendEnv]]) {
    receipt.stage = `PRODUCTION_BUILD_${label.toUpperCase()}`
    save()
    const target = targets[label]
    const start = new Date().toISOString()
    // Only `next build`: the API package's npm build script would restamp tracked source files.
    const proc = child(`build-${label}`, [target.next, "build", ...(label === "frontend" ? ["--webpack"] : [])], target.cwd, env)
    const timer = setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL") } catch {} }, 1200000)
    const result = await new Promise(done => {
      proc.once("error", () => done({ code: null, signal: "SPAWN_ERROR" }))
      proc.once("exit", (code, signal) => done({ code, signal }))
    })
    clearTimeout(timer)
    receipt.productionBuild[label] = { start, end: new Date().toISOString(), ...result }
    save()
    assert.ok(result.code === 0 && result.signal === null, "PRODUCTION_BUILD_FAILED")
    const idFile = join(target.cwd, ".next/BUILD_ID")
    assert.ok(existsSync(idFile), "PRODUCTION_BUILD_ID_FILE_REQUIRED")
    const bytes = readFileSync(idFile)
    assert.equal(bytes.toString("utf8"), buildId, "PRODUCTION_BUILD_ID_MISMATCH")
    receipt.productionBuild[label] = { ...receipt.productionBuild[label], buildIdFile: idFile, buildIdSha256: createHash("sha256").update(bytes).digest("hex") }
    save()
  }
  if (authTlsReceipt) {
    // A browser bundle still pointing at the http gateway would make https Auth unreachable from the mounted login.
    const scan = pattern => { try { return execFileSync("grep", ["-rlF", "--include=*.js", pattern, join(root, ".next/static")], { encoding: "utf8" }).trim() } catch { return "" } }
    assert.ok(scan(authTlsReceipt.origin) !== "", "FRONTEND_BUNDLE_MISSING_HTTPS_AUTH_ORIGIN")
    assert.equal(scan(isolated.SUPABASE_URL), "", "FRONTEND_BUNDLE_STILL_INLINES_HTTP_AUTH_ORIGIN")
    receipt.productionBuild.frontend.authOriginInlined = authTlsReceipt.origin
  }
  receipt.productionBuild.stage = "BUILT"
  save()
  return { apiNext, frontendNext, buildId, serverEnv: { ...appEnv, NODE_ENV: "production", FINNOR_BUILD_ID: buildId },
    spawned: { api: [apiNext, "start", "-H", "127.0.0.1", "-p", "3101"], frontend: [frontendNext, "start", "-H", "127.0.0.1", "-p", "3001"] } }
}
// END
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
  // BEGIN production build and start
  const production = productionBuild ? await buildProduction() : null
  const api = production ? child("api", production.spawned.api, join(backend, "apps/api"), production.serverEnv)
    : child("api", [join(backend, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", "3101"], join(backend, "apps/api"), appEnv)
  const frontend = production ? child("frontend", production.spawned.frontend, root, production.serverEnv)
    : child("frontend", [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", "3001"], root, appEnv)
  // END
  const worker = ownsWorker ? null : child("worker", ["--import", require.resolve("tsx"), join(backend, "apps/worker/src/index.ts")], backend, workerEnv)
  for (const proc of [api, frontend, ...(worker ? [worker] : [])]) {
    proc.once("exit", () => { if (!stopping) void stop(1, "OWNED_APPLICATION_PROCESS_EXITED") })
    proc.once("error", () => { if (!stopping) void stop(1, "OWNED_APPLICATION_PROCESS_START_FAILED") })
  }
  receipt.readiness = {
    apiUnauthenticated: await waitFor("http://127.0.0.1:3101/api/me", [401]),
    frontendLogin: await waitFor("http://127.0.0.1:3001/centropy/login", [200]),
  }
  // BEGIN production identity of the listening servers
  if (production) {
    for (const [label, port] of [["frontend", 3001], ["api", 3101]]) {
      const listener = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" }).match(/pid=(\d+)/)
      assert.ok(listener, "PRODUCTION_LISTENER_NOT_OBSERVED")
      // The server renames its process title, so the spawned argv and the process environment are the evidence.
      const pid = Number(listener[1])
      const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
      assert.equal(pid, receipt.pids[label], "PRODUCTION_LISTENER_MUST_BE_THE_SPAWNED_NEXT_START")
      assert.ok(environment.includes("NODE_ENV=production") && environment.includes(`FINNOR_BUILD_ID=${production.buildId}`), "PRODUCTION_LISTENER_ENVIRONMENT_REQUIRED")
      receipt.productionBuild[label] = { ...receipt.productionBuild[label], listenerPid: pid, spawnedArgv: [...production.spawned[label]].map(value => value.replace(root, "<repo>")),
        processTitle: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] }
    }
    receipt.productionBuild.stage = "SERVING_NEXT_START"
  }
  // END
  Object.assign(receipt, { status: "READY_REAL_AUTHENTICATED_NATIVE_TARGET", stage: "READY",
    application: "READY_FOR_MOUNTED_OWNER_SMOKE_NOT_PHASE_ADMISSION", readyAt: new Date().toISOString() })
  save()
  console.log(JSON.stringify({ status: receipt.status, state, pids: receipt.pids, authBypass: false, phasesAccepted: [] }))
} catch (error) {
  receipt.failureCode = /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : error?.code ?? "SETUP_ASSERTION_FAILED"
  console.error("ISOLATED_APPLICATION_SETUP_FAILED_INSPECT_PRIVATE_LOCAL_LOGS")
  await stop(1, "ISOLATED_APPLICATION_SETUP_FAILED_INSPECT_PRIVATE_LOCAL_LOGS")
}
