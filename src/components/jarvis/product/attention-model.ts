import type { AttentionItem, AttentionQueueResult } from "./contracts"
import type { ProductTruthState } from "./source-health"
import type {
  CompanyBrainNode,
  CompanyBrainProjection,
  CompanyBrainSearchResult,
  InspectionTarget,
  PeWorldRootRef,
  SemanticActivityProjection,
} from "../pe/contracts"
import { isTerminalClosing, productNodeLabel } from "./deal-model"

export const ATTENTION_CATEGORIES = [
  "NEEDS DECISION",
  "NEEDS EVIDENCE",
  "CRITICAL RISK",
  "CLOSING BLOCKER",
  "BLOCKED WORK",
  "IN MOTION",
  "VERIFIED OUTCOME",
] as const

export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number]

export interface ProductAttentionRow {
  key: string
  category: AttentionCategory
  deal: string
  object: string
  reason: string
  impact: string
  owner: string
  deadline: string | null
  evidenceState: ProductTruthState
  nextAction: string
  target: InspectionTarget
  root: PeWorldRootRef | null
  workId: string | null
  occurredAt: string
  sourceRank: number
}

const decisionKinds = new Set(["approval_required", "p5_vote_required", "p5_decision_required", "learning_proposal_review"])
const evidenceKinds = new Set(["clarification_required", "human_attestation_required", "manual_verification_required", "p5_question_blocking", "p5_condition_active", "human_only_boundary"])

function categoryForAttention(item: AttentionItem): AttentionCategory {
  if (decisionKinds.has(item.kind)) return "NEEDS DECISION"
  if (evidenceKinds.has(item.kind)) return "NEEDS EVIDENCE"
  if (item.kind === "work_assigned") return "IN MOTION"
  return "BLOCKED WORK"
}

function dealRoot(item: AttentionItem): PeWorldRootRef | null {
  const root = item.rootRefs.find((candidate) => candidate.entityType === "pe_deal")
  return root ? { entityType: "pe_deal", entityId: root.entityId } : null
}

function labelForRoot(root: PeWorldRootRef | null, roots: CompanyBrainSearchResult[]): string {
  if (!root) return "No recorded Deal link"
  return roots.find((item) => item.rootRefs.some((candidate) => candidate.entityType === root.entityType && candidate.entityId === root.entityId))?.label ?? "Deal label unavailable"
}

function nodeFact(node: CompanyBrainNode, key: string): unknown {
  return node.facts.find((fact) => fact.key === key)?.value
}

function dateFact(node: CompanyBrainNode): string | null {
  const raw = nodeFact(node, "dueAt") ?? nodeFact(node, "targetAt") ?? nodeFact(node, "targetClosingAt")
  return typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? raw : null
}

function evidenceState(node: CompanyBrainNode): ProductTruthState {
  if (node.epistemicState === "CONFLICTING") return "CONFLICTING"
  if (node.epistemicState === "STALE") return "STALE"
  if (node.epistemicState === "UNKNOWN") return "UNKNOWN"
  return node.provenanceRefs.length ? "KNOWN" : "KNOWN_EMPTY"
}

function attentionRows(queue: AttentionQueueResult | null, roots: CompanyBrainSearchResult[]): ProductAttentionRow[] {
  return (queue?.items ?? []).map((item, index) => {
    const root = dealRoot(item)
    return {
      key: `attention:${item.id}`,
      category: categoryForAttention(item),
      deal: labelForRoot(root, roots),
      object: item.kind.replaceAll("_", " "),
      reason: item.reason,
      impact: item.impact.blocksWorkCompletion
        ? `Blocks completion${item.impact.completionCriteria ? ` · ${item.impact.completionCriteria} criterion${item.impact.completionCriteria === 1 ? "" : "a"}` : ""}`
        : item.rankReason.primary,
      owner: item.assignedOrEligibleActor.employeeId === queue?.viewer.employeeId ? "You" : "Assigned team member",
      deadline: item.deadline,
      evidenceState: item.evidenceRefs.length ? "KNOWN" : "KNOWN_EMPTY",
      nextAction: item.nextHumanBoundary.description,
      target: { kind: "attention", attentionId: item.id, workId: item.workId },
      root,
      workId: item.workId,
      occurredAt: item.createdAt,
      sourceRank: index,
    }
  })
}

function projectionRows(projection: CompanyBrainProjection | null): ProductAttentionRow[] {
  if (!projection) return []
  const deal = projection.nodes.find((node) => node.type === "pe_deal")?.label ?? "Active Deal"
  const rows: ProductAttentionRow[] = []
  for (const node of projection.nodes) {
    const state = (node.state ?? "").toLocaleLowerCase()
    const severity = String(nodeFact(node, "severity") ?? "").toLocaleLowerCase()
    const terminalRisk = ["resolved", "accepted"].includes(state)
    const isCriticalRisk = node.type === "pe_deal_risk" && severity === "critical" && !terminalRisk
    const isClosingBlocker = (node.type === "pe_closing_condition" || node.type === "pe_closing_item") && !isTerminalClosing(node)
    if (!isCriticalRisk && !isClosingBlocker) continue
    const action = node.availableActions[0]
    rows.push({
      key: `${node.ref.namespace}:${node.ref.type}:${node.ref.id}`,
      category: isCriticalRisk ? "CRITICAL RISK" : "CLOSING BLOCKER",
      deal,
      object: productNodeLabel(node, projection.nodes, projection.edges),
      reason: isCriticalRisk ? "A persisted critical Deal Risk remains non-terminal." : "A persisted transaction-closing object remains non-terminal.",
      impact: isCriticalRisk ? `Risk state · ${node.state ?? "UNKNOWN"}` : `Closing state · ${node.state ?? "UNKNOWN"}`,
      owner: "No recorded owner",
      deadline: dateFact(node),
      evidenceState: evidenceState(node),
      nextAction: action?.label ?? "Inspect the source-backed object and its relationships.",
      target: node.inspectionTarget,
      root: projection.root,
      workId: node.workRefs[0]?.workId ?? null,
      occurredAt: node.asOf,
      sourceRank: rows.length,
    })
  }
  return rows
}

function activityRows(activity: SemanticActivityProjection | null, projection: CompanyBrainProjection | null): ProductAttentionRow[] {
  if (!activity) return []
  const deal = projection?.nodes.find((node) => node.type === "pe_deal")?.label ?? "Active Deal"
  const nodeByRef = new Map((projection?.nodes ?? []).map((node) => [`${node.ref.namespace}:${node.ref.type}:${node.ref.id}`, node]))
  return activity.items.flatMap((item, index): ProductAttentionRow[] => {
    if (item.bucket === "needs_attention") return []
    const node = nodeByRef.get(`${item.subjectRef.namespace}:${item.subjectRef.type}:${item.subjectRef.id}`)
    return [{
      key: `activity:${item.id}`,
      category: item.bucket === "verified_outcomes" ? "VERIFIED OUTCOME" : "IN MOTION",
      deal,
      object: node ? productNodeLabel(node, projection?.nodes ?? [], projection?.edges ?? []) : item.change.label,
      reason: item.change.label,
      impact: item.bucket === "verified_outcomes" ? "Persisted outcome with a semantic source event." : "Persisted execution movement; completion is not inferred.",
      owner: item.actorRef ? `${item.actor} actor` : item.actor,
      deadline: null,
      evidenceState: item.evidenceRefs.length || item.receiptRefs.length || item.proofRefs.length ? "KNOWN" : "KNOWN_EMPTY",
      nextAction: item.bucket === "verified_outcomes" ? "Inspect outcome evidence and causal lineage." : "Inspect current Work and its next authority boundary.",
      target: item.inspectionTarget,
      root: projection?.root ?? activity.root,
      workId: item.workId ?? null,
      occurredAt: item.occurredAt,
      sourceRank: index,
    }]
  })
}

export function buildAttentionRows(input: {
  queue: AttentionQueueResult | null
  roots: CompanyBrainSearchResult[]
  projection: CompanyBrainProjection | null
  activity: SemanticActivityProjection | null
}): ProductAttentionRow[] {
  const categoryRank = new Map(ATTENTION_CATEGORIES.map((category, index) => [category, index]))
  const candidates = [
    ...attentionRows(input.queue, input.roots),
    ...projectionRows(input.projection),
    ...activityRows(input.activity, input.projection),
  ]
  const unique = [...new Map(candidates.map((row) => [`${row.category}:${row.target.kind}:${row.object}:${row.workId ?? ""}`, row])).values()]
  return unique.sort((left, right) => {
    const category = (categoryRank.get(left.category) ?? 99) - (categoryRank.get(right.category) ?? 99)
    if (category !== 0) return category
    if (left.category === "VERIFIED OUTCOME" || left.category === "IN MOTION") return right.occurredAt.localeCompare(left.occurredAt)
    return left.sourceRank - right.sourceRank || left.key.localeCompare(right.key)
  })
}
