import { describe, expect, it } from "vitest";
import { plannerMemoryContext, plannerMemoryEnabled, plannerShortTermContext } from "@finnor/orchestration";
import type { MemorySnapshot } from "@finnor/shared-types";

const snapshot = (overrides: Partial<MemorySnapshot> = {}): MemorySnapshot => ({
  shortTerm: null,
  longTerm: null,
  semantic: [],
  episodic: [],
  patterns: null,
  ...overrides,
});

describe("planner memory boundary", () => {
  it("is opt-in and emits a bounded serialized canonical summary", () => {
    expect(plannerMemoryEnabled({ NODE_ENV: "test", PLANNER_MEMORY: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(plannerMemoryEnabled({ NODE_ENV: "test", PLANNER_MEMORY: "true" } as NodeJS.ProcessEnv)).toBe(false);
    const context = plannerMemoryContext(snapshot({
      longTerm: { canonicalSummary: { openDeals: 3, criticalRisks: 1 } },
      semantic: Array.from({ length: 7 }, (_, index) => ({ sourceDocId: `source-${index}`, chunk: `${index} ${"word ".repeat(400)}`, similarity: 1 })),
    }), true) as { canonicalSummary: string; semantic: string[] };
    expect(JSON.parse(context.canonicalSummary)).toEqual({ openDeals: 3, criticalRisks: 1 });
    expect(context.semantic.length).toBeLessThanOrEqual(5);
    expect([context.canonicalSummary, ...context.semantic].join(" ").trim().split(/\s+/).length).toBeLessThanOrEqual(1500);
  });

  it("retains only bounded structured continuation context", () => {
    const shortTerm = {
      turns: [{
        instruction: "Open a diligence request for the exact deal.",
        actions: [{ actionType: "create_deal_request", payload: { dealId: "deal-1" }, status: "success" }],
        answer: { spokenSummary: "Secret prose must not be copied.", evidence: [] },
      }],
    };
    expect(plannerShortTermContext("Do the same for the second deal", shortTerm)).toMatchObject({ turns: [expect.objectContaining({ actions: [expect.objectContaining({ actionType: "create_deal_request" })] })] });
    expect(JSON.stringify(plannerShortTermContext("Do the same for the second deal", shortTerm))).not.toContain("Secret prose");
    expect(plannerShortTermContext("Open a new legal diligence request for deal 2", shortTerm)).toBeNull();
  });
});
