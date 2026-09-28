"use client"

import { useState } from "react"
import { z } from "zod"
import { centropyPost } from "@/components/centropy/lib/api"

const UUID = z.string().uuid()
const DraftSchema = z.object({ draftKey: z.string().min(1), versionId: UUID })
const PatchSchema = z.union([
  z.object({ version: z.object({ id: UUID }) }),
  z.object({ versionId: UUID }),
])

export type EditableParagraph = { id: string; hash: string; text: string }
type ReviewedChange = { baseVersionId: string; anchor: string; expectedHash: string; before: string; after: string }
type Draft = z.infer<typeof DraftSchema>

export function ArtifactDocumentEditor({ documentId, versionId, pinnedVersionId, paragraphs, onVersionCreated }: {
  documentId: string
  versionId: string
  pinnedVersionId?: string
  paragraphs: EditableParagraph[]
  onVersionCreated: (versionId: string) => void
}) {
  const [anchor, setAnchor] = useState(paragraphs[0]?.id ?? "")
  const selected = paragraphs.find((paragraph) => paragraph.id === anchor) ?? null
  const [replacement, setReplacement] = useState(selected?.text ?? "")
  const [reviewed, setReviewed] = useState<ReviewedChange | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function chooseParagraph(nextAnchor: string) {
    const next = paragraphs.find((paragraph) => paragraph.id === nextAnchor)
    setAnchor(nextAnchor)
    setReplacement(next?.text ?? "")
    setReviewed(null)
    setDraft(null)
    setError(null)
  }

  function review() {
    if (!selected || !replacement.trim() || replacement === selected.text || replacement.length > 100_000) return
    setReviewed({ baseVersionId: versionId, anchor: selected.id, expectedHash: selected.hash, before: selected.text, after: replacement })
    setError(null)
  }

  async function apply() {
    if (!reviewed || busy || reviewed.baseVersionId !== versionId || selected?.id !== reviewed.anchor || selected.hash !== reviewed.expectedHash) return
    setBusy(true)
    setError(null)
    let exactDraft = draft
    try {
      if (!exactDraft) {
        exactDraft = DraftSchema.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/drafts`, { baseVersionId: reviewed.baseVersionId }))
        if (exactDraft.versionId !== reviewed.baseVersionId) throw new Error("The created draft points to a different base version.")
        setDraft(exactDraft)
      }
      const result = PatchSchema.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/patches`, {
        baseVersionId: reviewed.baseVersionId,
        draftKey: exactDraft.draftKey,
        operations: [{ type: "replace_text", anchor: reviewed.anchor, expectedHash: reviewed.expectedHash, text: reviewed.after }],
      }))
      const nextVersionId = "version" in result ? result.version.id : result.versionId
      if (nextVersionId === reviewed.baseVersionId) throw new Error("The patch returned the unchanged base version.")
      onVersionCreated(nextVersionId)
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Draft edit unavailable"} ${exactDraft ? "Retry uses the same draft and exact patch." : "Check the version list before starting another edit if the draft result is uncertain."}`)
    } finally {
      setBusy(false)
    }
  }

  return <section className="ct-artifact__section ct-artifact__editor">
    <span className="ct-eyebrow">ARTIFACT OS / DOCUMENT DRAFT</span>
    <h3>Edit a paragraph</h3>
    <p>Changes create a new persisted version. {pinnedVersionId ? `The IC case remains pinned to ${pinnedVersionId}.` : "This draft is not pinned to an IC decision."}</p>
    {paragraphs.length ? <>
      <label>Paragraph
        <select value={anchor} disabled={busy || !!reviewed} onChange={(event) => chooseParagraph(event.target.value)}>
          {paragraphs.map((paragraph, index) => <option key={paragraph.id} value={paragraph.id}>{index + 1}. {paragraph.text.replace(/\s+/g, " ").slice(0, 72)}</option>)}
        </select>
      </label>
      {selected && !reviewed ? <>
        <label>Replacement text
          <textarea value={replacement} disabled={busy} maxLength={100_000} onChange={(event) => setReplacement(event.target.value)} rows={6} />
        </label>
        <div className="ct-artifact__editor-actions"><button type="button" disabled={!replacement.trim() || replacement === selected.text || busy} onClick={review}>Review exact change</button></div>
      </> : null}
      {reviewed ? <div className="ct-artifact__edit-review">
        <p><strong>Source version</strong> {reviewed.baseVersionId}</p>
        <p><strong>Paragraph anchor</strong> {reviewed.anchor}</p>
        <div><strong>Recorded text</strong><p>{reviewed.before}</p></div>
        <div><strong>New draft text</strong><p>{reviewed.after}</p></div>
        <div className="ct-artifact__editor-actions"><button type="button" disabled={busy || !!draft} onClick={() => { setReviewed(null); setError(null) }}>Back to edit</button><button type="button" disabled={busy} onClick={() => void apply()}>{busy ? "Saving exact draft…" : draft ? "Retry exact patch" : "Create draft version"}</button></div>
      </div> : null}
      {error ? <p role="alert" className="ct-artifact__error-text">{error}</p> : null}
    </> : <p>No editable paragraphs are present in the loaded semantic page.</p>}
  </section>
}
