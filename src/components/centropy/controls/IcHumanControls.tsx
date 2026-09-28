"use client"

import { lazy, Suspense, useState } from "react"
import type { IcWorkspace } from "@/components/centropy/product/contracts"
const HumanControlDesk = lazy(() => import("./HumanControlDesk").then((module) => ({ default: module.HumanControlDesk })))

export function IcHumanControls({ workspace, writable, onRecorded }: { workspace: IcWorkspace; writable: boolean; onRecorded: () => void }) {
  const [questionId, setQuestionId] = useState("")
  const [conditionId, setConditionId] = useState("")
  const [open, setOpen] = useState(false)
  const question = workspace.questions.find((item) => item.id === questionId) ?? workspace.questions[0]
  const condition = workspace.conditions.find((item) => item.id === conditionId) ?? workspace.conditions[0]
  const controls: Record<string, string> = { "begin-preparation": "beginPreparation", questions: "createQuestion", recommendations: "createRecommendation", "ready-for-vote": "markReadyForVote", "voting/open": "openVoting", "voting/close": "closeVoting", "decision-proposals": "prepareDecisionProposal", finalize: "finalizeDecision", dissents: "recordDissent" }
  return <details className="ct-record-controls" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Review committee record changes</summary>
    <p>Questions, dissent, conditions, voting transitions, and final decisions use this exact IC case. Human decisions require your own attestation.</p>
    {workspace.questions.length ? <label>Selected question<select value={question?.id ?? ""} onChange={(e) => setQuestionId(e.target.value)}>{workspace.questions.map((item) => <option key={item.id} value={item.id}>{item.question ?? "Recorded question"} · {item.state?.replaceAll("_", " ")}</option>)}</select></label> : null}
    {workspace.conditions.length ? <label>Selected condition<select value={condition?.id ?? ""} onChange={(e) => setConditionId(e.target.value)}>{workspace.conditions.map((item) => <option key={item.id} value={item.id}>{item.title ?? "Recorded condition"} · {item.state?.replaceAll("_", " ")}</option>)}</select></label> : null}
    {open ? <Suspense fallback={<p>Opening committee record controls…</p>}><HumanControlDesk groups={["committee-records"]} context={{ dealId: workspace.case.dealId, investmentCaseId: workspace.case.investmentCaseId, committeeConfigVersionId: workspace.committee.config.id, expectedVersion: workspace.case.version, expectedCaseVersion: workspace.case.version, expectedVoteSetVersion: workspace.case.voteSetVersion, expectedQuestionVersion: question?.version, expectedConditionVersion: condition?.version, recommendationId: workspace.case.currentRecommendationId, memoId: workspace.case.currentMemoId, underwritingRunId: workspace.case.primaryUnderwritingRunId, decisionProposalId: workspace.decisionProposal?.id }} paths={{ id: workspace.case.id, ...(question ? { questionId: question.id } : {}), ...(condition ? { conditionId: condition.id } : {}) }} writable={writable} eligibility={(form) => {
      const suffix = form.routePattern.replace("private-equity/ic/cases/:id/", "")
      const key = controls[suffix]
      return key && workspace.controls[key] === false ? workspace.controlBlockers[key]?.length ? workspace.controlBlockers[key] : ["Current case does not permit this operation"] : []
    }} onRecorded={onRecorded} /></Suspense> : null}
  </details>
}
