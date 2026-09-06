import { execFileSync } from "node:child_process"

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

// `git status --untracked-files=all` recursively walks large evidence/database
// trees before it reports the source changes that make a release ineligible. Use
// Git's tracked diff plus directory-level untracked entries: this preserves the
// clean-worktree invariant while keeping the release gate bounded in evidence-heavy
// worktrees.
function worktreeStatus() {
  return [
    git(["diff-files", "--name-only", "-z", "--"]),
    git(["diff", "--cached", "--name-only", "-z", "--"]),
    git(["ls-files", "--others", "--exclude-standard", "--directory", "-z"]),
  ].filter(Boolean).join("\n")
}

function fail(message) {
  console.error(`Release provenance check failed: ${message}`)
  process.exit(1)
}

const actualSha = git(["rev-parse", "HEAD"]).toLowerCase()
const expectedSha = (process.env.RELEASE_COMMIT_SHA || process.env.GITHUB_SHA || actualSha).toLowerCase()
const dirty = worktreeStatus()
const buildId = process.env.FINNOR_BUILD_ID || ""
const version = process.env.FINNOR_VERSION || ""
const environment = process.env.FINNOR_ENVIRONMENT || ""
const source = process.env.FINNOR_RELEASE_SOURCE || ""
const expectedBuildId = `finnor-${actualSha.slice(0, 12)}`

if (!FULL_COMMIT_SHA.test(actualSha)) fail(`HEAD is not a full commit SHA: ${actualSha}`)
if (actualSha !== expectedSha) fail(`HEAD ${actualSha} does not match expected ${expectedSha}`)
if (dirty) fail(`working tree is dirty:\n${dirty}`)
if (process.env.VERCEL_TOKEN === "") fail("VERCEL_TOKEN is set but empty")
if (buildId !== expectedBuildId) fail(`FINNOR_BUILD_ID must be ${expectedBuildId}, got ${buildId || "<missing>"}`)
if (!version || !version.endsWith(`+${actualSha.slice(0, 12)}`)) {
  fail(`FINNOR_VERSION must end with +${actualSha.slice(0, 12)}, got ${version || "<missing>"}`)
}
if (environment !== "production") fail(`FINNOR_ENVIRONMENT must be production, got ${environment || "<missing>"}`)
if (!source) fail("FINNOR_RELEASE_SOURCE is missing")

const remoteMain = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]
if (remoteMain !== actualSha) fail(`origin/main is ${remoteMain || "missing"}, not ${actualSha}`)

console.log(JSON.stringify({
  ok: true,
  commitSha: actualSha,
  buildId,
  version,
  environment,
  source,
  remoteMain,
  dirty: false,
}, null, 2))
