"use client"

import { useEffect, useState } from "react"
import { ArrowRight, FileStack, RefreshCw } from "lucide-react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { WorkDeck } from "./work-deck-model"

const UUID = z.string().uuid()
const TemplateSchema = z.object({ id: UUID, template_key: z.string().min(1), version_id: UUID, kind: z.string(), status: z.string() }).passthrough()
const TemplatesSchema = z.array(TemplateSchema)
const CreatedSchema = z.object({ documentId: UUID, version: z.object({ id: UUID }) }).passthrough()
const ArtifactReadbackSchema = z.object({ documentId: UUID, version: z.object({ id: UUID }), document: z.object({ title: z.string() }) }).passthrough()

type Template = z.infer<typeof TemplateSchema>
export type CreatedDeck = { documentId: string; versionId: string; title: string; templateKey: string; verified: boolean }
type Review = { templateId: string; templateKey: string; templateVersionId: string; title: string }

export function ArtifactTemplateDesk({ caseTitle, createdDeck, workDeck, onDeckCreated, onOpenDraft }: {
  caseTitle: string
  createdDeck: CreatedDeck | null
  workDeck: WorkDeck | null
  onDeckCreated: (deck: CreatedDeck) => void
  onOpenDraft: (documentId: string, versionId: string) => void
}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState("")
  const [title, setTitle] = useState(`${caseTitle} · IC deck draft`)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [creatingAnother, setCreatingAnother] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void centropyGet<unknown>("artifact-templates").then((value) => {
      if (!active) return
      setTemplates(TemplatesSchema.parse(value).filter((item) => item.kind === "pptx" && item.status === "active"))
      setLoading(false)
    }).catch((cause) => {
      if (!active) return
      setError(cause instanceof Error ? cause.message : "Template catalog unavailable")
      setLoading(false)
    })
    return () => { active = false }
  }, [revision])

  const selected = templates.find((item) => item.template_key === selectedKey) ?? templates[0] ?? null

  function prepare() {
    const trimmed = title.trim()
    if (!selected || !trimmed || trimmed.length > 500 || busy || uncertain) return
    setReview({ templateId: selected.id, templateKey: selected.template_key, templateVersionId: selected.version_id, title: trimmed })
    setNotice(null)
  }

  async function create() {
    if (!review || busy || uncertain || !templates.some((item) => item.id === review.templateId && item.version_id === review.templateVersionId)) return
    setBusy(true)
    setNotice(null)
    let created: CreatedDeck | null = null
    try {
      const result = CreatedSchema.parse(await centropyPost<unknown>(`artifact-templates/${encodeURIComponent(review.templateKey)}/instantiate`, { title: review.title }))
      created = { documentId: result.documentId, versionId: result.version.id, title: review.title, templateKey: review.templateKey, verified: false }
      onDeckCreated(created)
      const readback = ArtifactReadbackSchema.parse(await centropyGet<unknown>(`documents/${created.documentId}/artifact`, { versionId: created.versionId }))
      if (readback.documentId !== created.documentId || readback.version.id !== created.versionId || readback.document.title !== review.title) throw new Error("Created deck readback did not match the reviewed title and exact version.")
      onDeckCreated({ ...created, verified: true })
      setReview(null)
      setNotice("Exact deck draft created and read back. Inspect its slides, make sourced edits, and review it before any IC selection or publication.")
    } catch (cause) {
      setUncertain(true)
      setNotice(`${cause instanceof Error ? cause.message : "Deck creation status unavailable"} ${created ? "The created document ID is retained below; verify it before another creation." : "Check recorded artifacts before submitting this creation again."}`)
    } finally {
      setBusy(false)
    }
  }

  async function verifyCreated() {
    if (!createdDeck || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const readback = ArtifactReadbackSchema.parse(await centropyGet<unknown>(`documents/${createdDeck.documentId}/artifact`, { versionId: createdDeck.versionId }))
      if (readback.documentId !== createdDeck.documentId || readback.version.id !== createdDeck.versionId || readback.document.title !== createdDeck.title) throw new Error("Exact deck readback does not match the created record.")
      onDeckCreated({ ...createdDeck, verified: true })
      setNotice("Exact deck version verified from persisted Artifact OS records.")
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Exact deck readback unavailable") }
    finally { setBusy(false) }
  }

  return <section className="ct-ic-template" aria-label="IC deck preparation">
    <header><div><span className="ct-eyebrow">ARTIFACT → IC</span><h3>Prepare a versioned IC deck</h3></div><FileStack size={21} aria-hidden="true" /></header>
    <p>{workDeck ? "Work created a separate draft from the recorded PPTX source version. Inspect its slides and evidence before committee selection or publication." : "Start from a registered PPTX template. Creation makes a separate draft; the committee’s recorded memo, deck, votes, and decision stay on their exact versions."}</p>
    <ol className="ct-ic-template__steps"><li data-state={templates.length || workDeck ? "ready" : "waiting"}>Template source</li><li data-state={createdDeck?.verified || workDeck ? "ready" : "waiting"}>Exact draft</li><li data-state="waiting">Review and IC selection</li><li data-state="waiting">Publication</li></ol>
    {workDeck ? <div className="ct-ic-template__created" aria-label="Work-created IC deck draft"><strong>Work-created draft · verified effect and finalized receipt</strong><p>Template {workDeck.templateKey} · source version {workDeck.templateVersionId}</p><small>Work {workDeck.workId} · {workDeck.workStatus.replaceAll("_", " ")}<br />Action {workDeck.actionId}<br />Document {workDeck.documentId}<br />Version {workDeck.versionId}</small><p>This draft is linked to the selected IC case. It still needs sourced edits and review before selection or publication.</p><div><button type="button" onClick={() => onOpenDraft(workDeck.documentId, workDeck.versionId)}>Open Work draft <ArrowRight size={14} /></button></div></div> : null}
    {workDeck && !creatingAnother ? <button type="button" onClick={() => setCreatingAnother(true)}>Create another draft</button> : loading ? <p role="status">Reading registered templates…</p> : error ? <div role="alert" className="ct-ic-template__notice"><p>Template catalog unavailable · {error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} /> Retry catalog</button></div> : !templates.length ? <div className="ct-ic-template__notice" role="status"><strong>Approved PPTX template needed</strong><p>No active presentation template is registered for this workspace. A test corpus deck or a blank file would not establish the approved IC source.</p><button type="button" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} /> Check again</button></div> : <>
      <div className="ct-ic-template__fields"><label>Registered template<select value={selected?.template_key ?? ""} disabled={busy || !!review || uncertain} onChange={(event) => { setSelectedKey(event.target.value); setReview(null) }}>{templates.map((item) => <option key={item.id} value={item.template_key}>{item.template_key}</option>)}</select></label><label>New draft title<input value={title} maxLength={500} disabled={busy || !!review || uncertain} onChange={(event) => setTitle(event.target.value)} /></label></div>
      {selected ? <p className="ct-ic-template__source">Source version · {selected.version_id}</p> : null}
      {!review ? <button className="ct-ic-template__primary" type="button" disabled={!selected || !title.trim() || busy || uncertain} onClick={prepare}>Review deck creation <ArrowRight size={14} /></button> : <div className="ct-ic-template__review"><strong>Review exact source and new title</strong><dl><div><dt>Template</dt><dd>{review.templateKey}</dd></div><div><dt>Source version</dt><dd>{review.templateVersionId}</dd></div><div><dt>New draft</dt><dd>{review.title}</dd></div></dl><p>This creates a new Document and version; it does not attach it to the IC case or publish to Microsoft 365.</p><div><button type="button" disabled={busy} onClick={() => setReview(null)}>Edit</button><button type="button" disabled={busy} onClick={() => void create()}>{busy ? "Creating…" : "Create exact draft"}</button></div></div>}
    </>}
    {createdDeck ? <div className="ct-ic-template__created"><strong>{createdDeck.verified ? "Draft verified" : "Draft readback pending"}</strong><p>{createdDeck.title}</p><small>Document {createdDeck.documentId}<br />Version {createdDeck.versionId}</small><div>{!createdDeck.verified ? <button type="button" disabled={busy} onClick={() => void verifyCreated()}>Verify exact version</button> : null}<button type="button" disabled={!createdDeck.verified} onClick={() => onOpenDraft(createdDeck.documentId, createdDeck.versionId)}>Open draft <ArrowRight size={14} /></button></div></div> : null}
    {notice ? <p className="ct-ic-template__message" role={uncertain ? "alert" : "status"}>{notice}</p> : null}
  </section>
}
