"use client"

import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { ArrowRight, ArrowUpRight, Clock3, Globe2, Link2, RefreshCw, Search, ShieldCheck } from "lucide-react"
import { centropyPost } from "@/components/centropy/lib/api"
import { useCompanyBrainRoots } from "@/components/centropy/pe/use-pe-data"
import { refKey, type CandidateCompanyBrainAction, type CompanyBrainEdge, type CompanyBrainFact, type CompanyBrainNode, type CompanyBrainObjectRef, type CompanyBrainProjection, type CompanyBrainSearchResult, type CompanyBrainSourceRef, type PeWorldRootRef } from "@/components/centropy/pe/contracts"
import { WorldWorkRecord } from "./WorldWorkRecord"
import { capabilityForId } from "@/lib/centropy/capability-manifest"
const WorldRelationships = lazy(() => import("./WorldRelationships").then((module) => ({ default: module.WorldRelationships })))
const HumanControlDesk = lazy(() => import("../controls/HumanControlDesk").then((module) => ({ default: module.HumanControlDesk })))

type WorldTab = "overview" | "record" | "relationships" | "provenance" | "history" | "evidence" | "decisions" | "actions"
type WorldGroup = "all" | "risks" | "committee" | "evidence" | "work" | "underwriting"
type Traverse = { nodes: CompanyBrainNode[]; edges: CompanyBrainEdge[]; page?: { truncated: boolean; total: number } }
type Provenance = { sourceRefs: CompanyBrainSourceRef[]; evidenceNodes: CompanyBrainNode[] }
type History = { support: string; entries: Array<{ version: number; recordedAt: string; observedAt: string | null }> }
type Actions = { actions: CandidateCompanyBrainAction[]; authorization: string }
type Detail = Traverse | Provenance | History | Actions | null

const TABS: Array<{ id: WorldTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "relationships", label: "Relationships" }, { id: "provenance", label: "Provenance" },
  { id: "history", label: "History" }, { id: "evidence", label: "Evidence lineage" }, { id: "decisions", label: "Decision lineage" }, { id: "actions", label: "Available actions" },
]
const GROUPS: Array<{ id: WorldGroup; label: string }> = [
  { id: "all", label: "All" }, { id: "risks", label: "Risks" }, { id: "committee", label: "Committee" },
  { id: "evidence", label: "Evidence" }, { id: "work", label: "Work" }, { id: "underwriting", label: "Underwriting" },
]
const labelType = (type: string) => type.replace(/^pe_/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase()
const textValue = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : typeof value === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value) ? value.replaceAll("_", " ") : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : value == null ? "No value recorded" : "Structured source value"
const technicalFact = (fact: CompanyBrainFact) => /(^id$|(?:_|\b)id$|Id$|hash$|Hash$|ref$|Ref$|tenant|^version$|graphVersion|sourceSystem|observedAt)/i.test(fact.key) || (typeof fact.value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{23,}$/i.test(fact.value))
const validDate = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
const rootKey = (root: PeWorldRootRef) => `${root.entityType}:${root.entityId}`
function inGroup(node: CompanyBrainNode, group: WorldGroup) {
  if (group === "all") return true
  if (group === "risks") return /risk|finding|dissent|conflict/.test(node.type)
  if (group === "committee") return /ic_|decision|vote/.test(node.type)
  if (group === "evidence") return /evidence|source|document|artifact/.test(node.type)
  if (group === "work") return /work|plan|action|effect|receipt|attention|agent/.test(node.type)
  return /underwriting|assumption|scenario|sensitivity/.test(node.type)
}
function worldPriority(node: CompanyBrainNode, root: PeWorldRootRef | null): number {
  if (root && node.ref.type === root.entityType && node.ref.id === root.entityId) return 0
  if (node.type === "pe_deal_risk") return 1
  if (node.type === "pe_finding") return 2
  if (node.type === "pe_closing_condition" || node.type === "pe_closing_item") return 3
  if (node.type === "pe_ic_decision_proposal" || node.type === "pe_decision") return 4
  if (node.type === "underwriting_run") return 5
  if (/work/.test(node.type)) return 6
  if (/attention/.test(node.type)) return 7
  return 10
}

export function WorldExplorer({ root, projection, projectionStatus, projectionError, initialObject, onSelectRoot, onSelectObject, onAsk, onRefresh }: {
  root: PeWorldRootRef | null
  projection: CompanyBrainProjection | null
  projectionStatus: "idle" | "loading" | "ready" | "error"
  projectionError: string | null
  initialObject: CompanyBrainObjectRef | null
  onSelectRoot: (root: PeWorldRootRef) => void
  onSelectObject: (ref: CompanyBrainObjectRef) => void
  onAsk: (node: CompanyBrainNode, prompt?: string) => void
  onRefresh: () => void
}) {
  const roots = useCompanyBrainRoots()
  const [query, setQuery] = useState("")
  const [searchResults, setSearchResults] = useState<CompanyBrainSearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [group, setGroup] = useState<WorldGroup>("all")
  const [controlsOpen, setControlsOpen] = useState(false)
  const [closingControlsOpen, setClosingControlsOpen] = useState(false)
  const [selected, setSelected] = useState<CompanyBrainObjectRef | null>(initialObject)
  const [tab, setTab] = useState<WorldTab>(initialObject?.type === "work" ? "record" : "overview")
  const [detail, setDetail] = useState<Detail>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const rootsList = useMemo(() => [...new Map((roots.data ?? []).flatMap((result) => result.rootRefs.map((ref) => [rootKey(ref), { root: ref, label: result.ref.id === ref.entityId ? result.label : `${labelType(ref.entityType)} · ${ref.entityId.slice(0, 8)}` }]))).values()], [roots.data])

  const initialKey = initialObject ? refKey(initialObject) : null
  // Reset for URL identity changes, not for a new parsed object with the same identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSelected(initialObject); setTab(initialObject?.type === "work" ? "record" : "overview"); setQuery(""); setSearchResults(null) }, [initialKey, root?.entityType, root?.entityId])
  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); setSearchError(null); setSearching(false); return }
    let active = true
    const timer = window.setTimeout(() => {
      setSearching(true)
      void centropyPost<{ results: CompanyBrainSearchResult[] }>("company-brain/search", { query: query.trim(), ...(root ? { root: { entityType: root.entityType, entityId: root.entityId } } : {}), limit: 50 })
        .then((result) => { if (active) { setSearchResults(Array.isArray(result.results) ? result.results : []); setSearchError(null) } })
        .catch((cause) => { if (active) { setSearchResults(null); setSearchError(cause instanceof Error ? cause.message : "Search unavailable") } })
        .finally(() => { if (active) setSearching(false) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, root])

  const selectedNode = projection?.nodes.find((node) => selected && refKey(node.ref) === refKey(selected)) ?? null
  const ordinaryFacts = selectedNode?.facts.filter((fact) => !technicalFact(fact)) ?? []
  const technicalFacts = selectedNode?.facts.filter(technicalFact) ?? []
  const selectedKey = selected ? refKey(selected) : null
  useEffect(() => {
    if (selected || !root || !projection) return
    const rootNode = projection.nodes.find((node) => node.ref.type === root.entityType && node.ref.id === root.entityId)
    if (rootNode) setSelected(rootNode.ref)
  }, [selected, root, projection])
  useEffect(() => {
    if (!root || !selected || !selectedNode || tab === "overview" || tab === "record") { setDetail(null); setDetailError(null); setDetailLoading(false); return }
    let active = true
    setDetail(null); setDetailError(null); setDetailLoading(true)
    const operation = tab === "relationships" ? "traverse" : tab === "evidence" ? "evidence-lineage" : tab === "decisions" ? "decision-lineage" : tab === "actions" ? "available-actions" : tab
    const body = { root: { entityType: root.entityType, entityId: root.entityId }, ref: selected, ...(operation === "traverse" ? { depth: 2, direction: "both", limit: 80 } : {}), ...(operation === "history" ? { limit: 50 } : {}) }
    void centropyPost<Detail>(`company-brain/${operation}`, body)
      .then((result) => { if (active) setDetail(result) })
      .catch((cause) => { if (active) setDetailError(cause instanceof Error ? cause.message : "Object detail unavailable") })
      .finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [root, selectedKey, selectedNode, tab, selected])

  const shownNodes = query.trim() && searchResults && root
    ? searchResults.flatMap((result) => projection?.nodes.find((node) => refKey(node.ref) === refKey(result.ref)) ?? [])
    : [...(projection?.nodes.filter((node) => inGroup(node, group)) ?? [])].sort((left, right) => worldPriority(left, root) - worldPriority(right, root) || left.label.localeCompare(right.label))
  const shownRoots = query.trim() && searchResults && !root
    ? searchResults.flatMap((result) => result.rootRefs.map((candidate) => ({ root: candidate, label: result.label })))
    : rootsList

  function pick(ref: CompanyBrainObjectRef) { setSelected(ref); setTab(ref.type === "work" ? "record" : "overview"); onSelectObject(ref) }
  function selectRoot(next: PeWorldRootRef) { setSelected(null); setGroup("all"); setQuery(""); onSelectRoot(next) }
  const closingDealId = root?.entityType === "pe_deal" ? root.entityId : selectedNode?.rootRefs.find((ref) => ref.entityType === "pe_deal")?.entityId
  const closingType = selectedNode?.type === "pe_closing_condition" ? "closing-waivers" : selectedNode?.type === "pe_closing_item" ? "closing-verification" : null
  const closingVersion = Number(selectedNode?.version)
  const closingEligible = Boolean(selectedNode && (closingType === "closing-waivers" ? ["open", "evidence_pending"].includes(selectedNode.state ?? "") : selectedNode.state === "ready"))

  return <div className="ct-world">
    <header className="ct-world__header"><div><span className="ct-eyebrow">WORLD / COMPANY BRAIN</span><button type="button" onClick={onRefresh} disabled={projectionStatus === "loading"} aria-label="Refresh WORLD projection"><RefreshCw size={15} /> Refresh WORLD</button></div><h2>{root ? projection?.nodes.find((node) => node.ref.type === root.entityType && node.ref.id === root.entityId)?.label ?? "Explore this context" : "Explore institutional truth"}</h2><p>Search connected records, inspect their source trail, and carry an exact object into the Thread.</p></header>
    <div className="ct-world__toolbar"><label><Search size={17} aria-hidden /><span className="ct-visually-hidden">Search WORLD</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={root ? "Search this context…" : "Search all roots…"} /></label><select aria-label="Choose WORLD root" value={root ? rootKey(root) : ""} onChange={(event) => { const found = rootsList.find((item) => rootKey(item.root) === event.target.value); if (found) selectRoot(found.root) }}><option value="">Choose a root</option>{rootsList.map((item) => <option value={rootKey(item.root)} key={rootKey(item.root)}>{item.label}</option>)}</select></div>
    {searching ? <p className="ct-world__status" role="status">Searching canonical records…</p> : null}
    {searchError ? <p className="ct-world__error" role="alert">{searchError}</p> : null}
    {roots.error ? <p className="ct-world__error" role="alert">Roots unavailable: {roots.error}</p> : null}
    {!root ? <div className="ct-world__roots"><span className="ct-eyebrow">START WITH A ROOT</span>{shownRoots.length ? shownRoots.slice(0, 50).map((item) => <button type="button" key={rootKey(item.root)} onClick={() => selectRoot(item.root)}><Globe2 size={18} /><span><strong>{item.label}</strong><small>{labelType(item.root.entityType)}</small></span><ArrowRight size={16} /></button>) : <p>{roots.status === "loading" ? "Loading accessible roots…" : "No matching roots are available."}</p>}</div> : <>
      {projectionStatus === "loading" && !projection ? <p className="ct-world__status" role="status">Loading the authenticated root projection…</p> : null}
      {projectionError ? <p className="ct-world__error" role="alert">Projection unavailable: {projectionError}</p> : null}
      {projection ? <><div className="ct-world__coverage"><span>{projection.nodes.length} connected objects</span><span>{projection.edges.length} relationships</span><span>{projection.bounds.truncated || projection.sourceStatus.some((source) => source.status !== "complete") ? "Partial coverage" : "Supported sources complete"}</span><time dateTime={projection.asOf}>As of {validDate(projection.asOf)}</time></div>
        <div className="ct-world__body"><aside className="ct-world__index" aria-label="WORLD objects"><div className="ct-world__groups" role="group" aria-label="Filter object families">{GROUPS.map((item) => <button type="button" key={item.id} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}</div><div className="ct-world__objects">{shownNodes.slice(0, 80).map((node) => <button type="button" key={refKey(node.ref)} data-selected={selectedNode && refKey(selectedNode.ref) === refKey(node.ref) ? "true" : undefined} onClick={() => pick(node.ref)}><span className="ct-world__object-type">{labelType(node.type)}</span><strong>{node.label}</strong><small>{textValue(node.state ?? node.epistemicState)}</small></button>)}{!shownNodes.length ? <p>No objects match this view.</p> : null}{shownNodes.length > 80 ? <p>Showing the first 80 of {shownNodes.length} objects. Narrow the search to inspect more.</p> : null}</div></aside>
          <section className="ct-world__detail" aria-label="Selected WORLD object">{selectedNode ? <><header><span className="ct-eyebrow">{labelType(selectedNode.type)}</span><h3>{selectedNode.label}</h3><div><span className="ct-truth" data-state={selectedNode.epistemicState}>{selectedNode.epistemicState.toLowerCase()}</span><span>{selectedNode.state ? textValue(selectedNode.state) : null}</span></div><button type="button" onClick={() => onAsk(selectedNode)}>Ask CENTROPY about this <ArrowUpRight size={15} /></button></header><nav aria-label="Object detail">{selectedNode.type === "work" ? <button type="button" aria-current={tab === "record" ? "page" : undefined} onClick={() => setTab("record")}>Work record</button> : null}{TABS.map((item) => <button type="button" key={item.id} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
            {tab === "overview" ? <div className="ct-world__detail-content"><p>{selectedNode.facts.length} recorded fact{selectedNode.facts.length === 1 ? "" : "s"} · {selectedNode.provenanceRefs.length} source link{selectedNode.provenanceRefs.length === 1 ? "" : "s"}</p>{ordinaryFacts.length ? <dl>{ordinaryFacts.slice(0, 30).map((fact) => <div key={fact.key}><dt>{labelType(fact.key)}</dt><dd>{textValue(fact.value)}<span className="ct-truth" data-state={fact.epistemicState}>{fact.epistemicState.toLowerCase()}</span></dd></div>)}</dl> : <p>No descriptive facts are recorded for this object.</p>}{technicalFacts.length ? <details className="ct-world__technical"><summary>Record identifiers and technical fields · {technicalFacts.length}</summary><dl>{technicalFacts.map((fact) => <div key={fact.key}><dt>{labelType(fact.key)}</dt><dd>{textValue(fact.value)}</dd></div>)}</dl></details> : null}{selectedNode.epistemicWarnings.map((warning) => <p className="ct-world__warning" key={warning.propositionId}>{warning.reason}</p>)}</div> : null}
            {tab === "record" && selectedNode.type === "work" ? <WorldWorkRecord key={selectedNode.ref.id} workId={selectedNode.ref.id} onChanged={onRefresh} /> : null}
            {detailLoading ? <p className="ct-world__status" role="status">Reading {tab} from Company Brain…</p> : null}
            {detailError ? <p className="ct-world__error" role="alert">{detailError}</p> : null}
            {tab === "relationships" || tab === "evidence" || tab === "decisions" ? <div className="ct-world__detail-content"><p>{tab === "relationships" ? "Connected objects" : tab === "evidence" ? "Evidence lineage" : "Decision lineage"}</p>{detail && "nodes" in detail ? <Suspense fallback={<p>Opening connected objects…</p>}><WorldRelationships nodes={detail.nodes} edges={detail.edges} selected={selectedNode} truncated={detail.page?.truncated} onSelect={pick} /></Suspense> : null}</div> : null}
            {tab === "provenance" ? <div className="ct-world__detail-content"><p>Source records and attached evidence</p>{detail && "sourceRefs" in detail ? <><div className="ct-world__detail-count"><Link2 size={16} /> {detail.sourceRefs.length} source links · {detail.evidenceNodes.length} evidence objects</div>{detail.sourceRefs.map((source) => <div className="ct-world__source" key={`${source.owner}:${source.table}:${source.id}:${source.fieldPath ?? ""}`}><strong>{labelType(source.table)}</strong><small>{source.owner} · {source.id.slice(0, 12)}</small></div>)}{detail.evidenceNodes.map((node) => <button className="ct-world__related" key={refKey(node.ref)} type="button" onClick={() => pick(node.ref)}>{node.label} <ArrowRight size={14} /></button>)}</> : null}</div> : null}
            {tab === "history" ? <div className="ct-world__detail-content"><p>Canonical history</p>{detail && "entries" in detail ? <><span className="ct-world__detail-count"><Clock3 size={16} /> {detail.support.replaceAll("_", " ")}</span>{detail.entries.map((entry) => <div className="ct-world__history" key={`${entry.version}:${entry.recordedAt}`}><strong>Version {entry.version}</strong><time dateTime={entry.recordedAt}>{validDate(entry.recordedAt)}</time></div>)}{!detail.entries.length ? <p>No version history is supported for this object.</p> : null}</> : null}</div> : null}
            {tab === "actions" ? <div className="ct-world__detail-content"><p>Candidate actions are evaluated against authority when executed.</p>{detail && "actions" in detail ? <>{detail.actions.map((action) => <div className="ct-world__action" key={action.actionType}><ShieldCheck size={17} /><span><strong>{action.label}</strong><small>Authority required at execution</small></span><button type="button" onClick={() => onAsk(selectedNode, capabilityForId(`planner.${action.actionType}`)?.humanOnly ? `Open the canonical record for ${selectedNode.label} so I can review its human decision controls.` : `Prepare this governed action for ${selectedNode.label}: ${action.label}. Verify authority and effects before execution.`)}>{capabilityForId(`planner.${action.actionType}`)?.humanOnly ? "Open record" : "Ask"} <ArrowRight size={13} /></button></div>)}{!detail.actions.length ? <p>No candidate action is recorded for this object.</p> : null}</> : null}</div> : null}
          </> : <div className="ct-world__detail-empty"><Globe2 size={25} /><h3>Select a connected object</h3><p>Its facts, provenance, relationships, and decision lineage will open here.</p></div>}</section></div>
      </> : null}
    </>}
    {root && projection ? <details className="ct-record-controls" onToggle={(event) => setControlsOpen(event.currentTarget.open)}><summary>Review institutional and model record changes</summary><p>Record known identities, responsibilities, authority, evidence, or model bindings in the selected investment context.</p>{controlsOpen ? <Suspense fallback={<p>Opening record controls…</p>}><HumanControlDesk groups={["institutional-records", "model-records", "workflow-controls"]} context={{ root, rootRef: root, dealId: root.entityType === "pe_deal" ? root.entityId : undefined, investmentCaseId: projection.nodes.find((node) => node.type === "pe_investment_case")?.ref.id }} writable={projectionStatus === "ready"} onRecorded={onRefresh} /></Suspense> : null}</details> : null}
    {closingType && selectedNode && closingDealId ? <details id="ct-world-closing-controls" className="ct-record-controls" onToggle={(event) => setClosingControlsOpen(event.currentTarget.open)}><summary>Review this human closing decision</summary><p>You author this decision. Its canonical action is grounded and pauses for a separate exact-effect approval before execution.</p>{closingControlsOpen ? <Suspense fallback={<p>Opening the human decision control…</p>}><HumanControlDesk key={`${selectedNode.ref.id}:${closingVersion}`} groups={[closingType]} context={{ payload: { dealId: closingDealId, ...(closingType === "closing-waivers" ? { closingConditionId: selectedNode.ref.id } : { closingItemId: selectedNode.ref.id }), expectedVersion: closingVersion } }} writable={projectionStatus === "ready" && closingEligible && Number.isInteger(closingVersion) && closingVersion > 0} onRecorded={onRefresh} /></Suspense> : null}</details> : null}
  </div>
}
