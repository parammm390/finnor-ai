// B2.T4 acceptance: ambiguity is persisted as a real pending clarification card, not
// silently converted into a guessed operational action.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { beginWorkPlannerAttempt, closePool, domainActions, receiveWork, tenantVerticalAssignments, tenants, withTenant } from "@finnor/db";
import { eq } from "drizzle-orm";
import { createDefaultPluginRegistry, GatedExecutor, LLMPlanner, selectAndMaterializePlan } from "@finnor/orchestration";
import { createDefaultRegistry } from "@finnor/tools";
import type { LLMProvider } from "@finnor/orchestration";
import type { DomainPolicy, MemorySnapshot, TenantContext } from "@finnor/shared-types";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000c4";
async function dbUp(): Promise<boolean> { const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 }); try { await client.connect(); await client.end(); return true; } catch { return false; } }
const available = await dbUp();
const memory = (): MemorySnapshot => ({ shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null });
const context = (): TenantContext => ({ tenantId: TENANT_ID, userId: "clarification-test", role: "owner" });

describe.skipIf(!available)("clarification request", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, async (db) => {
      await db.insert(tenants).values({ id: TENANT_ID, name: "Clarification Test Dealer" }).onConflictDoNothing();
      await db.insert(tenantVerticalAssignments).values({ tenantId: TENANT_ID, verticalKey: "none", sourceSystem: "certification:test", createdBy: "test" })
        .onConflictDoUpdate({ target: tenantVerticalAssignments.tenantId, set: { verticalKey: "none", sourceSystem: "certification:test", createdBy: "test", updatedAt: new Date() } });
    });
  });
  beforeEach(() => { delete process.env.AWS_BEDROCK_API_KEY; });
  afterAll(async () => { await closePool(); });

  it("registers, validates, and gates an ambiguous plan as a durable question card", async () => {
    const provider: LLMProvider = { name: "clarification-stub", async complete(options) {
      const criteria = JSON.parse(options.system.split("Accepted completion criteria: ")[1]!.split("\n")[0]!) as Array<{ id: string }>;
      return JSON.stringify({ candidates: [{
        version: 1,
        candidateKey: "clarification",
        nodes: [
          { key: "ask", kind: "action", actionType: "clarification_request", payload: { question: "Which deal should receive the diligence request?", missingFields: ["dealId"] }, supports: criteria.map((criterion) => criterion.id) },
          ...criteria.map((criterion, index) => ({ key: `check_${index}`, kind: "check", criterionId: criterion.id, dependsOn: ["ask"] })),
        ],
      }] });
    } };
    const plugins = createDefaultPluginRegistry();
    expect(plugins.actionTypes()).toContain("clarification_request");
    const work = await receiveWork({ tenantId: TENANT_ID, instruction: "Send the Hendersons a quote.", channel: "text", userId: context().userId });
    const attempt = await beginWorkPlannerAttempt({ tenantId: TENANT_ID, workId: work.workId, workInputId: work.workInputId, attemptKey: `test:${work.instructionId}` });
    const planning = await new LLMPlanner(plugins, provider).plan("Send the Hendersons a quote.", context(), memory(), {
      workId: work.workId,
      workInputId: work.workInputId,
      plannerAttemptId: attempt.id,
      decisionContextHash: attempt.decisionContextHash ?? undefined,
    });
    const materialized = await selectAndMaterializePlan({ planning, tenantContext: context(), workId: work.workId, workInputId: work.workInputId, plannerAttemptId: attempt.id, instructionId: work.instructionId });
    const [action] = materialized.actions;
    expect(action!.actionType).toBe("clarification_request");
    const policy: DomainPolicy = { id: "", tenantId: TENANT_ID, actionType: "clarification_request", policy: {}, requiresConfirmation: true, confirmationTemplate: null, version: 0 };
    const result = await new GatedExecutor(plugins, createDefaultRegistry()).execute(action!, policy);
    // clarification_request is META_NO_SIDE_EFFECT with an explicit NONE approval
    // floor in the fixed release spec. It must never enter the approval queue or
    // present Answer/Skip/Cancel as Approve/Reject; the durable question is the
    // completed, receipted action itself.
    expect(result.output).toMatchObject({ clarificationRequested: true, question: "Which deal should receive the diligence request?" });
    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, action!.id)));
    expect(row).toMatchObject({ actionType: "clarification_request", status: "completed", payload: { missingFields: ["dealId"] } });
  });
});
