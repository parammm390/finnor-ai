/** Failure model, registered before implementation:
 * - revenue/volume wins despite lower contribution, or private worlds leak into choice;
 * - accrual profit hides working-capital insolvency, or terminal stock is invented as cash;
 * - costs/tail debt disappear, duplicate, or are charged again after commitment;
 * - comparator worlds, pending schedules, units, currency, scale or legal entities drift;
 * - missing/negative/nonfinite drivers become zero, support failure becomes success;
 * - incomplete nonlinear search claims a linear zero-gap upper bound;
 * - legacy/exact/S5 consumers silently ignore nonlinear accounting;
 * - a conditional model is represented as realised profit or execution authority.
 */
import { describe, it, expect } from 'vitest';
import { synthesizeContingentControl, decideContingentPolicy } from '../../packages/epistemic-runtime/src/contingent-control';
import { parseEconomicMandate, assertContingentPolicy } from '../../packages/epistemic-runtime/src/control-contracts';
import { profitInput, profitRoot, sealProfitMandate } from '../../scripts/s4/operating-profit-fixtures';

const reseal = (input: any) => { input.mandate = sealProfitMandate(input.mandate); return input; };
const selected = (r: any) => r.policy?.nodes.find((n: any) => n.id === r.policy.rootNodeId);
const forecast = (r: any) => r.policy.certificate.operatingProfit.forecasts[0];
describe('operating-profit decision path', () => {
  it('rejects revenue growth that destroys contribution and selects actual incremental operating profit', async () => {
    const r = await synthesizeContingentControl(profitInput());
    expect(r.status).toBe('POLICY_AVAILABLE'); expect(selected(r).actionId).toBe('smart');
    expect(selected(r).alternatives.find((a: any) => a.actionId === 'grow').valueBounds).toEqual([-100, -100]);
    expect(r.policy!.certificate.valueBounds).toEqual([100, 100]);
    expect(forecast(r)).toMatchObject({ operatingProfit: 380, comparatorOperatingProfit: 280, incrementalOperatingProfit: 100,
      freeCashFlow: 400, comparatorFreeCashFlow: 300, incrementalFreeCashFlow: 100, closingCash: 500 });
    expect(r.policy!.admission.executionAuthorityGranted).toBe(false); expect(() => assertContingentPolicy(r.policy)).not.toThrow();
    expect(r.compute.backend.sourceDigests.some(s => s.path.endsWith('/operating-profit.ts'))).toBe(true);
  });
  it('keeps do-nothing when every growth action destroys profit', async () => {
    const r = await synthesizeContingentControl(profitInput({ actions: ['grow'] }));
    expect(r.status).toBe('POLICY_AVAILABLE'); expect(['wait', 'stop']).toContain(selected(r).actionId);
    expect(r.policy!.certificate.valueBounds).toEqual([0, 0]);
  });
  it('rejects a profitable action that breaches cash before collections', async () => {
    const r = await synthesizeContingentControl(profitInput({ actions: ['cash-trap'] }));
    expect(r.status).toBe('POLICY_AVAILABLE'); expect(['wait', 'stop']).toContain(selected(r).actionId);
    expect(selected(r).alternatives.find((a: any) => a.actionId === 'cash-trap')).toMatchObject({ status: 'INFEASIBLE', valueBounds: null });
  });
  it('uses the joint worst case without reading a private scenario ID to decide', async () => {
    const input = profitInput({ actions: ['smart'], worlds: ['base', 'adverse'] });
    const r = await synthesizeContingentControl(input);
    expect(r.status).toBe('POLICY_AVAILABLE'); expect(['wait', 'stop']).toContain(selected(r).actionId);
    expect(selected(r).alternatives.find((a: any) => a.actionId === 'smart').valueBounds).toEqual([-50, -50]);
    expect(r.policy!.certificate.operatingProfit!.forecasts).toHaveLength(2);
  });
  it('charges implementation once and retains the action tail in value and closing cash', async () => {
    const input = profitInput({ periods: 2, actions: ['smart'] });
    input.mandate.utility.operatingProfit.openingCash = 1000;
    input.problem.actions[0].cost = 150; input.problem.actions[0].tailLiability = 10;
    const r = await synthesizeContingentControl(reseal(input));
    expect(selected(r).actionId).toBe('smart'); expect(r.policy!.certificate.valueBounds).toEqual([40, 40]);
    expect(forecast(r)).toMatchObject({ incrementalOperatingProfit: 50, incrementalFreeCashFlow: 50, implementationCost: 150,
      terminalLiability: 10, comparatorTerminalLiability: 0, closingCash: 1640 });
  });
  it('does not double-charge common pending terminal debt in incremental utility', async () => {
    const input = profitInput({ actions: ['smart'] });
    input.mandate.utility.tail.terminalLiability = 30;
    const r = await synthesizeContingentControl(reseal(input));
    expect(r.policy!.certificate.valueBounds).toEqual([100, 100]);
    expect(forecast(r)).toMatchObject({ terminalLiability: 30, comparatorTerminalLiability: 30, closingCash: 470 });
  });
  it('preserves pending baseline schedules in the paired comparator', async () => {
    const input = profitInput({ actions: [] });
    input.problem.obligations = [{ ref: input.mandate.utilityRef, effectRef: input.mandate.utilityRef, actionId: null,
      status: 'KNOWN_PENDING', exposures: { choice: [2] }, resources: { capacity: 0 }, occupancy: { capacity: 0 },
      lockedExposureIds: ['choice'], occupationUntilPeriod: 1, terminalLiability: 0 }];
    const r = await synthesizeContingentControl(input);
    expect(r.status).toBe('POLICY_AVAILABLE'); expect(r.policy!.certificate.valueBounds).toEqual([0, 0]);
    expect(forecast(r)).toMatchObject({ operatingProfit: 380, comparatorOperatingProfit: 380, incrementalOperatingProfit: 0 });
  });
  it('carries working-capital stock between periods and does not release it automatically at the horizon', async () => {
    const input = profitInput({ periods: 2, actions: ['cash-trap'] });
    input.mandate.utility.operatingProfit.openingCash = 1000;
    const r = await synthesizeContingentControl(reseal(input));
    expect(selected(r).actionId).toBe('cash-trap'); expect(forecast(r)).toMatchObject({ incrementalOperatingProfit: 200, incrementalFreeCashFlow: -300 });
    input.mandate.utility.operatingProfit.objective = 'INCREMENTAL_FREE_CASH_FLOW';
    const cash = await synthesizeContingentControl(reseal(input));
    expect(['wait', 'stop']).toContain(selected(cash).actionId); expect(cash.policy!.certificate.valueBounds).toEqual([0, 0]);
  });
  it('recognizes collection when the actual modeled receivable stock falls', async () => {
    const input = profitInput({ periods: 2, actions: ['cash-trap'] });
    input.mandate.utility.operatingProfit.openingCash = 1000;
    const advance = input.dynamics.advance;
    input.dynamics.advance = (w: any, e: any, t: number) => { const next = advance(w, e, t); if (t === 1) next.history.at(-1).states.ar = 100; return next; };
    const r = await synthesizeContingentControl(reseal(input));
    expect(forecast(r).incrementalFreeCashFlow).toBe(200);
  });
  it('models 100 billion dollars of sales with explicit million-dollar scaling', async () => {
    const input = profitInput({ actions: ['smart'] }), p = input.mandate.utility.operatingProfit;
    p.moneyScale = '1000000'; input.mandate.utility.unit = 'USD:1000000';
    for (const key of ['fixedOperatingCost', 'depreciationAmortization', 'accountsReceivable', 'inventory', 'accountsPayable', 'capitalExpenditure', 'cashTaxes']) {
      p[key].unit = 'USD:1000000'; if (p[key].kind === 'CONSTANT') p[key].value = 0;
    }
    input.dynamics.stateUnits.ar = 'USD:1000000';
    input.dynamics.stateRanges = { price: [0, 2000], units: [0, 1000000000], ar: [0, 1] };
    input.dynamics.initialWorlds[0].history[0].states = { price: 1000, units: 100000000, ar: 0 };
    input.dynamics.advance = (w: any, e: any) => ({ ...w, history: [...w.history, { states: { price: e.choice ? 1010 : 1000, units: 100000000, ar: 0 }, exposures: e }] });
    for (const a of input.problem.actions) a.costUnit = 'USD:1000000';
    const r = await synthesizeContingentControl(reseal(input));
    expect(r.policy!.certificate.valueBounds).toEqual([1000, 1000]);
    expect(r.policy!.certificate.operatingProfit).toMatchObject({ currency: 'USD', moneyScale: '1000000', unit: 'USD:1000000' });
  });
  it('retains nonlinear upper-bound uncertainty after search exhaustion', async () => {
    const input = profitInput(); input.mandate.search.maxExpansions = 1;
    const r = await synthesizeContingentControl(reseal(input));
    expect(r.status).toBe('SEARCH_EXHAUSTED'); expect(r.policy).not.toBeNull();
    expect(r.policy!.certificate.optimalBounds[1]).toBeNull(); expect(r.policy!.certificate.normalizedRegretBounds[1]).toBeNull();
    const decision = decideContingentPolicy(r.policy!, { knowledgeAt: input.now, period: 0, actionHistory: [], observations: [],
      rightsRef: input.mandate.rightsRef, obligations: [], allocationRefs: [] });
    expect(decision.actionId).toBeNull();
  });
  it.each(['missing', 'negative', 'nonfinite'])('withholds activation for %s modeled drivers', async mode => {
    const input = profitInput(), advance = input.dynamics.advance;
    input.dynamics.advance = (w: any, e: any, t: number) => { const n = advance(w, e, t); if (e.choice === 2) {
      if (mode === 'missing') delete n.history.at(-1).states.units;
      else n.history.at(-1).states.units = mode === 'negative' ? -1 : NaN;
    } return n; };
    const r = await synthesizeContingentControl(input);
    expect(r.status).toBe('MODEL_UNSUPPORTED'); expect(r.policy!.certificate.completeSearch).toBe(false);
  });
  it.each(['currency', 'unit', 'root', 'missing-root'])('refuses an invalid %s binding', async mode => {
    const input = profitInput();
    if (mode === 'currency') input.mandate.utility.operatingProfit.currency = 'EUR';
    if (mode === 'unit') input.dynamics.stateUnits.units = 'USD';
    if (mode === 'root') input.dynamics.stateRoots.price = { ...profitRoot, entityId: '44444444-4444-4444-8444-444444444444' };
    if (mode === 'missing-root') delete input.dynamics.stateRoots;
    await expect(synthesizeContingentControl(reseal(input))).rejects.toThrow();
  });
  it('refuses duplicate segment revenue and legacy linear utility double-counting', async () => {
    const duplicate = profitInput(); duplicate.mandate.utility.operatingProfit.segments.push(structuredClone(duplicate.mandate.utility.operatingProfit.segments[0]));
    await expect(synthesizeContingentControl(reseal(duplicate))).rejects.toThrow();
    const linear = profitInput(); linear.mandate.utility.periodTerms = [{ variableId: 'ar', unit: 'USD', coefficient: 1 }];
    await expect(synthesizeContingentControl(reseal(linear))).rejects.toThrow();
  });
  it('requires explicit consumer support and refuses unqualified continuation accounting', async () => {
    const input = profitInput({ periods: 2 });
    expect(() => parseEconomicMandate(input.mandate)).toThrow(/operating.profit/i);
    input.problem.continuation = { elapsedPeriods: 1, actionHistory: ['wait'], observations: [],
      accruedUtility: { value: 0, unit: 'USD', sourceRef: input.mandate.utilityRef }, usedResources: { capacity: 0 }, humanSeconds: 0, accountingRef: input.mandate.utilityRef };
    input.now = new Date(Date.parse(input.now) + 60000).toISOString();
    await expect(synthesizeContingentControl(input)).rejects.toThrow(/continuation/i);
  });
});
