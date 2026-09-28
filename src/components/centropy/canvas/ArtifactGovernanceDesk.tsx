"use client"

import { useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"

const UUID = z.string().uuid()
const RecordedRow = z.object({ id: UUID, version_id: UUID }).passthrough()
const RecordedRows = z.array(RecordedRow)
const reviewStates = ["requested", "changes_requested", "approved"] as const
type ReviewState = (typeof reviewStates)[number]
type Anchor = { id: string; hash: string; kind: string; data: Record<string, unknown> }
type CommentIntent = { versionId: string; anchorId: string; anchorHash: string; anchorLabel: string; body: string }
type ReviewIntent = { versionId: string; state: ReviewState }

function anchorLabel(node: Anchor): string {
  const description = [node.data.text, node.data.address, node.data.name].find((value) => typeof value === "string")
  return `${node.kind} · ${typeof description === "string" ? description.replace(/\s+/g, " ").slice(0, 70) : node.id.slice(0, 80)}`
}

export function ArtifactGovernanceDesk({ documentId, versionId, pinnedVersionId, anchors, commentCount, reviewCount, onRecorded }: {
  documentId: string
  versionId: string
  pinnedVersionId?: string
  anchors: Anchor[]
  commentCount: number
  reviewCount: number
  onRecorded: () => void
}) {
  // Semantic runs and their containing paragraphs can share an anchor ID.
  // Keep the selected node position so its exact kind/hash survives selection.
  const [anchorIndex, setAnchorIndex] = useState(0)
  const [body, setBody] = useState("")
  const [commentIntent, setCommentIntent] = useState<CommentIntent | null>(null)
  const [reviewState, setReviewState] = useState<ReviewState>("requested")
  const [reviewIntent, setReviewIntent] = useState<ReviewIntent | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const selected = anchors[anchorIndex] ?? null

  function prepareComment() {
    if (!selected || !body.trim() || body.length > 10_000 || busy) return
    setCommentIntent({ versionId, anchorId: selected.id, anchorHash: selected.hash, anchorLabel: anchorLabel(selected), body: body.trim() })
    setReviewIntent(null)
    setMessage(null)
  }

  function prepareReview() {
    if (busy) return
    setReviewIntent({ versionId, state: reviewState })
    setCommentIntent(null)
    setMessage(null)
  }

  async function recordComment() {
    if (!commentIntent || busy || uncertain || commentIntent.versionId !== versionId || selected?.id !== commentIntent.anchorId || selected.hash !== commentIntent.anchorHash) return
    setBusy(true)
    setMessage(null)
    try {
      const row = RecordedRow.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/comments`, {
        versionId: commentIntent.versionId,
        anchorId: commentIntent.anchorId,
        anchorHash: commentIntent.anchorHash,
        body: commentIntent.body,
      }))
      if (row.version_id !== versionId) throw new Error("The recorded comment belongs to another version.")
      const rows = RecordedRows.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/comments`, { versionId }))
      if (!rows.some((item) => item.id === row.id && item.version_id === versionId)) throw new Error("The new comment was not present in the exact-version readback.")
      onRecorded()
    } catch (cause) {
      setUncertain(true)
      setMessage(`${cause instanceof Error ? cause.message : "Comment status unavailable"} Refresh the recorded history before deciding whether to submit again.`)
    } finally {
      setBusy(false)
    }
  }

  async function recordReview() {
    if (!reviewIntent || busy || uncertain || reviewIntent.versionId !== versionId) return
    setBusy(true)
    setMessage(null)
    try {
      const row = RecordedRow.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/reviews`, reviewIntent))
      if (row.version_id !== versionId || row.state !== reviewIntent.state) throw new Error("The recorded review does not match the reviewed version and state.")
      const rows = RecordedRows.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/reviews`, { versionId }))
      if (!rows.some((item) => item.id === row.id && item.version_id === versionId)) throw new Error("The new review was not present in the exact-version readback.")
      onRecorded()
    } catch (cause) {
      setUncertain(true)
      setMessage(`${cause instanceof Error ? cause.message : "Review status unavailable"} Refresh the recorded history before deciding whether to submit again.`)
    } finally {
      setBusy(false)
    }
  }

  return <section className="ct-artifact__section ct-artifact__governance-desk">
    <span className="ct-eyebrow">ARTIFACT OS / RECORDED GOVERNANCE</span>
    <h3>Comment and review this version</h3>
    <p>These records belong to version {versionId}. {pinnedVersionId ? `They do not change the IC pin, which remains ${pinnedVersionId}.` : "This draft is not pinned to an IC decision."}</p>
    <div className="ct-artifact__governance-forms">
      <div>
        <h4>Anchored comment</h4>
        {commentCount >= 200 ? <p>The recorded comment list has reached its 200-row read limit. Additional comments cannot be verified here.</p> : anchors.length ? <>
          <label>Exact semantic anchor<select value={anchorIndex} disabled={busy || uncertain || !!commentIntent} onChange={(event) => setAnchorIndex(Number(event.target.value))}>{anchors.map((anchor, index) => <option key={`${anchor.kind}:${anchor.id}:${index}`} value={index}>{anchorLabel(anchor)}</option>)}</select></label>
          <label>Comment<textarea value={body} disabled={busy || uncertain || !!commentIntent} maxLength={10_000} rows={4} onChange={(event) => setBody(event.target.value)} /></label>
          {!commentIntent ? <button type="button" disabled={!body.trim() || busy || uncertain} onClick={prepareComment}>Review comment</button> : <div className="ct-artifact__governance-review"><strong>Exact version and anchor</strong><p>{commentIntent.versionId}</p><p>{commentIntent.anchorLabel}</p><p>{commentIntent.body}</p><div><button type="button" disabled={busy || uncertain} onClick={() => setCommentIntent(null)}>Edit</button><button type="button" disabled={busy || uncertain} onClick={() => void recordComment()}>{busy ? "Recording…" : "Record comment"}</button></div></div>}
        </> : <p>No semantic anchor is present in the loaded page.</p>}
      </div>
      <div>
        <h4>Version review</h4>
        {reviewCount >= 200 ? <p>The recorded review list has reached its 200-row read limit. Additional reviews cannot be verified here.</p> : <>
          <label>Review record<select value={reviewState} disabled={busy || uncertain || !!reviewIntent} onChange={(event) => setReviewState(event.target.value as ReviewState)}><option value="requested">Request review</option><option value="changes_requested">Request changes</option><option value="approved">Approve this artifact version</option></select></label>
          {!reviewIntent ? <button type="button" disabled={busy || uncertain} onClick={prepareReview}>Review action</button> : <div className="ct-artifact__governance-review"><strong>Exact version and action</strong><p>{reviewIntent.versionId}</p><p>{reviewIntent.state.replaceAll("_", " ")}</p><p>Artifact review is recorded separately from any Investment Committee vote or decision.</p><div><button type="button" disabled={busy || uncertain} onClick={() => setReviewIntent(null)}>Back</button><button type="button" disabled={busy || uncertain} onClick={() => void recordReview()}>{busy ? "Recording…" : "Record review"}</button></div></div>}
        </>}
      </div>
    </div>
    {message ? <p role="alert" className="ct-artifact__error-text">{message}</p> : null}
  </section>
}
