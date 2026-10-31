import type { PoolClient } from "pg";
import { withTenantTransaction, DatabaseExecutionDeadlineError, type Db } from "@finnor/db";
import type { EvidenceDependency } from "@finnor/shared-types";
import { authorizeBeliefResources, authorizeBeliefSourceScopes } from "./enterprise-beliefs";
import { PeDomainError, type PeMutationContext, type PeWorldRootRef } from "./types";

export const principal = (ctx: PeMutationContext) => ctx.auth.employeeId ?? ctx.auth.userId;
export const unavailable = () => new PeDomainError("PE_ENTITY_NOT_FOUND", "Evidence resource is unavailable in the authenticated scope");
export const tx = <T>(ctx: PeMutationContext, fn: (client: PoolClient, db: Db) => Promise<T>, readOnly = false) =>
  withTenantTransaction(ctx.auth.tenantId, { userId: principal(ctx), readOnly }, (db, client) => fn(client, db));
export const closingTx = <T>(ctx: PeMutationContext, fn: (client: PoolClient, db: Db) => Promise<T>, readOnly = false) =>
  tx(ctx, async (client, db) => {
    if (!readOnly) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`v3-material-cut:${ctx.auth.tenantId}`]);
    return fn(client, db);
  }, readOnly);

export async function authorize(ctx: PeMutationContext, root: PeWorldRootRef,
  resources: Array<{ type: string; id: string }> = [], sources: string[] = [], client?: PoolClient) {
  try {
    const rights = await authorizeBeliefResources(ctx, [{ type: root.entityType, id: root.entityId }, ...resources], client);
    await authorizeBeliefSourceScopes(ctx, root, sources, client);
    return rights;
  } catch (error) {
    // An exhausted request deadline is not evidence that the resource is outside the caller's scope.
    if (error instanceof DatabaseExecutionDeadlineError) throw error;
    throw unavailable();
  }
}

export async function revisions(ctx: PeMutationContext, keys: string[], client?: PoolClient, lock = false): Promise<EvidenceDependency[]> {
  const unique = [...new Set(keys)].sort();
  const read = async (c: PoolClient) => {
    if (lock) await c.query(
      "INSERT INTO finnor_os.p4_source_revisions(tenant_id,key,revision) SELECT $1,k,0 FROM unnest($2::text[]) k ON CONFLICT DO NOTHING",
      [ctx.auth.tenantId, unique],
    );
    const rows = (await c.query<{ key: string; revision: string }>(
      "SELECT key,revision::text FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 AND key=ANY($2::text[]) ORDER BY key" + (lock ? " FOR UPDATE" : ""),
      [ctx.auth.tenantId, unique],
    )).rows;
    const byKey = new Map(rows.map(r => [r.key, Number(r.revision)]));
    return unique.map(key => ({ key, revision: byKey.get(key) ?? 0, nodeIds: [], digest: null }));
  };
  return client ? read(client) : tx(ctx, read, !lock);
}
export function sameRevisions(a: ReadonlyArray<Pick<EvidenceDependency, "key" | "revision">>, b: ReadonlyArray<Pick<EvidenceDependency, "key" | "revision">>): boolean {
  const byKey = new Map(b.map(d => [d.key, d.revision]));
  return a.every(d => byKey.get(d.key) === d.revision);
}
export async function assertDependencies(ctx: PeMutationContext, dependencies: EvidenceDependency[], client?: PoolClient, lock = false) {
  if (!sameRevisions(dependencies, await revisions(ctx, dependencies.map(d => d.key), client, lock))) {
    throw Error("SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED");
  }
}
