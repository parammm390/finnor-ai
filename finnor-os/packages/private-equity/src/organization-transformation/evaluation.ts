import type { OrganizationTransformationInput, OperatingEvaluationInput } from "./contracts";

export function qualifyOperatingBenefit(input: OrganizationTransformationInput, evidence: OperatingEvaluationInput) {
  const gaps: string[] = [], trial = input.mandate.trial, observations = evidence.observations;
  if (!evidence.assignmentVerified) gaps.push("S2_ASSIGNMENT_NOT_VERIFIED");
  if (trial.kind !== "PARALLEL_RANDOMIZED" || trial.interference !== "CONTROLLED" || trial.carryover !== "NONE")
    gaps.push("CAUSAL_MODEL_OR_INTERFERENCE_UNIDENTIFIED");
  if (evidence.assistance.length) gaps.push("ASSISTED_NOT_AUTONOMOUS");
  if (!evidence.completeCosts || evidence.migrationCostMinor == null || evidence.migrationHumanSeconds == null ||
      observations.some(o => o.costMinor === null || o.humanSeconds === null)) gaps.push("FULL_COST_OR_HUMAN_ACCOUNTING_UNKNOWN");
  if (evidence.migrationCostMinor != null && evidence.migrationCostMinor > input.mandate.maxMigrationCostMinor ||
      evidence.migrationHumanSeconds != null && evidence.migrationHumanSeconds > input.mandate.maxMigrationHumanSeconds)
    gaps.push("ORIGINAL_MIGRATION_BUDGET_EXCEEDED");
  const ids = new Set<string>(), assignments = new Set<string>();
  for (const o of observations) {
    if (ids.has(o.id) || assignments.has(o.assignmentId) || o.principalId !== input.mandate.evaluatorPrincipalId ||
        !Number.isSafeInteger(o.elapsedSeconds) || o.elapsedSeconds < 0 || o.elapsedSeconds > trial.outcomeRangeSeconds ||
        o.costMinor != null && (!Number.isSafeInteger(o.costMinor) || o.costMinor < 0) ||
        o.humanSeconds != null && (!Number.isSafeInteger(o.humanSeconds) || o.humanSeconds < 0))
      gaps.push("INDEPENDENT_ORIGINAL_OBSERVATION_INVALID");
    ids.add(o.id); assignments.add(o.assignmentId);
    if (!o.serviceRetained) gaps.push("CRITICAL_SERVICE_RETENTION_FAILED");
  }
  const a = observations.filter(o => o.arm === "ORIGINAL"), b = observations.filter(o => o.arm === "TRANSFORMED");
  if (a.length < trial.minimumPerArm || b.length < trial.minimumPerArm) gaps.push("INSUFFICIENT_ORIGINAL_ARM_COVERAGE");
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const improvement = a.length && b.length ? mean(a.map(o => o.elapsedSeconds)) - mean(b.map(o => o.elapsedSeconds)) : null;
  const alpha = 1 - trial.confidence;
  const radius = a.length && b.length ? trial.outcomeRangeSeconds *
    (Math.sqrt(Math.log(4 / alpha) / (2 * a.length)) + Math.sqrt(Math.log(4 / alpha) / (2 * b.length))) : null;
  const lower = improvement !== null && radius !== null ? improvement - radius : null;
  const moneyDelta = !gaps.includes("FULL_COST_OR_HUMAN_ACCOUNTING_UNKNOWN") && a.length && b.length
    ? mean(a.map(o => o.costMinor!)) - mean(b.map(o => o.costMinor!)) - evidence.migrationCostMinor! / b.length : null;
  if (lower !== null && lower < input.mandate.materialImprovementSeconds) gaps.push("REGISTERED_MATERIAL_MARGIN_NOT_ESTABLISHED");
  if (moneyDelta !== null && moneyDelta < 0) gaps.push("FULL_COST_LOSS_NOT_OPERATING_UPSIDE");
  if (evidence.sourceClass !== "FIELD" || input.sourceClass !== "FIELD") gaps.push("CONTROLLED_NOT_FIELD_EVIDENCE");
  const unique = [...new Set(gaps)];
  return { schema: "finnor.organization-operating-evaluation.v1" as const,
    status: unique.length ? "UNIDENTIFIED" as const : "QUALIFIED_OPERATING_BENEFIT" as const,
    gaps: unique, autonomous: evidence.assistance.length === 0,
    originalCount: a.length, transformedCount: b.length, improvementSeconds: improvement,
    lowerConfidenceBoundSeconds: lower, confidence: trial.confidence,
    bound: "BONFERRONI_HOEFFDING_INDEPENDENT_BOUNDED_ARMS",
    registeredMaterialMarginSeconds: input.mandate.materialImprovementSeconds, netCostDifferenceMinorPerOutcome: moneyDelta,
    savedSalariedTimeCashCreditMinor: 0, economicProfitEstablished: false, fieldBenefitEstablished: unique.length === 0 };
}
