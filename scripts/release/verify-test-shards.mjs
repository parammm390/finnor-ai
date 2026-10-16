import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const cwd = join(root, "finnor-os")
const excluded = "tests/integration/phase6-conversation-context-kernel.test.ts"
const receipt = { schema: "finnor.ci-shard-coverage.v1", status: "FAIL", startedAt: new Date().toISOString(), inputs: {}, lists: [], testsExecuted: false, rerun: "FINNOR_CI_PROCESS_EVIDENCE_DIR=/absolute/new/evidence node scripts/release/verify-test-shards.mjs" }
function list() {
  const args = ["node_modules/vitest/vitest.mjs", "list", "--filesOnly", "--json", "--exclude", excluded]
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.status, 0, `Vitest inventory failed: ${result.stderr}`)
  const files = JSON.parse(result.stdout).map(record => relative(cwd, record.file).replaceAll("\\", "/")).sort()
  assert.ok(files.length, "Empty test inventory")
  assert.equal(files.length, new Set(files).size, "Duplicate test paths within a shard")
  receipt.lists.push({ command: process.execPath, args, files })
  return files
}
try {
  for (const path of ["finnor-os/vitest.config.ts", "finnor-os/package-lock.json", ".github/workflows/ci.yml"]) receipt.inputs[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex")
  const all = list()
  // `vitest list --filesOnly` intentionally bypasses the execution pool and
  // ignores --shard. Invoke the installed, configured execution sequencer;
  // never implement a second approximation of its partition algorithm.
  const program = `
    import { createVitest } from './node_modules/vitest/dist/node.js';
    const context = await createVitest('test', { root: process.cwd(), watch: false, exclude: [${JSON.stringify(excluded)}] });
    try {
      const specs = await context.globTestSpecifications();
      const Sequencer = context.config.sequence.sequencer;
      const shards = [];
      for (const index of [1, 2, 3]) {
        context.config.shard = { index, count: 3 };
        shards.push((await new Sequencer(context).shard(Array.from(specs))).map(spec => spec.moduleId));
      }
      console.log(JSON.stringify({ all: specs.map(spec => spec.moduleId), shards }));
    } finally { await context.close(); }
  `
  const selected = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(selected.status, 0, `Installed execution sequencer failed: ${selected.stderr}`)
  const actual = JSON.parse(selected.stdout)
  const normalize = files => files.map(file => relative(cwd, file).replaceAll("\\", "/")).sort()
  assert.deepEqual(normalize(actual.all), all, "Runtime discovery differs from the independent CLI inventory")
  const shards = actual.shards.map(normalize)
  receipt.lists.push(...shards.map((files, index) => ({ command: "installed Vitest execution sequencer", shard: `${index + 1}/3`, files })))
  const combined = shards.flat().sort()
  assert.equal(new Set(combined).size, combined.length, "A test file occurs in multiple shards")
  assert.deepEqual(combined, all, "Shards must partition the complete existing active suite")
  assert.ok(!combined.includes(excluded), "Retired fixture exclusion changed")
  receipt.totalFiles = all.length
  receipt.shardCounts = shards.map(files => files.length)
  receipt.status = "PASS"
} finally {
  receipt.finishedAt = new Date().toISOString()
  receipt.durationMs = Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)
  const evidence = process.env.FINNOR_CI_PROCESS_EVIDENCE_DIR
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`
    writeFileSync(join(evidence, `test-shards-${Date.now()}-${receipt.status}.json`), bytes)
    writeFileSync(join(evidence, "test-shards.json"), bytes)
  }
  console.log(JSON.stringify({ ...receipt, lists: receipt.lists.map(list => ({ ...list, files: list.files.length })) }))
}
