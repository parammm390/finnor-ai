import { z } from "zod"
import { FinancialExplanationSchema } from "../../../../finnor-os/packages/shared-types/src/financial-explanation"
import { FinancialDocumentReviewSchema } from "../../../../finnor-os/packages/shared-types/src/document-financial-review"
import type { WorkAggregateView } from "../product/contracts"

const Answer = z.object({ kind: z.literal("answer"), readOnly: z.literal(true), spokenSummary: z.string().min(1),
  display: z.object({ title: z.string() }), analysis: z.unknown().optional() })
const Outcome = z.object({ kind: z.literal("answer"), spokenSummary: z.string().optional(), answer: Answer.optional() })

type AnswerWork = { work: Pick<WorkAggregateView["work"], "status" | "finalOutcome" | "updatedAt">; documentReview?: unknown }

export function readAnswerResult(work: AnswerWork | null) {
  if (!work || work.work.status !== "completed") return null
  const parsed = Outcome.safeParse(work.work.finalOutcome)
  if (!parsed.success) return null
  const answer = parsed.data.answer
  const text = answer?.spokenSummary ?? parsed.data.spokenSummary
  if (!text) return null
  const analysis = FinancialExplanationSchema.safeParse(answer?.analysis)
  const documentReview = FinancialDocumentReviewSchema.safeParse(work.documentReview)
  return { title: answer?.display.title ?? "Answer", text, analysis: analysis.success ? analysis.data : null,
    documentReview: documentReview.success ? documentReview.data : null, asOf: work.work.updatedAt }
}

export type AnswerResult = NonNullable<ReturnType<typeof readAnswerResult>>
