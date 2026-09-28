"use client"

import { useEffect, useState } from "react"
import { RefreshCw, RotateCcw } from "lucide-react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { WorkAggregateView } from "@/components/centropy/product/contracts"

const UUID = z.string().uuid()
const AssignmentSchema = z.object({
  id: UUID, workId: UUID, planRevisionId: UUID, planNodeId: z.string(), objectiveLoopId: UUID.nullable(), objectiveStepId: UUID.nullable(),
  agentProfileId: UUID, agentRevisionId: UUID, capability: z.string(), nodeKind: z.string(),
  state: z.string(), attempt: z.number().int(), assignmentReason: z.string(),
  previousAssignmentId: UUID.nullable(), reassignmentReason: z.string().nullable(),
  domainActionId: UUID.nullable(), failure: z.record(z.unknown()).nullable(),
  startedAt: z.string().nullable(), completedAt: z.string().nullable(), createdAt: z.string(),
}).passthrough()
const WorkerSchema = z.object({
  id: UUID, name: z.string(), key: z.string(), profileStatus: z.string(),
  activeRevision: z.object({ id: UUID, revision: z.number().int(), capabilityGrants: z.array(z.object({ capability: z.string(), kind: z.string() }).passthrough()) }).passthrough().nullable(),
}).passthrough()
const PageSchema = z.object({
  view: z.literal("workforce-status"),
  data: z.object({
    configurationState: z.enum(["configured", "unconfigured"]),
    assignments: z.array(AssignmentSchema), currentAssignments: z.array(AssignmentSchema),
    workers: z.array(WorkerSchema), asOf: z.string(),
    page: z.object({ hasMore: z.boolean(), nextCursor: UUID.nullable() }).passthrough(),
    sourceStatus: z.object({ status: z.enum(["complete", "partial"]), truncatedSources: z.array(z.string()) }).passthrough(),
  }).passthrough(),
}).passthrough()

type Assignment = z.infer<typeof AssignmentSchema>
type Worker = z.infer<typeof WorkerSchema>
interface WorkforceRead { assignments: Assignment[]; workers: Worker[]; asOf: string; configured: boolean; partial: boolean; truncatedSources: string[] }
const label = (value: string) => value.replaceAll("_", " ").toLowerCase()
function dateLabel(value: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded" }
function failureLabel(value: Record<string, unknown> | null) { return value && typeof value.code === "string" ? label(value.code) : value && typeof value.message === "string" ? value.message : null }

async function readWorkforce(workId: string): Promise<WorkforceRead> {
  const assignments = new Map<string, Assignment>()
  const workers = new Map<string, Worker>()
  let cursor: string | null = null
  let asOf = ""
  let configured = false
  let partial = false
  const truncatedSources = new Set<string>()
  for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
    const response: unknown = await centropyGet("read-models/workforce-status", { limit: "100", ...(cursor ? { cursor } : {}) })
    const parsed = PageSchema.parse(response).data
    if (!Number.isFinite(Date.parse(parsed.asOf))) throw new Error("Workforce read omitted its as-of time.")
    if (pageNumber > 0) partial = true // Pagination has no shared snapshot token.
    asOf = parsed.asOf
    configured ||= parsed.configurationState === "configured"
    partial ||= parsed.sourceStatus.status === "partial"
    parsed.sourceStatus.truncatedSources.forEach((source) => truncatedSources.add(source))
    parsed.workers.forEach((worker) => workers.set(worker.id, worker))
    for (const assignment of [...parsed.assignments, ...parsed.currentAssignments]) {
      if (assignment.workId === workId) assignments.set(assignment.id, assignment)
    }
    if (!parsed.page.hasMore) return { assignments: [...assignments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), workers: [...workers.values()], asOf, configured, partial, truncatedSources: [...truncatedSources] }
    if (!parsed.page.nextCursor || parsed.page.nextCursor === cursor) throw new Error("Workforce pagination did not advance.")
    cursor = parsed.page.nextCursor
  }
  return { assignments: [...assignments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), workers: [...workers.values()], asOf, configured, partial: true, truncatedSources: [...new Set([...truncatedSources, "agent_profiles beyond page 3"])] }
}

export function WorkforceAssignments({ workId, aggregate, onChanged }: { workId: string; aggregate: WorkAggregateView | null; onChanged: () => void }) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ data: WorkforceRead | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [reassigningId, setReassigningId] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [controlNotice, setControlNotice] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setState((previous) => ({ data: previous.data, error: null, loading: true }))
    void readWorkforce(workId).then((data) => { if (active) setState({ data, error: null, loading: false }) })
      .catch((cause) => { if (active) setState((previous) => ({ data: previous.data, error: cause instanceof Error ? cause.message : "Workforce status unavailable", loading: false })) })
    return () => { active = false }
  }, [workId, revision])

  const workActive = Boolean(aggregate && !["completed", "failed", "cancelled"].includes(aggregate.work.status))
  const assignmentActive = Boolean(state.data?.assignments.some((assignment) => ["queued", "claimed", "running", "waiting"].includes(assignment.state)))
  useEffect(() => {
    if (state.loading || (!workActive && !assignmentActive)) return
    const timer = window.setTimeout(() => setRevision((value) => value + 1), 2_500)
    return () => window.clearTimeout(timer)
  }, [assignmentActive, state.data, state.loading, workActive])

  async function reassign(assignment: Assignment) {
    if (reassigningId || !["queued", "claimed", "running", "waiting"].includes(assignment.state)) return
    setReassigningId(assignment.id); setControlError(null); setControlNotice(null)
    try {
      const result = await centropyPost<{ assignment: Assignment }>(`workforce/assignments/${assignment.id}/reassign`, {})
      if (result.assignment?.id !== assignment.id || result.assignment.state !== "reassigned") throw new Error("The reassignment response did not confirm this exact specialist assignment.")
      setReviewingId(null)
      setControlNotice(`Assignment ${assignment.id.slice(0, 8)} was relinquished. The Objective will select an eligible specialist in a new recorded assignment.`)
      setRevision((value) => value + 1)
      onChanged()
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : "Specialist reassignment could not be confirmed. Refresh before trying again.")
    } finally { setReassigningId(null) }
  }

  const workers = new Map(state.data?.workers.map((worker) => [worker.id, worker]) ?? [])
  return <section className="ct-workforce" aria-label="Persisted specialist assignments">
    <header><div><span className="ct-eyebrow">WORKFORCE / EXACT WORK</span><strong>Specialist assignments</strong></div><button type="button" aria-label="Refresh specialist assignments" onClick={() => setRevision((value) => value + 1)} disabled={state.loading}><RefreshCw size={14} /></button></header>
    {state.loading ? <p role="status">Reading persisted assignments…</p> : null}
    {state.error ? <p role="alert" className="ct-workforce__error">{state.error}</p> : null}
    {controlError ? <p role="alert" className="ct-workforce__error">{controlError}</p> : null}
    {controlNotice ? <p role="status">{controlNotice}</p> : null}
    {state.data ? <>
      <p>{state.data.assignments.length} assignment{state.data.assignments.length === 1 ? "" : "s"} linked to this Work · as of {dateLabel(state.data.asOf)}{state.data.partial ? " · partial workforce read" : ""}</p>
      {state.data.truncatedSources.length ? <p className="ct-workforce__caveat">Limited sources: {state.data.truncatedSources.map(label).join(", ")}.{state.data.truncatedSources.some((source) => /agent_profiles|workforce_assignments/.test(source)) ? " Additional assignments may exist." : " Assignment history is shown separately from those limited sources."}</p> : null}
      {!state.data.configured ? <p>No agent profile is configured in the current tenant read.</p> : null}
      {state.data.configured && !state.data.assignments.length ? <p>No specialist assignment is recorded for this Work within the loaded workforce scope.</p> : null}
      <ol>{state.data.assignments.map((assignment) => {
        const worker = workers.get(assignment.agentProfileId)
        const action = aggregate?.actions.find((item) => item.id === assignment.domainActionId)
        const effect = aggregate?.businessEffects.find((item) => item.domainActionId === assignment.domainActionId)
        const receipt = aggregate?.receipts.find((item) => item.domainActionId === assignment.domainActionId)
        return <li key={assignment.id} data-state={assignment.state}><div><strong>{worker?.name ?? `Agent profile ${assignment.agentProfileId.slice(0, 8)}`}</strong><span>{label(assignment.state)}</span></div><p>{label(assignment.nodeKind)} · {label(assignment.capability)} · attempt {assignment.attempt}</p><p>Reason · {assignment.assignmentReason}</p><dl><div><dt>Profile</dt><dd>{worker ? `${worker.key} · ${label(worker.profileStatus)}` : "Outside loaded profile page"}</dd></div><div><dt>Revision</dt><dd>{worker?.activeRevision?.id === assignment.agentRevisionId ? worker.activeRevision.revision : assignment.agentRevisionId.slice(0, 8)}</dd></div><div><dt>Objective</dt><dd>{assignment.objectiveLoopId ?? "Not linked"}</dd></div><div><dt>Objective step</dt><dd>{assignment.objectiveStepId ?? "Not linked"}</dd></div><div><dt>Plan node</dt><dd>{assignment.planNodeId}</dd></div><div><dt>Started</dt><dd>{dateLabel(assignment.startedAt)}</dd></div></dl>{failureLabel(assignment.failure) ? <p className="ct-workforce__caveat">Failure · {failureLabel(assignment.failure)}</p> : null}{assignment.reassignmentReason ? <p className="ct-workforce__caveat">Reassignment · {assignment.reassignmentReason}</p> : null}{assignment.domainActionId ? <p>Linked action {assignment.domainActionId.slice(0, 8)} · {action ? label(action.status) : "not in loaded Work"} · effect {effect ? label(effect.status) : "not recorded"} · receipt {receipt ? receipt.finalizedAt ? "finalized" : "pending" : "not recorded"}</p> : <p>No domain action linked to this assignment.</p>}{worker?.activeRevision?.id === assignment.agentRevisionId ? <details><summary>Capability grants · {worker.activeRevision.capabilityGrants.length}</summary><ul>{worker.activeRevision.capabilityGrants.map((grant) => <li key={`${grant.kind}:${grant.capability}`}>{label(grant.kind)} · {grant.capability}</li>)}</ul></details> : null}{["queued", "claimed", "running", "waiting"].includes(assignment.state) && workActive ? reviewingId === assignment.id ? <div className="ct-workforce__review"><p>Relinquish this exact assignment? The backend will retain it as reassigned and schedule the Objective to select an eligible specialist. An in-flight worker is fenced from completing this assignment.</p><button type="button" onClick={() => setReviewingId(null)} disabled={reassigningId === assignment.id}>Cancel</button><button type="button" onClick={() => void reassign(assignment)} disabled={reassigningId === assignment.id}><RotateCcw size={13} /> {reassigningId === assignment.id ? "Reassigning…" : "Confirm reassignment"}</button></div> : <button type="button" className="ct-workforce__reassign" onClick={() => { setReviewingId(assignment.id); setControlError(null) }}><RotateCcw size={13} /> Reassign specialist</button> : null}</li>
      })}</ol>
    </> : null}
  </section>
}
