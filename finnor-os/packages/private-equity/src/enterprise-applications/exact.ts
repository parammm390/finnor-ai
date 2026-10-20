import {
  APPLICATION_LIMITS, ApplicationDecimalSchema, ApplicationFault, applicationCanonical,
  type ApplicationComparison, type ApplicationQuantity, type ApplicationUnknown,
} from "./contracts";

// Fixed twelve-place integer representation. No amount passes through Number,
// parseFloat, floating-point arithmetic, rounding, or a missing-to-zero fallback.
const SCALE = 1000000000000n;
export function applicationExactInteger(amount: string): bigint {
  if (!ApplicationDecimalSchema.safeParse(amount).success)
    throw new ApplicationFault("INVALID_QUANTITY", "Expected a nonnegative exact decimal with precision 38 and scale <= 12");
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, "0"));
}
export function applicationExactDecimal(integer: bigint): string {
  if (integer < 0n) throw new ApplicationFault("INVALID_QUANTITY", "Negative quantities are outside this profile");
  const whole = (integer / SCALE).toString();
  const fraction = (integer % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  const value = fraction ? `${whole}.${fraction}` : whole;
  if (!ApplicationDecimalSchema.safeParse(value).success)
    throw new ApplicationFault("QUANTITY_OVERFLOW", "Exact arithmetic result exceeds precision 38");
  return value;
}
export function applicationDimensionMismatch(a: ApplicationQuantity, b: ApplicationQuantity): string | undefined {
  if (a.currency !== b.currency) return "CURRENCY_MISMATCH";
  if (applicationCanonical(a.entity) !== applicationCanonical(b.entity)) return "ENTITY_MISMATCH";
  if (a.units !== b.units) return "UNITS_MISMATCH";
  if (applicationCanonical(a.time) !== applicationCanonical(b.time)) return "TIME_MISMATCH";
  if (a.accountingBasis !== b.accountingBasis) return "ACCOUNTING_BASIS_MISMATCH";
  return undefined;
}
export function applicationSumQuantities(entries: readonly ApplicationQuantity[]): ApplicationQuantity | ApplicationUnknown {
  if (!entries.length || entries.length > APPLICATION_LIMITS.quantityEntries)
    throw new ApplicationFault("INVALID_QUANTITY_LIST", "Sum requires 1..128 entries");
  const first = entries[0]!;
  let total = 0n;
  for (const entry of entries) {
    const reason = applicationDimensionMismatch(first, entry);
    if (reason) return { kind: "UNKNOWN", reason };
    total += applicationExactInteger(entry.amount);
    // Nonnegative inputs cannot recover from overflow; fail at the first overflowing prefix.
    applicationExactDecimal(total);
  }
  return { ...first, amount: applicationExactDecimal(total) };
}
export function applicationExactCompare(a: string, b: string, comparison: ApplicationComparison): boolean {
  const left = applicationExactInteger(a), right = applicationExactInteger(b);
  switch (comparison) {
    case "lt": return left < right;
    case "lte": return left <= right;
    case "eq": return left === right;
    case "gte": return left >= right;
    case "gt": return left > right;
  }
}
/** Signed diagnostic text, not an assignable financial quantity or implicit FX. */
export function applicationExactDifference(a:string,b:string):string{
 const value=applicationExactInteger(a)-applicationExactInteger(b);
 return (value<0n?'-':'')+applicationExactDecimal(value<0n?-value:value);
}
