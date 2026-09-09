import { FinnorDecimal, decimalFrom, d, type DecimalString } from "./decimal";
import { fail } from "./errors";
import { daysBetween } from "./periods";
import type { SponsorCashFlow } from "./types";

export type { SponsorCashFlow } from "./types";

export const RETURN_SOLVER_POLICY = Object.freeze({
  minimumRate: "-0.999999999999" as DecimalString,
  maximumRate: "1000" as DecimalString,
  rateTolerance: "0.000000000000000000000001" as DecimalString,
  npvTolerance: "0.000000000000000000000001" as DecimalString,
  maxIterations: 200,
  searchIntervals: 512,
  xirrDayCount: "ACT/365F" as const,
  multipleRootDiscovery: "bounded sign-change scan; even-multiplicity roots without a sign change may be undiscovered" as const,
});

type Exponent = (index: number, flow: SponsorCashFlow) => InstanceType<typeof FinnorDecimal>;

function npv(rate: InstanceType<typeof FinnorDecimal>, flows: readonly SponsorCashFlow[], exponent: Exponent): InstanceType<typeof FinnorDecimal> {
  const base = rate.plus(1);
  if (base.lte(0)) return new FinnorDecimal("NaN");
  let total = new FinnorDecimal(0);
  for (let index = 0; index < flows.length; index += 1) {
    total = total.plus(d(flows[index]!.amount).dividedBy(base.pow(exponent(index, flows[index]!))));
  }
  return total;
}

function signChanges(flows: readonly SponsorCashFlow[]): number {
  let previous = 0;
  let changes = 0;
  for (const flow of flows) {
    const sign = d(flow.amount).comparedTo(0);
    if (sign === 0) continue;
    if (previous !== 0 && sign !== previous) changes += 1;
    previous = sign;
  }
  return changes;
}

let cachedRateGrid: Array<InstanceType<typeof FinnorDecimal>> | undefined;

function rateGrid(): Array<InstanceType<typeof FinnorDecimal>> {
  if (cachedRateGrid) return cachedRateGrid;
  // Search uniformly in log(1+r), which gives deterministic resolution both near
  // -100% and across very high positive return rates.
  const minBase = new FinnorDecimal(1).plus(d(RETURN_SOLVER_POLICY.minimumRate));
  const maxBase = new FinnorDecimal(1).plus(d(RETURN_SOLVER_POLICY.maximumRate));
  const low = minBase.ln();
  const high = maxBase.ln();
  const step = high.minus(low).dividedBy(String(RETURN_SOLVER_POLICY.searchIntervals));
  const output: Array<InstanceType<typeof FinnorDecimal>> = [];
  for (let index = 0; index <= RETURN_SOLVER_POLICY.searchIntervals; index += 1) {
    output.push(low.plus(step.times(String(index))).exp().minus(1));
  }
  cachedRateGrid = output;
  return cachedRateGrid;
}

function bisection(
  lower: InstanceType<typeof FinnorDecimal>,
  upper: InstanceType<typeof FinnorDecimal>,
  flows: readonly SponsorCashFlow[],
  exponent: Exponent,
): InstanceType<typeof FinnorDecimal> {
  let left = lower;
  let right = upper;
  let leftValue = npv(left, flows, exponent);
  const scale = FinnorDecimal.max(...flows.map((flow) => d(flow.amount).abs()), new FinnorDecimal(1));
  const npvTolerance = d(RETURN_SOLVER_POLICY.npvTolerance).times(scale);
  for (let iteration = 0; iteration < RETURN_SOLVER_POLICY.maxIterations; iteration += 1) {
    const midpoint = left.plus(right).dividedBy(2);
    const value = npv(midpoint, flows, exponent);
    if (value.abs().lte(npvTolerance) || right.minus(left).abs().lte(d(RETURN_SOLVER_POLICY.rateTolerance))) return midpoint;
    if (leftValue.comparedTo(0) === value.comparedTo(0)) {
      left = midpoint;
      leftValue = value;
    } else {
      right = midpoint;
    }
  }
  fail("NON_CONVERGENT", "IRR solver did not converge within the iteration limit", { maxIterations: RETURN_SOLVER_POLICY.maxIterations });
}

function solve(flows: readonly SponsorCashFlow[], exponent: Exponent): DecimalString {
  const variations = signChanges(flows);
  if (flows.length < 2 || variations === 0) fail("IRR_UNDEFINED", "IRR requires at least one positive and one negative sponsor cash flow");
  if (variations === 1) {
    const lower = d(RETURN_SOLVER_POLICY.minimumRate);
    const upper = d(RETURN_SOLVER_POLICY.maximumRate);
    const lowerValue = npv(lower, flows, exponent);
    const upperValue = npv(upper, flows, exponent);
    if (lowerValue.isFinite() && upperValue.isFinite() && lowerValue.comparedTo(0) !== upperValue.comparedTo(0)) {
      return decimalFrom(bisection(lower, upper, flows, exponent));
    }
    fail("IRR_UNDEFINED", "No IRR root was found in the supported domain", { minimumRate: RETURN_SOLVER_POLICY.minimumRate, maximumRate: RETURN_SOLVER_POLICY.maximumRate });
  }
  const grid = rateGrid();
  const brackets: Array<[InstanceType<typeof FinnorDecimal>, InstanceType<typeof FinnorDecimal>]> = [];
  const exact: Array<InstanceType<typeof FinnorDecimal>> = [];
  let previousRate = grid[0]!;
  let previousValue = npv(previousRate, flows, exponent);
  for (let index = 1; index < grid.length; index += 1) {
    const rate = grid[index]!;
    const value = npv(rate, flows, exponent);
    if (previousValue.isFinite() && previousValue.isZero()) exact.push(previousRate);
    if (previousValue.isFinite() && value.isFinite() && previousValue.comparedTo(0) !== value.comparedTo(0)) brackets.push([previousRate, rate]);
    previousRate = rate;
    previousValue = value;
  }
  if (previousValue.isFinite() && previousValue.isZero()) exact.push(previousRate);
  const roots = [...exact, ...brackets.map(([left, right]) => bisection(left, right, flows, exponent))]
    .sort((left, right) => left.comparedTo(right))
    .filter((root, index, all) => index === 0 || root.minus(all[index - 1]!).abs().gt(d(RETURN_SOLVER_POLICY.rateTolerance).times(10)));
  if (!roots.length) fail("IRR_UNDEFINED", "No IRR root was found in the supported domain", { minimumRate: RETURN_SOLVER_POLICY.minimumRate, maximumRate: RETURN_SOLVER_POLICY.maximumRate });
  if (roots.length > 1) fail("IRR_AMBIGUOUS", "Multiple economically supported IRR roots were detected", { roots: roots.map(decimalFrom) });
  return decimalFrom(roots[0]!);
}

export function solvePeriodicIrr(flows: readonly SponsorCashFlow[]): DecimalString {
  return solve(flows, (index) => new FinnorDecimal(String(index)));
}

export function annualizePeriodicIrr(periodicRate: DecimalString, periodsPerYear: number): DecimalString {
  if (![1, 4, 12].includes(periodsPerYear)) fail("INVALID_PERIOD", "Unsupported periods-per-year annualization", { periodsPerYear });
  return decimalFrom(d(periodicRate).plus(1).pow(String(periodsPerYear)).minus(1));
}

export function solveXirr(flows: readonly SponsorCashFlow[]): DecimalString {
  if (!flows.length) fail("IRR_UNDEFINED", "XIRR requires cash flows");
  const firstDate = flows[0]!.date;
  for (let index = 1; index < flows.length; index += 1) {
    if (daysBetween(flows[index - 1]!.date, flows[index]!.date) < 0) fail("INVALID_PERIOD", "XIRR cash flows must be in date order");
  }
  return solve(flows, (_index, flow) => new FinnorDecimal(String(daysBetween(firstDate, flow.date))).dividedBy(365));
}
