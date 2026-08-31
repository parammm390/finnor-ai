import { describe, expect, it, vi } from "vitest";
import type { InformationAction, InformationObservation } from "./contracts";
import { runEpistemicController } from "./controller";
import { TEST_NOW, testOption, testRequirement, testState } from "./test-support";

describe("bounded epistemic controller", () => {
  it("cannot repeat an identical acquisition or overrun any configured budget", async () => {
    const execute = vi.fn(async (action: InformationAction): Promise<InformationObservation> => ({
      actionId: action.id,
      adapterId: action.adapterId,
      tenantId: action.scope.tenantId,
      observedAt: TEST_NOW,
      evidence: [],
      propositionIds: action.expectedInformation.propositionIds,
      outcome: "NO_RESULT",
    }));
    const budget = {
      maxActions: 4,
      maxUserInterruptions: 1,
      maxLatencyMs: 10_000,
      maxCostUnits: 10,
      deadline: "2026-09-01T00:00:00.000Z",
    };
    const run = await runEpistemicController({
      state: testState(),
      requirements: [testRequirement("invoice.balance", [testOption()])],
      budget,
      executor: { execute },
      clock: { now: () => TEST_NOW },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.finalStop.reason).toBe("NO_LEGAL_ACTION");
    expect(run.usage.actions).toBeLessThanOrEqual(budget.maxActions);
    expect(run.usage.userInterruptions).toBeLessThanOrEqual(budget.maxUserInterruptions);
    expect(run.usage.latencyMs).toBeLessThanOrEqual(budget.maxLatencyMs);
    expect(run.usage.costUnits).toBeLessThanOrEqual(budget.maxCostUnits);
    expect(new Set(run.usage.selectedActionFingerprints).size).toBe(run.usage.selectedActionFingerprints.length);
  });

  it("performs zero acquisitions when maxActions is zero", async () => {
    const execute = vi.fn();
    const run = await runEpistemicController({
      state: testState(),
      requirements: [testRequirement()],
      budget: {
        maxActions: 0,
        maxUserInterruptions: 0,
        maxLatencyMs: 0,
        maxCostUnits: 0,
        deadline: "2026-09-01T00:00:00.000Z",
      },
      executor: { execute },
      clock: { now: () => TEST_NOW },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(run.finalStop.reason).toBe("BUDGET_EXHAUSTED");
    expect(run.usage.actions).toBe(0);
  });

  it("allows a non-interrupting machine read when the user-interruption budget is zero", async () => {
    const execute = vi.fn(async (action: InformationAction): Promise<InformationObservation> => ({
      actionId: action.id,
      adapterId: action.adapterId,
      tenantId: action.scope.tenantId,
      observedAt: TEST_NOW,
      evidence: [],
      propositionIds: action.expectedInformation.propositionIds,
      outcome: "NO_RESULT",
    }));
    const run = await runEpistemicController({
      state: testState(),
      requirements: [testRequirement()],
      budget: {
        maxActions: 1,
        maxUserInterruptions: 0,
        maxLatencyMs: 10_000,
        maxCostUnits: 10,
        deadline: "2026-09-01T00:00:00.000Z",
      },
      executor: { execute },
      clock: { now: () => TEST_NOW },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.usage.userInterruptions).toBe(0);
  });
});
