import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import test from "node:test"

const source = readFileSync(new URL("../../.github/workflows/ci-completion.yml", import.meta.url), "utf8")
const script = source.split("node --input-type=module <<'NODE'\n")[1]?.split("\n          NODE")[0]?.split("\n").map(line => line.slice(10)).join("\n")
assert(script, "The actual reusable completion workflow must contain its reporting program")
const head = "a".repeat(40), other = "b".repeat(40)

async function fixture(options = {}) {
  const requests = [], posted = []
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    let value
    if (request.url === "/repos/parammm390/finnor-ai/pulls/187") value = { state: "open", head: { sha: options.currentHead ?? head, repo: { full_name: options.fork ? "someone/else" : "parammm390/finnor-ai" } } }
    else if (request.url === "/repos/parammm390/finnor-ai/actions/runs/123") value = { id: 123, head_sha: options.runHead ?? head, run_started_at: "2026-11-15T00:00:00Z", html_url: "https://github.com/parammm390/finnor-ai/actions/runs/123" }
    else if (request.method === "GET" && request.url.startsWith("/repos/parammm390/finnor-ai/issues/187/comments?")) value = options.comments ?? []
    else if (request.method === "POST" && request.url === "/repos/parammm390/finnor-ai/issues/187/comments") { posted.push(JSON.parse(body)); value = { id: 1 } }
    else { response.writeHead(404); response.end("{}"); return }
    response.writeHead(options.apiFailure ? 403 : 200, { "content-type": "application/json" }); response.end(JSON.stringify(value))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const child = spawn(process.execPath, ["--input-type=module"], { env: { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: "parammm390/finnor-ai", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GH_TOKEN: "disposable-test-token", REVIEW_PR: "187", REVIEW_HEAD: head, REVIEW_GATE: options.gate ?? "required-pr-verdict", REVIEW_RESULT: options.result ?? "success" }, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.on("data", value => { stdout += value }); child.stderr.on("data", value => { stderr += value })
  child.stdin.end(script)
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  await new Promise(resolve => server.close(resolve))
  return { code, stdout, stderr, posted, requests }
}

test("terminal required gates emit a source-bound pass or fail through real HTTP", async () => {
  for (const gate of ["required-pr-verdict", "original-owner (default)", "w2-pair-verdict"]) for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const value = await fixture({ result, gate }); assert.equal(value.code, 0, value.stderr); assert.equal(value.posted.length, 1)
    const body = value.posted[0].body; assert(body.startsWith("<!-- finnor-ci-completion:v1 -->")); assert(body.includes(head)); assert(body.includes('"runId":123')); assert(body.includes(`"result":"${result === "success" ? "PASS" : "FAIL"}"`))
    assert(value.requests.every(request => request.authorization === "Bearer disposable-test-token"))
  }
})
test("a pending gate never emits a terminal event", async () => { const value = await fixture({ result: "in_progress" }); assert.notEqual(value.code, 0); assert.equal(value.posted.length, 0) })
test("stale heads cannot wake review of a different candidate", async () => { const value = await fixture({ currentHead: other }); assert.equal(value.code, 0); assert.equal(value.posted.length, 0) })
test("a fork source cannot use the owned-repository completion relay", async () => { const value = await fixture({ fork: true }); assert.equal(value.code, 0); assert.equal(value.posted.length, 0) })
test("a run with a different source is refused", async () => { const value = await fixture({ runHead: other }); assert.notEqual(value.code, 0); assert.equal(value.posted.length, 0) })
test("an existing bot receipt makes reruns idempotent", async () => { const value = await fixture({ comments: [{ user: { type: "Bot" }, body: '<!-- finnor-ci-completion:v1 -->\n{"receiptKey":"required-pr-verdict:123:1"}' }] }); assert.equal(value.code, 0); assert.equal(value.posted.length, 0) })
test("an API refusal cannot be reported as a successful receipt", async () => { const value = await fixture({ apiFailure: true }); assert.notEqual(value.code, 0); assert.equal(value.posted.length, 0) })
