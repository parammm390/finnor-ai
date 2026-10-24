/** Bounded canonical encoding for protected commitments and verification. */
import { createHash } from 'node:crypto';
export class LedgerFault extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
/** Native canonical snapshots already commit their exact PostgreSQL JSON text.
 * Encoding is explicit and immutable; never normalize those bytes into a new
 * digest or turn an owner snapshot commitment into a business-truth claim. */
export function referencePreimageDigest(reference) {
    if (reference.digestEncoding === undefined)
        return createHash('sha256').update(canonical(reference.content)).digest('hex');
    if (reference.digestEncoding !== 'NATIVE_UTF8_SHA256_V1' || typeof reference.content !== 'string' || Buffer.byteLength(reference.content) > 8 * 1024 * 1024)
        throw new LedgerFault(400, 'REFERENCE_DIGEST_ENCODING_UNSUPPORTED');
    return createHash('sha256').update(reference.content, 'utf8').digest('hex');
}
export function canonical(value) {
    let nodes = 0;
    const parts = [];
    function encode(v, depth) {
        if (++nodes > 100000 || depth > 64)
            throw new LedgerFault(413, 'JSON_COMPLEXITY_LIMIT');
        if (v === null) {
            parts.push('null');
            return;
        }
        if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) {
            parts.push(JSON.stringify(v));
            return;
        }
        if (Array.isArray(v)) {
            parts.push('[');
            for (let i = 0, length = v.length; i < length; i++) {
                if (i)
                    parts.push(',');
                if (i in v)
                    encode(v[i], depth + 1);
            }
            parts.push(']');
            return;
        }
        if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
            const record = v;
            parts.push('{');
            const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
            for (let i = 0; i < keys.length; i++) {
                if (i)
                    parts.push(',');
                const key = keys[i];
                parts.push(JSON.stringify(key), ':');
                encode(record[key], depth + 1);
            }
            parts.push('}');
            return;
        }
        throw new LedgerFault(400, 'NON_CANONICAL_JSON');
    }
    encode(value, 0);
    return parts.join('');
}
