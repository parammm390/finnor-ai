// Phase 2 (§2.4) acceptance: every claimed workflow step gets a DecisionReceipt, opened
// at first claim and finalized at completion/failure — and the correlationId thread
// (Phase 16(e), finished here) flows from submitCommand all the way onto the receipt.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, workflowSteps, workflowStepClaims, workflowRuns, commands, decisionReceipts, integrationOperations } from "@finnor/db";
import { eq } from "drizzle-orm";
import { submitCommand, claimStep, completeStep, failStep, redriveStepTx } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ea";

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

async function newCommand(idempotencyKey: string, correlationId?: string) {
  return withTenant(TENANT_ID, (db) =>
    submitCommand(db, {
      tenantId: TENANT_ID,
      commandType: "step_receipts_test",
      payload: {},
      workflowType: "step_receipts_test",
      idempotencyKey,
      correlationId,
      steps: [{ stepType: "probe_step", payload: { note: "test" } }],
    }),
  );
}

describe.skipIf(!available)("receipts wired into the engine (§2.4)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Step Receipts Test Dealer" }).onConflictDoNothing());
  });
  afterAll(async () => {
    await withTenant(TENANT_ID, async (db) => {
      const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.tenantId, TENANT_ID));
      for (const s of steps) {
        await db.delete(decisionReceipts).where(eq(decisionReceipts.workflowStepId, s.id));
        await db.delete(integrationOperations).where(eq(integrationOperations.workflowStepId, s.id));
      }
      await db.delete(workflowStepClaims).where(eq(workflowStepClaims.tenantId, TENANT_ID));
      await db.delete(workflowSteps).where(eq(workflowSteps.tenantId, TENANT_ID));
      await db.delete(workflowRuns).where(eq(workflowRuns.tenantId, TENANT_ID));
      await db.delete(commands).where(eq(commands.tenantId, TENANT_ID));
    });
    await closePool();
  });

  it("claimStep opens a receipt; completeStep finalizes it with actualResult", async () => {
    const submitted = await newCommand("step-receipts-complete", "corr-complete-1");
    const stepId = submitted.stepIds[0]!;

    const claimed = await claimStep(TENANT_ID, stepId);
    expect(claimed).not.toBeNull();

    const [opened] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
    expect(opened).toBeTruthy();
    expect(opened!.finalizedAt).toBeNull();
    expect(opened!.correlationId).toBe("corr-complete-1");
    expect((opened!.approval as Record<string, unknown>).required).toBe(true);
    expect((opened!.approval as Record<string, unknown>).approvedBy).toBeUndefined();
    expect((opened!.proposedAction as Record<string, unknown>).stepType).toBe("probe_step");

    await completeStep(TENANT_ID, stepId, { output: { ok: true } });
    const [finalized] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
    expect(finalized!.finalizedAt).not.toBeNull();
    expect(finalized!.actualResult).toEqual({ output: { ok: true } });
    expect(finalized!.failure).toBeNull();
  });

  it("failStep finalizes the receipt with a typed, terminal failure", async () => {
    const submitted = await newCommand("step-receipts-fail");
    const stepId = submitted.stepIds[0]!;
    await claimStep(TENANT_ID, stepId);

    await failStep(TENANT_ID, stepId, "provider rejected the request");
    const [finalized] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
    expect(finalized!.finalizedAt).not.toBeNull();
    expect(finalized!.actualResult).toBeNull();
    expect(finalized!.failure).toEqual({
      errorKind: "terminal",
      message: "provider rejected the request",
      recoveryPath: "review via GET /api/workflows/runs and retry or escalate the run",
    });
  });

  it("a retried claim on the same step does not open a second receipt", async () => {
    const submitted = await newCommand("step-receipts-retry");
    const stepId = submitted.stepIds[0]!;
    await claimStep(TENANT_ID, stepId);
    // Use the canonical fenced redrive. It closes the first claim history row,
    // advances the dispatch generation, and clears ownership atomically.
    const redriven = await withTenant(TENANT_ID, (db) => redriveStepTx(db, TENANT_ID, stepId));
    expect(redriven?.dispatchGeneration).toBe(1);
    await claimStep(TENANT_ID, stepId, 1);

    const rows = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
    expect(rows).toHaveLength(1);
  });

  it("submitCommand's correlationId lands on the command row and every one of its steps", async () => {
    const submitted = await newCommand("step-receipts-correlation-thread", "corr-thread-1");
    const [command] = await withTenant(TENANT_ID, (db) => db.select().from(commands).where(eq(commands.id, submitted.commandId)));
    expect(command!.correlationId).toBe("corr-thread-1");
    const [step] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, submitted.stepIds[0]!)));
    expect(step!.correlationId).toBe("corr-thread-1");
  });
});
