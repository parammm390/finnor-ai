import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { writeChangedFilesEvidence, readChangedFilesEvidence } from "./pr-verdict-policy.mjs"

test("a complete large PR diff crosses a real process boundary without file-list environment variables", () => {
  const directory = mkdtempSync(join(tmpdir(), "finnor-large-verdict-"))
  const head = "a".repeat(40), base = "b".repeat(40)
  const files = Array.from({ length: 5000 }, (_, index) => `finnor-os/packages/real-owner-${index}/long-original-source-name-${index}.ts`)
  files.push("docs/unusual\nname ü.md")
  assert(Buffer.byteLength(JSON.stringify(files)) > 131072)
  try {
    const path = join(directory, "changed-files.json")
    const digest = writeChangedFilesEvidence({ path, files, head, base })
    const module = new URL("./pr-verdict-policy.mjs", import.meta.url).href
    const script = `import {readChangedFilesEvidence,evaluateRequiredPrVerdict} from ${JSON.stringify(module)}; const files=readChangedFilesEvidence({path:process.env.INPUT_FILE,expectedSha256:process.env.INPUT_DIGEST,head:process.env.HEAD_SHA,base:process.env.BASE_SHA}); const result=evaluateRequiredPrVerdict({files,classifyResult:'success',sourceResult:'success',backendApplicable:true,backendResult:'success',rootApplicable:true,rootResult:'success',dependencyApplicable:true,securityResult:'success',replayResult:'success',readinessResult:'success'}); console.log(JSON.stringify({files:result.verdict.changedFiles,failures:result.failures}));`
    const child = spawnSync(process.execPath, ["--input-type=module"], { input: script, env: { PATH: process.env.PATH, INPUT_FILE: path, INPUT_DIGEST: digest, HEAD_SHA: head, BASE_SHA: base, GITHUB_RUN_ATTEMPT: "2" }, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout); assert.deepEqual(result.files, files); assert.deepEqual(result.failures, [])
    assert.deepEqual(readChangedFilesEvidence({ path, expectedSha256: digest, head, base }), files)
    assert.throws(() => readChangedFilesEvidence({ path, expectedSha256: digest, head: base, base }), /identity/)
    writeFileSync(path, readFileSync(path, "utf8").replace("real-owner-0", "fake-owner-0"))
    assert.throws(() => readChangedFilesEvidence({ path, expectedSha256: digest, head, base }), /digest/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
