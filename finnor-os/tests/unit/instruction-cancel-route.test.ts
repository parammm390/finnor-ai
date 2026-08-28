import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "selectDistinct"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(async () => selectResults.shift() ?? []);
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
    return chain;
  });
  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(async () => []);
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve([]).then(resolve, reject);
    return chain;
  });
  const db = { select, selectDistinct: select, update };
  const withTenant = vi.fn(async (_tenantId: string, fn: (database: typeof db) => unknown) => fn(db));
  const transitionWork = vi.fn(async () => undefined);
  const emitInstructionEvent = vi.fn(async () => undefined);
  const controlObjective = vi.fn(async () => ({ state: "cancelled" }));
  const decide = vi.fn(async () => undefined);
  const getOrchestrator = vi.fn(() => ({ controlObjective, decide }));
  const requireContext = vi.fn(async () => ({
    tenantId: "00000000-0000-4000-8000-0000000000a1",
    userId: "00000000-0000-4000-8000-0000000000a2",
    role: "owner" as const,
    correlationId: "cancel-test",
  }));
  const canApprove = vi.fn(async () => true);
  const errorResponse = vi.fn((error: unknown) => Response.json({ error: String(error) }, { status: 500 }));
  const cancelRun = vi.fn(async () => ({ ok: true }));
  return {
    selectResults,
    select,
    update,
    withTenant,
    transitionWork,
    emitInstructionEvent,
    controlObjective,
    decide,
    getOrchestrator,
    requireContext,
    canApprove,
    errorResponse,
    cancelRun,
  };
});

vi.mock("@finnor/db", () => ({
  actionLog: { id: "action_log.id" },
  businessOperations: { id: "business_operations.id", tenantId: "business_operations.tenant_id", workId: "business_operations.work_id", status: "business_operations.status" },
  domainActions: { id: "domain_actions.id", tenantId: "domain_actions.tenant_id", workId: "domain_actions.work_id", instructionId: "domain_actions.instruction_id", status: "domain_actions.status" },
  instructionSessions: { id: "instruction_sessions.id", tenantId: "instruction_sessions.tenant_id", workId: "instruction_sessions.work_id" },
  workflowRuns: { id: "workflow_runs.id", tenantId: "workflow_runs.tenant_id", version: "workflow_runs.version", status: "workflow_runs.status" },
  workflowSteps: { workflowRunId: "workflow_steps.workflow_run_id", domainActionId: "workflow_steps.domain_action_id" },
  workObjectiveLoops: { id: "work_objective_loops.id", tenantId: "work_objective_loops.tenant_id", workId: "work_objective_loops.work_id", state: "work_objective_loops.state" },
  works: { id: "works.id", tenantId: "works.tenant_id", status: "works.status" },
  withTenant: mocks.withTenant,
  transitionWork: mocks.transitionWork,
}));
vi.mock("@finnor/workflow-runtime", () => ({ cancelRun: mocks.cancelRun }));
vi.mock("@finnor/orchestration", () => ({ emitInstructionEvent: mocks.emitInstructionEvent }));
vi.mock("../../apps/api/lib/auth", () => ({
  canApprove: mocks.canApprove,
  errorResponse: mocks.errorResponse,
  requireContext: mocks.requireContext,
}));
vi.mock("../../apps/api/lib/orchestrator", () => ({ getOrchestrator: mocks.getOrchestrator }));

import { POST } from "../../apps/api/app/api/instructions/[id]/cancel/route";

const instructionId = "00000000-0000-4000-8000-0000000000a3";
const workId = "00000000-0000-4000-8000-0000000000a4";

function request(): Request {
  return new Request(`http://localhost/api/instructions/${instructionId}/cancel`, { method: "POST" });
}

describe("POST /api/instructions/:id/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
  });

  it("writes canonical cancelled status rather than failed", async () => {
    mocks.selectResults.push(
      [{ id: instructionId, workId }],
      [{ status: "planning" }],
      [],
      [],
      [],
      [],
    );

    const response = await POST(request(), { params: Promise.resolve({ id: instructionId }) });

    expect(response.status).toBe(200);
    expect(mocks.emitInstructionEvent).toHaveBeenCalledWith(expect.any(String), instructionId, "cancelled", expect.any(Object));
    expect(mocks.transitionWork).toHaveBeenCalledWith(
      expect.any(String),
      workId,
      "cancelled",
      "cancelled",
      expect.objectContaining({ instructionId }),
      expect.objectContaining({ finalOutcome: expect.objectContaining({ kind: "cancelled" }) }),
    );
    expect(mocks.transitionWork).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "failed", expect.anything(), expect.anything(), expect.anything());
  });

  it("cancels an objective loop after the Work terminal fence is persisted", async () => {
    mocks.selectResults.push(
      [{ id: instructionId, workId }],
      [{ status: "executing" }],
      [],
      [],
      [],
      [{ id: "objective-1", state: "continue" }],
    );

    const response = await POST(request(), { params: Promise.resolve({ id: instructionId }) });

    expect(response.status).toBe(200);
    expect(mocks.transitionWork.mock.invocationCallOrder[0]).toBeLessThan(mocks.controlObjective.mock.invocationCallOrder[0]!);
    expect(mocks.controlObjective).toHaveBeenCalledWith(expect.objectContaining({ workId, command: "cancel" }));
  });

  it("is idempotent once Work is already cancelled", async () => {
    mocks.selectResults.push(
      [{ id: instructionId, workId }],
      [{ status: "cancelled" }],
    );

    const response = await POST(request(), { params: Promise.resolve({ id: instructionId }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "cancelled", duplicate: true });
    expect(mocks.emitInstructionEvent).not.toHaveBeenCalled();
    expect(mocks.transitionWork).not.toHaveBeenCalled();
  });

  it("cancels queued durable operations before publishing terminal Work truth", async () => {
    mocks.selectResults.push(
      [{ id: instructionId, workId }],
      [{ status: "executing" }],
      [],
      [{ id: "operation-1", status: "queued" }],
      [],
      [],
    );

    const response = await POST(request(), { params: Promise.resolve({ id: instructionId }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "cancelled", cancelledOperations: 1 });
    expect(mocks.update).toHaveBeenCalled();
    expect(mocks.transitionWork).toHaveBeenCalledWith(
      expect.any(String),
      workId,
      "cancelled",
      "cancelled",
      expect.objectContaining({ reconciliationRequired: false, unresolvedOperationIds: [] }),
      expect.any(Object),
    );
  });
});
