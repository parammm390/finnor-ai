import type { CanonicalAllocationProblem, ContingentPolicy, JointAllocationModel, OperatingProfitForecast } from '@finnor/shared-types';
import { assertContingentPolicy } from './control-contracts';
import { allocationNumber as number, allocationDecimal as decimal, allocationQuantity, AllocationContractError, sameAllocationRef } from './allocation-contracts';
import { ER_ZERO } from './experiment-numerics';

const requireValue = (ok: unknown, reason: string): void => { if (!ok) throw new AllocationContractError('INVALID_REQUEST', reason); };
function forecasts(policy: ContingentPolicy): OperatingProfitForecast[] {
  assertContingentPolicy(policy);
  const f = policy.certificate.operatingProfit?.forecasts;
  requireValue(policy.mandate.utility.operatingProfit && f, 'S5_OPERATING_PROFIT_CERTIFICATE_REQUIRED');
  // This adapter covers alternative whole-entity programmes under one common
  // finite S3 law. It does not compose overlapping businesses or inquiry laws.
  requireValue(!policy.problem.continuation && !policy.problem.observations.length && !policy.problem.actions.some(a => a.kind === 'INQUIRE') &&
    policy.nodes.length === policy.mandate.horizon.periods, 'S5_OPERATING_CASH_CONTINGENT_INFORMATION_ADAPTER_UNAVAILABLE');
  requireValue(new Set(f!.map(x => x.worldId)).size === f!.length, 'S5_OPERATING_CASH_WORLD_IDENTITY_NOT_UNIQUE');
  return f!;
}
export function operatingCashScenarios(policies: ContingentPolicy[]): JointAllocationModel['scenarios'] {
  requireValue(policies.length > 0 && policies.length <= 16, 'S5_OPERATING_CASH_POLICY_BOUND');
  const base = policies[0]!, original = forecasts(base), all = policies.map(p => {
    requireValue(sameAllocationRef(p.mandateRef, base.mandateRef) && sameAllocationRef(p.bindings.dynamicsRef, base.bindings.dynamicsRef) &&
      sameAllocationRef(p.bindings.modelRef, base.bindings.modelRef) && sameAllocationRef(p.problem.baselineExposures, base.problem.baselineExposures),
    'S5_OPERATING_CASH_REQUIRES_SAME_MANDATE_BASELINE_AND_JOINT_WORLD');
    const f = forecasts(p);
    requireValue(f.length === original.length && original.every(x => f.some(y => y.worldId === x.worldId)), 'S5_OPERATING_CASH_WORLD_COVERAGE_DIFFERS');
    return f;
  });
  requireValue(original.length <= 32, 'S5_OPERATING_CASH_WORLD_BOUND');
  return original.map((world, i) => ({ id: `retained-operating-world-${i}`, operatingWorldId: world.worldId,
    sharedMechanismRef: base.bindings.dynamicsRef, baseValue: '0',
    policyPaths: policies.map((p, j) => ({ policyRef: p.ref, nodeIds: all[j]!.find(f => f.worldId === world.worldId)!.nodeIds })),
    terms: policies.map((p, j) => ({ policyIds: [p.ref.id], value: decimal(number(all[j]!.find(f => f.worldId === world.worldId)!.discountedUtility)), evidenceRef: p.ref })) }));
}
export function operatingCashForecast(p: CanonicalAllocationProblem, scenario: JointAllocationModel['scenarios'][number], policy: ContingentPolicy): OperatingProfitForecast {
  const path = scenario.policyPaths.find(x => sameAllocationRef(x.policyRef, policy.ref));
  const found = policy.certificate.operatingProfit?.forecasts.find(f => f.worldId === scenario.operatingWorldId && sameAllocationRef(f.nodeIds, path?.nodeIds));
  requireValue(found, 'S5_OPERATING_CASH_ORIGINAL_WORLD_PATH_MISSING');
  return found!;
}
/** Exact resource mechanics over the retained FLOAT64 model quantities. The
 * scale is explicit; there is no FX, ownership or forecast-proceeds conversion. */
export function operatingFinancialQuantity(p: CanonicalAllocationProblem, value: number) {
  return number(value).mul(number(Number(p.mandate.utility.operatingProfit?.moneyScale ?? '1')));
}
export function operatingCashDemand(p: CanonicalAllocationProblem, scenario: JointAllocationModel['scenarios'][number], policy: ContingentPolicy) {
  const f = operatingCashForecast(p, scenario, policy), scale = number(Number(p.mandate.utility.operatingProfit!.moneyScale));
  const out = f.periods.map(row => [row.variableCost, row.fixedOperatingCost, row.actionCost, row.cashTaxes,
    row.capitalExpenditure, row.workingCapitalFunding, row.nonOperatingCashOutflow].reduce((sum, v) => sum.add(number(v)), ER_ZERO).mul(scale));
  return [...out, ER_ZERO];
}
export function assertOperatingCashCorrespondence(p: CanonicalAllocationProblem): void {
  const profit = p.mandate.utility.operatingProfit;
  if (!profit) {
    requireValue(!p.funding.some(f => f.operatingCash) && !p.jointModel.scenarios.some(s => s.operatingWorldId !== undefined), 'S5_OPERATING_CASH_REQUIRES_PROFILE');
    return;
  }
  const expected = operatingCashScenarios(p.policies), ids = p.policies.map(x => x.ref.id);
  requireValue(p.jointModel.choiceConstraints.some(c => c.maximum === 1 && sameAllocationRef([...c.policyIds].sort(), [...ids].sort())),
    'S5_OPERATING_CASH_EXCLUSIVE_COMPLETE_PROGRAMME_CHOICE_REQUIRED');
  requireValue(p.jointModel.scenarios.length === expected.length && new Set(p.jointModel.scenarios.map(s => s.operatingWorldId)).size === expected.length,
    'S5_OPERATING_CASH_COMPLETE_WORLD_COVERAGE_REQUIRED');
  for (const s of p.jointModel.scenarios) {
    const original = expected.find(x => x.operatingWorldId === s.operatingWorldId);
    requireValue(original && sameAllocationRef(s.sharedMechanismRef, original.sharedMechanismRef) && s.baseValue === '0' && s.terms.length === p.policies.length,
      'S5_OPERATING_CASH_VALUE_OR_MECHANISM_CORRESPONDENCE');
    for (const policy of p.policies) {
      operatingCashForecast(p, s, policy);
      const term = s.terms.find(t => t.policyIds.length === 1 && t.policyIds[0] === policy.ref.id), value = original!.terms.find(t => t.policyIds[0] === policy.ref.id)!;
      requireValue(term && sameAllocationRef(term.evidenceRef, policy.ref) && allocationQuantity(term.value).compare(allocationQuantity(value.value)) === 0,
        'S5_OPERATING_CASH_VALUE_OR_MECHANISM_CORRESPONDENCE');
      const f = p.funding.find(x => sameAllocationRef(x.policyRef, policy.ref)), cash = p.resources.find(r => r.resourceId === f?.operatingCash?.resourceId);
      requireValue(f?.operatingCash?.schema === 'finnor.s5.operating-cash-binding.v1' && f.operatingCash.basis === 'GROSS_OUTFLOWS_NO_FORECAST_PROCEEDS' &&
        f.actionCostResourceId === null && cash && cash.resourceClass === 'CASH' && ['STOCK', 'CUMULATIVE_EXPENDITURE'].includes(cash.kind) &&
        cash.currency === profit.currency && cash.unit === profit.currency && cash.legalEntityRef.id === profit.root.entityId &&
        cash.permittedRoots.some(root => sameAllocationRef(root, profit.root)) &&
        allocationQuantity(cash.safetyMargin).compare(operatingFinancialQuantity(p, profit.minimumCash)) >= 0 &&
        (f.terminalLiabilityResourceId === null || f.terminalLiabilityResourceId === cash.resourceId), 'S5_OPERATING_CASH_EXACT_ENTITY_CURRENCY_FUNDING_AND_FLOOR_REQUIRED');
    }
  }
}
