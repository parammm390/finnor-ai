import type { PeMutationContext } from "../../types";
import { principal, tx } from "../../evidence-execution/store";
import { nativeApplicationProfile } from "../../application-semantics/store";
import { profileScopeKey, runWithPrefetchedProfiles, type PrefetchedProfile } from "../../application-semantics/profile-scope";
import { z3Fault } from "./contracts";

/** Resolves the profiles of the Work's application sessions on their own
 * connections BEFORE `run` opens a Z3 transaction. Inside the transaction the
 * material-cut lock is already held, and resolving a profile inserts an
 * authority decision that needs that same lock. Resolution errors are kept
 * and rethrown at the consuming check, so the typed refusal is unchanged. */
export async function withApplicationProfiles<R>(ctx: PeMutationContext, workId: string,
  run: () => Promise<R>): Promise<R> {
  const ids = (await tx(ctx, async c => (await c.query<{ id: string }>(
    `SELECT DISTINCT p::text id FROM finnor_os.application_semantics_sessions s, unnest(s.profile_ids) p
     WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.work_id=$3 AND s.id<>s.parent_id
       AND s.status NOT IN('CANCELLED','FAILED') ORDER BY 1 LIMIT 17`,
    [ctx.auth.tenantId, principal(ctx), workId])).rows, true)).map(row => row.id);
  if (ids.length > 16) z3Fault("Z3_NATIVE_APPLICATION_PROFILE_BOUND");
  const profiles = new Map<string, PrefetchedProfile<unknown>>();
  await Promise.all(ids.map(async id => {
    try { profiles.set(profileScopeKey(ctx.auth.tenantId, principal(ctx), id), { ok: true, value: await nativeApplicationProfile(ctx, id) }); }
    catch (error) { profiles.set(profileScopeKey(ctx.auth.tenantId, principal(ctx), id), { ok: false, error }); }
  }));
  return runWithPrefetchedProfiles(profiles, run);
}
