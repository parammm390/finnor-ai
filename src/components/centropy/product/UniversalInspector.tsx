"use client"

import { useEffect, useMemo, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { ArrowRight, Database, FileSearch, History, Link2, Network, ShieldCheck, Workflow, X } from "lucide-react"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import { humanize, refKey, type CompanyBrainEdge, type CompanyBrainNode, type CompanyBrainObjectRef, type InspectionTarget } from "../pe/contracts"
import { loadCompanyBrainObject } from "../pe/use-pe-data"
import { useCommandInterface } from "./CommandInterface"
import { usePeProductData } from "./ProductDataProvider"
import { productNodeLabel } from "./deal-model"
import { EmptyState, EntityLink, ErrorState, Inspector, Skeleton, Status, TruthState } from "./primitives"

const INSPECTOR_TABS = ["summary", "relationships", "evidence", "history", "work", "authority", "technical"] as const
type InspectorTab = (typeof INSPECTOR_TABS)[number]

type DetailPayload =
  | { kind: "evidence"; nodes: CompanyBrainNode[]; edges: CompanyBrainEdge[]; sourceRefs?: Array<{ owner: string; table: string; id: string; fieldPath?: string }> }
  | { kind: "history"; support: string; entries: Array<{ version: number; recordedAt: string; observedAt: string | null; snapshotHash: string; previousVersionId: string | null }> }

function displayValue(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  try { return JSON.stringify(value) } catch { return "Unavailable" }
}

function isTechnicalFact(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLocaleLowerCase()
  return normalized === "attempt"
    || normalized === "source_type"
    || normalized === "source_system"
    || normalized.split("_").some((part) => ["id", "hash", "version", "revision", "metadata", "provider"].includes(part))
}

function sameRef(left: CompanyBrainObjectRef, right: CompanyBrainObjectRef): boolean {
  return refKey(left) === refKey(right)
}

function targetNode(nodes: CompanyBrainNode[], target: InspectionTarget | null, selected: CompanyBrainObjectRef | null, rootType: string | null, rootId: string | null): CompanyBrainNode | null {
  if (selected) {
    const selectedNode = nodes.find((node) => sameRef(node.ref, selected))
    if (selectedNode) return selectedNode
  }
  if (target) {
    if (target.kind === "brain_object") return nodes.find((node) => sameRef(node.ref, target.ref)) ?? null
    if ((target.kind === "pe_context" || target.kind === "ic") && target.objectRef) return nodes.find((node) => sameRef(node.ref, target.objectRef!)) ?? null
    const id = target.kind === "work" ? target.workId
      : target.kind === "plan_revision" ? target.planRevisionId
        : target.kind === "plan_node" ? target.planNodeId
          : target.kind === "evidence" ? target.evidenceVersionId ?? target.evidenceSourceId
            : target.kind === "document" ? target.documentVersionId ?? target.documentId
              : target.kind === "underwriting" ? target.runId ?? target.modelId ?? target.investmentCaseId
                : target.kind === "domain_action" ? target.domainActionId
                  : target.kind === "business_effect" ? target.businessEffectId
                    : target.kind === "decision_receipt" ? target.decisionReceiptId
                      : target.kind === "completion_proof" ? target.planRevisionId
                        : target.kind === "agent" ? target.agentRevisionId ?? target.agentProfileId
                          : target.kind === "assignment" ? target.assignmentId
                            : target.kind === "attention" ? target.attentionId
                              : target.kind === "raw_activity" ? target.activityId
                                : null
    if (id) {
      const exact = nodes.find((node) => node.ref.id === id || (node.inspectionTarget.kind === "attention" && target.kind === "attention" && node.inspectionTarget.attentionId === target.attentionId))
      if (exact) return exact
    }
  }
  return nodes.find((node) => node.ref.type === rootType && node.ref.id === rootId) ?? null
}

function connectedEdges(node: CompanyBrainNode, nodes: CompanyBrainNode[], edges: CompanyBrainEdge[]): { edges: CompanyBrainEdge[]; index: Map<string, CompanyBrainNode> } {
  const index = new Map(nodes.map((item) => [refKey(item.ref), item]))
  const visited = new Set([refKey(node.ref)])
  const selected: CompanyBrainEdge[] = []
  for (let depth = 0; depth < 4; depth += 1) {
    const layer = edges.filter((edge) => visited.has(refKey(edge.fromRef)) || visited.has(refKey(edge.toRef)))
      .filter((edge) => !selected.includes(edge))
      .slice(0, 100 - selected.length)
    if (!layer.length) break
    for (const edge of layer) {
      selected.push(edge)
      visited.add(refKey(edge.fromRef))
      visited.add(refKey(edge.toRef))
    }
  }
  return { edges: selected, index }
}

export function UniversalInspector() {
  const pathname = usePathname()
  const params = useSearchParams()
  const operating = usePeOperatingContext()
  const product = usePeProductData()
  const command = useCommandInterface()
  const inspection = operating.inspection
  const clearInspection = operating.clearInspection
  const projection = product.brain.data
  const requestedTab = params.get("inspectorTab")
  const tab: InspectorTab = INSPECTOR_TABS.includes(requestedTab as InspectorTab) ? requestedTab as InspectorTab : "summary"
  const node = useMemo(() => projection ? targetNode(projection.nodes, operating.inspection, operating.context.selectedObject, projection.root.entityType, projection.root.entityId) : null, [operating.context.selectedObject, operating.inspection, projection])
  const graph = useMemo(() => node && projection ? connectedEdges(node, projection.nodes, projection.edges) : null, [node, projection])
  const [detail, setDetail] = useState<DetailPayload | null>(null)
  const [detailKey, setDetailKey] = useState("")
  const [loading, setLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    // Below the tablet breakpoint the Inspector is an overlay. Give keyboard users
    // the same deterministic escape hatch as the visible close control, while
    // leaving Escape to the command dialog when that higher modal layer is open.
    if (!inspection || command.isOpen) return
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      clearInspection()
    }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [clearInspection, command.isOpen, inspection])

  useEffect(() => {
    if (!node || !projection || (tab !== "evidence" && tab !== "history")) return
    const key = `${refKey(node.ref)}:${tab}`
    if (detailKey === key) return
    let active = true
    setLoading(true)
    setDetailError(null)
    const operation = tab === "evidence" ? "evidence-lineage" : "history"
    void loadCompanyBrainObject<Record<string, unknown>>(operation, projection.root, node.ref)
      .then((response) => {
        if (!active) return
        if (tab === "history") {
          setDetail({
            kind: "history",
            support: String(response.support ?? "unsupported"),
            entries: Array.isArray(response.entries) ? response.entries as Array<{ version: number; recordedAt: string; observedAt: string | null; snapshotHash: string; previousVersionId: string | null }> : [],
          })
        } else {
          setDetail({
            kind: "evidence",
            nodes: Array.isArray(response.nodes) ? response.nodes as CompanyBrainNode[] : Array.isArray(response.evidenceNodes) ? response.evidenceNodes as CompanyBrainNode[] : [],
            edges: Array.isArray(response.edges) ? response.edges as CompanyBrainEdge[] : [],
            sourceRefs: Array.isArray(response.sourceRefs) ? response.sourceRefs as Array<{ owner: string; table: string; id: string; fieldPath?: string }> : undefined,
          })
        }
        setDetailKey(key)
      })
      .catch((cause) => { if (active) setDetailError(cause instanceof Error ? cause.message : "Inspector source is unavailable.") })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [detailKey, node, projection, tab])

  function selectTab(next: InspectorTab) {
    const nextParams = new URLSearchParams(params.toString())
    nextParams.set("inspectorTab", next)
    window.history.pushState(null, "", `${pathname}?${nextParams.toString()}`)
  }

  if (!projection) {
    return <Inspector label="Universal Inspector"><EmptyState title="No inspectable context" detail="Select a canonical Deal or object. The Inspector never substitutes sample facts." icon={<Network size={18} />} /></Inspector>
  }
  if (!node) {
    return <Inspector label="Universal Inspector"><EmptyState title="No recorded inspection target" detail="The selected URL target does not resolve inside this authenticated Company Brain projection." icon={<Network size={18} />} /></Inspector>
  }

  const workNodes = graph ? [...graph.index.values()].filter((item) => ["work", "goal", "plan_revision", "plan_node", "domain_action", "business_effect", "decision_receipt", "completion_proof", "attention"].includes(item.type) && graph.edges.some((edge) => sameRef(edge.fromRef, item.ref) || sameRef(edge.toRef, item.ref))) : []
  const decisionFacts = node.facts.filter((fact) => !isTechnicalFact(fact.key))
  const technicalFacts = node.facts.filter((fact) => isTechnicalFact(fact.key))
  const inspectorTitle = projection ? productNodeLabel(node, projection.nodes, projection.edges) : node.label

  return <Inspector label={`Inspect ${inspectorTitle}`} open={Boolean(operating.inspection)}>
    <header className="pw-inspector__header"><div><span>{humanize(node.type)}</span><h2>{inspectorTitle}</h2><div><Status value={node.state} /><TruthState state={node.epistemicState} compact /></div></div>{operating.inspection ? <button type="button" onClick={operating.clearInspection} aria-label="Close Inspector"><X size={15} /></button> : null}</header>
    <nav className="pw-inspector__tabs" aria-label="Inspector tabs">{INSPECTOR_TABS.map((value) => <button type="button" key={value} aria-current={tab === value ? "page" : undefined} onClick={() => selectTab(value)}>{value}</button>)}</nav>
    <div className="pw-inspector__body">
      {tab === "summary" ? <>
        <section><h3>Decision-useful facts</h3>{decisionFacts.length ? decisionFacts.map((fact) => <article className="pw-inspector-fact" key={fact.key}><div><strong>{humanize(fact.key)}</strong><TruthState state={fact.epistemicState} compact /></div><p>{displayValue(fact.value)}</p><time dateTime={fact.asOf}>{new Date(fact.asOf).toLocaleString()}</time></article>) : <p className="pw-no-link">No recorded decision-useful fact field.</p>}</section>
        <section><h3>Truth boundary</h3><p>{node.temporal.support} · {node.temporal.completeness}</p>{node.temporal.reasons.map((reason) => <small key={reason}>{reason}</small>)}</section>
      </> : null}
      {tab === "relationships" ? <section><h3><Link2 size={13} /> Persisted Company Brain edges</h3>{graph?.edges.length ? graph.edges.map((edge) => {
        const from = graph.index.get(refKey(edge.fromRef))
        const to = graph.index.get(refKey(edge.toRef))
        if (!from || !to) return null
        return <article className="pw-lineage-edge" key={`${edge.relationship}:${refKey(edge.fromRef)}:${refKey(edge.toRef)}:${edge.sourceRef.id}`}><EntityLink onOpen={() => operating.inspect(from.inspectionTarget, from.ref)}>{productNodeLabel(from, projection.nodes, projection.edges)}</EntityLink><span><ArrowRight size={11} />{humanize(edge.relationship)}</span><EntityLink onOpen={() => operating.inspect(to.inspectionTarget, to.ref)}>{productNodeLabel(to, projection.nodes, projection.edges)}</EntityLink><small>{edge.sourceRef.table}</small></article>
      }) : <p className="pw-no-link">No recorded link.</p>}</section> : null}
      {tab === "evidence" ? <section><h3><FileSearch size={13} /> Evidence and source lineage</h3>{loading ? <Skeleton rows={4} label="Loading evidence lineage" /> : null}{detailError ? <ErrorState title="Evidence lineage unavailable" detail={detailError} /> : null}{detail?.kind === "evidence" && !loading ? <>{detail.nodes.length ? detail.nodes.map((item) => <EntityLink key={refKey(item.ref)} onOpen={() => operating.inspect(item.inspectionTarget, item.ref)}>{humanize(item.type)} · {productNodeLabel(item, detail.nodes, detail.edges)}</EntityLink>) : <p className="pw-no-link">No recorded link.</p>}{detail.edges.map((edge) => <code key={`${edge.relationship}:${edge.sourceRef.id}`}>{humanize(edge.relationship)} · {edge.sourceRef.table}</code>)}{detail.sourceRefs?.map((source) => <code key={`${source.owner}:${source.table}:${source.id}:${source.fieldPath ?? ""}`}>{source.owner} · {source.table}{source.fieldPath ? ` · ${source.fieldPath}` : ""}</code>)}</> : null}</section> : null}
      {tab === "history" ? <section><h3><History size={13} /> Supported history</h3>{loading ? <Skeleton rows={4} label="Loading object history" /> : null}{detailError ? <ErrorState title="History unavailable" detail={detailError} /> : null}{detail?.kind === "history" && !loading ? <>{detail.entries.length ? detail.entries.map((entry) => <article className="pw-history-row" key={`${entry.version}:${entry.snapshotHash}`}><strong>Version {entry.version}</strong><time>{new Date(entry.recordedAt).toLocaleString()}</time><small>{entry.previousVersionId ? "Supersedes a recorded version" : "First recorded version"}</small></article>) : <p className="pw-no-link">{detail.support === "canonical_history" ? "No recorded history entry." : `History is ${detail.support}; no version is inferred.`}</p>}</> : null}</section> : null}
      {tab === "work" ? <section><h3><Workflow size={13} /> Linked Work and execution</h3>{workNodes.length ? workNodes.map((item) => <EntityLink key={refKey(item.ref)} onOpen={() => operating.inspect(item.inspectionTarget, item.ref)}>{humanize(item.type)} · {productNodeLabel(item, projection.nodes, projection.edges)}</EntityLink>) : <p className="pw-no-link">No recorded link.</p>}</section> : null}
      {tab === "authority" ? <section><h3><ShieldCheck size={13} /> Governed actions</h3><p>Selection grants no authority. Every action is evaluated against the persisted Policy and Authority boundary at execution.</p>{node.availableActions.length ? node.availableActions.map((action) => <button className="pw-authority-action" type="button" key={action.actionType} onClick={() => command.openCommand({ prompt: `${action.label} for ${inspectorTitle}`, target: node.inspectionTarget })}><span><strong>{action.label}</strong><small>{action.authorityEvaluation.replaceAll("_", " ")}</small></span><ArrowRight size={13} /></button>) : <p className="pw-no-link">No recorded governed action is semantically applicable.</p>}</section> : null}
      {tab === "technical" ? <><section><h3><Database size={13} /> Canonical identity</h3><code>{refKey(node.ref)}</code><p>Version {node.version ?? "not recorded"} · revision {node.revision ?? "not recorded"}</p></section>{technicalFacts.length ? <section><h3>Technical fact fields</h3>{technicalFacts.map((fact) => <code key={fact.key}>{humanize(fact.key)} · {displayValue(fact.value)}</code>)}</section> : null}<section><h3>Source metadata</h3>{node.provenanceRefs.map((source) => <code key={`${source.owner}:${source.table}:${source.id}:${source.fieldPath ?? ""}`}>{source.owner} · {source.table}:{source.id}{source.revisionId ? ` · revision ${source.revisionId}` : ""}{source.fieldPath ? ` · ${source.fieldPath}` : ""}</code>)}</section></> : null}
    </div>
  </Inspector>
}
