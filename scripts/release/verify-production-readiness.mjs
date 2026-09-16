import { vercelProtectionHeaders } from "./vercel-protection.mjs"
import { evaluateProductionReadiness } from "./production-readiness-policy.mjs"

const [baseUrl, expectedSha, component = "api"] = process.argv.slice(2)

if (!baseUrl || !expectedSha) {
  console.error("Usage: node scripts/release/verify-production-readiness.mjs <api-url> <commit-sha> [api]")
  process.exit(2)
}

const url = `${baseUrl.replace(/\/$/, "")}/api/ready`
// Credential/configuration defects are never transient convergence conditions.
// Resolve the protected-deployment header once and fail immediately if absent.
const protectionHeaders = vercelProtectionHeaders(component)
const timeoutMs = 120_000
const pollIntervalMs = 5_000
const startedAt = Date.now()
let attempt = 0

while (true) {
  attempt += 1
  let response
  let body
  try {
    response = await fetch(url, {
      headers: protectionHeaders,
      signal: AbortSignal.timeout(20_000),
    })
    body = await response.json().catch(() => null)
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs + pollIntervalMs <= timeoutMs) {
      console.warn(JSON.stringify({ event: "production-readiness-request-retry", url, attempt, elapsedMs }))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
      continue
    }
    console.error(JSON.stringify({ ok: false, url, attempt, elapsedMs, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exit(1)
  }

  const evaluation = evaluateProductionReadiness({ responseOk: response.ok, status: response.status, body, expectedSha })
  if (evaluation.ok) {
    console.log(JSON.stringify({
      ok: true,
      url,
      attempt,
      convergenceMs: Date.now() - startedAt,
      checks: evaluation.checks,
      authority: {
        status: evaluation.authority.status,
        activeProductVertical: evaluation.authority.activeProductVertical,
        epoch: evaluation.authority.epoch,
        minimumCutoverProtocol: evaluation.authority.minimumCutoverProtocol,
      },
    }, null, 2))
    break
  }

  const elapsedMs = Date.now() - startedAt
  if (evaluation.retryable && elapsedMs + pollIntervalMs <= timeoutMs) {
    console.warn(JSON.stringify({
      event: "production-readiness-runtime-convergence",
      url,
      attempt,
      elapsedMs,
      releaseShas: evaluation.release.releaseShas,
      mixedRuntimes: evaluation.release.mixedRuntimes,
      mixedMigrationRuntimes: evaluation.release.mixedMigrationRuntimes,
    }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    continue
  }

  console.error(JSON.stringify({
    ok: false,
    url,
    status: response.status,
    attempt,
    elapsedMs,
    timedOut: evaluation.retryable,
    checks: evaluation.checks,
    body,
  }, null, 2))
  process.exit(1)
}
