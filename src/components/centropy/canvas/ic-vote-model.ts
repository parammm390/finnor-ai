import type { IcWorkspace } from "@/components/centropy/product/contracts"
import { z } from "zod"

export const IC_VOTE_CHOICES = ["APPROVE", "REJECT", "ABSTAIN", "DEFER"] as const
export type IcVoteChoice = (typeof IC_VOTE_CHOICES)[number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VoteEligibilitySchema = z.object({
  case: z.object({ id: z.string(), state: z.string(), currentRecommendationId: z.string().nullable(), currentMemoId: z.string().nullable(), primaryUnderwritingRunId: z.string().nullable(), votingBasisVersion: z.number().int().nullable() }),
  currentRecommendation: z.object({ id: z.string(), memoId: z.string(), underwritingRunId: z.string(), outcome: z.string(), rationale: z.string() }).nullable(),
  controls: z.object({ recordVote: z.boolean() }).passthrough(),
  controlBlockers: z.object({ recordVote: z.array(z.string()) }).passthrough(),
}).passthrough()
export interface IcVoteBasis { caseId: string; recommendationId: string; memoId: string; underwritingRunId: string; votingBasisVersion: number; recommendationOutcome: string; recommendationRationale: string }

/** A vote is available only when every submitted basis identifier is verified against the same IC read. */
export function icVoteBasis(workspace: IcWorkspace): { basis: IcVoteBasis | null; reasons: string[] } {
  const parsed = VoteEligibilitySchema.safeParse(workspace)
  if (!parsed.success) return { basis: null, reasons: ["IC_VOTE_BASIS_UNVERIFIED"] }
  const reasons = [...parsed.data.controlBlockers.recordVote]
  const record = parsed.data.case
  const recommendation = parsed.data.currentRecommendation
  if (record.state !== "VOTING") reasons.push(`STATE:${record.state}`)
  if (parsed.data.controls.recordVote !== true) reasons.push("VOTE_CONTROL_UNAVAILABLE")
  if (!UUID.test(record.id)) reasons.push("CASE_ID_UNAVAILABLE")
  if (!recommendation || !UUID.test(recommendation.id ?? "") || recommendation.id !== record.currentRecommendationId) reasons.push("CURRENT_RECOMMENDATION_UNAVAILABLE")
  if (!UUID.test(recommendation?.memoId ?? "") || recommendation?.memoId !== record.currentMemoId) reasons.push("CURRENT_MEMO_UNAVAILABLE")
  if (!UUID.test(recommendation?.underwritingRunId ?? "") || recommendation?.underwritingRunId !== record.primaryUnderwritingRunId) reasons.push("PINNED_UNDERWRITING_RUN_UNAVAILABLE")
  if (typeof record.votingBasisVersion !== "number" || !Number.isInteger(record.votingBasisVersion) || record.votingBasisVersion < 1) reasons.push("VOTING_BASIS_VERSION_UNAVAILABLE")
  if (!recommendation?.outcome || !recommendation.rationale) reasons.push("RECOMMENDATION_EXPLANATION_UNAVAILABLE")
  if (reasons.length || !recommendation?.id || !recommendation.memoId || !recommendation.underwritingRunId || !record.votingBasisVersion) return { basis: null, reasons: [...new Set(reasons)] }
  return { basis: {
    caseId: record.id, recommendationId: recommendation.id, memoId: recommendation.memoId,
    underwritingRunId: recommendation.underwritingRunId, votingBasisVersion: record.votingBasisVersion,
    recommendationOutcome: recommendation.outcome!, recommendationRationale: recommendation.rationale!,
  }, reasons: [] }
}

export function sameVoteBasis(left: IcVoteBasis, right: IcVoteBasis): boolean {
  return left.caseId === right.caseId && left.recommendationId === right.recommendationId && left.memoId === right.memoId && left.underwritingRunId === right.underwritingRunId && left.votingBasisVersion === right.votingBasisVersion
}
