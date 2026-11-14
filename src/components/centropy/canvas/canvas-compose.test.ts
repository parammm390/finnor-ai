import { describe, expect, it } from "vitest"
import { composeCanvasDocument } from "./canvas-compose"
import type { WorkAggregateView } from "../product/contracts"

const AT = "2026-11-14T00:00:00.000Z"
const WORK_ID = "10000000-0000-4000-8000-000000000001"
const THREAD = {
  id: "10000000-0000-4000-8000-000000000002",
  title: "Original Work",
  summary: null,
  revision: 3,
  activeWorkId: WORK_ID,
  activeObjectiveLoopId: null,
  lastActivityAt: AT,
  createdAt: AT,
  summaryThroughSequence: 0,
  activeReferences: [],
  unresolvedReferences: [],
  outcomeRefs: [],
} satisfies Parameters<typeof composeCanvasDocument>[0]["thread"]

function plan(revision: number, status: string, verified: boolean): WorkAggregateView["planRevisions"][number] {
  return {
    id: `10000000-0000-4000-8000-${String(revision + 10).padStart(12, "0")}`,
    revision,
    parentRevisionId: revision === 1 ? null : "10000000-0000-4000-8000-000000000011",
    reason: revision === 1 ? "initial" : "redirect",
    status,
    goalSpec: {},
    constraintSet: {},
    planningSnapshot: {},
    validation: {},
    planGraph: {},
    score: {},
    graphHash: `graph-${revision}`,
    semanticHash: `plan-${revision}`,
    completionProof: verified ? { verified: true, basis: "current canonical result" } : null,
    selectedAt: AT,
    completedAt: status === "completed" ? AT : null,
  }
}

function receipt(index: number, finalizedAt: string | null): WorkAggregateView["receipts"][number] {
  return {
    id: `10000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
    domainActionId: null,
    actualResult: { status: "recorded" },
    failure: null,
    finalizedAt,
  }
}

function work(input: {
  revisions: WorkAggregateView["planRevisions"],
  receipts?: WorkAggregateView["receipts"],
  complete?: boolean,
}): WorkAggregateView {
  return {
    work: {
      id: WORK_ID,
      status: "completed",
      initialInstruction: "Verify the current decision, not a previous action",
      executionModel: "objective",
      currentOwnerId: null,
      assignedTo: null,
      createdAt: AT,
      updatedAt: AT,
      failure: null,
      recovery: null,
      finalOutcome: { summary: "Persisted outcome, subject to verification" },
    },
    read: { limit: 100, complete: input.complete !== false, truncatedTables: input.complete === false ? ["work_plan_revisions"] : [] },
    planRevisions: input.revisions,
    receipts: input.receipts ?? [],
    actions: [],
    businessEffects: [],
    objectiveSteps: [],
    queryExecutions: [],
    eventWaits: [],
  }
}

function canvas(value: WorkAggregateView) {
  return composeCanvasDocument({ thread: THREAD, work: value, projection: null, builtAt: AT })
}

function workBlock(value: ReturnType<typeof canvas>) {
  const block = value.blocks.find((candidate) => candidate.type === "work_execution")
  if (!block || block.type !== "work_execution") throw new Error("Work Canvas block missing")
  return block
}

function stage(value: ReturnType<typeof canvas>, id: string) {
  const item = workBlock(value).payload.stages.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`Work stage missing: ${id}`)
  return item
}

describe("Work Canvas currentness and proof", () => {
  it("does not use revision 1 proof to verify a newer unresolved plan", () => {
    const document = canvas(work({ revisions: [plan(1, "completed", true), plan(2, "active", false)] }))
    expect(stage(document, "plan").detail).toContain("Revision 2")
    expect(stage(document, "plan").state).toBe("active")
    for (const id of ["execution", "verification", "outcome"]) expect(stage(document, id).state).not.toBe("verified")
  })

  it("does not turn a finalized older action receipt into current Work verification", () => {
    const document = canvas(work({
      revisions: [plan(1, "completed", true), plan(2, "active", false)],
      receipts: [receipt(1, AT)],
    }))
    expect(stage(document, "verification").state).toBe("waiting")
    expect(stage(document, "verification").detail).toContain("current Work completion not independently verified")
  })

  it("shows the latest pending receipt rather than hiding it behind an older finalization", () => {
    const document = canvas(work({
      revisions: [plan(1, "completed", true), plan(2, "active", false)],
      receipts: [receipt(1, AT), receipt(2, null)],
    }))
    const latestReceipt = document.blocks.find((block) => block.type === "decision_receipt")
    expect(latestReceipt?.id).toBe(`receipt:${receipt(2, null).id}`)
    if (latestReceipt?.type !== "decision_receipt") throw new Error("Action receipt block missing")
    expect(latestReceipt.payload.status).toBe("Pending")
  })

  it("only verifies the current completed plan with its explicit proof", () => {
    const document = canvas(work({ revisions: [plan(1, "completed", true), plan(2, "completed", true)] }))
    for (const id of ["plan", "verification", "outcome"]) expect(stage(document, id).state).toBe("verified")
    expect(workBlock(document).truthState).toBe("KNOWN")
  })

  it("refuses green completion when the Work aggregate is truncated", () => {
    const document = canvas(work({
      revisions: [plan(1, "completed", true), plan(2, "completed", true)],
      complete: false,
    }))
    expect(workBlock(document).truthState).toBe("PARTIAL")
    expect(stage(document, "verification").detail).toContain("work_plan_revisions")
    for (const id of ["plan", "verification", "outcome"]) expect(stage(document, id).state).not.toBe("verified")
  })

  it("does not mistake a completed Work lifecycle alone for observed execution", () => {
    const value = work({ revisions: [plan(1, "active", false)] })
    value.actions = [{
      id: "10000000-0000-4000-8000-000000000050",
      actionType: "integration_effect",
      status: "completed",
      planRevisionId: null,
      planNodeId: null,
      groundedPayload: {},
      predictedReceipt: null,
      createdAt: AT,
    }]
    const document = canvas(value)
    expect(stage(document, "execution").state).not.toBe("verified")
    expect(stage(document, "outcome").state).not.toBe("verified")
  })
})
