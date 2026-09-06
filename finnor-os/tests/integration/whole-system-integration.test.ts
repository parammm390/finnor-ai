import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { migrate } from "../../packages/db/migrate";
import {
  authorityApprovalRequests,
  authorityApprovalRequestSteps,
  businessOperationEvents,
  businessOperations,
  businessOperationTargets,
  closePool,
  communicationsLog,
  decisionReceipts,
  domainActions,
  handoffWork,
  households,
  jobs,
  receiveWork,
  sandboxOutbox,
  serviceVisits,
  tenants,
  technicians,
  users,
  withTenant,
  workAggregate,
  workEventWaits,
  workEvents,
  workObjectiveLoops,
  workflowSteps,
  works,
} from "@finnor/db";
import { employeeAuthoritySnapshot } from "@finnor/authority";
import {
  FinnorOrchestrator,
  processWorkEventWaitDeadline,
  recoverRunnableObjectives,
  type ObjectiveDecision,
  type ObjectiveDecisionPlanner,
  type ObjectiveInspection,
} from "@finnor/orchestration";
import { executeOperationalQuery, household360, workCases } from "@finnor/read-models";
import { dispatchBusinessOperation, executeBusinessOperationTarget } from "../../apps/worker/src/handlers/business-operation";
import { runWorkflowStep } from "../../apps/worker/src/handlers/run-workflow-step";
import { POST as handoffRoute } from "../../apps/api/app/api/works/[id]/handoff/route";
import { GET as employeesRoute } from "../../apps/api/app/api/employees/route";
import { POST as retryOperationRoute } from "../../apps/api/app/api/operations/[id]/retry/route";
import { citeObservedObjectiveEvidence } from "./helpers/objective-completion-evidence";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

const available = await dbUp();

class ScriptedPlanner implements ObjectiveDecisionPlanner {
  providerName = "upgrade10-scripted-proof";
  calls = 0;

  constructor(private readonly script: Array<ObjectiveDecision | ((inspection: ObjectiveInspection) => ObjectiveDecision)>) {}

  async decide(input: { inspection: ObjectiveInspection }): Promise<ObjectiveDecision> {
    const item = this.script[this.calls++];
    if (!item) throw new Error("Upgrade 10 scripted planner exhausted");
    return citeObservedObjectiveEvidence(typeof item === "function" ? item(input.inspection) : item, input.inspection);
  }
}

function request(path: string, tenantId: string, userId: string, role: "owner" | "dispatcher" | "technician", body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": tenantId,
      "x-user-id": userId,
      "x-user-role": role,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function metric(name: string, values: Record<string, number | string | boolean>): void {
  console.info(`[upgrade10-metric] ${JSON.stringify({ name, ...values })}`);
}

async function executeDurableAction(tenantId: string, actionId: string): Promise<void> {
  const [step] = await withTenant(tenantId, (db) => db.select().from(workflowSteps).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.domainActionId, actionId),
    eq(workflowSteps.status, "pending"),
  )).limit(1));
  if (!step) throw new Error(`No queued durable step for action ${actionId}`);
  await runWorkflowStep({ tenantId, workflowStepId: step.id });
}

describe.skipIf(!available)("Upgrade 10 whole-system integration", () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const dispatcherId = randomUUID();
  const ownerId = randomUUID();
  const suspendedId = randomUUID();
  const otherOwnerId = randomUUID();
  const householdId = randomUUID();
  const technicianId = randomUUID();
  const serviceVisitId = randomUUID();

  const bulkTenantId = randomUUID();
  const bulkOwnerId = randomUUID();
  const bulkStableHouseholdId = randomUUID();
  const bulkChangedHouseholdId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.SECRETS_PROVIDER = "env";
    process.env.COMMS_MODE = "sandbox";
    process.env.FINNOR_ENVIRONMENT = "test";
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(tenantId, async (db) => {
      await db.insert(tenants).values({ id: tenantId, name: "Upgrade 10 Journey Dealer" });
      await db.insert(users).values([
        { id: dispatcherId, tenantId, email: `upgrade10-dispatcher-${dispatcherId}@example.test`, role: "dispatcher", displayName: "Drew Dispatcher" },
        { id: ownerId, tenantId, email: `upgrade10-owner-${ownerId}@example.test`, role: "owner", displayName: "Olivia Owner" },
        { id: suspendedId, tenantId, email: `upgrade10-suspended-${suspendedId}@example.test`, role: "technician", displayName: "Suspended Sam", status: "suspended" },
      ]);
      await db.insert(households).values({
        id: householdId,
        tenantId,
        address: "10 Whole System Way",
        contactInfo: { name: "Casey Customer", phone: "+15551001001" },
        marketingConsent: true,
      });
      await db.insert(technicians).values({
        id: technicianId,
        tenantId,
        name: "Taylor Technician",
        availability: { weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] },
      });
      await db.insert(serviceVisits).values({
        id: serviceVisitId,
        tenantId,
        householdId,
        technicianId,
        type: "customer_issue_follow_up",
        scheduledAt: new Date(Date.now() + 60 * 60_000),
        notes: "Original customer issue visit",
      });
    });
    await withTenant(otherTenantId, async (db) => {
      await db.insert(tenants).values({ id: otherTenantId, name: "Upgrade 10 Adversarial Tenant" });
      await db.insert(users).values({ id: otherOwnerId, tenantId: otherTenantId, email: `upgrade10-other-${otherOwnerId}@example.test`, role: "owner", displayName: "Other Owner" });
    });
    await withTenant(bulkTenantId, async (db) => {
      await db.insert(tenants).values({ id: bulkTenantId, name: "Upgrade 10 Durable Operations Dealer" });
      await db.insert(users).values({ id: bulkOwnerId, tenantId: bulkTenantId, email: `upgrade10-bulk-${bulkOwnerId}@example.test`, role: "owner", displayName: "Bailey Bulk Owner" });
      await db.insert(households).values([
        { id: bulkStableHouseholdId, tenantId: bulkTenantId, address: "1 Stable Target Road", contactInfo: { name: "Stable Target", phone: "+15551002001" }, marketingConsent: true },
        { id: bulkChangedHouseholdId, tenantId: bulkTenantId, address: "2 Changed Target Road", contactInfo: { name: "Changed Target", phone: "+15551002002" }, marketingConsent: true },
      ]);
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("carries one voice-started customer objective through text continuation, employee handoff, another employee's approval, restart, verification, and completion", async () => {
    const journeyStarted = performance.now();
    const firstPlanner = new ScriptedPlanner([
      { kind: "query", request: { intent: "customer_lookup", householdId }, reason: "Resolve the exact customer before contact.", nextStep: "Draft the follow-up if it is still due." },
      { kind: "action", actionType: "send_follow_up", payload: { householdId, context: "the unresolved customer issue" }, reason: "The exact customer record still needs a verified follow-up.", nextStep: "Observe the provider result and receipt." },
    ]);
    const dispatcherCtx = { tenantId, userId: dispatcherId, employeeId: dispatcherId, role: "dispatcher" as const };
    const firstProcess = new FinnorOrchestrator({ objectiveDecisionPlanner: firstPlanner });
    const started = await firstProcess.startObjective("Resolve Casey's issue, record the contact, and return verified evidence.", dispatcherCtx, {
      channel: "voice",
      sessionId: `vapi:${randomUUID()}`,
      idempotencyKey: `upgrade10-customer:${randomUUID()}`,
      activeContext: { householdId },
      maxSteps: 8,
      maxActions: 2,
      maxQueries: 4,
    });
    expect(await firstProcess.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("continue");
    expect(await firstProcess.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("awaiting_approval");

    const awaiting = await workAggregate(tenantId, started.workId);
    const action = (awaiting!.actions as Array<typeof domainActions.$inferSelect>)[0]!;
    expect(action).toMatchObject({ actionType: "send_follow_up", initiatedBy: dispatcherId, status: "pending" });
    const [approvalRequest] = await withTenant(tenantId, (db) => db.select().from(authorityApprovalRequests).where(eq(authorityApprovalRequests.domainActionId, action.id)));
    expect(approvalRequest).toMatchObject({ requesterId: dispatcherId, status: "pending" });

    const handoffResponse = await handoffRoute(
      request(`/api/works/${started.workId}/handoff`, tenantId, dispatcherId, "dispatcher", { targetEmployeeId: ownerId, note: "Please authorize the customer contact and own verification." }),
      { params: Promise.resolve({ id: started.workId }) },
    );
    expect(handoffResponse.status).toBe(202);
    const ownerAuthority = await employeeAuthoritySnapshot({ tenantId, userId: ownerId, employeeId: ownerId, role: "owner" });
    await receiveWork({
      tenantId,
      workId: started.workId,
      instruction: "I have the handoff. Continue this same Work after my approval.",
      channel: "text",
      userId: ownerId,
      idempotencyKey: `upgrade10-text-continuation:${randomUUID()}`,
      authorityContext: { employeeId: ownerId, revision: ownerAuthority.revision, roles: ownerAuthority.roles, principal: ownerId },
    });

    expect(await firstProcess.decide(action.id, tenantId, "approve", ownerId, { role: "owner" })).toMatchObject({ status: "success", output: { queued: true, durable: true } });
    await executeDurableAction(tenantId, action.id);
    const restartedProcess = new FinnorOrchestrator({ objectiveDecisionPlanner: new ScriptedPlanner([
      (inspection) => {
        const observed = (inspection.actions as Array<{ id: string; status: string }>).some((row) => row.id === action.id && row.status === "completed");
        const receipt = (inspection.receipts as Array<{ domainActionId: string; finalizedAt: unknown }>).some((row) => row.domainActionId === action.id && Boolean(row.finalizedAt));
        if (!observed || !receipt) throw new Error("Completion was attempted without the real action and finalized receipt");
        return { kind: "complete", outcome: { customerIssue: "contacted_and_verified", actionId: action.id }, reason: "The contact is canonical and its finalized receipt is attached to this Work." };
      },
    ]) });
    expect(await restartedProcess.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    expect((await restartedProcess.decide(action.id, tenantId, "approve", ownerId, { role: "owner" })).status).toBe("success");
    await recoverRunnableObjectives(tenantId);

    const projectionStarted = performance.now();
    const [aggregate, projected] = await Promise.all([workAggregate(tenantId, started.workId), workCases(tenantId)]);
    const convergenceMs = performance.now() - projectionStarted;
    const work = aggregate!.work as typeof works.$inferSelect;
    expect(work).toMatchObject({ createdBy: dispatcherId, currentOwnerId: ownerId, assignedTo: ownerId, status: "completed" });
    expect(work.authorityContext).toMatchObject({ employeeId: ownerId, revision: ownerAuthority.revision, handedOffBy: dispatcherId });
    expect((aggregate!.inputs as Array<{ channel: string; createdBy: string | null }>).map((input) => input.channel)).toEqual(["voice", "text"]);
    expect(aggregate!.objectiveLoop).toMatchObject({ state: "completed", actionCount: 1, queryCount: 2 });
    expect(work.finalOutcome).toMatchObject({ kind: "objective", observation: { customerIssue: "contacted_and_verified", actionId: action.id } });
    expect(aggregate!.receipts).toEqual([expect.objectContaining({ domainActionId: action.id, finalizedAt: expect.any(Date) })]);
    expect(aggregate!.queryExecutions.length).toBeGreaterThanOrEqual(7);
    expect(aggregate!.queryExecutions.length).toBeLessThanOrEqual(8);
    const handoffs = await withTenant(tenantId, (db) => db.select().from(workEvents).where(and(eq(workEvents.workId, started.workId), eq(workEvents.eventType, "employee_handoff"))));
    expect(handoffs).toEqual([expect.objectContaining({ payload: expect.objectContaining({ fromEmployeeId: dispatcherId, toEmployeeId: ownerId }) })]);
    const [approvalStep] = await withTenant(tenantId, (db) => db.select().from(authorityApprovalRequestSteps).where(eq(authorityApprovalRequestSteps.approvalRequestId, approvalRequest!.id)));
    expect(approvalStep).toMatchObject({ status: "approved", decidedBy: ownerId });
    const outbox = await withTenant(tenantId, (db) => db.select().from(sandboxOutbox).where(and(eq(sandboxOutbox.tenantId, tenantId), eq(sandboxOutbox.toNumber, "+15551001001"))));
    expect(outbox).toHaveLength(1);
    const workCase = projected.find((row) => row.root.kind === "work" && row.root.id === started.workId)!;
    expect(workCase.durableWork).toMatchObject({ currentOwnerId: ownerId, assignedTo: ownerId, handoffs: [expect.objectContaining({ fromEmployeeId: dispatcherId, toEmployeeId: ownerId })] });

    const directoryResponse = await employeesRoute(request("/api/employees", tenantId, ownerId, "owner"));
    expect(directoryResponse.status).toBe(200);
    const directory = await directoryResponse.json() as { employees: Array<{ id: string }> };
    expect(directory.employees.map((employee) => employee.id)).toEqual(expect.arrayContaining([dispatcherId, ownerId, suspendedId]));
    expect(directory.employees.some((employee) => employee.id === otherOwnerId)).toBe(false);
    const staleOwnerHandoff = await handoffRoute(
      request(`/api/works/${started.workId}/handoff`, tenantId, dispatcherId, "dispatcher", { targetEmployeeId: suspendedId }),
      { params: Promise.resolve({ id: started.workId }) },
    );
    expect(staleOwnerHandoff.status).toBe(403);
    await expect(withTenant(tenantId, (db) => db.update(works).set({ currentOwnerId: otherOwnerId }).where(eq(works.id, started.workId)))).rejects.toThrow(/tenant boundary|failed query/i);
    expect(await workAggregate(otherTenantId, started.workId)).toBeNull();

    metric("voice_text_handoff_approval_completion", {
      latencyMs: Math.round(performance.now() - journeyStarted),
      staleStateConvergenceMs: Math.round(convergenceMs),
      canonicalQueryExecutions: aggregate!.queryExecutions.length,
      duplicateSideEffects: outbox.length - 1,
      objectiveCompletionCorrect: work.status === "completed" && Boolean((aggregate!.receipts as Array<{ finalizedAt: Date | null }>)[0]?.finalizedAt),
    });
  });

  it("keeps a durable bulk operation attached to its objective through partial failure, authorized recovery, duplicate delivery, and truthful completion", async () => {
    const planner = new ScriptedPlanner([
      { kind: "action", actionType: "bulk_notify_existing_customers", payload: { channel: "sms", discountPercent: 12, minDaysInactive: 0 }, reason: "The approved customer cohort should receive the win-back message.", nextStep: "Observe every frozen target and recover reviewable failures." },
    ]);
    const ctx = { tenantId: bulkTenantId, userId: bulkOwnerId, employeeId: bulkOwnerId, role: "owner" as const };
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Notify the eligible inactive customers and own every target outcome through recovery.", ctx, {
      channel: "text",
      idempotencyKey: `upgrade10-bulk:${randomUUID()}`,
      maxSteps: 7,
      maxActions: 2,
    });
    expect(await orchestrator.runObjectiveIteration({ tenantId: bulkTenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("awaiting_approval");
    const initial = await workAggregate(bulkTenantId, started.workId);
    const action = (initial!.actions as Array<typeof domainActions.$inferSelect>)[0]!;
    const operation = (initial!.operations as Array<typeof businessOperations.$inferSelect>)[0]!;
    expect(operation).toMatchObject({ workId: started.workId, domainActionId: action.id, status: "awaiting_approval", targetCount: 2 });
    expect((await orchestrator.decide(action.id, bulkTenantId, "approve", bulkOwnerId, { role: "owner", typedConfirmation: true })).status).toBe("success");

    await withTenant(bulkTenantId, (db) => db.update(households).set({ contactInfo: { name: "Changed Target", phone: "+15551002999" } }).where(eq(households.id, bulkChangedHouseholdId)));
    await dispatchBusinessOperation({ tenantId: bulkTenantId, operationId: operation.id, actionId: action.id });
    let targets = await withTenant(bulkTenantId, (db) => db.select().from(businessOperationTargets).where(eq(businessOperationTargets.operationId, operation.id)));
    const stableTarget = targets.find((target) => target.targetId === bulkStableHouseholdId)!;
    expect(targets.find((target) => target.targetId === bulkChangedHouseholdId)).toMatchObject({ status: "failed", failureClass: "human_review" });
    await executeBusinessOperationTarget({ tenantId: bulkTenantId, operationId: operation.id, targetId: stableTarget.id, actionId: action.id });
    await executeBusinessOperationTarget({ tenantId: bulkTenantId, operationId: operation.id, targetId: stableTarget.id, actionId: action.id });
    let [partial] = await withTenant(bulkTenantId, (db) => db.select().from(businessOperations).where(eq(businessOperations.id, operation.id)));
    expect(partial).toMatchObject({ status: "needs_human_review", succeededCount: 1, failedCount: 1 });
    expect(await orchestrator.runObjectiveIteration({ tenantId: bulkTenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("awaiting_approval");

    await withTenant(bulkTenantId, (db) => db.update(households).set({ contactInfo: { name: "Changed Target", phone: "+15551002002" } }).where(eq(households.id, bulkChangedHouseholdId)));
    const recoveryStarted = performance.now();
    const recoveryKey = `upgrade10-recovery:${randomUUID()}`;
    const recovered = await retryOperationRoute(
      request(`/api/operations/${operation.id}/retry`, bulkTenantId, bulkOwnerId, "owner", { recoveryKey }),
      { params: Promise.resolve({ id: operation.id }) },
    );
    expect(recovered.status).toBe(202);
    const duplicateRecovery = await retryOperationRoute(
      request(`/api/operations/${operation.id}/retry`, bulkTenantId, bulkOwnerId, "owner", { recoveryKey }),
      { params: Promise.resolve({ id: operation.id }) },
    );
    expect(duplicateRecovery.status).toBe(200);
    await dispatchBusinessOperation({ tenantId: bulkTenantId, operationId: operation.id, actionId: action.id });
    targets = await withTenant(bulkTenantId, (db) => db.select().from(businessOperationTargets).where(eq(businessOperationTargets.operationId, operation.id)));
    const recoveredTarget = targets.find((target) => target.targetId === bulkChangedHouseholdId)!;
    await executeBusinessOperationTarget({ tenantId: bulkTenantId, operationId: operation.id, targetId: recoveredTarget.id, actionId: action.id });
    await executeBusinessOperationTarget({ tenantId: bulkTenantId, operationId: operation.id, targetId: recoveredTarget.id, actionId: action.id });
    const recoveryMs = performance.now() - recoveryStarted;

    const restarted = new FinnorOrchestrator({ objectiveDecisionPlanner: new ScriptedPlanner([
      (inspection) => {
        const completed = (inspection.operations as Array<{ id: string; status: string; succeededCount: number }>).find((row) => row.id === operation.id);
        if (!completed || completed.status !== "completed" || completed.succeededCount !== 2) throw new Error("Objective completion did not observe the recovered operation");
        return { kind: "complete", outcome: { operationId: operation.id, succeeded: 2, failed: 0, recovered: true }, reason: "Both frozen targets have durable successful outcomes and the operation receipt is final." };
      },
    ]) });
    expect(await restarted.runObjectiveIteration({ tenantId: bulkTenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    const final = await workAggregate(bulkTenantId, started.workId);
    [partial] = await withTenant(bulkTenantId, (db) => db.select().from(businessOperations).where(eq(businessOperations.id, operation.id)));
    expect(partial).toMatchObject({ status: "completed", succeededCount: 2, failedCount: 0, pendingCount: 0, retryCount: 0 });
    const delivered = await withTenant(bulkTenantId, (db) => db.select().from(sandboxOutbox).where(eq(sandboxOutbox.tenantId, bulkTenantId)));
    expect(delivered).toHaveLength(2);
    const receipts = await withTenant(bulkTenantId, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.operationId, operation.id)));
    expect(receipts).toEqual([expect.objectContaining({ workId: started.workId, domainActionId: action.id, finalizedAt: expect.any(Date), actualResult: expect.objectContaining({ succeeded: 2, failed: 0 }) })]);
    const events = await withTenant(bulkTenantId, (db) => db.select().from(businessOperationEvents).where(eq(businessOperationEvents.operationId, operation.id)));
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(["operation_needs_human_review", "recovery_authorized", "operation_completed"]));
    expect(final!.objectiveLoop).toMatchObject({ state: "completed", actionCount: 1 });
    expect((final!.work as typeof works.$inferSelect).finalOutcome).toMatchObject({ observation: { operationId: operation.id, succeeded: 2, failed: 0, recovered: true } });

    metric("durable_operation_partial_failure_recovery", {
      recoveryMs: Math.round(recoveryMs),
      targetCount: partial!.targetCount,
      duplicateRecoveryRequests: 1,
      duplicateSideEffects: delivered.length - 2,
      objectiveCompletionCorrect: final!.objectiveLoop?.state === "completed" && Boolean(receipts[0]?.finalizedAt),
    });
  });

  it("survives a waiting objective process restart and resumes once without losing owner, context, or history", async () => {
    const planner = new ScriptedPlanner([
      { kind: "wait", resumeAt: new Date(Date.now() + 3_600_000).toISOString(), condition: "the promised customer response window", reason: "No safe next step exists until the response window opens." },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Wait for the response window and then verify the same customer Work.", { tenantId, userId: ownerId, employeeId: ownerId, role: "owner" }, {
      channel: "text",
      idempotencyKey: `upgrade10-wait:${randomUUID()}`,
      activeContext: { householdId },
      maxSteps: 4,
    });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("waiting");
    const [durableWait] = await withTenant(tenantId, (db) => db.select().from(workEventWaits).where(eq(workEventWaits.objectiveLoopId, started.objectiveLoopId)));
    expect(durableWait).toMatchObject({ status: "waiting", deadlineAt: expect.any(Date) });
    await closePool();
    const recoveryStarted = performance.now();
    const deadline = await processWorkEventWaitDeadline(tenantId, durableWait!.id, new Date(durableWait!.deadlineAt!.getTime() + 2_001));
    const enqueued = deadline.outcome === "timed_out" ? 1 : 0;
    const restarted = new FinnorOrchestrator({ objectiveDecisionPlanner: new ScriptedPlanner([
      { kind: "complete", outcome: { resumedAfterRestart: true }, reason: "The due continuation re-inspected the same Work after restart." },
    ]) });
    expect(await restarted.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    const aggregate = await workAggregate(tenantId, started.workId);
    const continuationJobs = await withTenant(tenantId, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, `objective-wake:${durableWait!.id}`)));
    expect(continuationJobs).toHaveLength(1);
    expect(aggregate!.objectiveSteps.map((step) => step.iterationOutcome)).toEqual(["waiting", "completed"]);
    expect(aggregate!.work).toMatchObject({
      currentOwnerId: ownerId,
      activeContext: { version: 1, focusedEntity: { entityType: "household", entityId: householdId } },
      status: "completed",
    });
    metric("waiting_restart_resume", {
      recoveryMs: Math.round(performance.now() - recoveryStarted),
      recoveryScanEnqueues: enqueued,
      duplicateContinuationJobs: continuationJobs.length - 1,
      objectiveCompletionCorrect: aggregate!.objectiveLoop?.state === "completed",
    });
  });

  it("abandons its originally expected action when fresh Company Graph state changes during the same objective", async () => {
    const planner = new ScriptedPlanner([
      { kind: "query", request: { intent: "customer_lookup", householdId }, reason: "Confirm the issue before planning a contact.", nextStep: "Send a follow-up unless another employee already did." },
      (inspection) => {
        if (!JSON.stringify(inspection.companyContext).includes("Resolved externally during the objective")) {
          return { kind: "action", actionType: "send_follow_up", payload: { householdId }, reason: "No newer resolution was observed." };
        }
        return { kind: "complete", outcome: { planChanged: true, actionSkipped: "fresh_business_state" }, reason: "A fresh canonical communication resolves the issue, so the original send would be a duplicate." };
      },
    ]);
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner });
    const started = await orchestrator.startObjective("Make sure Casey is followed up with, but stop if the business resolves it first.", { tenantId, userId: ownerId, employeeId: ownerId, role: "owner" }, {
      idempotencyKey: `upgrade10-plan-change:${randomUUID()}`,
      activeContext: { householdId },
      maxSteps: 4,
    });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("continue");
    await withTenant(tenantId, (db) => db.insert(communicationsLog).values({ householdId, channel: "sms", direction: "outbound", content: "Resolved externally during the objective" }));
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");
    const aggregate = await workAggregate(tenantId, started.workId);
    expect(aggregate!.actions).toHaveLength(0);
    expect(aggregate!.objectiveSteps.map((step) => step.decisionKind)).toEqual(["query", "complete"]);
    expect((aggregate!.work as typeof works.$inferSelect).finalOutcome).toMatchObject({ observation: { planChanged: true, actionSkipped: "fresh_business_state" } });
  });

  it("converges one real schedule change across Work, Customer, Schedule, Agents, and the adaptive workspace", async () => {
    const newTime = new Date(Date.now() + 2 * 60 * 60_000);
    const range = {
      start: new Date(Date.now() - 60 * 60_000).toISOString(),
      end: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
    };
    const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: new ScriptedPlanner([
      {
        kind: "action",
        actionType: "reschedule_visit",
        payload: { visitId: serviceVisitId, newTime: newTime.toISOString(), reason: "customer requested a safer arrival window" },
        reason: "The customer's exact service visit must move and every operating surface must observe the same change.",
        nextStep: "Verify the calendar, customer, employee activity, and Work evidence.",
      },
      (inspection) => {
        const completed = (inspection.actions as Array<{ actionType: string; status: string }>).some((action) => action.actionType === "reschedule_visit" && action.status === "completed");
        if (!completed) throw new Error("Projection journey attempted completion before the real action completed");
        return { kind: "complete", outcome: { visitId: serviceVisitId, scheduledAt: newTime.toISOString(), projectionsVerified: true }, reason: "The canonical visit mutation completed and is ready for cross-projection verification." };
      },
    ]) });
    const started = await orchestrator.startObjective("Move Casey's visit and keep every relevant operating surface consistent.", { tenantId, userId: ownerId, employeeId: ownerId, role: "owner" }, {
      channel: "text",
      idempotencyKey: `upgrade10-cross-projection:${randomUUID()}`,
      activeContext: { householdId, serviceVisitId },
      maxSteps: 4,
      maxActions: 1,
    });
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("awaiting_approval");
    const awaiting = await workAggregate(tenantId, started.workId);
    const action = (awaiting!.actions as Array<typeof domainActions.$inferSelect>)[0]!;
    expect(await orchestrator.decide(action.id, tenantId, "approve", ownerId, { role: "owner" })).toMatchObject({ status: "success", output: { queued: true, durable: true } });
    await executeDurableAction(tenantId, action.id);
    expect(await orchestrator.runObjectiveIteration({ tenantId, workId: started.workId, objectiveLoopId: started.objectiveLoopId })).toBe("completed");

    const convergenceStarted = performance.now();
    const [customer, schedule, agents, workspace, aggregate] = await Promise.all([
      household360(tenantId, householdId),
      executeOperationalQuery(tenantId, { intent: "schedule_range", range, page: { limit: 20 } }),
      executeOperationalQuery(tenantId, { intent: "agent_activity", range, page: { limit: 100 } }),
      workCases(tenantId),
      workAggregate(tenantId, started.workId),
    ]);
    const convergenceMs = performance.now() - convergenceStarted;
    const customerVisit = customer!.serviceVisits.find((visit) => visit.id === serviceVisitId);
    expect(customerVisit).toMatchObject({ scheduledAt: newTime.toISOString(), technicianId });
    expect(schedule.intent).toBe("schedule_range");
    if (schedule.intent !== "schedule_range") throw new Error("Schedule query returned the wrong typed projection");
    expect(schedule.rows).toContainEqual(expect.objectContaining({ id: serviceVisitId, scheduledAt: newTime.toISOString(), household: expect.objectContaining({ id: householdId }), technician: expect.objectContaining({ id: technicianId }) }));
    expect(agents.intent).toBe("agent_activity");
    if (agents.intent !== "agent_activity") throw new Error("Agent query returned the wrong typed projection");
    expect(agents.technicians).toContainEqual(expect.objectContaining({ id: technicianId }));
    expect(agents.actions).toContainEqual(expect.objectContaining({ actionType: "reschedule_visit", status: "completed" }));
    const workCase = workspace.find((row) => row.root.kind === "work" && row.root.id === started.workId)!;
    expect(workCase).toMatchObject({ status: "Completed", durableWork: { currentOwnerId: ownerId }, objectiveLoop: { state: "completed" } });
    expect(workCase.linkedEntities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "household", entityId: householdId }),
      expect.objectContaining({ entityType: "service_visit", entityId: serviceVisitId }),
    ]));
    expect(workCase.businessEvents).toContainEqual(expect.objectContaining({ entityType: "service_visit", entityId: serviceVisitId, eventType: "rescheduled" }));
    expect(aggregate!.receipts).toContainEqual(expect.objectContaining({
      domainActionId: action.id,
      finalizedAt: expect.any(Date),
      failure: null,
      actualResult: expect.objectContaining({ status: "success", output: expect.objectContaining({ visitId: serviceVisitId, scheduledAt: newTime.toISOString() }) }),
    }));
    metric("cross_projection_business_change", {
      staleStateConvergenceMs: Math.round(convergenceMs),
      relevantProjectionsChecked: 5,
      duplicateSideEffects: 0,
      objectiveCompletionCorrect: aggregate!.objectiveLoop?.state === "completed" && workCase.status === "Completed",
    });
  });

  it("rejects a direct cross-tenant handoff even when RLS is bypassed", async () => {
    const started = await new FinnorOrchestrator({ objectiveDecisionPlanner: new ScriptedPlanner([{ kind: "complete", outcome: {}, reason: "Scope probe complete." }]) })
      .startObjective("Prove the database owns the handoff tenant boundary.", { tenantId, userId: ownerId, employeeId: ownerId, role: "owner" }, { idempotencyKey: `upgrade10-scope:${randomUUID()}` });
    await expect(handoffWork({
      tenantId,
      workId: started.workId,
      actorId: ownerId,
      targetEmployeeId: otherOwnerId,
      authorityContext: { employeeId: otherOwnerId, revision: 1, roles: ["owner"] },
    })).rejects.toThrow(/active employee in this tenant|tenant boundary/i);
  });
});
