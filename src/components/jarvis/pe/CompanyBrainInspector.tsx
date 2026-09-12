"use client"

import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, ArrowUpRight, Database, History, Link2, Network, ShieldCheck, X } from "lucide-react"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import { humanize, refKey, type CompanyBrainEdge, type CompanyBrainNode, type CompanyBrainObjectRef, type CompanyBrainProjection, type CompanyBrainSourceRef } from "./contracts"
import { loadCompanyBrainObject } from "./use-pe-data"

type InspectorTab = "overview" | "provenance" | "history" | "evidence" | "decision"
type DetailPayload =
  | { kind: "provenance"; sourceRefs: CompanyBrainSourceRef[]; evidenceNodes: CompanyBrainNode[]; edges: CompanyBrainEdge[] }
  | { kind: "history"; support: string; entries: Array<{ version: number; recordedAt: string; observedAt: string | null; snapshotHash: string; previousVersionId: string | null; sourceRef: CompanyBrainSourceRef }> }
  | { kind: "lineage"; nodes: CompanyBrainNode[]; edges: CompanyBrainEdge[]; page: { returned: number; total: number; truncated: boolean } }

function displayValue(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  try { return JSON.stringify(value) } catch { return "Unavailable" }
}

function selectedNode(projection: CompanyBrainProjection, ref: CompanyBrainObjectRef | null): CompanyBrainNode | null {
  if (ref) return projection.nodes.find((node) => refKey(node.ref) === refKey(ref)) ?? null
  return projection.nodes.find((node) => node.ref.type === projection.root.entityType && node.ref.id === projection.root.entityId) ?? null
}

export function CompanyBrainInspector({ projection, onCandidateAction }: { projection: CompanyBrainProjection; onCandidateAction?: (actionType: string) => void }) {
  const operating = usePeOperatingContext()
  const node = useMemo(() => selectedNode(projection, operating.context.selectedObject), [operating.context.selectedObject, projection])
  const [tab, setTab] = useState<InspectorTab>("overview")
  const [detail, setDetail] = useState<DetailPayload | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const nodeKey = node ? refKey(node.ref) : null

  useEffect(() => { setTab("overview"); setDetail(null); setDetailError(null) }, [nodeKey])
  useEffect(() => {
    if (!node || tab === "overview") { setDetail(null); setDetailError(null); return }
    let active = true
    setLoading(true); setDetail(null); setDetailError(null)
    const operation = tab === "evidence" ? "evidence-lineage" : tab === "decision" ? "decision-lineage" : tab
    void loadCompanyBrainObject<Record<string, unknown>>(operation, projection.root, node.ref)
      .then((response) => {
        if (!active) return
        if (tab === "provenance") setDetail({ kind: "provenance", sourceRefs: (response.sourceRefs as CompanyBrainSourceRef[]) ?? [], evidenceNodes: (response.evidenceNodes as CompanyBrainNode[]) ?? [], edges: (response.edges as CompanyBrainEdge[]) ?? [] })
        else if (tab === "history") setDetail({ kind: "history", support: String(response.support ?? "unsupported"), entries: (response.entries as DetailPayload extends { kind: "history"; entries: infer E } ? E : never) ?? [] })
        else setDetail({ kind: "lineage", nodes: (response.nodes as CompanyBrainNode[]) ?? [], edges: (response.edges as CompanyBrainEdge[]) ?? [], page: (response.page as { returned: number; total: number; truncated: boolean }) ?? { returned: 0, total: 0, truncated: false } })
      })
      .catch((cause) => { if (active) setDetailError(cause instanceof Error ? cause.message : "Inspection source unavailable.") })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [node, projection.root, tab])

  if (!node) return <aside className="pe-inspector pe-sticky-inspection"><div className="pe-inspector__empty"><Network size={18} /><strong>Select an inspectable Brain object</strong><p>The inspector will resolve facts, provenance, temporal support, evidence, and decision lineage from the current root.</p></div></aside>
  return (
    <aside className="pe-inspector pe-sticky-inspection" data-epistemic={node.epistemicState} aria-label={`Inspect ${node.label}`}>
      <header className="pe-inspector__header"><div><span>{humanize(node.type)}</span><h2>{node.label}</h2><p>{node.state ?? node.epistemicState} · as of {new Date(node.asOf).toLocaleString()}</p></div>{operating.inspection ? <button type="button" onClick={operating.clearInspection} aria-label="Close inspection"><X size={15} /></button> : null}</header>
      <div className="pe-inspector__epistemic"><span data-state={node.epistemicState}>{node.epistemicState}</span><small>{node.temporal.support} · {node.temporal.completeness}</small></div>
      <nav className="pe-inspector__tabs" aria-label="Object inspection lenses">{(["overview", "provenance", "history", "evidence", "decision"] as const).map((value) => <button type="button" key={value} data-active={tab === value ? "true" : "false"} onClick={() => setTab(value)}>{humanize(value)}</button>)}</nav>
      {tab === "overview" ? <div className="pe-inspector__body">
        <section><h3>Canonical reference</h3><code>{refKey(node.ref)}</code></section>
        <section><h3>Facts</h3>{node.facts.length === 0 ? <p>Known empty: this projection exposes no fact fields for the object.</p> : node.facts.map((fact) => <div className="pe-fact" key={fact.key}><span><b>{humanize(fact.key)}</b><em data-state={fact.epistemicState}>{fact.epistemicState}</em></span><p>{displayValue(fact.value)}</p><small>{fact.sourceRefs.map((source) => `${source.table}:${source.id}`).join(" · ")}</small></div>)}</section>
        <section><h3>Warnings</h3>{node.epistemicWarnings.length === 0 ? <p>No epistemic warning is recorded for this object.</p> : node.epistemicWarnings.map((warning) => <div className="pe-warning" key={warning.propositionId}><AlertTriangle size={13} /><span><b>{warning.mappedState} · {warning.predicate}</b><small>{warning.reason}</small></span></div>)}</section>
        <section><h3>Available action types</h3>{node.availableActions.length === 0 ? <p>No semantically applicable action type is registered for this object.</p> : node.availableActions.map((action) => <button className="pe-candidate-action" type="button" key={action.actionType} onClick={() => onCandidateAction?.(action.actionType)} disabled={!onCandidateAction}><span><ShieldCheck size={13} /><b>{action.label}</b><small>{action.actionType}</small></span><em>candidate · authority evaluated at execution</em></button>)}</section>
      </div> : <div className="pe-inspector__body">
        {loading ? <p className="pe-inspector__loading">Resolving {tab} from canonical sources…</p> : null}
        {detailError ? <div className="pe-warning"><AlertTriangle size={13} /><span><b>Source unavailable</b><small>{detailError}</small></span></div> : null}
        {detail?.kind === "provenance" ? <><section><h3><Database size={13} /> Persisted sources</h3>{detail.sourceRefs.length ? detail.sourceRefs.map((source) => <code key={`${source.owner}:${source.table}:${source.id}:${source.fieldPath ?? ""}`}>{source.owner} · {source.table}:{source.id}{source.fieldPath ? ` · ${source.fieldPath}` : ""}</code>) : <p>Known empty: no source reference was returned.</p>}</section><section><h3><Link2 size={13} /> Evidence objects</h3>{detail.evidenceNodes.length ? detail.evidenceNodes.map((item) => <button type="button" key={refKey(item.ref)} onClick={() => operating.inspect(item.inspectionTarget, item.ref)}>{item.label}<ArrowUpRight size={12} /></button>) : <p>Known empty: no evidence object is linked.</p>}</section></> : null}
        {detail?.kind === "history" ? <section><h3><History size={13} /> History · {detail.support}</h3>{detail.entries.length ? detail.entries.map((entry) => <div className="pe-history" key={`${entry.version}:${entry.snapshotHash}`}><span>v{entry.version}</span><b>{new Date(entry.recordedAt).toLocaleString()}</b><code>{entry.snapshotHash}</code><small>{entry.previousVersionId ? `previous ${entry.previousVersionId}` : "first recorded version"}</small></div>) : <p>{detail.support === "canonical_history" ? "Known empty: no canonical version entry was returned." : `History is explicitly ${detail.support}; no version is being inferred.`}</p>}</section> : null}
        {detail?.kind === "lineage" ? <><section><h3><Network size={13} /> {humanize(tab)} lineage</h3><p>{detail.page.returned} of {detail.page.total} objects returned{detail.page.truncated ? " · bounded" : ""}.</p>{detail.nodes.map((item) => <button type="button" key={refKey(item.ref)} onClick={() => operating.inspect(item.inspectionTarget, item.ref)}>{humanize(item.type)} · {item.label}<ArrowUpRight size={12} /></button>)}</section><section><h3>Persisted relationships</h3>{detail.edges.length ? detail.edges.map((edge) => <code key={`${edge.relationship}:${edge.sourceRef.id}`}>{humanize(edge.relationship)} · {edge.sourceRef.table}:{edge.sourceRef.id}</code>) : <p>Known empty: no relationship exists in this lineage projection.</p>}</section></> : null}
      </div>}
    </aside>
  )
}
