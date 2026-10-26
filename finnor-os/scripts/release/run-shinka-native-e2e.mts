import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import pg from "pg";
import { createNativeOwnerDatabase } from "../s7/native-owner-database.mjs";

const output = resolve(process.env.FINNOR_CAPABILITY_EVIDENCE_DIR ?? "../docs/release/generated/shinka-native"); await mkdir(output, { recursive: true });
const paths = ["packages/db/migration-head.ts", "packages/db/migrations/0157_capability_private_evidence.sql", "packages/orchestration/src/capabilities/document-evidence.ts", "packages/orchestration/src/capabilities/optimization-broker.ts", "scripts/release/run-shinka-native-e2e.mts", "scripts/release/modal-protocol-fixture.py", "packages/orchestration/src/capabilities/shinka-execution.ts", "packages/orchestration/src/capabilities/modal-execution.ts", "packages/orchestration/src/capabilities/execution.ts", "packages/orchestration/src/capabilities/repository.ts", "packages/orchestration/src/capabilities/policy.ts", "packages/orchestration/src/capabilities/contracts.ts", "packages/tools/src/capabilities/python/shinka_engine.py", "packages/tools/src/capabilities/python/shinka_evaluator.py", "packages/tools/src/capabilities/python/modal_engine.py", "packages/tools/src/capabilities/python/modal_bootstrap.py", "packages/tools/src/capabilities/python-runner.ts", "packages/epistemic-runtime/src/allocation-checker.ts", "packages/epistemic-runtime/src/allocation-contracts.ts", "packages/private-equity/src/allocation-store.ts", "scripts/s5/owner-fixture.mts", "scripts/s3/reference.py", "packages/tools/src/capabilities/python/requirements-runtime.lock.txt"];
const cut = async () => Promise.all(paths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
paths.push("apps/api/app/api/interventions/[operation]/route.ts", "packages/tools/src/capabilities/python/pywhy_engine.py", "packages/private-equity/src/enterprise-interventions.ts", "packages/orchestration/src/capabilities/nango-lifecycle.ts", "packages/tools/src/nango.ts", "packages/data-platform/src/provider-observations.ts", "packages/db/migrations/0158_capability_planner_activations.sql", "packages/db/migrations/0159_capability_nango_lifecycle.sql");
const before = await cut(), python = process.env.FINNOR_CAPABILITY_PYTHON; assert(python);
process.env.FINNOR_S3_PYTHON ??= python; process.env.FINNOR_S5_PYTHON ??= process.env.FINNOR_S3_PYTHON;
process.env.FINNOR_S3_MODEL_STORE = join(output, "ordinary-models");
process.env.FINNOR_S4_POLICY_STORE = join(output, "ordinary-policies");
const database = await createNativeOwnerDatabase();
const provider = spawn(python, ["-I", "-B", "scripts/release/modal-protocol-fixture.py", join(output, "modal-protocol")], { env: { PATH: process.env.PATH, NODE_ENV: "test", FINNOR_MODAL_PROTOCOL_FIXTURE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let fixtureLog = "";
const ready = await new Promise<string>((done, reject) => {
  const timer = setTimeout(() => reject(new Error("MODAL_FIXTURE_START_TIMEOUT")), 10_000); let pending = "";
  provider.once("error", reject); provider.stderr.on("data", chunk => { fixtureLog += String(chunk); });
  provider.stdout.on("data", chunk => { pending += String(chunk); const end = pending.indexOf("\n"); if (end >= 0) { clearTimeout(timer); done(z.object({ url: z.string().url() }).parse(JSON.parse(pending.slice(0, end))).url); } });
});
Object.assign(process.env, { FINNOR_MODAL_ENABLED: "1", MODAL_TOKEN_ID: "ak-native-shinka-fixture", MODAL_TOKEN_SECRET: "as-native-shinka-fixture", FINNOR_MODAL_APP_NAME: "finnor-fixture", FINNOR_MODAL_IMAGE_ID: "im-Fixture123", FINNOR_MODAL_SERVER_URL: ready, FINNOR_MODAL_MAX_RUNS_PER_TENANT_DAY: "100", FINNOR_SHINKA_ENABLED: "1" });
const { POST: allocationPost } = await import("../../apps/api/app/api/allocations/[operation]/route");
const { POST: interventionPost } = await import("../../apps/api/app/api/interventions/[operation]/route");
const { createUpstreamFixtureSupport } = await import("../s5/owner-fixture.mjs");
const { createDocument, appendDocumentVersion } = await import("../../packages/data-platform/src/index");
const { JobQueue } = await import("../../apps/worker/src/queue"); const { runCapabilityProvider } = await import("../../apps/worker/src/handlers/run-capability-provider");
const runPost = await import("../../apps/api/app/api/capabilities/runs/route"), runGet = await import("../../apps/api/app/api/capabilities/runs/[id]/route");
const seedCode = '# EVOLVE-BLOCK-START\n# SELECT_FIRST\nimport sys,json\np=json.load(sys.stdin)\nprint(json.dumps({"solutions":[{"taskId":t["taskId"],"selectedPolicyIds":[v["ref"]["id"] for v in t["problem"]["policies"][:1]]} for t in p["problems"]]}))\n# EVOLVE-BLOCK-END\n';
const bestCode = seedCode.replace("SELECT_FIRST", "SELECT_ALL").replace('["policies"][:1]', '["policies"]');
const { registerProvider } = await import("../../packages/tools/src/llm"); let proposals = 0;
registerProvider("native-shinka-fixture", () => ({ name: "native-shinka-fixture", complete: async () => { proposals++; return `<NAME>select_all</NAME>\n<DESCRIPTION>Feasible independent fixture policy set.</DESCRIPTION>\n<CODE>\n\x60\x60\x60python\n${bestCode}\x60\x60\x60\n</CODE>`; } }));
process.env.LLM_PROVIDER_REPAIR_BACKGROUND = "native-shinka-fixture";
const headers = (tenant: string, principal: string) => ({ "content-type": "application/json", "x-tenant-id": tenant, "x-user-id": principal, "x-user-role": "owner" });
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = []; for await (const part of incoming) chunks.push(Buffer.from(part)); const h = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") h.set(key, value);
    const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: h, ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
    const id = /^\/api\/capabilities\/runs\/([^/]+)$/.exec(incoming.url ?? "")?.[1];
    const result = incoming.method === "POST" ? await runPost.POST(request) : id ? await runGet.GET(request, { params: Promise.resolve({ id }) }) : new Response(null, { status: 404 });
    outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end("{}"); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address(); assert(address && typeof address !== "string");
let observed: unknown, error: string | null = null;
try {
  await database.admin.query("UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=3,minimum_claim_epoch=3,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,activated_release_sha=$1,activated_at=clock_timestamp() WHERE singleton", [createHash("sha1").update(JSON.stringify(before)).digest("hex")]);
  const api = async (fixture: any, operation: string, body: unknown, handler = allocationPost) => { const response = await handler(new Request(`http://127.0.0.1/api/allocations/${operation}`, { method: "POST", headers: headers(fixture.tenant, fixture.principal), body: JSON.stringify(body) }), { params: Promise.resolve({ operation }) }); return { status: response.status, body: await response.json() }; };
  const generated = spawnSync(process.env.FINNOR_S3_PYTHON, ["scripts/s3/reference.py"], { input: JSON.stringify({ operation: "equivalent" }), encoding: "utf8", timeout: 30_000 }); assert.equal(generated.status, 0, generated.stderr);
  const day = 86_400_000, begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString();
  const upstream = createUpstreamFixtureSupport({ admin: () => database.admin, generatedRows: JSON.parse(generated.stdout).rows, begin, day, fixtures: {}, api, artifact: async (name: string, value: unknown) => { const path = join(output, "upstream", name); await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2)); return path; } });
  const f = await upstream.fixture("shinka-native-allocation", 1, [{ id: "cash", unit: "USD", capacity: 100, totalLimit: 100 }]);
  for (const label of ["A", "B", "C"]) await upstream.policy(f, label, { cash: 10 }); await upstream.resource(f, "cash", "USD", "STOCK", ["100", "100"]);
  const development = await api(f, "clear", upstream.clearing(f, { A: ["1"], B: ["2"], C: ["4"] })); assert.equal(development.status, 200, JSON.stringify(development));
  // Clearing durably commits the first policy set. Holdout uses distinct native
  // policies; reusing committed policies must fail the original S5 checker.
  for (const label of ["D", "E", "F"]) await upstream.policy(f, label, { cash: 10 });
  const heldout = await api(f, "clear", upstream.clearing(f, { D: ["2"], E: ["3"], F: ["5"] }, [], [], f.policies.slice(3))); assert.equal(heldout.status, 200, JSON.stringify(heldout));
  const dataset = { schema: "finnor.allocation-evolution-dataset.v1", seedCode, objectiveScale: 10, tasks: [{ id: "development", split: "development", allocationRef: development.body.certificate.ref }, { id: "holdout", split: "holdout", allocationRef: heldout.body.certificate.ref }] };
  let causalSeed = 117;
  const random = () => ((causalSeed = Math.imul(causalSeed, 1664525) + 1013904223 >>> 0) + 0.5) / 4294967296;
  const causalRows = ["t,y,x,z"];
  for (let i = 0; i < 500; i++) { const x = random() * 2 - 1, z = random() * 2 - 1, t = random() < 0.5 + x * 0.08 ? 1 : 0; causalRows.push([t, 2 * t + 0.5 * x + 0.2 * z + (random() - 0.5) * 0.1, x, z].join(",")); }
  const causalSource = await database.db.withTenant(f.tenant, async connection => { const doc = await createDocument(connection, { tenantId: f.tenant, kind: "tabular_evidence", title: "Native S3 conditional assessment.csv", provenance: { sourceSystem: "capability-e2e", createdBy: f.principal } }); const version = await appendDocumentVersion(connection, { tenantId: f.tenant, documentId: doc.documentId, bytes: Buffer.from(causalRows.join("\n") + "\n"), mediaType: "text/csv", format: "unknown", origin: "manual_upload", actor: f.principal }); return { documentId: doc.documentId, versionId: version.id }; }, f.principal);
  const causalRequest = { kind: "pywhy_assess", idempotencyKey: "native-s3-pywhy", dataset: { ...causalSource, name: "treatment_outcomes", format: "csv" }, treatment: "t", outcome: "y", commonCauses: ["x", "z"], effectModifiers: ["x"], estimator: "double_ml", assumptions: [{ statement: "Synthetic randomized treatment with supplied measured adjustment columns; no business identification claim.", evidenceRef: "native-s3-synthetic-dataset" }], seed: 13, timeoutMs: 120_000, interventionModelRef: f.model.ref };
  const causalAcceptance = await api(f, "assess-pywhy", causalRequest, interventionPost); assert.equal(causalAcceptance.status, 202, JSON.stringify(causalAcceptance));
  const causalQueue = new JobQueue(`s3-assessment:${randomUUID()}`, 300, "HEAVY"); causalQueue.register("run_capability_provider_v1", runCapabilityProvider, database.db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1); assert.equal(await causalQueue.tick(), true);
  const causalRead = await api(f, "read-pywhy-assessment", { runId: causalAcceptance.body.run.id }, interventionPost); assert.equal(causalRead.status, 200, JSON.stringify(causalRead)); assert.equal(causalRead.body.run.status, "SUCCEEDED", JSON.stringify(causalRead));
  const causalResult = z.object({ schema: z.literal("finnor.pywhy-assessment.v1"), estimation: z.object({ averageEffect: z.number().finite() }), s3Context: z.object({ interventionModelRef: z.record(z.unknown()), owner: z.literal("S3"), temporalModelReplaced: z.literal(false), modelAdmissionGranted: z.literal(false) }), causalClaimEstablished: z.literal(false) }).passthrough().parse(causalRead.body.run.result);
  assert(Math.abs(causalResult.estimation.averageEffect - 2) < 0.15); assert.deepEqual(causalResult.s3Context.interventionModelRef, f.model.ref);
  const foreignModel = await api(f, "assess-pywhy", { ...causalRequest, idempotencyKey: "foreign-s3-model", interventionModelRef: { ...f.model.ref, id: "intervention-model:" + "0".repeat(64), contentDigest: "0".repeat(64) } }, interventionPost); assert.equal(foreignModel.status, 404);
  const validatedModel = await api(f, "validate", { modelRef: f.model.ref }, interventionPost); assert.equal(validatedModel.status, 200); assert.equal(validatedModel.body.status, "CURRENT");
  await writeFile(join(output, "s3-pywhy-assessment.json"), JSON.stringify({ causalAcceptance, causalRead, foreignModel, validatedModel }, null, 2));
  await writeFile(join(output, "dataset.json"), JSON.stringify(dataset, null, 2));
  const source = await database.db.withTenant(f.tenant, async connection => { const doc = await createDocument(connection, { tenantId: f.tenant, kind: "evaluation_dataset", title: "Native Shinka allocation replay.json", provenance: { sourceSystem: "capability-e2e", createdBy: f.principal } }); const version = await appendDocumentVersion(connection, { tenantId: f.tenant, documentId: doc.documentId, bytes: Buffer.from(JSON.stringify(dataset)), mediaType: "application/json", format: "unknown", origin: "manual_upload", actor: f.principal }); return { documentId: doc.documentId, versionId: version.id }; }, f.principal);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/capabilities/runs`, { method: "POST", headers: headers(f.tenant, f.principal), body: JSON.stringify({ kind: "shinka_evolve", idempotencyKey: "native-shinka", problemSet: source, generations: 2, seed: 13, timeoutMs: 300_000 }) });
  const accepted = await response.json(); assert.equal(response.status, 202, JSON.stringify(accepted)); const id = z.string().uuid().parse(accepted.run.id);
  const queue = new JobQueue(`shinka-native:${randomUUID()}`, 300, "HEAVY"); queue.register("run_capability_provider_v1", runCapabilityProvider, database.db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1); assert.equal(await queue.tick(), true);
  const read = await fetch(`http://127.0.0.1:${address.port}/api/capabilities/runs/${id}`, { headers: headers(f.tenant, f.principal) }); const raw = await read.json();
  await writeFile(join(output, "native-run.json"), JSON.stringify(raw, null, 2)); assert.equal(read.status, 200); assert.equal(raw.run.status, "SUCCEEDED", JSON.stringify(raw));
  const result = z.object({ optimizer: z.object({ backend: z.object({ name: z.literal("ShinkaEvolve"), commit: z.literal("8adc053a2ce4511ad2ac310e004c530a73fb974a") }), programs: z.array(z.unknown()).min(2) }),
    holdout: z.object({ baseline: z.number(), candidate: z.number(), allFeasible: z.literal(true) }), holdoutAvailableToEvolution: z.literal(false), evaluations: z.array(z.object({ split: z.string(), correct: z.boolean(), checks: z.array(z.record(z.unknown())) })),
    admission: z.object({ status: z.literal("BLOCKED_EXTERNAL") }), executionAuthorityGranted: z.literal(false) }).passthrough().parse(raw.run.result);
  assert(result.holdout.candidate > result.holdout.baseline); assert.equal(proposals, 1); assert.equal(result.evaluations.filter(row => row.split === "holdout").length, 2);
  const physical = (await database.admin.query("SELECT j.status,j.attempts,j.claim_fence,r.remote_state FROM finnor_os.capability_runs r JOIN finnor_os.jobs j ON j.id=r.job_id WHERE r.id=$1", [id])).rows;
  const protocol = JSON.parse(await readFile(join(output, "modal-protocol/modal-protocol-observed.json"), "utf8")); assert(Object.values(protocol.sandboxes).every((state: any) => state.terminated === true));
  const reservations = (await database.admin.query("SELECT bucket_key,count FROM finnor_os.api_rate_limits WHERE bucket_key LIKE $1 ORDER BY bucket_key", [`budget:${f.tenant}:%:capability_submissions:%`])).rows;
  assert.equal(reservations.find(row => row.bucket_key.includes(":shinka:"))?.count, 1);
  assert.equal(reservations.find(row => row.bucket_key.includes(":modal:"))?.count, result.evaluations.length);
  const refused = await fetch(`http://127.0.0.1:${address.port}/api/capabilities/runs`, { method: "POST", headers: headers(f.tenant, f.principal), body: JSON.stringify({ kind: "shinka_evolve", idempotencyKey: "native-shinka-over-budget", problemSet: source, generations: 2, seed: 13, timeoutMs: 300_000 }) });
  const refusedRun = await refused.json(); assert.equal(refused.status, 202); assert.equal(await queue.tick(), true);
  const refusedRead = await fetch(`http://127.0.0.1:${address.port}/api/capabilities/runs/${refusedRun.run.id}`, { headers: headers(f.tenant, f.principal) });
  const refusedResult = await refusedRead.json(); assert.equal(refusedResult.run.status, "FAILED"); assert.equal(refusedResult.run.failureCode, "PROVIDER_DAILY_SUBMISSION_LIMIT"); assert.equal(proposals, 1);
  const validUntil = new Date(Date.now() + 90_000).toISOString();
  const expiringFit = await api(f, "fit", { request: { ...f.model.request, modelKey: "pywhy-lock-expiry", validity: { ...f.model.request.validity, validUntil } } }, interventionPost);
  assert.equal(expiringFit.status, 200, JSON.stringify(expiringFit));
  const expiringRef = expiringFit.body.model.ref;
  const wait = (ms: number) => new Promise<void>(done => setTimeout(done, Math.max(0, ms)));
  const readyFile = join(output, "expiry-real-engine-ready.json"), releaseFile = join(output, "expiry-release-real-output"), executable = join(output, "expiry-python-rendezvous");
  const wrapper = `#!${python}\nimport json,os,subprocess,sys,time\nraw=sys.stdin.buffer.read(16777217)\npayload=json.loads(raw)\ndeadline=payload['_finnorDeadlineAt']/1000\ncompleted=subprocess.run([${JSON.stringify(python)}]+sys.argv[1:],input=raw,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=max(.1,deadline-time.time()))\nwith open(${JSON.stringify(readyFile)},'w') as f: json.dump({'exitCode':completed.returncode,'outputBytes':len(completed.stdout),'at':time.time()},f)\nwhile not os.path.exists(${JSON.stringify(releaseFile)}) and time.time()<deadline: time.sleep(.01)\nif time.time()>=deadline: sys.exit(124)\nsys.stdout.buffer.write(completed.stdout)\nsys.stdout.buffer.flush()\nsys.exit(completed.returncode)\n`;
  await writeFile(executable, wrapper); await chmod(executable, 0o700);
  process.env.FINNOR_CAPABILITY_PYTHON = executable;
  const expiringAcceptance = await api(f, "assess-pywhy", { ...causalRequest, idempotencyKey: "native-s3-publication-expiry", interventionModelRef: expiringRef }, interventionPost);
  assert.equal(expiringAcceptance.status, 202, JSON.stringify(expiringAcceptance));
  const expiringId = expiringAcceptance.body.run.id, expiringWorker = causalQueue.tick();
  let engineReady = false;
  while (Date.now() < Date.parse(validUntil) - 4000) {
    try { await access(readyFile); engineReady = true; break; } catch { await wait(50); }
  }
  assert(engineReady, "EXPIRY_PROOF_REAL_ENGINE_NOT_READY_BEFORE_WINDOW");
  const engineObservation = JSON.parse(await readFile(readyFile, "utf8")); assert.equal(engineObservation.exitCode, 0);
  await wait(Date.parse(validUntil) - Date.now() - 3000);
  const runningBy = Date.now() + 3000;
  while ((await database.admin.query("SELECT status FROM finnor_os.capability_runs WHERE id=$1", [expiringId])).rows[0]?.status !== "RUNNING") {
    assert(Date.now() < runningBy, "EXPIRY_PROOF_WORKER_NOT_RUNNING"); await wait(20);
  }
  const blocker = new pg.Client({ connectionString: `postgres://finnor:finnor@127.0.0.1:${database.port}/finnor` }); await blocker.connect();
  let publicationBlocked = false;
  try {
    await blocker.query("BEGIN"); const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await blocker.query("SELECT id FROM finnor_os.capability_runs WHERE id=$1 FOR UPDATE", [expiringId]);
    await writeFile(releaseFile, "release unchanged actual engine stdout\n");
    while (Date.now() < Date.parse(validUntil)) {
      const blocked = await database.admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%capability_runs%' AND query LIKE '%FOR UPDATE%') AS blocked", [blockerPid]);
      if (blocked.rows[0]?.blocked === true) { publicationBlocked = true; break; } await wait(20);
    }
    assert(publicationBlocked, "EXPIRY_PROOF_DID_NOT_OBSERVE_PUBLICATION_LOCK");
    await wait(Date.parse(validUntil) - Date.now() + 50);
  } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  assert.equal(await expiringWorker, true); process.env.FINNOR_CAPABILITY_PYTHON = python;
  const expiredStored = await database.db.withTenant(f.tenant, async connection => {
    const { sql } = await import("drizzle-orm"); return (await connection.execute(sql`SELECT status,result,failure_code FROM finnor_os.capability_runs WHERE id=${expiringId}::uuid`)).rows[0];
  }, f.principal);
  assert.equal(expiredStored?.status, "FAILED"); assert.equal(expiredStored?.result, null); assert.equal(expiredStored?.failure_code, "PYWHY_S3_CURRENT_MODEL_EXPIRED");
  const expiredRead = await api(f, "read-pywhy-assessment", { runId: expiringId }, interventionPost); assert.equal(expiredRead.status, 404);
  const expiryProof = { validUntil, publicationBlocked, engineObservation, rendezvousSha256: createHash("sha256").update(wrapper).digest("hex"), ordinaryRoleStored: expiredStored, currentApiReadStatus: expiredRead.status, resultPublished: false };
  await writeFile(join(output, "s3-publication-expiry.json"), JSON.stringify(expiryProof, null, 2));
  observed = { runId: id, result, physical, officialModalRequests: protocol.requests.map((r: any) => r.method), allFixtureSandboxesTerminated: true, proposals, reservations, overBudget: refusedResult.run,
    nativeS3Pywhy: { runId: causalAcceptance.body.run.id, modelRef: f.model.ref, averageEffect: causalResult.estimation.averageEffect, expectedSyntheticEffect: 2, causalClaimEstablished: false, temporalModelStillCurrent: true, foreignModelRefused: true, expiryProof } };
} catch (caught) { error = String(caught); }
finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await database.stop(); provider.kill("SIGTERM"); await new Promise<void>(done => provider.once("exit", () => done())); }
const after = await cut(), sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after);
await writeFile(join(output, "results.json"), JSON.stringify({ schema: "finnor.shinka-native-e2e.v1", status: error || !sourcesUnchanged ? "FAIL" : "PASS", before, after, sourcesUnchanged, observed, error, fixtureLog,
  qualification: "REAL_NATIVE_S1_S3_S4_S5_API_ORDINARY_ROLE_DATABASE_CAPABILITY_QUEUE_WORKER_PINNED_SHINKA_AND_INDEPENDENT_ORIGINAL_S5_CHECKER; MODAL_IS_OFFICIAL_SDK_GRPC_FIXTURE_AND_NEVER_EXECUTES_CODE; LOCAL_MODEL_PROPOSAL_ONLY_NO_LIVE_ISOLATION_GENERALIZED_GAIN_OR_S8_ADMISSION" }, null, 2));
console.log(JSON.stringify({ output, error, sourcesUnchanged })); setTimeout(() => process.exit(error || !sourcesUnchanged ? 1 : 0), 2000);
