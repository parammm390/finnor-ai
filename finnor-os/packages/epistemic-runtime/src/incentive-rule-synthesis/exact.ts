import type { ElicitationRational } from '../../../shared-types/src/elicitation-protocol';

const integer = /^(?:0|-?[1-9]\d*)$/;
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a };
export class R3Rational {
  readonly n: bigint; readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (d <= 0n) throw Error('R3_POSITIVE_DENOMINATOR_REQUIRED');
    const g = gcd(n, d); this.n = n / g; this.d = d / g;
    if (this.n.toString().length > 128 || this.d.toString().length > 128) throw Error('R3_RATIONAL_GROWTH_BOUND');
  }
  add(b: R3Rational) { return new R3Rational(this.n * b.d + b.n * this.d, this.d * b.d) }
  sub(b: R3Rational) { return new R3Rational(this.n * b.d - b.n * this.d, this.d * b.d) }
  mul(b: R3Rational) { return new R3Rational(this.n * b.n, this.d * b.d) }
  compare(b: R3Rational) { const v = this.n * b.d - b.n * this.d; return v < 0n ? -1 : v > 0n ? 1 : 0 }
  json(): ElicitationRational { return { numerator: this.n.toString(), denominator: this.d.toString() } }
}
export const R3_ZERO = new R3Rational(0n);
export function r3Quantity(value: unknown): R3Rational {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('R3_EXACT_QUANTITY_REQUIRED');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'denominator,numerator' || typeof v.numerator !== 'string' ||
    typeof v.denominator !== 'string' || !integer.test(v.numerator) || !/^[1-9]\d*$/.test(v.denominator) ||
    v.numerator.length > 128 || v.denominator.length > 128) throw Error('R3_CANONICAL_RATIONAL_REQUIRED');
  const q = new R3Rational(BigInt(v.numerator), BigInt(v.denominator));
  if (q.n.toString() !== v.numerator || q.d.toString() !== v.denominator) throw Error('R3_REDUCED_RATIONAL_REQUIRED');
  return q;
}
/** Explicit ledger codec. Existing supplied finite-decimal contracts are unchanged. */
export function r3LedgerQuantity(q: R3Rational): string { return `r3q:${q.n}/${q.d}` }
export function readR3LedgerQuantity(value: string): R3Rational {
  const match = /^r3q:(0|-?[1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) throw Error('R3_EXACT_LEDGER_CODEC_REQUIRED');
  return r3Quantity({ numerator: match[1], denominator: match[2] });
}
export function r3FromDecimal(s: string): R3Rational {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,48})?$/.test(s)) throw Error('R3_ORIGINAL_DECIMAL_REQUIRED');
  const [whole, fraction = ''] = s.split('.');
  return new R3Rational(BigInt((whole!.startsWith('-') ? '-' : '') + whole!.replace('-', '') + fraction), 10n ** BigInt(fraction.length));
}
