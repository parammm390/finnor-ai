import type { PoolClient } from 'pg';
import type { AllocationConsumption, AllocationEnvelope, AllocationOutstandingCommitment, AllocationResource, AllocationReservation, ExperimentRef } from '@finnor/shared-types';
import type { ElicitationProtocol } from '../../../shared-types/src/elicitation-protocol';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { R3Rational as Q, R3_ZERO as Z, r3Quantity as q, r3FromDecimal, readR3LedgerQuantity, r3LedgerQuantity } from '../../../epistemic-runtime/src/incentive-rule-synthesis/exact';
import { allocationRef } from '../../../epistemic-runtime/src/allocation-contracts';
import { readAllocationSnapshot } from '../allocation-store';
import { tx, principal, unavailable } from '../evidence-execution/store';
import type { PeMutationContext } from '../types';
import { assertR3Current } from './owners';
import { r3Authorize, r3Event, r3Object, r3Protocol, r3Ref, r3Request, type R3RequestRow } from './store';
import { enqueueOwnerDeliveryInTransaction } from '../../../governed-execution/src/owner-delivery-store';
import { nativeReference } from '../native-experience-transport';

const VERSION = 's5-r3-contingent-v1';
const decode = (s: string) => s.startsWith('r3q:') ? readR3LedgerQuantity(s) : r3FromDecimal(s);
const sum = (a: Q[]) => a.reduce((v, q) => v.add(q), Z);
const usage = (kind: string, values: Q[], t: number) => ['STOCK', 'CUMULATIVE_EXPENDITURE'].includes(kind) ? sum(values.slice(0, t + 1)) : values[t]!;
const max = (a: Q, b: Q) => a.compare(b) >= 0 ? a : b, min = (a: Q, b: Q) => a.compare(b) <= 0 ? a : b;
export function checkR3CurrentDemand(protocol: ElicitationProtocol, resources: AllocationResource[], outstanding: AllocationOutstandingCommitment[], row: R3RequestRow) {
  if (!protocol.check.accepted || protocol.check.inputDigest !== r3Digest(row.problem) || protocol.check.ruleDigest !== r3Digest(protocol.rule))
    throw Error('R3_S5_ORIGINAL_CHECKED_RULE_REQUIRED');
  const p = protocol.problem, h = row.binding.mandate.horizon.periods;
  if (!resources.length || resources.length !== p.resources.length || resources.some(r => r.revoked ||
    r.availability.some(v => v.amount === null || v.basis !== 'REPORTED_AVAILABLE') || r.rightsRef !== p.binding.rightsRef ||
    r.ownerRef.id !== row.principal_id || r3Digest(r.horizon) !== r3Digest(row.binding.mandate.horizon)))
    throw Error('R3_S5_CURRENT_RESOURCE_UNKNOWN_OR_SEMANTIC_GAP');
  const reasons: string[] = [], paths = new Map<string, Q[][]>(), upper = new Map<string, Q[]>(), lower = new Map<string, Q[]>();
  for (const r of resources) {
    const base = r.existingUse.map(decode), least = r.existingUse.map(decode);
    for (const commitment of outstanding) {
      if (commitment.policyRefs.some(ref => ref.id === row.use_policy_ref?.id)) reasons.push('R3_POLICY_ALREADY_COMMITTED');
      for (const e of commitment.envelopes.filter(e => e.resourceId === r.resourceId)) {
        if (e.unit !== r.unit || e.kind !== r.kind || r3Digest(e.horizon) !== r3Digest(r.horizon) || e.quantities.length !== h + 1 ||
          e.minimumQuantities.length !== h + 1) throw Error('R3_S5_UNKNOWN_OUTSTANDING_ENVELOPE_REQUIRED');
        for (let t = 0; t <= h; t++) { base[t] = base[t]!.add(decode(e.quantities[t]!)); least[t] = least[t]!.add(decode(e.minimumQuantities[t]!)) }
      }
    }
    upper.set(r.resourceId, base); lower.set(r.resourceId, least); paths.set(r.resourceId, []);
  }
  // Reconstruct every branch from ORIGINAL schedules, never backend/receipt rows.
  for (const branch of protocol.rule.table) {
    const outcome = p.outcomes.find(o => o.id === branch.outcomeId); if (!outcome) throw Error('R3_S5_ORIGINAL_OUTCOME_REQUIRED');
    const raw = new Map(resources.map(r => {
      const original = outcome.demands[r.resourceId]; if (!original || original.length !== h + 1) throw Error('R3_S5_COMPLETE_CONTINGENT_DEMAND_REQUIRED');
      return [r.resourceId, original.map(q)] as const;
    }));
    const cash = raw.get(p.constraints.cashResourceId); if (!cash) throw Error('R3_S5_EXPLICIT_CASH_FUNDING_REQUIRED');
    for (let t = 0; t <= h; t++) cash[t] = cash[t]!.add(q(outcome.costs[t])).add(q(outcome.liabilities[t]));
    for (const promised of branch.schedule) {
      const date = p.dates.find(d => d.id === promised.dateId);
      if (!date || date.at !== promised.dueAt || promised.currency !== p.money.currency || promised.unit !== p.money.unit)
        throw Error('R3_S5_EXACT_MONEY_EVENT_MEANING_REQUIRED');
      const amount = q(promised.amount);
      if (amount.n > 0n) cash[date.period] = cash[date.period]!.add(amount);
    }
    for (const r of resources) {
      const values = raw.get(r.resourceId)!; paths.get(r.resourceId)!.push(values);
      for (let t = 0; t <= h; t++) {
        const total = values.map((v, i) => v.add(upper.get(r.resourceId)![i]!));
        const maximum = decode(r.availability[t]!.amount!).sub(decode(r.safetyMargin));
        if (usage(r.kind, total, t).compare(maximum) > 0) reasons.push(`HARD_RESOURCE:${r.resourceId}:${JSON.stringify(branch.reports)}:${t}`);
      }
      const dimension = row.binding.mandate.resources.dimensions.find(d => d.id === r.resourceId && d.unit === r.unit && d.resourceClass === r.resourceClass);
      if (!dimension && values.some(v => v.n !== 0n)) reasons.push(`S4_UNAUTHORIZED_RESOURCE:${r.resourceId}`);
      if (dimension) {
        if (sum(values).compare(r3FromDecimal(String(dimension.totalLimit))) > 0 ||
          values.some(v => v.compare(r3FromDecimal(String(dimension.capacity))) > 0)) reasons.push(`S4_ORIGINAL_ENVELOPE:${dimension.id}`);
      }
    }
    const covenants = new Map(resources.flatMap(r => r.covenants).map(c => [c.id, c]));
    for (const c of covenants.values()) for (const t of c.periods) {
      let used = Z;
      for (const term of c.terms) {
        const r = resources.find(r => r.resourceId === term.resourceId); if (!r) throw Error('R3_S5_COVENANT_RESOURCE_REQUIRED');
        const coefficient = decode(term.coefficient), base = coefficient.n < 0n ? lower : upper;
        used = used.add(coefficient.mul(usage(r.kind, raw.get(r.resourceId)!.map((v, i) => v.add(base.get(r.resourceId)![i]!)), t)));
      }
      if (used.compare(decode(c.maximum).sub(decode(c.safetyMargin))) > 0) reasons.push(`HARD_COVENANT:${c.id}:${t}`);
    }
    for (const c of row.binding.mandate.resources.couplings) for (let t = 0; t <= h; t++) {
      const used = Object.entries(c.weights).reduce((v, [id, coefficient]) => {
        const amounts = raw.get(id); if (!amounts) throw Error('R3_S4_COUPLING_RESOURCE_REQUIRED');
        return v.add(r3FromDecimal(String(coefficient)).mul(amounts[t]!));
      }, Z);
      if (used.compare(r3FromDecimal(String(c.maxPerPeriod))) > 0) reasons.push(`S4_ORIGINAL_COUPLING:${c.id}:${t}`);
    }
  }
  const envelopes: AllocationEnvelope[] = resources.map(r => {
    const current = paths.get(r.resourceId)!, maxima: Q[] = [], minima: Q[] = [];
    for (let t = 0; t <= h; t++) { const values = current.map(v => usage(r.kind, v, t)); maxima.push(values.reduce(max)); minima.push(values.reduce(min)) }
    const raw = (v: Q[]) => ['STOCK', 'CUMULATIVE_EXPENDITURE'].includes(r.kind) ? v.map((q, t) => t ? q.sub(v[t - 1]!) : q) : v;
    return { resourceId: r.resourceId, unit: r.unit, kind: r.kind, horizon: r.horizon,
      quantities: raw(maxima).map(r3LedgerQuantity), minimumQuantities: raw(minima).map(r3LedgerQuantity) };
  });
  return { schema: 'finnor.s5.r3-contingent-check.v1', feasible: reasons.length === 0, reasons, envelopes,
    profilesChecked: protocol.rule.table.length, protocolRef: protocol.ref, quantityEncoding: 'R3_EXACT_RATIONAL_LEDGER_V1',
    contingentSemantics: 'ONE_COMPONENTWISE_SOUND_PREFIX_ENVELOPE_NOT_81_SIMULTANEOUS_BRANCHES',
    promisedIncomingFundingCounted: false, executionAuthorityGranted: false };
}
async function enqueue(ctx: PeMutationContext, c: PoolClient, ref: ExperimentRef, content: unknown, rightsRef: string) {
  const reference = nativeReference('S5', ref.id, content, ref.version);
  if (reference.contentDigest !== ref.contentDigest) throw Error('R3_S5_NATIVE_ORIGIN_ENCODING_MISMATCH');
  await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: 'S5', tenantId: ctx.auth.tenantId, principalId: principal(ctx) },
    { kind: 'REFERENCE', identity: ref.id, payload: { reference, rightsRefs: [rightsRef] } });
}
export async function clearR3Portfolio(ctx: PeMutationContext, row: R3RequestRow, idempotencyKey: string) {
  if (!row.use_policy_ref || !row.protocol_ref) throw Error('R3_S4_CHECKED_USE_POLICY_REQUIRED');
  await assertR3Current(ctx, row, undefined, false, true);
  const protocol = await r3Protocol(ctx, row), snapshot = await readAllocationSnapshot(ctx);
  const check = checkR3CurrentDemand(protocol, snapshot.resources, snapshot.outstanding, row);
  if (!check.feasible) return { status: 'INFEASIBLE_CURRENT_RESOURCES', ...check, certificate: null, reservation: null };
  return tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['s5-portfolio:' + row.tenant_id]);
    await r3Authorize(ctx, c);
    const locked = await r3Request(ctx, row.id, c, true);
    if (locked.allocation_ref) return readR3Allocation(ctx, locked.allocation_ref, c);
    const current = await snapshotInTransaction(c, ctx.auth.tenantId);
    if (current.snapshotDigest !== snapshot.snapshotDigest) throw Error('R3_S5_CONTINGENT_COMMIT_PUBLICATION_FENCED');
    await assertR3Current(ctx, locked, c, true, true);
    const final = checkR3CurrentDemand(protocol, current.resources, current.outstanding, locked);
    if (!final.feasible || r3Digest(final) !== r3Digest(check)) throw Error('R3_S5_CURRENT_ORIGINAL_CHECK_REJECTED');
    const problem = { schema: 'finnor.s5.r3-allocation-problem.v1', tenantId: row.tenant_id, principalId: row.principal_id,
      episodeId: row.id, mandate: row.binding.mandate, protocolRef: protocol.ref, protocol,
      policies: [{ ref: row.use_policy_ref }], resources: current.resources, outstanding: current.outstanding, snapshotDigest: current.snapshotDigest };
    const body = { schema: 'finnor.s5.r3-allocation-certificate.v1', semanticOwner: 'S5', version: VERSION,
      tenantId: row.tenant_id, principalId: row.principal_id, requestId: row.id, mandateRef: row.problem.binding.mandateRef,
      rightsRef: row.problem.binding.rightsRef, policyBindings: [{ policyRef: row.use_policy_ref, demandDigest: r3Digest(protocol.rule) }],
      protocolRef: protocol.ref, snapshotDigest: current.snapshotDigest, validUntil: row.binding.validUntil, check: final,
      optimization: 'NOT_A_PORTFOLIO_OPTIMUM_CLAIM', admission: null, executionAuthorityGranted: false };
    const ref = r3Ref('S5', 'r3-allocation-certificate', body, VERSION), certificate = { ...body, ref }, requestDigest = r3Digest({ protocolRef: protocol.ref, usePolicyRef: row.use_policy_ref, idempotencyKey });
    const reservationBody: Omit<AllocationReservation, 'ref'> = { schema: 'finnor.allocation-reservation.v1', certificateRef: ref,
      tenantId: row.tenant_id, principalId: row.principal_id, idempotencyKey, requestDigest, createdAt: new Date().toISOString(),
      envelopes: final.envelopes, status: 'RESERVED', revocationReason: null, revision: 1, executionAuthorityGranted: false, protectedReceipt: null };
    const reservation = { ...reservationBody, ref: allocationRef('S5', 'allocation-reservation', reservationBody) };
    await c.query('INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',
      [row.tenant_id, row.principal_id, ref.contentDigest, JSON.stringify(problem), JSON.stringify(certificate)]);
    await c.query('INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5)',
      [row.tenant_id, row.principal_id, idempotencyKey, requestDigest, ref.contentDigest]);
    await c.query('INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',
      [row.tenant_id, row.principal_id, reservation.ref.id, ref.contentDigest, JSON.stringify(reservation)]);
    await c.query("INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes) VALUES($1,$2,$3,1,'RESERVED',$4::jsonb)",
      [row.tenant_id, reservation.ref.id, ref.contentDigest, JSON.stringify(final.envelopes)]);
    await c.query('UPDATE finnor_os.r3_requests SET allocation_ref=$3::jsonb WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.id, JSON.stringify(ref)]);
    await enqueue(ctx, c, ref, body, row.problem.binding.rightsRef);
    await enqueue(ctx, c, reservation.ref, reservationBody, row.problem.binding.rightsRef);
    await r3Event(ctx, locked, 'S5_CONTINGENT_RESERVED', { allocationRef: ref, reservationRef: reservation.ref, check: final, noIncomingPromiseFunding: true }, c);
    return { status: 'FEASIBLE', certificate, reservation, executionAuthorityGranted: false };
  });
}
/** Same canonical ledger snapshot shape, obtained after the existing S5 lock. */
async function snapshotInTransaction(c: PoolClient, tenant: string) {
  const resources = (await c.query('SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 ORDER BY r.resource_id LIMIT 17', [tenant])).rows.map(v => v.body as AllocationResource);
  const live = (await c.query("SELECT s.status,s.envelopes,o.body,p.certificate FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id) JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest WHERE s.tenant_id=$1 AND s.status<>'RELEASED' ORDER BY s.reservation_id LIMIT 257", [tenant])).rows;
  if (resources.length > 16 || live.length > 256) throw Error('R3_CANONICAL_S5_SNAPSHOT_BOUND');
  const outstanding: AllocationOutstandingCommitment[] = [];
  for (const r of live) {
    const effects = (await c.query('SELECT st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.reservation_id=$2 AND st.effect_ref IS NOT NULL', [tenant, r.body.ref.id])).rows.map(v => v.effect_ref);
    outstanding.push({ reservationRef: r.body.ref, certificateRef: r.body.certificateRef, envelopes: r.envelopes,
      status: r.status, policyRefs: r.certificate.policyBindings.map((b: { policyRef: ExperimentRef }) => b.policyRef), effectRefs: effects });
  }
  // Legacy snapshot uses epistemicHash, whose encoding is retained.
  const { epistemicHash } = await import('../../../epistemic-runtime/src/source-precedence');
  return { resources, outstanding, snapshotDigest: epistemicHash({ resources, outstanding }) };
}
export async function readR3Allocation(ctx: PeMutationContext, ref: ExperimentRef, c?: PoolClient): Promise<any> {
  const read = async (client: PoolClient) => {
    await r3Authorize(ctx, client, Boolean(c));
    const origin = (await client.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',
      [ctx.auth.tenantId, principal(ctx), ref.contentDigest])).rows[0];
    if (ref.version !== VERSION || !origin || r3Digest(origin.certificate.ref) !== r3Digest(ref)) throw unavailable();
    const { ref: _ref, ...body } = origin.certificate;
    if (r3Digest(body) !== ref.contentDigest) throw Error('R3_S5_IMMUTABLE_CERTIFICATE_BINDING');
    const projection = (await client.query('SELECT o.body,s.status,s.revision,s.envelopes,s.revocation_reason FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id) WHERE o.tenant_id=$1 AND o.allocation_digest=$2',
      [ctx.auth.tenantId, ref.contentDigest])).rows[0];
    if (!projection) throw Error('R3_CANONICAL_S5_DURABLE_RESERVATION_REQUIRED');
    const reservation = { ...projection.body, status: projection.status, revision: projection.revision, envelopes: projection.envelopes, revocationReason: projection.revocation_reason };
    return { status: 'FEASIBLE', ...origin, reservation, executionAuthorityGranted: false };
  }; return c ? read(c) : tx(ctx, read, true);
}
export async function validateR3Allocation(ctx: PeMutationContext, ref: ExperimentRef) {
  const issued = await readR3Allocation(ctx, ref), row = await r3Request(ctx, issued.certificate.requestId);
  const reasons: string[] = [];
  try { await assertR3Current(ctx, row, undefined, false, true) } catch (error) { reasons.push(error instanceof Error ? error.message : 'R3_OWNER_CHANGED') }
  if (issued.reservation.revocationReason || issued.reservation.status === 'RELEASED' || Date.now() >= Date.parse(issued.certificate.validUntil))
    reasons.push('R3_S5_RESERVATION_REVOKED_OR_EXPIRED');
  const snapshot = await readAllocationSnapshot(ctx), protocol = await r3Protocol(ctx, row);
  try {
    const checked = checkR3CurrentDemand(protocol, snapshot.resources, snapshot.outstanding.filter(o => o.reservationRef.id !== issued.reservation.ref.id), row);
    if (!checked.feasible || r3Digest(checked.envelopes) !== r3Digest(issued.reservation.envelopes)) reasons.push(...checked.reasons, 'R3_CURRENT_CONTINGENT_ENVELOPE_CHANGED');
  } catch (error) { reasons.push(error instanceof Error ? error.message : 'R3_CURRENT_S5_CHECK_UNAVAILABLE') }
  return { status: reasons.length ? 'STALE_INPUT' as const : 'CURRENT' as const, reasons, allocationRef: ref, reservationRef: issued.reservation.ref,
    conditionalClearance:!reasons.length, protectedReceipt:null, executionAuthorityGranted: false as const, responsibilityRetained: true };
}
export async function consumeR3Allocation(ctx:PeMutationContext,row:R3RequestRow,idempotencyKey:string) {
  if(!row.use_policy_ref||!row.allocation_ref)throw Error('R3_ACTUAL_S4_S5_CONSUMPTION_REQUIRED');
  const {chooseEnterpriseControlBranch}=await import('../enterprise-control');
  const choice=await chooseEnterpriseControlBranch(ctx,{schema:'finnor.s4.r3-choice-request.v1',policyRef:row.use_policy_ref});
  if(choice.status!=='PROPOSED_CHECKED_MODEL_RELATIVE'||!choice.row||!('ref' in choice))
    return {status:choice.status,choice,consumption:null,executionAuthorityGranted:false};
  const issued=await readR3Allocation(ctx,row.allocation_ref),requestDigest=r3Digest({operation:'R3_EXACT_CONSUMPTION',allocationRef:row.allocation_ref,
    policyRef:row.use_policy_ref,choiceRef:choice.ref,idempotencyKey});
  return tx(ctx,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+row.tenant_id]);
    const locked=await r3Request(ctx,row.id,c,true);await assertR3Current(ctx,locked,c,true,true);
    const previous=(await c.query('SELECT body,request_digest FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [row.tenant_id,row.principal_id,idempotencyKey])).rows[0];
    if(previous){if(previous.request_digest!==requestDigest)throw Error('R3_S5_CONSUMPTION_IDEMPOTENCY_CONFLICT');return {status:'INTENDED_PENDING_S6',choice,consumption:previous.body,semanticReplay:true,executionAuthorityGranted:false};}
    const other=(await c.query('SELECT consumption_id FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND reservation_id=$2 LIMIT 1',
      [row.tenant_id,issued.reservation.ref.id])).rows[0];
    if(other)throw Error('R3_S5_REPORT_RULE_ALREADY_INTENDED_PENDING_S6');
    const live=(await c.query("SELECT status,revocation_reason,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR UPDATE",
      [row.tenant_id,issued.reservation.ref.id])).rows[0];
    if(!live||live.revocation_reason||live.status!=='RESERVED')throw Error('R3_CURRENT_UNTOUCHED_S5_RESERVATION_REQUIRED');
    const snapshot=await snapshotInTransaction(c,row.tenant_id),protocol=await r3Protocol(ctx,locked,c);
    const current=checkR3CurrentDemand(protocol,snapshot.resources,snapshot.outstanding.filter(o=>o.reservationRef.id!==issued.reservation.ref.id),locked);
    if(!current.feasible||r3Digest(current.envelopes)!==r3Digest(live.envelopes))throw Error('R3_S5_CONSUMPTION_CURRENT_RESOURCE_FENCE');
    const body:Omit<AllocationConsumption,'ref'>={schema:'finnor.allocation-consumption.v1',reservationRef:issued.reservation.ref,
      certificateRef:row.allocation_ref!,policyRef:row.use_policy_ref!,demandDigest:r3Digest(protocol.rule),
      nodeId:'r3-report-profile:'+r3Digest(choice.row.reports),decisionRef:choice.ref!,idempotencyKey,requestDigest,
      createdAt:new Date().toISOString(),status:'INTENDED_PENDING_S6',compatibleScenarioIds:['r3-profile:'+r3Digest(choice.row.reports)],
      effectRef:null,envelope:live.envelopes,executionAuthorityGranted:false,protectedReceipt:null};
    const consumption={...body,ref:allocationRef('S5','allocation-consumption',body)};
    await c.query('INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [row.tenant_id,row.principal_id,consumption.ref.id,issued.reservation.ref.id,row.use_policy_ref!.id,body.nodeId,idempotencyKey,requestDigest,JSON.stringify(consumption)]);
    await c.query("INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision) VALUES($1,$2,'INTENDED_PENDING_S6',1)",
      [row.tenant_id,consumption.ref.id]);
    await c.query("UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
      [row.tenant_id,issued.reservation.ref.id]);
    await enqueue(ctx,c,consumption.ref,body,row.problem.binding.rightsRef);
    await r3Event(ctx,locked,'S5_RULE_USE_INTENDED_PENDING_S6',{consumptionRef:consumption.ref,choiceRef:choice.ref,
      exactOriginalSchedule:choice.row.schedule,fullContingentEnvelopeRetained:true,agreementEstablished:false,settlementEstablished:false},c);
    return {status:'INTENDED_PENDING_S6',choice,consumption,semanticReplay:false,executionAuthorityGranted:false};
  });
}
