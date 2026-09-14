import { describe, expect, it } from "vitest"
import { buildDealMasterRows } from "./deal-model"
import type { CompanyBrainNode, CompanyBrainProjection, CompanyBrainSearchResult } from "../pe/contracts"

const dealId = "11111111-1111-4111-8111-111111111111"
const root = { entityType: "pe_deal" as const, entityId: dealId }

function node(type: CompanyBrainNode["type"], id: string, label: string, state: string | null, facts: CompanyBrainNode["facts"] = []): CompanyBrainNode {
  const namespace = type === "work" ? "core" : "private_equity"
  const owner = type === "work" ? "@finnor/db" : "@finnor/private-equity"
  const ref = { namespace, owner, type, id } as CompanyBrainNode["ref"]
  return { ref, type, label, state, rootRefs: [root], version: 1, revision: 1, facts, asOf: "2026-09-13T00:00:00.000Z", temporal: { support: "canonical", completeness: "complete", baseline: null, reasons: [] }, epistemicState: "KNOWN", epistemicWarnings: [], provenanceRefs: [{ owner: owner as "@finnor/db", table: "source", id }], workRefs: [], inspectionTarget: type === "work" ? { kind: "work", workId: id } : { kind: "brain_object", ref }, availableActions: [] }
}

describe("Phase 9 Deal master model", () => {
  it("derives business columns from Company Brain and never turns an absent sector into a fact", () => {
    const deal = node("pe_deal", dealId, "Atlas", "active", [{ key: "targetClosingAt", value: "2026-10-01T00:00:00.000Z", asOf: "2026-09-13T00:00:00.000Z", sourceRefs: [], epistemicState: "KNOWN" }])
    const risk = node("pe_deal_risk", "22222222-2222-4222-8222-222222222222", "Leverage", "open", [{ key: "severity", value: "critical", asOf: "2026-09-13T00:00:00.000Z", sourceRefs: [], epistemicState: "KNOWN" }])
    const condition = node("pe_closing_condition", "33333333-3333-4333-8333-333333333333", "Financing", "satisfied")
    const work = node("work", "44444444-4444-4444-8444-444444444444", "Verify financing", "executing")
    const projection = { root, nodes: [deal, risk, condition, work], edges: [], asOf: "2026-09-13T00:00:00.000Z", sourceStatus: [{ owner: "@finnor/private-equity", status: "complete" }], temporal: { support: "canonical", completeness: "complete", baseline: null, reasons: [] }, bounds: { nodes: 4, edges: 0, truncated: false, maxNodes: 10, maxEdges: 10 } } as CompanyBrainProjection
    const roots = [{ label: "Atlas", rootRefs: [root] }] as CompanyBrainSearchResult[]
    const [row] = buildDealMasterRows(roots, { items: [{ root, projection, activity: null }], requested: 1, failedRoots: [], failedActivityRoots: [root] })
    expect(row).toMatchObject({ label: "Atlas", stageState: "active", criticalRisks: 1, openFindings: 0, openRequests: 0, riskPosture: "1 critical · 1 open", closingReadiness: "1/1 terminal checks", lastMaterialChange: "Activity unavailable", truthHealth: "KNOWN" })
  })

  it("keeps an unavailable Deal row instead of dropping it", () => {
    const roots = [{ label: "Atlas", rootRefs: [root] }] as CompanyBrainSearchResult[]
    const [row] = buildDealMasterRows(roots, { items: [], requested: 1, failedRoots: [root], failedActivityRoots: [] })
    expect(row).toMatchObject({ label: "Atlas", status: "UNKNOWN", truthHealth: "UNAVAILABLE", closingReadiness: "No recorded closing objects" })
  })
})
