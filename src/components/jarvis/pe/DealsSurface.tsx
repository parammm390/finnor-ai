"use client"

import { useMemo, useState } from "react"
import { BriefcaseBusiness, Search } from "lucide-react"
import { BrainLensBar, CompanyBrainGraph, type BrainLens } from "./CompanyBrainGraph"
import { CompanyBrainInspector } from "./CompanyBrainInspector"
import { PeOwnerBoundary, PeSourceState } from "./PeSurfaceFrame"
import { PeRootPicker } from "./PeRootPicker"
import { PeSurfaceMotion } from "./PeSurfaceMotion"
import { SemanticActivityTheater } from "./SemanticActivityTheater"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import { humanize, refKey } from "./contracts"
import { useCompanyBrainProjection, useSemanticActivity } from "./use-pe-data"

function DealsWorkspace() {
  const operating = usePeOperatingContext()
  const brain = useCompanyBrainProjection(operating.context.root)
  const activity = useSemanticActivity(operating.context.root)
  const [lens, setLens] = useState<BrainLens>("overview")
  const [query, setQuery] = useState("")
  const selected = useMemo(() => brain.data?.nodes.find((node) => operating.context.selectedObject && refKey(node.ref) === refKey(operating.context.selectedObject)) ?? null, [brain.data, operating.context.selectedObject])

  return <PeSurfaceMotion><main className="pe-deals">
    <header className="pe-deals__hero" data-pe-hero-enter><div><span className="pe-kicker">DEALS · COMPANY BRAIN</span><h1>The investment object is the center of execution.</h1><p>Navigate one authenticated world across Strategy, Opportunity, Deal, Investment Case, underwriting, diligence, IC, evidence, Work, and Activity.</p></div><div className="pe-deals__hero-stat"><BriefcaseBusiness size={17} /><span><b>{brain.data ? brain.data.nodes.filter((node) => node.type === "pe_deal").length : "—"}</b><small>Deal objects in current root</small></span></div></header>
    <BrainLensBar active={lens} onChange={setLens} />
    <section className="pe-deals__workspace" data-pe-pin-zone>
      <aside className="pe-deals__rail"><PeRootPicker compact /><label className="pe-brain-search"><Search size={13} /><span>Search current projection</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Object, type, or exact ID" /></label>{brain.data ? <div className="pe-deals__source-ledger"><span>PROJECTION SOURCES</span>{brain.data.sourceStatus.map((source) => <div key={source.owner} data-status={source.status}><b>{source.owner}</b><small>{source.status}{source.reason ? ` · ${source.reason}` : ""}</small></div>)}</div> : null}</aside>
      <div className="pe-deals__center">
        {!operating.context.root ? <section className="pe-home__no-context"><BriefcaseBusiness size={22} /><span className="pe-kicker">NO ROOT SELECTED</span><h2>Choose the exact investment context.</h2><p>Only canonical tenant-scoped Strategy, Opportunity, and Deal roots appear in the selector.</p></section> : null}
        {operating.validationStatus === "invalid" ? <PeSourceState title="Context rejected" detail={operating.validationError ?? "The requested object is not part of this authenticated root."} /> : null}
        {brain.status === "loading" ? <div className="pe-loading"><span className="pe-state__pulse" /> Resolving Company Brain…</div> : null}
        {brain.status === "error" ? <PeSourceState title="Company Brain unavailable" detail={brain.error ?? "The projection source failed."} retry={brain.reload} /> : null}
        {brain.data && lens !== "activity" ? <><header className="pe-object-center"><span>SELECTED OBJECT</span><h2>{selected?.label ?? humanize(brain.data.root.entityType)}</h2><p>{selected ? `${humanize(selected.type)} · ${selected.state ?? selected.epistemicState} · ${selected.ref.id}` : `${brain.data.root.entityId} · select any inspectable object below`}</p></header><CompanyBrainGraph projection={brain.data} lens={lens} query={query} /></> : null}
        {lens === "activity" && activity.data ? <SemanticActivityTheater projection={activity.data} /> : null}
        {lens === "activity" && activity.status === "loading" ? <div className="pe-loading"><span className="pe-state__pulse" /> Resolving semantic Activity…</div> : null}
        {lens === "activity" && activity.status === "error" ? <PeSourceState title="Semantic Activity unavailable" detail={activity.error ?? "The deterministic activity projection failed."} retry={activity.reload} /> : null}
      </div>
      <div data-pe-pin-inspector>{brain.data ? <CompanyBrainInspector projection={brain.data} /> : <aside className="pe-inspector"><div className="pe-inspector__empty"><strong>No inspectable object</strong><p>Select a canonical root first.</p></div></aside>}</div>
    </section>
  </main></PeSurfaceMotion>
}

export default function DealsSurface() {
  return <PeOwnerBoundary active="deals"><DealsWorkspace /></PeOwnerBoundary>
}
