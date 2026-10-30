import { AsyncLocalStorage } from "node:async_hooks";

/** Profiles resolved on their own connections before a caller opens a
 * transaction that already holds the tenant material-cut lock. Resolving a
 * profile inserts an authority decision, so doing it from inside such a
 * transaction waits on that lock through a second connection. */
export type PrefetchedProfile<T> = { ok: true; value: T } | { ok: false; error: unknown };

const scope = new AsyncLocalStorage<ReadonlyMap<string, PrefetchedProfile<unknown>>>();

export const profileScopeKey = (tenantId: string, principalId: string, profileId: string) =>
  `${tenantId}:${principalId}:${profileId}`;

export const runWithPrefetchedProfiles = <R>(profiles: ReadonlyMap<string, PrefetchedProfile<unknown>>,
  run: () => Promise<R>): Promise<R> => scope.run(profiles, run);

/** `null` when no scope is active; `undefined` when a scope is active but the profile was not prefetched. */
export function prefetchedProfile<T>(key: string): PrefetchedProfile<T> | undefined | null {
  const active = scope.getStore();
  if (!active) return null;
  return active.get(key) as PrefetchedProfile<T> | undefined;
}
