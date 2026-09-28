"use client"

import { RecordedValue } from "./RecordedValue"

import { useEffect, useRef, useState } from "react"
import { ArrowRight, ShieldCheck } from "lucide-react"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { WorkAggregateView } from "@/components/centropy/product/contracts"
import { PendingEffectPageSchema, pendingEffectReview, type PendingEffect } from "./pending-effect-model"

type QueueState = { actions: PendingEffect[]; status: "loading" | "ready" | "error"; error: string | null; complete: boolean }
type Decision = "confirm" | "reject" | "escalate"
const humanize = (value: string) => value.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
function visibleSummary(value: unknown): string | null {
  const source = record(value)
  for (const key of ["summary", "message", "reason", "outcome", "result", "status"]) if (typeof source?.[key] === "string" && source[key].trim()) return (source[key] as string).trim().slice(0, 300)
  return null
}

async function readQueue(filter: "pending" | "blocked"): Promise<{ actions: PendingEffect[]; complete: boolean }> {
  const actions: PendingEffect[] = []
  let cursor: string | null = null
  for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
    const result = PendingEffectPageSchema.parse(await centropyGet<unknown>("actions/pending", { filter, limit: "100", ...(cursor ? { cursor } : {}) }))
    actions.push(...result.actions)
    if (!result.page.hasMore || result.page.complete) return { actions, complete: true }
    if (!result.page.nextCursor) throw new Error("The approval queue has more rows but no continuation cursor.")
    cursor = result.page.nextCursor
  }
  return { actions, complete: false }
}

export function PendingEffects({ aggregate, current, refreshKey, onChanged }: { aggregate: WorkAggregateView; current: boolean; refreshKey: string; onChanged: () => void }) {
  const [queue, setQueue] = useState<QueueState>({ actions: [], status: "loading", error: null, complete: false })
  const [reload, setReload] = useState(0)
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [note, setNote] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [settledIds, setSettledIds] = useState<Set<string>>(() => new Set())
  const writeLock = useRef(false)
  const workId = aggregate.work.id
  const unresolvedPending = aggregate.actions.some((action) =>
    (action.status === "pending" || action.status === "needs_human_review") && !settledIds.has(action.id))
  const hasPending = aggregate.actions.some((action) => action.status === "pending")
  const hasBlocked = aggregate.actions.some((action) => action.status === "needs_human_review" || action.status === "blocked_integration_unavailable")

  useEffect(() => {
    let active = true
    setQueue((previous) => ({ ...previous, status: "loading", error: null }))
    const filters: Array<"pending" | "blocked"> = [
      ...(hasPending ? ["pending" as const] : []),
      ...(hasBlocked ? ["blocked" as const] : []),
    ]
    void Promise.all(filters.map(readQueue)).then((pages) => {
      if (!active) return
      const matching = pages.flatMap((page) => page.actions).filter((action) => action.workId === workId)
      setQueue({ actions: [...new Map(matching.map((action) => [action.id, action])).values()], status: "ready", error: null, complete: pages.every((page) => page.complete) })
    }).catch((cause) => {
      if (active) setQueue((previous) => ({ ...previous, status: "error", error: cause instanceof Error ? cause.message : "Approval queue unavailable" }))
    })
    return () => { active = false }
  }, [workId, refreshKey, reload, hasPending, hasBlocked])

  function choose(actionId: string, nextDecision: Decision | null) {
    setReviewId(actionId)
    setDecision(nextDecision)
    setNote("")
    setAcknowledged(false)
  }

  async function submit(action: PendingEffect) {
    if (!decision || !current || queue.status !== "ready" || settledIds.has(action.id) || writeLock.current) return
    const review = pendingEffectReview(action, aggregate)
    if (decision === "confirm" && (!review.canConfirm || !acknowledged)) return
    if (decision === "reject" && !review.canReject) return
    if (decision === "escalate" && !review.canEscalate) return
    if (decision === "confirm" && !review.effect) return
    writeLock.current = true
    setBusy(true)
    setMessages((previous) => ({ ...previous, [action.id]: "Recording the decision…" }))
    try {
      const body = decision === "confirm" ? { note: note.trim() || undefined, typedConfirmation: true, expectedEffectHash: review.effect!.semanticHash }
        : decision === "reject" ? { reason: note.trim() || undefined } : { note: note.trim() || undefined }
      const result = await centropyPost<{ result?: { status: string; error?: string }; status?: string; idempotent?: boolean }>(`actions/${action.id}/${decision}`, body)
      const idempotentState = decision === "confirm" ? ["approved", "executing", "completed"] : decision === "reject" ? ["rejected"] : ["needs_human_review"]
      const recorded = result.result?.status === "success" || (decision === "reject" && result.status === "rejected") || (result.idempotent === true && idempotentState.includes(result.status ?? ""))
      if (!recorded) throw new Error(result.result?.error ?? "The backend did not confirm this decision.")
      setSettledIds((previous) => new Set(previous).add(action.id))
      setMessages((previous) => ({ ...previous, [action.id]: "Decision recorded. Refreshing canonical action and Work state." }))
      setDecision(null)
      setAcknowledged(false)
      setReload((value) => value + 1)
      onChanged()
    } catch (cause) { setMessages((previous) => ({ ...previous, [action.id]: cause instanceof Error ? cause.message : "The decision could not be confirmed." })) }
    finally { writeLock.current = false; setBusy(false) }
  }

  return <section className="ct-effects" aria-label="Pending governed effects">
    <header><span><ShieldCheck size={16} /> EXACT EFFECTS</span><strong>{queue.actions.length ? `${queue.actions.length} for this Work` : "Checking"}</strong></header>
    {queue.status === "loading" && !queue.actions.length ? <p role="status">Checking the governed action queue…</p> : null}
    {queue.error ? <p role="alert" className="ct-effects__error">{queue.error} <button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></p> : null}
    {queue.status === "ready" && !queue.actions.length && queue.complete && unresolvedPending ? <p role="alert" className="ct-effects__error">Work records an action at a human boundary, but the approval queue did not return its exact effect. Decisions are unavailable until the sources agree. <button type="button" onClick={() => { setReload((value) => value + 1); onChanged() }}>Refresh sources</button></p> : null}
    {queue.status === "ready" && !queue.actions.length && queue.complete && !unresolvedPending && settledIds.size > 0 ? <p role="status">Decision recorded. Refreshing the Work outcome…</p> : null}
    {!queue.complete && queue.status === "ready" ? <p className="ct-effects__caveat">The queue has more pages. This Work may have additional pending actions outside the loaded range.</p> : null}
    {queue.actions.map((action) => {
      const review = pendingEffectReview(action, aggregate)
      const open = reviewId === action.id
      const settled = settledIds.has(action.id)
      return <article key={action.id} className="ct-effects__card">
        <div className="ct-effects__card-head"><span>{humanize(action.actionType)}</span><strong>{action.summary || review.effect?.operation || "Governed action"}</strong><small>{humanize(action.status)} · {action.id.slice(0, 8)}</small></div>
        {!open ? <button type="button" onClick={() => choose(action.id, null)}>Review exact effect <ArrowRight size={14} /></button> : <>
          <div className="ct-effects__proof">
            {review.effect ? <><dl><div><dt>Operation</dt><dd>{review.effect.operation}</dd></div><div><dt>Change</dt><dd>{humanize(review.effect.change)}</dd></div><div><dt>Authority</dt><dd>{review.effect.authority ? humanize(review.effect.authority) : "Not recorded"}</dd></div><div><dt>Risk</dt><dd>{review.effect.risk ? humanize(review.effect.risk) : "Not recorded"}</dd></div><div><dt>Approval basis</dt><dd>{review.effect.approvalSummary ?? "Not recorded"}</dd></div><div><dt>Reversibility</dt><dd>{review.effect.reversibility ? humanize(review.effect.reversibility) : "Not recorded"}</dd></div><div><dt>Expected observation</dt><dd>{review.effect.expectedObservation ? humanize(review.effect.expectedObservation) : "Not recorded"}</dd></div></dl>
              <div className="ct-effects__detail"><strong>Exact targets</strong>{review.effect.targets.length ? review.effect.targets.map((target) => <p key={`${target.type}:${target.id}`}>{humanize(target.type)} · {target.id}</p>) : <p>No target recorded in the effect.</p>}</div>
              {review.effect.before.length ? <div className="ct-effects__detail"><strong>Recorded before</strong>{review.effect.before.map((item) => <p key={`${item.type}:${item.id}`}>{humanize(item.type)} · {item.id}: {item.values.map((field) => `${humanize(field.label)} ${field.value}`).join(" · ") || "No scalar values"}</p>)}</div> : null}
              <div className="ct-effects__detail"><strong>Proposed effect</strong>{review.effect.values.length ? review.effect.values.map((field) => <p key={field.label}>{humanize(field.label)} · {field.value}</p>) : <p>No scalar change fields recorded.</p>}</div>
              {review.structuredFields.map((field) => <details className="ct-effects__structured" key={field.label} open={field.label === "scenario"}><summary>Exact {humanize(field.label)} values</summary><RecordedValue serialized={field.value} /></details>)}
              {review.communication ? <div className="ct-effects__detail"><strong>Communication</strong><p>Recipient · {review.recipient ?? "Not recorded"}</p><p>Provider · {review.provider ?? "Not recorded"}</p><p>Subject · {review.subject ?? "Not recorded"}</p><p>Body · {review.body ?? "Not recorded"}</p></div> : null}
              <div className="ct-effects__detail"><strong>Prediction and policy</strong><p>Predicted result · {visibleSummary(action.predicted) ?? "No display summary recorded"}</p><p>Policy · {visibleSummary(action.receipt?.policyApplied) ?? "No display reason recorded"}</p>{action.critic?.flagged ? <p>Independent critic · {action.critic.reason}</p> : null}</div>
            </> : <p>The action has no verified compiled effect. Confirmation is unavailable.</p>}
            {!review.hashMatches ? <p className="ct-effects__error">The effect hash does not match this Work’s frozen effect record. Refresh before any decision.</p> : null}
            {review.missingCommunication ? <p className="ct-effects__error">The exact recipient, {review.requiresSubject ? "subject, " : ""}or message body is absent. Confirmation is unavailable.</p> : null}
          </div>
          {decision ? <div className="ct-effects__decision"><strong>{decision === "confirm" ? "Confirm and release this exact effect" : decision === "reject" ? "Reject this action" : "Escalate this action"}</strong><textarea value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} placeholder={decision === "reject" ? "Reason for rejection" : decision === "escalate" ? "Reason for escalation" : "Decision note (optional)"} />{decision === "confirm" ? <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I reviewed the exact effect, authority, and expected observation.</label> : null}<div><button type="button" onClick={() => setDecision(null)} disabled={busy}>Cancel</button><button type="button" onClick={() => void submit(action)} disabled={busy || !current || queue.status !== "ready" || settled || (decision === "confirm" && (!review.canConfirm || !acknowledged)) || (decision === "reject" && !review.canReject) || (decision === "escalate" && !review.canEscalate)}>{busy ? "Recording…" : decision === "confirm" ? "Confirm effect" : decision === "reject" ? "Confirm rejection" : "Confirm escalation"}</button></div></div> : <div className="ct-effects__actions"><button type="button" disabled={!current || queue.status !== "ready" || settled || !review.canConfirm} onClick={() => choose(action.id, "confirm")}>Confirm</button><button type="button" disabled={!current || queue.status !== "ready" || settled || !review.canReject} onClick={() => choose(action.id, "reject")}>Reject</button><button type="button" disabled={!current || queue.status !== "ready" || settled || !review.canEscalate} onClick={() => choose(action.id, "escalate")}>Escalate</button></div>}
          <button type="button" className="ct-effects__close" onClick={() => { setReviewId(null); setDecision(null) }}>Close details</button>
        </>}
        {messages[action.id] ? <p role="status" className="ct-effects__message">{messages[action.id]}</p> : null}
      </article>
    })}
    {!current && unresolvedPending ? <p className="ct-effects__error">Work data is stale. Refresh the source before deciding.</p> : null}
  </section>
}
