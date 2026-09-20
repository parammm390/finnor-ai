// Universal durable single-action acceptance. These tests intentionally assert the
// new API contract: approval returns authorized/queued while canonical state is still
// unchanged; only a persistent worker may cross the effect boundary.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import {
  businessEffects,
  authorityApprovalRequests,
  authorityApprovalRequestSteps,
  actionLog,
  closePool,
  commands,
  decisionReceipts,
  domainActions,
  integrationOperations,
  jobDeliveryAttempts,
  jobs,
  reconciliationCases,
  receiveWork,
  tasks,
  users,
  withTenant,
  workflowRuns,
  workflowStepClaims,
  workflowSteps,
} from "@finnor/db";
import { FinnorOrchestrator, authorizeActionExecutionTx, emitInstructionEvent, executeAuthorizedEffectStep } from "@finnor/orchestration";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_OWNER_EMAIL, SEED_TENANT_ID } from "../../packages/db/seed";
import { runWorkflowStep } from "../../apps/worker/src/handlers/run-workflow-step";
import { JobQueue } from "../../apps/worker/src/queue";
import { cancelRun, claimStep, recoverStaleSteps } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const available = await (async () => {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
})();

let ownerId = "";

async function draftUpdate(title: string) {
  const taskId = randomUUID();
  await withTenant(SEED_TENANT_ID, (db) => db.insert(tasks).values({
    id: taskId,
    tenantId: SEED_TENANT_ID,
    subjectType: "business",
    subjectId: SEED_TENANT_ID,
    title: "Before durable approval",
    status: "open",
    priority: "normal",
  }));
  const orchestrator = new FinnorOrchestrator();
  const drafted = await orchestrator.draftKnownAction("update_task", {
    taskRef: { taskId },
    title,
    status: "done",
    priority: "high",
  }, SEED_TENANT_ID, { initiatedBy: ownerId, source: "phase2_acceptance" });
  expect(drafted.action.businessEffectId).toBeTruthy();
  const [action] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, drafted.action.id)).limit(1));
  expect(action!.status).toBe("pending");
  return { orchestrator, action: action!, taskId, effectId: action!.businessEffectId! };
}

async function durableRows(actionId: string) {
  return withTenant(SEED_TENANT_ID, async (db) => {
    const [step] = await db.select().from(workflowSteps).where(and(eq(workflowSteps.tenantId, SEED_TENANT_ID), eq(workflowSteps.domainActionId, actionId))).limit(1);
    const [run] = step ? await db.select().from(workflowRuns).where(eq(workflowRuns.id, step.workflowRunId)).limit(1) : [];
    const [command] = run ? await db.select().from(commands).where(eq(commands.id, run.commandId)).limit(1) : [];
    return { step, run, command };
  });
}

describe.skipIf(!available)("single-action universal durable boundary", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
    const [owner] = await withTenant(SEED_TENANT_ID, (db) => db.select({ id: users.id }).from(users).where(eq(users.email, SEED_OWNER_EMAIL)).limit(1));
    ownerId = owner!.id;
  });
  afterAll(async () => { await closePool(); });

  it("commits final approval + exact EffectSet intent + first job atomically, and returns before execution", async () => {
    const fixture = await draftUpdate("Executed only by the worker");
    const result = await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    expect(result).toMatchObject({ status: "success", output: { authorized: true, durable: true, queued: true, durableWorkerExecution: true } });

    const beforeWorker = await withTenant(SEED_TENANT_ID, (db) => db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).limit(1));
    expect(beforeWorker[0]).toMatchObject({ title: "Before durable approval", status: "open", priority: "normal" });

    const { command, run, step } = await durableRows(fixture.action.id);
    expect(command).toMatchObject({
      businessEffectId: fixture.effectId,
      status: "running",
      executionClass: "operational_change",
    });
    expect(command!.authorizedEffectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run).toMatchObject({ workflowType: "single_action", status: "running" });
    expect(step).toMatchObject({ stepType: "execute_authorized_effect", status: "pending", executionState: "authorized" });
    const queued = await withTenant(SEED_TENANT_ID, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, `workflow-step:${SEED_TENANT_ID}:${step!.id}`)));
    expect(queued).toHaveLength(1);

    await runWorkflowStep({ tenantId: SEED_TENANT_ID, workflowStepId: step!.id });
    const [afterWorker, action, effect, receipt] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
      db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, step!.id)).then((rows) => rows[0]),
    ]));
    expect(afterWorker).toMatchObject({ title: "Executed only by the worker", status: "done", priority: "high" });
    expect(action!.status).toBe("completed");
    expect(effect).toMatchObject({ status: "verified", semanticHash: command!.authorizedEffectHash });
    expect(receipt).toMatchObject({ executedEffectHash: command!.authorizedEffectHash, verification: expect.objectContaining({ state: "verified" }) });
  });

  it("converges repeated/concurrent final approvals and duplicate worker delivery on one semantic effect", async () => {
    const fixture = await draftUpdate("Exactly one worker effect");
    const approvals = await Promise.all(Array.from({ length: 2 }, () => fixture.orchestrator.decide(
      fixture.action.id,
      SEED_TENANT_ID,
      "approve",
      ownerId,
      { role: "owner" },
    )));
    approvals.push(await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" }));
    expect(approvals.every((result) => result.status === "success")).toBe(true);
    const { step } = await durableRows(fixture.action.id);
    expect(step).toBeTruthy();
    const commandCount = await withTenant(SEED_TENANT_ID, (db) => db.select().from(commands).where(eq(commands.businessEffectId, fixture.effectId)));
    expect(commandCount).toHaveLength(1);

    await Promise.all(Array.from({ length: 4 }, () => runWorkflowStep({ tenantId: SEED_TENANT_ID, workflowStepId: step!.id })));
    const [task, rows] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((result) => result[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)),
    ]));
    expect(task).toMatchObject({ title: "Exactly one worker effect", status: "done" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", attempts: 1, executionState: "verified" });
  });

  it("does not queue execution at an intermediate approval-chain step", async () => {
    const fixture = await draftUpdate("Only the final approver may queue this");
    await withTenant(SEED_TENANT_ID, async (db) => {
      const [request] = await db.select().from(authorityApprovalRequests).where(and(
        eq(authorityApprovalRequests.tenantId, SEED_TENANT_ID),
        eq(authorityApprovalRequests.domainActionId, fixture.action.id),
      )).limit(1);
      const [firstStep] = await db.select().from(authorityApprovalRequestSteps).where(and(
        eq(authorityApprovalRequestSteps.tenantId, SEED_TENANT_ID),
        eq(authorityApprovalRequestSteps.approvalRequestId, request!.id),
        eq(authorityApprovalRequestSteps.sequence, 1),
      )).limit(1);
      await db.insert(authorityApprovalRequestSteps).values({
        tenantId: SEED_TENANT_ID,
        approvalRequestId: request!.id,
        sequence: 2,
        approverCapability: firstStep!.approverCapability,
        minApprovals: 1,
      });
    });
    const intermediate = await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    expect(intermediate).toMatchObject({ status: "success", output: { awaitingNextApproval: true } });
    const [afterIntermediate, noCommands] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(commands).where(eq(commands.businessEffectId, fixture.effectId)),
    ]));
    expect(afterIntermediate!.status).toBe("pending");
    expect(noCommands).toHaveLength(0);

    const final = await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    expect(final).toMatchObject({ status: "success", output: { queued: true, durable: true } });
    expect((await durableRows(fixture.action.id)).step).toMatchObject({ status: "pending", executionState: "authorized" });
  });

  it("makes rejection terminal before any executable intent exists", async () => {
    const fixture = await draftUpdate("Rejected effects never execute");
    expect(await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "reject", ownerId, { role: "owner", reason: "Not authorized by the owner" })).toMatchObject({ status: "success", output: { rejected: true } });
    const [action, effect, commandRows] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
      db.select().from(commands).where(eq(commands.businessEffectId, fixture.effectId)),
    ]));
    expect(action!.status).toBe("rejected");
    expect(effect!.status).toBe("cancelled");
    expect(commandRows).toHaveLength(0);
  });

  it("refuses a late approval after the instruction cancellation fence commits", async () => {
    const fixture = await draftUpdate("Cancelled Work must never authorize");
    const received = await receiveWork({
      tenantId: SEED_TENANT_ID,
      userId: ownerId,
      instruction: "Update the task after approval",
      channel: "text",
      instructionId: randomUUID(),
    });
    await withTenant(SEED_TENANT_ID, (db) => db.update(domainActions).set({
      workId: received.workId,
      instructionId: received.instructionId,
    }).where(and(eq(domainActions.tenantId, SEED_TENANT_ID), eq(domainActions.id, fixture.action.id))));
    await emitInstructionEvent(SEED_TENANT_ID, received.instructionId, "cancelled", {
      fence: true,
      canonical: false,
      requestedBy: ownerId,
    });

    const approval = await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    expect(approval).toMatchObject({ status: "failure", output: { cancelled: true } });
    const [action, commandRows] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(commands).where(eq(commands.businessEffectId, fixture.effectId)),
    ]));
    expect(action!.status).toBe("pending");
    expect(commandRows).toHaveLength(0);
  });

  it("rolls back both approval state and executable intent when the authorization transaction does not commit", async () => {
    const fixture = await draftUpdate("Rolled back transaction");
    await expect(withTenant(SEED_TENANT_ID, async (db) => {
      await db.update(domainActions).set({ status: "approved" }).where(and(eq(domainActions.tenantId, SEED_TENANT_ID), eq(domainActions.id, fixture.action.id), eq(domainActions.status, "pending")));
      const [effect] = await db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).limit(1);
      await db.insert(actionLog).values({
        tenantId: SEED_TENANT_ID,
        domainActionId: fixture.action.id,
        step: "confirmed",
        input: { by: ownerId },
        output: { businessEffectId: fixture.effectId, authorizedEffectHash: effect!.semanticHash },
      });
      await authorizeActionExecutionTx(db, { tenantId: SEED_TENANT_ID, actionId: fixture.action.id, approvedBy: ownerId, authorizationSource: "human_approval" });
      throw new Error("injected_crash_before_commit");
    })).rejects.toThrow("injected_crash_before_commit");
    const [action, commandRows] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(commands).where(eq(commands.businessEffectId, fixture.effectId)),
    ]));
    expect(action!.status).toBe("pending");
    expect(commandRows).toHaveLength(0);
  });

  it("cancels an authorized unclaimed effect with a hard no-mutation guarantee", async () => {
    const fixture = await draftUpdate("Must never be written");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { run, step } = await durableRows(fixture.action.id);
    const cancelled = await cancelRun(SEED_TENANT_ID, run!.id, run!.version, ownerId);
    expect(cancelled.ok).toBe(true);
    await runWorkflowStep({ tenantId: SEED_TENANT_ID, workflowStepId: step!.id });

    const [task, action, effect, storedStep] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
    ]));
    expect(task).toMatchObject({ title: "Before durable approval", status: "open" });
    expect(action!.status).toBe("rejected");
    expect(effect!.status).toBe("cancelled");
    expect(storedStep).toMatchObject({ status: "failed", executionState: "cancelled_before_effect" });
  });

  it("lets cancellation win after local claim but before the effect commit point", async () => {
    const fixture = await draftUpdate("Claimed but cancelled before commit");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { run, step } = await durableRows(fixture.action.id);
    expect(await claimStep(SEED_TENANT_ID, step!.id)).toMatchObject({ executionState: "claimed" });
    expect((await cancelRun(SEED_TENANT_ID, run!.id, run!.version, ownerId)).ok).toBe(true);
    // Simulates the already-running worker continuing after its eligibility checks.
    await executeAuthorizedEffectStep(SEED_TENANT_ID, step!.id);
    const [task, storedStep] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
    ]));
    expect(task).toMatchObject({ title: "Before durable approval", status: "open" });
    expect(storedStep).toMatchObject({ status: "failed", executionState: "cancelled_before_effect", effectCommitAt: null });
  });

  it("fails closed when the initiating employee loses authority after approval", async () => {
    const fixture = await draftUpdate("Revoked authority must not write");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { step } = await durableRows(fixture.action.id);
    await withTenant(SEED_TENANT_ID, (db) => db.update(users).set({ status: "suspended" }).where(and(eq(users.tenantId, SEED_TENANT_ID), eq(users.id, ownerId))));
    try {
      await runWorkflowStep({ tenantId: SEED_TENANT_ID, workflowStepId: step!.id });
    } finally {
      await withTenant(SEED_TENANT_ID, (db) => db.update(users).set({ status: "active" }).where(and(eq(users.tenantId, SEED_TENANT_ID), eq(users.id, ownerId))));
    }
    const [task, action, effect, storedStep] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
    ]));
    expect(task).toMatchObject({ title: "Before durable approval", status: "open" });
    expect(action!.status).toBe("needs_human_review");
    expect(effect!.status).toBe("cancelled");
    expect(storedStep).toMatchObject({ status: "failed", executionState: "blocked", effectCommitAt: null });
  });

  it("records an authority revocation as causal-ready but execution-ineligible before any runtime claim", async () => {
    const fixture = await draftUpdate("Pre-claim revocation must not write");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { command, run, step } = await durableRows(fixture.action.id);
    expect(step).toMatchObject({
      protocolVersion: 2,
      status: "pending",
      executionState: "authorized",
      causalReadyAt: expect.any(Date),
      executionEligibleAt: null,
      attempts: 0,
    });

    const [targetJob] = await withTenant(SEED_TENANT_ID, (db) => db.update(jobs).set({
      priority: 1_000_000,
      runAt: new Date(0),
    }).where(eq(jobs.idempotencyKey, `workflow-step:${SEED_TENANT_ID}:${step!.id}`)).returning());
    expect(targetJob).toMatchObject({ type: "run_workflow_step_v2", protocolVersion: 2, status: "queued" });

    const workerId = `eligibility-certifier:${randomUUID()}`;
    const queue = new JobQueue(workerId, 30);
    queue.register("run_workflow_step_v2", runWorkflowStep, {
      protocolVersions: [2],
      retrySafety: "durably_effect_guarded",
    });
    await withTenant(SEED_TENANT_ID, (db) => db.update(users).set({ status: "suspended" }).where(and(
      eq(users.tenantId, SEED_TENANT_ID),
      eq(users.id, ownerId),
    )));
    try {
      expect(await queue.tick()).toBe(true);
    } finally {
      await withTenant(SEED_TENANT_ID, (db) => db.update(users).set({ status: "active" }).where(and(
        eq(users.tenantId, SEED_TENANT_ID),
        eq(users.id, ownerId),
      )));
    }

    const observed = await withTenant(SEED_TENANT_ID, async (db) => {
      const [task, action, effect, storedStep, storedRun, storedCommand, storedJob] = await Promise.all([
        db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
        db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
        db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
        db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
        db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id)).then((rows) => rows[0]),
        db.select().from(commands).where(eq(commands.id, command!.id)).then((rows) => rows[0]),
        db.select().from(jobs).where(eq(jobs.id, targetJob!.id)).then((rows) => rows[0]),
      ]);
      const [claims, deliveries] = await Promise.all([
        db.select().from(workflowStepClaims).where(and(
          eq(workflowStepClaims.tenantId, SEED_TENANT_ID),
          eq(workflowStepClaims.workflowStepId, step!.id),
        )),
        db.select().from(jobDeliveryAttempts).where(and(
          eq(jobDeliveryAttempts.tenantId, SEED_TENANT_ID),
          eq(jobDeliveryAttempts.jobId, targetJob!.id),
        )),
      ]);
      return { task, action, effect, storedStep, storedRun, storedCommand, storedJob, claims, deliveries };
    });
    expect(observed.task).toMatchObject({ title: "Before durable approval", status: "open" });
    expect(observed.action).toMatchObject({ status: "needs_human_review", executionStartedAt: null });
    // Scope 2 records the runtime refusal. It must not invent a Scope-1 CANCEL.
    expect(observed.effect).toMatchObject({ status: "authorized" });
    expect(observed.storedStep).toMatchObject({
      status: "failed",
      executionState: "blocked",
      causalReadyAt: expect.any(Date),
      executionEligibleAt: null,
      claimedAt: null,
      claimToken: null,
      attempts: 0,
      effectCommitAt: null,
      eligibilityEvidence: expect.objectContaining({
        eligible: false,
        authorityIsNotCausality: true,
        effectCommitCrossed: false,
      }),
    });
    expect(observed.storedRun).toMatchObject({ status: "failed" });
    expect(observed.storedCommand).toMatchObject({ status: "failed" });
    expect(observed.storedJob).toMatchObject({ status: "completed", attempts: 1 });
    expect(observed.claims).toHaveLength(0);
    expect(observed.deliveries).toHaveLength(1);
    expect(observed.deliveries[0]).toMatchObject({ workerId, outcome: "completed" });
  });

  it("does not execute an approved effect after its material target precondition changes", async () => {
    const fixture = await draftUpdate("Stale effect must not overwrite current truth");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { step } = await durableRows(fixture.action.id);
    await withTenant(SEED_TENANT_ID, (db) => db.update(tasks).set({ title: "Changed after approval", priority: "low" }).where(and(eq(tasks.tenantId, SEED_TENANT_ID), eq(tasks.id, fixture.taskId))));
    await runWorkflowStep({ tenantId: SEED_TENANT_ID, workflowStepId: step!.id });
    const [task, action, effect, storedStep] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
    ]));
    expect(task).toMatchObject({ title: "Changed after approval", status: "open", priority: "low" });
    expect(action!.status).toBe("needs_human_review");
    expect(effect!.status).toBe("cancelled");
    expect(storedStep).toMatchObject({ status: "failed", executionState: "blocked", effectCommitAt: null });
  });

  it("treats cancellation after the effect commit point as reconciliation, never rollback", async () => {
    const fixture = await draftUpdate("Possible effect must be reconciled");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { run, step } = await durableRows(fixture.action.id);
    await claimStep(SEED_TENANT_ID, step!.id);
    await withTenant(SEED_TENANT_ID, async (db) => {
      await db.insert(integrationOperations).values({
        tenantId: SEED_TENANT_ID,
        workflowStepId: step!.id,
        businessEffectId: fixture.effectId,
        operationKey: `business-effect:${step!.id}`,
        capability: "action:update_task",
        provider: "injected_possible_acceptance",
        requestHash: "injected-commit-boundary",
        status: "running",
      });
      await db.update(workflowSteps).set({ executionState: "commit_started", effectCommitAt: new Date() }).where(and(eq(workflowSteps.tenantId, SEED_TENANT_ID), eq(workflowSteps.id, step!.id)));
      await db.update(businessEffects).set({ status: "executing", executionStartedAt: new Date() }).where(and(eq(businessEffects.tenantId, SEED_TENANT_ID), eq(businessEffects.id, fixture.effectId)));
    });
    expect((await cancelRun(SEED_TENANT_ID, run!.id, run!.version, ownerId)).ok).toBe(true);
    await runWorkflowStep({ tenantId: SEED_TENANT_ID, workflowStepId: step!.id });
    const [task, action, effect, storedStep, cases] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
      db.select().from(reconciliationCases).where(and(eq(reconciliationCases.tenantId, SEED_TENANT_ID), eq(reconciliationCases.businessEffectId, fixture.effectId))),
    ]));
    expect(task).toMatchObject({ title: "Before durable approval", status: "open" });
    expect(action!.status).toBe("needs_human_review");
    expect(effect!.status).toBe("reconciliation_required");
    expect(storedStep).toMatchObject({ status: "leased", executionState: "cancellation_requested" });
    expect(cases).toHaveLength(1);
  });

  it("recovers a crash after possible provider acceptance without blind redelivery", async () => {
    const fixture = await draftUpdate("Unknown delivery must not repeat");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { step } = await durableRows(fixture.action.id);
    await claimStep(SEED_TENANT_ID, step!.id);
    await withTenant(SEED_TENANT_ID, async (db) => {
      await db.insert(integrationOperations).values({
        tenantId: SEED_TENANT_ID,
        workflowStepId: step!.id,
        businessEffectId: fixture.effectId,
        operationKey: `business-effect:${fixture.effectId}`,
        capability: "action:update_task",
        provider: "injected_crash_after_send",
        requestHash: "injected-possible-acceptance",
        status: "running",
      });
      await db.update(workflowSteps).set({ executionState: "commit_started", effectCommitAt: new Date(), leaseExpiresAt: new Date(Date.now() - 1_000) }).where(and(eq(workflowSteps.tenantId, SEED_TENANT_ID), eq(workflowSteps.id, step!.id)));
      await db.update(businessEffects).set({ status: "executing", executionStartedAt: new Date() }).where(and(eq(businessEffects.tenantId, SEED_TENANT_ID), eq(businessEffects.id, fixture.effectId)));
    });
    expect((await recoverStaleSteps(SEED_TENANT_ID)).reconciled).toBeGreaterThanOrEqual(1);
    await runWorkflowStep({ tenantId: SEED_TENANT_ID, workflowStepId: step!.id });
    const [task, action, effect, storedStep, operations, cases] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, fixture.action.id)).then((rows) => rows[0]),
      db.select().from(businessEffects).where(eq(businessEffects.id, fixture.effectId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
      db.select().from(integrationOperations).where(eq(integrationOperations.workflowStepId, step!.id)),
      db.select().from(reconciliationCases).where(and(eq(reconciliationCases.tenantId, SEED_TENANT_ID), eq(reconciliationCases.relatedStepId, step!.id))),
    ]));
    expect(task).toMatchObject({ title: "Before durable approval", status: "open" });
    expect(action!.status).toBe("needs_human_review");
    expect(effect!.status).toBe("reconciliation_required");
    expect(storedStep).toMatchObject({ status: "waiting_observation", executionState: "reconciling", claimToken: null });
    expect(operations).toHaveLength(1);
    expect(operations[0]!.status).toBe("unknown");
    expect(cases).toHaveLength(1);
  });

  it("fails closed when a forged tenant tries to claim another tenant's durable step", async () => {
    const fixture = await draftUpdate("Cross-tenant claim must not write");
    await fixture.orchestrator.decide(fixture.action.id, SEED_TENANT_ID, "approve", ownerId, { role: "owner" });
    const { step } = await durableRows(fixture.action.id);
    await runWorkflowStep({ tenantId: randomUUID(), workflowStepId: step!.id });
    const [task, storedStep] = await withTenant(SEED_TENANT_ID, async (db) => Promise.all([
      db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, step!.id)).then((rows) => rows[0]),
    ]));
    expect(task).toMatchObject({ title: "Before durable approval", status: "open" });
    expect(storedStep).toMatchObject({ status: "pending", executionState: "authorized", attempts: 0 });
  });
});
