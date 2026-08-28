import { describe, expect, it, vi } from "vitest";

vi.mock("@finnor/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@finnor/db")>();
  return {
    ...actual,
    receiveWork: vi.fn(async () => ({
      workId: "00000000-0000-4000-8000-0000000000a1",
      workInputId: "00000000-0000-4000-8000-0000000000a2",
      instructionId: "00000000-0000-4000-8000-0000000000a3",
      created: true,
      duplicate: false,
      status: "received",
      finalOutcome: null,
    })),
    transitionWork: vi.fn(async () => undefined),
    beginWorkPlannerAttempt: vi.fn(async () => ({ id: "00000000-0000-4000-8000-0000000000a4", attempt: 1, claimed: true, status: "planning" })),
    finishWorkPlannerAttempt: vi.fn(async () => undefined),
    isInstructionCancelled: vi.fn(async () => false),
  };
});

vi.mock("../../packages/orchestration/src/instruction-trace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/orchestration/src/instruction-trace")>();
  return {
    ...actual,
    ensureInstructionSession: vi.fn(async () => undefined),
    emitInstructionEvent: vi.fn(async () => undefined),
    isInstructionCancelled: vi.fn(async () => false),
  };
});

vi.mock("@finnor/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@finnor/memory")>();
  return {
    ...actual,
    buildMemorySnapshot: vi.fn(),
    appendShortTerm: vi.fn(),
    mirrorTurnToZep: vi.fn(),
  };
});

vi.mock("@finnor/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@finnor/security")>();
  return { ...actual, ensureSecretsLoaded: vi.fn(async () => undefined) };
});

import { FinnorOrchestrator, type AnswerEnvelope, type Planner } from "@finnor/orchestration";
import type { Executor } from "../../packages/orchestration/src/executor";
import { answerCashCollections, classifyFastReadOnlyQuestion, createFastReadOnlyRouter } from "../../packages/orchestration/src/fast-read-lane";
import { buildMemorySnapshot } from "@finnor/memory";
import { ensureSecretsLoaded } from "@finnor/security";

const CASH_SNAPSHOT = {
  invoicesByStatus: [
    { status: "paid", count: 3, totalUsd: 1200 },
    { status: "overdue", count: 2, totalUsd: 450 },
  ],
  totalCollected: 1200,
  paymentLinksAwaitingPayment: 1,
};

describe("fast read-only lane", () => {
  it("routes a high-confidence cash-collections question", () => {
    expect(classifyFastReadOnlyQuestion("How are cash collections?")).toEqual({ route: "fast_read", intent: "cash_collections" });
  });

  it.each(["hi", "Hello!", "good morning"])("keeps greetings out of the synthetic fast lane: %s", (instruction) => {
    expect(classifyFastReadOnlyQuestion(instruction)).toEqual({ route: "planner", reason: "not_question" });
  });

  it.each([
    "Create an invoice for the overdue customer",
    "How can we improve cash collections?",
    "What is the QuickBooks collections status?",
    "Tell me about technician availability",
  ])("falls back for uncertain or consequential input: %s", (instruction) => {
    expect(classifyFastReadOnlyQuestion(instruction).route).toBe("planner");
  });

  it("returns a bounded, citation-safe cash answer from the authenticated tenant", async () => {
    const tenantIds: string[] = [];
    const router = createFastReadOnlyRouter({
      cashCollections: async (tenantId) => {
        tenantIds.push(tenantId);
        return CASH_SNAPSHOT;
      },
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    const answer = await router.route("How are cash collections?", { tenantId: "tenant-a" });

    expect(tenantIds).toEqual(["tenant-a"]);
    expect(answer).toMatchObject({
      kind: "answer",
      intent: "cash_collections",
      readOnly: true,
      asOf: "2026-08-04T12:00:00.000Z",
      freshness: { status: "fresh", observedAt: "2026-08-04T12:00:00.000Z" },
      evidence: [{ source: "cash_collections_read_model", ref: "current", timestamp: "2026-08-04T12:00:00.000Z" }],
      display: {
        title: "Cash collections",
        facts: expect.arrayContaining([
          { label: "Collected to date", value: "$1,200.00" },
          { label: "Overdue amount", value: "$450.00" },
        ]),
      },
    });
    expect(JSON.stringify(answer)).not.toContain("groundedOn");
    expect(JSON.stringify(answer)).not.toContain("semanticSnippets");
  });

  it("does not load secrets, memory, or the planner on the fast path", async () => {
    const answer = answerCashCollections(CASH_SNAPSHOT, "2026-08-04T12:00:00.000Z");
    const router = {
      classify: () => ({ route: "fast_read", intent: "cash_collections" } as const),
      route: vi.fn(async () => answer),
    };
    const planner = { plan: vi.fn() } as unknown as Planner;
    const executor = { execute: vi.fn() } as unknown as Executor;
    const orchestrator = new FinnorOrchestrator({ planner, executor, fastReadOnlyRouter: router });

    vi.stubEnv("SECRETS_PROVIDER", "aws-secrets-manager");
    vi.stubEnv("FINNOR_SECRET_IDS", "{}");
    const result = await orchestrator.handleInstructionResult("How are cash collections?", {
      tenantId: "tenant-a",
      userId: "user-a",
      role: "owner",
    });

    expect(result).toEqual({
      actions: [],
      answer,
      workId: "00000000-0000-4000-8000-0000000000a1",
      workInputId: "00000000-0000-4000-8000-0000000000a2",
      instructionId: "00000000-0000-4000-8000-0000000000a3",
    });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(ensureSecretsLoaded).not.toHaveBeenCalled();
    expect(buildMemorySnapshot).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("routes the exact capability prompt before memory retrieval or business-question planning", async () => {
    const planner = { plan: vi.fn() } as unknown as Planner;
    const executor = { execute: vi.fn() } as unknown as Executor;
    const answer: AnswerEnvelope = {
      kind: "answer",
      intent: "conversation",
      readOnly: true,
      spokenSummary: "I can help with research, customers, scheduling, money, and governed execution.",
      display: { title: "JARVIS", facts: [] },
      evidence: [{ source: "conversation_model", ref: "test", timestamp: "2026-08-04T12:00:00.000Z", kind: "SESSION" }],
      asOf: "2026-08-04T12:00:00.000Z",
      freshness: { status: "fresh", observedAt: "2026-08-04T12:00:00.000Z" },
    };
    const responder = { answer: vi.fn(async () => answer) };
    const orchestrator = new FinnorOrchestrator({
      planner,
      executor,
      conversationResponder: responder,
      fastReadOnlyRouter: { classify: () => ({ route: "planner", reason: "unsupported" }), route: async () => null },
    });

    const result = await orchestrator.handleInstructionResult("hey what all can you do ?", {
      tenantId: "tenant-a",
      userId: "user-a",
      role: "owner",
    });

    expect(result.answer).toEqual(answer);
    expect(responder.answer).toHaveBeenCalledTimes(1);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(buildMemorySnapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(result.answer)).not.toContain("leads");
    expect(JSON.stringify(result.answer)).not.toContain("semantic");
  });

  it("does not answer a greeting from the fast router", async () => {
    const cashCollections = vi.fn(async () => CASH_SNAPSHOT);
    const router = createFastReadOnlyRouter({ cashCollections, now: () => new Date("2026-08-04T12:00:00.000Z") });

    await expect(router.route("hi", { tenantId: "tenant-a" })).resolves.toBeNull();
    expect(cashCollections).not.toHaveBeenCalled();
  });
});
