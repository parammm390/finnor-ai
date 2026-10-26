import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import pg from "pg";
import { z } from "zod";
import { createNativeOwnerDatabase } from "../s7/native-owner-database.mjs";

const output = resolve(process.env.FINNOR_CAPABILITY_EVIDENCE_DIR ?? "../docs/release/generated/capability-delivery");
await mkdir(output, { recursive: true });
let modalFixture: ReturnType<typeof spawn> | null = null;
if (process.env.FINNOR_VERIFY_MODAL_PROTOCOL === "1") {
  const executable = process.env.FINNOR_CAPABILITY_PYTHON; assert(executable);
  modalFixture = spawn(executable, ["-I", "-B", "scripts/release/modal-protocol-fixture.py", join(output, "modal-protocol")], { env: { PATH: process.env.PATH, NODE_ENV: "test", FINNOR_MODAL_PROTOCOL_FIXTURE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const fixture = modalFixture;
  const ready = await new Promise<{ url: string }>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error("MODAL_FIXTURE_START_TIMEOUT")), 10_000); let pending = "";
    fixture.once("error", reject); fixture.once("exit", () => reject(new Error("MODAL_FIXTURE_EXITED_BEFORE_READY")));
    fixture.stderr?.on("data", () => undefined);
    fixture.stdout?.on("data", chunk => { pending += String(chunk); const end = pending.indexOf("\n"); if (end >= 0) { clearTimeout(timeout); done(z.object({ ready: z.literal(true), url: z.string().url() }).parse(JSON.parse(pending.slice(0, end)))); } });
  });
  Object.assign(process.env, { FINNOR_MODAL_ENABLED: "1", MODAL_TOKEN_ID: "ak-disposable-fixture", MODAL_TOKEN_SECRET: "as-disposable-fixture", FINNOR_MODAL_APP_NAME: "finnor-fixture",
    FINNOR_MODAL_IMAGE_ID: "im-Fixture123", FINNOR_MODAL_SERVER_URL: ready.url, FINNOR_MODAL_MAX_RUNS_PER_TENANT_DAY: "100" });
}
const sourcePaths = ["scripts/s7/native-owner-database.mjs", "packages/db/migrations/0171_runtime_database_role_isolation.sql", "apps/worker/src/queue.ts","packages/orchestration/src/capabilities/optimization-broker.ts", "packages/tools/src/capabilities/python/requirements-linux-cpu.lock.txt", "packages/memory/src/evidence.ts", "packages/db/migrations/postx_y5_capability_3_capability_private_evidence.sql", "packages/tools/src/langfuse.ts", "packages/tools/src/llm.ts", "packages/tools/src/registry.ts", "scripts/release/verify-langfuse-registered-path.mts", "apps/worker/src/index.ts", "Dockerfile.worker", "packages/tools/src/capabilities/python/requirements-runtime.lock.txt", "packages/orchestration/src/capabilities/shinka-execution.ts", "packages/orchestration/src/capabilities/modal-execution.ts", "packages/tools/src/capabilities/python/modal_engine.py", "packages/tools/src/capabilities/python/modal_bootstrap.py", "scripts/release/modal-protocol-fixture.py", "scripts/release/run-capability-worker-once.mts", "packages/db/compute-contract.ts", "packages/orchestration/src/capabilities/policy.ts", "packages/orchestration/src/capabilities/job-claim.ts",
  "packages/orchestration/src/capabilities/gepa-execution.ts", "packages/tools/src/capabilities/python/gepa_engine.py", "packages/orchestration/src/capabilities/document-evidence.ts", "packages/tools/src/capabilities/python/docling_engine.py", "scripts/release/create-scanned-pdf-fixture.py",
  "packages/orchestration/src/capabilities/nango-bindings.ts", "packages/orchestration/src/capabilities/nango-execution.ts", "packages/orchestration/src/capabilities/nango-webhook.ts",
  "packages/tools/src/nango.ts", "packages/db/migrations/postx_y5_capability_2_nango_readonly_sources.sql", "packages/db/migration-head.ts", "packages/db/schema.ts",
  "apps/api/app/api/capabilities/nango/connect/route.ts", "apps/api/app/api/capabilities/nango/sources/route.ts", "apps/api/app/api/webhooks/nango/route.ts","packages/orchestration/src/capabilities/contracts.ts", "packages/orchestration/src/capabilities/repository.ts", "packages/orchestration/src/capabilities/execution.ts",
  "packages/tools/src/capabilities/python-runner.ts", "packages/tools/src/capabilities/python/duckdb_engine.py", "packages/db/migrations/postx_y5_capability_1_capability_provider_runs.sql",
  "apps/worker/src/handlers/run-capability-provider.ts", "apps/api/lib/capabilities.ts", "apps/api/app/api/capabilities/runs/route.ts", "apps/api/app/api/capabilities/runs/[id]/route.ts",
  "packages/orchestration/src/capabilities/parallel-execution.ts", "packages/tools/src/parallel.ts", "packages/tools/src/capabilities/provider-json.ts",
  "packages/tools/src/capabilities/python/pywhy_engine.py", "packages/tools/src/capabilities/python/requirements-causal.lock.txt",
  "packages/orchestration/src/capabilities/pageindex-execution.ts", "packages/orchestration/src/capabilities/pageindex-chat-execution.ts", "packages/orchestration/src/capabilities/provider-step.ts", "packages/tools/src/pageindex.ts",
  "packages/orchestration/src/capabilities/planner-activation.ts", "packages/orchestration/src/capabilities/planner-environment.ts", "apps/api/app/api/capabilities/planner/activation/route.ts", "packages/db/migrations/postx_y5_capability_4_capability_planner_activations.sql", "packages/orchestration/src/planner.ts", "packages/planning/src/compiler.ts",
  "packages/orchestration/src/capabilities/nango-lifecycle.ts", "packages/db/migrations/postx_y5_capability_5_capability_nango_lifecycle.sql", "packages/data-platform/src/provider-observations.ts",
  "scripts/release/run-capability-delivery-e2e.mts"];
const replayManifestPath = "packages/orchestration/src/capabilities/planner-replay-manifest.json";
const replayManifest = z.object({ sources: z.array(z.object({ file: z.string() })) }).parse(JSON.parse(await readFile(replayManifestPath, "utf8")));
sourcePaths.push(replayManifestPath, ...replayManifest.sources.map(source => source.file));
const sourceCut = async () => Promise.all([...new Set(sourcePaths)].map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
const before = await sourceCut();
const cases: Array<{ id: string; status: "PASS" | "FAIL"; observed?: unknown; error?: string }> = [];
async function check(id: string, run: () => Promise<unknown>) {
  try { cases.push({ id, status: "PASS", observed: await run() }); }
  catch (error) { cases.push({ id, status: "FAIL", error: String(error) }); }
  await writeFile(join(output, "partial-results.json"), JSON.stringify({ before, cases }, null, 2));
  console.log(JSON.stringify(cases.at(-1)));
}
console.log(JSON.stringify({ event: "disposable_database_starting" }));
process.env.FINNOR_CAPABILITY_NATIVE_WORKER_ROLE = "1";
const database = await createNativeOwnerDatabase();
const { admin, db } = database;
// This disposable database starts in the migration's preparing state. Exercise
// the real class claim guard with an explicitly synthetic fixture release id.
const fixtureReleaseId = createHash("sha1").update(JSON.stringify(before)).digest("hex");
await admin.query("UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=3,minimum_claim_epoch=3,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,activated_release_sha=$1,activated_at=clock_timestamp() WHERE singleton", [fixtureReleaseId]);
const tenant = randomUUID(), principal = randomUUID(), otherTenant = randomUUID(), otherPrincipal = randomUUID();
const pageTenant = randomUUID(), pagePrincipal = randomUUID(), nangoTenant = randomUUID(), nangoPrincipal = randomUUID();
const sameTenantPrincipal = randomUUID();
for (const [tenantId, userId] of [[tenant, principal], [otherTenant, otherPrincipal], [pageTenant, pagePrincipal], [nangoTenant, nangoPrincipal]]) {
  await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,$2)", [tenantId, "Capability disposable fixture"]);
  await admin.query("SELECT finnor_os.ensure_legacy_authority($1)", [tenantId]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [userId, tenantId, `${userId}@generated.invalid`]);
  await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) SELECT $1,$2,id,'{\"kind\":\"tenant\"}'::jsonb FROM finnor_os.employee_roles WHERE tenant_id=$1 AND key='owner' ON CONFLICT DO NOTHING", [tenantId, userId]);
}
await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [sameTenantPrincipal, pageTenant, `${sameTenantPrincipal}@generated.invalid`]);
const { createDocument, appendDocumentVersion } = await import("../../packages/data-platform/src/index");
const csv = Buffer.from("customer,revenue\na,40\nb,60\n");
const source = await db.withTenant(tenant, async connection => {
  const document = await createDocument(connection, { tenantId: tenant, kind: "tabular_evidence", title: "Concentration fixture.csv", provenance: { sourceSystem: "capability-e2e", createdBy: principal } });
  const version = await appendDocumentVersion(connection, { tenantId: tenant, documentId: document.documentId, bytes: csv, mediaType: "text/csv", format: "unknown", origin: "manual_upload", actor: principal });
  return { documentId: document.documentId, versionId: version.id, sha256: version.byte_sha256 };
}, principal);
let generatorSeed = 117;
const random = () => ((generatorSeed = Math.imul(generatorSeed, 1664525) + 1013904223 >>> 0) + 0.5) / 4294967296;
const causalRows = ["t,y,x,z"];
for (let index = 0; index < 500; index++) { const x = random() * 2 - 1, z = random() * 2 - 1, t = random() < 0.5 + x * 0.08 ? 1 : 0; causalRows.push([t, 2 * t + 0.5 * x + 0.2 * z + (random() - 0.5) * 0.1, x, z].join(",")); }
const causalCsv = causalRows.join("\n") + "\n";
await writeFile(join(output, "causal-input.csv"), causalCsv);
const causalSource = await db.withTenant(tenant, async connection => {
  const document = await createDocument(connection, { tenantId: tenant, kind: "tabular_evidence", title: "Synthetic known-effect fixture.csv", provenance: { sourceSystem: "capability-e2e", createdBy: principal } });
  const version = await appendDocumentVersion(connection, { tenantId: tenant, documentId: document.documentId, bytes: Buffer.from(causalCsv), mediaType: "text/csv", format: "unknown", origin: "manual_upload", actor: principal });
  return { documentId: document.documentId, versionId: version.id, sha256: version.byte_sha256 };
}, principal);
const gepaDataset = { schema: "finnor.planner-replay-dataset.v1", seedInstruction: "Prefer clarification when uncertain.", tasks:
  ["train", "validation", "holdout"].flatMap(split => [1, 2].map(index => ({ id: `${split}_${index}`, split, instruction: `Prepare a focused brief on synthetic ${split} component ${index}`, expectedActionTypes: ["search_web"] }))) };
let gepaSource: { documentId: string; versionId: string } | null = null;
let gepaProviderCalls = 0;
if (process.env.FINNOR_VERIFY_GEPA === "1") {
  gepaSource = await db.withTenant(pageTenant, async connection => {
    const document = await createDocument(connection, { tenantId: pageTenant, kind: "evaluation_dataset", title: "GEPA independent planner fixture.json", provenance: { sourceSystem: "capability-e2e", createdBy: pagePrincipal } });
    const version = await appendDocumentVersion(connection, { tenantId: pageTenant, documentId: document.documentId, bytes: Buffer.from(JSON.stringify(gepaDataset)), mediaType: "application/json", format: "unknown", origin: "manual_upload", actor: pagePrincipal });
    return { documentId: document.documentId, versionId: version.id };
  }, pagePrincipal);
  const { registerProvider } = await import("../../packages/tools/src/llm");
  const fixtureFactory = () => ({ name: "capability-gepa-fixture",
    qualificationIdentity: { transport: "custom" as const, name: "capability-gepa-fixture", revision: process.env.FINNOR_GEPA_FIXTURE_MODEL_REVISION ?? "v1" },
    complete: async (options: import("../../packages/tools/src/llm").LLMCallOptions) => {
    gepaProviderCalls++;
    if (options.purpose === "repair") return JSON.stringify({ instruction: "USE_SYNTHETIC_RESEARCH: propose the schema-valid native search_web action for a focused research brief." });
    const input = z.object({ goal: z.object({ criteria: z.array(z.object({ id: z.string() })) }) }).parse(JSON.parse(options.user));
    const improved = options.system.includes("USE_SYNTHETIC_RESEARCH"), key = improved ? "research" : "clarify";
    return JSON.stringify({ candidates: [{ version: 1, candidateKey: "synthetic", nodes: [{ key, kind: "action", actionType: improved ? "search_web" : "clarification_request",
      payload: improved ? { query: "Synthetic public component evidence" } : { question: "Which component?" }, supports: input.goal.criteria.map(c => c.id) },
      ...input.goal.criteria.map((criterion, index) => ({ key: `check_${index + 1}`, kind: "check", criterionId: criterion.id, dependsOn: [key] }))] }] });
  } });
  registerProvider("capability-gepa-fixture", fixtureFactory);
  // Next route handlers are CJS in this tsx harness; the worker is ESM. Each
  // loader owns a module instance, so configure the same local fixture in both.
  const { createRequire } = await import("node:module");
  createRequire(import.meta.url)("../../packages/tools/src/llm.ts").registerProvider("capability-gepa-fixture", fixtureFactory);
  process.env.LLM_PROVIDER_PLANNING_BACKGROUND = "capability-gepa-fixture"; process.env.LLM_PROVIDER_REPAIR_BACKGROUND = "capability-gepa-fixture"; process.env.FINNOR_GEPA_ENABLED = "1";
  process.env.FINNOR_GEPA_MAX_RUNS_PER_TENANT_DAY = "2";
}
const pdfParts = ["%PDF-1.4\n"];
const pdfOffsets = [0];
const stream = "BT /F1 12 Tf 20 100 Td (Synthetic revenue 42) Tj ET";
const pdfObjects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
for (const [index, object] of pdfObjects.entries()) { pdfOffsets.push(Buffer.byteLength(pdfParts.join(""))); pdfParts.push(`${index + 1} 0 obj\n${object}\nendobj\n`); }
const crossReference = Buffer.byteLength(pdfParts.join(""));
pdfParts.push(`xref\n0 6\n0000000000 65535 f \n${pdfOffsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF\n`);
const pdf = Buffer.from(pdfParts.join("")); await writeFile(join(output, "pageindex-source.pdf"), pdf);
const pageSource = await db.withTenant(pageTenant, async connection => {
  const document = await createDocument(connection, { tenantId: pageTenant, kind: "document", title: "Synthetic page source.pdf", provenance: { sourceSystem: "capability-e2e", createdBy: pagePrincipal } });
  const version = await appendDocumentVersion(connection, { tenantId: pageTenant, documentId: document.documentId, bytes: pdf, mediaType: "application/pdf", format: "pdf", origin: "manual_upload", actor: pagePrincipal });
  return { documentId: document.documentId, versionId: version.id, sha256: version.byte_sha256 };
}, pagePrincipal);
let scannedSource: { documentId: string; versionId: string; sha256: string } | null = null;
if (process.env.FINNOR_VERIFY_DOCLING === "1") {
  const path = join(output, "scanned-table.pdf"), executable = process.env.FINNOR_CAPABILITY_PYTHON; assert(executable);
  await new Promise<void>((done, reject) => {
    const generator = spawn(executable, ["-I", "-B", "scripts/release/create-scanned-pdf-fixture.py", path], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH, NODE_ENV: "test" } });
    generator.stderr.on("data", () => undefined); generator.once("error", reject); generator.once("exit", code => code === 0 ? done() : reject(new Error("SCANNED_PDF_GENERATOR_FAILED")));
  });
  scannedSource = await db.withTenant(pageTenant, async connection => {
    const document = await createDocument(connection, { tenantId: pageTenant, kind: "document", title: "Image-only scanned table.pdf", provenance: { sourceSystem: "capability-e2e", createdBy: pagePrincipal } });
    const version = await appendDocumentVersion(connection, { tenantId: pageTenant, documentId: document.documentId, bytes: await readFile(path), mediaType: "application/pdf", format: "pdf", origin: "manual_upload", actor: pagePrincipal });
    return { documentId: document.documentId, versionId: version.id, sha256: version.byte_sha256 };
  }, pagePrincipal);
  process.env.FINNOR_DOCLING_MODELS_DIR = resolve(".capability-models/docling");
}
const createRoute = await import("../../apps/api/app/api/capabilities/runs/route");
const readRoute = await import("../../apps/api/app/api/capabilities/runs/[id]/route");
const plannerActivationRoute = await import("../../apps/api/app/api/capabilities/planner/activation/route");
const nangoConnectRoute = await import("../../apps/api/app/api/capabilities/nango/connect/route");
const nangoSourcesRoute = await import("../../apps/api/app/api/capabilities/nango/sources/route");
const nangoWebhookRoute = await import("../../apps/api/app/api/webhooks/nango/route");
const { JobQueue } = await import("../../apps/worker/src/queue");
const { runCapabilityProvider } = await import("../../apps/worker/src/handlers/run-capability-provider");
const queue = new JobQueue(`capability-e2e:${randomUUID()}`, 30, "HEAVY");
queue.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1);
const providerSubmissions: Array<{ path: string; input: unknown }> = [];
let taskReady = false;
let monitorDeletions = 0;
let revokedMonitorDeletions = 0, lateMonitorDeletions = 0;
let pageIndexReady = false, pageUploads = 0, pageQueries = 0;
let nangoSessionTags: Record<string, string> | null = null, nangoProviderReads = 0, nangoBadRecord = false;
let nangoConnectionState: "healthy" | "missing" | "auth_error" = "healthy", nangoWrongIdentity = false, nangoConnectionReads = 0;
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === "/connect/sessions" || request.url?.startsWith("/records?") || request.url?.startsWith("/connections/")) {
      assert.equal(request.headers.authorization, "Bearer nango-disposable-fixture");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === "/connect/sessions") {
        const body = z.object({ allowed_integrations: z.array(z.literal("fixture-crm")), tags: z.record(z.string()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
        nangoSessionTags = body.tags; send({ data: { token: "short-lived-disposable-connect-token", expires_at: new Date(Date.now() + 1_800_000).toISOString() } }); return;
      }
      if (request.url?.startsWith("/connections/")) {
        const url = new URL(`http://127.0.0.1${request.url}`); assert.equal(url.pathname, "/connections/nango_connection_fixture"); assert.equal(url.searchParams.get("provider_config_key"), "fixture-crm");
        assert.equal(url.searchParams.get("refresh_token"), "false"); nangoConnectionReads++;
        if (nangoConnectionState === "missing") { response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":{"code":"unknown_connection"}}'); return; }
        send({ connection_id: "nango_connection_fixture", provider_config_key: "fixture-crm", tags: { ...nangoSessionTags, ...(nangoWrongIdentity ? { organization_id: otherTenant } : {}) }, errors: nangoConnectionState === "auth_error" ? [{ type: "auth" }] : [], credentials: { access_token: "PRIVATE_UPSTREAM_CREDENTIAL_MUST_NEVER_PERSIST" } }); return;
      }
      assert.equal(request.headers["connection-id"], "nango_connection_fixture"); assert.equal(request.headers["provider-config-key"], "fixture-crm");
      const query = new URL(`http://127.0.0.1${request.url}`).searchParams; assert.equal(query.get("model"), "Account"); nangoProviderReads++;
      const cursor = query.get("cursor"), at = "2026-10-25T00:00:00Z";
      const record = (id: string, name: string, token: string, action: "ADDED" | "UPDATED" | "DELETED", pruned = false) => ({ id, name, _nango_metadata: { cursor: token, first_seen_at: at, last_modified_at: at, last_action: action, deleted_at: action === "DELETED" ? at : null, pruned_at: pruned ? at : null } });
      if (nangoBadRecord) { send({ records: [record("x".repeat(1025), "must-rollback", "cursor5", "ADDED")], next_cursor: null }); return; }
      if (cursor === null) send({ records: [record("company1", "Alpha", "cursor1", "ADDED")], next_cursor: "cursor1" });
      else if (cursor === "cursor1") send({ records: [], next_cursor: "cursor2" });
      else if (cursor === "cursor2") send({ records: [record("company1", "Alpha revised", "cursor3", "UPDATED"), record("company2", "Deleted", "cursor3b", "DELETED"), record("company3", "Pruned", "cursor4", "UPDATED", true)], next_cursor: null });
      else if (cursor === "cursor4") send({ records: [], next_cursor: null });
      else throw new Error("UNEXPECTED_NANGO_CURSOR");
      return;
    }
    if (request.url?.startsWith("/doc/") || request.url === "/chat/completions") {
      assert.equal(request.headers.api_key, "pageindex-disposable-fixture");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      if (request.url === "/doc/" && request.method === "POST") {
        const form = await new Request("http://127.0.0.1/doc/", { method: "POST", headers, body: Buffer.concat(chunks) }).formData();
        const file = form.get("file"); assert(file && typeof file !== "string"); assert.equal(createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex"), pageSource.sha256);
        assert.equal(form.get("metadata"), null); pageUploads++; send({ doc_id: "pageindex_fixture" }); return;
      }
      if (request.url?.startsWith("/doc/pageindex_fixture/")) { send({ doc_id: "pageindex_fixture", status: pageIndexReady ? "completed" : "processing", ...(pageIndexReady ? { result: [{ node_id: "0001", title: "Synthetic revenue", page_index: 1, text: "Synthetic revenue 42", nodes: [] }] } : {}) }); return; }
      if (request.url === "/chat/completions" && request.method === "POST") {
        const body = z.object({ doc_id: z.literal("pageindex_fixture"), messages: z.array(z.object({ role: z.literal("user"), content: z.string() })).length(1), enable_citations: z.literal(true), stream: z.literal(false) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
        pageQueries++;
        if (body.messages[0]!.content === "lose-chat-acknowledgement") { request.socket.destroy(); return; }
        if (body.messages[0]!.content === "identityless-citation") { send({ id: "chat_identityless_fixture", choices: [{ message: { role: "assistant", content: "Synthetic revenue 42" }, finish_reason: "end_turn" }], citations: [{ page: 1 }] }); return; }
        if (body.messages[0]!.content === "truncated-chat") { send({ id: "chat_truncated_fixture", choices: [{ message: { role: "assistant", content: "Synthetic partial" }, finish_reason: "length" }], citations: [{ doc_id: "pageindex_fixture", page: 1 }] }); return; }
        send({ id: "chat_fixture", choices: [{ message: { role: "assistant", content: "Synthetic revenue 42 <doc=source.pdf;page=1>" }, finish_reason: "end_turn" }],
          citations: [{ doc_id: body.messages[0]!.content === "foreign-citation" ? "foreign_document" : "pageindex_fixture", node_id: "0001", page: 1 }] }); return;
      }
      response.writeHead(404); response.end("{}"); return;
    }
    if (request.url?.startsWith("/v1/") || request.url?.startsWith("/v1beta/")) {
      assert.equal(request.headers["x-api-key"], "disposable-protocol-fixture");
      const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (request.method === "POST") {
        providerSubmissions.push({ path: request.url, input: body });
        if (request.url === "/v1/tasks/runs") {
          if (z.object({ input: z.string() }).parse(body).input === "lost-ack") { request.socket.destroy(); return; }
          send({ run_id: "task_fixture", status: "running", is_active: true }); return;
        }
        if (request.url === "/v1beta/findall/runs") { send({ findall_id: "find_fixture", status: { status: "completed", is_active: false } }); return; }
        if (request.url === "/v1/monitors") {
          const monitor = z.object({ settings: z.object({ query: z.string() }), metadata: z.object({ external_id: z.string().uuid() }) }).parse(body);
          if (monitor.settings.query === "revoke-after-remote-acceptance") {
            await admin.query("UPDATE finnor_os.role_authority_grants SET effect='deny' WHERE tenant_id=$1 AND capability='capability:*'", [pageTenant]);
            send({ monitor_id: "monitor_revoked_fixture", status: "active", frequency: "1d" }); return;
          }
          if (monitor.settings.query === "lose-lease-after-remote-acceptance") {
            await admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT job_id FROM finnor_os.capability_runs WHERE id=$1)", [monitor.metadata.external_id]);
            send({ monitor_id: "monitor_late_fixture", status: "active", frequency: "1d" }); return;
          }
          send({ monitor_id: "monitor_fixture", status: "active", frequency: "1d" }); return;
        }
      }
      if (request.url === "/v1/tasks/runs/task_fixture") { send({ run_id: "task_fixture", status: taskReady ? "completed" : "running", is_active: !taskReady }); return; }
      if (request.url === "/v1/tasks/runs/task_fixture/result?timeout=5") { send({ run: { run_id: "task_fixture", status: "completed" }, output: { type: "json", content: { revenue: 42 }, basis: [{ field: "revenue", citations: [{ url: "https://evidence.example.invalid/filing", title: "Synthetic filing", excerpts: ["Synthetic revenue 42"] }] }] } }); return; }
      if (request.url === "/v1beta/findall/runs/find_fixture") { send({ findall_id: "find_fixture", status: { status: "completed", is_active: false } }); return; }
      if (request.url === "/v1beta/findall/runs/find_fixture/result") { send({ run: { findall_id: "find_fixture", status: { status: "completed", is_active: false } }, candidates: [{ candidate_id: "candidate_fixture", name: "Synthetic Company", url: "example.invalid", match_status: "matched", basis: null }], last_event_id: "last_fixture" }); return; }
      if (request.url === "/v1/monitors/monitor_fixture/cancel" && request.method === "POST") { monitorDeletions++; send({ monitor_id: "monitor_fixture", status: "cancelled", frequency: "1d" }); return; }
      if (request.url === "/v1/monitors/monitor_revoked_fixture/cancel" && request.method === "POST") { revokedMonitorDeletions++; send({ monitor_id: "monitor_revoked_fixture", status: "cancelled", frequency: "1d" }); return; }
      if (request.url === "/v1/monitors/monitor_late_fixture/cancel" && request.method === "POST") { lateMonitorDeletions++; send({ monitor_id: "monitor_late_fixture", status: "cancelled", frequency: "1d" }); return; }
      if (request.url === "/v1/monitors/monitor_fixture") { send({ monitor_id: "monitor_fixture", status: monitorDeletions ? "cancelled" : "active", frequency: "1d" }); return; }
      if (request.url === "/v1/monitors/monitor_fixture/events?event_group_id=group_fixture") { send({ events: [{ event_type: "event_stream", event_id: "event_fixture", event_group_id: "group_fixture", event_date: "2026-10-26", output: { type: "json", content: { change: "synthetic" }, basis: [] } }] }); return; }
      if (request.url === "/v1/monitors/monitor_fixture/events?include_completions=true&limit=10") { send({ events: [{ event_type: "completion", timestamp: "2026-10-26T00:00:00Z" }, { event_type: "error", timestamp: "2026-10-26T00:01:00Z", error_message: "Synthetic provider execution error" }], next_cursor: null }); return; }
      send({ error: "FIXTURE_ROUTE_NOT_FOUND" }, 404); return;
    }
    const url = `http://127.0.0.1${request.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const req = new Request(url, { method: request.method, headers, ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
    const match = /^\/api\/capabilities\/runs\/([^/?]+)$/.exec(request.url ?? "");
    const result = request.method === "POST" && request.url === "/api/capabilities/nango/connect" ? await nangoConnectRoute.POST(req)
      : request.method === "POST" && request.url === "/api/capabilities/planner/activation" ? await plannerActivationRoute.POST(req)
      : request.method === "GET" && request.url === "/api/capabilities/planner/activation" ? await plannerActivationRoute.GET(req)
      : request.method === "GET" && request.url === "/api/capabilities/nango/sources" ? await nangoSourcesRoute.GET(req)
      : request.method === "POST" && request.url === "/api/webhooks/nango" ? await nangoWebhookRoute.POST(req)
      : request.method === "POST" && request.url === "/api/capabilities/runs" ? await createRoute.POST(req)
      : request.method === "GET" && new URL(url).pathname === "/api/capabilities/runs" ? await createRoute.GET(req)
      : request.method === "GET" && match ? await readRoute.GET(req, { params: Promise.resolve({ id: match[1]! }) }) : new Response(null, { status: 404 });
    response.writeHead(result.status, Object.fromEntries(result.headers.entries())); response.end(Buffer.from(await result.arrayBuffer()));
  } catch { response.writeHead(500); response.end("{}"); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}/api/capabilities/runs`;
process.env.FINNOR_PARALLEL_ENABLED = "1";
process.env.FINNOR_PARALLEL_MONITORS_ENABLED = "1";
process.env.PARALLEL_API_KEY = "disposable-protocol-fixture";
process.env.FINNOR_PARALLEL_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.FINNOR_PARALLEL_MAX_RUNS_PER_TENANT_DAY = "100";
process.env.FINNOR_NANGO_ENABLED = "1";
process.env.NANGO_API_KEY = "nango-disposable-fixture";
process.env.FINNOR_NANGO_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.NANGO_WEBHOOK_SIGNING_KEY = "nango-distinct-disposable-webhook-key";
process.env.FINNOR_NANGO_PROVIDER_CATALOG = JSON.stringify([{ providerConfigKey: "fixture-crm", models: ["Account"], readOnly: true }]);
process.env.FINNOR_PAGEINDEX_ENABLED = "1";
process.env.PAGEINDEX_API_KEY = "pageindex-disposable-fixture";
process.env.FINNOR_PAGEINDEX_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.FINNOR_PAGEINDEX_MAX_RUNS_PER_TENANT_DAY = "100";
const headers = (t = tenant, p = principal) => ({ "content-type": "application/json", "x-tenant-id": t, "x-user-id": p, "x-user-role": "owner" });
const request = { kind: "duckdb_query", idempotencyKey: "concentration", timeoutMs: 60_000, datasets: [{ documentId: source.documentId, versionId: source.versionId, name: "sales", format: "csv" }],
  query: "SELECT customer,revenue,revenue/sum(revenue) OVER() AS share FROM sales ORDER BY customer", maxRows: 10 };
const acceptedSchema = z.object({ replayed: z.boolean(), run: z.object({ id: z.string().uuid(), status: z.string() }).passthrough() });
const runSchema = z.object({ run: z.object({ id: z.string().uuid(), status: z.string(), failureCode: z.string().nullable(), result: z.record(z.unknown()).nullable() }).passthrough() });
async function post(body: unknown, h = headers()) { return fetch(base, { method: "POST", headers: h, body: JSON.stringify(body) }); }
async function read(id: string, h = headers()) { return fetch(`${base}/${id}`, { headers: h }); }
async function grant(effect: "allow" | "deny") { await admin.query("UPDATE finnor_os.role_authority_grants SET effect=$2 WHERE tenant_id=$1 AND capability='capability:*'", [tenant, effect]); }
async function until<T>(fn: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const found = await fn(); if (found !== null) return found; await new Promise(done => setTimeout(done, 10)); }
  throw new Error("FIXTURE_OBSERVATION_TIMEOUT");
}
let runId: string | undefined;
let monitorRunId: string | undefined;
let indexRunId: string | undefined;
let gepaRunId: string | undefined;
let nangoSource: { integrationId: string; sourceScopeId: string; model: string } | undefined, nangoRunId: string | undefined;
let nangoAuthPayload: Record<string, unknown> | undefined;
const apiOrigin = `http://127.0.0.1:${address.port}`;
async function webhook(payload: unknown, validSignature = true) {
  const raw = JSON.stringify(payload), signature = createHmac("sha256", "nango-distinct-disposable-webhook-key").update(raw).digest("hex");
  return fetch(`${apiOrigin}/api/webhooks/nango`, { method: "POST", headers: { "content-type": "application/json", "x-nango-hmac-sha256": validSignature ? signature : "0".repeat(64) }, body: raw });
}
async function wakeNango(label: string) {
  const payload = { type: "sync", success: true, providerConfigKey: "fixture-crm", connectionId: "nango_connection_fixture", model: "Account", syncName: "accounts", modifiedAfter: label,
    records: [{ forgedCanonicalTruth: true, tenantId: otherTenant }] };
  const response = await webhook(payload); assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const row = (await admin.query("SELECT id FROM finnor_os.capability_runs WHERE tenant_id=$1 AND idempotency_key=$2", [nangoTenant, `nango-webhook:${digest}`])).rows[0]; assert(row); return { id: String(row.id), payload };
}
async function freshWorkerTick() { const worker = new JobQueue(`fresh:${randomUUID()}`, 30, "HEAVY"); worker.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1); return worker.tick(); }
try {
  await check("canonical-app-worker-queue-role-isolation", async () => {
    const app = new pg.Client({ connectionString: database.appUrl }); await app.connect();
    try {
      const roles = (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('finnor_app','finnor_worker') ORDER BY rolname")).rows;
      assert(roles.every(role => !role.rolsuper && !role.rolbypassrls));
      assert.equal((await app.query("SELECT count(*)::int n FROM finnor_os.compute_tenant_claim_state")).rows[0].n, 0);
      assert.equal((await app.query("SELECT pg_has_role('finnor_app','finnor_worker','MEMBER') AS member")).rows[0].member, false);
      assert.equal((await db.getPool().query("SELECT current_user AS role")).rows[0].role, 'finnor_worker');
      return { roles, appInheritsWorker: false, unscopedAppQueueRows: 0, harnessRole: 'finnor_worker', productionRlsChanged: false };
    } finally { await app.end(); }
  });
  await check("normal-owner-bootstrap-without-fixture-capability-grants", async () => {
    const grants = (await admin.query("SELECT r.key,g.capability FROM finnor_os.employee_roles r JOIN finnor_os.role_authority_grants g ON g.role_id=r.id WHERE r.tenant_id=$1 AND g.capability='capability:*'", [tenant])).rows;
    assert.deepEqual(grants, [{ key: "owner", capability: "capability:*" }]); return { grants, explicitFixtureGrants: false };
  });
  await check("unauthenticated-http-refused", async () => { const response = await post(request, { "content-type": "application/json" }); assert.equal(response.status, 401); return { status: response.status }; });
  await check("accepted-http-to-canonical-heavy-job", async () => {
    const response = await post(request), raw = await response.json();
    assert.equal(response.status, 202, JSON.stringify(raw)); const value = acceptedSchema.parse(raw); runId = value.run.id;
    const jobs = (await admin.query("SELECT type,status,workload_class,tenant_id FROM finnor_os.jobs WHERE payload->>'runId'=$1", [runId])).rows;
    assert.equal(jobs.length, 1); assert.equal(jobs[0].type, "run_capability_provider_v1"); assert.equal(jobs[0].workload_class, "HEAVY"); assert.equal(jobs[0].tenant_id, tenant);
    return { response: value, jobs };
  });
  await check("duplicate-http-converges-on-one-job", async () => {
    assert(runId); const response = await post(request), value = acceptedSchema.parse(await response.json());
    assert.equal(response.status, 200); assert.equal(value.run.id, runId); assert.equal(value.replayed, true);
    const count = (await admin.query("SELECT count(*)::int count FROM finnor_os.jobs WHERE payload->>'runId'=$1", [runId])).rows[0].count;
    assert.equal(count, 1); return { response: value, jobCount: count };
  });
  await check("real-queue-worker-child-and-authorized-read", async () => {
    assert(runId); assert.equal(await queue.tick(), true);
    const response = await read(runId), value = runSchema.parse(await response.json());
    assert.equal(response.status, 200); assert.equal(value.run.status, "SUCCEEDED", JSON.stringify(value));
    assert.deepEqual(value.run.result?.rows, [["a", 40, 0.4], ["b", 60, 0.6]]);
    const physical = (await admin.query("SELECT j.status,j.claim_fence,r.result_digest FROM finnor_os.capability_runs r JOIN finnor_os.jobs j ON j.id=r.job_id WHERE r.id=$1", [runId])).rows;
    assert.equal(physical[0].status, "completed"); assert(physical[0].claim_fence >= 1);
    return { response: value, physical };
  });
  await check("cross-tenant-result-read-refused", async () => { assert(runId); const response = await read(runId, headers(otherTenant, otherPrincipal)); assert.equal(response.status, 404); return { status: response.status }; });
  await check("cross-tenant-source-submission-refused", async () => { const response = await post({ ...request, idempotencyKey: "foreign-source" }, headers(otherTenant, otherPrincipal)); assert.equal(response.status, 404); return { status: response.status, body: await response.json() }; });
  await check("idempotency-content-conflict-refused", async () => { const response = await post({ ...request, query: "SELECT 1" }); assert.equal(response.status, 409); return { status: response.status, body: await response.json() }; });
  await check("revocation-removes-stored-content-access", async () => {
    assert(runId); await grant("deny");
    try { const response = await read(runId); assert.equal(response.status, 403); return { status: response.status, body: await response.json() }; }
    finally { await grant("allow"); }
  });
  await check("grant-revocation-before-publication-fences-result", async () => {
    const response = await post({ ...request, idempotencyKey: "publication-race", query: "SELECT sum(i) FROM range(100000000) t(i)" });
    assert.equal(response.status, 202); const accepted = acceptedSchema.parse(await response.json());
    const baseline = Number((await admin.query("SELECT count(*) count FROM finnor_os.authority_decisions WHERE tenant_id=$1 AND capability='capability:duckdb_query'", [tenant])).rows[0].count);
    const executing = queue.tick();
    const row = await until(async () => { const r = (await admin.query("SELECT job_id,status FROM finnor_os.capability_runs WHERE id=$1", [accepted.run.id])).rows[0]; return r.status === "RUNNING" ? r : null; });
    const lock = new pg.Client({ connectionString: `postgres://finnor:finnor@127.0.0.1:${database.port}/finnor` }); await lock.connect();
    try {
      await lock.query("BEGIN"); await lock.query("SELECT id FROM finnor_os.jobs WHERE id=$1 FOR UPDATE", [row.job_id]);
      await until(async () => { const n = Number((await admin.query("SELECT count(*) count FROM finnor_os.authority_decisions WHERE tenant_id=$1 AND capability='capability:duckdb_query'", [tenant])).rows[0].count); return n >= baseline + 2 ? n : null; });
      await grant("deny"); await lock.query("COMMIT"); await executing;
      const final = (await admin.query("SELECT status,result,failure_code FROM finnor_os.capability_runs WHERE id=$1", [accepted.run.id])).rows[0];
      assert.equal(final.status, "FAILED"); assert.equal(final.result, null); assert.equal(final.failure_code, "CAPABILITY_AUTHORITY_REVOKED_OR_CHANGED");
      return { runId: accepted.run.id, observed: final, boundary: "real job row lock between final authorization and publication" };
    } finally { await lock.query("ROLLBACK").catch(() => undefined); await lock.end(); await grant("allow"); await executing.catch(() => undefined); }
  });
  await check("accepted-deadline-survives-queue-delay", async () => {
    const response = await post({ ...request, idempotencyKey: "expired", timeoutMs: 100 }); assert.equal(response.status, 202);
    const value = acceptedSchema.parse(await response.json()); await new Promise(done => setTimeout(done, 150)); await queue.tick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "FAILED"); assert.equal(observed.run.failureCode, "CAPABILITY_DEADLINE_EXCEEDED");
    return observed;
  });
  await check("accepted-deadline-survives-publication-lock", async () => {
    const response = await post({ ...request, idempotencyKey: "publication-deadline", timeoutMs: 10_000, query: "SELECT sum(i) FROM range(10000000) t(i)" });
    assert.equal(response.status, 202); const accepted = acceptedSchema.parse(await response.json());
    const baseline = Number((await admin.query("SELECT count(*) count FROM finnor_os.authority_decisions WHERE tenant_id=$1 AND capability='capability:duckdb_query'", [tenant])).rows[0].count);
    const executing = queue.tick();
    const row = await until(async () => { const r = (await admin.query("SELECT job_id,status,deadline_at FROM finnor_os.capability_runs WHERE id=$1", [accepted.run.id])).rows[0]; return r.status === "RUNNING" ? r : null; });
    const lock = new pg.Client({ connectionString: `postgres://finnor:finnor@127.0.0.1:${database.port}/finnor` }); await lock.connect();
    try {
      await lock.query("BEGIN"); await lock.query("SELECT id FROM finnor_os.jobs WHERE id=$1 FOR UPDATE", [row.job_id]);
      await until(async () => { const n = Number((await admin.query("SELECT count(*) count FROM finnor_os.authority_decisions WHERE tenant_id=$1 AND capability='capability:duckdb_query'", [tenant])).rows[0].count); return n >= baseline + 2 ? n : null; });
      await new Promise(done => setTimeout(done, Math.max(0, new Date(row.deadline_at).getTime() - Date.now() + 100)));
      await lock.query("COMMIT"); await executing;
      const final = (await admin.query("SELECT status,result,failure_code FROM finnor_os.capability_runs WHERE id=$1", [accepted.run.id])).rows[0];
      assert.equal(final.status, "FAILED"); assert.equal(final.result, null); assert.equal(final.failure_code, "CAPABILITY_DEADLINE_EXCEEDED");
      return { runId: accepted.run.id, observed: final, boundary: "job row locked until after accepted deadline" };
    } finally { await lock.query("ROLLBACK").catch(() => undefined); await lock.end(); await executing.catch(() => undefined); }
  });
  await check("parallel-task-durable-continuation-preserves-citations", async () => {
    const response = await post({ kind: "parallel_task", idempotencyKey: "parallel-task", input: "synthetic-research", outputSchema: { type: "object", properties: { revenue: { type: "number" } }, required: ["revenue"] }, processor: "lite", timeoutMs: 60_000 });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await queue.tick();
    const waiting = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(waiting.run.status, "WAITING_PROVIDER");
    const jobs = (await admin.query("SELECT j.id,j.status,j.run_at,r.deadline_at FROM finnor_os.jobs j JOIN finnor_os.capability_runs r ON r.id=$1::uuid WHERE j.payload->>'runId'=$1::text ORDER BY j.accepted_at,j.id", [value.run.id])).rows;
    assert.equal(jobs.length, 2); assert.equal(jobs[0].status, "completed"); assert(new Date(jobs[1].run_at) <= new Date(jobs[1].deadline_at));
    // Accelerate only the fixture's due time; the accepted deadline is unchanged.
    taskReady = true; await admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=$1", [jobs[1].id]);
    const replacement = new JobQueue(`replacement:${randomUUID()}`, 30, "HEAVY"); replacement.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1); await replacement.tick();
    const completed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(completed.run.status, "SUCCEEDED", JSON.stringify(completed));
    assert.equal(providerSubmissions.filter(p => p.path === "/v1/tasks/runs").length, 1);
    const result = z.object({ research: z.object({ output: z.object({ content: z.object({ revenue: z.number() }), basis: z.array(z.object({ citations: z.array(z.object({ url: z.string() })) })) }) }) }).parse(completed.run.result);
    assert.equal(result.research.output.content.revenue, 42); assert.equal(result.research.output.basis[0]?.citations[0]?.url, "https://evidence.example.invalid/filing");
    return { runId: value.run.id, waitingStatus: waiting.run.status, finalStatus: completed.run.status, physicalJobs: jobs, result, providerCreates: 1, workerReplacement: "NEW_QUEUE_INSTANCE_SAME_PROCESS_NOT_CRASH_PROOF" };
  });
  await check("parallel-lost-acknowledgement-remains-unknown-without-resubmit", async () => {
    const body = { kind: "parallel_task", idempotencyKey: "parallel-unknown", input: "lost-ack", outputSchema: { type: "object" }, processor: "lite", timeoutMs: 60_000 };
    const response = await post(body); assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await queue.tick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "UNKNOWN"); assert.equal(observed.run.result, null);
    const replay = await post(body); assert.equal(replay.status, 200); await queue.tick();
    assert.equal(providerSubmissions.filter(p => p.path === "/v1/tasks/runs").length, 2);
    return { runId: value.run.id, observed, physicalFault: "provider socket destroyed after accepting POST", unknownSubmissions: 1 };
  });
  await check("parallel-findall-retains-provider-candidates-without-exhaustiveness", async () => {
    const invalid = await post({ kind: "parallel_find", idempotencyKey: "parallel-invalid-limit", objective: "Invalid fixture only", entityType: "companies", matchConditions: [{ name: "synthetic", description: "Synthetic fixture only" }], matchLimit: 1 }); assert.equal(invalid.status, 400);
    const response = await post({ kind: "parallel_find", idempotencyKey: "parallel-find", objective: "Find synthetic company", entityType: "companies", matchConditions: [{ name: "synthetic", description: "Synthetic fixture only" }], matchLimit: 5 });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); const worker = new JobQueue(`find:${randomUUID()}`, 30, "HEAVY"); worker.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1); await worker.tick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "SUCCEEDED"); assert.equal(observed.run.result?.exhaustivenessEstablished, false); return observed;
  });
  await check("parallel-monitor-persisted-identity", async () => {
    const response = await post({ kind: "parallel_monitor", idempotencyKey: "parallel-monitor", query: "Synthetic fixture query", cadence: "daily" });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); const worker = new JobQueue(`monitor:${randomUUID()}`, 30, "HEAVY"); worker.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1); await worker.tick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "SUCCEEDED"); assert.equal(observed.run.result?.remoteId, "monitor_fixture"); monitorRunId = value.run.id; return observed;
  });
  await check("parallel-foreign-monitor-control-refused", async () => {
    assert(monitorRunId); const response = await post({ kind: "parallel_monitor_control", idempotencyKey: "foreign-monitor", monitorRunId, operation: "cancel" }, headers(otherTenant, otherPrincipal));
    assert.equal(response.status, 404); assert.equal(monitorDeletions, 0); return { status: response.status, monitorDeletions };
  });
  await check("parallel-monitor-events-through-canonical-job", async () => {
    assert(monitorRunId); const response = await post({ kind: "parallel_monitor_control", idempotencyKey: "monitor-events", monitorRunId, operation: "events", eventGroupId: "group_fixture" });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "SUCCEEDED");
    const result = z.object({ observed: z.object({ events: z.array(z.object({ event_group_id: z.string() })) }) }).parse(observed.run.result); assert.equal(result.observed.events[0]?.event_group_id, "group_fixture"); return observed;
  });
  await check("parallel-monitor-events-discover-completions-without-external-group", async () => {
    assert(monitorRunId); const response = await post({ kind: "parallel_monitor_control", idempotencyKey: "monitor-events-discovery", monitorRunId, operation: "events" });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "SUCCEEDED");
    const result = z.object({ observed: z.object({ events: z.array(z.object({ event_type: z.string() })) }) }).parse(observed.run.result);
    assert.deepEqual(result.observed.events.map(event => event.event_type), ["completion", "error"]); return observed;
  });
  await check("parallel-monitor-cancellation-is-durable-and-idempotent", async () => {
    assert(monitorRunId); const body = { kind: "parallel_monitor_control", idempotencyKey: "monitor-cancel", monitorRunId, operation: "cancel" };
    const response = await post(body); assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "SUCCEEDED"); assert.equal(monitorDeletions, 1);
    assert.equal((await post(body)).status, 200); assert.equal(await freshWorkerTick(), false); assert.equal(monitorDeletions, 1); return { observed, monitorDeletions };
  });
  await check("parallel-server-submission-budget-refuses-before-provider", async () => {
    process.env.FINNOR_PARALLEL_MAX_RUNS_PER_TENANT_DAY = String(providerSubmissions.filter(submission => ["/v1/tasks/runs", "/v1beta/findall/runs", "/v1/monitors"].includes(submission.path)).length);
    const count = providerSubmissions.length, response = await post({ kind: "parallel_task", idempotencyKey: "parallel-over-budget", input: "must-not-dispatch", outputSchema: { type: "object" } });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); const worker = new JobQueue(`budget:${randomUUID()}`, 30, "HEAVY"); worker.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1); await worker.tick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "FAILED"); assert.equal(observed.run.failureCode, "PROVIDER_DAILY_SUBMISSION_LIMIT"); assert.equal(providerSubmissions.length, count); return { observed, providerSubmissions: count, limitKind: "SUBMISSION_COUNT_NOT_INVOICE_GUARANTEE" };
  });
  await check("pywhy-native-source-to-canonical-worker-and-result", async () => {
    const response = await post({ kind: "pywhy_assess", idempotencyKey: "native-causal", timeoutMs: 120_000, dataset: { documentId: causalSource.documentId, versionId: causalSource.versionId, name: "synthetic", format: "csv" }, treatment: "t", outcome: "y", commonCauses: ["x", "z"], effectModifiers: ["x"], estimator: "double_ml", assumptions: [{ statement: "Known synthetic generator uses only measured x and independent assignment noise", evidenceRef: "causal-input.csv; generatorSeed117" }], seed: 11 });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed));
    const causal = z.object({ estimation: z.object({ averageEffect: z.number() }), causalClaimEstablished: z.literal(false), admission: z.object({ status: z.literal("BLOCKED_EXTERNAL") }) }).parse(observed.run.result);
    assert(Math.abs(causal.estimation.averageEffect - 2) < 0.4); return { runId: value.run.id, observed: causal, expectedSyntheticEffect: 2, causalSource };
  });
  await check("postgres-jsonb-size-overhead-refused-without-retry", async () => {
    const fields = Array.from({ length: 90 }, (_, index) => `a${index}:=0`).join(","), response = await post({ ...request, idempotencyKey: "jsonb-overhead", maxRows: 10_000, query: `SELECT struct_pack(${fields}) AS wide FROM range(10000)` });
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id)).json()); assert.equal(observed.run.status, "FAILED"); assert.equal(observed.run.failureCode, "CAPABILITY_RESULT_TOO_LARGE");
    const job = (await admin.query("SELECT status,attempts FROM finnor_os.jobs WHERE payload->>'runId'=$1", [value.run.id])).rows[0]; assert.equal(job.status, "completed"); assert.equal(job.attempts, 1); return { observed, job };
  });
  await check("unknown-executor-kind-refused-before-enqueue", async () => {
    const beforeCount = (await admin.query("SELECT count(*)::int count FROM finnor_os.capability_runs")).rows[0].count;
    const response = await post({ kind: "unknown_executor", idempotencyKey: "not-implemented" });
    assert.equal(response.status, 400); const body = await response.json(); assert.equal(body.code, "CAPABILITY_INVALID_REQUEST");
    assert.equal((await admin.query("SELECT count(*)::int count FROM finnor_os.capability_runs")).rows[0].count, beforeCount); return { status: response.status, body, enqueued: false };
  });
  await check("pageindex-immutable-upload-and-durable-index-continuation", async () => {
    const response = await post({ kind: "pageindex_index", idempotencyKey: "pageindex-source", source: { documentId: pageSource.documentId, versionId: pageSource.versionId } }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); indexRunId = value.run.id; await freshWorkerTick();
    assert.equal(runSchema.parse(await (await read(indexRunId, headers(pageTenant, pagePrincipal))).json()).run.status, "WAITING_PROVIDER");
    pageIndexReady = true; await admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=(SELECT job_id FROM finnor_os.capability_runs WHERE id=$1)", [indexRunId]); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(indexRunId, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed)); assert.equal(pageUploads, 1);
    return { runId: indexRunId, source: pageSource, providerUploads: pageUploads, observed };
  });
  await check("pageindex-cross-tenant-index-reference-refused", async () => {
    assert(indexRunId); const response = await post({ kind: "pageindex_retrieve", idempotencyKey: "foreign-index", indexRunIds: [indexRunId], question: "What is revenue?" }, headers(otherTenant, otherPrincipal));
    assert.equal(response.status, 404); assert.equal(pageQueries, 0); return { status: response.status, providerQueries: pageQueries };
  });
  await check("pageindex-source-permission-enforced-before-query", async () => {
    assert(indexRunId);
    await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk) SELECT $1,id,'capability:pageindex_retrieve','document','deny','high' FROM finnor_os.employee_roles WHERE tenant_id=$1 AND key='owner'", [pageTenant]);
    try {
      const response = await post({ kind: "pageindex_retrieve", idempotencyKey: "denied-source", indexRunIds: [indexRunId], question: "What is revenue?" }, headers(pageTenant, pagePrincipal));
      assert.equal(response.status, 403); assert.equal(pageQueries, 0); return { status: response.status, providerQueries: pageQueries, deniedResourceType: "document" };
    } finally { await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND capability='capability:pageindex_retrieve'", [pageTenant]); }
  });
  await check("pageindex-retrieval-citations-bound-to-authorized-version", async () => {
    assert(indexRunId); const response = await post({ kind: "pageindex_retrieve", idempotencyKey: "allowed-source", indexRunIds: [indexRunId], question: "What is revenue?" }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed));
    const citations = z.object({ results: z.array(z.object({ anchors: z.array(z.object({ pageStart: z.number(), source: z.object({ documentId: z.string(), versionId: z.string(), sha256: z.string() }).passthrough() })) })) }).parse(observed.run.result);
    assert.equal(citations.results[0]?.anchors[0]?.pageStart, 1); assert.deepEqual(citations.results[0]?.anchors[0]?.source, { ...pageSource, mediaType: "application/pdf", sizeBytes: pdf.length }); assert.equal(pageQueries, 1);
    return { runId: value.run.id, observed, providerQueries: pageQueries };
  });
  await check("pageindex-chat-rejects-foreign-document-citation", async () => {
    assert(indexRunId); const response = await post({ kind: "pageindex_retrieve", idempotencyKey: "foreign-chat-citation", indexRunIds: [indexRunId], question: "foreign-citation" }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json());
    assert.equal(observed.run.status, "UNKNOWN"); assert.equal(observed.run.result, null); assert(observed.run.failureCode?.includes("PAGEINDEX_CITATION_DOCUMENT_MISMATCH"));
    return { runId: value.run.id, status: observed.run.status, resultPublished: false };
  });
  await check("pageindex-lost-chat-acknowledgement-never-resubmits", async () => {
    assert(indexRunId); const count = pageQueries;
    const body = { kind: "pageindex_retrieve", idempotencyKey: "lost-chat-ack", indexRunIds: [indexRunId], question: "lose-chat-acknowledgement" };
    const response = await post(body, headers(pageTenant, pagePrincipal)); assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "UNKNOWN"); assert.equal(observed.run.result, null);
    assert.equal((await post(body, headers(pageTenant, pagePrincipal))).status, 200); await freshWorkerTick(); assert.equal(pageQueries - count, 1);
    return { runId: value.run.id, physicalChatCreates: 1, status: observed.run.status, resultPublished: false };
  });
  await check("pageindex-identityless-citation-cannot-acquire-source-authority", async () => {
    assert(indexRunId); const response = await post({ kind: "pageindex_retrieve", idempotencyKey: "identityless-chat", indexRunIds: [indexRunId], question: "identityless-citation" }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED");
    const result = z.object({ results: z.array(z.object({ anchors: z.array(z.unknown()), warnings: z.array(z.object({ code: z.string() })) })) }).parse(observed.run.result);
    assert.equal(result.results[0]?.anchors.length, 0); assert.equal(result.results[0]?.warnings[0]?.code, "NO_VALID_PAGE_LOCATIONS_RETURNED"); return { runId: value.run.id, positivelyBoundAnchors: 0, warning: "NO_VALID_PAGE_LOCATIONS_RETURNED" };
  });
  await check("pageindex-truncated-chat-refused-without-publication", async () => {
    assert(indexRunId); const response = await post({ kind: "pageindex_retrieve", idempotencyKey: "truncated-chat", indexRunIds: [indexRunId], question: "truncated-chat" }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "UNKNOWN"); assert.equal(observed.run.result, null); return { runId: value.run.id, resultPublished: false, status: observed.run.status };
  });
  await check("nango-connect-rejects-caller-supplied-connection-id", async () => {
    const response = await fetch(`${apiOrigin}/api/capabilities/nango/connect`, { method: "POST", headers: headers(nangoTenant, nangoPrincipal), body: JSON.stringify({ idempotencyKey: "forged-connection", providerConfigKey: "fixture-crm", connectionId: "foreign-private-connection" }) });
    assert.equal(response.status, 400); assert.equal(nangoSessionTags, null); return { status: response.status, providerSessionCreated: false };
  });
  await check("nango-session-tags-bind-prepared-tenant-intent", async () => {
    const response = await fetch(`${apiOrigin}/api/capabilities/nango/connect`, { method: "POST", headers: headers(nangoTenant, nangoPrincipal), body: JSON.stringify({ idempotencyKey: "nango-connect", providerConfigKey: "fixture-crm" }) });
    const raw = await response.json(); assert.equal(response.status, 201, JSON.stringify(raw));
    const value = z.object({ intentId: z.string().uuid(), session: z.object({ token: z.string() }) }).parse(raw), tags = z.record(z.string()).parse(nangoSessionTags);
    assert.equal(tags.organization_id, nangoTenant); assert.equal(tags.end_user_id, nangoPrincipal); assert.equal(tags.finnor_binding_intent, value.intentId);
    const persisted = (await admin.query("SELECT row_to_json(i) AS intent FROM finnor_os.capability_nango_intents i WHERE id=$1", [value.intentId])).rows[0].intent;
    assert(!JSON.stringify(persisted).includes(value.session.token));
    nangoAuthPayload = { type: "auth", operation: "creation", success: true, providerConfigKey: "fixture-crm", connectionId: "nango_connection_fixture", tags };
    return { intentId: value.intentId, tags, sessionCredentialStored: false };
  });
  await check("nango-unsigned-webhook-refused-before-binding", async () => {
    assert(nangoAuthPayload); const response = await webhook(nangoAuthPayload, false); assert.equal(response.status, 403);
    assert.equal((await admin.query("SELECT count(*)::int count FROM finnor_os.capability_nango_bindings")).rows[0].count, 0); return { status: response.status, sourceBindings: 0 };
  });
  await check("nango-signed-foreign-intent-tags-refused", async () => {
    assert(nangoAuthPayload); const tags = z.record(z.string()).parse(nangoAuthPayload.tags);
    const response = await webhook({ ...nangoAuthPayload, tags: { ...tags, organization_id: otherTenant } }); assert.equal(response.status, 404);
    assert.equal((await admin.query("SELECT count(*)::int count FROM finnor_os.capability_nango_bindings")).rows[0].count, 0); return { status: response.status, sourceBindings: 0 };
  });
  await check("nango-signed-creation-binds-once-and-owner-can-discover-source", async () => {
    assert(nangoAuthPayload); const response = await webhook(nangoAuthPayload); assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    assert.equal((await webhook(nangoAuthPayload)).status, 202);
    const catalog = await fetch(`${apiOrigin}/api/capabilities/nango/sources`, { headers: headers(nangoTenant, nangoPrincipal) }); assert.equal(catalog.status, 200);
    const sources = z.object({ sources: z.array(z.object({ integration_id: z.string().uuid(), source_scope_id: z.string().uuid(), model: z.string() })) }).parse(await catalog.json()); assert.equal(sources.sources.length, 1);
    nangoSource = { integrationId: sources.sources[0]!.integration_id, sourceScopeId: sources.sources[0]!.source_scope_id, model: sources.sources[0]!.model };
    assert.equal((await admin.query("SELECT count(*)::int count FROM finnor_os.capability_nango_bindings")).rows[0].count, 1); return { source: nangoSource, replayDidNotDuplicate: true };
  });
  await check("nango-cross-tenant-source-sync-refused", async () => {
    assert(nangoSource); const response = await post({ kind: "nango_sync", idempotencyKey: "foreign-nango", ...nangoSource }, headers(otherTenant, otherPrincipal));
    assert.equal(response.status, 404); assert.equal(nangoProviderReads, 0); return { status: response.status, providerReads: 0 };
  });
  await check("nango-signed-sync-only-wakes-fresh-deduplicated-native-job", async () => {
    const wake = await wakeNango("first"); nangoRunId = wake.id;
    assert.equal((await webhook(wake.payload)).status, 202);
    const jobs = (await admin.query("SELECT type,workload_class FROM finnor_os.jobs WHERE payload->>'runId'=$1", [wake.id])).rows;
    assert.equal(jobs.length, 1); assert.equal(jobs[0].type, "run_capability_provider_v1"); assert.equal(jobs[0].workload_class, "HEAVY"); assert.equal(nangoProviderReads, 0);
    return { runId: wake.id, jobs, webhookRecordPayloadApplied: false };
  });
  await check("nango-empty-page-with-next-cursor-does-not-end-sync", async () => {
    assert(nangoRunId && nangoSource); await freshWorkerTick();
    let observed = runSchema.parse(await (await read(nangoRunId, headers(nangoTenant, nangoPrincipal))).json()); assert.equal(observed.run.status, "WAITING_PROVIDER");
    await admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=(SELECT job_id FROM finnor_os.capability_runs WHERE id=$1)", [nangoRunId]); await freshWorkerTick();
    observed = runSchema.parse(await (await read(nangoRunId, headers(nangoTenant, nangoPrincipal))).json()); assert.equal(observed.run.status, "WAITING_PROVIDER");
    const checkpoint = (await admin.query("SELECT cursor,revision FROM finnor_os.capability_nango_checkpoints WHERE tenant_id=$1 AND source_scope_id=$2", [nangoTenant, nangoSource.sourceScopeId])).rows[0];
    assert.equal(checkpoint.cursor, "cursor2"); assert.equal(Number(checkpoint.revision), 2); return { observedStatus: observed.run.status, checkpoint, providerReads: nangoProviderReads };
  });
  await check("nango-updates-deletions-pruning-and-checkpoint-are-native-evidence", async () => {
    assert(nangoRunId && nangoSource); await admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=(SELECT job_id FROM finnor_os.capability_runs WHERE id=$1)", [nangoRunId]); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(nangoRunId, headers(nangoTenant, nangoPrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed));
    const result = z.object({ recordsObserved: z.literal(4), pagesObserved: z.literal(3), historyLimited: z.literal(true), pageEventIds: z.array(z.string()).length(3), checkpoint: z.object({ cursor: z.literal("cursor4") }) }).parse(observed.run.result);
    const observations = (await admin.query("SELECT external_id,source_version,provider_deleted,materialization_status,evidence_source_id,evidence_version_id,canonical_entity_id FROM finnor_os.external_ref_observations WHERE tenant_id=$1 AND source_scope_id=$2 ORDER BY source_version", [nangoTenant, nangoSource.sourceScopeId])).rows;
    assert.equal(observations.length, 4); assert.equal(observations.filter(o => o.external_id === "company1").length, 2); assert.equal(observations.find(o => o.external_id === "company2").provider_deleted, true); assert(observations.every(o => o.evidence_version_id && o.canonical_entity_id === null));
    const scope = (await admin.query("SELECT freshness_state FROM finnor_os.integration_source_scopes WHERE tenant_id=$1 AND id=$2", [nangoTenant, nangoSource.sourceScopeId])).rows[0]; assert.equal(scope.freshness_state, "unknown");
    return { runId: nangoRunId, result, observations, scope, canonicalTruthWritten: false };
  });
  await check("nango-incremental-empty-read-retains-terminal-cursor", async () => {
    assert(nangoSource); const wake = await wakeNango("second"); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(wake.id, headers(nangoTenant, nangoPrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED"); assert.equal(observed.run.result?.recordsObserved, 0);
    const checkpoint = (await admin.query("SELECT cursor,revision FROM finnor_os.capability_nango_checkpoints WHERE tenant_id=$1 AND source_scope_id=$2", [nangoTenant, nangoSource.sourceScopeId])).rows[0]; assert.equal(checkpoint.cursor, "cursor4"); assert.equal(Number(checkpoint.revision), 4); return { observed, checkpoint };
  });
  await check("nango-invalid-provider-record-rolls-back-evidence-and-cursor-together", async () => {
    assert(nangoSource); nangoBadRecord = true;
    const before = (await admin.query("SELECT count(*)::int count FROM finnor_os.evidence_source_versions WHERE tenant_id=$1", [nangoTenant])).rows[0].count;
    const wake = await wakeNango("bad-record"); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(wake.id, headers(nangoTenant, nangoPrincipal))).json()); assert.equal(observed.run.status, "FAILED"); assert.equal(observed.run.result, null);
    const after = (await admin.query("SELECT count(*)::int count FROM finnor_os.evidence_source_versions WHERE tenant_id=$1", [nangoTenant])).rows[0].count; assert.equal(after, before);
    const checkpoint = (await admin.query("SELECT cursor,revision FROM finnor_os.capability_nango_checkpoints WHERE tenant_id=$1 AND source_scope_id=$2", [nangoTenant, nangoSource.sourceScopeId])).rows[0]; assert.equal(checkpoint.cursor, "cursor4"); assert.equal(Number(checkpoint.revision), 4);
    return { observed, evidenceVersionsBefore: before, evidenceVersionsAfter: after, checkpoint, physicalInputFault: "provider record id exceeds native observation bound after evidence insert is attempted" };
  });
  await check("nango-lifecycle-uses-fresh-health-and-never-resurrects-private-cache", async () => {
    assert(nangoSource); nangoBadRecord = false;
    const { sql } = await import("drizzle-orm");
    const initial = (await admin.query("SELECT id FROM finnor_os.evidence_sources WHERE tenant_id=$1 AND source_type='nango_record' ORDER BY created_at LIMIT 1", [nangoTenant])).rows[0]; assert(initial);
    const visible = async () => db.withTenant(nangoTenant, async connection => {
      const sources = await connection.execute(sql`SELECT id FROM finnor_os.evidence_sources WHERE id=${initial.id}::uuid`);
      const versions = await connection.execute(sql`SELECT id FROM finnor_os.evidence_source_versions WHERE source_id=${initial.id}::uuid`);
      const chunks = await connection.execute(sql`SELECT id FROM finnor_os.evidence_chunks WHERE source_id=${initial.id}::uuid`);
      const observations = await connection.execute(sql`SELECT id FROM finnor_os.external_ref_observations WHERE evidence_source_id=${initial.id}::uuid`);
      return { sources: sources.rows.length, versions: versions.rows.length, chunks: chunks.rows.length, observations: observations.rows.length };
    }, nangoPrincipal);
    const bound = async () => (await admin.query("SELECT status,connection_epoch FROM finnor_os.capability_nango_bindings WHERE tenant_id=$1 AND source_scope_id=$2", [nangoTenant, nangoSource!.sourceScopeId])).rows[0];
    const before = await visible(); assert.equal(before.sources, 1); assert(before.observations > 0);
    const queued = await post({ kind: "nango_sync", idempotencyKey: "prior-connection-epoch", ...nangoSource }, headers(nangoTenant, nangoPrincipal)); assert.equal(queued.status, 202);
    const queuedRun = acceptedSchema.parse(await queued.json());
    const event = (operation: string, success: boolean) => ({ type: "auth", operation, success, providerConfigKey: "fixture-crm", connectionId: "nango_connection_fixture" });
    const staleFailure = await webhook(event("refresh", false)); assert.equal(staleFailure.status, 202); assert.equal((await bound()).status, "ACTIVE");
    nangoWrongIdentity = true; const swapped = await webhook(event("refresh", true)); assert.equal(swapped.status, 409); nangoWrongIdentity = false; assert.equal((await bound()).status, "ACTIVE");
    nangoConnectionState = "missing"; const deletion = await webhook(event("deletion", true)); assert.equal(deletion.status, 202);
    const disabled = await bound(); assert.equal(disabled.status, "DISABLED"); assert.equal(Number(disabled.connection_epoch), 2); assert.deepEqual(await visible(), { sources: 0, versions: 0, chunks: 0, observations: 0 });
    const blocked = await post({ kind: "nango_sync", idempotencyKey: "disabled-nango-sync", ...nangoSource }, headers(nangoTenant, nangoPrincipal)); assert.equal(blocked.status, 404);
    const replay = await webhook(event("refresh", true)); assert.equal(replay.status, 202); assert.equal((await bound()).status, "DISABLED");
    nangoConnectionState = "healthy"; const recovered = await webhook(event("refresh", false)); assert.equal(recovered.status, 202);
    const active = await bound(); assert.equal(active.status, "ACTIVE"); assert.equal(Number(active.connection_epoch), 3); assert.deepEqual(await visible(), { sources: 0, versions: 0, chunks: 0, observations: 0 });
    const reset = (await admin.query("SELECT cursor,history_limited FROM finnor_os.capability_nango_checkpoints WHERE tenant_id=$1 AND source_scope_id=$2", [nangoTenant, nangoSource.sourceScopeId])).rows[0]; assert.equal(reset.cursor, null); assert.equal(reset.history_limited, true);
    const readsBeforeStale = nangoProviderReads; await freshWorkerTick();
    const staleRun = runSchema.parse(await (await read(queuedRun.run.id, headers(nangoTenant, nangoPrincipal))).json()); assert.equal(staleRun.run.status, "FAILED"); assert.equal(staleRun.run.failureCode, "NANGO_SOURCE_BINDING_CHANGED"); assert.equal(nangoProviderReads, readsBeforeStale);
    const wake = await wakeNango("after-recovery"); let observed;
    for (let i = 0; i < 4; i++) {
      await admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=(SELECT job_id FROM finnor_os.capability_runs WHERE id=$1)", [wake.id]); await freshWorkerTick();
      observed = runSchema.parse(await (await read(wake.id, headers(nangoTenant, nangoPrincipal))).json()); if (observed.run.status !== "WAITING_PROVIDER") break;
    }
    assert.equal(observed?.run.status, "SUCCEEDED", JSON.stringify(observed)); assert.deepEqual(await visible(), { sources: 0, versions: 0, chunks: 0, observations: 0 });
    const facts = (await admin.query("SELECT connection_epoch,status,observed_state FROM finnor_os.capability_nango_health_events WHERE tenant_id=$1 ORDER BY id", [nangoTenant])).rows;
    const recorded = (await admin.query("SELECT metadata::text FROM finnor_os.evidence_sources WHERE tenant_id=$1 UNION ALL SELECT observed_state::text FROM finnor_os.external_ref_observations WHERE tenant_id=$1", [nangoTenant])).rows;
    assert(!JSON.stringify(recorded).includes("PRIVATE_UPSTREAM_CREDENTIAL_MUST_NEVER_PERSIST"));
    return { before, disabled, recovered: active, reset, statusFacts: facts, freshProviderConnectionReads: nangoConnectionReads, historicalCacheRemainsHidden: true, staleQueuedRun: { id: queuedRun.run.id, failure: staleRun.run.failureCode, providerRecordsRead: 0 }, newSyncRunId: wake.id, credentialsPersisted: false };
  });
  await check("remote-acceptance-survives-revocation-and-remains-cancellable", async () => {
    const response = await post({ kind: "parallel_monitor", idempotencyKey: "monitor-acceptance-revocation", query: "revoke-after-remote-acceptance", cadence: "daily" }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json());
    try {
      await freshWorkerTick();
      const observed = (await admin.query("SELECT status,result,remote_state,failure_code FROM finnor_os.capability_runs WHERE id=$1", [value.run.id])).rows[0];
      assert.equal(observed.status, "UNKNOWN"); assert.equal(observed.result, null); assert.equal(observed.remote_state.remoteId, "monitor_revoked_fixture");
      assert.equal((await read(value.run.id, headers(pageTenant, pagePrincipal))).status, 403);
    } finally { await admin.query("UPDATE finnor_os.role_authority_grants SET effect='allow' WHERE tenant_id=$1 AND capability='capability:*'", [pageTenant]); }
    const cleanup = await post({ kind: "parallel_monitor_control", idempotencyKey: "cleanup-revoked-monitor", monitorRunId: value.run.id, operation: "cancel" }, headers(pageTenant, pagePrincipal));
    assert.equal(cleanup.status, 202, JSON.stringify(await cleanup.clone().json())); const accepted = acceptedSchema.parse(await cleanup.json()); await freshWorkerTick();
    assert.equal(runSchema.parse(await (await read(accepted.run.id, headers(pageTenant, pagePrincipal))).json()).run.status, "SUCCEEDED"); assert.equal(revokedMonitorDeletions, 1);
    return { runId: value.run.id, cleanupRunId: accepted.run.id, remoteAcceptanceRetained: true, businessResultPublished: false, providerDeletes: revokedMonitorDeletions, physicalFault: "authority revoked by the provider fixture after accepting POST, before returning acknowledgement" };
  });
  await check("late-accepted-receipt-is-reconstructible-after-lease-loss", async () => {
    const response = await post({ kind: "parallel_monitor", idempotencyKey: "monitor-late-acceptance", query: "lose-lease-after-remote-acceptance", cadence: "daily" }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const recovery = new JobQueue(`late-recovery:${randomUUID()}`, 30, "HEAVY"); recovery.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1);
    await recovery.recoverExpiredRunningJobs(); await admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE payload->>'runId'=$1 AND status='queued'", [value.run.id]); await recovery.tick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "UNKNOWN", JSON.stringify(observed));
    const receipt = z.object({ remoteState: z.object({ acceptedReceipt: z.object({ remoteId: z.literal("monitor_late_fixture") }) }) }).parse(observed.run);
    const late = (await admin.query("SELECT body FROM finnor_os.capability_run_events WHERE run_id=$1 AND kind='PROVIDER_ACCEPTED' AND body#>>'{receipt,late}'='true'", [value.run.id])).rows; assert.equal(late.length, 1);
    const cleanup = await post({ kind: "parallel_monitor_control", idempotencyKey: "cleanup-late-monitor", monitorRunId: value.run.id, operation: "cancel" }, headers(pageTenant, pagePrincipal));
    assert.equal(cleanup.status, 202, JSON.stringify(await cleanup.clone().json())); const accepted = acceptedSchema.parse(await cleanup.json()); await freshWorkerTick();
    assert.equal(runSchema.parse(await (await read(accepted.run.id, headers(pageTenant, pagePrincipal))).json()).run.status, "SUCCEEDED"); assert.equal(lateMonitorDeletions, 1);
    return { runId: value.run.id, receipt, lateReceipt: late, cleanupRunId: accepted.run.id, providerDeletes: lateMonitorDeletions, physicalFault: "actual job lease expired between provider acceptance and acknowledged receipt persistence" };
  });
  await check("worker-kill-before-dispatch-recovers-with-one-provider-create", async () => {
    const response = await post({ kind: "parallel_task", idempotencyKey: "pre-dispatch-worker-kill", input: "recovered-before-dispatch", outputSchema: { type: "object" }, processor: "lite", timeoutMs: 60_000 }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()), createsBefore = providerSubmissions.filter(p => p.path === "/v1/tasks/runs").length;
    // The real worker blocks before its dispatch-marker transaction commits.
    // No queue claim or domain result is fabricated by this fault fixture.
    const pauseSql = `CREATE FUNCTION finnor_os.capability_fixture_pause_before_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='PROVIDER_DISPATCH' AND NEW.run_id='${value.run.id}'::uuid THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$`;
    await admin.query(pauseSql);
    await admin.query("CREATE TRIGGER capability_fixture_pause_before_dispatch BEFORE INSERT ON finnor_os.capability_run_events FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_fixture_pause_before_dispatch()");
    const child = spawn(process.execPath, ["--import=tsx", "scripts/release/run-capability-worker-once.mts"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: database.workerUrl, LOG_LEVEL: "silent", FINNOR_PARALLEL_ENABLED: "1", PARALLEL_API_KEY: "disposable-protocol-fixture",
      FINNOR_PARALLEL_BASE_URL: apiOrigin, FINNOR_PARALLEL_MAX_RUNS_PER_TENANT_DAY: "100",
    } });
    let childLog = ""; child.stdout.on("data", chunk => { if (childLog.length < 65_536) childLog += String(chunk); }); child.stderr.on("data", chunk => { if (childLog.length < 65_536) childLog += String(chunk); });
    const exited = new Promise<void>(done => { child.once("exit", () => done()); child.once("error", () => done()); });
    let pausedBackend: number | null = null, pausedState: unknown;
    try {
      pausedBackend = await until(async () => { const row = (await admin.query("SELECT pid FROM pg_stat_activity WHERE datname='finnor' AND wait_event='PgSleep' AND query ILIKE '%capability_run_events%' AND pid<>pg_backend_pid()")).rows[0]; return row ? Number(row.pid) : null; }, 30_000);
      pausedState = (await admin.query("SELECT status,remote_state FROM finnor_os.capability_runs WHERE id=$1", [value.run.id])).rows[0];
      assert.deepEqual(pausedState, { status: "RUNNING", remote_state: {} });
      assert.equal(providerSubmissions.filter(p => p.path === "/v1/tasks/runs").length, createsBefore);
      child.kill("SIGKILL"); await exited;
      // Terminate only the observed paused backend in this owned disposable DB;
      // this physically rolls back its uncommitted dispatch journal transaction.
      await admin.query("SELECT pg_terminate_backend($1)", [pausedBackend]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      if (pausedBackend !== null) await admin.query("SELECT pg_terminate_backend($1) WHERE EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep')", [pausedBackend]);
      await admin.query("DROP TRIGGER capability_fixture_pause_before_dispatch ON finnor_os.capability_run_events");
      await admin.query("DROP FUNCTION finnor_os.capability_fixture_pause_before_dispatch()");
      await writeFile(join(output, "pre-dispatch-worker-kill.json"), JSON.stringify({ runId: value.run.id, childPid: child.pid, signal: child.signalCode, pausedBackend, pausedState, childLog, pauseSql }, null, 2));
    }
    await until(async () => { const row = (await admin.query("SELECT lease_expires_at<clock_timestamp() AS expired FROM finnor_os.jobs WHERE payload->>'runId'=$1", [value.run.id])).rows[0]; return row.expired === true ? true : null; });
    const recovery = new JobQueue(`killed-worker-recovery:${randomUUID()}`, 30, "HEAVY"); recovery.register("run_capability_provider_v1", runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1);
    assert.equal(await recovery.recoverExpiredRunningJobs(), 1);
    await admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE payload->>'runId'=$1 AND status='queued'", [value.run.id]); await recovery.tick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed));
    assert.equal(providerSubmissions.filter(p => p.path === "/v1/tasks/runs").length - createsBefore, 1);
    const deliveries = (await admin.query("SELECT a.claim_fence,a.outcome FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j ON j.id=a.job_id WHERE j.payload->>'runId'=$1 ORDER BY a.claim_fence", [value.run.id])).rows;
    assert.equal(deliveries.length, 2); assert.equal(deliveries[0].outcome, "lease_lost"); assert.equal(deliveries[1].outcome, "completed");
    return { runId: value.run.id, observedStatus: observed.run.status, providerCreates: 1, deliveries, physicalFault: "SIGKILL of a real native queue/worker process before the dispatch transaction commits, followed by actual lease expiry and canonical recovery" };
  });
  if (modalFixture) await check("modal-native-worker-uses-official-sdk-v2-with-bounded-policy", async () => {
    const code = 'print("The local protocol fixture must not execute this program")';
    const response = await post({ kind: "modal_execute", idempotencyKey: "modal-official-protocol", code, sources: [{ documentId: pageSource.documentId, versionId: pageSource.versionId }], stdin: "synthetic-input", timeoutMs: 60_000 }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed));
    const result = z.object({ sandboxId: z.string(), terminationAcknowledged: z.literal(true), program: z.object({ stdoutBase64: z.string(), codeSha256: z.string() }), configuredPolicy: z.object({ networkBlocked: z.literal(true), secrets: z.literal(0), volumes: z.literal(0), memoryMiB: z.literal(512) }) }).parse(observed.run.result);
    assert.equal(Buffer.from(result.program.stdoutBase64, "base64").toString(), "MODAL_PROTOCOL_FIXTURE_ONLY\n"); assert.equal(result.program.codeSha256, createHash("sha256").update(code).digest("hex"));
    const protocol = z.object({ requests: z.array(z.object({ method: z.string(), request: z.record(z.unknown()) })), sandboxes: z.record(z.object({ terminated: z.boolean(), inputSupplied: z.boolean() })) }).parse(JSON.parse(await readFile(join(output, "modal-protocol/modal-protocol-observed.json"), "utf8")));
    const created = protocol.requests.find(r => r.method === "SandboxCreateV2"); assert(created);
    const definition = z.object({ resources: z.object({ memory_mb: z.literal(512), memory_mb_max: z.literal(512), milli_cpu: z.literal(1000), milli_cpu_max: z.literal(1000) }), network_access: z.object({ network_access_type: z.literal("BLOCKED") }), runtime: z.literal("gvisor"), secret_ids: z.array(z.string()).optional(), volume_mounts: z.array(z.unknown()).optional(), entrypoint_args: z.array(z.string()) }).passthrough().parse(created.request.definition);
    assert.equal(definition.secret_ids?.length ?? 0, 0); assert.equal(definition.volume_mounts?.length ?? 0, 0); assert(!definition.entrypoint_args.join(" ").includes(code)); assert(!JSON.stringify(created.request).includes("as-disposable-fixture"));
    assert.equal(protocol.sandboxes[result.sandboxId]?.terminated, true); assert.equal(protocol.sandboxes[result.sandboxId]?.inputSupplied, true);
    const foreign = await post({ kind: "modal_control", idempotencyKey: "foreign-modal-control", executionRunId: value.run.id, operation: "terminate" }, headers(otherTenant, otherPrincipal)); assert.equal(foreign.status, 404);
    const status = await post({ kind: "modal_control", idempotencyKey: "modal-status", executionRunId: value.run.id, operation: "status" }, headers(pageTenant, pagePrincipal)); assert.equal(status.status, 202); const control = acceptedSchema.parse(await status.json()); await freshWorkerTick();
    const controlResult = runSchema.parse(await (await read(control.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(controlResult.run.status, "SUCCEEDED"); assert(!JSON.stringify(controlResult.run.result).includes("MODAL_PROTOCOL_FIXTURE_ONLY"));
    return { runId: value.run.id, observed: result, actualProtocolMethods: protocol.requests.map(r => r.method), configuredPolicy: definition, sourceBytesDigestVerifiedByFixture: true,
      qualification: "REAL_API_SQL_QUEUE_WORKER_AND_OFFICIAL_MODAL_1_6_2_SDK_V2_GRPC_PROTOCOL; FIXTURE_EXECUTES_NO_CANDIDATE_AND_PROVES_NO_VM_ISOLATION" };
  });
  if (modalFixture) await check("modal-attested-pre-create-refusal-is-failed-and-refunds-reservation", async () => {
    const counts = async () => {
      const protocol = JSON.parse(await readFile(join(output, "modal-protocol/modal-protocol-observed.json"), "utf8"));
      const budget = (await admin.query("SELECT count FROM finnor_os.api_rate_limits WHERE bucket_key LIKE $1", [`budget:${pageTenant}:modal:capability_submissions:%`])).rows;
      return { created: protocol.requests.filter((row: { method: string }) => ["SandboxCreate", "SandboxCreateV2"].includes(row.method)).length, reserved: budget.reduce((sum: number, row: { count: number }) => sum + row.count, 0) };
    };
    const before = await counts(), original = process.env.FINNOR_MODAL_APP_NAME; process.env.FINNOR_MODAL_APP_NAME = "finnor-pre-dispatch-refusal-fixture";
    try {
      const response = await post({ kind: "modal_execute", idempotencyKey: "modal-refused-before-create", code: "print('never executed')", timeoutMs: 30_000 }, headers(pageTenant, pagePrincipal));
      assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
      const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json());
      assert.equal(observed.run.status, "FAILED", JSON.stringify(observed)); assert.equal(observed.run.failureCode, "MODAL_CREATE_NOT_DISPATCHED");
      const state = (await admin.query("SELECT remote_state FROM finnor_os.capability_runs WHERE id=$1", [value.run.id])).rows[0].remote_state;
      assert.equal(state.phase, "not_dispatched"); assert.deepEqual(await counts(), before);
      return { runId: value.run.id, failureCode: observed.run.failureCode, before, after: await counts(), attestation: "TRUSTED_ENGINE_SOURCE_DIGEST_AND_CREATION_STARTED_FALSE" };
    } finally { if (original === undefined) delete process.env.FINNOR_MODAL_APP_NAME; else process.env.FINNOR_MODAL_APP_NAME = original; }
  });
  if (gepaSource) await check("actual-gepa-optimizer-native-planner-compiler-and-independent-holdout", async () => {
    const response = await post({ kind: "gepa_optimize", idempotencyKey: "gepa-native", dataset: gepaSource, maxMetricCalls: 16, timeoutMs: 120_000, seed: 13 }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); gepaRunId = value.run.id; await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed));
    const result = z.object({ optimizer: z.object({ backend: z.object({ name: z.literal("gepa"), version: z.literal("0.1.4") }), candidates: z.array(z.unknown()).min(2) }),
      holdout: z.object({ baseline: z.literal(0), candidate: z.literal(1), tasks: z.literal(2) }), evaluations: z.array(z.object({ taskId: z.string(), split: z.string(), phase: z.string() })),
      metricCalls: z.number().int().max(16), holdoutAvailableToOptimizer: z.literal(false), activation: z.literal("REQUIRES_SEPARATE_REVIEWED_OWNER_ACTIVATION") }).passthrough().parse(observed.run.result);
    assert(result.evaluations.filter(row => row.phase === "optimization").every(row => row.split !== "holdout"));
    const effects = (await admin.query("SELECT count(*)::int count FROM finnor_os.domain_actions WHERE tenant_id=$1", [pageTenant])).rows[0].count; assert.equal(effects, 0);
    return { runId: value.run.id, result, nativeBusinessActionsCreated: effects, qualification: "REAL_GEPA_NATIVE_PLANNER_AND_COMPILER_WITH_DETERMINISTIC_LOCAL_LLM_FIXTURE; SYNTHETIC_SCORE_CHANGE_ONLY_NOT_GENERALIZED_MODEL_GAIN" };
  });
  if (gepaSource) await check("reviewed-gepa-activation-drives-native-planner-and-is-reversible", async () => {
    assert(gepaRunId); process.env.FINNOR_GEPA_PLANNER_CANDIDATES_ENABLED = "1";
    const original = await read(gepaRunId, headers(pageTenant, pagePrincipal)); const run = z.object({ run: z.object({ resultDigest: z.string() }) }).parse(await original.json()).run;
    const submit = (body: unknown, h = headers(pageTenant, pagePrincipal)) => fetch(`${apiOrigin}/api/capabilities/planner/activation`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const request = { operation: "activate", expectedRevision: 0, idempotencyKey: "review-gepa-candidate", runId: gepaRunId, reviewedResultDigest: run.resultDigest, reviewNote: "Reviewed this immutable local qualification cut for background proposal-only use." };
    const foreign = await submit(request, headers(otherTenant, otherPrincipal)); assert.equal(foreign.status, 409);
    const changed = await submit({ ...request, reviewedResultDigest: "0".repeat(64) }); assert.equal(changed.status, 409);
    const { LLMPlanner } = await import("../../packages/orchestration/src/planner"), { createDefaultPluginRegistry } = await import("../../packages/orchestration/src/plugin-registry");
    const { loadActivePlannerHeuristic } = await import("../../packages/orchestration/src/capabilities/planner-activation");
    const actor = { tenantId: pageTenant, userId: pagePrincipal, employeeId: pagePrincipal, role: "owner" as const };
    const planner = new LLMPlanner(createDefaultPluginRegistry()), memory = { shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null };
    const actions = async (replay = false) => (await planner.plan(gepaDataset.tasks[0]!.instruction, actor, memory, { channel: "background", deadlineAt: Date.now() + 15_000, optimizationReplay: replay })).compilation.selected?.graph?.nodes.filter(node => node.kind === "action").map(node => node.actionType) ?? [];
    assert.deepEqual(await actions(), []);
    const { plannerCandidateEnvironment } = await import("../../packages/orchestration/src/capabilities/planner-environment");
    await writeFile(join(output, "planner-activation-environment.json"), JSON.stringify({ current: await plannerCandidateEnvironment(), api: await (await fetch(`${apiOrigin}/api/capabilities/planner/activation`, { headers: headers(pageTenant, pagePrincipal) })).json(), candidate: (await (await read(gepaRunId, headers(pageTenant, pagePrincipal))).json()).run.result.plannerEnvironment }, null, 2));
    const activated = await submit(request); assert.equal(activated.status, 200, JSON.stringify(await activated.clone().json())); const activation = await activated.json(); assert.equal(activation.activation.revision, 1);
    const duplicate = await submit(request); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).replayed, true);
    const stale = await submit({ ...request, idempotencyKey: "stale-activation" }); assert.equal(stale.status, 409);
    assert.deepEqual(await actions(), ["search_web"]); assert.deepEqual(await actions(true), []);
    process.env.FINNOR_GEPA_FIXTURE_MODEL_REVISION = "v2";
    assert.equal(await loadActivePlannerHeuristic(actor), null);
    assert.deepEqual(await actions(), []);
    const modelChanged = await submit({ ...request, expectedRevision: 1, idempotencyKey: "changed-model-activation" }); assert.equal(modelChanged.status, 409);
    delete process.env.FINNOR_GEPA_FIXTURE_MODEL_REVISION;
    assert.deepEqual(await actions(), ["search_web"]);
    const route = process.env.LLM_PROVIDER_PLANNING_BACKGROUND; process.env.LLM_PROVIDER_PLANNING_BACKGROUND = "absent-changed-route"; assert.equal(await loadActivePlannerHeuristic(actor), null); process.env.LLM_PROVIDER_PLANNING_BACKGROUND = route;
    const disabled = await submit({ operation: "disable", expectedRevision: 1, idempotencyKey: "disable-reviewed-candidate", reviewNote: "Restored the incumbent after the bounded native consumer proof." }); assert.equal(disabled.status, 200); assert.equal((await disabled.json()).activation.revision, 2);
    assert.deepEqual(await actions(), []);
    const history = (await admin.query("SELECT revision,operation,run_id,result_digest FROM finnor_os.capability_planner_activations WHERE tenant_id=$1 ORDER BY revision", [pageTenant])).rows;
    assert.deepEqual(history.map(row => row.operation), ["activate", "disable"]);
    return { runId: gepaRunId, activation, history, currentPlannerBefore: "NO_ACCEPTED_PLAN", reviewedPlannerAfter: "search_web", replayExcludesActiveCandidate: true, routeChangeInvalidatesCandidate: true, sameAliasModelChangeInvalidatesCandidate: true, disabledPlanner: "NO_ACCEPTED_PLAN", businessEffectsExecuted: 0 };
  });
  if (gepaSource) await check("gepa-repeated-holdout-instruction-refused-before-model-call", async () => {
    const tasks = gepaDataset.tasks.map(task => ({ ...task }));
    tasks[0] = { ...tasks[0]!, expectedActionTypes: ["search_web", "clarification_request"] };
    tasks[4] = { ...tasks[4]!, instruction: tasks[0]!.instruction, expectedActionTypes: ["clarification_request", "search_web"] };
    const dataset = await db.withTenant(pageTenant, async connection => {
      const document = await createDocument(connection, { tenantId: pageTenant, kind: "evaluation_dataset", title: "Rejected repeated holdout.json", provenance: { sourceSystem: "capability-e2e", createdBy: pagePrincipal } });
      const version = await appendDocumentVersion(connection, { tenantId: pageTenant, documentId: document.documentId, bytes: Buffer.from(JSON.stringify({ ...gepaDataset, tasks })), mediaType: "application/json", format: "unknown", origin: "manual_upload", actor: pagePrincipal });
      return { documentId: document.documentId, versionId: version.id };
    }, pagePrincipal);
    const callsBefore = gepaProviderCalls;
    const response = await post({ kind: "gepa_optimize", idempotencyKey: "gepa-repeated-holdout", dataset, maxMetricCalls: 16, timeoutMs: 30_000, seed: 13 }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json();
    assert.notEqual(observed.run.status, "SUCCEEDED"); assert.equal(observed.run.result, null); assert.equal(gepaProviderCalls, callsBefore);
    return { status: observed.run.status, failureCode: observed.run.failureCode, modelCalls: 0, resultPublished: false, repeatedInputWithPermutedLabels: true };
  });
  if (scannedSource) await check("actual-docling-ocr-table-and-native-memory-evidence", async () => {
    const response = await post({ kind: "docling_extract", idempotencyKey: "docling-native-scanned", source: { documentId: scannedSource.documentId, versionId: scannedSource.versionId }, forceOcr: true, timeoutMs: 120_000 }, headers(pageTenant, pagePrincipal));
    assert.equal(response.status, 202); const value = acceptedSchema.parse(await response.json()); await freshWorkerTick();
    const observed = runSchema.parse(await (await read(value.run.id, headers(pageTenant, pagePrincipal))).json()); assert.equal(observed.run.status, "SUCCEEDED", JSON.stringify(observed));
    const result = z.object({ status: z.literal("success"), markdown: z.string(), backend: z.object({ name: z.literal("docling"), version: z.literal("2.142.1"), modelManifestSha256: z.string() }),
      document: z.object({ tables: z.array(z.object({ data: z.object({ table_cells: z.array(z.object({ text: z.string() }).passthrough()) }).passthrough() }).passthrough()).min(1) }).passthrough(),
      anchors: z.array(z.object({ page: z.number(), source: z.object({ documentId: z.string(), versionId: z.string(), sha256: z.string() }).passthrough() }).passthrough()).min(1),
      evidence: z.array(z.object({ sourceId: z.string().uuid(), versionId: z.string().uuid(), chunks: z.number().int().positive() }).passthrough()).min(1) }).passthrough().parse(observed.run.result);
    const cells = result.document.tables.flatMap(table => table.data.table_cells.map(cell => cell.text));
    for (const expected of ["Customer", "Revenue", "Alpha", "40", "Beta", "60", "Total", "100"]) assert(cells.includes(expected), JSON.stringify(cells));
    assert.equal(result.anchors[0]!.page, 1); assert.equal(result.anchors[0]!.source.sha256, scannedSource.sha256); assert.equal(result.anchors[0]!.source.versionId, scannedSource.versionId);
    const memory = (await admin.query("SELECT s.source_type,v.content,v.snapshot FROM finnor_os.evidence_sources s JOIN finnor_os.evidence_source_versions v ON v.source_id=s.id WHERE s.tenant_id=$1 AND s.id=$2 AND v.id=$3", [pageTenant, result.evidence[0]!.sourceId, result.evidence[0]!.versionId])).rows[0];
    assert.equal(memory.source_type, "document_extraction"); assert(memory.content.includes("Alpha")); assert.equal(memory.snapshot.source.sha256, scannedSource.sha256); assert.equal(memory.snapshot.executionAuthorityGranted, false);
    return { runId: value.run.id, scannedSource, recognizedCells: cells, anchors: result.anchors, evidence: result.evidence, backend: result.backend,
      qualification: "REAL_OFFLINE_DOCLING_OCR_AND_TABLE_MODELS_IMAGE_ONLY_PDF_NATIVE_API_QUEUE_WORKER_MEMORY_VERSIONS_AND_CHUNKS" };
  });
  await check("capability-history-is-current-authorized-and-version-bound", async () => {
    assert(runId);
    const own = await fetch(`${base}?documentId=${source.documentId}&versionId=${source.versionId}`, { headers: headers() });
    const history = z.object({ runs: z.array(z.object({ id: z.string().uuid(), kind: z.string() }).passthrough()), nextCursor: z.string().nullable() }).parse(await own.json());
    assert.equal(own.status, 200); assert(history.runs.some(run => run.id === runId));
    const foreign = await fetch(`${base}?documentId=${source.documentId}&versionId=${source.versionId}`, { headers: headers(otherTenant, otherPrincipal) }); assert.deepEqual((await foreign.json()).runs, []);
    const mismatched = await fetch(`${base}?documentId=${source.documentId}`, { headers: headers() }); assert.equal(mismatched.status, 400);
    await grant("deny"); const denied = await fetch(base, { headers: headers() }); assert.equal(denied.status, 200); assert.deepEqual((await denied.json()).runs, []); await grant("allow");
    return { runId, history, otherTenantRuns: 0, revokedRuns: 0, exactVersionRequired: true };
  });
  await check("private-derived-evidence-cannot-widen-to-tenant-corpus", async () => {
    const { sql } = await import("drizzle-orm");
    const records = (await admin.query("SELECT s.id,s.tenant_id,s.metadata FROM finnor_os.evidence_sources s WHERE s.source_type='document_extraction' OR s.source_type='nango_record' AND EXISTS(SELECT 1 FROM finnor_os.capability_nango_bindings b WHERE b.tenant_id=s.tenant_id AND b.source_scope_id::text=s.metadata->>'sourceScopeId' AND b.status='ACTIVE' AND b.connection_epoch::text=s.metadata->>'connectionEpoch') ORDER BY s.created_at")).rows;
    assert(records.length > 0);
    const ownRows = async (sourceId: string, tenantId: string, actorId?: string) => db.withTenant(tenantId, async connection => {
      const sources = await connection.execute(sql`SELECT id FROM finnor_os.evidence_sources WHERE id=${sourceId}::uuid`);
      const versions = await connection.execute(sql`SELECT id FROM finnor_os.evidence_source_versions WHERE source_id=${sourceId}::uuid`);
      const chunks = await connection.execute(sql`SELECT id FROM finnor_os.evidence_chunks WHERE source_id=${sourceId}::uuid`);
      return { sources: sources.rows.length, versions: versions.rows.length, chunks: chunks.rows.length };
    }, actorId);
    const checks = [];
    for (const record of records) {
      const owned = await ownRows(record.id, record.tenant_id, record.metadata.capabilityPrincipalId); assert.equal(owned.sources, 1); assert(owned.versions > 0 && owned.chunks > 0);
      assert.deepEqual(await ownRows(record.id, record.tenant_id), { sources: 0, versions: 0, chunks: 0 });
      assert.deepEqual(await ownRows(record.id, record.tenant_id, record.tenant_id === pageTenant ? sameTenantPrincipal : otherPrincipal), { sources: 0, versions: 0, chunks: 0 }); checks.push({ id: record.id, owned });
    }
    const selected = records[0];
    await admin.query("UPDATE finnor_os.role_authority_grants SET effect='deny' WHERE tenant_id=$1 AND capability='capability:*'", [selected.tenant_id]);
    assert.deepEqual(await ownRows(selected.id, selected.tenant_id, selected.metadata.capabilityPrincipalId), { sources: 0, versions: 0, chunks: 0 });
    await admin.query("UPDATE finnor_os.role_authority_grants SET effect='allow' WHERE tenant_id=$1 AND capability='capability:*'", [selected.tenant_id]);
    assert.deepEqual(await ownRows(selected.id, selected.tenant_id, selected.metadata.capabilityPrincipalId), { sources: 0, versions: 0, chunks: 0 });
    return { checks, otherPrincipalAndUnscopedReads: 0, revokedAuthorityReads: 0, restoredAuthorityDoesNotReauthorizeHistoricalPrivateCut: true, role: "finnor_app_with_forced_rls" };
  });
  await check("langfuse-real-registered-model-tool-path-and-bounded-drain", async () => (await import("./verify-langfuse-registered-path.mjs")).verifyRegisteredLangfuse(pageTenant, pagePrincipal));
} finally {
  server.closeIdleConnections(); await new Promise<void>(done => server.close(() => done())); await database.stop();
  if (modalFixture) { const stopped = new Promise<void>(done => modalFixture!.once("exit", () => done())); modalFixture.kill("SIGTERM"); await stopped; }
}
const after = await sourceCut(), sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after);
const failed = !sourcesUnchanged || cases.some(c => c.status === "FAIL");
await writeFile(join(output, "results.json"), JSON.stringify({ schema: "finnor.capability-delivery-e2e.v1", before, after, sourcesUnchanged, cases,
  inputs: { source, csv: csv.toString(), request }, providerSubmissions, migrations: database.migrations, node: process.version,
  fixtureActivation: { fixtureReleaseId, identityKind: "SYNTHETIC_DISPOSABLE_FIXTURE_ID_NOT_GIT_HEAD", computeEpoch: 3 },
  qualification: "REAL_LOOPBACK_HTTP_ROUTE_HANDLERS_ORDINARY_ROLE_POSTGRES_QUEUE_WORKER_AND_PYTHON; DEV_HEADER_AUTH_NOT_PRODUCTION_IDENTITY; NO_HOSTED_PROVIDER_CERTIFICATION",
  rerun: "FINNOR_CAPABILITY_PYTHON=$PWD/.capability-venv/bin/python FINNOR_CAPABILITY_EVIDENCE_DIR=<fresh-directory> node --import=tsx scripts/release/run-capability-delivery-e2e.mts", failed }, null, 2) + "\n");
console.log(JSON.stringify({ output, failed })); process.exitCode = failed ? 1 : 0;
// Third-party logging workers can keep a disposable proof alive. All artifact
// writes and the owned database shutdown have completed before this bound.
setTimeout(() => process.exit(failed ? 1 : 0), 2000);
