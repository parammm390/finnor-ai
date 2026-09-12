"use client"

import { useMemo } from "react"
import { Activity, ArrowRight, Bot, CircleDot, ShieldCheck, Sparkles } from "lucide-react"
import { CompanyBrainInspector } from "../pe/CompanyBrainInspector"
import { PeOwnerBoundary, PeSourceState } from "../pe/PeSurfaceFrame"
import { PeRootPicker } from "../pe/PeRootPicker"
import { PeSurfaceMotion } from "../pe/PeSurfaceMotion"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import { humanize, isInspectionTarget, refKey, type CompanyBrainNode, type WorkforceAssignmentProjection, type WorkforceWorkerProjection } from "../pe/contracts"
import { useCompanyBrainProjection, useWorkforceStatus } from "../pe/use-pe-data"

function displayTime(value: string | null): string {
  if (!value) return "Not recorded"
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? "Not recorded" : parsed.toLocaleString()
}

function displayRate(value: number | null): string {
  return value === null ? "UNKNOWN" : `${Math.round(value * 100)}%`
}

function AgentRailRow({ worker, node, active }: { worker: WorkforceWorkerProjection; node: CompanyBrainNode; active: boolean }) {
  const operating = usePeOperatingContext()
  if (!isInspectionTarget(node.inspectionTarget)) return null
  return <button type="button" data-active={active ? "true" : "false"} onClick={() => operating.inspect(node.inspectionTarget, node.ref)}><span className="pe-agent-glyph"><Bot size={15} /><i /></span><span><strong>{worker.name}</strong><small>{worker.runtimeStatus} · revision {worker.activeRevision?.revision ?? "none"}</small></span><ArrowRight size={12} /></button>
}

function Assignment({ assignment, node }: { assignment: WorkforceAssignmentProjection; node: CompanyBrainNode }) {
  const operating = usePeOperatingContext()
  if (!isInspectionTarget(node.inspectionTarget)) return null
  return <button type="button" className="pe-assignment" data-state={assignment.state} onClick={() => operating.inspect(node.inspectionTarget, node.ref)}><span><b>{humanize(assignment.capability)}</b><em>{assignment.state}</em></span><p>Work {assignment.workId.slice(0, 8)}… · PlanNode {assignment.planNodeId.slice(0, 8)}…</p><small>attempt {assignment.attempt} · {assignment.assignmentReason}</small></button>
}

function AgentStage({ worker, assignments, assignmentNodes }: { worker: WorkforceWorkerProjection; assignments: WorkforceAssignmentProjection[]; assignmentNodes: Map<string, CompanyBrainNode> }) {
  const current = assignments.filter((assignment) => ["queued", "claimed", "running", "waiting"].includes(assignment.state))
  return <section className="pe-agent-stage pe-scale-reveal"><header><div><span className="pe-agent-glyph"><Bot size={16} /><i /></span><span><small>SELECTED AGENT PROFILE</small><h2>{worker.name}</h2><p>{worker.key} · {worker.profileStatus} · {worker.runtimeStatus}</p></span></div><strong>{worker.currentLoad}<small> / {worker.activeRevision?.maxConcurrentAssignments ?? "UNKNOWN"} active load</small></strong></header><div className="pe-agent-stage__authority"><ShieldCheck size={15} /><p>Capability grants permit attempts only. P6 selection, Policy, Authority, BusinessEffect, receipts, and proof remain authoritative.</p></div><div className="pe-agent-stage__grid"><section><header><CircleDot size={13} /><b>Current ownership</b><span>{current.length}</span></header>{current.length ? current.map((assignment) => { const node = assignmentNodes.get(assignment.id); return node ? <Assignment key={assignment.id} assignment={assignment} node={node} /> : null }) : <p>Known empty: no current root-linked assignment.</p>}</section><section><header><ShieldCheck size={13} /><b>Exact grants</b><span>{worker.activeRevision ? worker.activeRevision.capabilityGrants.length : "UNKNOWN"}</span></header>{worker.activeRevision ? worker.activeRevision.capabilityGrants.map((grant) => <div className="pe-agent-contract" key={`${grant.kind}:${grant.capability}`}><span>{grant.kind}</span><strong>{humanize(grant.capability)}</strong></div>) : <p>No active immutable AgentProfileRevision is recorded.</p>}</section><section><header><Activity size={13} /><b>Verified metrics</b><span>{worker.metrics.length}</span></header>{worker.metrics.length ? worker.metrics.map((metric) => <div className="pe-agent-contract" key={`${metric.agentRevisionId}:${metric.capability}:${metric.contextClass}`}><span>{metric.sampleState}</span><strong>{humanize(metric.capability)} · {metric.verifiedCompletionCount}/{metric.qualityAttemptCount} verified · {displayRate(metric.verifiedCompletionRate)}</strong></div>) : <p>No verified metric slice is available. Performance remains UNKNOWN.</p>}</section><section><header><Sparkles size={13} /><b>Assignment history</b><span>{assignments.length}</span></header>{assignments.length ? assignments.map((assignment) => { const node = assignmentNodes.get(assignment.id); return node ? <Assignment key={assignment.id} assignment={assignment} node={node} /> : null }) : <p>Known empty: no root-linked assignment history.</p>}</section></div><footer>Active revision: {worker.activeRevision?.id ?? "not recorded"} · source as of {displayTime(worker.latestAssignment?.updatedAt ?? null)}</footer></section>
}

function AgentWorkspace() {
  const operating = usePeOperatingContext()
  const brain = useCompanyBrainProjection(operating.context.root)
  const workforce = useWorkforceStatus(Boolean(operating.context.root))
  const profileNodes = useMemo(() => brain.data?.nodes.filter((node) => node.type === "agent_profile") ?? [], [brain.data])
  const profileIds = useMemo(() => new Set(profileNodes.map((node) => node.ref.id)), [profileNodes])
  const assignmentNodes = useMemo(() => new Map((brain.data?.nodes.filter((node) => node.type === "agent_assignment") ?? []).map((node) => [node.ref.id, node])), [brain.data])
  const workers = useMemo(() => workforce.data?.workers.filter((worker) => profileIds.has(worker.id)) ?? [], [profileIds, workforce.data])
  const selectedProfileId = operating.context.selectedObject?.type === "agent_profile" ? operating.context.selectedObject.id : operating.inspection?.kind === "agent" ? operating.inspection.agentProfileId : null
  const selected = workers.find((worker) => worker.id === selectedProfileId) ?? null
  const assignments = selected ? workforce.data?.assignments.filter((assignment) => assignment.agentProfileId === selected.id && assignmentNodes.has(assignment.id)) ?? [] : []

  return <PeSurfaceMotion><main className="pe-agents"><header className="pe-agents__hero" data-pe-hero-enter><div><span className="pe-kicker">P7 · GOVERNED WORKFORCE + LEARNING</span><h1>Worker identity is explicit. Human authority stays human.</h1><p>Only AgentProfiles and assignments connected to Work in the selected PE root are rendered.</p></div><div className="pe-agents__truth"><Bot size={18} /><span><b>{workforce.status === "ready" ? `${workers.length} root-linked worker${workers.length === 1 ? "" : "s"}` : "Source unresolved"}</b><small>{workforce.data ? `${workforce.data.sourceStatus.status} bounded view · ${displayTime(workforce.data.sourceStatus.asOf)}` : "No workforce state inferred"}</small></span></div></header><section className="pe-agents__layout" data-pe-pin-zone><aside className="pe-agents__rail"><PeRootPicker compact /><div className="pe-agent-list"><header><span>AI WORKERS</span><b>{brain.data ? workers.length : "—"}</b></header>{workers.map((worker) => { const node = profileNodes.find((candidate) => candidate.ref.id === worker.id); return node ? <AgentRailRow key={worker.id} worker={worker} node={node} active={selected?.id === worker.id} /> : null })}{brain.status === "ready" && workforce.status === "ready" && workers.length === 0 ? <p>Known empty: no configured worker has a persisted assignment to this root.</p> : null}</div></aside><div className="pe-agents__center">
    {!operating.context.root ? <section className="pe-home__no-context"><Bot size={22} /><span className="pe-kicker">NO ROOT SELECTED</span><h2>Select a canonical PE context.</h2><p>Tenant-wide workers are not substituted for a missing root relationship.</p></section> : null}
    {brain.status === "error" ? <PeSourceState title="Company Brain unavailable" detail={brain.error ?? "P7 composition could not be resolved."} retry={brain.reload} /> : null}
    {workforce.status === "error" ? <PeSourceState title="Workforce read unavailable" detail={workforce.error ?? "The canonical P7 read model failed."} retry={workforce.reload} /> : null}
    {(brain.status === "loading" || workforce.status === "loading") ? <div className="pe-loading"><span className="pe-state__pulse" /> Resolving governed workforce…</div> : null}
    {brain.data && workforce.data && !selected ? <section className="pe-home__no-context"><CircleDot size={20} /><span className="pe-kicker">AGENT SELECTION</span><h2>{workers.length ? "Choose an exact AgentProfile." : "No root-linked agent is recorded."}</h2><p>{workers.length ? "The profile, immutable revision, grants, assignments, and verified learning remain separate objects." : "No decorative or static agent persona is shown."}</p></section> : null}
    {selected ? <AgentStage worker={selected} assignments={assignments} assignmentNodes={assignmentNodes} /> : null}
  </div><div data-pe-pin-inspector>{brain.data ? <CompanyBrainInspector projection={brain.data} /> : <aside className="pe-inspector"><div className="pe-inspector__empty"><strong>No inspectable AgentProfile</strong><p>Select a PE root and source-backed worker.</p></div></aside>}</div></section></main></PeSurfaceMotion>
}

export default function AgentFleetSurface() {
  return <PeOwnerBoundary active="agents"><AgentWorkspace /></PeOwnerBoundary>
}
