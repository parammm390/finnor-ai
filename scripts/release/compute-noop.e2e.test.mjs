import assert from "node:assert/strict"
import test from "node:test"
import { createFixture } from "./compute-artifact-e2e-fixture.mjs"

test("exact-SHA finalized rerun independently proves a typed no-op without executing it", (t) => {
  const f = createFixture(t)
  const result = f.compute()
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.equal(receipt.verifiedNoop?.schema, "finnor.compute-verified-noop.v1")
  assert.equal(receipt.verifiedNoop?.status, "VERIFIED_NOOP")
  assert.equal(receipt.verifiedNoop?.taskDefinitionArns?.length, 4)
  assert.ok(f.events().some((event) => event.command === "authorize"))
  assert.ok(f.events().some((event) => event.args?.includes("get-template")))
  assert.equal(f.events().filter((event) => event.args?.includes("execute-change-set")).length, 0)
})

for (const scenario of [
  "failed-reason", "near-reason", "failed-changes", "empty-complete",
  "unstable-stack", "parameter-sha", "parameter-digest", "template-drift", "ecr-race",
  "task-image", "task-sha", "missing-class", "duplicate-beat", "stale-beat", "mixed-beat",
  "alb-health", "alb-extra", "db-fence", "auth-denied",
]) {
  test(`compute rerun rejects ${scenario} without executing the change set`, (t) => {
    const f = createFixture(t, scenario)
    const result = f.compute()
    assert.notEqual(result.status, 0)
    assert.equal(result.error, undefined, `fixture must fail closed, not time out: ${result.stderr}`)
    assert.equal(f.events().filter((event) => event.args?.includes("execute-change-set")).length, 0)
    assert.doesNotMatch(result.stdout, /"status":"VERIFIED_NOOP"/)
  })
}

test("normal nonempty four-class rollout still executes once", (t) => {
  const f = createFixture(t, "normal-rollout")
  const result = f.compute()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.events().filter((event) => event.args?.includes("execute-change-set")).length, 1)
  assert.doesNotMatch(result.stdout, /VERIFIED_NOOP/)
})

test("same-release interrupted routing retains ingress-only recovery without reactivating DB", (t) => {
  const f = createFixture(t, "routing-recovery")
  const result = f.compute("routing")
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.events().filter((event) => event.args?.includes("execute-change-set")).length, 1)
  assert.equal(f.events().filter((event) => event.command === "pg" && event.sql.includes("UPDATE finnor_os.compute_plane_cutover")).length, 0)
})

for (const stage of ["preparing", "routing", "finalized"]) {
  test(`empty-result shortcut is never available to ${stage}`, (t) => {
    const f = createFixture(t, `wrong-stage-${stage}`)
    const result = f.compute(stage)
    assert.notEqual(result.status, 0)
    assert.equal(f.events().filter((event) => event.args?.includes("execute-change-set")).length, 0)
  })
}
