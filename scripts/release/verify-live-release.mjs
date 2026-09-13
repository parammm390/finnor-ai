import { vercelProtectionHeaders } from "./vercel-protection.mjs"

const [baseUrl, expectedSha, expectedBuildId, expectedVersion, expectedEnvironment = "production", component = "api"] = process.argv.slice(2)

if (!baseUrl || !expectedSha || !expectedBuildId || !expectedVersion) {
  console.error("Usage: node scripts/release/verify-live-release.mjs <url> <commit-sha> <build-id> <version> [environment] [frontend|api]")
  process.exit(2)
}

const url = `${baseUrl.replace(/\/$/, "")}/api/release`
const response = await fetch(url, {
  headers: vercelProtectionHeaders(component),
  signal: AbortSignal.timeout(20_000),
})
const body = await response.json().catch(() => null)

if (!response.ok || !body || typeof body !== "object") {
  console.error(JSON.stringify({ ok: false, url, status: response.status, body }, null, 2))
  process.exit(1)
}

const checks = {
  commitSha: body.commitSha === expectedSha,
  buildId: body.buildId === expectedBuildId,
  version: body.version === expectedVersion,
  environment: body.environment === expectedEnvironment,
  deploymentId: typeof body.deploymentId === "string" && /^dpl_/.test(body.deploymentId),
  traceable: body.traceable === true,
}

if (Object.values(checks).some((value) => !value)) {
  console.error(JSON.stringify({ ok: false, url, checks, body }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({ ok: true, url, checks, release: body }, null, 2))
