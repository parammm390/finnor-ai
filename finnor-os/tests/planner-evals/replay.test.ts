import { describe, expect, it } from "vitest";
import { reviewAction } from "@finnor/orchestration";
import { CRITIC_GOLDENS, PLANNER_GOLDENS } from "./fixtures";

function scorePlanner(caseDef: (typeof PLANNER_GOLDENS)[number]): boolean {
  const action = caseDef.replay.actions.find((candidate) => candidate.action_type === caseDef.expectedActionType);
  return Boolean(action && caseDef.requiredFields.every((field) => action.payload[field] !== undefined && action.payload[field] !== null && action.payload[field] !== ""));
}

describe("planner replay evals (B2.T7)", () => {
  it("contains at least 60 labeled golden cases across normal, must-ask, repair, and health-degraded paths", () => {
    expect(PLANNER_GOLDENS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(PLANNER_GOLDENS.map((c) => c.category))).toEqual(new Set(["standard", "must_ask", "terminal_repair", "health_degraded"]));
  });

  it("meets the 95% replay action-type-and-parameter gate", () => {
    const passed = PLANNER_GOLDENS.filter(scorePlanner).length;
    expect(passed / PLANNER_GOLDENS.length).toBeGreaterThanOrEqual(0.95);
  });

  it("meets the 90% seeded critic gate", async () => {
    const verdicts = await Promise.all(
      CRITIC_GOLDENS.map((fixture) =>
        reviewAction(
          { instruction: "replay fixture", actionType: "record_finding", payload: {}, summary: "replay fixture" },
          { name: "replay-critic", complete: async () => JSON.stringify(fixture.response) },
        ),
      ),
    );
    const passed = verdicts.filter((verdict, index) => verdict.flagged === CRITIC_GOLDENS[index]!.expectedFlagged).length;
    expect(passed / CRITIC_GOLDENS.length).toBeGreaterThanOrEqual(0.9);
  });
});
