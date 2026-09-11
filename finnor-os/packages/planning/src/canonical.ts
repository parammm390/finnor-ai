import { createHash } from "node:crypto";

/** PostgreSQL-jsonb-compatible canonical JSON. Callers deliberately construct the
 * semantic projection first; target references remain meaningful, while database
 * row ids, timestamps, candidate labels, and model rationale never enter it. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .filter((key) => row[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}
