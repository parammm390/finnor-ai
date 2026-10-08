/** Bounded canonical encoding for protected commitments and verification. */
import {createHash} from 'node:crypto';
export class LedgerFault extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** Native canonical snapshots already commit their exact PostgreSQL JSON text.
 * Encoding is explicit and immutable; never normalize those bytes into a new
 * digest or turn an owner snapshot commitment into a business-truth claim. */
export function referencePreimageDigest(reference:{content:unknown;digestEncoding?:unknown}):string{
 if(reference.digestEncoding===undefined)return createHash('sha256').update(canonical(reference.content)).digest('hex');
 if(reference.digestEncoding!=='NATIVE_UTF8_SHA256_V1'||typeof reference.content!=='string'||Buffer.byteLength(reference.content)>8*1024*1024)throw new LedgerFault(400,'REFERENCE_DIGEST_ENCODING_UNSUPPORTED');
 return createHash('sha256').update(reference.content,'utf8').digest('hex');
}
export function canonical(value: unknown): string {
  let nodes = 0;
  function encode(v: unknown, depth: number): string {
    if (++nodes > 100000 || depth > 64) throw new LedgerFault(413, 'JSON_COMPLEXITY_LIMIT');
    if (v === null) return 'null';
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => encode(x, depth + 1)).join(',') + ']';
    if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      const record = v as Record<string, unknown>;
      return '{' + Object.keys(record).sort((a, b) => a.localeCompare(b)).map(k => JSON.stringify(k) + ':' + encode(record[k], depth + 1)).join(',') + '}';
    }
    throw new LedgerFault(400, 'NON_CANONICAL_JSON');
  }
  return encode(value, 0);
}
