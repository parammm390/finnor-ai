"use client"

import { useState } from "react"
import { z } from "zod"
import { centropyPost } from "@/components/centropy/lib/api"

const UUID = z.string().uuid()
const DraftSchema = z.object({ draftKey: z.string().min(1), versionId: UUID })
const PatchSchema = z.union([z.object({ version: z.object({ id: UUID }) }), z.object({ versionId: UUID })])

export type EditableSlideText = { id: string; hash: string; kind: "shape" | "tableCell"; text: string; name: string }
type ReviewedChange = { baseVersionId: string; anchor: string; expectedHash: string; kind: EditableSlideText["kind"]; name: string; before: string; after: string }
type Draft = z.infer<typeof DraftSchema>

export function ArtifactPresentationEditor({ documentId, versionId, pinnedVersionId, slideLabel, textNodes, onVersionCreated }: {
  documentId: string
  versionId: string
  pinnedVersionId?: string
  slideLabel: string
  textNodes: EditableSlideText[]
  onVersionCreated: (versionId: string) => void
}) {
  const [anchor, setAnchor] = useState(textNodes[0]?.id ?? "")
  const selected = textNodes.find((node) => node.id === anchor) ?? null
  const [replacement, setReplacement] = useState(selected?.text ?? "")
  const [reviewed, setReviewed] = useState<ReviewedChange | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function chooseText(nextAnchor: string) {
    const next = textNodes.find((node) => node.id === nextAnchor)
    setAnchor(nextAnchor)
    setReplacement(next?.text ?? "")
    setReviewed(null)
    setDraft(null)
    setError(null)
  }

  function review() {
    if (!selected || !replacement.trim() || replacement === selected.text || replacement.length > 100_000) return
    setReviewed({ baseVersionId: versionId, anchor: selected.id, expectedHash: selected.hash, kind: selected.kind, name: selected.name, before: selected.text, after: replacement })
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
        if (exactDraft.versionId !== reviewed.baseVersionId) throw new Error("The draft points to a different base version.")
        setDraft(exactDraft)
      }
      const result = PatchSchema.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/patches`, {
        baseVersionId: reviewed.baseVersionId,
        draftKey: exactDraft.draftKey,
        operations: [{ type: reviewed.kind === "tableCell" ? "replace_table_cell" : "replace_text", anchor: reviewed.anchor, expectedHash: reviewed.expectedHash, text: reviewed.after }],
      }))
      const nextVersionId = "version" in result ? result.version.id : result.versionId
      if (nextVersionId === reviewed.baseVersionId) throw new Error("The patch returned the unchanged base version.")
      onVersionCreated(nextVersionId)
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Slide edit unavailable"} ${exactDraft ? "Retry uses the same draft and exact patch." : "Check recorded versions before starting another edit if the draft result is uncertain."}`)
    } finally {
      setBusy(false)
    }
  }

  return <section className="ct-artifact__section ct-artifact__editor" aria-label="Versioned presentation editor">
    <span className="ct-eyebrow">ARTIFACT OS / PRESENTATION DRAFT</span>
    <h3>Edit {slideLabel.toLowerCase()}</h3>
    <p>Each edit creates a new exact deck version. {pinnedVersionId ? `The IC case remains pinned to ${pinnedVersionId}.` : "This draft is not pinned to an IC decision."}</p>
    {textNodes.length ? <>
      <label>Text or table cell
        <select value={anchor} disabled={busy || !!reviewed} onChange={(event) => chooseText(event.target.value)}>
          {textNodes.map((node, index) => <option key={node.id} value={node.id}>{index + 1}. {node.name} · {node.text.replace(/\s+/g, " ").slice(0, 60)}</option>)}
        </select>
      </label>
      {selected && !reviewed ? <>
        <label>Replacement text<textarea value={replacement} disabled={busy} maxLength={100_000} onChange={(event) => setReplacement(event.target.value)} rows={5} /></label>
        <div className="ct-artifact__editor-actions"><button type="button" disabled={!replacement.trim() || replacement === selected.text || busy} onClick={review}>Review exact slide change</button></div>
      </> : null}
      {reviewed ? <div className="ct-artifact__edit-review">
        <p><strong>Source version</strong> {reviewed.baseVersionId}</p>
        <p><strong>Slide anchor</strong> {reviewed.anchor}</p>
        <p><strong>Anchor hash</strong> {reviewed.expectedHash}</p>
        <div><strong>Recorded text · {reviewed.name}</strong><p>{reviewed.before}</p></div>
        <div><strong>New draft text</strong><p>{reviewed.after}</p></div>
        <div className="ct-artifact__editor-actions"><button type="button" disabled={busy || !!draft} onClick={() => { setReviewed(null); setError(null) }}>Back to edit</button><button type="button" disabled={busy} onClick={() => void apply()}>{busy ? "Saving exact draft…" : draft ? "Retry exact patch" : "Create deck version"}</button></div>
      </div> : null}
      {error ? <p role="alert" className="ct-artifact__error-text">{error}</p> : null}
    </> : <p>No editable text shape or table cell is present in this slide’s loaded semantic page.</p>}
  </section>
}
