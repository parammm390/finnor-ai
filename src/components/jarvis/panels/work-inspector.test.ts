import { describe, expect, it } from "vitest"
import type { WorkCaseProjection } from "@/lib/jarvis-client"
import { buildWorkInspectorFacts } from "./work-inspector"

function workCase(overrides: Partial<WorkCaseProjection> = {}): WorkCaseProjection {
  return {
    id: "work-1", root: { kind: "work", id: "work-1" }, title: "Collect invoice", status: "Needs you", createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T01:00:00Z",
    source: { kind: "instruction", id: "instruction-1", channel: "text" }, instruction: { id: "instruction-1", text: "Collect invoice 7", source: "typed", createdAt: "2026-08-15T00:00:00Z", lastPhase: "planning" },
    actions: [{ id: "action-1", actionType: "send_payment_reminder", status: "pending", summary: "Send a payment reminder", instructionId: "instruction-1", planId: "plan-1", dependsOn: [], payload: {}, createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z" }],
    approvals: [{ actionId: "action-1", status: "pending", decidedBy: null, decidedAt: null, pendingConfirmationId: "approval-1" }], workflows: [], receipts: [], linkedEntities: [{ entityType: "invoice", entityId: "invoice-7", via: "action.payload.invoiceId" }],
    businessEvents: [], calls: [], relatedActionIds: ["action-1"], provenance: ["domain_actions"],
    ...overrides,
  }
}

function objectiveLoop(state: NonNullable<WorkCaseProjection["objectiveLoop"]>["state"], nextStep: string): NonNullable<WorkCaseProjection["objectiveLoop"]> {
  return {
    id: "loop-1", objective: "Collect", state, revision: 1, reason: null, nextStep, nextRunAt: null, lastObservation: null,
    budget: { steps: 1, maxSteps: 3, actions: 1, maxActions: 3, queries: 1, maxQueries: 3 }, iterations: [],
  }
}

describe("Work contextual inspector", () => {
  it("covers source, permission, consequence, authority, outcome, evidence, and next action", () => {
    const facts = buildWorkInspectorFacts(workCase())
    expect(facts.map((fact) => fact.label)).toEqual(expect.arrayContaining(["Supporting sources", "Policy / permission", "Expected change", "Authority boundary", "What happened", "Evidence / closure", "Next permitted action"]))
    expect(facts.find((fact) => fact.label === "Policy / permission")?.value).toContain("approval")
    expect(facts.find((fact) => fact.label === "Supporting sources")?.value).toContain("action.payload.invoiceId")
  })

  it("uses recorded failure and recovery instead of claiming success", () => {
    const facts = buildWorkInspectorFacts(workCase({
      status: "Failed",
      approvals: [],
      receipts: [{ id: "receipt-1", workflowRunId: null, workflowStepId: null, domainActionId: "action-1", objective: "Send reminder", evidence: [], approval: {}, expectedResult: { status: "delivered" }, actualResult: null, failure: { message: "Provider unavailable" }, correlationId: null, createdAt: "2026-08-15T00:00:00Z", finalizedAt: "2026-08-15T01:00:00Z" }],
      durableWork: { id: "work-1", status: "failed", sessionId: "session-1", channel: "text", activeContext: null, initiatedBy: "user-1", currentOwnerId: "user-1", assignedTo: "user-1", authorityContext: { role: "owner" }, finalOutcome: null, failure: { message: "Provider unavailable" }, recovery: { message: "Retry delivery" } },
    }))
    expect(facts.find((fact) => fact.label === "What happened")?.value).toContain("Provider unavailable")
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).toContain("Retry delivery")
  })

  it("does not present cancelled Work as completed or still in flight", () => {
    const facts = buildWorkInspectorFacts(workCase({ status: "Cancelled", approvals: [], objectiveLoop: objectiveLoop("cancelled", "Send another reminder") }))
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).toContain("No future execution is scheduled")
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).not.toContain("Send another reminder")
  })

  it("routes partial outcomes to incomplete-evidence review", () => {
    const facts = buildWorkInspectorFacts(workCase({ status: "Partial", approvals: [], objectiveLoop: objectiveLoop("failed", "Keep executing") }))
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).toContain("Inspect the incomplete outcome")
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).not.toContain("Keep executing")
  })

  it("does not expose stale loop guidance after Work completed", () => {
    const facts = buildWorkInspectorFacts(workCase({ status: "Completed", approvals: [], objectiveLoop: objectiveLoop("completed", "Retry the charge") }))
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).toContain("follow-up")
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).not.toContain("Retry the charge")
  })

  it.each(["Failed", "Blocked"] as const)("does not expose stale loop guidance after Work is %s", (status) => {
    const facts = buildWorkInspectorFacts(workCase({ status, approvals: [], objectiveLoop: objectiveLoop("failed", "Keep executing") }))
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).toContain("Inspect the incomplete outcome")
    expect(facts.find((fact) => fact.label === "Next permitted action")?.value).not.toContain("Keep executing")
  })
})
