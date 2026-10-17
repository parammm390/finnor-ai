/** Failure model registered before the joint programme implementation:
 * - requiring a profit target never generates a better intervention;
 * - independent lever profits are added despite joint price/volume/cost effects;
 * - setup/interaction charges, resource occupancy or residual debt vanish;
 * - options mutate the original revenue charter, model, entity, horizon or grants;
 * - forbidden bundles, overlapping control channels or unpriced choices pass;
 * - Cartesian truncation, failed S3 support or search exhaustion claims completeness;
 * - a caller edits compiled actions or the chosen-option certificate before S5;
 * - a conditional programme is mistaken for verified field profit or authority.
 */
import { describe, expect, it } from 'vitest';
import { synthesizeContingentControl, decideContingentPolicy } from '../../packages/epistemic-runtime/src/contingent-control';
import { assertContingentPolicy, parseControlProblem } from '../../packages/epistemic-runtime/src/control-contracts';
import { operatingCashScenarios } from '../../packages/epistemic-runtime/src/operating-profit-allocation';
import { epistemicHash } from '../../packages/epistemic-runtime/src/source-precedence';
import { profitInput, profitRef, profitRoot, sealProfitMandate } from '../../scripts/s4/operating-profit-fixtures';

function input(periods = 1, worlds = ['base']): any {
  const i = profitInput({ periods, worlds, actions: [] }), m = i.mandate, p = m.utility.operatingProfit;
  const c = (value: number) => ({ kind: 'CONSTANT', value, unit: 'USD', sourceRef: profitRef(`joint-cost:${value}`) });
  p.objective = 'INCREMENTAL_NET_PROFIT'; p.openingCash = 1000;
  p.netProfit = { schema: 'finnor.s4.net-profit-accounting.v1', financingExpense: c(0), incomeTaxExpense: c(0), otherIncome: c(0), otherExpense: c(0),
    cashTreatment: 'ACCRUAL_PNL_SEPARATE_EXPLICIT_CASH_DRIVERS' };
  p.segments[0].variableUnitCost = { kind: 'STATE', variableId: 'unitCost', unit: 'USD/item' };
  p.profitTarget = { schema: 'finnor.s4.revenue-profit-target.v1', minimumBasisPoints: 1000,
    basis: 'INCREMENTAL_NET_PROFIT_LESS_ADDITIONAL_TERMINAL_LIABILITY', denominator: 'FIXED_PREREGISTERED_REVENUE',
    revenueBaseline: { amount: 1000 * periods, unit: 'USD', root: profitRoot, horizon: m.horizon, sourceRef: profitRef('fixed-joint-revenue') },
    qualification: 'OWNER_BASELINE_ASSERTION_NOT_VERIFIED_REVENUE' };
  i.mandate = sealProfitMandate(m);
  i.dynamics.exposureIds = ['pricing', 'procurement']; i.problem.baselineExposures = { pricing: Array(periods).fill(0), procurement: Array(periods).fill(0) };
  i.dynamics.stateUnits.unitCost = 'USD/item'; i.dynamics.stateRoots.unitCost = profitRoot; i.dynamics.stateRanges.unitCost = [0, 10];
  for (const w of i.dynamics.initialWorlds) { w.history[0].states.unitCost = 6; w.history[0].exposures = { pricing: 0, procurement: 0 }; }
  i.dynamics.advance = (w: any, e: any) => ({ ...w, history: [...w.history, { states: { price: 10 + 2 * e.pricing,
    units: 100 - (w.id === 'adverse' ? 50 : 20) * e.pricing, unitCost: 6 - e.procurement, ar: 100 }, exposures: e }] });
  const costs = (cost: number) => ({ cost, resources: { capacity: 0 }, occupancy: { capacity: 0 }, tailLiability: 0, humanSeconds: 0 });
  i.problem.schema = 'finnor.control-problem.operating-programme.v2';
  i.problem.programmeSpace = { schema: 'finnor.s4.operating-programme-space.v1', sourceRef: profitRef('joint-owner-options'),
    scope: { mandateRef: i.mandate.ref, root: profitRoot, unit: 'USD', horizon: m.horizon },
    levers: [{ id: 'pricing', exposureId: 'pricing', options: [0, .5, 1].map((v, n) => ({ id: `price-${n}`, schedule: Array(periods).fill(v), ...costs(n ? 5 : 0) })) },
      { id: 'procurement', exposureId: 'procurement', options: [0, .3, .6].map((v, n) => ({ id: `cost-${n}`, schedule: Array(periods).fill(v), ...costs(n ? 10 : 0) })) }],
    exclusions: [], interactionCharges: [{ id: 'combined-rollout', when: [{ leverId: 'pricing', optionId: 'price-2' }, { leverId: 'procurement', optionId: 'cost-2' }], ...costs(10) }],
    commitment: 'FULL_HORIZON_COMMITMENTS_WITH_EXPLICIT_ADDITIVE_AND_INTERACTION_COSTS',
    qualification: 'OWNER_DECLARED_OPTIONS_NOT_VERIFIED_ACTIONABILITY' };
  return i;
}
const report = (r: any) => r.operatingProgrammeSearch;
const choice = (r: any) => r.policy.problem.actions.find((a: any) => a.id === r.policy.nodes.find((n: any) => n.id === r.policy.rootNodeId).actionId);
function resign(p: any) { const { ref: _ref, ...body } = p, contentDigest = epistemicHash(body); return { ...body, ref: { ...p.ref, contentDigest, id: `contingent-policy:${contentDigest}` } }; }

describe('joint operating programme discovery', () => {
  it('discovers a qualifying joint programme that neither lever can achieve alone', async () => {
    const i = input(), r: any = await synthesizeContingentControl(i);
    expect(r.status).toBe('POLICY_AVAILABLE');
    expect(i.problem.actions.every((a: any) => ['WAIT', 'STOP'].includes(a.kind))).toBe(true);
    expect(r.policy.problem.actions).toHaveLength(11); // nine full combinations plus wait/stop
    expect(choice(r)).toMatchObject({ exposures: { pricing: [1], procurement: [.6] }, cost: 25, earliestPeriod: 0, lastPeriod: 0, atMostOnce: true });
    expect(r.policy.certificate.valueBounds[0]).toBeCloseTo(103);
    const forecast = r.policy.certificate.operatingProfit.forecasts[0];
    expect(forecast.netProfit.incrementalProfit).toBeCloseTo(103); // joint gross 128 minus 25, not 80 + 60 - 25
    expect(forecast.periods[0]).toMatchObject({ revenue: 960, variableCost: 432, actionCost: 25 });
    expect(report(r)).toMatchObject({ combinations: 9, excludedCombinations: 0, generatedProgrammes: 9, evaluatedProgrammes: 9, completeSearch: true,
      selectedOptions: [{ leverId: 'pricing', optionId: 'price-2' }, { leverId: 'procurement', optionId: 'cost-2' }], interactionChargeIds: ['combined-rollout'] });
    expect(report(r).candidates).toHaveLength(9);
    expect(r.policy.certificate.operatingProfit.programmeSearch).toEqual(report(r));
    expect(r.policy.admission.executionAuthorityGranted).toBe(false);
    expect(() => assertContingentPolicy(r.policy)).not.toThrow();
    const decision = decideContingentPolicy(r.policy, { knowledgeAt: i.now, period: 0, actionHistory: [], observations: [], rightsRef: i.mandate.rightsRef, obligations: [], allocationRefs: [] });
    expect(decision.actionId).toBe(choice(r).id); expect(decision.executionAuthorityGranted).toBe(false);
    // Read/replay from the fully materialized original domain yields identical economic choices.
    const replay: any = await synthesizeContingentControl({ ...i, problem: r.policy.problem });
    expect(replay.policy.nodes).toEqual(r.policy.nodes); expect(replay.policy.certificate).toEqual(r.policy.certificate);
  });
  it('does not invent enough profit when only the pricing lever is permitted', async () => {
    const i = input(); i.problem.programmeSpace.levers.pop(); i.problem.programmeSpace.interactionCharges = [];
    const r: any = await synthesizeContingentControl(i);
    expect(r.policy).toBeNull(); expect(r.status).toBe('INFEASIBLE');
    expect(Number(r.profitTargetAssessment.bestWorstCaseProfit.display)).toBeCloseTo(75);
    expect(Number(r.profitTargetAssessment.shortfall.display)).toBeCloseTo(25);
    expect(report(r)).toMatchObject({ generatedProgrammes: 3, evaluatedProgrammes: 3, completeSearch: true });
  });
  it('applies forbidden combinations before search without silently replacing them', async () => {
    const i = input(); i.problem.programmeSpace.exclusions = [{ id: 'incompatible-supplier-and-price', when: i.problem.programmeSpace.interactionCharges[0].when }];
    const r: any = await synthesizeContingentControl(i);
    expect(r.policy).toBeNull(); expect(report(r)).toMatchObject({ combinations: 9, excludedCombinations: 1, generatedProgrammes: 8, evaluatedProgrammes: 8 });
    expect(Number(r.profitTargetAssessment.bestWorstCaseProfit.display)).toBeCloseTo(89);
  });
  it('pays setup/interaction costs once while retaining additional debt and common liabilities', async () => {
    const i = input(2); i.mandate.utility.tail.terminalLiability = 30; i.mandate = sealProfitMandate(i.mandate);
    i.problem.programmeSpace.scope.mandateRef = i.mandate.ref; i.problem.programmeSpace.interactionCharges[0].tailLiability = 10;
    const r: any = await synthesizeContingentControl(i), f = r.policy.certificate.operatingProfit.forecasts[0];
    expect(r.policy.certificate.valueBounds[0]).toBeCloseTo(221);
    expect(f).toMatchObject({ implementationCost: 25, terminalLiability: 40, comparatorTerminalLiability: 30 });
    expect(f.periods.map((p: any) => p.actionCost)).toEqual([25, 0]);
  });
  it('rejects individually feasible levers whose combined resource spending exceeds the grant', async () => {
    const i = input(); for (const l of i.problem.programmeSpace.levers) for (const o of l.options.slice(1)) o.resources.capacity = 60;
    const r: any = await synthesizeContingentControl(i);
    expect(r.policy).toBeNull(); expect(report(r).candidates.some((c: any) => c.reasons.includes('RESOURCE_OR_HUMAN_ENVELOPE_INFEASIBLE'))).toBe(true);
  });
  it('retains full-horizon occupancy when lever combinations are constructed', async () => {
    const i = input(2); for (const l of i.problem.programmeSpace.levers) for (const o of l.options.slice(1)) o.occupancy.capacity = 60;
    const r: any = await synthesizeContingentControl(i);
    expect(r.policy).toBeNull(); expect(report(r).candidates.some((c: any) => c.reasons.includes('RESOURCE_OR_HUMAN_ENVELOPE_INFEASIBLE'))).toBe(true);
  });
  it('preserves the actual hard risk floor and cash required before any forecast collection', async () => {
    const i = input(); i.mandate.utility.operatingProfit.openingCash = 60; i.mandate = sealProfitMandate(i.mandate); i.problem.programmeSpace.scope.mandateRef = i.mandate.ref;
    const r: any = await synthesizeContingentControl(i);
    expect(r.policy).toBeNull(); expect(report(r).candidates.some((c: any) => c.reasons.includes('OPERATING_CASH_FLOOR_INFEASIBLE'))).toBe(true);
  });
  it('uses all retained adverse worlds rather than choosing a different private-world bundle', async () => {
    const r: any = await synthesizeContingentControl(input(1, ['base', 'adverse']));
    expect(r.policy).toBeNull(); expect(Number(r.profitTargetAssessment.bestWorstCaseProfit.display)).toBeCloseTo(50);
  });
  it('withholds completeness and qualifying authority when joint search exhausts its original grant', async () => {
    const i = input(); i.mandate.search.maxExpansions = 1; i.mandate = sealProfitMandate(i.mandate); i.problem.programmeSpace.scope.mandateRef = i.mandate.ref;
    const r: any = await synthesizeContingentControl(i);
    expect(r.status).toBe('SEARCH_EXHAUSTED'); expect(r.policy).toBeNull();
    expect(report(r).completeSearch).toBe(false); expect(report(r).evaluatedProgrammes).toBeLessThan(9);
    expect(r.profitTargetAssessment.modelUpperBound).toBeNull(); expect(report(r).candidates.some((c: any) => c.status === 'NOT_EVALUATED')).toBe(true);
  });
  it('does not turn an unsupported intervention into a complete-domain profit claim', async () => {
    const i = input(), advance = i.dynamics.advance;
    i.dynamics.advance = (w: any, e: any, t: number) => ({ ...advance(w, e, t), supported: e.pricing !== 1 });
    const r: any = await synthesizeContingentControl(i);
    expect(r.status).toBe('MODEL_UNSUPPORTED'); expect(r.policy).toBeNull(); expect(report(r).completeSearch).toBe(false);
    expect(r.profitTargetAssessment.modelUpperBound).toBeNull();
  });
  it.each(['unpriced', 'overlapping-controls', 'unknown-channel', 'foreign-entity', 'wrong-currency', 'wrong-horizon', 'changed-mandate', 'oversize-domain', 'dangling-rule', 'missing-ref', 'non-profit', 'caller-action'])('refuses an unqualified domain: %s', async defect => {
    const i = input(), s = i.problem.programmeSpace;
    if (defect === 'unpriced') delete s.levers[0].options[0].cost;
    if (defect === 'overlapping-controls') s.levers[1].exposureId = 'pricing';
    if (defect === 'unknown-channel') s.levers[1].exposureId = 'unregistered-lever';
    if (defect === 'foreign-entity') s.scope.root = { ...profitRoot, entityId: '99999999-9999-4999-8999-999999999999' };
    if (defect === 'wrong-currency') { s.scope.unit = 'EUR'; for (const a of i.problem.actions) a.costUnit = 'EUR'; }
    if (defect === 'wrong-horizon') s.scope.horizon = { ...s.scope.horizon, periodMs: s.scope.horizon.periodMs + 1 };
    if (defect === 'changed-mandate') s.scope.mandateRef = profitRef('other-mandate');
    if (defect === 'oversize-domain') { for (let n = 0; n < 2; n++) { const exposureId = `exposure-${n}`; s.levers.push({ ...structuredClone(s.levers[0]), id: `lever-${n}`, exposureId }); i.problem.baselineExposures[exposureId] = [0]; i.dynamics.exposureIds.push(exposureId); } for (const l of s.levers) l.options = Array.from({ length: 8 }, (_, n) => ({ ...l.options[0], id: `option-${n}` })); s.interactionCharges = []; }
    if (defect === 'dangling-rule') s.exclusions = [{ id: 'bad', when: [{ leverId: 'pricing', optionId: 'missing' }] }];
    if (defect === 'missing-ref') delete s.sourceRef;
    if (defect === 'non-profit') { delete i.mandate.utility.operatingProfit; i.mandate = sealProfitMandate(i.mandate); s.scope.mandateRef = i.mandate.ref; }
    if (defect === 'caller-action') i.problem.actions.push({ ...i.problem.actions[0], id: 'unregistered-free-profit', kind: 'INTERVENE', atMostOnce: true, exposures: { pricing: [1], procurement: [.6] } });
    await expect(synthesizeContingentControl(i)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('requires explicit consumer support rather than letting legacy control paths ignore the domain', () => {
    expect(() => parseControlProblem(input().problem)).toThrow();
  });
  it('rejects materialized action tampering and S5 certificate substitution', async () => {
    const i = input(), r: any = await synthesizeContingentControl(i), p = r.policy;
    expect(Number(operatingCashScenarios([p])[0]!.terms[0]!.value)).toBeCloseTo(103);
    const changed = structuredClone(p.problem); changed.actions.find((a: any) => a.kind === 'INTERVENE').cost = 999;
    await expect(synthesizeContingentControl({ ...i, problem: changed })).rejects.toThrow();
    const forged = structuredClone(p); forged.certificate.operatingProfit.programmeSearch.selectedOptions[0].optionId = 'price-0';
    expect(() => operatingCashScenarios([resign(forged)])).toThrow();
  });
});
