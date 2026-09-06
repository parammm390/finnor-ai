import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertCanonicalRelease, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const evidenceIndex = process.argv.indexOf("--preflight-evidence")
const evidencePath = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined
if (!evidencePath) throw new Error("Usage: node scripts/release/deploy-azure-worker.mjs --preflight-evidence <path>")

const gitRelease = readGitRelease(repoRoot, contract)
assertCanonicalRelease(gitRelease)
const expected = expectedRelease(gitRelease.head, process.env.FINNOR_RELEASE_SOURCE || "github-actions")
const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"))
const contractBytes = readFileSync(resolve(repoRoot, "infra/deployment/production.contract.json"))
const contractHash = createHash("sha256").update(contractBytes).digest("hex")
const ageMs = Date.now() - Date.parse(evidence.checkedAt)
if (
  evidence.ok !== true || evidence.commitSha !== gitRelease.head || evidence.remoteMain !== gitRelease.head
  || evidence.contractSha256 !== contractHash
  || evidence.azure?.resourceId?.toLowerCase() !== contract.topology.worker.resourceId.toLowerCase()
  || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 60 * 60 * 1000
) throw new Error("Azure deployment requires fresh, matching production preflight evidence")

const worker = contract.topology.worker
const replacements = {
  __FINNOR_RELEASE_SHA__: expected.commitSha,
  __FINNOR_BUILD_ID__: expected.buildId,
  __FINNOR_VERSION__: expected.version,
  __FINNOR_RELEASE_SOURCE__: expected.source,
  __FINNOR_REPOSITORY__: contract.canonicalGit.repository,
  __FINNOR_SYSTEMD_UNIT__: worker.systemdUnit,
  __FINNOR_RELEASE_ROOT__: worker.releaseRoot,
  __FINNOR_CURRENT_SYMLINK__: worker.currentSymlink,
  __FINNOR_SECRET_ENV__: worker.secretEnvironmentFile,
  __FINNOR_RELEASE_ENV__: worker.releaseEnvironmentFile,
}
let script = readFileSync(resolve(repoRoot, "scripts/release/azure/deploy-worker.sh"), "utf8")
for (const [placeholder, value] of Object.entries(replacements)) script = script.replaceAll(placeholder, value)
if (/__FINNOR_[A-Z_]+__/.test(script)) throw new Error("Azure deployment script contains an unresolved placeholder")

const output = execFileSync(process.env.AZURE_CLI || "az", [
  "vm", "run-command", "invoke", "--resource-group", worker.resourceGroup,
  "--name", worker.resourceName, "--command-id", "RunShellScript", "--scripts", script,
  "--only-show-errors", "-o", "json",
], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000 })
const result = JSON.parse(output)
const message = (result.value ?? []).map((entry) => entry.message ?? "").join("\n")
if (!message.includes(`FINNOR_AZURE_DEPLOY_OK ${expected.commitSha}`)) {
  throw new Error(`Azure worker deployment did not return its success marker:\n${message}`)
}
console.log(JSON.stringify({ ok: true, component: "worker", ...expected, resourceId: worker.resourceId }, null, 2))
