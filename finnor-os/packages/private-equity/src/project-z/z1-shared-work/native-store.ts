import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ExperimentRef } from '@finnor/shared-types';
import { employeeAuthoritySnapshotTx } from '@finnor/authority';
import { withTenantTransaction } from '@finnor/db';
import type { JobExecutionContext } from '../../../../../apps/worker/src/queue';
import type { PeMutationContext } from '../../types';
import { authorize, principal, tx } from '../../owner-context';
import { withNativeTransaction as withS5PortfolioTransaction } from './resources.js';
import { persistEconomicRecordTx } from '../../economic-store';
import {
  boundedJSON, digest, requireZ1, RequestSchema, Z1_LOCK, type SharedWorkRequest, type WorkProjection,
} from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { requestAfterChanges, currentness } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/engine.js';
import { epistemicHash } from '../../../../epistemic-runtime/src/source-precedence';
import { runtimeIdentity, installedSourceIdentity } from './processes.js';
import { assertBudgetCurrentTx, currentWorkInputTx } from './resources.js';
import {
  DeclarationSchema, SourceDeclarationSchema, SubmitSchema, developmentOnly, parsed, same, nativeRef,
  assertOriginalBudget, type Submit, type NativeCut, type NativeRow, type OriginalBudget,
} from './native-contracts.js';
import type { ClaimPayload, ClaimedSnapshot, PublishedProgram } from './owner.js';

export async function artifactTx<T>(ctx: PeMutationContext, c: PoolClient, requestId: string, owner: string, kind: string, body: T): Promise<ExperimentRef> {
  boundedJSON(body, 134217728);
  const reference = nativeRef(owner, kind, body);
  await c.query(
    `INSERT INTO finnor_os.z1_artifacts(tenant_id,principal_id,request_id,artifact_id,kind,reference,body)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(tenant_id,artifact_id)
     DO NOTHING`,
    [ctx.auth.tenantId, principal(ctx), requestId, reference.id, kind, JSON.stringify(reference), JSON.stringify(body)]);
  const row = (await c.query<{ body: T; reference: ExperimentRef }>(
    'SELECT body,reference FROM finnor_os.z1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id=$3',
    [ctx.auth.tenantId, principal(ctx), reference.id])).rows[0];
  requireZ1(row && same(row.body, body) && same(row.reference, reference), 'Z1_NATIVE_IMMUTABLE_ARTIFACT_CONFLICT');
  return reference;
}
export async function eventTx(ctx: PeMutationContext, c: PoolClient, requestId: string, attempt: string | null, key: string, body: unknown) {
  boundedJSON(body, 8388608);
  await c.query(
    `INSERT INTO finnor_os.z1_events(tenant_id,principal_id,request_id,attempt_id,event_key,body)
     VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,request_id,event_key)
     DO NOTHING`,
    [ctx.auth.tenantId, principal(ctx), requestId, attempt, key, JSON.stringify(body)]);
  const prior = (await c.query<{ body: unknown }>(
    'SELECT body FROM finnor_os.z1_events WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND event_key=$4',
    [ctx.auth.tenantId, principal(ctx), requestId, key])).rows[0];
  requireZ1(prior && same(prior.body, body), 'Z1_NATIVE_EVENT_IDEMPOTENCY_CONFLICT');
}
export async function rowTx(ctx: PeMutationContext, c: PoolClient, requestId: string, lock = true, originalWorkId?: string): Promise<NativeRow> {
  const row = (await c.query<NativeRow>(
    `SELECT * FROM finnor_os.z1_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock ? ' FOR UPDATE' : ''}`,
    [ctx.auth.tenantId, principal(ctx), requestId])).rows[0];
  requireZ1(row && digest(row.request) === row.request_digest, 'Z1_PERMITTED_ORIGINAL_REQUEST_REQUIRED', 'REVOKED');
  requireZ1(!originalWorkId || row.cuts.some(cut => cut.workId === originalWorkId), 'Z1_ORIGINAL_WORK_REQUIRED', 'REVOKED');
  await authorize(ctx, row.root, row.request.works.filter(work => !originalWorkId || work.id === originalWorkId)
    .map(work => ({ type: 'work', id: work.id })), [], c);
  return row;
}
async function evidenceTx(ctx: PeMutationContext, c: PoolClient, root: Submit['root'], pin: Submit['works'][number]['declaration']) {
  await authorize(ctx, root, [{ type: 'evidence_source_version', id: pin.versionId }], [pin.sourceId], c);
  await c.query('SELECT finnor_os.z1_lock_source_cut($1::uuid)', [pin.sourceId]);
  const row = (await c.query<{ id: string; content_hash: string; snapshot: Record<string, unknown> }>(
    `SELECT id::text,content_hash,snapshot FROM finnor_os.evidence_source_versions
     WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1 FOR SHARE`,
    [ctx.auth.tenantId, pin.sourceId])).rows[0];
  requireZ1(row && row.id === pin.versionId && row.content_hash === pin.contentDigest &&
    same(row.snapshot.worldRoot, root) && row.snapshot.protectionDomain === 'DISPOSABLE_LOCAL_DEVELOPMENT' &&
    row.snapshot.externalEffects === false, 'Z1_CURRENT_CANONICAL_S1_PREIMAGE_REQUIRED', 'STALE');
  return row.snapshot;
}
export async function originalObligationsTx(ctx: PeMutationContext, c: PoolClient, workId: string): Promise<string[]> {
  requireZ1((await c.query<{ complete: boolean }>('SELECT finnor_os.y4_control_context_complete() complete')).rows[0]?.complete === true,
    'Z1_COMPLETE_ORIGINAL_S6_CONTEXT_REQUIRED', 'INCOMPLETE');
  const rows = (await c.query<{ obligation_id: string }>(
    `SELECT o.obligation_id FROM finnor_os.s6_obligation_origins o
     JOIN finnor_os.domain_actions a ON a.tenant_id=o.tenant_id AND a.id=o.domain_action_id
     WHERE o.tenant_id=$1 AND o.principal_id=$2 AND
       (a.work_id=$3 OR o.body->'workLineage'->>'workId'=$3::text) ORDER BY o.obligation_id LIMIT 4097`,
    [ctx.auth.tenantId, principal(ctx), workId])).rows;
  requireZ1(rows.length <= 4096, 'Z1_ORIGINAL_S6_OBLIGATION_BOUND', 'INCOMPLETE');
  // Retain every historical identity. Settlement/release still belongs to S6/S5.
  return rows.map(row => row.obligation_id);
}
async function resolveTx(ctx: PeMutationContext, c: PoolClient, input: Submit, identity: SharedWorkRequest['identity'],
  originalDeadline: string, originalWorkId?: string): Promise<{ request: SharedWorkRequest; cuts: NativeCut[]; budgets: OriginalBudget[]; rights: string }> {
  const workPins = input.works.filter(work => !originalWorkId || work.workId === originalWorkId);
  requireZ1(!originalWorkId || workPins.length === 1, 'Z1_ORIGINAL_WORK_REQUIRED', 'REVOKED');
  await authorize(ctx, input.root, workPins.map(work => ({ type: 'work', id: work.workId })), [], c);
  requireZ1(new Set(input.works.map(work => work.workId)).size === input.works.length, 'Z1_DISTINCT_ORIGINAL_WORKS_REQUIRED');
  const rights = String((await employeeAuthoritySnapshotTx(ctx.auth, c)).revision), cuts: NativeCut[] = [], budgets: OriginalBudget[] = [];
  const works: SharedWorkRequest['works'] = [], sources = new Map<string, SharedWorkRequest['sources'][number]>();
  const evidence = new Map<string, Awaited<ReturnType<typeof evidenceTx>>>();
  const resolveEvidence = async (pin: Submit['works'][number]['declaration']) => {
    const key = digest(pin), prior = evidence.get(key);
    if (prior) return prior;
    requireZ1(evidence.size < 8192, 'Z1_UNIQUE_CANONICAL_PIN_BOUND', 'INCOMPLETE');
    const snapshot = await evidenceTx(ctx, c, input.root, pin); evidence.set(key, snapshot); return snapshot;
  };
  for (const workPin of workPins) {
    const cut = await currentWorkInputTx(ctx, c, workPin.workId, input.root);
    const snapshot = await resolveEvidence(workPin.declaration);
    const declaration = parsed(DeclarationSchema, snapshot.z1OriginalWork, 134217728), work = declaration.work;
    requireZ1(work.id === workPin.workId && work.inputRef === cut.inputId &&
      work.partition.tenantId === ctx.auth.tenantId && work.partition.principalId === principal(ctx) &&
      work.partition.rightsRevision === rights && work.partition.permittedUse === 'Z1_EXACT_DERIVATION_FOR_ORIGINAL_WORK',
    'Z1_ORIGINAL_WORK_MEANING_AND_CURRENT_INPUT_REQUIRED', 'REVOKED');
    const budget = await assertBudgetCurrentTx(ctx, c, declaration.parentReservation);
    assertOriginalBudget(work, budget); budgets.push(budget);
    const obligations = await originalObligationsTx(ctx, c, work.id);
    requireZ1(same([...work.unresolvedObligationRefs].sort(), obligations), 'Z1_ORIGINAL_S6_RESPONSIBILITY_COVERAGE_REQUIRED', 'REVOKED');
    const workSources: string[] = [];
    for (const pin of declaration.sourcePins) {
      const sourceSnapshot = await resolveEvidence(pin);
      const source = parsed(SourceDeclarationSchema, sourceSnapshot.z1Source, 134217728).source;
      requireZ1(source.partition.tenantId === ctx.auth.tenantId &&
        source.partition.principalId === principal(ctx) && source.partition.rightsRevision === rights,
      'Z1_SOURCE_ORIGINAL_SCOPE_REQUIRED', 'REVOKED');
      const prior = sources.get(source.id);
      requireZ1(!prior || same(prior, source), 'Z1_CANONICAL_SOURCE_ALIAS_CONFLICT');
      sources.set(source.id, source); workSources.push(source.id);
    }
    requireZ1(same([...workSources].sort(), [...new Set(work.programme.nodes.flatMap(node =>
      node.op === 'source' ? [node.sourceId] : []))].sort()), 'Z1_EXACT_ORIGINAL_SOURCE_PIN_COVERAGE_REQUIRED');
    works.push(work); cuts.push({ workId: work.id, ...cut, declarationDigest: digest(declaration),
      declaration: workPin.declaration, sourcePins: declaration.sourcePins,
      consumer: declaration.consumer, parent: declaration.parentReservation });
  }
  const content: SharedWorkRequest = { schema: 'finnor.z1.request.v1', identity, works,
    sources: [...sources.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    limits: { ...input.limits, deadlineAt: originalDeadline } };
  // A per-original currentness probe is not a new one-Work production request.
  // Each source/declaration was already strictly parsed above.
  const request = originalWorkId ? content : RequestSchema.parse(content);
  requireZ1(request.works.reduce((n, work) => n + work.programme.nodes.length, 0) <= 4096 &&
    request.sources.reduce((n, source) => n + source.rows.length, 0) <= 100000,
  'Z1_COMBINED_ORIGINAL_DOMAIN_BOUND', 'INCOMPLETE');
  boundedJSON(request, request.limits.maxBytes);
  return { request, cuts, budgets, rights };
}
export async function assertRowCurrentTx(ctx: PeMutationContext, c: PoolClient, row: NativeRow, originalWorkId?: string): Promise<void> {
  requireZ1(row.status !== 'CANCELLED' && (originalWorkId || row.status !== 'INVALIDATED') && row.deadline_at.getTime() > Date.now(),
    'Z1_ORIGINAL_REQUEST_NO_LONGER_CURRENT', 'REVOKED');
  const runtime = await runtimeIdentity();
  const installed = await installedSourceIdentity();
  requireZ1(runtime.digest === row.runtime.digest && runtime.digest === row.request.identity.producerBuildIdentity,
    'Z1_INSTALLED_NATIVE_OWNER_CHANGED', 'STALE');
  requireZ1(installed.sourceCommit === row.request.identity.sourceCommit && installed.sourceTree === row.request.identity.sourceTree &&
    installed.reconstructionReference === row.request.identity.reconstructionReference,
    'Z1_INSTALLED_ORIGINAL_SOURCE_CUT_CHANGED', 'STALE');
  const current = await resolveTx(ctx, c, row.intake, row.request.identity, row.request.limits.deadlineAt, originalWorkId);
  const originals = originalWorkId ? row.request.works.filter(work => work.id === originalWorkId) : row.request.works;
  const cuts = originalWorkId ? row.cuts.filter(cut => cut.workId === originalWorkId) : row.cuts;
  requireZ1(same(current.request.works, originals) && same(current.cuts, cuts) &&
    (originalWorkId || same(current.request, row.request)) && current.rights === row.rights_revision,
    'Z1_ORIGINAL_WORK_SOURCE_RIGHTS_TERMS_OR_OWNER_CHANGED', 'STALE');
}
export async function fenceTx(ctx: PeMutationContext, c: PoolClient, row: NativeRow, claim: Readonly<JobExecutionContext>) {
  const owned = (await c.query(
    `SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.id=$6
     WHERE j.id=$1 AND j.tenant_id=$2 AND j.status='running' AND j.claim_token=$3 AND j.claim_fence=$4
     AND j.protocol_version=1 AND j.lease_owner=$5 AND j.lease_expires_at>clock_timestamp()
     AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND a.outcome='running' AND a.finished_at IS NULL
     AND j.payload->>'requestId'=$7 AND (j.payload->>'generation')::int=$8 FOR SHARE OF j,a`,
    [claim.jobId, ctx.auth.tenantId, claim.claimToken, claim.claimFence, claim.workerId,
      claim.deliveryAttemptId, row.id, row.generation])).rows[0];
  requireZ1(owned && claim.tenantId === row.tenant_id, 'Z1_ACTUAL_CANONICAL_JOB_FENCED', 'REVOKED');
}
export async function enqueueTx(ctx: PeMutationContext, c: PoolClient, row: NativeRow, workId?: string, publication?: ExperimentRef) {
  const payload = { tenantId: ctx.auth.tenantId, principalId: principal(ctx), requestId: row.id, generation: row.generation,
    workIds: row.request.works.map(work => work.id), ...(workId ? { workId, publication } : {}) };
  const type = workId ? 'consume_shared_work_projection_v1' : 'run_shared_work_program_v1';
  const key = `z1:${ctx.auth.tenantId}:${row.id}:${row.generation}:${workId ?? 'produce'}:${publication?.contentDigest ?? ''}`;
  return (await c.query<{ id: string }>(
    `INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane,retry_safety)
     VALUES($1,$2,$3::jsonb,$4,1,4,'interactive','locally_idempotent')
     ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
    [ctx.auth.tenantId, type, JSON.stringify(payload), key])).rows[0]!.id;
}
export async function submitNativeSharedWork(ctx: PeMutationContext, value: unknown) {
  developmentOnly(); const input = parsed(SubmitSchema, value, 134217728), runtime = await runtimeIdentity();
  const source = await installedSourceIdentity();
  return withS5PortfolioTransaction(ctx, async c => {
    const original = input.previous ? await rowTx(ctx, c, input.previous.requestId) : null;
    const replay = (await c.query<{ request_id: string; request_digest: string }>(
      'SELECT request_id,request_digest FROM finnor_os.z1_intakes WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (replay) {
      requireZ1(replay.request_digest === digest(input), 'Z1_NATIVE_INTAKE_IDEMPOTENCY_CONFLICT');
      const row = await rowTx(ctx, c, replay.request_id); await assertRowCurrentTx(ctx, c, row);
      return { requestId: row.id, generation: row.generation, status: row.status, replayed: true };
    }
    if (original) requireZ1(original.status !== 'CANCELLED' && original.generation === input.previous!.generation && original.checkpoint &&
      original.attempts_used < 16 && original.wall_used_ms + original.wall_reserved_ms < 120000 && original.deadline_at.getTime() > Date.now() &&
      same(original.root, input.root) && same(original.runtime, { digest: runtime.digest }),
    'Z1_ORIGINAL_GENERATION_OR_REMAINING_EPISODE_EXHAUSTED', 'INCOMPLETE');
    let deadline = original?.request.limits.deadlineAt ?? new Date(Date.now() + 86400000).toISOString();
    const identity: SharedWorkRequest['identity'] = original?.request.identity ?? {
      productLockDigest: Z1_LOCK, sourceCommit: source.sourceCommit, sourceTree: source.sourceTree,
      producerBuildIdentity: runtime.digest, checkerIdentity: 'z1-original-fraction-v1',
      ownerConsumerContractVersion: 'z1-per-original-work-v1', reconstructionReference: source.reconstructionReference,
    };
    const resolved = await resolveTx(ctx, c, input, identity, deadline);
    if (!original) {
      deadline = new Date(Math.min(...resolved.budgets.map(budget => Date.parse(budget.original.deadlineAt)))).toISOString();
      resolved.request.limits.deadlineAt = deadline;
    }
    if (original) {
      requireZ1(same(original.cuts.map(cut => cut.workId).sort(), resolved.cuts.map(cut => cut.workId).sort()),
        'Z1_SAME_ORIGINAL_EPISODE_WORKS_REQUIRED', 'REVOKED');
      const expected = requestAfterChanges(original.checkpoint!, input.previous!.changes);
      requireZ1(same(expected, resolved.request), 'Z1_SIGNED_CHANGE_MUST_EQUAL_CURRENT_CANONICAL_ORIGINALS', 'COUNTEREXAMPLE');
      requireZ1(resolved.request.limits.maxTicks <= original.request.limits.maxTicks &&
        resolved.request.limits.maxBytes <= original.request.limits.maxBytes, 'Z1_ORIGINAL_LIMITS_CANNOT_BE_RENEWED', 'REVOKED');
    }
    const id = original?.id ?? randomUUID(), generation = (original?.generation ?? 0) + 1;
    const priorEpisodes = (await c.query<{ work_id: string; request_id: string; deadline_at: Date }>(
      `SELECT work_id,request_id,deadline_at FROM finnor_os.z1_work_episodes
       WHERE tenant_id=$1 AND principal_id=$2 AND work_id=ANY($3::uuid[]) FOR UPDATE`,
      [ctx.auth.tenantId, principal(ctx), resolved.cuts.map(cut => cut.workId)])).rows;
    requireZ1(original ? priorEpisodes.length === resolved.cuts.length &&
      priorEpisodes.every(episode => episode.request_id === id && episode.deadline_at.toISOString() === deadline) :
      priorEpisodes.length === 0, 'Z1_ORIGINAL_EPISODE_AND_DEADLINE_CANNOT_BE_RENEWED', 'REVOKED');
    if (original) await c.query(
      `UPDATE finnor_os.z1_requests SET intake=$4::jsonb,request=$5::jsonb,request_digest=$6,cuts=$7::jsonb,
       rights_revision=$8,generation=$9,publication=NULL,status='QUEUED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [ctx.auth.tenantId, principal(ctx), id, JSON.stringify(input), JSON.stringify(resolved.request), digest(resolved.request),
        JSON.stringify(resolved.cuts), resolved.rights, generation]);
    else await c.query(
      `INSERT INTO finnor_os.z1_requests(tenant_id,principal_id,id,root,intake,request,request_digest,runtime,cuts,rights_revision,deadline_at)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11)`,
      [ctx.auth.tenantId, principal(ctx), id, JSON.stringify(input.root), JSON.stringify(input), JSON.stringify(resolved.request),
        digest(resolved.request), JSON.stringify({ digest: runtime.digest }), JSON.stringify(resolved.cuts), resolved.rights, deadline]);
    if (!original) for (const cut of resolved.cuts) await c.query(
      'INSERT INTO finnor_os.z1_work_episodes(tenant_id,principal_id,work_id,request_id,deadline_at) VALUES($1,$2,$3,$4,$5)',
      [ctx.auth.tenantId, principal(ctx), cut.workId, id, deadline]);
    await c.query('INSERT INTO finnor_os.z1_intakes(tenant_id,principal_id,idempotency_key,request_id,generation,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey, id, generation, digest(input), JSON.stringify(input)]);
    const row = await rowTx(ctx, c, id);
    const jobId = await enqueueTx(ctx, c, row);
    await eventTx(ctx, c, id, null, `intake:${generation}`, { kind: 'AUTHENTICATED_ORIGINAL_INTAKE',
      generation, requestDigest: digest(resolved.request), originalWorkIds: resolved.request.works.map(work => work.id), jobId,
      priorCostsAndObligationsRetained: true, executionAuthorityGranted: false });
    return { requestId: id, generation, jobId, status: 'QUEUED', replayed: false };
  });
}
export async function contextForNativeClaim(payload: ClaimPayload & { workId?: string }, claim: Readonly<JobExecutionContext>): Promise<PeMutationContext> {
  requireZ1(claim.tenantId === payload.tenantId && claim.protocolVersion === 1, 'Z1_ACTUAL_CLAIM_REQUIRED', 'REVOKED');
  // The job asserts identity only. The canonical active user supplies the role.
  const user = await withTenantTransaction(payload.tenantId, { userId: payload.principalId, readOnly: true }, async (_db, c) => (await c.query<{ role: string }>(
    "SELECT role FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active'",
    [payload.tenantId, payload.principalId])).rows[0]);
  requireZ1(user?.role === 'owner', 'Z1_CURRENT_CANONICAL_OWNER_REQUIRED', 'REVOKED');
  const ctx: PeMutationContext = { auth: { tenantId: payload.tenantId, userId: payload.principalId, employeeId: payload.principalId, role: 'owner' } };
  await withS5PortfolioTransaction(ctx, async c => { const row = await rowTx(ctx, c, payload.requestId, true, payload.workId);
    requireZ1(row.generation === payload.generation, 'Z1_ORIGINAL_GENERATION_FENCED', 'STALE'); await fenceTx(ctx, c, row, claim); });
  return ctx;
}
export async function loadNativeClaim(ctx: PeMutationContext, payload: ClaimPayload, claim: Readonly<JobExecutionContext>): Promise<ClaimedSnapshot> {
  return withS5PortfolioTransaction(ctx, async c => {
    const row = await rowTx(ctx, c, payload.requestId); await fenceTx(ctx, c, row, claim); await assertRowCurrentTx(ctx, c, row);
    requireZ1(row.generation === payload.generation && row.attempts_used < 16 && row.wall_used_ms + row.wall_reserved_ms < 120000,
      'Z1_ORIGINAL_NATIVE_EPISODE_EXHAUSTED', 'INCOMPLETE');
    const originalRequestRef = await artifactTx(ctx, c, row.id, 'S3', 'z1-original-request', row.request);
    return { request: row.request, ...(row.checkpoint ? { previous: row.checkpoint } : {}), version: row.version,
      remainingWallMs: Math.min(30000, 120000 - row.wall_used_ms - row.wall_reserved_ms, row.deadline_at.getTime() - Date.now()),
      originalRequestRef, ...(row.publication ? { publication: row.publication } : {}) };
  });
}
export async function readPublishedTx(ctx: PeMutationContext, c: PoolClient, reference: ExperimentRef, workId: string) {
  const stored = (await c.query<{ body: PublishedProgram['body']; request_id: string; reference: ExperimentRef }>(
    'SELECT body,request_id,reference FROM finnor_os.z1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id=$3 AND kind=$4',
    [ctx.auth.tenantId, principal(ctx), reference.id, 'z1-checked-publication'])).rows[0];
  requireZ1(stored && same(reference, stored.reference) && reference.contentDigest === epistemicHash(stored.body),
    'Z1_CANONICAL_PUBLICATION_PREIMAGE_REQUIRED', 'REVOKED');
  const row = await rowTx(ctx, c, stored.request_id, true, workId);
  await assertRowCurrentTx(ctx, c, row, workId);
  requireZ1(row.publication && same(row.publication.reference, reference) &&
    currentness(stored.body.candidate, row.request, workId) === 'CURRENT', 'Z1_ORIGINAL_PUBLICATION_NOT_CURRENT', 'STALE');
  return { publication: { reference, body: stored.body }, currentRequest: row.request, row };
}
export async function recordNativeCostTx(ctx: PeMutationContext, c: PoolClient, row: NativeRow, key: string, payload: Record<string, unknown>) {
  const result = await persistEconomicRecordTx(ctx, { kind: 'COMPUTE', rightsRef: row.rights_revision,
    idempotencyKey: `z1:${digest([row.id, key])}`, validAt: new Date().toISOString(), horizon: 'H0',
    uncertainty: 'EXACT_LOGICAL_ALLOCATION_WITH_OBSERVED_PHYSICAL_SCOPE_AND_EXPLICIT_MONEY_GAPS',
    semanticRequestDigest: digest([row.id, key, payload]),
    payload: { schema: 'finnor.s7.z1-native-cost.v1', requestId: row.id, generation: row.generation,
      originalWorkIds: row.request.works.map(work => work.id), ...payload, money: null, currency: 'USD',
      lifecycleFinancialCostComplete: false, protectedAdmission: false, executionAuthorityGranted: false } }, c);
  await eventTx(ctx, c, row.id, null, `s7:${digest(key)}`, { kind: 'CANONICAL_S7_COMPUTE_REFERENCE',
    reference: result.record.ref, physicalFinancialGapsRetained: true, executionAuthorityGranted: false });
  return result;
}
export async function readNativeWorkProjection(ctx: PeMutationContext, root: Submit['root'], workId: string) {
  developmentOnly();
  return withS5PortfolioTransaction(ctx, async c => {
    await authorize(ctx, root, [{ type: 'work', id: workId }], [], c);
    const rows = (await c.query<NativeRow>(
      `SELECT q.* FROM finnor_os.z1_requests q WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.root=$3::jsonb
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.request->'works') w WHERE w->>'id'=$4)
       ORDER BY q.created_at DESC,q.id DESC LIMIT 2`, [ctx.auth.tenantId, principal(ctx), JSON.stringify(root), workId])).rows;
    const row = rows[0]; if (!row) return { workId, status: 'NOT_REQUESTED', executionAuthorityGranted: false };
    let current = true; try { await assertRowCurrentTx(ctx, c, row, workId); } catch { current = false; }
    const projection: WorkProjection | undefined = current ? row.publication?.body.candidate.workProjections.find(work => work.workId === workId) : undefined;
    const uses = row.publication ? (await c.query<{ body: unknown }>(
      'SELECT body FROM finnor_os.z1_owner_uses WHERE tenant_id=$1 AND principal_id=$2 AND publication_id=$3 AND work_id=$4 ORDER BY created_at',
      [ctx.auth.tenantId, principal(ctx), row.publication.reference.id, workId])).rows.map(item => item.body) : [];
    const attempts = (await c.query<{ status: string; costs_unknown: boolean }>(
      'SELECT status,costs_unknown FROM finnor_os.z1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at,id LIMIT 16',
      [ctx.auth.tenantId, principal(ctx), row.id])).rows;
    return { workId, requestId: row.id, generation: row.generation, status: current ? row.status : 'STALE_OR_REVOKED',
      artifactRef: current ? row.publication?.reference ?? null : null, projection: projection ?? null,
      originalOwnerUses: current ? uses : [], historicalOwnerUseCount: uses.length,
      costs: { logical: projection?.accounting ?? null, attempts, usd: null, lifecycleComplete: false },
      unresolvedObligationRefs: await originalObligationsTx(ctx, c, workId),
      originalDeadline: row.deadline_at.toISOString(), businessCompletionGranted: false, protectedAdmission: false,
      qualification: 'CONDITIONAL_EXACT_ORIGINAL_DERIVATION_NOT_BUSINESS_SUCCESS', executionAuthorityGranted: false };
  });
}
