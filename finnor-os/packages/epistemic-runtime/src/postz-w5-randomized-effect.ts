/** S3's bounded final-look estimator for the additive W5 S2 contract. It
 * estimates registered task elapsed time, not business wealth or field truth. */
import { z } from "zod";
import { ExperimentRefSchema } from "./experiments";
import { checkW5ProspectiveTrial, type W5ProspectiveTrialRecord, type W5NativeAssignmentRecord } from "./postz-w5-prospective-trial";

export const W5RandomizedOutcomeSchema = z.object({
  assignmentId: z.string().uuid(), unitId: z.string().uuid(), workId: z.string().uuid(), workInputId: z.string().uuid(),
  workInputDigest: z.string().regex(/^[a-f0-9]{64}$/), arm: z.enum(["ORIGINAL", "TRANSFORMED"]),
  elapsedSeconds: z.number().int().nonnegative().max(2_000_000_000),
  humanSeconds: z.number().int().nonnegative().max(2_000_000_000).nullable(), serviceRetained: z.boolean().nullable(),
  useKey: z.string().min(1).max(240).nullable(), evaluatorPrincipalId: z.string().uuid(),
  observationRef: ExperimentRefSchema, observedAt: z.string().datetime({ offset: true }),
  receivedAt: z.string().datetime({ offset: true }),
}).strict();
export type W5RandomizedOutcome = z.infer<typeof W5RandomizedOutcomeSchema>;
export function analyzeW5RandomizedTaskEffect(trial: W5ProspectiveTrialRecord,
  assignments: readonly W5NativeAssignmentRecord[], outcomes: readonly W5RandomizedOutcome[]) {
  const assignmentCheck = checkW5ProspectiveTrial(trial, assignments), b = trial.body, gaps: string[] = [...assignmentCheck.errors];
  if (b.analysis.interference !== "CONTROLLED" || b.analysis.carryover !== "NONE")
    gaps.push("INTERFERENCE_OR_CARRYOVER_UNIDENTIFIED");
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    const a = assignments.find(entry => entry.body.assignmentId === outcome.assignmentId)?.body;
    if (!a || seen.has(outcome.assignmentId) || outcome.unitId !== a.unit.unitId ||
        outcome.workId !== a.unit.workId || outcome.workInputId !== a.unit.workInputId ||
        outcome.workInputDigest !== a.unit.workInputDigest || outcome.arm !== a.arm ||
        outcome.evaluatorPrincipalId !== b.evaluatorPrincipalId || outcome.observationRef.owner !== "S1" ||
        !Number.isSafeInteger(outcome.elapsedSeconds) || outcome.elapsedSeconds < 0 ||
        outcome.elapsedSeconds > b.analysis.outcomeRangeSeconds ||
        outcome.humanSeconds !== null && (!Number.isSafeInteger(outcome.humanSeconds) || outcome.humanSeconds < 0) ||
        outcome.arm === "ORIGINAL" && outcome.useKey !== null ||
        outcome.arm === "TRANSFORMED" && !outcome.useKey ||
        !Number.isFinite(Date.parse(outcome.observedAt)) || !Number.isFinite(Date.parse(outcome.receivedAt)) ||
        Date.parse(outcome.observedAt) < Date.parse(a.assignedAt) ||
        Date.parse(outcome.observedAt) > Date.parse(outcome.receivedAt) ||
        Date.parse(outcome.observedAt) > Date.parse(b.originalDeadline))
      gaps.push("INDEPENDENT_POST_ASSIGNMENT_OUTCOME_BINDING_INVALID");
    if (outcome.serviceRetained !== null && typeof outcome.serviceRetained !== "boolean")
      gaps.push("CRITICAL_SERVICE_OUTCOME_INVALID");
    else if (outcome.serviceRetained === null) gaps.push("CRITICAL_SERVICE_OUTCOME_UNKNOWN");
    else if (!outcome.serviceRetained) gaps.push("CRITICAL_SERVICE_RETENTION_FAILED");
    seen.add(outcome.assignmentId);
  }
  if (outcomes.length !== assignments.length || assignments.some(a => !seen.has(a.body.assignmentId)))
    gaps.push("COMPLETE_FIXED_FINAL_LOOK_OUTCOME_POPULATION_REQUIRED");
  const originalCount = outcomes.filter(o => o.arm === "ORIGINAL").length;
  const transformedCount = outcomes.filter(o => o.arm === "TRANSFORMED").length;
  if (Math.min(originalCount, transformedCount) < b.analysis.minimumPerArm)
    gaps.push("INSUFFICIENT_REGISTERED_ARM_COVERAGE");
  const complete = gaps.length === 0, numerator = b.assignment.transformedNumerator, denominator = b.assignment.denominator;
  const originalWeight = denominator / (denominator - numerator), transformedWeight = denominator / numerator;
  // One fixed complete population, independently randomized per registered
  // unit. A unit's HT contribution lies in [-R/p, R/(1-p)].
  const estimate = complete ? outcomes.reduce((sum, o) =>
    sum + (o.arm === "ORIGINAL" ? o.elapsedSeconds * originalWeight : -o.elapsedSeconds * transformedWeight), 0) / assignments.length : null;
  const span = b.analysis.outcomeRangeSeconds * (originalWeight + transformedWeight);
  const statisticalRadius = complete ? span * Math.sqrt(Math.log(2 / (1 - b.analysis.confidence)) / (2 * assignments.length)) : null;
  // Integer denominator complements avoid cancellation near probability one.
  // Expand, never shrink, the bound for bounded floating-point accumulation.
  const roundoffGuard = complete ? Number.EPSILON * 16 * assignments.length *
    (span + Math.abs(estimate!) + statisticalRadius!) : null;
  const radius = statisticalRadius !== null && roundoffGuard !== null ? statisticalRadius + roundoffGuard : null;
  const lower = estimate !== null && radius !== null ? estimate - radius : null;
  const material = lower !== null && lower >= b.analysis.materialMarginSeconds;
  return { schema: "finnor.s3.w5-randomized-task-effect.v1", semanticOwner: "S3" as const,
    status: complete ? "REGISTERED_RANDOMIZED_TASK_ESTIMATE" as const : "UNIDENTIFIED" as const,
    gaps: [...new Set(gaps)], assignmentCheck, trialRef: trial.ref,
    registeredUnitCount: b.units.length, observedUnitCount: outcomes.length, originalCount, transformedCount,
    method: "BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK", estimateSeconds: estimate,
    lowerConfidenceBoundSeconds: lower, radiusSeconds: radius, statisticalRadiusSeconds: statisticalRadius,
    roundoffGuardSeconds: roundoffGuard, confidence: b.analysis.confidence,
    registeredMaterialMarginSeconds: b.analysis.materialMarginSeconds, registeredMaterialMarginEstablished: material,
    outcome: "TASK_ELAPSED_SECONDS_NOT_OWNER_WEALTH", completePopulationRequired: true,
    scientificAdmission: false, fullCostBenefitEstablished: false, fieldBenefitEstablished: false,
    executionAuthorityGranted: false };
}
