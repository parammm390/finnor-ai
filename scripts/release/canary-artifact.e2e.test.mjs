import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { createFixture, SHA } from "./compute-artifact-e2e-fixture.mjs"

const APP = "supplierCanaryApp"
const AUTH = "supplierCanaryAuth"
const builds = (f) => f.events().filter((event) => event.command === "vercel" && event.args[0] === "build").length
const deploys = (f) => f.events().filter((event) => event.command === "vercel" && event.args[0] === "deploy").length
function prepare(f, component = APP) {
  const result = f.canary(component, "--prepare-only")
  assert.equal(result.status, 0, result.stderr)
  return f.prepared(component)
}

test("per-role durable contexts survive exit and deploy the same bytes once without rebuilding", (t) => {
  const f = createFixture(t, "canary-dual-role")
  const app = prepare(f)
  const auth = prepare(f, AUTH)
  assert.notEqual(app, auth)
  assert.ok(existsSync(join(app, "context/.vercel/output/config.json")))
  assert.ok(existsSync(join(auth, "context/.vercel/output/config.json")))
  const receipt = JSON.parse(readFileSync(join(app, "prepared.json"), "utf8"))
  assert.equal(receipt.schema, "finnor.canary-prepared-artifact.v1")
  assert.equal(receipt.commitSha, SHA)
  assert.equal(receipt.component, APP)
  assert.equal(receipt.portalRole, "app")
  for (const field of ["sourceSha256", "outputSha256", "configSha256", "contextSha256", "toolchainSha256"]) assert.match(receipt[field], /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(receipt), /fixture-secret|fixture-only-not-a-credential|DATABASE_URL|SERVICE_ROLE_KEY/)
  assert.doesNotMatch(readFileSync(join(app, "context/.vercel/.env.production.local"), "utf8"), /fixture-secret|DATABASE_URL|SERVICE_ROLE_KEY/)
  assert.equal(f.canary(APP, "--deploy-only").status, 0)
  assert.equal(f.canary(AUTH, "--deploy-only").status, 0)
  assert.equal(builds(f), 2)
  assert.equal(deploys(f), 2)
  const commands = f.events().filter((event) => event.command === "vercel")
  assert.ok(commands.every((event) => !event.oidcPresent && !event.awsSecretPresent && !event.ghTokenPresent))
})

test("repeat prepare reuses a validated artifact without another build", (t) => {
  const f = createFixture(t, "canary-repeat")
  prepare(f)
  prepare(f)
  assert.equal(builds(f), 1)
})

test("deploy-only refuses a missing canary artifact without rebuild/deploy", (t) => {
  const f = createFixture(t, "canary-missing")
  assert.notEqual(f.canary(APP, "--deploy-only").status, 0)
  assert.equal(builds(f), 0)
  assert.equal(deploys(f), 0)
})

for (const mutation of ["output", "config", "receipt", "source", "lock", "symlink"]) {
  test(`prepared canary rejects ${mutation} tampering without deployment`, (t) => {
    const f = createFixture(t, `canary-${mutation}`)
    const folder = prepare(f)
    if (mutation === "output") writeFileSync(join(folder, "context/.vercel/output/config.json"), '{"version":3,"changed":true}')
    if (mutation === "config") writeFileSync(join(folder, "context/.vercel/project.json"), '{"projectId":"wrong","orgId":"wrong"}')
    if (mutation === "receipt") {
      const path = join(folder, "prepared.json")
      const receipt = JSON.parse(readFileSync(path, "utf8")); receipt.portalRole = "auth"; writeFileSync(path, JSON.stringify(receipt))
    }
    if (mutation === "source") writeFileSync(join(f.appDir, "api/index.mjs"), "changed source")
    if (mutation === "lock") writeFileSync(join(f.repo, "finnor-os/package-lock.json"), '{"changed":true}')
    if (mutation === "symlink") symlinkSync(join(f.root, "state.json"), join(folder, "context/.vercel/output/escape"))
    assert.notEqual(f.canary(APP, "--deploy-only").status, 0)
    assert.equal(deploys(f), 0)
  })
}

for (const scenario of ["wrong-role", "public-service-key"]) {
  test(`canary prepare refuses ${scenario}`, (t) => {
    const f = createFixture(t, scenario)
    assert.notEqual(f.canary(APP, "--prepare-only").status, 0)
    assert.equal(deploys(f), 0)
    assert.ok(!existsSync(join(f.prepared(APP), "prepared.json")))
  })
}

for (const scenario of ["auth-denied", "artifact-auth-race"]) {
  test(`prepared canary refuses ${scenario} at the authorized deployment boundary`, (t) => {
    const f = createFixture(t, `canary-${scenario}`)
    prepare(f)
    f.setScenario(scenario)
    assert.notEqual(f.canary(APP, "--deploy-only").status, 0)
    assert.equal(deploys(f), 0)
  })
}
