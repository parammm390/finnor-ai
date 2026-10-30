import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { captureMemoryProvider } from "./fixtures.mjs";
import { conversationNotes } from "./scenario.mjs";
import { createNativeOwnerDatabase } from "../s7/native-owner-database.mjs";

const output = resolve(process.env.FINNOR_MEMORY_EVIDENCE_DIR ?? "../memory-evidence", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const sourcePaths = [
  "packages/orchestration/src/conversation.ts", "packages/orchestration/src/conversation-kernel.ts",
  "packages/orchestration/src/planner.ts", "packages/orchestration/src/objective-loop.ts",
  "packages/db/index.ts", "packages/shared-types/src/conversation-context.ts", "scripts/memory/verification-plan.json"
];
const sources = await Promise.all(sourcePaths.map(async path => ({
  path, sha256: createHash("sha256").update(await readFile(path)).digest("hex")
})));
const cases: Array<{ id: string; status: "PASS" | "FAIL"; observed?: unknown; error?: string }> = [];
const prompts: Array<{ system: string; user: string }> = [];
async function save() {
  await writeFile(join(output, "results.json"), JSON.stringify({
    sources, cases, node: process.version, prompts,
    authentication: "Existing local-only header authentication, followed by real canonical employee validation and private DB RLS",
    provider: "Deterministic capture for transport; no comprehension claim",
    rerun: "node_modules/.bin/tsx scripts/memory/run-e2e.mts"
  }, null, 2));
}
async function check(id: string, run: () => Promise<unknown>) {
  if (process.env.FINNOR_MEMORY_CASES && !process.env.FINNOR_MEMORY_CASES.split(",").includes(id)) return;
  try { cases.push({ id, status: "PASS", observed: await run() }); }
  catch (error) { cases.push({ id, status: "FAIL", error: error instanceof Error ? error.message : String(error) }); }
  await save();
  process.stdout.write(JSON.stringify({ ...cases.at(-1), output }) + "\n");
}
Object.assign(process.env, {
  RATE_LIMIT_PER_MINUTE: "10000", RATE_LIMIT_INTAKE_PER_MINUTE: "10000",
  LLM_PROVIDER_ANSWER: "memory-e2e-capture", LLM_PROVIDER_PLANNING: "memory-e2e-capture", SECRETS_PROVIDER: "env"
});
delete process.env.ZEP_API_KEY;
delete process.env.REDIS_URL;
const database = await createNativeOwnerDatabase();
const { admin } = database;
process.env.LOG_LEVEL = "error";
const tenantId = randomUUID(), employeeId = randomUUID();
try {
  await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Memory disposable fixture')", [tenantId]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [employeeId, tenantId, employeeId + "@generated.invalid"]);
  await admin.query("SELECT finnor_os.ensure_legacy_authority($1)", [tenantId]);
  const { configureTenantVertical } = await import("../../packages/db/index");
  await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: employeeId, sourceSystem: "memory-e2e" });
  const { registerProvider } = await import("../../packages/tools/src/llm");
  const provider = () => captureMemoryProvider(prompt => prompts.push(prompt));
  registerProvider("memory-e2e-capture", provider);
  const { createRequire } = await import("node:module");
  createRequire(import.meta.url)("../../packages/tools/src/llm.ts").registerProvider("memory-e2e-capture", provider);
  const { createEmployeeConversationThread } = await import("../../packages/db/index");
  const thread = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Memory repair E2E" });
  const db = await import("../../packages/db/index");
  const memory = await import("../../packages/orchestration/src/conversation-memory");
  const { buildConversationModelInput } = await import("../../packages/orchestration/src/conversation-prompt");
  const ctx = { tenantId, employeeId, userId: employeeId, role: "owner" as const };
  const workerCapture = join(output, "worker-prompts.jsonl");
  async function workerOnce(mode = "compaction") {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/memory/worker-once.mts", mode], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: database.workerUrl, FINNOR_MEMORY_CAPTURE_FILE: workerCapture }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const exit = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
    assert.equal(exit, 0, stderr);
    return { pid: child.pid, stdout, stderr };
  }
  let checkpoint: Awaited<ReturnType<typeof db.readConversationCheckpoint>> = null;
  let finalResponse: unknown;

  const { POST } = await import("../../apps/api/app/api/actions/route");
  async function submit(instruction: string, selectedThread = thread.id) {
    const instructionId = randomUUID();
    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": employeeId },
      body: JSON.stringify({ instruction, instructionId, idempotencyKey: instructionId, threadId: selectedThread, channel: "text" })
    }));
    const body: unknown = await response.json();
    assert(response.ok, JSON.stringify({ status: response.status, body }));
    finalResponse = body;
    return body;
  }
  await check("answer-history-delivery", async () => {
    await submit("What is your understanding of this requirement: Atlas payment terms are 30 days?");
    await submit("What is your understanding of this correction: Atlas payment terms are 45 days, replacing 30 days?");
    await submit("What did I say about payment terms earlier?");
    const last = prompts.at(-1);
    assert(last, "The answer provider was never reached");
    assert(last.user.includes("Atlas payment terms are 45 days"), "Actual answer model input omitted the prior user correction");
    return { promptCount: prompts.length, threadId: thread.id, correctedSourceReachedModel: true };
  });
  await check("thirty-complete-exchanges", async () => {
    for (let index = 4; index <= 30; index++) {
      await submit("What is your understanding of note " + index + ": MEMORY_NOTE_" + index + " applies to Atlas analysis?");
    }
    const loaded = await db.loadEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, messageLimit: 100 });
    assert.equal(loaded?.messages.filter(message => message.role === "user").length, 30);
    assert.equal(loaded?.messages.filter(message => message.role === "assistant").length, 30);
    const last = prompts.at(-1);
    assert(last);
    for (let index = 4; index <= 30; index++) assert(last.user.includes("MEMORY_NOTE_" + index), "Missing note " + index);
    return { userExchanges: 30, totalPersistedMessages: loaded?.messages.length, allNotesReachedModel: true };
  });
  await check("repeated-compaction", async () => {
    process.env.FINNOR_MEMORY_COMPACTION_TRIGGER_TOKENS = "1";
    await admin.query("UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=3,minimum_claim_epoch=3,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,activated_release_sha=$1,activated_at=clock_timestamp() WHERE singleton", ["f80266f8e50356e8537bc3d4a4475a601225fc1e"]);
    await memory.scheduleConversationCompaction({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 60 });
    const workers = [];
    for (let index = 0; index < 10; index++) {
      const queued = await admin.query("SELECT count(*)::int AS n FROM finnor_os.jobs WHERE tenant_id=$1 AND type='compact_employee_conversation_v1' AND status='queued'", [tenantId]);
      if (!queued.rows[0].n) break;
      workers.push(await workerOnce());
    }
    const rows = await admin.query("SELECT id,from_sequence,through_sequence,parent_id FROM finnor_os.employee_conversation_checkpoints WHERE thread_id=$1 ORDER BY through_sequence", [thread.id]);
    assert(rows.rows.length >= 3, JSON.stringify(rows.rows));
    let previous = 0;
    for (const row of rows.rows) { assert.equal(row.from_sequence, previous + 1); previous = row.through_sequence; }
    checkpoint = await db.readConversationCheckpoint({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 60 });
    assert(checkpoint);
    const payment = checkpoint.items.filter(item => item.subject === "Atlas payment terms");
    assert(payment.some(item => item.statement.includes("45 days") && item.supersededBy === null));
    assert(payment.some(item => item.statement.includes("requirement: Atlas payment terms are 30 days") && item.supersededBy !== null));
    await submit("What did I say about payment terms earlier?");
    assert(prompts.at(-1)?.user.includes("45 days"));
    delete process.env.FINNOR_MEMORY_COMPACTION_TRIGGER_TOKENS;
    return { checkpoints: rows.rows, workers, currentCorrectionRetained: true };
  });
  await check("reload-and-private-isolation", async () => {
    const { GET } = await import("../../apps/api/app/api/threads/[id]/route");
    const headers = { "x-tenant-id": tenantId, "x-user-id": employeeId };
    const reloaded = await GET(new Request("http://localhost/api/threads/" + thread.id, { headers }), { params: Promise.resolve({ id: thread.id }) });
    assert.equal(reloaded.status, 200);
    const loaded: unknown = await reloaded.json();
    assert(JSON.stringify(loaded).includes("Atlas payment terms are 45 days"));
    const peer = randomUUID();
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [peer, tenantId, peer + "@generated.invalid"]);
    const denied = await GET(new Request("http://localhost/api/threads/" + thread.id, { headers: { ...headers, "x-user-id": peer } }), { params: Promise.resolve({ id: thread.id }) });
    assert.equal(denied.status, 404);
    const otherTenant = randomUUID();
    await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Foreign memory tenant')", [otherTenant]);
    assert.equal(await db.readConversationCheckpoint({ tenantId: otherTenant, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 1000 }), null);
    assert.equal(await db.readConversationCheckpoint({ tenantId, ownerEmployeeId: peer, threadId: thread.id, throughSequence: 1000 }), null);
    assert.deepEqual(await db.searchConversationEvidence({ tenantId, ownerEmployeeId: peer, threadId: thread.id, throughSequence: 1000, terms: ["payment"] }), []);
    return { reloadStatus: reloaded.status, peerStatus: denied.status, sourceAndCheckpointIsolation: true };
  });
  await check("concurrent-sequence-fence", async () => {
    const concurrent = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Concurrent memory" });
    const { prepareEmployeeConversationTurn } = await import("../../packages/orchestration/src/conversation-kernel");
    const turns = await Promise.all(["EARLIER_PRIVATE_SOURCE", "LATER_PRIVATE_SOURCE"].map(instruction => prepareEmployeeConversationTurn({ ctx, threadId: concurrent.id, instruction, instructionId: randomUUID(), channel: "text" })));
    turns.sort((a, b) => a.userMessage.sequence - b.userMessage.sequence);
    const first = turns[0], second = turns[1]; assert(first && second);
    const prompt = await buildConversationModelInput({ provider: provider(), system: "Source fidelity check", required: { instruction: first.userMessage.originalText }, conversation: first.context });
    assert(!prompt.user.includes(second.userMessage.originalText), "A future concurrent turn entered the earlier model request");
    assert(first.context.exactRecentMessages.every(message => message.sequence <= first.userMessage.sequence));
    return { sequenceCuts: turns.map(turn => turn.userMessage.sequence), futureSourceExcluded: true };
  });
  await check("model-budget", async () => {
    const ids = z.object({ workId: z.string(), workInputId: z.string() }).parse(finalResponse);
    const context = await memory.loadWorkInputConversation({ ctx, ...ids }); assert(context);
    const { countPromptTokensUpperBound } = await import("../../packages/tools/src/model-context");
    const small = { ...provider(), contextWindowTokens: 32000 };
    const prompt = await buildConversationModelInput({ provider: small, system: "Budgeted source fidelity", required: { instruction: "Recall the terms", authority: { principal: employeeId, revision: 17 } }, conversation: context });
    assert(countPromptTokensUpperBound(prompt.system) + countPromptTokensUpperBound(prompt.user) + 1024 + (prompt.maxOutputTokens ?? 0) <= 32000);
    assert(prompt.user.includes("45 days")); assert(prompt.user.includes('"revision":17'));
    await assert.rejects(buildConversationModelInput({ provider: { ...provider(), contextWindowTokens: 2000 }, system: "Budgeted source fidelity", required: { instruction: "Recall the terms", authority: { principal: employeeId } }, conversation: context }), /Conversation context cannot fit/);
    await assert.rejects(buildConversationModelInput({ provider: { name: "unknown-model", complete: async () => "unused" }, system: "", required: {}, conversation: context }), /UNKNOWN_CAPACITY/);
    const { resolveProviderForPurpose } = await import("../../packages/tools/src/llm");
    let smallCalls = 0, largeCalls = 0;
    registerProvider("memory-e2e-small", () => ({ ...provider(), contextWindowTokens: 2000, complete: async () => { smallCalls++; throw new Error("Undersized fallback must not be called"); } }));
    registerProvider("memory-e2e-large", () => ({ ...provider(), complete: async () => { largeCalls++; return "larger configured provider reached"; } }));
    process.env.LLM_PROVIDER_CRITIC = "memory-e2e-small";
    process.env.LLM_FALLBACKS_CRITIC = "memory-e2e-large";
    const routed = resolveProviderForPurpose("critic", "text");
    const { provider: fitted, ...fittedPrompt } = await buildConversationModelInput({ provider: routed, system: "Required canonical state " + "X".repeat(32000), required: { instruction: "Recall terms", authority: { principal: employeeId } }, conversation: context });
    assert.equal(await fitted.complete({ ...fittedPrompt, tenantId, purpose: "critic", channel: "text" }), "larger configured provider reached");
    assert.equal(smallCalls, 0); assert.equal(largeCalls, 1);
    delete process.env.LLM_PROVIDER_CRITIC; delete process.env.LLM_FALLBACKS_CRITIC;
    return { configuredCapacity: 32000, fullRequestBound: countPromptTokensUpperBound(prompt.system) + countPromptTokensUpperBound(prompt.user) + 1024 + (prompt.maxOutputTokens ?? 0), correctedSourceAndAuthorityRetained: true, overflowAndUnknownCapacityRejected: true };
  });
  await check("compaction-negative-and-immutable-source", async () => {
    const isolated = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Invalid compaction" });
    const message = await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: isolated.id, role: "user", channel: "text", originalText: "The approved term is 17 days.", idempotencyKey: randomUUID() });
    const assistant = await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: isolated.id, role: "assistant", channel: "text", originalText: "I suggested an unverified action.", idempotencyKey: randomUUID() });
    const cut = { tenantId, ownerEmployeeId: employeeId, threadId: isolated.id, throughSequence: 2 };
    const invalid = { ...provider(), complete: async () => JSON.stringify({ narrative: "invalid", items: [{ kind: "constraint", subject: "term", statement: "Invented 99 days", sources: [{ messageId: "m999" }], supersedes: [] }] }) };
    await assert.rejects(memory.compactEmployeeConversation(cut, { provider: invalid, reviewer: provider() }), /quote_invalid/);
    assert.equal(await db.readConversationCheckpoint(cut), null);
    const rejectReview = { ...provider(), complete: async () => JSON.stringify({ approved: false, issues: ["omitted qualifier"] }) };
    await assert.rejects(memory.compactEmployeeConversation(cut, { provider: provider(), reviewer: rejectReview }), /semantic_review_failed/);
    assert.equal(await db.readConversationCheckpoint(cut), null);
    const inventedNumber = { ...provider(), complete: async () => JSON.stringify({ narrative: "Exact original retained", items: [{ kind: "constraint", subject: "term", statement: "Invented 99 days", sources: [{ messageId: "m1" }], supersedes: [] }] }) };
    assert.equal((await memory.compactEmployeeConversation(cut, { provider: inventedNumber, reviewer: provider() })).status, "published");
    const exact = await db.readConversationCheckpoint(cut); assert(exact);
    assert.equal(exact.items[0]?.statement, "The approved term is 17 days.");
    assert(!JSON.stringify(exact.items).includes("99 days"));
    const temporal = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Relative date provenance" });
    const temporalSource = await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: temporal.id, role: "user", channel: "text", originalText: "The risk review is due tomorrow, relative to this message in UTC.", idempotencyKey: randomUUID() });
    await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: temporal.id, role: "assistant", channel: "text", originalText: "This is an unverified draft deadline.", idempotencyKey: randomUUID() });
    const inferredDate = { ...provider(), complete: async () => JSON.stringify({ narrative: "Relative deadline retained", items: [{ kind: "constraint", subject: "risk review", statement: "Review is due 2026-10-30", sources: [{ messageId: "m1" }], supersedes: [] }] }) };
    const temporalCut = { ...cut, threadId: temporal.id };
    assert.equal((await memory.compactEmployeeConversation(temporalCut, { provider: inferredDate, reviewer: provider() })).status, "published");
    const retainedDate = await db.readConversationCheckpoint(temporalCut); assert(retainedDate);
    assert.equal(retainedDate.items[0]?.statement, temporalSource.message.originalText);
    assert.equal(retainedDate.items[0]?.sources[0]?.recordedAt, temporalSource.message.createdAt);
    await assert.rejects(db.withTenant(tenantId, async connection => { const { sql } = await import("drizzle-orm"); await connection.execute(sql`UPDATE finnor_os.employee_conversation_messages SET original_text='tampered' WHERE id=${message.message.id}`); }, employeeId), /Failed query/);
    await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1", [employeeId]);
    await assert.rejects(memory.compactEmployeeConversation(cut, { provider: provider(), reviewer: provider() }), /owner_not_active/);
    await admin.query("UPDATE finnor_os.users SET status='active' WHERE id=$1", [employeeId]);
    return { invalidQuoteAndReviewRejected: true, synthesizedQuantityReplacedByExactSource: true, relativeDateAndOriginalTimestampPreserved: true, originalMessageImmutable: true, revokedOwnerRejected: true };
  });
  await check("frozen-work-input-binding", async () => {
    const ids = z.object({ workId: z.string(), workInputId: z.string() }).parse(finalResponse);
    const oldContext = await memory.loadWorkInputConversation({ ctx, ...ids }); assert(oldContext);
    await submit("What is your understanding of this unrelated topic: FUTURE_ONLY_VALUE_999?");
    const reloaded = await memory.loadWorkInputConversation({ ctx, ...ids }); assert(reloaded);
    assert.equal(reloaded.memory?.binding.throughSequence, oldContext.memory?.binding.throughSequence);
    assert(!JSON.stringify(reloaded.exactRecentMessages).includes("FUTURE_ONLY_VALUE_999"));
    assert(!JSON.stringify(reloaded.memory?.checkpoint).includes("FUTURE_ONLY_VALUE_999"));
    const bound = reloaded.memory?.binding; assert(bound);
    await assert.rejects(db.updateEmployeeConversationMessageContext({ tenantId, ownerEmployeeId: employeeId, threadId: bound.threadId, messageId: bound.inputMessageId, workInputId: null }), /Failed query/);
    return { immutableAcceptedSequence: bound.throughSequence, laterTopicExcluded: true, bindingRemovalRejected: true };
  });
  await check("empty-extraction-preserves-original-user-evidence", async () => {
    const isolated = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Original source preservation" });
    const originals = ["Keep the collection period at 45 days.", "No supplier email has been sent."];
    for (const originalText of originals) await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: isolated.id, role: "user", channel: "text", originalText, idempotencyKey: randomUUID() });
    await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: isolated.id, role: "assistant", channel: "text", originalText: "These remain unverified user inputs.", idempotencyKey: randomUUID() });
    const empty = { ...provider(), complete: async () => JSON.stringify({ items: [], narrative: "No extracted items" }) };
    const cut = { tenantId, ownerEmployeeId: employeeId, threadId: isolated.id, throughSequence: 3 };
    assert.equal((await memory.compactEmployeeConversation(cut, { provider: empty, reviewer: provider() })).status, "published");
    const retained = await db.readConversationCheckpoint(cut); assert(retained);
    for (const text of originals) assert(retained.items.some(item => item.sources.some(source => source.role === "user" && source.quote === text)));
    const input = await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: isolated.id, role: "user", channel: "text", originalText: "What did we agree earlier?", idempotencyKey: randomUUID() });
    const loaded = await db.loadEmployeeConversationThread({ ...cut, throughSequence: 4 }); assert(loaded);
    const context = await memory.hydrateConversationMemory({ tenantId, input: input.message, context: {
      version: 1, ownerEmployeeId: employeeId, thread: loaded.thread, exactRecentMessages: loaded.messages,
      summary: null, olderRelevantMessages: [], personalMemories: [], zepFacts: [],
      resolution: { status: "none", originalInstruction: input.message.originalText, resolvedReferences: [], candidates: [], unresolvedExpressions: [], clarificationQuestion: null, consequential: false, senderIdentityRef: null, provenance: [] },
    } });
    const packed = await buildConversationModelInput({ provider: { ...provider(), contextWindowTokens: 32000 }, system: "Recall exact sources", required: { instruction: input.message.originalText }, conversation: context });
    for (const text of originals) assert(packed.user.includes(text));
    return { omittedUserSourcesPreserved: originals.length, bothSourcesReachModelAfterCompaction: true };
  });
  await check("all-quality-notes-use-read-only-conversation", async () => {
    const fixture = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Full quality input routing preflight" });
    for (const note of conversationNotes(randomUUID())) {
      const value = await submit("What is your understanding of this note (one short sentence): " + note, fixture.id);
      z.object({ answer: z.object({ readOnly: z.literal(true), intent: z.literal("conversation") }) }).parse(value);
    }
    const priorPrompts = prompts.length;
    const canonical = await submit("What is the current workforce status we discussed earlier?", fixture.id);
    z.object({ answer: z.object({ readOnly: z.literal(true), intent: z.literal("workforce_status") }) }).parse(canonical);
    assert.equal(prompts.length, priorPrompts, "A canonical status question was redirected to historical model memory");
    return { notes: 30, everyNoteReadOnly: true, historicalQualifierPreservesCanonicalRead: true };
  });
  await check("historical-task-continuation-preserves-action-intent", async () => {
    for (const instruction of [
      'What is your understanding of this note: The sentence says "review it and send the draft"; no action is requested.',
      'What is your understanding of this note "Please send the draft we discussed earlier"?',
    ]) {
      const quoted = await submit(instruction);
      z.object({ answer: z.object({ readOnly: z.literal(true), intent: z.literal("conversation") }) }).parse(quoted);
    }
    const observations = [];
    for (const instruction of ["Can you finish the financial model we discussed earlier?", "Can you share the draft we discussed earlier?", "What did we agree earlier: USD or EUR? Then share the draft."]) {
      const instructionId = randomUUID();
      const response = await POST(new Request("http://localhost/api/actions", { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": employeeId }, body: JSON.stringify({ instruction, instructionId, idempotencyKey: instructionId, threadId: thread.id, channel: "text" }) }));
      const raw: unknown = await response.json();
      assert(response.status === 503, JSON.stringify({ instruction, status: response.status, body: raw }));
      const value = z.object({ code: z.literal("worker_fleet_unavailable"), workId: z.uuid(), workInputId: z.uuid() }).parse(raw);
      assert.equal(response.status, 503);
      const input = await db.latestWorkInput(tenantId, value.workId); assert.equal(input?.instructionText, instruction);
      observations.push({ instruction, ...value, status: response.status });
    }
    return { quotedActionRemainsReadOnly: true, taskRequestsReachedWorkerAdmission: observations, qualification: "Routing and durable acceptance; no execution claim for the deliberately absent fixture fleet" };
  });
} finally {
  await save();
  await database.stop();
}
process.exitCode = cases.some(item => item.status === "FAIL") ? 1 : 0;
