import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { CapitalFormationError, capitalDigest, canonicalCapital } from "./contracts";

const CORE_BYTES = 262144;
const DECODED_BYTES = 8388608;
const StorageSchema = z.object({
  schema: z.literal("finnor.v4.publication-storage.v1"),
  encoding: z.literal("gzip-base64"),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decodedBytes: z.number().int().positive().max(DECODED_BYTES),
  data: z.string().min(1).max(CORE_BYTES),
}).strict();
const invalid = () => new CapitalFormationError("CAPITAL_PUBLICATION_STORAGE_INVALID", undefined, 503);
const changed = () => new CapitalFormationError("CAPITAL_PUBLICATION_BYTES_CHANGED", undefined, 503);

/** Storage only: the full canonical publication remains the semantic identity.
 * Core Evidence's content and snapshot bounds are not increased. */
export function encodeCapitalPublication(value: Record<string, unknown>): Record<string, unknown> {
  const content = canonicalCapital(value), bytes = Buffer.byteLength(content);
  if (bytes <= CORE_BYTES) return value;
  if (bytes > DECODED_BYTES) throw new CapitalFormationError("CAPITAL_PUBLICATION_STORAGE_BOUND_EXCEEDED", undefined, 413);
  const stored = {
    schema: "finnor.v4.publication-storage.v1", encoding: "gzip-base64",
    contentDigest: capitalDigest(content), decodedBytes: bytes,
    data: gzipSync(Buffer.from(content), { level: 6 }).toString("base64"),
  };
  if (Buffer.byteLength(canonicalCapital(stored)) > CORE_BYTES) {
    throw new CapitalFormationError("CAPITAL_PUBLICATION_STORAGE_BOUND_EXCEEDED", undefined, 413);
  }
  return stored;
}

/** The caller independently verifies the actual immutable Evidence byte hash. */
export function decodeCapitalPublication(content: string, expectedDigest: string): Record<string, unknown> {
  if (Buffer.byteLength(content) > CORE_BYTES) throw invalid();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(content);
    if (!body || typeof body !== "object" || Array.isArray(body) || canonicalCapital(body) !== content) throw invalid();
  } catch { throw invalid(); }
  if (body.schema !== "finnor.v4.publication-storage.v1") {
    if (capitalDigest(content) !== expectedDigest) throw changed();
    return body;
  }
  const parsed = StorageSchema.safeParse(body);
  if (!parsed.success) throw invalid();
  const stored = parsed.data;
  if (stored.contentDigest !== expectedDigest) throw changed();
  let decoded: string;
  try {
    const compressed = Buffer.from(stored.data, "base64");
    if (compressed.toString("base64") !== stored.data) throw invalid();
    const bytes = gunzipSync(compressed, { maxOutputLength: DECODED_BYTES });
    if (bytes.length !== stored.decodedBytes) throw invalid();
    decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded).equals(bytes)) throw invalid();
  } catch { throw invalid(); }
  if (capitalDigest(decoded) !== expectedDigest) throw changed();
  try {
    const result = JSON.parse(decoded);
    if (!result || typeof result !== "object" || Array.isArray(result) || canonicalCapital(result) !== decoded) throw invalid();
    return result;
  } catch { throw invalid(); }
}
