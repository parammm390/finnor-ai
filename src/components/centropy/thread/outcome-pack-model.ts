export type DealMissionCheck = "closing_readiness" | "open_requests" | "critical_dependencies"

/** A constrained general mission: the user names the objective and selects one canonical Deal check. */
export function buildGeneralDealMissionInput(params: { dealId: string; mode: "shadow" | "approval" | "autopilot"; objective: string; check: DealMissionCheck }) {
  const objective = params.objective.trim()
  if (!objective || objective.length > 10_000) throw new Error("State a bounded objective of at most 10,000 characters")
  const assertion = params.check === "closing_readiness"
    ? { path: ["eligible"], operator: "eq" as const, expected: true }
    : { path: ["rows", 0], operator: "not_exists" as const }
  return {
    mode: params.mode,
    objective,
    subjectRefs: [{ entityType: "pe_deal", entityId: params.dealId }],
    successCondition: {
      version: 1,
      statement: objective,
      mode: "all" as const,
      source: "explicit" as const,
      criteria: [
        { kind: "no_open_execution" as const },
        { kind: "all_objective_effects_verified" as const, minimumCount: 0 },
        { kind: "canonical_query" as const, request: { intent: params.check, dealId: params.dealId }, assertion },
        { kind: "decision_evidence" as const, minimumCount: 1, accepted: ["canonical_query" as const, "business_effect" as const, "matched_event" as const, "delegation" as const, "computer_run" as const] },
      ],
    },
  }
}
