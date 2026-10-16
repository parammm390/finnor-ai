/** Exact nonnegative tariff quote, not a physical usage or invoice attestation. */
export function priceCeiling(numerator: string, denominator: string, units: bigint): string {
  const n = BigInt(numerator) * units, d = BigInt(denominator);
  if (n < 0n || d <= 0n) throw Error("PRIMARY_PRICEBOOK_INVALID");
  return ((n + d - 1n) / d).toString();
}
