// Durable execution runtime acceptance (Phase 2, docs/jarvis-90-execution-blueprint.md
// §3): command/step lifecycle, lease-based recovery, and reconciliation-on-unknown-
// delivery — all against real Postgres, no mocks.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  withTenant,
  closePool,
  tenants,
  workflowSteps,
  workflowRuns,
  commands,
  integrationOperations,
  reconciliationCases,
  decisionReceipts,
} from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { submitCommand, claimStep, completeStep, failStep, advanceWorkflow, recoverStaleSteps } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000d1";

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

async function cleanSlate() {
  await withTenant(TENANT_ID, async (db) => {
    await db.delete(reconciliationCases).where(eq(reconciliationCases.tenantId, TENANT_ID));
    await db.delete(integrationOperations).where(eq(integrationOperations.tenantId, TENANT_ID));
    // decision_receipts.workflow_step_id FKs into workflow_steps (§2.4 — claimStep opens
    // one per step) — must clear before the steps themselves are deleted.
    await db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_ID));
    await db.delete(workflowSteps).where(eq(workflowSteps.tenantId, TENANT_ID));
    await db.delete(workflowRuns).where(eq(workflowRuns.tenantId, TENANT_ID));
    await db.delete(commands).where(eq(commands.tenantId, TENANT_ID));
  });
}

describe.skipIf(!available)("durable execution runtime", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Workflow Runtime Test Dealer" }).onConflictDoNothing());
    await cleanSlate();
  });
  afterAll(async () => {
    await closePool();
  });

  it("submitCommand is idempotent by (tenant, idempotency_key) — same ids returned, no duplicate rows", async () => {
    const params = {
      tenantId: TENANT_ID,
      commandType: "test_command",
      payload: { a: 1 },
      workflowType: "test_workflow",
      steps: [{ stepType: "step_a", payload: {} }],
      idempotencyKey: "idem-1",
    };
    const first = await withTenant(TENANT_ID, (db) => submitCommand(db, params));
    expect(first.alreadyExisted).toBe(false);
    const second = await withTenant(TENANT_ID, (db) => submitCommand(db, params));
    expect(second.alreadyExisted).toBe(true);
    expect(second.commandId).toBe(first.commandId);
    expect(second.workflowRunId).toBe(first.workflowRunId);
    expect(second.stepIds).toEqual(first.stepIds);

    const allCommands = await withTenant(TENANT_ID, (db) => db.select().from(commands).where(eq(commands.idempotencyKey, "idem-1")));
    expect(allCommands).toHaveLength(1);
  });

  it("claimStep is atomic — a second claim on an already-leased step is a safe no-op", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "test_command",
        payload: {},
        workflowType: "test_workflow",
        steps: [{ stepType: "step_a", payload: {} }],
        idempotencyKey: "idem-claim-1",
      }),
    );
    const stepId = submitted.stepIds[0]!;
    const first = await claimStep(TENANT_ID, stepId);
    expect(first?.status).toBe("leased");
    const second = await claimStep(TENANT_ID, stepId);
    expect(second).toBeNull(); // already leased — duplicate job delivery, safe

    await completeStep(TENANT_ID, stepId, { done: true });
    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)));
    expect(row!.status).toBe("completed");
    expect(row!.leaseExpiresAt).toBeNull();
  });

  it("advanceWorkflow enqueues the next pending step, then marks the run and command completed once every step is done", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "test_command",
        payload: {},
        workflowType: "test_workflow",
        steps: [{ stepType: "step_a", payload: {} }, { stepType: "step_b", payload: {} }],
        idempotencyKey: "idem-advance-1",
      }),
    );
    await claimStep(TENANT_ID, submitted.stepIds[0]!);
    await completeStep(TENANT_ID, submitted.stepIds[0]!, {});
    await advanceWorkflow(TENANT_ID, submitted.workflowRunId);

    const [runMidway] = await withTenant(TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, submitted.workflowRunId)));
    expect(runMidway!.status).toBe("running"); // step 2 still pending

    await claimStep(TENANT_ID, submitted.stepIds[1]!);
    await completeStep(TENANT_ID, submitted.stepIds[1]!, {});
    await advanceWorkflow(TENANT_ID, submitted.workflowRunId);

    const [run] = await withTenant(TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, submitted.workflowRunId)));
    const [cmd] = await withTenant(TENANT_ID, (db) => db.select().from(commands).where(eq(commands.id, submitted.commandId)));
    expect(run!.status).toBe("completed");
    expect(cmd!.status).toBe("completed");
  });

  it("failStep marks the workflow_run and command failed via advanceWorkflow", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "test_command",
        payload: {},
        workflowType: "test_workflow",
        steps: [{ stepType: "step_a", payload: {} }],
        idempotencyKey: "idem-fail-1",
      }),
    );
    await claimStep(TENANT_ID, submitted.stepIds[0]!);
    await failStep(TENANT_ID, submitted.stepIds[0]!, "capability call failed");
    await advanceWorkflow(TENANT_ID, submitted.workflowRunId);

    const [run] = await withTenant(TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, submitted.workflowRunId)));
    expect(run!.status).toBe("failed");
  });

  it("recoverStaleSteps: no integration_operations claim yet — resets to pending and re-enqueues (nothing external happened)", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "test_command",
        payload: {},
        workflowType: "test_workflow",
        steps: [{ stepType: "step_a", payload: {} }],
        idempotencyKey: "idem-recover-clean-1",
      }),
    );
    await claimStep(TENANT_ID, submitted.stepIds[0]!);
    await withTenant(TENANT_ID, (db) =>
      db.update(workflowSteps).set({ leaseExpiresAt: new Date(Date.now() - 60_000) }).where(eq(workflowSteps.id, submitted.stepIds[0]!)),
    );

    const result = await recoverStaleSteps(TENANT_ID);
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(result.reconciled).toBe(0);

    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, submitted.stepIds[0]!)));
    expect(row!.status).toBe("pending");
  });

  it("recoverStaleSteps: integration_operations row 'succeeded' — completes the step and resumes (exactly-once, resumed correctly)", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "test_command",
        payload: {},
        workflowType: "test_workflow",
        steps: [{ stepType: "step_a", payload: {} }],
        idempotencyKey: "idem-recover-succeeded-1",
      }),
    );
    const stepId = submitted.stepIds[0]!;
    await claimStep(TENANT_ID, stepId);
    await withTenant(TENANT_ID, async (db) => {
      await db.insert(integrationOperations).values({
        tenantId: TENANT_ID,
        workflowStepId: stepId,
        operationKey: "op-succeeded",
        capability: "test_capability",
        requestHash: "hash",
        status: "succeeded",
        response: { ok: true },
      });
      await db.update(workflowSteps).set({ leaseExpiresAt: new Date(Date.now() - 60_000) }).where(eq(workflowSteps.id, stepId));
    });

    const result = await recoverStaleSteps(TENANT_ID);
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(result.reconciled).toBe(0);

    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)));
    expect(row!.status).toBe("completed");
    const [run] = await withTenant(TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, submitted.workflowRunId)));
    expect(run!.status).toBe("completed");
  });

  it("recoverStaleSteps: integration_operations row stuck 'running' — opens a reconciliation_case, never blindly retries", async () => {
    const submitted = await withTenant(TENANT_ID, (db) =>
      submitCommand(db, {
        tenantId: TENANT_ID,
        commandType: "test_command",
        payload: {},
        workflowType: "test_workflow",
        steps: [{ stepType: "step_a", payload: {} }],
        idempotencyKey: "idem-recover-unknown-1",
      }),
    );
    const stepId = submitted.stepIds[0]!;
    await claimStep(TENANT_ID, stepId);
    await withTenant(TENANT_ID, async (db) => {
      await db.insert(integrationOperations).values({
        tenantId: TENANT_ID,
        workflowStepId: stepId,
        operationKey: "op-unknown",
        capability: "test_capability",
        requestHash: "hash",
        status: "running",
      });
      await db.update(workflowSteps).set({ leaseExpiresAt: new Date(Date.now() - 60_000) }).where(eq(workflowSteps.id, stepId));
    });

    const result = await recoverStaleSteps(TENANT_ID);
    expect(result.reconciled).toBeGreaterThanOrEqual(1);

    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)));
    // Never silently completed and never silently retried. Runtime ownership is
    // released and the step waits on observation/reconciliation; the old fence is
    // closed so a stale process cannot advance it.
    expect(row).toMatchObject({ status: "waiting_observation", executionState: "reconciling", claimToken: null });

    const cases = await withTenant(TENANT_ID, (db) =>
      db.select().from(reconciliationCases).where(and(eq(reconciliationCases.relatedStepId, stepId), eq(reconciliationCases.caseType, "unknown_delivery"))),
    );
    expect(cases).toHaveLength(1);

    // recoverStaleSteps() is polled repeatedly in production (every job-queue tick) —
    // calling it again on the same still-stuck step must NEVER open a second case.
    const second = await recoverStaleSteps(TENANT_ID);
    expect(second.reconciled).toBe(0);
    const casesAfterSecondCall = await withTenant(TENANT_ID, (db) =>
      db.select().from(reconciliationCases).where(eq(reconciliationCases.relatedStepId, stepId)),
    );
    expect(casesAfterSecondCall).toHaveLength(1);
    expect(cases[0]!.status).toBe("open");
  });
});
