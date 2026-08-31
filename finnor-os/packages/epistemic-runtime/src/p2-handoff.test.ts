import { describe, expect, it, vi } from "vitest";
import type { StaticAdmissibilityResultLike } from "./contracts";
import { requirementsFromP2Unresolved } from "./uncertainty";
import { resolveP2WithInformation } from "./p2-handoff";
import { isRedactedEpistemicTrace, redactP2HandoffTrace } from "./trace";
import { TEST_NOW, testState } from "./test-support";

const BUDGET = {
  maxActions: 2,
  maxUserInterruptions: 1,
  maxLatencyMs: 100_000,
  maxCostUnits: 10,
  deadline: "2026-09-01T00:00:00.000Z",
} as const;

const REJECTED: StaticAdmissibilityResultLike = {
  status: "REJECTED",
  reasonCodes: ["FORBIDDEN_INFORMATION_FLOW"],
  issues: [{
    status: "REJECTED",
    reasonCode: "FORBIDDEN_INFORMATION_FLOW",
    nodeId: "effect:1",
    path: "effects.0",
    message: "Forbidden flow",
  }],
};

const UNRESOLVED: StaticAdmissibilityResultLike = {
  status: "UNRESOLVED",
  reasonCodes: ["ENTITY_RESOLUTION_UNRESOLVED"],
  issues: [{
    status: "UNRESOLVED",
    reasonCode: "ENTITY_RESOLUTION_UNRESOLVED",
    nodeId: "entity:invoice",
    path: "resolution.entity:invoice",
    message: "Invoice identity unresolved",
    detail: { resolutionReasonCode: "ENTITY_REFERENCE_UNRESOLVED" },
  }],
};

describe("P2 to P3 handoff", () => {
  it("never converts or overrides a P2 rejection", async () => {
    const execute = vi.fn();
    const rerunP2 = vi.fn();
    expect(() => requirementsFromP2Unresolved(REJECTED, "decision:test")).toThrow(/REJECTED/);
    const handoff = await resolveP2WithInformation({
      initialP2: REJECTED,
      state: testState([]),
      budget: BUDGET,
      executor: { execute },
      rerunP2,
      now: () => TEST_NOW,
    });
    expect(handoff.status).toBe("P2_REJECTED");
    expect(handoff.finalP2).toBe(REJECTED);
    expect(handoff.rejectedOverrideAttempts).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(rerunP2).not.toHaveBeenCalled();
    const trace = redactP2HandoffTrace(handoff, testState([]), { startedAt: TEST_NOW, completedAt: TEST_NOW });
    expect(isRedactedEpistemicTrace(trace)).toBe(true);
    expect(trace.p2Statuses).toEqual(["REJECTED"]);
    expect(trace.selectedActions).toEqual([]);
  });

  it("maps actual P2 resolution reason codes to typed mandatory propositions", () => {
    const result = requirementsFromP2Unresolved(UNRESOLVED, "decision:test");
    expect(result.propositions).toEqual([
      expect.objectContaining({ id: "p2:entity:invoice:ENTITY_REFERENCE_UNRESOLVED" }),
    ]);
    expect(result.requirements[0]).toMatchObject({ mandatory: true, acceptableStatuses: ["KNOWN"] });
    expect(result.requirements[0]?.acquisitionOptions[0]).toMatchObject({ kind: "READ", adapterId: "CANONICAL_OPERATIONAL_QUERY" });
  });

  it("preserves the exact upstream uncertainty category and traces a zero-action budget stop", async () => {
    const ambiguous: StaticAdmissibilityResultLike = {
      status: "UNRESOLVED",
      reasonCodes: ["ENTITY_RESOLUTION_UNRESOLVED"],
      issues: [{
        status: "UNRESOLVED",
        reasonCode: "ENTITY_RESOLUTION_UNRESOLVED",
        nodeId: "entity:customer",
        path: "resolution.entity:customer",
        message: "Customer identity is ambiguous",
        detail: { resolutionReasonCode: "ENTITY_REFERENCE_AMBIGUOUS" },
      }],
    };
    const execute = vi.fn();
    const handoff = await resolveP2WithInformation({
      initialP2: ambiguous,
      state: testState([]),
      budget: { ...BUDGET, maxActions: 0, maxUserInterruptions: 0, maxLatencyMs: 0, maxCostUnits: 0 },
      executor: { execute },
      rerunP2: vi.fn(),
      now: () => TEST_NOW,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(handoff.rounds).toHaveLength(1);
    expect(handoff.rounds[0]?.uncertainties[0]).toMatchObject({
      category: "AMBIGUOUS",
      reasonCodes: expect.arrayContaining(["ENTITY_REFERENCE_AMBIGUOUS"]),
    });
    expect(handoff.rounds[0]?.stopDecision.reason).toBe("BUDGET_EXHAUSTED");
  });

  it("does not acquire or rerun P2 when P2 is already admissible", async () => {
    const execute = vi.fn();
    const rerunP2 = vi.fn();
    const admissible: StaticAdmissibilityResultLike = { status: "ADMISSIBLE", reasonCodes: [], issues: [] };
    const handoff = await resolveP2WithInformation({
      initialP2: admissible,
      state: testState([]),
      budget: BUDGET,
      executor: { execute },
      rerunP2,
      now: () => TEST_NOW,
    });
    expect(handoff.status).toBe("P2_ADMISSIBLE");
    expect(handoff.p2History).toEqual(["ADMISSIBLE"]);
    expect(execute).not.toHaveBeenCalled();
    expect(rerunP2).not.toHaveBeenCalled();
  });
});
