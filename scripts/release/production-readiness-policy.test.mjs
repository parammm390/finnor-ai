import assert from "node:assert/strict"
import test from "node:test"
import { evaluateProductionReadiness } from "./production-readiness-policy.mjs"

const SHA = "a".repeat(40)
const OLD_SHA = "b".repeat(40)

function readiness({ mixed = false } = {}) {
  return {
    ok: !mixed,
    checks: {
      migrations: { ok: true, detail: "0131_private_equity_release_baseline.sql" },
      workerFleet: { ok: true, detail: { compatibleWorkers: 1, freshRuntimes: mixed ? 7 : 4 } },
      productAuthority: {
        ok: true,
        detail: {
          status: "active",
          activeProductVertical: "private_equity",
          epoch: 6,
          minimumCutoverProtocol: 5,
          finalPeGateRequired: true,
        },
      },
      runtimeEpoch: { ok: true, detail: { productEpochs: [6], mixedRuntimes: 0, expectedEpoch: 6 } },
      runtimeRelease: {
        ok: !mixed,
        detail: {
          releaseShas: mixed ? [SHA, OLD_SHA] : [SHA],
          mixedRuntimes: mixed ? 3 : 0,
          mixedMigrationRuntimes: mixed ? 3 : 0,
          incompatibleProtocolRuntimes: 0,
          expectedReleaseSha: SHA,
        },
      },
    },
    provenance: { commitSha: SHA, traceable: true },
  }
}

test("accepts exact converged Private Equity production readiness", () => {
  const result = evaluateProductionReadiness({ responseOk: true, status: 200, body: readiness(), expectedSha: SHA })
  assert.equal(result.ok, true)
  assert.equal(result.retryable, false)
  assert.equal(Object.values(result.checks).every(Boolean), true)
})

test("retries only the bounded old-runtime heartbeat drain window", () => {
  const result = evaluateProductionReadiness({ responseOk: false, status: 503, body: readiness({ mixed: true }), expectedSha: SHA })
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
  assert.equal(result.checks.runtimeRelease, false)
  assert.equal(result.checks.provenanceRelease, true)
})

test("fails closed instead of retrying wrong provenance or unsafe runtime state", () => {
  const wrongProvenance = readiness({ mixed: true })
  wrongProvenance.provenance.commitSha = OLD_SHA
  assert.equal(evaluateProductionReadiness({ responseOk: false, status: 503, body: wrongProvenance, expectedSha: SHA }).retryable, false)

  const incompatible = readiness({ mixed: true })
  incompatible.checks.runtimeRelease.detail.incompatibleProtocolRuntimes = 1
  assert.equal(evaluateProductionReadiness({ responseOk: false, status: 503, body: incompatible, expectedSha: SHA }).retryable, false)

  const authorityFailure = readiness({ mixed: true })
  authorityFailure.checks.productAuthority.ok = false
  assert.equal(evaluateProductionReadiness({ responseOk: false, status: 503, body: authorityFailure, expectedSha: SHA }).retryable, false)
})
