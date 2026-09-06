// Planner repair-pass acceptance (Phase 7): real DB, real domain_actions row, real
// "repair" episode. The repair LLM call itself is mocked the same way
// critic-review.test.ts mocks the critic — BedrockOpenAICompatProvider is a plain
// fetch() call, so stubbing global fetch is the correct, narrow seam; this never
// spends a real Bedrock token in CI. The planner's OWN first LLM call is injected
// directly via LLMPlanner's constructor (a stub LLMProvider), so this suite never
// spends a real Groq token either.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { getPool, closePool, withTenant, domainActions } from "@finnor/db";
import { eq } from "drizzle-orm";
import { readEpisodes } from "@finnor/memory";
import { LLMPlanner, createDefaultPluginRegistry } from "@finnor/orchestration";
import type { LLMProvider } from "@finnor/orchestration";
import type { TenantContext, MemorySnapshot } from "@finnor/shared-types";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000f9"; // dedicated, isolated from other fixtures

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

function mockFetchOnce(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: { message: { content: [{ text: content }] } } }),
    }),
  );
}

/** A stub LLMProvider standing in for the planner's OWN first-pass call (Groq in
 *  production) — always returns a single fixed action so each test controls exactly
 *  what candidate action the repair pass has to work with. */
function stubPlannerProvider(actionType: string, payload: Record<string, unknown>, reasoning = "stub reasoning"): LLMProvider {
  return {
    name: "stub-planner",
    async complete() {
      return JSON.stringify({ actions: [{ action_type: actionType, payload, reasoning }] });
    },
  };
}

const emptyMemory = (): MemorySnapshot => ({ shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null });
const tenantContext = (): TenantContext => ({ tenantId: TENANT_ID, userId: "test-user", role: "owner" });

describe.skipIf(!available)("LLMPlanner repair pass", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await getPool().query(`INSERT INTO tenants (id, name) VALUES ($1, 'Planner Repair Test Tenant') ON CONFLICT (id) DO NOTHING`, [TENANT_ID]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  beforeEach(() => {
    delete process.env.AWS_BEDROCK_API_KEY;
    vi.unstubAllGlobals();
  });

  it("1. leaves an unambiguous action untouched — repaired:false logged, action_type unchanged", async () => {
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    mockFetchOnce('{"repaired": false, "actionType": "create_invoice", "payload": {"amountUsd": 450}, "reason": "Matches the instruction."}');
    const planner = new LLMPlanner(createDefaultPluginRegistry(), stubPlannerProvider("create_invoice", { amountUsd: 450 }));
    const [result] = await planner.plan("Create a $450 invoice for the Hendersons.", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("create_invoice");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const repair = episodes.find((e) => e.step === "repair");
    expect(repair).toBeTruthy();
    expect((repair!.output as Record<string, unknown>).repaired).toBe(false);
  });

  it("2. corrects an action_type, and the corrected type is what actually gets inserted", async () => {
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    // "Send the proposal to the Petersons" mis-drafted as the batch action — the
    // repair call corrects it back to send_proposal with a real-shaped proposalId.
    mockFetchOnce(
      '{"repaired": true, "actionType": "send_proposal", "payload": {"proposalId": "11111111-1111-4111-8111-111111111111"}, "reason": "Single household, not a batch send."}',
    );
    const planner = new LLMPlanner(
      createDefaultPluginRegistry(),
      stubPlannerProvider("send_proposal_to_recent_installs", {}),
    );
    const [result] = await planner.plan("Send the proposal to the Petersons for their quote.", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("send_proposal");
    expect((result!.payload as Record<string, unknown>).proposalId).toBe("11111111-1111-4111-8111-111111111111");

    // Assert the DB row itself, not just the in-memory return value.
    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, result!.id)));
    expect(row!.actionType).toBe("send_proposal");
    expect(row!.compiledGraph).toMatchObject({ commandType: "send_proposal" });
    // groundedPayload reflects the CORRECTED type's payload shape (proposalId is a
    // known-id field the compiler grounds) — not the original empty payload.
    const grounded = row!.groundedPayload as Array<{ field: string }>;
    expect(grounded.some((g) => g.field === "proposalId")).toBe(true);

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const repair = episodes.find((e) => e.step === "repair");
    expect((repair!.output as Record<string, unknown>).repaired).toBe(true);
    expect((repair!.output as Record<string, unknown>).actionType).toBe("send_proposal");
  });

  it("3. discards a correction whose payload fails the target plugin's validate()", async () => {
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    // Proposes send_proposal but forgets the required proposalId field entirely.
    mockFetchOnce('{"repaired": true, "actionType": "send_proposal", "payload": {}, "reason": "Should be a direct send."}');
    const planner = new LLMPlanner(createDefaultPluginRegistry(), stubPlannerProvider("answer_business_question", { question: "send the proposal" }));
    const [result] = await planner.plan("Send the proposal to the Petersons for their quote.", tenantContext(), emptyMemory());
    // Original survives — the correction is discarded, not silently kept broken.
    expect(result!.actionType).toBe("answer_business_question");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const repair = episodes.find((e) => e.step === "repair");
    expect((repair!.output as Record<string, unknown>).repaired).toBe(false);
    expect(String((repair!.output as Record<string, unknown>).reason)).toContain("failed validation");
  });

  it("4. clean no-op when AWS_BEDROCK_API_KEY isn't set — no network call attempted", async () => {
    // Deliberately no fetch stub installed at all — if repairAction() ever called
    // fetch() here, it would throw (real network access is blocked in tests).
    const planner = new LLMPlanner(createDefaultPluginRegistry(), stubPlannerProvider("create_invoice", { amountUsd: 450 }));
    const [result] = await planner.plan("Create a $450 invoice for the Hendersons.", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("create_invoice");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const repair = episodes.find((e) => e.step === "repair");
    expect((repair!.output as Record<string, unknown>).repaired).toBe(false);
    expect(String((repair!.output as Record<string, unknown>).reason)).toContain("not configured");
  });

  it("5. draftKnownAction() never produces a 'repair' episode (regression guard)", async () => {
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    // No fetch stub installed — if draftKnownAction's path ever called repairAction()
    // (or the planner's own LLM call), it would throw on the real network access
    // this test blocks. draftKnownAction() never calls plan() at all — it inserts
    // directly (packages/orchestration/src/index.ts:169) — this is a regression
    // guard for that structural guarantee, not a claim it's enforced here.
    const orchestration = await import("@finnor/orchestration");
    const orchestrator = new orchestration.FinnorOrchestrator();
    const { action } = await orchestrator.draftKnownAction("create_invoice", { amountUsd: 200 }, TENANT_ID, { source: "system_scan" });
    const episodes = await readEpisodes(TENANT_ID, { domainActionId: action.id });
    expect(episodes.some((e) => e.step === "repair")).toBe(false);
    expect(episodes.some((e) => e.step === "planned")).toBe(true);
  });

  it("6. real known failure pattern (unmocked, real LLM): single-household proposal send is no longer mis-drafted as the batch action", { timeout: 30000 }, async () => {
    // Needs BOTH a real planner provider (Groq) to reproduce the original
    // misdraft AND a real repair provider (Bedrock) to fix it — the
    // "single-household-not-batch" checklist rule is deliberately confidence:"low"
    // (a hint fed to the LLM call, not an auto-apply), so without a configured
    // repair LLM this scenario cannot be fixed and the test would just be
    // re-proving the known bug, not the fix. Skip gracefully rather than assert
    // something this environment has no credentials to prove either way.
    if (!process.env.GROQ_API_KEY || !process.env.AWS_BEDROCK_API_KEY) return;
    const planner = new LLMPlanner(createDefaultPluginRegistry());
    const [result] = await planner.plan("Send the proposal to the Petersons for their quote.", tenantContext(), emptyMemory());
    expect(result).toBeTruthy();
    expect(result!.actionType).not.toBe("send_proposal_to_recent_installs");
  });

  it("7. repairs one schema-invalid payload using the concrete validation error", async () => {
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    mockFetchOnce('{"repaired": true, "actionType": "create_invoice", "payload": {"amountUsd": 450}, "reason": "Added the required amount from the instruction."}');
    const planner = new LLMPlanner(createDefaultPluginRegistry(), stubPlannerProvider("create_invoice", {}));
    const [result] = await planner.plan("Create a $450 invoice for the Hendersons.", tenantContext(), emptyMemory());
    expect(result).toMatchObject({ actionType: "create_invoice", payload: { amountUsd: 450 } });
    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    expect(episodes.find((episode) => episode.step === "schema_repair")?.output).toMatchObject({ repaired: true });
  });

  it("8. fails loudly after its one invalid-payload repair attempt", async () => {
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    mockFetchOnce('{"repaired": true, "actionType": "create_invoice", "payload": {}, "reason": "Still missing the amount."}');
    const planner = new LLMPlanner(createDefaultPluginRegistry(), stubPlannerProvider("create_invoice", {}));
    await expect(planner.plan("Create an invoice.", tenantContext(), emptyMemory())).rejects.toThrow(/Schema repair failed for create_invoice after one attempt/);
  });

  it("9. safely routes read-only research when the planning provider times out", async () => {
    const unavailableProvider: LLMProvider = {
      name: "timed-out-planner",
      async complete() {
        throw new Error("LLM call deadline exceeded");
      },
    };
    const planner = new LLMPlanner(createDefaultPluginRegistry(), unavailableProvider);
    const instruction = "Research the latest U.S. residential water softener market and cite three sources.";
    const [result] = await planner.plan(instruction, tenantContext(), emptyMemory());
    expect(result).toMatchObject({ actionType: "search_web", payload: { query: instruction } });
  });

  it("10. still fails closed for a mutation when the planning provider times out", async () => {
    const unavailableProvider: LLMProvider = {
      name: "timed-out-planner",
      async complete() {
        throw new Error("LLM call deadline exceeded");
      },
    };
    const planner = new LLMPlanner(createDefaultPluginRegistry(), unavailableProvider);
    await expect(
      planner.plan("Call every inactive customer with a discount.", tenantContext(), emptyMemory()),
    ).rejects.toThrow("Planner LLM call failed: LLM call deadline exceeded");
  });
});
