import { z } from 'zod';
import type { ControlDynamicsAdapter, ControlWorld, EconomicMandate, OperatingProfitDriver, OperatingProfitObjective, OperatingProfitForecast } from '@finnor/shared-types';
import { ExperimentRefSchema } from './experiments';

const text = z.string().min(1).max(256), amount = z.number().finite().nonnegative().max(1e9);
const driver = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('STATE'), variableId: text, unit: text }).strict(),
  z.object({ kind: z.literal('CONSTANT'), value: amount, unit: text, sourceRef: ExperimentRefSchema }).strict(),
]);
export const OperatingProfitObjectiveSchema = z.object({
  schema: z.literal('finnor.s4.operating-profit.v1'), root: z.object({ entityType: text, entityId: z.string().uuid() }).strict(),
  currency: z.string().regex(/^[A-Z]{3}$/), moneyScale: z.enum(['1', '1000', '1000000', '1000000000']),
  objective: z.enum(['INCREMENTAL_OPERATING_PROFIT', 'INCREMENTAL_FREE_CASH_FLOW']),
  segments: z.array(z.object({ id: text, quantityUnit: text, netUnitPrice: driver, unitsSold: driver, variableUnitCost: driver }).strict()).min(1).max(16),
  fixedOperatingCost: driver, depreciationAmortization: driver,
  accountsReceivable: driver, inventory: driver, accountsPayable: driver, capitalExpenditure: driver, cashTaxes: driver,
  openingCash: amount, minimumCash: amount,
  actionCostTreatment: z.literal('IMMEDIATE_OPERATING_EXPENSE_AND_CASH_OUTFLOW'),
  terminalWorkingCapital: z.literal('NO_AUTOMATIC_RELEASE'),
  qualification: z.literal('OWNER_ACCOUNTING_CONDITIONAL_S3_DYNAMICS_NOT_OBSERVED_VALUE'),
}).strict();
const finite = z.number().finite();
export const OperatingProfitCertificateSchema = z.object({
  schema: z.literal('finnor.s4.operating-profit-certificate.v1'), root: OperatingProfitObjectiveSchema.shape.root,
  currency: OperatingProfitObjectiveSchema.shape.currency, moneyScale: OperatingProfitObjectiveSchema.shape.moneyScale,
  unit: text, objective: OperatingProfitObjectiveSchema.shape.objective,
  measure: z.literal('OPERATING_PROFIT_BEFORE_FINANCING_AND_TAX'),
  comparator: z.literal('SAME_INITIAL_WORLD_AND_RETAINED_BASELINE_WITH_PENDING_OBLIGATIONS'),
  arithmetic: z.literal('FLOAT64_INHERITS_S3_AND_SEARCH_LIMITATIONS'),
  forecastBasis: z.literal('UNDISCOUNTED_TOTALS_SEPARATE_TERMINAL_LIABILITIES'),
  qualification: z.literal('MODEL_CONDITIONAL_NOT_REALIZED_OR_GUARANTEED'),
  forecasts: z.array(z.object({ worldId: text, mechanismId: text, revenue: finite.nonnegative(), comparatorRevenue: finite.nonnegative(),
    operatingProfit: finite, comparatorOperatingProfit: finite, incrementalOperatingProfit: finite,
    freeCashFlow: finite, comparatorFreeCashFlow: finite, incrementalFreeCashFlow: finite,
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
    p.capitalExpenditure, p.cashTaxes].map(d => [d, unit] as [OperatingProfitDriver, string])];
}
/** A reason is returned so the owning boundary keeps its own error vocabulary. */
export function operatingProfitContractReason(m: EconomicMandate, dynamics?: ControlDynamicsAdapter): string | null {
  const p = m.utility.operatingProfit;
  if (!p) return null;
  if (m.utility.unit !== operatingMoneyUnit(p) || m.utility.periodTerms.length || m.utility.terminalTerms.length || m.utility.deliberation)
    return 'Operating-profit accounting requires its exact currency/scale unit and excludes duplicate linear or deliberation utility';
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
 * FX, ownership, debt service, tax shield, terminal sale or stock liquidation. */
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
  if (![revenue, variableCost, operatingProfit, freeCashFlow, changeInWorkingCapital].every(Number.isFinite))
    throw new OperatingProfitDomainError('OPERATING_PROFIT_NONFINITE_ACCOUNTING');
  return { revenue, variableCost, operatingProfit, freeCashFlow, changeInWorkingCapital };
}

export interface OperatingProfitCourse {
  baselineWorld: ControlWorld; baselineSchedule: Record<string, number[]>; commonLiability: number;
  cash: number; baselineCash: number; minimumCashObserved: number;
  revenue: number; baselineRevenue: number; operatingProfit: number; baselineOperatingProfit: number;
  freeCashFlow: number; baselineFreeCashFlow: number; implementationCost: number;
}
export function openOperatingProfitCourse(p: OperatingProfitObjective, world: ControlWorld, baselineSchedule: Record<string, number[]>, commonLiability: number): OperatingProfitCourse {
  return { baselineWorld: structuredClone(world), baselineSchedule: structuredClone(baselineSchedule), commonLiability,
    cash: p.openingCash, baselineCash: p.openingCash, minimumCashObserved: p.openingCash,
    revenue: 0, baselineRevenue: 0, operatingProfit: 0, baselineOperatingProfit: 0,
    freeCashFlow: 0, baselineFreeCashFlow: 0, implementationCost: 0 };
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
  const cash = old.cash + actual.freeCashFlow;
  const course: OperatingProfitCourse = { ...old, baselineWorld, cash, baselineCash: old.baselineCash + baseline.freeCashFlow,
    minimumCashObserved: Math.min(old.minimumCashObserved, cash),
    revenue: old.revenue + actual.revenue, baselineRevenue: old.baselineRevenue + baseline.revenue,
    operatingProfit: old.operatingProfit + actual.operatingProfit, baselineOperatingProfit: old.baselineOperatingProfit + baseline.operatingProfit,
    freeCashFlow: old.freeCashFlow + actual.freeCashFlow, baselineFreeCashFlow: old.baselineFreeCashFlow + baseline.freeCashFlow,
    implementationCost: old.implementationCost + actionCost };
  if (Object.values(course).some(v => typeof v === 'number' && !Number.isFinite(v)))
    throw new OperatingProfitDomainError('OPERATING_PROFIT_NONFINITE_ACCOUNTING');
  const increment = p.objective === 'INCREMENTAL_OPERATING_PROFIT'
    ? actual.operatingProfit - baseline.operatingProfit : actual.freeCashFlow - baseline.freeCashFlow;
  return { course, increment };
}
export function operatingProfitForecast(course: OperatingProfitCourse, world: ControlWorld, terminalLiability: number): OperatingProfitForecast {
  return { worldId: world.id, mechanismId: world.mechanismId,
    revenue: course.revenue, comparatorRevenue: course.baselineRevenue,
    operatingProfit: course.operatingProfit, comparatorOperatingProfit: course.baselineOperatingProfit,
    incrementalOperatingProfit: course.operatingProfit - course.baselineOperatingProfit,
    freeCashFlow: course.freeCashFlow, comparatorFreeCashFlow: course.baselineFreeCashFlow,
    incrementalFreeCashFlow: course.freeCashFlow - course.baselineFreeCashFlow,
    implementationCost: course.implementationCost,
    closingCash: course.cash - terminalLiability, comparatorClosingCash: course.baselineCash - course.commonLiability,
    minimumCashObserved: Math.min(course.minimumCashObserved, course.cash - terminalLiability),
    terminalLiability, comparatorTerminalLiability: course.commonLiability };
}
