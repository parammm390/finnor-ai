import { createHash } from "node:crypto";

/** JSON object order is not semantic. Arrays retain their declared order. */
export function canonicalInstitutionJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalInstitutionJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalInstitutionJson(item)}`).join(",")}}`;
}
export const institutionDigest = (value: unknown) => createHash("sha256")
  .update(canonicalInstitutionJson(value)).digest("hex");
