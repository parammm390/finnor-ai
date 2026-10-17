/** Failure modes registered before implementation:
 * - existing margin/revenue/borrowing is sold as incremental net profit;
 * - financing, income-tax expense, programme fees or residual debt disappear;
 * - P&L recognition silently pays cash twice, or cash taxes replace tax expense;
 * - a forecast shrinks the fixed revenue denominator or changes its entity/unit/time;
 * - mean/upside replaces the joint worst case, or epsilon admits a shortfall;
 * - a failed/incomplete search publishes a qualifying policy or invents impossibility;
 * - certificate rewriting bypasses the hurdle or breaks S5's original net payoff;
 * - target attainment is represented as observed profit or execution authority.
 */
import { describe, expect, it } from 'vitest';
import { synthesizeContingentControl } from '../../packages/epistemic-runtime/src/contingent-control';
import { assertContingentPolicy } from '../../packages/epistemic-runtime/src/control-contracts';
import { operatingCashScenarios } from '../../packages/epistemic-runtime/src/operating-profit-allocation';
import { epistemicHash } from '../../packages/epistemic-runtime/src/source-precedence';
import { profitInput, profitRef, profitRoot, sealProfitMandate } from '../../scripts/s4/operating-profit-fixtures';

const constant = (value: number, unit = 'USD') => ({ kind: 'CONSTANT', value, unit, sourceRef: profitRef(`net:${unit}:${value}`) });
function input(options: { actions?: string[]; worlds?: string[]; periods?: number } = {}): any {
  const i = profitInput({ actions: ['smart'], ...options }), p = i.mandate.utility.operatingProfit;
  p.objective = 'INCREMENTAL_NET_PROFIT';
  p.netProfit = { schema: 'finnor.s4.net-profit-accounting.v1', financingExpense: constant(0), incomeTaxExpense: constant(0),
    otherIncome: constant(0), otherExpense: constant(0), cashTreatment: 'ACCRUAL_PNL_SEPARATE_EXPLICIT_CASH_DRIVERS' };
  p.profitTarget = { schema: 'finnor.s4.revenue-profit-target.v1', minimumBasisPoints: 1000,
    basis: 'INCREMENTAL_NET_PROFIT_LESS_ADDITIONAL_TERMINAL_LIABILITY', denominator: 'FIXED_PREREGISTERED_REVENUE',
    revenueBaseline: { amount: 1000 * i.mandate.horizon.periods, unit: 'USD', root: profitRoot,
      horizon: structuredClone(i.mandate.horizon), sourceRef: profitRef('preregistered-generated-revenue') },
    qualification: 'OWNER_BASELINE_ASSERTION_NOT_VERIFIED_REVENUE' };
  return i;
}
const reseal = (i: any) => ({ ...i, mandate: sealProfitMandate(i.mandate) });
const run = (i: any) => synthesizeContingentControl(reseal(i));
const assessment = (r: any) => r.profitTargetAssessment;
const first = (r: any) => r.policy.certificate.operatingProfit.forecasts[0];
function addState(i: any, key: string, value: (choice: number, world: string) => number) {
  i.dynamics.stateUnits[key] = 'USD'; i.dynamics.stateRoots[key] = profitRoot; i.dynamics.stateRanges[key] = [0, 1000];
  for (const w of i.dynamics.initialWorlds) w.history[0].states[key] = value(0, w.id);
  const advance = i.dynamics.advance;
  i.dynamics.advance = (w: any, e: any, t: number) => { const n = advance(w, e, t); n.history.at(-1).states[key] = value(e.choice, w.id); return n; };
}
function resealPolicy(p: any) {
  const { ref: _ref, ...body } = p, contentDigest = epistemicHash(body);
  return { ...body, ref: { ...p.ref, id: `contingent-policy:${contentDigest}`, contentDigest } };
}

describe('fixed revenue hurdle for additional net profit', () => {
  it('requires ten billion additional dollars on one hundred billion baseline sales', async () => {
    const i = input(), p = i.mandate.utility.operatingProfit;
    p.moneyScale = '1000000'; i.mandate.utility.unit = 'USD:1000000';
    for (const key of ['fixedOperatingCost', 'depreciationAmortization', 'accountsReceivable', 'inventory', 'accountsPayable',
      'capitalExpenditure', 'cashTaxes', 'nonOperatingCashInflow', 'nonOperatingCashOutflow']) {
      p[key] = constant(0, 'USD:1000000');
    }
    for (const key of ['financingExpense', 'incomeTaxExpense', 'otherIncome', 'otherExpense']) p.netProfit[key] = constant(0, 'USD:1000000');
    p.profitTarget.revenueBaseline.amount = 100000; p.profitTarget.revenueBaseline.unit = 'USD:1000000';
    i.dynamics.initialWorlds[0].history[0].states = { price: 1000, units: 100000000, ar: 0 };
    i.dynamics.stateRanges = { price: [0, 2000], units: [0, 1000000000], ar: [0, 1] };
    i.dynamics.advance = (w: any, e: any) => ({ ...w, history: [...w.history, { states: { price: e.choice ? 1100 : 1000, units: 100000000, ar: 0 }, exposures: e }] });
    for (const a of i.problem.actions) a.costUnit = 'USD:1000000';
    const r = await run(i);
    expect(r.status).toBe('POLICY_AVAILABLE');
    expect(assessment(r)).toMatchObject({ status: 'TARGET_MET_IN_RETAINED_MODEL', requiredIncrementalProfit: { numerator: '10000', denominator: '1', unit: 'USD:1000000' },
      bestWorstCaseProfit: { numerator: '10000', denominator: '1' }, shortfall: { numerator: '0' }, searchComplete: true });
    expect(first(r).netProfit.incrementalProfit).toBe(10000);
    expect(r.policy!.certificate.operatingProfit!.measure).toBe('NET_PROFIT_AFTER_FINANCING_AND_INCOME_TAX');
    expect(r.policy!.admission.executionAuthorityGranted).toBe(false);
    expect(() => assertContingentPolicy(r.policy)).not.toThrow();
  });
  it('does not count an already profitable business as additional profit', async () => {
    const r = await run(input({ actions: [] }));
    expect(r.status).toBe('INFEASIBLE'); expect(r.policy).toBeNull();
    expect(assessment(r)).toMatchObject({ status: 'TARGET_UNATTAINABLE_IN_ENUMERATED_MODEL', bestWorstCaseProfit: { numerator: '0' },
      shortfall: { numerator: '100' }, modelUpperBound: { numerator: '0' }, searchComplete: true });
    expect(r.reasons).toContain('REVENUE_PROFIT_TARGET_NOT_MET');
    expect(r.experience[0]!.detail.profitTargetAssessment).toEqual(assessment(r));
  });
  it('subtracts action-dependent financing and tax expense from the target payoff', async () => {
    const i = input(); addState(i, 'interest', c => c ? 30 : 10); addState(i, 'taxExpense', c => c ? 30 : 0);
    i.mandate.utility.operatingProfit.netProfit.financingExpense = { kind: 'STATE', variableId: 'interest', unit: 'USD' };
    i.mandate.utility.operatingProfit.netProfit.incomeTaxExpense = { kind: 'STATE', variableId: 'taxExpense', unit: 'USD' };
    const r = await run(i);
    expect(r.policy).toBeNull(); expect(assessment(r).bestWorstCaseProfit.numerator).toBe('50'); expect(assessment(r).shortfall.numerator).toBe('50');
  });
  it('keeps the denominator fixed when the action lowers modeled sales', async () => {
    const i = input(); i.mandate.utility.operatingProfit.segments[0].variableUnitCost.value = 9;
    i.dynamics.advance = (w: any, e: any) => ({ ...w, history: [...w.history, { states: { price: e.choice ? 20 : 10,
      units: e.choice ? 15 : 100, ar: 100 }, exposures: e }] });
    const r = await run(i); // sales fall to 300, incremental profit 65, fixed target remains 100
    expect(r.policy).toBeNull(); expect(assessment(r)).toMatchObject({ requiredIncrementalProfit: { numerator: '100' }, bestWorstCaseProfit: { numerator: '65' }, shortfall: { numerator: '35' } });
  });
  it('uses the worst complete joint world, never its average or upside', async () => {
    const i = input({ worlds: ['base', 'adverse'] });
    const r = await run(i);
    expect(r.policy).toBeNull(); expect(assessment(r).bestWorstCaseProfit.numerator).toBe('0'); expect(assessment(r).shortfall.numerator).toBe('100');
  });
  it('does not use solver tolerance to forgive a tiny shortfall', async () => {
    const i = input(); i.problem.actions[0].cost = 1e-9;
    const r = await run(i);
    expect(r.policy).toBeNull(); expect(assessment(r).shortfall.numerator).not.toBe('0');
    expect(assessment(r).status).toBe('TARGET_UNATTAINABLE_IN_ENUMERATED_MODEL');
  });
  it('charges implementation fees and additional terminal debt once against the hurdle', async () => {
    const i = input({ periods: 2 }); i.mandate.utility.operatingProfit.openingCash = 1000;
    i.problem.actions[0].cost = 20; i.problem.actions[0].tailLiability = 10;
    const r = await run(i);
    expect(r.policy).toBeNull(); expect(assessment(r)).toMatchObject({ requiredIncrementalProfit: { numerator: '200' }, bestWorstCaseProfit: { numerator: '170' }, shortfall: { numerator: '30' } });
  });
  it('does not charge common pre-existing terminal obligations twice', async () => {
    const i = input(); i.mandate.utility.tail.terminalLiability = 30;
    const r = await run(i);
    expect(r.status).toBe('POLICY_AVAILABLE'); expect(assessment(r).bestWorstCaseProfit.numerator).toBe('100');
    expect(first(r)).toMatchObject({ closingCash: 470, comparatorClosingCash: 370 });
  });
  it('separates accrual P&L recognition from explicit financing/tax cash payments', async () => {
    const i = input(), p = i.mandate.utility.operatingProfit;
    p.netProfit.financingExpense = constant(10); p.netProfit.incomeTaxExpense = constant(20);
    p.nonOperatingCashOutflow.value = 40; p.cashTaxes.value = 15;
    const r = await run(i);
    expect(r.status).toBe('POLICY_AVAILABLE');
    expect(first(r)).toMatchObject({ netProfit: { profit: 350, comparatorProfit: 250, incrementalProfit: 100 },
      freeCashFlow: 385, nonOperatingNetCashFlow: -40, closingCash: 445 });
    expect(first(r).periods[0].netProfit).toMatchObject({ financingExpense: 10, incomeTaxExpense: 20, profit: 350 });
  });
  it('still rejects a profitable programme that cannot fund working capital', async () => {
    const r = await run(input({ actions: ['cash-trap'] }));
    expect(r.policy).toBeNull(); expect(assessment(r).bestWorstCaseProfit.numerator).toBe('0');
  });
  it('does not turn borrowing into incremental net profit', async () => {
    const i = input({ actions: [] }); i.mandate.utility.operatingProfit.nonOperatingCashInflow.value = 10000;
    const r = await run(i); expect(r.policy).toBeNull(); expect(assessment(r).bestWorstCaseProfit.numerator).toBe('0');
  });
  it('retains uncertainty rather than claiming impossibility after incomplete search', async () => {
    const i = input(); i.mandate.search.maxExpansions = 1; i.problem.actions[0].cost = 1;
    const r = await run(i);
    expect(r.status).toBe('SEARCH_EXHAUSTED'); expect(r.policy).toBeNull();
    expect(assessment(r)).toMatchObject({ status: 'INCUMBENT_BELOW_TARGET_SEARCH_UNRESOLVED', searchComplete: false, modelUpperBound: null });
    expect(assessment(r).shortfall.numerator).not.toBe('0');
  });
  it('retains the target even when no policy satisfies a separate hard risk floor', async () => {
    const i = input(); i.mandate.risk.minimumUtility = 200;
    const r = await run(i);
    expect(r.policy).toBeNull(); expect(assessment(r)).toMatchObject({ status: 'NO_FEASIBLE_INCUMBENT', bestWorstCaseProfit: null, shortfall: null });
  });
  it.each(['missing-net', 'missing-tax', 'missing-revenue-ref', 'wrong-unit', 'wrong-root', 'wrong-horizon', 'zero-revenue', 'below-ten-percent', 'discounted', 'wrong-objective'])('refuses an incomplete or changed economic contract: %s', async defect => {
    const i = input(), p = i.mandate.utility.operatingProfit, target = p.profitTarget;
    if (defect === 'missing-net') delete p.netProfit;
    if (defect === 'missing-tax') delete p.netProfit.incomeTaxExpense;
    if (defect === 'missing-revenue-ref') delete target.revenueBaseline.sourceRef;
    if (defect === 'wrong-unit') target.revenueBaseline.unit = 'EUR';
    if (defect === 'wrong-root') target.revenueBaseline.root = { ...profitRoot, entityId: '99999999-9999-4999-8999-999999999999' };
    if (defect === 'wrong-horizon') target.revenueBaseline.horizon.periods++;
    if (defect === 'zero-revenue') target.revenueBaseline.amount = 0;
    if (defect === 'below-ten-percent') target.minimumBasisPoints = 999;
    if (defect === 'discounted') i.mandate.utility.discountFactors[0] = .99;
    if (defect === 'wrong-objective') p.objective = 'INCREMENTAL_OPERATING_PROFIT';
    await expect(run(i)).rejects.toThrow();
  });
  it('binds net P&L states to the same entity, currency and supported domain', async () => {
    const i = input(); addState(i, 'interest', () => 0);
    i.mandate.utility.operatingProfit.netProfit.financingExpense = { kind: 'STATE', variableId: 'interest', unit: 'USD' };
    i.dynamics.stateRoots.interest = { ...profitRoot, entityId: '99999999-9999-4999-8999-999999999999' };
    await expect(run(i)).rejects.toThrow(/entity/);
    i.dynamics.stateRoots.interest = profitRoot; addState(i, 'interest', () => -1);
    const r = await run(i); expect(r.status).toBe('MODEL_UNSUPPORTED'); expect(r.policy).toBeNull();
  });
  it('carries original net profit into S5 while refusing forged target or P&L certificates', async () => {
    const r = await run(input()), p = r.policy!;
    expect(operatingCashScenarios([p])[0]!.terms[0]!.value).toBe('100');
    expect(p.certificate.operatingProfit!.profitTargetAssessment).toEqual(assessment(r));
    for (const mutation of ['assessment', 'net-ledger', 'net-total', 'remove-assessment']) {
      const forged: any = structuredClone(p), c = forged.certificate.operatingProfit;
      if (mutation === 'assessment') c.profitTargetAssessment.requiredIncrementalProfit.numerator = '1';
      if (mutation === 'net-ledger') c.forecasts[0].periods[0].netProfit.financingExpense = 100;
      if (mutation === 'net-total') c.forecasts[0].netProfit.incrementalProfit = 1000;
      if (mutation === 'remove-assessment') delete c.profitTargetAssessment;
      expect(() => operatingCashScenarios([resealPolicy(forged)])).toThrow();
    }
  });
});
