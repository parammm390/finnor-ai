import DecimalJs from "decimal.js";
import { fail } from "./errors";

/**
 * P4 calculation policy.  The clone prevents process-global Decimal settings from
 * changing historical results in another package.
 */
export const FINNOR_DECIMAL_POLICY = Object.freeze({
  precision: 34,
  rounding: "ROUND_HALF_EVEN" as const,
  maxInputCharacters: 128,
  maxAbsoluteExponent: 100,
});

export const FinnorDecimal = DecimalJs.clone({
  precision: FINNOR_DECIMAL_POLICY.precision,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -FINNOR_DECIMAL_POLICY.maxAbsoluteExponent,
  toExpPos: FINNOR_DECIMAL_POLICY.maxAbsoluteExponent,
  maxE: FINNOR_DECIMAL_POLICY.maxAbsoluteExponent,
  minE: -FINNOR_DECIMAL_POLICY.maxAbsoluteExponent,
  modulo: DecimalJs.ROUND_DOWN,
  crypto: false,
});

declare const decimalBrand: unique symbol;
export type DecimalString = string & { readonly [decimalBrand]: "DecimalString" };

const DECIMAL_SYNTAX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function assertedInput(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > FINNOR_DECIMAL_POLICY.maxInputCharacters) {
    fail("DECIMAL_LIMIT", "Decimal input is empty or exceeds the character limit", { length: typeof value === "string" ? value.length : null });
  }
  if (value.trim() !== value || !DECIMAL_SYNTAX.test(value)) {
    fail("INVALID_DECIMAL", "Financial decimals must be unformatted base-10 strings", { value });
  }
  const exponent = /[eE]([+-]?\d+)$/.exec(value)?.[1];
  if (exponent !== undefined && Math.abs(Number(exponent)) > FINNOR_DECIMAL_POLICY.maxAbsoluteExponent) {
    fail("DECIMAL_LIMIT", "Decimal exponent exceeds the deterministic limit", { exponent });
  }
  return value;
}

export function d(value: DecimalString | string): DecimalJs {
  const source = assertedInput(value as string);
  let parsed: DecimalJs;
  try {
    parsed = new FinnorDecimal(source);
  } catch {
    fail("INVALID_DECIMAL", "Invalid financial decimal", { value: source });
  }
  if (!parsed.isFinite()) fail("INVALID_DECIMAL", "Financial decimals must be finite", { value: source });
  if (parsed.isZero()) return new FinnorDecimal(0);
  return parsed;
}

export function decimal(value: string): DecimalString {
  const parsed = d(value);
  const normalized = parsed.isZero() ? "0" : parsed.toFixed();
  if (normalized.length > FINNOR_DECIMAL_POLICY.maxInputCharacters) {
    fail("DECIMAL_LIMIT", "Normalized decimal exceeds the deterministic limit", { length: normalized.length });
  }
  return normalized as DecimalString;
}

export function decimalFrom(value: DecimalJs): DecimalString {
  if (!value.isFinite()) fail("INVALID_DECIMAL", "Calculated decimal is not finite");
  const normalized = value.isZero() ? "0" : value.toFixed();
  if (normalized.length > FINNOR_DECIMAL_POLICY.maxInputCharacters) {
    fail("DECIMAL_LIMIT", "Calculated decimal exceeds the deterministic limit", { length: normalized.length });
  }
  return normalized as DecimalString;
}

export const ZERO = decimal("0");
export const ONE = decimal("1");

export function add(...values: Array<DecimalString | string>): DecimalString {
  return decimalFrom(values.reduce<DecimalJs>((total, value) => total.plus(d(value)), new FinnorDecimal(0)));
}

export function sub(left: DecimalString | string, right: DecimalString | string): DecimalString {
  return decimalFrom(d(left).minus(d(right)));
}

export function mul(...values: Array<DecimalString | string>): DecimalString {
  return decimalFrom(values.reduce<DecimalJs>((total, value) => total.times(d(value)), new FinnorDecimal(1)));
}

export function div(left: DecimalString | string, right: DecimalString | string): DecimalString {
  const denominator = d(right);
  if (denominator.isZero()) fail("DIVIDE_BY_ZERO", "Financial division by zero");
  return decimalFrom(d(left).dividedBy(denominator));
}

export function neg(value: DecimalString | string): DecimalString {
  return decimalFrom(d(value).negated());
}

export function abs(value: DecimalString | string): DecimalString {
  return decimalFrom(d(value).abs());
}

export function min(...values: Array<DecimalString | string>): DecimalString {
  if (!values.length) fail("MODEL_SCHEMA_INVALID", "min requires at least one operand");
  return decimalFrom(FinnorDecimal.min(...values.map(d)));
}

export function max(...values: Array<DecimalString | string>): DecimalString {
  if (!values.length) fail("MODEL_SCHEMA_INVALID", "max requires at least one operand");
  return decimalFrom(FinnorDecimal.max(...values.map(d)));
}

export function cmp(left: DecimalString | string, right: DecimalString | string): -1 | 0 | 1 {
  return d(left).comparedTo(d(right)) as -1 | 0 | 1;
}

export function round(value: DecimalString | string, decimalPlaces: number): DecimalString {
  if (!Number.isSafeInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 34) {
    fail("MODEL_SCHEMA_INVALID", "Invalid output rounding precision", { decimalPlaces });
  }
  return decimalFrom(d(value).toDecimalPlaces(decimalPlaces, DecimalJs.ROUND_HALF_EVEN));
}

export function pow(base: DecimalString | string, exponent: DecimalString | string): DecimalString {
  return decimalFrom(d(base).pow(d(exponent)));
}

export function decimalEquals(left: DecimalString | string, right: DecimalString | string): boolean {
  return d(left).equals(d(right));
}

export function withinTolerance(
  left: DecimalString | string,
  right: DecimalString | string,
  absoluteTolerance: DecimalString | string,
  relativeTolerance: DecimalString | string = ZERO,
): boolean {
  const difference = d(left).minus(d(right)).abs();
  if (difference.lte(d(absoluteTolerance))) return true;
  const scale = FinnorDecimal.max(d(left).abs(), d(right).abs());
  return !scale.isZero() && difference.dividedBy(scale).lte(d(relativeTolerance));
}
