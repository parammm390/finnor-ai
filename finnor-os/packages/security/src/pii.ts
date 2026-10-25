/**
 * Boundary-safe PII handling. Values sent to an LLM, Zep, logs, or telemetry must
 * be redacted first. Tokens are reversible only in the request process, allowing
 * the planner to reason over a request without receiving raw contact details.
 */
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\w)(?:\+?\d[\d .()\-]{7,}\d)(?!\w)/g;
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|boulevard|blvd\.?|court|ct\.?|way|place|pl\.?|parkway|pkwy\.?)(?:\s*,?\s*[A-Za-z .'-]+)?(?:\s*,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?\b/gi;
const SENSITIVE_KEY = /(?:email|e_mail|phone|mobile|contact|address|street|postal|zip|social.?security|card|payment|token|secret|password|api.?key)/i;
const SSN_KEY = /ssn/i;
const TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/;

export interface RedactionResult {
  value: string;
  tokens: Map<string, string>;
}

function nextToken(tokens: Map<string, string>, kind: string, raw: string): string {
  for (const [token, value] of tokens) if (value === raw) return token;
  const token = `[${kind}_${[...tokens.keys()].filter((key) => key.startsWith(`[${kind}_`)).length + 1}]`;
  tokens.set(token, raw);
  return token;
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function overlapsUuid(value: string, start: number, length: number): boolean {
  const end = start + length;
  UUID.lastIndex = 0;
  for (const match of value.matchAll(UUID)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (start < matchEnd && end > matchStart) return true;
  }
  return false;
}

function redactWithNamespace(value: string, namespace: string): RedactionResult {
  const tokens = new Map<string, string>();
  const token = (kind: string, raw: string) => nextToken(tokens, namespace ? `REQUEST_${namespace}_${kind}` : kind, raw);
  let redacted = value.replace(EMAIL, (raw) => token("EMAIL", raw));
  redacted = redacted.replace(STREET_ADDRESS, (raw) => token("ADDRESS", raw));
  redacted = redacted.replace(SSN, (raw) => token("SSN", raw));
  // UUIDs and receipt identifiers can contain 13–19 digits separated by hyphens,
  // which the old matcher mistook for payment cards in user-facing evidence.
  // Real card PANs satisfy Luhn; preserve non-card identifiers and redact only a
  // valid PAN that is not embedded in a UUID.
  redacted = redacted.replace(CARD, (raw, offset: number, source: string) =>
    luhnValid(raw) && !overlapsUuid(source, offset, raw.length) ? token("CARD", raw) : raw,
  );
  // The broad punctuation-friendly matcher also sees year ranges such as
  // "2025-2032". A real phone value in this U.S.-operating product has at least
  // ten digits; preserve shorter numeric ranges so research titles, dates, and
  // forecasts do not become bogus [PHONE_n] tokens.
  redacted = redacted.replace(PHONE, (raw, offset: number, source: string) =>
    raw.replace(/\D/g, "").length >= 10 && !overlapsUuid(source, offset, raw.length)
      ? token("PHONE", raw)
      : raw,
  );
  return { value: redacted, tokens };
}

export function redactText(value: string): RedactionResult {
  return redactWithNamespace(value, "");
}

export function redactReversibleText(value: string): RedactionResult {
  return redactWithNamespace(value, globalThis.crypto.randomUUID());
}

export function restoreTokens<T>(value: T, tokens: ReadonlyMap<string, string>): T {
  if (typeof value === "string") {
    let restored: string = value;
    for (const [token, raw] of tokens) restored = restored.replaceAll(token, raw);
    return restored as T;
  }
  if (Array.isArray(value)) return value.map((entry) => restoreTokens(entry, tokens)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, restoreTokens(entry, tokens)])) as T;
  }
  return value;
}

/** Removes direct identifiers in structured data, preserving non-identifying business facts. */
export function redactStructured<T>(value: T): T {
  if (typeof value === "string") return (TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) ? value : redactText(value).value) as T;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((entry) => redactStructured(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const words = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
        return [key, SENSITIVE_KEY.test(key) || SSN_KEY.test(words) ? "[REDACTED]" : redactStructured(entry)];
      }),
    ) as T;
  }
  return value;
}

/**
 * External integrations receive only their declared fields. A tool must opt in to
 * every field it needs; accidental new PII fields therefore fail closed.
 */
export function minimizeExternalInput(input: Record<string, unknown>, allowedFields: readonly string[] | undefined): Record<string, unknown> {
  if (!allowedFields) return redactStructured(input);
  return Object.fromEntries(allowedFields.filter((key) => key in input).map((key) => [key, input[key]]));
}
