"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { lazy, Suspense, useState } from "react"
import { ArrowDown, ArrowUp, ArrowUpRight, CircleAlert, CircleCheck, Clock3, FileCheck2, FileText, Layers3, Pin, RefreshCw } from "lucide-react"
import type { PeWorldRootRef } from "@/components/centropy/pe/contracts"
import type { IcWorkspace, UnderwritingWorkspace, WorkAggregateView } from "@/components/centropy/product/contracts"
import { CanvasBlockSchema, CanvasDocumentEnvelopeSchema, type CanvasBlock } from "./canvas-contract"
import { CanvasSectionNav, canvasSectionDomId } from "./CanvasSectionNav"
import type { CreatedDeck } from "./ArtifactTemplateDesk"
import { useCanvasPreferences } from "./use-canvas-preferences"
import { verifiedWorkDeck, type WorkDeck } from "./work-deck-model"

const ComputeSearchPanel = lazy(() => import("./ComputeSearchPanel").then(module=>({default:module.ComputeSearchPanel})))
const CapitalProgramPanel = lazy(() => import("./CapitalProgramPanel").then(module=>({default:module.CapitalProgramPanel})))
const BranchRehearsalPanel = lazy(() => import("./BranchRehearsalPanel").then(module=>({default:module.BranchRehearsalPanel})))
const InterfaceSynthesisPanel = lazy(() => import("./InterfaceSynthesisPanel").then(module=>({default:module.InterfaceSynthesisPanel})))
const DeliberationPanel = lazy(() => import("./DeliberationPanel").then(module=>({default:module.DeliberationPanel})))
const ProgramSynthesisPanel = lazy(() => import("./ProgramSynthesisPanel").then(module=>({default:module.ProgramSynthesisPanel})))
const EvidenceWorkbench = lazy(() => import("./EvidenceWorkbench").then(module=>({default:module.EvidenceWorkbench})))
const UnderwritingScenarioLab = lazy(() => import("./UnderwritingScenarioLab").then((module) => ({ default: module.UnderwritingScenarioLab })))
const IcVoteControl = lazy(() => import("./IcVoteControl").then((module) => ({ default: module.IcVoteControl })))
const IcCaseContinuation = lazy(() => import("./IcCaseContinuation").then((module) => ({ default: module.IcCaseContinuation })))
const IcHumanControls = lazy(() => import("../controls/IcHumanControls").then((module) => ({ default: module.IcHumanControls })))
const ArtifactCanvas = lazy(() => import("./ArtifactCanvas").then((module) => ({ default: module.ArtifactCanvas })))
const ArtifactTemplateDesk = lazy(() => import("./ArtifactTemplateDesk").then((module) => ({ default: module.ArtifactTemplateDesk })))
const SourceDiagnostics = lazy(() => import("./SourceDiagnostics").then((module) => ({ default: module.SourceDiagnostics })))
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function dateLabel(value: string) { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) }
function Truth({ state }: { state: CanvasBlock["truthState"] }) { return <span className="ct-truth" data-state={state}>{state.replaceAll("_", " ").toLowerCase()}</span> }
function readinessBlockerLabel(code: string): string {
  if (code === "MISSING_EXACT_MEMO_RECOMMENDATION_OR_RUN") return "The committee basis is missing a current memo, matching recommendation, or pinned underwriting run."
  if (code === "RECOMMENDATION_BASIS_STALE") return "The recommendation does not match the current memo and underwriting run."
  if (code.startsWith("REQUIRED_QUESTION:")) return `Required question ${code.slice("REQUIRED_QUESTION:".length)} is unresolved.`
  return code.replaceAll("_", " ").toLowerCase()
}

function SourceReferences({ block, onInspectEntity }: { onSelectProgramWork?: (workId: string) => void; block: CanvasBlock; onInspectEntity?: (id: string) => void }) {
  return <div className="ct-source-refs">
    {block.sourceRefs.length ? <details><summary>Inspect {block.sourceRefs.length} source reference{block.sourceRefs.length === 1 ? "" : "s"}</summary><ul>{block.sourceRefs.map((source) => {
      const object = block.entityRefs.find((ref) => ref.id === source.id)
      return <li key={`${source.owner}:${source.table}:${source.id}:${source.fieldPath ?? ""}`}><strong>{source.table.replaceAll("_", " ")}</strong><span>{source.owner} · {source.id}{source.fieldPath ? ` · ${source.fieldPath}` : ""}</span>{object && onInspectEntity ? <button type="button" onClick={() => onInspectEntity(`${object.type}:${object.id}`)}>Inspect object <ArrowUpRight size={13} /></button> : null}</li>
    })}</ul><p>These are exact recorded references. Document content and anchors require their owning source.</p></details> : <span>No source reference attached</span>}
    <small>{block.entityRefs.length} object{block.entityRefs.length === 1 ? "" : "s"} · {block.workRefs.length} Work link{block.workRefs.length === 1 ? "" : "s"}</small>
  </div>
}
function artifactRef(value: unknown): { documentId: string; versionId: string; projection: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return typeof record.documentId === "string" && typeof record.documentVersionId === "string" ? { documentId: record.documentId, versionId: record.documentVersionId, projection: record } : null
}

function RecordRows({ rows, onInspect }: { rows: Array<{ id: string; label: string; state: string; detail?: string }>; onInspect?: (id: string) => void }) {
  return rows.length ? <div className="ct-canvas-rows">{rows.map((row) => <div className="ct-canvas-row" key={row.id}><span className="ct-canvas-row__status" data-state={row.state.toLowerCase()}>{row.state.replaceAll("_", " ")}</span><div><strong>{row.label}</strong>{row.detail ? <p>{row.detail}</p> : null}</div>{onInspect ? <button type="button" onClick={() => onInspect(row.id)} aria-label={`Inspect ${row.label} in WORLD`}><ArrowUpRight size={16} /></button> : null}</div>)}</div> : <p className="ct-canvas__empty">No records are present in the selected source scope.</p>
}

type UnderwritingPayload = Extract<CanvasBlock, { type: "underwriting_summary" }>["payload"]
type IcPayload = Extract<CanvasBlock, { type: "ic_governance" }>["payload"]

function displayFinancialValue(value: string, unit: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  if (unit === "rate") { const scaled = numeric * 100; const shown = scaled.toFixed(1); return `${Math.abs(scaled - Number(shown)) > 1e-9 ? "≈" : ""}${shown}%` }
  if (unit === "multiple") { const shown = numeric.toFixed(2); return `${Math.abs(numeric - Number(shown)) > 1e-9 ? "≈" : ""}${shown}×` }
  if (/money/.test(unit)) { const [whole, fractional = ""] = value.split("."); const rounded = fractional.length > 2 && /[1-9]/.test(fractional.slice(2)); const shown = rounded ? numeric.toLocaleString(undefined, { maximumFractionDigits: 2 }) : `${Number(whole).toLocaleString()}${fractional ? `.${fractional}` : ""}`; return `${rounded ? "≈" : ""}${shown}` }
  return value
}

function outputPriority(nodeId: string): number {
  if (/gross.sponsor.irr/i.test(nodeId)) return 0
  if (/gross.sponsor.moic/i.test(nodeId)) return 1
  if (/sponsor.exit.proceeds/i.test(nodeId)) return 2
  if (/exit.enterprise.value/i.test(nodeId)) return 3
  if (/exit.equity.value/i.test(nodeId)) return 4
  if (/forecast.revenue/i.test(nodeId)) return 5
  return 100
}

function UnderwritingContent({ payload, workspace, writable, onRefresh, workId }: { payload: UnderwritingPayload; workspace?: UnderwritingWorkspace | null; writable?: boolean; onRefresh?: () => void; workId?: string | null }) {
  const [labOpen, setLabOpen] = useState(false)
  const highlights = payload.outputs.filter((output) => !output.value.includes(": ")).sort((left, right) => outputPriority(left.nodeId) - outputPriority(right.nodeId)).slice(0, 6)
  return <>
    <div className="ct-canvas-block__metrics"><div><strong>{payload.status}</strong><span>persisted run</span></div><div><strong>{payload.validity}</strong><span>validity</span></div><div><strong>{payload.failedChecks.length}</strong><span>failed checks</span></div></div>
    <p className="ct-canvas-block__lede">{payload.investmentCaseTitle} · {payload.modelName} · {payload.scenarioName}{payload.modelVersion ? ` · ${payload.modelVersion}` : ""}</p>
    {highlights.length ? <div className="ct-underwriting-highlights">{highlights.map((output) => <div key={output.nodeId}><span>{output.label}</span><strong title={`Exact source value: ${output.value}`}>{displayFinancialValue(output.value, output.unit)}</strong><small>{output.unit} · {output.truthClass.replaceAll("_", " ")}</small></div>)}</div> : <p>No scalar run outputs are recorded.</p>}
    {payload.outputs.length ? <details className="ct-underwriting-all"><summary>Inspect all {payload.outputs.length} persisted outputs</summary><div className="ct-instrument-table" role="table" aria-label="Persisted underwriting outputs"><div role="row" className="ct-instrument-table__head"><span role="columnheader">Output</span><span role="columnheader">Value</span><span role="columnheader">Unit</span><span role="columnheader">Truth</span></div>{payload.outputs.map((output) => <div role="row" key={output.nodeId}><strong role="cell">{output.label}</strong><span role="cell" title={`Exact source value: ${output.value}`}>{displayFinancialValue(output.value, output.unit)}</span><span role="cell">{output.unit}</span><span role="cell">{output.truthClass.replaceAll("_", " ")}</span></div>)}</div></details> : null}
    {payload.failedChecks.map((check) => <p className="ct-canvas-block__warning" key={`${check.nodeId}:${check.code}`}>{check.severity} check · {check.message}</p>)}
    {workspace && onRefresh ? <><button className="ct-canvas-block__replay" type="button" aria-expanded={labOpen} onClick={() => setLabOpen((value) => !value)}><Layers3 size={15} /> {labOpen ? "Close scenario laboratory" : "Open scenario laboratory"} <ArrowUpRight size={14} /></button>{labOpen ? <Suspense fallback={<p>Opening scenario laboratory…</p>}><UnderwritingScenarioLab key={workspace.investmentCase.id} workspace={workspace} writable={Boolean(writable)} onRefresh={onRefresh} workId={workId} /></Suspense> : null}</> : null}
  </>
}

function IcContent({ payload, workspace, writable, onRefresh, onSelectIcCase, onInspectEntity, onOpenArtifact, onOpenDraft, createdDeck, workDeck, onDeckCreated }: { payload: IcPayload; workspace?: IcWorkspace | null; writable?: boolean; onRefresh?: () => void; onSelectIcCase?: (id: string) => void; onInspectEntity?: (id: string) => void; onOpenArtifact?: (documentId: string, versionId: string, projection: Record<string, unknown>) => void; onOpenDraft?: (documentId: string, versionId: string) => void; createdDeck?: CreatedDeck | null; workDeck?: WorkDeck | null; onDeckCreated?: (deck: CreatedDeck) => void }) {
  const memoArtifact = artifactRef(workspace?.artifacts.memo)
  const deckArtifact = artifactRef(workspace?.artifacts.deck)
  return <>
    <p className="ct-canvas-block__lede">{payload.caseTitle} · {payload.caseState.replaceAll("_", " ")}</p>
    <div className="ct-canvas-block__metrics"><div><strong>{payload.terminalDecision ? "Complete" : payload.votingEligible ? "Eligible" : "Not eligible"}</strong><span>voting</span></div><div><strong>{payload.terminalDecision ? "Recorded" : payload.decisionEligible ? "Eligible" : "Not eligible"}</strong><span>decision</span></div><div><strong>{payload.quorum ? `${payload.quorum.actual}/${payload.quorum.required}` : "Unknown"}</strong><span>quorum{payload.quorum ? ` · ${payload.quorum.status}` : ""}</span></div></div>
    <div className="ct-ic-artifacts" aria-label="Pinned committee artifacts"><div><span>PINNED ARTIFACTS</span><p>Open the exact memo or deck version recorded by the committee before reviewing its decision.</p></div><div>{memoArtifact && onOpenArtifact ? <button type="button" aria-label={`Open memo, pinned version ${memoArtifact.versionId}`} onClick={() => onOpenArtifact(memoArtifact.documentId, memoArtifact.versionId, memoArtifact.projection)}><FileText size={17} /><span><strong>Open memo</strong><small title={memoArtifact.versionId}>Version …{memoArtifact.versionId.slice(-8)}</small></span><ArrowUpRight size={15} /></button> : null}{deckArtifact && onOpenArtifact ? <button type="button" aria-label={`Open deck, pinned version ${deckArtifact.versionId}`} onClick={() => onOpenArtifact(deckArtifact.documentId, deckArtifact.versionId, deckArtifact.projection)}><FileText size={17} /><span><strong>Open deck</strong><small title={deckArtifact.versionId}>Version …{deckArtifact.versionId.slice(-8)}</small></span><ArrowUpRight size={15} /></button> : null}{!memoArtifact && !deckArtifact ? <p>No exact artifact version is pinned in the loaded committee record.</p> : null}</div></div>
    {onDeckCreated && onOpenDraft ? <Suspense fallback={<p>Reading IC deck preparation…</p>}><ArtifactTemplateDesk caseTitle={payload.caseTitle} createdDeck={createdDeck ?? null} workDeck={workDeck ?? null} onDeckCreated={onDeckCreated} onOpenDraft={onOpenDraft} /></Suspense> : null}
    {workspace && onSelectIcCase ? <Suspense fallback={<p>Reading IC case continuity…</p>}><IcCaseContinuation workspace={workspace} onSelectCase={onSelectIcCase} /></Suspense> : null}
    {payload.blockers.length ? <div className="ct-ic-blockers"><strong>Recorded readiness blockers</strong><ul>{payload.blockers.map((blocker, index) => <li key={`${blocker}:${index}`} title={blocker}>{readinessBlockerLabel(blocker)}</li>)}</ul></div> : <p className="ct-canvas__empty">No readiness blocker is recorded.</p>}
    <div className="ct-canvas-block__subhead">Questions · {payload.questions.length}</div><RecordRows rows={payload.questions} onInspect={onInspectEntity} />
    <div className="ct-ic-summary"><span>{payload.votes} votes</span><span>{payload.dissents} dissents</span><span>{payload.conditions} conditions</span></div>
    {workspace ? <details className="ct-ic-record"><summary>Inspect committee record and pinned basis</summary><div>
      <section><strong>Selected memo and deck</strong><p>Memo · {workspace.case.currentMemoId ?? "No memo pinned"}</p><p>Deck · {workspace.deck?.id ?? "No deck selected"}</p><p>Underwriting run · {workspace.case.primaryUnderwritingRunId ?? "No run pinned"}</p></section>
      <section><strong>Current recommendation</strong>{workspace.currentRecommendation ? <><p>{workspace.currentRecommendation.outcome?.replaceAll("_", " ") ?? "Outcome not recorded"} · revision {workspace.currentRecommendation.revision ?? "unknown"}</p><p>{workspace.currentRecommendation.rationale ?? "No rationale recorded"}</p></> : <p>No current recommendation recorded.</p>}</section>
      <section><strong>Recorded votes</strong>{workspace.votes.length ? <ul>{workspace.votes.map((vote) => <li key={vote.id}>{vote.choice?.replaceAll("_", " ") ?? "Choice unavailable"}{vote.rationale ? ` · ${vote.rationale}` : ""}</li>)}</ul> : <p>No votes recorded.</p>}</section>
      <section><strong>Dissent and conditions</strong>{workspace.dissents.map((dissent) => <p key={dissent.id}>Dissent · {dissent.rationale ?? "Rationale unavailable"}</p>)}{workspace.conditions.map((condition) => <p key={condition.id}>{condition.title ?? "Condition"} · {condition.state?.replaceAll("_", " ") ?? "state unavailable"}</p>)}{!workspace.dissents.length && !workspace.conditions.length ? <p>None recorded.</p> : null}</section>
    </div></details> : null}
    {workspace?.case.state === "VOTING" && onRefresh ? <Suspense fallback={<p>Reading voting control…</p>}><IcVoteControl key={workspace.case.id} workspace={workspace} writable={Boolean(writable)} onRefresh={onRefresh} /></Suspense> : null}
    {workspace && onRefresh ? <Suspense fallback={<p>Reading committee controls…</p>}><IcHumanControls workspace={workspace} writable={Boolean(writable)} onRecorded={onRefresh} /></Suspense> : null}
    {payload.decision ? <p className="ct-canvas-block__outcome"><strong>Persisted Decision</strong>{payload.decision}</p> : null}
  </>
}

function BlockContent({ workId, onSelectProgramWork, block, onInspectEntity, onOpenReplay, onOpenArtifact, onOpenDraft, createdDeck, workDeck, onDeckCreated, underwriting, underwritingReady, ic, icReady, onRefresh, onSelectIcCase }: { workId?: string | null; onSelectProgramWork?: (workId: string) => void; block: CanvasBlock; onInspectEntity?: (id: string) => void; onOpenReplay?: (workId: string) => void; onOpenArtifact?: (documentId: string, versionId: string, projection: Record<string, unknown>) => void; onOpenDraft?: (documentId: string, versionId: string) => void; createdDeck?: CreatedDeck | null; workDeck?: WorkDeck | null; onDeckCreated?: (deck: CreatedDeck) => void; underwriting?: UnderwritingWorkspace | null; underwritingReady?: boolean; ic?: IcWorkspace | null; icReady?: boolean; onRefresh?: () => void; onSelectIcCase?: (id: string) => void }) {
  switch (block.type) {
    case "capital_program": return workId===block.payload.workId?<Suspense fallback={<p>Opening economic arrangements…</p>}><CapitalProgramPanel key={`${block.payload.workId}:${block.payload.root.entityId}`} {...block.payload}/></Suspense>:<p>Reload current Work before opening economic arrangements.</p>
    case "branch_fabric": return workId===block.payload.workId?<Suspense fallback={<p>Opening branch rehearsal…</p>}><BranchRehearsalPanel key={`${block.payload.workId}:${block.payload.rootId}`} {...block.payload}/></Suspense>:<p>Reload current Work before opening branch rehearsal.</p>
    case "interface_synthesis": return <Suspense fallback={<p>Opening interface acquisition…</p>}><InterfaceSynthesisPanel key={`${block.payload.root.entityId}:${block.payload.workId}`} {...block.payload}/></Suspense>
    case "compute_search": return <Suspense fallback={<p>Opening allocated computation…</p>}><ComputeSearchPanel key={`${block.payload.root.entityId}:${block.payload.workId}`} {...block.payload}/></Suspense>
    case "deliberation_policy": return <Suspense fallback={<p>Opening current deliberation…</p>}><DeliberationPanel key={`${block.payload.root.entityId}:${block.payload.workId}`} {...block.payload}/></Suspense>
    case "program_synthesis": return <Suspense fallback={<p>Opening analytical method…</p>}><ProgramSynthesisPanel key={`${block.payload.root.entityId}:${block.payload.workId}`} {...block.payload} onSelectWork={onSelectProgramWork}/></Suspense>
    case "evidence_execution": return <Suspense fallback={<p>Opening evidence calculations…</p>}><EvidenceWorkbench key={block.payload.root.entityId} root={block.payload.root} workId={block.payload.workId}/></Suspense>
    case "work_execution": return <><p className="ct-canvas-block__lede">{block.payload.objective}</p><ol className="ct-work-stages">{block.payload.stages.map((stage) => <li key={stage.id} data-state={stage.state}><span className="ct-work-stages__icon">{stage.state === "verified" ? <CircleCheck size={17} /> : stage.state === "blocked" ? <CircleAlert size={17} /> : <Clock3 size={17} />}</span><div><strong>{stage.label}</strong><p>{stage.detail}</p></div></li>)}</ol>{block.payload.failure ? <p className="ct-canvas-block__warning">Failure recorded: {block.payload.failure}</p> : null}{block.payload.finalOutcome ? <p className="ct-canvas-block__outcome"><strong>Persisted outcome</strong>{block.payload.finalOutcome}</p> : null}{onOpenReplay ? <button className="ct-canvas-block__replay" type="button" onClick={() => { const workId = block.workRefs[0]?.workId; if (workId) onOpenReplay(workId) }}><Layers3 size={15} /> Why did this happen? <ArrowUpRight size={14} /></button> : null}</>
    case "closing_readiness": return <><div className="ct-canvas-block__metrics"><div><strong>{block.payload.conditions.length}</strong><span>recorded conditions</span></div><div><strong>{block.payload.openRisks}</strong><span>open risks or findings</span></div><div><strong>{block.payload.sourceCoverage}</strong><span>source coverage</span></div></div><RecordRows rows={block.payload.conditions} onInspect={onInspectEntity} /></>
    case "risk_register": return <RecordRows rows={block.payload.risks} onInspect={onInspectEntity} />
    case "ic_readiness": return <><div className="ct-canvas-block__subhead">Questions and dissent · {block.payload.questions.length}</div><RecordRows rows={block.payload.questions} onInspect={onInspectEntity} /><div className="ct-canvas-block__subhead">Recorded decisions · {block.payload.decisions.length}</div><RecordRows rows={block.payload.decisions} onInspect={onInspectEntity} /></>
    case "evidence_matrix": return <><p className="ct-canvas-block__lede">{block.payload.conflicts ? `${block.payload.conflicts} source conflict${block.payload.conflicts === 1 ? "" : "s"} in view.` : "No source conflict is recorded in this projection."}</p><RecordRows rows={block.payload.items} onInspect={onInspectEntity} /></>
    case "decision_receipt": return <div className="ct-decision-receipt"><FileCheck2 size={24} /><div><strong>{block.payload.status}</strong><p>{block.payload.result}</p>{block.payload.failure ? <p className="ct-canvas-block__warning">{block.payload.failure}</p> : null}<small>{block.payload.finalizedAt ? `Finalized ${dateLabel(block.payload.finalizedAt)}` : "Awaiting finalization"}</small></div></div>
    case "underwriting_summary": return <UnderwritingContent payload={block.payload} workspace={underwriting} writable={underwritingReady} onRefresh={onRefresh} workId={workId} />
    case "ic_governance": return <IcContent payload={block.payload} workspace={ic} writable={icReady} onRefresh={onRefresh} onSelectIcCase={onSelectIcCase} onInspectEntity={onInspectEntity} onOpenArtifact={onOpenArtifact} onOpenDraft={onOpenDraft} createdDeck={createdDeck} workDeck={workDeck} onDeckCreated={onDeckCreated} />
  }
}

export interface CanvasSourceError { kind: CanvasBlock["sourceKind"]; message: string; retained: boolean }
export function displayedTruthState(block: CanvasBlock, errors: CanvasSourceError[]): CanvasBlock["truthState"] {
  return errors.some((error) => error.kind === block.sourceKind && error.retained) ? "STALE" : block.truthState
}

export function CanvasDocument({ onSelectProgramWork, document, root, sourceErrors, refreshing, onRefresh, onRefreshUnderwriting, onInspectEntity, onOpenReplay, onSelectIcCase, work, underwriting, underwritingReady, ic, icReady }: { onSelectProgramWork?: (workId: string) => void; document: unknown; root?: PeWorldRootRef | null; sourceErrors: CanvasSourceError[]; refreshing: boolean; onRefresh: () => void; onRefreshUnderwriting?: () => void; onInspectEntity?: (id: string) => void; onOpenReplay?: (workId: string) => void; onSelectIcCase?: (id: string) => void; work?: WorkAggregateView | null; underwriting?: UnderwritingWorkspace | null; underwritingReady?: boolean; ic?: IcWorkspace | null; icReady?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pinnedArtifact, setPinnedArtifact] = useState<{ documentId: string; versionId: string; projection: Record<string, unknown>; pinned: true } | null>(null)
  const [createdDeck, setCreatedDeck] = useState<CreatedDeck | null>(null)
  const verifiedDeck = verifiedWorkDeck(work, root?.entityType === "pe_deal" ? root.entityId : null)
  const workDeck = verifiedDeck && ic?.case.id === verifiedDeck.caseId && ic.case.dealId === root?.entityId ? verifiedDeck : null
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const draftDocumentId = searchParams.get("artifactDocumentId")
  const draftVersionId = searchParams.get("artifactVersionId")
  const draftArtifact = draftDocumentId && draftVersionId && UUID_PATTERN.test(draftDocumentId) && UUID_PATTERN.test(draftVersionId) && searchParams.get("artifactMode") === "draft" ? { documentId: draftDocumentId, versionId: draftVersionId, projection: {}, pinned: false as const } : null
  const openArtifact = pinnedArtifact ?? draftArtifact
  function setDraftUrl(documentId: string | null, versionId: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (documentId && versionId && UUID_PATTERN.test(documentId) && UUID_PATTERN.test(versionId)) { params.set("artifactMode", "draft"); params.set("artifactDocumentId", documentId); params.set("artifactVersionId", versionId) }
    else { params.delete("artifactMode"); params.delete("artifactDocumentId"); params.delete("artifactVersionId") }
    router.replace(`${pathname}${params.size ? `?${params.toString()}` : ""}`, { scroll: false })
  }
  const valid = CanvasDocumentEnvelopeSchema.safeParse(document)
  const preferences = useCanvasPreferences(valid.success ? valid.data.threadId : null, valid.success ? valid.data.layout.blockIds : [])
  if (openArtifact) return <Suspense fallback={<div className="ct-canvas__invalid" role="status">Opening exact artifact…</div>}><ArtifactCanvas key={`${openArtifact.documentId}:${openArtifact.versionId}`} documentId={openArtifact.documentId} initialVersionId={openArtifact.versionId} pinnedVersionId={openArtifact.pinned ? openArtifact.versionId : undefined} pinnedProjection={openArtifact.projection} ic={openArtifact.pinned ? null : ic} icReady={icReady} onIcRefresh={onRefresh} onSelectIcCase={onSelectIcCase} onClose={() => { if (openArtifact.pinned) setPinnedArtifact(null); else setDraftUrl(null, null) }} onVersionChange={openArtifact.pinned ? undefined : (versionId) => setDraftUrl(openArtifact.documentId, versionId)} /></Suspense>
  if (!valid.success) return <div className="ct-canvas__invalid" role="alert"><CircleAlert size={20} /><h2>Canvas cannot be verified</h2><p>The presentation contract failed validation. Canonical Work and source records remain intact.</p><button type="button" onClick={onRefresh}>Reload from sources</button></div>
  const blocks = new Map(valid.data.blocks.flatMap((block) => block && typeof block === "object" && !Array.isArray(block) && typeof (block as Record<string, unknown>).id === "string" ? [[(block as { id: string }).id, block] as const] : []))
  const sections = preferences.order.map((id) => { const parsed = CanvasBlockSchema.safeParse(blocks.get(id)); return { id, title: parsed.success ? parsed.data.title : "Unsupported instrument", type: parsed.success ? parsed.data.type : "unsupported" } })
  return <div className="ct-canvas-document">
    <header className="ct-canvas-document__header"><div><span className="ct-eyebrow">INVESTIGATION CANVAS</span><h2>{valid.data.title}</h2><p>Instruments follow the records attached to this Investigation. Every state below is scoped to its source.</p></div><button type="button" onClick={onRefresh} aria-label="Refresh Canvas sources" disabled={refreshing}><RefreshCw size={16} /></button></header>
    <div className="ct-canvas-document__meta"><span><Layers3 size={15} /> {refreshing && valid.data.blocks.length === 0 ? "Loading instruments" : `${valid.data.blocks.length} instrument${valid.data.blocks.length === 1 ? "" : "s"}`}</span>{valid.data.blocks.length > 0 ? <span>Assembled {dateLabel(valid.data.revision.builtAt)}</span> : null}{refreshing ? <span>Checking sources…</span> : null}<button type="button" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((value) => !value)}>{sourcesOpen ? "Close source diagnostics" : "Inspect source diagnostics"}</button></div>
    <CanvasSectionNav sections={sections} />
    <div className="ct-canvas-layout"><span>THREAD CANVAS ORDER · {preferences.status === "loading" ? "READING" : preferences.status.toUpperCase()}</span>{preferences.dirty && preferences.status === "ready" ? <button type="button" onClick={() => void preferences.save()}>Save order and focus</button> : null}{["unavailable", "uncertain"].includes(preferences.status) ? <button type="button" onClick={preferences.reload}>Reload saved order</button> : null}{preferences.message ? <p role="status">{preferences.message}</p> : null}</div>
    {sourcesOpen ? <Suspense fallback={<p role="status">Opening source diagnostics…</p>}><SourceDiagnostics root={root ?? null} /></Suspense> : null}
    {sourceErrors.map((error) => <p className="ct-canvas__source-error" role="alert" key={error.kind}>{({ work: "Work", company_brain: "Company Brain", underwriting: "Underwriting", ic: "Investment committee" })[error.kind]} source unavailable · {error.message}. {error.retained ? "Its last loaded instruments are marked stale." : "No instrument from this source is shown."}</p>)}
    {preferences.order.length ? preferences.order.map((id, index) => {
      const parsed = CanvasBlockSchema.safeParse(blocks.get(id))
      if (!parsed.success) return <section className="ct-canvas-block" id={canvasSectionDomId(id)} key={id}><span className="ct-eyebrow">UNSUPPORTED INSTRUMENT</span><p>This block version cannot be displayed safely.</p></section>
      const block = parsed.data
      if(["capital_program","branch_fabric"].includes(block.type)&&sourceErrors.some(error=>["work","company_brain"].includes(error.kind)))
        return <section className="ct-canvas-block" id={canvasSectionDomId(block.id)} key={id}><h3>{block.title}</h3><p>Reload current Work and company sources before opening this instrument.</p></section>
      return <section className="ct-canvas-block" id={canvasSectionDomId(block.id)} key={id} data-type={block.type} data-focused={preferences.focusedId === id}><header><div><span className="ct-canvas-block__index">{String(index + 1).padStart(2, "0")} / {block.type.replaceAll("_", " ")}</span><h3>{block.title}</h3></div><div className="ct-canvas-block__controls"><button type="button" title={`Move ${block.title} up`} aria-label={`Move ${block.title} up`} disabled={preferences.status !== "ready" || index === 0} onClick={() => preferences.move(id, -1)}><ArrowUp size={14} /></button><button type="button" title={`Move ${block.title} down`} aria-label={`Move ${block.title} down`} disabled={preferences.status !== "ready" || index === preferences.order.length - 1} onClick={() => preferences.move(id, 1)}><ArrowDown size={14} /></button><button type="button" title={`Focus ${block.title}`} aria-label={`Focus ${block.title}`} aria-pressed={preferences.focusedId === id} disabled={preferences.status !== "ready"} onClick={() => preferences.focus(id)}><Pin size={14} /></button><Truth state={displayedTruthState(block, sourceErrors)} /></div></header><BlockContent workId={sourceErrors.some(error => error.kind === "work") ? null : work?.work.id ?? null} onSelectProgramWork={onSelectProgramWork} block={block} onInspectEntity={onInspectEntity} onOpenReplay={onOpenReplay} onOpenArtifact={(documentId, versionId, projection) => setPinnedArtifact({ documentId, versionId, projection, pinned: true })} onOpenDraft={(documentId, versionId) => setDraftUrl(documentId, versionId)} createdDeck={createdDeck} workDeck={workDeck} onDeckCreated={setCreatedDeck} underwriting={underwriting} underwritingReady={underwritingReady} ic={ic} icReady={icReady} onSelectIcCase={onSelectIcCase} onRefresh={block.type === "underwriting_summary" ? onRefreshUnderwriting ?? onRefresh : onRefresh} /><footer><SourceReferences block={block} onInspectEntity={onInspectEntity} /><time dateTime={block.asOf}>As of {dateLabel(block.asOf)}</time></footer></section>
    }) : <div className="ct-canvas__empty-document" role="status"><Layers3 size={24} /><h3>{refreshing ? "Assembling instruments…" : "No instruments assembled yet"}</h3><p>{refreshing ? "Checking the records attached to this Investigation." : "This Investigation has no linked Work or accessible root projection to render. State an objective in the Thread to begin."}</p></div>}
  </div>
}
