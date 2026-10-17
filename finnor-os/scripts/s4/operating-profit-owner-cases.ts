/** Permitted S1 -> S3 -> S4 -> owner replay -> S5 cash funding. The revenue
 * hurdle must reject the small intervention before accepting a stronger one
 * under the SAME revenue charter. Retain both requests/results and replay.
 * Generated price/volume history only; this is not measured customer profit. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createMetricSeries, attachCanonicalEvidenceToWorld, type PeMutationContext } from '@finnor/private-equity';
import { createEvidenceSource } from '@finnor/memory';
import { profitInput, profitRef, sealProfitMandate } from './operating-profit-fixtures';
import { POST as allocationPost } from '../../apps/api/app/api/allocations/[operation]/route';
import { receiveWork } from '@finnor/db';
import { proposeEnterpriseSameDealAlternatives } from '../../packages/private-equity/src/allocation-proposal';

export async function operatingProfitOwnerCase(input: {
  admin: { query: (sql: string, values?: any[]) => Promise<any> }; ctx: PeMutationContext;
  api: (...args: any[]) => Promise<any>; s3Post: unknown; request: any; rows: any[];
}) {
  const { admin, ctx, api, s3Post, rows } = input, tenant = ctx.auth.tenantId, principal = ctx.auth.employeeId ?? ctx.auth.userId;
  const root = { entityType: 'external_organization' as const, entityId: randomUUID() };
  await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Generated operating-profit company','other')", [root.entityId, tenant, `s4-profit-${root.entityId}`]);
  const source = (await createEvidenceSource(tenant, { sourceKey: `s4-profit:${randomUUID()}`, sourceType: 'pe_document_claim', title: 'Generated operating driver history' })).id;
  const version = randomUUID(), request = structuredClone(input.request), series: Record<string, string> = {};
  await admin.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,1,$4,'Generated operating history',$5::jsonb,$6,clock_timestamp(),clock_timestamp())", [version, source, tenant, profitRef('generated-operating-data').contentDigest, JSON.stringify({ worldRoot: root, claims: [{ propositionId: 'generated-operating-law', predicate: 'reported', value: 'Generated law, no field identification' }] }), request.time.startAt]);
  const units = { price: 'USD/item', volume: 'item', exposure: 'fraction' };
  for (const id of ['price', 'volume', 'exposure'] as const) {
    const metric = await createMetricSeries(ctx, { subjectType: 'external_organization', subjectId: root.entityId,
      metricKey: `s4-profit-${id}`, name: id, unit: units[id], frequency: 'daily' });
    series[id] = String(metric.row.id);
    await attachCanonicalEvidenceToWorld(ctx, { worldRoot: root, entity: { entityType: 'pe_metric_series', entityId: series[id]! }, evidenceSourceId: source, evidenceVersionId: version, relationship: 'supports' });
    for (const row of rows) {
      const exposure = row.exposures.price, noise = .001 * (row.states.outcome - exposure), at = Date.parse(request.time.startAt) + row.period * request.time.periodMs;
      const value = id === 'price' ? 10 + 2 * exposure + noise : id === 'volume' ? 100 - 10 * exposure + noise : exposure;
      await admin.query("INSERT INTO finnor_os.pe_metric_observations(id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,created_by) VALUES($1,$2,$3,$4,$5,'number',$6,$7,$8,'s4:generated-operating-profit',$9)", [randomUUID(), tenant, series[id], new Date(at).toISOString(), new Date(at + request.time.periodMs).toISOString(), String(value), source, version, principal]);
    }
  }
  request.modelKey = 'generated-operating-profit'; request.episodeId = 's4-operating-profit'; request.roots = [root];
  request.stateVariables = ['price', 'volume'].map(id => ({ id: id === 'price' ? 'netPrice' : id, root, seriesId: series[id], unit: units[id as 'price' | 'volume'], range: [0, id === 'price' ? 100 : 1000], role: 'ENTERPRISE_STATE' }));
  request.exposures[0].root = root; request.exposures[0].seriesId = series.exposure;
  request.mechanisms = [request.mechanisms[0]];
  request.mechanisms[0].equations = ['netPrice', 'volume'].map(variableId => ({ variableId, features: [{ kind: 'CONSTANT' }, { kind: 'EXPOSURE', id: 'price', lag: 0 }] }));
  request.mechanisms[0].counterparties = [];
  const fit = await api('fit', { request }, tenant, principal, s3Post);
  assert.equal(fit.status, 200, JSON.stringify(fit)); assert.equal(fit.body.status, 'FITTED', JSON.stringify(fit));
  const fixture = profitInput({ periods: 2, actions: ['smart'] }), m = fixture.mandate, p = fixture.problem;
  m.tenantId = tenant; m.principalId = principal; m.businessOwnerRef = profitRef(principal); m.episodeId = request.episodeId;
  m.horizon = { startAt: request.time.endAt, periodMs: request.time.periodMs, periods: 2 };
  m.utility.operatingProfit.root = root; m.utility.operatingProfit.segments[0].unitsSold.variableId = 'volume';
  m.utility.operatingProfit.segments[0].netUnitPrice.variableId = 'netPrice';
  m.utility.operatingProfit.accountsReceivable = { kind: 'CONSTANT', value: 100, unit: 'USD', sourceRef: profitRef('generated-receivables') };
  m.utility.operatingProfit.nonOperatingCashOutflow = { kind: 'CONSTANT', value: 300, unit: 'USD', sourceRef: profitRef('generated-mandatory-debt-payments') };
  m.utility.operatingProfit.objective = 'INCREMENTAL_NET_PROFIT';
  const constant = (value: number, name: string) => ({ kind: 'CONSTANT', value, unit: 'USD', sourceRef: profitRef(name) });
  m.utility.operatingProfit.netProfit = { schema: 'finnor.s4.net-profit-accounting.v1',
    financingExpense: constant(20, 'generated-interest-already-in-debt-cash-payments'),
    incomeTaxExpense: constant(30, 'generated-accrued-tax-no-payment-during-horizon'),
    otherIncome: constant(0, 'generated-no-other-income'), otherExpense: constant(0, 'generated-no-other-expense'),
    cashTreatment: 'ACCRUAL_PNL_SEPARATE_EXPLICIT_CASH_DRIVERS' };
  m.utility.operatingProfit.profitTarget = { schema: 'finnor.s4.revenue-profit-target.v1', minimumBasisPoints: 1000,
    basis: 'INCREMENTAL_NET_PROFIT_LESS_ADDITIONAL_TERMINAL_LIABILITY', denominator: 'FIXED_PREREGISTERED_REVENUE',
    revenueBaseline: { amount: 2000, unit: 'USD', root, horizon: structuredClone(m.horizon), sourceRef: profitRef('generated-fixed-two-period-revenue-charter') },
    qualification: 'OWNER_BASELINE_ASSERTION_NOT_VERIFIED_REVENUE' };
  const mandate = sealProfitMandate(m);
  p.episodeId = m.episodeId; p.modelRef = fit.body.model.ref; p.context = 'public-price'; p.regime = 'operating';
  p.baselineExposures = { price: [0, 0] };
  for (const a of p.actions) if (a.kind === 'INTERVENE') a.exposures = { price: [.75, .75] };
  const payload = { mandate, problem: p, protocols: [], scenarios: { pathsPerMechanism: 4, seed: 20261017 } };
  const belowTargetPayload = structuredClone(payload);
  for (const a of belowTargetPayload.problem.actions) if (a.kind === 'INTERVENE') a.exposures = { price: [.15, .15] };
  const belowTarget = await api('synthesize', belowTargetPayload);
  assert.equal(belowTarget.status, 200, JSON.stringify(belowTarget)); assert.equal(belowTarget.body.status, 'INFEASIBLE', JSON.stringify(belowTarget));
  assert.equal(belowTarget.body.policy, null);
  assert.equal(belowTarget.body.profitTargetAssessment.status, 'TARGET_UNATTAINABLE_IN_ENUMERATED_MODEL');
  assert.equal(belowTarget.body.profitTargetAssessment.requiredIncrementalProfit.numerator, '200');
  assert(Number(belowTarget.body.profitTargetAssessment.shortfall.display) > 150);
  const result = await api('synthesize', payload);
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.status, 'POLICY_AVAILABLE', JSON.stringify(result));
  const policy = result.body.policy;
  assert.equal(policy.nodes.find((n: any) => n.id === policy.rootNodeId).actionId, 'smart'); assert(policy.certificate.valueBounds[0] > 0);
  assert.equal(policy.certificate.operatingProfit.qualification, 'MODEL_CONDITIONAL_NOT_REALIZED_OR_GUARANTEED');
  assert.equal(policy.certificate.operatingProfit.measure, 'NET_PROFIT_AFTER_FINANCING_AND_INCOME_TAX');
  assert.deepEqual(result.body.profitTargetAssessment.target, belowTarget.body.profitTargetAssessment.target);
  assert.equal(result.body.profitTargetAssessment.status, 'TARGET_MET_IN_RETAINED_MODEL');
  assert.equal(result.body.profitTargetAssessment.shortfall.numerator, '0');
  assert(policy.certificate.operatingProfit.forecasts.every((f: any) => f.netProfit.incrementalProfit >= 200));
  assert(policy.certificate.operatingProfit.forecasts.every((f: any) => f.incrementalOperatingProfit > 0 && f.minimumCashObserved >= 50));
  assert(policy.certificate.operatingProfit.forecasts.every((f: any) => f.nonOperatingNetCashFlow === -600));
  assert.equal(policy.admission.executionAuthorityGranted, false); assert.equal(policy.demand.reservationGranted, false);
  const read = await api('read', { policyRef: policy.ref }), replay = await api('replay', { policyRef: policy.ref });
  assert.equal(read.status, 200, JSON.stringify(read)); assert.equal(replay.status, 200, JSON.stringify(replay));
  assert.equal(replay.body.programMatches, true); assert.equal(replay.body.certificateMatches, true);
  for (const field of ['currency', 'root']) {
    const invalid = structuredClone(payload);
    if (field === 'currency') invalid.mandate.utility.operatingProfit.currency = 'EUR'; else invalid.mandate.utility.operatingProfit.root.entityId = randomUUID();
    invalid.mandate = sealProfitMandate(invalid.mandate);
    assert.equal((await api('synthesize', invalid)).status, 400);
  }
  // Registered before the S5 implementation: a real owner-issued cash resource
  // funds gross modeled outlays, remains held after unknown execution, and
  // grants no protected effect, settlement or attribution.
  const cash = await api('resource', { resource: { schema: 'finnor.allocation-resource.v1', resourceId: 'operating-cash', tenantId: tenant,
    ownerRef: mandate.businessOwnerRef, legalEntityRef: profitRef(root.entityId, 'S1'), scopeRef: mandate.ref,
    permittedRoots: [root], rightsRef: mandate.rightsRef, unit: 'USD', currency: 'USD', kind: 'STOCK', resourceClass: 'CASH',
    horizon: mandate.horizon, sourceRef: profitRef('generated-ring-fenced-cash'), asOf: mandate.knowledgeAt,
    knowledgeAt: new Date().toISOString(), validUntil: mandate.validUntil, beliefPins: policy.bindings.beliefPins,
    availability: Array(3).fill({ amount: '3000', basis: 'REPORTED_AVAILABLE' }), existingUse: ['0', '0', '0'],
    safetyMargin: '50', covenants: [], revoked: false, qualification: 'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED' } }, tenant, principal, allocationPost);
  assert.equal(cash.status, 200, JSON.stringify(cash));
  const work = await receiveWork({ tenantId: tenant, userId: principal, instruction: 'Generated operating programme funding proof only', channel: 'console', idempotencyKey: randomUUID() });
  const proposed = await proposeEnterpriseSameDealAlternatives(ctx, { workId: work.workId, incumbentPolicyRef: policy.ref, policyRefs: [policy.ref] });
  assert.equal(proposed.reservationCreated, false);
  assert(proposed.checks.some(check => check.selectedPolicyIds.includes(policy.ref.id) && check.feasible));
  const clearing = { mandate, policyRefs: [policy.ref], resourceRefs: [cash.body.ref],
    jointModel: proposed.problem.jointModel, demandBindings: proposed.problem.demandBindings,
    funding: proposed.problem.funding, idempotencyKey: randomUUID() };
  const allocated = await api('clear', clearing, tenant, principal, allocationPost);
  assert.equal(allocated.status, 200, JSON.stringify(allocated)); assert.equal(allocated.body.status, 'FEASIBLE', JSON.stringify(allocated));
  const certificate = allocated.body.certificate, envelope = certificate.check.envelopes.find((e: any) => e.resourceId === 'operating-cash');
  assert.deepEqual(certificate.check.selectedPolicyIds, [policy.ref.id]); assert.equal(envelope.quantities.length, 3);
  assert(envelope.quantities.reduce((s: number, x: string) => s + Number(x), 0) > 1900);
  assert.equal(allocated.body.executionAuthorityGranted, false);
  const repeated = await api('clear', clearing, tenant, principal, allocationPost);
  assert.equal(repeated.body.reservation.ref.contentDigest, allocated.body.reservation.ref.contentDigest);
  const consumed = await api('consume', { allocationRef: certificate.ref, policyRef: policy.ref,
    decision: { knowledgeAt: new Date().toISOString(), period: 0, actionHistory: [], observations: [], rightsRef: mandate.rightsRef,
      obligations: [], allocationRefs: [certificate.ref] }, idempotencyKey: randomUUID() }, tenant, principal, allocationPost);
  assert.equal(consumed.status, 200, JSON.stringify(consumed)); assert.equal(consumed.body.consumption.status, 'INTENDED_PENDING_S6');
  assert.deepEqual(consumed.body.consumption.envelope, certificate.check.envelopes);
  const held = await api('reconcile', { allocationRef: certificate.ref }, tenant, principal, allocationPost);
  assert.equal(held.body.reservation.status, 'UNKNOWN_OUTCOME'); assert.deepEqual(held.body.reservation.envelopes, certificate.check.envelopes);
  assert.equal((await api('release', { allocationRef: certificate.ref, idempotencyKey: randomUUID() }, tenant, principal, allocationPost)).status, 422);
  return { qualification: 'GENERATED_OWNER_INTEGRATION_NOT_CUSTOMER_PROFIT', request, payload, fitRef: fit.body.model.ref, result, read, replay,
    belowTargetPayload, belowTarget, cash, proposed, clearing, allocated, repeated, consumed, held };
}
