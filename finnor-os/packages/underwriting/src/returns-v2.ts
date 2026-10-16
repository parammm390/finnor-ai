import { FinnorDecimal, d, decimalFrom, type DecimalString } from "./decimal";
import { fail } from "./errors";
import { daysBetween } from "./periods";
import { RETURN_SOLVER_POLICY } from "./returns";
import type { NativeReturnTrace, SponsorCashFlow } from "./types";

/** Explicit new native operation; never an alias for returns.ts v1 arithmetic.
 * Every multiplication/addition/division below uses the existing live native
 * Decimal34 HALF_EVEN clone, including its original exponent saturation. */
export const NATIVE_RETURN_METHOD_V2 = "decimal34_horner_npv_v2" as const;
export const NATIVE_RETURN_V2_POLICY = Object.freeze({
  method: NATIVE_RETURN_METHOD_V2,
  periodicNpv: "ORDERED_BASE_HORNER_DECIMAL34_V2",
  datedNpv: "ACT365F_DAILY_BASE_HORNER_DECIMAL34_V2",
  naturalPower: "SQUARE_AND_MULTIPLY_DECIMAL34_V2",
  periodicAnnualization: "DECLARED_FREQUENCY_SQUARE_AND_MULTIPLY_DECIMAL34_V2",
  dailyRoot: "BOUNDED_365TH_POWER_BRACKET_DECIMAL34_V2",
  dailyRootWidth: "0.00000000000000000000000000000001",
  maximumNaturalExponent: 5000,
  maximumFlows: 13,
  minimumRate: RETURN_SOLVER_POLICY.minimumRate,
  maximumRate: RETURN_SOLVER_POLICY.maximumRate,
  rateTolerance: RETURN_SOLVER_POLICY.rateTolerance,
  npvTolerance: RETURN_SOLVER_POLICY.npvTolerance,
  maxIterations: RETURN_SOLVER_POLICY.maxIterations,
  npvToleranceBasis: "HORNER_NUMERATOR_TIMES_NATIVE_CASH_FLOW_SCALE",
  supportedSigns: "ONE_NEGATIVE_INITIAL_FLOW_NONNEGATIVE_FUTURE_FLOWS",
});

/** This ordered power is a v2 primitive, not a claim about vendor pow(). */
export function naturalPower34V2(base: InstanceType<typeof FinnorDecimal>, exponent: number): InstanceType<typeof FinnorDecimal> {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > NATIVE_RETURN_V2_POLICY.maximumNaturalExponent) {
    fail("INVALID_PERIOD", "Versioned native power exponent is outside its bound", { exponent });
  }
  let power = exponent, factor = new FinnorDecimal(base), value = new FinnorDecimal(1);
  while (power > 0) {
    if (power % 2 === 1) value = value.times(factor);
    power = Math.floor(power / 2);
    if (power > 0) factor = factor.times(factor);
  }
  return value;
}

function dailyBracket(target: InstanceType<typeof FinnorDecimal>): NativeReturnTrace["dailyBrackets"][number] {
  let left = new FinnorDecimal(0);
  let right = new FinnorDecimal(target.lte(1) ? 1 : 2);
  const steps: NativeReturnTrace["dailyBrackets"][number]["steps"] = [];
  for (let iteration = 0; iteration < NATIVE_RETURN_V2_POLICY.maxIterations; iteration += 1) {
    const midpoint = left.plus(right).dividedBy(2);
    if (right.minus(left).lte(d(NATIVE_RETURN_V2_POLICY.dailyRootWidth))
      || midpoint.eq(left) || midpoint.eq(right)) {
      return { target: target.toFixed(), left: left.toFixed(), right: right.toFixed(), steps };
    }
    const power = naturalPower34V2(midpoint, 365);
    const side = power.lte(target) ? "LEFT" as const : "RIGHT" as const;
    steps.push({ left: left.toFixed(), right: right.toFixed(), midpoint: midpoint.toFixed(),
      power: power.toFixed(), side });
    if (side === "LEFT") left = midpoint;
    else right = midpoint;
  }
  fail("NON_CONVERGENT", "Versioned native daily-root bracket did not converge");
}

function solve(flows: readonly SponsorCashFlow[], mode: NativeReturnTrace["mode"]): {
  rate: DecimalString; trace: NativeReturnTrace;
} {
  if (flows.length < 2 || flows.length > NATIVE_RETURN_V2_POLICY.maximumFlows
    || !d(flows[0]!.amount).lt(0)
    || flows.slice(1).some(flow => d(flow.amount).lt(0))
    || !flows.slice(1).some(flow => d(flow.amount).gt(0))) {
    fail("IRR_UNDEFINED", "Versioned native Horner return requires one negative initial and nonnegative future flows");
  }
  const gaps = flows.slice(1).map((flow, index) => mode === "PERIODIC" ? 1
    : daysBetween(flows[index]!.date, flow.date));
  if (gaps.some(gap => gap < 0 || gap > NATIVE_RETURN_V2_POLICY.maximumNaturalExponent)
    || gaps.reduce((total, gap) => total + gap, 0) > NATIVE_RETURN_V2_POLICY.maximumNaturalExponent) {
    fail("INVALID_PERIOD", "Versioned dated returns require an ordered bounded ACT/365F timeline");
  }
  const dailyBrackets = mode === "ACT365F_DAILY" ? [
    dailyBracket(d(NATIVE_RETURN_V2_POLICY.minimumRate).plus(1)),
    dailyBracket(d(NATIVE_RETURN_V2_POLICY.maximumRate).plus(1)),
  ] : [];
  let left = mode === "PERIODIC" ? d(NATIVE_RETURN_V2_POLICY.minimumRate).plus(1) : d(dailyBrackets[0]!.left);
  let right = mode === "PERIODIC" ? d(NATIVE_RETURN_V2_POLICY.maximumRate).plus(1) : d(dailyBrackets[1]!.right);
  const trace: NativeReturnTrace = {
    method: NATIVE_RETURN_METHOD_V2, mode, gaps, dailyBrackets,
    npvs: [], iterations: [], finalBase: null, rate: null,
  };
  const npv = (base: InstanceType<typeof FinnorDecimal>): InstanceType<typeof FinnorDecimal> => {
    if (base.lte(0)) fail("IRR_UNDEFINED", "Versioned native return base must be positive");
    let total = d(flows[0]!.amount);
    const powers: string[] = [], partials: string[] = [total.toFixed()];
    for (let index = 1; index < flows.length; index += 1) {
      const power = naturalPower34V2(base, gaps[index - 1]!);
      total = total.times(power).plus(d(flows[index]!.amount));
      powers.push(power.toFixed()); partials.push(total.toFixed());
    }
    trace.npvs.push({ base: base.toFixed(), powers, partials });
    return total;
  };
  let leftValue = npv(left);
  const rightValue = npv(right);
  if (!leftValue.isFinite() || !rightValue.isFinite() || leftValue.comparedTo(0) === rightValue.comparedTo(0)) {
    fail("IRR_UNDEFINED", "No versioned native Horner root in the original annual/periodic rate domain", {
      method: NATIVE_RETURN_METHOD_V2, mode, minimumRate: NATIVE_RETURN_V2_POLICY.minimumRate,
      maximumRate: NATIVE_RETURN_V2_POLICY.maximumRate, lowerNpv: leftValue.toFixed(), upperNpv: rightValue.toFixed(),
    });
  }
  const scale = FinnorDecimal.max(...flows.map(flow => d(flow.amount).abs()), new FinnorDecimal(1));
  const npvTolerance = d(NATIVE_RETURN_V2_POLICY.npvTolerance).times(scale);
  for (let iteration = 0; iteration < NATIVE_RETURN_V2_POLICY.maxIterations; iteration += 1) {
    const midpoint = left.plus(right).dividedBy(2);
    const value = npv(midpoint);
    const convertedLeft = mode === "PERIODIC" ? left : naturalPower34V2(left, 365);
    const convertedRight = mode === "PERIODIC" ? right : naturalPower34V2(right, 365);
    const width = convertedRight.minus(convertedLeft).abs();
    const terminate = value.abs().lte(npvTolerance) || width.lte(d(NATIVE_RETURN_V2_POLICY.rateTolerance));
    trace.iterations.push({ left: left.toFixed(), right: right.toFixed(), midpoint: midpoint.toFixed(),
      value: value.toFixed(), width: width.toFixed(), terminate });
    if (terminate) {
      const rate = mode === "PERIODIC" ? midpoint.minus(1) : naturalPower34V2(midpoint, 365).minus(1);
      if (rate.lt(d(NATIVE_RETURN_V2_POLICY.minimumRate)) || rate.gt(d(NATIVE_RETURN_V2_POLICY.maximumRate))) {
        fail("IRR_UNDEFINED", "Versioned native return violates the unchanged reported-rate bounds");
      }
      trace.finalBase = midpoint.toFixed(); trace.rate = decimalFrom(rate);
      return { rate: trace.rate, trace };
    }
    if (leftValue.comparedTo(0) === value.comparedTo(0)) {
      left = midpoint; leftValue = value;
    } else right = midpoint;
  }
  fail("NON_CONVERGENT", "Versioned native Horner return did not converge within the original iteration bound");
}

export function solvePeriodicIrrV2(flows: readonly SponsorCashFlow[]): { rate: DecimalString; trace: NativeReturnTrace } {
  return solve(flows, "PERIODIC");
}
export function solveXirrV2(flows: readonly SponsorCashFlow[]): { rate: DecimalString; trace: NativeReturnTrace } {
  return solve(flows, "ACT365F_DAILY");
}
export function annualizePeriodicIrrV2(rate: DecimalString, periodsPerYear: number): DecimalString {
  if (![1, 4, 12].includes(periodsPerYear)) fail("INVALID_PERIOD", "Versioned native annualization frequency is not registered");
  return decimalFrom(naturalPower34V2(d(rate).plus(1), periodsPerYear).minus(1));
}
