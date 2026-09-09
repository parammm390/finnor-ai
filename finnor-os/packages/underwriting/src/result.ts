import { canonicalSerialize, deepFreeze, semanticHash } from "./canonical";
import { asUnderwritingFailure } from "./errors";
import {
  UNDERWRITING_ENGINE_VERSION,
  UNDERWRITING_LIMITS,
  type CheckResult,
  type NodeExecutionResult,
  type SolverDiagnostic,
  type SponsorCashFlow,
  type UnderwritingRunValidity,
  type UnderwritingRunResult,
} from "./types";

interface FinalizeResultInput {
  status: "SUCCEEDED" | "FAILED";
  validity: UnderwritingRunValidity;
  modelSemanticHash: string;
  inputSemanticHash: string;
  scenarioSemanticHash?: string;
  values?: Record<string, NodeExecutionResult>;
  outputs?: Record<string, NodeExecutionResult>;
  checks?: CheckResult[];
  solverDiagnostics?: SolverDiagnostic[];
  sponsorCashFlows?: SponsorCashFlow[];
  failure?: unknown;
}

export function runResultHash(result: Omit<UnderwritingRunResult, "resultSemanticHash"> | UnderwritingRunResult): string {
  const { resultSemanticHash: _ignored, ...body } = result as UnderwritingRunResult;
  return semanticHash(body);
}

export function finalizeRunResult(input: FinalizeResultInput): Readonly<UnderwritingRunResult> {
  const body = {
    status: input.status,
    validity: input.validity,
    engineVersion: UNDERWRITING_ENGINE_VERSION,
    modelSemanticHash: input.modelSemanticHash,
    inputSemanticHash: input.inputSemanticHash,
    ...(input.scenarioSemanticHash ? { scenarioSemanticHash: input.scenarioSemanticHash } : {}),
    values: input.values ?? {},
    outputs: input.outputs ?? {},
    checks: input.checks ?? [],
    solverDiagnostics: input.solverDiagnostics ?? [],
    ...(input.sponsorCashFlows ? { sponsorCashFlows: input.sponsorCashFlows } : {}),
    ...(input.failure ? { failure: asUnderwritingFailure(input.failure) } : {}),
  };
  const bytes = Buffer.byteLength(canonicalSerialize(body));
  if (bytes > UNDERWRITING_LIMITS.resultBytes) {
    const failure = asUnderwritingFailure(new Error("Canonical Run result exceeds the byte limit"));
    failure.code = "RESULT_LIMIT";
    const limited = {
      status: "FAILED" as const,
      validity: "INCOMPLETE" as const,
      engineVersion: UNDERWRITING_ENGINE_VERSION,
      modelSemanticHash: input.modelSemanticHash,
      inputSemanticHash: input.inputSemanticHash,
      ...(input.scenarioSemanticHash ? { scenarioSemanticHash: input.scenarioSemanticHash } : {}),
      values: {}, outputs: {}, checks: [], solverDiagnostics: [], failure,
    };
    return deepFreeze({ ...limited, resultSemanticHash: semanticHash(limited) });
  }
  return deepFreeze({ ...body, resultSemanticHash: semanticHash(body) }) as Readonly<UnderwritingRunResult>;
}
