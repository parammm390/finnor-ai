import { createHash } from 'node:crypto';
import type { AllocationEnvelope, ResourceQuantity } from '../../../shared-types/src/allocation';
import type { AuthenticatedWorkforceCommand, WorkforceHistoryAnchor } from './schema';

const gcd = (a: bigint, b: bigint): bigint => {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
};

export class ExactQuantity {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (d <= 0n) throw Error('POSITIVE_DENOMINATOR_REQUIRED');
    const divisor = gcd(n, d);
    this.n = n / divisor; this.d = d / divisor;
    if (this.n.toString().length > 4096 || this.d.toString().length > 4096) throw Error('EXACT_ARITHMETIC_LIMIT');
  }
  add(q: ExactQuantity) { return new ExactQuantity(this.n * q.d + q.n * this.d, this.d * q.d); }
  sub(q: ExactQuantity) { return new ExactQuantity(this.n * q.d - q.n * this.d, this.d * q.d); }
  compare(q: ExactQuantity) { const n = this.n * q.d - q.n * this.d; return n < 0n ? -1 : n > 0n ? 1 : 0; }
  string(): ResourceQuantity { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}
export const ZERO = new ExactQuantity(0n);
export const ONE = new ExactQuantity(1n);

export function exactQuantity(value: ResourceQuantity): ExactQuantity {
  if (value.length > 256) throw Error('QUANTITY_ENCODING_LIMIT');
  const rational = /^(0|[1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (rational?.[1] !== undefined && rational[2] !== undefined) {
    const q = new ExactQuantity(BigInt(rational[1]), BigInt(rational[2]));
    if (q.n.toString() !== rational[1] || q.d.toString() !== rational[2]) throw Error('REDUCED_RATIONAL_REQUIRED');
    return q;
  }
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw Error('NONNEGATIVE_EXACT_QUANTITY_REQUIRED');
  const [integer = '0', fraction = ''] = value.split('.');
  return new ExactQuantity(BigInt(integer + fraction), 10n ** BigInt(fraction.length));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw Error('DIGEST_REQUIRES_JSON_VALUE');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export function workforceDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/** Call only with the independently loaded latest committed native history. */
export function workforceHistoryAnchor(history: readonly AuthenticatedWorkforceCommand[]): WorkforceHistoryAnchor {
  return { revision: history.length, commandsDigest: workforceDigest(history) };
}

export function coordinate(e: AllocationEnvelope): string {
  return JSON.stringify([e.resourceId, e.unit, e.kind, e.horizon.startAt, e.horizon.periodMs, e.horizon.periods]);
}
export type ExactVector = Map<string, ExactQuantity[]>;
export function quantities(envelopes: AllocationEnvelope[]): ExactVector {
  const result: ExactVector = new Map();
  for (const e of envelopes) {
    const key = coordinate(e);
    const prior = result.get(key) ?? Array.from({ length: e.horizon.periods + 1 }, () => ZERO);
    result.set(key, prior.map((q, i) => q.add(exactQuantity(e.quantities[i] ?? '0'))));
  }
  return result;
}
export function addVectors(a: ExactVector, b: ExactVector): ExactVector {
  const result: ExactVector = new Map(a);
  for (const [key, values] of b) {
    const prior = result.get(key) ?? values.map(() => ZERO);
    result.set(key, values.map((q, i) => q.add(prior[i] ?? ZERO)));
  }
  return result;
}
export function fits(used: ExactVector, limits: AllocationEnvelope[]): boolean {
  const cap = quantities(limits);
  for (const [key, values] of used) {
    const ceiling = cap.get(key);
    if (!ceiling || ceiling.length !== values.length) return false;
    const kind = limits.find(e => coordinate(e) === key)?.kind;
    let sum = ZERO; let maximum = ZERO;
    for (let i = 0; i < values.length; i++) {
      const q = values[i] ?? ZERO; const c = ceiling[i] ?? ZERO;
      sum = sum.add(q); maximum = maximum.add(c);
      if (q.compare(c) > 0 || ((kind === 'STOCK' || kind === 'CUMULATIVE_EXPENDITURE') && sum.compare(maximum) > 0)) return false;
    }
  }
  return true;
}
