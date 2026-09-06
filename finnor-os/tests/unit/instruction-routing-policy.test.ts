import { describe, expect, it } from "vitest";
import type { DomainAction } from "@finnor/shared-types";
import { classifyInstructionRoute, finalizeInstructionRoute } from "@finnor/orchestration";

const planner = { route: "planner", reason: "mutation_or_advice" } as const;
const query = {
  route: "fast_read",
  confidence: "high",
  request: { intent: "money_summary" },
} as const;

function action(overrides: Partial<DomainAction> = {}): DomainAction {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    tenantId: "00000000-0000-4000-8000-000000000012",
    actionType: "send_follow_up",
    payload: { householdId: "00000000-0000-4000-8000-000000000013" },
    policyId: null,
    status: "draft",
    createdAt: new Date(0).toISOString(),
    compiledGraph: { kind: "single_action", commandType: "send_follow_up", requiresConfirmation: true, autoApprove: false },
    ...overrides,
  };
}

describe("objective-first instruction-routing policy", () => {
  it("preserves deterministic Operational Query Plane reads", () => {
    expect(classifyInstructionRoute({ instruction: "How much is overdue?", fastReadDecision: query })).toMatchObject({
      route: "QUERY",
      reasonCodes: ["deterministic_canonical_read"],
    });
  });

  it("keeps an unsupported non-business question off the heavy objective planner", () => {
    expect(classifyInstructionRoute({ instruction: "What time is it?", fastReadDecision: { route: "planner", reason: "unsupported" } })).toMatchObject({
      route: "CONVERSATION",
      reasonCodes: ["lightweight_informational_question"],
    });
  });

  it("does not promote an unsupported read question into an objective", () => {
    expect(classifyInstructionRoute({
      instruction: "Tell me about technician availability",
      fastReadDecision: { route: "planner", reason: "unsupported" },
    }).route).toBe("CONVERSATION");
  });

  it("reserves the atomic route for an exact one-effect candidate", () => {
    const preliminary = classifyInstructionRoute({
      instruction: "Send this exact message to casey@example.test",
      fastReadDecision: planner,
    });
    expect(preliminary.route).toBe("ATOMIC_EFFECT");
    expect(finalizeInstructionRoute(preliminary, [action({ actionType: "send_customer_message" })])).toMatchObject({
      route: "ATOMIC_EFFECT",
      reasonCodes: ["strict_single_effect_candidate", "one_independent_effect_set"],
    });
  });

  it.each([
    "Resolve Peterson's installation and keep going until it is operational",
    "Message the vendor, wait for their reply, then reschedule the visit",
    "Delegate this to Mario and finish after he confirms completion",
    "Use the browser and then update the canonical customer record",
  ])("defaults meaningful continuation work to Objective: %s", (instruction) => {
    expect(classifyInstructionRoute({ instruction, fastReadDecision: planner }).route).toBe("OBJECTIVE");
  });

  it("rejects a nominally atomic instruction when the typed plan reveals a workflow or dependency", () => {
    const preliminary = classifyInstructionRoute({ instruction: "Send this exact message to +15550101010", fastReadDecision: planner });
    expect(finalizeInstructionRoute(preliminary, [action({ compiledGraph: { kind: "workflow", commandType: "send_follow_up", requiresConfirmation: true, autoApprove: false } })]).route).toBe("OBJECTIVE");
    expect(finalizeInstructionRoute(preliminary, [action(), action({ id: "00000000-0000-4000-8000-000000000014" })]).route).toBe("OBJECTIVE");
  });
});
