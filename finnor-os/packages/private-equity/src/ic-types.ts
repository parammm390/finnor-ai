export const IC_CASE_STATES = [
  "DRAFT",
  "PREPARING",
  "READY_FOR_REVIEW",
  "QUESTIONS_OPEN",
  "READY_FOR_VOTE",
  "VOTING",
  "CONDITIONS_PENDING",
  "DECIDED",
  "WITHDRAWN",
  "SUPERSEDED",
  "BLOCKED",
] as const;

export type IcCaseState = (typeof IC_CASE_STATES)[number];

export const IC_CASE_TRANSITIONS: Readonly<Record<IcCaseState, readonly IcCaseState[]>> = {
  DRAFT: ["PREPARING", "WITHDRAWN"],
  PREPARING: ["READY_FOR_REVIEW", "BLOCKED", "WITHDRAWN"],
  READY_FOR_REVIEW: ["QUESTIONS_OPEN", "READY_FOR_VOTE", "BLOCKED", "WITHDRAWN"],
  QUESTIONS_OPEN: ["READY_FOR_VOTE", "READY_FOR_REVIEW", "BLOCKED", "WITHDRAWN"],
  READY_FOR_VOTE: ["VOTING", "QUESTIONS_OPEN", "READY_FOR_REVIEW", "BLOCKED", "WITHDRAWN"],
  VOTING: ["CONDITIONS_PENDING", "READY_FOR_REVIEW", "BLOCKED", "WITHDRAWN"],
  CONDITIONS_PENDING: ["DECIDED", "READY_FOR_REVIEW", "BLOCKED", "WITHDRAWN"],
  DECIDED: ["SUPERSEDED"],
  WITHDRAWN: [],
  SUPERSEDED: [],
  BLOCKED: ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE", "CONDITIONS_PENDING", "WITHDRAWN"],
};

export const IC_QUESTION_STATES = ["OPEN", "ANSWERED", "RESOLVED", "WAIVED", "SUPERSEDED"] as const;
export type IcQuestionState = (typeof IC_QUESTION_STATES)[number];

export const IC_QUESTION_TRANSITIONS: Readonly<Record<IcQuestionState, readonly IcQuestionState[]>> = {
  OPEN: ["ANSWERED", "WAIVED", "SUPERSEDED"],
  ANSWERED: ["RESOLVED", "WAIVED", "SUPERSEDED"],
  RESOLVED: ["SUPERSEDED"],
  WAIVED: ["SUPERSEDED"],
  SUPERSEDED: [],
};

export const IC_RECOMMENDATION_OUTCOMES = [
  "INVEST",
  "DECLINE",
  "DEFER",
  "INVEST_WITH_CONDITIONS",
  "CONTINUE_DILIGENCE",
] as const;
export type IcRecommendationOutcome = (typeof IC_RECOMMENDATION_OUTCOMES)[number];

export const IC_VOTE_CHOICES = ["APPROVE", "REJECT", "ABSTAIN", "DEFER"] as const;
export type IcVoteChoice = (typeof IC_VOTE_CHOICES)[number];

export const IC_CONDITION_TYPES = ["PRE_DECISION", "POST_DECISION_PRE_SIGNING", "PRE_CLOSING", "MONITORING"] as const;
export type IcConditionType = (typeof IC_CONDITION_TYPES)[number];

export const IC_CONDITION_STATES = ["PROPOSED", "ACTIVE", "SATISFIED", "WAIVED", "FAILED", "SUPERSEDED"] as const;
export type IcConditionState = (typeof IC_CONDITION_STATES)[number];

export const IC_CONDITION_TRANSITIONS: Readonly<Record<IcConditionState, readonly IcConditionState[]>> = {
  PROPOSED: ["ACTIVE", "SUPERSEDED"],
  ACTIVE: ["SATISFIED", "WAIVED", "FAILED", "SUPERSEDED"],
  SATISFIED: ["SUPERSEDED"],
  WAIVED: ["SUPERSEDED"],
  FAILED: ["SUPERSEDED"],
  SUPERSEDED: [],
};

export const IC_SOURCE_KINDS = [
  "EVIDENCE_VERSION",
  "ARTIFACT_ANCHOR",
  "UNDERWRITING_RUN",
  "P1_WORLD",
  "IC_QUESTION",
  "PE_RISK",
  "IC_CONDITION",
] as const;
export type IcSourceKind = (typeof IC_SOURCE_KINDS)[number];

export type IcQuorumRule =
  | { kind: "MIN_COUNT"; minimum: number }
  | { kind: "PERCENTAGE"; basisPoints: number };

export type IcThresholdRule =
  | { kind: "SIMPLE_MAJORITY" }
  | { kind: "SUPERMAJORITY"; basisPoints: number }
  | { kind: "UNANIMOUS" }
  | { kind: "NAMED_ROLE_CONCURRENCE"; memberRole: string; base: "SIMPLE_MAJORITY" | "SUPERMAJORITY"; basisPoints?: number }
  | { kind: "BLOCKED_CONFIG"; reason: string };

export interface IcPolicySnapshot {
  schemaVersion: "pe-ic-policy.v1";
  quorum: IcQuorumRule;
  threshold: IcThresholdRule;
  abstentionsCountForQuorum: boolean;
  deferralsCountForQuorum: boolean;
  abstentionsCountAsNonApprove: boolean;
  deferralsCountAsNonApprove: boolean;
  memoChange: "REQUIRE_REVOTE" | "REQUIRE_REAFFIRMATION" | "RETAIN_IF_NON_MATERIAL";
  underwritingRunChange: "REQUIRE_NEW_RECOMMENDATION";
  requiredQuestionWaiverAllowed: boolean;
  conditionWaiverAllowed: boolean;
  allowedPrimaryRunValidities: readonly ("VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT")[];
}

export interface IcCommitteeMemberSnapshot {
  employeeId: string;
  memberRole: string;
  votingEligible: boolean;
  chair: boolean;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

export interface IcVoteSnapshot {
  id: string;
  employeeId: string;
  choice: IcVoteChoice;
  recordedAt: string;
}

export interface IcQuestionSnapshot {
  id: string;
  state: IcQuestionState;
  requiredBeforeVote: boolean;
  requiredBeforeDecision: boolean;
}

export interface IcConditionSnapshot {
  id: string;
  type: IcConditionType;
  state: IcConditionState;
  required: boolean;
}

export interface IcAggregationInput {
  asOf: string;
  committeeConfigVersionId: string;
  recommendationId: string;
  recommendationOutcome: IcRecommendationOutcome;
  memoId: string;
  underwritingRunId: string;
  policy: IcPolicySnapshot;
  members: readonly IcCommitteeMemberSnapshot[];
  votes: readonly IcVoteSnapshot[];
  questions: readonly IcQuestionSnapshot[];
  conditions: readonly IcConditionSnapshot[];
}

export interface IcAggregationResult {
  schemaVersion: "pe-ic-aggregation.v1";
  asOf: string;
  inputHash: string;
  eligibleVoterIds: string[];
  effectiveVotes: IcVoteSnapshot[];
  counts: {
    eligible: number;
    participating: number;
    approve: number;
    reject: number;
    abstain: number;
    defer: number;
    thresholdDenominator: number;
  };
  quorum: { status: "QUORUM_MET" | "NOT_MET"; required: number; actual: number };
  threshold: { status: "THRESHOLD_MET" | "NOT_MET" | "BLOCKED_CONFIG"; rule: IcThresholdRule; requiredApprovals: number | null; actualApprovals: number };
  process: { status: "PROCESS_ELIGIBLE" | "BLOCKED"; blockers: string[] };
  proposedOutcome: IcRecommendationOutcome | null;
}

export interface IcWorkspaceReadModel {
  viewer: { employeeId: string | null };
  case: Record<string, unknown>;
  investmentCase: Record<string, unknown>;
  committee: {
    config: Record<string, unknown>;
    members: Record<string, unknown>[];
  };
  memo: Record<string, unknown> | null;
  deck: Record<string, unknown> | null;
  artifacts: {
    memo: Record<string, unknown> | null;
    deck: Record<string, unknown> | null;
  };
  underwriting: {
    run: Record<string, unknown>;
    checks: Record<string, unknown>[];
    eligibleUnderPinnedPolicy: boolean;
    eligibilityBlockers: string[];
  } | null;
  questions: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }>;
  recommendations: Record<string, unknown>[];
  currentRecommendation: Record<string, unknown> | null;
  votes: Record<string, unknown>[];
  dissents: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }>;
  conditions: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }>;
  decisionProposal: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  decisionProof: Record<string, unknown> | null;
  readiness: {
    votingEligible: boolean;
    decisionEligible: boolean;
    blockers: string[];
    aggregation: IcAggregationResult | null;
  };
  controls: Record<string, boolean>;
  controlBlockers: Record<string, string[]>;
  asOf: string;
}
