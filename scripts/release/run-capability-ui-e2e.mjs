import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve, join } from "node:path"
import { chromium } from "@playwright/test"

const root = process.cwd(), output = resolve(process.env.FINNOR_CAPABILITY_EVIDENCE_DIR ?? "docs/release/generated/capability-ui")
await mkdir(output, { recursive: true })
const { build } = createRequire(join(root, "finnor-os/package.json"))("esbuild")
const paths = ["scripts/release/run-capability-ui-e2e.mjs", "src/components/centropy/canvas/DocumentCapabilityDesk.tsx", "src/components/centropy/canvas/NangoConnectionDesk.tsx", "src/components/centropy/canvas/ResearchCapabilityDesk.tsx", "src/components/centropy/canvas/ArtifactCanvas.tsx", "src/components/centropy/canvas/SourceDiagnostics.tsx", "src/components/centropy/canvas/CanvasDocument.tsx"]
const cut = () => Promise.all(paths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") })))
paths.push("src/components/centropy/canvas/PlannerCandidateReview.tsx")
const before = await cut(), documentId = randomUUID(), firstVersion = randomUUID(), secondVersion = randomUUID(), integrationId = randomUUID(), scopeId = randomUUID()
const requests = [], runs = new Map(), idempotency = new Map(); let loseFirstQueryAck = true
let preference = { revision: 0, operation: "disable", runId: null, reviewedResultDigest: null }
const entry = `import React,{useState} from 'react'; import{createRoot}from'react-dom/client';
import{DocumentCapabilityDesk}from ${JSON.stringify(join(root, paths[1]))};import{NangoConnectionDesk}from ${JSON.stringify(join(root, paths[2]))};import{ResearchCapabilityDesk}from ${JSON.stringify(join(root, paths[3]))};
function Harness(){const[v,setV]=useState(${JSON.stringify(firstVersion)});return <main><h1>Local capability component proof</h1><p>Selected version: {v}</p><button onClick={()=>setV(${JSON.stringify(secondVersion)})}>Switch to another version</button><DocumentCapabilityDesk key={v} documentId=${JSON.stringify(documentId)} versionId={v}/><NangoConnectionDesk/><ResearchCapabilityDesk/></main>}createRoot(document.getElementById('root')).render(<Harness/>);`
await build({ stdin: { contents: entry, resolveDir: root, sourcefile: "capability-ui-harness.tsx", loader: "tsx" }, bundle: true, platform: "browser", jsx: "automatic", outfile: join(output, "ui.js"), define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "explicit-local-api-fixture", setup(builder) {
  builder.onResolve({ filter: /^(?:@\/components\/centropy\/lib\/api|\.\.\/lib\/api)$/ }, () => ({ path: "local-fixture", namespace: "fixture-api" }))
  builder.onLoad({ filter: /.*/, namespace: "fixture-api" }, () => ({ contents: `async function call(p,o){const r=await fetch('/api/centropy/'+p,o);const j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j}export const centropyGet=(p,q)=>call(p+(q?'?'+new URLSearchParams(q):''));export const centropyPost=(p,b)=>call(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});`, loader: "js" }))
} }] })
const script = await readFile(join(output, "ui.js")), cases = []
const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1")
  const send = (value, status = 200) => { outgoing.writeHead(status, { "content-type": "application/json" }); outgoing.end(JSON.stringify(value)) }
  try {
    if (url.pathname === "/ui.js") { outgoing.writeHead(200, { "content-type": "text/javascript" }); outgoing.end(script); return }
    if (url.pathname === "/") { outgoing.writeHead(200, { "content-type": "text/html" }); outgoing.end('<!doctype html><html><meta name="viewport" content="width=device-width"><style>body{font:16px system-ui;margin:28px;max-width:1100px}section{border:1px solid #aaa;padding:16px;margin:12px 0}label{display:block;margin:10px 0}input,textarea,select{display:block;min-width:280px;max-width:90%}button,summary{cursor:pointer;margin:5px}pre{background:#eee;padding:12px}details{margin:18px 0}</style><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>'); return }
    if (incoming.method === "GET" && url.pathname === "/api/centropy/capabilities/planner/activation") { send({ activation: preference }); return }
    if (incoming.method === "GET" && url.pathname === "/api/centropy/capabilities/nango/sources") { send({ providers: [{ providerConfigKey: "fixture-crm", models: ["Account"], readOnly: true }], sources: [{ integration_id: integrationId, source_scope_id: scopeId, provider_config_key: "fixture-crm", model: "Account", status: "ACTIVE", revision: 2, cache_enumeration_completed: true, history_limited: false, updated_at: new Date().toISOString() }] }); return }
    if (incoming.method === "GET" && url.pathname === "/api/centropy/capabilities/runs") {
      const found = [...runs.values()].filter(run => (!url.searchParams.has("kind") || run.kind === url.searchParams.get("kind")) && (!url.searchParams.has("versionId") || run.sources.some(source => source.versionId === url.searchParams.get("versionId") && source.documentId === url.searchParams.get("documentId"))))
      send({ runs: found.reverse().map(({ id, kind, status, deadlineAt }) => ({ id, kind, status, deadlineAt })), nextCursor: null }); return
    }
    const runId = /^\/api\/centropy\/capabilities\/runs\/([^/]+)$/.exec(url.pathname)?.[1]
    if (incoming.method === "GET" && runId) { const run = runs.get(runId); send(run ? { run } : { error: "not found" }, run ? 200 : 404); return }
    if (incoming.method === "POST") {
      const chunks = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); requests.push({ path: url.pathname, body })
      if (url.pathname === "/api/centropy/capabilities/planner/activation") {
        assert.equal(body.expectedRevision, preference.revision); assert(body.reviewNote.trim().length >= 16)
        if (body.operation === "activate") assert.equal(body.reviewedResultDigest, runs.get(body.runId).resultDigest)
        preference = { revision: preference.revision + 1, operation: body.operation, runId: body.operation === "activate" ? body.runId : null, reviewedResultDigest: body.operation === "activate" ? body.reviewedResultDigest : null }; send({ activation: preference }); return
      }
      if (url.pathname === "/api/centropy/capabilities/nango/connect") { send({ session: { token: "PRIVATE_CONNECT_TOKEN_NOT_RENDERED", connect_link: "https://connect.nango.dev/local-fixture", expires_at: new Date(Date.now() + 600000).toISOString() } }); return }
      if (url.pathname === "/api/centropy/capabilities/runs") {
        const existing = idempotency.get(body.idempotencyKey)
        if (existing) { send({ run: runs.get(existing), replayed: true }); return }
        const id = randomUUID(), sources = body.source ? [body.source] : body.datasets ?? (body.dataset ? [body.dataset] : body.problemSet ? [body.problemSet] : body.indexRunIds ? runs.get(body.indexRunIds[0]).sources : [])
        const run = { id, kind: body.kind, request: body, status: "SUCCEEDED", sources, deadlineAt: new Date(Date.now() + body.timeoutMs).toISOString(), failureCode: null,
          result: body.kind === "gepa_optimize" ? { candidate: { instruction: "LOCAL_REVIEWED_PLANNER_FIXTURE" }, holdout: { baseline: 0, candidate: 1, tasks: 2, disposition: "IMPROVED_ON_THIS_HELDOUT_CUT" } } : body.kind === "docling_extract" ? { markdown: "LOCAL OCR TABLE FIXTURE", anchors: [{ page: 1, source: sources[0] }] } : body.kind === "pageindex_retrieve" ? { answer: "LOCAL PAGE ANSWER", citations: [{ page: 1, source: sources[0] }] } : { fixture: body.kind, rows: [["a", 40], ["b", 60]], qualification: "EXPLICIT_LOCAL_UI_TRANSPORT_FIXTURE" } }
        run.resultDigest = createHash("sha256").update(JSON.stringify(run.result)).digest("hex")
        runs.set(id, run); idempotency.set(body.idempotencyKey, id)
        if (body.kind === "duckdb_query" && loseFirstQueryAck) { loseFirstQueryAck = false; send({ error: "Gateway acknowledgement lost after acceptance" }, 504); return }
        send({ run, replayed: false }, 202); return
      }
    }
    send({ error: "fixture route not found" }, 404)
  } catch (error) { send({ error: String(error) }, 500) }
})
await new Promise(done => server.listen(0, "127.0.0.1", done)); const address = server.address(); assert(address && typeof address !== "string")
const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const browserErrors = []; page.on("pageerror", error => browserErrors.push(String(error)))
const until = async fn => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(done => setTimeout(done, 25)) }; throw new Error("BROWSER_OBSERVATION_TIMEOUT") }
const check = async (id, run) => { try { cases.push({ id, status: "PASS", observed: await run() }) } catch (error) { cases.push({ id, status: "FAIL", error: String(error) }) } }
try {
  await page.goto(`http://127.0.0.1:${address.port}`)
  await check("document-query-keeps-idempotency-after-lost-acceptance", async () => {
    await page.getByText("Document intelligence · extraction and analysis", { exact: true }).click()
    await page.getByText("Analyze a tabular snapshot · DuckDB / PyWhy", { exact: true }).click()
    await page.getByRole("button", { name: "Run snapshot query", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "reuse its submission key" }).waitFor()
    await page.getByRole("button", { name: "Run snapshot query", exact: true }).click()
    await until(() => requests.filter(request => request.body.kind === "duckdb_query").length === 2)
    const attempts = requests.filter(request => request.body.kind === "duckdb_query"); assert.equal(attempts[0].body.idempotencyKey, attempts[1].body.idempotencyKey); assert.equal(attempts[1].body.datasets[0].versionId, firstVersion)
    await page.getByRole("region", { name: "Document intelligence", exact: true }).getByText("SUCCEEDED", { exact: true }).waitFor(); return { submissions: 2, acceptedRuns: 1 }
  })
  await check("page-question-uses-the-selected-versions-index", async () => {
    await page.getByRole("button", { name: "Build PDF page index · PageIndex", exact: true }).click()
    await until(() => requests.some(request => request.body.kind === "pageindex_index"))
    await page.getByLabel("Question about this version", { exact: true }).fill("Which page contains the table?")
    await until(() => page.getByRole("button", { name: "Ask indexed document", exact: true }).isEnabled())
    await page.getByRole("button", { name: "Ask indexed document", exact: true }).click()
    await until(() => requests.some(request => request.body.kind === "pageindex_retrieve")); const request = requests.find(request => request.body.kind === "pageindex_retrieve")
    assert.equal(runs.get(request.body.indexRunIds[0]).sources[0].versionId, firstVersion); return { exactVersion: firstVersion }
  })
  await check("version-navigation-clears-prior-index-and-output", async () => {
    await page.getByRole("button", { name: "Switch to another version", exact: true }).click()
    await page.getByText("Document intelligence · extraction and analysis", { exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "Ask indexed document", exact: true }).isDisabled(), true)
    assert.equal(await page.getByText("LOCAL PAGE ANSWER", { exact: false }).count(), 0)
    await page.getByRole("button", { name: "Extract PDF text and tables · Docling", exact: true }).click()
    await until(() => requests.some(request => request.body.kind === "docling_extract")); assert.equal(requests.find(request => request.body.kind === "docling_extract").body.source.versionId, secondVersion); return { newVersion: secondVersion, staleOutputVisible: false }
  })
  await check("nango-connect-and-readonly-sync-use-server-catalog", async () => {
    await page.getByText("Connect more read-only sources", { exact: true }).click()
    await page.getByLabel("Service", { exact: true }).selectOption("fixture-crm")
    await page.getByRole("button", { name: "Create authorization link", exact: true }).click()
    await page.getByRole("link", { name: "Open secure authorization", exact: true }).waitFor(); assert.equal(await page.getByRole("link", { name: "Open secure authorization", exact: true }).getAttribute("href"), "https://connect.nango.dev/local-fixture")
    assert(!await page.locator("body").innerText().then(text => text.includes("PRIVATE_CONNECT_TOKEN_NOT_RENDERED")))
    await page.getByRole("button", { name: "Sync this source", exact: true }).click(); await until(() => requests.some(request => request.body.kind === "nango_sync"))
    const request = requests.find(request => request.body.kind === "nango_sync").body; assert.equal(request.integrationId, integrationId); assert.equal(request.sourceScopeId, scopeId); assert.equal(request.model, "Account"); assert(!("connectionId" in request)); return { catalogBound: true, providerCredentialRendered: false }
  })
  await check("reviewed-planner-preference-pins-result-and-restores-incumbent", async () => {
    await page.getByText("Evaluate a versioned optimization dataset", { exact: true }).click(); await page.getByRole("button", { name: "Optimize planner candidate · GEPA", exact: true }).click()
    await page.getByText("Review planner candidate for background use", { exact: true }).waitFor(); await page.getByText("Review planner candidate for background use", { exact: true }).click()
    await page.getByLabel("Review note", { exact: true }).fill("Reviewed this local immutable qualification cut before activation.")
    await until(() => page.getByRole("button", { name: "Activate this reviewed candidate", exact: true }).isEnabled()); await page.getByRole("button", { name: "Activate this reviewed candidate", exact: true }).click()
    await until(() => preference.revision === 1); const activation = requests.find(request => request.path.endsWith("/planner/activation") && request.body.operation === "activate").body
    assert.equal(activation.reviewedResultDigest, runs.get(activation.runId).resultDigest)
    await page.getByLabel("Review note", { exact: true }).fill("Restore the incumbent after this bounded component qualification.")
    await until(() => page.getByRole("button", { name: "Restore incumbent planner", exact: true }).isEnabled()); await page.getByRole("button", { name: "Restore incumbent planner", exact: true }).click()
    await until(() => preference.revision === 2); assert.equal(preference.operation, "disable"); return { exactReviewedDigest: true, activationRevision: 1, restoredRevision: 2 }
  })
  await check("research-and-monitor-lifecycle-are-operable", async () => {
    await page.getByText("Research and monitoring tools", { exact: true }).click(); await page.getByLabel("Research objective", { exact: true }).fill("Track changes to a synthetic industry")
    await page.getByRole("button", { name: "Research with citations", exact: true }).click(); await until(() => requests.some(request => request.body.kind === "parallel_task"))
    await until(() => page.getByRole("button", { name: "Research with citations", exact: true }).isEnabled())
    await page.getByText("Monitor this research objective", { exact: true }).click(); await page.getByRole("button", { name: "Start monitoring", exact: true }).click()
    await page.getByRole("button", { name: "Stop monitor", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Read monitor events", exact: true }).isEnabled(), true)
    await page.getByRole("button", { name: "Read monitor events", exact: true }).click()
    await until(() => requests.some(request => request.body.kind === "parallel_monitor_control" && request.body.operation === "events" && !request.body.eventGroupId))
    await until(() => page.getByRole("button", { name: "Read monitor events", exact: true }).isEnabled())
    await page.getByRole("textbox", { name: /^Event group for monitor / }).fill("fixture_group_1")
    await page.getByRole("button", { name: "Read monitor events", exact: true }).click()
    await until(() => requests.some(request => request.body.kind === "parallel_monitor_control" && request.body.operation === "events" && request.body.eventGroupId === "fixture_group_1")); assert.equal(requests.find(request => request.body.operation === "events" && request.body.eventGroupId).body.eventGroupId, "fixture_group_1")
    await page.getByRole("button", { name: "Stop monitor", exact: true }).click()
    await until(() => requests.some(request => request.body.kind === "parallel_monitor_control" && request.body.operation === "cancel")); const control = requests.find(request => request.body.kind === "parallel_monitor_control" && request.body.operation === "cancel").body
    assert.equal(control.operation, "cancel"); assert.equal(runs.get(control.monitorRunId).kind, "parallel_monitor"); return { taskProcessor: "lite", monitorCancellationBoundToOwnedRun: true }
  })
  await page.screenshot({ path: join(output, "capability-components.png"), fullPage: true })
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(() => done())) }
const after = await cut(), sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after)
await writeFile(join(output, "results.json"), JSON.stringify({ schema: "finnor.capability-ui-e2e.v1", before, after, sourcesUnchanged, cases, browserErrors, requests,
  qualification: "REAL_REACT_COMPONENTS_AND_CHROMIUM_LOCAL_TRANSPORT_FIXTURE; NATIVE_API_QUEUE_WORKER_PROVEN_SEPARATELY; NO_NEXT_LAYOUT_SUPABASE_OR_HOSTED_SERVICE_QUALIFICATION",
  rerun: "FINNOR_CAPABILITY_EVIDENCE_DIR=<fresh-directory> node scripts/release/run-capability-ui-e2e.mjs" }, null, 2))
console.log(JSON.stringify({ output, sourcesUnchanged, cases: cases.map(({ id, status, error }) => ({ id, status, error })), browserErrors })); process.exitCode = sourcesUnchanged && !cases.some(row => row.status !== "PASS") && !browserErrors.length ? 0 : 1
