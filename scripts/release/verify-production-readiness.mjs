const [baseUrl, expectedSha] = process.argv.slice(2)

if (!baseUrl || !expectedSha) {
  console.error("Usage: node scripts/release/verify-production-readiness.mjs <api-url> <commit-sha>")
  process.exit(2)
}

const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
const url = `${baseUrl.replace(/\/$/, "")}/api/ready`
const response = await fetch(url, {
  headers: {
    accept: "application/json",
    "cache-control": "no-cache",
    ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
  },
  signal: AbortSignal.timeout(20_000),
})
const body = await response.json().catch(() => null)
const authority = body?.checks?.productAuthority?.detail
const release = body?.checks?.runtimeRelease?.detail

const checks = {
  http: response.ok,
  ready: body?.ok === true,
  finalPeGateRequired: authority?.finalPeGateRequired === true,
  authorityState: authority?.state === "water_retired",
  activeProductVertical: authority?.activeProductVertical === "private_equity",
  authorityCheck: body?.checks?.productAuthority?.ok === true,
  runtimeEpoch: body?.checks?.runtimeEpoch?.ok === true,
  runtimeRelease: body?.checks?.runtimeRelease?.ok === true,
  expectedRelease: release?.expectedReleaseSha === expectedSha,
  migration: body?.checks?.migrations?.ok === true,
  workerFleet: body?.checks?.workerFleet?.ok === true,
}

if (Object.values(checks).some((value) => !value)) {
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
