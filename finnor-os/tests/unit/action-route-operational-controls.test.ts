import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const requireContext = vi.fn(async () => ({
    tenantId: "00000000-0000-4000-8000-0000000000a1",
    userId: "00000000-0000-4000-8000-0000000000a2",
    role: "owner" as const,
    correlationId: "test-correlation",
  }));
  const enforceRouteRateLimit = vi.fn(async () => undefined);
  const enforceBatchBackpressure = vi.fn(async () => undefined);
  const receiveWork = vi.fn(async () => ({
    workId: "00000000-0000-4000-8000-0000000000a3",
    workInputId: "00000000-0000-4000-8000-0000000000a4",
    instructionId: "00000000-0000-4000-8000-0000000000a5",
    created: true,
    duplicate: false,
    status: "received" as const,
    finalOutcome: null,
  }));
  const recordWorkResponse = vi.fn(async () => undefined);
  const transitionWork = vi.fn(async () => undefined);
  const workAggregate = vi.fn(async () => null);
  const prepareEmployeeConversationTurn = vi.fn(async () => ({
    threadId: "00000000-0000-4000-8000-0000000000a6",
    employeeId: "00000000-0000-4000-8000-0000000000a2",
    userMessage: { id: "00000000-0000-4000-8000-0000000000a7" },
    duplicate: false,
    context: { resolution: { resolvedReferences: [] } },
  }));
  const linkEmployeeConversationTurnToWork = vi.fn(async () => undefined);
  const persistEmployeeAssistantTurn = vi.fn(async () => ({
    id: "00000000-0000-4000-8000-0000000000a8",
    originalText: "Persisted assistant response",
    createdAt: "2026-08-25T00:00:00.000Z",
  }));
  const interpretOperationalQuery = vi.fn((instruction: string) => instruction.startsWith("Find")
    ? {
        route: "fast_read" as const,
        intent: "customer_lookup" as const,
        confidence: "high" as const,
        request: { intent: "customer_lookup" as const, query: "Contract Household" },
      }
    : { route: "planner" as const, reason: "mutation_or_advice" as const });
  const handleInstructionResult = vi.fn(async (_instruction: string, _ctx: unknown, options: Record<string, unknown>) => ({
    actions: options.fastReadDecision && (options.fastReadDecision as { route?: string }).route === "planner"
      ? [{ id: "planner-action" }]
      : [],
    query: options.fastReadDecision && (options.fastReadDecision as { route?: string }).route === "fast_read"
      ? { metadata: { queryId: "query-1", durationMs: 1 }, request: { intent: "customer_lookup" }, result: { intent: "customer_lookup", asOf: "2026-08-25T00:00:00.000Z" } }
      : undefined,
  }));
  const getOrchestrator = vi.fn(() => ({ handleInstructionResult }));
  const errorResponse = vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 500 }));
  return {
    requireContext,
    enforceRouteRateLimit,
    enforceBatchBackpressure,
    receiveWork,
    recordWorkResponse,
    transitionWork,
    workAggregate,
    prepareEmployeeConversationTurn,
    linkEmployeeConversationTurnToWork,
    persistEmployeeAssistantTurn,
    interpretOperationalQuery,
    handleInstructionResult,
    getOrchestrator,
    errorResponse,
  };
});

vi.mock("../../apps/api/lib/auth", () => ({
  requireContext: mocks.requireContext,
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
  classifyInstructionRoute: vi.fn(({ fastReadDecision }: { fastReadDecision: { route: string } }) => fastReadDecision.route === "fast_read"
    ? { version: 1, route: "QUERY", reasonCodes: ["deterministic_canonical_read"], queryDecision: fastReadDecision }
    : { version: 1, route: "ATOMIC_EFFECT", reasonCodes: ["strict_single_effect_candidate"] }),
  isConversationalTurn: vi.fn(() => false),
  resolveOperatingInteractionContext: vi.fn(async ({ context }: { context?: unknown }) => context),
  interactionAwareOperationalDecision: vi.fn((decision: unknown) => decision),
  OperatingInteractionContextError: class OperatingInteractionContextError extends Error {},
  prepareEmployeeConversationTurn: mocks.prepareEmployeeConversationTurn,
  linkEmployeeConversationTurnToWork: mocks.linkEmployeeConversationTurnToWork,
  persistEmployeeAssistantTurn: mocks.persistEmployeeAssistantTurn,
}));
vi.mock("@finnor/authority", () => ({ employeeAuthoritySnapshot: vi.fn(async () => ({})) }));

import { POST as actionsPOST } from "../../apps/api/app/api/actions/route";

function request(instruction: string): Request {
  return new Request("http://localhost/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction, channel: "text" }),
  });
}

describe("POST /api/actions deterministic-vs-planner controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a supported read to the fast path without planner-only gates", async () => {
    const response = await actionsPOST(request("Find the customer record for Contract Household"));
    expect(response.status).toBe(201);
    expect(mocks.interpretOperationalQuery).toHaveBeenCalledWith("Find the customer record for Contract Household");
    expect(mocks.enforceRouteRateLimit).not.toHaveBeenCalled();
    expect(mocks.enforceBatchBackpressure).not.toHaveBeenCalled();
    expect(mocks.handleInstructionResult).toHaveBeenCalledWith(
      "Find the customer record for Contract Household",
      expect.objectContaining({ tenantId: "00000000-0000-4000-8000-0000000000a1" }),
      expect.objectContaining({
        fastReadDecision: expect.objectContaining({ route: "fast_read" }),
        skipFastReadClassification: true,
      }),
    );
    expect((await response.json()).query).toMatchObject({ result: { intent: "customer_lookup" } });
  });

  it("keeps mutation/advice instructions on the ordinary planner path with both planner gates", async () => {
    const response = await actionsPOST(request("Create a work order for Contract Household"));
    expect(response.status).toBe(201);
    expect(mocks.enforceRouteRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.enforceBatchBackpressure).toHaveBeenCalledTimes(1);
    expect(mocks.handleInstructionResult).toHaveBeenCalledWith(
      "Create a work order for Contract Household",
      expect.anything(),
      expect.objectContaining({
        fastReadDecision: expect.objectContaining({ route: "planner" }),
        skipFastReadClassification: true,
      }),
    );
    expect((await response.json()).planned).toEqual([{ id: "planner-action" }]);
  });
});
