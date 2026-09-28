"use client"

import { useEffect, useState } from "react"
import { ArrowRight, RefreshCw, ShieldCheck } from "lucide-react"
import { centropyGet } from "@/components/centropy/lib/api"
import type { WorkAggregateView } from "@/components/centropy/product/contracts"
import { CausalReplayPanel } from "../canvas/CausalReplayPanel"
import { PendingEffects } from "../thread/PendingEffects"
import { HumanControlDesk } from "../controls/HumanControlDesk"

const label = (value: string) => value.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const displayValue = (value: string | boolean | number) => typeof value !== "string" ? String(value)
  : /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString()
    : /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value) ? label(value) : value
function summary(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  const data = record(value)
  if (!data) return null
  for (const key of ["summary", "message", "reason", "outcome", "result"]) {
    if (typeof data[key] === "string" && data[key].trim()) return data[key].trim().slice(0, 300)
  }
  const fields = Object.entries(data).filter(([key, entry]) => !/id$|hash$|ref/i.test(key) && (typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number"))
  return fields.length ? fields.slice(0, 4).map(([key, entry]) => `${label(key)}: ${displayValue(entry as string | boolean | number)}`).join(" · ") : null
}

export function WorldWorkRecord({ workId, onChanged }: { workId: string; onChanged: () => void }) {
  const [aggregate, setAggregate] = useState<WorkAggregateView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [replay, setReplay] = useState(false)

  useEffect(() => {
    let active = true
    setAggregate(null); setError(null); setLoading(true)
    void centropyGet<{ work: WorkAggregateView }>(`works/${workId}`).then((result) => {
      if (!result.work || result.work.work?.id !== workId || !Array.isArray(result.work.actions) || !Array.isArray(result.work.businessEffects) || !Array.isArray(result.work.receipts)) {
        throw new Error("The Work record did not match the selected WORLD object")
      }
      if (active) setAggregate(result.work)
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Work record unavailable") })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [workId, revision])

  if (replay) return <CausalReplayPanel workId={workId} onClose={() => setReplay(false)} returnLabel="Work record" />
  const finalized = aggregate?.receipts.filter((item) => Boolean(item.finalizedAt)) ?? []
  const verified = aggregate?.businessEffects.filter((item) => item.status === "verified") ?? []
  return <div className="ct-world__detail-content ct-world-work">
    <div className="ct-world-work__top"><p>Durable Work execution, observed effects, and receipts for this exact WORLD record.</p><button type="button" aria-label="Refresh Work record" onClick={() => setRevision((value) => value + 1)} disabled={loading}><RefreshCw size={15} /></button></div>
    {loading ? <p role="status">Reading the exact Work record…</p> : null}
    {error ? <p className="ct-world__error" role="alert">{error} <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button></p> : null}
    {aggregate ? <>
      <div className="ct-world-work__metrics"><div><span>Work</span><strong>{label(aggregate.work.status)}</strong></div><div><span>Verified effects</span><strong>{verified.length} / {aggregate.businessEffects.length}</strong></div><div><span>Finalized receipts</span><strong>{finalized.length} / {aggregate.receipts.length}</strong></div></div>
      <p className="ct-world-work__objective">{aggregate.work.initialInstruction}</p>
      {summary(aggregate.work.finalOutcome) ? <p className="ct-world-work__outcome"><ShieldCheck size={16} /> {summary(aggregate.work.finalOutcome)}</p> : null}
      {aggregate.read?.complete === false ? <p className="ct-world-work__caveat">This bounded Work read is incomplete. The counts below cover only returned rows.</p> : null}
      <div className="ct-world-work__section"><h4>Recorded actions and verification</h4>{aggregate.actions.map((action) => {
        const effects = aggregate.businessEffects.filter((item) => item.domainActionId === action.id)
        const receipts = aggregate.receipts.filter((item) => item.domainActionId === action.id)
        return <article key={action.id}><div className="ct-world-work__action-head"><strong>{label(action.actionType)}</strong><span>{label(action.status)}</span></div><p>{action.summary?.trim() || summary(action.groundedPayload) || "No display summary in the grounded action."}</p>{effects.map((effect) => <div key={effect.id} className="ct-world-work__proof" data-state={effect.status}><span>Observed business effect · {label(effect.status)}</span><p>{summary(effect.observedResult) ?? "No display summary recorded."}</p><small>Exact effect hash · {effect.semanticHash}</small>{summary(effect.verification) ? <small>Verification · {summary(effect.verification)}</small> : null}</div>)}{receipts.map((receipt) => <div key={receipt.id} className="ct-world-work__proof" data-state={receipt.finalizedAt ? "finalized" : "pending"}><span>Decision receipt · {receipt.finalizedAt ? "finalized" : "awaiting finalization"}</span><p>{summary(receipt.actualResult) ?? "No actual result recorded."}</p>{receipt.finalizedAt ? <time dateTime={receipt.finalizedAt}>Finalized {new Date(receipt.finalizedAt).toLocaleString()}</time> : null}<small>Receipt ID · {receipt.id}</small>{summary(receipt.failure) ? <small>Failure · {summary(receipt.failure)}</small> : null}</div>)}{!effects.length && !receipts.length ? <p>No business effect or decision receipt is linked to this action.</p> : null}</article>
      })}{!aggregate.actions.length ? <p>No Work actions are recorded. This may be a read-only Work.</p> : null}</div>
      {aggregate.actions.some((item) => item.status === "pending" || item.status === "needs_human_review") ? <PendingEffects aggregate={aggregate} current={aggregate.read?.complete !== false} refreshKey={String(revision)} onChanged={() => { setRevision((value) => value + 1); onChanged() }} /> : null}
      {aggregate.businessEffects.some((item) => !item.domainActionId) || aggregate.receipts.some((item) => !item.domainActionId) ? <p className="ct-world-work__caveat">Some effects or receipts are outside the action links returned in this Work record. Inspect causal replay for declared relationships and gaps.</p> : null}
      <button type="button" className="ct-world-work__replay" onClick={() => setReplay(true)}>Open causal replay <ArrowRight size={15} /></button>
      <details className="ct-record-controls"><summary>Review Work responsibility</summary><HumanControlDesk groups={["work-controls"]} paths={{ id: workId }} writable={aggregate.read?.complete !== false} onRecorded={() => { setRevision((value) => value + 1); onChanged() }} /></details>
      <details className="ct-record-controls"><summary>Correct a recorded answer</summary><p>Your correction is linked to the exact recorded receipt. It is a human correction, not provider evidence.</p><HumanControlDesk groups={["memory-corrections"]} context={{ receiptId: finalized.at(-1)?.id }} writable={aggregate.read?.complete !== false && finalized.length > 0} onRecorded={onChanged} /></details>
      <details className="ct-record-controls"><summary>Review execution recovery controls</summary><p>Use the exact run, step, or reconciliation case reference from the recorded failure. Resolving an uncertain effect requires supporting evidence.</p><HumanControlDesk groups={["workflow-controls", "reconciliation-controls", "computer-controls"]} writable={aggregate.read?.complete !== false} onRecorded={() => { setRevision((value) => value + 1); onChanged() }} /></details>
    </> : null}
  </div>
}
