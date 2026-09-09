import { createHash } from "node:crypto";
import { fail } from "./errors";

function normalized(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("MODEL_SCHEMA_INVALID", "Canonical model numbers must be safe structural integers; financial values must be decimal strings");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalized(item, seen));
  if (typeof value === "object") {
    if (seen.has(value as object)) fail("MODEL_SCHEMA_INVALID", "Canonical data cannot contain cycles");
    seen.add(value as object);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        fail("MODEL_SCHEMA_INVALID", "Canonical data contains an unsupported value", { key, type: typeof item });
      }
      output[key] = normalized(item, seen);
    }
    seen.delete(value as object);
    return output;
  }
  fail("MODEL_SCHEMA_INVALID", "Canonical data contains an unsupported primitive", { type: typeof value });
}

export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(normalized(value, new WeakSet()));
}

export function semanticHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}
