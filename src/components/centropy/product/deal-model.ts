import type { FirmDealProjectionSet } from "./contracts"
import type { ProductTruthState } from "./source-health"
import { refKey, type CompanyBrainEdge, type CompanyBrainNode, type CompanyBrainProjection, type CompanyBrainSearchResult, type PeWorldRootRef, type SemanticActivityProjection } from "../pe/contracts"

export interface DealMasterRow {
  root: PeWorldRootRef
  label: string
  status: string
  stageState: string
  investmentCaseState: string
  latestUnderwritingState: string
  criticalRisks: number
  openFindings: number
  openRequests: number
  icState: string
  riskPosture: string
  closingReadiness: string
  owner: string
  lastMaterialChange: string
  updatedAt: string | null
  truthHealth: ProductTruthState
  projection: CompanyBrainProjection | null
}

export function fact(node: CompanyBrainNode | undefined, key: string): unknown {
  return node?.facts.find((item) => item.key === key)?.value
}

export function textFact(node: CompanyBrainNode | undefined, key: string): string | null {
  const value = fact(node, key)
  return typeof value === "string" && value.trim() ? value : null
}

/** Prefer the persisted P6 Goal objective over Company Brain's deliberately
 * technical fallback label ("Work <id>"). The traversal uses only canonical
 * work → PlanRevision → Goal edges; it never invents a summary. */
export function workObjectiveLabel(node: CompanyBrainNode, nodes: CompanyBrainNode[], edges: CompanyBrainEdge[]): string {
  if (node.type !== "work") return node.label
  const workPlan = edges.find((edge) => edge.relationship === "work_plan_revision" && refKey(edge.fromRef) === refKey(node.ref))
  const planGoal = workPlan && edges.find((edge) => edge.relationship === "plan_revision_goal" && refKey(edge.fromRef) === refKey(workPlan.toRef))
  const goal = planGoal ? nodes.find((candidate) => refKey(candidate.ref) === refKey(planGoal.toRef)) : null
  return goal?.label ?? "Canonical Work"
}

/** Product-facing identity derived only from canonical labels and persisted
 * Company Brain edges. Relationship records that have no standalone business
 * text are described by their exact persisted endpoints instead of an ID. */
export function productNodeLabel(node: CompanyBrainNode, nodes: CompanyBrainNode[], edges: CompanyBrainEdge[]): string {
  if (node.type === "work") return workObjectiveLabel(node, nodes, edges)
  const relationship = node.type === "pe_dependency" ? "dependency_blocks"
    : node.type === "pe_finding_risk_link" ? "finding_risk"
      : node.type === "pe_document_link" ? "document_link"
        : node.type === "pe_evidence_link" ? "evidence_link"
          : null
  if (!relationship) return node.label
  const edge = edges.find((candidate) => candidate.relationship === relationship && candidate.sourceRef.id === node.ref.id)
  const from = edge ? nodes.find((candidate) => refKey(candidate.ref) === refKey(edge.fromRef)) : null
  const to = edge ? nodes.find((candidate) => refKey(candidate.ref) === refKey(edge.toRef)) : null
  return from && to ? `${from.label} → ${to.label}` : node.label
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function truthFor(projection: CompanyBrainProjection | null): ProductTruthState {
  if (!projection) return "UNAVAILABLE"
  if (projection.nodes.some((node) => node.epistemicState === "CONFLICTING")) return "CONFLICTING"
  if (projection.nodes.some((node) => node.epistemicState === "STALE")) return "STALE"
  if (projection.sourceStatus.some((source) => source.status !== "complete") || projection.bounds.truncated) return "PARTIAL"
  return projection.nodes.length ? "KNOWN" : "KNOWN_EMPTY"
}

export function isTerminalClosing(node: CompanyBrainNode): boolean {
  return ["satisfied", "waived", "completed", "closed", "removed", "resolved", "verified", "final"].includes((node.state ?? "").toLocaleLowerCase())
}

export function closingReadiness(nodes: CompanyBrainNode[]): string {
  const closing = nodes.filter((node) => node.type === "pe_closing_condition" || node.type === "pe_closing_item")
  if (!closing.length) return "No recorded closing objects"
  const ready = closing.filter(isTerminalClosing).length
  return `${ready}/${closing.length} terminal checks`
}

function riskPosture(nodes: CompanyBrainNode[]): string {
  const open = nodes.filter((node) => node.type === "pe_deal_risk" && !["resolved", "accepted"].includes((node.state ?? "").toLocaleLowerCase()))
  if (!open.length) return "No open recorded risk"
  const critical = open.filter((node) => String(fact(node, "severity") ?? "").toLocaleLowerCase() === "critical").length
  return critical ? `${critical} critical · ${open.length} open` : `${open.length} open · none recorded critical`
}

function nonTerminal(nodes: CompanyBrainNode[], type: CompanyBrainNode["type"], terminal: string[]): CompanyBrainNode[] {
  return nodes.filter((node) => node.type === type && !terminal.includes((node.state ?? "").toLocaleLowerCase()))
}

function latestActivity(activity: SemanticActivityProjection | null): { label: string; at: string | null } {
  const latest = [...(activity?.items ?? [])].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0]
  return latest ? { label: latest.change.label, at: latest.occurredAt } : { label: activity ? "Known empty: no semantic Activity" : "Activity unavailable", at: null }
}

function rowFor(root: PeWorldRootRef, label: string, projection: CompanyBrainProjection | null, activity: SemanticActivityProjection | null): DealMasterRow {
  const nodes = projection?.nodes ?? []
  const deal = nodes.find((node) => node.type === "pe_deal" && node.ref.id === root.entityId)
  const investmentCases = unique(nodes.filter((node) => node.type === "pe_investment_case").map((node) => node.state))
  const icStates = unique(nodes.filter((node) => node.type === "pe_ic_case").map((node) => node.state))
  const underwriting = nodes.filter((node) => node.type === "underwriting_run").sort((left, right) => right.asOf.localeCompare(left.asOf))[0]
  const criticalRisks = nonTerminal(nodes, "pe_deal_risk", ["resolved", "accepted"])
    .filter((node) => String(fact(node, "severity") ?? "").toLocaleLowerCase() === "critical").length
  const openFindings = nonTerminal(nodes, "pe_finding", ["resolved", "accepted", "closed"])
  const openRequests = nonTerminal(nodes, "pe_request", ["completed", "fulfilled", "resolved", "closed", "cancelled", "withdrawn"])
  const materialChange = latestActivity(activity)
  const owner = textFact(deal, "owner") ?? textFact(deal, "dealLead") ?? "No recorded owner in projection"
  const stage = textFact(deal, "stage")
  return {
    root,
    label: deal?.label ?? label,
    status: deal?.state ?? "UNKNOWN",
    stageState: stage ? `${stage} · ${deal?.state ?? "UNKNOWN"}` : deal?.state ?? "UNKNOWN",
    investmentCaseState: investmentCases.length ? investmentCases.join(", ") : "No recorded Investment Case",
    latestUnderwritingState: underwriting ? `${underwriting.state ?? "UNKNOWN"}${textFact(underwriting, "validity") ? ` · ${textFact(underwriting, "validity")}` : ""}` : "No recorded underwriting run",
    criticalRisks,
    openFindings: openFindings.length,
    openRequests: openRequests.length,
    icState: icStates.length ? icStates.join(", ") : "No recorded IC case",
    riskPosture: riskPosture(nodes),
    closingReadiness: closingReadiness(nodes),
    owner,
    lastMaterialChange: materialChange.label,
    updatedAt: materialChange.at,
    truthHealth: truthFor(projection),
    projection,
  }
}

export function buildDealMasterRows(roots: CompanyBrainSearchResult[], set: FirmDealProjectionSet | null): DealMasterRow[] {
  const dealRoots = [...new Map(roots.flatMap((item) => item.rootRefs)
    .filter((root) => root.entityType === "pe_deal")
    .map((root) => [root.entityId, root])).values()]
  const projectionByRoot = new Map((set?.items ?? []).map((item) => [item.root.entityId, item]))
  return dealRoots.map((root) => {
    const rootResult = roots.find((item) => item.rootRefs.some((candidate) => candidate.entityType === "pe_deal" && candidate.entityId === root.entityId))
    const item = projectionByRoot.get(root.entityId)
    return rowFor(root, rootResult?.label ?? "Deal label unavailable", item?.projection ?? null, item?.activity ?? null)
  })
}
