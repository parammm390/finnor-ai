import { assertSupplierCanaryRelease } from "./p8-water-retirement-policy.mjs"
import { loadContract } from "./release-policy.mjs"
import { vercelProtectionHeaders } from "./vercel-protection.mjs"

const [component, baseUrl, commitSha, buildId, version] = process.argv.slice(2)
if (!["supplierCanaryApp", "supplierCanaryAuth"].includes(component) || !baseUrl || !commitSha || !buildId || !version) {
  console.error("Usage: node scripts/release/verify-supplier-canary-release.mjs <supplierCanaryApp|supplierCanaryAuth> <url> <commit-sha> <build-id> <version>")
  process.exit(2)
}

const contract = loadContract()
const target = contract.topology[component]
const expected = {
  commitSha,
  buildId,
  version,
  environment: "production",
  source: process.env.FINNOR_RELEASE_SOURCE || "github-actions",
}
const url = `${baseUrl.replace(/\/$/, "")}${target.releasePath}`
const response = await fetch(url, {
  headers: vercelProtectionHeaders(component),
  signal: AbortSignal.timeout(20_000),
})
const body = await response.json().catch(() => null)
if (!response.ok) throw new Error(`${component} release endpoint failed with HTTP ${response.status}`)
assertSupplierCanaryRelease(component, body, expected, target, contract.release.requiredMigrationHead)
console.log(JSON.stringify({
  ok: true,
  component,
  url,
  role: body.role,
  commitSha: body.commitSha,
  deploymentId: body.deploymentId,
  migrationHead: body.migrationHead,
  cutoverProtocol: body.cutoverProtocol,
}, null, 2))
