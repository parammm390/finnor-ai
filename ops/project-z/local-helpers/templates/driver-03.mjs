// Worker G attempt 29 Z1 native session: isolated real Auth+DB, scratch app (--profile=z1 --no-worker),
// product-library seeding, authenticated HTTP and mounted browser observation, offline fixture attempt.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { createWriteStream, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const name = process.argv[2]
assert.match(name, /^g29-z1-native-[0-9]{2}$/)
assert.ok(!["g29-z1-native-01", "g29-z1-native-02"].includes(name), "ATTEMPT_RETAINED")
const S = "/home/factory-user/repos/fzv-g-scratch-29", O = "/home/factory-user/repos/fzv-g-out-29"
const ev = join(O, name), state = join(S, ".centropy-certification", name), tmp = "/tmp/" + name
const hs = "/home/factory-user/repos/fzv-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"
for (const p of [ev, state, tmp]) assert.ok(!existsSync(p), "NEW_RUN_NAME_REQUIRED")
mkdirSync(ev, { mode: 0o700 }); mkdirSync(tmp, { mode: 0o700 }); mkdirSync(join(S, ".centropy-certification"), { recursive: true, mode: 0o700 })
const sha = b => createHash("sha256").update(b).digest("hex")
const r = { schema: "fzv-g-29.z1-native-session.v1", name, startedAt: new Date().toISOString(), sourceRoot: S, state,
  redaction: "no email, password, token, key or credentialed URL recorded", children: {}, processes: {}, http: {}, browser: {}, steps: [] }
const save = () => writeFileSync(join(ev, "result.json"), JSON.stringify(r, null, 2) + "\n", { mode: 0o600 })
const baseEnv = { PATH: "/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:/usr/bin:/bin", HOME: tmp, TMPDIR: tmp, LANG: "C.UTF-8" }
const kids = []
function start(label, cmd, args, ready, cwd = S) {
  const log = createWriteStream(join(ev, label + ".private.log"), { flags: "wx", mode: 0o600 })
  const c = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: baseEnv })
  kids.push(c); r.children[label] = { pid: c.pid, args: args.map(a => a.replace(/^--(state|auth-binary)=.*/, "--$1=<path>")) }
  let buf = "", out = ""
  const done = new Promise(res => c.once("close", (code, signal) => { Object.assign(r.children[label], { code, signal, endedAt: new Date().toISOString() }); save(); res({ code, signal, out }) }))
  const readyP = new Promise(res => {
    c.stdout.on("data", d => { log.write(d); buf += d; out += d; for (const line of buf.split("\n")) { try { if (ready && JSON.parse(line).status === ready) res(true) } catch {} } })
    c.stderr.on("data", d => log.write(d)); done.then(() => res(false))
  })
  return { c, done, ready: readyP }
}
const bounded = (p, ms) => Promise.race([p, delay(ms, false, { ref: false })])
async function stopOne(c) {
  if (c.exitCode !== null || c.signalCode !== null) return "ALREADY_EXITED"
  try { process.kill(-c.pid, "SIGTERM") } catch {}
  await bounded(new Promise(res => c.once("close", res)), 20000)
  if (c.exitCode === null && c.signalCode === null) { try { process.kill(-c.pid, "SIGKILL") } catch {}; return "SIGKILL_AFTER_20S" }
  return "SIGTERM"
}
function identity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const exe = readlinkSync(`/proc/${pid}/exe`)
    return { pid, startTicks: fields[19], uid: readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)[1],
      executable: exe, executableSha256: sha(readFileSync(exe)), commandLineSha256: sha(readFileSync(`/proc/${pid}/cmdline`)), cwd: readlinkSync(`/proc/${pid}/cwd`) }
  } catch (e) { return { pid, error: e.code ?? "UNREADABLE" } }
}
function run(label, args, cwd, timeoutMs) {
  return new Promise(res => {
    const begin = Date.now(), c = spawn(process.execPath, args, { cwd, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = ""; c.stdout.on("data", d => out += d); c.stderr.on("data", d => err += d)
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs)
    c.once("close", (code, signal) => {
      clearTimeout(t); writeFileSync(join(ev, label + ".stdout.log"), out, { mode: 0o600 }); writeFileSync(join(ev, label + ".stderr.private.log"), err, { mode: 0o600 })
      const errorLine = (err.match(/Error: [A-Z0-9_]+/) ?? [null])[0]
      const row = { label, code, signal, ms: Date.now() - begin, stdoutSha256: sha(out), stderrSha256: sha(err), stdoutTail: out.slice(-600), errorLine }
      r.steps.push(row); save(); res(row)
    })
  })
}
const tsx = createRequire(join(S, "finnor-os/package.json")).resolve("tsx")
let app, auth
try {
  const inst = start("auth-install", "/usr/bin/python3", ["-I", "-B", join(S, "scripts/project-z/install-isolated-auth.py"), "--target", join(tmp, "auth-toolchain"), "--archive", "/tmp/fzv-native-02/auth-toolchain/auth.tar.xz"])
  assert.equal((await inst.done).code, 0, "AUTH_INSTALL_FAILED")
  auth = start("auth", process.execPath, [join(S, "scripts/project-z/start-isolated-auth.mjs"), "--state=" + state, "--auth-binary=" + join(tmp, "auth-toolchain/auth")], "READY_REAL_LOCAL_AUTH_AND_DATABASE")
  assert.ok(await bounded(auth.ready, 240000), "AUTH_READY_REQUIRED")
  r.authReadyAt = new Date().toISOString(); save()
  app = start("app", process.execPath, [join(S, "scripts/project-z/start-isolated-app.mjs"), "--state=" + state, "--profile=z1", "--no-worker"], "READY_REAL_AUTHENTICATED_NATIVE_TARGET")
  assert.ok(await bounded(app.ready, 1200000), "APP_READY_REQUIRED")
  r.appReadyAt = new Date().toISOString()
  const appState = JSON.parse(readFileSync(join(state, "native-app-state.json"), "utf8")), authState = JSON.parse(readFileSync(join(state, "state.json"), "utf8"))
  r.appState = { status: appState.status, mode: appState.mode, profiles: appState.profiles, profileEnvNames: appState.profileEnvNames, stockWorker: appState.stockWorker,
    steps: appState.steps, ownerBinding: appState.ownerBinding, readiness: appState.readiness, pids: appState.pids, authBypass: appState.authBypass }
  r.authState = { status: authState.status, authentication: authState.authentication, authUserId: authState.authUserId, pids: authState.pids, authBypass: authState.authBypass }
  for (const [label, pid] of Object.entries({ ...Object.fromEntries(Object.entries(authState.pids ?? {}).map(([k, v]) => ["auth-" + k, v])), ...Object.fromEntries(Object.entries(appState.pids ?? {}).map(([k, v]) => ["app-" + k, v])) }))
    if (pid) r.processes[label] = identity(pid)
  const env = JSON.parse(readFileSync(join(state, "native-environment-01.private.json"), "utf8"))
  r.environmentNames = Object.keys(env).sort(); save()
  mkdirSync(join(ev, "seed"), { mode: 0o700 })
  const seed = await run("seed", ["--import", tsx, join(O, "z1-seed/seed-03.mjs"), state, join(ev, "seed"), S], join(S, "finnor-os"), 300000)
  let bindings = null
  try { bindings = JSON.parse(readFileSync(join(ev, "seed/bindings-without-s6-obligation.json"), "utf8")) } catch {}
  r.seed = { code: seed.code, receiptSha256: existsSync(join(ev, "seed/seed-receipt.json")) ? sha(readFileSync(join(ev, "seed/seed-receipt.json"))) : null,
    bindingsSha256: bindings ? sha(readFileSync(join(ev, "seed/bindings-without-s6-obligation.json"))) : null }
  save()
  const login = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ email: env.TEST_OWNER_EMAIL, password: env.TEST_OWNER_PASSWORD }) })
  const session = await login.json().catch(() => ({}))
  r.http.passwordLogin = { status: login.status, accessToken: session.access_token ? "PRESENT_NOT_RECORDED" : "ABSENT" }
  const api = async (path) => {
    const res = await fetch("http://127.0.0.1:3101" + path, { headers: { authorization: "Bearer " + session.access_token } })
    const text = await res.text(); let body = null; try { body = JSON.parse(text) } catch {}
    return { status: res.status, bodySha256: sha(text), body }
  }
  const me = await api("/api/me")
  const meData = me.body?.data ?? me.body ?? {}
  r.http.me = { status: me.status, bodySha256: me.bodySha256, userId: meData.userId ?? null, employeeId: meData.employeeId ?? null, principalId: meData.principalId ?? null,
    tenantId: meData.tenantId ?? null, role: meData.role ?? null, keys: Object.keys(meData).sort() }
  r.http.unauthenticatedMe = (await fetch("http://127.0.0.1:3101/api/me")).status
  if (bindings) {
    r.http.works = {}
    for (const id of [...bindings.works.map(w => w.workId), bindings.foreignWorkId]) {
      const w = await api("/api/works/" + id), d = w.body?.data ?? w.body ?? {}
      writeFileSync(join(ev, `work-${id}.private.json`), JSON.stringify(w.body, null, 2) + "\n", { mode: 0o600 })
      r.http.works[id] = { status: w.status, bodySha256: w.bodySha256, id: d.id ?? d.work?.id ?? null, state: d.status ?? d.state ?? d.work?.status ?? null, keys: Object.keys(d).sort().slice(0, 40) }
    }
  }
  save()
  try {
    // A dynamic import of the CommonJS entry exposed no named chromium export in attempt 01.
    const { chromium } = createRequire(join(S, "package.json"))("@playwright/test")
    const browser = await chromium.launch({ headless: true, executablePath: hs, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] })
    r.browser.executableSha256 = sha(readFileSync(hs))
    try {
      const page = await (await browser.newContext()).newPage()
      r.browser.responses = []
      page.on("response", res => { const u = new URL(res.url()); if (u.pathname.startsWith("/api/centropy/") && r.browser.responses.length < 200) r.browser.responses.push({ path: u.pathname, status: res.status(), phase: r.browser.afterLoginPath ? (r.browser.afterReloadPath === undefined ? "after-login" : "after-reload") : "login" }) })
      await page.goto("http://127.0.0.1:3001/centropy/login", { timeout: 180000 })
      await page.getByLabel("Email").fill(env.TEST_OWNER_EMAIL)
      await page.getByLabel("Password").fill(env.TEST_OWNER_PASSWORD)
      await page.getByRole("button", { name: "Sign in" }).click()
      await page.waitForURL(u => !String(u).includes("/login"), { timeout: 180000 })
      r.browser.afterLoginPath = new URL(page.url()).pathname
      const pm = await page.request.get("http://127.0.0.1:3001/api/centropy/me"); const pmb = await pm.json().catch(() => ({})); const pmd = pmb.data ?? pmb
      r.browser.proxyMe = { status: pm.status(), userId: pmd.userId ?? null, employeeId: pmd.employeeId ?? null, principalId: pmd.principalId ?? null }
      if (bindings) { const pw = await page.request.get("http://127.0.0.1:3001/api/centropy/works/" + bindings.works[0].workId); r.browser.proxyWork0 = { status: pw.status(), bodySha256: sha(await pw.text()) } }
      await page.reload({ timeout: 180000 }); await delay(3000)
      r.browser.afterReloadPath = new URL(page.url()).pathname
      r.browser.conversationRegionVisible = await page.getByRole("region", { name: /CENTROPY/i }).first().isVisible().catch(() => false)
      await page.screenshot({ path: join(ev, "mounted-after-reload.private.png") })
      r.browser.status = "OBSERVED"
    } finally { await browser.close() }
  } catch (e) { r.browser.status = "FAILED"; r.browser.error = String(e?.message ?? e).split("\n")[0].slice(0, 300) }
  save()
  if (bindings) await run("make-native-fixture", ["--import", tsx, join(S, "finnor-os/scripts/project-z/z1/make-native-fixture.mjs"), "--bindings", join(ev, "seed/bindings-without-s6-obligation.json"), "--output", join(ev, "fixture-attempt.json")], join(S, "finnor-os"), 120000)
  await run("native-guard", ["--import", tsx, join(S, "finnor-os/scripts/project-z/z1/native-e2e.mjs"), "--report", join(ev, "native-guard")], join(S, "finnor-os"), 120000)
  r.status = "SESSION_COMPLETED"
} catch (e) {
  r.status = "SESSION_FAILED"; r.failure = String(e?.message ?? e).split("\n")[0].slice(0, 300)
} finally {
  if (app) r.children.app.stop = await stopOne(app.c)
  if (auth) r.children.auth.stop = await stopOne(auth.c)
  // Embedded PostgreSQL/Auth listeners outlived the harness exit briefly in attempt 01.
  const { execFileSync } = await import("node:child_process")
  for (let i = 0; i < 60; i++) {
    const busy = [3001, 3101, 55441, 54321, 54322].filter(p => execFileSync("ss", ["-ltn"], { encoding: "utf8" }).includes(":" + p + " "))
    r.portsBusyAfterStop = busy; if (!busy.length) break; await delay(1000)
  }
  r.finishedAt = new Date().toISOString(); save()
  console.log(JSON.stringify({ status: r.status, failure: r.failure ?? null }))
  process.exit(0)
}
