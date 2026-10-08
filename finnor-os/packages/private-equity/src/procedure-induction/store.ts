import type { PoolClient } from 'pg';
import type { PeMutationContext } from '../types';
import { authorize, codeIdentity, principal, sha, stable, tx, unavailable } from '../evidence-execution/store';
import { readProcedureExperience } from './experience';
import { componentRef, parseCapsule, type EpisodeCut, type InductionRequest, type ProcedureCapsule, type ImmutableRef } from './contracts';

export interface InductionRow {
  id: string; tenant_id: string; principal_id: string; work_id: string; work_input_id: string;
  work_input_digest: string; request: InductionRequest; request_digest: string; cut: EpisodeCut;
  cut_digest: string; source_digest: string; schema_digest: string; state: string; generation: number;
  deadline_at: Date; capsule_ids: string[]; claim_token: string | null; claim_fence: number | null;
  attempts_used: number; reason: string | null;
}
export async function inductionRow(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false) {
  const read = async (client: PoolClient) => {
    const row = (await client.query<InductionRow>(`SELECT * FROM finnor_os.p6_inductions
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3` + (lock ? ' FOR UPDATE' : ''),
    [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw unavailable();
    if (sha(row.request) !== row.request_digest || sha(row.cut) !== row.cut_digest)
      throw Error('P6_DURABLE_REQUEST_OR_CUT_PREIMAGE_INVALID');
    return row;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function authorizeInduction(ctx: PeMutationContext, row: InductionRow) {
  await authorize(ctx, row.request.root, [{ type: 'work', id: row.work_id }]);
  // Refresh rights for the full declared universe without rewriting its cut.
  const fresh = await readProcedureExperience(ctx, {
    programIds: row.request.programIds, knowledgeCut: row.request.knowledgeCut, mode: 'ordinary_disposable',
  });
  if (fresh.cutDigest !== row.cut.cutDigest) throw Error('P6_NATIVE_EPISODE_CUT_CHANGED');
  return fresh;
}
export async function assertInductionWork(ctx: PeMutationContext, row: InductionRow, c: PoolClient) {
  await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE', [row.tenant_id, row.work_id]);
  const latest = (await c.query<{ id: string; body: unknown }>(
    `SELECT id::text,to_jsonb(i) body FROM finnor_os.work_inputs i WHERE tenant_id=$1 AND work_id=$2
     ORDER BY created_at DESC,id DESC LIMIT 1`, [row.tenant_id, row.work_id])).rows[0];
  if (latest?.id !== row.work_input_id || sha(latest.body) !== row.work_input_digest)
    throw Error('P6_EXACT_WORK_REVISION_CHANGED');
}
export async function appendProcedureEvent(ctx: PeMutationContext, row: InductionRow,
  kind: string, body: unknown, idempotencyKey: string, c: PoolClient, capsuleId: string | null = null) {
  const digest = sha(body);
  const prior = (await c.query<{ body: unknown; digest: string; id: string }>(
    `SELECT id,body,digest FROM finnor_os.p6_events WHERE tenant_id=$1 AND principal_id=$2
     AND induction_id=$3 AND idempotency_key=$4`, [row.tenant_id, principal(ctx), row.id, idempotencyKey])).rows[0];
  if (prior) {
    if (sha(prior.body) !== prior.digest || prior.digest !== digest) throw Error('P6_EVENT_IDEMPOTENCY_CONFLICT');
    return componentRef('event', prior.body);
  }
  await c.query(`INSERT INTO finnor_os.p6_events(tenant_id,principal_id,induction_id,capsule_id,kind,body,digest,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
  [row.tenant_id, principal(ctx), row.id, capsuleId, kind, stable(body), digest, idempotencyKey]);
  return componentRef('event', body);
}
export async function capsuleRow(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false) {
  const read = async (client: PoolClient) => {
    const row = (await client.query<{ id: string; induction_id: string; body: ProcedureCapsule; digest: string }>(
      `SELECT id,induction_id,body,digest FROM finnor_os.p6_capsules WHERE tenant_id=$1 AND principal_id=$2 AND id=$3` +
      (lock ? ' FOR SHARE' : ''), [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw unavailable();
    if (sha(row.body) !== row.digest) throw Error('P6_IMMUTABLE_CAPSULE_PREIMAGE_INVALID');
    const capsule = parseCapsule(row.body);
    if (capsule.id !== id || capsule.tenantId !== ctx.auth.tenantId || capsule.principalId !== principal(ctx))
      throw Error('P6_CAPSULE_SCOPE_OR_IDENTITY_INVALID');
    return { ...row, body: capsule };
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function readCapsule(ctx: PeMutationContext, id: string) {
  const stored = await capsuleRow(ctx, id), row = await inductionRow(ctx, stored.induction_id);
  const refreshed = await authorizeInduction(ctx, row);
  const adverse = refreshed.newAdverseNoticeRefs.filter(ref =>
    !row.cut.newAdverseNoticeRefs.some(prior => stable(prior) === stable(ref)));
  const history = await tx(ctx, async c => (await c.query<{ kind: string; body: unknown; digest: string }>(
    `SELECT kind,body,digest FROM finnor_os.p6_events WHERE tenant_id=$1 AND principal_id=$2
     AND induction_id=$3 AND (capsule_id=$4 OR capsule_id IS NULL) ORDER BY created_at,id LIMIT 513`,
  [ctx.auth.tenantId, principal(ctx), row.id, id])).rows, true);
  if (history.length > 512) throw Error('P6_IMMUTABLE_HISTORY_BOUND');
  for (const event of history) if (sha(event.body) !== event.digest) throw Error('P6_IMMUTABLE_HISTORY_PREIMAGE_INVALID');
  const invalidation = await tx(ctx, async c => (await c.query(
    'SELECT ref,reason FROM finnor_os.p6_invalidations WHERE tenant_id=$1 AND principal_id=$2 AND capsule_id=$3',
  [ctx.auth.tenantId, principal(ctx), id])).rows[0] ?? null, true);
  return { capsule: stored.body, state: invalidation || adverse.length ? 'INVALIDATED' as const : 'PROPOSED' as const,
    invalidation, newAdverseNoticeRefs: adverse, history, costs: history.filter(e => /ATTEMPT|COST/.test(e.kind)),
    executionAuthorityGranted: false, admissionGranted: false };
}
export async function currentCapsule(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false) {
  const stored = await capsuleRow(ctx, id, c, lock), row = await inductionRow(ctx, stored.induction_id);
  const fresh = await authorizeInduction(ctx, row);
  if (fresh.newAdverseNoticeRefs.some(ref =>
    !row.cut.newAdverseNoticeRefs.some(prior => stable(prior) === stable(ref))))
    throw Error('P6_NEW_ADVERSE_EPISODE_NOTICE_REQUIRES_REASSESSMENT');
  const read = async (client: PoolClient) => {
    // Selection and counterexample append use the same lock. The lock is held
    // through P1 final publication when called with its transaction.
    if (lock) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7601))',
      [ctx.auth.tenantId + ':' + principal(ctx) + ':' + id]);
    const bad = (await client.query('SELECT ref FROM finnor_os.p6_invalidations WHERE tenant_id=$1 AND principal_id=$2 AND capsule_id=$3',
      [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (bad) throw Error('P6_CAPSULE_INVALIDATED');
  };
  if (c) await read(c); else await tx(ctx, read, true);
  if (stored.body.producer.codeDigest !== (await codeIdentity()).digest) throw Error('P6_CAPSULE_COMPILER_OR_RUNTIME_CHANGED');
  return stored.body;
}
export async function resolveCapsuleComponent(ctx: PeMutationContext, id: string, reference: ImmutableRef) {
  const stored = await capsuleRow(ctx, id), row = await inductionRow(ctx, stored.induction_id);
  await authorizeInduction(ctx, row);
  const candidates: Array<{ ref: ImmutableRef; body: unknown }> = [];
  for (const [name, body] of Object.entries(stored.body.components)) candidates.push({ ref: componentRef(name, body), body });
  const history = await tx(ctx, async c => (await c.query<{ kind: string; body: unknown; digest: string }>(
    `SELECT kind,body,digest FROM finnor_os.p6_events WHERE tenant_id=$1 AND principal_id=$2
     AND induction_id=$3 AND (capsule_id=$4 OR capsule_id IS NULL) ORDER BY created_at,id LIMIT 513`,
    [ctx.auth.tenantId, principal(ctx), row.id, id],
  )).rows, true);
  if (history.length > 512) throw Error('P6_IMMUTABLE_HISTORY_BOUND');
  for (const event of history) {
    if (sha(event.body) !== event.digest) throw Error('P6_IMMUTABLE_HISTORY_PREIMAGE_INVALID');
    candidates.push({ ref: componentRef(event.kind === 'COUNTEREXAMPLE' ? 'counterexample' : 'event', event.body), body: event.body });
  }
  for (const record of row.cut.records) {
    candidates.push({ ref: record.ref, body: record.body });
    if (record.kind === 'PROGRAMME_HEAD') {
      const program = record.body as import('../program-synthesis/contracts').HarnessProgram;
      candidates.push({ ref: componentRef('source-cost', program.costs), body: program.costs },
        { ref: componentRef('source-checks', program.independentChecks), body: program.independentChecks });
    }
  }
  const match = candidates.find(candidate => stable(candidate.ref) === stable(reference));
  if (!match || sha(match.body) !== reference.contentDigest) throw Error('P6_IMMUTABLE_REFERENCE_UNAVAILABLE');
  return { ref: reference, body: match.body, qualification: 'ORDINARY_OWNER_PREIMAGE_NOT_PROTECTED_TRUTH' };
}
