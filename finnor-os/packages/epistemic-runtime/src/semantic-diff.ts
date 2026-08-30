import type {
  EpistemicBehaviorSummary,
  EpistemicSemanticDiff,
  ExistingTruthClass,
} from "./contracts";
import { EXISTING_TRUTH_PRECEDENCE, truthClassRank } from "./source-precedence";

function setRelation(left: string[], right: string[]): "SAME" | "LEFT_MORE" | "RIGHT_MORE" | "DIFFERENT" {
  const l = new Set(left);
  const r = new Set(right);
  const leftOnly = [...l].some((value) => !r.has(value));
  const rightOnly = [...r].some((value) => !l.has(value));
  if (!leftOnly && !rightOnly) return "SAME";
  if (leftOnly && !rightOnly) return "LEFT_MORE";
  if (!leftOnly && rightOnly) return "RIGHT_MORE";
  return "DIFFERENT";
}

function sourceRank(summary: EpistemicBehaviorSummary): number | null {
  return summary.selectedSource ? truthClassRank(summary.selectedSource.truthClass) : null;
}

function validSummary(summary: EpistemicBehaviorSummary): boolean {
  return summary.sourcePrecedence.join("|") === EXISTING_TRUTH_PRECEDENCE.join("|")
    && summary.requiredFacts.every((fact) => fact.trim())
    && summary.factsAvailable.every((fact) => fact.trim())
    && summary.canonicalFactsAvailable.every((fact) => fact.trim())
    && summary.missingFacts.every((fact) => fact.trim());
}

export function compareEpistemicBehavior(
  existing: EpistemicBehaviorSummary,
  p3: EpistemicBehaviorSummary,
): EpistemicSemanticDiff {
  if (!validSummary(existing) || !validSummary(p3)) {
    return {
      classification: "FIXTURE_INVALID",
      reasonCodes: ["INVALID_BEHAVIOR_SUMMARY_OR_PRECEDENCE"],
      fields: {
        requiredFacts: "DIFFERENT",
        factsAvailable: "DIFFERENT",
        missingFacts: "DIFFERENT",
        sourcePrecedence: "DIFFERENT",
        clarificationNecessity: "SAME",
        selectedSource: "DIFFERENT",
        freshness: "DIFFERENT",
        conflicts: "DIFFERENT",
        decisionCriticalUncertainty: "DIFFERENT",
        stopCondition: "DIFFERENT",
      },
    };
  }
  const required = setRelation(existing.requiredFacts, p3.requiredFacts);
  const available = setRelation(existing.factsAvailable, p3.factsAvailable);
  const canonicalAvailable = setRelation(existing.canonicalFactsAvailable, p3.canonicalFactsAvailable);
  const missing = setRelation(existing.missingFacts, p3.missingFacts);
  const conflicts = setRelation(existing.conflicts, p3.conflicts);
  const critical = setRelation(existing.decisionCriticalUncertainty, p3.decisionCriticalUncertainty);
  const existingRank = sourceRank(existing);
  const p3Rank = sourceRank(p3);
  const reasonCodes: string[] = [];
  const p3LowerSource = existingRank !== null && p3Rank !== null && p3Rank > existingRank;
  const p3HigherSource = existingRank !== null && p3Rank !== null && p3Rank < existingRank;
  const canonicalAvailableButNotSelected = p3.selectedSource !== null
    && p3.selectedSource.truthClass !== "CANONICAL"
    && p3.requiredFacts.some((fact) => p3.canonicalFactsAvailable.includes(fact));
  const mandatoryIgnored = p3.consequentialDecisionAllowed && p3.decisionCriticalUncertainty.length > 0;
  const p2RejectedOverridden = p3.p2Status === "REJECTED" && p3.consequentialDecisionAllowed;
  const resolvedByBetterInformation = available === "RIGHT_MORE" || missing === "LEFT_MORE";
  const conflictHidden = conflicts === "LEFT_MORE" && !resolvedByBetterInformation;
  const uncertaintyHidden = critical === "LEFT_MORE" && !resolvedByBetterInformation;
  if (p3LowerSource || canonicalAvailableButNotSelected) reasonCodes.push("LOWER_AUTHORITY_SELECTED_OVER_AVAILABLE_TRUTH");
  if (mandatoryIgnored) reasonCodes.push("MANDATORY_UNCERTAINTY_IGNORED");
  if (p2RejectedOverridden) reasonCodes.push("P2_REJECTED_OVERRIDDEN");
  if (conflictHidden) reasonCodes.push("P3_HIDES_EXISTING_CONFLICT");
  if (uncertaintyHidden) reasonCodes.push("P3_HIDES_DECISION_CRITICAL_UNCERTAINTY");
  if (p3.clarificationNecessary && !existing.clarificationNecessary && p3.factsAvailable.length >= existing.factsAvailable.length) {
    reasonCodes.push("UNNECESSARY_USER_INTERRUPTION");
  }

  let classification: EpistemicSemanticDiff["classification"];
  if (reasonCodes.length > 0) classification = "REGRESSION";
  else if (!p3.consequentialDecisionAllowed && existing.consequentialDecisionAllowed) {
    classification = "STRICTER_SAFE";
    reasonCodes.push("P3_BLOCKS_UNRESOLVED_CONSEQUENTIAL_DECISION");
  } else if (
    available === "RIGHT_MORE"
    || canonicalAvailable === "RIGHT_MORE"
    || conflicts === "RIGHT_MORE"
    || critical === "RIGHT_MORE"
    || (!p3.clarificationNecessary && existing.clarificationNecessary)
    || p3HigherSource
  ) {
    classification = "BETTER_INFORMATION";
    reasonCodes.push("P3_IMPROVES_DECISION_INFORMATION");
  } else if (
    required === "SAME"
    && available === "SAME"
    && missing === "SAME"
    && conflicts === "SAME"
    && critical === "SAME"
    && existing.clarificationNecessary === p3.clarificationNecessary
    && existingRank === p3Rank
    && existing.freshness === p3.freshness
    && existing.stopCondition === p3.stopCondition
    && existing.consequentialDecisionAllowed === p3.consequentialDecisionAllowed
  ) {
    classification = "EQUIVALENT";
    reasonCodes.push("SEMANTICS_EQUIVALENT");
  } else {
    classification = "UNSUPPORTED";
    reasonCodes.push("DIFFERENCE_NOT_CLASSIFIED_AS_SAFE_OR_INFORMATION_IMPROVEMENT");
  }

  return {
    classification,
    reasonCodes,
    fields: {
      requiredFacts: required === "SAME" ? "SAME" : required === "RIGHT_MORE" ? "P3_STRICTER" : "DIFFERENT",
      factsAvailable: available === "SAME" ? "SAME" : available === "RIGHT_MORE" ? "P3_MORE" : available === "LEFT_MORE" ? "P3_LESS" : "DIFFERENT",
      missingFacts: missing === "SAME" ? "SAME" : missing === "RIGHT_MORE" ? "P3_MORE" : missing === "LEFT_MORE" ? "P3_LESS" : "DIFFERENT",
      sourcePrecedence: existing.sourcePrecedence.join("|") === p3.sourcePrecedence.join("|") ? "SAME" : "DIFFERENT",
      clarificationNecessity: existing.clarificationNecessary === p3.clarificationNecessary ? "SAME" : p3.clarificationNecessary ? "P3_ADDS" : "P3_AVOIDS",
      selectedSource: existingRank === p3Rank ? "SAME" : p3HigherSource ? "P3_HIGHER" : p3LowerSource ? "P3_LOWER" : "DIFFERENT",
      freshness: existing.freshness === p3.freshness ? "SAME" : p3.freshness === "FRESH" ? "P3_FRESHER" : existing.freshness === "FRESH" ? "P3_STALER" : "DIFFERENT",
      conflicts: conflicts === "SAME" ? "SAME" : conflicts === "RIGHT_MORE" ? "P3_EXPOSES" : conflicts === "LEFT_MORE" ? "P3_HIDES" : "DIFFERENT",
      decisionCriticalUncertainty: critical === "SAME" ? "SAME" : critical === "RIGHT_MORE" ? "P3_EXPOSES" : critical === "LEFT_MORE" ? "P3_HIDES" : "DIFFERENT",
      stopCondition: existing.stopCondition === p3.stopCondition ? "SAME" : !p3.consequentialDecisionAllowed ? "P3_SAFER" : existing.consequentialDecisionAllowed ? "P3_WEAKER" : "DIFFERENT",
    },
  };
}

export function behaviorSummaryUsesExactPrecedence(summary: EpistemicBehaviorSummary): boolean {
  return summary.sourcePrecedence.join("|") === (EXISTING_TRUTH_PRECEDENCE as readonly ExistingTruthClass[]).join("|");
}
