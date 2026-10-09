import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { readFileSync, writeFileSync, readlinkSync, unlinkSync, symlinkSync } from "node:fs"
import { createFixture, SHA } from "./compute-artifact-e2e-fixture.mjs"
import { readProtectedEnv } from "./protected-env.mjs"

// Controller lifecycle proof. Actual compiler/function proof is the separate,
// mandatory production-artifact.e2e.mjs, never this mocked provider.
test("API prepare preserves provider-pulled unescaped JSON and deploy-only consumes its canonical root without rebuilding", t => {
  const f = createFixture(t, "api-artifact")
  f.setScenario("api-file-map")
  const prepared = f.canary("api", "--prepare-only")
  assert.equal(prepared.status, 0, prepared.stderr)
  const directory = join(f.runner, "finnor-prepared-api", SHA, "api")
  const receipt = JSON.parse(readFileSync(join(directory, "prepared.json"), "utf8"))
  assert.equal(receipt.schema, "finnor.api-prepared-artifact.v1")
  assert.equal(receipt.component, "api")
  assert.match(readFileSync(join(directory, "context/.vercel/.env.production.local"), "utf8"), /SECRETS_PROVIDER="aws-secrets-manager"/)
  assert.deepEqual(JSON.parse(readProtectedEnv(join(directory, "context/.vercel/.env.production.local")).FINNOR_SECRET_IDS), {
    GROQ_API_KEY: "finnor/prod/groq-api-key",
  })
  const output = join(directory, "context/.vercel/output")
  assert.equal(readlinkSync(join(output, "functions/alias.func")), "health.func")
  assert.ok(readFileSync(join(output, "functions/health.func/package-lock.json")).length)
  assert.equal(JSON.parse(readFileSync(join(directory, "context/.vercel/project.json"), "utf8")).settings.rootDirectory, "finnor-os/apps/api")
  assert.equal(f.canary("api", "--prepare-only").status, 0)
  const deployed = f.canary("api", "--deploy-only")
  assert.equal(deployed.status, 0, deployed.stderr)
  assert.equal(f.events().filter(e => e.command === "vercel" && e.args[0] === "build").length, 1)
  writeFileSync(join(directory, "context/.vercel/output/config.json"), '{"version":3,"tampered":true}')
  assert.notEqual(f.canary("api", "--deploy-only").status, 0)
  assert.equal(f.events().filter(e => e.command === "vercel" && e.args[0] === "deploy").length, 1)
})

test("API deploy-only refuses missing prepared bytes without building or deploying", t => {
  const f = createFixture(t, "api-artifact-missing")
  assert.notEqual(f.canary("api", "--deploy-only").status, 0)
  assert.equal(f.events().filter(e => e.command === "vercel").length, 1) // version read only
})

test("API deploy-only reproduces the provider's stale project-root failure without rebuilding", t => {
  const f = createFixture(t, "api-legacy-provider-root")
  f.setScenario("api-legacy-root")
  const prepared = f.canary("api", "--prepare-only")
  assert.equal(prepared.status, 0, prepared.stderr)
  const deployed = f.canary("api", "--deploy-only")
  assert.notEqual(deployed.status, 0)
  assert.match(deployed.stderr, /Provider project root does not exist: apps\/api/)
  assert.equal(f.events().filter(e => e.command === "vercel" && e.args[0] === "build").length, 1)
})

test("API prepared artifact refuses a function alias escaping its output boundary", t => {
  const f = createFixture(t, "api-artifact-escape")
  f.setScenario("api-file-map")
  assert.equal(f.canary("api", "--prepare-only").status, 0)
  const alias = join(f.runner, "finnor-prepared-api", SHA, "api/context/.vercel/output/functions/alias.func")
  unlinkSync(alias)
  symlinkSync(f.repo, alias)
  assert.notEqual(f.canary("api", "--deploy-only").status, 0)
  assert.equal(f.events().filter(e => e.command === "vercel" && e.args[0] === "deploy").length, 0)
})

test("API prepare rejects a noncanonical provider selector before building or deploying", t => {
  const f = createFixture(t, "api-invalid-provider")
  f.setScenario("api-invalid-provider")
  const result = f.canary("api", "--prepare-only")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /forbidden credential class/)
  assert.equal(f.events().filter(e => e.command === "vercel" && ["build", "deploy"].includes(e.args[0])).length, 0)
})
