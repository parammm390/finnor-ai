import { describe, expect, it } from "vitest";
import { extractNamedExpressions } from "../../packages/orchestration/src/conversation-kernel";
import { mandate } from "../../scripts/pe-acceptance/birch";

describe("conversation party references", () => {
  it("does not turn the Birch mandate's no-contact restriction into a recipient", () => {
    expect(extractNamedExpressions(mandate)).toEqual([]);
  });

  it("does not resolve forbidden outreach but still resolves a separate requested recipient", () => {
    expect(extractNamedExpressions("You must not contact Terry from Birch. Ask Morgan about the memo.")
      .map(reference => reference.name)).toEqual(["Morgan"]);
  });
});
