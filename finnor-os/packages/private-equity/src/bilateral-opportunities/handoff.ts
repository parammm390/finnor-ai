import type { PoolClient } from "pg";
import type { PrimaryIntake } from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import { currentArtifact, hash } from "./store";

/** Actual V2 boundary. Exact immutable gaps are transferred, not reinterpreted
 * or relabeled as already established primary facts. New V2 acquisition still
 * requires its real source, consent, semantics and S5 owners. */
export async function resolveBilateralPredecessor(ctx: PeMutationContext, intake: PrimaryIntake, c?: PoolClient) {
  if (!intake.predecessorRef) return null;
  const { artifact: a, programme: p } = await currentArtifact(ctx, intake.predecessorRef, c);
  if (intake.root.entityType !== "pe_opportunity" || intake.root.entityId !== a.opportunityId ||
    intake.workId !== a.workRef || intake.expectedWorkInputId !== a.workRevision ||
    p.work_id !== intake.workId || p.work_input_id !== intake.expectedWorkInputId ||
    !intake.assertions.length || intake.assertions.length !== a.remainingUnderwritingGaps.length || intake.assertions.some(assertion =>
      !a.remainingUnderwritingGaps.some(gap => hash(gap) === hash(assertion))))
    throw Error("V1_V2_EXACT_OPPORTUNITY_WORK_INPUT_AND_UNRESOLVED_GAP_BINDING_REQUIRED");
  return { artifact: a, programme: p, dependencyKey: "bilateral-artifact:" + a.artifactId };
}
