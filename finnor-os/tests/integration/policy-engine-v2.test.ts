import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { closePool, domainActions, domainPolicies, domainPolicyRevisions, tenants, withTenant, actionLog, decisionReceipts } from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { FinnorOrchestrator, simulatePolicy, type Executor, type Reflection } from "@finnor/orchestration";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = randomUUID();
async function dbUp() { const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 }); try { await c.connect(); await c.end(); return true; } catch { return false; } }
const available = await dbUp();

describe.skipIf(!available)("B6 policy engine v2", () => {
  beforeAll(async () => { process.env.DATABASE_URL = DB_URL; await migrate(DB_URL); await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "B6 policy test" })); });
  // action_log is intentionally immutable; this isolated random-UUID fixture is left
  // in the disposable integration database rather than weakening that production guard.
  afterAll(async () => { await closePool(); });

  it("preserves effective-dated revisions, simulates history without a write, and records approval drift", async () => {
    const policyId = randomUUID();
    const now = new Date();
    await withTenant(TENANT_ID, async (db) => {
      await db.insert(domainPolicies).values({ id: policyId, tenantId: TENANT_ID, actionType: "clarification_request", policy: { threshold: 1 }, requiresConfirmation: true, version: 1, effectiveFrom: now });
      await db.insert(domainPolicyRevisions).values({ tenantId: TENANT_ID, policyId, actionType: "clarification_request", version: 1, policy: { threshold: 1 }, requiresConfirmation: true, effectiveFrom: now });
      const [action] = await db.insert(domainActions).values({ tenantId: TENANT_ID, actionType: "clarification_request", payload: { question: "Which diligence item should be used?", missingFields: ["diligenceItem"] }, policyId, policyVersion: 1, status: "pending" }).returning();
      await db.insert(decisionReceipts).values({ tenantId: TENANT_ID, domainActionId: action!.id, objective: "historic diligence check", evidence: [], riskTier: "low", proposedAction: { actionType: "clarification_request" }, approval: { required: true } });
    });
    const report = await simulatePolicy(TENANT_ID, "clarification_request", { requiresConfirmation: false });
    expect(report).toMatchObject({ evaluatedReceipts: 1, historicalGated: 1, candidateGated: 0, gateDelta: -1, simulated: true });
    await withTenant(TENANT_ID, async (db) => {
      await db.update(domainPolicies).set({ version: 2, policy: { threshold: 2 }, effectiveFrom: new Date() }).where(eq(domainPolicies.id, policyId));
      await db.insert(domainPolicyRevisions).values({ tenantId: TENANT_ID, policyId, actionType: "clarification_request", version: 2, policy: { threshold: 2 }, requiresConfirmation: true, effectiveFrom: new Date() });
    });
    const executor: Executor = { execute: async () => ({ status: "success", output: {} }) };
    const reflection: Reflection = { evaluate: async () => ({ decision: "accept", matched: true, detail: "test" }) };
    const orchestrator = new FinnorOrchestrator({ executor, reflection });
    const [action] = await withTenant(TENANT_ID, (db) => db.select().from(domainActions).where(and(eq(domainActions.tenantId, TENANT_ID), eq(domainActions.policyId, policyId))).limit(1));
    await orchestrator.decide(action!.id, TENANT_ID, "approve", "test-owner", { role: "owner" });
    const [approval] = await withTenant(TENANT_ID, (db) => db.select().from(actionLog).where(and(eq(actionLog.domainActionId, action!.id), eq(actionLog.step, "confirmed"))));
    expect(approval!.output).toMatchObject({ policyDrift: { draftedVersion: 1, approvedVersion: 2, changed: { policy: true } } });
  });
});
