// Receipt citation regression: a completed step's real citations overwrite the
// generic open-time placeholder on its DecisionReceipt (steps.ts's extractCitations).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, workflowSteps, workflowRuns, commands, decisionReceipts } from "@finnor/db";
import { eq } from "drizzle-orm";
import { submitCommand, claimStep, completeStep } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ed";

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

describe.skipIf(!available)("workflow receipt citations", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Receipt Citations Test Project" }).onConflictDoNothing());
  });
  afterAll(async () => {
    await withTenant(TENANT_ID, async (db) => {
      await db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_ID));
      await db.delete(workflowSteps).where(eq(workflowSteps.tenantId, TENANT_ID));
      await db.delete(workflowRuns).where(eq(workflowRuns.tenantId, TENANT_ID));
      await db.delete(commands).where(eq(commands.tenantId, TENANT_ID));
    });
    await closePool();
  });

  it("a step whose output carries citations overwrites the receipt's placeholder evidence with them", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "citations_test",
        payload: {},
        workflowType: "evidence_capture",
        idempotencyKey: "citations-flow-1",
        steps: [{ stepType: "capture_citations", payload: {} }],
      }),
    );
    const stepId = submitted.stepIds[0]!;
    await claimStep(TENANT_ID, stepId);

    const [beforeReceipt] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
    expect((beforeReceipt!.evidence as Array<{ source: string }>)[0]!.source).toBe("workflow_step"); // the open-time placeholder

    const realCitations = [
      { source: "deal_context", ref: "current", timestamp: new Date().toISOString() },
      { source: "semantic_memory", ref: "receipt:abc-123", timestamp: new Date().toISOString() },
    ];
    await completeStep(TENANT_ID, stepId, { output: { spokenSummary: "The diligence evidence is current.", citations: realCitations } });

    const [afterReceipt] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
    expect(afterReceipt!.evidence).toEqual(realCitations);
  });

  it("a step whose output carries no citations leaves the placeholder evidence untouched", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "citations_test",
        payload: {},
        workflowType: "probe",
        idempotencyKey: "citations-flow-2",
        steps: [{ stepType: "probe_step", payload: {} }],
      }),
    );
    const stepId = submitted.stepIds[0]!;
    await claimStep(TENANT_ID, stepId);
    await completeStep(TENANT_ID, stepId, { output: { ok: true } });
    const [receipt] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
    expect((receipt!.evidence as Array<{ source: string }>)[0]!.source).toBe("workflow_step");
  });
});
