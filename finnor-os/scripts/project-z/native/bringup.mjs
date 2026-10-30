// Scenario: authenticated transport bring-up of the integrated native stack.
// Establishes only that real Auth, the migrated application and the worker role
// are reachable by the real owner. It admits no phase.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const state = process.env.FINNOR_NATIVE_STATE
const evidence = process.env.FINNOR_NATIVE_EVIDENCE
assert.ok(state && evidence, "NATIVE_SCENARIO_ENVIRONMENT_REQUIRED")
mkdirSync(evidence, { mode: 0o700 })
const env = JSON.parse(readFileSync(join(state, "native-environment-01.private.json"), "utf8"))
const appState = JSON.parse(readFileSync(join(state, "native-app-state.json"), "utf8"))
const sha = value => createHash("sha256").update(value).digest("hex")
const result = { schema: "finnor.project-z.native-bringup.v1", startedAt: new Date().toISOString(),
  redaction: "no credential, token or credentialed URL recorded", launcher: {
    status: appState.status, profiles: appState.profiles ?? null, workerDatabaseRole: appState.workerDatabaseRole,
    workerLifecycle: appState.workerLifecycle, authBypass: appState.authBypass },
  http: {}, checks: [] }
const check = (name, ok, detail = {}) => { result.checks.push({ name, ok: Boolean(ok), ...detail }); }
const save = () => writeFileSync(join(evidence, "bringup.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
try {
  const login = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: env.TEST_OWNER_EMAIL, password: env.TEST_OWNER_PASSWORD }) })
  const session = await login.json().catch(() => ({}))
  check("real-auth-password-grant", login.status === 200 && typeof session.access_token === "string", { status: login.status })
  const call = async (path, init = {}) => {
    const response = await fetch("http://127.0.0.1:3101" + path, { ...init,
      headers: { ...(init.headers ?? {}), authorization: "Bearer " + session.access_token, "content-type": "application/json" } })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { status: response.status, bodySha256: sha(text), body }
  }
  const anonymous = await fetch("http://127.0.0.1:3101/api/me")
  check("unauthenticated-me-is-401", anonymous.status === 401, { status: anonymous.status })
  const me = await call("/api/me")
  const meData = me.body?.data ?? me.body ?? {}
  check("authenticated-me", me.status === 200 && Boolean(meData.tenantId ?? meData.tenant_id), { status: me.status, keys: Object.keys(meData).sort() })
  result.http.me = { status: me.status, bodySha256: me.bodySha256 }
  const works = await call("/api/works")
  check("authenticated-works-list", works.status === 200, { status: works.status })
  result.http.works = { status: works.status, bodySha256: works.bodySha256 }
  const front = await fetch("http://127.0.0.1:3001/centropy/login")
  check("mounted-login-page", front.status === 200, { status: front.status })
  result.status = result.checks.every(row => row.ok) ? "BRINGUP_OBSERVED" : "BRINGUP_FAILED"
} catch (error) {
  result.status = "BRINGUP_ERROR"
  result.failure = String(error?.message ?? error).split("\n")[0].slice(0, 300)
  process.exitCode = 1
} finally {
  result.finishedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify({ status: result.status, failure: result.failure ?? null }))
}
if (result.status !== "BRINGUP_OBSERVED") process.exitCode = 1
