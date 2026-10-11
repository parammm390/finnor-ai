import { createHash } from "node:crypto";
import type { IdentificationRational } from "../../../shared-types/src/identification-plan";

/** R4_JSON_UTF8_SORTED_V1, matches the native checker, not locale collation. */
export function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const v = value as Record<string, unknown>;
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
export const hash = (value: unknown) => createHash("sha256").update(Buffer.isBuffer(value) ? value : stable(value)).digest("hex");
export const bytesHash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
export function rational(value: IdentificationRational) {
  const n = BigInt(value.numerator), d = BigInt(value.denominator);
  if (n < 0n || d <= 0n || gcd(n, d) !== 1n) throw Error("R4_NORMALIZED_RATIONAL_REQUIRED");
  return { n, d };
}
/** Existing numerical S4 accepts numbers, not R4's exact rational ABI.
 * Only a round-trip-exact finite decimal can cross that explicit adapter. */
export function exactOwnerNumber(value: IdentificationRational): number {
  const { n, d } = rational(value);
  let divisor = d, twos = 0, fives = 0;
  while (divisor % 2n === 0n) { divisor /= 2n; twos++; }
  while (divisor % 5n === 0n) { divisor /= 5n; fives++; }
  if (divisor !== 1n || Math.max(twos, fives) > 6 || n > 1000000000000n) throw Error("R4_S4_EXACT_COST_CONVERSION_UNSUPPORTED");
  const places = Math.max(twos, fives), scaled = n * (10n ** BigInt(places)) / d;
  const number = Number(scaled) / 10 ** places;
  if (!Number.isFinite(number) || BigInt(Math.round(number * 10 ** places)) !== scaled) throw Error("R4_S4_EXACT_COST_CONVERSION_UNSUPPORTED");
  return number;
}
