import { describe, expect, it } from "vitest"
import { peProjectionMetrics } from "./projection-metrics"
import type { CompanyBrainNode, CompanyBrainProjection, SemanticActivityProjection } from "./contracts"

function node(type: CompanyBrainNode["type"], state: string | null, facts: CompanyBrainNode["facts"] = []): CompanyBrainNode {
  const ref = { namespace: "private_equity", owner: "@finnor/private-equity", type: type as "pe_deal", id: "11111111-1111-4111-8111-111111111111" } as CompanyBrainNode["ref"]
  return { ref, type, label: type, state, rootRefs: [{ entityType: "pe_deal", entityId: ref.id }], version: 1, revision: null, facts, asOf: "2026-09-12T00:00:00.000Z", temporal: { support: "current_only", completeness: "unsupported", baseline: null, reasons: [] }, epistemicState: "KNOWN", epistemicWarnings: [], provenanceRefs: [], workRefs: [], inspectionTarget: { kind: "brain_object", ref }, availableActions: [] }
}

describe("PE projection metrics", () => {
  it("counts only exact root-scoped states and never guesses missing severity", () => {
    const brain = { nodes: [node("pe_deal", "active"), node("pe_request", "open"), node("pe_finding", "open"), node("pe_deal_risk", "open"), node("pe_deal_risk", "open", [{ key: "severity", value: "critical", asOf: "2026-09-12T00:00:00.000Z", sourceRefs: [], epistemicState: "KNOWN" }]), node("pe_closing_condition", "satisfied"), node("pe_closing_item", "open")], edges: [] } as unknown as CompanyBrainProjection
    const result = peProjectionMetrics(brain, null)
    expect(result).toMatchObject({ openDeals: 1, openRequests: 1, openFindings: 1, criticalDealRisks: 1, closingChecks: { ready: 1, recorded: 2 }, needsAttention: null, inMotion: null, verifiedOutcomes: null })
  })

  it("keeps semantic buckets separate", () => {
    const activity = { items: [{ bucket: "needs_attention" }, { bucket: "in_motion" }, { bucket: "verified_outcomes" }, { bucket: "verified_outcomes" }] } as SemanticActivityProjection
    expect(peProjectionMetrics({ nodes: [] } as unknown as CompanyBrainProjection, activity)).toMatchObject({ needsAttention: 1, inMotion: 1, verifiedOutcomes: 2 })
  })
})
