import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTenantClientTransaction } from '@finnor/db';
import type { TenantContext } from '@finnor/shared-types';
import { fault, hash, WORK_LIMITS, type Basis, type BranchRequest, type InputArtifact, type State } from './contracts';
export const actor = (ctx: TenantContext) => ctx.employeeId ?? ctx.userId;
export const tx = <T>(ctx: TenantContext, fn: (c: PoolClient) => Promise<T>) => withTenantClientTransaction(ctx.tenantId, { userId: actor(ctx) }, fn);
export interface Head {
  id: string; work_id: string; input_id: string; request: BranchRequest; basis: Basis;
  status: State; generation: number; epoch: number; attempt_id: string | null; result_id: string | null;
  checkpoint_id: string | null; job_id: string | null; created_at: Date; reason: string | null;
}
/** Original inputs are immutable. Latest input membership is also material. */
export async function workBasis(c: PoolClient, ctx: TenantContext, workId: string): Promise<Basis> {
  const user = (await c.query('SELECT u.id,u.status,coalesce(s.revision,1) AS authority_revision FROM finnor_os.users u LEFT JOIN finnor_os.authority_states s ON s.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.id=$2 FOR SHARE OF u', [ctx.tenantId, actor(ctx)])).rows[0];
  const work = (await c.query('SELECT id,created_by,current_owner_id,status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE', [ctx.tenantId, workId])).rows[0];
  if (!user || user.status !== 'active' || !work || ![work.created_by, work.current_owner_id].includes(actor(ctx))) fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
  const inputs = (await c.query('SELECT id,instruction_text,context_snapshot_hash,created_at FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id LIMIT 129', [ctx.tenantId, workId])).rows;
  if (!inputs.length || inputs.length > 128) fault('WORK_INPUT_COVERAGE_UNAVAILABLE', 409);
  const input = inputs.at(-1)!;
  const inputDigest = hash(inputs.map(i => ({ id: i.id, text: i.instruction_text, context: i.context_snapshot_hash, at: new Date(i.created_at).toISOString() })));
  const rightsRevision = Number(user.authority_revision);
  if (!Number.isSafeInteger(rightsRevision) || rightsRevision < 1 || ['cancelled', 'failed'].includes(work.status)) fault('WORK_OR_RIGHTS_UNAVAILABLE', 409);
  return { workId, inputRevision: input.id, inputDigest, rightsRevision, validAt: new Date(input.created_at).toISOString(), knowledgeAt: new Date().toISOString(), dependencyDigest: hash({ inputDigest, rightsRevision, workStatus: work.status }) };
}
export async function artifact(c: PoolClient, ctx: TenantContext, workId: string, category: string, body: unknown, id = randomUUID()): Promise<string> {
  const digest = hash(body);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`p3-budget:${ctx.tenantId}:${actor(ctx)}:${workId}`]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`p3-storage:${ctx.tenantId}:${actor(ctx)}:${workId}`]);
  const existing = (await c.query('SELECT id,work_id,body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category=$3 AND content_digest=$4', [ctx.tenantId, actor(ctx), category, digest])).rows[0];
  if (existing) {
    if (existing.work_id !== workId || hash(existing.body) !== digest) fault('ARTIFACT_CONFLICT');
    return existing.id;
  }
  const storage = (await c.query(`SELECT coalesce(sum(octet_length(body::text)),0)+octet_length($4::jsonb::text) AS bytes
    FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`, [ctx.tenantId, actor(ctx), workId, JSON.stringify(body)])).rows[0];
  const bound = WORK_LIMITS.retainedJsonBytes + (['COST', 'EVENT', 'CLEANUP'].includes(category) ? WORK_LIMITS.accountingReserveBytes : 0);
  if (Number(storage.bytes) > bound) fault('WORK_RETAINED_STORAGE_BOUND');
  const row = await c.query(
    `INSERT INTO finnor_os.p3_artifacts(id,tenant_id,principal_id,work_id,category,content_digest,body)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,principal_id,category,content_digest) DO NOTHING RETURNING id`,
    [id, ctx.tenantId, actor(ctx), workId, category, digest, JSON.stringify(body)]);
  if (row.rows[0]) return row.rows[0].id;
  const prior = (await c.query('SELECT id,work_id,body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category=$3 AND content_digest=$4', [ctx.tenantId, actor(ctx), category, digest])).rows[0];
  if (!prior || prior.work_id !== workId || hash(prior.body) !== digest) fault('ARTIFACT_CONFLICT');
  return prior.id;
}
export async function readArtifact<T>(c: PoolClient, ctx: TenantContext, id: string, category?: string): Promise<T> {
  const row = (await c.query('SELECT category,content_digest,body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3', [ctx.tenantId, actor(ctx), id])).rows[0];
  if (!row || category && row.category !== category) fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
  if (hash(row.body) !== row.content_digest) fault('ARTIFACT_QUARANTINED');
  return row.body as T;
}
export async function head(c: PoolClient, ctx: TenantContext, id: string, lock: boolean | 'share' = false): Promise<Head> {
  const row = (await c.query(`SELECT * FROM finnor_os.p3_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock === 'share' ? ' FOR SHARE' : lock ? ' FOR UPDATE' : ''}`, [ctx.tenantId, actor(ctx), id])).rows[0];
  if (!row) fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
  return row;
}
export async function assertBasis(c: PoolClient, ctx: TenantContext, h: Pick<Head, 'basis' | 'work_id'>) {
  const current = await workBasis(c, ctx, h.work_id);
  if (current.dependencyDigest !== h.basis.dependencyDigest) fault('WORK_OR_RIGHTS_INVALIDATED');
}
export async function changeState(c: PoolClient, h: Head, status: State, reason: string | null = null) {
  await c.query('UPDATE finnor_os.p3_requests SET status=$2,reason=$3,updated_at=clock_timestamp() WHERE id=$1', [h.id, status, reason]);
}
export async function assertFence(c: PoolClient, h: Head, binding: { jobId: string; claimToken: string; claimFence: number }) {
  const job = (await c.query('SELECT id,status,claim_token,claim_fence,lease_expires_at FROM finnor_os.jobs WHERE id=$1 FOR SHARE', [binding.jobId])).rows[0];
  const fence = Number(binding.claimFence);
  if (!Number.isSafeInteger(fence) || fence < 1 || !job || h.job_id !== job.id || job.status !== 'running' || job.claim_token !== binding.claimToken || Number(job.claim_fence) !== fence || new Date(job.lease_expires_at).getTime() <= Date.now()) fault('BRANCH_FENCE_LOST');
}
/** Database time and immutable ancestry, including queue waiting and restores. */
export async function episodeTime(c: PoolClient, ctx: TenantContext, branchId: string) {
  const r = (await c.query<{ deadline_at: Date; remaining_ms: string }>(`WITH d AS MATERIALIZED(
    SELECT finnor_os.p3_episode_deadline($1,$2,$3) AS deadline_at)
    SELECT deadline_at,extract(epoch FROM deadline_at-clock_timestamp())*1000 AS remaining_ms FROM d`,
    [ctx.tenantId, actor(ctx), branchId])).rows[0]!;
  return { deadlineAt: r.deadline_at.toISOString(), remainingMs: Number(r.remaining_ms) };
}
export async function assertEpisodeTime(c: PoolClient, ctx: TenantContext, branchId: string) {
  const time = await episodeTime(c, ctx, branchId);
  if (!Number.isFinite(time.remainingMs) || time.remainingMs <= 0) fault('BRANCH_EPISODE_DEADLINE_EXHAUSTED');
  return time;
}
export async function inputFor(ctx: TenantContext, id: string) { return tx(ctx, c => readArtifact<InputArtifact>(c, ctx, id, 'INPUT')); }
