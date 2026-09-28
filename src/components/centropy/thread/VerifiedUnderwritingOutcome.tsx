import type { UnderwritingWorkspace, WorkAggregateView } from "@/components/centropy/product/contracts"

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function VerifiedUnderwritingOutcome({ work, underwriting, dealId, onOpenCanvas }: {
  work: WorkAggregateView | null
  underwriting: UnderwritingWorkspace | null
  dealId: string | null
  onOpenCanvas: () => void
}) {
  if (!work || !underwriting || !dealId || work.work.status !== "completed" || underwriting.investmentCase.dealId !== dealId) return null
  const outcome = record(work.work.finalOutcome)
  const verification = record(outcome?.successVerification)
  if (outcome?.kind !== "objective" || verification?.state !== "verified" || !Array.isArray(verification.results)) return null
  const exact = verification.results.map(record).find((result) => result?.kind === "private_equity_underwriting_scenario" && result.satisfied === true)
  const observed = record(exact?.observed)
  if (!observed || !Array.isArray(exact?.evidenceRefs)) return null
  const baseId = String(observed.baseRunId ?? "")
  const scenarioId = String(observed.scenarioId ?? "")
  const branchId = String(observed.branchRunId ?? "")
  const base = underwriting.runs.find((run) => run.id === baseId && !run.scenarioId && run.status === "SUCCEEDED" && run.validity === "VALID")
  const branch = underwriting.runs.find((run) => run.id === branchId && run.scenarioId === scenarioId && run.modelVersionId === base?.modelVersionId && run.status === "SUCCEEDED" && run.validity === "VALID")
  const scenario = underwriting.scenarios.find((item) => item.id === scenarioId && item.modelVersionId === base?.modelVersionId)
  const action = work.actions.find((item) => item.actionType === "create_underwriting_run" && item.status === "completed")
  const effect = work.businessEffects.find((item) => item.domainActionId === action?.id && item.status === "verified" && record(item.verification)?.state === "verified")
  const receipt = work.receipts.find((item) => item.domainActionId === action?.id && item.finalizedAt && !item.failure)
  const references = exact.evidenceRefs.map(record)
  const cited = (type: string, id: string) => references.some((ref) => ref?.type === type && ref.id === id)
  const completedPlan = work.planRevisions.find((plan) => {
    const proof = record(plan.completionProof)
    return plan.status === "completed" && proof?.verified === true && Array.isArray(proof.evidenceRefs)
      && proof.evidenceRefs.map(record).some((ref) => ref?.type === "business_effect" && ref.id === effect?.id)
  })
  const criteria = record(completedPlan?.goalSpec)?.criteria
  const contract = Array.isArray(criteria) ? criteria.map(record).map((item) => record(item?.criterion))
    .find((item) => item?.kind === "private_equity_underwriting_scenario" && item.dealId === dealId) : null
  const decreaseBps = contract?.growthDecreaseBps
  if (!base || !branch || !scenario || !action || !effect || !receipt || !completedPlan
    || typeof decreaseBps !== "number" || !Number.isInteger(decreaseBps) || decreaseBps < 1 || decreaseBps > 10_000
    || !cited("underwriting_run", baseId) || !cited("underwriting_run", branchId)
    || !cited("underwriting_scenario", scenarioId) || !cited("business_effect", effect.id) || !cited("decision_receipt", receipt.id)) return null
  const baseGrowth = record(base.inputSnapshot.values["operating.revenue_growth"]?.value)
  const branchGrowth = record(branch.inputSnapshot.values["operating.revenue_growth"]?.value)
  const growthPeriods = Object.keys(baseGrowth ?? {}).sort()
  const branchExit = branch.inputSnapshot.values["exit.multiple"]?.value
  const baseExit = base.inputSnapshot.values["exit.multiple"]?.value
  if (!growthPeriods.length || !branchGrowth || growthPeriods.some((period) => typeof baseGrowth?.[period] !== "string" || typeof branchGrowth[period] !== "string")
    || typeof baseExit !== "string" || typeof branchExit !== "string" || branchExit !== contract?.exitMultiple) return null
  return <section className="ct-verified-outcome" aria-label="Verified underwriting result" data-work-id={work.work.id}>
    <div className="ct-verified-outcome__eyebrow">CENTROPY · VERIFIED WORK RESULT</div>
    <h2>Growth scenario completed</h2>
    <p>The Objective finished with a valid Work-linked Run. The persisted success check verified the requested {decreaseBps} basis-point growth decrease and {branchExit}x exit.</p>
    <div className="ct-verified-outcome__case">
      {growthPeriods.map((period) => <p key={period}>Growth rate · {period}: {String(baseGrowth?.[period])} → {String(branchGrowth[period])} (−{decreaseBps}bps)</p>)}
      <p>Exit multiple: {baseExit}x → {branchExit}x</p>
      <button type="button" onClick={onOpenCanvas}>Inspect base, branch, and lineage in Canvas</button>
    </div>
    <details><summary>Verification references</summary><dl>
      <div><dt>Base Run</dt><dd>{baseId}</dd></div>
      <div><dt>Scenario</dt><dd>{scenarioId}</dd></div>
      <div><dt>Work-linked Run</dt><dd>{branchId}</dd></div>
      <div><dt>Business Effect</dt><dd>{effect.id}</dd></div>
      <div><dt>Receipt</dt><dd>{receipt.id}</dd></div>
    </dl></details>
  </section>
}
