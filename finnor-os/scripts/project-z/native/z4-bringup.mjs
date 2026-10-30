// Scenario: transport-only bring-up of the https-Auth production-build native stack.
// It establishes that the declared self-signed Auth certificate is trusted by exactly the
// declared processes, that the API and the mounted login are production builds with pinned
// BUILD_ID files, and that the real owner can sign in through the mounted browser path.
// It runs no Z4 work and admits no phase.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:https"
import { join } from "node:path"

const state = process.env.FINNOR_NATIVE_STATE
const evidence = process.env.FINNOR_NATIVE_EVIDENCE
const root = process.env.FINNOR_NATIVE_ROOT
const tlsState = process.env.FINNOR_NATIVE_AUTH_TLS_STATE
const chromium = process.env.FINNOR_Z4_CHROMIUM
assert.ok(state && evidence && root && tlsState && chromium, "NATIVE_SCENARIO_ENVIRONMENT_REQUIRED")
mkdirSync(evidence, { mode: 0o700 })
const sha = value => createHash("sha256").update(value).digest("hex")
const env = JSON.parse(readFileSync(join(state, "native-environment-01.private.json"), "utf8"))
const app = JSON.parse(readFileSync(join(state, "native-app-state.json"), "utf8"))
const tls = JSON.parse(readFileSync(join(tlsState, "state.json"), "utf8"))
const result = { schema: "finnor.project-z.z4-transport-bringup.v1", scope: "transport_only", startedAt: new Date().toISOString(),
  redaction: "no credential, token or credentialed URL recorded", provenance: "source",
  launcher: { status: app.status, profiles: app.profiles ?? null, productionBuild: app.productionBuild ?? null, authTls: app.authTls ?? null },
  checks: [] }
const check = (name, ok, detail = {}) => { result.checks.push({ name, ok: Boolean(ok), ...detail }) }
const save = () => writeFileSync(join(evidence, "transport.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
let browser
let secondLeaf
try {
  check("node-trust-is-the-declared-pem-only", process.env.NODE_EXTRA_CA_CERTS === tls.certificateFile
    && !("NODE_TLS_REJECT_UNAUTHORIZED" in process.env) && !process.env.SSL_CERT_FILE && !process.env.SSL_CERT_DIR)
  check("certificate-file-is-the-declared-bytes", sha(readFileSync(tls.certificateFile)) === tls.certificateSha256)
  check("auth-origin-is-https", env.SUPABASE_URL === tls.origin && env.SUPABASE_URL.startsWith("https://127.0.0.1:"))

  const login = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: env.TEST_OWNER_EMAIL, password: env.TEST_OWNER_PASSWORD }) })
  const session = await login.json().catch(() => ({}))
  check("https-auth-password-grant-trusts-declared-certificate", login.status === 200 && typeof session.access_token === "string", { status: login.status })

  // A different self-signed leaf must fail under the same trust, otherwise the trust is wider than the declared PEM.
  const other = join(evidence, "other-leaf")
  mkdirSync(other, { mode: 0o700 })
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(other, "key.private.pem"), "-out", join(other, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:FALSE"], { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" })
  assert.equal(made.status, 0, "SECOND_LEAF_GENERATION_FAILED")
  secondLeaf = createServer({ key: readFileSync(join(other, "key.private.pem")), cert: readFileSync(join(other, "cert.pem")) },
    (_request, response) => response.end("second-leaf"))
  await new Promise(done => secondLeaf.listen(0, "127.0.0.1", done))
  const secondOrigin = `https://127.0.0.1:${secondLeaf.address().port}`
  const secondFailure = await fetch(secondOrigin + "/").then(() => null, error => String(error?.cause?.code ?? error?.message))
  check("node-rejects-an-undeclared-self-signed-leaf", typeof secondFailure === "string" && /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/.test(secondFailure), { code: secondFailure })

  const call = async (path, token) => {
    const response = await fetch("http://127.0.0.1:3101" + path, { headers: token ? { authorization: "Bearer " + token } : {} })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { status: response.status, bodySha256: sha(text), body }
  }
  check("api-unauthenticated-me-is-401", (await call("/api/me")).status === 401)
  const me = await call("/api/me", session.access_token)
  const meData = me.body?.data ?? me.body ?? {}
  check("api-bearer-verified-through-https-auth", me.status === 200 && Boolean(meData.tenantId ?? meData.tenant_id), { status: me.status, bodySha256: me.bodySha256 })

  const builds = app.productionBuild ?? {}
  for (const [label, file] of [["frontend", join(root, ".next/BUILD_ID")], ["api", join(root, "finnor-os/apps/api/.next/BUILD_ID")]]) {
    const bytes = readFileSync(file)
    check(`${label}-build-id-matches-launcher-pin`, builds[label]?.buildIdFile === file && builds[label]?.buildIdSha256 === sha(bytes)
      && bytes.toString("utf8") === builds.buildId, { sha256: sha(bytes) })
    check(`${label}-listener-is-the-spawned-next-start`, builds[label]?.spawnedArgv?.includes("start") && !builds[label]?.spawnedArgv?.includes("dev")
      && Number.isInteger(builds[label]?.listenerPid))
  }
  check("frontend-bundle-inlines-the-https-auth-origin", builds.frontend?.authOriginInlined === tls.origin)

  const front = await fetch("http://127.0.0.1:3001/centropy/login")
  check("mounted-login-page-served", front.status === 200, { status: front.status })

  const { chromium: engine } = await import("@playwright/test")
  const { expect } = await import("@playwright/test")
  browser = await engine.launch({ headless: true, executablePath: chromium,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--no-first-run",
      "--ignore-certificate-errors-spki-list=" + tls.spkiSha256Base64] })
  const origins = ["http://127.0.0.1:3001", "http://127.0.0.1:3101", tls.origin]
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3001" })
  const blocked = []
  await context.route("**/*", async route => {
    const origin = new URL(route.request().url()).origin
    if (origins.includes(origin)) await route.continue()
    else { blocked.push(origin); await route.abort("blockedbyclient") }
  })
  const authRequests = []
  const page = await context.newPage()
  page.on("request", request => { if (new URL(request.url()).origin === tls.origin) authRequests.push(new URL(request.url()).pathname) })
  await page.goto("/centropy/login")
  await expect(page.getByRole("heading", { name: "Sign in to CENTROPY" })).toBeVisible()
  await page.getByLabel("Email", { exact: true }).fill(env.TEST_OWNER_EMAIL)
  await page.getByLabel("Password", { exact: true }).fill(env.TEST_OWNER_PASSWORD)
  const mePromise = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const browserMe = await mePromise
  const identity = await browserMe.json().catch(() => ({}))
  check("mounted-browser-login-through-https-auth", browserMe.status() === 200 && identity.role === "owner" && authRequests.some(path => path.startsWith("/auth/v1/token")),
    { status: browserMe.status(), authPaths: [...new Set(authRequests)].sort(), role: identity.role ?? null })
  check("browser-reached-only-declared-origins", blocked.length === 0, { blocked })

  // The pin is for the declared key only: an undeclared self-signed leaf must still fail in the browser.
  const probe = await browser.newContext()
  const probePage = await probe.newPage()
  const browserFailure = await probePage.goto(secondOrigin + "/", { timeout: 15000 }).then(() => null, error => String(error?.message).split("\n")[0])
  check("browser-rejects-an-undeclared-self-signed-leaf", typeof browserFailure === "string" && /ERR_CERT/.test(browserFailure), { error: browserFailure })
  result.status = result.checks.every(row => row.ok) ? "TRANSPORT_OBSERVED" : "TRANSPORT_FAILED"
} catch (error) {
  result.status = "TRANSPORT_ERROR"
  result.failure = String(error?.message ?? error).split("\n")[0].slice(0, 400)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await new Promise(done => secondLeaf ? secondLeaf.close(done) : done())
  result.finishedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify({ status: result.status, failure: result.failure ?? null }))
}
if (result.status !== "TRANSPORT_OBSERVED") process.exitCode = 1
