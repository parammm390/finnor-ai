import { add, cmp, decimal, deepFreeze, semanticHash, sub } from "@finnor/underwriting";
import {
  CAPITAL_PROGRAM_VERSION, CapitalProgramError, ConstructionContextSchema, ownerBindingBlockers, parseCapitalProgramRequest,
  type CapitalAttempt, type CapitalCandidate, type CapitalProgramBlocker, type CapitalProgramRequest,
  type CapitalProgramSearchResult,
} from "./contracts";
import { generateCapitalCandidates } from "./grammar";
import { compileNativeCandidate, constructNativeCandidate, executeNativeCandidate, validateNativeBase } from "./native-finance";

function codeOf(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ?
    error.code : "NATIVE_CONSTRUCTION_FAILED";
}
function blocker(error: unknown): CapitalProgramBlocker {
  return { owner: "M3", code: codeOf(error), reason: error instanceof Error ? error.message : String(error), ref: null };
}
function initialResult(request: CapitalProgramRequest): CapitalProgramSearchResult {
  return {
    schema: "finnor.m3.capital-program-search.v1", producerVersion: CAPITAL_PROGRAM_VERSION,
    source: "INDEPENDENT_NATIVE_CORE", qualification: "H0_DEV_H1_FIXTURE_ONLY",
    status: "BLOCKED_INPUT", resolution: "BLOCKED", requestDigest: semanticHash(request), baseDigest: null,
    attempts: [], counts: { evaluated: 0, failed: 0, rejected: 0, duplicate: 0 },
    costs: {
      nativeExecutions: 0, declaredWorkUnits: 0, declaredEvaluationLiability: decimal("0"),
      actualMoney: null, accounting: "DECLARED_DEV_COSTS_ACTUAL_MONEY_UNMETERED", setupAndCompilationCost: "UNMETERED",
    },
    selection: null,
    gap: { finiteDomainComplete: false, remainingGeneratedDescriptors: null, stopReason: "NATIVE_INPUT_UNBOUND",
      externalOptimalityBound: null, globalOptimalityClaimed: false },
    blockers: ownerBindingBlockers(), executionAuthorityGranted: false,
  };
}
function rejected(index: number, candidate: CapitalCandidate, reason: string, semanticDigest: string | null = null): CapitalAttempt {
  return {
    index, isIncumbent: index === 0, candidate, semanticDigest, disposition: "REJECTED",
    duplicateOf: null, reason, declaredEvaluationCost: decimal("0"), program: null,
  };
}

/**
 * Deterministic, finite development search. No owner I/O, allocations, effects,
 * tenant selection, supplied candidate lists or protected admission are accepted.
 */
export function searchCapitalPrograms(requestInput: unknown, contextInput: unknown): Readonly<CapitalProgramSearchResult> {
  const request = parseCapitalProgramRequest(requestInput);
  const result = initialResult(request);
  let candidates: CapitalCandidate[];
  let context: ReturnType<typeof ConstructionContextSchema.parse>;
  let base: ReturnType<typeof validateNativeBase>;
  try {
    const parsed = ConstructionContextSchema.safeParse(contextInput);
    if (!parsed.success) throw new CapitalProgramError("INVALID_NATIVE_CONTEXT", parsed.error.message);
    context = parsed.data;
    base = validateNativeBase(context.base);
    if (base.digest !== request.baseDigest) throw new CapitalProgramError("BASE_PIN_MISMATCH", "Request does not pin the exact immutable native base");
    if (request.costs.currency !== base.config.currency) {
      throw new CapitalProgramError("COST_CURRENCY_MISMATCH", "Declared costs must use the exact native currency and scale 1");
    }
    candidates = generateCapitalCandidates(base, context.entities, context.permitted);
    result.baseDigest = base.digest;
  } catch (error) {
    result.blockers.push(blocker(error));
    result.gap.stopReason = codeOf(error);
    return deepFreeze(result);
  }
  const seen = new Map<string, number>();
  let processed = 0, stopReason: string | null = null;
  for (const [index, candidate] of candidates.entries()) {
    if (result.attempts.length >= request.budget.maxAttempts) {
      stopReason = "ATTEMPT_BUDGET";
      break;
    }
    let constructed: ReturnType<typeof constructNativeCandidate>;
    try {
      constructed = constructNativeCandidate(base, context.entities, context.permitted, candidate, request);
    } catch (error) {
      result.attempts.push(rejected(index, candidate, codeOf(error)));
      processed += 1;
      continue;
    }
    const duplicateOf = seen.get(constructed.semanticDigest);
    if (duplicateOf !== undefined) {
      result.attempts.push({
        index, isIncumbent: index === 0, candidate, semanticDigest: constructed.semanticDigest,
        disposition: "DUPLICATE", duplicateOf, reason: "CANONICAL_EFFECTIVE_ECONOMICS_ALREADY_ATTEMPTED",
        declaredEvaluationCost: decimal("0"), program: null,
      });
      processed += 1;
      continue;
    }
    if (result.costs.nativeExecutions >= request.budget.maxNativeExecutions) {
      result.attempts.push(rejected(index, candidate, "NATIVE_EXECUTION_BUDGET", constructed.semanticDigest));
      // This descriptor is observed/rejected but not evaluated; retain it in the gap.
      stopReason = "NATIVE_EXECUTION_BUDGET";
      break;
    }
    let compiled: ReturnType<typeof compileNativeCandidate>;
    try {
      compiled = compileNativeCandidate(constructed);
    } catch (error) {
      seen.set(constructed.semanticDigest, index);
      result.attempts.push(rejected(index, candidate, codeOf(error), constructed.semanticDigest));
      processed += 1;
      continue;
    }
    if (result.costs.declaredWorkUnits + compiled.compilation.declaredWorkUnits > request.budget.maxWorkUnits) {
      result.attempts.push(rejected(index, candidate, "DECLARED_WORK_BUDGET", constructed.semanticDigest));
      stopReason = "DECLARED_WORK_BUDGET";
      break;
    }
    seen.set(constructed.semanticDigest, index);
    result.costs.nativeExecutions += 1;
    result.costs.declaredWorkUnits += compiled.compilation.declaredWorkUnits;
    result.costs.declaredEvaluationLiability = add(result.costs.declaredEvaluationLiability, request.costs.perNativeExecution);
    try {
      const program = executeNativeCandidate(compiled, request);
      result.attempts.push({
        index, isIncumbent: index === 0, candidate, semanticDigest: constructed.semanticDigest,
        disposition: program.economics ? "EVALUATED" : "FAILED", duplicateOf: null,
        reason: program.economics ? null : program.nativeRun.failure?.code ?? "NATIVE_VALIDITY_CHECK_FAILED",
        declaredEvaluationCost: request.costs.perNativeExecution, program,
      });
    } catch (error) {
      // An unexpected execution/conversion failure still incurs native-call liability.
      result.attempts.push({
        index, isIncumbent: index === 0, candidate, semanticDigest: constructed.semanticDigest,
        disposition: "FAILED", duplicateOf: null, reason: codeOf(error),
        declaredEvaluationCost: request.costs.perNativeExecution, program: null,
      });
      result.blockers.push(blocker(error));
    }
    processed += 1;
  }
  for (const attempt of result.attempts) {
    if (attempt.disposition === "EVALUATED") result.counts.evaluated += 1;
    else if (attempt.disposition === "FAILED") result.counts.failed += 1;
    else if (attempt.disposition === "REJECTED") result.counts.rejected += 1;
    else result.counts.duplicate += 1;
  }
  const finiteDomainComplete = processed === candidates.length && stopReason === null;
  result.status = finiteDomainComplete ? "COMPLETE_DEV" : "PARTIAL_DEV";
  result.gap = {
    finiteDomainComplete, remainingGeneratedDescriptors: candidates.length - processed, stopReason,
    externalOptimalityBound: null, globalOptimalityClaimed: false,
  };
  const incumbent = result.attempts[0]?.program?.economics;
  if (!incumbent) {
    result.blockers.push({ owner: "M3", code: "INCUMBENT_NATIVE_EVALUATION_FAILED",
      reason: "No valid incumbent numeric baseline exists; no local replacement comparison can be returned", ref: null });
    return deepFreeze(result);
  }
  let best = result.attempts[0]!;
  for (const attempt of result.attempts) {
    const value = attempt.program?.economics;
    if (value && cmp(value.localValueBeforeSearchCost, best.program!.economics!.localValueBeforeSearchCost) > 0) best = attempt;
  }
  const bestImprovement = sub(sub(best.program!.economics!.localValueBeforeSearchCost,
    incumbent.localValueBeforeSearchCost), result.costs.declaredEvaluationLiability);
  const selected = cmp(bestImprovement, request.objective.minimumNetImprovement) > 0 ? best : result.attempts[0]!;
  result.selection = {
    incumbentAttempt: 0, bestFiniteAttempt: best.index, selectedAttempt: selected.index,
    costAdjustedImprovement: bestImprovement,
    selectedNetChangeVsUnsearchedIncumbent: sub(sub(selected.program!.economics!.localValueBeforeSearchCost,
      incumbent.localValueBeforeSearchCost), result.costs.declaredEvaluationLiability),
    utilityOwner: "S4_UNBOUND_LOCAL_SURROGATE_ONLY",
  };
  return deepFreeze(result);
}
