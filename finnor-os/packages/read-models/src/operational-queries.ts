import {
  actionLog,
  appointments,
  calls,
  communicationsLog,
  contacts,
  contactMethods,
  conversations,
  domainActions,
  invoices,
  inventoryItems,
  leads,
  messages,
  opportunities,
  payments,
  procurementOrders,
  proposals,
  quotes,
  serviceVisits,
  tasks,
  tenants,
  technicians,
  users,
  warehouses,
  warehouseStock,
  withTenant,
  workOrders,
  workflowRuns,
  workflowSteps,
  works,
  households,
  type Db,
  beginWorkQueryExecution,
  finishWorkQueryExecution,
  attachWorkEntity,
} from "@finnor/db";
import type {
  AgentActivityRequest,
  AgentActivityResult,
  BusinessStateCount,
  BusinessStateRequest,
  CanonicalOperationalQueryIntent,
  CanonicalOperationalQueryRequest,
  BusinessStateResult,
  CompanyContextRequest,
  CompanyContextResult,
  CustomerCohortRequest,
  CustomerCohortResult,
  CustomerLookupRequest,
  CustomerLookupResult,
  CustomerLookupRow,
  InventoryStatusRequest,
  InventoryStatusResult,
  MoneyStatusSummary,
  MoneySummaryRequest,
  MoneySummaryResult,
  OperationalQueryIntent,
  OperationalQueryExecutionRef,
  OperationalLocalDateRange,
  OperationalQueryRange,
  OperationalQueryPageInfo,
  OperationalQueryPageRequest,
  OperationalQueryRequest,
  OperationalQueryResult,
  OperationalQueryResultFor,
  OperationalQuerySource,
  PartyAvailabilityResult,
  PartyContextResult,
  PartyLookupResult,
  TeamRosterResult,
  ScheduleRangeRequest,
  ScheduleRangeResult,
  ScheduleRow,
  WorkListRequest,
  WorkListResult,
} from "@finnor/shared-types";
import { canonicalEntityRefToPartyRef } from "@finnor/shared-types";
import { companyContext as resolveCompanyContext } from "./index";
import { executePartyOperationalQuery, type PartyReadExecutionContext } from "./party-queries";
import { resolveParty } from "./party-resolver";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const FUZZY_CANDIDATE_CAP = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Cursor = Record<string, unknown>;

interface QueryOptions {
  /** Attach the execution to this durable Work. */
  workId?: string;
  /** Optional input within workId that caused this read. */
  workInputId?: string | null;
  /** Idempotency key unique within workId. A deterministic key is derived when omitted. */
  executionKey?: string;
  /** Injectable clock for deterministic callers/tests. */
  now?: (() => Date) | Date;
  /** Optional lower cap for a caller that wants an even smaller bounded page. */
  maxRows?: number;
  /** Trusted authenticated employee identity for relationship-aware party reads. */
  employeeId?: string;
  /** Trusted authenticated user identity; never read from a request payload. */
  userId?: string;
}

export type OperationalQueryOptions = QueryOptions;

type CanonicalOperationalQueryResult =
  | CustomerLookupResult
  | CustomerCohortResult
  | ScheduleRangeResult
  | MoneySummaryResult
  | WorkListResult
  | InventoryStatusResult
  | AgentActivityResult
  | BusinessStateResult
  | CompanyContextResult
  | PartyLookupResult
  | PartyContextResult
  | TeamRosterResult
  | PartyAvailabilityResult;

interface PageContext {
  limit: number;
  cursor: Cursor | null;
}

function pageContext(request: OperationalQueryPageRequest | undefined, options: QueryOptions): PageContext {
  const requested = request?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Operational query page limit must be positive");
  const callerCap = options.maxRows === undefined ? MAX_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.maxRows)));
  const limit = Math.min(Math.floor(requested), callerCap);
  return { limit, cursor: request?.cursor ? decodeCursor(request.cursor) : null };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("not an object");
    return decoded as Cursor;
  } catch {
    throw new Error("Invalid operational query cursor");
  }
}

function validateCursorKeys(cursor: Cursor | null, keys: Record<string, "string" | "number">): void {
  if (!cursor) return;
  const actual = Object.keys(cursor).sort();
  const expected = Object.keys(keys).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Operational query cursor shape does not match this query");
  }
  for (const [key, kind] of Object.entries(keys)) {
    const value = cursor[key];
    if (kind === "string" && (typeof value !== "string" || value.length === 0)) throw new Error("Operational query cursor contains an invalid value");
    if (kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("Operational query cursor contains an invalid value");
  }
}

function validateSectionCursors(cursor: Cursor | null, sections: Record<string, Record<string, "string" | "number">>): void {
  if (!cursor) return;
  for (const key of Object.keys(cursor)) {
    if (!(key in sections)) throw new Error("Operational query cursor contains an unknown section");
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) throw new Error("Operational query cursor section is invalid");
  }
  for (const [section, shape] of Object.entries(sections)) validateCursorKeys(sectionCursor(cursor, section), shape);
}

function cursorString(cursor: Cursor | null, key: string): string | null {
  const value = cursor?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) throw new Error(`${field} must be an ISO timestamp`);
  return parsed;
}

function normalizedRange(range: { start: string; end: string }, field = "range"): { start: string; end: string; startDate: Date; endDate: Date } {
  const startDate = parseDate(range.start, `${field}.start`);
  const endDate = parseDate(range.end, `${field}.end`);
  if (startDate.getTime() >= endDate.getTime()) throw new Error(`${field} must be a non-empty half-open interval`);
  return { start: startDate.toISOString(), end: endDate.toISOString(), startDate, endDate };
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function localDateString(date: Date, timeZone: string): string {
  const parts = localDateParts(date, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function addLocalDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function resolveLocalDate(value: string, asOf: Date, timeZone: string): string {
  if (value === "today") return localDateString(asOf, timeZone);
  if (value === "tomorrow") return addLocalDays(localDateString(asOf, timeZone), 1);
  if (!validLocalDate(value)) throw new Error("local schedule dates must be ISO calendar dates, today, or tomorrow");
  return value;
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return localAsUtc - instant.getTime();
}

/** Converts a tenant-local midnight to UTC while re-checking the offset after the
 * first estimate. This handles DST transitions without server-locale assumptions. */
function localMidnightUtc(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const naiveUtc = Date.UTC(year!, month! - 1, day!);
  let candidate = new Date(naiveUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) candidate = new Date(naiveUtc - timeZoneOffsetMs(candidate, timeZone));
  return candidate;
}

interface ResolvedTenantRange {
  range: { start: string; end: string; startDate: Date; endDate: Date };
  timeZone: string;
  localDateRange?: OperationalLocalDateRange;
}

export async function resolveTenantRange(
  db: Db,
  tenantId: string,
  request: { range?: OperationalQueryRange; localDateRange?: OperationalLocalDateRange },
  asOf: string,
): Promise<ResolvedTenantRange> {
  const [tenant] = await db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error("Tenant not found");
  if (request.range && request.localDateRange) throw new Error("A tenant-local query range and UTC range cannot both be supplied");
  if (request.range) return { range: normalizedRange(request.range, "range"), timeZone: tenant.timezone };
  if (!request.localDateRange) throw new Error("A bounded UTC range or localDateRange is required");
  const asOfDate = parseDate(asOf, "asOf");
  const startDate = resolveLocalDate(request.localDateRange.startDate, asOfDate, tenant.timezone);
  const inclusiveEnd = resolveLocalDate(request.localDateRange.endDate ?? request.localDateRange.startDate, asOfDate, tenant.timezone);
  if (inclusiveEnd < startDate) throw new Error("localDateRange.endDate must not precede startDate");
  const exclusiveEnd = addLocalDays(inclusiveEnd, 1);
  const start = localMidnightUtc(startDate, tenant.timezone);
  const end = localMidnightUtc(exclusiveEnd, tenant.timezone);
  return {
    range: { start: start.toISOString(), end: end.toISOString(), startDate: start, endDate: end },
    timeZone: tenant.timezone,
    localDateRange: { startDate: request.localDateRange.startDate, ...(request.localDateRange.endDate ? { endDate: request.localDateRange.endDate } : {}) },
  };
}

function pageInfo(
  limit: number,
  returned: number,
  hasMore: boolean,
  nextCursor: string | null,
  totalCount: number | null = null,
  totalCountExact = false,
): OperationalQueryPageInfo {
  return {
    limit,
    returned,
    totalCount,
    totalCountExact,
    hasMore,
    nextCursor,
    truncated: hasMore,
  };
}

function source(tables: string[]): OperationalQuerySource {
  return { kind: "canonical_postgres", tables };
}

function base<I extends CanonicalOperationalQueryIntent>(
  intent: I,
  sourceInfo: OperationalQuerySource,
  asOf: string,
  page: OperationalQueryPageInfo,
  execution?: CanonicalOperationalQueryResult["execution"],
): {
  kind: "operational_query_result";
  status: "ok";
  data: Record<string, unknown>;
  version: 1;
  intent: I;
  source: OperationalQuerySource;
  asOf: string;
  count: number;
  truncated: boolean;
  page: OperationalQueryPageInfo;
  meta: { version: 1; source: OperationalQuerySource; asOf: string };
  execution?: OperationalQueryExecutionRef;
} {
  return {
    kind: "operational_query_result",
    status: "ok",
    data: {},
    version: 1,
    intent,
    source: sourceInfo,
    asOf,
    count: page.returned,
    truncated: page.truncated,
    page,
    meta: { version: 1, source: sourceInfo, asOf },
    ...(execution ? { execution } : {}),
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredIso(value: Date | string): string {
  const result = iso(value);
  if (!result) throw new Error("Database returned an invalid timestamp");
  return result;
}

function numberValue(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function displayName(contactInfo: unknown, fallback: string | null = null): string | null {
  const info = objectValue(contactInfo);
  for (const key of ["name", "displayName", "fullName"]) {
    if (typeof info[key] === "string" && info[key]!.trim()) return info[key] as string;
  }
  return fallback;
}

function boundedTitle(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeLookup(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length]!;
}

function fuzzyNameMatch(query: string, name: string): boolean {
  const queryTokens = query.split(" ").filter(Boolean);
  const nameTokens = name.split(" ").filter(Boolean);
  if (queryTokens.length < 2 || nameTokens.length < 2 || query.length < 8) return false;
  if (queryTokens[0] !== nameTokens[0]) return false;
  return editDistance(query, name) <= 2;
}

function afterDescendingTimestampId(
  timestampColumn: AnyColumn,
  idColumn: AnyColumn,
  cursor: Cursor | null,
): SQL | undefined {
  const timestamp = cursorString(cursor, "at");
  const id = cursorString(cursor, "id");
  if (!timestamp || !id) return undefined;
  const date = parseDate(timestamp, "cursor.at");
  return or(
    lt(timestampColumn, date),
    and(eq(timestampColumn, date), lt(idColumn, id)),
  );
}

function afterAscendingTimestampKindId(
  timestampColumn: AnyColumn,
  kind: ScheduleRow["kind"],
  idColumn: AnyColumn,
  cursor: Cursor | null,
): SQL | undefined {
  const timestamp = cursorString(cursor, "at");
  const cursorKind = cursorString(cursor, "kind");
  const cursorId = cursorString(cursor, "id");
  if (!timestamp || !cursorKind || !cursorId) return undefined;
  if (!["appointment", "service_visit", "work_order"].includes(cursorKind)) throw new Error("Invalid schedule cursor kind");
  const date = parseDate(timestamp, "cursor.at");
  if (kind < cursorKind) return gt(timestampColumn, date);
  if (kind > cursorKind) return or(gt(timestampColumn, date), eq(timestampColumn, date));
  return or(gt(timestampColumn, date), and(eq(timestampColumn, date), gt(idColumn, cursorId)));
}

function afterDescendingId(
  idColumn: AnyColumn,
  cursor: Cursor | null,
): SQL | undefined {
  const id = cursorString(cursor, "id");
  return id ? lt(idColumn, id) : undefined;
}

function sectionCursor(cursor: Cursor | null, section: string): Cursor | null {
  const value = cursor?.[section];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Cursor : null;
}

function sectionNextCursor(
  cursor: Cursor | null,
  section: string,
  page: OperationalQueryPageInfo,
  last: Cursor | null,
): Cursor | null {
  if (!page.hasMore || !last) return cursor;
  return { ...(cursor ?? {}), [section]: last };
}

function failSafeError(error: unknown): Record<string, unknown> {
  return { message: error instanceof Error ? error.message : "Operational query failed" };
}

function requestKey(request: OperationalQueryRequest): string {
  const canonical = JSON.stringify(request);
  return `opq:${request.intent}:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

interface CustomerCandidate {
  id: string;
  address: string;
  contactInfo: unknown;
  createdAt: Date;
  contacts: Array<{
    id: string;
    name: string;
    role: string | null;
    methods: Array<{ methodType: string; value: string }>;
  }>;
}

function customerAliases(candidate: CustomerCandidate): Array<{ value: string; kind: "name" | "address" | "phone" | "email" }> {
  const aliases: Array<{ value: string; kind: "name" | "address" | "phone" | "email" }> = [];
  const info = objectValue(candidate.contactInfo);
  for (const key of ["name", "displayName", "fullName"]) {
    if (typeof info[key] === "string" && info[key]!.trim()) aliases.push({ value: info[key] as string, kind: "name" });
  }
  aliases.push({ value: candidate.address, kind: "address" });
  for (const contact of candidate.contacts) {
    aliases.push({ value: contact.name, kind: "name" });
    for (const method of contact.methods) aliases.push({ value: method.value, kind: method.methodType === "email" ? "email" : "phone" });
  }
  for (const key of ["phone", "email"]) {
    if (typeof info[key] === "string" && info[key]!.trim()) aliases.push({ value: info[key] as string, kind: key as "phone" | "email" });
  }
  return aliases;
}

async function loadCustomerCandidates(
  db: Db,
  tenantId: string,
  request: CustomerLookupRequest,
): Promise<{ candidates: CustomerCandidate[]; candidateTruncated: boolean }> {
  const exactId = request.householdId?.trim() || null;
  const selectors = [request.query, request.name, request.address, request.contact].filter((value): value is string => Boolean(value?.trim()));
  const selector = selectors.join(" ").trim();
  const normalized = normalizeLookup(selector);
  const phoneDigits = digits(selector);

  // Exact id is resolved before any text search. This also avoids a text query
  // accidentally returning an ambiguous result when the caller already has the
  // canonical household identity.
  let idRows: Array<{ id: string }>;
  let candidateTruncated = false;
  if (exactId) {
    idRows = await db.select({ id: households.id }).from(households).where(and(
      eq(households.tenantId, tenantId),
      eq(households.id, exactId),
    )).limit(1);
  } else if (!normalized && phoneDigits.length < 7) {
    idRows = [];
  } else {
    const normalizedPattern = `%${normalized}%`;
    const addressText = sql`lower(regexp_replace(coalesce(${households.address}, ''), '[^a-z0-9]+', ' ', 'g'))`;
    const contactNameText = sql`lower(regexp_replace(coalesce(${contacts.name}, ''), '[^a-z0-9]+', ' ', 'g'))`;
    const contactValueText = sql`lower(regexp_replace(coalesce(${contactMethods.value}, ''), '[^a-z0-9]+', ' ', 'g'))`;
    const contactInfoNameText = sql`lower(regexp_replace(coalesce(${households.contactInfo}->>'name', ''), '[^a-z0-9]+', ' ', 'g'))`;
    const contactInfoEmailText = sql`lower(regexp_replace(coalesce(${households.contactInfo}->>'email', ''), '[^a-z0-9]+', ' ', 'g'))`;
    const contactInfoPhoneText = sql`regexp_replace(coalesce(${households.contactInfo}->>'phone', ''), '\\D', '', 'g')`;
    const predicates = [
      normalized ? sql`${addressText} LIKE ${normalizedPattern}` : undefined,
      normalized ? sql`${contactNameText} LIKE ${normalizedPattern}` : undefined,
      normalized ? sql`${contactValueText} LIKE ${normalizedPattern}` : undefined,
      normalized ? sql`${contactInfoNameText} LIKE ${normalizedPattern}` : undefined,
      normalized ? sql`${contactInfoEmailText} LIKE ${normalizedPattern}` : undefined,
      phoneDigits.length >= 7 ? sql`${contactInfoPhoneText} LIKE ${`%${phoneDigits}%`}` : undefined,
      phoneDigits.length >= 7 ? sql`regexp_replace(coalesce(${contactMethods.value}, ''), '\\D', '', 'g') LIKE ${`%${phoneDigits}%`}` : undefined,
    ].filter((value): value is SQL => Boolean(value));
    const rows = await db.selectDistinct({ id: households.id })
      .from(households)
      .leftJoin(contacts, and(eq(contacts.householdId, households.id), eq(contacts.tenantId, tenantId), isNull(contacts.archivedAt)))
      .leftJoin(contactMethods, and(eq(contactMethods.contactId, contacts.id), eq(contactMethods.tenantId, tenantId)))
      .where(and(eq(households.tenantId, tenantId), or(...predicates)))
      .orderBy(asc(households.id))
      .limit(FUZZY_CANDIDATE_CAP + 1);
    candidateTruncated = rows.length > FUZZY_CANDIDATE_CAP;
    idRows = rows.slice(0, FUZZY_CANDIDATE_CAP);

    // A typo-safe fallback is only allowed after the normalized SQL prefilter
    // found nothing. It is bounded and later requires a unique best match.
    if (idRows.length === 0 && normalized) {
      const fallbackRows = await db.select({ id: households.id })
        .from(households)
        .where(eq(households.tenantId, tenantId))
        .orderBy(asc(households.id))
        .limit(FUZZY_CANDIDATE_CAP + 1);
      candidateTruncated = fallbackRows.length > FUZZY_CANDIDATE_CAP;
      idRows = fallbackRows.slice(0, FUZZY_CANDIDATE_CAP);
    }
  }

  const ids = idRows.map((row) => row.id);
  if (ids.length === 0) return { candidates: [], candidateTruncated };
  const householdRows = await db.select({
    id: households.id,
    address: households.address,
    contactInfo: households.contactInfo,
    createdAt: households.createdAt,
  }).from(households).where(and(eq(households.tenantId, tenantId), inArray(households.id, ids)));
  const contactRows = await db.select({
    id: contacts.id,
    householdId: contacts.householdId,
    name: contacts.name,
    role: contacts.role,
  }).from(contacts).where(and(
    eq(contacts.tenantId, tenantId),
    inArray(contacts.householdId, ids),
    isNull(contacts.archivedAt),
  ));
  const contactIds = contactRows.map((row) => row.id);
  const methodRows = contactIds.length > 0
    ? await db.select({ contactId: contactMethods.contactId, methodType: contactMethods.methodType, value: contactMethods.value })
      .from(contactMethods)
      .where(and(eq(contactMethods.tenantId, tenantId), inArray(contactMethods.contactId, contactIds)))
    : [];
  const methodsByContact = new Map<string, Array<{ methodType: string; value: string }>>();
  for (const row of methodRows) {
    const list = methodsByContact.get(row.contactId) ?? [];
    list.push({ methodType: row.methodType, value: row.value });
    methodsByContact.set(row.contactId, list);
  }
  const contactsByHousehold = new Map<string, CustomerCandidate["contacts"]>();
  for (const row of contactRows) {
    if (!row.householdId) continue;
    const list = contactsByHousehold.get(row.householdId) ?? [];
    list.push({ id: row.id, name: row.name, role: row.role, methods: methodsByContact.get(row.id) ?? [] });
    contactsByHousehold.set(row.householdId, list);
  }
  return {
    candidates: householdRows.map((row) => ({
      id: row.id,
      address: row.address,
      contactInfo: row.contactInfo,
      createdAt: row.createdAt,
      contacts: contactsByHousehold.get(row.id) ?? [],
    })),
    candidateTruncated,
  };
}

function customerLookupRows(
  candidates: CustomerCandidate[],
  request: CustomerLookupRequest,
): Array<CustomerLookupRow & { score: number }> {
  const selector = [request.query, request.name, request.address, request.contact].filter((value): value is string => Boolean(value?.trim())).join(" ").trim();
  const normalizedSelector = normalizeLookup(selector);
  const selectorDigits = digits(selector);
  return candidates.map((candidate) => {
    const matched = new Set<CustomerLookupRow["matchedBy"][number]>();
    let score = 0;
    if (request.householdId && candidate.id === request.householdId) {
      matched.add("household_id");
      score = 10_000;
    }
    for (const alias of customerAliases(candidate)) {
      const normalizedAlias = normalizeLookup(alias.value);
      const aliasDigits = digits(alias.value);
      const exact = alias.kind === "phone"
        ? selectorDigits.length >= 7 && aliasDigits.includes(selectorDigits)
        : Boolean(normalizedSelector) && (normalizedAlias === normalizedSelector || normalizedAlias.includes(normalizedSelector) || normalizedSelector.includes(normalizedAlias));
      const fuzzy = alias.kind === "name" && fuzzyNameMatch(normalizedSelector, normalizedAlias);
      if (!exact && !fuzzy) continue;
      matched.add(alias.kind);
      const kindScore = alias.kind === "phone" || alias.kind === "email" ? 5_000 : alias.kind === "name" ? 4_000 : 3_000;
      score = Math.max(score, kindScore + normalizedAlias.length - (fuzzy ? 500 : 0));
    }
    return {
      householdId: candidate.id,
      displayName: displayName(candidate.contactInfo, candidate.contacts[0]?.name ?? null),
      address: candidate.address,
      contacts: candidate.contacts,
      matchedBy: [...matched].sort(),
      createdAt: requiredIso(candidate.createdAt),
      score,
    };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.householdId.localeCompare(b.householdId));
}

async function customerLookup(
  db: Db,
  tenantId: string,
  request: CustomerLookupRequest,
  asOf: string,
  options: QueryOptions,
): Promise<CustomerLookupResult> {
  const page = pageContext(request.page, options);
  validateCursorKeys(page.cursor, { score: "number", id: "string" });
  const loaded = await loadCustomerCandidates(db, tenantId, request);
  const allMatches = customerLookupRows(loaded.candidates, request);
  const globalBestScore = allMatches[0]?.score ?? 0;
  const globalTied = globalBestScore > 0 ? allMatches.filter((row) => row.score === globalBestScore) : [];
  const globalSelected = exactLookupCandidateSet(globalTied, request);
  const cursorScore = typeof page.cursor?.score === "number" ? page.cursor.score : null;
  const cursorId = cursorString(page.cursor, "id");
  // Lookup rows are score-desc/id-asc. The cursor is applied before resolution
  // selection so page 2 cannot repeat page 1 and ties remain deterministic.
  const matches = cursorScore === null || !cursorId
    ? globalSelected
    : globalSelected.filter((row) => row.score < cursorScore || (row.score === cursorScore && row.householdId > cursorId));
  const exactId = Boolean(request.householdId);
  const resolution: CustomerLookupResult["resolution"] = exactId
    ? (allMatches.length > 0 ? "exact" : "not_found")
    : allMatches.length === 0 ? "not_found" : globalTied.length > 1 ? "ambiguous" : "unique";
  const selected = matches.slice(0, page.limit + 1);
  const hasMore = loaded.candidateTruncated || selected.length > page.limit;
  const rows = selected.slice(0, page.limit).map(({ score: _score, ...row }) => row);
  const next = hasMore && rows.length > 0 ? encodeCursor({ score: selected[page.limit - 1]?.score ?? 0, id: rows[rows.length - 1]!.householdId }) : null;
  const sourceInfo = source(["households", "contacts", "contact_methods"]);
  const totalCount = loaded.candidateTruncated ? null : globalSelected.length;
  const info = pageInfo(page.limit, rows.length, hasMore, next, totalCount, totalCount !== null);
  return { ...base("customer_lookup", sourceInfo, asOf, info), resolution, rows };
}

function exactLookupCandidateSet<T extends { score: number }>(
  topTied: T[],
  request: CustomerLookupRequest,
): T[] {
  // The exact household id path has already constrained candidates to one row;
  // otherwise only the globally best score (including all ties) is a valid lookup
  // result. Lower-score candidates are not silently exposed on later pages.
  if (request.householdId) return topTied.slice(0, 1);
  return topTied;
}

async function customerCohort(
  db: Db,
  tenantId: string,
  request: CustomerCohortRequest,
  asOf: string,
  options: QueryOptions,
): Promise<CustomerCohortResult> {
  if (request.cohort !== "inactive") throw new Error("Unsupported customer cohort");
  if (!Number.isInteger(request.minDaysInactive) || request.minDaysInactive < 0 || request.minDaysInactive > 36_500) {
    throw new Error("minDaysInactive must be an integer between 0 and 36500");
  }
  const page = pageContext(request.page, options);
  const asOfDate = parseDate(asOf, "asOf");
  const cutoffDate = new Date(asOfDate.getTime() - request.minDaysInactive * 86_400_000);
  validateCursorKeys(page.cursor, { id: "string" });
  const cursorId = cursorString(page.cursor, "id");
  const cursorPredicate = cursorId ? sql`AND eligible.household_id > ${cursorId}` : sql``;
  const result = await db.execute(sql`
    WITH latest_interactions AS (
      SELECT interaction.household_id, max(interaction.occurred_at) AS last_interaction_at
      FROM (
        SELECT c.household_id, c.last_activity_at AS occurred_at
        FROM finnor_os.conversations c
        WHERE c.tenant_id = ${tenantId}
          AND c.household_id IS NOT NULL
        UNION ALL
        SELECT c.household_id, m.sent_at AS occurred_at
        FROM finnor_os.messages m
        INNER JOIN finnor_os.conversations c
          ON c.id = m.conversation_id
         AND c.tenant_id = ${tenantId}
        WHERE m.tenant_id = ${tenantId}
          AND c.household_id IS NOT NULL
        UNION ALL
        SELECT cl.household_id, cl."timestamp" AS occurred_at
        FROM finnor_os.communications_log cl
        INNER JOIN finnor_os.households scoped_h
          ON scoped_h.id = cl.household_id
         AND scoped_h.tenant_id = ${tenantId}
        UNION ALL
        SELECT sv.household_id, sv.completed_at AS occurred_at
        FROM finnor_os.service_visits sv
        INNER JOIN finnor_os.households scoped_h
          ON scoped_h.id = sv.household_id
         AND scoped_h.tenant_id = ${tenantId}
        WHERE sv.completed_at IS NOT NULL
      ) interaction
      GROUP BY interaction.household_id
    ), eligible AS (
      SELECT
        h.id AS household_id,
        h.address,
        h.contact_info,
        latest.last_interaction_at
      FROM finnor_os.households h
      LEFT JOIN latest_interactions latest ON latest.household_id = h.id
      WHERE h.tenant_id = ${tenantId}
        AND (latest.last_interaction_at < ${cutoffDate} OR (latest.last_interaction_at IS NULL AND h.created_at < ${cutoffDate}))
    )
    SELECT eligible.*
    FROM eligible
    WHERE 1 = 1 ${cursorPredicate}
    ORDER BY eligible.household_id ASC
    LIMIT ${page.limit + 1}
  `);
  const countResult = await db.execute(sql`
    WITH latest_interactions AS (
      SELECT interaction.household_id, max(interaction.occurred_at) AS last_interaction_at
      FROM (
        SELECT c.household_id, c.last_activity_at AS occurred_at
        FROM finnor_os.conversations c
        WHERE c.tenant_id = ${tenantId} AND c.household_id IS NOT NULL
        UNION ALL
        SELECT c.household_id, m.sent_at AS occurred_at
        FROM finnor_os.messages m
        INNER JOIN finnor_os.conversations c
          ON c.id = m.conversation_id AND c.tenant_id = ${tenantId}
        WHERE m.tenant_id = ${tenantId} AND c.household_id IS NOT NULL
        UNION ALL
        SELECT cl.household_id, cl."timestamp" AS occurred_at
        FROM finnor_os.communications_log cl
        INNER JOIN finnor_os.households scoped_h
          ON scoped_h.id = cl.household_id AND scoped_h.tenant_id = ${tenantId}
        UNION ALL
        SELECT sv.household_id, sv.completed_at AS occurred_at
        FROM finnor_os.service_visits sv
        INNER JOIN finnor_os.households scoped_h
          ON scoped_h.id = sv.household_id AND scoped_h.tenant_id = ${tenantId}
        WHERE sv.completed_at IS NOT NULL
      ) interaction
      GROUP BY interaction.household_id
    )
    SELECT count(*)::int AS total_count
    FROM finnor_os.households h
    LEFT JOIN latest_interactions latest ON latest.household_id = h.id
    WHERE h.tenant_id = ${tenantId}
      AND (latest.last_interaction_at < ${cutoffDate} OR (latest.last_interaction_at IS NULL AND h.created_at < ${cutoffDate}))
  `);
  const rows = (result.rows as Array<Record<string, unknown>>);
  const countRows = countResult.rows as Array<Record<string, unknown>>;
  const totalCount = numberValue(countRows[0]?.total_count);
  const hasMore = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit).map((row) => ({
    householdId: textValue(row.household_id),
    displayName: displayName(row.contact_info),
    address: textValue(row.address),
    lastInteractionAt: iso(row.last_interaction_at as Date | string | null),
    qualifiesBecause: row.last_interaction_at === null || row.last_interaction_at === undefined ? "never_active" as const : "before_cutoff" as const,
  }));
  const next = hasMore && pageRows.length > 0 ? encodeCursor({ id: pageRows[pageRows.length - 1]!.householdId }) : null;
  const sourceInfo = source(["households", "conversations", "messages", "communications_log", "service_visits"]);
  const info = pageInfo(page.limit, pageRows.length, hasMore, next, totalCount, true);
  return {
    ...base("customer_cohort", sourceInfo, asOf, info),
    cohort: "inactive",
    minDaysInactive: request.minDaysInactive,
    cutoff: cutoffDate.toISOString(),
    rows: pageRows,
  };
}

interface InternalScheduleRow extends ScheduleRow {
  at: Date;
}

function sortSchedule(a: InternalScheduleRow, b: InternalScheduleRow): number {
  return a.at.getTime() - b.at.getTime() || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}

async function scheduleRange(
  db: Db,
  tenantId: string,
  request: ScheduleRangeRequest,
  asOf: string,
  options: QueryOptions,
): Promise<ScheduleRangeResult> {
  const resolved = await resolveTenantRange(db, tenantId, request, asOf);
  const normalized = resolved.range;
  const page = pageContext(request.page, options);
  validateCursorKeys(page.cursor, { at: "string", kind: "string", id: "string" });
  if (page.cursor && !["appointment", "service_visit", "work_order"].includes(cursorString(page.cursor, "kind") ?? "")) throw new Error("Invalid schedule cursor kind");
  const appointmentAfter = afterAscendingTimestampKindId(appointments.scheduledAt, "appointment", appointments.id, page.cursor);
  const serviceVisitAfter = afterAscendingTimestampKindId(serviceVisits.scheduledAt, "service_visit", serviceVisits.id, page.cursor);
  const workOrderAfter = afterAscendingTimestampKindId(workOrders.scheduledAt, "work_order", workOrders.id, page.cursor);
  const appointmentWhere = [
    eq(appointments.tenantId, tenantId),
    isNull(appointments.archivedAt),
    gte(appointments.scheduledAt, normalized.startDate),
    lt(appointments.scheduledAt, normalized.endDate),
    ...(appointmentAfter ? [appointmentAfter] : []),
  ];
  const serviceVisitWhere = [
    eq(households.tenantId, tenantId),
    gte(serviceVisits.scheduledAt, normalized.startDate),
    lt(serviceVisits.scheduledAt, normalized.endDate),
    isNotNull(serviceVisits.scheduledAt),
    ...(serviceVisitAfter ? [serviceVisitAfter] : []),
  ];
  const workOrderWhere = [
    eq(workOrders.tenantId, tenantId),
    isNull(workOrders.archivedAt),
    gte(workOrders.scheduledAt, normalized.startDate),
    lt(workOrders.scheduledAt, normalized.endDate),
    isNotNull(workOrders.scheduledAt),
    ...(workOrderAfter ? [workOrderAfter] : []),
  ];

  const appointmentRows = await db.select({
    id: appointments.id,
    subjectType: appointments.subjectType,
    subjectId: appointments.subjectId,
    technicianId: appointments.technicianId,
    status: appointments.status,
    scheduledAt: appointments.scheduledAt,
    durationMinutes: appointments.durationMinutes,
  }).from(appointments).where(and(...appointmentWhere)).orderBy(asc(appointments.scheduledAt), asc(appointments.id)).limit(page.limit + 1);

  const serviceVisitRows = await db.select({
    id: serviceVisits.id,
    householdId: serviceVisits.householdId,
    technicianId: serviceVisits.technicianId,
    completedAt: serviceVisits.completedAt,
    scheduledAt: serviceVisits.scheduledAt,
    householdAddress: households.address,
    householdContactInfo: households.contactInfo,
    technicianName: technicians.name,
  }).from(serviceVisits)
    .innerJoin(households, eq(households.id, serviceVisits.householdId))
    .leftJoin(technicians, and(eq(technicians.id, serviceVisits.technicianId), eq(technicians.tenantId, tenantId)))
    .where(and(...serviceVisitWhere))
    .orderBy(asc(serviceVisits.scheduledAt), asc(serviceVisits.id))
    .limit(page.limit + 1);

  const workOrderRows = await db.select({
    id: workOrders.id,
    householdId: workOrders.householdId,
    technicianId: workOrders.technicianId,
    type: workOrders.type,
    status: workOrders.status,
    scheduledAt: workOrders.scheduledAt,
    householdAddress: households.address,
    householdContactInfo: households.contactInfo,
    technicianName: technicians.name,
  }).from(workOrders)
    .innerJoin(households, and(eq(households.id, workOrders.householdId), eq(households.tenantId, tenantId)))
    .leftJoin(technicians, and(eq(technicians.id, workOrders.technicianId), eq(technicians.tenantId, tenantId)))
    .where(and(...workOrderWhere))
    .orderBy(asc(workOrders.scheduledAt), asc(workOrders.id))
    .limit(page.limit + 1);

  const workOrderIds = appointmentRows.filter((row) => row.subjectType === "work_order").map((row) => row.subjectId);
  const leadIds = appointmentRows.filter((row) => row.subjectType === "lead").map((row) => row.subjectId);
  const subjectWorkOrders = workOrderIds.length > 0
    ? await db.select({ id: workOrders.id, householdId: workOrders.householdId }).from(workOrders).where(and(
      eq(workOrders.tenantId, tenantId),
      isNull(workOrders.archivedAt),
      inArray(workOrders.id, workOrderIds),
    ))
    : [];
  const subjectLeads = leadIds.length > 0
    ? await db.select({ id: leads.id, householdId: leads.householdId }).from(leads).where(and(
      eq(leads.tenantId, tenantId),
      isNull(leads.archivedAt),
      inArray(leads.id, leadIds),
    ))
    : [];
  const householdIds = [...new Set([
    ...appointmentRows.filter((row) => row.subjectType === "household").map((row) => row.subjectId),
    ...subjectWorkOrders.map((row) => row.householdId),
    ...subjectLeads.map((row) => row.householdId),
  ].filter((value): value is string => Boolean(value)))];
  const householdRows = householdIds.length > 0
    ? await db.select({ id: households.id, address: households.address, contactInfo: households.contactInfo }).from(households).where(and(
      eq(households.tenantId, tenantId),
      inArray(households.id, householdIds),
    ))
    : [];
  const householdById = new Map(householdRows.map((row) => [row.id, row]));
  const appointmentHouseholdId = new Map<string, string | null>();
  for (const row of subjectWorkOrders) appointmentHouseholdId.set(row.id, row.householdId);
  for (const row of subjectLeads) appointmentHouseholdId.set(row.id, row.householdId);
  const appointmentTechnicianIds = appointmentRows.map((row) => row.technicianId).filter((value): value is string => Boolean(value));
  const appointmentTechnicians = appointmentTechnicianIds.length > 0
    ? await db.select({ id: technicians.id, name: technicians.name }).from(technicians).where(and(
      eq(technicians.tenantId, tenantId),
      inArray(technicians.id, appointmentTechnicianIds),
    ))
    : [];
  const technicianById = new Map(appointmentTechnicians.map((row) => [row.id, row]));

  const appointmentSchedule: InternalScheduleRow[] = appointmentRows.map((row) => {
    const householdId = row.subjectType === "household" ? row.subjectId : appointmentHouseholdId.get(row.subjectId) ?? null;
    const household = householdId ? householdById.get(householdId) : undefined;
    const technician = row.technicianId ? technicianById.get(row.technicianId) : undefined;
    return {
      kind: "appointment",
      id: row.id,
      at: row.scheduledAt,
      scheduledAt: requiredIso(row.scheduledAt),
      status: row.status,
      technician: technician ? { id: technician.id, name: technician.name } : null,
      household: household ? { id: household.id, displayName: displayName(household.contactInfo), address: household.address } : null,
      subjectType: row.subjectType,
      durationMinutes: row.durationMinutes,
    };
  });
  const serviceVisitSchedule: InternalScheduleRow[] = serviceVisitRows.map((row) => ({
    kind: "service_visit",
    id: row.id,
    at: row.scheduledAt!,
    scheduledAt: requiredIso(row.scheduledAt!),
    status: row.completedAt ? "completed" : "scheduled",
    technician: row.technicianId && row.technicianName ? { id: row.technicianId, name: row.technicianName } : null,
    household: { id: row.householdId, displayName: displayName(row.householdContactInfo), address: row.householdAddress },
  }));
  const workOrderSchedule: InternalScheduleRow[] = workOrderRows.map((row) => ({
    kind: "work_order",
    id: row.id,
    at: row.scheduledAt!,
    scheduledAt: requiredIso(row.scheduledAt!),
    status: row.status,
    technician: row.technicianId && row.technicianName ? { id: row.technicianId, name: row.technicianName } : null,
    household: { id: row.householdId, displayName: displayName(row.householdContactInfo), address: row.householdAddress },
  }));
  const merged = [...appointmentSchedule, ...serviceVisitSchedule, ...workOrderSchedule].sort(sortSchedule);

  // Count the complete half-open source sets separately; cursor predicates are
  // intentionally omitted so every page carries an honest totalCount.
  const [appointmentCount] = await db.select({ count: sql<number>`count(*)::int` }).from(appointments).where(and(
    eq(appointments.tenantId, tenantId),
    isNull(appointments.archivedAt),
    gte(appointments.scheduledAt, normalized.startDate),
    lt(appointments.scheduledAt, normalized.endDate),
  ));
  const [serviceVisitCount] = await db.select({ count: sql<number>`count(*)::int` }).from(serviceVisits)
    .innerJoin(households, eq(households.id, serviceVisits.householdId))
    .where(and(
      eq(households.tenantId, tenantId),
      gte(serviceVisits.scheduledAt, normalized.startDate),
      lt(serviceVisits.scheduledAt, normalized.endDate),
      isNotNull(serviceVisits.scheduledAt),
    ));
  const [workOrderCount] = await db.select({ count: sql<number>`count(*)::int` }).from(workOrders)
    .where(and(
      eq(workOrders.tenantId, tenantId),
      isNull(workOrders.archivedAt),
      gte(workOrders.scheduledAt, normalized.startDate),
      lt(workOrders.scheduledAt, normalized.endDate),
      isNotNull(workOrders.scheduledAt),
    ));
  const totalCount = numberValue(appointmentCount?.count) + numberValue(serviceVisitCount?.count) + numberValue(workOrderCount?.count);
  const hasMore = merged.length > page.limit;
  const rows = merged.slice(0, page.limit).map(({ at: _at, ...row }) => row);
  const last = rows[rows.length - 1];
  const next = hasMore && last ? encodeCursor({ at: last.scheduledAt, kind: last.kind, id: last.id }) : null;
  const sourceInfo = source(["appointments", "service_visits", "work_orders", "households", "technicians"]);
  const info = pageInfo(page.limit, rows.length, hasMore, next, totalCount, true);
  return {
    ...base("schedule_range", sourceInfo, asOf, info),
    range: { start: normalized.start, end: normalized.end },
    timeZone: resolved.timeZone,
    ...(resolved.localDateRange ? { localDateRange: resolved.localDateRange } : {}),
    rows,
  };
}

function moneyRange(request: MoneySummaryRequest): { range: { start: string; end: string } | null; startDate: Date | null; endDate: Date | null } {
  if (request.range && (request.start !== undefined || request.end !== undefined)) {
    throw new Error("money_summary accepts either range or start/end, not both");
  }
  if (request.range) {
    const normalized = normalizedRange(request.range, "range");
    return { range: { start: normalized.start, end: normalized.end }, startDate: normalized.startDate, endDate: normalized.endDate };
  }
  if (request.start || request.end) {
    if (!request.start || !request.end) throw new Error("money_summary start and end must be supplied together");
    const normalized = normalizedRange({ start: request.start, end: request.end }, "range");
    return { range: { start: normalized.start, end: normalized.end }, startDate: normalized.startDate, endDate: normalized.endDate };
  }
  return { range: null, startDate: null, endDate: null };
}

async function moneySummary(
  db: Db,
  tenantId: string,
  request: MoneySummaryRequest,
  asOf: string,
  options: QueryOptions,
): Promise<MoneySummaryResult> {
  const range = moneyRange(request);
  const page = pageContext(request.page, options);
  if (page.cursor) throw new Error("money_summary is a bounded aggregate and does not accept a cursor");
  const invoiceWhere = [
    eq(invoices.tenantId, tenantId),
    ...(range.startDate && range.endDate ? [gte(invoices.createdAt, range.startDate), lt(invoices.createdAt, range.endDate)] : []),
  ];
  const paymentWhere = [
    eq(payments.tenantId, tenantId),
    ...(range.startDate && range.endDate ? [gte(payments.receivedAt, range.startDate), lt(payments.receivedAt, range.endDate)] : []),
  ];
  const invoiceRows = await db.select({
    status: invoices.status,
    count: sql<number>`count(*)::int`,
    totalUsd: sql<string>`coalesce(sum(${invoices.amountUsd}), 0)`,
  }).from(invoices).where(and(...invoiceWhere)).groupBy(invoices.status).orderBy(asc(invoices.status));
  const collectionRows = await db.select({
    status: payments.status,
    count: sql<number>`count(*)::int`,
    totalUsd: sql<string>`coalesce(sum(${payments.amountUsd}), 0)`,
  }).from(payments)
    .innerJoin(invoices, and(eq(invoices.id, payments.invoiceId), eq(invoices.tenantId, tenantId)))
    .where(and(...paymentWhere))
    .groupBy(payments.status)
    .orderBy(asc(payments.status));
  const invoicesSummary: MoneyStatusSummary[] = invoiceRows.map((row) => ({ status: row.status, count: numberValue(row.count), totalUsd: numberValue(row.totalUsd) }));
  const collectionsSummary: MoneyStatusSummary[] = collectionRows.map((row) => ({ status: row.status, count: numberValue(row.count), totalUsd: numberValue(row.totalUsd) }));
  const invoicedUsd = invoicesSummary.filter((row) => row.status !== "void").reduce((sum, row) => sum + row.totalUsd, 0);
  const collectedUsd = collectionsSummary.filter((row) => row.status === "succeeded").reduce((sum, row) => sum + row.totalUsd, 0);
  const pendingInvoiceUsd = invoicesSummary.filter((row) => row.status === "sent" || row.status === "overdue").reduce((sum, row) => sum + row.totalUsd, 0);
  const [paymentLinksRow] = range.range
    ? [{ count: null as number | null }]
    : await db.select({ count: sql<number>`count(*)::int` }).from(workflowSteps).where(and(
      eq(workflowSteps.tenantId, tenantId),
      eq(workflowSteps.stepType, "create_payment_link"),
      inArray(workflowSteps.status, ["pending", "leased", "completed"]),
    ));
  const info = pageInfo(
    Math.max(page.limit, invoicesSummary.length + collectionsSummary.length),
    invoicesSummary.length + collectionsSummary.length,
    false,
    null,
    invoicesSummary.length + collectionsSummary.length,
    true,
  );
  const sourceInfo = source(["invoices", "payments", "workflow_steps"]);
  return {
    ...base("money_summary", sourceInfo, asOf, info),
    range: range.range,
    paymentLinksAwaitingPayment: paymentLinksRow?.count ?? null,
    invoices: invoicesSummary,
    collections: collectionsSummary,
    totals: {
      invoicedUsd,
      collectedUsd,
      // Invoice status is the canonical outstanding signal. Do not subtract
      // succeeded payments here: invoice.created_at and payment.received_at may
      // be filtered by the same half-open range but represent different events.
      pendingCollectionUsd: pendingInvoiceUsd,
    },
  };
}

function statusFilter(column: AnyColumn, statuses: string[] | undefined): SQL | undefined {
  return statuses && statuses.length > 0 ? inArray(column, statuses) : undefined;
}

const OPEN_WORK_STATUSES = ["received", "understanding", "planning", "ready", "actionable", "awaiting_approval", "executing"] as const;
const OPEN_WORK_ORDER_STATUSES = ["draft", "scheduled", "in_progress"] as const;
const OPEN_TASK_STATUSES = ["open"] as const;

async function workList(
  db: Db,
  tenantId: string,
  request: WorkListRequest,
  asOf: string,
  options: QueryOptions,
): Promise<WorkListResult> {
  const page = pageContext(request.page, options);
  validateSectionCursors(page.cursor, {
    works: { at: "string", id: "string" },
    workOrders: { at: "string", id: "string" },
    tasks: { at: "string", id: "string" },
  });
  const selected = request.section ?? "all";
  const includeWorks = selected === "all" || selected === "works";
  const includeWorkOrders = selected === "all" || selected === "work_orders";
  const includeTasks = selected === "all" || selected === "tasks";
  const rootLimit = page.limit * [includeWorks, includeWorkOrders, includeTasks].filter(Boolean).length;
  const statuses = request.statuses?.map((status) => status.trim()).filter(Boolean);
  const workStatuses = request.openOnly ? [...OPEN_WORK_STATUSES] : statuses;
  const workOrderStatuses = request.openOnly ? [...OPEN_WORK_ORDER_STATUSES] : statuses;
  const taskStatuses = request.openOnly ? [...OPEN_TASK_STATUSES] : statuses;
  const rootCursor = sectionCursor(page.cursor, "works");
  const orderCursor = sectionCursor(page.cursor, "workOrders");
  const taskCursor = sectionCursor(page.cursor, "tasks");
  const worksWhere = [
    eq(works.tenantId, tenantId),
    ...(request.recordId ? [eq(works.id, request.recordId)] : []),
    ...(statusFilter(works.status, workStatuses) ? [statusFilter(works.status, workStatuses)!] : []),
    ...(afterDescendingTimestampId(works.updatedAt, works.id, rootCursor) ? [afterDescendingTimestampId(works.updatedAt, works.id, rootCursor)!] : []),
  ];
  const worksCountWhere = [
    eq(works.tenantId, tenantId),
    ...(request.recordId ? [eq(works.id, request.recordId)] : []),
    ...(statusFilter(works.status, workStatuses) ? [statusFilter(works.status, workStatuses)!] : []),
  ];
  const workOrderWhere = [
    eq(workOrders.tenantId, tenantId),
    isNull(workOrders.archivedAt),
    ...(request.recordId ? [eq(workOrders.id, request.recordId)] : []),
    ...(statusFilter(workOrders.status, workOrderStatuses) ? [statusFilter(workOrders.status, workOrderStatuses)!] : []),
    ...(afterDescendingTimestampId(workOrders.createdAt, workOrders.id, orderCursor) ? [afterDescendingTimestampId(workOrders.createdAt, workOrders.id, orderCursor)!] : []),
  ];
  const taskWhere = [
    eq(tasks.tenantId, tenantId),
    isNull(tasks.archivedAt),
    ...(request.recordId ? [sql`false`] : []),
    ...(statusFilter(tasks.status, taskStatuses) ? [statusFilter(tasks.status, taskStatuses)!] : []),
    ...(afterDescendingTimestampId(tasks.createdAt, tasks.id, taskCursor) ? [afterDescendingTimestampId(tasks.createdAt, tasks.id, taskCursor)!] : []),
  ];

  const workRows = includeWorks
    ? await db.select({
      id: works.id,
      status: works.status,
      channel: works.initialChannel,
      sessionId: works.sessionId,
      createdAt: works.createdAt,
      updatedAt: works.updatedAt,
    }).from(works).where(and(...worksWhere)).orderBy(desc(works.updatedAt), desc(works.id)).limit(page.limit + 1)
    : [];
  const workOrderRows = includeWorkOrders
    ? await db.select({
      id: workOrders.id,
      householdId: workOrders.householdId,
      householdAddress: households.address,
      householdContactInfo: households.contactInfo,
      technicianId: workOrders.technicianId,
      technicianName: technicians.name,
      type: workOrders.type,
      status: workOrders.status,
      scheduledAt: workOrders.scheduledAt,
      createdAt: workOrders.createdAt,
    }).from(workOrders)
      .innerJoin(households, and(eq(households.id, workOrders.householdId), eq(households.tenantId, tenantId)))
      .leftJoin(technicians, and(eq(technicians.id, workOrders.technicianId), eq(technicians.tenantId, tenantId)))
      .where(and(...workOrderWhere)).orderBy(desc(workOrders.createdAt), desc(workOrders.id)).limit(page.limit + 1)
    : [];
  const taskRows = includeTasks
    ? await db.select({
      id: tasks.id,
      subjectType: tasks.subjectType,
      subjectId: tasks.subjectId,
      title: tasks.title,
      dueAt: tasks.dueAt,
      assigneeType: tasks.assigneeType,
      assigneeId: tasks.assigneeId,
      status: tasks.status,
      priority: tasks.priority,
      createdAt: tasks.createdAt,
    }).from(tasks).where(and(...taskWhere)).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(page.limit + 1)
    : [];

  const worksCount = includeWorks
    ? await db.select({ count: sql<number>`count(*)::int` }).from(works).where(and(...worksCountWhere))
    : [{ count: 0 }];
  const workOrdersCount = includeWorkOrders
    ? await db.select({ count: sql<number>`count(*)::int` }).from(workOrders).where(and(
      eq(workOrders.tenantId, tenantId),
      isNull(workOrders.archivedAt),
      ...(request.recordId ? [eq(workOrders.id, request.recordId)] : []),
      ...(statusFilter(workOrders.status, workOrderStatuses) ? [statusFilter(workOrders.status, workOrderStatuses)!] : []),
    ))
    : [{ count: 0 }];
  const tasksCount = includeTasks
    ? await db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(and(
      eq(tasks.tenantId, tenantId),
      isNull(tasks.archivedAt),
      ...(request.recordId ? [sql`false`] : []),
      ...(statusFilter(tasks.status, taskStatuses) ? [statusFilter(tasks.status, taskStatuses)!] : []),
    ))
    : [{ count: 0 }];

  const worksHasMore = workRows.length > page.limit;
  const workOrdersHasMore = workOrderRows.length > page.limit;
  const tasksHasMore = taskRows.length > page.limit;
  const worksOut = workRows.slice(0, page.limit).map((row) => ({
    id: row.id,
    status: row.status,
    channel: row.channel,
    sessionId: row.sessionId,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  }));
  const workOrdersOut = workOrderRows.slice(0, page.limit).map((row) => ({
    id: row.id,
    household: { id: row.householdId, displayName: displayName(row.householdContactInfo), address: row.householdAddress },
    technician: row.technicianId && row.technicianName ? { id: row.technicianId, name: row.technicianName } : null,
    type: row.type,
    status: row.status,
    scheduledAt: iso(row.scheduledAt),
    createdAt: requiredIso(row.createdAt),
  }));
  const tasksOut = taskRows.slice(0, page.limit).map((row) => ({
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    title: boundedTitle(row.title),
    dueAt: iso(row.dueAt),
    assigneeType: row.assigneeType,
    assigneeId: row.assigneeId,
    status: row.status,
    priority: row.priority,
    createdAt: requiredIso(row.createdAt),
  }));
  const workTotal = numberValue(worksCount[0]?.count);
  const workOrderTotal = numberValue(workOrdersCount[0]?.count);
  const taskTotal = numberValue(tasksCount[0]?.count);
  const worksPage = pageInfo(page.limit, worksOut.length, worksHasMore, worksHasMore && worksOut.length > 0 ? encodeCursor({ at: worksOut[worksOut.length - 1]!.updatedAt, id: worksOut[worksOut.length - 1]!.id }) : null, workTotal, true);
  const workOrdersPage = pageInfo(page.limit, workOrdersOut.length, workOrdersHasMore, workOrdersHasMore && workOrdersOut.length > 0 ? encodeCursor({ at: workOrdersOut[workOrdersOut.length - 1]!.createdAt, id: workOrdersOut[workOrdersOut.length - 1]!.id }) : null, workOrderTotal, true);
  const tasksPage = pageInfo(page.limit, tasksOut.length, tasksHasMore, tasksHasMore && tasksOut.length > 0 ? encodeCursor({ at: tasksOut[tasksOut.length - 1]!.createdAt, id: tasksOut[tasksOut.length - 1]!.id }) : null, taskTotal, true);
  const hasMore = worksHasMore || workOrdersHasMore || tasksHasMore;
  // Preserve every section cursor while another section is still advancing. A
  // section that exhausted on this page must not restart from its first row on
  // the next root page.
  const nextSections: Cursor = { ...(page.cursor ?? {}) };
  if (includeWorks && worksOut.length > 0) nextSections.works = { at: worksOut[worksOut.length - 1]!.updatedAt, id: worksOut[worksOut.length - 1]!.id };
  if (includeWorkOrders && workOrdersOut.length > 0) nextSections.workOrders = { at: workOrdersOut[workOrdersOut.length - 1]!.createdAt, id: workOrdersOut[workOrdersOut.length - 1]!.id };
  if (includeTasks && tasksOut.length > 0) nextSections.tasks = { at: tasksOut[tasksOut.length - 1]!.createdAt, id: tasksOut[tasksOut.length - 1]!.id };
  const totalCount = workTotal + workOrderTotal + taskTotal;
  const returned = worksOut.length + workOrdersOut.length + tasksOut.length;
  const pageInfoValue = pageInfo(rootLimit, returned, hasMore, hasMore ? encodeCursor(nextSections) : null, totalCount, true);
  const sourceInfo = source(["works", "work_orders", "tasks", "households", "technicians"]);
  return {
    ...base("work_list", sourceInfo, asOf, pageInfoValue),
    works: worksOut,
    workOrders: workOrdersOut,
    tasks: tasksOut,
    sectionPages: { works: worksPage, workOrders: workOrdersPage, tasks: tasksPage },
  };
}

async function inventoryStatus(
  db: Db,
  tenantId: string,
  request: InventoryStatusRequest,
  asOf: string,
  options: QueryOptions,
): Promise<InventoryStatusResult> {
  const page = pageContext(request.page, options);
  validateSectionCursors(page.cursor, {
    items: { id: "string" },
    warehouseStock: { id: "string" },
    openProcurement: { id: "string" },
  });
  const includeProcurement = request.includeOpenProcurement !== false;
  const itemCursor = sectionCursor(page.cursor, "items");
  const stockCursor = sectionCursor(page.cursor, "warehouseStock");
  const procurementCursor = sectionCursor(page.cursor, "openProcurement");
  const lowStockPredicate = request.lowStockOnly ? sql`${inventoryItems.quantity} <= ${inventoryItems.reorderThreshold}` : undefined;
  const stockLowPredicate = request.lowStockOnly ? sql`${warehouseStock.quantity} <= ${warehouseStock.reorderThreshold}` : undefined;
  const itemAfter = afterDescendingId(inventoryItems.id, itemCursor);
  const stockAfter = afterDescendingId(warehouseStock.id, stockCursor);
  const procurementAfter = afterDescendingId(procurementOrders.id, procurementCursor);
  const itemsWhere = [
    eq(inventoryItems.tenantId, tenantId),
    ...(request.sku ? [eq(inventoryItems.sku, request.sku)] : []),
    ...(lowStockPredicate ? [lowStockPredicate] : []),
    ...(itemAfter ? [itemAfter] : []),
  ];
  const stockWhere = [
    eq(warehouseStock.tenantId, tenantId),
    ...(request.sku ? [eq(warehouseStock.sku, request.sku)] : []),
    ...(stockLowPredicate ? [stockLowPredicate] : []),
    ...(stockAfter ? [stockAfter] : []),
  ];
  const procurementWhere = [
    eq(procurementOrders.tenantId, tenantId),
    ...(request.sku ? [eq(procurementOrders.sku, request.sku)] : []),
    inArray(procurementOrders.status, ["draft", "ordered"]),
    ...(procurementAfter ? [procurementAfter] : []),
  ];
  const itemRows = await db.select({
    id: inventoryItems.id,
    sku: inventoryItems.sku,
    name: inventoryItems.name,
    quantity: inventoryItems.quantity,
    reorderThreshold: inventoryItems.reorderThreshold,
    unitCostUsd: inventoryItems.unitCostUsd,
  }).from(inventoryItems).where(and(...itemsWhere)).orderBy(desc(inventoryItems.id)).limit(page.limit + 1);
  const stockRows = await db.select({
    id: warehouseStock.id,
    warehouseId: warehouseStock.warehouseId,
    warehouseName: warehouses.name,
    sku: warehouseStock.sku,
    quantity: warehouseStock.quantity,
    reorderThreshold: warehouseStock.reorderThreshold,
    unitOfMeasure: warehouseStock.unitOfMeasure,
  }).from(warehouseStock)
    .innerJoin(warehouses, and(eq(warehouses.id, warehouseStock.warehouseId), eq(warehouses.tenantId, tenantId)))
    .where(and(...stockWhere)).orderBy(desc(warehouseStock.id)).limit(page.limit + 1);
  const procurementRows = includeProcurement
    ? await db.select({
      id: procurementOrders.id,
      warehouseId: procurementOrders.warehouseId,
      warehouseName: warehouses.name,
      sku: procurementOrders.sku,
      quantityOrdered: procurementOrders.quantityOrdered,
      status: procurementOrders.status,
      expectedAt: procurementOrders.expectedAt,
      createdAt: procurementOrders.createdAt,
    }).from(procurementOrders)
      .innerJoin(warehouses, and(eq(warehouses.id, procurementOrders.warehouseId), eq(warehouses.tenantId, tenantId)))
      .where(and(...procurementWhere)).orderBy(desc(procurementOrders.id)).limit(page.limit + 1)
    : [];

  const [itemCount] = await db.select({ count: sql<number>`count(*)::int` }).from(inventoryItems).where(and(
    eq(inventoryItems.tenantId, tenantId),
    ...(request.sku ? [eq(inventoryItems.sku, request.sku)] : []),
    ...(lowStockPredicate ? [lowStockPredicate] : []),
  ));
  const [stockCount] = await db.select({ count: sql<number>`count(*)::int` }).from(warehouseStock).where(and(
    eq(warehouseStock.tenantId, tenantId),
    ...(request.sku ? [eq(warehouseStock.sku, request.sku)] : []),
    ...(stockLowPredicate ? [stockLowPredicate] : []),
  ));
  const [procurementCount] = includeProcurement
    ? await db.select({ count: sql<number>`count(*)::int` }).from(procurementOrders).where(and(
      eq(procurementOrders.tenantId, tenantId),
      inArray(procurementOrders.status, ["draft", "ordered"]),
      ...(request.sku ? [eq(procurementOrders.sku, request.sku)] : []),
    ))
    : [{ count: 0 }];
  const itemsOut = itemRows.slice(0, page.limit).map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    quantity: row.quantity,
    reorderThreshold: row.reorderThreshold,
    unitCostUsd: nullableNumber(row.unitCostUsd),
    lowStock: row.quantity <= row.reorderThreshold,
  }));
  const stockOut = stockRows.slice(0, page.limit).map((row) => ({
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    sku: row.sku,
    quantity: row.quantity,
    reorderThreshold: row.reorderThreshold,
    unitOfMeasure: row.unitOfMeasure,
    lowStock: row.quantity <= row.reorderThreshold,
  }));
  const procurementOut = procurementRows.slice(0, page.limit).map((row) => ({
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    sku: row.sku,
    quantityOrdered: row.quantityOrdered,
    status: row.status,
    expectedAt: iso(row.expectedAt),
    createdAt: requiredIso(row.createdAt),
  }));
  const itemsHasMore = itemRows.length > page.limit;
  const stockHasMore = stockRows.length > page.limit;
  const procurementHasMore = procurementRows.length > page.limit;
  const itemsTotal = numberValue(itemCount?.count);
  const stockTotal = numberValue(stockCount?.count);
  const procurementTotal = numberValue(procurementCount?.count);
  const itemsPage = pageInfo(page.limit, itemsOut.length, itemsHasMore, itemsHasMore && itemsOut.length > 0 ? encodeCursor({ id: itemsOut[itemsOut.length - 1]!.id }) : null, itemsTotal, true);
  const stockPage = pageInfo(page.limit, stockOut.length, stockHasMore, stockHasMore && stockOut.length > 0 ? encodeCursor({ id: stockOut[stockOut.length - 1]!.id }) : null, stockTotal, true);
  const procurementPage = pageInfo(page.limit, procurementOut.length, procurementHasMore, procurementHasMore && procurementOut.length > 0 ? encodeCursor({ id: procurementOut[procurementOut.length - 1]!.id }) : null, procurementTotal, true);
  const hasMore = itemsHasMore || stockHasMore || procurementHasMore;
  const nextSections: Cursor = { ...(page.cursor ?? {}) };
  if (itemsOut.length > 0) nextSections.items = { id: itemsOut[itemsOut.length - 1]!.id };
  if (stockOut.length > 0) nextSections.warehouseStock = { id: stockOut[stockOut.length - 1]!.id };
  if (includeProcurement && procurementOut.length > 0) nextSections.openProcurement = { id: procurementOut[procurementOut.length - 1]!.id };
  const returned = itemsOut.length + stockOut.length + procurementOut.length;
  const totalCount = itemsTotal + stockTotal + procurementTotal;
  const rootLimit = page.limit * (includeProcurement ? 3 : 2);
  const info = pageInfo(rootLimit, returned, hasMore, hasMore ? encodeCursor(nextSections) : null, totalCount, true);
  const sourceInfo = source(["inventory_items", "warehouse_stock", "warehouses", "procurement_orders"]);
  return {
    ...base("inventory_status", sourceInfo, asOf, info),
    items: itemsOut,
    warehouseStock: stockOut,
    openProcurement: procurementOut,
    sectionPages: { items: itemsPage, warehouseStock: stockPage, openProcurement: procurementPage },
  };
}

async function agentActivity(
  db: Db,
  tenantId: string,
  request: AgentActivityRequest,
  asOf: string,
  options: QueryOptions,
): Promise<AgentActivityResult> {
  const resolved = await resolveTenantRange(db, tenantId, request, asOf);
  const normalized = resolved.range;
  const page = pageContext(request.page, options);
  validateSectionCursors(page.cursor, {
    users: { at: "string", id: "string" },
    technicians: { id: "string" },
    actions: { at: "string", id: "string" },
    workflows: { at: "string", id: "string" },
    calls: { at: "string", id: "string" },
  });
  const userCursor = sectionCursor(page.cursor, "users");
  const technicianCursor = sectionCursor(page.cursor, "technicians");
  const actionCursor = sectionCursor(page.cursor, "actions");
  const workflowCursor = sectionCursor(page.cursor, "workflows");
  const callCursor = sectionCursor(page.cursor, "calls");
  const userAfter = afterDescendingTimestampId(users.createdAt, users.id, userCursor);
  const technicianAfter = afterDescendingId(technicians.id, technicianCursor);
  const actionAfter = afterDescendingTimestampId(actionLog.timestamp, actionLog.id, actionCursor);
  const workflowAfter = afterDescendingTimestampId(workflowRuns.updatedAt, workflowRuns.id, workflowCursor);
  const callOccurredAt = sql<Date>`coalesce(${calls.startedAt}, ${calls.createdAt})`;
  const callAt = cursorString(callCursor, "at");
  const callId = cursorString(callCursor, "id");
  const callAfter = callAt && callId
    ? or(lt(callOccurredAt, parseDate(callAt, "cursor.at")), and(eq(callOccurredAt, parseDate(callAt, "cursor.at")), lt(calls.id, callId)))
    : undefined;
  const usersWhere = [
    eq(users.tenantId, tenantId),
    gte(users.createdAt, normalized.startDate),
    lt(users.createdAt, normalized.endDate),
    ...(userAfter ? [userAfter] : []),
  ];
  const techniciansWhere = [eq(technicians.tenantId, tenantId), ...(technicianAfter ? [technicianAfter] : [])];
  const actionsWhere = [
    eq(actionLog.tenantId, tenantId),
    gte(actionLog.timestamp, normalized.startDate),
    lt(actionLog.timestamp, normalized.endDate),
    ...(actionAfter ? [actionAfter] : []),
  ];
  const workflowsWhere = [
    eq(workflowRuns.tenantId, tenantId),
    gte(workflowRuns.updatedAt, normalized.startDate),
    lt(workflowRuns.updatedAt, normalized.endDate),
    ...(workflowAfter ? [workflowAfter] : []),
  ];
  const callsWhere = [
    eq(calls.tenantId, tenantId),
    gte(callOccurredAt, normalized.startDate),
    lt(callOccurredAt, normalized.endDate),
    ...(callAfter ? [callAfter] : []),
  ];
  const userRows = await db.select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
    .from(users).where(and(...usersWhere)).orderBy(desc(users.createdAt), desc(users.id)).limit(page.limit + 1);
  const technicianRows = await db.select({ id: technicians.id, name: technicians.name })
    .from(technicians).where(and(...techniciansWhere)).orderBy(desc(technicians.id)).limit(page.limit + 1);
  const actionRows = await db.select({
    id: actionLog.id,
    actionType: domainActions.actionType,
    actionStatus: domainActions.status,
    step: actionLog.step,
    occurredAt: actionLog.timestamp,
  }).from(actionLog)
    .leftJoin(domainActions, and(eq(domainActions.id, actionLog.domainActionId), eq(domainActions.tenantId, tenantId)))
    .where(and(...actionsWhere)).orderBy(desc(actionLog.timestamp), desc(actionLog.id)).limit(page.limit + 1);
  const workflowRows = await db.select({ id: workflowRuns.id, workflowType: workflowRuns.workflowType, status: workflowRuns.status, occurredAt: workflowRuns.updatedAt })
    .from(workflowRuns).where(and(...workflowsWhere)).orderBy(desc(workflowRuns.updatedAt), desc(workflowRuns.id)).limit(page.limit + 1);
  const callRows = await db.select({
    id: calls.id,
    conversationId: calls.conversationId,
    direction: calls.direction,
    startedAt: calls.startedAt,
    endedAt: calls.endedAt,
    endedReason: calls.endedReason,
    occurredAt: callOccurredAt,
  }).from(calls).where(and(...callsWhere)).orderBy(desc(callOccurredAt), desc(calls.id)).limit(page.limit + 1);

  const [userCount] = await db.select({ count: sql<number>`count(*)::int` }).from(users).where(and(
    eq(users.tenantId, tenantId),
    gte(users.createdAt, normalized.startDate),
    lt(users.createdAt, normalized.endDate),
  ));
  const [technicianCount] = await db.select({ count: sql<number>`count(*)::int` }).from(technicians).where(eq(technicians.tenantId, tenantId));
  const [actionCount] = await db.select({ count: sql<number>`count(*)::int` }).from(actionLog).where(and(
    eq(actionLog.tenantId, tenantId),
    gte(actionLog.timestamp, normalized.startDate),
    lt(actionLog.timestamp, normalized.endDate),
  ));
  const [workflowCount] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowRuns).where(and(
    eq(workflowRuns.tenantId, tenantId),
    gte(workflowRuns.updatedAt, normalized.startDate),
    lt(workflowRuns.updatedAt, normalized.endDate),
  ));
  const [callCount] = await db.select({ count: sql<number>`count(*)::int` }).from(calls).where(and(
    eq(calls.tenantId, tenantId),
    gte(callOccurredAt, normalized.startDate),
    lt(callOccurredAt, normalized.endDate),
  ));
  const usersOut = userRows.slice(0, page.limit).map((row) => ({ id: row.id, email: row.email, role: row.role, createdAt: requiredIso(row.createdAt) }));
  const techniciansOut = technicianRows.slice(0, page.limit).map((row) => ({ id: row.id, name: row.name }));
  const actionsOut = actionRows.slice(0, page.limit).map((row) => ({ id: row.id, actionType: row.actionType ?? "unknown", status: row.actionStatus ?? "unknown", step: row.step, occurredAt: requiredIso(row.occurredAt) }));
  const workflowsOut = workflowRows.slice(0, page.limit).map((row) => ({ id: row.id, workflowType: row.workflowType, status: row.status, occurredAt: requiredIso(row.occurredAt) }));
  const callsOut = callRows.slice(0, page.limit).map((row) => ({ id: row.id, conversationId: row.conversationId, direction: row.direction, startedAt: iso(row.startedAt), endedAt: iso(row.endedAt), endedReason: row.endedReason, occurredAt: requiredIso(row.occurredAt) }));
  const usersMore = userRows.length > page.limit;
  const techniciansMore = technicianRows.length > page.limit;
  const actionsMore = actionRows.length > page.limit;
  const workflowsMore = workflowRows.length > page.limit;
  const callsMore = callRows.length > page.limit;
  const usersTotal = numberValue(userCount?.count);
  const techniciansTotal = numberValue(technicianCount?.count);
  const actionsTotal = numberValue(actionCount?.count);
  const workflowsTotal = numberValue(workflowCount?.count);
  const callsTotal = numberValue(callCount?.count);
  const usersPage = pageInfo(page.limit, usersOut.length, usersMore, usersMore && usersOut.length > 0 ? encodeCursor({ at: usersOut[usersOut.length - 1]!.createdAt, id: usersOut[usersOut.length - 1]!.id }) : null, usersTotal, true);
  const techniciansPage = pageInfo(page.limit, techniciansOut.length, techniciansMore, techniciansMore && techniciansOut.length > 0 ? encodeCursor({ id: techniciansOut[techniciansOut.length - 1]!.id }) : null, techniciansTotal, true);
  const actionsPage = pageInfo(page.limit, actionsOut.length, actionsMore, actionsMore && actionsOut.length > 0 ? encodeCursor({ at: actionsOut[actionsOut.length - 1]!.occurredAt, id: actionsOut[actionsOut.length - 1]!.id }) : null, actionsTotal, true);
  const workflowsPage = pageInfo(page.limit, workflowsOut.length, workflowsMore, workflowsMore && workflowsOut.length > 0 ? encodeCursor({ at: workflowsOut[workflowsOut.length - 1]!.occurredAt, id: workflowsOut[workflowsOut.length - 1]!.id }) : null, workflowsTotal, true);
  const callsPage = pageInfo(page.limit, callsOut.length, callsMore, callsMore && callsOut.length > 0 ? encodeCursor({ at: callsOut[callsOut.length - 1]!.occurredAt, id: callsOut[callsOut.length - 1]!.id }) : null, callsTotal, true);
  const hasMore = usersMore || techniciansMore || actionsMore || workflowsMore || callsMore;
  const nextSections: Cursor = { ...(page.cursor ?? {}) };
  if (usersOut.length > 0) nextSections.users = { at: usersOut[usersOut.length - 1]!.createdAt, id: usersOut[usersOut.length - 1]!.id };
  if (techniciansOut.length > 0) nextSections.technicians = { id: techniciansOut[techniciansOut.length - 1]!.id };
  if (actionsOut.length > 0) nextSections.actions = { at: actionsOut[actionsOut.length - 1]!.occurredAt, id: actionsOut[actionsOut.length - 1]!.id };
  if (workflowsOut.length > 0) nextSections.workflows = { at: workflowsOut[workflowsOut.length - 1]!.occurredAt, id: workflowsOut[workflowsOut.length - 1]!.id };
  if (callsOut.length > 0) nextSections.calls = { at: callsOut[callsOut.length - 1]!.occurredAt, id: callsOut[callsOut.length - 1]!.id };
  const returned = usersOut.length + techniciansOut.length + actionsOut.length + workflowsOut.length + callsOut.length;
  const totalCount = usersTotal + techniciansTotal + actionsTotal + workflowsTotal + callsTotal;
  const info = pageInfo(page.limit * 5, returned, hasMore, hasMore ? encodeCursor(nextSections) : null, totalCount, true);
  const sourceInfo = source(["users", "technicians", "action_log", "domain_actions", "workflow_runs", "calls"]);
  return {
    ...base("agent_activity", sourceInfo, asOf, info),
    range: { start: normalized.start, end: normalized.end },
    timeZone: resolved.timeZone,
    ...(resolved.localDateRange ? { localDateRange: resolved.localDateRange } : {}),
    users: usersOut,
    technicians: techniciansOut,
    actions: actionsOut,
    workflows: workflowsOut,
    calls: callsOut,
    sectionPages: { users: usersPage, technicians: techniciansPage, actions: actionsPage, workflows: workflowsPage, calls: callsPage },
  };
}

function countRows(rows: Array<{ status: string; count: unknown }>): BusinessStateCount[] {
  return rows.map((row) => ({ status: row.status, count: numberValue(row.count) }));
}

async function businessState(
  db: Db,
  tenantId: string,
  request: BusinessStateRequest,
  asOf: string,
  options: QueryOptions,
): Promise<BusinessStateResult> {
  const page = pageContext(request.page, options);
  if (page.cursor) throw new Error("business_state is a bounded aggregate and does not accept a cursor");
  const leadsByStatus = await db.select({ status: leads.status, count: sql<number>`count(*)::int` }).from(leads).where(and(eq(leads.tenantId, tenantId), isNull(leads.archivedAt))).groupBy(leads.status).orderBy(asc(leads.status));
  const quotesByStatus = await db.select({ status: quotes.status, count: sql<number>`count(*)::int` }).from(quotes)
    .where(and(eq(quotes.tenantId, tenantId), isNull(quotes.archivedAt))).groupBy(quotes.status).orderBy(asc(quotes.status));
  const proposalsByStatus = await db.select({ status: proposals.status, count: sql<number>`count(*)::int` }).from(proposals)
    .innerJoin(households, eq(households.id, proposals.householdId))
    .where(eq(households.tenantId, tenantId)).groupBy(proposals.status).orderBy(asc(proposals.status));
  const opportunitiesByStage = await db.select({ status: opportunities.pipelineStage, count: sql<number>`count(*)::int` }).from(opportunities).where(and(eq(opportunities.tenantId, tenantId), isNull(opportunities.archivedAt))).groupBy(opportunities.pipelineStage).orderBy(asc(opportunities.pipelineStage));
  const appointmentsByStatus = await db.select({ status: appointments.status, count: sql<number>`count(*)::int` }).from(appointments).where(and(eq(appointments.tenantId, tenantId), isNull(appointments.archivedAt))).groupBy(appointments.status).orderBy(asc(appointments.status));
  const workOrdersByStatus = await db.select({ status: workOrders.status, count: sql<number>`count(*)::int` }).from(workOrders).where(and(eq(workOrders.tenantId, tenantId), isNull(workOrders.archivedAt))).groupBy(workOrders.status).orderBy(asc(workOrders.status));
  const tasksByStatus = await db.select({ status: tasks.status, count: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.tenantId, tenantId), isNull(tasks.archivedAt))).groupBy(tasks.status).orderBy(asc(tasks.status));
  const invoicesByStatus = await db.select({ status: invoices.status, count: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.tenantId, tenantId)).groupBy(invoices.status).orderBy(asc(invoices.status));
  const workflowsByStatus = await db.select({ status: workflowRuns.status, count: sql<number>`count(*)::int` }).from(workflowRuns).where(eq(workflowRuns.tenantId, tenantId)).groupBy(workflowRuns.status).orderBy(asc(workflowRuns.status));
  const [openProcurement] = await db.select({ count: sql<number>`count(*)::int` }).from(procurementOrders).where(and(eq(procurementOrders.tenantId, tenantId), inArray(procurementOrders.status, ["draft", "ordered"])));
  const [lowInventory] = await db.select({ count: sql<number>`count(*)::int` }).from(inventoryItems).where(and(eq(inventoryItems.tenantId, tenantId), sql`${inventoryItems.quantity} <= ${inventoryItems.reorderThreshold}`));
  const [lowWarehouse] = await db.select({ count: sql<number>`count(*)::int` }).from(warehouseStock).where(and(eq(warehouseStock.tenantId, tenantId), sql`${warehouseStock.quantity} <= ${warehouseStock.reorderThreshold}`));
  const leadsCounts = countRows(leadsByStatus);
  const quoteCounts = countRows(quotesByStatus);
  const proposalCounts = countRows(proposalsByStatus);
  const opportunityCounts = countRows(opportunitiesByStage);
  const appointmentCounts = countRows(appointmentsByStatus);
  const workOrderCounts = countRows(workOrdersByStatus);
  const taskCounts = countRows(tasksByStatus);
  const invoiceCounts = countRows(invoicesByStatus);
  const workflowCounts = countRows(workflowsByStatus);
  const aggregateCount = [
    ...leadsCounts, ...quoteCounts, ...proposalCounts, ...opportunityCounts,
    ...appointmentCounts, ...workOrderCounts, ...taskCounts, ...invoiceCounts, ...workflowCounts,
  ].length + 2;
  const info = pageInfo(Math.max(page.limit, aggregateCount), aggregateCount, false, null, aggregateCount, true);
  const sourceInfo = source(["leads", "quotes", "proposals", "opportunities", "appointments", "work_orders", "tasks", "invoices", "workflow_runs", "procurement_orders", "inventory_items", "warehouse_stock"]);
  return {
    ...base("business_state", sourceInfo, asOf, info),
    pipeline: { leads: leadsCounts, quotes: quoteCounts, proposals: proposalCounts, opportunities: opportunityCounts },
    operations: {
      appointments: appointmentCounts,
      workOrders: workOrderCounts,
      tasks: taskCounts,
      invoices: invoiceCounts,
      workflows: workflowCounts,
      openProcurementOrders: numberValue(openProcurement?.count),
      lowStockItems: numberValue(lowInventory?.count) + numberValue(lowWarehouse?.count),
    },
  };
}

function compatibilityPage(limit: number | undefined): { limit?: number } {
  return limit === undefined ? {} : { limit };
}

async function companyContextQuery(
  tenantId: string,
  request: CompanyContextRequest,
  asOf: string,
  options: QueryOptions,
): Promise<CompanyContextResult> {
  let anchor: CompanyContextRequest["anchor"];
  let resolution: CompanyContextResult["resolution"] = "not_found";
  const requesterEmployeeId = options.employeeId && UUID.test(options.employeeId)
    ? options.employeeId
    : options.userId && UUID.test(options.userId)
      ? options.userId
      : undefined;
  const resolverContext = {
    ...(requesterEmployeeId ? { requesterEmployeeId } : {}),
    ...(options.workId && UUID.test(options.workId) ? { workId: options.workId } : {}),
  };
  const explicitPartyRef = request.anchor
    ? "partyType" in request.anchor
      ? request.anchor
      : canonicalEntityRefToPartyRef(request.anchor)
    : request.householdId
      ? { partyType: "household" as const, partyId: request.householdId }
      : null;

  if (explicitPartyRef) {
    const partyResolution = await resolveParty(tenantId, { ref: explicitPartyRef }, resolverContext);
    if (partyResolution.status === "resolved" && partyResolution.party) {
      anchor = partyResolution.party.ref;
      resolution = "exact";
    } else {
      resolution = partyResolution.status === "ambiguous"
        ? "ambiguous"
        : partyResolution.status === "inactive"
          ? "inactive"
          : "not_found";
    }
  } else if (request.anchor) {
    // Legacy canonical anchors that have no PartyRef representation retain the
    // existing graph path. Company-party anchors always pass through the resolver.
    anchor = request.anchor;
    resolution = "exact";
  } else if (request.query?.trim()) {
    const partyResolution = await resolveParty(tenantId, { query: request.query }, resolverContext);
    if (partyResolution.status === "resolved" && partyResolution.party) {
      anchor = partyResolution.party.ref;
      resolution = "unique";
    } else if (partyResolution.status === "ambiguous" || partyResolution.status === "inactive") {
      resolution = partyResolution.status;
    } else {
      // Preserve the legacy household/address journey only after the one
      // canonical Party Resolver has explicitly returned not_found.
      const lookup = await withTenant(tenantId, (db) => customerLookup(db, tenantId, { intent: "customer_lookup", query: request.query, page: { limit: 2 } }, asOf, options));
      if (lookup.resolution === "ambiguous") resolution = "ambiguous";
      else if (lookup.resolution === "not_found") resolution = "not_found";
      else if (lookup.rows[0]) {
        anchor = { partyType: "household", partyId: lookup.rows[0].householdId };
        resolution = "unique";
      }
    }
  }
  const context = anchor ? await resolveCompanyContext(tenantId, anchor) : null;
  if (anchor && !context) resolution = "not_found";
  const sourceInfo = context?.source ?? source(["company_graph_edges"]);
  const info = pageInfo(
    COMPANY_CONTEXT_LIMIT,
    context?.nodes.length ?? 0,
    context?.truncated ?? false,
    null,
    context?.nodes.length ?? 0,
    !(context?.truncated ?? false),
  );
  return {
    ...base("company_context", sourceInfo, asOf, info),
    status: resolution === "ambiguous" ? "ambiguous" : resolution === "not_found" ? "not_found" : resolution === "inactive" ? "inactive" : "ok",
    resolution,
    context,
  };
}

const COMPANY_CONTEXT_LIMIT = 250;

function normalizeOperationalRequest(request: OperationalQueryRequest, asOf: string): CanonicalOperationalQueryRequest {
  if (!("params" in request)) return request as CanonicalOperationalQueryRequest;
  switch (request.intent) {
    case "customer_lookup": {
      const params = request.params;
      return {
        intent: "customer_lookup",
        householdId: params.householdId,
        query: params.query,
        name: params.name,
        contact: params.phone,
        page: compatibilityPage(params.limit),
      };
    }
    case "customer_cohort":
    case "inactivity_cohort": {
      const params = request.params;
      return {
        intent: "customer_cohort",
        cohort: "inactive",
        minDaysInactive: params.minDaysInactive,
        asOf: params.asOf,
        page: compatibilityPage(params.limit),
      };
    }
    case "schedule_range": {
      const params = request.params;
      return {
        intent: "schedule_range",
        localDateRange: {
          startDate: params.startDate,
          ...(params.endDate ? { endDate: params.endDate } : {}),
        },
        page: compatibilityPage(params.limit),
      };
    }
    case "money_summary":
    case "money": {
      const params = request.params;
      return { intent: "money_summary", page: compatibilityPage(params.limit) };
    }
    case "work_list":
    case "work": {
      const params = request.params;
      return {
        intent: "work_list",
        recordId: params.recordId,
        openOnly: params.openOnly,
        statuses: params.status ? [params.status] : undefined,
        page: compatibilityPage(params.limit),
      };
    }
    case "inventory_status":
    case "inventory": {
      const params = request.params;
      return {
        intent: "inventory_status",
        sku: params.sku,
        lowStockOnly: params.lowStockOnly,
        page: compatibilityPage(params.limit),
      };
    }
    case "agent_activity": {
      const params = request.params;
      return {
        intent: "agent_activity",
        range: { start: params.since ?? asOf, end: asOf },
        page: compatibilityPage(params.limit),
      };
    }
    case "business_state": {
      return { intent: "business_state" };
    }
    default:
      return assertNever(request as never);
  }
}

function compatibilityEnvelope(result: CanonicalOperationalQueryResult): CanonicalOperationalQueryResult {
  if (!("version" in result)) return result;
  const { data: _data, kind: _kind, status: _status, ...payload } = result;
  const status = "resolution" in result && result.resolution === "ambiguous"
    ? "ambiguous"
    : "resolution" in result && result.resolution === "inactive"
      ? "inactive"
      : "resolution" in result && result.resolution === "not_found"
      ? "not_found"
      : "ok";
  return {
    ...result,
    kind: "operational_query_result",
    status,
    data: payload,
  };
}

async function runOperationalQuery(
  db: Db,
  tenantId: string,
  request: CanonicalOperationalQueryRequest,
  asOf: string,
  options: QueryOptions,
): Promise<CanonicalOperationalQueryResult> {
  switch (request.intent) {
    case "customer_lookup":
      return customerLookup(db, tenantId, request, asOf, options);
    case "customer_cohort":
      return customerCohort(db, tenantId, request, asOf, options);
    case "schedule_range":
      return scheduleRange(db, tenantId, request, asOf, options);
    case "money_summary":
      return moneySummary(db, tenantId, request, asOf, options);
    case "work_list":
      return workList(db, tenantId, request, asOf, options);
    case "inventory_status":
      return inventoryStatus(db, tenantId, request, asOf, options);
    case "agent_activity":
      return agentActivity(db, tenantId, request, asOf, options);
    case "business_state":
      return businessState(db, tenantId, request, asOf, options);
    case "company_context":
      throw new Error("company_context must execute outside an existing tenant transaction");
    case "party_lookup":
    case "party_context":
    case "team_roster":
    case "party_availability":
      throw new Error(`${request.intent} must execute outside an existing tenant transaction`);
    default:
      return assertNever(request as never);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported operational query intent: ${String(value)}`);
}

/**
 * Execute one of the exact operational read intents. The request is never
 * allowed to carry tenantId; tenant scope is established only by this authenticated
 * parameter and withTenant(). When Work metadata is provided, this creates a
 * work_query_executions receipt rather than a planner attempt.
 */
export async function executeOperationalQuery<T extends OperationalQueryRequest>(
  tenantId: string,
  request: T,
  options: OperationalQueryOptions = {},
): Promise<OperationalQueryResultFor<T>> {
  if (!tenantId.trim()) throw new Error("tenantId is required from authenticated context");
  if (!request || typeof request !== "object" || !("intent" in request)) throw new Error("Operational query request is invalid");
  if (Object.prototype.hasOwnProperty.call(request, "tenantId")) throw new Error("Operational query request must not contain tenantId");
  const startedAt = typeof options.now === "function" ? options.now() : options.now ?? new Date();
  if (Number.isNaN(startedAt.getTime())) throw new Error("Operational query clock returned an invalid date");
  const asOf = startedAt.toISOString();
  const startedPerformance = performance.now();
  const canonicalRequest = normalizeOperationalRequest(request, asOf);
  if (options.workInputId && !options.workId) throw new Error("workInputId requires workId");
  const executionKey = options.workId ? options.executionKey ?? requestKey(canonicalRequest) : undefined;
  let claim: Awaited<ReturnType<typeof beginWorkQueryExecution>> | undefined;
  if (options.workId && executionKey) {
    claim = await beginWorkQueryExecution({
      tenantId,
      workId: options.workId,
      workInputId: options.workInputId ?? null,
      intent: canonicalRequest.intent,
      request: canonicalRequest as unknown as Record<string, unknown>,
      executionKey,
    });
  }
  try {
    // company_context composes several bounded read models. Execute those tenant
    // transactions sequentially: production intentionally uses a one-connection
    // pool, so nesting withTenant() inside another transaction would deadlock.
    const partyIntent = canonicalRequest.intent === "party_lookup"
      || canonicalRequest.intent === "party_context"
      || canonicalRequest.intent === "team_roster"
      || canonicalRequest.intent === "party_availability";
    const partyContext: PartyReadExecutionContext = {
      ...(options.employeeId ? { employeeId: options.employeeId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      ...(options.workId ? { workId: options.workId } : {}),
      now: startedAt,
      ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    };
    const rawResult = canonicalRequest.intent === "company_context"
      ? await companyContextQuery(tenantId, canonicalRequest, asOf, options)
      : partyIntent
        ? await executePartyOperationalQuery(tenantId, canonicalRequest, partyContext)
        : await withTenant(tenantId, (db) => runOperationalQuery(db, tenantId, canonicalRequest, asOf, options));
    const result = compatibilityEnvelope(rawResult);
    if (options.workId) {
      const householdId = result.intent === "customer_lookup" && result.rows.length === 1
        ? result.rows[0]!.householdId
        : result.intent === "company_context" && result.context
          ? result.context.household?.id ?? null
          : null;
      if (householdId) await attachWorkEntity(tenantId, options.workId, {
        entityType: "household",
        entityId: householdId,
        source: `operational_query:${result.intent}`,
      });
    }
    if (claim) {
      const durationMs = Math.max(0, performance.now() - startedPerformance);
      await finishWorkQueryExecution({
        tenantId,
        executionId: claim.id,
        status: "succeeded",
        rowCount: result.count,
        durationMs,
        resultSummary: {
          intent: result.intent,
          returned: result.page.returned,
          totalCount: result.page.totalCount,
          totalCountExact: result.page.totalCountExact,
          truncated: result.page.truncated,
        },
      });
      const execution = {
        id: claim.id,
        workId: claim.workId,
        workInputId: claim.workInputId,
        executionKey: claim.executionKey,
        status: "succeeded" as const,
      };
      return { ...result, execution } as OperationalQueryResultFor<T>;
    }
    return result as OperationalQueryResultFor<T>;
  } catch (error) {
    if (claim) {
      await finishWorkQueryExecution({
        tenantId,
        executionId: claim.id,
        status: "failed",
        rowCount: 0,
        durationMs: Math.max(0, performance.now() - startedPerformance),
        failure: failSafeError(error),
      }).catch(() => undefined);
    }
    throw error;
  }
}

export const operationalQueryIntents = [
  "customer_lookup",
  "customer_cohort",
  "schedule_range",
  "money_summary",
  "work_list",
  "inventory_status",
  "agent_activity",
  "business_state",
  "company_context",
  "party_lookup",
  "party_context",
  "team_roster",
  "party_availability",
] as const;
