import { describe, expect, it, vi } from "vitest";
import { updateEmployeeConversationThreadContext } from "@finnor/db";
import { prepareEmployeeConversationTurn } from "../../packages/orchestration/src/conversation-kernel";

const { employeeId, thread, message, contacts } = vi.hoisted(() => ({
  employeeId: "11111111-1111-4111-8111-111111111111",
  thread: { id: "fixture-thread", activeReferences: [] },
  message: { id: "fixture-message", sequence: 1 },
  contacts: [
    { id: "22222222-2222-4222-8222-222222222222", name: "Terry Morgan (Birch)", active: true },
    { id: "33333333-3333-4333-8333-333333333333", name: "Terry Morgan", active: true },
  ],
}));

vi.mock("@finnor/db", async (importOriginal) => {
  const db = await importOriginal<typeof import("@finnor/db")>();
  const fixture = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => table === db.users ? [{ id: employeeId, status: "active" }]
            : table === db.externalContacts ? contacts : [],
        }),
      }),
    }),
  };
  return {
    ...db,
    withTenant: async (_tenantId: string, run: (tx: typeof fixture) => unknown) => run(fixture),
    createEmployeeConversationThread: async () => thread,
    appendEmployeeConversationMessage: async () => ({ message, duplicate: false }),
    loadEmployeeConversationThread: async () => ({ thread, messages: [message] }),
    updateEmployeeConversationMessageContext: vi.fn(),
    updateEmployeeConversationThreadContext: vi.fn(),
    listEmployeePersonalMemories: async () => [],
  };
});

vi.mock("@finnor/memory", () => ({
  mirrorConversationMessageToZep: vi.fn(),
  queryConsolidatedFacts: async () => [],
}));

vi.mock("@finnor/read-models", () => import("../../packages/read-models/src/party-resolver"));

vi.mock("../../packages/orchestration/src/conversation-memory", () => ({
  hydrateConversationMemory: async ({ context }: { context: unknown }) => context,
  scheduleConversationCompaction: vi.fn(),
}));

function prepare(instruction: string) {
  return prepareEmployeeConversationTurn({
    ctx: { tenantId: "fixture-tenant", userId: employeeId, role: "owner" },
    instruction,
    instructionId: "fixture-instruction",
    channel: "text",
  });
}

describe("conversation intake recipient ambiguity", () => {
  it.each([
    ["channel switch", "I cannot call Terry Morgan from Birch. Email Terry Morgan about the memo."],
    ["contact exclusion", "Don't email Terry Morgan from Birch, email Terry Morgan about the memo."],
    ["channel switch with punctuation", "I can’t call Terry Morgan from Birch; email Terry Morgan instead."],
  ])("asks before binding a namesake after a %s", async (_case, instruction) => {
    const turn = await prepare(instruction);

    expect(turn.context.resolution).toMatchObject({
      status: "clarification_required",
      resolvedReferences: [],
      unresolvedExpressions: ["Terry Morgan"],
      clarificationQuestion: "Which active target do you mean for Terry Morgan?",
    });
    expect(updateEmployeeConversationThreadContext).toHaveBeenLastCalledWith(expect.objectContaining({
      activeReferences: [],
      unresolvedReferences: [{ expression: "Terry Morgan", messageId: message.id, sequence: message.sequence }],
    }));
  });

  it("keeps a Birch no-contact instruction from creating or clarifying a recipient", async () => {
    const turn = await prepare("Draft the memo. You may not contact anyone, including Terry Morgan from Birch.");

    expect(turn.context.resolution).toMatchObject({
      status: "none",
      resolvedReferences: [],
      candidates: [],
      unresolvedExpressions: [],
      clarificationQuestion: null,
    });
  });

  it("resolves a recipient explicitly qualified in the affirmative request", async () => {
    const turn = await prepare("I cannot call Terry Morgan from Birch. Email Terry Morgan from Birch about the memo.");

    expect(turn.context.resolution).toMatchObject({
      status: "resolved",
      resolvedReferences: [{ entityType: "external_contact", entityId: contacts[0]!.id }],
      clarificationQuestion: null,
    });
  });
});
