import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { migrate } from "../../packages/db/migrate";
import {
  authorityDecisions,
  closePool,
  communicationsLog,
  domainActions,
  households,
  jobs,
  sandboxOutbox,
  tenants,
  users,
  withTenant,
  workAggregate,
  workEventWaits,
  workObjectiveLoops,
  workObjectivePlannerAttempts,
  workObjectiveSteps,
  workflowRuns,
  workflowSteps,
  getPool,
  CURRENT_MIGRATION_HEAD,
} from "@finnor/db";
import { ToolRegistry } from "@finnor/tools";
import {
  controlWorkObjective,
  executeAuthorizedEffectStep,
  FinnorOrchestrator,
  processWorkEventWaitDeadline,
  recoverRunnableObjectives,
  type ObjectiveDecision,
  type ObjectiveDecisionPlanner,
  type ObjectiveInspection,
} from "@finnor/orchestration";
import { claimStep, retryRun } from "@finnor/workflow-runtime";
import { runWorkflowStep } from "../../apps/worker/src/handlers/run-workflow-step";
import { POST as startObjectiveRoute } from "../../apps/api/app/api/objectives/route";
import { GET as getObjectiveRoute, POST as controlObjectiveRoute } from "../../apps/api/app/api/works/[id]/objective/route";
import { citeObservedObjectiveEvidence } from "./helpers/objective-completion-evidence";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

const available = await dbUp();

async function durableStepForAction(tenantId: string, actionId: string) {
  const [step] = await withTenant(tenantId, (db) => db.select().from(workflowSteps).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.domainActionId, actionId),
  )).limit(1));
  if (!step) throw new Error(`No durable workflow step for action ${actionId}`);
  const [run] = await withTenant(tenantId, (db) => db.select().from(workflowRuns).where(and(
    eq(workflowRuns.tenantId, tenantId),
    eq(workflowRuns.id, step.workflowRunId),
  )).limit(1));
  if (!run) throw new Error(`No durable workflow run for action ${actionId}`);
  return { step, run };
}

class ScriptedPlanner implements ObjectiveDecisionPlanner {
  providerName = "scripted-objective-test";
  calls = 0;

  constructor(private script: Array<ObjectiveDecision | Error | ((inspection: ObjectiveInspection) => ObjectiveDecision)>) {}

  async decide(input: { inspection: ObjectiveInspection }): Promise<ObjectiveDecision> {
    const item = this.script[this.calls++];
    if (!item) throw new Error("Scripted planner exhausted");
    if (item instanceof Error) throw item;
    return citeObservedObjectiveEvidence(typeof item === "function" ? item(input.inspection) : item, input.inspection);
  }
}

describe.skipIf(!available)("Upgrade 9 governed agentic objective loop", () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const ownerId = randomUUID();
  const suspendedId = randomUUID();
  const householdId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.SECRETS_PROVIDER = "env";
    process.env.COMMS_MODE = "sandbox";
    process.env.FINNOR_ENVIRONMENT = "test";
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await getPool().query(
      `INSERT INTO finnor_os.service_release_heartbeats
        (service,instance_id,release_sha,build_id,version,release_source,migration_head,environment,last_beat_at)
       VALUES ('worker','agentic-objective-test','test','test','test','vitest',$1,'test',now())
       ON CONFLICT (service,instance_id) DO UPDATE
       SET migration_head=excluded.migration_head, last_beat_at=now()`,
      [CURRENT_MIGRATION_HEAD],
    );
    await withTenant(tenantId, async (db) => {
      await db.insert(tenants).values({ id: tenantId, name: "Objective Loop Test Dealer" });
      await db.insert(users).values({ id: ownerId, tenantId, email: `objective-owner-${tenantId}@example.test`, role: "owner", displayName: "Objective Owner" });
      await db.insert(users).values({ id: suspendedId, tenantId, email: `objective-suspended-${tenantId}@example.test`, role: "technician", displayName: "Suspended Objective Employee", status: "suspended" });
      await db.insert(households).values({
        id: householdId,
        tenantId,
        address: "42 Objective Loop Lane",
        contactInfo: { name: "Avery Objective", phone: "+15550191919" },
        marketingConsent: true,
      });
    });
    await withTenant(otherTenantId, (db) => db.insert(tenants).values({ id: otherTenantId, name: "Objective Loop Other Dealer" }));
  });

  afterAll(async () => {
    await closePool();
  });

  const ctx = { tenantId, userId: ownerId, employeeId: ownerId, role: "owner" as const };

  it("owns a customer follow-up through deterministic reads, approval, real action observation, and completion", async () => {
    const planner = new ScriptedPlanner([
      { kind: "query", request: { intent: "customer_lookup", householdId }, reason: "Confirm the exact customer before contact.", nextStep: "Send the follow-up if it is still needed." },
      { kind: "action", actionType: "send_follow_up", payload: { householdId, context: "the recent service visit" }, reason: "The live customer record shows a follow-up is still due.", nextStep: "Observe the delivery receipt and customer history." },
      (inspection) => {
        const completed = (inspection.actions as Array<{ actionType: string; status: string }>).some((action) => action.actionType === "send_follow_up" && action.status === "completed");
        if (!completed) throw new Error("The planner was asked to complete before observing the real action result");
        return { kind: "complete", outcome: { customerFollowUp: "sent_and_observed" }, reason: "The outbound follow-up and its completed receipt are now canonical; no further send is necessary." };
      },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Follow up with Avery about the recent service visit and own it until the contact is actually recorded.", ctx, {
      idempotencyKey: `objective:follow-up:${randomUUID()}`,
      activeContext: { householdId },
      maxSteps: 8,
      maxActions: 2,
      maxQueries: 4,
    });

    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("continue");
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("awaiting_approval");
    const beforeApproval = await workAggregate(tenantId, started.workId);
    const action = (beforeApproval!.actions as Array<typeof domainActions.$inferSelect>).find((row) => row.actionType === "send_follow_up")!;
    expect(action).toMatchObject({ status: "pending", initiatedBy: ownerId, objectiveStepId: expect.any(String) });

    const approved = await orchestrator.decide(action.id, tenantId, "approve", ownerId, { role: "owner" });
    expect(approved).toMatchObject({ status: "success", output: { queued: true, durable: true } });
    const { step } = await durableStepForAction(tenantId, action.id);
    await runWorkflowStep({ tenantId, workflowStepId: step.id });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");

    const aggregate = await workAggregate(tenantId, started.workId);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "completed", stepCount: 3, actionCount: 1, queryCount: 2 });
    expect(aggregate!.objectiveSteps.map((step) => step.iterationOutcome)).toEqual(["continue", "awaiting_approval", "completed"]);
    expect((aggregate!.work as { status: string }).status).toBe("completed");
    expect(aggregate!.queryExecutions.length).toBeGreaterThanOrEqual(4); // business/company inspection each iteration + selected lookup
    expect(aggregate!.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ domainActionId: action.id, finalizedAt: expect.any(Date) })]));
    const outbox = await withTenant(tenantId, (db) => db.select().from(sandboxOutbox).where(and(eq(sandboxOutbox.tenantId, tenantId), eq(sandboxOutbox.toNumber, "+15550191919"))));
    expect(outbox).toHaveLength(1);

    // Restart/idempotency proof: stale recovery scans and duplicate action resumes
    // cannot enqueue or perform a second effect after terminal completion.
    await recoverRunnableObjectives(tenantId);
    await recoverRunnableObjectives(tenantId);
    const afterRecovery = await withTenant(tenantId, (db) => db.select().from(sandboxOutbox).where(and(eq(sandboxOutbox.tenantId, tenantId), eq(sandboxOutbox.toNumber, "+15550191919"))));
    expect(afterRecovery).toHaveLength(1);
  });

  it("persists a provider failure and recovers the same iteration without losing its inspection", async () => {
    const planner = new ScriptedPlanner([
      new Error("planning provider timeout"),
      { kind: "complete", outcome: { recovered: true }, reason: "The provider recovered and canonical state shows no further business action is required." },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Inspect the business and close this objective once provider planning recovers.", ctx, {
      idempotencyKey: `objective:provider-recovery:${randomUUID()}`,
      maxSteps: 4,
      maxPlannerFailures: 3,
    });
    await expect(orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).rejects.toThrow("provider timeout");
    const afterFailure = await workAggregate(tenantId, started.workId);
    expect(afterFailure!.objectiveLoop).toMatchObject({ state: "continue", stepCount: 1, plannerFailureCount: 1 });
    expect(afterFailure!.objectiveSteps).toEqual([expect.objectContaining({ phase: "deciding", completedAt: null })]);
    expect(afterFailure!.objectivePlannerAttempts).toEqual([expect.objectContaining({ status: "timed_out", attempt: 1 })]);

    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    const recovered = await withTenant(tenantId, async (db) => ({
      steps: await db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.objectiveLoopId, started.objectiveLoopId)),
      attempts: await db.select().from(workObjectivePlannerAttempts).where(eq(workObjectivePlannerAttempts.objectiveLoopId, started.objectiveLoopId)),
    }));
    expect(recovered.steps).toHaveLength(1);
    expect(recovered.attempts.map((attempt) => attempt.status)).toEqual(["timed_out", "succeeded"]);
    expect(recovered.attempts[0]!.inspectionHash).toBeTruthy();
    expect(recovered.attempts[1]!.inspectionHash).toBeTruthy();
  });

  it("classifies an invalid model-selected typed query as a recoverable planner failure", async () => {
    const planner = new ScriptedPlanner([
      { kind: "query", request: { intent: "customer_lookup" }, reason: "The model omitted the required selector." },
      { kind: "complete", outcome: { recoveredFromInvalidQuery: true }, reason: "The retry used the persisted validation failure and canonical state; no query was executed." },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Recover safely when a model emits an invalid typed query.", ctx, {
      idempotencyKey: `objective:invalid-query-recovery:${randomUUID()}`,
      maxSteps: 3,
      maxPlannerFailures: 2,
    });

    await expect(orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).rejects.toThrow(/semantic validation/);
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    const aggregate = await workAggregate(tenantId, started.workId);
    expect(aggregate!.objectiveSteps).toHaveLength(1);
    expect(aggregate!.objectivePlannerAttempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "completed", stepCount: 1, queryCount: 1, plannerFailureCount: 1 });
  });

  it("leases an iteration so concurrent workers cannot make two model decisions", async () => {
    let releasePlanner!: () => void;
    let plannerStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releasePlanner = resolve; });
    const startedPlanning = new Promise<void>((resolve) => { plannerStarted = resolve; });
    let calls = 0;
    const planner: ObjectiveDecisionPlanner = {
      providerName: "leased-objective-test",
      async decide(input) {
        calls += 1;
        plannerStarted();
        await gate;
        return citeObservedObjectiveEvidence({ kind: "complete", outcome: { leased: true }, reason: "Only the lease holder made this decision." }, input.inspection);
      },
    };
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const objective = await orchestrator.startObjective("Prove concurrent workers cannot decide twice.", ctx, { idempotencyKey: `objective:lease:${randomUUID()}` });
    const first = orchestrator.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId });
    await startedPlanning;
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("continue");
    expect(calls).toBe(1);
    releasePlanner();
    expect(await first).toBe("completed");
    expect((await workAggregate(tenantId, objective.workId))!.objectiveSteps).toHaveLength(1);
  });

  it("discards a late model decision when a person interrupts the objective mid-iteration", async () => {
    let releasePlanner!: () => void;
    let plannerStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releasePlanner = resolve; });
    const startedPlanning = new Promise<void>((resolve) => { plannerStarted = resolve; });
    const planner: ObjectiveDecisionPlanner = {
      providerName: "late-decision-test",
      async decide() {
        plannerStarted();
        await gate;
        return { kind: "action", actionType: "send_follow_up", payload: { householdId, context: "must never execute" }, reason: "This decision was superseded." };
      },
    };
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const objective = await orchestrator.startObjective("Interrupt while the bounded decision is in flight.", ctx, { idempotencyKey: `objective:late-decision:${randomUUID()}`, activeContext: { householdId } });
    const running = orchestrator.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId });
    await startedPlanning;
    await controlWorkObjective({ tenantId, workId: objective.workId, command: "interrupt", actorId: ownerId });
    releasePlanner();
    expect(await running).toBe("blocked");
    const aggregate = await workAggregate(tenantId, objective.workId);
    expect(aggregate!.actions).toHaveLength(0);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "blocked" });
  });

  it("recovers the same typed action after a provider outage without duplicating its eventual side effect", async () => {
    let providerAvailable = false;
    let providerAttempts = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "ghl_send_sms",
      description: "Objective-loop provider recovery test adapter",
      integration: "test-sms-provider",
      inputSchema: z.object({ contactId: z.string().uuid(), message: z.string().min(1), tenantId: z.string().uuid() }).passthrough(),
      piiAllowlist: ["contactId", "message", "tenantId"],
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 1_000 },
      async run(input) {
        providerAttempts += 1;
        if (!providerAvailable) throw new Error("test SMS provider unavailable");
        await withTenant(String(input.tenantId), async (db) => {
          await db.insert(sandboxOutbox).values({ tenantId: String(input.tenantId), channel: "sms", toNumber: "+15550191919", content: String(input.message) });
          await db.insert(communicationsLog).values({ householdId: String(input.contactId), channel: "sms", direction: "outbound", content: String(input.message) });
        });
        return { providerMessageId: `recovered-${providerAttempts}` };
      },
    });
    const planner = new ScriptedPlanner([
      { kind: "action", actionType: "send_follow_up", payload: { householdId, context: "provider recovery proof" }, reason: "A follow-up is required.", nextStep: "Observe the provider result." },
      (inspection) => {
        const completed = (inspection.actions as Array<{ status: string }>).some((action) => action.status === "completed");
        if (!completed) throw new Error("Provider recovery was not observed canonically");
        return { kind: "complete", outcome: { providerRecovered: true }, reason: "The original typed action completed after provider recovery and its result is now canonical." };
      },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner, tools });
    const started = await orchestrator.startObjective("Send the recovery-proof follow-up, recovering safely if its provider is down.", ctx, {
      idempotencyKey: `objective:action-recovery:${randomUUID()}`,
      activeContext: { householdId },
      maxSteps: 6,
      maxActions: 2,
    });

    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("awaiting_approval");
    const first = await workAggregate(tenantId, started.workId);
    const action = (first!.actions as Array<typeof domainActions.$inferSelect>)[0]!;
    expect(await orchestrator.decide(action.id, tenantId, "approve", ownerId, { role: "owner" })).toMatchObject({ status: "success", output: { queued: true, durable: true } });
    const firstExecution = await durableStepForAction(tenantId, action.id);
    expect(await claimStep(tenantId, firstExecution.step.id)).toBeTruthy();
    await executeAuthorizedEffectStep(tenantId, firstExecution.step.id, { tools });
    const afterFailure = await workAggregate(tenantId, started.workId);
    expect((afterFailure!.actions as Array<typeof domainActions.$inferSelect>)[0]).toMatchObject({ id: action.id, status: "blocked_integration_unavailable" });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("awaiting_approval");

    const recoveryStarted = performance.now();
    providerAvailable = true;
    const failedRun = (await durableStepForAction(tenantId, action.id)).run;
    expect(await retryRun(tenantId, failedRun.id, failedRun.version, ownerId)).toMatchObject({ ok: true });
    const retried = await durableStepForAction(tenantId, action.id);
    expect(await claimStep(tenantId, retried.step.id, retried.step.dispatchGeneration)).toBeTruthy();
    await executeAuthorizedEffectStep(tenantId, retried.step.id, { tools });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    const recovered = await workAggregate(tenantId, started.workId);
    expect(recovered!.objectiveLoop).toMatchObject({ state: "completed", actionCount: 1 });
    expect(recovered!.actions).toEqual([expect.objectContaining({ id: action.id, status: "completed" })]);
    expect(providerAttempts).toBe(2); // one known failed attempt + one explicit safe retry
    const delivered = await withTenant(tenantId, (db) => db.select().from(sandboxOutbox).where(and(eq(sandboxOutbox.tenantId, tenantId), eq(sandboxOutbox.content, "Hi Avery Objective! Just following up about provider recovery proof — reply here or call us if you need anything."))));
    expect(delivered).toHaveLength(1);
    console.info(`[upgrade10-metric] ${JSON.stringify({
      name: "provider_failure_safe_recovery",
      recoveryMs: Math.round(performance.now() - recoveryStarted),
      providerAttempts,
      duplicateSideEffects: delivered.length - 1,
      objectiveCompletionCorrect: recovered!.objectiveLoop?.state === "completed",
    })}`);
  });

  it("blocks before planning when the owning employee cannot inspect canonical state", async () => {
    const planner = new ScriptedPlanner([{ kind: "complete", outcome: {}, reason: "This decision must never be reached." }]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Attempt work as a suspended employee.", { tenantId, userId: suspendedId, employeeId: suspendedId, role: "technician" }, {
      idempotencyKey: `objective:suspended:${randomUUID()}`,
    });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("blocked");
    expect(planner.calls).toBe(0);
    const aggregate = await workAggregate(tenantId, started.workId);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "blocked", reason: expect.stringContaining("Authority denied") });
    const decisions = await withTenant(tenantId, (db) => db.select().from(authorityDecisions).where(and(eq(authorityDecisions.tenantId, tenantId), eq(authorityDecisions.employeeId, suspendedId))));
    expect(decisions).toEqual(expect.arrayContaining([expect.objectContaining({ operation: "query", outcome: "denied" })]));
  });

  it("rejects a cross-tenant action reference even when the connection can bypass RLS", async () => {
    const planner = new ScriptedPlanner([{ kind: "complete", outcome: {}, reason: "Create one completed objective step for scope proof." }]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const objective = await orchestrator.startObjective("Prove objective references remain tenant-safe.", ctx, { idempotencyKey: `objective:scope:${randomUUID()}` });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("completed");
    const step = (await workAggregate(tenantId, objective.workId))!.objectiveSteps[0]!;
    let rejected: unknown;
    try {
      await withTenant(otherTenantId, (db) => db.insert(domainActions).values({
        tenantId: otherTenantId,
        actionType: "send_follow_up",
        payload: {},
        workId: objective.workId,
        objectiveStepId: step.id,
      }));
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error & { cause?: Error }).cause?.message).toMatch(/(?:objective action crosses step, Work|domain_action\.work canonical reference crosses tenant) boundary/i);
  });

  it("terminates repeated reads when canonical business state makes no progress", async () => {
    const sameRead: ObjectiveDecision = { kind: "query", request: { intent: "business_state" }, reason: "Re-check the same state.", nextStep: "Check once more." };
    const planner = new ScriptedPlanner([sameRead, sameRead, sameRead]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Stop safely if repeated inspection cannot advance this objective.", ctx, {
      idempotencyKey: `objective:no-progress:${randomUUID()}`,
      maxSteps: 8,
      maxQueries: 5,
      maxConsecutiveNoProgress: 2,
    });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("continue");
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("continue");
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("blocked");
    const aggregate = await workAggregate(tenantId, started.workId);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "blocked", queryCount: 3, consecutiveNoProgress: 2, reason: expect.stringContaining("without observed progress") });
  });

  it("does not allow an explicit continue to bypass the configured step budget", async () => {
    const planner = new ScriptedPlanner([
      { kind: "query", request: { intent: "business_state" }, reason: "Use the only permitted step." },
      { kind: "action", actionType: "send_follow_up", payload: { householdId }, reason: "This over-budget action must never be planned." },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const objective = await orchestrator.startObjective("Respect a one-step objective budget.", ctx, { idempotencyKey: `objective:step-limit:${randomUUID()}`, maxSteps: 1 });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("blocked");
    const continued = await controlWorkObjective({ tenantId, workId: objective.workId, command: "continue", actorId: ownerId });
    expect(continued.revision).toBe(2);
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId, expectedRevision: 2, expectedStepNumber: 2 })).toBe("blocked");
    expect(planner.calls).toBe(1);
    const aggregate = await workAggregate(tenantId, objective.workId);
    expect(aggregate!.actions).toHaveLength(0);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "blocked", stepCount: 2, queryCount: 1 });
  });

  it("interrupts an unexecuted objective action so it cannot fire after the loop stops", async () => {
    const planner = new ScriptedPlanner([{ kind: "action", actionType: "send_follow_up", payload: { householdId, context: "interruption proof" }, reason: "Draft a gated action." }]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const objective = await orchestrator.startObjective("Draft a follow-up, then stop safely if interrupted.", ctx, { idempotencyKey: `objective:interrupt-action:${randomUUID()}`, activeContext: { householdId } });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("awaiting_approval");
    await controlWorkObjective({ tenantId, workId: objective.workId, command: "interrupt", actorId: ownerId });
    const aggregate = await workAggregate(tenantId, objective.workId);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "blocked" });
    expect(aggregate!.actions).toEqual([expect.objectContaining({ status: "rejected" })]);
    const action = (aggregate!.actions as Array<typeof domainActions.$inferSelect>)[0]!;
    let refused: unknown;
    try {
      await withTenant(tenantId, (db) => db.update(domainActions).set({ status: "executing" }).where(eq(domainActions.id, action.id)));
    } catch (error) {
      refused = error;
    }
    expect((refused as Error & { cause?: Error }).cause?.message).toMatch(/objective action execution refused/i);
  });

  it("waits durably for future business state and resumes later", async () => {
    const planner = new ScriptedPlanner([
      () => ({ kind: "wait", resumeAt: new Date(Date.now() + 80).toISOString(), condition: "the promised customer-response window", reason: "No meaningful step exists until the response window opens." }),
      { kind: "complete", outcome: { resumedAfterWait: true }, reason: "The scheduled continuation re-inspected the business after the wait." },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Wait for the response window, then re-check and finish truthfully.", ctx, { idempotencyKey: `objective:wait:${randomUUID()}`, maxSteps: 4 });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("waiting");
    const waiting = await withTenant(tenantId, async (db) => ({
      loop: (await db.select().from(workObjectiveLoops).where(eq(workObjectiveLoops.id, started.objectiveLoopId)))[0]!,
      wait: (await db.select().from(workEventWaits).where(eq(workEventWaits.objectiveLoopId, started.objectiveLoopId)))[0]!,
    }));
    expect(waiting.loop.nextRunAt).not.toBeNull();
    const [deadlineJob] = await withTenant(tenantId, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, `work-event-wait:${waiting.wait.id}:deadline`)));
    expect(deadlineJob!.runAt.getTime()).toBeGreaterThan(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await processWorkEventWaitDeadline(tenantId, waiting.wait.id, new Date(waiting.wait.deadlineAt!.getTime() + 2_001))).outcome).toBe("timed_out");
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
  });

  it("completes without the originally expected action when fresh Company Graph state makes it unnecessary", async () => {
    await withTenant(tenantId, (db) => db.insert(communicationsLog).values({ householdId, channel: "sms", direction: "outbound", content: "Already followed up from the service desk." }));
    const planner = new ScriptedPlanner([
      (inspection) => {
        if (!JSON.stringify(inspection.companyContext).includes("Already followed up from the service desk")) {
          return { kind: "action", actionType: "send_follow_up", payload: { householdId }, reason: "No existing follow-up was observed." };
        }
        return { kind: "complete", outcome: { actionSkipped: "follow_up_already_exists" }, reason: "Fresh customer history proves the follow-up already happened, so another send would be a duplicate." };
      },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Make sure Avery has been followed up with, but do not contact twice.", ctx, { idempotencyKey: `objective:obsolete-step:${randomUUID()}`, activeContext: { householdId }, maxSteps: 3 });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    const aggregate = await workAggregate(tenantId, started.workId);
    expect(aggregate!.actions).toHaveLength(0);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "completed", actionCount: 0 });
    expect(aggregate!.objectiveSteps[0]).toMatchObject({ decisionKind: "complete", progressMade: true });
  });

  it("interrupts and redirects the same Work while preserving the prior objective audit", async () => {
    const planner = new ScriptedPlanner([{ kind: "complete", outcome: { redirected: true }, reason: "The redirected objective is satisfied." }]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Original objective", ctx, { idempotencyKey: `objective:control:${randomUUID()}`, maxSteps: 3 });
    const interrupted = await controlWorkObjective({ tenantId, workId: started.workId, command: "interrupt", actorId: ownerId });
    expect(interrupted).toMatchObject({ state: "blocked", objective: "Original objective" });
    const redirected = await controlWorkObjective({ tenantId, workId: started.workId, command: "redirect", actorId: ownerId, objective: "Redirected objective" });
    expect(redirected).toMatchObject({ state: "continue", objective: "Redirected objective", revision: 2 });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId, expectedRevision: 1, expectedStepNumber: 1 })).toBe("continue");
    expect(planner.calls).toBe(0);
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId, expectedRevision: 2, expectedStepNumber: 1 })).toBe("completed");
  });

  it("exposes idempotent text intake plus inspect and control routes for the same Work", async () => {
    const idempotencyKey = `objective:route:${randomUUID()}`;
    const routeRequest = (path: string, body?: unknown) => new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": ownerId, "x-user-role": "owner" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const first = await startObjectiveRoute(routeRequest("/api/objectives", { objective: "Own this route-created business outcome.", channel: "text", idempotencyKey }));
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { objective: { workId: string; objectiveLoopId: string } };
    const canonicalJobKey = `objective:${firstBody.objective.objectiveLoopId}:revision:1:step:1`;
    const [initialJob] = await withTenant(tenantId, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, canonicalJobKey)));
    expect(initialJob).toMatchObject({ status: "queued", lane: "interactive", priority: 100 });
    expect((await workAggregate(tenantId, firstBody.objective.workId))!.work).toMatchObject({ status: "executing", executionModel: "objective" });

    // Simulate the historical split-commit orphan: an idempotent replay must repair
    // delivery instead of treating loop existence alone as healthy.
    await withTenant(tenantId, (db) => db.delete(jobs).where(eq(jobs.id, initialJob!.id)));
    const replay = await startObjectiveRoute(routeRequest("/api/objectives", { objective: "Own this route-created business outcome.", channel: "text", idempotencyKey }));
    expect(replay.status).toBe(200);
    expect((await replay.json() as typeof firstBody & { objective: { duplicate: boolean } }).objective).toMatchObject({
      workId: firstBody.objective.workId,
      objectiveLoopId: firstBody.objective.objectiveLoopId,
      duplicate: true,
    });
    const [repairedJob] = await withTenant(tenantId, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, canonicalJobKey)));
    expect(repairedJob).toMatchObject({ status: "queued" });

    // A consumed delivery is immutable. Periodic recovery creates a new delivery
    // identity rather than colliding with the terminal key forever.
    await withTenant(tenantId, (db) => db.update(jobs).set({ status: "completed", completedAt: new Date() }).where(eq(jobs.id, repairedJob!.id)));
    await recoverRunnableObjectives(tenantId);
    const objectiveJobs = await withTenant(tenantId, (db) => db.select().from(jobs).where(eq(jobs.type, "run_objective_iteration")));
    expect(objectiveJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ idempotencyKey: `${canonicalJobKey}:recovery-after:${repairedJob!.id}`, status: "queued" }),
    ]));

    const inspected = await getObjectiveRoute(routeRequest(`/api/works/${firstBody.objective.workId}/objective`), { params: Promise.resolve({ id: firstBody.objective.workId }) });
    expect(inspected.status).toBe(200);
    expect((await inspected.json() as { objective: { id: string; state: string } }).objective).toMatchObject({ id: firstBody.objective.objectiveLoopId, state: "continue" });
    const interrupted = await controlObjectiveRoute(routeRequest(`/api/works/${firstBody.objective.workId}/objective`, { command: "interrupt" }), { params: Promise.resolve({ id: firstBody.objective.workId }) });
    expect(interrupted.status).toBe(200);
    expect((await interrupted.json() as { objective: { state: string } }).objective.state).toBe("blocked");
  });
});
