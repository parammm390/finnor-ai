import type {
  AcquisitionBudget,
  AcquisitionUsage,
  EpistemicState,
  InformationAction,
  InformationActionScore,
  StopDecision,
  Uncertainty,
} from "./contracts";
import { EPISTEMIC_HEURISTIC_VERSION } from "./contracts";
import {
  budgetAllowsAction,
  informationActionPrivacyErrors,
} from "./information-actions";
import { requirementResolved } from "./state";
import type { DecisionRequirement } from "./contracts";

export interface ScoreContext {
  state: EpistemicState;
  uncertainties: readonly Uncertainty[];
  requirements: readonly DecisionRequirement[];
  budget: AcquisitionBudget;
  usage: AcquisitionUsage;
  now: string;
}

function bounded(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function lowAuthorityPenalty(action: InformationAction, state: EpistemicState): string[] {
  const reasons: string[] = [];
  for (const propositionId of action.requiredInput.propositionIds) {
    if (state.canonicalTruth.some((truth) => truth.propositionId === propositionId) && action.sourceAuthority !== "CANONICAL_OWNER") {
      reasons.push("LOWER_AUTHORITY_CANNOT_REPLACE_AVAILABLE_CANONICAL_TRUTH");
    }
  }
  return reasons;
}

function clarificationReasonCodes(action: InformationAction, actions: readonly InformationAction[], state: EpistemicState): string[] {
  if (action.kind !== "ASK") return [];
  const propositionId = action.requiredInput.propositionIds[0];
  if (!propositionId) return ["ASK_REQUIRES_DECISION_PROPOSITION"];
  const proposition = state.propositions.find((candidate) => candidate.id === propositionId);
  const userOwned = proposition?.subject.kind === "user_intent";
  if (userOwned || action.estimate.reasonCodes.some((code) => code === "USER_CHOICE_REQUIRED" || code === "USER_AUTHORIZATION_REQUIRED")) return [];
  const machineAlternative = actions.some((candidate) =>
    candidate.id !== action.id
    && candidate.kind !== "ASK"
    && candidate.requiredInput.propositionIds.includes(propositionId)
    && informationActionPrivacyErrors(candidate).length === 0
    && candidate.estimate.expectedUncertaintyReduction > 0,
  );
  return machineAlternative ? ["MACHINE_SOURCE_PRECEDES_CLARIFICATION"] : [];
}

export function scoreInformationAction(
  action: InformationAction,
  allActions: readonly InformationAction[],
  context: ScoreContext,
): InformationActionScore {
  const privacyErrors = informationActionPrivacyErrors(action);
  const budget = budgetAllowsAction(context.budget, context.usage, action, context.now);
  const precedenceErrors = lowAuthorityPenalty(action, context.state);
  const clarificationErrors = clarificationReasonCodes(action, allActions, context.state);
  const reasonCodes = [...new Set([...privacyErrors, ...budget.reasonCodes, ...precedenceErrors, ...clarificationErrors, ...action.estimate.reasonCodes])];
  const latencyPenalty = bounded((action.latency.expectedMs / Math.max(1, context.budget.maxLatencyMs)) * 100);
  const costPenalty = bounded(((action.cost.monetaryUnits + action.cost.toolUnits) / Math.max(1, context.budget.maxCostUnits)) * 100);
  const userPenalty = bounded(action.userInterruption.units);
  const privacyPenalty = bounded(action.privacyExposure.units);
  const failurePenalty = bounded(action.estimate.failureRisk);
  const improvement = bounded(action.estimate.decisionQualityImprovement);
  const relevance = bounded(action.estimate.decisionRelevance);
  const reduction = bounded(action.estimate.expectedUncertaintyReduction);
  const safety = bounded(action.estimate.safetyLegalityPriority);
  const netUtility = improvement + reduction - userPenalty - latencyPenalty - costPenalty - privacyPenalty - failurePenalty;
  return {
    actionId: action.id,
    eligible: privacyErrors.length === 0 && budget.allowed && precedenceErrors.length === 0 && clarificationErrors.length === 0 && reduction > 0,
    safetyLegality: safety,
    decisionRelevance: relevance,
    uncertaintyReduction: reduction,
    userInterruptionPenalty: userPenalty,
    latencyPenalty,
    costPenalty,
    privacyPenalty,
    failureRiskPenalty: failurePenalty,
    netUtility,
    heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
    reasonCodes,
  };
}

/** Required lexicographic ordering: safety/legality, relevance, uncertainty
 * reduction, interruption, latency, cost, then privacy/failure. Net utility is a
 * stop threshold and final tie-breaker; it cannot let convenience outrank safety. */
export function compareInformationActionScores(left: InformationActionScore, right: InformationActionScore): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  if (left.safetyLegality !== right.safetyLegality) return right.safetyLegality - left.safetyLegality;
  if (left.decisionRelevance !== right.decisionRelevance) return right.decisionRelevance - left.decisionRelevance;
  if (left.uncertaintyReduction !== right.uncertaintyReduction) return right.uncertaintyReduction - left.uncertaintyReduction;
  if (left.userInterruptionPenalty !== right.userInterruptionPenalty) return left.userInterruptionPenalty - right.userInterruptionPenalty;
  if (left.latencyPenalty !== right.latencyPenalty) return left.latencyPenalty - right.latencyPenalty;
  if (left.costPenalty !== right.costPenalty) return left.costPenalty - right.costPenalty;
  if (left.privacyPenalty !== right.privacyPenalty) return left.privacyPenalty - right.privacyPenalty;
  if (left.failureRiskPenalty !== right.failureRiskPenalty) return left.failureRiskPenalty - right.failureRiskPenalty;
  if (left.netUtility !== right.netUtility) return right.netUtility - left.netUtility;
  return left.actionId.localeCompare(right.actionId);
}

export function selectInformationAction(
  actions: readonly InformationAction[],
  context: ScoreContext,
): { action: InformationAction | null; scores: InformationActionScore[] } {
  const scores = actions.map((action) => scoreInformationAction(action, actions, context)).sort(compareInformationActionScores);
  const best = scores.find((score) => score.eligible);
  return {
    action: best ? actions.find((action) => action.id === best.actionId) ?? null : null,
    scores,
  };
}

export function decideAcquisitionStop(
  state: EpistemicState,
  requirements: readonly DecisionRequirement[],
  actions: readonly InformationAction[],
  scores: readonly InformationActionScore[],
  budget: AcquisitionBudget,
  usage: AcquisitionUsage,
  now: string,
  utilityThreshold = 0,
): StopDecision {
  const unresolvedMandatory = requirements
    .filter((requirement) => requirement.mandatory && !requirementResolved(state, requirement))
    .map((requirement) => requirement.propositionId)
    .sort();
  const best = [...scores].sort(compareInformationActionScores).find((score) => score.eligible);
  const budgetReasonCodes = [...new Set(scores.flatMap((score) => score.reasonCodes).filter((code) =>
    code === "MAX_ACTIONS_EXCEEDED"
    || code === "MAX_USER_INTERRUPTION_EXCEEDED"
    || code === "MAX_LATENCY_EXCEEDED"
    || code === "MAX_COST_EXCEEDED",
  ))];
  if (unresolvedMandatory.length === 0 && (!best || best.netUtility <= utilityThreshold)) {
    return {
      stop: true,
      reason: "DECISION_CRITICAL_RESOLVED",
      unresolvedMandatory,
      ...(best ? { bestActionId: best.actionId, bestNetUtility: best.netUtility } : {}),
      reasonCodes: ["MANDATORY_PROPOSITIONS_RESOLVED", "NO_POSITIVE_INCREMENTAL_VALUE"],
    };
  }
  if (Date.parse(now) >= Date.parse(budget.deadline)) {
    return { stop: true, reason: "DEADLINE_REACHED", unresolvedMandatory, reasonCodes: ["ACQUISITION_DEADLINE_REACHED"] };
  }
  // Every acquisition consumes one action, so this dimension can be evaluated
  // independently of the candidate set. Interruption, latency, and cost cannot:
  // a zero allowance in one of those dimensions must still permit a candidate
  // that consumes zero units of that dimension.
  if (usage.actions >= budget.maxActions) {
    return { stop: true, reason: "BUDGET_EXHAUSTED", unresolvedMandatory, reasonCodes: ["ACQUISITION_BUDGET_EXHAUSTED", "MAX_ACTIONS_EXCEEDED"] };
  }
  if (!best || !actions.some((action) => action.id === best.actionId)) {
    if (budgetReasonCodes.length > 0) {
      return {
        stop: true,
        reason: "BUDGET_EXHAUSTED",
        unresolvedMandatory,
        reasonCodes: ["ACQUISITION_BUDGET_EXHAUSTED", ...budgetReasonCodes],
      };
    }
    return { stop: true, reason: "NO_LEGAL_ACTION", unresolvedMandatory, reasonCodes: ["NO_ELIGIBLE_INFORMATION_ACTION"] };
  }
  if (best.netUtility <= utilityThreshold) {
    return { stop: true, reason: "NON_POSITIVE_INFORMATION_VALUE", unresolvedMandatory, bestActionId: best.actionId, bestNetUtility: best.netUtility, reasonCodes: ["EXPECTED_VALUE_BELOW_THRESHOLD"] };
  }
  return { stop: false, reason: "CONTINUE_ACQUISITION", unresolvedMandatory, bestActionId: best.actionId, bestNetUtility: best.netUtility, reasonCodes: ["POSITIVE_INFORMATION_VALUE"] };
}
