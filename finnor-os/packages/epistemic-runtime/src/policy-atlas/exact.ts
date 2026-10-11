import { createHash } from 'node:crypto';
import { ExperimentRational, ER_ZERO } from '../experiment-numerics';
import type { AtlasAffine, AtlasFacet } from '../../../shared-types/src/decision-atlas';

export class AtlasError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'AtlasError'; }
}
export type Q = ExperimentRational;
export const Z = ER_ZERO;
export const O = new ExperimentRational(1n);
export function bounded(q: Q, bits = 4096): Q {
  if ((q.n < 0n ? -q.n : q.n).toString(2).length > bits || q.d.toString(2).length > bits)
    throw new AtlasError('INTEGER_GROWTH_LIMIT');
  return q;
}
export function rational(value: string, bits = 4096): Q {
  if (typeof value !== 'string' || value.length > 2500 || !/^(?:0|-?[1-9]\d*)\/[1-9]\d*$/.test(value))
    throw new AtlasError('INVALID_RATIONAL');
  const [n, d] = value.split('/'), q = bounded(new ExperimentRational(BigInt(n!), BigInt(d!)), bits);
  if (encode(q) !== value) throw new AtlasError('NONCANONICAL_RATIONAL');
  return q;
}
export const encode = (q: Q): string => `${q.n}/${q.d}`;
export const add = (x: Q, y: Q): Q => bounded(x.add(y));
export const sub = (x: Q, y: Q): Q => bounded(x.sub(y));
export const mul = (x: Q, y: Q): Q => bounded(x.mul(y));
export function div(x: Q, y: Q): Q {
  if (!y.n) throw new AtlasError('ZERO_DIVISOR');
  return bounded(new ExperimentRational(x.n * y.d * (y.n < 0n ? -1n : 1n), x.d * (y.n < 0n ? -y.n : y.n)));
}
export const negate = (q: Q): Q => new ExperimentRational(-q.n, q.d);
export const sign = (q: Q): -1 | 0 | 1 => q.n < 0n ? -1 : q.n > 0n ? 1 : 0;
export const sum = (values: Q[]): Q => values.reduce(add, Z);
export const zeroAffine = (n: number): AtlasAffine => ({ a: Array(n).fill('0/1'), b: '0/1' });
export const constant = (n: number, value: string): AtlasAffine => ({ ...zeroAffine(n), b: value });
export function combine(x: AtlasAffine, y: AtlasAffine, factor = O): AtlasAffine {
  if (x.a.length !== y.a.length) throw new AtlasError('AFFINE_DIMENSION_MISMATCH');
  return { a: x.a.map((v, i) => encode(add(rational(v), mul(rational(y.a[i]!), factor)))),
    b: encode(add(rational(x.b), mul(rational(y.b), factor))) };
}
export const difference = (x: AtlasAffine, y: AtlasAffine): AtlasAffine => combine(x, y, negate(O));
export const scale = (x: AtlasAffine, factor: Q): AtlasAffine =>
  ({ a: x.a.map(v => encode(mul(rational(v), factor))), b: encode(mul(rational(x.b), factor)) });
export const evaluate = (x: AtlasAffine, point: Q[]): Q => {
  if (x.a.length !== point.length) throw new AtlasError('PARAMETER_DIMENSION_MISMATCH');
  return x.a.reduce((v, c, i) => add(v, mul(rational(c), point[i]!)), rational(x.b));
};
export const holds = (facet: AtlasFacet, point: Q[], closure = false): boolean => {
  const s = sign(evaluate(facet.expression, point));
  return facet.relation === 'EQ' ? s === 0 : facet.relation === 'LT' && !closure ? s < 0 : s <= 0;
};
/** Positive scaling only: orientation and strict/equality semantics survive. */
export function affineKey(x: AtlasAffine): string {
  const values = [...x.a, x.b].map(v => rational(v)), first = values.find(v => v.n !== 0n);
  if (!first) return values.map(encode).join(',');
  const factor = new ExperimentRational(first.d, first.n < 0n ? -first.n : first.n);
  return values.map(v => encode(mul(v, factor))).join(',');
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}
export const atlasHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const bytesHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const atlasRef = (owner: string, kind: string, body: unknown, version = 'r7-exact-affine-v1') => {
  const contentDigest = atlasHash(body); return { owner, id: `${kind}:${contentDigest}`, version, contentDigest };
};
