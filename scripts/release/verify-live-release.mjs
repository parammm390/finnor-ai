const [baseUrl, expectedSha, expectedBuildId, expectedVersion, expectedEnvironment = "production"] = process.argv.slice(2)

if (!baseUrl || !expectedSha || !expectedBuildId || !expectedVersion) {
  console.error("Usage: node scripts/release/verify-live-release.mjs <url> <commit-sha> <build-id> <version> [environment]")
  process.exit(2)
}

const url = `${baseUrl.replace(/\/$/, "")}/api/release`
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
const response = await fetch(url, {
  headers: {
    accept: "application/json",
    "cache-control": "no-cache",
    ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
  },
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
