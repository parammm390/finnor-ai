import { createHash } from "node:crypto";
import type {
  IcAggregationInput,
  IcAggregationResult,
  IcCommitteeMemberSnapshot,
  IcThresholdRule,
  IcVoteSnapshot,
} from "./ic-types";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

export function icSemanticHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function ceilRatio(value: number, basisPoints: number): number {
  return Math.ceil((value * basisPoints) / 10_000);
}

function activeAt(member: IcCommitteeMemberSnapshot, asOf: number): boolean {
  const from = Date.parse(member.effectiveFrom);
  const until = member.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(member.effectiveUntil);
  return Number.isFinite(from) && from <= asOf && asOf < until;
}

function thresholdEvaluation(params: {
  rule: IcThresholdRule;
  denominator: number;
  approve: number;
  eligible: readonly IcCommitteeMemberSnapshot[];
  votes: readonly IcVoteSnapshot[];
}): IcAggregationResult["threshold"] {
  const { rule, denominator, approve } = params;
  if (rule.kind === "BLOCKED_CONFIG") {
    return { status: "BLOCKED_CONFIG", rule, requiredApprovals: null, actualApprovals: approve };
  }
  let required = 0;
  let baseMet = false;
  if (rule.kind === "SIMPLE_MAJORITY") {
    required = Math.floor(denominator / 2) + 1;
    baseMet = denominator > 0 && approve >= required;
  } else if (rule.kind === "SUPERMAJORITY") {
    required = ceilRatio(denominator, rule.basisPoints);
    baseMet = denominator > 0 && approve >= required;
  } else if (rule.kind === "UNANIMOUS") {
    required = denominator;
    baseMet = denominator > 0 && approve === denominator;
  } else {
    required = rule.base === "SIMPLE_MAJORITY"
      ? Math.floor(denominator / 2) + 1
      : ceilRatio(denominator, rule.basisPoints ?? 6_667);
    const roleIds = new Set(params.eligible.filter((member) => member.memberRole === rule.memberRole).map((member) => member.employeeId));
    const roleConcurrence = roleIds.size > 0 && params.votes.some((vote) => roleIds.has(vote.employeeId) && vote.choice === "APPROVE");
    baseMet = denominator > 0 && approve >= required && roleConcurrence;
  }
  return {
    status: baseMet ? "THRESHOLD_MET" : "NOT_MET",
    rule,
    requiredApprovals: required,
    actualApprovals: approve,
  };
}

/** Pure, order-independent IC aggregation. All time-dependent input is explicit. */
export function aggregateIcDecision(input: IcAggregationInput): IcAggregationResult {
  const asOf = Date.parse(input.asOf);
  if (!Number.isFinite(asOf)) throw new Error("IC aggregation asOf must be an ISO timestamp");

  const activeEligible = [...input.members]
    .filter((member) => member.votingEligible && activeAt(member, asOf))
    .sort((left, right) => left.employeeId.localeCompare(right.employeeId));
  const duplicateEligibleMemberIds = activeEligible
    .filter((member, index) => activeEligible.findIndex((candidate) => candidate.employeeId === member.employeeId) !== index)
    .map((member) => member.employeeId);
  const eligible = activeEligible.filter((member, index) => activeEligible.findIndex((candidate) => candidate.employeeId === member.employeeId) === index);
  const eligibleIds = new Set(eligible.map((member) => member.employeeId));
  const sortedInputVotes = [...input.votes]
    .sort((left, right) => left.employeeId.localeCompare(right.employeeId) || left.id.localeCompare(right.id));
  const ineligibleVoteIds = sortedInputVotes.filter((vote) => !eligibleIds.has(vote.employeeId)).map((vote) => vote.id);
  const duplicateVoteEmployeeIds = sortedInputVotes
    .filter((vote, index) => sortedInputVotes.findIndex((candidate) => candidate.employeeId === vote.employeeId) !== index)
    .map((vote) => vote.employeeId);
  const seen = new Set<string>();
  const votes = sortedInputVotes
    .filter((vote) => {
      if (!eligibleIds.has(vote.employeeId) || seen.has(vote.employeeId)) return false;
      seen.add(vote.employeeId);
      return true;
    });
  const count = (choice: IcVoteSnapshot["choice"]) => votes.filter((vote) => vote.choice === choice).length;
  const approve = count("APPROVE");
  const reject = count("REJECT");
  const abstain = count("ABSTAIN");
  const defer = count("DEFER");
  const quorumActual = approve + reject
    + (input.policy.abstentionsCountForQuorum ? abstain : 0)
    + (input.policy.deferralsCountForQuorum ? defer : 0);
  const quorumRequired = input.policy.quorum.kind === "MIN_COUNT"
    ? input.policy.quorum.minimum
    : ceilRatio(eligible.length, input.policy.quorum.basisPoints);
  const quorumMet = eligible.length > 0 && quorumActual >= quorumRequired;
  const denominator = approve + reject
    + (input.policy.abstentionsCountAsNonApprove ? abstain : 0)
    + (input.policy.deferralsCountAsNonApprove ? defer : 0);
  const threshold = thresholdEvaluation({
    rule: input.policy.threshold,
    denominator,
    approve,
    eligible,
    votes,
  });

  const blockers: string[] = [];
  for (const memberId of [...new Set(duplicateEligibleMemberIds)].sort()) blockers.push(`DUPLICATE_ELIGIBLE_MEMBER:${memberId}`);
  for (const memberId of [...new Set(duplicateVoteEmployeeIds)].sort()) blockers.push(`DUPLICATE_EFFECTIVE_VOTE:${memberId}`);
  for (const voteId of ineligibleVoteIds.sort()) blockers.push(`INELIGIBLE_VOTE:${voteId}`);
  if (!quorumMet) blockers.push("QUORUM_NOT_MET");
  if (threshold.status === "NOT_MET") blockers.push("THRESHOLD_NOT_MET");
  if (threshold.status === "BLOCKED_CONFIG") blockers.push("BLOCKED_CONFIG");
  if (input.recommendationOutcome === "INVEST_WITH_CONDITIONS"
    && !input.conditions.some((condition) => condition.state !== "SUPERSEDED")) {
    blockers.push("CONDITIONAL_OUTCOME_REQUIRES_CONDITION");
  }
  for (const question of [...input.questions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (question.requiredBeforeDecision && !["RESOLVED", "WAIVED", "SUPERSEDED"].includes(question.state)) {
      blockers.push(`REQUIRED_QUESTION:${question.id}`);
    }
  }
  for (const condition of [...input.conditions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (condition.required && condition.type === "PRE_DECISION" && !["SATISFIED", "WAIVED", "SUPERSEDED"].includes(condition.state)) {
      blockers.push(`PRE_DECISION_CONDITION:${condition.id}`);
    }
  }

  const material = {
    schemaVersion: "pe-ic-aggregation-input.v1",
    ...input,
    members: [...input.members].sort((a, b) => a.employeeId.localeCompare(b.employeeId)),
    votes: [...input.votes].sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.id.localeCompare(b.id)),
    questions: [...input.questions].sort((a, b) => a.id.localeCompare(b.id)),
    conditions: [...input.conditions].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return {
    schemaVersion: "pe-ic-aggregation.v1",
    asOf: input.asOf,
    inputHash: icSemanticHash(material),
    eligibleVoterIds: eligible.map((member) => member.employeeId),
    effectiveVotes: votes,
    counts: {
      eligible: eligible.length,
      participating: quorumActual,
      approve,
      reject,
      abstain,
      defer,
      thresholdDenominator: denominator,
    },
    quorum: { status: quorumMet ? "QUORUM_MET" : "NOT_MET", required: quorumRequired, actual: quorumActual },
    threshold,
    process: { status: blockers.length === 0 ? "PROCESS_ELIGIBLE" : "BLOCKED", blockers },
    proposedOutcome: blockers.length === 0 ? input.recommendationOutcome : null,
  };
}
