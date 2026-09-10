import type {
  IcAggregationInput,
  IcAggregationResult,
  IcCaseState,
  IcCommitteeMemberSnapshot,
  IcConditionSnapshot,
  IcPolicySnapshot,
  IcQuestionSnapshot,
  IcRecommendationOutcome,
  IcVoteSnapshot,
} from "@finnor/private-equity";

const AS_OF = "2026-09-10T12:00:00.000Z";

function member(index: number, overrides: Partial<IcCommitteeMemberSnapshot> = {}): IcCommitteeMemberSnapshot {
  return {
    employeeId: `golden-member-${index}`,
    memberRole: index === 1 ? "CHAIR" : "MEMBER",
    votingEligible: true,
    chair: index === 1,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    ...overrides,
  };
}

function vote(index: number, choice: IcVoteSnapshot["choice"]): IcVoteSnapshot {
  return {
    id: `golden-vote-${index}`,
    employeeId: `golden-member-${index}`,
    choice,
    recordedAt: AS_OF,
  };
}

function policy(overrides: Partial<IcPolicySnapshot> = {}): IcPolicySnapshot {
  return {
    schemaVersion: "pe-ic-policy.v1",
    quorum: { kind: "MIN_COUNT", minimum: 3 },
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

function aggregation(overrides: Partial<IcAggregationInput> = {}): IcAggregationInput {
  return {
    asOf: AS_OF,
    committeeConfigVersionId: "golden-committee-v1",
    recommendationId: "golden-recommendation-v1",
    recommendationOutcome: "INVEST",
    memoId: "golden-memo-v1",
    underwritingRunId: "golden-run-v1",
    policy: policy(),
    members: [member(1), member(2), member(3), member(4), member(5)],
    votes: [
      vote(1, "APPROVE"), vote(2, "APPROVE"), vote(3, "APPROVE"),
      vote(4, "REJECT"), vote(5, "REJECT"),
    ],
    questions: [],
    conditions: [],
    ...overrides,
  };
}

export interface GoldenAggregationExpectation {
  processStatus: IcAggregationResult["process"]["status"];
  blockers: string[];
  proposedOutcome: IcRecommendationOutcome | null;
  quorumStatus: IcAggregationResult["quorum"]["status"];
  thresholdStatus: IcAggregationResult["threshold"]["status"];
  eligible: number;
  participating: number;
  approve: number;
  reject: number;
  abstain: number;
  effectiveVotes: number;
}

export interface GoldenIcCase {
  id: number;
  name: string;
  exactProcessFixture: {
    pinnedCommitteeVersion: string;
    pinnedMemoVersion: string;
    pinnedUnderwritingRun: string;
    pinnedRecommendationRevision: string;
    caseState: IcCaseState | "LEGACY_NO_P5_HISTORY";
    priorCaseState?: IcCaseState;
    priorDecisionState?: "final" | "superseded";
    canonicalDecisionCount: number;
    effectiveVoteCount: number;
    dissentCount: number;
    idempotentReplay: boolean;
    invalidatesPriorVotes: boolean;
    authorityRequired?: "QUESTION_WAIVER" | "DECISION_FINALIZATION" | "DECISION_SUPERSESSION";
  };
  aggregationInput?: IcAggregationInput;
  expectedAggregation?: GoldenAggregationExpectation;
  expectedAssertions: readonly string[];
}

const resolvedQuestion: IcQuestionSnapshot = {
  id: "golden-question-1", state: "RESOLVED", requiredBeforeVote: true, requiredBeforeDecision: true,
};
const waivedQuestion: IcQuestionSnapshot = {
  id: "golden-question-1", state: "WAIVED", requiredBeforeVote: true, requiredBeforeDecision: true,
};
const activePostDecisionCondition: IcConditionSnapshot = {
  id: "golden-condition-1", type: "POST_DECISION_PRE_SIGNING", state: "ACTIVE", required: true,
};

function fixture(overrides: Partial<GoldenIcCase["exactProcessFixture"]> = {}): GoldenIcCase["exactProcessFixture"] {
  return {
    pinnedCommitteeVersion: "golden-committee-v1",
    pinnedMemoVersion: "golden-memo-v1",
    pinnedUnderwritingRun: "golden-run-v1",
    pinnedRecommendationRevision: "golden-recommendation-v1",
    caseState: "DECIDED",
    canonicalDecisionCount: 1,
    effectiveVoteCount: 5,
    dissentCount: 0,
    idempotentReplay: false,
    invalidatesPriorVotes: false,
    ...overrides,
  };
}

/**
 * Twenty hand-authored fixtures required by the P5 roadmap. Expected outcomes
 * are literal acceptance truth; none are computed from the implementation.
 */
export const PE_IC_GOLDEN_CASES: readonly GoldenIcCase[] = Object.freeze([
  {
    id: 1,
    name: "unanimous approval",
    exactProcessFixture: fixture(),
    aggregationInput: aggregation({
      policy: policy({ threshold: { kind: "UNANIMOUS" } }),
      votes: [1, 2, 3, 4, 5].map((index) => vote(index, "APPROVE")),
    }),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 5, reject: 0, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["all five exact members approve", "one canonical P1 Decision is final"],
  },
  {
    id: 2,
    name: "majority approval",
    exactProcessFixture: fixture(),
    aggregationInput: aggregation(),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["simple majority is three of five", "minority Votes remain immutable history"],
  },
  {
    id: 3,
    name: "rejection",
    exactProcessFixture: fixture(),
    aggregationInput: aggregation({ recommendationOutcome: "DECLINE" }),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "DECLINE",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["committee approval of a DECLINE Recommendation remains DECLINE", "no outcome translation occurs"],
  },
  {
    id: 4,
    name: "abstention with quorum still met",
    exactProcessFixture: fixture({ effectiveVoteCount: 5 }),
    aggregationInput: aggregation({
      policy: policy({ quorum: { kind: "MIN_COUNT", minimum: 4 }, abstentionsCountAsNonApprove: false }),
      votes: [vote(1, "APPROVE"), vote(2, "APPROVE"), vote(3, "REJECT"), vote(4, "ABSTAIN"), vote(5, "ABSTAIN")],
    }),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 2, reject: 1, abstain: 2, effectiveVotes: 5,
    },
    expectedAssertions: ["abstentions count for quorum", "abstentions are excluded from the configured threshold denominator"],
  },
  {
    id: 5,
    name: "quorum failure",
    exactProcessFixture: fixture({ caseState: "VOTING", canonicalDecisionCount: 0, effectiveVoteCount: 2 }),
    aggregationInput: aggregation({ policy: policy({ quorum: { kind: "MIN_COUNT", minimum: 4 } }), votes: [vote(1, "APPROVE"), vote(2, "APPROVE")] }),
    expectedAggregation: {
      processStatus: "BLOCKED", blockers: ["QUORUM_NOT_MET"], proposedOutcome: null,
      quorumStatus: "NOT_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 2, approve: 2, reject: 0, abstain: 0, effectiveVotes: 2,
    },
    expectedAssertions: ["missing Votes never become approvals", "no P1 Decision is created"],
  },
  {
    id: 6,
    name: "supermajority threshold failure",
    exactProcessFixture: fixture({ caseState: "VOTING", canonicalDecisionCount: 0 }),
    aggregationInput: aggregation({ policy: policy({ threshold: { kind: "SUPERMAJORITY", basisPoints: 8_000 } }) }),
    expectedAggregation: {
      processStatus: "BLOCKED", blockers: ["THRESHOLD_NOT_MET"], proposedOutcome: null,
      quorumStatus: "QUORUM_MET", thresholdStatus: "NOT_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["four approvals are required at 80 percent", "three approvals cannot be rounded upward"],
  },
  {
    id: 7,
    name: "conditional approval",
    exactProcessFixture: fixture(),
    aggregationInput: aggregation({ recommendationOutcome: "INVEST_WITH_CONDITIONS", conditions: [activePostDecisionCondition] }),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST_WITH_CONDITIONS",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["an explicit IC Condition exists", "the IC Condition is not a transaction closing condition"],
  },
  {
    id: 8,
    name: "required Question blocks voting",
    exactProcessFixture: fixture({ caseState: "QUESTIONS_OPEN", canonicalDecisionCount: 0 }),
    aggregationInput: aggregation({ questions: [{ ...resolvedQuestion, state: "OPEN" }] }),
    expectedAggregation: {
      processStatus: "BLOCKED", blockers: ["REQUIRED_QUESTION:golden-question-1"], proposedOutcome: null,
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["required Question is OPEN", "voting/finalization cannot bypass it"],
  },
  {
    id: 9,
    name: "required Question waived with authority",
    exactProcessFixture: fixture({ authorityRequired: "QUESTION_WAIVER" }),
    aggregationInput: aggregation({ questions: [waivedQuestion] }),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["waiver preserves the Question", "Core Authority and finalized Receipt are required"],
  },
  {
    id: 10,
    name: "Recommendation revision before voting",
    exactProcessFixture: fixture({
      caseState: "READY_FOR_VOTE", canonicalDecisionCount: 0, effectiveVoteCount: 0,
      pinnedRecommendationRevision: "golden-recommendation-v2",
    }),
    expectedAssertions: ["revision two supersedes revision one", "no Vote references the superseded revision"],
  },
  {
    id: 11,
    name: "Recommendation revision after votes requires revote",
    exactProcessFixture: fixture({
      priorCaseState: "VOTING", caseState: "READY_FOR_REVIEW", canonicalDecisionCount: 0,
      effectiveVoteCount: 0, invalidatesPriorVotes: true, pinnedRecommendationRevision: "golden-recommendation-v2",
    }),
    expectedAssertions: ["new Recommendation invalidates the open voting basis", "prior Votes remain history but are not effective for revision two"],
  },
  {
    id: 12,
    name: "Memo version change during review",
    exactProcessFixture: fixture({
      priorCaseState: "READY_FOR_VOTE", caseState: "READY_FOR_REVIEW", canonicalDecisionCount: 0,
      effectiveVoteCount: 0, invalidatesPriorVotes: true, pinnedMemoVersion: "golden-memo-v2",
      pinnedRecommendationRevision: "NONE_REQUIRES_NEW_RECOMMENDATION",
    }),
    expectedAssertions: ["new exact P3 DocumentVersion is pinned", "the prior Recommendation cannot silently survive a material Memo change"],
  },
  {
    id: 13,
    name: "P4 Run replacement invalidates Recommendation",
    exactProcessFixture: fixture({
      priorCaseState: "READY_FOR_VOTE", caseState: "READY_FOR_REVIEW", canonicalDecisionCount: 0,
      effectiveVoteCount: 0, invalidatesPriorVotes: true, pinnedUnderwritingRun: "golden-run-v2",
      pinnedRecommendationRevision: "NONE_REQUIRES_NEW_RECOMMENDATION",
    }),
    expectedAssertions: ["new exact P4 Run is selected", "P5 does not copy or recalculate financial values"],
  },
  {
    id: 14,
    name: "Dissent preserved after majority approval",
    exactProcessFixture: fixture({ dissentCount: 1 }),
    aggregationInput: aggregation(),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["majority outcome remains INVEST", "one immutable Dissent remains linked to its exact rejecting Vote"],
  },
  {
    id: 15,
    name: "member becomes ineligible before vote",
    exactProcessFixture: fixture({ caseState: "VOTING", canonicalDecisionCount: 0, effectiveVoteCount: 4 }),
    aggregationInput: aggregation({
      members: [member(1), member(2), member(3), member(4), member(5, { effectiveUntil: "2026-09-10T11:00:00.000Z" })],
    }),
    expectedAggregation: {
      processStatus: "BLOCKED", blockers: ["INELIGIBLE_VOTE:golden-vote-5"], proposedOutcome: null,
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 4, participating: 4, approve: 3, reject: 1, abstain: 0, effectiveVotes: 4,
    },
    expectedAssertions: ["eligibility is evaluated at the pinned time", "the expired member Vote cannot be accepted"],
  },
  {
    id: 16,
    name: "duplicate Vote retry",
    exactProcessFixture: fixture({ effectiveVoteCount: 1, idempotentReplay: true }),
    aggregationInput: aggregation({
      policy: policy({ quorum: { kind: "MIN_COUNT", minimum: 1 } }),
      members: [member(1)], votes: [vote(1, "APPROVE")],
    }),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 1, participating: 1, approve: 1, reject: 0, abstain: 0, effectiveVotes: 1,
    },
    expectedAssertions: ["ten identical retries resolve to the original Vote", "one effective Vote exists"],
  },
  {
    id: 17,
    name: "simultaneous voting",
    exactProcessFixture: fixture({ caseState: "VOTING", canonicalDecisionCount: 0 }),
    aggregationInput: aggregation({ votes: [vote(5, "REJECT"), vote(3, "APPROVE"), vote(1, "APPROVE"), vote(4, "REJECT"), vote(2, "APPROVE")] }),
    expectedAggregation: {
      processStatus: "PROCESS_ELIGIBLE", blockers: [], proposedOutcome: "INVEST",
      quorumStatus: "QUORUM_MET", thresholdStatus: "THRESHOLD_MET",
      eligible: 5, participating: 5, approve: 3, reject: 2, abstain: 0, effectiveVotes: 5,
    },
    expectedAssertions: ["row arrival order cannot alter the aggregate", "all authenticated members retain one Vote"],
  },
  {
    id: 18,
    name: "Decision finalization retry",
    exactProcessFixture: fixture({ idempotentReplay: true, authorityRequired: "DECISION_FINALIZATION" }),
    expectedAssertions: ["both calls return the same P1 Decision identity", "one finalized Core DecisionReceipt exists"],
  },
  {
    id: 19,
    name: "reconsideration/superseding P1 Decision",
    exactProcessFixture: fixture({ priorDecisionState: "superseded", authorityRequired: "DECISION_SUPERSESSION" }),
    expectedAssertions: ["replacement P1 Decision points to the prior Decision", "prior ICCase and Decision remain immutable superseded history"],
  },
  {
    id: 20,
    name: "legacy P1 investment_committee Decision without P5 history",
    exactProcessFixture: fixture({
      caseState: "LEGACY_NO_P5_HISTORY", canonicalDecisionCount: 1, effectiveVoteCount: 0,
      pinnedCommitteeVersion: "NONE", pinnedMemoVersion: "NONE", pinnedUnderwritingRun: "NONE",
      pinnedRecommendationRevision: "NONE",
    }),
    expectedAssertions: ["legacy P1 Decision remains canonical and untouched", "no fabricated ICCase, Vote, Memo, or committee history is backfilled"],
  },
]);

export const PE_IC_GOLDEN_NAMES = PE_IC_GOLDEN_CASES.map((entry) => entry.name);
