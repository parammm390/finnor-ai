"use client"

import { useMemo } from "react"
import { Bot, ShieldCheck } from "lucide-react"
import { usePeProductData } from "../product/ProductDataProvider"
import { workObjectiveLabel } from "../product/deal-model"
import { DataTable, EmptyState, EntityLink, ErrorState, PageHeader, Skeleton, Status, TruthState } from "../product/primitives"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import { humanize, isInspectionTarget, refKey, type CompanyBrainEdge, type CompanyBrainNode, type WorkforceAssignmentProjection, type WorkforceWorkerProjection } from "../pe/contracts"

function rate(value: number | null): string {
  return value === null ? "UNKNOWN" : `${Math.round(value * 100)}%`
}

function failureReason(assignment: WorkforceAssignmentProjection | null, attention: string | null): string {
  if (attention) return attention
  if (!assignment?.failure) return assignment?.reassignmentReason ?? "No recorded blocker"
  const code = typeof assignment.failure.code === "string" ? assignment.failure.code : null
  const message = typeof assignment.failure.message === "string" ? assignment.failure.message : null
  return [code, message].filter(Boolean).join(" · ") || "Recorded assignment failure"
}

function assignmentLabel(assignment: WorkforceAssignmentProjection | null, nodes: CompanyBrainNode[]): string {
  if (!assignment) return "No current assignment"
  return nodes.find((node) => node.type === "plan_node" && node.ref.id === assignment.planNodeId)?.label ?? `${humanize(assignment.nodeKind)} assignment`
}

function connectedNodes(nodes: CompanyBrainNode[], edges: CompanyBrainEdge[], start: CompanyBrainNode, depth = 4): CompanyBrainNode[] {
  const index = new Map(nodes.map((node) => [refKey(node.ref), node]))
  const visited = new Set([refKey(start.ref)])
  let frontier = new Set(visited)
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>()
    for (const edge of edges) {
      const from = refKey(edge.fromRef)
      const to = refKey(edge.toRef)
      if (frontier.has(from) && !visited.has(to)) next.add(to)
      if (frontier.has(to) && !visited.has(from)) next.add(from)
    }
    if (!next.size) break
    next.forEach((key) => visited.add(key))
    frontier = next
  }
  return [...visited].flatMap((key) => index.get(key) ? [index.get(key)!] : [])
}

function AgentRow({ worker, profile, nodes, edges, dealNode }: { worker: WorkforceWorkerProjection; profile: CompanyBrainNode; nodes: CompanyBrainNode[]; edges: CompanyBrainEdge[]; dealNode: CompanyBrainNode | null }) {
  const operating = usePeOperatingContext()
  const product = usePeProductData()
  const assignment = worker.latestAssignment
  const assignmentNode = assignment ? nodes.find((node) => node.type === "agent_assignment" && node.ref.id === assignment.id) : null
  const workNode = assignment ? nodes.find((node) => node.type === "work" && node.ref.id === assignment.workId) : null
  const attention = assignment ? product.attention.data?.items.find((item) => item.workId === assignment.workId) ?? null : null
  const metrics = worker.metrics.filter((metric) => !assignment || metric.capability === assignment.capability)
  const verified = metrics.reduce((sum, item) => sum + item.verifiedCompletionCount, 0)
  const attempts = metrics.reduce((sum, item) => sum + item.qualityAttemptCount, 0)
  const quality = metrics.find((item) => item.sampleState === "KNOWN")
  const proposal = product.workforce.data?.proposals.find((item) => item.targetId === worker.id || item.targetAgentRevisionId === worker.activeRevision?.id)
  const learning = product.workforce.data?.learningRevisions.find((item) => item.targetAgentProfileId === worker.id)
  const evidenceAndOutcomes = assignmentNode ? connectedNodes(nodes, edges, assignmentNode).filter((node) => ["evidence_source", "evidence_version", "document", "document_version", "business_effect", "decision_receipt", "completion_proof"].includes(node.type)) : []
  const firstOutcome = evidenceAndOutcomes.find((node) => ["completion_proof", "decision_receipt", "business_effect"].includes(node.type)) ?? evidenceAndOutcomes[0]
  return <tr>
    <td>{isInspectionTarget(profile.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(profile.inspectionTarget, profile.ref)}><span className="pw-agent-name"><Bot size={14} /><strong>{worker.name}</strong></span></EntityLink> : worker.name}<small className="pw-cell-meta"><Status value={worker.runtimeStatus} /></small></td>
    <td>{assignment ? humanize(assignment.capability) : worker.activeRevision?.capabilityGrants.length ? worker.activeRevision.capabilityGrants.slice(0, 2).map((grant) => humanize(grant.capability)).join(", ") : "No active capability grant"}</td>
    <td>{assignmentNode && isInspectionTarget(assignmentNode.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(assignmentNode.inspectionTarget, assignmentNode.ref)}>{assignmentLabel(assignment, nodes)}</EntityLink> : assignmentLabel(assignment, nodes)}</td>
    <td>{assignment && dealNode && isInspectionTarget(dealNode.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(dealNode.inspectionTarget, dealNode.ref)}>{dealNode.label}</EntityLink> : assignment ? "Deal label unavailable" : "No active Deal assignment"}</td>
    <td>{workNode ? <EntityLink onOpen={() => operating.inspect(workNode.inspectionTarget, workNode.ref)}>{workObjectiveLabel(workNode, nodes, edges)}</EntityLink> : assignment ? "Linked Work label unavailable" : "No active Work"}</td>
    <td><Status value={assignment?.state ?? worker.runtimeStatus} /></td>
    <td>{attention?.nextHumanBoundary.description ?? (assignment?.state === "waiting" ? "Waiting boundary is recorded; inspect Work for exact condition." : "No active human boundary")}</td>
    <td>{failureReason(assignment?.state === "failed" || assignment?.state === "reassigned" ? assignment : null, attention?.reason ?? null)}</td>
    <td>{firstOutcome && isInspectionTarget(firstOutcome.inspectionTarget) ? <EntityLink onOpen={() => operating.inspect(firstOutcome.inspectionTarget, firstOutcome.ref)}>{humanize(firstOutcome.type)}</EntityLink> : attempts ? `${verified}/${attempts} verified` : "UNKNOWN"}<small className="pw-cell-meta">{evidenceAndOutcomes.length ? `${evidenceAndOutcomes.length} persisted evidence / outcome object(s) · ${verified}/${attempts} quality completions verified` : "No recorded evidence or verified outcome link"}</small></td>
    <td>{quality ? `${rate(quality.verifiedCompletionRate)} verified · ${rate(quality.qualityFailureRate)} quality failure` : "UNKNOWN"}</td>
    <td>{proposal ? <><Status value={proposal.status} /><small className="pw-cell-meta">{proposal.sampleSize} evidence samples</small></> : learning ? "Promoted learning revision" : "No proposed learning change"}</td>
  </tr>
}

export default function AgentFleetSurface() {
  const product = usePeProductData()
  const operating = usePeOperatingContext()
  const nodes = useMemo(() => product.brain.data?.nodes ?? [], [product.brain.data])
  const profileNodes = useMemo(() => nodes.filter((node) => node.type === "agent_profile"), [nodes])
  const profileById = useMemo(() => new Map(profileNodes.map((node) => [node.ref.id, node])), [profileNodes])
  const rootWorkIds = useMemo(() => new Set(nodes.filter((node) => node.type === "work").map((node) => node.ref.id)), [nodes])
  const workers = useMemo(() => (product.workforce.data?.workers ?? []).filter((worker) => {
    if (!profileById.has(worker.id)) return false
    return !worker.latestAssignment || rootWorkIds.has(worker.latestAssignment.workId)
  }), [product.workforce.data, profileById, rootWorkIds])
  const dealNode = nodes.find((node) => node.type === "pe_deal") ?? null
  const edges = product.brain.data?.edges ?? []

  return <main className="pw-page pw-agents-page">
    <PageHeader eyebrow="AGENTS · GOVERNED WORKFORCE" title="Business-shaped AI workforce" description="AgentProfile identity, immutable capabilities, assignments, human boundaries, verified quality, and learning remain distinct source-backed objects." actions={<span className="pw-authority-chip"><ShieldCheck size={14} /> Human authority remains backend-owned</span>} />
    {!operating.context.root ? <EmptyState title="Select a Deal or PE root" detail="Tenant-wide agents are not substituted without an exact persisted relationship to the current context." /> : null}
    {(product.brain.status === "loading" || product.workforce.status === "loading") && !product.workforce.data ? <Skeleton rows={8} label="Resolving governed workforce" /> : null}
    {product.brain.status === "error" && !product.brain.data ? <ErrorState title="Company Brain unavailable" detail={product.brain.error ?? "Agent relationships could not be resolved."} state={product.brain.truthState} onRetry={product.brain.reload} /> : null}
    {product.workforce.status === "error" ? <ErrorState title={product.workforce.data ? "Showing stale workforce data" : "Workforce read unavailable"} detail={product.workforce.error ?? "The canonical P7 read model failed."} state={product.workforce.data ? "STALE" : product.workforce.truthState} onRetry={product.workforce.reload} /> : null}
    {product.brain.data && product.workforce.data && workers.length ? <><section className="pw-agent-summary"><article><span>Root-linked workers</span><strong>{workers.length}</strong><TruthState state={product.workforce.truthState} compact /></article><article><span>Active assignments</span><strong>{workers.filter((worker) => worker.latestAssignment && ["queued", "claimed", "running", "waiting"].includes(worker.latestAssignment.state)).length}</strong><Status value="GOVERNED" /></article><article><span>Blocked / failed</span><strong>{workers.filter((worker) => worker.latestAssignment && ["failed", "reassigned"].includes(worker.latestAssignment.state)).length}</strong><Status value={workers.some((worker) => worker.latestAssignment && ["failed", "reassigned"].includes(worker.latestAssignment.state)) ? "ATTENTION" : "KNOWN EMPTY"} /></article></section>
      <DataTable label="Business-shaped governed AI workforce"><thead><tr><th>Agent</th><th>Capability</th><th>Current assignment</th><th>Deal</th><th>Work</th><th>Progress</th><th>Human boundary</th><th>Blocked reason</th><th>Evidence / outcome</th><th>Quality</th><th>Learning</th></tr></thead><tbody>{workers.map((worker) => <AgentRow key={worker.id} worker={worker} profile={profileById.get(worker.id)!} nodes={nodes} edges={edges} dealNode={dealNode} />)}</tbody></DataTable>
    </> : product.brain.data && product.workforce.data ? <EmptyState icon={<Bot size={20} />} title="Known empty: no root-linked governed worker" detail="No static persona, decorative agent, or tenant-wide worker was substituted." /> : null}
  </main>
}
