"use client"

import { Activity, ArrowRight, BrainCircuit, CheckCircle2, CircleAlert, Network, Workflow } from "lucide-react"
import { CompanyBrainGraph } from "./pe/CompanyBrainGraph"
import { CompanyBrainInspector } from "./pe/CompanyBrainInspector"
import { PeCommandComposer } from "./pe/PeCommandComposer"
import { PeOwnerBoundary, PeSourceState } from "./pe/PeSurfaceFrame"
import { PeRootPicker } from "./pe/PeRootPicker"
import { PeSurfaceMotion } from "./pe/PeSurfaceMotion"
import { SemanticActivityTheater } from "./pe/SemanticActivityTheater"
import { usePeOperatingContext } from "./pe/PeOperatingContextProvider"
import { humanize } from "./pe/contracts"
import { peProjectionMetrics } from "./pe/projection-metrics"
import { useCompanyBrainProjection, useSemanticActivity } from "./pe/use-pe-data"

function semanticCount(value: number | null): string | number {
  return value === null ? "UNKNOWN" : value
}

function OwnerHome() {
  const operating = usePeOperatingContext()
  const brain = useCompanyBrainProjection(operating.context.root)
  const activity = useSemanticActivity(operating.context.root)
  const metrics = brain.data ? peProjectionMetrics(brain.data, activity.data) : null

  return (
    <PeSurfaceMotion>
      <main className="pe-home">
        <section className="pe-home__hero">
          <div className="pe-home__hero-copy" data-pe-hero-enter>
            <span className="pe-kicker">FINNOR · PRIVATE EQUITY DECISION + EXECUTION INFRASTRUCTURE</span>
            <h1>One command surface for the full investment decision.</h1>
            <p>Inspect canonical deal truth, trace evidence into decisions, and move approved work through execution without separating the operating context from its proof.</p>
          </div>
          <div data-pe-hero-enter><PeCommandComposer surface="home" /></div>
          <div data-pe-hero-enter><PeRootPicker compact /></div>
        </section>

        <div className="pe-context-marquee" aria-label="Canonical system owners"><div>{["P1 · PE REALITY", "P4 · UNDERWRITING", "P5 · IC GOVERNANCE", "P6 · WORK + PROOF", "P7 · GOVERNED WORKFORCE", "COMPANY BRAIN · READ PROJECTION", "SEMANTIC ACTIVITY · DETERMINISTIC"].concat(["P1 · PE REALITY", "P4 · UNDERWRITING", "P5 · IC GOVERNANCE", "P6 · WORK + PROOF"]).map((label, index) => <span key={`${label}:${index}`}><i />{label}</span>)}</div></div>

        {!operating.context.root ? <section className="pe-home__no-context pe-scale-reveal"><BrainCircuit size={24} /><span className="pe-kicker">SOURCE-BACKED CONTEXT REQUIRED</span><h2>Select a Strategy, Opportunity, or Deal root.</h2><p>JARVIS will not manufacture the Strategy → Opportunity → Deal → Investment Case chain from URL parameters. The selected root is resolved tenant-safely before any projection is shown.</p></section> : null}
        {operating.validationStatus === "invalid" ? <PeSourceState title="Operating context rejected" detail={operating.validationError ?? "The selected object or Work does not belong to this authenticated PE root."} /> : null}
        {brain.status === "error" ? <PeSourceState title="Company Brain unavailable" detail={brain.error ?? "The root projection failed."} retry={brain.reload} /> : null}
        {brain.status === "loading" && !brain.data ? <div className="pe-loading"><span className="pe-state__pulse" /> Resolving P1–P7 into one inspectable world…</div> : null}

        {brain.data && metrics ? <>
          <section className="pe-home__metrics pe-scale-reveal" aria-label="Root-scoped operating metrics">
            <article className="pe-metric pe-metric--hero"><span><Network size={15} /> Closing checks</span><strong>{metrics.closingChecks.ready}<small> / {metrics.closingChecks.recorded}</small></strong><p>Satisfied, waived, or verified canonical closing objects. This is not a close-eligibility claim.</p></article>
            <article className="pe-metric"><span>Open deals</span><strong>{metrics.openDeals}</strong><p>Active Deal objects in this root.</p></article>
            <article className="pe-metric"><span>Open requests</span><strong>{metrics.openRequests}</strong><p>Open or acknowledged diligence requests.</p></article>
            <article className="pe-metric"><span>Critical risks</span><strong>{metrics.criticalDealRisks}</strong><p>Open risks with persisted critical severity.</p></article>
            <article className="pe-metric"><span>Approval actions</span><strong>{metrics.pendingApprovalActions}</strong><p>Root-linked DomainActions in pending state.</p></article>
            <article className="pe-metric pe-metric--activity"><span><Activity size={14} /> Semantic movement</span><div><b><CircleAlert size={12} /> {semanticCount(metrics.needsAttention)} attention</b><b><Workflow size={12} /> {semanticCount(metrics.inMotion)} in motion</b><b><CheckCircle2 size={12} /> {semanticCount(metrics.verifiedOutcomes)} verified</b></div><p>{activity.data ? "Exact semantic events, not raw telemetry rows." : "Semantic source unresolved; no zero count is inferred."}</p></article>
          </section>

          <section className="pe-home__brain" data-pe-pin-zone>
            <div><header className="pe-section-heading"><div><span className="pe-kicker">CURRENT CONTEXT</span><h2>{humanize(brain.data.root.entityType)} · one connected operating world.</h2></div><p>{brain.data.nodes.length} objects · {brain.data.edges.length} sourced relationships · {brain.data.temporal.completeness}</p></header><CompanyBrainGraph projection={brain.data} /></div>
            <div data-pe-pin-inspector><CompanyBrainInspector projection={brain.data} /></div>
          </section>

          {activity.status === "error" ? <PeSourceState title="Semantic Activity unavailable" detail={activity.error ?? "The deterministic activity projection failed."} retry={activity.reload} /> : null}
          {activity.data ? <SemanticActivityTheater projection={activity.data} /> : activity.status === "loading" ? <div className="pe-loading"><span className="pe-state__pulse" /> Building semantic activity from canonical change records…</div> : null}
          <section className="pe-home__cta pe-scale-reveal"><div><span className="pe-kicker">NEXT OPERATING MOVE</span><h2>Keep the object, Work, evidence, and authority chain together.</h2><p>Use Deals for object context, Work for plans and proof, and Agents for governed assignment and learning. The selected canonical root travels with you.</p></div><a href="#company-brain-graph">Return to Company Brain <ArrowRight size={14} /></a></section>
        </> : null}
      </main>
    </PeSurfaceMotion>
  )
}

export default function PersonalizedHome() {
  return <PeOwnerBoundary active="home"><OwnerHome /></PeOwnerBoundary>
}
