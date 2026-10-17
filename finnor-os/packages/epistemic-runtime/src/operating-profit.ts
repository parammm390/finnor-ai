import { z } from 'zod';
import type { ControlDynamicsAdapter, ControlWorld, EconomicMandate, OperatingProfitDriver, OperatingProfitObjective, OperatingProfitForecast, OperatingProfitCashPeriod, RevenueProfitAssessment } from '@finnor/shared-types';
import { ExperimentRefSchema } from './experiments';
import { ER_ZERO, ExperimentRational } from './experiment-numerics';

const text = z.string().min(1).max(256), amount = z.number().finite().nonnegative().max(1e9);
const driver = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('STATE'), variableId: text, unit: text }).strict(),
  z.object({ kind: z.literal('CONSTANT'), value: amount, unit: text, sourceRef: ExperimentRefSchema }).strict(),
]);
const root = z.object({ entityType: text, entityId: z.string().uuid() }).strict();
const horizon = z.object({ startAt: z.string().datetime({ offset: true }), periodMs: z.number().int().positive().max(31536000000), periods: z.number().int().min(1).max(24) }).strict();
const netProfitAccounting = z.object({ schema: z.literal('finnor.s4.net-profit-accounting.v1'),
  financingExpense: driver, incomeTaxExpense: driver, otherIncome: driver, otherExpense: driver,
  cashTreatment: z.literal('ACCRUAL_PNL_SEPARATE_EXPLICIT_CASH_DRIVERS') }).strict();
const revenueProfitTarget = z.object({ schema: z.literal('finnor.s4.revenue-profit-target.v1'), minimumBasisPoints: z.number().int().min(1000).max(10000),
  basis: z.literal('INCREMENTAL_NET_PROFIT_LESS_ADDITIONAL_TERMINAL_LIABILITY'), denominator: z.literal('FIXED_PREREGISTERED_REVENUE'),
  revenueBaseline: z.object({ amount: amount.positive(), unit: text, root, horizon, sourceRef: ExperimentRefSchema }).strict(),
  qualification: z.literal('OWNER_BASELINE_ASSERTION_NOT_VERIFIED_REVENUE') }).strict();
export const OperatingProfitObjectiveSchema = z.object({
  schema: z.literal('finnor.s4.operating-profit.v1'), root,
  currency: z.string().regex(/^[A-Z]{3}$/), moneyScale: z.enum(['1', '1000', '1000000', '1000000000']),
  objective: z.enum(['INCREMENTAL_OPERATING_PROFIT', 'INCREMENTAL_FREE_CASH_FLOW', 'INCREMENTAL_NET_PROFIT']),
  netProfit: netProfitAccounting.optional(), profitTarget: revenueProfitTarget.optional(),
  segments: z.array(z.object({ id: text, quantityUnit: text, netUnitPrice: driver, unitsSold: driver, variableUnitCost: driver }).strict()).min(1).max(16),
  fixedOperatingCost: driver, depreciationAmortization: driver,
  accountsReceivable: driver, inventory: driver, accountsPayable: driver, capitalExpenditure: driver, cashTaxes: driver,
  nonOperatingCashInflow: driver, nonOperatingCashOutflow: driver,
  openingCash: amount, minimumCash: amount,
  actionCostTreatment: z.literal('IMMEDIATE_OPERATING_EXPENSE_AND_CASH_OUTFLOW'),
  terminalWorkingCapital: z.literal('NO_AUTOMATIC_RELEASE'),
  qualification: z.literal('OWNER_ACCOUNTING_CONDITIONAL_S3_DYNAMICS_NOT_OBSERVED_VALUE'),
}).strict();
const finite = z.number().finite();
const netComponents = z.object({ financingExpense: finite.nonnegative(), incomeTaxExpense: finite.nonnegative(),
  otherIncome: finite.nonnegative(), otherExpense: finite.nonnegative(), profit: finite }).strict();
const exact = z.object({ numerator: z.string().regex(/^-?\d+$/).max(1024), denominator: z.string().regex(/^[1-9]\d*$/).max(1024),
  display: z.string().max(1024), unit: text }).strict();
const revenueProfitAssessment = z.object({ schema: z.literal('finnor.s4.revenue-profit-assessment.v1'), target: revenueProfitTarget,
  status: z.enum(['TARGET_MET_IN_RETAINED_MODEL', 'TARGET_UNATTAINABLE_IN_ENUMERATED_MODEL', 'INCUMBENT_BELOW_TARGET_SEARCH_UNRESOLVED', 'NO_FEASIBLE_INCUMBENT']),
  requiredIncrementalProfit: exact, bestWorstCaseProfit: exact.nullable(), shortfall: exact.nullable(), searchComplete: z.boolean(), modelUpperBound: exact.nullable(),
  arithmetic: z.literal('EXACT_DECIMAL_COMPARISON_OF_RETAINED_FLOAT64'), qualification: z.literal('FINITE_MODEL_CONDITIONAL_NOT_REALIZED_OR_GUARANTEED') }).strict();
const cashPeriod = z.object({ period: z.number().int().min(0).max(23), revenue: finite.nonnegative(), variableCost: finite.nonnegative(),
  fixedOperatingCost: finite.nonnegative(), depreciationAmortization: finite.nonnegative(), cashTaxes: finite.nonnegative(),
  capitalExpenditure: finite.nonnegative(), actionCost: finite.nonnegative(), workingCapitalFunding: finite.nonnegative(),
  changeInWorkingCapital: finite, operatingProfit: finite, freeCashFlow: finite, nonOperatingCashInflow: finite.nonnegative(),
  nonOperatingCashOutflow: finite.nonnegative(), nonOperatingNetCashFlow: finite,
  comparatorOperatingProfit: finite, comparatorFreeCashFlow: finite, openingCash: finite, cashAfterAction: finite, closingCash: finite,
  netProfit: netComponents.extend({ comparator: netComponents }).strict().optional() }).strict();
export const OperatingProfitCertificateSchema = z.object({
  schema: z.literal('finnor.s4.operating-profit-certificate.v1'), root: OperatingProfitObjectiveSchema.shape.root,
  currency: OperatingProfitObjectiveSchema.shape.currency, moneyScale: OperatingProfitObjectiveSchema.shape.moneyScale,
  unit: text, objective: OperatingProfitObjectiveSchema.shape.objective,
  measure: z.enum(['OPERATING_PROFIT_BEFORE_FINANCING_AND_TAX', 'NET_PROFIT_AFTER_FINANCING_AND_INCOME_TAX']),
  profitTargetAssessment: revenueProfitAssessment.optional(),
  comparator: z.literal('SAME_INITIAL_WORLD_AND_RETAINED_BASELINE_WITH_PENDING_OBLIGATIONS'),
  arithmetic: z.literal('FLOAT64_INHERITS_S3_AND_SEARCH_LIMITATIONS'),
  forecastBasis: z.literal('UNDISCOUNTED_TOTALS_SEPARATE_TERMINAL_LIABILITIES'),
  qualification: z.literal('MODEL_CONDITIONAL_NOT_REALIZED_OR_GUARANTEED'),
  forecasts: z.array(z.object({ worldId: z.string().min(1).max(512), mechanismId: text, nodeIds: z.array(text).min(1).max(24),
    discountedUtility: finite, periods: z.array(cashPeriod).min(1).max(24), revenue: finite.nonnegative(), comparatorRevenue: finite.nonnegative(),
    operatingProfit: finite, comparatorOperatingProfit: finite, incrementalOperatingProfit: finite,
    netProfit: z.object({ profit: finite, comparatorProfit: finite, incrementalProfit: finite }).strict().optional(),
    freeCashFlow: finite, comparatorFreeCashFlow: finite, incrementalFreeCashFlow: finite,
    nonOperatingNetCashFlow: finite, comparatorNonOperatingNetCashFlow: finite,
    implementationCost: finite.nonnegative(), closingCash: finite, comparatorClosingCash: finite,
    minimumCashObserved: finite, terminalLiability: finite.nonnegative(), comparatorTerminalLiability: finite.nonnegative(),
  }).strict()).min(1).max(512),
}).strict();
export const operatingMoneyUnit = (p: OperatingProfitObjective) => p.moneyScale === '1' ? p.currency : `${p.currency}:${p.moneyScale}`;
function bindings(p: OperatingProfitObjective): Array<[OperatingProfitDriver, string]> {
  const unit = operatingMoneyUnit(p);
  return [...p.segments.flatMap(s => [[s.netUnitPrice, `${p.currency}/${s.quantityUnit}`], [s.unitsSold, s.quantityUnit],
    [s.variableUnitCost, `${p.currency}/${s.quantityUnit}`]] as Array<[OperatingProfitDriver, string]>),
  ...[p.fixedOperatingCost, p.depreciationAmortization, p.accountsReceivable, p.inventory, p.accountsPayable,
    p.capitalExpenditure, p.cashTaxes, p.nonOperatingCashInflow, p.nonOperatingCashOutflow,
    ...(p.netProfit ? [p.netProfit.financingExpense, p.netProfit.incomeTaxExpense, p.netProfit.otherIncome, p.netProfit.otherExpense] : [])].map(d => [d, unit] as [OperatingProfitDriver, string])];
}
/** A reason is returned so the owning boundary keeps its own error vocabulary. */
export function operatingProfitContractReason(m: EconomicMandate, dynamics?: ControlDynamicsAdapter): string | null {
  const p = m.utility.operatingProfit;
  if (!p) return null;
  if (m.utility.unit !== operatingMoneyUnit(p) || m.utility.periodTerms.length || m.utility.terminalTerms.length || m.utility.deliberation)
    return 'Operating-profit accounting requires its exact currency/scale unit and excludes duplicate linear or deliberation utility';
  if ((p.objective === 'INCREMENTAL_NET_PROFIT') !== Boolean(p.netProfit))
    return 'Net-profit objective requires explicit financing, income-tax and other P&L accounting';
  if (p.profitTarget) {
    const b = p.profitTarget.revenueBaseline;
    if (p.objective !== 'INCREMENTAL_NET_PROFIT' || m.utility.discountFactors.some(v => v !== 1))
      return 'Revenue profit target requires undiscounted incremental net profit and the additional terminal-liability reserve';
    if (b.unit !== operatingMoneyUnit(p) || b.root.entityType !== p.root.entityType || b.root.entityId !== p.root.entityId ||
      b.horizon.startAt !== m.horizon.startAt || b.horizon.periodMs !== m.horizon.periodMs || b.horizon.periods !== m.horizon.periods)
      return 'Fixed revenue baseline must bind the exact accounting entity, unit and decision horizon';
  }
  if (new Set(p.segments.map(s => s.id)).size !== p.segments.length)
    return 'Operating-profit segments require distinct identities';
  // Sharing a modeled volume driver would recognise that same sale twice.
  const volumes = p.segments.filter(s => s.unitsSold.kind === 'STATE').map(s => (s.unitsSold as { variableId: string }).variableId);
  if (new Set(volumes).size !== volumes.length) return 'Operating-profit sales volume cannot be counted in multiple segments';
  for (const [d, unit] of bindings(p)) {
    if (d.unit !== unit) return 'Operating-profit driver unit/currency/scale does not match its accounting role';
    if (dynamics && d.kind === 'STATE') {
      const root = dynamics.stateRoots?.[d.variableId];
      if (dynamics.stateUnits[d.variableId] !== unit || !root || root.entityType !== p.root.entityType || root.entityId !== p.root.entityId)
        return 'Operating-profit driver must bind the same S3 unit and legal entity';
    }
  }
  return null;
}
export class OperatingProfitDomainError extends Error {}
/** Compare the exact decimal representation of the retained FLOAT64 output.
 * This removes threshold tolerances; it does not certify S3 roundoff, causal
 * identification or real-world profit. Exponents/subnormal inputs remain exact. */
function retainedNumber(v: number): ExperimentRational {
  if (!Number.isFinite(v)) throw new OperatingProfitDomainError('NONFINITE_REVENUE_PROFIT_TARGET_QUANTITY');
  const [mantissa, exponent = '0'] = String(v).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa!.split('.'), n = BigInt(whole! + fraction), places = fraction.length - Number(exponent);
  return places >= 0 ? new ExperimentRational(n, 10n ** BigInt(places)) : new ExperimentRational(n * 10n ** BigInt(-places));
}
export function assessRevenueProfitTarget(m: EconomicMandate, bestWorstCaseProfit: number | null, searchComplete: boolean): RevenueProfitAssessment | undefined {
  const target = m.utility.operatingProfit?.profitTarget;
  if (!target) return undefined;
  const unit = m.utility.unit, required = retainedNumber(target.revenueBaseline.amount).mul(new ExperimentRational(BigInt(target.minimumBasisPoints), 10000n));
  const best = bestWorstCaseProfit === null ? null : retainedNumber(bestWorstCaseProfit), met = best !== null && best.compare(required) >= 0;
  const gap = best === null ? null : met ? ER_ZERO : required.sub(best);
  return { schema: 'finnor.s4.revenue-profit-assessment.v1', target,
    status: met ? 'TARGET_MET_IN_RETAINED_MODEL' : best === null ? 'NO_FEASIBLE_INCUMBENT' : searchComplete ? 'TARGET_UNATTAINABLE_IN_ENUMERATED_MODEL' : 'INCUMBENT_BELOW_TARGET_SEARCH_UNRESOLVED',
    requiredIncrementalProfit: required.exact(unit), bestWorstCaseProfit: best?.exact(unit) ?? null, shortfall: gap?.exact(unit) ?? null,
    searchComplete, modelUpperBound: searchComplete ? best?.exact(unit) ?? null : null,
    arithmetic: 'EXACT_DECIMAL_COMPARISON_OF_RETAINED_FLOAT64', qualification: 'FINITE_MODEL_CONDITIONAL_NOT_REALIZED_OR_GUARANTEED' };
}
function read(d: OperatingProfitDriver, states: Record<string, number>): number {
  const v = d.kind === 'CONSTANT' ? d.value : states[d.variableId];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9)
    throw new OperatingProfitDomainError('OPERATING_PROFIT_DRIVER_OUTSIDE_QUALIFIED_DOMAIN');
  return v;
}
function workingCapital(p: OperatingProfitObjective, states: Record<string, number>): number {
  return read(p.accountsReceivable, states) + read(p.inventory, states) - read(p.accountsPayable, states);
}
/** State values remain conditional FLOAT64 S3 simulations. There is no implicit
 * FX, ownership, financing payment schedule, tax shield or stock liquidation. */
export function operatingProfitPeriod(p: OperatingProfitObjective, previous: Record<string, number>, states: Record<string, number>, actionCost: number) {
  let revenue = 0, variableCost = 0;
  for (const s of p.segments) {
    const units = read(s.unitsSold, states);
    revenue += read(s.netUnitPrice, states) * units / Number(p.moneyScale);
    variableCost += read(s.variableUnitCost, states) * units / Number(p.moneyScale);
  }
  const depreciation = read(p.depreciationAmortization, states), fixedCost = read(p.fixedOperatingCost, states);
  const operatingProfit = revenue - variableCost - fixedCost - depreciation - actionCost;
  const changeInWorkingCapital = workingCapital(p, states) - workingCapital(p, previous);
  const freeCashFlow = operatingProfit + depreciation - read(p.cashTaxes, states) - read(p.capitalExpenditure, states) - changeInWorkingCapital;
  const nonOperatingNetCashFlow = read(p.nonOperatingCashInflow, states) - read(p.nonOperatingCashOutflow, states);
  const workingCapitalFunding = Math.max(0, read(p.accountsReceivable, states) - read(p.accountsReceivable, previous)) +
    Math.max(0, read(p.inventory, states) - read(p.inventory, previous)) + Math.max(0, read(p.accountsPayable, previous) - read(p.accountsPayable, states));
  if (![revenue, variableCost, operatingProfit, freeCashFlow, nonOperatingNetCashFlow, changeInWorkingCapital].every(Number.isFinite))
    throw new OperatingProfitDomainError('OPERATING_PROFIT_NONFINITE_ACCOUNTING');
  let netProfit: z.infer<typeof netComponents> | undefined;
  if (p.netProfit) {
    const financingExpense = read(p.netProfit.financingExpense, states), incomeTaxExpense = read(p.netProfit.incomeTaxExpense, states),
      otherIncome = read(p.netProfit.otherIncome, states), otherExpense = read(p.netProfit.otherExpense, states);
    const profit = operatingProfit - financingExpense - incomeTaxExpense + otherIncome - otherExpense;
    if (!Number.isFinite(profit)) throw new OperatingProfitDomainError('NET_PROFIT_NONFINITE_ACCOUNTING');
    netProfit = { financingExpense, incomeTaxExpense, otherIncome, otherExpense, profit };
  }
  return { revenue, variableCost, operatingProfit, freeCashFlow, nonOperatingNetCashFlow, changeInWorkingCapital,
    ...(netProfit ? { netProfit } : {}),
    fixedOperatingCost: fixedCost, depreciationAmortization: depreciation, cashTaxes: read(p.cashTaxes, states),
    capitalExpenditure: read(p.capitalExpenditure, states), actionCost, workingCapitalFunding,
    nonOperatingCashInflow: read(p.nonOperatingCashInflow, states), nonOperatingCashOutflow: read(p.nonOperatingCashOutflow, states) };
}

export interface OperatingProfitCourse {
  baselineWorld: ControlWorld; baselineSchedule: Record<string, number[]>; commonLiability: number;
  cash: number; baselineCash: number; minimumCashObserved: number;
  revenue: number; baselineRevenue: number; operatingProfit: number; baselineOperatingProfit: number;
  freeCashFlow: number; baselineFreeCashFlow: number; implementationCost: number;
  nonOperatingNetCashFlow: number; baselineNonOperatingNetCashFlow: number;
  netProfit?: { profit: number; comparatorProfit: number; incrementalProfit: number };
  periods: OperatingProfitCashPeriod[];
}
export function openOperatingProfitCourse(p: OperatingProfitObjective, world: ControlWorld, baselineSchedule: Record<string, number[]>, commonLiability: number): OperatingProfitCourse {
  return { baselineWorld: structuredClone(world), baselineSchedule: structuredClone(baselineSchedule), commonLiability,
    cash: p.openingCash, baselineCash: p.openingCash, minimumCashObserved: p.openingCash,
    revenue: 0, baselineRevenue: 0, operatingProfit: 0, baselineOperatingProfit: 0,
    freeCashFlow: 0, baselineFreeCashFlow: 0, implementationCost: 0, nonOperatingNetCashFlow: 0, baselineNonOperatingNetCashFlow: 0,
    ...(p.netProfit ? { netProfit: { profit: 0, comparatorProfit: 0, incrementalProfit: 0 } } : {}), periods: [] };
}
export function advanceOperatingProfitCourse(p: OperatingProfitObjective, dynamics: ControlDynamicsAdapter, old: OperatingProfitCourse,
  previous: ControlWorld, next: ControlWorld, period: number, actionCost: number) {
  const baselineWorld = dynamics.advance(old.baselineWorld,
    Object.fromEntries(dynamics.exposureIds.map(id => [id, old.baselineSchedule[id]![period]!])), period);
  if (!baselineWorld.supported) throw new OperatingProfitDomainError('OPERATING_PROFIT_COMPARATOR_OUTSIDE_JOINT_SUPPORT');
  const states = (w: ControlWorld) => {
    const row = w.history.at(-1);
    if (!row) throw new OperatingProfitDomainError('OPERATING_PROFIT_ACCOUNTING_HISTORY_MISSING');
    return row.states;
  };
  const actual = operatingProfitPeriod(p, states(previous), states(next), actionCost);
  const baseline = operatingProfitPeriod(p, states(old.baselineWorld), states(baselineWorld), 0);
  const cash = old.cash + actual.freeCashFlow + actual.nonOperatingNetCashFlow;
  const { netProfit: actualNet, ...actualOperating } = actual;
  const netProfit = actualNet && baseline.netProfit ? { profit: old.netProfit!.profit + actualNet.profit,
    comparatorProfit: old.netProfit!.comparatorProfit + baseline.netProfit.profit,
    incrementalProfit: (old.netProfit!.profit + actualNet.profit) - (old.netProfit!.comparatorProfit + baseline.netProfit.profit) } : undefined;
  const course: OperatingProfitCourse = { ...old, baselineWorld, cash, baselineCash: old.baselineCash + baseline.freeCashFlow + baseline.nonOperatingNetCashFlow,
    minimumCashObserved: Math.min(old.minimumCashObserved, old.cash - actionCost, cash),
    revenue: old.revenue + actual.revenue, baselineRevenue: old.baselineRevenue + baseline.revenue,
    operatingProfit: old.operatingProfit + actual.operatingProfit, baselineOperatingProfit: old.baselineOperatingProfit + baseline.operatingProfit,
    freeCashFlow: old.freeCashFlow + actual.freeCashFlow, baselineFreeCashFlow: old.baselineFreeCashFlow + baseline.freeCashFlow,
    nonOperatingNetCashFlow: old.nonOperatingNetCashFlow + actual.nonOperatingNetCashFlow,
    baselineNonOperatingNetCashFlow: old.baselineNonOperatingNetCashFlow + baseline.nonOperatingNetCashFlow,
    implementationCost: old.implementationCost + actionCost,
    ...(netProfit ? { netProfit } : {}),
    periods: [...old.periods, { ...actualOperating, ...(actualNet ? { netProfit: { ...actualNet, comparator: baseline.netProfit! } } : {}), period, comparatorOperatingProfit: baseline.operatingProfit,
      comparatorFreeCashFlow: baseline.freeCashFlow, openingCash: old.cash, cashAfterAction: old.cash - actionCost, closingCash: cash }] };
  if (Object.values(course).some(v => typeof v === 'number' && !Number.isFinite(v)))
    throw new OperatingProfitDomainError('OPERATING_PROFIT_NONFINITE_ACCOUNTING');
  const increment = p.objective === 'INCREMENTAL_NET_PROFIT' ? actualNet!.profit - baseline.netProfit!.profit : p.objective === 'INCREMENTAL_OPERATING_PROFIT'
    ? actual.operatingProfit - baseline.operatingProfit : actual.freeCashFlow - baseline.freeCashFlow;
  return { course, increment };
}
export function operatingProfitForecast(course: OperatingProfitCourse, world: ControlWorld, terminalLiability: number, nodeIds: string[], discountedUtility: number): OperatingProfitForecast {
  return { worldId: world.id, mechanismId: world.mechanismId, nodeIds, discountedUtility, periods: course.periods,
    revenue: course.revenue, comparatorRevenue: course.baselineRevenue,
    operatingProfit: course.operatingProfit, comparatorOperatingProfit: course.baselineOperatingProfit,
    incrementalOperatingProfit: course.operatingProfit - course.baselineOperatingProfit,
    ...(course.netProfit ? { netProfit: course.netProfit } : {}),
    freeCashFlow: course.freeCashFlow, comparatorFreeCashFlow: course.baselineFreeCashFlow,
    incrementalFreeCashFlow: course.freeCashFlow - course.baselineFreeCashFlow,
    nonOperatingNetCashFlow: course.nonOperatingNetCashFlow, comparatorNonOperatingNetCashFlow: course.baselineNonOperatingNetCashFlow,
    implementationCost: course.implementationCost,
    closingCash: course.cash - terminalLiability, comparatorClosingCash: course.baselineCash - course.commonLiability,
    minimumCashObserved: Math.min(course.minimumCashObserved, course.cash - terminalLiability),
    terminalLiability, comparatorTerminalLiability: course.commonLiability };
}
