"use client"

import { useMemo } from "react"
import { ArrowRight, CircleDot, FileCheck2, GitBranch, RotateCcw, Workflow } from "lucide-react"
import { CompanyBrainInspector } from "./CompanyBrainInspector"
import { PeCommandComposer } from "./PeCommandComposer"
import { PeOwnerBoundary, PeSourceState } from "./PeSurfaceFrame"
import { PeRootPicker } from "./PeRootPicker"
import { PeSurfaceMotion } from "./PeSurfaceMotion"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import { humanize, isInspectionTarget, refKey, type CompanyBrainNode, type CompanyBrainProjection, type InspectionTarget, type SemanticActivityItem } from "./contracts"
import { useCompanyBrainProjection, useSemanticActivity } from "./use-pe-data"

function targetWorkId(target: InspectionTarget): string | null {
  return "workId" in target && typeof target.workId === "string" ? target.workId : null
}

const STAGES: Array<{ key: string; label: string; types: ReadonlySet<string>; icon: typeof Workflow }> = [
  { key: "intent", label: "Work + goal", types: new Set(["work", "goal"]), icon: CircleDot },
  { key: "plan", label: "Plan", types: new Set(["plan_revision", "plan_node"]), icon: GitBranch },
  { key: "execution", label: "Execution", types: new Set(["domain_action", "business_effect"]), icon: Workflow },
  { key: "proof", label: "Proof", types: new Set(["decision_receipt", "completion_proof"]), icon: FileCheck2 },
  { key: "recovery", label: "Recovery", types: new Set(["attention"]), icon: RotateCcw },
]

function WorkNode({ node }: { node: CompanyBrainNode }) {
  const operating = usePeOperatingContext()
  if (!isInspectionTarget(node.inspectionTarget)) return null
  return <button type="button" className="pe-work-node" data-state={node.state ?? node.epistemicState} onClick={() => operating.inspect(node.inspectionTarget, node.ref)}><span><b>{humanize(node.type)}</b><em data-state={node.epistemicState}>{node.epistemicState}</em></span><strong>{node.label}</strong><p>{node.state ?? "state unknown"} · {node.ref.id.slice(0, 12)}…</p><small>{node.provenanceRefs.map((source) => `${source.table}:${source.id.slice(0, 8)}…`).join(" · ")}</small></button>
}

function WorkActivity({ items }: { items: SemanticActivityItem[] }) {
  const operating = usePeOperatingContext()
  if (!items.length) return <p className="pe-known-empty">Known empty: no semantic event is attributed to this Work.</p>
  return <div className="pe-work-activity">{items.map((item) => isInspectionTarget(item.inspectionTarget) ? <button type="button" key={item.id} data-bucket={item.bucket} onClick={() => operating.inspect(item.inspectionTarget, item.subjectRef)}><span>{new Date(item.occurredAt).toLocaleString()}</span><strong>{item.change.label}</strong><small>{item.causalRefs.length ? `${item.causalRefs.length} persisted cause${item.causalRefs.length === 1 ? "" : "s"}` : "no persisted cause"} · {item.sourceRefs[0]?.table}:{item.sourceRefs[0]?.id.slice(0, 8)}…</small></button> : null)}</div>
}

function WorkSpine({ projection, workId }: { projection: CompanyBrainProjection; workId: string }) {
  const workNodes = useMemo(() => projection.nodes.filter((node) => targetWorkId(node.inspectionTarget) === workId), [projection.nodes, workId])
  const keys = useMemo(() => new Set(workNodes.map((node) => refKey(node.ref))), [workNodes])
  const edges = useMemo(() => projection.edges.filter((edge) => keys.has(refKey(edge.fromRef)) && keys.has(refKey(edge.toRef))), [keys, projection.edges])
  return <section className="pe-work-spine pe-scale-reveal"><header><div><span className="pe-kicker">WORK CAUSAL SPINE</span><h2>Plan, execution, effect, and proof stay inspectable.</h2></div><p>{workNodes.length} objects · {edges.length} persisted relationships</p></header><div className="pe-work-spine__stages">{STAGES.map(({ key, label, types, icon: Icon }, index) => { const nodes = workNodes.filter((node) => types.has(node.type)); return <section key={key} className="pe-work-stage"><header><span>{String(index + 1).padStart(2, "0")}</span><Icon size={14} /><b>{label}</b></header>{nodes.length ? nodes.map((node) => <WorkNode key={refKey(node.ref)} node={node} />) : <p>Known empty</p>}{index < STAGES.length - 1 ? <ArrowRight className="pe-work-stage__arrow" size={16} aria-hidden /> : null}</section> })}</div><footer><span>RELATIONSHIP SOURCES</span>{edges.length ? edges.slice(0, 20).map((edge) => <code key={`${edge.relationship}:${edge.sourceRef.id}`}>{humanize(edge.relationship)} · {edge.sourceRef.table}:{edge.sourceRef.id}</code>) : <p>No persisted edge joins the Work objects shown.</p>}</footer></section>
}

function WorkWorkspace() {
  const operating = usePeOperatingContext()
  const brain = useCompanyBrainProjection(operating.context.root)
  const activity = useSemanticActivity(operating.context.root)
  const works = useMemo(() => brain.data?.nodes.filter((node) => node.type === "work" && node.inspectionTarget.kind === "work") ?? [], [brain.data])
  const selectedWorkId = operating.context.workId
  const selectedWork = works.find((node) => node.ref.id === selectedWorkId) ?? null
  const workActivity = activity.data?.items.filter((item) => item.workId === selectedWorkId) ?? []

  return <PeSurfaceMotion><main className="pe-work"><header className="pe-work__hero" data-pe-hero-enter><div><span className="pe-kicker">WORK · PLAN · EXECUTION · PROOF · RECOVERY</span><h1>Every operating move remains attached to its proof.</h1><p>Work is rendered only when a persisted PE link brings it into the current Company Brain root.</p></div><div><PeCommandComposer surface="work" /></div></header><section className="pe-work__layout" data-pe-pin-zone><aside className="pe-work__rail"><PeRootPicker compact /><div className="pe-work-list"><header><span>ROOT-LINKED WORK</span><b>{brain.status === "ready" ? works.length : "—"}</b></header>{works.length ? works.map((work) => <button key={work.ref.id} type="button" data-active={selectedWorkId === work.ref.id ? "true" : "false"} onClick={() => operating.inspect(work.inspectionTarget, work.ref)}><Workflow size={13} /><span><strong>{work.label}</strong><small>{work.state ?? work.epistemicState} · {work.ref.id.slice(0, 8)}…</small></span><ArrowRight size={12} /></button>) : brain.status === "ready" ? <p>Known empty: this root has no persisted Work link.</p> : null}</div></aside><div className="pe-work__center">
    {!operating.context.root ? <section className="pe-home__no-context"><Workflow size={22} /><span className="pe-kicker">NO ROOT SELECTED</span><h2>Select a canonical PE context.</h2><p>Work will be constrained to exact persisted links from that root.</p></section> : null}
    {brain.status === "loading" ? <div className="pe-loading"><span className="pe-state__pulse" /> Resolving root-linked Work…</div> : null}
    {brain.status === "error" ? <PeSourceState title="Work projection unavailable" detail={brain.error ?? "Company Brain could not compose P6 Work."} retry={brain.reload} /> : null}
    {brain.data && !selectedWork ? <section className="pe-home__no-context"><GitBranch size={22} /><span className="pe-kicker">WORK SELECTION</span><h2>{works.length ? "Choose exact Work from the left rail." : "No linked Work is recorded."}</h2><p>{works.length ? "The selected Work ID will become part of the typed PE operating context." : "No generic tenant Work is substituted into this root."}</p></section> : null}
    {brain.data && selectedWork && selectedWorkId ? <><header className="pe-object-center"><span>SELECTED WORK</span><h2>{selectedWork.label}</h2><p>{selectedWork.ref.id} · {selectedWork.state ?? selectedWork.epistemicState}</p></header><WorkSpine projection={brain.data} workId={selectedWorkId} /><section className="pe-work__activity"><header><div><span className="pe-kicker">WORK ACTIVITY</span><h2>Exact semantic events attributed to this Work.</h2></div><p>{workActivity.length} events</p></header>{activity.status === "error" ? <PeSourceState title="Work Activity unavailable" detail={activity.error ?? "Semantic activity could not be read."} retry={activity.reload} /> : <WorkActivity items={workActivity} />}</section></> : null}
  </div><div data-pe-pin-inspector>{brain.data ? <CompanyBrainInspector projection={brain.data} /> : <aside className="pe-inspector"><div className="pe-inspector__empty"><strong>No Work object selected</strong><p>Select a root and exact Work.</p></div></aside>}</div></section></main></PeSurfaceMotion>
}

export default function WorkSurface() {
  return <PeOwnerBoundary active="work"><WorkWorkspace /></PeOwnerBoundary>
}
