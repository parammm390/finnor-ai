/** Typed S5 specialization on the existing tables and portfolio serializer.
 * No resource population, new authority, external effect, or parallel ledger. */
import type { PoolClient } from 'pg';
import type { AllocationEnvelope, AllocationResource, ExperimentRef } from '@finnor/shared-types';
import { employeeAuthoritySnapshotTx, evaluateAuthorityTx } from '@finnor/authority';
import { isImmutableWorkStatus, type WorkStatus } from '@finnor/db';
import { allocationSnapshotInTransaction, withS5PortfolioTransaction, allocationPermissionResources } from '../../allocation-store';
import { allocationQuantity } from '../../../../epistemic-runtime/src/allocation-contracts';
import { validateBeliefViewPin } from '../../enterprise-beliefs';
import { authorize, principal } from '../../owner-context';
import { enqueueOwnerDeliveryInTransaction } from '../../../../governed-execution/src/owner-delivery-store';
import type { PeMutationContext } from '../../types';
import { requireZ1, digest, boundedJSON } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { BudgetSchema, developmentOnly, nativeRef, parsed, same, type OriginalBudget, type BudgetInput } from './native-contracts.js';

const integer = (value: string): bigint => {
  requireZ1(/^(?:0|[1-9][0-9]{0,15})$/.test(value), 'Z1_S5_INTEGER_RESOURCE_REQUIRED'); return BigInt(value);
};
export async function currentWorkInputTx(ctx: PeMutationContext, c: PoolClient, workId: string, root: BudgetInput['root']) {
  const work = (await c.query<{ status: WorkStatus }>(
    'SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND created_by=$3 FOR SHARE',
    [ctx.auth.tenantId, workId, principal(ctx)])).rows[0];
  const input = (await c.query<{ id: string; body: { context_snapshot?: { businessRoot?: unknown } } }>(
    'SELECT id::text,to_jsonb(i) body FROM finnor_os.work_inputs i WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
    [ctx.auth.tenantId, workId])).rows[0];
  requireZ1(work && input && !isImmutableWorkStatus(work.status) && input.body.context_snapshot?.businessRoot !== undefined &&
    same(input.body.context_snapshot.businessRoot, root),
    'Z1_CURRENT_ROOTED_OWNED_ORIGINAL_WORK_REQUIRED', 'REVOKED');
  return { inputId: input.id, inputDigest: digest(input.body) };
}
async function referenceTx(ctx: PeMutationContext, c: PoolClient, value: { ref: ExperimentRef }, rightsRef: string) {
  const { ref, ...content } = value;
  requireZ1(same(ref, nativeRef('S5', ref.id.split(':')[0]!, content)), 'Z1_S5_REFERENCE_PREIMAGE_REQUIRED');
  await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: 'S5', tenantId: ctx.auth.tenantId, principalId: principal(ctx) },
    { kind: 'REFERENCE', identity: ref.id, payload: { reference: { ...ref, content }, rightsRefs: [rightsRef] } });
}
const roles = ['logical', 'cpu', 'storage', 'memory'] as const;
type Role = typeof roles[number];
function domain(resource: AllocationResource, role: Role, input: BudgetInput, actor: string) {
  const unit = role === 'logical' ? 'z1-logical-tick' : role === 'cpu' ? 'cpu-microseconds' : 'byte';
  const kind = role === 'memory' ? 'OCCUPANCY' : 'CUMULATIVE_EXPENDITURE';
  requireZ1(resource.resourceClass === 'COMPUTE' && resource.unit === unit && resource.kind === kind &&
    resource.currency === null && resource.ownerRef.id === actor && !resource.revoked && resource.covenants.length === 0 &&
    resource.permittedRoots.some(root => same(root, input.root)) && Date.parse(resource.validUntil) >= Date.parse(input.deadlineAt) &&
    Date.parse(resource.horizon.startAt) <= Date.now() &&
    Date.parse(resource.horizon.startAt) + resource.horizon.periodMs * resource.horizon.periods >= Date.parse(input.deadlineAt),
  'Z1_S5_CURRENT_EXACT_RESOURCE_DOMAIN_REQUIRED', 'REVOKED');
  requireZ1(resource.availability.length === resource.horizon.periods + 1 &&
    resource.existingUse.length === resource.horizon.periods + 1 &&
    resource.availability.every(value => value.amount !== null && /^(?:0|[1-9]\d{0,15})$/.test(value.amount)) &&
    resource.existingUse.every(value => /^(?:0|[1-9]\d{0,15})$/.test(value)) &&
    /^(?:0|[1-9]\d{0,15})$/.test(resource.safetyMargin), 'Z1_S5_EXACT_INTEGER_COMPUTE_CAPACITY_REQUIRED');
}
const amount = (input: BudgetInput, role: Role) => String(role === 'logical' ? input.maximumTicks :
  role === 'cpu' ? input.maximumCpuMicros : role === 'storage' ? input.maximumRetainedBytes : input.maximumMemoryBytes);
export async function reserveOriginalSharedWorkBudget(ctx: PeMutationContext, value: unknown) {
  developmentOnly(); const input = parsed(BudgetSchema, value);
  return withS5PortfolioTransaction(ctx, async c => {
    await authorize(ctx, input.root, [{ type: 'work', id: input.workId }], [], c);
    // One immutable parent for this original Work, including across new request IDs.
    const prior = (await c.query<{ body: OriginalBudget }>(
      `SELECT o.body FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_proposals p
       ON p.tenant_id=o.tenant_id AND p.content_digest=o.allocation_digest
       WHERE o.tenant_id=$1 AND o.principal_id=$2 AND p.problem->>'schema'='finnor.s5.z1-original-work-problem.v1'
       AND p.problem->>'originalWorkId'=$3 LIMIT 2`,
      [ctx.auth.tenantId, principal(ctx), input.workId])).rows;
    requireZ1(prior.length <= 1, 'Z1_S5_ORIGINAL_PARENT_AMBIGUOUS');
    if (prior[0]) {
      requireZ1(same(prior[0].body.original, input), 'Z1_ORIGINAL_PARENT_CANNOT_BE_RENEWED', 'REVOKED');
      return assertBudgetCurrentTx(ctx, c, prior[0].body.ref);
    }
    const cut = await currentWorkInputTx(ctx, c, input.workId, input.root), rights = await employeeAuthoritySnapshotTx(ctx.auth, c);
    requireZ1(Date.parse(input.deadlineAt) > Date.now() && Date.parse(input.deadlineAt) <= Date.now() + 86400000 &&
      new Set(Object.values(input.resources).map(ref => ref.id)).size === roles.length, 'Z1_ORIGINAL_BUDGET_DOMAIN');
    const snapshot = await allocationSnapshotInTransaction(c, ctx.auth.tenantId);
    requireZ1(snapshot.outstanding.length < 256, 'Z1_SHARED_S5_COMMITMENT_BOUND', 'INCOMPLETE');
    const resources: AllocationResource[] = [], envelopes: AllocationEnvelope[] = [], resourceReadDecisionIds: string[] = [];
    for (const role of roles) {
      const resource = snapshot.resources.find(item => same(item.ref, input.resources[role]));
      requireZ1(resource, 'Z1_S5_ORIGINAL_RESOURCE_PREIMAGE_REQUIRED', 'REVOKED');
      const readDecision = await evaluateAuthorityTx(ctx.auth, { operation: 'query', capability: 'query:allocation_resources',
        resource: { type: 'allocation_resource', id: resource.scopeRef.id }, risk: 'low' }, c),
        allowed = readDecision.outcome === 'allowed' && readDecision.reasonCode === 'grant_allows';
      requireZ1(allowed, 'Z1_S5_ORIGINAL_RESOURCE_READ_AUTHORITY_REQUIRED', 'REVOKED');
      resourceReadDecisionIds.push(readDecision.id);
      domain(resource, role, input, principal(ctx));
      for (const pin of resource.beliefPins) requireZ1((await validateBeliefViewPin(ctx, pin)).status === 'CURRENT',
        'Z1_S5_CURRENT_RESOURCE_SOURCE_REQUIRED', 'STALE');
      const requested = integer(amount(input, role));
      for (let period = 0; period <= resource.horizon.periods; period++) {
        const available = resource.availability[period];
        requireZ1(available?.amount !== null && available?.basis === 'REPORTED_AVAILABLE' &&
          resource.existingUse.length === resource.horizon.periods + 1, 'Z1_S5_AVAILABLE_CAPACITY_UNKNOWN', 'INCOMPLETE');
        let used = allocationQuantity('0');
        const indices = role === 'memory' ? [period] : Array.from({ length: period + 1 }, (_, i) => i);
        for (const i of indices) used = used.add(allocationQuantity(resource.existingUse[i]!));
        for (const held of snapshot.outstanding) for (const envelope of held.envelopes.filter(e => e.resourceId === resource.resourceId)) {
          requireZ1(envelope.unit === resource.unit && envelope.kind === resource.kind && same(envelope.horizon, resource.horizon) &&
            envelope.quantities.length === resource.horizon.periods + 1, 'Z1_S5_COMPLETE_SHARED_HORIZON_REQUIRED');
          for (const i of indices) used = used.add(allocationQuantity(envelope.quantities[i]!));
        }
        requireZ1(used.add(allocationQuantity(requested.toString())).compare(
          allocationQuantity(available.amount).sub(allocationQuantity(resource.safetyMargin))) <= 0,
        'Z1_SHARED_S5_RESOURCE_EXHAUSTED', 'INCOMPLETE');
      }
      resources.push(resource);
      envelopes.push({ resourceId: resource.resourceId, unit: resource.unit, kind: resource.kind, horizon: resource.horizon,
        quantities: Array.from({ length: resource.horizon.periods + 1 }, (_, i) => role === 'memory' || i === 0 ? requested.toString() : '0'),
        minimumQuantities: Array.from({ length: resource.horizon.periods + 1 }, () => '0') });
    }
    const allocationDecision = await evaluateAuthorityTx(ctx.auth, { operation: 'action', capability: 'action:allocate_resource',
      resources: allocationPermissionResources(resources), risk: 'high', exactAmountUsd: '0', workId: input.workId,
      controlBinding: { proposalId: input.workId, proposalDigest: digest(input), requestDigest: digest(input),
        dependencyDigest: digest({ cut, resources: input.resources, rights: String(rights.revision) }), expiresAt: input.deadlineAt } }, c);
    requireZ1(allocationDecision.outcome === 'allowed' && allocationDecision.reasonCode === 'grant_allows',
      'Z1_S5_ORIGINAL_ALLOCATION_AUTHORITY_REQUIRED', 'REVOKED');
    const problem = { schema: 'finnor.s5.z1-original-work-problem.v1', originalWorkId: input.workId, original: input,
      input: cut, resources, snapshotDigest: snapshot.snapshotDigest, rightsRevision: String(rights.revision) };
    const certificateBody = { schema: 'finnor.s5.z1-original-work-certificate.v1', tenantId: ctx.auth.tenantId,
      principalId: principal(ctx), rightsRef: String(rights.revision), policyBindings: [], resourceRefs: resources.map(r => r.ref),
      originalWorkId: input.workId, validUntil: input.deadlineAt, check: { envelopes, feasible: true,
        arithmetic: 'EXACT_EVERY_CANONICAL_PREFIX_AND_OCCUPANCY_PERIOD' }, executionAuthorityGranted: false, protectedReceipt: null };
    const certificate = { ...certificateBody, ref: nativeRef('S5', 'z1-original-certificate', certificateBody) };
    const body: Omit<OriginalBudget, 'ref'> = { schema: 'finnor.s5.z1-original-budget.v1', certificateRef: certificate.ref,
      tenantId: ctx.auth.tenantId, principalId: principal(ctx), original: input, ...cut, rightsRevision: String(rights.revision),
      resources, envelopes, authorityDecisionId: allocationDecision.id, resourceReadDecisionIds,
      createdAt: new Date().toISOString(), executionAuthorityGranted: false, protectedReceipt: null };
    const budget: OriginalBudget = { ...body, ref: nativeRef('S5', 'z1-original-budget', body) };
    boundedJSON({ problem, certificate }, 8388608); boundedJSON(budget, 8388608);
    await c.query('SELECT finnor_os.z1_s5_reserve($1::jsonb,$2::jsonb,$3::jsonb,$4)',
      [JSON.stringify(problem), JSON.stringify(certificate), JSON.stringify(budget), digest(input)]);
    await referenceTx(ctx, c, certificate, body.rightsRevision); await referenceTx(ctx, c, budget, body.rightsRevision);
    return budget;
  });
}
export async function assertBudgetCurrentTx(ctx: PeMutationContext, c: PoolClient, ref: ExperimentRef, recovery = false): Promise<OriginalBudget> {
  const row = (await c.query<{ body: OriginalBudget; status: string; envelopes: AllocationEnvelope[]; revocation_reason: string | null }>(
    `SELECT o.body,s.status,s.envelopes,s.revocation_reason FROM finnor_os.s5_reservation_origins o
     JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
     WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.reservation_id=$3 FOR UPDATE OF s`,
    [ctx.auth.tenantId, principal(ctx), ref.id])).rows[0];
  requireZ1(row && row.body.schema === 'finnor.s5.z1-original-budget.v1' && same(row.body.ref, ref), 'Z1_ORIGINAL_S5_BUDGET_REQUIRED', 'REVOKED');
  const { ref: original, ...body } = row.body;
  requireZ1(same(original, nativeRef('S5', 'z1-original-budget', body)) && same(row.envelopes, row.body.envelopes) &&
    row.status !== 'RELEASED', 'Z1_ORIGINAL_S5_PREIMAGE_OR_HOLD_CHANGED', 'REVOKED');
  if (!recovery) {
    requireZ1(!row.revocation_reason && Date.parse(body.original.deadlineAt) > Date.now(), 'Z1_ORIGINAL_S5_BUDGET_EXPIRED', 'REVOKED');
    for (const [i, role] of roles.entries()) {
      const resource = body.resources[i]!;
      const current = (await c.query<{ body: AllocationResource }>(
        `SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
         WHERE r.tenant_id=$1 AND r.resource_id=$2 FOR SHARE OF h`, [ctx.auth.tenantId, resource.resourceId])).rows[0]?.body;
      requireZ1(current && same(current, resource), 'Z1_S5_RESOURCE_REVISION_CHANGED', 'STALE');
      domain(current, role, body.original, principal(ctx));
      for (const pin of current.beliefPins) requireZ1((await validateBeliefViewPin(ctx, pin)).status === 'CURRENT', 'Z1_S5_RESOURCE_SOURCE_CHANGED', 'STALE');
    }
  }
  return row.body;
}
async function pendingCpuTx(ctx: PeMutationContext, c: PoolClient, parent: ExperimentRef, except?: ExperimentRef) {
  const row = (await c.query<{ held: string }>(
    `SELECT coalesce(sum((co.body->>'maximumUnits')::bigint),0)::text held
     FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
     WHERE co.tenant_id=$1 AND co.reservation_id=$2 AND co.body->>'schema'='finnor.s5.z1-compute-hold.v1'
     AND st.status<>'RECONCILED' AND ($3::text IS NULL OR co.consumption_id<>$3)`,
    [ctx.auth.tenantId, parent.id, except?.id ?? null])).rows[0]!;
  return integer(row.held);
}
export async function holdOriginalCpuTx(ctx: PeMutationContext, c: PoolClient, parent: ExperimentRef, key: string, maximumUnits: number) {
  const budget = await assertBudgetCurrentTx(ctx, c, parent);
  requireZ1(Number.isSafeInteger(maximumUnits) && maximumUnits > 0 && maximumUnits <= 120000000, 'Z1_S5_BOUNDED_CPU_HOLD_REQUIRED');
  const chargeKey = `z1-cpu-hold:${digest([parent, key])}`, requestDigest = digest([parent, key, maximumUnits]);
  const prior = (await c.query<{ body: { ref: ExperimentRef }; request_digest: string }>(
    'SELECT body,request_digest FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
    [ctx.auth.tenantId, principal(ctx), chargeKey])).rows[0];
  if (prior) { requireZ1(prior.request_digest === requestDigest, 'Z1_S5_CPU_HOLD_CONFLICT'); return prior.body.ref; }
  const cpu = budget.resources[1]!, used = (await c.query<{ used: string }>(
    'SELECT coalesce(sum(units),0)::text used FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND resource_id=$3',
    [ctx.auth.tenantId, parent.id, cpu.resourceId])).rows[0]!;
  requireZ1(integer(used.used) + await pendingCpuTx(ctx, c, parent) + BigInt(maximumUnits) <= BigInt(budget.original.maximumCpuMicros),
    'Z1_S5_ORIGINAL_PENDING_AND_USED_CPU_EXHAUSTED', 'INCOMPLETE');
  const body = { schema: 'finnor.s5.z1-compute-hold.v1', tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    parentReservationRef: parent, originalWorkId: budget.original.workId, originalDeadline: budget.original.deadlineAt,
    key, maximumUnits, requestDigest, unit: 'cpu-microseconds', effectRef: null, executionAuthorityGranted: false };
  const record = { ...body, ref: nativeRef('S5', 'z1-compute-hold', body) };
  await c.query('SELECT finnor_os.z1_s5_hold_cpu($1::jsonb,$2,$3)', [JSON.stringify(record), chargeKey, requestDigest]);
  await referenceTx(ctx, c, record, budget.rightsRevision);
  return record.ref;
}
/** Integer S5 occupation is conservative. Exact rational allocations remain in
 * the immutable charge preimage; no rounding residual becomes available capacity. */
export async function chargeOriginalBudgetTx(ctx: PeMutationContext, c: PoolClient, ref: ExperimentRef, input: {
  key: string; role: 'logical' | 'cpu' | 'storage'; units: number; exactAllocation: unknown; recovery?: boolean; cpuHold?: ExperimentRef;
}): Promise<ExperimentRef | null> {
  requireZ1(Number.isSafeInteger(input.units) && input.units >= 0 && input.units <= 1000000000, 'Z1_S5_BOUNDED_CHARGE_REQUIRED');
  const budget = await assertBudgetCurrentTx(ctx, c, ref, input.recovery), index = roles.indexOf(input.role), resource = budget.resources[index]!;
  const requestDigest = digest({ parent: ref, ...input }), key = `z1-charge:${digest([ref, input.key, input.role])}`;
  const prior = (await c.query<{ request_digest: string; body: { ref: ExperimentRef } }>(
    'SELECT request_digest,body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
    [ctx.auth.tenantId, principal(ctx), key])).rows[0];
  if (prior) { requireZ1(prior.request_digest === requestDigest, 'Z1_S5_CHARGE_IDEMPOTENCY_CONFLICT'); return prior.body.ref; }
  const used = (await c.query<{ used: string }>(
    'SELECT coalesce(sum(units),0)::text used FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND resource_id=$3',
    [ctx.auth.tenantId, ref.id, resource.resourceId])).rows[0]!;
  if (input.cpuHold) {
    const hold = (await c.query<{ body: { ref: ExperimentRef; maximumUnits: number } }>(
      `SELECT co.body FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
       WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.reservation_id=$3 AND co.consumption_id=$4
       AND st.status='INTENDED_PENDING_S6' AND co.body->>'schema'='finnor.s5.z1-compute-hold.v1' FOR UPDATE OF st`,
      [ctx.auth.tenantId, principal(ctx), ref.id, input.cpuHold.id])).rows[0]?.body;
    requireZ1(input.role === 'cpu' && hold && same(hold.ref, input.cpuHold) && input.units <= hold.maximumUnits,
      'Z1_EXACT_OWNED_CPU_HOLD_REQUIRED', 'INCOMPLETE');
  }
  const pending = input.role === 'cpu' ? await pendingCpuTx(ctx, c, ref, input.cpuHold) : 0n;
  requireZ1(integer(used.used) + pending + BigInt(input.units) <= integer(amount(budget.original, input.role)),
    'Z1_ORIGINAL_S5_REMAINING_BUDGET_EXHAUSTED', 'INCOMPLETE');
  const body = { schema: 'finnor.s5.z1-original-consumption.v1', tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    reservationRef: ref, originalWorkId: budget.original.workId, originalDeadline: budget.original.deadlineAt,
    chargeKey: key, requestDigest, role: input.role, units: input.units, exactAllocation: input.exactAllocation,
    rounding: 'S5_INTEGER_OCCUPATION_ROUNDED_UP_WITH_RESIDUAL_RETAINED_NOT_MONEY', resourceRef: resource.ref,
    status: 'INTENDED_PENDING_S6', effectRef: null, protectedReceipt: null, executionAuthorityGranted: false };
  const consumption = { ...body, ref: nativeRef('S5', 'z1-original-consumption', body) };
  boundedJSON(consumption, 8388608);
  await c.query('SELECT finnor_os.z1_s5_charge($1::jsonb,$2,$3,$4::jsonb,$5)',
    [JSON.stringify(consumption), key, `${input.key}:${input.role}`, input.cpuHold ? JSON.stringify(input.cpuHold) : null,
      input.recovery ?? false]);
  await referenceTx(ctx, c, consumption, budget.rightsRevision);
  return consumption.ref;
}
/** Every native write is metered by the proposed SQL triggers. Settle its full
 * cumulative JSON-write occupation, not only the producer's serialized result.
 * S5/S7 transport, WAL/index/compaction and meter-tail costs remain explicit gaps. */
export async function settleNativeStorageTx(ctx: PeMutationContext, c: PoolClient) {
  const rows = (await c.query<{ id: string; retained_bytes: string; storage_charged_bytes: string;
    cuts: Array<{ workId: string; parent: ExperimentRef }> }>(
    `SELECT id,retained_bytes::text,storage_charged_bytes::text,cuts FROM finnor_os.z1_requests
     WHERE tenant_id=$1 AND principal_id=$2 AND retained_bytes>storage_charged_bytes ORDER BY id LIMIT 257 FOR UPDATE`,
    [ctx.auth.tenantId, principal(ctx)])).rows;
  requireZ1(rows.length <= 256, 'Z1_ORIGINAL_STORAGE_EPISODE_BOUND', 'INCOMPLETE');
  for (const row of rows) {
    const before = integer(row.storage_charged_bytes), after = integer(row.retained_bytes), n = BigInt(row.cuts.length);
    requireZ1(n >= 2n && after >= before, 'Z1_ORIGINAL_STORAGE_ALLOCATION_REQUIRED');
    const units = Number((after + n - 1n) / n - (before + n - 1n) / n);
    for (const cut of row.cuts) await chargeOriginalBudgetTx(ctx, c, cut.parent, {
      key: `native-json:${row.id}:${after}`, role: 'storage', units, recovery: true,
      exactAllocation: { requestId: row.id, fromBytes: before.toString(), toBytes: after.toString(),
        exactIncrementPerOriginal: `${after - before}/${n}`, scope: 'ALL_NATIVE_Z1_CANONICAL_JSON_WRITES_INCLUDING_REPEATED_PREIMAGES',
        originalWorkCount: row.cuts.length, originalRetentionResponsibilitySurvivesWithdrawal: true,
        s5s7TransportWalIndicesCompactionBillingAndMeterTail: 'UNKNOWN_NOT_ZERO' } });
    await c.query(`UPDATE finnor_os.z1_requests SET storage_charged_bytes=$4
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [ctx.auth.tenantId, principal(ctx), row.id, after.toString()]);
  }
}
export function withNativeTransaction<T>(ctx: PeMutationContext, invoke: (c: PoolClient) => Promise<T>) {
  return withS5PortfolioTransaction(ctx, async c => {
    const result = await invoke(c); await settleNativeStorageTx(ctx, c); return result;
  });
}
