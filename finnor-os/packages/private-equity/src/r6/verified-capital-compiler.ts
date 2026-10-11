import { canonicalSerialize, sealInputSnapshot } from "../../../underwriting/src/index";
import type { CompiledUnderwritingModel, UnderwritingInputSnapshot } from "../../../underwriting/src/types";
import {
  runVerifiedCapitalCompiler,
  type R6ResolvedProblem, type R6RunRequest, type R6RunResponse,
} from "../../../epistemic-runtime/src/verified-capital-compiler/index";

export type R6PreparedRunRequest = Omit<R6RunRequest, "problem"> & {
  problem: Omit<R6ResolvedProblem, "programme" | "witness">;
};

/** Executable, non-persisting seam after the existing prepareUnderwritingRun.
 * That owner still resolves tenant, ModelVersion, Evidence/rights and Scenario.
 * This adapter cannot create a prepared owner context or confer authority.
 * On any non-COMPLETE result the existing underwriting/S4/S5 route remains
 * unchanged; neither a development receipt nor this adapter reserves funds. */
export async function runPreparedVerifiedCapitalCompiler(
  // Exactly the two native fields of the existing PreparedRun, not a new owner
  // context. The native type view avoids pulling unrelated SQL/API packages
  // into this non-persisting leaf's compile/runtime dependency graph.
  prepared: {
    compiled: CompiledUnderwritingModel;
    effectiveSnapshot: Readonly<UnderwritingInputSnapshot>;
  },
  request: R6PreparedRunRequest,
): Promise<R6RunResponse> {
  const response = await runVerifiedCapitalCompiler({
    ...request,
    problem: {
      ...request.problem,
      programme: prepared.compiled.model,
      witness: sealInputSnapshot(prepared.effectiveSnapshot),
    },
  });
  if (response.packet
    && canonicalSerialize(response.packet.compiledProgramme) !== canonicalSerialize(prepared.compiled)) {
    return {
      ...response, status: "INVALIDATED", artifact_ref: null, incumbent_ref: null, proof: null,
      unresolved_claim_refs: [request.problem_ref],
      reason: "Proof compilation does not bind the exact existing owner-prepared ModelVersion",
    };
  }
  return response;
}
