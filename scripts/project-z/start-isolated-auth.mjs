import assert from "node:assert/strict"
import { createHmac, createHash, randomBytes } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { createServer, request } from "node:http"
import { createServer as createSocket } from "node:net"
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

// Real local Supabase Auth and PostgreSQL, never inherited hosted credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(join(root, "finnor-os/package.json"))
const { default: EmbeddedPostgres } = require("embedded-postgres")
const { Client } = require("pg")
const pins = JSON.parse(readFileSync(join(root, "infra/deployment/project-z-verification-toolchain.json"), "utf8"))
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const selected = option("state")
const binary = option("auth-binary")
assert.ok(selected && binary && isAbsolute(selected) && isAbsolute(binary), "Absolute --state and --auth-binary are required")
const state = resolve(selected)
assert.equal(realpathSync(dirname(state)), dirname(state), "State parent must not use symlinks")
assert.equal(realpathSync(binary), binary, "Auth binary must not be a symlink")
assert.ok(!existsSync(state), "State must be new; no automatic retry or reuse")
assert.equal(process.platform + "-" + process.arch, pins.supabaseAuth.platform)
assert.match(process.version, /^v22\./)
const authDirectory = dirname(binary)
assert.equal(createHash("sha256").update(readFileSync(join(authDirectory, "auth.tar.xz"))).digest("hex"), pins.supabaseAuth.archiveSha256)
const disk = statfsSync(dirname(state))
assert.ok(Number(disk.bavail) * Number(disk.bsize) >= 4 * 1024 ** 3, "Local stack needs at least four GiB free")

const reservations = []
try {
  for (const port of Object.values(pins.ports)) {
    const socket = createSocket()
    await new Promise((done, reject) => socket.once("error", reject).listen(port, "127.0.0.1", done))
    reservations.push(socket)
  }
} finally {
  await Promise.all(reservations.map(socket => new Promise(done => socket.close(done))))
}
mkdirSync(state, { mode: 0o700 })
const privateLog = createWriteStream(join(state, "postgres.private.log"), { flags: "wx", mode: 0o600 })
const secret = randomBytes(48).toString("base64url")
const password = randomBytes(32).toString("base64url")
const email = "project-z-owner@verification.invalid"
const database = `postgres://finnor:finnor@127.0.0.1:${pins.ports.database}/finnor`
const authDatabase = `postgres://finnor:finnor@127.0.0.1:${pins.ports.database}/finnor_auth`
const authOrigin = `http://127.0.0.1:${pins.ports.authGateway}`
const frontend = `http://127.0.0.1:${pins.ports.frontend}`
function jwt(role) {
  const encode = body => Buffer.from(JSON.stringify(body)).toString("base64url")
  const value = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "supabase", role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 })}`
  return `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`
}
const service = jwt("service_role")
const anon = jwt("anon")
const minimal = {
  PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: state, TMPDIR: state,
  LANG: "C.UTF-8", CI: "1", NEXT_TELEMETRY_DISABLED: "1",
}
const env = {
  ...minimal, DATABASE_URL: database, FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
  SUPABASE_URL: authOrigin, NEXT_PUBLIC_SUPABASE_URL: authOrigin,
  SUPABASE_SERVICE_ROLE_KEY: service, SUPABASE_ANON_KEY: anon, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
  TEST_OWNER_EMAIL: email, TEST_OWNER_PASSWORD: password,
  NEXT_PUBLIC_OS_API_URL: `http://127.0.0.1:${pins.ports.api}`,
  FINNOR_OS_API_URL: `http://127.0.0.1:${pins.ports.api}`,
  FINNOR_ENVIRONMENT: "ordinary_disposable", FINNOR_Z1_PROFILE: "ordinary_disposable",
  SECRETS_PROVIDER: "env", ALLOW_PLAINTEXT_ENV_SECRETS: "1", NODE_ENV: "development",
  NODE_OPTIONS: "--max-old-space-size=4096", WORKER_CONCURRENCY: "1",
}
const pg = new EmbeddedPostgres({
  databaseDir: join(state, "postgres"), user: "finnor", password: "finnor",
  port: pins.ports.database, persistent: true,
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=",
    "-c", "track_commit_timestamp=on", "-c", "shared_buffers=64MB", "-c", "max_connections=64"],
  onLog: value => privateLog.write(String(value) + "\n"),
  onError: value => privateLog.write(String(value) + "\n"),
})
let auth
let gateway
let stopping = false
const receipt = { schema: "finnor.project-z.isolated-auth.v1", status: "STARTING",
  startedAt: new Date().toISOString(), source: pins.supabaseAuth, ports: pins.ports,
  authBypass: false, inheritedCredentials: false, productionAccess: false, phasesAccepted: [],
  authentication: "NOT_RUN", application: "NOT_STARTED", state }
function save() {
  writeFileSync(join(state, "state.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 })
}
async function stop(code) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  receipt.stoppedAt = new Date().toISOString()
  receipt.status = code ? "FAILED_RETAINED_NO_AUTOMATIC_RETRY" : "STOPPED"
  save()
  if (auth && auth.exitCode === null) {
    auth.kill("SIGTERM")
    await Promise.race([new Promise(done => auth.once("exit", done)), delay(3000)])
    if (auth.exitCode === null) auth.kill("SIGKILL")
  }
  if (gateway) gateway.closeAllConnections()
  if (gateway?.listening) await new Promise(done => gateway.close(done))
  // embedded-postgres waits for a future exit event even if startup already
  // exited. Do not leave a pending cleanup promise that makes Node exit zero.
  if (pg.process && pg.process.exitCode === null) await pg.stop().catch(() => {})
  privateLog.end()
  process.exit(code)
}
process.once("SIGTERM", () => void stop(0))
process.once("SIGINT", () => void stop(0))
try {
  receipt.stage = "DATABASE_INITIALIZATION"
  save()
  await pg.initialise()
  receipt.stage = "DATABASE_START"
  save()
  await pg.start()
  await pg.createDatabase("finnor")
  await pg.createDatabase("finnor_auth")
  const client = new Client({ connectionString: authDatabase })
  await client.connect()
  try {
    await client.query("CREATE SCHEMA auth")
    await client.query("ALTER DATABASE finnor_auth SET search_path TO auth, public")
    // App migrations change this cluster role's default namespace. Keep the
    // Auth namespace fixed for every later connection to its own database.
    await client.query("ALTER ROLE finnor IN DATABASE finnor_auth SET search_path TO auth, public")
    for (const role of ["anon", "authenticated", "service_role", "postgres"]) {
      await client.query(`CREATE ROLE ${role} NOLOGIN`)
    }
  } finally { await client.end() }
  receipt.stage = "REAL_AUTH_MIGRATIONS"
  save()
  const verifiedInstallation = spawnSync("python3", ["-I", "-B", join(root, "scripts/project-z/install-isolated-auth.py"),
    "--target", authDirectory, "--verify-only"], { env: minimal, timeout: 30000, stdio: ["ignore", "ignore", "ignore"] })
  assert.equal(verifiedInstallation.status, 0, "INSTALLED_AUTH_BYTES_MUST_EQUAL_PINNED_OFFICIAL_ARCHIVE")
  const authLog = createWriteStream(join(state, "auth.private.log"), { flags: "wx", mode: 0o600 })
  const authEnv = {
      ...minimal, GOTRUE_API_HOST: "127.0.0.1", PORT: String(pins.ports.auth),
      API_EXTERNAL_URL: authOrigin + "/auth/v1", GOTRUE_SITE_URL: frontend,
      GOTRUE_DB_DRIVER: "postgres", GOTRUE_DB_DATABASE_URL: authDatabase, GOTRUE_DB_NAMESPACE: "auth",
      GOTRUE_DB_MIGRATIONS_PATH: join(authDirectory, "migrations"),
      GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_EXP: "3600", GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_ADMIN_ROLES: "service_role", GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true", GOTRUE_MAILER_AUTOCONFIRM: "true",
      GOTRUE_DISABLE_SIGNUP: "true", GOTRUE_LOG_LEVEL: "error", GOTRUE_TRACING_ENABLED: "false",
  }
  // The official default command migrates before serving; explicit `serve`
  // alone reports healthy even when its tables have not been initialized.
  const migrationLog = openSync(join(state, "auth-migrate.private.log"), "wx", 0o600)
  try {
    const migration = spawnSync(binary, ["migrate"], {
      cwd: authDirectory, env: authEnv, stdio: ["ignore", migrationLog, migrationLog], timeout: 60000,
    })
    assert.equal(migration.status, 0, "REAL_AUTH_MIGRATIONS_FAILED")
  } finally { closeSync(migrationLog) }
  receipt.stage = "REAL_AUTH_START"
  save()
  auth = spawn(binary, ["serve"], {
    cwd: authDirectory, env: authEnv, stdio: ["ignore", "pipe", "pipe"],
  })
  auth.stdout.pipe(authLog)
  auth.stderr.pipe(authLog)
  auth.once("error", () => { if (!stopping) void stop(1) })
  auth.once("exit", () => { if (!stopping) void stop(1) })
  gateway = createServer((incoming, outgoing) => {
    if (!incoming.url?.startsWith("/auth/v1/")) { outgoing.writeHead(404).end(); return }
    if (incoming.headers.origin && incoming.headers.origin !== frontend) { outgoing.writeHead(403).end(); return }
    const allowedHeaders = ["authorization", "apikey", "content-type", "x-client-info", "x-supabase-api-version"]
    const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    const cors = incoming.headers.origin === frontend ? {
      "access-control-allow-origin": frontend, "vary": "Origin",
      "access-control-allow-headers": allowedHeaders.join(", "),
      "access-control-allow-methods": allowedMethods.join(", "),
    } : {}
    if (incoming.method === "OPTIONS" && incoming.headers.origin === frontend) {
      const requestedHeaders = String(incoming.headers["access-control-request-headers"] ?? "")
        .split(",").map(value => value.trim().toLowerCase()).filter(Boolean)
      if (!allowedMethods.includes(String(incoming.headers["access-control-request-method"] ?? "")) ||
          requestedHeaders.some(value => !allowedHeaders.includes(value))) {
        outgoing.writeHead(403).end(); return
      }
      outgoing.writeHead(204, cors).end(); return
    }
    const upstream = request({
      host: "127.0.0.1", port: pins.ports.auth, method: incoming.method,
      path: incoming.url.slice("/auth/v1".length), headers: { ...incoming.headers, host: `127.0.0.1:${pins.ports.auth}` },
      timeout: 10000,
    }, response => { outgoing.writeHead(response.statusCode, { ...response.headers, ...cors }); response.pipe(outgoing) })
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502, cors); outgoing.end() })
    upstream.on("timeout", () => upstream.destroy())
    incoming.pipe(upstream)
  })
  gateway.requestTimeout = 15000
  await new Promise((done, reject) => gateway.once("error", reject).listen(pins.ports.authGateway, "127.0.0.1", done))
  const limit = Date.now() + 60000
  while (true) {
    if (auth.exitCode !== null) throw new Error("AUTH_PROCESS_EXITED")
    const healthy = await fetch(authOrigin + "/auth/v1/health", { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)
    if (healthy) break
    assert.ok(Date.now() < limit, "AUTH_STARTUP_DEADLINE")
    await delay(200)
  }
  receipt.stage = "REAL_AUTH_USER_CREATION"
  save()
  const created = await fetch(authOrigin + "/auth/v1/admin/users", {
    method: "POST", headers: { Authorization: "Bearer " + service, apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }), signal: AbortSignal.timeout(10000),
  })
  assert.equal(created.status, 200, "REAL_AUTH_USER_CREATION_FAILED")
  const user = await created.json()
  assert.match(user.id, /^[0-9a-f-]{36}$/)
  receipt.stage = "REAL_AUTH_PASSWORD_LOGIN"
  save()
  const login = await fetch(authOrigin + "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10000),
  })
  assert.equal(login.status, 200, "REAL_AUTH_PASSWORD_LOGIN_FAILED")
  const session = await login.json()
  receipt.stage = "REAL_AUTH_SESSION_VERIFICATION"
  save()
  const verified = await fetch(authOrigin + "/auth/v1/user", {
    headers: { apikey: anon, Authorization: "Bearer " + session.access_token }, signal: AbortSignal.timeout(10000),
  })
  assert.equal(verified.status, 200, "REAL_AUTH_SESSION_VERIFICATION_FAILED")
  assert.equal((await verified.json()).id, user.id)
  writeFileSync(join(state, "environment.private.json"), JSON.stringify(env) + "\n", { flag: "wx", mode: 0o600 })
  Object.assign(receipt, { status: "READY_REAL_LOCAL_AUTH_AND_DATABASE", authentication: "REAL_CREATE_PASSWORD_LOGIN_AND_USER_VERIFICATION_PASSED",
    stage: "READY", authUserId: user.id, pids: { harness: process.pid, auth: auth.pid }, readyAt: new Date().toISOString() })
  save()
  console.log(JSON.stringify({ status: receipt.status, authentication: receipt.authentication, state, ports: pins.ports }))
} catch {
  // Raw upstream failures can contain credentials; retain private logs only.
  receipt.failure = "ISOLATED_SETUP_FAILED_INSPECT_PRIVATE_LOCAL_LOGS"
  console.error(receipt.failure)
  await stop(1)
}
