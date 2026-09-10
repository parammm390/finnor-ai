import { describe, expect, it } from "vitest";
import {
  aggregateIcDecision,
  IC_CASE_STATES,
  icSemanticHash,
} from "@finnor/private-equity";
import { PE_IC_GOLDEN_CASES, PE_IC_GOLDEN_NAMES } from "../pe-ic-corpus/golden-cases";

const REQUIRED_NAMES = [
  "unanimous approval",
  "majority approval",
  "rejection",
  "abstention with quorum still met",
  "quorum failure",
  "supermajority threshold failure",
  "conditional approval",
  "required Question blocks voting",
  "required Question waived with authority",
  "Recommendation revision before voting",
  "Recommendation revision after votes requires revote",
  "Memo version change during review",
  "P4 Run replacement invalidates Recommendation",
  "Dissent preserved after majority approval",
  "member becomes ineligible before vote",
  "duplicate Vote retry",
  "simultaneous voting",
  "Decision finalization retry",
  "reconsideration/superseding P1 Decision",
  "legacy P1 investment_committee Decision without P5 history",
] as const;

describe("P5 serious deterministic 20-case golden IC corpus", () => {
  it("contains exactly the twenty roadmap fixtures in exact order with independent expectations", () => {
    expect(PE_IC_GOLDEN_CASES).toHaveLength(20);
    expect(PE_IC_GOLDEN_NAMES).toEqual(REQUIRED_NAMES);
    expect(PE_IC_GOLDEN_CASES.map((entry) => entry.id)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    for (const entry of PE_IC_GOLDEN_CASES) {
      expect(entry.expectedAssertions.length).toBeGreaterThanOrEqual(2);
      expect(entry.exactProcessFixture.canonicalDecisionCount).toBeLessThanOrEqual(1);
      expect(entry.exactProcessFixture.effectiveVoteCount).toBeLessThanOrEqual(50);
      if (entry.exactProcessFixture.caseState !== "LEGACY_NO_P5_HISTORY") {
        expect(IC_CASE_STATES).toContain(entry.exactProcessFixture.caseState);
      }
      expect(entry.expectedAggregation === undefined).toBe(entry.aggregationInput === undefined);
    }
  });

  it.each(PE_IC_GOLDEN_CASES.filter((entry) => entry.aggregationInput))(
    "$name reproduces its independently specified aggregate",
    (entry) => {
      const result = aggregateIcDecision(entry.aggregationInput!);
      const expected = entry.expectedAggregation!;
      expect(result.process).toEqual({ status: expected.processStatus, blockers: expected.blockers });
      expect(result.proposedOutcome).toBe(expected.proposedOutcome);
      expect(result.quorum.status).toBe(expected.quorumStatus);
      expect(result.threshold.status).toBe(expected.thresholdStatus);
      expect(result.counts).toMatchObject({
        eligible: expected.eligible,
        participating: expected.participating,
        approve: expected.approve,
        reject: expected.reject,
        abstain: expected.abstain,
      });
      expect(result.effectiveVotes).toHaveLength(expected.effectiveVotes);
      expect(result.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
  );

  it("keeps the corpus itself deterministic and order-independent where simultaneous arrival is modeled", () => {
    const simultaneous = PE_IC_GOLDEN_CASES.find((entry) => entry.name === "simultaneous voting")!;
    const original = aggregateIcDecision(simultaneous.aggregationInput!);
    const reversed = aggregateIcDecision({
      ...simultaneous.aggregationInput!,
      members: [...simultaneous.aggregationInput!.members].reverse(),
      votes: [...simultaneous.aggregationInput!.votes].reverse(),
    });
    expect(reversed).toEqual(original);
    expect(icSemanticHash(PE_IC_GOLDEN_CASES)).toBe(icSemanticHash(PE_IC_GOLDEN_CASES));
  });

  it("preserves the canonical ownership expectations across lifecycle-only fixtures", () => {
    const legacy = PE_IC_GOLDEN_CASES[19]!.exactProcessFixture;
    const reconsideration = PE_IC_GOLDEN_CASES[18]!.exactProcessFixture;
    const retry = PE_IC_GOLDEN_CASES[17]!.exactProcessFixture;
    expect(legacy).toMatchObject({ caseState: "LEGACY_NO_P5_HISTORY", canonicalDecisionCount: 1, effectiveVoteCount: 0 });
    expect(reconsideration).toMatchObject({ caseState: "DECIDED", priorDecisionState: "superseded", canonicalDecisionCount: 1 });
    expect(retry).toMatchObject({ caseState: "DECIDED", canonicalDecisionCount: 1, idempotentReplay: true });
  });
});
