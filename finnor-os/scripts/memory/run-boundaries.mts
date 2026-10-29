import { strict as assert } from "node:assert";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import pg from "pg";
import { createNativeOwnerDatabase } from "../s7/native-owner-database.mjs";
import { captureMemoryProvider } from "./fixtures.mjs";

const output = resolve(process.env.FINNOR_MEMORY_EVIDENCE_DIR ?? "../memory-evidence", "boundaries-" + new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const cases: Array<{ id: string; status: "PASS" | "FAIL"; observed?: unknown; error?: string }> = [];
const sources = await Promise.all([
  "packages/orchestration/src/conversation-memory.ts", "packages/db/conversation-memory.ts",
  "packages/orchestration/src/objective-loop.ts", "apps/api/app/api/works/[id]/objective/route.ts",
  "apps/worker/src/queue.ts", "scripts/memory/worker-once.mts", "scripts/memory/run-boundaries.mts",
].map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
const wait = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
async function check(id: string, run: () => Promise<unknown>) {
  if (process.env.FINNOR_MEMORY_CASES && !process.env.FINNOR_MEMORY_CASES.split(",").includes(id)) return;
  try { cases.push({ id, status: "PASS", observed: await run() }); }
  catch (error) {
    cases.push({ id, status: "FAIL", error: error instanceof Error ? error.message : String(error) });
    await writeFile(join(output, id + "-failure-state.json"), JSON.stringify({
      jobs: (await admin.query("SELECT id,type,status,attempts,last_error,run_at,lease_expires_at,payload FROM finnor_os.jobs ORDER BY accepted_at")).rows,
      objectives: (await admin.query("SELECT * FROM finnor_os.work_objective_loops")).rows,
      attempts: (await admin.query("SELECT * FROM finnor_os.work_planner_attempts")).rows,
    }, null, 2));
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ sources, cases, rerun: "node_modules/.bin/tsx scripts/memory/run-boundaries.mts", provider: "Deterministic transport fixture, not comprehension evidence", authentication: "Local-only header auth, real active employee, native Work/queue/worker roles and private Postgres RLS" }, null, 2));
  process.stdout.write(JSON.stringify({ ...cases.at(-1), output }) + "\n");
}
Object.assign(process.env, { LLM_PROVIDER_ANSWER: "memory-e2e-capture", LLM_PROVIDER_PLANNING: "memory-e2e-capture", SECRETS_PROVIDER: "env" });
delete process.env.REDIS_URL; delete process.env.ZEP_API_KEY;
const database = await createNativeOwnerDatabase();
const { admin, db } = database;
const tenantId = randomUUID(), employeeId = randomUUID();
const ctx = { tenantId, employeeId, userId: employeeId, role: "owner" as const };
const captureFile = join(output, "worker-prompts.jsonl");
const promptSchema = z.array(z.object({ system: z.string(), user: z.string() }));
async function prompts() {
  try { return promptSchema.parse((await readFile(captureFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function worker(mode = "compaction", marker?: { name: string; phase: "BEFORE" | "AFTER" }) {
  const markerPath = marker ? join(output, marker.name + ".json") : undefined;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/memory/worker-once.mts", mode], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: database.workerUrl, FINNOR_MEMORY_CAPTURE_FILE: captureFile,
      ...(markerPath ? { ["FINNOR_MEMORY_" + marker!.phase + "_PUBLICATION_MARKER"]: markerPath } : {}) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal })); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    if (markerPath) {
      let reached = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        try { const value = z.object({ pid: z.number() }).parse(JSON.parse(await readFile(markerPath, "utf8"))); assert.equal(value.pid, child.pid); reached = true; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await wait(100);
      }
      assert(reached, "Worker did not reach the requested crash boundary: " + stderr);
      child.kill("SIGKILL");
    }
    const result = await exited;
    await writeFile(join(output, "worker-" + child.pid + ".json"), JSON.stringify({ mode, ...result, stdout, stderr }, null, 2));
    assert(markerPath ? result.signal === "SIGKILL" : result.code === 0, JSON.stringify({ result, stderr }));
    return { pid: child.pid, ...result, stdout, stderr, markerPath };
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
try {
  await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Memory boundary fixture')", [tenantId]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [employeeId, tenantId, employeeId + "@generated.invalid"]);
  await admin.query("SELECT finnor_os.ensure_legacy_authority($1)", [tenantId]);
  await db.configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: employeeId, sourceSystem: "memory-boundaries" });
  await admin.query("UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=3,minimum_claim_epoch=3,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,activated_release_sha=$1,activated_at=clock_timestamp() WHERE singleton", ["f80266f8e50356e8537bc3d4a4475a601225fc1e"]);
  const llm = await import("../../packages/tools/src/llm");
  llm.registerProvider("memory-e2e-capture", captureMemoryProvider);
  createRequire(import.meta.url)("../../packages/tools/src/llm.ts").registerProvider("memory-e2e-capture", captureMemoryProvider);
  const memory = await import("../../packages/orchestration/src/conversation-memory");
  const { prepareEmployeeConversationTurn } = await import("../../packages/orchestration/src/conversation-kernel");
  const { startWorkObjective } = await import("../../packages/orchestration/src/objective-loop");
  for (const phase of ["BEFORE", "AFTER"] as const) await check("worker-crash-" + phase.toLowerCase() + "-publication", async () => {
    const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Physical process termination " + phase });
    for (const role of ["user", "assistant"] as const) await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role, channel: "text", originalText: role === "user" ? "The term is 17 days." : "This is an unverified draft.", idempotencyKey: randomUUID() });
    const cut = { tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 2 };
    const key = "memory-crash:" + thread.id;
    await db.enqueueJob("compact_employee_conversation_v1", cut, key);
    const crashed = await worker("compaction", { phase, name: phase.toLowerCase() + "-publication" });
    const checkpointBeforeRecovery = await db.readConversationCheckpoint(cut);
    assert.equal(Boolean(checkpointBeforeRecovery), phase === "AFTER");
    const [running] = (await admin.query("SELECT id,status,lease_expires_at FROM finnor_os.jobs WHERE idempotency_key=$1", [key])).rows;
    assert.equal(running.status, "running");
    await wait(4000);
    const recovered = await worker();
    const rows = (await admin.query("SELECT id,through_sequence FROM finnor_os.employee_conversation_checkpoints WHERE thread_id=$1", [thread.id])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].through_sequence, 2);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM finnor_os.employee_conversation_messages WHERE thread_id=$1", [thread.id])).rows[0].n, 2);
    const [finished] = (await admin.query("SELECT status FROM finnor_os.jobs WHERE id=$1", [running.id])).rows;
    assert.equal(finished.status, "completed");
    return { crashed, recovered, jobId: running.id, oneCheckpoint: rows[0], sourceMessagesRetained: 2 };
  });
  await check("new-input-recovers-no-op-compaction", async () => {
    process.env.FINNOR_MEMORY_COMPACTION_TRIGGER_TOKENS = "1";
    const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "No-op scheduling" });
    for (let index = 1; index <= 9; index++) await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: index % 2 ? "user" : "assistant", channel: "text", originalText: "Immutable scheduling source " + index, idempotencyKey: randomUUID() });
    const cut = { tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 9 };
    await memory.scheduleConversationCompaction(cut); await worker();
    assert.equal(await db.readConversationCheckpoint(cut), null);
    await db.appendEmployeeConversationMessage({ ...cut, role: "assistant", channel: "text", originalText: "The exchange is now complete.", idempotencyKey: randomUUID() });
    await memory.scheduleConversationCompaction({ ...cut, throughSequence: 10 }); await worker();
    const published = await db.readConversationCheckpoint({ ...cut, throughSequence: 10 }); assert(published);
    assert.equal(published.throughSequence, 2);
    delete process.env.FINNOR_MEMORY_COMPACTION_TRIGGER_TOKENS;
    return { noOpDidNotBlockNewCut: true, throughSequence: published.throughSequence };
  });
  for (const mode of ["objective", "objective-compat"] as const) await check(mode + "-fresh-worker-and-redirect", async () => {
    const organizationId = randomUUID(), dealId = randomUUID();
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name) VALUES($1,$2,$3,'Memory synthetic target')", [organizationId, tenantId, "memory-" + dealId]);
    await admin.query("INSERT INTO finnor_os.pe_deals(id,tenant_id,target_organization_id,name,deal_lead_employee_id,signed_loi_at,target_closing_at,source_system,created_by) VALUES($1,$2,$3,'Memory fixture Atlas',$4,now(),now()+interval '30 days','memory-fixture',$4::uuid::text)", [dealId, tenantId, organizationId, employeeId]);
    const activeContext = { version: 1 as const, capturedAt: new Date().toISOString(), source: "text" as const,
      businessRoot: { entityType: "pe_deal" as const, entityId: dealId }, selectedEntities: [], excludedEntities: [], surface: { id: "centropy" as const }, filters: [] };
    const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: mode });
    await prepareEmployeeConversationTurn({ ctx, threadId: thread.id, instruction: "Atlas payment terms are 45 days. Keep exact artifact MEMORY_ARTIFACT_A.", instructionId: randomUUID(), channel: "text" });
    const instruction = "Reconcile Atlas assumptions with the retained constraints and identify unresolved inconsistencies.";
    const instructionId = randomUUID();
    const turn = await prepareEmployeeConversationTurn({ ctx, threadId: thread.id, instruction, instructionId, channel: "text" });
    const objective = await startWorkObjective(instruction, ctx, { instructionId, conversationContext: turn.context, activeContext, channel: "text" });
    await prepareEmployeeConversationTurn({ ctx, threadId: thread.id, instruction: "FUTURE_UNRELATED_VALUE_999 must not enter the accepted task.", instructionId: randomUUID(), channel: "text" });
    const offset = (await prompts()).length;
    const fresh = await worker(mode);
    const planning = (await prompts()).slice(offset).filter(prompt => prompt.user.includes('"conversation"'));
    assert(planning.length, "Fresh worker never reached the bound planner");
    assert(planning.every(prompt => prompt.user.includes("MEMORY_ARTIFACT_A") && !prompt.user.includes("FUTURE_UNRELATED_VALUE_999")));
    const bound = JSON.parse(planning[0]!.user).conversation;
    assert.equal(bound.throughSequence, turn.userMessage.sequence);
    assert(planning[0]!.user.includes("45 days"));
    const { POST } = await import("../../apps/api/app/api/works/[id]/objective/route");
    const redirectId = randomUUID();
    const response = await POST(new Request("http://localhost/api/works/" + objective.workId + "/objective", { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": employeeId }, body: JSON.stringify({ command: "redirect", objective: "Reconcile the revised Atlas assumptions with the retained constraints.", instructionId: redirectId, idempotencyKey: redirectId }) }), { params: Promise.resolve({ id: objective.workId }) });
    const body: unknown = await response.json(); assert(response.ok, JSON.stringify({ status: response.status, body }));
    const latest = await db.latestWorkInput(tenantId, objective.workId); assert(latest && latest.id !== objective.workInputId);
    const redirectContext = await memory.loadWorkInputConversation({ ctx, workId: objective.workId, workInputId: latest.id }); assert(redirectContext);
    assert.equal(redirectContext.thread.id, thread.id);
    const frozen = redirectContext.memory?.binding.throughSequence; assert(frozen && frozen > turn.userMessage.sequence);
    await prepareEmployeeConversationTurn({ ctx, threadId: thread.id, instruction: "AFTER_REDIRECT_ONLY_888", instructionId: randomUUID(), channel: "text" });
    const restored = await memory.loadWorkInputConversation({ ctx, workId: objective.workId, workInputId: latest.id });
    assert.equal(restored?.memory?.binding.throughSequence, frozen);
    assert(!JSON.stringify(restored?.exactRecentMessages).includes("AFTER_REDIRECT_ONLY_888"));
    const redirectOffset = (await prompts()).length;
    const redirectWorker = await worker(mode);
    const redirectPrompts = (await prompts()).slice(redirectOffset).filter(prompt => prompt.user.includes('"conversation"'));
    assert(redirectPrompts.length, "Redirect worker never reached the bound planner");
    assert(redirectPrompts.every(prompt => !prompt.user.includes("AFTER_REDIRECT_ONLY_888")));
    assert.equal(JSON.parse(redirectPrompts[0]!.user).conversation.throughSequence, frozen);
    const peer = randomUUID();
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [peer, tenantId, peer + "@generated.invalid"]);
    await assert.rejects(memory.loadWorkInputConversation({ ctx: { ...ctx, employeeId: peer, userId: peer }, workId: objective.workId, workInputId: latest.id }), /principal_changed/);
    const { controlWorkObjective } = await import("../../packages/orchestration/src/objective-loop");
    await controlWorkObjective({ tenantId, workId: objective.workId, actorId: employeeId, command: "cancel" });
    return { freshWorker: fresh, redirectWorker, acceptedSequence: turn.userMessage.sequence, redirectSequence: frozen, sourceDelivered: true, laterSourceExcluded: true, changedPrincipalRejected: true };
  });
  await check("oversized-complete-exchange", async () => {
    const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Large complete exchange" });
    const originalText = "字".repeat(4094) + "123456" + "字".repeat(2406) + " exact ending remains available.";
    assert(Buffer.byteLength(originalText) > 18000);
    await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: "user", channel: "text", originalText, idempotencyKey: randomUUID() });
    await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: "assistant", channel: "text", originalText: "The source remains an unverified draft.", idempotencyKey: randomUUID() });
    const provider = captureMemoryProvider();
    const result = await memory.compactEmployeeConversation({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 2 }, {
      provider: { ...provider, async complete(options) {
        if (!options.system.startsWith("Extract an incremental")) return provider.complete(options);
        const input = z.object({ messages: z.array(z.object({ id: z.string(), role: z.string() })) }).parse(JSON.parse(options.user));
        return JSON.stringify({ narrative: "Large exact source", items: [{ kind: "constraint", subject: "Exact count", statement: "Exact count is 123456", sources: input.messages.filter(message => message.role === "user").map(message => ({ messageId: message.id })), supersedes: [] }] });
      } }, reviewer: provider,
    });
    assert.equal(result.status, "published"); assert.equal(result.throughSequence, 2);
    const checkpoint = await db.readConversationCheckpoint({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 2 });
    assert.equal(checkpoint?.items[0]?.sources.map(source => source.quote).join(""), originalText);
    return { originalBytes: Buffer.byteLength(originalText), result, completeExchangeAdvanced: true, numericLiteralAcrossNaiveChunkBoundaryPreserved: true };
  });
  await check("future-carried-target-excluded", async () => {
    const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Future target fence" });
    const instructionId = randomUUID(), organizationId = randomUUID();
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name) VALUES($1,$2,$3,'Later target')", [organizationId, tenantId, "later-" + organizationId]);
    const original = await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: "user", channel: "text", originalText: "Email him", instructionId, idempotencyKey: "user:" + instructionId });
    const later = await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: "user", channel: "text", originalText: "The later selected target", instructionId: randomUUID(), idempotencyKey: randomUUID() });
    const target = { entityType: "external_organization", entityId: organizationId, label: "Later target", source: "explicit_context", sourceMessageId: later.message.id, mentionedAtSequence: later.message.sequence };
    await db.updateEmployeeConversationThreadContext({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, activeReferences: [target] });
    const retried = await prepareEmployeeConversationTurn({ ctx, threadId: thread.id, instruction: "Email him", instructionId, channel: "text" });
    assert.equal(retried.userMessage.sequence, original.message.sequence);
    assert.equal(retried.context.resolution.status, "clarification_required");
    assert.deepEqual(retried.context.resolution.resolvedReferences, []);
    const retained = await db.loadEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, messageLimit: 1 });
    assert(retained?.thread.activeReferences.some(ref => ref.sourceMessageId === later.message.id), "Older retry overwrote the later reference projection");
    return { acceptedSequence: original.message.sequence, futureTargetSequence: later.message.sequence, targetNotInferred: true, laterProjectionPreserved: true };
  });
  await check("revoked-owner-fenced-at-publication", async () => {
    const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Owner revocation boundary" });
    for (const role of ["user", "assistant"] as const) await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role, channel: "text", originalText: role === "user" ? "The term is 17 days." : "This remains unverified.", idempotencyKey: randomUUID() });
    const blocker = new pg.Client({ connectionString: "postgres://finnor:finnor@127.0.0.1:" + database.port + "/finnor" });
    await blocker.connect();
    let revoking = false;
    const capture = captureMemoryProvider();
    const reviewer = { ...capture, async complete(options: Parameters<typeof capture.complete>[0]) {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1", [employeeId]);
      revoking = true;
      return capture.complete(options);
    } };
    const cut = { tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 2 };
    let settled = false;
    const publication = memory.compactEmployeeConversation(cut, { provider: capture, reviewer }).finally(() => { settled = true; });
    publication.catch(() => undefined);
    try {
      let lockObserved = false;
      for (let index = 0; index < 100; index++) {
        const locks = await admin.query("SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname='finnor' AND wait_event_type='Lock' AND query LIKE '%users%' AND pid<>pg_backend_pid()");
        if (revoking && locks.rows.length) { lockObserved = true; break; }
        await wait(50);
      }
      assert(lockObserved && !settled, "Publication did not wait on the real principal-row revocation");
      await blocker.query("COMMIT");
      await assert.rejects(publication, /owner_not_active/);
      assert.equal(await db.readConversationCheckpoint(cut), null);
      return { realPrincipalLockObserved: lockObserved, revokedPublicationRejected: true, sourceMessagesRetained: 2 };
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      await admin.query("UPDATE finnor_os.users SET status='active' WHERE id=$1", [employeeId]);
      await publication.catch(() => undefined);
    }
  });
  await check("legacy-work-and-migration-rerun", async () => {
    const legacy = await db.receiveWork({ tenantId, userId: employeeId, channel: "text", instruction: "Legacy input without private thread", instructionId: randomUUID() });
    assert.equal(await memory.loadWorkInputConversation({ ctx, workId: legacy.workId, workInputId: legacy.workInputId }), null);
    const { migrate } = await import("../../packages/db/migrate");
    const rerun = await migrate("postgres://finnor:finnor@127.0.0.1:" + database.port + "/finnor");
    return { legacyUnbound: true, migrationRerun: rerun, migrations: database.migrations };
  });
} finally { await database.stop(); }
process.exitCode = cases.some(item => item.status === "FAIL") ? 1 : 0;
