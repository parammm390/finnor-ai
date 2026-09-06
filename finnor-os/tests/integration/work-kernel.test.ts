import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  beginWorkPlannerAttempt,
  claimWorkRecovery,
  closePool,
  domainActions,
  finishWorkPlannerAttempt,
  receiveWork,
  reconcileWorkStatus,
  tenants,
  transitionWork,
  WorkTransitionConflictError,
  withTenant,
  workAggregate,
} from "@finnor/db";
import { FinnorOrchestrator } from "@finnor/orchestration";
import { openReceipt, submitCommand } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000092f2";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await dbUp();

describe.skipIf(!available)("Upgrade 2 durable Work kernel", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.SECRETS_PROVIDER = "env";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Work Kernel Test Dealer" }).onConflictDoNothing());
  });

  afterAll(async () => {
    await closePool();
  });

  it("claims intake exactly once and lets typed and voice inputs continue the same Work/context", async () => {
    const instructionId = randomUUID();
    const idempotencyKey = `work-kernel:${randomUUID()}`;
    const first = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Prepare the Peterson service visit",
      instructionId,
      idempotencyKey,
      sessionId: "shared-session",
      channel: "text",
      activeContext: { dealId: "deal-a" },
    });
    const duplicate = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Prepare the Peterson service visit",
      instructionId,
      idempotencyKey,
      sessionId: "shared-session",
      channel: "text",
    });
    await transitionWork(TENANT_ID, first.workId, "failed", "planning_failed", { message: "test failure" });
    const continuation = await receiveWork({
      tenantId: TENANT_ID,
      workId: first.workId,
      instructionId: randomUUID(),
      idempotencyKey: `work-kernel:${randomUUID()}`,
      instruction: "Make that tomorrow morning",
      sessionId: "shared-session",
      channel: "voice",
      activeContext: { appointmentWindow: "morning" },
    });

    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({ workId: first.workId, workInputId: first.workInputId, duplicate: true });
    expect(continuation.workId).toBe(first.workId);
    const aggregate = await workAggregate(TENANT_ID, first.workId);
    expect(aggregate).not.toBeNull();
    expect((aggregate!.inputs as unknown[])).toHaveLength(2);
    expect((aggregate!.work as { status: string; sessionId: string; activeContext: Record<string, unknown> })).toMatchObject({
      status: "recovery",
      sessionId: "shared-session",
      activeContext: { dealId: "deal-a" },
    });
    expect((aggregate!.events as Array<{ seq: number; eventType: string }>).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((aggregate!.events as Array<{ eventType: string }>).at(-1)?.eventType).toBe("recovery_input_received");
  });

  it("keeps cancellation terminal against late planner and child reconciliation writes", async () => {
    const received = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Plan something slowly",
      instructionId: randomUUID(),
      channel: "text",
    });
    await transitionWork(TENANT_ID, received.workId, "planning", "planning_started", {}, { expectedWorkInputId: received.workInputId });
    await transitionWork(TENANT_ID, received.workId, "cancelled", "cancelled", { requestedBy: "test" });
    await withTenant(TENANT_ID, (db) => db.insert(domainActions).values({
      tenantId: TENANT_ID,
      workId: received.workId,
      instructionId: received.instructionId,
      actionType: "late_planner_draft",
      payload: {},
      status: "draft",
    }));

    await expect(transitionWork(
      TENANT_ID,
      received.workId,
      "ready",
      "planner_succeeded",
      {},
      { expectedWorkInputId: received.workInputId },
    )).rejects.toBeInstanceOf(WorkTransitionConflictError);
    expect(await reconcileWorkStatus(TENANT_ID, received.workId)).toBe("cancelled");
    expect((await workAggregate(TENANT_ID, received.workId))!.work).toMatchObject({ status: "cancelled" });
  });

  it("requires an explicit recovery transition before failed Work can become ready again", async () => {
    const received = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Exercise the failed Work fence",
      instructionId: randomUUID(),
      channel: "text",
    });
    await transitionWork(TENANT_ID, received.workId, "failed", "planning_failed", { message: "test failure" });

    await expect(transitionWork(
      TENANT_ID,
      received.workId,
      "ready",
      "stale_planner_succeeded",
      {},
      { expectedWorkInputId: received.workInputId },
    )).rejects.toBeInstanceOf(WorkTransitionConflictError);

    await transitionWork(TENANT_ID, received.workId, "recovery", "retry_requested", { requestedBy: "test" });
    await transitionWork(TENANT_ID, received.workId, "ready", "recovery_ready");
    expect((await workAggregate(TENANT_ID, received.workId))!.work).toMatchObject({ status: "ready" });
  });

  it("allows only one concurrent recovery lease across distinct request keys", async () => {
    const received = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Exercise concurrent recovery claims",
      instructionId: randomUUID(),
      channel: "text",
    });
    await transitionWork(TENANT_ID, received.workId, "failed", "planning_failed", { message: "test failure" });

    const claims = await Promise.all([
      claimWorkRecovery({ tenantId: TENANT_ID, workId: received.workId, attemptKey: "retry:one", requestedBy: "test" }),
      claimWorkRecovery({ tenantId: TENANT_ID, workId: received.workId, attemptKey: "retry:two", requestedBy: "test" }),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.claimed)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.activeAttemptKey)).size).toBe(1);
    expect((await workAggregate(TENANT_ID, received.workId))!.work).toMatchObject({ status: "recovery" });
  });

  it("allows only a newer explicit input to continue cancelled Work", async () => {
    const first = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "First turn",
      instructionId: randomUUID(),
      channel: "text",
    });
    await transitionWork(TENANT_ID, first.workId, "cancelled", "cancelled", { requestedBy: "test" });
    const continuation = await receiveWork({
      tenantId: TENANT_ID,
      workId: first.workId,
      instruction: "Continue with a new turn",
      instructionId: randomUUID(),
      channel: "text",
    });

    await expect(transitionWork(
      TENANT_ID,
      first.workId,
      "planning",
      "stale_planner_write",
      {},
      { expectedWorkInputId: first.workInputId },
    )).rejects.toBeInstanceOf(WorkTransitionConflictError);
    await transitionWork(
      TENANT_ID,
      first.workId,
      "understanding",
      "understanding_started",
      { workInputId: continuation.workInputId },
      { expectedWorkInputId: continuation.workInputId },
    );
    expect((await workAggregate(TENANT_ID, first.workId))!.work).toMatchObject({ status: "understanding" });
  });

  it("reconciles an all-rejected plan as cancelled, never completed", async () => {
    const received = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Propose an action that the owner rejects",
      instructionId: randomUUID(),
      channel: "text",
    });
    await withTenant(TENANT_ID, (db) => db.insert(domainActions).values({
      tenantId: TENANT_ID,
      workId: received.workId,
      instructionId: received.instructionId,
      actionType: "rejected_plan_action",
      payload: {},
      status: "rejected",
    }));
    expect(await reconcileWorkStatus(TENANT_ID, received.workId)).toBe("cancelled");
    expect((await workAggregate(TENANT_ID, received.workId))!.work).toMatchObject({ status: "cancelled" });
  });

  it("accepts meaningful persistent work before a legacy one-shot planner can time out and deduplicates the Objective", async () => {
    let plannerCalls = 0;
    const planner = {
      async plan() {
        plannerCalls += 1;
        throw new Error("The one-shot planner must not own meaningful persistent work");
      },
    };
    const orchestrator = new FinnorOrchestrator({
      planner,
      fastReadOnlyRouter: { classify: () => ({ route: "planner", reason: "unsupported" }), route: async () => null },
    });
    const instructionId = randomUUID();
    const opts = { instructionId, idempotencyKey: `planner-failure:${randomUUID()}`, channel: "text" as const };

    const first = await orchestrator.handleInstructionResult("Schedule a service visit for the Petersons and keep responsibility until it is confirmed", {
      tenantId: TENANT_ID,
      userId: "system:test",
      role: "owner",
    }, opts);
    const retry = await orchestrator.handleInstructionResult("Schedule a service visit for the Petersons and keep responsibility until it is confirmed", {
      tenantId: TENANT_ID,
      userId: "system:test",
      role: "owner",
    }, opts);

    expect(first).toMatchObject({ workId: instructionId, instructionId, actions: [], objective: { route: "OBJECTIVE", state: "continue" } });
    expect(retry).toMatchObject({ workId: instructionId, instructionId, objective: { objectiveLoopId: first.objective!.objectiveLoopId } });
    expect(plannerCalls).toBe(0);
    const aggregate = await workAggregate(TENANT_ID, instructionId);
    expect((aggregate!.work as { status: string; executionModel: string }).status).toBe("executing");
    expect((aggregate!.work as { executionModel: string }).executionModel).toBe("objective");
    expect(aggregate!.plannerAttempts).toHaveLength(0);
    expect(aggregate!.objectiveLoop).toMatchObject({ id: first.objective!.objectiveLoopId, state: "continue" });
  });

  it("aggregates planner, action, workflow, and receipt evidence through durable foreign keys", async () => {
    const received = await receiveWork({ tenantId: TENANT_ID, instruction: "Run linked work", instructionId: randomUUID(), channel: "console" });
    const attempt = await beginWorkPlannerAttempt({ tenantId: TENANT_ID, workId: received.workId, workInputId: received.workInputId, attemptKey: "input" });
    const duplicateAttempt = await beginWorkPlannerAttempt({ tenantId: TENANT_ID, workId: received.workId, workInputId: received.workInputId, attemptKey: "input" });
    expect(duplicateAttempt).toMatchObject({ id: attempt.id, claimed: false, attempt: 1 });
    const [action] = await withTenant(TENANT_ID, (db) => db.insert(domainActions).values({
      tenantId: TENANT_ID,
      workId: received.workId,
      plannerAttemptId: attempt.id,
      instructionId: received.instructionId,
      actionType: "test_work_action",
      payload: {},
      status: "approved",
    }).returning());
    await finishWorkPlannerAttempt({ tenantId: TENANT_ID, attemptId: attempt.id, status: "succeeded", plannerResult: { actionIds: [action!.id] } });
    const command = await withTenant(TENANT_ID, (db) => submitCommand(db, {
      tenantId: TENANT_ID,
      workId: received.workId,
      domainActionId: action!.id,
      commandType: "test_work_command",
      workflowType: "test_workflow",
      payload: {},
      steps: [{ stepType: "test_step", payload: {} }],
    }));
    await openReceipt({
      tenantId: TENANT_ID,
      workId: received.workId,
      workflowRunId: command.workflowRunId,
      workflowStepId: command.stepIds[0],
      domainActionId: action!.id,
      objective: "Prove linked evidence",
      evidence: [{ source: "test", ref: action!.id, timestamp: new Date().toISOString() }],
      policyApplied: null,
      riskTier: "low",
      proposedAction: {},
      approval: { required: false },
    });

    const aggregate = await workAggregate(TENANT_ID, received.workId);
    expect(aggregate!.plannerAttempts).toHaveLength(1);
    expect(aggregate!.actions).toEqual([expect.objectContaining({ id: action!.id, workId: received.workId })]);
    expect(aggregate!.workflowRuns).toEqual([expect.objectContaining({ id: command.workflowRunId, workId: received.workId })]);
    expect(aggregate!.receipts).toEqual([expect.objectContaining({ workId: received.workId, domainActionId: action!.id })]);
  });
});
