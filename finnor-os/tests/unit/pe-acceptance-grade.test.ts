import { describe, expect, it } from "vitest";
import { grade } from "../../scripts/pe-acceptance/grade.mts";

const denied = {
  stage: "T0",
  intake: {
    status: 403,
    body: { error: "The business root or selected subject is unavailable in the current scope" },
  },
  jobs: [], actions: [], effects: [],
};

describe("Birch role-boundary grading", () => {
  it("passes the expected participant denial without scoring an associate submission", () => {
    const verdicts = grade({ mode: "participant", attempts: [denied] });
    expect(verdicts.find(row => row.name === "participant-deal-denial")?.verdict).toBe("PASS");
    expect(verdicts.find(row => row.name === "underwrite")?.verdict).toBe("UNPROVEN");
    expect(verdicts.filter(row => row.verdict === "PASS")).toHaveLength(1);
  });

  it("fails the control for an unrelated 403, unexpected acceptance, or queued work", () => {
    for (const attempt of [
      { ...denied, intake: { status: 403, body: { error: "Forbidden" } } },
      { ...denied, intake: { status: 202, body: denied.intake.body } },
      { ...denied, jobs: [{ type: "run_objective_iteration" }] },
    ]) {
      expect(grade({ mode: "participant", attempts: [attempt] })
        .find(row => row.name === "participant-deal-denial")?.verdict).toBe("FAIL");
    }
  });

  it("scores an accepted owner control without crediting the participant control", () => {
    const verdicts = grade({ mode: "owner-control", attempts: [{ stage: "T0", intake: { status: 202 } }] });
    expect(verdicts.find(row => row.name === "underwrite")?.verdict).toBe("FAIL");
    expect(verdicts.some(row => row.name === "participant-deal-denial")).toBe(false);
  });
});
