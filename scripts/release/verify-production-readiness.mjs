import { vercelProtectionHeaders } from "./vercel-protection.mjs"
import { evaluateProductionReadiness } from "./production-readiness-policy.mjs"

const [baseUrl, expectedSha, component = "api"] = process.argv.slice(2)

if (!baseUrl || !expectedSha) {
  console.error("Usage: node scripts/release/verify-production-readiness.mjs <api-url> <commit-sha> [api]")
  process.exit(2)
}

const url = `${baseUrl.replace(/\/$/, "")}/api/ready`
const response = await fetch(url, {
  headers: vercelProtectionHeaders(component),
  signal: AbortSignal.timeout(20_000),
})
const body = await response.json().catch(() => null)
const { ok, checks, authority } = evaluateProductionReadiness({
  responseOk: response.ok, status: response.status, body, expectedSha,
})

if (!ok) {
  console.error(JSON.stringify({ ok: false, url, status: response.status, checks, body }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  url,
  checks,
  authority: {
    state: authority.state,
    activeProductVertical: authority.activeProductVertical,
    epoch: authority.epoch,
    minimumCutoverProtocol: authority.minimumCutoverProtocol,
  },
}, null, 2))
