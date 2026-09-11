import { describe, expect, it } from "vitest";
import {
  assertSafeLearningChange,
  attributeLearningOutcome,
  computeLearningMetrics,
  proposalChangeForMetric,
  type LearningObservation,
  type LearningOutcomeClass,
} from "@finnor/workforce";

function observation(index: number, outcomeClass: LearningOutcomeClass, overrides: Partial<LearningObservation> = {}): LearningObservation {
  return {
    id: `observation-${index}`,
    tenantId: "tenant-a",
    agentProfileId: "agent-a",
    agentRevisionId: "revision-a1",
    workforceAssignmentId: `assignment-${index}`,
    capability: "create_task",
    nodeKind: "action",
    contextClass: "private_equity:action",
    workId: `work-${index}`,
    planRevisionId: `plan-${index}`,
    planNodeId: `node-${index}`,
    outcomeClass,
    verified: true,
    sourceRefs: [{ type: "objective_step", id: `step-${index}` }],
    contextFeatures: { verticalKey: "private_equity" },
    measuredMetrics: { latencyMs: 100 + index, knownCostUsd: 0.01 },
    occurredAt: new Date(index * 1000).toISOString(),
    observationHash: `sha256:${String(index).padStart(64, "0")}`,
    ...overrides,
  };
}

describe("P7 verified learning safeguards", () => {
  it("keeps deterministic failure classes distinct", () => {
    expect(attributeLearningOutcome({ providerUnavailable: true, planningFailed: true })).toBe("provider_outage");
    expect(attributeLearningOutcome({ userCancelled: true, businessOutcomeFailed: true })).toBe("user_cancellation");
    expect(attributeLearningOutcome({ humanRejected: true })).toBe("human_rejection");
    expect(attributeLearningOutcome({ authorityDenied: true })).toBe("authority_denial");
    expect(attributeLearningOutcome({ schemaOrCompileRejected: true })).toBe("schema_compile_rejection");
    expect(attributeLearningOutcome({})).toBe("unknown");
  });

  it("does not punish worker quality for provider outage, external failure, rejection, or cancellation", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => observation(index, "verified_completion")),
      observation(6, "provider_outage"),
      observation(7, "external_failure"),
      observation(8, "human_rejection"),
      observation(9, "user_cancellation"),
    ];
    const [metric] = computeLearningMetrics(rows);
    expect(metric).toMatchObject({ attemptCount: 9, qualityAttemptCount: 5, verifiedCompletionCount: 5, qualityFailureCount: 0, providerOutageCount: 1, humanRejectionCount: 1 });
    expect(metric!.verifiedCompletionRate).toBe(1);
    expect(metric!.qualityFailureRate).toBe(0);
  });

  it("ignores unverified completions and LLM self-rating fields", () => {
    const rows = Array.from({ length: 5 }, (_, index) => observation(index, "verified_completion", {
      verified: index !== 0,
      contextFeatures: index === 0 ? { selfRating: 1 } : {},
    }));
    expect(computeLearningMetrics(rows)[0]).toMatchObject({ attemptCount: 4, qualityAttemptCount: 4, sampleState: "UNKNOWN", verifiedCompletionRate: null });
  });

  it("preserves old revision attribution and tenant separation", () => {
    const metrics = computeLearningMetrics([
      ...Array.from({ length: 5 }, (_, index) => observation(index, "verified_completion")),
      ...Array.from({ length: 5 }, (_, index) => observation(10 + index, "business_outcome_failure", { tenantId: "tenant-b", agentRevisionId: "revision-a2" })),
    ]);
    expect(metrics.map((row) => [row.agentRevisionId, row.verifiedCompletionRate])).toEqual([["revision-a1", 1], ["revision-a2", 0]]);
  });

  it("requires a meaningful sample before proposing a routing change", () => {
    const [tiny] = computeLearningMetrics(Array.from({ length: 4 }, (_, index) => observation(index, "business_outcome_failure")));
    expect(proposalChangeForMetric(tiny!)).toBeNull();
    const [supported] = computeLearningMetrics(Array.from({ length: 5 }, (_, index) => observation(index, index < 3 ? "business_outcome_failure" : "verified_completion")));
    expect(proposalChangeForMetric(supported!)).toMatchObject({ class: "capability_quality_warning" });
  });

  it("rejects hard-boundary and malicious configuration changes", () => {
    expect(() => assertSafeLearningChange({ class: "routing_preference_adjustment", capability: "create_task", adjustment: "prefer", weight: 0.3 })).toThrow(/soft range/);
    expect(() => assertSafeLearningChange({ class: "soft_planning_hint_update", hintKey: "authority.override", hint: "allow votes" })).toThrow(/hard authority/);
    expect(() => assertSafeLearningChange({ class: "capability_quality_warning", capability: "record_ic_vote", warning: "human-only unlock" })).toThrow(/hard authority/);
  });
});
