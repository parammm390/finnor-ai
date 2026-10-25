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

export type AcquisitionMissionBudgets = {
  maxSteps: number
  maxActions: number
  maxQueries: number
  maxPlannerFailures: number
  maxConsecutiveNoProgress: number
  deadlineAt: string
}
export type MissionStart = (
  packId: "deal_to_verified_closing_readiness" | "deal_request_resolution" | "critical_deal_dependency_resolution" | "general_operator_objective",
  mode: "shadow" | "approval" | "autopilot",
  title: string,
  input: Record<string, unknown>,
  budgets?: AcquisitionMissionBudgets,
) => Promise<{ workId: string }>

export const ACQUISITION_OBJECTIVE = "Evaluate this acquisition, verify the financials, determine our maximum bid, compare financing, investigate material uncertainties, prepare IC, execute approved work, and track the economic outcome."

export function buildAcquisitionMissionInput(params: {
  dealId: string
  mode: "shadow" | "approval" | "autopilot"
  request: AcquisitionReviewedRequest
}) {
  if (params.request.dealId !== params.dealId) throw new Error("The reviewed request belongs to another Deal")
  return {
    mode: params.mode,
    objective: ACQUISITION_OBJECTIVE,
    subjectRefs: [{ entityType: "pe_deal", entityId: params.dealId }],
    acquisitionRequest: params.request,
    successCondition: {
      version: 1,
      statement: ACQUISITION_OBJECTIVE,
      mode: "all",
      source: "explicit",
      criteria: [
        { kind: "no_open_execution" },
        { kind: "private_equity_ic_preparation", dealId: params.dealId, requireAcquisition: true, requireScenario: false },
        { kind: "canonical_query", request: { intent: "closing_readiness", dealId: params.dealId }, assertion: { path: ["verifiedClosing", "status"], operator: "eq", expected: "CLOSED" } },
        { kind: "manual_verification", reason: "Realized economic outcome requires prospective S7 estimand and authenticated settlement, costs and measurements; financial model profit is insufficient." },
      ],
    },
  }
}

export type AcquisitionReviewedRequest = {
  schema: "finnor.reviewed-acquisition-request.v1"
  dealId: string
  primary: Omit<import("../../../../finnor-os/packages/shared-types/src/primary-diligence").PrimaryIntake, "schema" | "root" | "workId" | "expectedWorkInputId" | "idempotencyKey">
  underwriting: {
    investmentCaseId: string
    modelVersionId: string
    primaryAssertions: Record<string, { assertionId: string; revision: number }>
    explicitInputs?: import("../../../../finnor-os/packages/shared-types/src/acquisition-intake").AcquisitionIntakeDraft["explicitInputs"]
  }
  acquisition: import("../../../../finnor-os/packages/shared-types/src/acquisition-intake").AcquisitionIntakeDraft["acquisition"]
}
