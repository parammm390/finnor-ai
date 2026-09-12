import type { CompanyBrainNode, CompanyBrainProjection, SemanticActivityProjection } from "./contracts"

function normalized(value: string | null): string {
  return value?.toLocaleLowerCase() ?? ""
}

function fact(node: CompanyBrainNode, key: string): unknown {
  return node.facts.find((candidate) => candidate.key === key)?.value
}

export interface PeProjectionMetrics {
  openDeals: number
  openRequests: number
  openFindings: number
  criticalDealRisks: number
  pendingApprovalActions: number
  closingChecks: { ready: number; recorded: number }
  needsAttention: number | null
  inMotion: number | null
  verifiedOutcomes: number | null
}

export function peProjectionMetrics(brain: CompanyBrainProjection, activity: SemanticActivityProjection | null): PeProjectionMetrics {
  const nodes = brain.nodes
  const closing = nodes.filter((node) => node.type === "pe_closing_condition" || node.type === "pe_closing_item")
  const readyClosingStates = new Set(["satisfied", "waived", "verified"])
  return {
    openDeals: nodes.filter((node) => node.type === "pe_deal" && normalized(node.state) === "active").length,
    openRequests: nodes.filter((node) => node.type === "pe_request" && ["open", "acknowledged"].includes(normalized(node.state))).length,
    openFindings: nodes.filter((node) => node.type === "pe_finding" && normalized(node.state) === "open").length,
    criticalDealRisks: nodes.filter((node) => node.type === "pe_deal_risk" && normalized(fact(node, "severity") as string | null) === "critical" && !["resolved", "accepted"].includes(normalized(node.state))).length,
    pendingApprovalActions: nodes.filter((node) => node.type === "domain_action" && normalized(node.state) === "pending").length,
    closingChecks: { ready: closing.filter((node) => readyClosingStates.has(normalized(node.state))).length, recorded: closing.length },
    needsAttention: activity ? activity.items.filter((item) => item.bucket === "needs_attention").length : null,
    inMotion: activity ? activity.items.filter((item) => item.bucket === "in_motion").length : null,
    verifiedOutcomes: activity ? activity.items.filter((item) => item.bucket === "verified_outcomes").length : null,
  }
}
