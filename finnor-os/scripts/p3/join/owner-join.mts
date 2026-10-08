/** Preregistered T cases: real signed producers, ordinary SQL, queue and P3 cells. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { receiveWork } from '@finnor/db';
import { createEvidenceSource, appendEvidenceVersion } from '@finnor/memory';
import { createMetricSeries, recordMetricObservation, restateMetricObservation, createAssumption,
  createDeal, createInvestmentCase, createUnderwritingModel, createUnderwritingModelVersion, attachWorkToDealGraph } from '@finnor/private-equity';
import { UNDERWRITING_ENGINE_VERSION, FINANCIAL_CONVENTION_VERSION } from '@finnor/underwriting';
import { POST } from '../../../apps/api/app/api/company-brain/[operation]/route';
import { JobQueue } from '../../../apps/worker/src/queue';
import { PRODUCTION_JOB_CONTRACTS } from '../../../packages/db/compute-contract';
import { runEvidenceDerivationJob } from '../../../packages/private-equity/src/evidence-execution/worker';
import { branchQueue } from '../../../packages/private-equity/src/branch-fabric/worker';
import { hash } from '../../../packages/private-equity/src/branch-fabric/contracts';
import { currentCodeIdentity } from '../../../packages/private-equity/src/evidence-execution/store';
export const joinHandler = POST;
const success = (r: any) => { assert(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body; };

export async function joinChallenges(s: any) {
  process.env.FINNOR_P4_PROFILE = 'ordinary_disposable'; process.env.FINNOR_M1_PROFILE = 'DISPOSABLE_NATIVE';
  process.env.FINNOR_M1_STORE = join(s.output, 'm1-private-store');
  await s.admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('native:p4',2,2,0,60,true,'P3 exact committed disposable join'),('provider:m1-native',2,2,0,120,true,'P3 exact committed disposable join') ON CONFLICT(resource_key) DO NOTHING");
  const f = await s.fixture('p3-p4-current'), m = await s.fixture('p3-m1-current');
  const root = { entityType: 'external_organization', entityId: f.rootId }, ctx = { auth: f.ctx, provenance: { sourceSystem: 'P3:join-public-fixture', createdBy: f.ctx.userId } };
  const calls: any[] = [];
  async function ownerApi(owner: any, operation: string, body: unknown) {
    const r = await fetch(s.apiOrigin + '/api/company-brain/' + operation, { method: 'POST', headers: { authorization: 'Bearer ' + owner.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = { status: r.status, body: await r.json() };
    calls.push({ operation, tenantId: owner.ctx.tenantId, principalId: owner.ctx.userId, body, response });
    await s.save(`join/calls/${String(calls.length).padStart(4, '0')}.json`, calls.at(-1));
    return response;
  }
  const periodStart = '2025-01-01T00:00:00.000Z', periodEnd = '2025-12-31T00:00:00.000Z';
  const evidence = await createEvidenceSource(f.ctx.tenantId, { sourceKey: randomUUID(), sourceType: 'manual', title: 'P3 committed join public fixed source' });
  const version = await appendEvidenceVersion(f.ctx.tenantId, evidence.id, { content: 'EV120 debt70 EBITDA20', snapshot: { EV: 120, debt: 70, EBITDA: 20 }, asOf: new Date(periodStart) });
  const evidenceRef = { evidenceSourceId: evidence.id, evidenceVersionId: version.versionId }, observations: Record<string, string> = {};
  for (const [metric, value] of [['EV', '120'], ['debt', '70'], ['EBITDA', '20']]) {
    const series = await createMetricSeries(ctx, { subjectType: 'external_organization', subjectId: f.rootId, metricKey: metric!, name: metric!, unit: 'currency', currencyCode: 'USD', frequency: 'annual' });
    observations[metric!] = String((await recordMetricObservation(ctx, { metricSeriesId: String(series.row.id), periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), value: { type: 'number', value: value! }, evidence: evidenceRef })).row.id);
  }
  const program = { schema: 'finnor.derivation-ir.v1', nodes: [
    { id: 'evrows', op: 'source', inputId: 'EV' }, { id: 'ev', op: 'unique', input: 'evrows' },
    { id: 'debtrows', op: 'source', inputId: 'debt' }, { id: 'debt', op: 'unique', input: 'debtrows' },
    { id: 'erows', op: 'source', inputId: 'EBITDA' }, { id: 'ebitda', op: 'unique', input: 'erows' },
    { id: 'equity', op: 'subtract', left: 'ev', right: 'debt' }, { id: 'leverage', op: 'ratio', left: 'debt', right: 'ebitda', decimalPlaces: 18 },
  ], outputs: ['equity', 'leverage'] };
  const handles = success(await ownerApi(f, 'evidence-handles', { root, inputs: ['EV', 'debt', 'EBITDA'].map(metric => ({ inputId: metric, source: { kind: 'metric', subject: root, metricKey: metric, periodStart, periodEnd, unit: 'currency', currencyCode: 'USD', frequency: 'annual', calendar: 'OWNER_RECORDED', consolidation: 'OWNER_SUBJECT_ONLY', instrument: 'UNSPECIFIED', scale: '1', sign: 'AS_RECORDED' } })) })).handles;
  const q = new JobQueue('p3-p4-authentic-join', 60, 'INTERACTIVE');
  q.register('run_evidence_derivation_v1', runEvidenceDerivationJob, PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
  async function finish(submitted: any) {
    for (let i = 0; i < 10; i++) {
      await q.tick(); const result = success(await ownerApi(f, 'evidence-read', { queryId: submitted.queryId }));
      if (['TESTED', 'PARTIAL', 'FAILED', 'INVALIDATED', 'CANCELLED'].includes(result.status)) return result;
    }
    throw Error('P4_QUEUE_DID_NOT_FINISH');
  }
  const submission = success(await ownerApi(f, 'evidence-submit', { schema: 'finnor.evidence-request.v1', root, workId: f.workId, question: 'Exact current equity and leverage for P3 native rehearsal', idempotencyKey: randomUUID(), mode: 'ordinary_disposable', inputs: handles.map((h: any) => ({ inputId: h.inputId, handleId: h.id })), program, acceptance: { selectedUniverse: 'COMPLETE', absoluteTolerance: '0', materialOutputs: ['equity', 'leverage'] } }));
  let current = await finish(submission), first: any;
  await s.save('join/producer-cut.json', { identity: await currentCodeIdentity(), migrationCount: s.migrationCount,
    base: JSON.parse(await readFile(join(s.root, 'scope-pm/phase-03-p3-branch-fabric/scope-evidence/join-import-receipt.json'), 'utf8')),
    sourceCut: current, mode: 'AUTHENTIC_COMMITTED_PRODUCERS_ORDINARY_NATIVE_NOT_ACCEPTED_ISOLATION' });
  await s.challenge('T1-authentic-P4-current-native-replay', ['Signed CompanyBrain producer routes', 'Real P4 queue/SQL witnesses/checks', 'P3 fixed credential-free native P4 child and independent rational checker', 'Foreign principal refusal'],
    'Exact equity50 and leverage3.5, selected universe preserved; no source/business/admission upgrade', async () => {
      assert.equal(current.status, 'TESTED', JSON.stringify(current));
      const cut = await s.prepared(f, { kind: 'p4', derivationId: current.derivation.id, output: 'equity' });
      first = await s.run(f, cut);
      assert.equal(first.branch.status, 'COMPLETE', JSON.stringify(first));
      assert.equal(first.branch.result.result.output.value, '50'); assert.equal(first.branch.result.result.native.outputs.leverage.value, '3.5');
      assert.equal(first.branch.result.check.domain, 'P4_SOURCE_UNIQUE_EXACT_ARITHMETIC_BIGINT_RATIONAL');
      assert.equal(first.branch.result.accepted, false); assert.equal(first.branch.result.evidenceClass, 'COMPUTATION');
      const foreign = await s.api(s.other, 'prepare', { workId: s.other.workId, root: { entityType: 'external_organization', entityId: s.other.rootId }, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source: { kind: 'p4', derivationId: current.derivation.id, output: 'equity' } });
      assert.equal(foreign.status, 404); assert(!JSON.stringify(foreign).includes('50'));
      return { current, cut, first, foreign };
    });
  await s.challenge('T2-P4-restatement-revocation-replay', ['Real owner restates debt70→80', 'Old P3/P4 current readers refuse', 'Actual P4 replay updates Work revision', 'Fresh P3 native cell'],
    'Old immutable history retained but not served; replay produces equity40 and leverage4', async () => {
      assert(first);
      const before = await s.sqlState(f, first.s.branchId);
      const restated = await restateMetricObservation(ctx, { priorObservationId: observations.debt!, expectedVersion: 1, replacement: { value: { type: 'number', value: '80' }, evidence: evidenceRef } });
      const refused = await s.api(f, 'read', { branchId: first.s.branchId }); assert.equal(refused.status, 409);
      const old = success(await ownerApi(f, 'evidence-read', { queryId: current.queryId })); assert.equal(old.status, 'INVALIDATED'); assert.equal(old.derivation, null);
      const after = await s.sqlState(f, first.s.branchId); assert.equal(after.head.status, 'INVALIDATED');
      assert.deepEqual(after.artifacts.filter((r: any) => r.category === 'RESULT'), before.artifacts.filter((r: any) => r.category === 'RESULT'));
      current = await finish(success(await ownerApi(f, 'evidence-replay', { queryId: current.queryId, idempotencyKey: randomUUID() })));
      assert.equal(current.status, 'TESTED', JSON.stringify(current));
      const replay = await s.run(f, await s.prepared(f, { kind: 'p4', derivationId: current.derivation.id, output: 'equity' }));
      assert.equal(replay.branch.status, 'COMPLETE'); assert.equal(replay.branch.result.result.output.value, '40'); assert.equal(replay.branch.result.result.native.outputs.leverage.value, '4');
      return { restated, refused, old, before, after, current, replay };
    });
  await s.challenge('T3-P4-P3-cancel-before-publication', ['Authentic current P4 input', 'P3 actual cell completes', 'Cancellation at observed execution boundary', 'Late checker/publication refusal'],
    'Terminal observed-stopped cancellation, no published result; costs retained', async () => {
      const cut = await s.prepared(f, { kind: 'p4', derivationId: current.derivation.id, output: 'equity' }), submitted = await s.submitted(f, cut);
      await branchQueue({ boundary: async name => { if (name === 'AFTER_EXECUTION') success(await s.api(f, 'cancel', { branchId: submitted.branchId })); } }).tick();
      const state = await s.sqlState(f, submitted.branchId); assert.equal(state.head.status, 'CANCELLED'); assert.equal(state.head.result_id, null);
      assert(state.artifacts.some((r: any) => r.category === 'COST'));
      return { cut, submitted, state };
    });
  const mc = { auth: m.ctx, provenance: { sourceSystem: 'P3:authentic-M1-native-join', createdBy: m.ctx.userId } };
  const deal = String((await createDeal(mc, { targetOrganizationId: m.rootId, name: 'P3 exact M1 native case', dealLeadEmployeeId: m.ctx.userId, signedLoiAt: new Date(), targetClosingAt: new Date(Date.now() + 86400000) })).row.id);
  const ic = String((await createInvestmentCase(mc, { dealId: deal, title: 'P3 actual M1 dependency binding' })).row.id);
  const assumption = String((await createAssumption(mc, { dealId: deal, investmentCaseId: ic, assumptionKey: 'x', statement: 'Public owner constant x34', valueType: 'number', value: 34, unit: 'ratio' })).row.id);
  const definition: any = { schemaVersion: 'underwriting-model-ir.v1', modelKey: 'p3-m1-join', modelVersion: '1', financialConventionVersion: FINANCIAL_CONVENTION_VERSION, minimumEngineVersion: UNDERWRITING_ENGINE_VERSION, periodDefinition: { frequency: 'annual', forecastStart: '2026-01-01', count: 1 }, circularBlocks: [], nodes: [
    { id: 'x', kind: 'input', valueType: 'decimal', unit: 'ratio', shape: 'scalar', dependencies: [], required: true, source: { kind: 'p1_assumption', assumptionId: assumption } },
    { id: 'score', kind: 'output', valueType: 'decimal', unit: 'ratio', shape: 'scalar', dependencies: ['x'], sourceNodeId: 'x' },
  ] };
  const model = String((await createUnderwritingModel(mc, { investmentCaseId: ic, modelKey: definition.modelKey, name: 'Actual M1 native model' })).id);
  const modelVersion = String((await createUnderwritingModelVersion(mc, { modelId: model, definition })).id);
  await attachWorkToDealGraph(mc, { workId: m.workId, dealId: deal, entities: [{ entityType: 'pe_investment_case', entityId: ic }] });
  const request = { schema: 'finnor.decision-slice-request.v1', workId: m.workId, source: { kind: 'UNDERWRITING', investmentCaseId: ic, modelVersionId: modelVersion }, purpose: 'ACQUISITION', resource: { deadlineMs: 30000, maxNodes: 2048, maxBytes: 8388608, maxDemands: 128 } };
  let slice: any, bound: any;
  const prepareM1 = async () => success(await s.api(m, 'prepare', { workId: m.workId, root: { entityType: 'pe_deal', entityId: deal }, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source: { kind: 'm1', sliceRef: slice.ref } }));
  await s.challenge('T4-authentic-M1-current-slice-native-binding', ['Signed M1 compile through CompanyBrain', 'Actual S1/native assumption/model input', 'P3 material/native binding and separate ancestor checker', 'Retain all M1 gaps and no projection budget'],
    'Native score34, exact dependency preservation, unresolved legal/domain coverage and no decision authority', async () => {
      slice = success(await ownerApi(m, 'decision-slice-compile', request)).slice;
      const cut = await prepareM1(); bound = await s.run(m, cut);
      assert.equal(bound.branch.status, 'COMPLETE', JSON.stringify(bound));
      assert.equal(bound.branch.result.result.run.outputs.score.value, '34');
      assert.equal(hash(bound.branch.result.result.unresolvedCoverage), hash(slice.unresolvedCoverage)); assert(slice.unresolvedCoverage.length > 0);
      assert.equal(slice.projectionLoss, null); assert.equal(bound.branch.result.result.executionAuthorityGranted, false);
      const foreign = await s.api(s.other, 'prepare', { workId: s.other.workId, root: { entityType: 'external_organization', entityId: s.other.rootId }, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source: { kind: 'm1', sliceRef: slice.ref } });
      assert.equal(foreign.status, 404);
      return { request, slice, cut, bound, foreign };
    });
  await s.challenge('T5-M1-cancel-late-P3-publication', ['Current authentic M1 slice', 'P3 result blob durably written', 'Actual M1 cancellation before P3 pointer', 'Fresh producer currentness refusal'],
    'No result pointer after upstream cancellation; immutable orphan/attempt and costs retained', async () => {
      const cut = await prepareM1(), submitted = await s.submitted(m, cut);
      await branchQueue({ boundary: async name => { if (name === 'AFTER_BLOB_BEFORE_POINTER') success(await ownerApi(m, 'decision-slice-cancel', { sliceRef: slice.ref })); } }).tick();
      const state = await s.sqlState(m, submitted.branchId); assert.equal(state.head.result_id, null); assert.notEqual(state.head.status, 'COMPLETE');
      assert(state.artifacts.some((r: any) => r.category === 'COST'));
      return { slice, cut, submitted, state };
    });
  await s.challenge('T6-M1-Work-revision-invalidates-P3', ['Recompile actual M1 slice', 'P3 fresh native branch', 'New real Work input', 'M1/P3 current serving refused'],
    'Equal score cannot resurrect old choice; original records preserved', async () => {
      slice = success(await ownerApi(m, 'decision-slice-compile', request)).slice;
      const fresh = await s.run(m, await prepareM1()), before = await s.sqlState(m, fresh.s.branchId);
      await receiveWork({ tenantId: m.ctx.tenantId, userId: m.ctx.userId, workId: m.workId, instruction: 'Material new Work request after exact M1 branch', channel: 'console', idempotencyKey: randomUUID() });
      const m1Refused = await ownerApi(m, 'decision-slice-read', { sliceRef: slice.ref }); assert.equal(m1Refused.status, 409);
      const p3Refused = await s.api(m, 'read', { branchId: fresh.s.branchId }); assert.equal(p3Refused.status, 409);
      const after = await s.sqlState(m, fresh.s.branchId); assert.equal(after.head.status, 'INVALIDATED'); assert.equal(after.head.result_id, before.head.result_id);
      return { slice, fresh, before, after, m1Refused, p3Refused };
    });
  await s.save('join/calls.json', calls);
}
