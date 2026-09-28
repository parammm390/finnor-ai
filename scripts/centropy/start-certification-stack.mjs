import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, createWriteStream, writeFileSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

// Explicit localhost fixture. Its database survives Playwright output cleanup
// and process restarts; no production credentials are used for database writes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const backend = join(root, "finnor-os")
const require = createRequire(join(backend, "package.json"))
const { default: EmbeddedPostgres } = require("embedded-postgres")
const { parse } = require("dotenv")
const readEnv = (path) => existsSync(path) ? parse(readFileSync(path)) : {}
const name = process.argv.find((arg) => arg.startsWith("--name="))?.slice(7) ?? "candidate"
if (!/^[a-z0-9-]{1,48}$/.test(name)) throw new Error("Use a short lowercase fixture name")
const stateDir = join(root, ".centropy-certification", name)
mkdirSync(stateDir, { recursive: true })
const rootEnv = readEnv(join(root, ".env.local"))
const apiEnv = readEnv(join(backend, "apps/api/.env.local"))
const env = { ...process.env, ...rootEnv, ...readEnv(join(backend, ".env")), ...apiEnv,
  DATABASE_URL: "postgres://finnor_app:finnor_app@127.0.0.1:55441/finnor",
  NEXT_PUBLIC_OS_API_URL: "http://127.0.0.1:3101", FINNOR_OS_API_URL: "http://127.0.0.1:3101", WORKER_CONCURRENCY: "4" }
delete env.AUTH_DEV_BYPASS
const productionBuild = process.argv.includes("--production-build")
if (productionBuild) {
  if (!existsSync(join(root, ".next/BUILD_ID")) || !existsSync(join(backend, "apps/api/.next/BUILD_ID"))) throw new Error("Build both frontend and API before compiled local certification")
  Object.assign(env, { SECRETS_PROVIDER: "env", ALLOW_PLAINTEXT_ENV_SECRETS: "1" })
}
if (!rootEnv.TEST_OWNER_EMAIL || !rootEnv.TEST_OWNER_PASSWORD) throw new Error("Fixture owner sign-in variables are required")
if (env.SUPABASE_URL !== rootEnv.NEXT_PUBLIC_SUPABASE_URL) throw new Error("Frontend and API must use the same Supabase Auth project")
const adminEnv = { ...env, DATABASE_URL: "postgres://finnor:finnor@127.0.0.1:55441/finnor", FINNOR_TEST_MANAGED_EXTENSIONS: "omit" }
const smtpCanary = process.argv.includes("--smtp-canary")
if (smtpCanary) {
  if (name !== "atlas-temporal-clone") throw new Error("SMTP canary requires its named disposable clone")
  Object.assign(env, { CENTROPY_SMTP_CANARY: "1", FINNOR_LEGACY_CREDENTIAL_TENANT_IDS: "00000000-0000-4000-8000-000000000001", GMAIL_USER: "owner@centropy-certification.invalid", GMAIL_APP_PASSWORD: "fixture-only-no-real-credential" })
  Object.assign(adminEnv, { CENTROPY_SMTP_CANARY: "1" })
}
const pg = new EmbeddedPostgres({ databaseDir: join(stateDir, "postgres"), user: "finnor", password: "finnor", port: 55441, persistent: true })
const children = []
let stopping = false
function child(label, file, args, cwd, variables = env) {
  const log = createWriteStream(join(stateDir, `${label}.log`), { flags: "a", mode: 0o600 })
  log.on("error", (error) => { console.error(`${label} log failed: ${error.code ?? error.message}`); void stop(1) })
  const proc = spawn(file, args, { cwd, env: variables, stdio: ["ignore", "pipe", "pipe"], detached: true })
  proc.stdout.pipe(log); proc.stderr.pipe(log)
  children.push(proc)
  return proc
}
async function step(label, args) {
  const proc = child(label, process.execPath, ["--import", "tsx", ...args], backend, adminEnv)
  const code = await new Promise((done) => { proc.on("exit", done); proc.on("error", () => done(-1)) })
  if (code !== 0) throw new Error(`${label} failed; inspect ${join(stateDir, `${label}.log`)}`)
  console.log(`${label}: passed`)
}
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const proc of children) { try { process.kill(-proc.pid, "SIGTERM") } catch {} }
  await Promise.all(children.filter((proc) => proc.exitCode === null).map((proc) => new Promise((done) => { proc.once("exit", done); setTimeout(done, 3000) })))
  await pg.stop().catch(() => {})
  process.exit(code)
}
process.on("SIGINT", () => stop())
process.on("SIGTERM", () => stop())
try {
  const fresh = !existsSync(join(stateDir, "postgres/PG_VERSION"))
  if (fresh) await pg.initialise()
  await pg.start()
  if (fresh) await pg.createDatabase("finnor")
  await step("migrate", ["packages/db/migrate.ts"])
  if (name !== "atlas-temporal-clone") {
    await step("seed", ["packages/db/seed.ts"])
    await step("atlas-fixture", ["scripts/seed-phase9-e2e.ts"])
  }
  if (name === "atlas-temporal-clone") await step("temporal-baseline", ["scripts/seed-centropy-temporal-baseline.ts"])
  if (smtpCanary) await step("communication-fixture", ["scripts/seed-centropy-communication-canary.ts"])
  const preload = smtpCanary ? ["--import", "tsx", "--import", join(root, "scripts/centropy/smtp-canary-preload.mjs")] : []
  const api = child("api", process.execPath, [...preload, join(backend, "node_modules/next/dist/bin/next"), productionBuild ? "start" : "dev", "-p", "3101"], join(backend, "apps/api"))
  const frontend = child("frontend", process.execPath, [join(root, "node_modules/next/dist/bin/next"), productionBuild ? "start" : "dev", "-p", "3001"], root)
  const worker = child("worker", process.execPath, ["--import", "tsx", ...(smtpCanary ? ["--import", join(root, "scripts/centropy/smtp-canary-preload.mjs")] : []), "apps/worker/src/index.ts"], backend, { ...env, ...(smtpCanary ? { CENTROPY_SMTP_CAPTURE_SERVER: "1" } : {}) })
  for (const proc of [api, frontend, worker]) proc.on("exit", (code) => { if (!stopping) { console.error(`Stack process ${proc.pid} exited (${code})`); void stop(1) } })
  const state = { schema: "centropy.disposable-stack/v1", name, startedAt: new Date().toISOString(), serverMode: productionBuild ? "compiled_local_fixture" : "development", authBypass: false,
    frontend: "http://localhost:3001", api: "http://127.0.0.1:3101", database: { host: "127.0.0.1", port: 55441, name: "finnor" },
    pids: { harness: process.pid, api: api.pid, frontend: frontend.pid, worker: worker.pid } }
  writeFileSync(join(stateDir, "stack.json"), JSON.stringify(state, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(state))
} catch (error) { console.error(error instanceof Error ? error.message : "Fixture stack failed"); await stop(1) }
