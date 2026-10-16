import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyCiProcess } from "./ci-process-policy.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))
const toolchain = JSON.parse(readFileSync(join(root, "infra/deployment/release-toolchain.json"), "utf8"))
const policy = toolchain.workflowValidator
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const temporary = mkdtempSync(join(tmpdir(), "finnor-actionlint-"))
const evidence = process.env.FINNOR_CI_PROCESS_EVIDENCE_DIR
const receipt = { schema: "finnor.ci-process.v1", status: "FAIL", startedAt: new Date().toISOString(), commands: [], inputs: {}, rerun: "FINNOR_CI_PROCESS_EVIDENCE_DIR=/absolute/new/evidence node scripts/release/verify-ci-workflows.mjs", hostedExecutionClaimed: false }
try {
  let binary = process.env.FINNOR_ACTIONLINT_BIN
  if (!binary) {
    const key = `${process.platform}_${process.arch}`
    const asset = policy?.platforms?.[key]
    assert.ok(asset, `No pinned actionlint for ${key}`)
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(30_000) })
    assert.ok(response.ok, `Cannot acquire pinned actionlint (${response.status})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(hash(bytes), asset.sha256, "actionlint archive checksum mismatch")
    const archive = join(temporary, "actionlint.tar.gz")
    writeFileSync(archive, bytes)
    const extraction = spawnSync("tar", ["-xzf", archive, "-C", temporary, "actionlint"], { encoding: "utf8", timeout: 10_000 })
    assert.equal(extraction.status, 0, extraction.stderr)
    binary = join(temporary, "actionlint")
    chmodSync(binary, 0o755)
    receipt.archiveSha256 = asset.sha256
  }
  const version = spawnSync(binary, ["-version"], { encoding: "utf8", timeout: 10_000 })
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.split(/\r?\n/)[0], policy.version)
  receipt.binarySha256 = hash(readFileSync(binary))
  const graph = verifyCiProcess(root)
  for (const file of graph.workflows) {
    const path = `.github/workflows/${file}`
    const bytes = readFileSync(join(root, path))
    const text = bytes.toString("utf8")
    receipt.inputs[path] = hash(bytes)
    for (const [, version] of text.matchAll(/^\s*node-version:\s*["']?([^\s"'#]+)/gm)) assert.equal(version, toolchain.nodeVersion, `${file}: Node pin differs from the release toolchain`)
    for (const [, image] of text.matchAll(/^\s*image:\s*([^\s#]+)/gm)) assert.match(image, /@sha256:[0-9a-f]{64}$/, `${file}: mutable service image`)
    for (const [, version] of text.matchAll(/npm install --global vercel@([^\s]+)/g)) assert.equal(version, toolchain.vercelCliVersion, `${file}: Vercel pin differs from the release toolchain`)
  }
  for (const path of ["infra/deployment/release-toolchain.json", "scripts/release/verify-ci-workflows.mjs", "scripts/release/ci-process-policy.mjs"]) receipt.inputs[path] = hash(readFileSync(join(root, path)))
  // actionlint validates GitHub expressions, permissions, dependencies, matrices
  // and reusable calls. Shellcheck/pyflakes are separate optional tools; bash
  // syntax of the actual image gate is checked independently below.
  for (const [command, args] of [[binary, ["-shellcheck=", "-pyflakes=", ...graph.workflows.map(file => join(".github/workflows", file))]], ["bash", ["-n", "scripts/release/smoke-worker-image.sh"]]]) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30_000 })
    receipt.commands.push({ command: command === binary ? `actionlint ${policy.version}` : command, args, exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` })
    assert.equal(result.status, 0, receipt.commands.at(-1).output)
  }
  assert.deepEqual(graph.failures, [], graph.failures.join("\n"))
  receipt.status = "PASS"
} finally {
  receipt.finishedAt = new Date().toISOString()
  receipt.durationMs = Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`
    writeFileSync(join(evidence, `workflow-process-${Date.now()}-${receipt.status}.json`), bytes)
    writeFileSync(join(evidence, "workflow-process.json"), bytes)
  }
  console.log(JSON.stringify(receipt))
  rmSync(temporary, { recursive: true, force: true })
}
