/** Registered failure model: docs/release/profit-code-quality-2026-10-18.md.
 * These public numerical/certificate boundaries cannot be forced through the
 * immutable owner store without replacing the very storage contract it owns.
 * No private helper, test-only export, or production clock hook is used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContingentPolicy } from '../../packages/shared-types/src/contingent-control';
import { synthesizeContingentControl, decideContingentPolicy } from '../../packages/epistemic-runtime/src/contingent-control';
import { operatingCashScenarios } from '../../packages/epistemic-runtime/src/operating-profit-allocation';
import { epistemicHash } from '../../packages/epistemic-runtime/src/source-precedence';
import { profitInput, profitRef, sealProfitMandate } from '../../scripts/s4/operating-profit-fixtures';

afterEach(() => vi.restoreAllMocks());
function reseal(policy: ContingentPolicy): ContingentPolicy {
  const { ref, ...body } = policy, contentDigest = epistemicHash(body);
  return { ...body, ref: { ...ref, id: `contingent-policy:${contentDigest}`, contentDigest } };
}
async function policyFor(input = profitInput({ actions: ['smart'] })) {
  const result = await synthesizeContingentControl({ ...input, mandate: sealProfitMandate(input.mandate) });
  expect(result.status).toBe('POLICY_AVAILABLE');
  expect(operatingCashScenarios([result.policy!])[0]!.terms[0]!.policyIds).toEqual([result.policy!.ref.id]);
  return structuredClone(result.policy!);
}
const first = (policy: ContingentPolicy) => policy.certificate.operatingProfit!.forecasts[0]!;

describe('search grant and original accounting commitments', () => {
  it('withholds an actionable result when the final model calculation crosses the original deadline', async () => {
    const input = profitInput({ actions: ['smart'] });
    input.problem.actions = [...input.problem.actions.slice(1), input.problem.actions[0]];
    input.mandate.search.deadlineMs = 10;
    let elapsed = 0, slowTransitionObserved = false;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const advance = input.dynamics.advance;
    input.dynamics.advance = (world: any, exposures: any, period: number) => {
      const next = advance(world, exposures, period);
      if (exposures.choice === 2) { slowTransitionObserved = true; elapsed = 11; }
      return next;
    };
    const result = await synthesizeContingentControl({ ...input, mandate: sealProfitMandate(input.mandate) });
    expect(slowTransitionObserved).toBe(true);
    expect(result.status).toBe('SEARCH_EXHAUSTED');
    expect(result.compute.usage.elapsedMs).toBeGreaterThanOrEqual(10);
    if (result.policy) {
      const decision = decideContingentPolicy(result.policy, { knowledgeAt: input.now, period: 0, actionHistory: [], observations: [],
        rightsRef: input.mandate.rightsRef, obligations: [], allocationRefs: [] });
      expect(decision.status).toBe('SEARCH_EXHAUSTED'); expect(decision.actionId).toBeNull();
    }
  });

  it('retains a small stock movement beside a billion-unit inventory balance', async () => {
    const input = profitInput({ actions: ['smart'] });
    input.mandate.utility.operatingProfit.inventory.value = 1e9;
    input.dynamics.initialWorlds[0].history[0].states.ar = .1;
    const advance = input.dynamics.advance;
    input.dynamics.advance = (world: any, exposures: any, period: number) => {
      const next = advance(world, exposures, period); next.history.at(-1).states.ar = exposures.choice ? .2 : .1; return next;
    };
    const policy = await policyFor(input), row = first(policy).periods[0]!;
    expect(row.changeInWorkingCapital).toBe(.1); expect(row.workingCapitalFunding).toBe(.1);
  });

  it('refuses a rehashed ledger that drops positive working-capital funding', async () => {
    const input = profitInput({ actions: ['cash-trap'] }); input.mandate.utility.operatingProfit.openingCash = 1000;
    const policy = await policyFor(input), row = first(policy).periods[0]!;
    expect(row.changeInWorkingCapital).toBe(500); expect(row.workingCapitalFunding).toBe(500);
    row.workingCapitalFunding = 0;
    expect(() => operatingCashScenarios([reseal(policy)])).toThrow();
  });

  it.each(['mandate', 'settled-obligation'])('refuses dropping common %s debt from both paired courses', async source => {
    const input = profitInput({ actions: ['smart'] }), debt = source === 'mandate' ? 30 : 40;
    if (source === 'mandate') input.mandate.utility.tail.terminalLiability = debt;
    else input.problem.obligations = [{ ref: profitRef('settled-debt'), effectRef: profitRef('settled-effect'), actionId: null,
      status: 'SETTLED', exposures: null, resources: null, occupancy: null, lockedExposureIds: null, occupationUntilPeriod: 0, terminalLiability: debt }];
    const policy = await policyFor(input), f = first(policy);
    expect(f.terminalLiability).toBe(debt); expect(f.comparatorTerminalLiability).toBe(debt);
    f.terminalLiability = 0; f.comparatorTerminalLiability = 0; f.closingCash += debt; f.comparatorClosingCash += debt;
    expect(() => operatingCashScenarios([reseal(policy)])).toThrow();
  });

  it('refuses dropping a selected action liability while raising its reported value consistently', async () => {
    const input = profitInput({ actions: ['smart'] }); input.problem.actions[0].tailLiability = 10;
    const policy = await policyFor(input), f = first(policy);
    expect(f.terminalLiability).toBe(10); expect(f.discountedUtility).toBe(90);
    f.terminalLiability = 0; f.closingCash += 10; f.discountedUtility += 10;
    policy.certificate.valueBounds = [100, 100]; policy.certificate.optimalBounds = [100, 100];
    policy.nodes.find(node => node.id === policy.rootNodeId)!.valueBounds = [100, 100];
    expect(() => operatingCashScenarios([reseal(policy)])).toThrow();
  });

  it('refuses consistently removing a charter-declared debt payment from cash', async () => {
    const input = profitInput({ actions: ['smart'] }); input.mandate.utility.operatingProfit.nonOperatingCashOutflow.value = 300;
    const policy = await policyFor(input), f = first(policy), row = f.periods[0]!;
    expect(row.nonOperatingCashOutflow).toBe(300);
    row.nonOperatingCashOutflow = 0; row.nonOperatingNetCashFlow = 0; row.closingCash += 300;
    f.nonOperatingNetCashFlow = 0; f.comparatorNonOperatingNetCashFlow = 0; f.closingCash += 300; f.comparatorClosingCash += 300;
    expect(() => operatingCashScenarios([reseal(policy)])).toThrow();
  });

  it('refuses replacing a charter financing expense with a higher self-consistent profit', async () => {
    const input = profitInput({ actions: ['smart'] }), profile = input.mandate.utility.operatingProfit;
    const c = (value: number) => ({ kind: 'CONSTANT', value, unit: 'USD', sourceRef: profitRef(`expense:${value}`) });
    profile.objective = 'INCREMENTAL_NET_PROFIT';
    profile.netProfit = { schema: 'finnor.s4.net-profit-accounting.v1', financingExpense: c(10), incomeTaxExpense: c(0),
      otherIncome: c(0), otherExpense: c(0), cashTreatment: 'ACCRUAL_PNL_SEPARATE_EXPLICIT_CASH_DRIVERS' };
    const policy = await policyFor(input), f = first(policy), net = f.periods[0]!.netProfit!;
    expect(net.financingExpense).toBe(10); expect(f.netProfit!.incrementalProfit).toBe(100);
    net.financingExpense = 0; net.profit += 10; f.netProfit!.profit += 10; f.netProfit!.incrementalProfit += 10; f.discountedUtility += 10;
    policy.certificate.valueBounds = [110, 110]; policy.certificate.optimalBounds = [110, 110];
    policy.nodes.find(node => node.id === policy.rootNodeId)!.valueBounds = [110, 110];
    expect(() => operatingCashScenarios([reseal(policy)])).toThrow();
  });

  it.each(['revenue', 'nonOperatingNetCashFlow', 'comparatorClosingCash'] as const)('refuses an unreconciled forecast total: %s', async field => {
    const policy = await policyFor(); first(policy)[field] += 1;
    expect(() => operatingCashScenarios([reseal(policy)])).toThrow();
  });
});
