// Risk-tiered reasoning depth acceptance (Phase 8): real DB, real domain_actions row,
// real "reasoning_tier" episode on every action. The repair LLM call is mocked the
// same way critic-review.test.ts / planner-repair.test.ts mock it — stubbing global
// fetch, since BedrockOpenAICompatProvider is a plain fetch() call. The planner's own
// first-pass call AND the high-tier second-candidate call are both injected directly
// via LLMPlanner's constructor, so this suite never spends a real Groq token either.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { getPool, closePool, withTenant, domainPolicies, domainPolicyRevisions } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { readEpisodes } from "@finnor/memory";
import { LLMPlanner, createDefaultPluginRegistry } from "@finnor/orchestration";
import type { LLMProvider } from "@finnor/orchestration";
import type { TenantContext, MemorySnapshot } from "@finnor/shared-types";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000fa"; // dedicated, isolated from other fixtures

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

function stubPlannerProvider(actionType: string, payload: Record<string, unknown>, reasoning = "stub reasoning"): LLMProvider {
  return {
    name: "stub-planner",
    async complete() {
      return JSON.stringify({ actions: [{ action_type: actionType, payload, reasoning }] });
    },
  };
}

function stubSecondCandidateProvider(actionType: string, payload: Record<string, unknown>): LLMProvider {
  return {
    name: "stub-second-candidate",
    async complete() {
      return JSON.stringify({ action_type: actionType, payload });
    },
  };
}

/** Throws if ever called — a safety net proving a tier that shouldn't generate a
 *  second candidate never does. */
const neverCalledProvider: LLMProvider = {
  name: "never-called",
  async complete() {
    throw new Error("secondCandidateProvider should never be called for this tier");
  },
};

/** Updates the existing row for this (tenant, actionType) in place rather than
 *  delete+insert — several tests below reuse "create_invoice" with different
 *  requiresConfirmation/policy combinations, and an earlier test's inserted
 *  domain_actions row already references that policy row via policyId (FK), so
 *  deleting it would violate domain_actions_policy_id_fkey. domain_policies also has
 *  no unique constraint on (tenant, actionType), so without reusing the same row a
 *  later test's Map lookup in planner.ts would nondeterministically pick whichever
 *  duplicate the DB happened to return last. */
async function setPolicy(actionType: string, requiresConfirmation: boolean, policy: Record<string, unknown> = {}) {
  await withTenant(TENANT_ID, async (db) => {
    const [existing] = await db
      .select({ id: domainPolicies.id, version: domainPolicies.version })
      .from(domainPolicies)
      .where(and(eq(domainPolicies.tenantId, TENANT_ID), eq(domainPolicies.actionType, actionType)));
    if (existing) {
      const [updated] = await db
        .update(domainPolicies)
        .set({ requiresConfirmation, policy, version: existing.version + 1, effectiveFrom: new Date() })
        .where(eq(domainPolicies.id, existing.id))
        .returning();
      await db.insert(domainPolicyRevisions).values({
        tenantId: TENANT_ID,
        policyId: updated!.id,
        actionType,
        version: updated!.version,
        policy: updated!.policy,
        requiresConfirmation: updated!.requiresConfirmation,
        confirmationTemplate: updated!.confirmationTemplate,
        modelProvider: updated!.modelProvider,
        confirmationTimeoutHours: updated!.confirmationTimeoutHours,
        effectiveFrom: updated!.effectiveFrom,
      });
    } else {
      const [created] = await db
        .insert(domainPolicies)
        .values({ tenantId: TENANT_ID, actionType, requiresConfirmation, policy })
        .returning();
      await db.insert(domainPolicyRevisions).values({
        tenantId: TENANT_ID,
        policyId: created!.id,
        actionType,
        version: created!.version,
        policy: created!.policy,
        requiresConfirmation: created!.requiresConfirmation,
        confirmationTemplate: created!.confirmationTemplate,
        modelProvider: created!.modelProvider,
        confirmationTimeoutHours: created!.confirmationTimeoutHours,
        effectiveFrom: created!.effectiveFrom,
      });
    }
  });
}

const emptyMemory = (): MemorySnapshot => ({ shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null });
const tenantContext = (): TenantContext => ({ tenantId: TENANT_ID, userId: "test-user", role: "owner" });

describe.skipIf(!available)("LLMPlanner reasoning tier", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await getPool().query(`INSERT INTO tenants (id, name) VALUES ($1, 'Reasoning Tier Test Tenant') ON CONFLICT (id) DO NOTHING`, [TENANT_ID]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  beforeEach(() => {
    delete process.env.AWS_BEDROCK_API_KEY;
    vi.unstubAllGlobals();
  });

  it("1. requiresConfirmation:false takes the low path — no repair episode, tier:low, candidateBGenerated:false", async () => {
    await setPolicy("check_stock_level", false);
    const planner = new LLMPlanner(createDefaultPluginRegistry(), stubPlannerProvider("check_stock_level", {}), neverCalledProvider);
    const [result] = await planner.plan("How many RO membranes do we have?", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("check_stock_level");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    expect(episodes.some((e) => e.step === "repair")).toBe(false);
    const tierEpisode = episodes.find((e) => e.step === "reasoning_tier");
    expect(tierEpisode).toBeTruthy();
    expect((tierEpisode!.output as Record<string, unknown>).tier).toBe("low");
    expect((tierEpisode!.output as Record<string, unknown>).candidateBGenerated).toBe(false);
  });

  it("2. $50 invoice (below default $500 threshold, requiresConfirmation:true) is medium — repair runs, no candidate B", async () => {
    await setPolicy("create_invoice", true);
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    mockFetchOnce('{"repaired": false, "actionType": "create_invoice", "payload": {"amountUsd": 50}, "reason": "Matches the instruction."}');
    const planner = new LLMPlanner(
      createDefaultPluginRegistry(),
      stubPlannerProvider("create_invoice", { amountUsd: 50 }),
      neverCalledProvider,
    );
    const [result] = await planner.plan("Create a $50 invoice for the Hendersons.", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("create_invoice");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const tierEpisode = episodes.find((e) => e.step === "reasoning_tier");
    expect((tierEpisode!.output as Record<string, unknown>).tier).toBe("medium");
    expect((tierEpisode!.output as Record<string, unknown>).candidateBGenerated).toBe(false);
    const repairEpisode = episodes.find((e) => e.step === "repair");
    expect(repairEpisode).toBeTruthy();
    expect((repairEpisode!.output as Record<string, unknown>).repaired).toBe(false);
  });

  it("3. $5,000 invoice (above threshold) is high — candidate B generated, both scored, winner logged", async () => {
    await setPolicy("create_invoice", true);
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    mockFetchOnce('{"repaired": false, "actionType": "create_invoice", "payload": {"amountUsd": 5000}, "reason": "Matches the instruction."}');
    const planner = new LLMPlanner(
      createDefaultPluginRegistry(),
      stubPlannerProvider("create_invoice", { amountUsd: 5000 }),
      stubSecondCandidateProvider("create_invoice", { amountUsd: 5000 }),
    );
    const [result] = await planner.plan("Create a $5,000 invoice for the Hendersons.", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("create_invoice");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const tierEpisode = episodes.find((e) => e.step === "reasoning_tier");
    const output = tierEpisode!.output as Record<string, unknown>;
    expect(output.tier).toBe("high");
    expect(output.candidateBGenerated).toBe(true);
    expect(output.scoreA).not.toBeNull();
    expect(output.scoreB).not.toBeNull();
    expect(["A", "B"]).toContain(output.winner);
    // High tier always repair-passes the winner too — two different failure modes.
    expect(episodes.some((e) => e.step === "repair")).toBe(true);
  });

  it("4. a workflow-tagged action type is high regardless of amount — the compiledGraph.kind trigger", async () => {
    await setPolicy("start_invoice_to_cash_workflow", true);
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    mockFetchOnce(
      '{"repaired": false, "actionType": "start_invoice_to_cash_workflow", "payload": {"invoiceId": "11111111-1111-4111-8111-111111111111"}, "reason": "Matches."}',
    );
    const planner = new LLMPlanner(
      createDefaultPluginRegistry(),
      stubPlannerProvider("start_invoice_to_cash_workflow", { invoiceId: "11111111-1111-4111-8111-111111111111" }),
      // Malformed JSON — proves "candidate B simply does not exist, scoring picks A" degrades cleanly.
      { name: "malformed", async complete() { return "not json"; } },
    );
    const [result] = await planner.plan("Get the Hendersons' invoice paid — send them a payment link.", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("start_invoice_to_cash_workflow");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const tierEpisode = episodes.find((e) => e.step === "reasoning_tier");
    const output = tierEpisode!.output as Record<string, unknown>;
    expect(output.tier).toBe("high");
    expect(output.candidateBGenerated).toBe(true); // attempted, even though it failed to parse
    expect(output.scoreB).toBeNull(); // candidate B never materialized — scoring trivially picked A
    expect(output.winner).toBe("A");
  });

  it("5. a tenant policy override (riskThresholds.amountUsd:100) makes a $150 invoice high tier even though the default would make it medium", async () => {
    await setPolicy("create_invoice", true, { riskThresholds: { amountUsd: 100 } });
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    mockFetchOnce('{"repaired": false, "actionType": "create_invoice", "payload": {"amountUsd": 150}, "reason": "Matches."}');
    const planner = new LLMPlanner(
      createDefaultPluginRegistry(),
      stubPlannerProvider("create_invoice", { amountUsd: 150 }),
      stubSecondCandidateProvider("create_invoice", { amountUsd: 150 }),
    );
    const [result] = await planner.plan("Create a $150 invoice for the Hendersons.", tenantContext(), emptyMemory());
    expect(result!.actionType).toBe("create_invoice");

    const episodes = await readEpisodes(TENANT_ID, { domainActionId: result!.id });
    const tierEpisode = episodes.find((e) => e.step === "reasoning_tier");
    expect((tierEpisode!.output as Record<string, unknown>).tier).toBe("high");
  });
});
