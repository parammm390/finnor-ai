"use client"

import { useRef, useState } from "react"
import { ArrowRight, ShieldCheck } from "lucide-react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { IcWorkspace } from "@/components/centropy/product/contracts"
import { IC_VOTE_CHOICES, icVoteBasis, sameVoteBasis, type IcVoteBasis, type IcVoteChoice } from "./ic-vote-model"

const VoteResponseSchema = z.object({
  vote: z.object({ id: z.string().uuid(), icCaseId: z.string().uuid(), recommendationId: z.string().uuid(), memoId: z.string().uuid(), underwritingRunId: z.string().uuid(), votingBasisVersion: z.number().int(), choice: z.enum(IC_VOTE_CHOICES) }).passthrough(),
  case: z.object({ id: z.string().uuid() }).passthrough(),
  idempotent: z.boolean(),
}).passthrough()

type Review = { basis: IcVoteBasis; choice: IcVoteChoice; rationale: string; idempotencyKey: string }
const label = (value: string) => value.replaceAll("_", " ").toLowerCase()

export function IcVoteControl({ workspace, writable, onRefresh }: { workspace: IcWorkspace; writable: boolean; onRefresh: () => void }) {
  const [choice, setChoice] = useState<IcVoteChoice | "">("")
  const [rationale, setRationale] = useState("")
  const [reviewed, setReviewed] = useState<Review | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const { basis, reasons } = icVoteBasis(workspace)
  const currentReview = reviewed && basis && sameVoteBasis(reviewed.basis, basis) && reviewed.choice === choice && reviewed.rationale === rationale.trim() ? reviewed : null

  function reviewVote() {
    setError(null)
    setNotice(null)
    setAcknowledged(false)
    if (!basis || !writable || !choice) return
    setReviewed({ basis, choice, rationale: rationale.trim(), idempotencyKey: crypto.randomUUID() })
  }

  async function recordVote() {
    if (!currentReview || !acknowledged || !writable || lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const fresh = await centropyGet<IcWorkspace>(`private-equity/ic/cases/${currentReview.basis.caseId}`)
      if (fresh.case?.id !== currentReview.basis.caseId) throw new Error("The IC read did not return the reviewed case.")
      const next = icVoteBasis(fresh).basis
      if (!next || !sameVoteBasis(next, currentReview.basis)) throw new Error("The official voting basis or your eligibility changed. Refresh and review again.")
      const result = VoteResponseSchema.parse(await centropyPost<unknown>(`private-equity/ic/cases/${currentReview.basis.caseId}/votes`, {
        recommendationId: currentReview.basis.recommendationId, memoId: currentReview.basis.memoId,
        underwritingRunId: currentReview.basis.underwritingRunId, expectedVotingBasisVersion: currentReview.basis.votingBasisVersion,
        choice: currentReview.choice, ...(currentReview.rationale ? { rationale: currentReview.rationale } : {}), idempotencyKey: currentReview.idempotencyKey,
      }))
      if (result.case.id !== currentReview.basis.caseId || result.vote.icCaseId !== currentReview.basis.caseId || result.vote.recommendationId !== currentReview.basis.recommendationId || result.vote.memoId !== currentReview.basis.memoId || result.vote.underwritingRunId !== currentReview.basis.underwritingRunId || result.vote.votingBasisVersion !== currentReview.basis.votingBasisVersion || result.vote.choice !== currentReview.choice) throw new Error("The vote response did not match the reviewed basis. Refresh the IC case before any further action.")
      setNotice(`${result.idempotent ? "Existing" : "Official"} ${label(result.vote.choice)} vote recorded · ${result.vote.id.slice(0, 8)}. Refreshing the case.`)
      setReviewed(null)
      setAcknowledged(false)
      onRefresh()
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "The vote could not be verified."} If the request may have reached the server, refresh the case before retrying.`)
      onRefresh()
    } finally { setBusy(false); lock.current = false }
  }

  return <section className="ct-ic-vote" aria-label="Official committee vote">
    <header><span><ShieldCheck size={16} /> OFFICIAL HUMAN VOTE</span><strong>{basis ? "Eligible basis" : "Unavailable"}</strong></header>
    <p>The verified session identifies the voter. CENTROPY cannot cast a vote as an agent.</p>
    {reasons.length ? <div className="ct-ic-vote__blockers"><strong>Voting control blockers</strong><ul>{reasons.map((reason) => <li key={reason}>{reason.replaceAll("_", " ")}</li>)}</ul></div> : null}
    {basis ? <>
      <dl className="ct-ic-vote__basis"><div><dt>Recommendation</dt><dd>{basis.recommendationOutcome.replaceAll("_", " ")} · {basis.recommendationId}</dd></div><div><dt>Rationale</dt><dd>{basis.recommendationRationale}</dd></div><div><dt>Memo</dt><dd>{basis.memoId}</dd></div><div><dt>Underwriting run</dt><dd>{basis.underwritingRunId}</dd></div><div><dt>Voting basis</dt><dd>Version {basis.votingBasisVersion}</dd></div></dl>
      <label className="ct-ic-vote__field">Your choice<select value={choice} onChange={(event) => { setChoice(event.target.value as IcVoteChoice | ""); setAcknowledged(false) }}><option value="">Choose an official vote</option>{IC_VOTE_CHOICES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label className="ct-ic-vote__field">Your rationale<textarea value={rationale} maxLength={10_000} rows={3} onChange={(event) => { setRationale(event.target.value); setAcknowledged(false) }} placeholder="Optional rationale recorded with your vote" /></label>
      {!currentReview ? <button className="ct-ic-vote__primary" type="button" disabled={!writable || !choice || busy} onClick={reviewVote}>Review official vote <ArrowRight size={14} /></button> : <div className="ct-ic-vote__review"><strong>Review before recording</strong><p>You are recording {label(currentReview.choice)} on the exact recommendation, memo, underwriting run, and voting basis above. This vote becomes an immutable IC record.</p><label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I reviewed the pinned basis and this is my official vote.</label><div><button type="button" disabled={busy} onClick={() => { setReviewed(null); setAcknowledged(false) }}>Cancel</button><button type="button" disabled={!writable || !acknowledged || busy} onClick={() => void recordVote()}>{busy ? "Recording…" : "Record my vote"}</button></div></div>}
    </> : null}
    {!writable ? <p className="ct-ic-vote__error">The IC source is stale or unavailable. Refresh before voting.</p> : null}
    {notice ? <p role="status" className="ct-ic-vote__notice">{notice}</p> : null}
    {error ? <p role="alert" className="ct-ic-vote__error">{error}</p> : null}
  </section>
}
