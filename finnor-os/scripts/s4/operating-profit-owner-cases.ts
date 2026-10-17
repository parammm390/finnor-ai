/** Registered before implementation: permitted S1 -> S3 -> S4 -> owner replay.
 * Generated price/volume history only; this is not measured customer profit. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createMetricSeries, attachCanonicalEvidenceToWorld, type PeMutationContext } from '@finnor/private-equity';
import { createEvidenceSource } from '@finnor/memory';
import { profitInput, profitRef, sealProfitMandate } from './operating-profit-fixtures';

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
  const mandate = sealProfitMandate(m);
  p.episodeId = m.episodeId; p.modelRef = fit.body.model.ref; p.context = 'public-price'; p.regime = 'operating';
  p.baselineExposures = { price: [0, 0] };
  for (const a of p.actions) if (a.kind === 'INTERVENE') a.exposures = { price: [.15, .15] };
  const payload = { mandate, problem: p, protocols: [], scenarios: { pathsPerMechanism: 4, seed: 20261017 } };
  const result = await api('synthesize', payload);
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.status, 'POLICY_AVAILABLE', JSON.stringify(result));
  const policy = result.body.policy;
  assert.equal(policy.nodes.find((n: any) => n.id === policy.rootNodeId).actionId, 'smart'); assert(policy.certificate.valueBounds[0] > 0);
  assert.equal(policy.certificate.operatingProfit.qualification, 'MODEL_CONDITIONAL_NOT_REALIZED_OR_GUARANTEED');
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
  return { qualification: 'GENERATED_OWNER_INTEGRATION_NOT_CUSTOMER_PROFIT', request, payload, fitRef: fit.body.model.ref, result, read, replay };
}
