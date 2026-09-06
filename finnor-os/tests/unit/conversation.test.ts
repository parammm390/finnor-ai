import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../../packages/orchestration/src/llm";
import { isConversationalTurn, LLMConversationResponder, safeReadFallbackForInstruction } from "@finnor/orchestration";

const memory = {
  shortTerm: { turns: [{ instruction: "How are collections?", result: "Two invoices are overdue." }] },
  longTerm: null,
  semantic: [],
  episodic: [],
  patterns: null,
};

describe("real conversational lane", () => {
  it.each(["hey", "Hello!", "how are you?", "What can you help me accomplish across my business?", "hey what all can you do ?", "What all do you handle?"])(
    "recognizes a real conversational turn: %s",
    (instruction) => expect(isConversationalTurn(instruction)).toBe(true),
  );

  it.each(["Create an invoice for Acme", "Research current water-treatment ad trends", "How much cash is overdue?", "What can you tell me about our leads?"])(
    "keeps business reads and actions on the planner stack: %s",
    (instruction) => expect(isConversationalTurn(instruction)).toBe(false),
  );

  it("uses the configured answer model and returns its conversational response", async () => {
    const complete = vi.fn(async () => "Hey — I’m here. I can research the market, answer questions from your business records, prepare work, and route consequential actions through approval.");
    const provider: LLMProvider = { name: "test-answer-model", complete };
    const responder = new LLMConversationResponder(provider, () => new Date("2026-08-10T10:00:00.000Z"));

    const answer = await responder.answer(
      "hey",
      { tenantId: "tenant-a", userId: "owner-a", role: "owner", correlationId: "trace-a" },
      memory,
      { channel: "text", capabilityActionTypes: ["search_web", "create_invoice", "route_suggestion"] },
    );

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "answer",
      channel: "text",
      tenantId: "tenant-a",
      traceId: "trace-a",
    }));
    expect(answer).toMatchObject({
      kind: "answer",
      intent: "conversation",
      spokenSummary: expect.stringContaining("I’m here"),
      asOf: "2026-08-10T10:00:00.000Z",
      evidence: [{ source: "conversation_model", ref: "test-answer-model", timestamp: "2026-08-10T10:00:00.000Z" }],
    });
    expect(answer.spokenSummary).not.toMatch(/^(?:heard|JARVIS is ready)/i);
  });
});

describe("safe empty-plan recovery", () => {
  const actions = ["answer_business_question", "search_web"];

  it("routes external research to the existing web research action", () => {
    expect(safeReadFallbackForInstruction("Research the latest local competitor reviews", actions)).toMatchObject({
      action_type: "search_web",
      payload: { query: "Research the latest local competitor reviews" },
    });
  });

  it("routes an internal business question to grounded business QA", () => {
    expect(safeReadFallbackForInstruction("How much cash is overdue?", actions)).toMatchObject({
      action_type: "answer_business_question",
      payload: { question: "How much cash is overdue?" },
    });
  });

  it("never guesses a write when the planner returned no valid action", () => {
    expect(safeReadFallbackForInstruction("Create and send an invoice for Acme", actions)).toBeNull();
  });
});
