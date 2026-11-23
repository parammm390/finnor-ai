import type { PoolClient } from 'pg';
import type { AllocationResource, ExperimentRef } from '@finnor/shared-types';
import type { PeMutationContext } from '../../types';
import { principal } from '../../owner-context';
import { boundedJSON, digest, requireZ1 } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { OriginalPortfolioStream, PORTFOLIO_STREAM, type PortfolioStreamScope } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/portfolio-stream.js';
import { Z1_PORTFOLIO } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/portfolio-population.js';

async function transactionScopeTx(ctx: PeMutationContext, c: PoolClient): Promise<PortfolioStreamScope> {
  const actor = (await c.query<{ actor: string }>('SELECT finnor_os.z1_s5_actor()::text actor')).rows[0]?.actor;
  const row = (await c.query<PortfolioStreamScope>(
    `SELECT finnor_os.request_tenant_id()::text "tenantId",current_setting('app.user_id',true) "principalId",
     txid_current()::text "transactionId",revision::text "rightsRevision"
     FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE`, [ctx.auth.tenantId])).rows[0];
  requireZ1(row && actor === principal(ctx) && row.tenantId === ctx.auth.tenantId && row.principalId === actor,
    'Z1_NATIVE_PORTFOLIO_AUTHENTICATED_TRANSACTION_REQUIRED', 'REVOKED');
  return row;
}

/** Current original use needs complete canonical context, not serialization of
 * an unused all-tenant snapshot. Existing parents continue to hold exposure. */
export async function assertNativePortfolioContextTx(ctx: PeMutationContext, c: PoolClient) {
  const scope = await transactionScopeTx(ctx, c);
  const row = (await c.query<{ original_count: number; other_count: number; resource_count: number }>(
    `SELECT p.*,(SELECT count(*)::integer FROM finnor_os.s5_resource_heads WHERE tenant_id=$1) resource_count
     FROM finnor_os.z1_s5_portfolio_population() p`, [ctx.auth.tenantId])).rows[0];
  requireZ1(row && Number.isSafeInteger(row.original_count) && row.original_count >= 0 &&
    row.original_count <= Z1_PORTFOLIO.originals && Number.isSafeInteger(row.other_count) &&
    row.other_count >= 0 && row.other_count <= Z1_PORTFOLIO.other && Number.isSafeInteger(row.resource_count) &&
    row.resource_count >= 0 && row.resource_count <= Z1_PORTFOLIO.resources,
  'Z1_COMPLETE_S5_POPULATION_BOUND', 'INCOMPLETE');
  return { scope, originals: row.original_count, other: row.other_count };
}

/** Read only the actual original's selected heads; other tenants/principals'
 * occupation is supplied by the scoped opaque cursor, never treated as zero. */
export async function readNativeResourcesTx(ctx: PeMutationContext, c: PoolClient, refs: readonly ExperimentRef[]) {
  await transactionScopeTx(ctx, c);
  requireZ1(refs.length > 0 && refs.length <= Z1_PORTFOLIO.resources &&
    new Set(refs.map(ref => ref.id)).size === refs.length, 'Z1_NATIVE_PORTFOLIO_SELECTION_REQUIRED', 'INCOMPLETE');
  const resources: AllocationResource[] = [];
  for (const ref of refs) {
    const rows = (await c.query<{ body: AllocationResource }>(
      `SELECT r.body FROM finnor_os.s5_resources r
       JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
       WHERE r.tenant_id=$1 AND r.body->'ref'=$2::jsonb ORDER BY r.resource_id LIMIT 2 FOR SHARE OF h`,
      [ctx.auth.tenantId, JSON.stringify(ref)])).rows;
    requireZ1(rows.length === 1 && digest(rows[0]!.body.ref) === digest(ref),
      'Z1_S5_ORIGINAL_RESOURCE_PREIMAGE_REQUIRED', 'REVOKED');
    boundedJSON(rows[0]!.body, 8388608); resources.push(rows[0]!.body);
  }
  return resources;
}

/** Concrete fixed SQL binding. The WITHOUT HOLD cursor, all FETCHes and final
 * scope check use this same native PoolClient transaction under the S5 lock. */
export async function readNativeCapacityPortfolioTx(ctx: PeMutationContext, c: PoolClient,
  resources: readonly AllocationResource[], requested: Readonly<Record<string, string>>) {
  const scope = await transactionScopeTx(ctx, c), fold = new OriginalPortfolioStream(scope, resources, requested);
  const cursor = (await c.query<{ cursor: string }>(
    'SELECT finnor_os.z1_s5_open_occupation($1::text[])::text cursor',
    [resources.map(resource => resource.resourceId).sort()])).rows[0]?.cursor;
  requireZ1(cursor && /^z1p_[0-9]+_[0-9]+$/.test(cursor), 'Z1_NATIVE_PORTFOLIO_CURSOR_REQUIRED', 'INCOMPLETE');
  let complete = false;
  try {
    for (;;) {
      const rows = (await c.query<{ frame: unknown }>(`FETCH FORWARD ${PORTFOLIO_STREAM.fetchFrames} FROM ${cursor}`)).rows;
      requireZ1(rows.length <= PORTFOLIO_STREAM.fetchFrames, 'Z1_NATIVE_PORTFOLIO_PAGE_BOUND', 'INCOMPLETE');
      boundedJSON(rows, PORTFOLIO_STREAM.pageBytes);
      if (!rows.length) break;
      for (const row of rows) fold.accept(row.frame);
    }
    const receipt = fold.finish();
    requireZ1(digest(await transactionScopeTx(ctx, c)) === digest(scope),
      'Z1_NATIVE_PORTFOLIO_TRANSACTION_CHANGED', 'STALE');
    complete = true; return receipt;
  } finally {
    if (complete) await c.query(`CLOSE ${cursor}`);
    else { try { await c.query(`CLOSE ${cursor}`); } catch { /* Preserve the original failure in an aborted transaction. */ } }
  }
}
