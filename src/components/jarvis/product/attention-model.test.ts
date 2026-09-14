import { describe, expect, it } from "vitest"
import { ATTENTION_CATEGORIES, buildAttentionRows } from "./attention-model"
import type { AttentionItem, AttentionQueueResult } from "./contracts"
import type { CompanyBrainNode, CompanyBrainProjection, CompanyBrainSearchResult, SemanticActivityProjection } from "../pe/contracts"

const dealId = "11111111-1111-4111-8111-111111111111"
const workId = "22222222-2222-4222-8222-222222222222"
const viewer = "33333333-3333-4333-8333-333333333333"
const root = { entityType: "pe_deal" as const, entityId: dealId }
const roots = [{ ref: { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_deal", id: dealId }, label: "Atlas", state: "active", rootRefs: [root], inspectionTarget: { kind: "pe_context", root } }] as CompanyBrainSearchResult[]

function attention(kind: string, index: number): AttentionItem {
  return {
    id: `${kind}:${index}`, workId, rootRefs: [{ ...root, relationship: "about", source: "test" }], kind, reason: `Reason ${kind}`,
    assignedOrEligibleActor: { employeeId: viewer, basis: "owner", capability: null }, deadline: null, slackMs: null, blocks: [], unblocks: [], authorityBoundary: null, recoveryBoundary: null,
    impact: { blocksWorkCompletion: kind !== "work_assigned", downstreamPlanNodes: 0, completionCriteria: 0, sourceBackedMateriality: null }, evidenceRefs: [],
    nextHumanBoundary: { kind: "govern", description: "Review the exact boundary", capability: null, executable: false },
    rankVector: { tuple: [1, 1, 0, 0, 1, 1, 1, index, `${kind}:${index}`] }, rankReason: { primary: "Server rank", factors: [] }, createdAt: `2026-09-13T00:00:0${index}.000Z`,
  }
}

function node(type: CompanyBrainNode["type"], id: string, label: string, state: string, facts: CompanyBrainNode["facts"]): CompanyBrainNode {
  const ref = { namespace: "private_equity", owner: "@finnor/private-equity", type, id } as CompanyBrainNode["ref"]
  return { ref, type, label, state, rootRefs: [root], version: 1, revision: 1, facts, asOf: "2026-09-13T00:00:00.000Z", temporal: { support: "canonical", completeness: "complete", baseline: null, reasons: [] }, epistemicState: "KNOWN", epistemicWarnings: [], provenanceRefs: [{ owner: "@finnor/private-equity", table: "canonical", id }], workRefs: [], inspectionTarget: { kind: "brain_object", ref }, availableActions: [] }
}

describe("Phase 9 ranked attention model", () => {
  it("uses the required category order while preserving source rank within a category", () => {
    const queue = { items: [attention("work_assigned", 1), attention("work_failure", 2), attention("p5_vote_required", 3), attention("approval_required", 4), attention("manual_verification_required", 5)], viewer: { employeeId: viewer }, status: "ok", sourceStatus: { status: "complete" }, asOf: "2026-09-13T00:00:00.000Z" } as AttentionQueueResult
    const rows = buildAttentionRows({ queue, roots, projection: null, activity: null })
    expect(rows.map((row) => row.category)).toEqual(["NEEDS DECISION", "NEEDS DECISION", "NEEDS EVIDENCE", "BLOCKED WORK", "IN MOTION"])
    expect(rows.slice(0, 2).map((row) => row.key)).toEqual(["attention:p5_vote_required:3", "attention:approval_required:4"])
    expect(rows.every((row) => ATTENTION_CATEGORIES.includes(row.category))).toBe(true)
    expect(rows[0]?.owner).toBe("You")
  })

  it("adds only persisted selected-context critical risk, closing, and semantic outcome rows", () => {
    const risk = node("pe_deal_risk", "44444444-4444-4444-8444-444444444444", "Leverage covenant", "open", [{ key: "severity", value: "critical", asOf: "2026-09-13T00:00:00.000Z", sourceRefs: [], epistemicState: "KNOWN" }])
    const closing = node("pe_closing_condition", "55555555-5555-4555-8555-555555555555", "Financing condition", "open", [])
    const verifiedClosing = node("pe_closing_item", "66666666-6666-4666-8666-666666666666", "Funds flow verified", "verified", [])
    const projection = { root, nodes: [risk, closing, verifiedClosing], edges: [], asOf: "2026-09-13T00:00:00.000Z", sourceStatus: [], temporal: { support: "canonical", completeness: "complete", baseline: null, reasons: [] }, bounds: { nodes: 3, edges: 0, truncated: false, maxNodes: 10, maxEdges: 10 } } as CompanyBrainProjection
    const activity = { root, items: [{ id: "event-1", occurredAt: "2026-09-13T01:00:00.000Z", bucket: "verified_outcomes", subjectRef: risk.ref, actor: "system", change: { type: "state", label: "Evidence verified" }, causalRefs: [], evidenceRefs: [{ type: "evidence", id: "e1" }], receiptRefs: [], proofRefs: [], inspectionTarget: risk.inspectionTarget }], sourceStatus: [] } as unknown as SemanticActivityProjection
    const rows = buildAttentionRows({ queue: null, roots, projection, activity })
    expect(rows.map((row) => row.category)).toEqual(["CRITICAL RISK", "CLOSING BLOCKER", "VERIFIED OUTCOME"])
    expect(rows.some((row) => row.object === "Funds flow verified" && row.category === "CLOSING BLOCKER")).toBe(false)
    expect(rows[0]?.deal).toBe("Active Deal")
  })
})
