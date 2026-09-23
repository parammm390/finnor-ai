"use client"

import { useMemo } from "react"
import { ArrowRight, FileCheck2, GitBranch, RotateCcw, Workflow } from "lucide-react"
import { centropyGet } from "../lib/api"
import { useCommandInterface } from "../product/CommandInterface"
import { usePeProductData } from "../product/ProductDataProvider"
import { workObjectiveLabel } from "../product/deal-model"
import type { WorkAggregateView } from "../product/contracts"
import { ActionBar, DataTable, EmptyState, EntityLink, ErrorState, PageHeader, Skeleton, Status, TruthState } from "../product/primitives"
import type { ProductTruthState } from "../product/source-health"
import { useProductRequest } from "../product/useProductRequest"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import { humanize, isInspectionTarget, refKey, type CompanyBrainNode } from "./contracts"

function proofState(aggregate: WorkAggregateView | null): ProductTruthState {
  if (!aggregate) return "UNKNOWN"
  if (aggregate.work.failure) return "CONFLICTING"
  const verifiedProof = aggregate.planRevisions.some((revision) => {
    const proof = revision.completionProof
    return Boolean(proof && typeof proof === "object" && !Array.isArray(proof) && (proof as Record<string, unknown>).verified === true)
  })
  const finalizedReceipt = aggregate.receipts.some((receipt) => Boolean(receipt.finalizedAt) && !receipt.failure)
  if (verifiedProof || finalizedReceipt) return "KNOWN"
  return aggregate.receipts.length || aggregate.businessEffects.length ? "PARTIAL" : "KNOWN_EMPTY"
}

function WorkDetail({ node }: { node: CompanyBrainNode }) {
  const operating = usePeOperatingContext()
  const product = usePeProductData()
  const command = useCommandInterface()
  const id = node.ref.id
  const aggregate = useProductRequest({ enabled: true, key: id, load: async () => (await centropyGet<{ work: WorkAggregateView }>(`works/${id}`)).work, stateFor: (data) => data.work.failure ? "CONFLICTING" : "KNOWN" })
  const attention = product.attention.data?.items.filter((item) => item.workId === id) ?? []
  const activity = product.activity.data?.items.filter((item) => item.workId === id) ?? []
  const currentPlan = aggregate.data?.planRevisions[0] ?? null
  const outcome = aggregate.data?.work.finalOutcome
  const objective = aggregate.data?.work.initialInstruction ?? node.label
  const projected = product.brain.data?.nodes ?? []
  const linkedNode = (type: CompanyBrainNode["type"], id: string) => projected.find((candidate) => candidate.type === type && candidate.ref.id === id)
  const inspectable = (candidate: CompanyBrainNode | undefined, label: string) => candidate && isInspectionTarget(candidate.inspectionTarget)
    ? <EntityLink onOpen={() => operating.inspect(candidate.inspectionTarget, candidate.ref)}>{label}</EntityLink>
    : label
  return <section className="pw-work-detail">
    <header className="pw-work-context"><div><span>CANONICAL WORK</span><h2>{objective}</h2><p>Work is the container; Plan, execution, verification, recovery, and final outcome remain distinct records.</p></div><Status value={aggregate.data?.work.status ?? node.state} /><TruthState state={aggregate.truthState} compact /></header>
    <ActionBar><button type="button" onClick={() => operating.inspect(node.inspectionTarget, node.ref)}><Workflow size={13} /> Inspect Work</button><button type="button" onClick={() => command.openCommand({ prompt: `Continue this Work: ${objective}`, target: node.inspectionTarget })}>Continue through CENTROPY <ArrowRight size={13} /></button></ActionBar>
    {aggregate.status === "loading" && !aggregate.data ? <Skeleton rows={8} label="Loading Work aggregate" /> : null}
    {aggregate.status === "error" ? <ErrorState title={aggregate.data ? "Showing stale Work data" : "Work unavailable"} detail={aggregate.error ?? "P6 Work could not be read."} state={aggregate.data ? "STALE" : aggregate.truthState} onRetry={aggregate.reload} /> : null}
    {aggregate.data ? <>
      <section className="pw-work-sequence" aria-label="Work business sequence">
        <article><span>1 · Objective</span><strong>{aggregate.data.work.initialInstruction}</strong><p>{aggregate.data.work.currentOwnerId || aggregate.data.work.assignedTo ? "Owned by a recorded team member" : "No recorded owner"}</p></article>
        <article><span>2 · Plan</span><strong>{currentPlan ? `Revision ${currentPlan.revision} · ${currentPlan.status}` : "KNOWN_EMPTY"}</strong><p>{currentPlan ? currentPlan.reason : "No selected Plan revision"}</p></article>
        <article><span>3 · Human boundary</span><strong>{attention[0]?.nextHumanBoundary.kind ? humanize(attention[0].nextHumanBoundary.kind) : "No active recorded boundary"}</strong><p>{attention[0]?.nextHumanBoundary.description ?? "No attention condition is assigned to the current viewer."}</p></article>
        <article><span>4 · Execution</span><strong>{aggregate.data.actions.length} action{aggregate.data.actions.length === 1 ? "" : "s"} · {aggregate.data.businessEffects.length} effect{aggregate.data.businessEffects.length === 1 ? "" : "s"}</strong><p>{aggregate.data.actions.length ? [...new Set(aggregate.data.actions.map((item) => item.status))].join(", ") : "No execution action recorded"}</p></article>
        <article><span>5 · Verification</span><strong><TruthState state={proofState(aggregate.data)} /></strong><p>{aggregate.data.receipts.length} receipt{aggregate.data.receipts.length === 1 ? "" : "s"}; completion is never inferred from submission.</p></article>
        <article><span>6 · Outcome</span><strong>{outcome ? "Persisted final outcome" : "No final outcome"}</strong><p>{outcome ? JSON.stringify(outcome) : "KNOWN_EMPTY"}</p></article>
      </section>
      <DataTable label="Plan and execution"><thead><tr><th>Business stage</th><th>Object</th><th>State</th><th>Verification / consequence</th></tr></thead><tbody>
        {aggregate.data.planRevisions.map((item) => <tr key={`plan:${item.id}`}><td><GitBranch size={13} /> {inspectable(linkedNode("plan_revision", item.id), `Plan revision ${item.revision}`)}</td><td>{item.reason}</td><td><Status value={item.status} /></td><td>{item.completionProof ? inspectable(linkedNode("completion_proof", item.id), "Completion proof recorded") : "No completion proof"}</td></tr>)}
        {aggregate.data.actions.map((item) => <tr key={`action:${item.id}`}><td>Execution action</td><td>{inspectable(linkedNode("domain_action", item.id), humanize(item.actionType))}</td><td><Status value={item.status} /></td><td>{aggregate.data!.businessEffects.filter((effect) => effect.domainActionId === item.id).length} observed effect(s)</td></tr>)}
        {aggregate.data.businessEffects.map((item) => <tr key={`effect:${item.id}`}><td>Business effect</td><td>{inspectable(linkedNode("business_effect", item.id), humanize(item.status))}</td><td><Status value={item.status} /></td><td>{item.verification ? "Verification recorded" : "No verification recorded"}</td></tr>)}
        {aggregate.data.receipts.map((item) => <tr key={`receipt:${item.id}`}><td><FileCheck2 size={13} /> {inspectable(linkedNode("decision_receipt", item.id), "Decision receipt")}</td><td>{item.actualResult ? "Actual result recorded" : "No actual result"}</td><td><Status value={item.failure ? "FAILED" : item.finalizedAt ? "FINALIZED" : "PENDING"} /></td><td>{item.finalizedAt ? new Date(item.finalizedAt).toLocaleString() : "Not finalized"}</td></tr>)}
        {aggregate.data.objectiveSteps.filter((item) => item.failure || item.recoveryKind).map((item) => <tr key={`recovery:${item.id}`}><td><RotateCcw size={13} /> Recovery</td><td>{item.recoveryKind ? humanize(item.recoveryKind) : "Recorded failure"}</td><td><Status value={item.iterationOutcome} /></td><td>{item.failure ? "Failure evidence recorded" : "Recovery boundary recorded"}</td></tr>)}
      </tbody></DataTable>
      <section className="pw-section"><header className="pw-section__heading"><div><span>SEMANTIC ACTIVITY</span><h3>Meaningful changes attributed to this Work</h3></div><p>{activity.length} event{activity.length === 1 ? "" : "s"}</p></header>{activity.length ? <DataTable label="Work semantic Activity"><tbody>{activity.map((item) => <tr key={item.id}><td><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time></td><td>{isInspectionTarget(item.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(item.inspectionTarget, item.subjectRef)}>{item.change.label}</EntityLink> : item.change.label}</td><td><Status value={item.bucket} /></td><td>{item.causalRefs.length ? `${item.causalRefs.length} persisted cause(s)` : "No recorded link"}</td></tr>)}</tbody></DataTable> : <EmptyState title="Known empty: no Work Activity" detail="Raw telemetry is not substituted." />}</section>
    </> : null}
  </section>
}

export default function WorkSurface() {
  const operating = usePeOperatingContext()
  const product = usePeProductData()
  const works = useMemo(() => product.brain.data?.nodes.filter((node) => node.type === "work" && node.inspectionTarget.kind === "work") ?? [], [product.brain.data])
  const selected = works.find((node) => node.ref.id === operating.context.workId) ?? null
  return <main className="pw-page pw-work-page">
    <PageHeader eyebrow="WORK · PLAN · EXECUTION · PROOF · RECOVERY" title="Business outcomes with an inspectable execution spine" description="Only Work connected to the active canonical PE root appears here. Technical runtime identifiers stay in the universal Inspector." />
    {!operating.context.root ? <EmptyState title="Select a Deal or PE root" detail="Work is always shown inside exact investment context; tenant-wide Work is not substituted." /> : null}
    {product.brain.status === "loading" && !product.brain.data ? <Skeleton rows={7} label="Resolving root-linked Work" /> : null}
    {product.brain.status === "error" && !product.brain.data ? <ErrorState title="Work projection unavailable" detail={product.brain.error ?? "Company Brain could not compose P6 Work."} state={product.brain.truthState} onRetry={product.brain.reload} /> : null}
    {product.brain.data ? <div className="pw-work-layout"><aside className="pw-work-list"><header><span>ROOT-LINKED WORK</span><b>{works.length}</b></header>{works.map((node) => <button type="button" key={refKey(node.ref)} data-active={selected?.ref.id === node.ref.id ? "true" : undefined} onClick={() => operating.setWork(node.ref.id)}><Workflow size={14} /><span><strong>{workObjectiveLabel(node, product.brain.data!.nodes, product.brain.data!.edges)}</strong><small><Status value={node.state} /></small></span><ArrowRight size={13} /></button>)}{!works.length ? <p>Known empty: no persisted Work link.</p> : null}</aside><div>{selected ? <WorkDetail node={selected} /> : <EmptyState title={works.length ? "Choose source-backed Work" : "No linked Work is recorded"} detail={works.length ? "The selection becomes part of the typed operating context." : "No generic Work is fabricated for this root."} />}</div></div> : null}
  </main>
}
