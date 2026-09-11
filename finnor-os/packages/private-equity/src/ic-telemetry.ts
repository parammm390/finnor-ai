import { logWithTrace } from "@finnor/tools";

export const IC_METRICS = [
  "ic_cases_opened",
  "ic_case_transition_failures",
  "ic_questions_open",
  "ic_required_questions_blocking",
  "ic_question_waivers",
  "ic_recommendation_revisions",
  "ic_voting_sessions",
  "ic_votes_recorded",
  "ic_vote_conflicts",
  "ic_ineligible_vote_attempts",
  "ic_dissents_recorded",
  "ic_quorum_failures",
  "ic_threshold_failures",
  "ic_conditions_active",
  "ic_condition_waivers",
  "ic_decision_finalizations",
  "ic_decision_finalization_failures",
  "pe_action_grounding_failures",
  "pe_action_authority_failures",
  "pe_action_verification_failures",
  "pe_action_recovery_attempts",
] as const;

export type IcMetric = (typeof IC_METRICS)[number];

export interface IcMetricContext {
  tenantId?: string;
  traceId?: string;
  investmentCaseId?: string;
  icCaseId?: string;
  actorId?: string;
  operation?: string;
  entityId?: string;
  state?: string;
  result?: "success" | "blocked" | "failure" | "recovered";
}

/** Metadata-only P5 metric sample; confidential process content is excluded. */
export function recordIcMetric(
  context: IcMetricContext,
  metric: IcMetric,
  value = 1,
  unit: "count" | "milliseconds" = "count",
): void {
  if (!Number.isFinite(value) || value < 0) return;
  logWithTrace({
    tenantId: context.tenantId,
    traceId: context.traceId,
    subsystem: "pe_investment_committee",
    investmentCaseId: context.investmentCaseId,
    icCaseId: context.icCaseId,
    actorId: context.actorId,
    operation: context.operation,
    entityId: context.entityId,
    state: context.state,
    result: context.result,
  }).info({ event: "ic_metric", metric, value, unit }, "PE Investment Committee metric sample");
}
