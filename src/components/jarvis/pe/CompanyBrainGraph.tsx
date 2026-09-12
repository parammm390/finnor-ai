"use client"

import { ArrowRight, Box, CircleDot, Network } from "lucide-react"
import { useMemo } from "react"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import { humanize, isInspectionTarget, refKey, type CompanyBrainNode, type CompanyBrainProjection } from "./contracts"

export const BRAIN_LENSES = ["overview", "investment_case", "underwriting", "diligence", "ic", "evidence_documents", "work", "activity"] as const
export type BrainLens = (typeof BRAIN_LENSES)[number]

export const BRAIN_LENS_LABELS: Record<BrainLens, string> = {
  overview: "Overview",
  investment_case: "Investment Case",
  underwriting: "Underwriting",
  diligence: "Diligence",
  ic: "IC",
  evidence_documents: "Evidence & Documents",
  work: "Work",
  activity: "Activity",
}

const LENS_TYPES: Record<Exclude<BrainLens, "overview" | "activity">, ReadonlySet<string>> = {
  investment_case: new Set(["pe_investment_case", "pe_thesis", "pe_assumption", "pe_decision"]),
  underwriting: new Set(["underwriting_model", "underwriting_model_version", "underwriting_scenario", "underwriting_run", "underwriting_sensitivity"]),
  diligence: new Set(["pe_workstream", "pe_request", "pe_deliverable", "pe_finding", "pe_deal_risk", "pe_dependency", "pe_milestone", "pe_closing_condition", "pe_closing_item"]),
  ic: new Set(["pe_ic_case", "pe_ic_memo", "pe_ic_question", "pe_ic_recommendation", "pe_ic_vote", "pe_ic_dissent", "pe_ic_condition", "pe_ic_decision_proposal"]),
  evidence_documents: new Set(["document", "document_version", "evidence_source", "evidence_version", "source_observation", "source_coverage", "source_conflict", "pe_document_link", "pe_evidence_link"]),
  work: new Set(["work", "goal", "plan_revision", "plan_node", "domain_action", "business_effect", "decision_receipt", "completion_proof", "attention", "agent_profile", "agent_revision", "agent_assignment", "learning_revision"]),
}

export function nodesForLens(projection: CompanyBrainProjection, lens: BrainLens): CompanyBrainNode[] {
  if (lens === "overview" || lens === "activity") return projection.nodes
  const allowed = LENS_TYPES[lens]
  return projection.nodes.filter((node) => allowed.has(node.type))
}

function stateLabel(node: CompanyBrainNode): string {
  return node.state ?? node.epistemicState
}

export function BrainLensBar({ active, onChange }: { active: BrainLens; onChange: (lens: BrainLens) => void }) {
  return <div className="pe-lenses" role="tablist" aria-label="Company Brain semantic lenses">{BRAIN_LENSES.map((lens) => <button key={lens} type="button" role="tab" aria-selected={active === lens} data-active={active === lens ? "true" : "false"} onClick={() => onChange(lens)}><span>{BRAIN_LENS_LABELS[lens]}</span><ArrowRight size={12} /></button>)}</div>
}

export function CompanyBrainGraph({ projection, lens = "overview", query = "" }: { projection: CompanyBrainProjection; lens?: BrainLens; query?: string }) {
  const operating = usePeOperatingContext()
  const normalized = query.trim().toLocaleLowerCase()
  const visibleNodes = useMemo(() => nodesForLens(projection, lens)
    .filter((node) => isInspectionTarget(node.inspectionTarget))
    .filter((node) => !normalized || node.label.toLocaleLowerCase().includes(normalized) || node.type.toLocaleLowerCase().includes(normalized) || node.ref.id.toLocaleLowerCase().includes(normalized))
    .slice(0, 100), [lens, normalized, projection])
  const visibleKeys = useMemo(() => new Set(visibleNodes.map((node) => refKey(node.ref))), [visibleNodes])
  const visibleEdges = useMemo(() => projection.edges.filter((edge) => visibleKeys.has(refKey(edge.fromRef)) && visibleKeys.has(refKey(edge.toRef))).slice(0, 120), [projection.edges, visibleKeys])
  const nodeIndex = useMemo(() => new Map(projection.nodes.map((node) => [refKey(node.ref), node])), [projection.nodes])
  const selectedKey = operating.context.selectedObject ? refKey(operating.context.selectedObject) : null

  return (
    <section className="pe-brain-graph pe-scale-reveal" id="company-brain-graph" aria-labelledby="company-brain-graph-title">
      <header><span><Network size={15} /><b id="company-brain-graph-title">Company Brain</b></span><small>{visibleNodes.length} visible objects · {visibleEdges.length} visible sourced relationships</small></header>
      {visibleNodes.length === 0 ? <div className="pe-brain-graph__empty"><Box size={18} /><strong>Known empty for this lens</strong><p>The current root projection returned no inspectable objects matching this semantic lens.</p></div> : <div className="pe-brain-graph__nodes">{visibleNodes.map((node) => <button key={refKey(node.ref)} type="button" className="pe-brain-node" data-selected={selectedKey === refKey(node.ref) ? "true" : "false"} data-epistemic={node.epistemicState} onClick={() => operating.inspect(node.inspectionTarget, node.ref)}><span className="pe-brain-node__type"><CircleDot size={11} /> {humanize(node.type)}</span><strong>{node.label}</strong><small>{stateLabel(node)}</small><span className="pe-brain-node__source">{node.provenanceRefs[0]?.table ?? "source unavailable"}</span></button>)}</div>}
      <div className="pe-brain-edges" aria-label="Persisted relationship ledger">
        <header><span>RELATIONSHIPS</span><small>Every row names its persisted source.</small></header>
        {visibleEdges.length === 0 ? <p>No persisted relationship joins the visible objects.</p> : visibleEdges.map((edge) => {
          const from = nodeIndex.get(refKey(edge.fromRef)); const to = nodeIndex.get(refKey(edge.toRef))
          if (!from || !to || !isInspectionTarget(from.inspectionTarget) || !isInspectionTarget(to.inspectionTarget)) return null
          return <div className="pe-brain-edge" key={`${edge.relationship}:${refKey(edge.fromRef)}:${refKey(edge.toRef)}:${edge.sourceRef.id}`}><button type="button" onClick={() => operating.inspect(from.inspectionTarget, from.ref)}>{from.label}</button><span><ArrowRight size={12} />{humanize(edge.relationship)}</span><button type="button" onClick={() => operating.inspect(to.inspectionTarget, to.ref)}>{to.label}</button><code>{edge.sourceRef.table}:{edge.sourceRef.id.slice(0, 8)}…</code></div>
        })}
      </div>
      {nodesForLens(projection, lens).length > 100 ? <footer>Visual bound reached: 100 of {nodesForLens(projection, lens).length} inspectable objects shown. No hidden object is summarized as absent.</footer> : null}
    </section>
  )
}
