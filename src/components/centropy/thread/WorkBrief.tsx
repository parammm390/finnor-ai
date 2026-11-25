"use client"

import { ArrowRight, CircleCheck, CircleAlert, Clock3 } from "lucide-react"
import type { WorkAggregateView } from "../product/contracts"
import type { CanvasBlock } from "../canvas/canvas-contract"

type WorkExecution = Extract<CanvasBlock, { type: "work_execution" }>

export function WorkBrief({ work, execution, current, onOpen, onReview }: {
  work: WorkAggregateView
  execution: WorkExecution | undefined
  current: boolean
  onOpen: () => void
  onReview: () => void
}) {
  const decisions = work.actions.filter(action => ["pending", "needs_human_review"].includes(action.status)).length
  const recovery = ["failed", "recovery"].includes(work.work.status)
  const blocked = recovery || work.work.status === "blocked" || work.actions.some(action => action.status === "blocked_integration_unavailable")
  const verified = execution?.payload.stages.find(stage => stage.id === "outcome")?.state === "verified"
  const outcome = execution?.payload.finalOutcome ?? execution?.payload.stages.find(stage => stage.id === "outcome")?.detail
  const nextStep = work.objectiveLoop?.nextStep
  const label = !current ? "Last recorded state" : decisions ? "Decision needed" : blocked ? "Work needs attention" : work.read?.complete !== true ? "Partial Work record" : verified ? "Verified outcome" : work.work.status === "completed" ? "Result recorded" : work.work.status.replaceAll("_", " ")

  return <section className="ct-work-brief" aria-label="Current Work" data-attention={Boolean(decisions || blocked)}>
    <div className="ct-work-brief__heading">
      <span>{decisions || blocked ? <CircleAlert size={16} aria-hidden /> : current && verified ? <CircleCheck size={16} aria-hidden /> : <Clock3 size={16} aria-hidden />}{label}</span>
      <button type="button" onClick={onOpen}>Work &amp; evidence <ArrowRight size={14} aria-hidden /></button>
    </div>
    <strong>{work.work.initialInstruction}</strong>
    <p>{!current ? "This is the last recorded state, not a fresh confirmation." : decisions ? `${decisions} action${decisions === 1 ? " requires" : "s require"} review. Nothing is approved by opening this view.` : outcome ?? "No final outcome is recorded yet."}</p>
    {current && nextStep && !decisions ? <p><b>Next step:</b> {nextStep}</p> : null}
    {decisions || blocked ? <button className="ct-work-brief__review" type="button" onClick={onReview}>{decisions ? "Review decisions" : recovery ? "Review recovery" : "Review blocker"}<ArrowRight size={14} aria-hidden /></button> : null}
    {work.read?.complete !== true ? <small>Partial Work record. More actions or evidence may exist.</small> : null}
  </section>
}
