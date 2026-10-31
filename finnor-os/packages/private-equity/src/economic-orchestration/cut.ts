import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import type { SearchRow } from "../compute-search/contracts";
import type { ProgramRow } from "../program-synthesis/store";
import { nativeControlSnapshotTx } from "./snapshot";
import { latestPublishedEconomicCapsuleTx, currentEconomicDevelopmentCheckTx } from "./capsules";
import { invalidateNativeFingerprintsTx } from "./dependencies";
import { W1_NATIVE_VERSION, nativeDeadlineAt } from "./contracts";
import { sha } from "../evidence-execution/store";

/** A response head advance is not dependency invalidation. Continue the exact
 * immutable, actually fitted revision until its own validity/dependencies fail. */
export async function currentEconomicCutTx(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, c: PoolClient, ignoreAttemptId?: string) {
  const capsule = await latestPublishedEconomicCapsuleTx(ctx, s, c, { historical: true });
  const recorded = capsule && !!(await c.query("SELECT capsule_digest FROM finnor_os.w1_invalidations WHERE tenant_id=$1 AND principal_id=$2 AND capsule_digest=$3 LIMIT 1",
    [s.tenant_id, s.principal_id, sha(capsule)])).rowCount;
  const eligible = capsule?.version === W1_NATIVE_VERSION && !recorded && capsule.proposal.status === "CHECKED_POLICY" &&
    nativeDeadlineAt(capsule.input) > Date.now();
  let input;
  try {
    input = await nativeControlSnapshotTx(ctx, s, q, c, { ignoreAttemptId,
      ...(eligible ? { pinnedContinuationRef: capsule.proposal.status === "CHECKED_POLICY" ? capsule.proposal.responseRef : null } : {}) });
  } catch (error) {
    if (!(error instanceof Error) || !/^W1_PINNED_CONTINUATION_(EXPIRED|UNAVAILABLE)$/.test(error.message)) throw error;
    input = await nativeControlSnapshotTx(ctx, s, q, c, { ignoreAttemptId, pinnedContinuationRef: null });
  }
  const invalidated = capsule ? await invalidateNativeFingerprintsTx(s, q, capsule, input.dependencyState ?? {}, c) : false;
  if (capsule && !invalidated && eligible) await currentEconomicDevelopmentCheckTx(ctx, s, capsule, c);
  return { input, capsule, invalidated };
}
