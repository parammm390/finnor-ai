import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  tenantId: "00000000-0000-4000-8000-0000000000a1",
  employeeId: "00000000-0000-4000-8000-0000000000a2",
  workId: "00000000-0000-4000-8000-0000000000a3",
  workInputId: "00000000-0000-4000-8000-0000000000a4",
  instructionId: "00000000-0000-4000-8000-0000000000a5",
  threadId: "00000000-0000-4000-8000-0000000000a6",
  userMessageId: "00000000-0000-4000-8000-0000000000a7",
  assistantMessageId: "00000000-0000-4000-8000-0000000000a8",
  objectiveLoopId: "00000000-0000-4000-8000-0000000000a9",
};

type MockReceivedWork = {
  workId: string;
  workInputId: string;
  instructionId: string;
  created: boolean;
  duplicate: boolean;
  status: "received" | "completed" | "failed" | "cancelled";
  finalOutcome: unknown;
};

type MockWorkAggregate = {
  work: { id: string; status: string; finalOutcome?: unknown } | null;
  actions: unknown[];
  objectiveLoop?: { id: string; state: string } | null;
} | null;

const mocks = vi.hoisted(() => {
  const receiveWork = vi.fn<() => Promise<MockReceivedWork>>(async () => ({
    workId: ids.workId,
    workInputId: ids.workInputId,
    instructionId: ids.instructionId,
    created: true,
    duplicate: false,
    status: "received",
    finalOutcome: null,
  }));
  const resolveOperatingInteractionContext = vi.fn(async ({ context }: { context?: unknown }) => context);
  const prepareEmployeeConversationTurn = vi.fn(async () => ({
    threadId: ids.threadId,
    employeeId: ids.employeeId,
    userMessage: { id: ids.userMessageId },
    duplicate: false,
    context: { resolution: { resolvedReferences: [], status: "resolved" } },
  }));
  const linkEmployeeConversationTurnToWork = vi.fn(async () => undefined);
  const persistEmployeeAssistantTurn = vi.fn(async () => ({
    id: ids.assistantMessageId,
    originalText: "Persisted assistant response",
    createdAt: "2026-08-25T00:00:00.000Z",
  }));
  const interpretOperationalQuery = vi.fn(() => ({ route: "planner" as const, reason: "mutation_or_advice" as const }));
  const interactionAwareOperationalDecision = vi.fn((decision: unknown) => decision);
  const classifyInstructionRoute = vi.fn(() => ({ version: 1, route: "ATOMIC_EFFECT" as const, reasonCodes: ["strict_single_effect_candidate"] }));
  const handleInstructionResult = vi.fn(async () => ({ actions: [] }));
  const startObjective = vi.fn(async () => ({
    workId: ids.workId,
    workInputId: ids.workInputId,
    instructionId: ids.instructionId,
    objectiveLoopId: ids.objectiveLoopId,
    state: "continue" as const,
    duplicate: false,
  }));
  const getOrchestrator = vi.fn(() => ({ handleInstructionResult, startObjective }));
  const enforceRouteRateLimit = vi.fn(async () => undefined);
  const enforceBatchBackpressure = vi.fn(async () => undefined);
  const recordWorkResponse = vi.fn(async () => undefined);
  const transitionWork = vi.fn(async () => undefined);
  const workAggregate = vi.fn<() => Promise<MockWorkAggregate>>(async () => null);
  const ensureObjectiveIterationDelivery = vi.fn(async () => false);
  const errorResponse = vi.fn((error: unknown) => Response.json({ error: String(error) }, { status: 500 }));
  return {
    receiveWork,
    resolveOperatingInteractionContext,
    prepareEmployeeConversationTurn,
    linkEmployeeConversationTurnToWork,
    persistEmployeeAssistantTurn,
    interpretOperationalQuery,
    interactionAwareOperationalDecision,
    classifyInstructionRoute,
    handleInstructionResult,
    startObjective,
    getOrchestrator,
    enforceRouteRateLimit,
    enforceBatchBackpressure,
    recordWorkResponse,
    transitionWork,
    workAggregate,
    ensureObjectiveIterationDelivery,
    errorResponse,
  };
});

vi.mock("../../apps/api/lib/auth", () => ({
  requireContext: vi.fn(async () => ({ tenantId: ids.tenantId, userId: ids.employeeId, role: "owner", correlationId: "test-correlation" })),
  enforceRouteRateLimit: mocks.enforceRouteRateLimit,
  errorResponse: mocks.errorResponse,
}));
vi.mock("../../apps/api/lib/backpressure", () => ({ enforceBatchBackpressure: mocks.enforceBatchBackpressure }));
vi.mock("../../apps/api/lib/worker-readiness", () => ({ requireWorkerFleetReady: vi.fn(async () => undefined) }));
vi.mock("../../apps/api/lib/orchestrator", () => ({ getOrchestrator: mocks.getOrchestrator }));
vi.mock("@finnor/db", () => ({
  receiveWork: mocks.receiveWork,
  recordWorkResponse: mocks.recordWorkResponse,
  transitionWork: mocks.transitionWork,
  workAggregate: mocks.workAggregate,
}));
vi.mock("@finnor/orchestration", () => ({
  interpretOperationalQuery: mocks.interpretOperationalQuery,
  interactionAwareOperationalDecision: mocks.interactionAwareOperationalDecision,
  classifyInstructionRoute: mocks.classifyInstructionRoute,
  isConversationalTurn: vi.fn(() => false),
  resolveOperatingInteractionContext: mocks.resolveOperatingInteractionContext,
  OperatingInteractionContextError: class OperatingInteractionContextError extends Error {},
  prepareEmployeeConversationTurn: mocks.prepareEmployeeConversationTurn,
  linkEmployeeConversationTurnToWork: mocks.linkEmployeeConversationTurnToWork,
  persistEmployeeAssistantTurn: mocks.persistEmployeeAssistantTurn,
  parseObjectiveSuccessCondition: vi.fn((condition: unknown) => condition),
  ensureObjectiveIterationDelivery: mocks.ensureObjectiveIterationDelivery,
}));

import { POST as actionsPOST } from "../../apps/api/app/api/actions/route";
import { POST as objectivesPOST } from "../../apps/api/app/api/objectives/route";

function request(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const received = (): MockReceivedWork => ({
  workId: ids.workId,
  workInputId: ids.workInputId,
  instructionId: ids.instructionId,
  created: true,
  duplicate: false,
  status: "received",
  finalOutcome: null,
});

const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

describe("production-correctness intake boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receiveWork.mockResolvedValue(received());
    mocks.workAggregate.mockReset();
    mocks.workAggregate.mockResolvedValue(null);
    mocks.persistEmployeeAssistantTurn.mockResolvedValue({
      id: ids.assistantMessageId,
      originalText: "Persisted assistant response",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
  });

  afterAll(() => consoleError.mockRestore());

  it("claims Work/Input before context, conversation, classification, rate limiting, or orchestration on /api/actions", async () => {
    const response = await actionsPOST(request("/api/actions", { instruction: "Create a work order", channel: "text" }));

    expect(response.status).toBe(201);
    const claimOrder = mocks.receiveWork.mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(mocks.resolveOperatingInteractionContext.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(mocks.prepareEmployeeConversationTurn.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(mocks.interpretOperationalQuery.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(mocks.enforceRouteRateLimit.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(mocks.handleInstructionResult.mock.invocationCallOrder[0]!);
    expect(mocks.prepareEmployeeConversationTurn).toHaveBeenCalledWith(expect.objectContaining({ instructionId: ids.instructionId }));
  });

  it("claims Work/Input before context, conversation, or objective orchestration on /api/objectives", async () => {
    const response = await objectivesPOST(request("/api/objectives", { objective: "Own this outcome", channel: "text" }));

    expect(response.status).toBe(202);
    const claimOrder = mocks.receiveWork.mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(mocks.resolveOperatingInteractionContext.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(mocks.prepareEmployeeConversationTurn.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(mocks.startObjective.mock.invocationCallOrder[0]!);
    expect(mocks.prepareEmployeeConversationTurn).toHaveBeenCalledWith(expect.objectContaining({ instructionId: ids.instructionId }));
  });

  it("keeps action core success when assistant projection persistence fails", async () => {
    mocks.persistEmployeeAssistantTurn.mockRejectedValueOnce(new Error("assistant projection unavailable"));

    const response = await actionsPOST(request("/api/actions", { instruction: "Create a work order", channel: "text" }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      planned: [],
      workId: ids.workId,
      workInputId: ids.workInputId,
      instructionId: ids.instructionId,
      projectionWarnings: [{ stage: "assistant message", code: "projection_persistence_failed" }],
    });
    expect(mocks.transitionWork).not.toHaveBeenCalled();
    expect(mocks.recordWorkResponse).toHaveBeenCalledTimes(1);
  });

  it("keeps objective core success when assistant projection persistence fails", async () => {
    mocks.persistEmployeeAssistantTurn.mockRejectedValueOnce(new Error("assistant projection unavailable"));

    const response = await objectivesPOST(request("/api/objectives", { objective: "Own this outcome", channel: "text" }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      objective: { workId: ids.workId, objectiveLoopId: ids.objectiveLoopId, duplicate: false },
      projectionWarnings: [{ stage: "assistant message", code: "projection_persistence_failed" }],
    });
  });

  it("returns core success with an explicit warning when exact action replay persistence fails", async () => {
    mocks.recordWorkResponse.mockRejectedValueOnce(new Error("response projection unavailable"));

    const response = await actionsPOST(request("/api/actions", { instruction: "Create a work order", channel: "text" }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.projectionWarnings).toContainEqual({ stage: "response", code: "projection_persistence_failed" });
    expect(mocks.transitionWork).not.toHaveBeenCalled();
  });

  it("preserves duplicate action replay status and cached response shape", async () => {
    mocks.receiveWork.mockResolvedValueOnce({ ...received(), duplicate: true, status: "completed", finalOutcome: { response: { planned: [{ id: "cached-action" }], workId: ids.workId, threadId: ids.threadId } } });
    mocks.workAggregate.mockResolvedValueOnce({
      work: {
        id: ids.workId,
        status: "completed",
        finalOutcome: { response: { planned: [{ id: "aggregate-action" }], workId: ids.workId } },
      },
      actions: [],
    });

    const response = await actionsPOST(request("/api/actions", { instruction: "Create a work order", channel: "text" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ planned: [{ id: "cached-action" }], workId: ids.workId, duplicate: true, threadId: ids.threadId });
    expect(mocks.resolveOperatingInteractionContext).not.toHaveBeenCalled();
    expect(mocks.prepareEmployeeConversationTurn).not.toHaveBeenCalled();
    expect(mocks.interpretOperationalQuery).not.toHaveBeenCalled();
    expect(mocks.interactionAwareOperationalDecision).not.toHaveBeenCalled();
    expect(mocks.classifyInstructionRoute).not.toHaveBeenCalled();
    expect(mocks.enforceRouteRateLimit).not.toHaveBeenCalled();
    expect(mocks.linkEmployeeConversationTurnToWork).not.toHaveBeenCalled();
    expect(mocks.handleInstructionResult).not.toHaveBeenCalled();
    expect(mocks.persistEmployeeAssistantTurn).not.toHaveBeenCalled();
    expect(mocks.recordWorkResponse).not.toHaveBeenCalled();
    expect(mocks.workAggregate).not.toHaveBeenCalled();
  });

  it("truthfully replays canonical action state when the exact response projection is missing", async () => {
    mocks.receiveWork.mockResolvedValueOnce({ ...received(), duplicate: true, status: "completed", finalOutcome: null });
    mocks.workAggregate.mockResolvedValueOnce({
      work: { id: ids.workId, status: "completed" },
      actions: [{ id: "canonical-action", status: "completed" }],
    });

    const response = await actionsPOST(request("/api/actions", { instruction: "Create a work order", channel: "text" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      planned: [{ id: "canonical-action", status: "completed" }],
      workId: ids.workId,
      duplicate: true,
      replayDegraded: true,
      projectionWarnings: [{ stage: "response", code: "projection_missing_on_replay" }],
    });
    expect(mocks.prepareEmployeeConversationTurn).not.toHaveBeenCalled();
    expect(mocks.handleInstructionResult).not.toHaveBeenCalled();
  });

  it("marks an action setup failure failed and exposes explicit retry instead of replaying an empty duplicate", async () => {
    mocks.resolveOperatingInteractionContext.mockRejectedValueOnce(new Error("context resolver unavailable"));

    const first = await actionsPOST(request("/api/actions", { instruction: "Create a work order", channel: "text", idempotencyKey: "action-recovery" }));
    const firstBody = await first.json();

    expect(first.status).toBe(500);
    expect(firstBody).toMatchObject({ recoverable: true, workId: ids.workId, workInputId: ids.workInputId, instructionId: ids.instructionId });
    expect(mocks.transitionWork).toHaveBeenCalledWith(
      ids.tenantId,
      ids.workId,
      "failed",
      "intake_pre_orchestration_failed",
      expect.objectContaining({ message: "context resolver unavailable", recoverable: true }),
      expect.objectContaining({
        expectedStatus: "received",
        expectedWorkInputId: ids.workInputId,
        failure: expect.objectContaining({ message: "context resolver unavailable", recoverable: true }),
      }),
    );

    mocks.workAggregate.mockReset();
    mocks.receiveWork.mockResolvedValueOnce({ ...received(), created: false, duplicate: true, status: "failed", finalOutcome: null });
    mocks.workAggregate.mockResolvedValueOnce({ work: { id: ids.workId, status: "failed" }, actions: [], objectiveLoop: null });

    const second = await actionsPOST(request("/api/actions", { instruction: "Create a work order", channel: "text", idempotencyKey: "action-recovery" }));
    const secondBody = await second.json();

    expect(second.status).toBe(409);
    expect(secondBody).toMatchObject({ recoverable: true, retryRequired: true, duplicate: true, status: "failed", workId: ids.workId });
    expect(mocks.resolveOperatingInteractionContext).toHaveBeenCalledTimes(1);
    expect(mocks.handleInstructionResult).not.toHaveBeenCalled();
  });

  it("marks an objective setup failure failed and never presents a duplicate without a loop or response as an objective replay", async () => {
    mocks.resolveOperatingInteractionContext.mockRejectedValueOnce(new Error("objective context unavailable"));

    const first = await objectivesPOST(request("/api/objectives", { objective: "Own this outcome", channel: "text", idempotencyKey: "objective-recovery" }));
    const firstBody = await first.json();

    expect(first.status).toBe(500);
    expect(firstBody).toMatchObject({ recoverable: true, workId: ids.workId, workInputId: ids.workInputId, instructionId: ids.instructionId });
    expect(mocks.transitionWork).toHaveBeenCalledWith(
      ids.tenantId,
      ids.workId,
      "failed",
      "intake_pre_orchestration_failed",
      expect.objectContaining({ message: "objective context unavailable", recoverable: true }),
      expect.objectContaining({
        expectedStatus: "received",
        expectedWorkInputId: ids.workInputId,
        failure: expect.objectContaining({ message: "objective context unavailable", recoverable: true }),
      }),
    );

    mocks.workAggregate.mockReset();
    mocks.receiveWork.mockResolvedValueOnce({ ...received(), created: false, duplicate: true, status: "failed", finalOutcome: null });
    mocks.workAggregate.mockResolvedValueOnce({ work: { id: ids.workId, status: "failed" }, actions: [], objectiveLoop: null });

    const second = await objectivesPOST(request("/api/objectives", { objective: "Own this outcome", channel: "text", idempotencyKey: "objective-recovery" }));
    const secondBody = await second.json();

    expect(second.status).toBe(409);
    expect(secondBody).toMatchObject({ recoverable: true, retryRequired: true, duplicate: true, status: "failed", workId: ids.workId });
    expect(secondBody.objective).toBeUndefined();
    expect(mocks.resolveOperatingInteractionContext).toHaveBeenCalledTimes(1);
    expect(mocks.startObjective).not.toHaveBeenCalled();
  });

  it("replays duplicate objectives from the stored response without re-entering enrichment or objective setup", async () => {
    mocks.receiveWork.mockResolvedValueOnce({
      ...received(),
      duplicate: true,
      status: "received",
      finalOutcome: {
        response: {
          objective: { workId: ids.workId, workInputId: ids.workInputId, instructionId: ids.instructionId, objectiveLoopId: ids.objectiveLoopId, state: "continue", duplicate: false },
          threadId: ids.threadId,
          assistantMessage: { id: ids.assistantMessageId },
        },
      },
    });

    const response = await objectivesPOST(request("/api/objectives", { objective: "Own this outcome", channel: "text" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      objective: { workId: ids.workId, objectiveLoopId: ids.objectiveLoopId, instructionId: ids.instructionId, duplicate: true },
      threadId: ids.threadId,
    });
    expect(mocks.resolveOperatingInteractionContext).not.toHaveBeenCalled();
    expect(mocks.prepareEmployeeConversationTurn).not.toHaveBeenCalled();
    expect(mocks.startObjective).not.toHaveBeenCalled();
    expect(mocks.linkEmployeeConversationTurnToWork).not.toHaveBeenCalled();
    expect(mocks.persistEmployeeAssistantTurn).not.toHaveBeenCalled();
    expect(mocks.recordWorkResponse).not.toHaveBeenCalled();
    expect(mocks.workAggregate).not.toHaveBeenCalled();
    expect(mocks.ensureObjectiveIterationDelivery).toHaveBeenCalledWith(ids.tenantId, ids.objectiveLoopId, "test-correlation");
  });
});
