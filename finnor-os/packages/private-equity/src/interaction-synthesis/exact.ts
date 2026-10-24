export const ARITHMETIC_BITS = 4096;
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
}
export class Rational {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (d === 0n) throw new Error("Y3_ZERO_DENOMINATOR");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
    if (this.n.toString(2).replace("-", "").length > ARITHMETIC_BITS || this.d.toString(2).length > ARITHMETIC_BITS)
      throw new Error("Y3_ARITHMETIC_BOUND");
  }
  add(b: Rational) { return new Rational(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(b: Rational) { return new Rational(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(b: Rational) { return new Rational(this.n * b.n, this.d * b.d); }
  div(b: Rational) { return new Rational(this.n * b.d, this.d * b.n); }
  compare(b: Rational) { const n = this.n * b.d - b.n * this.d; return n < 0n ? -1 : n > 0n ? 1 : 0; }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
  static parse(value: string) {
    if (typeof value !== "string" || value.length > 2500 || !/^-?(?:0|[1-9][0-9]*)(?:\/[1-9][0-9]*)?$/.test(value))
      throw new Error("Y3_NONCANONICAL_RATIONAL");
    const [n, d = "1"] = value.split("/");
    const result = new Rational(BigInt(n!), BigInt(d));
    if (result.toString() !== value) throw new Error("Y3_NONCANONICAL_RATIONAL");
    return result;
  }
}
export const q = Rational.parse;
export const ZERO = new Rational(0n);
export const ONE = new Rational(1n);
export const sum = (values: Rational[]) => values.reduce((a, b) => a.add(b), ZERO);
