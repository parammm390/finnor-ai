import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { TenantContext } from '@finnor/shared-types';
import { releaseComputeResourceLeases, type ComputeResourceLease } from '@finnor/db';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import { actor, artifact, assertFence, head, tx } from './store';
import { branchRemainingMs, branchCleanupCause } from './budget';
import { fault } from './contracts';

const exec = promisify(execFile);
type Kind = 'NATIVE_PERMIT' | 'PUBLIC_PREPARATION' | 'NATIVE_STATE' | 'CHECKER_STATE';
interface ResourceScope { ctx: TenantContext; branchId: string; attemptId: string; workId: string; execution: Readonly<JobExecutionContext> }
export interface NativeResource {
  id: string; kind: Kind; path: string | null; descriptor: { ownerId: string; root?: string; rootDevice?: string; rootInode?: string };
  process_group: number | null; state: string; claim_fence: string; job_id: string; delivery_attempt_id: string;
}
const ownership = new AsyncLocalStorage<ResourceScope>();
export const withBranchResources = <T>(scope: ResourceScope, invoke: () => Promise<T>) => ownership.run(scope, invoke);
export const hasBranchResources = () => Boolean(ownership.getStore());
async function configuredRoot() {
  const path = process.env.FINNOR_P3_RESOURCE_ROOT;
  if (!path || !isAbsolute(path) || resolve(path) !== path) fault('NATIVE_RESOURCE_ROOT_REQUIRED', 503);
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 ||
    await realpath(path) !== path) fault('NATIVE_RESOURCE_ROOT_UNSAFE', 503);
  return { root: path, rootDevice: String(st.dev), rootInode: String(st.ino) };
}
/** Commit intent and exact unique path before creating anything physical. */
export async function planNativeResource(kind: Kind): Promise<NativeResource> {
  branchRemainingMs();
  const scope = ownership.getStore() ?? fault('DURABLE_RESOURCE_SCOPE_REQUIRED');
  const id = randomUUID(), descriptor = { ownerId: `p3:${scope.branchId}:${scope.execution.deliveryAttemptId}`,
    ...(kind === 'NATIVE_PERMIT' ? {} : await configuredRoot()) };
  const path = descriptor.root ? join(descriptor.root, id) : null;
  return tx(scope.ctx, async c => {
    const h = await head(c, scope.ctx, scope.branchId, true); await assertFence(c, h, scope.execution);
    if (h.attempt_id !== scope.attemptId || !['RUNNING', 'CHECKING'].includes(h.status)) fault('BRANCH_RESOURCE_GENERATION_CHANGED');
    const row = (await c.query<NativeResource>(`INSERT INTO finnor_os.p3_resource_intents
      (id,tenant_id,principal_id,work_id,branch_id,attempt_id,delivery_attempt_id,job_id,claim_token,claim_fence,kind,path,descriptor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
      [id, scope.ctx.tenantId, actor(scope.ctx), scope.workId, scope.branchId, scope.attemptId,
        scope.execution.deliveryAttemptId, scope.execution.jobId, scope.execution.claimToken, scope.execution.claimFence, kind, path,
        JSON.stringify(descriptor)])).rows[0]!;
    await artifact(c, scope.ctx, scope.workId, 'EVENT', { branchId: scope.branchId, attemptId: scope.attemptId,
      type: 'RESOURCE_INTENT', resourceId: id, kind, path, ownerId: descriptor.ownerId, beforePhysicalAcquisition: true });
    return { id: row.id, kind: row.kind, path: row.path, descriptor: row.descriptor,
      process_group: row.process_group, state: row.state, claim_fence: String(row.claim_fence),
      job_id: row.job_id, delivery_attempt_id: row.delivery_attempt_id };
  });
}
export async function createNativeDirectory(kind: Exclude<Kind, 'NATIVE_PERMIT'>) {
  const resource = await planNativeResource(kind);
  await verifyResourceRoot(resource);
  branchRemainingMs();
  await mkdir(resource.path!, { mode: 0o700 }); // Never reuse or overwrite an existing path.
  await markNativeResource(resource, 'CREATED');
  return resource;
}
export async function markNativeResource(resource: NativeResource, state: 'CREATED' | 'STARTED' | 'RETAINED', processGroup?: number) {
  branchRemainingMs();
  const scope = ownership.getStore() ?? fault('DURABLE_RESOURCE_SCOPE_REQUIRED');
  await tx(scope.ctx, async c => {
    const h = await head(c, scope.ctx, scope.branchId); await assertFence(c, h, scope.execution);
    if (h.attempt_id !== scope.attemptId || !['RUNNING', 'CHECKING'].includes(h.status)) fault('BRANCH_RESOURCE_GENERATION_CHANGED');
    await c.query("UPDATE finnor_os.p3_resource_intents SET state=$2,process_group=coalesce(process_group,$3),updated_at=clock_timestamp() WHERE id=$1 AND state<>'CLEANED'",
      [resource.id, state, processGroup ?? null]);
  });
}
async function verifyResourceRoot(resource: NativeResource) {
  const configured = await configuredRoot(), d = resource.descriptor;
  if (configured.root !== d.root || configured.rootDevice !== d.rootDevice || configured.rootInode !== d.rootInode ||
    resource.path !== join(configured.root, resource.id)) fault('RESOURCE_OWNERSHIP_UNCONFIRMED');
}
async function processRows() {
  const result = await exec('/bin/ps', ['-axo', 'pid=,pgid=,command='], { timeout: 500, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), group: Number(match[2]), command: match[3]! } : null;
  }).filter((row): row is NonNullable<typeof row> => row !== null);
}
async function stopResourceProcess(resource: NativeResource) {
  const tag = '--p3-resource-id=' + resource.id, rows = await processRows();
  const matches = rows.filter(r => r.command.startsWith(process.execPath + ' ') && r.command.split(/\s+/).includes(tag));
  const groups = [...new Set(matches.map(r => r.group))];
  for (const row of matches) {
    if (row.pid !== row.group || resource.process_group != null && row.group !== resource.process_group) fault('RESOURCE_PROCESS_IDENTITY_UNCONFIRMED');
    try { process.kill(-row.group, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
  if (resource.process_group != null) groups.push(resource.process_group);
  const deadline = Date.now() + 1500;
  for (;;) {
    const after = await processRows();
    if (!after.some(r => groups.includes(r.group) || r.command.split(/\s+/).includes(tag))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(ok => setTimeout(ok, 25));
  }
}
/** Exact durable ownership, actual queue fence, OS observation and no replay. */
export async function reconcileBranchResources(ctx: TenantContext, branchId: string, execution: Readonly<JobExecutionContext>, includeCurrent = false) {
  const rows = await tx(ctx, async c => {
    const h = await head(c, ctx, branchId); await assertFence(c, h, execution);
    return (await c.query<NativeResource>(`SELECT * FROM finnor_os.p3_resource_intents WHERE tenant_id=$1 AND principal_id=$2 AND branch_id=$3
      AND state<>'CLEANED' AND ($4 OR delivery_attempt_id<>$5) ORDER BY CASE WHEN kind='NATIVE_PERMIT' THEN 1 ELSE 0 END,created_at,id LIMIT 129`,
      [ctx.tenantId, actor(ctx), branchId, includeCurrent, execution.deliveryAttemptId])).rows;
  });
  if (rows.length > 128) fault('RESOURCE_RECONCILIATION_BOUND');
  const observations = [];
  for (const resource of rows) {
    const scope = await tx(ctx, c => head(c, ctx, branchId));
    let stopped = false;
    let stage = 'VERIFY_RESOURCE_OWNERSHIP';
    try {
      if (resource.kind === 'NATIVE_PERMIT') {
        stage = 'RELEASE_EXACT_OWNED_PERMIT_AFTER_SCRATCH';
        const leases = await tx(ctx, async c => (await c.query<ComputeResourceLease>(`SELECT resource_key AS "resourceKey",lease_token AS token,
          fence::integer,owner_id AS "ownerId",120 AS "leaseSeconds" FROM finnor_os.compute_resource_leases
          WHERE tenant_key=$1 AND owner_id=$2 AND resource_key='native:p3-branch' AND released_at IS NULL`,
          [ctx.tenantId, resource.descriptor.ownerId])).rows);
        await releaseComputeResourceLeases(leases, 'P3_DURABLE_OWNERSHIP_RECONCILED_AFTER_STOP');
        stopped = (await tx(ctx, c => c.query('SELECT id FROM finnor_os.compute_resource_leases WHERE tenant_key=$1 AND owner_id=$2 AND released_at IS NULL',
          [ctx.tenantId, resource.descriptor.ownerId]))).rowCount === 0;
      } else {
        await verifyResourceRoot(resource);
        stage = 'OBSERVE_AND_STOP_EXACT_PROCESS';
        stopped = await stopResourceProcess(resource);
        if (stopped) {
          stage = 'REMOVE_PRIVATE_OWNED_DIRECTORY';
          try {
            const st = await lstat(resource.path!);
            if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
              fault('RESOURCE_PATH_IDENTITY_UNCONFIRMED');
            await rm(resource.path!, { recursive: true });
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          try { await lstat(resource.path!); stopped = false; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        }
      }
      stage = 'COMMIT_OBSERVED_CLEANUP';
      await tx(ctx, async c => {
        const h = await head(c, ctx, branchId); await assertFence(c, h, execution);
        await c.query("UPDATE finnor_os.p3_resource_intents SET state=$2,cleanup_observed=$3,reason=$4,updated_at=clock_timestamp() WHERE id=$1",
          [resource.id, stopped ? 'CLEANED' : 'CLEANUP_REQUIRED', stopped, stopped ? null : 'PHYSICAL_TEARDOWN_UNCONFIRMED']);
        await artifact(c, ctx, scope.work_id, 'CLEANUP', { branchId, resourceId: resource.id, kind: resource.kind,
          ownerId: resource.descriptor.ownerId, observedStopped: stopped, resourceRemoved: stopped,
          recovered: resource.delivery_attempt_id !== execution.deliveryAttemptId, financialLiabilitiesRetained: true });
      });
      if (!stopped) fault('BRANCH_CLEANUP_REQUIRED', 503);
      observations.push({ resourceId: resource.id, kind: resource.kind, cleanup: 'OBSERVED_REMOVED', recovered: resource.delivery_attempt_id !== execution.deliveryAttemptId });
    } catch (error) {
      // Do not free a permit after failed scratch/process reconciliation. The
      // durable INTENT/CREATED record remains a retryable cleanup obligation.
      const cause = branchCleanupCause(error);
      let durableFailureRecorded = false;
      try {
        durableFailureRecorded = await tx(ctx, async c => {
          const h = await head(c, ctx, branchId); await assertFence(c, h, execution);
          const changed = await c.query(`UPDATE finnor_os.p3_resource_intents
            SET state='CLEANUP_REQUIRED',cleanup_observed=false,reason=$2,updated_at=clock_timestamp()
            WHERE id=$1 AND state<>'CLEANED' RETURNING id`, [resource.id, cause]);
          if (!changed.rowCount) return false;
          await artifact(c, ctx, h.work_id, 'CLEANUP', { type: 'RESOURCE_CLEANUP_FAILED', branchId,
            resourceId: resource.id, kind: resource.kind, ownerId: resource.descriptor.ownerId,
            jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
            resourceDeliveryAttemptId: resource.delivery_attempt_id, stage, cause,
            observedStopped: stopped, resourceRemoved: false, physicalCleanupUnconfirmed: true, financialLiabilitiesRetained: true });
          return true;
        });
      } catch { /* The same bounded drain may be unavailable; retain the original intent. */ }
      console.error(JSON.stringify({ event: 'P3_RESOURCE_CLEANUP_FAILED', branchId,
        resourceId: resource.id, kind: resource.kind, stage, cause, durableFailureRecorded,
        financialLiabilitiesRetained: true }));
      throw error;
    }
  }
  return observations;
}
