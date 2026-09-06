import type { ImportEntity } from "./definition";
import type { ImportIssue } from "./mapping";

const exists = (value: unknown) => value !== undefined && value !== null && value !== "";

/** Domain-neutral validation applied after a registered vertical contract validates
 * field names. Vertical-specific state machines remain owned by their writers. */
export function validateCanonicalRow(_entity: ImportEntity, data: Record<string, unknown>): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (exists(data.email) && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(data.email))) {
    issues.push({ stage: "validation", code: "invalid_email", message: "email is not valid", field: "email" });
  }
  if (exists(data.phone) && !/^\\+[1-9]\\d{6,14}$/.test(String(data.phone))) {
    issues.push({ stage: "validation", code: "invalid_phone", message: "phone must be normalized E.164", field: "phone" });
  }
  for (const [field, value] of Object.entries(data)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      issues.push({ stage: "validation", code: "non_finite_number", message: "number must be finite", field });
    }
  }
  return issues;
}
