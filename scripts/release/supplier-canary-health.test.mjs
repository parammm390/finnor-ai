import assert from "node:assert/strict"
import test from "node:test"
import handler from "../../finnor-os/apps/supplier-canary/api/index.mjs"

const managedEnvironment = [
  "PORTAL_ROLE",
  "CANARY_SIGNING_KEY",
  "APP_ORIGIN",
  "AUTH_ORIGIN",
  "FINNOR_COMMIT_SHA",
  "FINNOR_BUILD_ID",
  "FINNOR_VERSION",
  "FINNOR_ENVIRONMENT",
  "FINNOR_RELEASE_SOURCE",
  "VERCEL_DEPLOYMENT_ID",
]

function response() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: "",
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value) },
    end(value = "") { this.body = String(value) },
  }
}

function withEnvironment(values, run) {
  const previous = Object.fromEntries(managedEnvironment.map((name) => [name, process.env[name]]))
  for (const name of managedEnvironment) delete process.env[name]
  Object.assign(process.env, values)
  try { return run() } finally {
    for (const name of managedEnvironment) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

test("supplier canary health exposes exact Phase 8 release provenance", () => {
  withEnvironment({
    PORTAL_ROLE: "app",
    CANARY_SIGNING_KEY: "test-key",
    APP_ORIGIN: "https://app.example.invalid",
    AUTH_ORIGIN: "https://auth.example.invalid",
    FINNOR_COMMIT_SHA: "a".repeat(40),
    FINNOR_BUILD_ID: `finnor-${"a".repeat(12)}`,
    FINNOR_VERSION: `0.1.0+${"a".repeat(12)}`,
    FINNOR_ENVIRONMENT: "production",
    FINNOR_RELEASE_SOURCE: "github-actions",
    VERCEL_DEPLOYMENT_ID: "dpl_exact",
  }, () => {
    const res = response()
    handler({ url: "/health", headers: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), {
      ok: true,
      service: "supplier-canary",
      role: "app",
      commitSha: "a".repeat(40),
      buildId: `finnor-${"a".repeat(12)}`,
      version: `0.1.0+${"a".repeat(12)}`,
      environment: "production",
      source: "github-actions",
      deploymentId: "dpl_exact",
      migrationHead: "0130_phase8_cutover_runtime_head_compatibility.sql",
      cutoverProtocol: 5,
      traceable: true,
    })
  })
})

test("supplier canary health fails closed when portal or release provenance is incomplete", () => {
  withEnvironment({}, () => {
    const res = response()
    handler({ url: "/health", headers: {} }, res)
    assert.equal(res.statusCode, 503)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.traceable, false)
  })
})
