// A4.T2 acceptance: scan-watchdog.ts's four signals — stuck runs, orphaned steps,
// unfinalized receipts, aging-approval nudges — against real fixtures in local Postgres,
// with real backdated timestamps (same technique as
// provider-circuit-breaker-budget.test.ts's openedAt manipulation), not mocked time.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import {
  withTenant,
  closePool,
  getPool,
  commands,
  workflowRuns,
  workflowSteps,
  decisionReceipts,
  domainActions,
  domainPolicies,
} from "@finnor/db";
import { eq } from "drizzle-orm";
import { detectWatchdogFindings } from "../../apps/worker/src/handlers/scan-watchdog";
import { workflowStepJobKey } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

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

describe.skipIf(!available)("scan_watchdog detector (A4.T2)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
  });
  afterAll(async () => {
    await closePool();
  });

  it("flags a workflow_run stuck past its kind's deadline, and leaves a fresh one alone", async () => {
    const stuckRunId = await withTenant(SEED_TENANT_ID, async (db) => {
      const [cmd] = await db
        .insert(commands)
        .values({ tenantId: SEED_TENANT_ID, commandType: "single_action", payload: {} })
        .returning();
      const [run] = await db
        .insert(workflowRuns)
        .values({ tenantId: SEED_TENANT_ID, commandId: cmd!.id, workflowType: "single_action", status: "running" })
        .returning();
      // single_action's deadline is 0.25h (15min) — back-date well past it.
      await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() - 30 * 60_000) }).where(eq(workflowRuns.id, run!.id));
      return run!.id;
    });
    const freshRunId = await withTenant(SEED_TENANT_ID, async (db) => {
      const [cmd] = await db
        .insert(commands)
        .values({ tenantId: SEED_TENANT_ID, commandType: "single_action", payload: {} })
        .returning();
      const [run] = await db
        .insert(workflowRuns)
        .values({ tenantId: SEED_TENANT_ID, commandId: cmd!.id, workflowType: "single_action", status: "running" })
        .returning();
      return run!.id;
    });

    const findings = await detectWatchdogFindings(SEED_TENANT_ID);
    const stuck = findings.filter((f) => f.kind === "stuck_run");
    expect(stuck.some((f) => f.refId === stuckRunId)).toBe(true);
    expect(stuck.some((f) => f.refId === freshRunId)).toBe(false);
  });

  it("flags a pending step with no job row, and self-heals by enqueueing one", async () => {
    const idempotencyKey = `watchdog-orphan-test:${randomUUID()}`;
    const { stepId } = await withTenant(SEED_TENANT_ID, async (db) => {
      const [cmd] = await db
        .insert(commands)
        .values({ tenantId: SEED_TENANT_ID, commandType: "single_action", payload: {} })
        .returning();
      const [run] = await db
        .insert(workflowRuns)
        .values({ tenantId: SEED_TENANT_ID, commandId: cmd!.id, workflowType: "single_action", status: "running" })
        .returning();
      const [step] = await db
        .insert(workflowSteps)
        .values({
          tenantId: SEED_TENANT_ID,
          workflowRunId: run!.id,
          stepType: "noop",
          sequence: 0,
          status: "pending",
          idempotencyKey,
        })
        .returning();
      await db.update(workflowSteps).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(workflowSteps.id, step!.id));
      return { stepId: step!.id };
    });

    const canonicalJobKey = `workflow-step:${SEED_TENANT_ID}:${stepId}`;
    const beforeJob = await getPool().query("SELECT 1 FROM jobs WHERE idempotency_key = $1", [canonicalJobKey]);
    expect(beforeJob.rows).toHaveLength(0); // confirms it's genuinely orphaned before detection

    const findings = await detectWatchdogFindings(SEED_TENANT_ID);
    expect(findings.some((f) => f.kind === "orphaned_step" && f.refId === stepId)).toBe(true);

    const afterJob = await getPool().query("SELECT 1 FROM jobs WHERE idempotency_key = $1", [canonicalJobKey]);
    expect(afterJob.rows).toHaveLength(1); // self-healed: a job now exists for it
  });

  it("does NOT flag a pending step that already has a job (not orphaned, just queued)", async () => {
    const idempotencyKey = `watchdog-notorphan-test:${randomUUID()}`;
    const stepId = await withTenant(SEED_TENANT_ID, async (db) => {
      const [cmd] = await db.insert(commands).values({ tenantId: SEED_TENANT_ID, commandType: "single_action", payload: {} }).returning();
      const [run] = await db
        .insert(workflowRuns)
        .values({ tenantId: SEED_TENANT_ID, commandId: cmd!.id, workflowType: "single_action", status: "running" })
        .returning();
      const [step] = await db
        .insert(workflowSteps)
        .values({ tenantId: SEED_TENANT_ID, workflowRunId: run!.id, stepType: "noop", sequence: 0, status: "pending", idempotencyKey })
        .returning();
      await db.update(workflowSteps).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(workflowSteps.id, step!.id));
      return step!.id;
    });
    await getPool().query("INSERT INTO jobs (type, payload, idempotency_key) VALUES ($1, $2, $3)", [
      "run_workflow_step",
      JSON.stringify({ tenantId: SEED_TENANT_ID, workflowStepId: stepId }),
      `workflow-step:${SEED_TENANT_ID}:${stepId}`,
    ]);

    const findings = await detectWatchdogFindings(SEED_TENANT_ID);
    expect(findings.some((f) => f.kind === "orphaned_step" && f.refId === stepId)).toBe(false);
  });

  it.each(["completed", "dead_letter"])("re-drives a pending step whose current job is %s", async (terminalStatus) => {
    const idempotencyKey = `watchdog-terminal-job-test:${terminalStatus}:${randomUUID()}`;
    const stepId = await withTenant(SEED_TENANT_ID, async (db) => {
      const [cmd] = await db.insert(commands).values({ tenantId: SEED_TENANT_ID, commandType: "single_action", payload: {} }).returning();
      const [run] = await db.insert(workflowRuns).values({ tenantId: SEED_TENANT_ID, commandId: cmd!.id, workflowType: "single_action", status: "running" }).returning();
      const [step] = await db.insert(workflowSteps).values({
        tenantId: SEED_TENANT_ID,
        workflowRunId: run!.id,
        stepType: "noop",
        sequence: 0,
        status: "pending",
        idempotencyKey,
      }).returning();
      await db.update(workflowSteps).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(workflowSteps.id, step!.id));
      return step!.id;
    });
    await getPool().query("INSERT INTO jobs (type, payload, idempotency_key, status) VALUES ($1, $2, $3, $4)", [
      "run_workflow_step",
      JSON.stringify({ tenantId: SEED_TENANT_ID, workflowStepId: stepId, workflowStepGeneration: 0 }),
      workflowStepJobKey(SEED_TENANT_ID, stepId, 0),
      terminalStatus,
    ]);

    const findings = await detectWatchdogFindings(SEED_TENANT_ID);
    expect(findings.some((finding) => finding.kind === "orphaned_step" && finding.refId === stepId)).toBe(true);
    const [step] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)));
    expect(step!.dispatchGeneration).toBe(1);
    const replacement = await getPool().query("SELECT status FROM jobs WHERE idempotency_key=$1", [
      workflowStepJobKey(SEED_TENANT_ID, stepId, 1),
    ]);
    expect(replacement.rows).toEqual([{ status: "queued" }]);
  });

  it("flags a decision receipt that's sat unfinalized past the threshold", async () => {
    const receiptId = await withTenant(SEED_TENANT_ID, async (db) => {
      const [receipt] = await db
        .insert(decisionReceipts)
        .values({ tenantId: SEED_TENANT_ID, objective: "watchdog unfinalized test", riskTier: "low", approval: { required: false } })
        .returning();
      await db.update(decisionReceipts).set({ createdAt: new Date(Date.now() - 90 * 60_000) }).where(eq(decisionReceipts.id, receipt!.id));
      return receipt!.id;
    });

    const findings = await detectWatchdogFindings(SEED_TENANT_ID);
    expect(findings.some((f) => f.kind === "unfinalized_receipt" && f.refId === receiptId)).toBe(true);
  });

  it("nudges a pending action past half its confirmation timeout, exactly once", async () => {
    const actionType = `watchdog_nudge_test_${randomUUID().slice(0, 8)}`;
    const actionId = await withTenant(SEED_TENANT_ID, async (db) => {
      const [policy] = await db
        .insert(domainPolicies)
        .values({ tenantId: SEED_TENANT_ID, actionType, policy: {}, requiresConfirmation: true, confirmationTimeoutHours: 2 })
        .returning();
      const [action] = await db
        .insert(domainActions)
        .values({ tenantId: SEED_TENANT_ID, actionType, payload: {}, policyId: policy!.id, status: "pending" })
        .returning();
      // 1.5h old vs a 2h timeout — past the 50% (1h) nudge threshold, not yet expired.
      await db.update(domainActions).set({ createdAt: new Date(Date.now() - 90 * 60_000) }).where(eq(domainActions.id, action!.id));
      return action!.id;
    });

    const first = await detectWatchdogFindings(SEED_TENANT_ID);
    expect(first.some((f) => f.kind === "aging_approval_nudge" && f.refId === actionId)).toBe(true);
    // status must be unchanged — this is a nudge, not the expiry scan's escalation.
    const [row] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, actionId)));
    expect(row!.status).toBe("pending");

    const second = await detectWatchdogFindings(SEED_TENANT_ID);
    expect(second.some((f) => f.kind === "aging_approval_nudge" && f.refId === actionId)).toBe(false); // deduped, no repeat nudge
  });
});
