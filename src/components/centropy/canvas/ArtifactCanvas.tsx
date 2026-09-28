"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, ArrowRight, Download, FileText, GitCompareArrows, RefreshCw } from "lucide-react"
import { z } from "zod"
import { centropyDownload, centropyGet } from "@/components/centropy/lib/api"
import type { IcWorkspace } from "@/components/centropy/product/contracts"
import { ArtifactDocumentEditor, type EditableParagraph } from "./ArtifactDocumentEditor"
import { ArtifactPresentationEditor, type EditableSlideText } from "./ArtifactPresentationEditor"
import { ArtifactGovernanceDesk } from "./ArtifactGovernanceDesk"
import { ArtifactIcHandoff } from "./ArtifactIcHandoff"
import { ArtifactPublicationDesk } from "./ArtifactPublicationDesk"

const UUID = z.string().uuid()
const RowSchema = z.object({ id: UUID }).passthrough()
const ArtifactMetaSchema = z.object({
  documentId: UUID,
  document: z.object({ id: UUID, title: z.string() }).passthrough(),
  version: RowSchema,
  versions: z.array(RowSchema),
  semantic: z.object({ kind: z.string(), semanticHash: z.string(), nodeCount: z.number().int().nonnegative(), warnings: z.array(z.string()), calculationStatus: z.string() }).passthrough(),
  comments: z.array(z.record(z.unknown())), reviews: z.array(z.record(z.unknown())),
  bindings: z.array(z.record(z.unknown())), lineage: z.array(z.record(z.unknown())),
  publications: z.array(z.record(z.unknown())), providerCreations: z.array(z.record(z.unknown())),
}).passthrough()
const NodeSchema = z.object({ id: z.string(), kind: z.string(), hash: z.string(), part: z.string(), data: z.record(z.unknown()) }).passthrough()
const IrPageSchema = z.object({ kind: z.string(), semanticHash: z.string(), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), nodes: z.array(NodeSchema), warnings: z.array(z.string()) }).passthrough()
const DiffSchema = z.object({ left: UUID, right: UUID, changes: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()) }).passthrough()
const PinnedProjectionSchema = z.object({
  documentId: UUID, documentVersionId: UUID, documentTitle: z.string(),
  versionOrdinal: z.number().int().optional(), format: z.string().optional(),
  parseStatus: z.string().nullable().optional(), fidelityStatus: z.string().nullable().optional(),
  calculationStatus: z.string().nullable().optional(), reviewState: z.string().nullable().optional(),
  citationCount: z.number().int().nonnegative().optional(), sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: z.string().optional(),
}).passthrough()

type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>
type IrPage = z.infer<typeof IrPageSchema>
type ArtifactNode = z.infer<typeof NodeSchema>
type Diff = z.infer<typeof DiffSchema>
type ArtifactState = { meta: ArtifactMeta | null; ir: IrPage | null; error: string | null; loading: boolean }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function field(value: unknown, key: string): string | null { const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; const raw = data?.[key] ?? data?.[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]; return typeof raw === "string" && raw.trim() ? raw : null }
function scalar(value: unknown): string { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : value == null ? "Not recorded" : "Structured value" }
const label = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase()

export function ArtifactCanvas({ documentId, initialVersionId, pinnedVersionId, pinnedProjection, ic, icReady, onIcRefresh, onSelectIcCase, onClose, onVersionChange }: { documentId: string; initialVersionId: string; pinnedVersionId?: string; pinnedProjection?: Record<string, unknown>; ic?: IcWorkspace | null; icReady?: boolean; onIcRefresh?: () => void; onSelectIcCase?: (id: string) => void; onClose: () => void; onVersionChange?: (versionId: string) => void }) {
  const [versionId, setVersionId] = useState(initialVersionId)
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<ArtifactState>({ meta: null, ir: null, error: null, loading: true })
  const [sheetId, setSheetId] = useState("")
  const [slideId, setSlideId] = useState("")
  const [range, setRange] = useState("")
  const [rangePage, setRangePage] = useState<IrPage | null>(null)
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [rangeLoading, setRangeLoading] = useState(false)
  const [compareId, setCompareId] = useState("")
  const [diff, setDiff] = useState<Diff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  async function download() {
    if (!state.meta || downloading) return
    setDownloading(true); setDownloadError(null)
    try {
      await centropyDownload(`documents/${documentId}`, `${state.meta.document.title.replace(/\.[a-z0-9]+$/i, "")}.${state.meta.semantic.kind}`, { versionId })
    } catch (cause) { setDownloadError(cause instanceof Error ? cause.message : "Artifact download unavailable") }
    finally { setDownloading(false) }
  }

  useEffect(() => {
    if (!UUID_PATTERN.test(documentId) || !UUID_PATTERN.test(versionId)) { setState({ meta: null, ir: null, error: "The document or version identifier is invalid.", loading: false }); return }
    let active = true
    setState({ meta: null, ir: null, error: null, loading: true }); setRangePage(null); setDiff(null)
    void Promise.all([
      centropyGet<unknown>(`documents/${documentId}/artifact`, { versionId }).catch((cause) => { throw new Error(`Artifact metadata read: ${cause instanceof Error ? cause.message : "Unavailable"}`) }),
      centropyGet<unknown>(`documents/${documentId}/artifact/ir/${versionId}`, { limit: "500" }).catch((cause) => { throw new Error(`Semantic content read: ${cause instanceof Error ? cause.message : "Unavailable"}`) }),
    ]).then(([metaValue, irValue]) => {
      if (!active) return
      const meta = ArtifactMetaSchema.parse(metaValue)
      const ir = IrPageSchema.parse(irValue)
      if (meta.documentId !== documentId || meta.document.id !== documentId || meta.version.id !== versionId || !meta.versions.some((version) => version.id === versionId) || meta.semantic.semanticHash !== ir.semanticHash || meta.semantic.kind !== ir.kind) throw new Error("Artifact metadata and semantic content did not match the pinned document version.")
      setState({ meta, ir, error: null, loading: false })
    }).catch((cause) => { if (active) setState({ meta: null, ir: null, error: cause instanceof Error ? cause.message : "Artifact read unavailable", loading: false }) })
    return () => { active = false }
  }, [documentId, versionId, refresh])

  const meta = state.meta
  const ir = state.ir
  const selectedVersionReady = meta?.version.id === versionId
  const pinned = PinnedProjectionSchema.safeParse(pinnedProjection)
  const fallback = pinnedVersionId && pinned.success && pinned.data.documentId === documentId && pinned.data.documentVersionId === pinnedVersionId ? pinned.data : null
  const sheets = useMemo(() => ir?.nodes.filter((node) => node.kind === "worksheet") ?? [], [ir])
  const slides = useMemo(() => ir?.nodes.filter((node) => node.kind === "slide") ?? [], [ir])
  const activeSheet = sheets.find((node) => node.id === sheetId) ?? sheets[0] ?? null
  const activeSlide = slides.find((node) => node.id === slideId) ?? slides[0] ?? null
  const sheetCells = (rangePage?.nodes ?? ir?.nodes ?? []).filter((node) => node.kind === "cell" && node.data.sheetId === activeSheet?.id.replace(/^sheet:/, ""))
  const slideNodes = ir?.nodes.filter((node) => activeSlide && node.id.startsWith(`shape:${activeSlide.id.replace(/^slide:/, "")}:`) && ["shape", "tableCell", "image", "table"].includes(node.kind)) ?? []
  const editableSlideText: EditableSlideText[] = slideNodes.filter((node) => (node.kind === "shape" || node.kind === "tableCell") && node.data.editable === true && typeof node.data.text === "string" && node.data.text.trim()).map((node) => ({ id: node.id, hash: node.hash, kind: node.kind as "shape" | "tableCell", text: String(node.data.text), name: typeof node.data.name === "string" && node.data.name.trim() ? node.data.name : node.kind === "tableCell" ? "Table cell" : "Text shape" }))
  const paragraphs = ir?.nodes.filter((node) => node.kind === "paragraph" && typeof node.data.text === "string" && node.data.text.trim()) ?? []
  const editableParagraphs: EditableParagraph[] = paragraphs.filter((node) => node.data.editable === true).map((node) => ({ id: node.id, hash: node.hash, text: String(node.data.text) }))

  function selectVersion(nextVersionId: string) {
    setVersionId(nextVersionId)
    setCompareId("")
    onVersionChange?.(nextVersionId)
  }

  async function inspectRange() {
    if (!activeSheet || !ir || !/^[A-Z]{1,3}[1-9]\d{0,6}:[A-Z]{1,3}[1-9]\d{0,6}$/i.test(range.trim())) { setRangeError("Enter an A1 range such as A1:D20."); return }
    setRangeLoading(true); setRangeError(null); setRangePage(null)
    try {
      const page = IrPageSchema.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/ir/${versionId}`, { sheetId: activeSheet.id.replace(/^sheet:/, ""), range: range.trim().toUpperCase(), limit: "500" }))
      if (page.semanticHash !== ir.semanticHash || page.kind !== ir.kind) throw new Error("The range read did not match this document version.")
      setRangePage(page)
    } catch (cause) { setRangeError(cause instanceof Error ? cause.message : "Range unavailable") }
    finally { setRangeLoading(false) }
  }

  async function compareVersions() {
    if (!compareId || !UUID_PATTERN.test(compareId) || !meta?.versions.some((version) => version.id === compareId) || compareId === versionId) return
    setDiffLoading(true); setDiffError(null); setDiff(null)
    try {
      const result = DiffSchema.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/diff`, { left: compareId, right: versionId }))
      if (result.left !== compareId || result.right !== versionId) throw new Error("Artifact diff returned a different version pair.")
      setDiff(result)
    } catch (cause) { setDiffError(cause instanceof Error ? cause.message : "Diff unavailable") }
    finally { setDiffLoading(false) }
  }

  return <div className="ct-artifact">
    <header><button type="button" onClick={onClose}><ArrowLeft size={16} /> Back to Investigation Canvas</button><span>ARTIFACT / EXACT VERSION</span><button type="button" disabled={downloading || !selectedVersionReady} onClick={() => void download()}><Download size={16} /> {downloading ? "Downloading…" : "Download exact version"}</button><button type="button" onClick={() => setRefresh((value) => value + 1)} aria-label="Refresh artifact"><RefreshCw size={16} /></button></header>
    {downloadError ? <p role="alert" className="ct-artifact__error-text">{downloadError}</p> : null}
    {state.loading ? <p role="status">Reading the persisted artifact and semantic content…</p> : null}
    {!state.loading && meta && !selectedVersionReady ? <p role="status">Loading the selected exact version…</p> : null}
    {state.error ? <div className="ct-artifact__error" role="alert"><h2>Artifact content unavailable</h2><p>{state.error}</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry Artifact OS read</button></div> : null}
    {state.error && fallback ? <section className="ct-artifact__fallback"><span className="ct-eyebrow">PINNED IC RECORD · PARTIAL COVERAGE</span><h2>{fallback.documentTitle}</h2><p>The IC service verifies this exact document version. Artifact content, anchors, and editing cannot be shown until the Artifact OS read succeeds.</p><dl><div><dt>Document</dt><dd>{fallback.documentId}</dd></div><div><dt>Version</dt><dd>{fallback.documentVersionId}</dd></div>{fallback.versionOrdinal ? <div><dt>Ordinal</dt><dd>{fallback.versionOrdinal}</dd></div> : null}{fallback.format ? <div><dt>Format</dt><dd>{fallback.format.toUpperCase()}</dd></div> : null}{fallback.parseStatus ? <div><dt>Parse</dt><dd>{label(fallback.parseStatus)}</dd></div> : null}{fallback.fidelityStatus ? <div><dt>Fidelity</dt><dd>{label(fallback.fidelityStatus)}</dd></div> : null}{fallback.calculationStatus ? <div><dt>Calculation</dt><dd>{label(fallback.calculationStatus)}</dd></div> : null}{fallback.reviewState ? <div><dt>Review</dt><dd>{label(fallback.reviewState)}</dd></div> : null}</dl></section> : null}
    {meta && ir && selectedVersionReady ? <>
      <div className="ct-artifact__intro"><span className="ct-eyebrow">{ir.kind.toUpperCase()} · {meta.semantic.calculationStatus.replaceAll("_", " ")}</span><h2>{meta.document.title}</h2><p>Document {documentId} · version {versionId}</p></div>
      <div className="ct-artifact__meta"><span>{ir.total} semantic nodes</span><span>{meta.versions.length} versions</span><span>{meta.comments.length} comments</span><span>{meta.bindings.length} bindings</span><span>{meta.reviews.length} reviews</span><span>{meta.publications.length} replacement publications</span><span>{meta.providerCreations.length} provider creations</span></div>
      <section className="ct-artifact__section"><div className="ct-artifact__section-head"><h3>Version</h3><select aria-label="Artifact version" value={versionId} onChange={(event) => selectVersion(event.target.value)}>{meta.versions.map((version) => <option key={version.id} value={version.id}>{pinnedVersionId && version.id === pinnedVersionId ? "IC pinned · " : ""}{version.id.slice(0, 8)}{field(version, "createdAt") ? ` · ${new Date(field(version, "createdAt")!).toLocaleDateString()}` : ""}</option>)}</select></div>{pinnedVersionId && versionId !== pinnedVersionId ? <p className="ct-artifact__caveat">You are inspecting another version. The IC case remains pinned to {pinnedVersionId}.</p> : !pinnedVersionId ? <p className="ct-artifact__caveat">This draft is not pinned to an IC decision. The current URL reopens this exact version after refresh.</p> : null}</section>
      {ir.kind === "docx" ? <section className="ct-artifact__section"><h3>Document structure</h3>{paragraphs.length ? <div className="ct-artifact__document">{paragraphs.map((node) => <p key={node.id} data-style={scalar(node.data.style)}>{scalar(node.data.text)}</p>)}</div> : <p>No readable paragraphs are present in the loaded semantic page.</p>}</section> : null}
      {ir.kind === "docx" ? <ArtifactDocumentEditor key={`editor:${versionId}`} documentId={documentId} versionId={versionId} pinnedVersionId={pinnedVersionId} paragraphs={editableParagraphs} onVersionCreated={selectVersion} /> : null}
      {ir.kind === "pptx" ? <section className="ct-artifact__section"><h3>Presentation slides</h3>{slides.length ? <><div className="ct-artifact__nav">{slides.map((slide, index) => <button type="button" aria-pressed={activeSlide?.id === slide.id} onClick={() => setSlideId(slide.id)} key={slide.id}>Slide {index + 1}</button>)}</div><div className="ct-artifact__slide"><span>SLIDE {slides.indexOf(activeSlide!) + 1}</span>{slideNodes.length ? slideNodes.map((node) => <p key={node.id}>{scalar(node.data.text)}</p>) : <p>No text shapes in this slide’s loaded semantic page.</p>}</div></> : <p>No slides are present in the loaded semantic page.</p>}</section> : null}
      {ir.kind === "pptx" && activeSlide ? <ArtifactPresentationEditor key={`slide-editor:${versionId}:${activeSlide.id}`} documentId={documentId} versionId={versionId} pinnedVersionId={pinnedVersionId} slideLabel={`Slide ${slides.indexOf(activeSlide) + 1}`} textNodes={editableSlideText} onVersionCreated={selectVersion} /> : null}
      {["xlsx", "xlsm"].includes(ir.kind) ? <section className="ct-artifact__section"><h3>Workbook</h3>{sheets.length ? <><div className="ct-artifact__nav">{sheets.map((sheet) => <button type="button" aria-pressed={activeSheet?.id === sheet.id} onClick={() => { setSheetId(sheet.id); setRangePage(null) }} key={sheet.id}>{scalar(sheet.data.name)}</button>)}</div><div className="ct-artifact__range"><label>Inspect exact range<input value={range} onChange={(event) => setRange(event.target.value)} placeholder="A1:D20" /></label><button type="button" disabled={rangeLoading} onClick={() => void inspectRange()}>{rangeLoading ? "Reading…" : "Read range"} <ArrowRight size={13} /></button></div>{rangeError ? <p role="alert" className="ct-artifact__error-text">{rangeError}</p> : null}<div className="ct-artifact__cells" role="table" aria-label="Recorded worksheet cells"><div role="row"><strong role="columnheader">Cell</strong><strong role="columnheader">Stored value or formula</strong></div>{sheetCells.slice(0, 200).map((cell) => <div role="row" key={cell.id}><span role="cell">{scalar(cell.data.address)}</span><span role="cell">{cell.data.formula != null ? `=${scalar(cell.data.formula)} · cached ${scalar(cell.data.cached)} · ${scalar(cell.data.calculation)}` : scalar(cell.data.value)}</span></div>)}</div>{sheetCells.length > 200 ? <p>Showing 200 of {sheetCells.length} loaded cells. Narrow the range.</p> : null}</> : <p>No worksheets are present in the loaded semantic page.</p>}</section> : null}
      {ir.total > ir.nodes.length ? <p className="ct-artifact__caveat">Showing {ir.nodes.length} of {ir.total} semantic nodes. Use a narrower range or version for exact inspection.</p> : null}
      {meta.versions.length > 1 ? <section className="ct-artifact__section"><h3>Version difference</h3><div className="ct-artifact__range"><select aria-label="Compare with version" value={compareId} onChange={(event) => setCompareId(event.target.value)}><option value="">Choose an earlier version</option>{meta.versions.filter((version) => version.id !== versionId).map((version) => <option key={version.id} value={version.id}>{version.id.slice(0, 8)}</option>)}</select><button type="button" disabled={!compareId || diffLoading} onClick={() => void compareVersions()}><GitCompareArrows size={14} /> {diffLoading ? "Comparing…" : "Compare"}</button></div>{diffError ? <p role="alert" className="ct-artifact__error-text">{diffError}</p> : null}{diff ? <div className="ct-artifact__diff"><p>{diff.changes.length} recorded semantic change{diff.changes.length === 1 ? "" : "s"}</p>{diff.changes.slice(0, 100).map((change) => <p key={change.id}>{label(change.kind)} · {change.id}</p>)}{diff.changes.length > 100 ? <p>Showing the first 100 changes.</p> : null}</div> : null}</section> : null}
      <ArtifactGovernanceDesk key={`governance:${versionId}`} documentId={documentId} versionId={versionId} pinnedVersionId={pinnedVersionId} anchors={ir.nodes} commentCount={meta.comments.length} reviewCount={meta.reviews.length} onRecorded={() => setRefresh((value) => value + 1)} />
      {!pinnedVersionId && ir.kind === "pptx" ? <ArtifactPublicationDesk key={`publication:${versionId}`} documentId={documentId} versionId={versionId} semanticHash={ir.semanticHash} title={meta.document.title} dealId={ic?.case.dealId ?? null} reviews={meta.reviews} providerCreations={meta.providerCreations} onRecorded={() => setRefresh((value) => value + 1)} onVersionChange={selectVersion} /> : null}
      {!pinnedVersionId && ir.kind === "pptx" && onIcRefresh ? <ArtifactIcHandoff key={`handoff:${versionId}`} documentId={documentId} versionId={versionId} format={ir.kind} reviews={meta.reviews} bindingCount={meta.bindings.length} publications={meta.publications} providerCreations={meta.providerCreations} ic={ic ?? null} writable={Boolean(icReady)} onIcRefresh={onIcRefresh} onSelectIcCase={onSelectIcCase} /> : null}
      <section className="ct-artifact__section"><h3>Governance and provenance</h3><div className="ct-artifact__governance"><div><strong>Comments · {meta.comments.length}</strong>{meta.comments.map((comment, index) => <p key={field(comment, "id") ?? index}>{field(comment, "anchorId") ?? "Anchor unavailable"} · {field(comment, "body") ?? "Comment unavailable"}</p>)}</div><div><strong>Bindings · {meta.bindings.length}</strong>{meta.bindings.map((binding, index) => <p key={field(binding, "id") ?? index}>{field(binding, "anchorId") ?? "Anchor unavailable"} → {field(binding, "targetKind") ?? "Target unavailable"} {field(binding, "targetId") ?? ""}</p>)}</div><div><strong>Reviews · {meta.reviews.length}</strong>{meta.reviews.map((review, index) => <p key={field(review, "id") ?? index}>{label(field(review, "state") ?? "state unavailable")}</p>)}</div><div><strong>Replacement publications · {meta.publications.length}</strong>{meta.publications.map((publication, index) => <p key={field(publication, "id") ?? index}>{label(field(publication, "status") ?? "status unavailable")}</p>)}</div><div><strong>Provider file creations · {meta.providerCreations.length}</strong>{meta.providerCreations.map((creation, index) => <p key={field(creation, "id") ?? index}>{label(field(creation, "status") ?? "status unavailable")} · {field(creation, "fileName") ?? "Name unavailable"}</p>)}</div><div><strong>Lineage · {meta.lineage.length}</strong>{meta.lineage.map((line, index) => <p key={field(line, "id") ?? index}>{label(field(line, "relation") ?? "relation unavailable")}</p>)}</div></div></section>
      {ir.warnings.length ? <section className="ct-artifact__section ct-artifact__warnings"><h3>Parse and fidelity notes</h3>{ir.warnings.map((warning) => <p key={warning}>{warning.replaceAll("_", " ")}</p>)}</section> : null}
    </> : null}
  </div>
}
