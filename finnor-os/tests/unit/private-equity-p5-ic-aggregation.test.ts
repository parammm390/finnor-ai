import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  aggregateIcDecision,
  icSemanticHash,
  parseIcPolicySnapshot,
  PeDomainError,
  type IcAggregationInput,
  type IcCommitteeMemberSnapshot,
  type IcPolicySnapshot,
  type IcVoteSnapshot,
} from "@finnor/private-equity";

const AS_OF = "2026-09-10T12:00:00.000Z";

function policy(overrides: Partial<IcPolicySnapshot> = {}): IcPolicySnapshot {
  return {
    schemaVersion: "pe-ic-policy.v1",
    quorum: { kind: "MIN_COUNT", minimum: 2 },
    threshold: { kind: "SIMPLE_MAJORITY" },
    abstentionsCountForQuorum: true,
    deferralsCountForQuorum: false,
    abstentionsCountAsNonApprove: true,
    deferralsCountAsNonApprove: true,
    memoChange: "REQUIRE_REVOTE",
    underwritingRunChange: "REQUIRE_NEW_RECOMMENDATION",
    requiredQuestionWaiverAllowed: true,
    conditionWaiverAllowed: true,
    allowedPrimaryRunValidities: ["VALID"],
    ...overrides,
  };
}

function member(index: number, overrides: Partial<IcCommitteeMemberSnapshot> = {}): IcCommitteeMemberSnapshot {
  return {
    employeeId: `member-${String(index).padStart(2, "0")}`,
    memberRole: index === 1 ? "CHAIR" : "MEMBER",
    votingEligible: true,
    chair: index === 1,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    ...overrides,
  };
}

function vote(index: number, choice: IcVoteSnapshot["choice"]): IcVoteSnapshot {
  return { id: `vote-${String(index).padStart(2, "0")}`, employeeId: member(index).employeeId, choice, recordedAt: AS_OF };
}

function input(overrides: Partial<IcAggregationInput> = {}): IcAggregationInput {
  return {
    asOf: AS_OF,
    committeeConfigVersionId: "committee-v1",
    recommendationId: "recommendation-v1",
    recommendationOutcome: "INVEST",
    memoId: "memo-v1",
    underwritingRunId: "run-v1",
    policy: policy(),
    members: [member(1), member(2), member(3)],
    votes: [vote(1, "APPROVE"), vote(2, "APPROVE"), vote(3, "REJECT")],
    questions: [],
    conditions: [],
    ...overrides,
  };
}

describe("P5 deterministic Investment Committee aggregation", () => {
  it("certifies unanimous approval", () => {
    const result = aggregateIcDecision(input({ votes: [vote(1, "APPROVE"), vote(2, "APPROVE"), vote(3, "APPROVE")], policy: policy({ threshold: { kind: "UNANIMOUS" } }) }));
    expect(result.process.status).toBe("PROCESS_ELIGIBLE");
    expect(result.threshold).toMatchObject({ status: "THRESHOLD_MET", requiredApprovals: 3, actualApprovals: 3 });
  });

  it("certifies majority approval against the exact denominator", () => {
    const result = aggregateIcDecision(input());
    expect(result.process.status).toBe("PROCESS_ELIGIBLE");
    expect(result.counts).toMatchObject({ eligible: 3, participating: 3, approve: 2, reject: 1, thresholdDenominator: 3 });
  });

  it("represents committee approval of a DECLINE recommendation without translating it into an Invest outcome", () => {
    const result = aggregateIcDecision(input({ recommendationOutcome: "DECLINE" }));
    expect(result.proposedOutcome).toBe("DECLINE");
  });

  it("applies explicit abstention treatment to quorum and threshold", () => {
    const result = aggregateIcDecision(input({ votes: [vote(1, "APPROVE"), vote(2, "ABSTAIN")], policy: policy({ quorum: { kind: "MIN_COUNT", minimum: 2 }, abstentionsCountAsNonApprove: false }) }));
    expect(result.quorum).toMatchObject({ status: "QUORUM_MET", actual: 2 });
    expect(result.threshold).toMatchObject({ status: "THRESHOLD_MET", requiredApprovals: 1 });
  });

  it("fails quorum instead of treating a missing voter as yes", () => {
    const result = aggregateIcDecision(input({ votes: [vote(1, "APPROVE")] }));
    expect(result.process.blockers).toContain("QUORUM_NOT_MET");
    expect(result.proposedOutcome).toBeNull();
  });

  it("fails an exact supermajority threshold", () => {
    const result = aggregateIcDecision(input({ policy: policy({ threshold: { kind: "SUPERMAJORITY", basisPoints: 7_500 } }) }));
    expect(result.threshold).toMatchObject({ status: "NOT_MET", requiredApprovals: 3, actualApprovals: 2 });
  });

  it("requires an actual Condition for INVEST_WITH_CONDITIONS", () => {
    const missing = aggregateIcDecision(input({ recommendationOutcome: "INVEST_WITH_CONDITIONS" }));
    expect(missing.process.blockers).toContain("CONDITIONAL_OUTCOME_REQUIRES_CONDITION");
    const present = aggregateIcDecision(input({ recommendationOutcome: "INVEST_WITH_CONDITIONS", conditions: [{ id: "condition-1", type: "POST_DECISION_PRE_SIGNING", state: "ACTIVE", required: true }] }));
    expect(present.process.status).toBe("PROCESS_ELIGIBLE");
  });

  it("blocks an unresolved required-before-Decision Question", () => {
    const result = aggregateIcDecision(input({ questions: [{ id: "question-1", state: "ANSWERED", requiredBeforeVote: true, requiredBeforeDecision: true }] }));
    expect(result.process.blockers).toEqual(["REQUIRED_QUESTION:question-1"]);
  });

  it("accepts a governed WAIVED required Question while preserving it in the input", () => {
    const result = aggregateIcDecision(input({ questions: [{ id: "question-1", state: "WAIVED", requiredBeforeVote: true, requiredBeforeDecision: true }] }));
    expect(result.process.status).toBe("PROCESS_ELIGIBLE");
    expect(result.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("blocks a required ACTIVE PRE_DECISION Condition", () => {
    const result = aggregateIcDecision(input({ conditions: [{ id: "condition-1", type: "PRE_DECISION", state: "ACTIVE", required: true }] }));
    expect(result.process.blockers).toContain("PRE_DECISION_CONDITION:condition-1");
  });

  it("requires named-role concurrence in addition to the configured base threshold", () => {
    const result = aggregateIcDecision(input({
      votes: [vote(1, "REJECT"), vote(2, "APPROVE"), vote(3, "APPROVE")],
      policy: policy({ threshold: { kind: "NAMED_ROLE_CONCURRENCE", memberRole: "CHAIR", base: "SIMPLE_MAJORITY" } }),
    }));
    expect(result.threshold.status).toBe("NOT_MET");
  });

  it("fails unsupported custom policy as BLOCKED_CONFIG instead of approximating", () => {
    const result = aggregateIcDecision(input({ policy: policy({ threshold: { kind: "BLOCKED_CONFIG", reason: "custom veto graph" } }) }));
    expect(result.threshold.status).toBe("BLOCKED_CONFIG");
    expect(result.process.blockers).toContain("BLOCKED_CONFIG");
  });

  it("evaluates membership at the explicit aggregation time", () => {
    const expired = member(3, { effectiveUntil: "2026-09-01T00:00:00.000Z" });
    const result = aggregateIcDecision(input({ members: [member(1), member(2), expired], votes: [vote(1, "APPROVE"), vote(2, "APPROVE")] }));
    expect(result.eligibleVoterIds).toEqual([member(1).employeeId, member(2).employeeId]);
  });

  it("blocks duplicate eligible membership rather than silently counting it twice", () => {
    const result = aggregateIcDecision(input({ members: [member(1), member(1), member(2)] }));
    expect(result.process.blockers).toContain(`DUPLICATE_ELIGIBLE_MEMBER:${member(1).employeeId}`);
  });

  it("blocks duplicate effective Votes rather than selecting a winner by row order", () => {
    const conflicting = { ...vote(1, "REJECT"), id: "vote-99" };
    const result = aggregateIcDecision(input({ votes: [vote(1, "APPROVE"), conflicting, vote(2, "APPROVE")] }));
    expect(result.process.blockers).toContain(`DUPLICATE_EFFECTIVE_VOTE:${member(1).employeeId}`);
  });

  it("blocks a Vote from outside the pinned eligible set", () => {
    const result = aggregateIcDecision(input({ votes: [...input().votes, { ...vote(4, "APPROVE") }] }));
    expect(result.process.blockers).toContain("INELIGIBLE_VOTE:vote-04");
  });

  it("is independent of member, Vote, Question and Condition input row order", () => {
    fc.assert(fc.property(
      fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
      fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
      (memberOrder, voteOrder) => {
        const base = input({ questions: [{ id: "q2", state: "WAIVED", requiredBeforeVote: true, requiredBeforeDecision: true }, { id: "q1", state: "RESOLVED", requiredBeforeVote: true, requiredBeforeDecision: true }] });
        const reordered = { ...base, members: memberOrder.map((index) => base.members[index]!), votes: voteOrder.map((index) => base.votes[index]!), questions: [...base.questions].reverse() };
        expect(aggregateIcDecision(reordered)).toEqual(aggregateIcDecision(base));
      },
    ), { seed: 5_001, numRuns: 50 });
  });

  it("computes percentage quorum with an exact ceiling", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 10_000 }), (count, basisPoints) => {
      const members = Array.from({ length: count }, (_, index) => member(index + 1));
      const result = aggregateIcDecision(input({ members, votes: [], policy: policy({ quorum: { kind: "PERCENTAGE", basisPoints } }) }));
      expect(result.quorum.required).toBe(Math.ceil((count * basisPoints) / 10_000));
    }), { seed: 5_002, numRuns: 100 });
  });

  it("produces a stable canonical semantic hash for equivalent objects", () => {
    expect(icSemanticHash({ z: 1, nested: { b: 2, a: 3 } })).toBe(icSemanticHash({ nested: { a: 3, b: 2 }, z: 1 }));
  });

  it("strictly parses the pinned Core policy and rejects invented rule forms", () => {
    expect(parseIcPolicySnapshot(policy())).toEqual(policy());
    expect(() => parseIcPolicySnapshot({ ...policy(), threshold: { kind: "LLM_JUDGMENT" } })).toThrow(PeDomainError);
    expect(() => parseIcPolicySnapshot({ ...policy(), schemaVersion: "future" })).toThrow(/pe-ic-policy\.v1/);
  });
});
