import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const guard = fileURLToPath(new URL("./keyset-cursors.mjs", import.meta.url))
const run = (cwd, command, args) => spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env,
  GIT_AUTHOR_NAME: "guard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "guard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } })

function commitSource(path, contents) {
  const repo = mkdtempSync(join(tmpdir(), "keyset-guard-"))
  run(repo, "git", ["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(repo, "README.md"), "fixture\n")
  run(repo, "git", ["add", "."])
  run(repo, "git", ["commit", "--quiet", "-m", "baseline"])
  mkdirSync(join(repo, dirname(path)), { recursive: true })
  writeFileSync(join(repo, path), contents)
  run(repo, "git", ["add", "."])
  run(repo, "git", ["commit", "--quiet", "-m", "change under review"])
  return { repo, result: run(repo, process.execPath, [guard, "HEAD^", "HEAD"]) }
}

test("rejects a page boundary that compares a timestamp column with a Date from the cursor", () => {
  const { repo, result } = commitSource("finnor-os/apps/api/app/api/example/route.ts",
    "const where = cursor ? or(\n  lt(domainActions.createdAt, new Date(cursor.createdAt)),\n) : undefined\n")
  try {
    assert.equal(result.status, 1)
    assert.match(result.stderr, /route\.ts:2: page cursor built from a JavaScript Date\. .*exactInstant\(column\).*packages\/db\/keyset\.ts/)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("rejects a next cursor encoded from a row's Date", () => {
  const { repo, result } = commitSource("finnor-os/packages/read-models/src/example.ts",
    "const nextCursor = last\n  ? encode({ at: last.updatedAt.toISOString(), id: last.id })\n  : null\n")
  try {
    assert.equal(result.status, 1)
    assert.match(result.stderr, /example\.ts:2: page cursor built from a JavaScript Date/)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("accepts a page that uses the shared exact keyset", () => {
  const { repo, result } = commitSource("finnor-os/packages/read-models/src/example.ts",
    "const rows = await db.select({ row: works, at: exactInstant(works.updatedAt) }).from(works)\n  .where(cursor ? olderThan(works.updatedAt, works.id, cursor) : undefined)\nconst nextCursor = last ? encodeKeysetCursor({ at: last.at, id: last.row.id }) : null\n")
  try {
    assert.equal(result.status, 0, result.stderr)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
