/** Narrow, explicit original-behavior refinement. Unsupported revisions
 * require a new admitted semantic bridge; they cannot reset an actual prefix. */
import { hash, type OriginalBinding, type PublicArena } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";

export interface ViabilityRevisionBridge {
  schema: "finnor.z3.identity-revision-bridge.v1"; previousSessionId: string;
  previousArenaDigest: string; previousBindingDigest: string; currentBindingDigest: string;
  strategyDigest: string; cursor: { stateId: string; memory: number; operations: number;
    goalVisits: { READINESS: number; RECONCILE: number } };
  rule: "EXACT_ORIGINAL_BEHAVIOR_AND_CHECKED_INITIAL_MEMORY";
  candidateReuseAllowed: false; newAllowance: false;
}
export function originalViabilityIdentityRefinement(input: {
  previousSessionId: string; previousBinding: OriginalBinding; binding: OriginalBinding;
  previousArena: PublicArena; arena: PublicArena; previousReservation: unknown; reservation: unknown;
  strategy: unknown; cursor: ViabilityRevisionBridge["cursor"];
}): ViabilityRevisionBridge {
  const a = input.previousBinding, b = input.binding;
  if (["tenantId", "principalId", "workId", "originalParentId", "mandateDigest", "observationDigest", "resourceDigest", "deadlineAt"]
    .some(k => a[k as keyof OriginalBinding] !== b[k as keyof OriginalBinding])
    || hash(input.previousReservation) !== hash(input.reservation)
    || hash(input.previousArena) !== hash(input.arena)
    || input.arena.initial.length !== 1 || input.arena.initial[0] !== input.cursor.stateId) {
    throw Error("Z3_ORIGINAL_BEHAVIOR_REVISION_BRIDGE_REQUIRED");
  }
  return { schema: "finnor.z3.identity-revision-bridge.v1", previousSessionId: input.previousSessionId,
    previousArenaDigest: hash(input.previousArena), previousBindingDigest: hash(a), currentBindingDigest: hash(b),
    strategyDigest: hash(input.strategy), cursor: input.cursor, rule: "EXACT_ORIGINAL_BEHAVIOR_AND_CHECKED_INITIAL_MEMORY",
    candidateReuseAllowed: false, newAllowance: false };
}
