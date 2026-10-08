import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@finnor/shared-types';
import { decode, fault, hash, PrepareSchema, RequestSchema, type BranchRequest, type InputArtifact } from './contracts';
import { actor, artifact, assertBasis, head, inputFor, readArtifact, tx, workBasis } from './store';
import { prepareInput, currentInput } from './owners';
import { verifyCheckpoint, createCheckpoint } from './checkpoint';
import { capability } from './runtime';
import { assertWorkBudget, beginControl, finishControl, workUsage } from './accounting';

export async function prepare(ctx: TenantContext, value: unknown) {
  const request = decode(PrepareSchema, value), acquisitionId = randomUUID();
  const control = await beginControl(ctx, request.workId, 'ACQUISITION_AND_VERIFICATION', 30000, { accountingId: `acquisition:${acquisitionId}`, acquisitionId, sourceKind: request.source.kind, inputRequestDigest: hash(request) });
  let inputId: string | null = null, input: InputArtifact | null = null, failure: string | null = null;
  try {
    input = await prepareInput(ctx, request);
    inputId = await tx(ctx, c => artifact(c, ctx, input!.basis.workId, 'INPUT', input));
    return { schema: 'finnor.branch-preparation.v1', inputId, acquisitionId, programme: input.programme, basis: input.basis, kind: input.kind, profile: input.profile, inputDigest: hash(input), capability: await capability(), qualification: input.qualification, funding: null, admission: null };
  } catch (e) { failure = e instanceof Error ? e.message : 'ACQUISITION_FAILED'; throw e; }
  finally {
    // A failed/currentness-refused acquisition is still chargeable. A lost
    // controller leaves the durable intent as an outstanding accounting liability.
    await finishControl(control, { acquisitionId, inputId, failure, ownerCompute: input?.ownerBindings.compute ?? null, externalAttemptRefs: input?.ownerBindings.operation ? [input.ownerBindings.operation] : [], storageBytes: input ? Buffer.byteLength(JSON.stringify(input)) : null, meterStatus: input ? 'CONTROL_INTERVAL_OWNER_RECEIPTS_RETAINED' : 'OWNER_FAILURE_USAGE_MAY_BE_INCOMPLETE' });
  }
}
export async function submit(ctx: TenantContext, value: unknown) {
  const request = decode(RequestSchema, value), input = await inputFor(ctx, request.inputId);
  if (input.basis.workId !== request.workId || hash(input.programme) !== hash(request.programme)) fault('REQUEST_INPUT_BINDING_INVALID', 400);
  await currentInput(ctx, input);
  if (request.mode === 'VERIFIED_CHECKPOINT_RESTORE') {
    if (!request.checkpointId) fault('CHECKPOINT_REQUIRED', 400);
    await verifyCheckpoint(ctx, input, request.checkpointId);
  } else if (request.checkpointId) fault('AMBIGUOUS_CHECKPOINT_MODE', 400);
  if (request.mode === 'PRIVATE_STATE_CLONE' && input.kind !== 'application_fixture') fault('PRIVATE_CLONE_DOMAIN_UNSUPPORTED', 400);
  const digest = hash(request);
  return tx(ctx, async c => {
    await workBasis(c, ctx, request.workId);
    const prior = (await c.query('SELECT id,request_digest,status FROM finnor_os.p3_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3', [ctx.tenantId, actor(ctx), request.idempotencyKey])).rows[0];
    if (prior) { if (prior.request_digest !== digest) fault('BRANCH_IDEMPOTENCY_CONFLICT'); return { branchId: prior.id, status: prior.status, semanticReplay: true }; }
    await assertWorkBudget(c, ctx, request.workId, 120000, 1);
    const branchId = randomUUID(), jobId = randomUUID();
    await c.query(`INSERT INTO finnor_os.p3_requests(id,tenant_id,principal_id,work_id,input_id,request,request_digest,basis,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9)`, [branchId, ctx.tenantId, actor(ctx), request.workId, request.inputId, JSON.stringify(request), digest, JSON.stringify(input.basis), request.idempotencyKey]);
    await c.query(`INSERT INTO finnor_os.jobs(id,tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,max_attempts)
      VALUES($1,$2,'run_branch_fabric_v1',$3::jsonb,$4,'batch',1,'pure',3)`, [jobId, ctx.tenantId, JSON.stringify({ tenantId: ctx.tenantId, principalId: actor(ctx), branchId }), `p3:${branchId}:1`]);
    await c.query('UPDATE finnor_os.p3_requests SET job_id=$2 WHERE id=$1', [branchId, jobId]);
    await artifact(c, ctx, request.workId, 'EVENT', { branchId, generation: 1, type: 'REQUEST_ACCEPTED_FOR_ASYNC_PREPARATION', requestDigest: digest, at: new Date().toISOString(), funding: null, admission: null, externalSettlement: 'NOT_APPLICABLE' });
    return { branchId, status: 'PREPARING', semanticReplay: false, protectedEligible: false };
  });
}
export async function read(ctx: TenantContext, branchId: string) {
  const h = await tx(ctx, c => head(c, ctx, branchId));
  const input = await inputFor(ctx, h.input_id);
  try { await currentInput(ctx, input); }
  catch (e) {
    await tx(ctx, async c => {
      const now = await head(c, ctx, branchId, true);
      if (!['CANCELLED', 'FAILED', 'INVALIDATED', 'QUARANTINED'].includes(now.status)) await c.query("UPDATE finnor_os.p3_requests SET status='INVALIDATED',epoch=epoch+1,reason='CURRENT_OWNER_VECTOR_CHANGED' WHERE id=$1", [branchId]);
    }).catch(() => undefined);
    throw e;
  }
  return tx(ctx, async c => {
    const fresh = await head(c, ctx, branchId); await assertBasis(c, ctx, fresh);
    const result = fresh.status === 'COMPLETE' && fresh.result_id ? await readArtifact<any>(c, ctx, fresh.result_id, 'RESULT') : null;
    return { branchId, status: fresh.status, generation: fresh.generation, reason: fresh.reason, kind: input.kind, programme: input.programme, baselineDigest: hash(input.payload), currentness: 'CURRENT', profile: input.profile, result, resultRef: result ? { id: fresh.result_id, contentDigest: hash(result), category: 'RESULT' } : null, checkpointId: fresh.checkpoint_id, work: input.basis, protectedEligible: false, funding: null, admission: null, externalSettlement: 'NOT_APPLICABLE' };
  });
}
export async function list(ctx: TenantContext, workId: string, limit: number, after?: string) {
  const ids = await tx(ctx, async c => {
    await workBasis(c, ctx, workId);
    return (await c.query('SELECT id FROM finnor_os.p3_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5', [ctx.tenantId, actor(ctx), workId, after ?? null, limit])).rows.map(r => r.id);
  });
  const branches = [];
  for (const id of ids) { try { branches.push(await read(ctx, id)); } catch { branches.push({ branchId: id, status: 'INVALIDATED', result: null }); } }
  return { branches, next: ids.length === limit ? ids.at(-1) : null };
}
export async function compare(ctx: TenantContext, branchIds: string[]) {
  const branches = await Promise.all(branchIds.map(id => read(ctx, id)));
  const inputs = await Promise.all(branchIds.map(async id => inputFor(ctx, (await tx(ctx, c => head(c, ctx, id))).input_id)));
  const cut = (i: InputArtifact) => hash({ root: i.root, kind: i.kind, basis: i.basis.dependencyDigest, programme: i.programme, profile: i.profile, sourceKind: i.source.kind, baseline: i.source.kind === 'financing_fixture' ? i.ownerBindings.stateDigest : i.source.kind === 'public_fixture' ? i.ownerBindings.sourceDigest : i.ownerBindings });
  if (inputs.some(i => cut(i) !== cut(inputs[0]!))) fault('COMPARISON_DOMAIN_MISMATCH');
  return { schema: 'finnor.branch-comparison.v1', branches, evidenceClass: branches[0]!.result?.evidenceClass ?? null, accountingScope: 'ALL_ATTEMPTS_UNRECONCILED_USD', rejectedAndUnknownIncluded: true, winner: null, executionAuthorityGranted: false };
}
export async function cancel(ctx: TenantContext, branchId: string) {
  return tx(ctx, async c => {
    const h = await head(c, ctx, branchId, true);
    await workBasis(c, ctx, h.work_id);
    if (['COMPLETE', 'CANCELLED', 'FAILED', 'INVALIDATED', 'QUARANTINED'].includes(h.status)) return { branchId, status: h.status, observedStopped: h.status === 'CANCELLED' };
    await c.query("UPDATE finnor_os.p3_requests SET status='CANCEL_REQUESTED',epoch=epoch+1 WHERE id=$1", [branchId]);
    await artifact(c, ctx, h.work_id, 'EVENT', { branchId, type: 'CANCELLATION_REQUESTED', epoch: h.epoch + 1, at: new Date().toISOString(), observedStopped: false });
    return { branchId, status: 'CANCEL_REQUESTED', observedStopped: false };
  });
}
export async function resume(ctx: TenantContext, branchId: string, checkpointId: string, idempotencyKey: string) {
  const h = await tx(ctx, c => head(c, ctx, branchId)), input = await inputFor(ctx, h.input_id);
  await verifyCheckpoint(ctx, input, checkpointId);
  // Complete logical result replay is a new request and new actual physical attempt.
  // It reuses pinned inputs, never a previous browser/broker identity.
  return submit(ctx, { ...h.request, mode: 'VERIFIED_CHECKPOINT_RESTORE', checkpointId, idempotencyKey });
}
export async function inspect(ctx: TenantContext, branchId: string) {
  let currentness = 'CURRENT';
  try { await read(ctx, branchId); } catch {
    await tx(ctx, async c => { const h = await head(c, ctx, branchId); await workBasis(c, ctx, h.work_id); });
    currentness = 'INVALIDATED_ACCOUNTING_ONLY';
  }
  return tx(ctx, async c => {
    const h = await head(c, ctx, branchId);
    const rows = (await c.query("SELECT id,category,content_digest,body,recorded_at FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND body->>'branchId'=$4 AND ($5 OR category IN ('COST','CLEANUP')) ORDER BY recorded_at,id LIMIT 256", [ctx.tenantId, actor(ctx), h.work_id, branchId, currentness === 'CURRENT'])).rows;
    for (const row of rows) if (hash(row.body) !== row.content_digest) fault('WITNESS_DIGEST_INVALID');
    const charged = new Set(rows.filter(r => r.category === 'COST').map(r => r.body.attemptId));
    const inputCosts = (await c.query("SELECT id,body,content_digest FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category='COST' AND body->>'inputId'=$3 ORDER BY recorded_at,id LIMIT 64", [ctx.tenantId, actor(ctx), h.input_id])).rows;
    for (const row of inputCosts) if (hash(row.body) !== row.content_digest) fault('WITNESS_DIGEST_INVALID');
    return { branchId, currentness, artifacts: rows, acquisitionCostsSharedAcrossInputUsesNotChargedTwice: inputCosts, workUsage: await workUsage(c, ctx, h.work_id), outstandingAttemptCosts: rows.filter(r => r.category === 'ATTEMPT' && !charged.has(r.id)).map(r => r.id), retainedUnknownUsageLiabilities: rows.filter(r => r.category === 'COST' && r.body.reservedLiabilityMs != null).map(r => r.id), aggregateMoneyUSD: null, reconciliation: 'UNRECONCILED', qualification: 'ORDINARY_IMMUTABLE_ATTEMPTS_CHECKS_COSTS_NOT_PROTECTED_RECEIPTS' };
  });
}
export async function continuation(ctx: TenantContext, branchId: string) {
  const branch = await read(ctx, branchId);
  return { schema: 'finnor.branch-continuation.v1', status: 'FRESH_S4_S5_S6_AUTHORITY_REQUIRED', branchId, resultRef: branch.resultRef, evidenceClass: branch.result?.evidenceClass ?? null, executionAuthorityGranted: false, reusableRequestTranscript: false, requiredOwners: ['S4', 'S5', 'S6'] };
}
export { createCheckpoint };
