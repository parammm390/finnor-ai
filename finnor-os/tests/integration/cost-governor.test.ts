import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool, decisionReceipts, domainActions, llmCalls, tenantLlmBudgets, withTenant } from "@finnor/db";
import { eq } from "drizzle-orm";
import { LLMBudgetDeferredError, registerProvider, resolveProvider, type LLMProvider } from "@finnor/tools";
import { openReceipt } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000b5";

async function dbUp() {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const available = await dbUp();

class UsageProvider implements LLMProvider {
  name = "test-cost-provider";
  lastUsage = { model: "test-model", inputTokens: 10, outputTokens: 5 };
  async complete() { return '{"ok":true}'; }
}

describe.skipIf(!available)("B5 cost governor", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.LLM_INPUT_USD_PER_MILLION = "2";
    process.env.LLM_OUTPUT_USD_PER_MILLION = "4";
    await migrate(DB_URL);
    await new pg.Client({ connectionString: DB_URL }).connect().catch(() => undefined);
    const admin = new pg.Client({ connectionString: DB_URL }); await admin.connect();
    await admin.query("INSERT INTO finnor_os.tenants (id, name) VALUES ($1, 'B5 Cost Governor') ON CONFLICT (id) DO NOTHING", [TENANT_ID]);
    await admin.query("DELETE FROM finnor_os.tenant_llm_budgets WHERE tenant_id = $1", [TENANT_ID]);
    await admin.query("DELETE FROM finnor_os.llm_calls WHERE tenant_id = $1", [TENANT_ID]);
    await admin.end();
    registerProvider("test-cost", () => new UsageProvider());
  });

  afterAll(async () => { await closePool(); });

  it("persists provider-reported tokens and configured cost", async () => {
    const [action] = await withTenant(TENANT_ID, (db) => db.insert(domainActions).values({ tenantId: TENANT_ID, actionType: "record_finding", payload: {}, status: "draft" }).returning());
    const provider = resolveProvider("test-cost");
    await provider.complete({ system: "stable policy", user: "hello", tenantId: TENANT_ID, actionId: action!.id, traceId: "b5-ledger", purpose: "planning" });
    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(llmCalls).where(eq(llmCalls.traceId, "b5-ledger")));
    expect(row?.inputTokens).toBe(10);
    expect(row?.outputTokens).toBe(5);
    expect(row?.costUsd).toBeCloseTo(0.00004);
    const { receiptId } = await openReceipt({ tenantId: TENANT_ID, domainActionId: action!.id, objective: "Costed decision", evidence: [], policyApplied: null, riskTier: "low", proposedAction: {}, approval: { required: false } });
    const [receipt] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, receiptId)));
    expect(receipt?.llmCostUsd).toBeCloseTo(0.00004);
  });

  it("defers a non-urgent call at a forced hard cap without calling the provider", async () => {
    const [action] = await withTenant(TENANT_ID, (db) => db.insert(domainActions).values({ tenantId: TENANT_ID, actionType: "record_finding", payload: {}, status: "draft" }).returning());
    await withTenant(TENANT_ID, (db) => db.insert(tenantLlmBudgets).values({ tenantId: TENANT_ID, dailyTokenBudget: 0, softLimitPercent: 80 }).onConflictDoUpdate({ target: tenantLlmBudgets.tenantId, set: { dailyTokenBudget: 0 } }));
    await expect(resolveProvider("test-cost").complete({ system: "x", user: "y", tenantId: TENANT_ID, actionId: action!.id, traceId: "b5-hard-cap", purpose: "critic" })).rejects.toBeInstanceOf(LLMBudgetDeferredError);
    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(llmCalls).where(eq(llmCalls.traceId, "b5-hard-cap")));
    expect(row?.status).toBe("deferred");
    const [receipt] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.domainActionId, action!.id)));
    expect((receipt?.failure as { errorKind?: string } | null)?.errorKind).toBe("config");
  });
});
