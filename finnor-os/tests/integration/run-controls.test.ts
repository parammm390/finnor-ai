// Phase 2 (§2.7) run controls acceptance: pause/resume/cancel/retry/escalate, each a
// guarded state transition — optimistic version check, illegal-transition rejection,
// and (per verb) the real enforcement/side-effect that makes it more than a status
// label: pause/cancel/escalate genuinely block claimStep from progressing the run
// further, resume re-drives a step that was blocked, retry resets the failed step and
// re-enqueues it.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, getPool, tenants, users, workflowRuns, workflowSteps, decisionReceipts, works, reconciliationCases } from "@finnor/db";
import { executionProjection } from "@finnor/read-models";
import { eq } from "drizzle-orm";
import { submitCommand, claimStep, completeStep, failStep, advanceWorkflow, pauseRun, resumeRun, cancelRun, retryRun, escalateRun, workflowStepJobKey } from "@finnor/workflow-runtime";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000eb";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: SUPER_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

async function newRun(steps: string[] = ["step_a", "step_b"], workId?: string): Promise<{ runId: string; stepIds: string[] }> {
  const submitted = await withTenant(TENANT_ID, (db) =>
    submitCommand(db, {
      tenantId: TENANT_ID,
      commandType: "run_controls_test",
      payload: {},
      workflowType: "run_controls_test",
      workId,
      steps: steps.map((s) => ({ stepType: s, payload: {} })),
    }),
  );
  return { runId: submitted.workflowRunId, stepIds: submitted.stepIds };
}

describe.skipIf(!available)("run controls (§2.7)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Run Controls Test Dealer" }).onConflictDoNothing());
  });
  afterAll(async () => {
    await closePool();
  });

  it("pause: running -> paused, and blocks claimStep from progressing the run further", async () => {
    const { runId, stepIds } = await newRun();
    const result = await pauseRun(TENANT_ID, runId, 1, "owner-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe("paused");
    expect(result.run.version).toBe(2);

    // The real enforcement: a paused run's step cannot be claimed at all.
    const claimed = await claimStep(TENANT_ID, stepIds[0]!);
    expect(claimed).toBeNull();
    const [step] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepIds[0]!)));
    expect(step!.status).toBe("pending"); // untouched — never silently leased

    // A receipt records who paused it and when.
    const [receipt] = await withTenant(TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowRunId, runId)));
    expect(receipt).toBeTruthy();
    expect(receipt!.workflowStepId).toBeNull();
    expect((receipt!.approval as Record<string, unknown>).approvedBy).toBe("owner-1");
    expect(receipt!.finalizedAt).not.toBeNull();
  });

  it("pause is illegal from a non-running status — rejected as a conflict, not silently accepted", async () => {
    const { runId } = await newRun();
    const first = await pauseRun(TENANT_ID, runId, 1, "owner-1");
    expect(first.ok).toBe(true);
    const second = await pauseRun(TENANT_ID, runId, 2, "owner-1"); // already paused
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("illegal_transition");
  });

  it("a stale expectedVersion is rejected as a version conflict, not applied", async () => {
    const { runId } = await newRun();
    await pauseRun(TENANT_ID, runId, 1, "owner-1"); // version is now 2
    const stale = await pauseRun(TENANT_ID, runId, 1, "owner-1"); // still claims version 1
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe("version_conflict");
  });

  it("an unknown run id is not_found", async () => {
    const result = await pauseRun(TENANT_ID, "00000000-0000-4000-9000-000000000abc", 1, "owner-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("resume: paused -> running, and re-drives a step that was blocked by the pause", async () => {
    const { runId, stepIds } = await newRun();
    await pauseRun(TENANT_ID, runId, 1, "owner-1");
    // This is what the real worker records after claimStep correctly no-ops while
    // paused: the immutable generation-0 queue row is terminal.
    await getPool().query("UPDATE jobs SET status='completed', completed_at=now() WHERE idempotency_key=$1", [
      workflowStepJobKey(TENANT_ID, stepIds[0]!, 0),
    ]);
    const result = await resumeRun(TENANT_ID, runId, 2, "owner-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe("running");

    const [step] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepIds[0]!)));
    expect(step!.dispatchGeneration).toBe(1);
    const replacement = await getPool().query("SELECT status FROM jobs WHERE idempotency_key=$1", [
      workflowStepJobKey(TENANT_ID, stepIds[0]!, 1),
    ]);
    expect(replacement.rows).toEqual([{ status: "queued" }]);
    // A late legacy delivery is fenced; only the replacement generation can claim.
    expect(await claimStep(TENANT_ID, stepIds[0]!, 0)).toBeNull();
    const claimed = await claimStep(TENANT_ID, stepIds[0]!, 1);
    expect(claimed).not.toBeNull();
  });

  it("resume is illegal from 'running' — a run that was never paused can't be resumed", async () => {
    const { runId } = await newRun();
    const result = await resumeRun(TENANT_ID, runId, 1, "owner-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal_transition");
  });

  it("cancel: running -> cancelled from either running or paused, and blocks further claims", async () => {
    const { runId: runningId, stepIds: runningSteps } = await newRun();
    const cancelFromRunning = await cancelRun(TENANT_ID, runningId, 1, "owner-1");
    expect(cancelFromRunning.ok).toBe(true);
    expect(await claimStep(TENANT_ID, runningSteps[0]!)).toBeNull();

    const { runId: pausedId } = await newRun();
    await pauseRun(TENANT_ID, pausedId, 1, "owner-1");
    const cancelFromPaused = await cancelRun(TENANT_ID, pausedId, 2, "owner-1");
    expect(cancelFromPaused.ok).toBe(true);
  });

  it("cancel is illegal from a terminal status", async () => {
    const { runId, stepIds } = await newRun(["only_step"]);
    // Drive it to completion for real.
    const claimed = await claimStep(TENANT_ID, stepIds[0]!);
    expect(claimed).not.toBeNull();
    await completeStep(TENANT_ID, stepIds[0]!, { ok: true });
    await advanceWorkflow(TENANT_ID, runId); // production callers (run-workflow-step.ts) always call this after completeStep
    const [run] = await withTenant(TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)));
    expect(run!.status).toBe("completed");

    const result = await cancelRun(TENANT_ID, runId, run!.version, "owner-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal_transition");
  });

  it("retry: failed -> running, resets the failed step to pending, and re-enqueues it for real (not just a status flip)", async () => {
    const { runId, stepIds } = await newRun(["only_step"]);
    const claimed = await claimStep(TENANT_ID, stepIds[0]!);
    expect(claimed).not.toBeNull();
    await failStep(TENANT_ID, stepIds[0]!, "provider timeout");
    await advanceWorkflow(TENANT_ID, runId);
    const [runAfterFail] = await withTenant(TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)));
    expect(runAfterFail!.status).toBe("failed");

    const result = await retryRun(TENANT_ID, runId, runAfterFail!.version, "owner-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe("running");

    const [stepAfterRetry] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepIds[0]!)));
    // Reset to pending (not left 'failed') — genuinely retryable, not a cosmetic flip.
    expect(stepAfterRetry!.status).toBe("pending");
    expect(stepAfterRetry!.terminalReason).toBeNull();
    expect(stepAfterRetry!.dispatchGeneration).toBe(1);
    const replacement = await getPool().query("SELECT status FROM jobs WHERE idempotency_key=$1", [
      workflowStepJobKey(TENANT_ID, stepIds[0]!, 1),
    ]);
    expect(replacement.rows).toEqual([{ status: "queued" }]);
  });

  it("retry is illegal from a status other than 'failed'", async () => {
    const { runId } = await newRun();
    const result = await retryRun(TENANT_ID, runId, 1, "owner-1"); // still running, never failed
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal_transition");
  });

  it("offers safe retry and withholds it when the same run has an open reconciliation", async () => {
    const [work] = await withTenant(TENANT_ID, (db) => db.insert(works).values({
      tenantId: TENANT_ID, initialChannel: "console", initialInstruction: "Verify retry controls",
    }).returning());
    const [owner] = await withTenant(TENANT_ID, (db) => db.insert(users).values({
      tenantId: TENANT_ID, email: `retry-${work!.id}@example.test`, role: "owner", displayName: "Retry owner",
    }).returning());
    const { runId, stepIds } = await newRun(["retryable_step"], work!.id);
    expect(await claimStep(TENANT_ID, stepIds[0]!)).not.toBeNull();
    await failStep(TENANT_ID, stepIds[0]!, "Known local failure");
    await advanceWorkflow(TENANT_ID, runId);
    const projectRun = async () => (await executionProjection(TENANT_ID, work!.id, {
      userId: owner!.id, role: "owner", canControlRuns: true,
    }))?.workflows.find((run) => run.id === runId);
    const eligible = await projectRun();
    expect(eligible?.controls).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "retry" })]));
    await withTenant(TENANT_ID, (db) => db.insert(reconciliationCases).values({
      tenantId: TENANT_ID, relatedStepId: stepIds[0]!, caseType: "unknown_delivery", status: "open",
    }));
    const blocked = await projectRun();
    expect(blocked?.controls.some((control) => control.kind === "retry")).toBe(false);
    expect(blocked?.retryBlocked).toMatchObject({ code: "unresolved_effect" });
    expect(await retryRun(TENANT_ID, runId, eligible!.version, owner!.id)).toEqual({ ok: false, reason: "illegal_transition" });
  });

  it("escalate: running or failed -> escalated, and blocks further claims", async () => {
    const { runId, stepIds } = await newRun();
    const result = await escalateRun(TENANT_ID, runId, 1, "owner-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe("escalated");
    expect(await claimStep(TENANT_ID, stepIds[0]!)).toBeNull();
  });

  it("escalate is illegal from a terminal status", async () => {
    const { runId, stepIds } = await newRun(["only_step"]);
    await claimStep(TENANT_ID, stepIds[0]!);
    await completeStep(TENANT_ID, stepIds[0]!, { ok: true });
    await advanceWorkflow(TENANT_ID, runId);
    const [run] = await withTenant(TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)));
    const result = await escalateRun(TENANT_ID, runId, run!.version, "owner-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal_transition");
  });
});
