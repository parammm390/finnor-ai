"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowRight, Calculator, FileCheck2, GitCompareArrows, ShieldCheck } from "lucide-react"
import { jarvisGet } from "../lib/api"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import { DEAL_SECTION_KEYS, type DealSectionKey, withPeOperatingContext } from "../pe/context-routing"
import { humanize, isInspectionTarget, refKey, type CompanyBrainNode, type CompanyBrainProjection, type InspectionTarget, type SemanticActivityItem } from "../pe/contracts"
import { useCommandInterface } from "./CommandInterface"
import { usePeProductData } from "./ProductDataProvider"
import type { IcWorkspace, UnderwritingLineage, UnderwritingRun, UnderwritingWorkspace } from "./contracts"
import { closingReadiness, fact, isTerminalClosing, productNodeLabel, textFact, workObjectiveLabel } from "./deal-model"
import { ActionBar, ContextHeader, DataTable, EmptyState, EntityLink, ErrorState, EvidenceLink, Skeleton, Status, TruthState } from "./primitives"
import type { ProductTruthState } from "./source-health"
import { useProductRequest } from "./useProductRequest"

const LABELS: Record<DealSectionKey, string> = {
  overview: "Overview", underwriting: "Underwriting", diligence: "Diligence", ic: "IC", evidence: "Evidence", closing: "Closing", work: "Work", activity: "Activity",
}

function nodeTruth(node: CompanyBrainNode): ProductTruthState {
  if (node.epistemicState === "CONFLICTING") return "CONFLICTING"
  if (node.epistemicState === "STALE") return "STALE"
  if (node.epistemicState === "UNKNOWN") return "UNKNOWN"
  return node.provenanceRefs.length ? "KNOWN" : "KNOWN_EMPTY"
}

function NodesTable({ label, nodes, projection, empty }: { label: string; nodes: CompanyBrainNode[]; projection: CompanyBrainProjection; empty: string }) {
  const operating = usePeOperatingContext()
  if (!nodes.length) return <EmptyState title={`Known empty: ${label}`} detail={empty} />
  return <DataTable label={label}><thead><tr><th>Object</th><th>State</th><th>Truth</th><th>Evidence / provenance</th><th>Next governed action</th></tr></thead><tbody>{nodes.map((node) => { const nodeLabel = productNodeLabel(node, projection.nodes, projection.edges); return <tr key={refKey(node.ref)}><td>{isInspectionTarget(node.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{nodeLabel}</EntityLink> : nodeLabel}<small className="pw-cell-meta">{humanize(node.type)}</small></td><td><Status value={node.state} /></td><td><TruthState state={nodeTruth(node)} compact /></td><td>{node.provenanceRefs.length ? <EvidenceLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{node.provenanceRefs.length} persisted source{node.provenanceRefs.length === 1 ? "" : "s"}</EvidenceLink> : "No recorded provenance"}</td><td>{node.availableActions[0]?.label ?? "Inspect only"}</td></tr> })}</tbody></DataTable>
}

function newest(nodes: CompanyBrainNode[]): CompanyBrainNode | null {
  return [...nodes].sort((left, right) => right.asOf.localeCompare(left.asOf) || String(right.version ?? "").localeCompare(String(left.version ?? "")))[0] ?? null
}

function OverviewSection({ projection, activity }: { projection: CompanyBrainProjection; activity: SemanticActivityItem[] }) {
  const thesis = projection.nodes.filter((node) => node.type === "pe_thesis")
  const assumptions = projection.nodes.filter((node) => node.type === "pe_assumption" && ["critical", "high", "material"].includes(String(fact(node, "materiality") ?? "").toLocaleLowerCase()))
  const decision = newest(projection.nodes.filter((node) => node.type === "pe_decision"))
  const underwriting = newest(projection.nodes.filter((node) => node.type === "underwriting_run"))
  const risks = projection.nodes.filter((node) => node.type === "pe_deal_risk" && !["resolved", "accepted"].includes((node.state ?? "").toLocaleLowerCase()))
  const critical = risks.filter((node) => String(fact(node, "severity") ?? "").toLocaleLowerCase() === "critical")
  const findings = projection.nodes.filter((node) => node.type === "pe_finding" && !["resolved", "accepted", "closed"].includes((node.state ?? "").toLocaleLowerCase()))
  const requests = projection.nodes.filter((node) => node.type === "pe_request" && !["completed", "fulfilled", "resolved", "closed", "cancelled", "withdrawn"].includes((node.state ?? "").toLocaleLowerCase()))
  const work = projection.nodes.filter((node) => node.type === "work" && !["completed", "cancelled", "failed"].includes((node.state ?? "").toLocaleLowerCase()))
  const closing = projection.nodes.filter((node) => node.type === "pe_closing_condition" || node.type === "pe_closing_item")
  const closingBlockers = closing.filter((node) => !isTerminalClosing(node))
  const verified = [...activity].filter((item) => item.bucket === "verified_outcomes").sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
  return <div className="pw-deal-section"><section className="pw-summary-grid" aria-label="Deal synthesis">
    <article><span>Investment thesis</span><strong>{thesis.length ? productNodeLabel(thesis[0]!, projection.nodes, projection.edges) : "No recorded thesis"}</strong><p>{thesis.length > 1 ? `${thesis.length} canonical thesis objects` : thesis[0] ? String(textFact(thesis[0], "summary") ?? thesis[0].state ?? "No recorded summary") : "KNOWN_EMPTY"}</p></article>
    <article><span>Material assumptions</span><strong>{assumptions.length}</strong><p>{assumptions[0] ? productNodeLabel(assumptions[0], projection.nodes, projection.edges) : "No assumption marked material"}</p></article>
    <article><span>Current Decision</span><strong>{decision ? productNodeLabel(decision, projection.nodes, projection.edges) : "No recorded Decision"}</strong><p>{decision?.state ?? "KNOWN_EMPTY"}</p></article>
    <article><span>Latest underwriting result</span><strong>{underwriting?.state ?? "No recorded run"}</strong><p>{underwriting ? `${underwriting.label} · ${String(fact(underwriting, "validity") ?? "validity UNKNOWN")}` : "KNOWN_EMPTY"}</p></article>
    <article data-tone={critical.length ? "blocked" : "neutral"}><span>Critical risks</span><strong>{critical.length}</strong><p>{risks.length} open recorded risk{risks.length === 1 ? "" : "s"}; absence is not clearance.</p></article>
    <article data-tone={findings.length ? "attention" : "neutral"}><span>Open findings</span><strong>{findings.length}</strong><p>{findings[0] ? productNodeLabel(findings[0], projection.nodes, projection.edges) : "KNOWN_EMPTY"}</p></article>
    <article data-tone={requests.length ? "attention" : "neutral"}><span>Unresolved requests</span><strong>{requests.length}</strong><p>{requests[0] ? productNodeLabel(requests[0], projection.nodes, projection.edges) : "KNOWN_EMPTY"}</p></article>
    <article data-tone={closingBlockers.length ? "blocked" : "neutral"}><span>Closing blockers</span><strong>{closingBlockers.length}</strong><p>{closing.length ? closingReadiness(projection.nodes) : "No represented closing objects"}</p></article>
    <article><span>Active Work</span><strong>{work.length}</strong><p>{work.length ? [...new Set(work.map((node) => node.state ?? "UNKNOWN"))].join(", ") : "No persisted active Work"}</p></article>
    <article data-tone={verified.length ? "verified" : "neutral"}><span>Latest verified outcomes</span><strong>{verified.length}</strong><p>{verified[0] ? `${verified[0].change.label} · ${new Date(verified[0].occurredAt).toLocaleString()}` : "KNOWN_EMPTY"}</p></article>
  </section><NodesTable label="Decision and investment-case objects" projection={projection} nodes={projection.nodes.filter((node) => ["pe_investment_case", "pe_thesis", "pe_assumption", "pe_decision"].includes(node.type))} empty="No Investment Case, thesis, assumption, or Decision object is recorded for this Deal." /></div>
}

function UnderwritingSection({ projection }: { projection: CompanyBrainProjection }) {
  const operating = usePeOperatingContext()
  const search = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const cases = projection.nodes.filter((node) => node.type === "pe_investment_case")
  const requestedCase = search.get("case")
  const selectedCase = cases.find((node) => node.ref.id === requestedCase) ?? cases[0] ?? null
  const caseId = selectedCase?.ref.id ?? ""
  const workspace = useProductRequest({ enabled: Boolean(selectedCase), key: caseId, load: () => jarvisGet<UnderwritingWorkspace>(`investment-cases/${caseId}/underwriting`), stateFor: (data) => data.runs.length ? "KNOWN" : "KNOWN_EMPTY" })
  const [lineage, setLineage] = useState<{ key: string; data: UnderwritingLineage | null; error: string | null }>({ key: "", data: null, error: null })
  const [comparison, setComparison] = useState<Record<string, unknown> | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)
  const runs = workspace.data?.runs ?? []
  const latest = runs[0] ?? null
  const latestVersion = latest ? workspace.data?.modelVersions.find((version) => version.id === latest.modelVersionId) ?? null : null
  const latestModel = latestVersion ? workspace.data?.models.find((model) => model.id === latestVersion.modelId) ?? null : null
  const latestScenario = latest?.scenarioId ? workspace.data?.scenarios.find((scenario) => scenario.id === latest.scenarioId) ?? null : null

  function chooseCase(id: string) {
    const params = new URLSearchParams(search)
    params.set("case", id)
    router.replace(`${pathname}?${params}`, { scroll: false })
  }

  async function explain(run: UnderwritingRun, nodeId: string) {
    setLineage({ key: `${run.id}:${nodeId}`, data: null, error: null })
    operating.inspect({ kind: "underwriting", investmentCaseId: caseId, modelId: run.modelVersionId, runId: run.id }, projection.nodes.find((node) => node.type === "underwriting_run" && node.ref.id === run.id)?.ref, projection.root)
    try { setLineage({ key: `${run.id}:${nodeId}`, data: await jarvisGet<UnderwritingLineage>(`underwriting/runs/${run.id}/explain`, { nodeId }), error: null }) }
    catch (cause) { setLineage({ key: `${run.id}:${nodeId}`, data: null, error: cause instanceof Error ? cause.message : "Lineage unavailable" }) }
  }

  async function compare() {
    if (runs.length < 2) return
    setComparison(null); setCompareError(null)
    try { setComparison(await jarvisGet<Record<string, unknown>>("underwriting/runs/diff", { left: runs[1]!.id, right: runs[0]!.id })) }
    catch (cause) { setCompareError(cause instanceof Error ? cause.message : "Run comparison unavailable") }
  }

  if (!cases.length) return <EmptyState title="Known empty: no Investment Case" detail="Underwriting remains owned by P4; no case or model is fabricated for this Deal." />
  return <div className="pw-deal-section">
    <ActionBar label="Investment Case selection"><label><span>Investment Case</span><select value={caseId} onChange={(event) => chooseCase(event.target.value)}>{cases.map((node) => <option key={node.ref.id} value={node.ref.id}>{node.label}</option>)}</select></label>{runs.length > 1 ? <button type="button" onClick={() => void compare()}><GitCompareArrows size={13} /> Compare latest runs</button> : null}<TruthState state={workspace.truthState} compact /></ActionBar>
    {workspace.status === "loading" && !workspace.data ? <Skeleton rows={6} label="Loading canonical underwriting workspace" /> : null}
    {workspace.status === "error" ? <ErrorState title="Underwriting source unavailable" detail={workspace.error ?? "P4 underwriting could not be read."} state={workspace.truthState} onRetry={workspace.reload} /> : null}
    {latest ? <><section className="pw-run-header"><div><span>LATEST PERSISTED RUN</span><h2>{latestModel?.name ?? "Underwriting model"}</h2></div><Status value={latest.status} /><Status value={latest.validity} /><time dateTime={latest.computedAt}>{new Date(latest.computedAt).toLocaleString()}</time></section>
      <section className="pw-summary-grid" aria-label="Underwriting run contract"><article><span>ModelVersion</span><strong>{latestVersion?.versionKey ?? "UNKNOWN"}</strong><p>{latestVersion ? `Schema ${latestVersion.schemaVersion} · financial conventions ${latestVersion.financialConventionVersion}` : "No represented ModelVersion"}</p></article><article><span>Scenario</span><strong>{latestScenario?.name ?? (latest.scenarioId ? "Scenario label unavailable" : "Base case")}</strong><p>{latestScenario ? `${latestScenario.definition.overrides.length} persisted override(s)` : latest.scenarioId ? "Scenario relationship is unresolved" : "No scenario override was applied"}</p></article><article><span>Run / validity</span><strong><Status value={latest.validity} /></strong><p><code>{latest.id}</code></p></article><article><span>worldAt</span><strong>{new Date(latest.worldAt).toLocaleString()}</strong><p>Exact P4 effective world timestamp</p></article><article><span>Result hash</span><strong>{latest.resultHash.slice(0, 12)}…</strong><p><code>{latest.resultHash}</code></p></article><article><span>Checks</span><strong>{latest.result.checks.filter((check) => check.passed).length}/{latest.result.checks.length}</strong><p>{latest.result.checks.filter((check) => !check.passed).length} failed persisted check(s)</p></article></section>
      <DataTable label="Underwriting inputs"><thead><tr><th>Input</th><th>Persisted value</th><th>Unit</th><th>Truth / status</th><th>Source provenance</th></tr></thead><tbody>{Object.values(latest.inputSnapshot.values).map((input) => <tr key={input.nodeId}><td><strong>{humanize(input.nodeId)}</strong></td><td>{input.value === null ? "UNKNOWN" : typeof input.value === "object" ? JSON.stringify(input.value) : String(input.value)}</td><td>{input.currency ? `${input.currency} · ${input.unit}` : input.unit}</td><td><Status value={`${input.truthClass} · ${input.status}`} /></td><td>{input.provenance.length ? `${input.provenance.length} exact source reference${input.provenance.length === 1 ? "" : "s"}` : "No recorded link"}</td></tr>)}</tbody></DataTable>
      <DataTable label="Underwriting outputs"><thead><tr><th>Output</th><th>Value</th><th>Unit</th><th>Truth</th><th>Calculation</th><th>Lineage</th></tr></thead><tbody>{Object.entries(latest.result.outputs).map(([nodeId, output]) => <tr key={nodeId}><td><strong>{humanize(nodeId)}</strong></td><td>{typeof output.value === "object" ? JSON.stringify(output.value) : String(output.value)}</td><td>{output.currency ? `${output.currency} · ${output.unit}` : output.unit}</td><td><Status value={output.truthClass} /></td><td>{output.calculation}</td><td><button type="button" className="pw-next-action" onClick={() => void explain(latest, nodeId)}><Calculator size={13} /> Explain</button></td></tr>)}</tbody></DataTable>
      {latest.result.checks.length ? <DataTable label="Underwriting checks"><thead><tr><th>Check</th><th>Result</th><th>Severity</th><th>Persisted message</th></tr></thead><tbody>{latest.result.checks.map((check) => <tr key={`${check.nodeId}:${check.code}`}><td>{humanize(check.nodeId)}</td><td><Status value={check.passed ? "PASSED" : "FAILED"} /></td><td><Status value={check.severity} /></td><td>{check.message}</td></tr>)}</tbody></DataTable> : <EmptyState title="Known empty: no underwriting checks" detail="No check result is inferred from run validity." />}
      {lineage.key ? <section className="pw-lineage-panel"><header><strong>Exact output lineage</strong><TruthState state={lineage.error ? "UNAVAILABLE" : lineage.data ? "KNOWN" : "UNKNOWN"} compact /></header>{lineage.error ? <p>{lineage.error}</p> : lineage.data ? <><h3>{humanize(lineage.data.nodeId)}</h3><p>{lineage.data.calculation}</p><dl><div><dt>Direct dependencies</dt><dd>{lineage.data.directDependencies.join(", ") || "KNOWN_EMPTY"}</dd></div><div><dt>Source provenance</dt><dd>{lineage.data.sourceProvenance.length} exact source reference{lineage.data.sourceProvenance.length === 1 ? "" : "s"}</dd></div><div><dt>Recursive dependencies</dt><dd>{lineage.data.dependencies.length}</dd></div></dl></> : <Skeleton rows={3} />}</section> : null}
      <section className="pw-lineage-panel"><header><strong>Model diff</strong><TruthState state={runs.length > 1 ? comparison ? "KNOWN" : "UNKNOWN" : "KNOWN_EMPTY"} compact /></header>{runs.length > 1 ? comparison ? <pre>{JSON.stringify(comparison, null, 2)}</pre> : <p>Select “Compare latest runs” to read the canonical P4 diff.</p> : <p>No prior persisted run is available for comparison.</p>}</section>
    </> : workspace.status === "ready" ? <EmptyState title="Known empty: no persisted underwriting run" detail="No output values, sensitivities, or comparisons are inferred." /> : null}
    {compareError ? <ErrorState title="Run comparison unavailable" detail={compareError} /> : null}
  </div>
}

function DiligenceSection({ projection }: { projection: CompanyBrainProjection }) {
  const types = new Set(["pe_workstream", "pe_request", "pe_deliverable", "pe_finding", "pe_deal_risk", "pe_dependency", "pe_milestone"])
  return <div className="pw-deal-section"><NodesTable label="Diligence workstreams, requests, findings, risks, dependencies, and milestones" projection={projection} nodes={projection.nodes.filter((node) => types.has(node.type))} empty="No diligence execution objects are recorded." /><RelationshipLedger projection={projection} /></div>
}

function RelationshipLedger({ projection }: { projection: CompanyBrainProjection }) {
  const operating = usePeOperatingContext()
  const nodes = new Map(projection.nodes.map((node) => [refKey(node.ref), node]))
  if (!projection.edges.length) return <EmptyState title="Known empty: no persisted relationships" detail="No inferred edge is drawn." />
  return <DataTable label="Persisted object relationships"><thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Persisted source</th></tr></thead><tbody>{projection.edges.slice(0, 120).map((edge) => { const from = nodes.get(refKey(edge.fromRef)); const to = nodes.get(refKey(edge.toRef)); return <tr key={`${edge.relationship}:${edge.sourceRef.table}:${edge.sourceRef.id}:${refKey(edge.fromRef)}:${refKey(edge.toRef)}`}><td>{from && isInspectionTarget(from.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(from.inspectionTarget, from.ref, projection.root)}>{productNodeLabel(from, projection.nodes, projection.edges)}</EntityLink> : humanize(edge.fromRef.type)}</td><td><Status value={edge.relationship} /></td><td>{to && isInspectionTarget(to.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(to.inspectionTarget, to.ref, projection.root)}>{productNodeLabel(to, projection.nodes, projection.edges)}</EntityLink> : humanize(edge.toRef.type)}</td><td>{edge.sourceRef.table}</td></tr> })}</tbody></DataTable>
}

function IcSection({ projection }: { projection: CompanyBrainProjection }) {
  const command = useCommandInterface()
  const operating = usePeOperatingContext()
  const cases = projection.nodes.filter((node) => node.type === "pe_ic_case")
  const selected = cases[0] ?? null
  const id = selected?.ref.id ?? ""
  const workspace = useProductRequest({ enabled: Boolean(selected), key: id, load: () => jarvisGet<IcWorkspace>(`private-equity/ic/cases/${id}`), stateFor: (data) => data.readiness.decisionEligible ? "KNOWN" : data.readiness.blockers.length ? "PARTIAL" : "KNOWN", confirmedAt: (data) => data.asOf })
  if (!selected) return <EmptyState title="Known empty: no IC case" detail="No committee state, recommendation, vote, dissent, condition, or Decision is inferred." />
  const target: InspectionTarget = { kind: "ic", icCaseId: id, objectRef: selected.ref }
  const nodeFor = (type: CompanyBrainNode["type"], objectId: unknown) => typeof objectId === "string" ? projection.nodes.find((node) => node.type === type && node.ref.id === objectId) : undefined
  const objectLink = (node: CompanyBrainNode | undefined, label: string) => node && isInspectionTarget(node.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{label}</EntityLink> : label
  const governanceCell = (kind: string, node: CompanyBrainNode | undefined, label: string) => <>{objectLink(node, label)}<small className="pw-cell-meta">{kind}</small></>
  const terminalDecision = Boolean(workspace.data?.decision) || ["DECIDED", "CLOSED"].includes(String(workspace.data?.case.state ?? "").toLocaleUpperCase())
  const votingLabel = terminalDecision ? "COMPLETED" : workspace.data?.readiness.votingEligible ? "ELIGIBLE" : "NOT ELIGIBLE"
  const decisionLabel = terminalDecision ? "DECIDED" : workspace.data?.readiness.decisionEligible ? "ELIGIBLE" : "NOT ELIGIBLE"
  const quorum = workspace.data?.readiness.aggregation?.quorum
  return <div className="pw-deal-section">
    {workspace.status === "loading" && !workspace.data ? <Skeleton rows={7} label="Loading governed IC workspace" /> : null}
    {workspace.status === "error" ? <ErrorState title="IC governance unavailable" detail={workspace.error ?? "P5 IC could not be read."} state={workspace.truthState} onRetry={workspace.reload} /> : null}
    {workspace.data ? <><section className="pw-ic-header"><div><span>GOVERNED IC CASE</span><h2>{workspace.data.investmentCase.title ?? selected.label}</h2><p>{workspace.data.readiness.blockers.length ? workspace.data.readiness.blockers.join(" · ") : terminalDecision ? "The final Decision is persisted; no current readiness blocker is applicable." : "No readiness blocker is recorded."}</p></div><Status value={workspace.data.case.state} /><TruthState state={workspace.truthState} compact /></section>
      <ActionBar><button type="button" onClick={() => operating.inspect(target, selected.ref, projection.root)}><ShieldCheck size={13} /> Inspect authority</button>{Object.entries(workspace.data.controls).filter(([, allowed]) => allowed).map(([control]) => <button key={control} type="button" onClick={() => command.openCommand({ prompt: `${humanize(control)} for ${selected.label}`, target })}>{humanize(control)}</button>)}</ActionBar>
      <section className="pw-summary-grid" aria-label="IC governance state"><article><span>Memo / Deck</span><strong>{workspace.data.memo ? "Memo recorded" : "No memo"} · {workspace.data.deck ? "Deck recorded" : "No deck"}</strong><p>Artifacts remain distinct canonical P5 objects.</p></article><article><span>Recommendation / revisions</span><strong>{String(workspace.data.currentRecommendation?.outcome ?? "No current recommendation")}</strong><p>{workspace.data.recommendations.length} persisted revision{workspace.data.recommendations.length === 1 ? "" : "s"}</p></article><article><span>Questions / substantiation</span><strong>{workspace.data.questions.filter((question) => question.state !== "RESOLVED" && question.state !== "WAIVED").length} open</strong><p>{workspace.data.questions.filter((question) => question.substantiationStatus === "SUBSTANTIATED").length}/{workspace.data.questions.length} substantiated</p></article><article><span>Quorum</span><strong>{quorum?.status ?? "UNKNOWN"}</strong><p>{quorum ? `${quorum.actual}/${quorum.required} represented members` : "No aggregation is represented"}</p></article><article><span>Votes / dissent</span><strong>{workspace.data.votes.length} / {workspace.data.dissents.length}</strong><p>Immutable votes and separately persisted dissent</p></article><article><span>Conditions</span><strong>{workspace.data.conditions.filter((condition) => !["SATISFIED", "WAIVED"].includes(String(condition.state ?? "").toLocaleUpperCase())).length} active</strong><p>{workspace.data.conditions.length} represented condition(s)</p></article><article><span>Voting readiness</span><strong>{votingLabel}</strong><p>{terminalDecision ? "The governed voting phase is terminal." : `${workspace.data.questions.filter((question) => question.state !== "RESOLVED" && question.state !== "WAIVED").length} open represented question(s)`}</p></article><article><span>Decision readiness / final Decision</span><strong>{decisionLabel}</strong><p>{workspace.data.decision ? `${String(workspace.data.decision.decision ?? "Recorded")} · ${String(workspace.data.decision.state ?? "RECORDED")}` : `${workspace.data.readiness.blockers.length} canonical blocker(s)`}</p></article></section>
      <DataTable label="IC questions, recommendations, votes, dissents, conditions, and Decision"><thead><tr><th>Governance object</th><th>State / choice</th><th>Substantiation</th><th>Human boundary</th></tr></thead><tbody>
        {workspace.data.memo ? <tr><td>{governanceCell("Memo", nodeFor("pe_ic_memo", workspace.data.memo.id), String(workspace.data.memo.title ?? "IC memo"))}</td><td><Status value={String(workspace.data.memo.state ?? "RECORDED")} /></td><td>Persisted IC artifact</td><td>Memo is evidence for deliberation, not a Decision</td></tr> : null}
        {workspace.data.deck ? <tr><td>{governanceCell("Deck", nodeFor("pe_ic_memo", workspace.data.deck.id), String(workspace.data.deck.title ?? "IC deck"))}</td><td><Status value={String(workspace.data.deck.state ?? "RECORDED")} /></td><td>Persisted IC artifact</td><td>Deck is evidence for deliberation, not a Decision</td></tr> : null}
        {workspace.data.questions.map((row) => <tr key={`q:${row.id}`}><td>{governanceCell("Question", nodeFor("pe_ic_question", row.id), String(row.question ?? "IC question"))}</td><td><Status value={String(row.state ?? "UNKNOWN")} /></td><td>{String(row.substantiationStatus ?? "UNKNOWN")}</td><td>Answer with exact evidence, resolve, or use the separately governed waiver path.</td></tr>)}
        {workspace.data.recommendations.map((row) => <tr key={`r:${String(row.id)}`}><td>{governanceCell(`Recommendation revision ${String(row.revision ?? "UNKNOWN")}`, nodeFor("pe_ic_recommendation", row.id), "IC recommendation")}</td><td><Status value={String(row.outcome ?? row.state ?? "RECORDED")} /></td><td>{row.rationale ? "Recorded rationale" : "No recorded rationale"}</td><td>Recommendation is not a Decision or authority grant</td></tr>)}
        {workspace.data.votes.map((row) => <tr key={`v:${row.id}`}><td>{governanceCell("Vote", nodeFor("pe_ic_vote", row.id), "Recorded committee vote")}</td><td><Status value={String(row.choice ?? "UNKNOWN")} /></td><td>{row.rationale ? "Recorded rationale" : "No recorded rationale"}</td><td>Immutable human attestation</td></tr>)}
        {workspace.data.dissents.map((row) => <tr key={`d:${row.id}`}><td>{governanceCell("Dissent", nodeFor("pe_ic_dissent", row.id), "Recorded dissent")}</td><td><Status value="DISSENT" /></td><td>{row.sources.length ? `${row.sources.length} source(s)` : "No recorded source"}</td><td>Inspect and resolve through IC governance</td></tr>)}
        {workspace.data.conditions.map((row) => <tr key={`c:${row.id}`}><td>{governanceCell("Condition", nodeFor("pe_ic_condition", row.id), String(row.title ?? "IC condition"))}</td><td><Status value={String(row.state ?? "UNKNOWN")} /></td><td>{row.sources.length ? `${row.sources.length} source(s)` : "No recorded source"}</td><td>Satisfy or use the separately governed waiver path</td></tr>)}
        {workspace.data.decision ? <tr><td>{governanceCell("Decision", nodeFor("pe_decision", workspace.data.decision.id), String(workspace.data.decision.title ?? "Final investment Decision"))}</td><td><Status value={String(workspace.data.decision.decision ?? workspace.data.decision.state ?? "RECORDED")} /></td><td>{workspace.data.decision.rationale ? "Recorded rationale" : "No recorded rationale"}</td><td>Final P1 Decision remains distinct from the IC proposal</td></tr> : null}
      </tbody></DataTable>
    </> : null}
  </div>
}

function EvidenceSection({ projection }: { projection: CompanyBrainProjection }) {
  const types = new Set(["document", "document_version", "evidence_source", "evidence_version", "source_observation", "source_coverage", "source_conflict", "pe_document_link", "pe_evidence_link"])
  const operating = usePeOperatingContext()
  const nodes = projection.nodes.filter((node) => types.has(node.type))
  const touching = (node: CompanyBrainNode) => projection.edges.filter((edge) => refKey(edge.fromRef) === refKey(node.ref) || refKey(edge.toRef) === refKey(node.ref))
  if (!nodes.length) return <EmptyState title="Known empty: no documents or evidence" detail="No citation, source, document, observation, coverage, or conflict object is recorded for this Deal projection." />
  return <div className="pw-deal-section"><DataTable label="Documents, evidence, observations, coverage, and conflicts"><thead><tr><th>Document / evidence</th><th>Version or citation</th><th>Linked propositions / facts</th><th>Freshness</th><th>Conflict</th><th>Provenance / source location</th></tr></thead><tbody>{nodes.map((node) => {
    const edges = touching(node)
    const links = edges.filter((edge) => !types.has(edge.fromRef.type) || !types.has(edge.toRef.type))
    const conflict = node.type === "source_conflict" || node.epistemicState === "CONFLICTING"
    const version = fact(node, "versionNumber") ?? node.version ?? node.revision
    return <tr key={refKey(node.ref)}><td><EntityLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{productNodeLabel(node, projection.nodes, projection.edges)}</EntityLink><small className="pw-cell-meta">{humanize(node.type)}</small></td><td>{version ? `Version ${String(version)}` : node.ref.revisionId ? `Revision ${node.ref.revisionId}` : "No separate version recorded"}</td><td>{links.length ? `${links.length} persisted proposition/fact link${links.length === 1 ? "" : "s"}` : "No recorded link"}</td><td><TruthState state={node.epistemicState === "STALE" ? "STALE" : node.epistemicState === "UNKNOWN" ? "UNKNOWN" : "KNOWN"} compact /><small className="pw-cell-meta">As of {new Date(node.asOf).toLocaleString()}</small></td><td><TruthState state={conflict ? "CONFLICTING" : "KNOWN_EMPTY"} compact /></td><td><EvidenceLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{node.provenanceRefs.length} exact source reference{node.provenanceRefs.length === 1 ? "" : "s"}</EvidenceLink><small className="pw-cell-meta">Open to traverse persisted document/evidence location</small></td></tr>
  })}</tbody></DataTable><RelationshipLedger projection={{ ...projection, edges: projection.edges.filter((edge) => types.has(edge.fromRef.type) || types.has(edge.toRef.type)) }} /></div>
}

interface ClosingQuestion { question: string; answer: string; state: ProductTruthState; detail: string }

function ClosingSection({ projection }: { projection: CompanyBrainProjection }) {
  const operating = usePeOperatingContext()
  const product = usePeProductData()
  const closingConditions = projection.nodes.filter((node) => node.type === "pe_closing_condition" && fact(node, "requiredForClose") !== false)
  const closingItems = projection.nodes.filter((node) => node.type === "pe_closing_item" && fact(node, "requiredForClose") !== false && fact(node, "required") !== false)
  const criticalDependencies = projection.nodes.filter((node) => node.type === "pe_dependency")
  const evidenceObjects = projection.nodes.filter((node) => ["pe_closing_condition", "pe_closing_item", "pe_deal_risk", "pe_finding"].includes(node.type))
  const decisionProof = projection.nodes.filter((node) => node.type === "pe_decision" || node.type === "decision_receipt" || node.type === "completion_proof")
  const terminal = (node: CompanyBrainNode) => ["satisfied", "waived", "completed", "resolved", "closed", "removed", "verified", "final"].includes((node.state ?? "").toLocaleLowerCase())
  const question = (label: string, values: CompanyBrainNode[], emptyDetail: string): ClosingQuestion => values.length ? { question: label, answer: values.every(terminal) ? "SUPPORTED" : "NOT YET SUPPORTED", state: values.every(terminal) ? "KNOWN" : "PARTIAL", detail: `${values.filter(terminal).length}/${values.length} represented objects are terminal.` } : { question: label, answer: "UNKNOWN", state: "UNKNOWN", detail: emptyDetail }
  const questions: ClosingQuestion[] = [
    question("Are all required transaction conditions satisfied or validly waived?", closingConditions, "No required closing condition is represented."),
    question("Are all required closing items complete?", closingItems, "No required closing item is represented."),
    question("Are critical dependencies resolved?", criticalDependencies, "No dependency object is represented; absence is not clearance."),
    evidenceObjects.length ? { question: "Is required evidence current and non-conflicting?", answer: evidenceObjects.every((node) => node.epistemicState === "KNOWN") ? "SUPPORTED" : "NOT YET SUPPORTED", state: evidenceObjects.some((node) => node.epistemicState === "CONFLICTING") ? "CONFLICTING" : evidenceObjects.some((node) => node.epistemicState === "STALE") ? "STALE" : "PARTIAL", detail: `${evidenceObjects.filter((node) => node.epistemicState === "KNOWN").length}/${evidenceObjects.length} represented objects have KNOWN epistemic state.` } : { question: "Is required evidence current and non-conflicting?", answer: "UNKNOWN", state: "UNKNOWN", detail: "No evidence-bearing closing object is represented." },
    question("Is the exact investment Decision and its proof represented?", decisionProof, "No Decision, receipt, or completion proof is represented."),
  ]
  const blockers = [...closingConditions, ...closingItems].filter((node) => !terminal(node))
  const evidenceLinks = (node: CompanyBrainNode) => projection.edges.filter((edge) => edge.relationship === "evidence_link" && (refKey(edge.fromRef) === refKey(node.ref) || refKey(edge.toRef) === refKey(node.ref)))
  const ownerLabel = (node: CompanyBrainNode) => {
    const ownerId = textFact(node, "ownerPartyId")
    if (!ownerId) return "UNKNOWN — no owner is represented"
    if (ownerId === product.attention.data?.viewer.employeeId) return "You"
    return `${humanize(textFact(node, "ownerPartyType") ?? "recorded")} owner recorded`
  }
  return <div className="pw-deal-section"><DataTable label="Closing readiness questions"><thead><tr><th>Required question</th><th>Answer</th><th>Truth</th><th>Source-backed basis</th></tr></thead><tbody>{questions.map((item) => <tr key={item.question}><td><strong>{item.question}</strong></td><td><Status value={item.answer} /></td><td><TruthState state={item.state} compact /></td><td>{item.detail}</td></tr>)}</tbody></DataTable><p className="pw-boundary-note"><FileCheck2 size={14} /> This synthesis does not claim legal or transaction close eligibility; it reports only represented canonical P1/P5/P6 states.</p>{blockers.length ? <DataTable label="Closing blockers and resolution boundary"><thead><tr><th>What is blocked?</th><th>Why?</th><th>Who owns resolution?</th><th>What evidence is missing?</th><th>What action is permitted?</th></tr></thead><tbody>{blockers.map((node) => {
    const evidence = evidenceLinks(node)
    return <tr key={refKey(node.ref)}><td><EntityLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{productNodeLabel(node, projection.nodes, projection.edges)}</EntityLink><small className="pw-cell-meta"><Status value={node.state} /></small></td><td>{fact(node, "requiredForClose") === false ? "Not required for close" : `${humanize(node.type)} remains ${node.state ?? "UNKNOWN"}.`}</td><td>{ownerLabel(node)}<small className="pw-cell-meta">Exact persisted identity is available in Inspector → Technical</small></td><td>{evidence.length ? `${evidence.length} persisted evidence link${evidence.length === 1 ? "" : "s"}; verification remains non-terminal.` : "No recorded evidence link"}</td><td>{node.availableActions[0]?.label ?? "Inspect only"}<small className="pw-cell-meta">Authority evaluated at execution</small></td></tr>
  })}</tbody></DataTable> : <EmptyState title="Known empty: no represented closing blocker" detail="All represented required closing conditions and items are terminal; this is not a legal close claim." />}<NodesTable label="Closing conditions and items" projection={projection} nodes={[...closingConditions, ...closingItems]} empty="No closing execution objects are represented." /></div>
}

function WorkSection({ projection }: { projection: CompanyBrainProjection }) {
  const work = projection.nodes.filter((node) => node.type === "work")
  const operating = usePeOperatingContext()
  if (!work.length) return <EmptyState title="Known empty: no linked Work" detail="No generic tenant Work is substituted into this Deal." />
  return <div className="pw-deal-section"><DataTable label="Deal-linked Work"><thead><tr><th>Objective</th><th>State</th><th>Plan / execution / proof</th><th>Open business view</th></tr></thead><tbody>{work.map((node) => {
    const linked = new Set(projection.edges.filter((edge) => refKey(edge.fromRef) === refKey(node.ref) || refKey(edge.toRef) === refKey(node.ref)).flatMap((edge) => [refKey(edge.fromRef), refKey(edge.toRef)]))
    const stages = projection.nodes.filter((candidate) => linked.has(refKey(candidate.ref)) && candidate.ref.id !== node.ref.id)
    return <tr key={node.ref.id}><td><EntityLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{workObjectiveLabel(node, projection.nodes, projection.edges)}</EntityLink></td><td><Status value={node.state} /></td><td>{stages.length ? `${stages.length} persisted linked object${stages.length === 1 ? "" : "s"}` : "No recorded link"}</td><td><Link className="pw-next-action" href={withPeOperatingContext("/jarvis/work", { root: projection.root, selectedObject: node.ref, workId: node.ref.id }, node.inspectionTarget)}>Open Work <ArrowRight size={12} /></Link></td></tr>
  })}</tbody></DataTable></div>
}

function ActivitySection({ projection, items }: { projection: CompanyBrainProjection; items: SemanticActivityItem[] }) {
  const operating = usePeOperatingContext()
  const index = new Map(projection.nodes.map((node) => [refKey(node.ref), node]))
  const nodeForCause = (item: SemanticActivityItem, type: string, id: string) => {
    const exactTarget = item.causalRefs.find((cause) => cause.type === type && cause.id === id)?.targetRef
    if (exactTarget) return index.get(refKey(exactTarget))
    return projection.nodes.find((node) => node.ref.type === type && node.ref.id === id)
  }
  if (!items.length) return <EmptyState title="Known empty: no semantic Activity" detail="Raw telemetry is not substituted for P8 causal Activity." />
  return <div className="pw-deal-section"><DataTable label="Semantic causal Activity"><thead><tr><th>When</th><th>Meaningful change</th><th>Actor</th><th>Causal business thread</th><th>Evidence / proof</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time></td><td><EntityLink onOpen={() => operating.inspect(item.inspectionTarget, item.subjectRef, projection.root)}>{item.change.label}</EntityLink><small className="pw-cell-meta"><Status value={item.bucket} /></small></td><td>{item.actor}</td><td>{item.causalRefs.length ? <div className="pw-causal-thread">{item.causalRefs.map((cause) => {
    const node = nodeForCause(item, cause.type, cause.id)
    return node && isInspectionTarget(node.inspectionTarget) ? <span key={`${cause.relationship}:${cause.type}:${cause.id}`}><EntityLink onOpen={() => operating.inspect(node.inspectionTarget, node.ref, projection.root)}>{productNodeLabel(node, projection.nodes, projection.edges)}</EntityLink><small>{humanize(cause.relationship)}</small></span> : <span key={`${cause.relationship}:${cause.type}:${cause.id}`}><strong>{humanize(cause.type)}</strong><small>{humanize(cause.relationship)}</small></span>
  })}</div> : "No recorded link"}</td><td>{item.evidenceRefs.length + item.receiptRefs.length + item.proofRefs.length || "Known empty"}</td></tr>)}</tbody></DataTable></div>
}

export default function DealWorkspace() {
  const pathname = usePathname()
  const product = usePeProductData()
  const operating = usePeOperatingContext()
  const projection = product.brain.data
  const sectionCandidate = pathname.split("/")[4]
  const section: DealSectionKey = DEAL_SECTION_KEYS.includes(sectionCandidate as DealSectionKey) ? sectionCandidate as DealSectionKey : "overview"
  const deal = projection?.nodes.find((node) => node.type === "pe_deal" && node.ref.id === operating.context.root?.entityId)
  const investmentCase = projection ? newest(projection.nodes.filter((node) => node.type === "pe_investment_case")) : null
  const decision = projection ? newest(projection.nodes.filter((node) => node.type === "pe_decision")) : null
  const underwriting = projection ? newest(projection.nodes.filter((node) => node.type === "underwriting_run")) : null
  const ic = projection?.nodes.find((node) => node.type === "pe_ic_case")

  if (product.brain.status === "loading" && !projection) return <main className="pw-page"><Skeleton rows={10} label="Loading Deal workspace" /></main>
  if (product.brain.status === "error" && !projection) return <main className="pw-page"><ErrorState title="Deal workspace unavailable" detail={product.brain.error ?? "The canonical Company Brain projection failed."} state={product.brain.truthState} onRetry={product.brain.reload} /></main>
  if (!projection || !deal) return <main className="pw-page"><EmptyState title="Deal context is not represented" detail="The URL Deal root did not resolve to an authenticated canonical Company Brain object." /></main>

  const rootContext = { root: projection.root, selectedObject: operating.context.selectedObject, workId: operating.context.workId }
  return <main className="pw-deal-workspace">
    <ContextHeader title={deal.label} asOf={projection.asOf} facts={[
      { label: "State", value: <Status value={deal.state} /> },
      { label: "Investment Case", value: investmentCase ? <>{investmentCase.label}<small className="pw-cell-meta"><Status value={investmentCase.state} /></small></> : "No recorded Investment Case" },
      { label: "Latest Decision", value: decision ? <>{decision.label}<small className="pw-cell-meta"><Status value={decision.state} /></small></> : "No recorded Decision" },
      { label: "IC state", value: <Status value={ic?.state ?? "No IC case"} /> },
      { label: "Closing readiness", value: closingReadiness(projection.nodes) },
      { label: "Latest underwriting", value: underwriting ? <Status value={`${underwriting.state ?? "UNKNOWN"} · ${String(fact(underwriting, "validity") ?? "validity UNKNOWN")}`} /> : "No recorded run" },
      { label: "Epistemic / truth health", value: <TruthState state={product.brain.truthState} compact /> },
    ]} />
    <nav className="pw-deal-tabs" aria-label="Deal workspace sections">{DEAL_SECTION_KEYS.map((key) => <Link key={key} data-active={section === key ? "true" : undefined} href={withPeOperatingContext(`/jarvis/deals/${projection.root.entityId}/${key}`, rootContext)}>{LABELS[key]}</Link>)}</nav>
    {product.brain.status === "error" && projection ? <ErrorState title="Showing stale Deal data" detail={product.brain.error ?? "Refresh failed; last confirmed projection remains visible."} state="STALE" onRetry={product.brain.reload} /> : null}
    {section === "overview" ? <OverviewSection projection={projection} activity={product.activity.data?.items ?? []} /> : null}
    {section === "underwriting" ? <UnderwritingSection projection={projection} /> : null}
    {section === "diligence" ? <DiligenceSection projection={projection} /> : null}
    {section === "ic" ? <IcSection projection={projection} /> : null}
    {section === "evidence" ? <EvidenceSection projection={projection} /> : null}
    {section === "closing" ? <ClosingSection projection={projection} /> : null}
    {section === "work" ? <WorkSection projection={projection} /> : null}
    {section === "activity" ? product.activity.status === "error" && !product.activity.data ? <ErrorState title="Semantic Activity unavailable" detail={product.activity.error ?? "P8 Activity failed."} state={product.activity.truthState} onRetry={product.activity.reload} /> : <ActivitySection projection={projection} items={product.activity.data?.items ?? []} /> : null}
  </main>
}
