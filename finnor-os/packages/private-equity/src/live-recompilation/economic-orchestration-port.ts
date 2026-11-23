import type { PoolClient } from "pg";
import { z } from "zod";
import type { PeMutationContext } from "../types";
import type { SearchRow } from "../compute-search/contracts";
import { searchRow, append } from "../compute-search/store";
import { requestRow } from "../program-synthesis/store";
import { authorize, revisions, sha, stable } from "../evidence-execution/store";
import { nativeCapsuleSchema } from "../economic-orchestration/contracts";
import { nativeControlSnapshotTx } from "../economic-orchestration/snapshot";
import { invalidateNativeFingerprintsTx, nativeOwnerReadFailure, invalidateNativeOwnerUnavailableTx } from "../economic-orchestration/dependencies";

/** P7 reconciles original owner revisions and the immutable capsule's facets.
 * Only the affected closure returns to its original nonterminal P2 scheduler. */
export async function reconcileEconomicPolicyDependenciesTx(ctx: PeMutationContext, s: SearchRow, c: PoolClient): Promise<string[]> {
  s = await searchRow(ctx, s.id, c, true);
  const q = await requestRow(ctx, s.program_id, c);
  await authorize(ctx, q.request.root, [{ type: "work", id: q.work_id }], [], c);
  const rows = (await c.query(
    "SELECT capsule_digest,dependency_key,revision,facet FROM finnor_os.w1_dependencies WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY capsule_digest,dependency_key",
    [s.tenant_id, s.principal_id, s.id])).rows.map(raw => z.object({
      capsule_digest: z.string(), dependency_key: z.string(), revision: z.coerce.number(), facet: z.string() }).parse(raw));
  const observed = await revisions(ctx, [...new Set(rows.map(row => row.dependency_key))], c, true), affected = new Set<string>();
  for (const row of rows) {
    const found = observed.find(dependency => dependency.key === row.dependency_key);
    if (found && found.revision === row.revision) continue;
    const revision = found?.revision ?? 0;
    await c.query(
      `INSERT INTO finnor_os.w1_invalidations(tenant_id,principal_id,search_id,capsule_digest,dependency_key,observed_revision,body)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [s.tenant_id, s.principal_id, s.id, row.capsule_digest, row.dependency_key, revision,
        stable({ facet: row.facet, priorRevision: row.revision, observedRevision: found?.revision ?? null, ownerReadable: !!found,
          originalEpisode: q.episode_id, oldArtifactsAndCostsRetained: true, originalS6IdentityPreserved: true,
          newGrant: false, authorityGranted: false })]); affected.add(row.capsule_digest);
  }
  const capsules = (await c.query("SELECT body,digest FROM finnor_os.w1_capsules WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY revision",
    [s.tenant_id, s.principal_id, s.id])).rows;
  for (const row of capsules) {
    if (sha(row.body) !== row.digest) throw Error("W1_IMMUTABLE_CAPSULE_DIGEST_MISMATCH");
    const capsule = nativeCapsuleSchema.parse(row.body);
    try {
      let input;
      try { input = await nativeControlSnapshotTx(ctx, s, q, c, capsule.proposal.status === "CHECKED_POLICY" ?
        { pinnedContinuationRef: capsule.proposal.responseRef } : {}); }
      catch (error) {
        if (!(error instanceof Error) || !/^W1_PINNED_CONTINUATION_(EXPIRED|UNAVAILABLE)$/.test(error.message)) throw error;
        input = await nativeControlSnapshotTx(ctx, s, q, c, { pinnedContinuationRef: null });
      }
      if (await invalidateNativeFingerprintsTx(s, q, capsule, input.dependencyState ?? {}, c)) affected.add(row.digest);
    } catch (error) {
      const predicate = nativeOwnerReadFailure(error); if (!predicate) throw error;
      await invalidateNativeOwnerUnavailableTx(s, q, capsule, predicate, c); affected.add(row.digest);
    }
  }
  if (affected.size) {
    await append(ctx, s, "W1_P7_SMALLEST_DEPENDENT_CLOSURE", { affectedCapsules: [...affected],
      unaffectedCapsulesRetained: true, physicalUnknownNotCleared: true, originalEpisode: q.episode_id, authorityGranted: false }, c);
    if (!["CANCELLED", "INVALIDATED", "STOPPED", "FAILED"].includes(s.status)) {
      const { replan } = await import("../compute-search/controller"); await replan(ctx, s, q, c);
    }
  }
  return [...affected];
}
