import { describe, expect, it } from "vitest";
import { createInstructionTraceResultEnvelope, isReadOnlyAnswerAction } from "./instruction-trace";

describe("instruction trace answer envelope", () => {
  it("redacts hidden evidence while preserving a bounded Private Equity summary", () => {
    const envelope = createInstructionTraceResultEnvelope("action-1", {
      spokenSummary: "Diligence record DD-48 is ready; call 555-010-1234 for access.",
      displaySafe: {
        deal: { id: "DD-48", status: "review" },
        groundedOn: { secret: "raw memory" },
        semanticSnippets: ["private transcript"],
      },
      groundedOn: { deal_context: { secret: "raw memory" } },
    });
    expect(envelope).toEqual({
      actionId: "action-1",
      result: {
        kind: "answer",
        spokenSummary: "Diligence record DD-48 is ready; call [PHONE_1] for access.",
        display: { deal: { id: "DD-48", status: "review" } },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("raw memory");
  });

  it("does not expose retired answer actions as browser-answer eligible", () => {
    expect(isReadOnlyAnswerAction("answer_customer_question", { answered: true }, false)).toBe(false);
    expect(isReadOnlyAnswerAction("search_web", { spokenSummary: "Current source result" }, false)).toBe(true);
  });
});
