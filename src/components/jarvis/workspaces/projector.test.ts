import { describe, expect, it } from "vitest"
import type { Thread } from "../kernel/store"
import { projectThreadWorkspace } from "./projector"

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1",
    sessionId: "session-1",
    instructionId: "instruction-1",
    workId: "work-1",
    source: "typed",
    instructionText: "Show inactive customers",
    createdAtMs: 1,
    machine: { instructionState: "completed" },
    nodes: [],
    contextChips: [],
    traceGating: { expectedCount: 0, resolvedActionIds: [], gatedActionIds: [] },
    clarification: null,
    submitError: null,
    approvalWatch: null,
    runWatch: null,
    terminalAtMs: 2,
    everExecuted: false,
    receiptRefreshTick: 0,
    ...overrides,
  }
}

describe("projectThreadWorkspace", () => {
  it("routes a typed cohort result to a cohort workspace", () => {
    const projected = projectThreadWorkspace(thread({
      answerResult: {
        kind: "answer",
        spokenSummary: "I found one customer.",
        query: {
          request: { intent: "customer_cohort" },
          metadata: { queryId: "query-1", source: "postgresql", durationMs: 4, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z" },
          result: {
            kind: "operational_query_result", version: 1, intent: "customer_cohort", status: "ok", source: { kind: "canonical_postgres", tables: ["households"] }, asOf: "2026-01-01T00:00:01Z", count: 1, truncated: false,
            page: { limit: 100, returned: 1, totalCount: 1, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false }, data: {}, cohort: "inactive", minDaysInactive: 90, cutoff: "2025-10-01T00:00:00Z", rows: [{ householdId: "h-1", displayName: "A Customer", address: "1 Main St", lastInteractionAt: null, qualifiesBecause: "never_active" }],
          },
        },
      },
    }))
    expect(projected.kind).toBe("customer-cohort")
    expect(projected.query?.result.intent).toBe("customer_cohort")
  })

  it("keeps failed action work in recovery", () => {
    expect(projectThreadWorkspace(thread({ machine: { instructionState: "failed" }, answerResult: null })).kind).toBe("recovery")
  })

  it("routes bulk action plans to campaign work", () => {
    expect(projectThreadWorkspace(thread({
      machine: { instructionState: "awaiting_approval" },
      answerResult: null,
      nodes: [{ id: "a-1", actionType: "bulk_notify_existing_customers", amountUsd: null, targetLabel: null, policyId: null, policyVersion: 1, groundedPayload: [], payload: { recipientCount: 12 } }],
    })).kind).toBe("campaign")
  })

  it("keeps a non-research answer out of the research workspace", () => {
    const projected = projectThreadWorkspace(thread({
      answerResult: { kind: "answer", spokenSummary: "The canonical answer is ready.", evidence: [{ source: "business_state", ref: "query-1" }] },
    }))
    expect(projected.kind).toBe("answer")
    expect(projected.title).toBe("Direct answer")
  })

  it("distinguishes internal answer actions from external research actions", () => {
    const answerNode = { id: "a-1", actionType: "answer_business_question", amountUsd: null, targetLabel: null, policyId: null, policyVersion: 1, groundedPayload: [], payload: {} }
    const webNode = { ...answerNode, id: "a-2", actionType: "search_web" }
    expect(projectThreadWorkspace(thread({ nodes: [answerNode], answerResult: { kind: "answer", spokenSummary: "Canonical answer." } })).kind).toBe("answer")
    expect(projectThreadWorkspace(thread({ nodes: [webNode], answerResult: { kind: "answer", spokenSummary: "Cited research." } })).kind).toBe("research")
  })
})
