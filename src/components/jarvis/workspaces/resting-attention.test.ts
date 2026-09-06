import { describe, expect, it } from "vitest"
import type { WorkCaseProjection, WorkCaseStatus } from "@/lib/jarvis-client"
import { projectRestingAttention, restingAttentionPresentation } from "./resting-attention"

function workCase(id: string, status: WorkCaseStatus, overrides: Partial<WorkCaseProjection> = {}): WorkCaseProjection {
  return {
    id,
    root: { kind: "work", id },
    title: `Work ${id}`,
    status,
    createdAt: "2026-08-15T08:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    source: { kind: "work", id, channel: "text" },
    instruction: null,
    actions: [],
    approvals: [],
    workflows: [],
    receipts: [],
    operations: [],
    linkedEntities: [],
    businessEvents: [],
    calls: [],
    relatedActionIds: [],
    provenance: ["works", "domain_actions"],
    ...overrides,
  }
}

describe("projectRestingAttention", () => {
  it("never claims a clear queue before canonical Work succeeds", () => {
    expect(restingAttentionPresentation({ itemCount: 0, loading: true, error: null, stale: false })).toMatchObject({
      heading: "Reading what needs attention…",
      showClearState: false,
    })
    expect(restingAttentionPresentation({ itemCount: 0, loading: false, error: "unavailable", stale: false })).toMatchObject({
      heading: "Operational attention is unavailable",
      truthLabel: "Projection unavailable",
      showClearState: false,
    })
    expect(restingAttentionPresentation({ itemCount: 0, loading: false, error: null, stale: false })).toMatchObject({
      heading: "No urgent Work is waiting",
      showClearState: true,
    })
  })
  it("shows only the three highest-priority canonical Work conditions", () => {
    const rows = [
      workCase("working", "Working"),
      workCase("approval", "Needs you", { approvals: [{ actionId: "a1", status: "pending", decidedBy: null, decidedAt: null, pendingConfirmationId: "p1" }] }),
      workCase("failure", "Failed", { durableWork: { id: "failure", status: "failed", sessionId: null, channel: "text", activeContext: null, initiatedBy: null, currentOwnerId: null, assignedTo: null, authorityContext: null, finalOutcome: null, failure: { message: "Provider did not confirm delivery" }, recovery: { message: "Retry delivery" } } }),
      workCase("schedule", "Needs you", { linkedEntities: [{ entityType: "work_order", entityId: "wo-1", via: "work" }] }),
      workCase("money", "Needs you", { linkedEntities: [{ entityType: "invoice", entityId: "inv-1", via: "action" }] }),
      workCase("complete", "Completed"),
      workCase("cancelled", "Cancelled"),
    ]

    const projected = projectRestingAttention(rows, Date.parse("2026-08-15T10:00:00.000Z"))
    expect(projected).toHaveLength(3)
    expect(projected.map((item) => item.workCase.id)).toEqual(["failure", "approval", "schedule"])
    expect(projected[0]).toMatchObject({ kind: "recovery", reason: "Provider did not confirm delivery", nextAction: "Retry delivery" })
  })

  it("keeps exact Work and entity identity in the inspection destination", () => {
    const [item] = projectRestingAttention([
      workCase("work-1", "Needs you", {
        linkedEntities: [
          { entityType: "household", entityId: "household-1", via: "context" },
          { entityType: "invoice", entityId: "invoice-1", via: "action" },
        ],
      }),
    ])

    expect(item?.href).toBe("/jarvis/work?workCaseId=work-1&householdId=household-1&invoiceId=invoice-1")
    expect(item?.source).toBe("works · domain_actions")
  })

  it("promotes a due waiting objective without treating ordinary in-flight Work as urgent", () => {
    const projected = projectRestingAttention([
      workCase("due", "Waiting", { objectiveLoop: { id: "objective", objective: "Follow up", state: "waiting", revision: 1, reason: "Customer reply window elapsed", nextStep: "Re-inspect the customer record", nextRunAt: "2026-08-15T09:00:00.000Z", lastObservation: null, budget: { steps: 1, maxSteps: 10, actions: 0, maxActions: 5, queries: 1, maxQueries: 10 }, iterations: [] } }),
      workCase("future", "Waiting", { objectiveLoop: { id: "future", objective: "Wait", state: "waiting", revision: 1, reason: null, nextStep: null, nextRunAt: "2026-08-16T09:00:00.000Z", lastObservation: null, budget: { steps: 1, maxSteps: 10, actions: 0, maxActions: 5, queries: 1, maxQueries: 10 }, iterations: [] } }),
      workCase("working", "Working"),
    ], Date.parse("2026-08-15T10:00:00.000Z"))

    expect(projected.map((item) => item.workCase.id)).toEqual(["due"])
    expect(projected[0]?.reason).toBe("Customer reply window elapsed")
  })

  it("surfaces partial terminal outcomes for review", () => {
    const projected = projectRestingAttention([workCase("partial", "Partial")])
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({ kind: "recovery" })
  })
})
