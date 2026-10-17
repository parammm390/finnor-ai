/** Failure modes registered before this S5 extension:
 * immediate expense is financed by later income; totals conceal payment periods;
 * forecast sales/borrowing are credited as available cash; incomplete paths omit
 * adverse worlds; arbitrary joint payoffs replace S4 value; overlapping complete
 * programmes are added; cost/tail is charged twice or scale is dropped; funding
 * uses another entity/currency/kind; missing funding/safety floor passes; the
 * MILP producer omits a cash row enforced by the independent exact checker.
 */
import { describe, it, expect } from 'vitest';
import { synthesizeContingentControl } from '../../packages/epistemic-runtime/src/contingent-control';
import { allocationRef, assertAllocationProblem } from '../../packages/epistemic-runtime/src/allocation-contracts';
import { verifyCanonicalAllocation } from '../../packages/epistemic-runtime/src/allocation-checker';
import { compileAllocationMilp } from '../../packages/epistemic-runtime/src/allocation-producer';
import { operatingCashScenarios } from '../../packages/epistemic-runtime/src/operating-profit-allocation';
import { epistemicHash } from '../../packages/epistemic-runtime/src/source-precedence';
import { profitInput, profitRef, profitRoot, sealProfitMandate } from '../../scripts/s4/operating-profit-fixtures';

const seal = (p: any) => { const { ref: _ref, ...body } = p; return { ...body, ref: allocationRef('S5', 'allocation-problem', body) }; };
const jointSeal = (j: any) => { const { ref: _ref, ...body } = j; return { ...body, ref: allocationRef('BUSINESS_OWNER', 'joint-allocation-model', body, 's5-joint-model-v1') }; };
async function problem(options: { periods?: number; amount?: string; tail?: number; cost?: number; borrowing?: number } = {}) {
  const input = profitInput({ periods: options.periods ?? 1, actions: ['smart'], worlds: ['base', 'other'] });
  input.mandate.utility.tail.terminalLiability = options.tail ?? 0;
  input.problem.actions[0].cost = options.cost ?? 0;
  input.mandate.utility.operatingProfit.nonOperatingCashInflow.value = options.borrowing ?? 0;
  input.mandate = sealProfitMandate(input.mandate);
  const pin = { tenantId: input.mandate.tenantId, principalId: input.mandate.principalId, root: profitRoot,
    validAt: input.now, knowledgeAt: input.now, dependencyDigest: 'generated', rightsRevision: 0, interpretationVersion: 'fixture-v1' };
  const result = await synthesizeContingentControl({ ...input, beliefPins: [pin] });
  expect(result.status).toBe('POLICY_AVAILABLE'); const policy = result.policy!;
  const m = policy.mandate, body = { schema: 'finnor.allocation-resource.v1', resourceId: 'cash', tenantId: m.tenantId,
    ownerRef: m.businessOwnerRef, legalEntityRef: profitRef(profitRoot.entityId, 'S1'), scopeRef: m.ref,
    permittedRoots: [profitRoot], rightsRef: m.rightsRef, unit: 'USD', currency: 'USD', kind: 'STOCK', resourceClass: 'CASH',
    horizon: m.horizon, sourceRef: profitRef('registered-cash'), asOf: input.now, knowledgeAt: input.now, validUntil: m.validUntil,
    beliefPins: [pin], availability: Array(m.horizon.periods + 1).fill({ amount: options.amount ?? '10000', basis: 'REPORTED_AVAILABLE' }),
    existingUse: Array(m.horizon.periods + 1).fill('0'), safetyMargin: '50', covenants: [], revoked: false,
    qualification: 'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED', revision: 1, priorRef: null };
  const digest = epistemicHash(body), resource = { ...body, ref: { owner: 'S5', id: `allocation-resource:cash:1:${digest}`, version: 's5-joint-finite-v1', contentDigest: digest } };
  const joint = jointSeal({ schema: 'finnor.joint-allocation-model.v1', tenantId: m.tenantId, principalId: m.principalId,
    mandateRef: m.ref, rightsRef: m.rightsRef, sourceRefs: [policy.bindings.modelRef], knowledgeAt: input.now, validUntil: m.validUntil,
    qualification: 'SUPPLIED_JOINT_FINITE_SCENARIOS_UNADMITTED', ambiguity: 'FIXED_COMPLETE_JOINT_PATHS_NO_PROBABILITIES',
    completeness: 'ALL_MATERIAL_INTERFERENCE_AND_COMPATIBILITY_DECLARED', assumptions: ['Generated same-programme alternatives, no forecast proceeds fund cash'],
    omittedModelGap: 'UNKNOWN', identificationGap: 'UNKNOWN', scenarios: operatingCashScenarios([policy]),
    choiceConstraints: [{ id: 'one-programme', policyIds: [policy.ref.id], minimum: 0, maximum: 1, sourceRef: m.ref }] });
  return seal({ schema: 'finnor.allocation-problem.v1', tenantId: m.tenantId, principalId: m.principalId, episodeId: m.episodeId,
    mandate: m, policies: [policy], resources: [resource], jointModel: joint, demandBindings: [],
    funding: [{ policyRef: policy.ref, actionCostResourceId: null, terminalLiabilityResourceId: options.tail ? 'cash' : null, humanSecondsResourceId: null,
      operatingCash: { schema: 'finnor.s5.operating-cash-binding.v1', resourceId: 'cash', basis: 'GROSS_OUTFLOWS_NO_FORECAST_PROCEEDS' } }],
    outstanding: [], snapshotDigest: epistemicHash({ resources: [resource], outstanding: [] }), knowledgeAt: new Date().toISOString(),
    validUntil: m.validUntil, methodVersion: 's5-joint-finite-v1' });
}
function resealResource(p: any, change: (r: any) => void) {
  const r = p.resources[0]; change(r); const { ref: _ref, ...body } = r, digest = epistemicHash(body);
  r.ref = { ...r.ref, id: `allocation-resource:cash:1:${digest}`, contentDigest: digest };
  p.snapshotDigest = epistemicHash({ resources: p.resources, outstanding: p.outstanding }); return seal(p);
}
describe('operating-profit cash allocation correspondence', () => {
  it('refuses an immediate expense that only later income could pay', async () => {
    const input = profitInput({ actions: ['smart'] }); input.problem.actions[0].cost = 70;
    const result = await synthesizeContingentControl(input);
    expect(result.status).toBe('POLICY_AVAILABLE');
    expect(['wait', 'stop']).toContain(result.policy!.nodes.find(n => n.id === result.policy!.rootNodeId)!.actionId);
  });
  it('retains a source-bound cash ledger and funds gross outlays without crediting sales', async () => {
    const p = await problem(), forecast = p.policies[0].certificate.operatingProfit.forecasts[0];
    expect(forecast.periods).toHaveLength(1); expect(forecast.nodeIds).toEqual(p.jointModel.scenarios[0].policyPaths[0].nodeIds);
    const check = verifyCanonicalAllocation(p, [p.policies[0].ref.id]);
    expect(check.feasible).toBe(true); expect(check.objective).toBe('100');
    expect(check.envelopes[0]!.quantities).toEqual(['700', '0']); expect(check.executionAuthorityGranted).toBe(false);
  });
  it('enforces the exact cash boundary including the protected cash floor', async () => {
    const p = await problem({ amount: '750' }); expect(verifyCanonicalAllocation(p, [p.policies[0].ref.id]).feasible).toBe(true);
    const less = resealResource(p, r => { r.availability = r.availability.map(() => ({ amount: '749.999999999999', basis: 'REPORTED_AVAILABLE' })); });
    expect(verifyCanonicalAllocation(less, [less.policies[0].ref.id]).feasible).toBe(false);
  });
  it('does not fund early outlays with later availability or projected borrowing', async () => {
    const p = await problem({ periods: 2, borrowing: 1000 });
    const check = verifyCanonicalAllocation(p, [p.policies[0].ref.id]); expect(check.envelopes[0]!.quantities).toEqual(['700', '700', '0']);
    const late = resealResource(p, r => { r.availability[0] = { amount: '700', basis: 'REPORTED_AVAILABLE' }; });
    expect(verifyCanonicalAllocation(late, [late.policies[0].ref.id]).feasible).toBe(false);
  });
  it('charges immediate cost once and preserves terminal cash liability', async () => {
    const p = await problem({ cost: 20, tail: 30 });
    const check = verifyCanonicalAllocation(p, [p.policies[0].ref.id]);
    expect(check.envelopes[0]!.quantities).toEqual(['720', '30']); expect(check.objective).toBe('80');
  });
  it.each(['missing-funding', 'wrong-currency', 'wrong-entity', 'wrong-kind', 'missing-floor'])('refuses %s', async mode => {
    let p = await problem();
    if (mode === 'missing-funding') delete p.funding[0].operatingCash;
    else p = resealResource(p, r => {
      if (mode === 'wrong-currency') { r.unit = 'EUR'; r.currency = 'EUR'; }
      if (mode === 'wrong-entity') r.legalEntityRef = profitRef('44444444-4444-4444-8444-444444444444', 'S1');
      if (mode === 'wrong-kind') r.kind = 'FLOW';
      if (mode === 'missing-floor') r.safetyMargin = '0';
    });
    expect(() => verifyCanonicalAllocation(seal(p), [p.policies[0].ref.id])).toThrow();
  });
  it.each(['value', 'world', 'coverage', 'choice'])('refuses a forged %s correspondence', async mode => {
    const p = await problem();
    if (mode === 'value') p.jointModel.scenarios[0].terms[0].value = '999999';
    if (mode === 'world') p.jointModel.scenarios[0].operatingWorldId = 'not-the-retained-world';
    if (mode === 'coverage') p.jointModel.scenarios.pop();
    if (mode === 'choice') p.jointModel.choiceConstraints = [];
    p.jointModel = jointSeal(p.jointModel);
    expect(() => assertAllocationProblem(seal(p))).toThrow();
  });
  it('puts the same cash requirement in the producer MILP and independent checker', async () => {
    const p = await problem({ periods: 2 }), compiled = compileAllocationMilp(p, 10000);
    const rows = compiled.input.rows.filter(r => r.id.startsWith('resource:cash:'));
    expect(rows.some(r => r.coefficients['0'] === '700')).toBe(true); expect(rows.some(r => r.coefficients['0'] === '1400')).toBe(true);
    expect(verifyCanonicalAllocation(p, [p.policies[0].ref.id]).envelopes[0]!.quantities).toEqual(['700', '700', '0']);
  });
});
