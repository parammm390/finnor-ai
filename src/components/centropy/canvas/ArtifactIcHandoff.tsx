"use client"

import { useState } from "react"
import { ArrowRight, ShieldCheck } from "lucide-react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { IcWorkspace } from "@/components/centropy/product/contracts"
import { IcCaseContinuation } from "./IcCaseContinuation"

const UUID = z.string().uuid()
const ArtifactSchema = z.object({ documentId: UUID, version: z.object({ id: UUID }), semantic: z.object({ kind: z.string() }).passthrough() }).passthrough()
const ReviewSchema = z.object({ id: UUID, version_id: UUID, state: z.string() }).passthrough()
const ReviewsSchema = z.array(ReviewSchema)
const LinkSchema = z.object({ link: z.object({ documentId: UUID, dealId: UUID, entityId: UUID, linkRole: z.literal("governing") }).passthrough() }).passthrough()
const SelectionSchema = z.object({ memo: z.object({ id: UUID, documentId: UUID, documentVersionId: UUID, artifactRole: z.literal("DECK") }).passthrough(), case: z.object({ id: UUID, currentDeckId: UUID }).passthrough() }).passthrough()
const SELECTABLE = new Set(["DRAFT", "PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE"])
const COMPLETENESS = ["UNKNOWN", "INCOMPLETE", "CONFLICTING", "COMPLETE"] as const
type Completeness = typeof COMPLETENESS[number]
type Review = { caseId: string; caseVersion: number; dealId: string; investmentCaseId: string; documentId: string; versionId: string; reviewId: string; sourceCompleteness: Completeness; evidenceCutoffAt: string; idempotencyKey: string }
function rowField(row: Record<string, unknown>, key: string): string | null {
  const raw = row[key] ?? row[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]
  return typeof raw === "string" && raw.trim() ? raw : null
}

export function ArtifactIcHandoff({ documentId, versionId, format, reviews, bindingCount, publications, providerCreations, ic, writable, onIcRefresh, onSelectIcCase }: {
  documentId: string; versionId: string; format: string; reviews: Record<string, unknown>[]; bindingCount: number; publications: Record<string, unknown>[]; providerCreations: Record<string, unknown>[];
  ic: IcWorkspace | null; writable: boolean; onIcRefresh: () => void; onSelectIcCase?: (id: string) => void;
}) {
  const [sourceCompleteness, setSourceCompleteness] = useState<Completeness>("UNKNOWN")
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const latest = reviews.length < 200 ? ReviewSchema.safeParse(reviews.at(-1)) : null
  const approved = latest?.success && latest.data.state === "approved" && latest.data.version_id === versionId ? latest.data : null
  const selected = ic?.deck?.documentId === documentId && ic.deck.documentVersionId === versionId
  const eligible = ic && SELECTABLE.has(ic.case.state)
  const exactProviderReadback = [...publications, ...providerCreations].some((row) =>
    rowField(row, "readbackVersionId") === versionId && ["verified", "verified_provider_normalized"].includes(rowField(row, "status") ?? ""))

  function prepare() {
    if (!ic || !eligible || !writable || !approved || format !== "pptx" || busy || uncertain) return
    setReview({ caseId: ic.case.id, caseVersion: ic.case.version, dealId: ic.case.dealId, investmentCaseId: ic.case.investmentCaseId,
      documentId, versionId, reviewId: approved.id, sourceCompleteness, evidenceCutoffAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID() })
    setNotice(null)
  }

  async function select() {
    if (!review || busy || uncertain || !writable) return
    setBusy(true)
    setNotice(null)
    try {
      const fresh = await centropyGet<IcWorkspace>(`private-equity/ic/cases/${review.caseId}`)
      if (fresh.case.id !== review.caseId || fresh.case.version !== review.caseVersion || fresh.case.dealId !== review.dealId || fresh.case.investmentCaseId !== review.investmentCaseId || !SELECTABLE.has(fresh.case.state)) throw new Error("The IC basis changed. Refresh and review the exact case again.")
      const artifact = ArtifactSchema.parse(await centropyGet<unknown>(`documents/${review.documentId}/artifact`, { versionId: review.versionId }))
      if (artifact.documentId !== review.documentId || artifact.version.id !== review.versionId || artifact.semantic.kind !== "pptx") throw new Error("The exact deck version is no longer verifiable as PPTX.")
      const freshReviews = ReviewsSchema.parse(await centropyGet<unknown>(`documents/${review.documentId}/artifact/reviews`, { versionId: review.versionId }))
      if (freshReviews.length >= 200 || freshReviews.at(-1)?.id !== review.reviewId || freshReviews.at(-1)?.state !== "approved") throw new Error("The exact deck approval changed. Refresh and review again.")
      const linked = LinkSchema.parse(await centropyPost<unknown>(`private-equity/ic/cases/${review.caseId}/reviewed-deck-link`, {
        expectedCaseVersion: review.caseVersion, documentId: review.documentId, documentVersionId: review.versionId,
      }))
      if (linked.link.documentId !== review.documentId || linked.link.dealId !== review.dealId || linked.link.entityId !== review.investmentCaseId) throw new Error("The Deal-root link did not match the reviewed deck and Investment Case.")
      const selectedVersion = SelectionSchema.parse(await centropyPost<unknown>(`private-equity/ic/cases/${review.caseId}/memos`, {
        expectedCaseVersion: review.caseVersion, artifactRole: "DECK", documentId: review.documentId, documentVersionId: review.versionId,
        evidenceCutoffAt: review.evidenceCutoffAt, sourceCompleteness: review.sourceCompleteness, idempotencyKey: review.idempotencyKey,
      }))
      if (selectedVersion.case.id !== review.caseId || selectedVersion.memo.documentId !== review.documentId || selectedVersion.memo.documentVersionId !== review.versionId || selectedVersion.case.currentDeckId !== selectedVersion.memo.id) throw new Error("The selection response did not match the reviewed exact version.")
      const persisted = await centropyGet<IcWorkspace>(`private-equity/ic/cases/${review.caseId}`)
      if (persisted.deck?.id !== selectedVersion.memo.id || persisted.deck.documentId !== review.documentId || persisted.deck.documentVersionId !== review.versionId) throw new Error("The IC readback did not select this exact deck version.")
      setReview(null)
      setNotice(`Exact deck version selected into IC · ${selectedVersion.memo.id}`)
      onIcRefresh()
    } catch (cause) {
      setUncertain(true)
      setNotice(`${cause instanceof Error ? cause.message : "The IC handoff could not be verified"} A link or selection may have committed; refresh the IC case and Artifact history before another attempt.`)
      onIcRefresh()
    } finally { setBusy(false) }
  }

  return <section className="ct-artifact__section ct-artifact-ic" aria-label="Artifact to IC handoff">
    <header><div><span className="ct-eyebrow">ARTIFACT → INVESTMENT COMMITTEE</span><h3>Select an exact reviewed deck</h3></div><ShieldCheck size={20} aria-hidden="true" /></header>
    <p>Document {documentId} · version {versionId}. This version has {bindingCount} source binding{bindingCount === 1 ? "" : "s"}, {publications.length} replacement publication{publications.length === 1 ? "" : "s"}, and {providerCreations.length} provider file creation{providerCreations.length === 1 ? "" : "s"} in its recorded context.</p>
    {selected ? <p className="ct-artifact-ic__success" role="status">This exact version is selected in IC case {ic?.case.id}. {exactProviderReadback ? "A verified Microsoft provider readback matches this selected version." : "No verified provider readback matches this selected version; inspect the publication record separately."}</p> : null}
    {!ic ? <p role="status">No IC case is loaded for this Investigation. Return to the committee instrument and refresh its source.</p> : null}
    {ic && !eligible && onSelectIcCase ? <IcCaseContinuation workspace={ic} onSelectCase={onSelectIcCase} /> : null}
    {ic && eligible && !selected ? <>
      {!approved ? <p role="status">The latest recorded review for this exact version must be approved before it can be linked. Review history is {reviews.length >= 200 ? "at its verification limit" : "currently not approved"}.</p> : null}
      <label className="ct-artifact-ic__field">Source completeness recorded in IC<select value={sourceCompleteness} disabled={busy || !!review || uncertain} onChange={(event) => setSourceCompleteness(event.target.value as Completeness)}>{COMPLETENESS.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ").toLowerCase()}</option>)}</select></label>
      <p>Choose COMPLETE only after checking the deck’s source bindings and missing evidence. This selection does not publish the presentation or authorize a committee vote.</p>
      {!review ? <button type="button" disabled={!writable || !approved || format !== "pptx" || busy || uncertain} onClick={prepare}>Review exact IC selection <ArrowRight size={14} /></button> : <div className="ct-artifact-ic__review"><strong>Confirm the immutable basis</strong><dl><div><dt>IC case · version</dt><dd>{review.caseId} · {review.caseVersion}</dd></div><div><dt>Deal</dt><dd>{review.dealId}</dd></div><div><dt>Deck version</dt><dd>{review.versionId}</dd></div><div><dt>Artifact approval</dt><dd>{review.reviewId}</dd></div><div><dt>Source status</dt><dd>{review.sourceCompleteness}</dd></div><div><dt>Evidence cutoff</dt><dd>{review.evidenceCutoffAt}</dd></div></dl><p>The deck will be linked to this Deal and selected into this active IC case. Its exact version will be read back before this control reports success.</p><div><button type="button" disabled={busy} onClick={() => setReview(null)}>Back</button><button type="button" disabled={busy} onClick={() => void select()}>{busy ? "Selecting…" : "Select reviewed deck"}</button></div></div>}
    </> : null}
    {notice ? <p role={uncertain ? "alert" : "status"} className="ct-artifact-ic__notice">{notice}</p> : null}
  </section>
}
