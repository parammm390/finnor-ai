import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const binary = resolve(process.argv[2] ?? join(root, ".centropy-certification/tooling/gitleaks-8.24.3/gitleaks"))
const config = join(root, ".gitleaks.toml")
const output = resolve(process.argv[3] ?? join(root, "docs/centropy/evidence/release-candidate-secret-scan/policy.proof.json"))
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const version = spawnSync(binary, ["version"], { encoding: "utf8" })
if (version.status !== 0 || version.stdout.trim() !== "8.24.3") throw new Error("Use the release's pinned Gitleaks 8.24.3 binary")
const temporary = mkdtempSync(join(tmpdir(), "centropy-secret-policy-"))
const reference = "dac03595-1793-4796-a744-a7c0c7dc2d35"
const authoredNegative = ["gf9A3mR7", "zQ2xP6cV", "8bN4kH1s", "D0uW5eTj"].join("")
const fixtures = {
  business: { executionKey: reference, idempotencyKey: reference, templateKey: "centropy_ic_default_v1", versionKey: "centropy-growth-bps-e2e-v2" },
  credential: { accessToken: reference, apiKey: authoredNegative },
}
const scans = []
try {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const path = join(temporary, name, "docs/centropy/evidence/probe.json")
    const bytes = JSON.stringify(fixture, null, 2) + "\n"
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
    for (const policy of name === "business" ? ["default", "configured"] : ["configured"]) {
      const report = join(temporary, `${name}-${policy}.json`)
      const result = spawnSync(binary, ["dir", join(temporary, name), "--redact", "--report-format=json", `--report-path=${report}`, ...(policy === "configured" ? [`--config=${config}`] : []), "--log-level=error"], { encoding: "utf8", timeout: 30_000 })
      if (![0, 1].includes(result.status)) throw new Error(`Scanner failed for ${name}/${policy}, exit ${result.status}`)
      const findings = JSON.parse(readFileSync(report, "utf8"))
      scans.push({ fixture: name, policy, inputSha256: sha(bytes), inputBytes: Buffer.byteLength(bytes), fields: Object.keys(fixture), exitCode: result.status, findingCount: findings.length, ruleIds: [...new Set(findings.map((item) => item.RuleID))].sort() })
    }
  }
  const [baseline, permitted, rejected] = scans
  if (baseline.exitCode !== 1 || baseline.findingCount < 2 || permitted.exitCode !== 0 || permitted.findingCount !== 0 || rejected.exitCode !== 1 || rejected.findingCount !== 2) throw new Error(`Policy verification failed: ${JSON.stringify(scans)}`)
  const proof = { schema: "centropy.secret-scan-policy-proof/v1", status: "PASS", capturedAt: new Date().toISOString(), scannerVersion: version.stdout.trim(), binarySha256: sha(readFileSync(binary)), configurationSha256: sha(readFileSync(config)), steps: ["Show the default scanner detects the authored high entropy business references", "Show the exact field/value/path policy allows those references", "Show accessToken and apiKey fields remain detected on the same evidence path"], scans, reproduce: "node scripts/centropy/verify-secret-scan-policy.mjs <pinned-gitleaks-8.24.3-path>", limitation: "Authored scanner fixtures; no external credentials or external security certification are claimed." }
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(proof, null, 2) + "\n")
  console.log(JSON.stringify({ status: proof.status, scannerVersion: proof.scannerVersion, scans, output }))
} finally { rmSync(temporary, { recursive: true, force: true }) }
