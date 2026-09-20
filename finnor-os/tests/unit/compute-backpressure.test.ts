import { describe, expect, it } from "vitest";
import { decideComputeBackpressure, type ComputePressureSignals } from "../../apps/api/lib/backpressure";

function signals(overrides: Partial<ComputePressureSignals> = {}): ComputePressureSignals {
  return {
    workloadClass: "INTERACTIVE",
    eligibleQueued: 20,
    tenantEligibleQueued: 8,
    oldestEligibleAgeSeconds: 120,
    runningJobs: 1,
    freshRunningTasks: 1,
    effectiveProcessSlots: 4,
    backlogPerTask: 20,
    globalGovernorSaturated: false,
    tenantGovernorSaturated: false,
    telemetryStatus: "healthy",
    telemetryAgeSeconds: 10,
    cutoverState: "authoritative",
    observedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("compute backpressure acceptance boundary", () => {
  it("may defer coalescible optional work only before durable acceptance", () => {
    expect(decideComputeBackpressure({
      phase: "before_acceptance",
      obligationKind: "coalescible",
      signals: signals(),
    }).action).toBe("defer_optional");
  });

  it("preserves required Work after durable acceptance under identical saturation", () => {
    const decision = decideComputeBackpressure({
      phase: "after_acceptance",
      obligationKind: "required",
      signals: signals(),
    });
    expect(decision.action).toBe("preserve_accepted");
    expect(decision.saturated).toBe(true);
  });

  it("reports missing telemetry as degraded rather than fabricating zero demand", () => {
    const decision = decideComputeBackpressure({
      phase: "after_acceptance",
      obligationKind: "required",
      signals: signals({
        eligibleQueued: null,
        oldestEligibleAgeSeconds: null,
        backlogPerTask: null,
        freshRunningTasks: null,
        telemetryStatus: "unavailable",
      }),
    });
    expect(decision.action).toBe("preserve_accepted");
    expect(decision.reasons).toContain("telemetry_unavailable");
    expect(decision.signals.eligibleQueued).toBeNull();
  });

  it("defers only optional pre-acceptance work when telemetry is unavailable", () => {
    const unknown = signals({
      eligibleQueued: null,
      oldestEligibleAgeSeconds: null,
      backlogPerTask: null,
      freshRunningTasks: null,
      telemetryStatus: "unavailable",
    });
    expect(decideComputeBackpressure({ phase: "before_acceptance", obligationKind: "coalescible", signals: unknown }).action).toBe("defer_optional");
    expect(decideComputeBackpressure({ phase: "before_acceptance", obligationKind: "required", signals: unknown }).action).toBe("admit");
  });
});
