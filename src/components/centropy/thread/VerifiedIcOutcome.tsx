import type { IcWorkspace, WorkAggregateView } from "@/components/centropy/product/contracts"
import { verifiedWorkIcCase } from "../canvas/work-deck-model"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Render only when the completed Work and its Plan cite the exact IC review effect. */
function verifiedReview(work: WorkAggregateView | null, dealId: string | null) {
  if (!work || work.work.status !== "completed") return null
  const caseId = verifiedWorkIcCase(work, dealId)
  if (!caseId) return null
  const review = work.actions.find((action) => action.actionType === "request_ic_memo_review" && action.status === "completed")
  const effect = work.businessEffects.find((item) => item.domainActionId === review?.id && item.status === "verified" && record(item.verification)?.state === "verified")
  if (!effect || !work.receipts.some((receipt) => receipt.domainActionId === review?.id && receipt.finalizedAt && !receipt.failure)) return null
  const outcome = record(work.work.finalOutcome)
  const verification = record(outcome?.successVerification)
  const cited = Array.isArray(verification?.evidence) && verification.evidence.some((value) => {
    const evidence = record(value)
    return evidence?.kind === "business_effect" && evidence.businessEffectId === effect.id
  })
  if (outcome?.kind !== "objective" || !UUID.test(String(outcome.objectiveLoopId ?? "")) || verification?.state !== "verified" || !cited) return null
  const provenPlan = work.planRevisions.some((plan) => {
    const proof = record(plan.completionProof)
    return plan.status === "completed" && proof?.verified === true && Array.isArray(proof.evidenceRefs)
      && proof.evidenceRefs.some((value) => {
        const ref = record(value)
        return ref?.type === "business_effect" && ref.id === effect.id
      })
  })
  return provenPlan ? { caseId, effectId: effect.id, objectiveLoopId: String(outcome.objectiveLoopId) } : null
}

export function VerifiedIcOutcome({ work, ic, dealId, onOpenCanvas }: {
  work: WorkAggregateView | null
  ic: IcWorkspace | null
  dealId: string | null
  onOpenCanvas: () => void
}) {
  const result = verifiedReview(work, dealId)
  if (!result) return null
  const exactCase = ic?.case.id === result.caseId && ic.case.dealId === dealId ? ic : null
  const recommendation = exactCase && exactCase.currentRecommendation?.id === exactCase.case.currentRecommendationId ? exactCase.currentRecommendation : null
  const selectedMemo = exactCase && exactCase.memo?.id === exactCase.case.currentMemoId ? exactCase.memo : null
  return <section className="ct-verified-outcome" aria-label="Verified Objective result" data-work-id={work?.work.id}>
    <div className="ct-verified-outcome__eyebrow">CENTROPY · VERIFIED WORK RESULT</div>
    <h2>IC preparation completed</h2>
    <p>The Objective reached its verified completion condition. Its exact review effect and completed Plan are recorded on this Work.</p>
    {exactCase ? <div className="ct-verified-outcome__case">
      <strong>IC case · {exactCase.case.state.replaceAll("_", " ")}</strong>
      {recommendation ? <p>Current recommendation: {String(recommendation.outcome ?? "Outcome not recorded").replaceAll("_", " ").toLowerCase()}.</p> : null}
      {selectedMemo ? <p>Selected memo is recorded on this IC case.</p> : null}
      <button type="button" onClick={onOpenCanvas}>Inspect case and sources in Canvas</button>
    </div> : <p className="ct-verified-outcome__pending">Loading the exact Work-linked IC case…</p>}
    <details><summary>Verification references</summary><dl>
      <div><dt>Work</dt><dd>{work?.work.id}</dd></div>
      <div><dt>Objective</dt><dd>{result.objectiveLoopId}</dd></div>
      <div><dt>Review Business Effect</dt><dd>{result.effectId}</dd></div>
      <div><dt>IC case</dt><dd>{result.caseId}</dd></div>
    </dl></details>
  </section>
}
