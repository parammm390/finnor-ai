import type {
  AttentionItem,
  AttentionKind,
  AttentionRankVector,
} from "@finnor/shared-types";

const NO_DEADLINE = Number.MAX_SAFE_INTEGER;
const NO_MATERIALITY = 9;

const SAFETY_RECOVERY_KINDS = new Set<AttentionKind>([
  "work_recovery",
  "work_failure",
  "wait_timed_out",
  "manual_verification_required",
  "ai_assignment_failed",
  "no_eligible_ai_worker",
  "worker_budget_exhausted",
]);

const AUTHORITY_BOTTLENECK_KINDS = new Set<AttentionKind>([
  "approval_required",
  "human_attestation_required",
  "manual_verification_required",
  "p5_question_blocking",
  "p5_vote_required",
  "p5_decision_required",
  "p5_condition_active",
  "learning_proposal_review",
  "human_only_boundary",
]);

const MATERIALITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  CRITICAL: 0,
  MATERIAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  NORMAL: 2,
  LOW: 3,
  NON_MATERIAL: 3,
});

function finiteInteger(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return Math.trunc(value);
}

export interface AttentionRankInput {
  id: string;
  kind: AttentionKind;
  deadline: string | null;
  createdAt: string;
  impact: AttentionItem["impact"];
  authorityBoundary: AttentionItem["authorityBoundary"];
}

/** Pure deterministic lexicographic rank. It consumes only explicit canonical
 * fields and never prose, a model score, or a probability. */
export function buildAttentionRankVector(input: AttentionRankInput, asOf: Date): AttentionRankVector {
  if (!Number.isFinite(asOf.valueOf())) throw new Error("Attention asOf must be a valid instant");
  const createdAtMs = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAtMs)) throw new Error("Attention createdAt must be an ISO timestamp");
  const deadlineMs = input.deadline === null ? null : Date.parse(input.deadline);
  if (input.deadline !== null && !Number.isFinite(deadlineMs)) throw new Error("Attention deadline must be an ISO timestamp");
  const slackMs = deadlineMs === null ? null : finiteInteger(deadlineMs - asOf.valueOf(), "Attention slack");
  const deadlineRank = slackMs === null ? 2 : slackMs <= 0 ? 0 : 1;
  const materiality = input.impact.sourceBackedMateriality?.classification.toUpperCase() ?? null;
  const materialityRank = materiality === null ? null : (MATERIALITY_RANK[materiality] ?? NO_MATERIALITY);
  const downstreamCompletionCriteria = Math.max(0, finiteInteger(input.impact.completionCriteria, "Completion criterion count"));
  const downstreamPlanNodes = Math.max(0, finiteInteger(input.impact.downstreamPlanNodes, "Downstream node count"));
  const ageMs = Math.max(0, finiteInteger(asOf.valueOf() - createdAtMs, "Attention age"));
  const safetyRecoveryRank = SAFETY_RECOVERY_KINDS.has(input.kind) ? 0 : 1;
  const authorityBottleneckRank = input.authorityBoundary || AUTHORITY_BOTTLENECK_KINDS.has(input.kind) ? 0 : 1;
  const stableTieBreak = input.id;
  return {
    safetyRecoveryRank,
    deadlineRank,
    slackMs,
    downstreamCompletionCriteria,
    downstreamPlanNodes,
    authorityBottleneckRank,
    materialityRank,
    ageMs,
    stableTieBreak,
    tuple: [
      safetyRecoveryRank,
      deadlineRank,
      slackMs ?? NO_DEADLINE,
      -downstreamCompletionCriteria,
      -downstreamPlanNodes,
      authorityBottleneckRank,
      materialityRank ?? NO_MATERIALITY,
      -ageMs,
      stableTieBreak,
    ],
  };
}

function compareTuple(left: AttentionRankVector["tuple"], right: AttentionRankVector["tuple"]): number {
  for (let index = 0; index < left.length - 1; index += 1) {
    const delta = (left[index] as number) - (right[index] as number);
    if (delta !== 0) return delta;
  }
  return String(left.at(-1)).localeCompare(String(right.at(-1)));
}

export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  return compareTuple(left.rankVector.tuple, right.rankVector.tuple);
}

export function rankAttentionItems<T extends Omit<AttentionItem, "rankVector" | "slackMs">>(
  items: readonly T[],
  asOf: Date,
): Array<T & Pick<AttentionItem, "rankVector" | "slackMs">> {
  return items.map((item) => {
    const rankVector = buildAttentionRankVector(item, asOf);
    return { ...item, slackMs: rankVector.slackMs, rankVector };
  }).sort(compareAttentionItems as (left: T & Pick<AttentionItem, "rankVector" | "slackMs">, right: T & Pick<AttentionItem, "rankVector" | "slackMs">) => number);
}
