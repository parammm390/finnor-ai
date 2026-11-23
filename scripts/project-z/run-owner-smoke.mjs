import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const state = option("state")
const attempt = option("app-attempt")
const evidence = option("evidence")
const browsers = option("browsers")
assert.ok(state && isAbsolute(state) && state.startsWith(join(root, ".centropy-certification") + "/"))
assert.match(attempt ?? "", /^[0-9]{2}$/)
assert.ok(evidence && isAbsolute(evidence) && !existsSync(evidence), "New private smoke evidence directory required")
assert.ok(browsers && isAbsolute(browsers))
const appFile = join(state, attempt === "01" ? "native-app-state.json" : `native-app-state-${attempt}.json`)
const appBytes = readFileSync(appFile)
const app = JSON.parse(appBytes)
assert.equal(app.status, "READY_REAL_AUTHENTICATED_NATIVE_TARGET")
assert.equal(app.authBypass, false)
assert.equal(app.environmentFile, `native-environment-${attempt}.private.json`)
const environmentFile = join(state, app.environmentFile)
assert.equal(statSync(environmentFile).mode & 0o777, 0o600)
const env = JSON.parse(readFileSync(environmentFile, "utf8"))
assert.ok(env.TEST_OWNER_EMAIL && env.TEST_OWNER_PASSWORD && !env.AUTH_DEV_BYPASS)
assert.equal(env.SUPABASE_URL, "http://127.0.0.1:54321")
mkdirSync(evidence, { mode: 0o700 })
writeFileSync(join(evidence, "bound-app-receipt.json"), appBytes, { flag: "wx", mode: 0o600 })
const receipt = { schema: "finnor.project-z.owner-smoke.v1", status: "RUNNING",
  startedAt: new Date().toISOString(), stage: "REAL_AUTH_SESSION",
  appReceiptSha256: createHash("sha256").update(appBytes).digest("hex"),
  sourceRoot: root, serverMode: app.mode, authBypass: false, observations: {},
  originalWorkCreated: false, nativeMechanismAdmission: "NOT_RUN",
  physicalRecovery: "NOT_RUN", installedAcceptance: "NOT_RUN", phasesAccepted: [] }
function save() { writeFileSync(join(evidence, "result.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }) }
save()
try {
  const login = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.TEST_OWNER_EMAIL, password: env.TEST_OWNER_PASSWORD }),
    signal: AbortSignal.timeout(10000),
  })
  receipt.observations.authHttpStatus = login.status
  save()
  assert.equal(login.status, 200, "REAL_AUTH_SESSION_REQUIRED")
  const session = await login.json()
  assert.equal(session.user.id, app.authUserId, "SAME_REAL_AUTH_USER_REQUIRED")
  receipt.stage = "REAL_RESTRICTED_OWNER_API"
  save()
  const me = await fetch("http://127.0.0.1:3101/api/me", {
    headers: { Authorization: "Bearer " + session.access_token }, signal: AbortSignal.timeout(120000),
  })
  receipt.observations.ownerMeStatus = me.status
  assert.equal(me.status, 200, "REAL_OWNER_API_MUST_SUCCEED")
  const owner = await me.json()
  assert.equal(owner.userId, app.ownerBinding.userId, "ORIGINAL_USER_ID_MUST_BE_PRESERVED")
  assert.equal(owner.tenantId, app.ownerBinding.tenantId, "ORIGINAL_TENANT_ID_MUST_BE_PRESERVED")
  assert.equal(owner.role, "owner")
  receipt.observations.owner = { userId: owner.userId, tenantId: owner.tenantId, role: owner.role }
  receipt.stage = "MOUNTED_BROWSER_LOGIN_AND_RELOAD"
  save()
  const browserEnv = { ...env, PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3001",
    PLAYWRIGHT_OUTPUT_DIR: join(evidence, "browser-output"), CENTROPY_DISPOSABLE_E2E: "1" }
  const stdout = createWriteStream(join(evidence, "playwright.private.json"), { flags: "wx", mode: 0o600 })
  const stderr = createWriteStream(join(evidence, "playwright.private.stderr"), { flags: "wx", mode: 0o600 })
  const child = spawn(process.execPath, [join(root, "node_modules/@playwright/test/cli.js"), "test",
    "e2e/centropy-owner-login.spec.ts", "--project=desktop-chromium", "--workers=1", "--retries=0",
    "--timeout=120000", "--reporter=json"], { cwd: root, env: browserEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.pipe(stdout, { end: false })
  child.stderr.pipe(stderr, { end: false })
  let timeout = false
  let escalation
  function terminate() {
    try { process.kill(-child.pid, "SIGTERM") } catch {}
    escalation = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 2000)
    escalation.unref()
  }
  const timer = setTimeout(() => { timeout = true; terminate() }, 180000)
  process.once("SIGTERM", terminate)
  process.once("SIGINT", terminate)
  const result = await new Promise(done => {
    child.once("error", () => done({ code: null, signal: "SPAWN_ERROR" }))
    child.once("close", (code, signal) => done({ code, signal }))
  })
  clearTimeout(timer)
  if (escalation) clearTimeout(escalation)
  await Promise.all([new Promise(done => stdout.end(done)), new Promise(done => stderr.end(done))])
  receipt.browserProcess = { ...result, timedOut: timeout }
  assert.equal(result.code, 0, "MOUNTED_OWNER_BROWSER_PROCESS_FAILED")
  assert.ok(!timeout && !result.signal)
  const browser = JSON.parse(readFileSync(join(evidence, "playwright.private.json"), "utf8"))
  assert.equal(browser.stats.expected, 1, "EXACTLY_ONE_REAL_OWNER_FLOW_REQUIRED")
  assert.equal(browser.stats.skipped, 0, "SKIPPED_OWNER_FLOW_IS_NOT_PASS")
  assert.equal(browser.stats.unexpected, 0)
  assert.equal(browser.stats.flaky, 0)
  receipt.observations.mountedLoginAndReload = "PASS"
  receipt.browserStats = browser.stats
  receipt.status = "PASS_ORDINARY_DEVELOPMENT_OWNER_SMOKE_ONLY"
  receipt.stage = "COMPLETE"
} catch (error) {
  receipt.status = "FAILED_RETAINED_NO_AUTOMATIC_RETRY"
  const label = error?.message?.split("\n")[0] ?? ""
  receipt.failureCode = /^[A-Z_]+$/.test(label) ? label : error?.code ?? "SMOKE_ASSERTION_FAILED"
  process.exitCode = 1
}
receipt.finishedAt = new Date().toISOString()
save()
console.log(JSON.stringify(receipt))
