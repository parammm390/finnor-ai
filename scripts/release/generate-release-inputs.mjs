import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const backend = join(root, "finnor-os")
const check = process.argv.includes("--check")
assert(process.argv.slice(2).every(argument => argument === "--check"), "Unknown release input option")
const toolchain = JSON.parse(readFileSync(join(root, "infra/deployment/release-toolchain.json"), "utf8"))
assert.equal(process.version, `v${toolchain.nodeVersion}`, "Use the pinned release Node version")
const startedAt = new Date().toISOString()
const steps = []
const command = (id, path, cwd = root, generateArguments = [], loader = false) => ({
  id, cwd, args: [...(loader ? ["--import=tsx"] : []), path, ...(check ? ["--check"] : generateArguments)],
})
const plan = [
  command("workspace", "scripts/generate-workspace-contract.mjs"),
  command("migrations", "scripts/bundle-migrations.ts", backend, [], true),
  command("authorization", "scripts/generate-authz-matrix.ts", backend, [], true),
  command("openapi", "scripts/generate-openapi.ts", backend, [], true),
  command("action-manifest", "scripts/release/verify-action-manifest.ts", backend, ["--write"], true),
  command("frontend-clients", "scripts/centropy/generate-openapi-client.mjs"),
  command("capabilities", "scripts/centropy/generate-capability-manifest.mjs"),
  command("human-forms", "scripts/centropy/generate-human-forms.mjs"),
]
const api = join(backend, "apps/api")
const stages = JSON.parse(readFileSync(join(api, "package.json"), "utf8")).scripts.build.split(/\s*&&\s*/)
assert.equal(stages.pop(), "next build", "Review changed API build stages")
for (const [index, stage] of stages.entries()) {
  assert.match(stage, /^tsx [^\s]+$/, "Review changed API source stamping command")
  plan.push(command(`api-stamp-${index}`, stage.slice(4), api, [], true))
}
plan.push(command("planner-replay", "scripts/release/generate-planner-replay-manifest.mts", backend, [], true))
plan.push(command("frontend-coverage", "scripts/centropy/audit-capability-coverage.mjs"))
plan.push({ id: "product-boundary", cwd: backend,
  args: ["--import=tsx", "scripts/release/verify-pe-domain-boundary.ts"] })
plan.push({ id: "release-provenance", cwd: root, args: ["scripts/release/validate-deployment-truth.mjs"] })

if (!check) {
  const head = readdirSync(join(backend, "packages/db/migrations")).filter(name => name.endsWith(".sql")).sort().at(-1)
  assert(head, "Complete migration population required")
  const contractPath = join(root, "infra/deployment/production.contract.json")
  const contract = JSON.parse(readFileSync(contractPath, "utf8"))
  assert.equal(typeof contract.release.requiredMigrationHead, "string")
  contract.release.requiredMigrationHead = head
  writeFileSync(contractPath, JSON.stringify(contract, null, 2) + "\n")
  const canaryPath = join(backend, "apps/supplier-canary/api/index.mjs")
  const canary = readFileSync(canaryPath, "utf8")
  const pattern = /^const CURRENT_MIGRATION_HEAD = "[^"\n]+";$/gm
  assert.equal([...canary.matchAll(pattern)].length, 1, "Exact isolated supplier head required")
  writeFileSync(canaryPath, canary.replace(pattern, `const CURRENT_MIGRATION_HEAD = ${JSON.stringify(head)};`))
}
for (const step of plan) {
  const began = performance.now()
  const result = spawnSync(process.execPath, step.args, { cwd: step.cwd, encoding: "utf8",
    timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" } })
  const observed = { id: step.id, command: [process.execPath, ...step.args],
    cwd: step.cwd, exitCode: result.status, signal: result.signal,
    durationMs: performance.now() - began, error: result.error?.message ?? null }
  steps.push(observed)
  process.stdout.write(JSON.stringify(observed) + "\n")
  if (result.status !== 0) {
    process.stderr.write((result.stdout ?? "") + (result.stderr ?? ""))
    if (!check) break
  }
}
const passed = steps.length === plan.length && steps.every(step => step.exitCode === 0)
process.stdout.write(JSON.stringify({ schema: "finnor.release-input-chain.v1", status: passed ? "PASS" : "FAIL",
  mode: check ? "READ_ONLY_CHECK" : "GENERATE", startedAt, finishedAt: new Date().toISOString(),
  steps: steps.length, requiredSteps: plan.length, failed: steps.filter(step => step.exitCode !== 0).map(step => step.id),
  qualification: "SOURCE_CONSISTENCY_ONLY_NO_RUNTIME_DEPLOYMENT_OR_ADMISSION" }) + "\n")
process.exitCode = passed ? 0 : 1
