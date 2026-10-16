import { createHash, verify } from "node:crypto";

/** Public signature wire contract. This authenticates bytes, not their truth. */
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export const digest = (value: unknown): string => createHash("sha256")
  .update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
export function verifySigned(body: unknown, signature: string, publicKeyPem: string): boolean {
  try { return verify(null, Buffer.from(canonical(body)), publicKeyPem, Buffer.from(signature, "base64")); }
  catch { return false; }
}
