"use client"

import { useRef, useState } from "react"
import { AlertTriangle, ArrowRight, RotateCcw } from "lucide-react"
import { centropyPost } from "@/components/centropy/lib/api"
import type { WorkAggregateView } from "@/components/centropy/product/contracts"

function summary(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300)
  if (!value || typeof value !== "object" || Array.isArray(value)) return "The backend recorded a failure without a display summary."
  const record = value as Record<string, unknown>
  for (const key of ["message", "reason", "summary", "failureCode", "code"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim().slice(0, 300)
  }
  return "The backend recorded structured failure details."
}

const REJECTION_LABELS: Record<string, string> = {
  CANDIDATE_SCHEMA_INVALID: "The proposed plan did not match the plan format",
  PAYLOAD_SCHEMA_INVALID: "An action did not match its registered input format",
  UNGROUNDED_REFERENCE: "An action referenced an unverified record",
  COMPLETION_COVERAGE_MISSING: "The plan did not cover every completion check",
  AUTHORITY_DENIED: "Current authority did not permit a proposed action",
  INTEGRATION_UNAVAILABLE: "A required capability was unavailable",
  STALE_GROUNDING: "A referenced record was no longer current",
}

function latestPlannerRejection(aggregate: WorkAggregateView): { attempt: number; issues: string[] } | null {
  const attempt = [...(aggregate.plannerAttempts ?? [])]
    .filter((item) => item.status === "failed" || item.status === "timed_out")
    .sort((left, right) => right.attempt - left.attempt)[0]
  if (!attempt || !attempt.compilationResult || typeof attempt.compilationResult !== "object") return null
  const candidates = (attempt.compilationResult as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates)) return null
  const codes = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return []
    const violations = (candidate as { violations?: unknown }).violations
    if (!Array.isArray(violations)) return []
    return violations.flatMap((violation) => {
      if (!violation || typeof violation !== "object") return []
      const code = (violation as { code?: unknown }).code
      return typeof code === "string" && Object.hasOwn(REJECTION_LABELS, code) ? [code] : []
    })
  })
  const issues = [...new Set(codes)].slice(0, 4).map((code) => REJECTION_LABELS[code]!)
  return issues.length ? { attempt: attempt.attempt, issues } : null
}

export function WorkRecovery({ aggregate, current, onChanged }: { aggregate: WorkAggregateView; current: boolean; onChanged: () => void }) {
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attemptKey = useRef<string | null>(null)
  const lock = useRef(false)
  const work = aggregate.work
  if (work.status !== "failed" && work.status !== "recovery") return null
  const plannerRejection = latestPlannerRejection(aggregate)

  async function retry() {
    if (!current || work.status !== "failed" || lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    if (!attemptKey.current) attemptKey.current = crypto.randomUUID()
    try {
      const result = await centropyPost<{ workId?: string; recovery?: boolean; duplicate?: boolean; work?: WorkAggregateView }>(`works/${work.id}/retry`, { idempotencyKey: attemptKey.current })
      if (result.workId && result.workId !== work.id) throw new Error("The retry response identified a different Work.")
      if (result.work?.work.id && result.work.work.id !== work.id) throw new Error("The retry response returned a different Work.")
      if (!result.recovery && !result.duplicate) throw new Error("The retry response did not confirm a recovery claim.")
      setNotice(result.duplicate ? "An earlier retry request owns this Work. Refreshing its recorded state." : "Retry request accepted. Refreshing the recorded Work state and execution trace.")
      setReviewing(false)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The retry request could not be confirmed.")
      onChanged()
    } finally { setBusy(false); lock.current = false }
  }

  return <section className="ct-recovery" aria-label="Work recovery" data-state={work.status}>
    <header><span><AlertTriangle size={16} /> {work.status === "recovery" ? "RECOVERY IN PROGRESS" : "WORK NEEDS RECOVERY"}</span><strong>{work.status.replaceAll("_", " ")}</strong></header>
    <p>{summary(work.failure)}</p>
    {plannerRejection ? <div className="ct-recovery__diagnosis"><strong>Planner rejection · attempt {plannerRejection.attempt}</strong><ul>{plannerRejection.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul><small>The proposed plan was rejected before its actions could run. Review the Work trace and current records before retrying.</small></div> : null}
    <div className="ct-recovery__record"><span>{aggregate.planRevisions.length} plan revision{aggregate.planRevisions.length === 1 ? "" : "s"}</span><span>{aggregate.actions.length} recorded action{aggregate.actions.length === 1 ? "" : "s"}</span><span>{aggregate.businessEffects.length} business effect{aggregate.businessEffects.length === 1 ? "" : "s"}</span><span>{aggregate.receipts.filter((receipt) => receipt.finalizedAt).length} finalized receipt{aggregate.receipts.filter((receipt) => receipt.finalizedAt).length === 1 ? "" : "s"}</span></div>
    {work.status === "recovery" ? <small>The backend holds a retry claim. This Work will update when its planner attempt advances.</small> : reviewing ? <div className="ct-recovery__review"><strong>Retry this exact Work?</strong><p>The backend will re-enter planning with its latest durable input. Recorded actions, effects, and receipts remain available for inspection. The new attempt can reach governed effects.</p><div><button type="button" onClick={() => setReviewing(false)} disabled={busy}>Cancel</button><button type="button" onClick={() => void retry()} disabled={!current || busy}><RotateCcw size={14} /> {busy ? "Requesting retry…" : "Retry Work"}</button></div></div> : <button type="button" onClick={() => setReviewing(true)} disabled={!current || Boolean(notice)}>Review retry <ArrowRight size={14} /></button>}
    {!current ? <p className="ct-recovery__error">The Work source is not current. Refresh Canvas before retrying.</p> : null}
    {notice ? <p role="status" className="ct-recovery__notice">{notice}</p> : null}
    {error ? <p role="alert" className="ct-recovery__error">{error}</p> : null}
  </section>
}
