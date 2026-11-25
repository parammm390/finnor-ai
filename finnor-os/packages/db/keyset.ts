import { sql, type AnyColumn, type SQL } from "drizzle-orm";

declare const exactInstantBrand: unique symbol;

/** A timestamptz in UTC with all six fractional digits. JavaScript Date keeps
 * three, so a page boundary built from a Date skips rows inside one millisecond. */
export type ExactInstant = string & { readonly [exactInstantBrand]: true };

export interface KeysetPosition {
  at: ExactInstant;
  id: string;
}

export class InvalidKeysetCursorError extends Error {
  constructor() {
    super("Invalid page cursor");
    this.name = "InvalidKeysetCursorError";
  }
}

const EXACT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Select this next to every paged row and build the next cursor from it. */
export function exactInstant(column: AnyColumn | SQL): SQL<ExactInstant> {
  return sql<ExactInstant>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function parseExactInstant(value: unknown): ExactInstant | null {
  return typeof value === "string" && EXACT_INSTANT.test(value) && Number.isFinite(Date.parse(value)) ? value as ExactInstant : null;
}

/** The rows after `position` when the page is ordered by `column DESC, id DESC`. */
export function olderThan(column: AnyColumn | SQL, id: AnyColumn | SQL, position: KeysetPosition): SQL {
  return sql`(${column}, ${id}) < (${position.at}::timestamptz, ${position.id}::uuid)`;
}

/** The rows after `position` when the page is ordered by `column ASC, id ASC`. */
export function newerThan(column: AnyColumn | SQL, id: AnyColumn | SQL, position: KeysetPosition): SQL {
  return sql`(${column}, ${id}) > (${position.at}::timestamptz, ${position.id}::uuid)`;
}

/** Orders two selected positions the way `newerThan` pages them. */
export function compareKeysetPositions(left: KeysetPosition, right: KeysetPosition): number {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  const leftId = left.id.toLowerCase();
  const rightId = right.id.toLowerCase();
  return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
}

export function encodeKeysetCursor<Extra extends Record<string, string | number>>(position: KeysetPosition, extra?: Extra): string {
  return Buffer.from(JSON.stringify({ v: 1, ...extra, at: position.at, id: position.id })).toString("base64url");
}

/** Returns the position and the caller's own fields, which the caller validates. */
export function decodeKeysetCursor(raw: string): KeysetPosition & Record<string, unknown> {
  if (raw.length === 0 || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new InvalidKeysetCursorError();
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.toString("base64url") !== raw) throw new InvalidKeysetCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new InvalidKeysetCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidKeysetCursorError();
  const fields = parsed as Record<string, unknown>;
  const at = parseExactInstant(fields.at);
  if (fields.v !== 1 || !at || typeof fields.id !== "string" || !UUID.test(fields.id)) throw new InvalidKeysetCursorError();
  return { ...fields, at, id: fields.id };
}
