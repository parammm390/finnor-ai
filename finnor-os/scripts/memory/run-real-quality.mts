import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { z } from "zod";
import { ConversationMemoryCheckpointSchema } from "../../packages/shared-types/src/conversation-memory";
import { conversationNotes } from "./scenario.mjs";
import { createNativeOwnerDatabase } from "../s7/native-owner-database.mjs";

const output = resolve(process.env.FINNOR_MEMORY_EVIDENCE_DIR ?? "../memory-evidence",
  "real-" + new Date().toISOString().replaceAll(":", "-"));
const startedAt = Date.now();
const wait = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
let lastSubmissionAt = 0;
async function pace(milliseconds = 40000) {
  assert(Date.now() - startedAt < 1800_000, "Predeclared wall-clock limit reached");
  await wait(Math.max(0, lastSubmissionAt + milliseconds - Date.now()));
  lastSubmissionAt = Date.now();
}
await mkdir(output, { recursive: true });
const configurationSource = process.env.FINNOR_MEMORY_MODEL_ENV ?? "/Users/paramdave/FINNOR/finnor-os/.env";
const configuration = parse(await readFile(configurationSource));
const key = process.env.GROQ_API_KEY ?? configuration.GROQ_API_KEY;
assert(key?.startsWith("gsk_"), "An existing configured Groq credential is required");
const modelsResponse = await fetch("https://api.groq.com/openai/v1/models", {
  headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(8000),
});
assert.equal(modelsResponse.status, 200, "Configured model metadata is unavailable");
const models = z.object({ data: z.array(z.object({ id: z.string(), context_window: z.number() })) }).parse(await modelsResponse.json());
const selectedModel = process.env.FINNOR_MEMORY_MODEL ?? "openai/gpt-oss-120b";
const resumePath = process.env.FINNOR_MEMORY_RESUME_JOURNAL;
const journalPath = resumePath ?? process.env.FINNOR_MEMORY_PROBE_JOURNAL;
assert(!resumePath || !process.argv.includes("--compaction-probe"), "Resume and focused probe are separate modes");
assert(!journalPath || resumePath || process.argv.includes("--compaction-probe"), "A journal requires resume or focused probe mode");
const journalBytes = journalPath ? await readFile(journalPath) : undefined;
const journal = journalBytes ? z.object({
  artifactId: z.uuid(), messages: z.array(z.object({ role: z.enum(["user", "assistant"]), original_text: z.string() })),
}).parse(JSON.parse(journalBytes.toString("utf8"))) : undefined;
const resumedJournal = resumePath && journalBytes ? z.object({
  artifactId: z.uuid(), messages: z.array(z.object({ id: z.uuid(), sequence: z.number().int().positive(), role: z.enum(["user", "assistant"]), original_text: z.string(), created_at: z.string() })),
  checkpoints: z.array(z.object({ state: ConversationMemoryCheckpointSchema })),
}).parse(JSON.parse(journalBytes.toString("utf8"))) : undefined;
const resumed = resumedJournal ? { ...resumedJournal,
  messages: resumedJournal.messages.slice(0, Math.floor(resumedJournal.messages.length / 2) * 2),
  incompleteMessages: resumedJournal.messages.slice(Math.floor(resumedJournal.messages.length / 2) * 2),
} : undefined;
assert(models.data.some(model => model.id === selectedModel && model.context_window >= 131072), "The declared evaluation model/window is unavailable");
Object.assign(process.env, {
  GROQ_API_KEY: key, GROQ_MODEL: selectedModel, GROQ_FALLBACK_MODELS: "",
  LLM_PROVIDER_ANSWER: "memory-real", LLM_PROVIDER_CLASSIFICATION: "memory-real-review",
  RATE_LIMIT_PER_MINUTE: "10000", RATE_LIMIT_INTAKE_PER_MINUTE: "10000",
  FINNOR_MEMORY_COMPACTION_TRIGGER_TOKENS: "1",
});
delete process.env.ZEP_API_KEY;
delete process.env.REDIS_URL;
const database = await createNativeOwnerDatabase();
const { admin, db } = database;
const calls: Array<{ system: string; user: string; response?: string; attempts: unknown[]; usage: unknown; error?: string }> = [];
const cases: Array<{ id: string; status: "PASS" | "FAIL" | "NOT_RUN"; observed?: unknown; error?: string }> = [];
let physicalAttempts = 0;
const sources = await Promise.all([
  "packages/orchestration/src/conversation-memory.ts", "packages/orchestration/src/conversation-prompt.ts",
  "packages/orchestration/src/conversation.ts", "packages/tools/src/model-context.ts", "packages/tools/src/llm.ts",
  "packages/db/conversation-memory.ts", "scripts/memory/run-real-quality.mts",
].map(async path => {
  const bytes = await readFile(path);
  await mkdir(join(output, "source", path, ".."), { recursive: true });
  await writeFile(join(output, "source", path), bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
async function save() {
  await writeFile(join(output, "results.json"), JSON.stringify({
    cases, calls, sources, selectedModel, physicalAttempts, maximumPhysicalAttempts: 45,
    pacing: "40 seconds between input submissions; 61 seconds before each compaction. The reviewer and search expansion use the separately metered configured 20B model. Native request deadlines remain unchanged.",
    authentication: "Existing local-only header authentication with real canonical employee and private Postgres checks",
    modelMetadata: models.data.filter(model => [selectedModel, "openai/gpt-oss-20b"].includes(model.id)),
    rerun: "node_modules/.bin/tsx scripts/memory/run-real-quality.mts",
    scope: "Synthetic business conversation and final model interpretation; no production actions or financial-truth qualification",
    preservedJournal: journalPath && journalBytes ? { path: journalPath, sha256: createHash("sha256").update(journalBytes).digest("hex"), messages: journal?.messages.length } : null,
    lineage: resumed ? "Resume of recorded real API/model exchanges. Exact source IDs, sequence, text, timestamps and checked checkpoint state are restored into a new disposable owner scope. Prior native Work bindings are not restored or qualified by this reading test; fresh-worker binding has a separate E2E proof." : "Fresh transcript",
    excludedIncompleteSourceIds: resumed?.incompleteMessages.map(message => message.id) ?? [],
  }, null, 2));
}
async function check(id: string, run: () => Promise<unknown>, requiresTranscript = false) {
  if (requiresTranscript && !cases.some(item => item.id === "thirty-real-model-exchanges" && item.status === "PASS")) {
    cases.push({ id, status: "NOT_RUN", error: "Required thirty-exchange transcript did not complete" });
    await save(); return;
  }
  try { cases.push({ id, status: "PASS", observed: await run() }); }
  catch (error) { cases.push({ id, status: "FAIL", error: error instanceof Error ? error.message : String(error) }); }
  await save();
  process.stdout.write(JSON.stringify({ ...cases.at(-1), output }) + "\n");
}
const tenantId = randomUUID(), employeeId = randomUUID(), artifactId = resumed?.artifactId ?? randomUUID();
let qualityThreadId: string | undefined;
try {
  await admin.query("INSERT INTO finnor_os.tenants(id,name,timezone) VALUES($1,'Synthetic memory quality fixture','UTC')", [tenantId]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [employeeId, tenantId, employeeId + "@generated.invalid"]);
  await admin.query("SELECT finnor_os.ensure_legacy_authority($1)", [tenantId]);
  await db.configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: employeeId, sourceSystem: "memory-quality" });
  const { GroqProvider, registerProvider } = await import("../../packages/tools/src/llm");
  const factory = (model = selectedModel) => {
    const provider = new GroqProvider(key, model);
    return {
      name: provider.name,
      get qualificationIdentity() { return provider.qualificationIdentity; },
      get lastUsage() { return provider.lastUsage; },
      get lastAttempts() { return provider.lastAttempts; },
      async complete(options: Parameters<typeof provider.complete>[0]) {
        assert(physicalAttempts + 1 <= 45, "Predeclared physical model-attempt limit reached");
        const call: typeof calls[number] = { system: options.system, user: options.user, attempts: [], usage: null };
        calls.push(call);
        try { const response = await provider.complete(options); call.response = response; return response; }
        catch (error) { call.error = error instanceof Error ? error.name : String(error); throw error; }
        finally {
          call.attempts = provider.lastAttempts; call.usage = provider.lastUsage ?? null;
          physicalAttempts += Math.max(1, provider.lastAttempts.length); await save();
        }
      },
    };
  };
  registerProvider("memory-real", factory);
  registerProvider("memory-real-review", () => factory("openai/gpt-oss-20b"));
  const cjsProviders = createRequire(import.meta.url)("../../packages/tools/src/llm.ts");
  cjsProviders.registerProvider("memory-real", factory);
  cjsProviders.registerProvider("memory-real-review", () => factory("openai/gpt-oss-20b"));
  const { POST } = await import("../../apps/api/app/api/actions/route");
  const memory = await import("../../packages/orchestration/src/conversation-memory");
  const { parseModelJson } = await import("../../packages/orchestration/src/model-json");
  const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Real model memory quality" });
  qualityThreadId = thread.id;
  async function submit(instruction: string, interval = 40000) {
    await pace(interval);
    const instructionId = randomUUID();
    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": employeeId },
      body: JSON.stringify({ instruction, instructionId, idempotencyKey: instructionId, threadId: thread.id, channel: "text" }),
    }));
    const body: unknown = await response.json();
    assert(response.ok, JSON.stringify({ status: response.status, body }));
    return z.object({ answer: z.object({ spokenSummary: z.string() }) }).parse(body).answer.spokenSummary;
  }
  const notes = conversationNotes(artifactId);
  if (resumed) {
    assert(resumed.messages.length > 0 && resumed.messages.length <= 60 && resumed.messages.length % 2 === 0);
    for (const [index, message] of resumed.messages.entries()) {
      assert.equal(message.sequence, index + 1);
      assert.equal(message.role, index % 2 ? "assistant" : "user");
      if (message.role === "user") assert.equal(message.original_text, "What is your understanding of this note (one short sentence): " + notes[index / 2]);
      await admin.query(`INSERT INTO finnor_os.employee_conversation_messages
        (id,tenant_id,thread_id,owner_employee_id,sequence,role,channel,author_employee_id,original_text,idempotency_key,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'text',$7,$8,$9,$10)`,
        [message.id, tenantId, thread.id, employeeId, message.sequence, message.role, message.role === "user" ? employeeId : null, message.original_text, "restored:" + message.id, message.created_at]);
    }
    for (const message of resumed.incompleteMessages) {
      assert.equal(message.role, "user");
      assert.equal(message.sequence, resumed.messages.length + 1);
      assert.equal(message.original_text, "What is your understanding of this note (one short sentence): " + notes[resumed.messages.length / 2]);
    }
    for (const checkpoint of resumed.checkpoints) assert(await db.publishConversationCheckpoint({ ...checkpoint.state, tenantId, ownerEmployeeId: employeeId, threadId: thread.id }));
  }
  if (process.argv.includes("--compaction-probe")) {
    await check("real-compactor-protocol-probe", async () => {
      for (const message of journal?.messages ?? notes.flatMap(note => [
        { role: "user" as const, original_text: note },
        { role: "assistant" as const, original_text: "This remains a user-supplied, unverified draft input." },
      ])) {
        await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: message.role, channel: "text", originalText: message.original_text, idempotencyKey: randomUUID() });
      }
      const results = [];
      for (let index = 0; index < (journal ? 1 : 3); index++) {
        if (index) await pace(61000);
        results.push(await memory.compactEmployeeConversation({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: journal ? journal.messages.length - 8 : 52 }, { provider: factory(), reviewer: factory("openai/gpt-oss-20b") }));
        assert.equal(results.at(-1)?.status, "published");
        lastSubmissionAt = Date.now();
      }
      return { results, scope: "Direct compactor protocol and semantic review using synthetic persisted sources; no answer-path quality claim" };
    });
  } else {
  await check("thirty-real-model-exchanges", async () => {
    if (resumed && [20, 40, 60].includes(resumed.messages.length)) {
      const target = resumed.messages.length - 8;
      const checkpoint = await db.readConversationCheckpoint({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: target });
      const expectedCoverage = resumed.messages.length / 20 * 12;
      if ((checkpoint?.throughSequence ?? 0) < expectedCoverage) {
        const result = await memory.compactEmployeeConversation({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: target }, { provider: factory(), reviewer: factory("openai/gpt-oss-20b") });
        assert.equal(result.status, "published"); lastSubmissionAt = Date.now();
      }
    }
    for (const [index, note] of notes.entries()) {
      if (index < (resumed?.messages.length ?? 0) / 2) continue;
      await submit("What is your understanding of this note (one short sentence): " + note);
      if ([9, 19, 29].includes(index)) {
        await pace(61000);
        const loaded = await db.loadEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, messageLimit: 1 });
        const throughSequence = loaded?.messages.at(-1)?.sequence; assert(throughSequence);
        const compacted = await memory.compactEmployeeConversation({
          tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: throughSequence - 8,
        }, { provider: factory(), reviewer: factory("openai/gpt-oss-20b") });
        assert.equal(compacted.status, "published", JSON.stringify(compacted));
      }
      process.stdout.write(JSON.stringify({ completedUserExchanges: index + 1, physicalAttempts }) + "\n");
    }
    const rows = await admin.query("SELECT id,from_sequence,through_sequence,parent_id FROM finnor_os.employee_conversation_checkpoints WHERE thread_id=$1 ORDER BY through_sequence", [thread.id]);
    assert.equal(rows.rows.length, 3);
    return { userExchanges: notes.length, restoredRealExchanges: (resumed?.messages.length ?? 0) / 2, newlySubmittedExchanges: notes.length - (resumed?.messages.length ?? 0) / 2, checkpoints: rows.rows, physicalAttempts };
  });
  await check("corrected-financial-model-assumptions", async () => {
    const reply = await submit('What are the accepted Atlas assumptions we discussed earlier? Return only JSON with paymentTermDays, currency, discountRatePercent, annualRevenue, dayCountBasis, grossMarginPercent, ebitdaMarginPercent, artifactId, cashCollectionWorkingCapital. Calculate cashCollectionWorkingCapital as annualRevenue divided by dayCountBasis multiplied by paymentTermDays.', 61000);
    const model = z.object({ paymentTermDays: z.number(), currency: z.string(), discountRatePercent: z.number(), annualRevenue: z.number(),
      dayCountBasis: z.number(), grossMarginPercent: z.number(), ebitdaMarginPercent: z.number(), artifactId: z.string(),
      cashCollectionWorkingCapital: z.number() }).parse(parseModelJson(reply));
    assert.deepEqual(model, { paymentTermDays: 45, currency: "USD", discountRatePercent: 12, annualRevenue: 1200000,
      dayCountBasis: 360, grossMarginPercent: 60, ebitdaMarginPercent: 20, artifactId, cashCollectionWorkingCapital: 150000 });
    await writeFile(join(output, "financial-model-assumptions.json"), JSON.stringify(model, null, 2));
    return model;
  }, true);
  await check("unknown-fact-and-unverified-action", async () => {
    const reply = await submit('What did we establish earlier about supplier churn and the supplier email? Return only JSON with supplierChurnRate (number or null if unknown) and supplierEmailVerifiedSent (boolean). Use only evidence in the conversation.', 61000);
    const value = z.object({ supplierChurnRate: z.null(), supplierEmailVerifiedSent: z.literal(false) }).parse(parseModelJson(reply));
    return value;
  }, true);
  await check("paraphrased-topic-resumption", async () => {
    const reply = await submit('What settlement window did we agree for Atlas earlier, following the detour into Orion? Return only JSON {"days":number,"currency":"code"}.', 61000);
    const value = z.object({ days: z.literal(45), currency: z.literal("USD") }).parse(parseModelJson(reply));
    return value;
  }, true);
  await check("temporal-reference", async () => {
    const source = await admin.query("SELECT created_at FROM finnor_os.employee_conversation_messages WHERE thread_id=$1 AND role='user' AND original_text LIKE '%risk review is due tomorrow%'", [thread.id]);
    assert.equal(source.rows.length, 1);
    const expectedDate = new Date(new Date(source.rows[0].created_at).getTime() + 86400_000).toISOString().slice(0, 10);
    const reply = await submit('What calendar date did the earlier risk-review deadline refer to? Resolve tomorrow relative to its original message timestamp in UTC. Return only JSON {"date":"YYYY-MM-DD"}.', 61000);
    const value = z.object({ date: z.literal(expectedDate) }).parse(parseModelJson(reply));
    return { ...value, originalTimestamp: new Date(source.rows[0].created_at).toISOString() };
  }, true);
  }
} finally {
  await writeFile(join(output, "durable-memory.json"), JSON.stringify({
    threadId: qualityThreadId, artifactId,
    messages: (await admin.query("SELECT * FROM finnor_os.employee_conversation_messages WHERE thread_id=$1 ORDER BY sequence", [qualityThreadId])).rows,
    checkpoints: (await admin.query("SELECT * FROM finnor_os.employee_conversation_checkpoints WHERE thread_id=$1 ORDER BY through_sequence", [qualityThreadId])).rows,
  }, null, 2));
  await save(); await database.stop();
}
process.exitCode = cases.some(item => item.status === "FAIL") ? 1 : 0;
