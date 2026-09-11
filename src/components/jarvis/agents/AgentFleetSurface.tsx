"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Activity, ArrowUpRight, Bot, CircleDot, ShieldCheck, X } from "lucide-react"
import type { WorkforceAssignmentProjection, WorkforceRuntimeStatus } from "@/lib/jarvis-client"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { useBusinessProjection } from "../lib/business-projections"
import { businessProjections } from "../lib/projection-definitions"
import { OperationalSurfaceNav } from "../surfaces/OperationalSurfaceNav"
import "../jarvis-theme.css"

type DisplayStatus = WorkforceRuntimeStatus | "unconfigured"

const STATUS_COPY: Record<DisplayStatus, string> = {
  unconfigured: "Unconfigured",
  idle: "Idle",
  working: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  unavailable: "Unavailable",
}

function shortId(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : "—"
}

function displayTime(value: string | null): string {
  if (!value) return "Not recorded"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function displayPercent(value: number | null): string {
  return value === null ? "UNKNOWN" : `${Math.round(value * 100)}%`
}

function FleetLane({ eyebrow, title, icon, children }: { eyebrow: string; title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="jarvis-agent-fleet__lane">
      <div className="jarvis-agent-fleet__lane-heading">
        <span className="jarvis-agent-fleet__lane-icon" aria-hidden>{icon}</span>
        <span><span className="jarvis-agent-fleet__eyebrow">{eyebrow}</span><strong>{title}</strong></span>
      </div>
      <div className="jarvis-agent-fleet__lane-body">{children}</div>
    </section>
  )
}

function AssignmentRow({ assignment, onInspect }: { assignment: WorkforceAssignmentProjection; onInspect: () => void }) {
  return (
    <div className="jarvis-agent-fleet__activity-row">
      <button type="button" className="jarvis-agent-fleet__activity-main" onClick={onInspect}>
        <span><strong>{assignment.capability.replaceAll("_", " ")}</strong><small>{assignment.state} · Plan node {assignment.planNodeId}</small></span>
        <ArrowUpRight size={15} aria-hidden />
      </button>
      <div className="jarvis-agent-fleet__activity-links">
        <Link href={`/jarvis/work?workCaseId=${encodeURIComponent(assignment.workId)}`}>Work {shortId(assignment.workId)}</Link>
        <span>Revision {shortId(assignment.agentRevisionId)}</span>
      </div>
    </div>
  )
}

export default function AgentFleetSurface() {
  const { session } = useJarvisAuth()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspector, setInspector] = useState<WorkforceAssignmentProjection | null>(null)
  const projection = useBusinessProjection(businessProjections.workforceStatus(), { enabled: Boolean(session) })
  const workforce = projection.data
  const workers = useMemo(() => workforce?.workers ?? [], [workforce?.workers])
  const selected = workers.find((worker) => worker.id === selectedId) ?? workers[0] ?? null
  const sourceUnavailable = !session || projection.status === "error" || !workforce
  const pageStatus: DisplayStatus = sourceUnavailable
    ? "unavailable"
    : workforce.configurationState === "unconfigured"
      ? "unconfigured"
      : selected?.runtimeStatus ?? "unavailable"
  const assignments = selected ? workforce?.assignments.filter((item) => item.agentProfileId === selected.id) ?? [] : []
  const currentAssignments = assignments.filter((item) => ["queued", "claimed", "running", "waiting"].includes(item.state))
  const completedAssignments = assignments.filter((item) => item.state === "completed")
  const failedAssignments = assignments.filter((item) => item.state === "failed" || item.state === "reassigned")
  const proposals = selected ? workforce?.proposals.filter((proposal) => proposal.targetId === selected.id) ?? [] : []
  const learningRevisions = selected ? workforce?.learningRevisions.filter((revision) => revision.targetAgentProfileId === selected.id) ?? [] : []

  return (
    <main className="jarvis-agent-fleet-shell" data-jarvis-agent-fleet data-inspector-state={inspector ? "open" : "closed"}>
      <OperationalSurfaceNav active="agents" />

      <section className="jarvis-agent-fleet__intro">
        <div>
          <span className="jarvis-agent-fleet__eyebrow">GOVERNED AI WORKFORCE</span>
          <h1>Worker identity, assignment, and learning from backend truth.</h1>
          <p>P6 selects valid PlanNodes. This surface shows only configured P7 worker revisions, their exact grants, durable assignments, and verified learning evidence.</p>
        </div>
        <div className="jarvis-agent-fleet__intro-signal" data-source="api:read-models/workforce-status">
          <Bot size={18} aria-hidden />
          <span>
            <strong>{sourceUnavailable ? "Source unavailable" : workforce.configurationState === "unconfigured" ? "No configured AI workers" : `${workforce.page.totalCount ?? workers.length} configured AI worker${(workforce.page.totalCount ?? workers.length) === 1 ? "" : "s"}`}</strong>
            <small>{sourceUnavailable ? "No workforce state is being inferred" : `${workforce.currentAssignments.length} current · ${workforce.completedAssignments.length} completed · ${workforce.blockedOrFailedAssignments.length} failed/reassigned`}</small>
          </span>
        </div>
      </section>

      <div className="jarvis-agent-fleet__provider-strip" data-provider-status={pageStatus} data-source="api:read-models/workforce-status">
        <span className="jarvis-agent-fleet__provider-mark" aria-hidden><Activity size={16} /></span>
        <span className="jarvis-agent-fleet__provider-copy">
          <strong>{STATUS_COPY[pageStatus]}</strong>
          <small>{sourceUnavailable ? (session ? "The canonical workforce read failed." : "Sign in to read tenant-scoped workforce truth.") : `Canonical PostgreSQL${workforce.sourceStatus.status === "partial" ? ` · partial bounded view (${workforce.sourceStatus.truncatedSources.join(", ")})` : " · complete bounded view"} · as of ${displayTime(workforce.sourceStatus.asOf)}`}</small>
        </span>
        <span className="jarvis-agent-fleet__provider-scope">Source fact · no inferred health</span>
      </div>

      {!session ? <div className="jarvis-agent-fleet__auth-note" role="status"><span>Sign in to inspect the governed workforce.</span><Link href="/jarvis/login">Sign in <ArrowUpRight size={13} aria-hidden /></Link></div> : null}

      <div className="jarvis-agent-fleet__layout">
        <aside className="jarvis-agent-fleet__rail" aria-label="Configured AI workers" data-agent-fleet-rail>
          <div className="jarvis-agent-fleet__rail-heading"><span>AI WORKERS</span><strong>{sourceUnavailable ? "Unavailable" : workforce.configurationState}</strong></div>
          <div className="jarvis-agent-fleet__rail-list">
            {workers.map((worker) => (
              <button
                key={worker.id}
                type="button"
                className="jarvis-agent-fleet__rail-row"
                data-selected={selected?.id === worker.id ? "true" : "false"}
                data-agent-key={worker.key}
                aria-pressed={selected?.id === worker.id}
                onClick={() => { setSelectedId(worker.id); setInspector(null) }}
              >
                <span className="jarvis-agent-fleet__glyph" data-glyph="orb" aria-hidden><Bot size={17} strokeWidth={1.7} /><span className="jarvis-agent-fleet__glyph-ring" /></span>
                <span className="jarvis-agent-fleet__rail-row-copy"><strong>{worker.name}</strong><small>revision {worker.activeRevision?.revision ?? "none"} · {STATUS_COPY[worker.runtimeStatus]}</small></span>
                <span className="jarvis-agent-fleet__rail-row-state" aria-label={STATUS_COPY[worker.runtimeStatus]}>{worker.runtimeStatus === "working" ? "●" : worker.runtimeStatus === "idle" ? "○" : worker.runtimeStatus === "waiting" ? "…" : "!"}</span>
              </button>
            ))}
          </div>
          {workers.length === 0 ? <p className="jarvis-agent-fleet__rail-note">{sourceUnavailable ? "Workforce source unavailable." : "Unconfigured: no AgentProfile rows exist for this tenant."}</p> : <p className="jarvis-agent-fleet__rail-note">Status is derived from the active immutable revision and latest durable assignment.</p>}
        </aside>

        <section className="jarvis-agent-fleet__stage" data-agent-fleet-stage aria-labelledby="selected-agent-title">
          <header className="jarvis-agent-fleet__stage-header">
            <div className="jarvis-agent-fleet__stage-agent">
              <span className="jarvis-agent-fleet__glyph" data-glyph="orb" aria-hidden><Bot size={17} /><span className="jarvis-agent-fleet__glyph-ring" /></span>
              <div><span className="jarvis-agent-fleet__eyebrow">{selected ? "SELECTED AGENT PROFILE" : "WORKFORCE STATE"}</span><h2 id="selected-agent-title">{selected?.name ?? STATUS_COPY[pageStatus]}</h2></div>
            </div>
            <div className="jarvis-agent-fleet__stage-state" data-agent-status={pageStatus} data-source="api:read-models/workforce-status"><span className="jarvis-agent-fleet__state-dot" aria-hidden /><span>{STATUS_COPY[pageStatus]}{selected ? ` · load ${selected.currentLoad}/${selected.activeRevision?.maxConcurrentAssignments == null ? "UNKNOWN" : selected.activeRevision.maxConcurrentAssignments}` : ""}</span></div>
          </header>

          <div className="jarvis-agent-fleet__role-band">
            <span className="jarvis-agent-fleet__eyebrow">IDENTITY / AUTHORITY BOUNDARY</span>
            <p>{selected ? `AgentProfile ${selected.key} pins immutable revision ${selected.activeRevision?.revision ?? "none"}. Its grants permit attempts only; P6, Policy, Authority, and BusinessEffect gates remain authoritative.` : sourceUnavailable ? "Canonical workforce state cannot be read; no workers or activity are shown." : "This tenant has no configured AI worker identities. Static personas are not treated as workforce truth."}</p>
            <div className="jarvis-agent-fleet__authority"><ShieldCheck size={15} aria-hidden /><span>AI worker identity is distinct from every human approver, voter, verifier, signatory, and attestor.</span></div>
          </div>

          <div className="jarvis-agent-fleet__lanes">
            <FleetLane eyebrow="CURRENT OWNERSHIP" title={`${currentAssignments.length} current assignment${currentAssignments.length === 1 ? "" : "s"}`} icon={<CircleDot size={16} />}>
              {currentAssignments.length === 0 ? <p>{selected ? "No queued, claimed, running, or waiting assignment is recorded for this worker." : "No configured worker is selected."}</p> : <div className="jarvis-agent-fleet__activity-list">{currentAssignments.map((assignment) => <AssignmentRow key={assignment.id} assignment={assignment} onInspect={() => setInspector(assignment)} />)}</div>}
            </FleetLane>
            <FleetLane eyebrow="EXACT GRANTS" title={`${selected?.activeRevision ? selected.activeRevision.capabilityGrants.length : "UNKNOWN"} capabilities`} icon={<ShieldCheck size={16} />}>
              {selected?.activeRevision ? <div className="jarvis-agent-fleet__contract-list" aria-label={`${selected.name} capability grants`}>{selected.activeRevision.capabilityGrants.map((grant, index) => <div key={`${grant.kind}:${grant.capability}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{grant.kind}:{grant.capability}</strong></div>)}</div> : <p>No active immutable AgentProfileRevision is recorded.</p>}
            </FleetLane>
            <FleetLane eyebrow="VERIFIED EVIDENCE" title={`${selected ? selected.metrics.length : "UNKNOWN"} metric slices`} icon={<Activity size={16} />}>
              {!selected || selected.metrics.length === 0 ? <p>No verified performance metric slice is available. Performance remains UNKNOWN.</p> : <div className="jarvis-agent-fleet__contract-list">{selected.metrics.map((metric) => <div key={`${metric.agentRevisionId}:${metric.capability}:${metric.contextClass}`}><span>{metric.sampleState}</span><strong>{metric.capability} · {metric.verifiedCompletionCount}/{metric.qualityAttemptCount} verified quality attempts · completion {displayPercent(metric.verifiedCompletionRate)}</strong></div>)}</div>}
            </FleetLane>
            <FleetLane eyebrow="HISTORY" title={`${completedAssignments.length} completed · ${failedAssignments.length} failed/reassigned`} icon={<Activity size={16} />}>
              {assignments.length === 0 ? <p>No durable assignment history is recorded for this worker.</p> : <div className="jarvis-agent-fleet__activity-list">{assignments.slice(0, 8).map((assignment) => <AssignmentRow key={assignment.id} assignment={assignment} onInspect={() => setInspector(assignment)} />)}</div>}
            </FleetLane>
            <FleetLane eyebrow="GOVERNED LEARNING" title={`${proposals.length} proposals · ${learningRevisions.length} promoted revisions`} icon={<ShieldCheck size={16} />}>
              {proposals.length === 0 && learningRevisions.length === 0 ? <p>No source-backed LearningProposal or LearningRevision is recorded for this worker.</p> : <div className="jarvis-agent-fleet__contract-list">{proposals.map((proposal) => <div key={proposal.id}><span>{proposal.status}</span><strong>{proposal.proposedChange.class ? String(proposal.proposedChange.class).replaceAll("_", " ") : "bounded soft change"} · {proposal.sampleSize} observations</strong></div>)}{learningRevisions.map((revision) => <div key={revision.id}><span>R{revision.revision}</span><strong>Promoted from proposal {shortId(revision.sourceProposalId)}</strong></div>)}</div>}
            </FleetLane>
          </div>

          <footer className="jarvis-agent-fleet__stage-footer"><span>Source: {workforce?.sourceStatus.tables.join(", ") ?? "unavailable"}</span><span>As of {workforce ? displayTime(workforce.asOf) : "unavailable"}</span></footer>
        </section>

        {inspector ? <aside className="jarvis-agent-fleet__inspector" data-agent-fleet-inspector aria-label="Selected assignment inspector"><header><div><span className="jarvis-agent-fleet__eyebrow">ASSIGNMENT</span><h2>{inspector.capability}</h2></div><button type="button" onClick={() => setInspector(null)} aria-label="Close inspector"><X size={16} /></button></header><p>Assignment {inspector.id} pins worker revision {inspector.agentRevisionId}, PlanRevision {inspector.planRevisionId}, and node {inspector.planNodeId}. State: {inspector.state}. Started: {displayTime(inspector.startedAt)}. Completed: {displayTime(inspector.completedAt)}.</p></aside> : null}
      </div>
    </main>
  )
}
