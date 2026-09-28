"use client"

import { useEffect, useState } from "react"
import { ArrowRight, RefreshCw } from "lucide-react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { IcWorkspace } from "@/components/centropy/product/contracts"

const UUID = z.string().uuid()
const CaseSchema = z.object({ id: UUID, dealId: UUID, investmentCaseId: UUID, state: z.string(), version: z.number().int(), reconsidersDecisionId: UUID.nullable().optional() }).passthrough()
const ListSchema = z.object({ cases: z.array(CaseSchema), complete: z.literal(true) })
const OpenedSchema = z.object({ row: CaseSchema, idempotent: z.boolean() }).passthrough()
const ACTIVE_STATES = new Set(["DRAFT", "PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE"])

type Review = { previousCaseId: string; previousVersion: number; decisionId: string; configId: string; runId: string | null; idempotencyKey: string }

export function IcCaseContinuation({ workspace, onSelectCase }: { workspace: IcWorkspace; onSelectCase: (id: string) => void }) {
  const [cases, setCases] = useState<z.infer<typeof CaseSchema>[]>([])
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState("")
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const decisionId = typeof workspace.decision?.id === "string" && UUID.safeParse(workspace.decision.id).success ? workspace.decision.id : null
  const configId = typeof workspace.committee.config.id === "string" && UUID.safeParse(workspace.committee.config.id).success ? workspace.committee.config.id : null
  const alternatives = cases.filter((item) => item.id !== workspace.case.id && item.dealId === workspace.case.dealId && item.investmentCaseId === workspace.case.investmentCaseId && ACTIVE_STATES.has(item.state))
  const selected = alternatives.find((item) => item.id === chosen) ?? alternatives[0] ?? null

  useEffect(() => {
    let active = true
    setLoading(true)
    void centropyGet<unknown>("private-equity/ic/cases").then((value) => {
      if (!active) return
      setCases(ListSchema.parse(value).cases)
      setError(null)
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "IC case list unavailable") })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])

  function prepare() {
    if (workspace.case.state !== "DECIDED" || !decisionId || !configId || busy || uncertain) return
    setReview({ previousCaseId: workspace.case.id, previousVersion: workspace.case.version, decisionId, configId, runId: workspace.case.primaryUnderwritingRunId, idempotencyKey: crypto.randomUUID() })
    setNotice(null)
  }

  async function open() {
    if (!review || busy || uncertain) return
    setBusy(true)
    setNotice(null)
    try {
      const fresh = await centropyGet<IcWorkspace>(`private-equity/ic/cases/${review.previousCaseId}`)
      if (fresh.case.id !== review.previousCaseId || fresh.case.version !== review.previousVersion || fresh.case.state !== "DECIDED" || fresh.decision?.id !== review.decisionId || fresh.committee.config.id !== review.configId || fresh.case.primaryUnderwritingRunId !== review.runId) throw new Error("The recorded case basis changed. Refresh and review again.")
      const opened = OpenedSchema.parse(await centropyPost<unknown>("private-equity/ic/cases", {
        dealId: fresh.case.dealId, investmentCaseId: fresh.case.investmentCaseId,
        committeeConfigVersionId: review.configId, reconsidersDecisionId: review.decisionId,
        ...(review.runId ? { primaryUnderwritingRunId: review.runId } : {}), idempotencyKey: review.idempotencyKey,
      }))
      const next = await centropyGet<IcWorkspace>(`private-equity/ic/cases/${opened.row.id}`)
      if (next.case.id !== opened.row.id || next.case.dealId !== fresh.case.dealId || next.case.investmentCaseId !== fresh.case.investmentCaseId || next.case.reconsidersDecisionId !== review.decisionId) throw new Error("The new case readback did not match the reviewed Deal, Investment Case, and prior Decision.")
      setNotice(`New IC review verified · ${opened.row.id}`)
      setReview(null)
      onSelectCase(opened.row.id)
    } catch (cause) {
      setUncertain(true)
      setNotice(`${cause instanceof Error ? cause.message : "IC case opening could not be verified"} Refresh the case list before another opening attempt.`)
    } finally { setBusy(false) }
  }

  if (workspace.case.state !== "DECIDED" && !alternatives.length && !loading && !error) return null
  return <section className="ct-ic-continuation" aria-label="Select IC review case">
    <header><span className="ct-eyebrow">IC CASE CONTINUITY</span><strong>{workspace.case.state === "DECIDED" ? "Recorded decision preserved" : "Choose active review"}</strong></header>
    <p>The selected case is {workspace.case.state.replaceAll("_", " ").toLowerCase()}. A new deck needs its own active IC basis; the recorded decision and its pinned versions stay intact.</p>
    {loading ? <p role="status">Reading IC cases…</p> : error ? <p role="alert">{error}</p> : alternatives.length ? <div className="ct-ic-continuation__choose"><label>Active case<select value={selected?.id ?? ""} onChange={(event) => setChosen(event.target.value)}>{alternatives.map((item) => <option key={item.id} value={item.id}>{item.state.replaceAll("_", " ")} · {item.id.slice(0, 8)}</option>)}</select></label><button type="button" disabled={!selected} onClick={() => selected && onSelectCase(selected.id)}>Open case <ArrowRight size={14} /></button></div> : null}
    {workspace.case.state === "DECIDED" ? !decisionId || !configId ? <p role="status">The exact prior Decision or committee configuration is unavailable. A new case cannot be grounded from this view.</p> : !review ? <button type="button" disabled={busy || uncertain} onClick={prepare}>Review new IC case <ArrowRight size={14} /></button> : <div className="ct-ic-continuation__review"><strong>Open a reconsideration case</strong><dl><div><dt>Deal</dt><dd>{workspace.case.dealId}</dd></div><div><dt>Investment Case</dt><dd>{workspace.case.investmentCaseId}</dd></div><div><dt>Prior decision</dt><dd>{review.decisionId}</dd></div><div><dt>Committee policy</dt><dd>{review.configId}</dd></div><div><dt>Underwriting run</dt><dd>{review.runId ?? "None selected"}</dd></div></dl><p>This creates a separate DRAFT case under the current policy configuration. It does not change the prior decision.</p><div><button type="button" disabled={busy} onClick={() => setReview(null)}>Back</button><button type="button" disabled={busy} onClick={() => void open()}>{busy ? "Opening…" : "Open new review"}</button></div></div> : null}
    {notice ? <p role={uncertain ? "alert" : "status"}>{notice}</p> : null}
    <button type="button" className="ct-ic-continuation__reload" disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={13} /> Refresh case list</button>
  </section>
}
