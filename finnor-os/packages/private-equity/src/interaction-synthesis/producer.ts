import {
  canonical, PROFILE, ProblemSchema, type InteractionProblem, type RuntimeIdentity, type ConstructionResult
} from "./contracts.js";
import { isolatedRequest } from "./process.js";

export { runtimeIdentity, independentlyCheck } from "./process.js";
export async function construct(
  input: InteractionProblem, deadlineAtEpochMs: number, runtime?: RuntimeIdentity, signal?: AbortSignal
): Promise<ConstructionResult> {
  const incomplete = (reason: string, status: ConstructionResult["status"] = "INCOMPLETE"): ConstructionResult => ({
    status, candidate: null, reasons: [reason], search: { steps: 0, policies: 0, profiles: 0, complete: false }
  });
  if (!Number.isSafeInteger(deadlineAtEpochMs) || deadlineAtEpochMs <= Date.now()) return incomplete("Y3_DEADLINE");
  if (signal?.aborted) return incomplete("Y3_ABORTED");
  let problem: InteractionProblem;
  try {
    if (Buffer.byteLength(canonical(input)) > PROFILE.maxRequestBytes) return incomplete("Y3_REQUEST_BYTE_BOUND", "UNSUPPORTED");
    problem = ProblemSchema.parse(input);
  } catch { return incomplete("Y3_PROBLEM_SHAPE", "UNSUPPORTED"); }
  const budgetMs = Math.max(0, Math.min(PROFILE.maxProcessWallMs, deadlineAtEpochMs - Date.now()));
  const result = await isolatedRequest("producer.py", { problem, budgetMs }, deadlineAtEpochMs, runtime, signal);
  if (result.reason || !result.value) return incomplete(result.reason ?? "Y3_PRODUCER_NO_OUTPUT");
  const value = result.value as ConstructionResult;
  if (!["CANDIDATE", "INCOMPLETE", "INFEASIBLE", "UNIDENTIFIED", "UNSUPPORTED", "UNKNOWN"].includes(value.status)
    || !Array.isArray(value.reasons) || !value.search || value.search.complete !== false)
    return incomplete("Y3_PRODUCER_OUTPUT_SHAPE", "UNKNOWN");
  if (value.status === "CANDIDATE" && (!value.candidate || Buffer.byteLength(canonical(value.candidate)) > PROFILE.maxArtifactBytes))
    return incomplete("Y3_PRODUCER_ARTIFACT_BOUND", "UNKNOWN");
  return value;
}
