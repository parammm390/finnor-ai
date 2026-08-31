import { describe, expect, it } from "vitest";
import { appendEvidenceAndRecompute } from "./belief-update";
import type { EpistemicBehaviorSummary } from "./contracts";
import { EXISTING_TRUTH_PRECEDENCE } from "./source-precedence";
import { compareEpistemicBehavior } from "./semantic-diff";
import { runEpistemicShadow } from "./shadow";
import { epistemicTraceToCausalReplayNodes, isRedactedEpistemicTrace } from "./trace";
import { TEST_NOW, testEvidence, testRequirement, testState } from "./test-support";

const BUDGET = {
  maxActions: 1,
  maxUserInterruptions: 0,
  maxLatencyMs: 1_000,
  maxCostUnits: 1,
  deadline: "2026-09-01T00:00:00.000Z",
} as const;

function behavior(overrides: Partial<EpistemicBehaviorSummary> = {}): EpistemicBehaviorSummary {
  return {
    requiredFacts: ["invoice.balance"],
    factsAvailable: ["invoice.balance"],
    canonicalFactsAvailable: [],
    missingFacts: [],
    sourcePrecedence: [...EXISTING_TRUTH_PRECEDENCE],
    clarificationNecessary: false,
    selectedSource: null,
    freshness: "FRESH",
    conflicts: [],
    decisionCriticalUncertainty: [],
    stopCondition: "DECISION_CRITICAL_RESOLVED",
    consequentialDecisionAllowed: true,
    ...overrides,
  };
}

describe("shadow controller, replay trace, and semantic differential", () => {
  it("returns the exact planner result and records no value, prompt, or chain of thought", async () => {
    const initial = testState();
    const known = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "canonical:secret", value: "SHOULD_NOT_APPEAR", kind: "CANONICAL_DB" }),
    ], TEST_NOW);
    const plannerResult = { planId: "plan-1" };
    const result = await runEpistemicShadow({
      authoritativePlannerResult: plannerResult,
      state: known,
      requirements: [testRequirement()],
      budget: BUDGET,
      existingBehavior: behavior({
        selectedSource: known.propositions[0]?.source ?? null,
      }),
      allowedAdapters: [],
      clock: { now: () => TEST_NOW },
    });
    expect(result.authoritativePlannerResult).toBe(plannerResult);
    expect(result.authoritativeBehaviorChanged).toBe(false);
    expect(result.consequentialMutations).toBe(0);
    expect(result.plannerCallsAdded).toBe(0);
    expect(result.trace.redaction).toBe("STRUCTURED_DECISIONS_ONLY");
    expect(JSON.stringify(result.trace)).not.toContain("SHOULD_NOT_APPEAR");
    expect(JSON.stringify(result.trace).toLowerCase()).not.toContain("chain-of-thought");
    expect(isRedactedEpistemicTrace(result.trace)).toBe(true);
    expect(isRedactedEpistemicTrace({ ...result.trace, redaction: "RAW" })).toBe(false);
    const nodes = epistemicTraceToCausalReplayNodes(result.trace);
    expect(nodes.map((node) => node.stage)).toEqual(["context", "evidence", "planning"]);
    expect(nodes.every((node) => node.evidence.length === 1)).toBe(true);
    const persisted = epistemicTraceToCausalReplayNodes(result.trace, {
      source: "instruction_events.payload.epistemicTrace",
      ref: "instruction-event-1",
      recordedAt: TEST_NOW,
    });
    expect(persisted.every((node) => node.evidence[0]?.source === "instruction_events.payload.epistemicTrace")).toBe(true);
  });

  it("classifies lower-authority selection and unresolved consequential action as regressions", () => {
    const canonicalSource = {
      kind: "CANONICAL_DB" as const,
      owner: "operational_query:money_summary",
      ref: "canonical:1",
      authority: "CANONICAL_OWNER" as const,
      truthClass: "CANONICAL" as const,
      role: "answer_evidence" as const,
    };
    const memorySource = {
      kind: "MEMORY" as const,
      owner: "hybrid_retrieval",
      ref: "memory:1",
      authority: "SEMANTIC_MEMORY" as const,
      truthClass: "MEMORY" as const,
      role: "answer_evidence" as const,
    };
    const lower = compareEpistemicBehavior(
      behavior({ selectedSource: canonicalSource, canonicalFactsAvailable: ["invoice.balance"] }),
      behavior({ selectedSource: memorySource, canonicalFactsAvailable: ["invoice.balance"] }),
    );
    expect(lower.classification).toBe("REGRESSION");
    expect(lower.reasonCodes).toContain("LOWER_AUTHORITY_SELECTED_OVER_AVAILABLE_TRUTH");

    const unsafe = compareEpistemicBehavior(
      behavior({ consequentialDecisionAllowed: false, decisionCriticalUncertainty: ["invoice.balance"] }),
      behavior({ consequentialDecisionAllowed: true, decisionCriticalUncertainty: ["invoice.balance"] }),
    );
    expect(unsafe.classification).toBe("REGRESSION");
    expect(unsafe.reasonCodes).toContain("MANDATORY_UNCERTAINTY_IGNORED");
  });

  it("classifies a provenance-backed resolution as better information rather than hidden uncertainty", () => {
    const existing = behavior({
      factsAvailable: [],
      missingFacts: ["invoice.balance"],
      decisionCriticalUncertainty: ["invoice.balance"],
      consequentialDecisionAllowed: false,
      freshness: "UNKNOWN",
      stopCondition: "NO_LEGAL_ACTION",
    });
    const p3 = behavior({
      factsAvailable: ["invoice.balance"],
      missingFacts: [],
      decisionCriticalUncertainty: [],
      consequentialDecisionAllowed: true,
      freshness: "FRESH",
      stopCondition: "DECISION_CRITICAL_RESOLVED",
    });
    const diff = compareEpistemicBehavior(existing, p3);
    expect(diff.classification).toBe("BETTER_INFORMATION");
    expect(diff.reasonCodes).not.toContain("P3_HIDES_DECISION_CRITICAL_UNCERTAINTY");
  });

  it("contains a permitted read-only adapter failure without changing the planner result", async () => {
    const plannerResult = { planId: "plan-adapter-failure" };
    const result = await runEpistemicShadow({
      authoritativePlannerResult: plannerResult,
      state: testState(),
      requirements: [testRequirement()],
      budget: BUDGET,
      existingBehavior: behavior({
        factsAvailable: [],
        missingFacts: ["invoice.balance"],
        decisionCriticalUncertainty: ["invoice.balance"],
        consequentialDecisionAllowed: false,
        freshness: "UNKNOWN",
        stopCondition: "NO_LEGAL_ACTION",
      }),
      allowedAdapters: ["CANONICAL_OPERATIONAL_QUERY"],
      executor: { execute: async () => { throw new Error("adapter unavailable"); } },
      clock: { now: () => TEST_NOW },
    });
    expect(result.authoritativePlannerResult).toBe(plannerResult);
    expect(result.run.rounds[0]?.observation).toMatchObject({ outcome: "FAILED", failureCode: "SHADOW_ADAPTER_FAILURE" });
    expect(result.consequentialMutations).toBe(0);
  });
});
