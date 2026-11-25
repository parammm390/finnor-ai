import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const guard = fileURLToPath(new URL("./machine-local-paths.mjs", import.meta.url))
const abs = (...parts) => `/${parts.join("/")}`
const run = (cwd, command, args) => spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env,
  GIT_AUTHOR_NAME: "guard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "guard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } })

function commitFile(contents) {
  const repo = mkdtempSync(join(tmpdir(), "machine-path-guard-"))
  run(repo, "git", ["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(repo, "existing.json"), `{"path": "${abs("Users", "someone", "old")}"}\n`)
  run(repo, "git", ["add", "."])
  run(repo, "git", ["commit", "--quiet", "-m", "baseline with a pre-existing path"])
  writeFileSync(join(repo, "added.json"), contents)
  run(repo, "git", ["add", "."])
  run(repo, "git", ["commit", "--quiet", "-m", "change under review"])
  return { repo, result: run(repo, process.execPath, [guard, "HEAD^", "HEAD"]) }
}

test("rejects an added home-directory path and names the fix", () => {
  const { repo, result } = commitFile(`{"evidence": "${abs("Users", "paramdave", "Desktop", "FINNOR", "run.json")}"}\n`)
  try {
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^added\.json:1: machine-local path "\/Users\/paramdave\/"\. Derive it from the file's own location/m)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("rejects Linux agent homes and macOS temporary folders", () => {
  const { repo, result } = commitFile(`a ${abs("home", "factory-user", "repo")}\nb ${abs("var", "folders", "qp", "T", "x")}\n`)
  try {
    assert.equal(result.status, 1)
    assert.match(result.stderr, /added\.json:1: machine-local path "\/home\/factory-user\/"/)
    assert.match(result.stderr, /added\.json:2: machine-local path "\/var\/folders\/qp\/"/)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("accepts repository-relative paths and leaves pre-existing paths to their owners", () => {
  const { repo, result } = commitFile(`{"evidence": "scope-r/handoff/run.json"}\n`)
  try {
    assert.equal(result.status, 0, result.stderr)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("honours an unexpired, approved exception and rejects an expired one", () => {
  const live = commitFile(`${abs("Users", "ci", "x")} allow-machine-path: vendor fixture; expires=2999-01-01; approved=@parammm390\n`)
  const expired = commitFile(`${abs("Users", "ci", "x")} allow-machine-path: vendor fixture; expires=2000-01-01; approved=@parammm390\n`)
  try {
    assert.equal(live.result.status, 0, live.result.stderr)
    assert.equal(expired.result.status, 1)
    assert.match(expired.result.stderr, /exception expired on 2000-01-01/)
  } finally {
    rmSync(live.repo, { recursive: true, force: true })
    rmSync(expired.repo, { recursive: true, force: true })
  }
})
