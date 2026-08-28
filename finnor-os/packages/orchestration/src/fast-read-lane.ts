// Deterministic operational query plane.
//
// This module owns interpretation, compatibility formatting, and the execution
// seam. Canonical tenant-scoped reads live in @finnor/read-models; SQL and
// tenant fallback readers deliberately do not belong here.

import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CANONICAL_ENTITY_TYPES,
  PARTY_TYPES,
  type CompanyContextRequest,
  type CanonicalOperationalQueryIntent,
  type CanonicalOperationalQueryRequest,
  type OperationalLocalDateRange,
  type OperationalQueryPageRequest,
  type OperationalQueryResult as SharedOperationalQueryResult,
  type OperationalQuerySource,
  type OperatingEvidenceKind,
  type PartyRef,
  type TenantContext,
} from "@finnor/shared-types";
import {
  executeOperationalQuery as canonicalExecuteOperationalQuery,
  type CashCollections,
  type OperationalQueryOptions,
} from "@finnor/read-models";
import { tenantSourceTruthReport, type TenantSourceTruthReport } from "@finnor/tools";

/** Keep the old public names, but make their public meaning canonical. */
export type OperationalQueryIntent = CanonicalOperationalQueryIntent;
export type OperationalQueryRequest = CanonicalOperationalQueryRequest;
export type OperationalQueryResult = SharedOperationalQueryResult;

type DraftOperationalQueryIntent = CanonicalOperationalQueryIntent;

type DraftOperationalQueryRequest =
  | { intent: "customer_lookup"; query: string }
  | { intent: "customer_cohort"; minDaysInactive: number }
  | { intent: "schedule_range"; localDateRange: OperationalLocalDateRange }
  | { intent: "money_summary" }
  | { intent: "work_list"; openOnly: boolean }
  | { intent: "inventory_status"; lowStockOnly: boolean }
  | { intent: "agent_activity"; localDateRange: OperationalLocalDateRange }
  | { intent: "business_state" }
  | { intent: "company_context"; query: string };

type QueryDateValue = string | "today" | "tomorrow";
type QueryResultStatus = "ok" | "ambiguous" | "not_found" | "inactive";
type QueryTenantContext = Pick<TenantContext, "tenantId"> & Partial<Pick<TenantContext, "userId" | "employeeId">>;

export interface OperationalQueryDateRange {
  timeZone: string;
  startLocalDate: string;
  endLocalDateInclusive: string;
  /** Half-open UTC range: [startAt, endAt). */
  startAt: string;
  endAt: string;
}

export interface OperationalQueryMetadata {
  /** Durable work_query_executions.id when Work context was supplied. */
  queryId: string;
  source: "postgresql";
  durationMs: number;
  startedAt: string;
  completedAt: string;
  timeZone?: string;
  dateRange?: OperationalQueryDateRange;
  sourceTruth?: OperationalQuerySourceTruth;
}

export interface OperationalQuerySourceTruth {
  assessedAt: string;
  status: "fresh" | "stale" | "unknown";
  provenance: "tenant_integrations+integration_sync_checkpoints+external_refs";
  sources: Array<{
    integrationId: string;
    capability: string;
    provider: string;
    state: string;
    freshness: string;
    asOf?: string;
    unresolvedConflicts: number;
    blockedReason?: string;
  }>;
}

export interface OperationalQueryExecution {
  request: OperationalQueryRequest;
  result: OperationalQueryResult;
  metadata: OperationalQueryMetadata;
}

export interface OperationalQueryInterpretation {
  route: "fast_read";
  confidence: "high";
  request: OperationalQueryRequest;
}

export interface PlannerReadFallback {
  route: "planner";
  reason: "not_question" | "mutation_or_advice" | "external_or_ambiguous" | "unsupported";
}

export type OperationalQueryDecision = OperationalQueryInterpretation | PlannerReadFallback;

export interface AnswerDisplayFact {
  label: string;
  value: string;
}

export interface AnswerDisplay {
  title: string;
  facts: AnswerDisplayFact[];
}

export interface AnswerEvidence {
  source: string;
  ref: string;
  timestamp: string;
  kind?: OperatingEvidenceKind;
}

export interface AnswerFreshness {
  status: "fresh" | "stale" | "unknown";
  observedAt: string;
  sourceTruth?: OperationalQuerySourceTruth;
}

/** Browser/voice-safe answer contract. Raw read-model rows do not cross this seam. */
export interface AnswerEnvelope {
  kind: "answer";
  intent: OperationalQueryIntent | "cash_collections" | "conversation";
  readOnly: true;
  spokenSummary: string;
  display: AnswerDisplay;
  evidence: AnswerEvidence[];
  asOf: string;
  freshness: AnswerFreshness;
  /** Additive typed metadata; existing cash/voice consumers may ignore it. */
  query?: OperationalQueryExecution;
}

export type FastReadOnlyClassification =
  | { route: "fast_read"; intent: "cash_collections" }
  | { route: "fast_read"; intent: OperationalQueryIntent }
  | PlannerReadFallback;

/** Exactly the canonical read-model executor type, including its option seam. */
export type ExecuteOperationalQuery = typeof canonicalExecuteOperationalQuery;

export interface FastReadOnlyRouter {
  classify(instruction: string): FastReadOnlyClassification;
  /** Existing seam: returns a browser/voice answer or null. */
  route(instruction: string, ctx: QueryTenantContext): Promise<AnswerEnvelope | null>;
  /** Typed seams used by the orchestrator/API. Optional on injected legacy routers. */
  interpret?(instruction: string): OperationalQueryDecision;
  execute?(request: OperationalQueryRequest, ctx: QueryTenantContext, options?: OperationalQueryOptions): Promise<OperationalQueryExecution>;
  answer?(execution: OperationalQueryExecution): AnswerEnvelope;
}

export interface FastReadOnlyRouterDeps {
  /** Test seam for the canonical reader; production defaults to read-models. */
  executeOperationalQuery?: ExecuteOperationalQuery;
  /** Explicit legacy test seam. It is adapted to the canonical money result shape. */
  cashCollections?: (tenantId: string) => Promise<CashCollections>;
  /** Test/embedding seam. Production loads only local canonical source state; it
   * never fans an operational query out to a remote provider. */
  sourceTruth?: (tenantId: string, now?: Date) => Promise<TenantSourceTruthReport>;
  now?: () => Date;
}

const QUESTION_PREFIX = /^(?:(?:please\s+)?(?:how|what|which|where|when|who|is|are|do|does|did|can|could|would)\b|(?:please\s+)?(?:tell me|show(?:\s+me)?|pull\s+up|find|get|give me|list(?:\s+out)?|summarize|explain)\b)/i;
const MUTATION_VERB = String.raw`(?:create|send|update|change|delete|remove|approve|reject|book|cancel|call|text|email|pay|charge|reorder|restock|flag|mark|start|launch|assign|execute|run|prepare|draft|write|edit|improve|make|reschedule)`;
const MUTATION_OR_ADVICE = new RegExp(String.raw`\b(?:${MUTATION_VERB}|recommend|recommendation|advice|should|schedule\s+(?:an?|the)?\s*(?:appointment|visit|service|water\s*test|job))\b`, "i");
const GUARDED_MUTATION_VERB = String.raw`(?:${MUTATION_VERB}|schedule)`;
const TRAILING_READ_ONLY_GUARD = new RegExp(
  String.raw`^(.+?)(?:(?:[.!?]\s+)|(?:,\s*|\s+)(?:and|but)\s+)(?:read[\s-]*only\s*:\s*)?(?:please\s+)?(?:do\s+not|don't|never)\s+${GUARDED_MUTATION_VERB}\b[\s\S]*$`,
  "i",
);
const EXTERNAL_OR_AMBIGUOUS = /\b(?:quickbooks|stripe|google|meta|vapi|integration|connected account|external|online|web|research|look up|competitors?|comparable compan(?:y|ies)|peer compan(?:y|ies)|latest|current\s+(?:news|benchmark|market|source|industry)|why|forecast|predict|projection|trend|benchmark|cite|citation|source-backed)\b/i;
const CASH_COLLECTIONS = /\b(?:cash\s+collections?|collections?|payments?\s+collected|collected\s+(?:cash|payments?)|cash\s+position|cash\b[\s\S]{0,40}\bcollected)\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const DATE_WORD = /\b(?:today|tomorrow)\b/gi;
const DATE_CONNECTOR = /\b(?:through|thru|to|until|and|between)\b/i;
const DANGEROUS_LOOKUP_TEXT = /[;{}[\]<>=$`]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedInstruction(instruction: string): string {
  return instruction.trim().replace(/\s+/g, " ");
}

/**
 * Users often append a negative safety constraint to an otherwise deterministic
 * read ("Show tomorrow's schedule. Read only: do not update anything"). That
 * constraint must not turn the read into a mutation, but only when it is a
 * syntactically separate, trailing clause. The primary request is still scanned
 * normally, so "Create a follow-up, but do not send it" remains consequential.
 */
function withoutTrailingReadOnlyGuard(instruction: string): string {
  const guarded = instruction.match(TRAILING_READ_ONLY_GUARD)?.[1]?.trim();
  return guarded || instruction;
}

function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function parseDateTokens(instruction: string): QueryDateValue[] | null {
  const normalized = normalizedInstruction(instruction);
  // Only two relative words and explicit ISO local dates are supported. This
  // deliberately rejects "next Friday" and server-locale date parsing.
  if (/\b(?:next|last|this|coming|week|month|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i.test(normalized)) return null;
  const matches = [
    ...[...normalized.matchAll(ISO_DATE)].map((match) => ({ value: match[0] as QueryDateValue, index: match.index ?? 0 })),
    ...[...normalized.matchAll(DATE_WORD)].map((match) => ({ value: match[0].toLowerCase() as QueryDateValue, index: match.index ?? 0 })),
  ].sort((a, b) => a.index - b.index);
  const values = matches.map((match) => match.value);
  if (values.length === 0 || values.length > 2) return null;
  if (values.some((value) => typeof value === "string" && value.includes("-") && !validLocalDate(value))) return null;
  if (values.length === 2 && !DATE_CONNECTOR.test(normalized)) return null;
  return values;
}

function queryParamString(value: string | undefined): string | undefined {
  const result = value?.trim();
  if (!result || result.length > 200 || DANGEROUS_LOOKUP_TEXT.test(result)) return undefined;
  return result;
}

function extractCustomerQuery(instruction: string): string | undefined {
  const normalized = normalizedInstruction(instruction);
  const match = normalized.match(/\b(?:for|about|named|called|customer|household|client|account)\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,100}?)(?:\?|$|\b(?:history|record|details|information|lookup|look-up)\b)/i);
  const history = normalized.match(/\b(?:history|record|details|information)\s+for\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,100})\??$/i);
  const fallback = normalized.match(/\b(?:customer|household|client|account)\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,100})\??$/i);
  const candidate = queryParamString((match?.[1] ?? history?.[1] ?? fallback?.[1])
    ?.replace(/^(?:record|history|details|information)\s+for\s+/i, "")
    .replace(/[,.]+$/, ""));
  if (!candidate) return undefined;
  // A bare first name is deliberately ambiguous in the natural-language
  // lane. Typed callers may still submit it and receive an ambiguous result.
  const words = candidate.split(/\s+/).filter(Boolean);
  return words.length >= 2 || /\d/.test(candidate) ? candidate : undefined;
}

function parseOperationalQuery(instruction: string): DraftOperationalQueryRequest | null {
  const normalized = normalizedInstruction(instruction);
  if (!normalized || normalized.length > 500) return null;

  const scheduleMention = /\b(?:schedule|calendar|appointment|appointments|service\s+visit|service\s+visits|work\s+order|work\s+orders|technician\s+availability|(?:available|free)\s+technicians?|technicians?\s+(?:who|that)\s+(?:are\s+)?(?:available|free)|who(?:'s|\s+is)\s+free|everything)\b/i.test(normalized);
  if (scheduleMention) {
    const dates = parseDateTokens(normalized);
    if (dates) return { intent: "schedule_range", localDateRange: { startDate: dates[0]!, ...(dates[1] ? { endDate: dates[1] } : {}) } };
  }

  if (/\b(?:inactive|inactivity|haven['’]?t\s+seen|not\s+(?:visited|heard\s+from)|no\s+(?:service|visit|activity))\b/i.test(normalized)) {
    const days = normalized.match(/\b(\d{1,4})\s*days?\b/i)?.[1];
    if (days) return { intent: "customer_cohort", minDaysInactive: Number(days) };
    return null;
  }

  if (CASH_COLLECTIONS.test(normalized) || /\b(?:overdue|outstanding|invoice|invoices|money|revenue|payments?)\b/i.test(normalized)) return { intent: "money_summary" };

  if (/\b(?:inventory|stock|sku|on\s+hand|low\s+stock|running\s+low|reorder\s+point)\b/i.test(normalized)) {
    return { intent: "inventory_status", lowStockOnly: /\b(?:low|running\s+low|reorder)\b/i.test(normalized) };
  }

  if (/\b(?:agent\s+activity|agent\s+actions|what\s+(?:did|has)\s+(?:the\s+)?(?:agent|agents|jarvis)|recent\s+activity|activity\s+log)\b/i.test(normalized)) {
    const dates = parseDateTokens(normalized);
    if (!dates) return null;
    return { intent: "agent_activity", localDateRange: { startDate: dates[0]!, ...(dates[1] ? { endDate: dates[1] } : {}) } };
  }
  if (/\b(?:business\s+state|business\s+health|operational\s+state|pipeline\s+health|business\s+overview|how\s+is\s+(?:the\s+)?business)\b/i.test(normalized)) return { intent: "business_state" };
  if (/\b(?:how\s+many|count|status|pipeline|overview|summary)\b/i.test(normalized) && /\b(?:quotes?|proposals?|opportunities)\b/i.test(normalized)) return { intent: "business_state" };
  if (/\b(?:full\s+context|connected\s+context|customer\s+360|household\s+360|service\s+history|customer\s+history|household\s+history|complete\s+(?:record|history))\b/i.test(normalized)) {
    const query = extractCustomerQuery(normalized);
    if (!query) return null;
    return { intent: "company_context", query };
  }
  if (/\b(?:work\s+orders?|work\b|jobs?|workflow|work\s+queue|backlog|in\s+progress)\b/i.test(normalized)) return { intent: "work_list", openOnly: /\b(?:open|pending|in\s+progress|backlog|queue)\b/i.test(normalized) };

  if (/\b(?:customer|household|client|account|customer\s+record|household\s+history)\b/i.test(normalized)) {
    const query = extractCustomerQuery(normalized);
    if (!query) return null;
    return { intent: "customer_lookup", query };
  }
  return null;
}

/** Map the private interpreter draft immediately to the canonical shared request. */
function toCanonicalRequest(draft: DraftOperationalQueryRequest): OperationalQueryRequest {
  switch (draft.intent) {
    case "customer_lookup":
      return { intent: "customer_lookup", query: draft.query };
    case "customer_cohort":
      return { intent: "customer_cohort", cohort: "inactive", minDaysInactive: draft.minDaysInactive };
    case "schedule_range":
      // The canonical reader resolves this local inclusive range through the
      // tenant timezone and injected asOf clock. Never cast it to UTC here.
      return { intent: "schedule_range", localDateRange: draft.localDateRange };
    case "money_summary":
      return { intent: "money_summary" };
    case "work_list":
      // The canonical reader applies openOnly independently to works,
      // work_orders, and tasks; sharing one status vocabulary would silently
      // omit draft/scheduled work orders or open tasks.
      return draft.openOnly ? { intent: "work_list", openOnly: true } : { intent: "work_list" };
    case "inventory_status":
      return { intent: "inventory_status", lowStockOnly: draft.lowStockOnly };
    case "agent_activity": {
      // The data thread's canonical executor resolves local calendar ranges
      // through tenants.timezone and the injected clock. Keep the token typed
      // and explicit; never manufacture a server-locale UTC range here.
      return { intent: "agent_activity", localDateRange: draft.localDateRange };
    }
    case "business_state":
      return { intent: "business_state" };
    case "company_context":
      return { intent: "company_context", query: draft.query };
    default:
      return assertNever(draft);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported operational query intent: ${String(value)}`);
}

/** Pure, fail-closed natural-language interpretation. */
export function interpretOperationalQuery(instruction: string): OperationalQueryDecision {
  const normalized = normalizedInstruction(instruction);
  const readRequest = withoutTrailingReadOnlyGuard(normalized);
  if (!normalized || normalized.length > 500 || (!QUESTION_PREFIX.test(readRequest) && !/\?\s*$/.test(readRequest))) return { route: "planner", reason: "not_question" };
  if (MUTATION_OR_ADVICE.test(readRequest)) return { route: "planner", reason: "mutation_or_advice" };
  if (EXTERNAL_OR_AMBIGUOUS.test(readRequest)) return { route: "planner", reason: "external_or_ambiguous" };
  const draft = parseOperationalQuery(readRequest);
  return draft ? { route: "fast_read", confidence: "high", request: toCanonicalRequest(draft) } : { route: "planner", reason: "unsupported" };
}

function isPage(value: unknown): value is OperationalQueryPageRequest {
  if (!isRecord(value)) return false;
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100)) return false;
  return value.cursor === undefined || (typeof value.cursor === "string" && value.cursor.length <= 4096);
}

function isRange(value: unknown): value is { start: string; end: string } {
  return isRecord(value) && typeof value.start === "string" && typeof value.end === "string" && !Number.isNaN(new Date(value.start).getTime()) && !Number.isNaN(new Date(value.end).getTime()) && new Date(value.start).getTime() < new Date(value.end).getTime();
}

function isLocalDateValue(value: unknown): value is QueryDateValue {
  return typeof value === "string" && (value === "today" || value === "tomorrow" || validLocalDate(value));
}

function isLocalDateRange(value: unknown): value is OperationalLocalDateRange {
  return isRecord(value) && isLocalDateValue(value.startDate) && (value.endDate === undefined || isLocalDateValue(value.endDate));
}

function isPartyRef(value: unknown): value is PartyRef {
  return isRecord(value)
    && Object.keys(value).length === 2
    && Object.keys(value).every((key) => key === "partyType" || key === "partyId")
    && typeof value.partyType === "string"
    && PARTY_TYPES.includes(value.partyType as (typeof PARTY_TYPES)[number])
    && typeof value.partyId === "string"
    && UUID.test(value.partyId);
}

function isCanonicalEntityRef(value: unknown): value is CompanyContextRequest["anchor"] {
  return isRecord(value)
    && Object.keys(value).length === 2
    && Object.keys(value).every((key) => key === "entityType" || key === "entityId")
    && typeof value.entityType === "string"
    && CANONICAL_ENTITY_TYPES.includes(value.entityType as (typeof CANONICAL_ENTITY_TYPES)[number])
    && typeof value.entityId === "string"
    && UUID.test(value.entityId);
}

function paramsFor(input: Record<string, unknown>): { params: Record<string, unknown>; error?: string } {
  const rawParams = input.params;
  const direct = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "intent" && key !== "params"));
  if (rawParams !== undefined && !isRecord(rawParams)) return { params: {}, error: "Query params must be an object" };
  if (rawParams !== undefined && Object.keys(direct).length > 0) return { params: {}, error: "Use either canonical fields or params, not both" };
  return { params: isRecord(rawParams) ? rawParams : direct };
}

function unknownFields(params: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(params).filter((key) => !allowed.includes(key));
}

/**
 * Validate/normalize a public typed request. Compatibility `params` input is
 * accepted only as an adapter; the returned request is always canonical direct
 * fields, so it can never fall through to the planner or a divergent executor.
 */
export function validateOperationalQueryRequest(input: unknown): { success: true; request: OperationalQueryRequest } | { success: false; error: string } {
  if (!isRecord(input) || typeof input.intent !== "string") return { success: false, error: "A typed query intent is required" };
  const intent = input.intent === "cash_collections" ? "money_summary" : input.intent;
  const { params, error } = paramsFor(input);
  if (error) return { success: false, error };

  if (intent === "customer_lookup") {
    const unknown = unknownFields(params, ["householdId", "query", "name", "address", "contact", "phone", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for customer_lookup: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    const selectors = ["householdId", "query", "name", "address", "contact", "phone"] as const;
    if (!selectors.some((key) => typeof params[key] === "string" && (params[key] as string).trim())) return { success: false, error: "customer_lookup requires a selector" };
    if (params.householdId !== undefined && (typeof params.householdId !== "string" || !/^[0-9a-f-]{36}$/i.test(params.householdId))) return { success: false, error: "householdId must be a UUID" };
    return { success: true, request: { intent: "customer_lookup", ...(params.householdId ? { householdId: params.householdId } : {}), ...(typeof params.query === "string" ? { query: params.query } : {}), ...(typeof params.name === "string" ? { name: params.name } : {}), ...(typeof params.address === "string" ? { address: params.address } : {}), ...(typeof (params.contact ?? params.phone) === "string" ? { contact: (params.contact ?? params.phone) as string } : {}), ...(page ? { page } : {}) } };
  }

  if (intent === "customer_cohort" || intent === "inactivity_cohort") {
    const unknown = unknownFields(params, ["cohort", "minDaysInactive", "asOf", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for customer_cohort: ${unknown.join(", ")}` };
    const days = Number(params.minDaysInactive);
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (!Number.isInteger(days) || days < 1 || days > 3650) return { success: false, error: "minDaysInactive must be an integer between 1 and 3650" };
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.cohort !== undefined && params.cohort !== "inactive") return { success: false, error: "cohort must be inactive" };
    if (params.asOf !== undefined && (typeof params.asOf !== "string" || Number.isNaN(new Date(params.asOf).getTime()))) return { success: false, error: "asOf must be an ISO timestamp" };
    return { success: true, request: { intent: "customer_cohort", cohort: "inactive", minDaysInactive: days, ...(typeof params.asOf === "string" ? { asOf: params.asOf } : {}), ...(page ? { page } : {}) } };
  }

  if (intent === "schedule_range") {
    const unknown = unknownFields(params, ["range", "localDateRange", "startDate", "endDate", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for schedule_range: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    const localDateRange = params.localDateRange ?? (params.startDate === undefined ? undefined : { startDate: params.startDate, ...(params.endDate === undefined ? {} : { endDate: params.endDate }) });
    if (localDateRange !== undefined && !isLocalDateRange(localDateRange)) return { success: false, error: "localDateRange must contain ISO local dates, today, or tomorrow" };
    if (params.range !== undefined && !isRange(params.range)) return { success: false, error: "range must be a valid half-open timestamp range" };
    if (params.range !== undefined && localDateRange !== undefined) return { success: false, error: "Use either range or localDateRange" };
    if (params.range === undefined && localDateRange === undefined) return { success: false, error: "schedule_range requires range or localDateRange" };
    return { success: true, request: { intent: "schedule_range", ...(params.range ? { range: params.range } : {}), ...(localDateRange ? { localDateRange } : {}), ...(page ? { page } : {}) } };
  }

  if (intent === "money_summary" || intent === "money") {
    const unknown = unknownFields(params, ["range", "start", "end", "page", "limit", "metric"]);
    if (unknown.length) return { success: false, error: `Unknown fields for money_summary: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.metric !== undefined && !["cash_collections", "invoices", "payments", "overdue"].includes(String(params.metric))) return { success: false, error: "Unknown money metric" };
    if (params.range !== undefined && !isRange(params.range)) return { success: false, error: "range must be a valid half-open timestamp range" };
    if (params.range !== undefined && (params.start !== undefined || params.end !== undefined)) return { success: false, error: "Use either range or start/end, not both" };
    if ((params.start === undefined) !== (params.end === undefined)) return { success: false, error: "money_summary start and end must be supplied together" };
    if (params.start !== undefined && (typeof params.start !== "string" || typeof params.end !== "string" || !isRange({ start: params.start, end: params.end }))) return { success: false, error: "start/end must be a valid half-open timestamp range" };
    return { success: true, request: { intent: "money_summary", ...(params.range ? { range: params.range } : {}), ...(typeof params.start === "string" ? { start: params.start, end: params.end as string } : {}), ...(page ? { page } : {}) } };
  }

  if (intent === "work_list" || intent === "work") {
    const unknown = unknownFields(params, ["section", "statuses", "status", "openOnly", "recordId", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for work_list: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.recordId !== undefined && (typeof params.recordId !== "string" || !/^[0-9a-f-]{36}$/i.test(params.recordId))) return { success: false, error: "recordId must be a UUID" };
    const statuses = Array.isArray(params.statuses) ? params.statuses : typeof params.status === "string" ? [params.status] : undefined;
    if (statuses && (!statuses.every((value) => typeof value === "string" && value.length <= 80) || statuses.length > 20)) return { success: false, error: "statuses must be a bounded string array" };
    if (params.section !== undefined && !["all", "works", "work_orders", "tasks"].includes(String(params.section))) return { success: false, error: "Unknown work section" };
    if (params.openOnly !== undefined && typeof params.openOnly !== "boolean") return { success: false, error: "openOnly must be boolean" };
    return { success: true, request: { intent: "work_list", ...(params.section ? { section: params.section as "all" | "works" | "work_orders" | "tasks" } : {}), ...(statuses ? { statuses } : {}), ...(params.openOnly === undefined ? {} : { openOnly: params.openOnly }), ...(params.recordId ? { recordId: params.recordId } : {}), ...(page ? { page } : {}) } };
  }

  if (intent === "inventory_status") {
    const unknown = unknownFields(params, ["sku", "lowStockOnly", "includeOpenProcurement", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for inventory_status: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.lowStockOnly !== undefined && typeof params.lowStockOnly !== "boolean") return { success: false, error: "lowStockOnly must be boolean" };
    if (params.includeOpenProcurement !== undefined && typeof params.includeOpenProcurement !== "boolean") return { success: false, error: "includeOpenProcurement must be boolean" };
    if (params.sku !== undefined && (typeof params.sku !== "string" || params.sku.length > 120)) return { success: false, error: "sku must be a bounded string" };
    return { success: true, request: { intent: "inventory_status", ...(typeof params.sku === "string" ? { sku: params.sku } : {}), ...(params.lowStockOnly === undefined ? {} : { lowStockOnly: params.lowStockOnly }), ...(params.includeOpenProcurement === undefined ? {} : { includeOpenProcurement: params.includeOpenProcurement }), ...(page ? { page } : {}) } };
  }

  if (intent === "agent_activity") {
    const unknown = unknownFields(params, ["range", "localDateRange", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for agent_activity: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.localDateRange !== undefined) {
      if (!isLocalDateRange(params.localDateRange)) return { success: false, error: "localDateRange must contain ISO local dates, today, or tomorrow" };
      return { success: true, request: { intent: "agent_activity", localDateRange: params.localDateRange, ...(page ? { page } : {}) } };
    }
    if (!isRange(params.range)) return { success: false, error: "agent_activity requires a valid UTC range or localDateRange" };
    return { success: true, request: { intent: "agent_activity", range: params.range, ...(page ? { page } : {}) } };
  }

  if (intent === "business_state") {
    const unknown = unknownFields(params, ["page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for business_state: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    return { success: true, request: { intent: "business_state", ...(page ? { page } : {}) } };
  }
  if (intent === "party_lookup" || intent === "party_context") {
    const unknown = unknownFields(params, ["ref", "query", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for ${intent}: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.ref !== undefined && !isPartyRef(params.ref)) return { success: false, error: "ref must be a PartyRef" };
    if (params.query !== undefined && (typeof params.query !== "string" || !params.query.trim() || params.query.length > 300)) return { success: false, error: "query must be a bounded non-empty string" };
    if (!params.ref && !params.query) return { success: false, error: `${intent} requires ref or query` };
    return { success: true, request: {
      intent,
      ...(params.ref ? { ref: params.ref } : {}),
      ...(typeof params.query === "string" ? { query: params.query } : {}),
      ...(page ? { page } : {}),
    } };
  }
  if (intent === "team_roster") {
    const unknown = unknownFields(params, ["teamRef", "query", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for team_roster: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.teamRef !== undefined && (!isPartyRef(params.teamRef) || params.teamRef.partyType !== "team")) return { success: false, error: "teamRef must be a team PartyRef" };
    if (params.query !== undefined && (typeof params.query !== "string" || !params.query.trim() || params.query.length > 300)) return { success: false, error: "query must be a bounded non-empty string" };
    if (!params.teamRef && !params.query) return { success: false, error: "team_roster requires teamRef or query" };
    return { success: true, request: {
      intent: "team_roster",
      ...(params.teamRef ? { teamRef: params.teamRef } : {}),
      ...(typeof params.query === "string" ? { query: params.query } : {}),
      ...(page ? { page } : {}),
    } };
  }
  if (intent === "party_availability") {
    const unknown = unknownFields(params, ["ref", "query", "localDateRange", "includeCapacity", "page", "limit"]);
    if (unknown.length) return { success: false, error: `Unknown fields for party_availability: ${unknown.join(", ")}` };
    const page = params.page ?? (params.limit === undefined ? undefined : { limit: params.limit });
    if (page !== undefined && !isPage(page)) return { success: false, error: "Invalid page" };
    if (params.ref !== undefined && !isPartyRef(params.ref)) return { success: false, error: "ref must be a PartyRef" };
    if (params.query !== undefined && (typeof params.query !== "string" || !params.query.trim() || params.query.length > 300)) return { success: false, error: "query must be a bounded non-empty string" };
    if (params.localDateRange !== undefined && !isLocalDateRange(params.localDateRange)) return { success: false, error: "localDateRange must contain ISO local dates, today, or tomorrow" };
    if (params.includeCapacity !== undefined && typeof params.includeCapacity !== "boolean") return { success: false, error: "includeCapacity must be boolean" };
    if (!params.ref && !params.query) return { success: false, error: "party_availability requires ref or query" };
    return { success: true, request: {
      intent: "party_availability",
      ...(params.ref ? { ref: params.ref } : {}),
      ...(typeof params.query === "string" ? { query: params.query } : {}),
      ...(params.localDateRange ? { localDateRange: params.localDateRange } : {}),
      ...(params.includeCapacity === undefined ? {} : { includeCapacity: params.includeCapacity }),
      ...(page ? { page } : {}),
    } };
  }
  if (intent === "company_context") {
    const unknown = unknownFields(params, ["anchor", "householdId", "query"]);
    if (unknown.length) return { success: false, error: `Unknown fields for company_context: ${unknown.join(", ")}` };
    if (params.anchor !== undefined && !isCanonicalEntityRef(params.anchor) && !isPartyRef(params.anchor)) {
      return { success: false, error: "anchor must be a canonical entity reference or PartyRef" };
    }
    if (params.householdId !== undefined && (typeof params.householdId !== "string" || !/^[0-9a-f-]{36}$/i.test(params.householdId))) return { success: false, error: "householdId must be a UUID" };
    if (params.query !== undefined && (typeof params.query !== "string" || !params.query.trim() || params.query.length > 300)) return { success: false, error: "query must be a bounded non-empty string" };
    if (!params.anchor && !params.householdId && !params.query) return { success: false, error: "company_context requires anchor, householdId, or query" };
    return { success: true, request: {
      intent: "company_context",
      ...(params.anchor ? { anchor: params.anchor as unknown as CompanyContextRequest["anchor"] } : {}),
      ...(typeof params.householdId === "string" ? { householdId: params.householdId } : {}),
      ...(typeof params.query === "string" ? { query: params.query } : {}),
    } };
  }
  return { success: false, error: "Unknown operational query intent" };
}

function isLegacyCashQuestion(instruction: string): boolean {
  return CASH_COLLECTIONS.test(normalizedInstruction(instruction));
}

/** Backward-compatible classifier. The typed interpreter remains canonical. */
export function classifyFastReadOnlyQuestion(instruction: string): FastReadOnlyClassification {
  const decision = interpretOperationalQuery(instruction);
  if (decision.route !== "fast_read") return decision;
  if (decision.request.intent === "money_summary" && isLegacyCashQuestion(instruction)) return { route: "fast_read", intent: "cash_collections" };
  return { route: "fast_read", intent: decision.request.intent };
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function countFor(snapshot: CashCollections, status: string): { count: number; totalUsd: number } {
  const row = snapshot.invoicesByStatus.find((item) => item.status.toLowerCase() === status);
  return { count: row?.count ?? 0, totalUsd: row?.totalUsd ?? 0 };
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

export function answerCashCollections(snapshot: CashCollections, asOf: string): AnswerEnvelope {
  const paid = countFor(snapshot, "paid");
  const overdue = countFor(snapshot, "overdue");
  const links = snapshot.paymentLinksAwaitingPayment;
  const spokenSummary = `Cash collections are ${money(snapshot.totalCollected)} collected to date. There are ${plural(paid.count, "paid invoice")} and ${plural(overdue.count, "overdue invoice")} totaling ${money(overdue.totalUsd)} overdue. ${plural(links, "payment link")} ${links === 1 ? "is" : "are"} awaiting payment.`;
  return {
    kind: "answer",
    intent: "cash_collections",
    readOnly: true,
    spokenSummary,
    display: { title: "Cash collections", facts: [
      { label: "Collected to date", value: money(snapshot.totalCollected) },
      { label: "Paid invoices", value: String(paid.count) },
      { label: "Overdue invoices", value: String(overdue.count) },
      { label: "Overdue amount", value: money(overdue.totalUsd) },
      { label: "Payment links awaiting payment", value: String(links) },
    ] },
    evidence: [{ source: "cash_collections_read_model", ref: "current", timestamp: asOf, kind: "CANONICAL" }],
    asOf,
    freshness: { status: "fresh", observedAt: asOf },
  };
}

function sourceFor(intent: OperationalQueryIntent): OperationalQuerySource {
  return { kind: "canonical_postgres", tables: [`operational_query:${intent}`] };
}

function stableExecutionKey(request: OperationalQueryRequest, workId?: string): string {
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
  return `operational-query:${workId ?? "unbound"}:${digest}`;
}

function legacyCashResult(snapshot: CashCollections, asOf: string): OperationalQueryResult {
  const page = { limit: 100, returned: snapshot.invoicesByStatus.length, totalCount: snapshot.invoicesByStatus.length, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false } as const;
  const source = sourceFor("money_summary");
  return {
    kind: "operational_query_result",
    status: "ok",
    data: snapshot as unknown as Record<string, unknown>,
    version: 1,
    intent: "money_summary",
    source,
    asOf,
    count: page.returned,
    truncated: false,
    page,
    meta: { version: 1, source, asOf },
  } as unknown as OperationalQueryResult;
}

function canonicalizeResult(request: OperationalQueryRequest, raw: unknown, asOf: string): OperationalQueryResult {
  const top = isRecord(raw) ? raw : {};
  const candidate = isRecord(top.result) ? top.result : top;
  const source = isRecord(candidate.source) ? candidate.source as unknown as OperationalQuerySource : sourceFor(request.intent);
  const status: QueryResultStatus = candidate.status === "ambiguous"
    ? "ambiguous"
    : candidate.status === "not_found"
      ? "not_found"
      : candidate.status === "inactive"
        ? "inactive"
      : "ok";
  const resultAsOf = typeof candidate.asOf === "string" ? candidate.asOf : asOf;
  if (candidate.kind === "operational_query_result" && candidate.version === 1 && isRecord(candidate.page) && isRecord(candidate.meta)) return candidate as unknown as OperationalQueryResult;
  const data = isRecord(candidate.data) ? candidate.data : {};
  const page = isRecord(candidate.page)
    ? candidate.page
    : { limit: 100, returned: 0, totalCount: null, totalCountExact: false, hasMore: false, nextCursor: null, truncated: false };
  return {
    kind: "operational_query_result",
    status,
    data,
    version: 1,
    intent: request.intent,
    source,
    asOf: resultAsOf,
    count: typeof candidate.count === "number" ? candidate.count : Number(page.returned ?? 0),
    truncated: Boolean(candidate.truncated ?? page.truncated),
    page: page as never,
    meta: { version: 1, source, asOf: resultAsOf },
    ...(isRecord(candidate.execution) ? { execution: candidate.execution as never } : {}),
  } as unknown as OperationalQueryResult;
}

function dateRangeFromResult(result: OperationalQueryResult): { timeZone?: string; dateRange?: OperationalQueryDateRange } {
  const value = result as unknown as Record<string, unknown>;
  if (typeof value.timeZone !== "string" || !isRecord(value.range)) return {};
  const range = value.range;
  if (typeof range.start !== "string" || typeof range.end !== "string") return {};
  const local = isRecord(value.localDateRange) ? value.localDateRange : undefined;
  const startLocalDate = typeof local?.startDate === "string" ? local.startDate : range.start.slice(0, 10);
  const endLocalDateInclusive = typeof local?.endDate === "string" ? local.endDate : startLocalDate;
  return { timeZone: value.timeZone, dateRange: { timeZone: value.timeZone, startLocalDate, endLocalDateInclusive, startAt: range.start, endAt: range.end } };
}

const QUERY_SOURCE_CAPABILITIES: Record<OperationalQueryIntent, string[]> = {
  customer_lookup: ["crm"],
  customer_cohort: ["crm"],
  schedule_range: ["scheduling"],
  money_summary: ["accounting", "payments"],
  work_list: [],
  inventory_status: ["inventory"],
  agent_activity: ["communications", "crm"],
  business_state: ["crm", "scheduling", "inventory", "accounting", "payments", "communications"],
  company_context: ["crm", "scheduling", "accounting", "payments", "communications"],
  party_lookup: ["crm"],
  party_context: ["crm"],
  team_roster: [],
  party_availability: ["scheduling"],
};

function querySourceTruth(intent: OperationalQueryIntent, report: TenantSourceTruthReport, assessedAt: string): OperationalQuerySourceTruth {
  const capabilities = new Set(QUERY_SOURCE_CAPABILITIES[intent]);
  const sources = report.sources.filter((source) => capabilities.has(source.capability) && (
    source.sourcePolicyConfigured
    || source.syncScopes.length > 0
    || !["native", "emulator", "dry_run"].includes(source.binding)
  )).map((source) => ({
    integrationId: source.integrationId,
    capability: source.capability,
    provider: source.binding,
    state: source.state,
    freshness: source.freshness,
    ...(source.lastSuccessfulSyncAt || source.lastObservedAt ? { asOf: source.lastSuccessfulSyncAt ?? source.lastObservedAt } : {}),
    unresolvedConflicts: source.unresolvedConflicts,
    ...(source.blockedReason ? { blockedReason: source.blockedReason } : {}),
  }));
  const status = sources.length === 0 || sources.every((source) => source.state === "fresh") ? "fresh"
    : sources.some((source) => ["blocked", "degraded"].includes(source.state) || ["stale", "expired"].includes(source.freshness)) ? "stale"
      : "unknown";
  return {
    assessedAt,
    status,
    provenance: "tenant_integrations+integration_sync_checkpoints+external_refs",
    sources,
  };
}

function normalizeCanonicalExecution(request: OperationalQueryRequest, raw: unknown, startedAt: string, completedAt: string, durationMs: number, sourceTruth?: OperationalQuerySourceTruth): OperationalQueryExecution {
  const result = canonicalizeResult(request, raw, completedAt);
  const top = isRecord(raw) ? raw : {};
  const metadata = isRecord(top.metadata) ? top.metadata : {};
  const execution = isRecord(result.execution) ? result.execution : undefined;
  const dates = dateRangeFromResult(result);
  return {
    request,
    result,
    metadata: {
      queryId: typeof execution?.id === "string" ? execution.id : typeof metadata.queryId === "string" ? metadata.queryId : randomUUID(),
      source: "postgresql",
      durationMs,
      startedAt,
      completedAt,
      ...(dates.timeZone ? { timeZone: dates.timeZone } : {}),
      ...(dates.dateRange ? { dateRange: dates.dateRange } : {}),
      ...(sourceTruth ? { sourceTruth } : {}),
    },
  };
}

function resultValue(result: OperationalQueryResult, key: string): unknown {
  const root = result as unknown as Record<string, unknown>;
  if (root[key] !== undefined) return root[key];
  const data = isRecord(result.data) ? result.data : {};
  return data[key];
}

function arrayLength(result: OperationalQueryResult, ...keys: string[]): number {
  return keys.reduce((total, key) => total + (Array.isArray(resultValue(result, key)) ? (resultValue(result, key) as unknown[]).length : 0), 0);
}

function resultCount(result: OperationalQueryResult): number {
  const value = resultValue(result, "count");
  return typeof value === "number" ? value : 0;
}

function summarizeData(intent: OperationalQueryIntent, result: OperationalQueryResult): { title: string; spokenSummary: string; facts: AnswerDisplayFact[] } {
  if (intent === "customer_lookup") {
    const rows = arrayLength(result, "rows");
    const resolution = resultValue(result, "resolution");
    if (resolution === "ambiguous" || result.status === "ambiguous") return { title: "Customer lookup", spokenSummary: `I found ${rows} possible customer records. Which one should I use?`, facts: [{ label: "Possible matches", value: String(rows) }] };
    if (resolution === "not_found" || result.status === "not_found") return { title: "Customer lookup", spokenSummary: "I couldn't find a matching customer record in this tenant.", facts: [{ label: "Matches", value: "0" }] };
    return { title: "Customer lookup", spokenSummary: "I found the customer record in this tenant.", facts: [{ label: "Matches", value: String(rows) }] };
  }
  if (intent === "customer_cohort") return { title: "Inactivity cohort", spokenSummary: `I found ${resultCount(result)} customers at or beyond the inactivity threshold.`, facts: [{ label: "Customers", value: String(resultCount(result)) }, { label: "Minimum inactive days", value: String(resultValue(result, "minDaysInactive") ?? "configured") }] };
  if (intent === "schedule_range") {
    const count = arrayLength(result, "rows");
    const localRange = isRecord(resultValue(result, "localDateRange")) ? resultValue(result, "localDateRange") as Record<string, unknown> : {};
    const range = isRecord(resultValue(result, "range")) ? resultValue(result, "range") as Record<string, unknown> : {};
    const timeZone = typeof resultValue(result, "timeZone") === "string" ? String(resultValue(result, "timeZone")) : "UTC";
    const localDateAt = (value: string): string => {
      try {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
        const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
        const year = part("year");
        const month = part("month");
        const day = part("day");
        return year && month && day ? `${year}-${month}-${day}` : value.slice(0, 10);
      } catch {
        return value.slice(0, 10);
      }
    };
    const requestedDate = typeof localRange.startDate === "string" && localRange.startDate !== "tomorrow"
      ? localRange.startDate
      : typeof range.start === "string"
        ? localDateAt(range.start)
        : "the requested date";
    const asOfTime = (() => {
      try {
        return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(new Date(result.asOf));
      } catch {
        return result.asOf;
      }
    })();
    return count === 0
      ? {
          title: "Schedule",
          spokenSummary: `0 appointments found for ${requestedDate} as of ${asOfTime}. This is a canonical schedule result.`,
          facts: [{ label: "Appointments", value: "0" }, { label: "Date", value: requestedDate }, { label: "As of", value: `${asOfTime} (${timeZone})` }],
        }
      : {
          title: "Schedule",
          spokenSummary: `${count} appointments and scheduled work items found for ${requestedDate} as of ${asOfTime}.`,
          facts: [{ label: "Appointments and work", value: String(count) }, { label: "Date", value: requestedDate }, { label: "Sources", value: "Appointments, service visits, work orders" }],
        };
  }
  if (intent === "money_summary") {
    const totals = isRecord(resultValue(result, "totals")) ? resultValue(result, "totals") as Record<string, unknown> : {};
    return { title: "Money summary", spokenSummary: `I retrieved ${money(Number(totals.collectedUsd ?? 0))} in collected payments.`, facts: [{ label: "Collected", value: money(Number(totals.collectedUsd ?? 0)) }, { label: "Invoiced", value: money(Number(totals.invoicedUsd ?? 0)) }, { label: "Pending collection", value: money(Number(totals.pendingCollectionUsd ?? 0)) }] };
  }
  if (intent === "work_list") return { title: "Work", spokenSummary: `I found ${resultCount(result)} durable Work records or related operational items.`, facts: [{ label: "Records", value: String(resultCount(result)) }] };
  if (intent === "inventory_status") return { title: "Inventory", spokenSummary: `I found ${resultCount(result)} inventory records matching the request.`, facts: [{ label: "Records", value: String(resultCount(result)) }] };
  if (intent === "agent_activity") return { title: "Agent activity", spokenSummary: `I found ${resultCount(result)} recent agent activity records.`, facts: [{ label: "Records", value: String(resultCount(result)) }] };
  if (intent === "party_lookup") {
    const rows = arrayLength(result, "rows");
    const resolution = resultValue(result, "resolution");
    if (resolution === "ambiguous") return { title: "Party lookup", spokenSummary: `I found ${rows} possible directory matches. Which one should I use?`, facts: [{ label: "Possible matches", value: String(rows) }] };
    if (resolution === "inactive") return { title: "Party lookup", spokenSummary: "The matching directory party is inactive or suspended and cannot be used as an operational target.", facts: [{ label: "Status", value: "inactive" }] };
    if (resolution === "not_found") return { title: "Party lookup", spokenSummary: "I couldn't find a matching operational party in this tenant.", facts: [{ label: "Matches", value: "0" }] };
    return { title: "Party lookup", spokenSummary: "I found the operational party in this tenant directory.", facts: [{ label: "Matches", value: String(rows) }] };
  }
  if (intent === "party_context") return { title: "Party context", spokenSummary: result.status === "inactive" ? "The requested party is inactive or suspended, so no operational context was loaded." : `I retrieved ${resultCount(result)} bounded party-context records from the canonical directory.`, facts: [{ label: "Status", value: result.status }] };
  if (intent === "team_roster") return { title: "Team roster", spokenSummary: result.status === "inactive" ? "The requested team is inactive and cannot be used as an operational roster." : `I retrieved ${resultCount(result)} active team-roster members.`, facts: [{ label: "Members", value: String(resultCount(result)) }, { label: "Status", value: result.status }] };
  if (intent === "party_availability") return { title: "Party availability", spokenSummary: result.status === "inactive" ? "The requested party is inactive or suspended and cannot be used for dispatch." : `I retrieved the canonical availability state: ${String(resultValue(result, "availability") ?? "unknown")}.`, facts: [{ label: "Availability", value: String(resultValue(result, "availability") ?? "unknown") }, { label: "Status", value: result.status }] };
  if (intent === "company_context") {
    const context = isRecord(resultValue(result, "context")) ? resultValue(result, "context") as Record<string, unknown> : null;
    const household = context && isRecord(context.household) ? context.household : null;
    const label = typeof household?.displayName === "string" ? household.displayName : typeof household?.address === "string" ? household.address : "customer";
    if (!context) return { title: "Company context", spokenSummary: result.status === "ambiguous" ? "I found multiple matching customers. Which one should I use?" : "I couldn't resolve a canonical customer context.", facts: [{ label: "Status", value: result.status }] };
    return { title: "Company context", spokenSummary: `I resolved ${label}'s connected company context from canonical records.`, facts: [{ label: "Connected records", value: String(resultCount(result)) }, { label: "Customer", value: label }] };
  }
  return { title: "Business state", spokenSummary: "I retrieved the current business state from the tenant's operational records.", facts: [{ label: "Source", value: "Tenant operational database" }] };
}

function snapshotFromMoneyResult(result: OperationalQueryResult): CashCollections | null {
  const data = isRecord(result.data) ? result.data : {};
  if (Array.isArray(data.invoicesByStatus) && typeof data.totalCollected === "number" && typeof data.paymentLinksAwaitingPayment === "number") return data as unknown as CashCollections;
  const root = result as unknown as Record<string, unknown>;
  const invoices = Array.isArray(root.invoices) ? root.invoices : null;
  const totals = isRecord(root.totals) ? root.totals : null;
  if (!invoices || !totals || typeof totals.collectedUsd !== "number") return null;
  const paymentLinks = typeof root.paymentLinksAwaitingPayment === "number"
    ? root.paymentLinksAwaitingPayment
    : typeof data.paymentLinksAwaitingPayment === "number"
      ? data.paymentLinksAwaitingPayment
      : Array.isArray(root.paymentLinksAwaitingPayment)
        ? root.paymentLinksAwaitingPayment.length
        : 0;
  return {
    invoicesByStatus: invoices.filter(isRecord).map((row) => ({
      status: typeof row.status === "string" ? row.status : "unknown",
      count: typeof row.count === "number" ? row.count : 0,
      totalUsd: typeof row.totalUsd === "number" ? row.totalUsd : 0,
    })),
    totalCollected: totals.collectedUsd,
    paymentLinksAwaitingPayment: paymentLinks,
  };
}

function answerForExecution(execution: OperationalQueryExecution): AnswerEnvelope {
  const legacySnapshot = execution.request.intent === "money_summary" ? snapshotFromMoneyResult(execution.result) : null;
  if (legacySnapshot) return { ...answerCashCollections(legacySnapshot, execution.result.asOf), query: execution };
  const summary = summarizeData(execution.request.intent, execution.result);
  return {
    kind: "answer",
    intent: execution.request.intent,
    readOnly: true,
    spokenSummary: summary.spokenSummary,
    display: { title: summary.title, facts: summary.facts.slice(0, 8) },
    evidence: [{ source: `operational_query:${execution.request.intent}`, ref: execution.metadata.queryId, timestamp: execution.result.asOf, kind: "CANONICAL" }],
    asOf: execution.result.asOf,
    freshness: {
      status: execution.metadata.sourceTruth?.status ?? "fresh",
      observedAt: execution.metadata.sourceTruth?.sources
        .map((source) => source.asOf).filter((value): value is string => Boolean(value)).sort()[0]
        ?? execution.result.asOf,
      ...(execution.metadata.sourceTruth ? { sourceTruth: execution.metadata.sourceTruth } : {}),
    },
    query: execution,
  };
}

export function createFastReadOnlyRouter(deps: FastReadOnlyRouterDeps = {}): FastReadOnlyRouter {
  const clock = deps.now ?? (() => new Date());
  const router: FastReadOnlyRouter = {
    classify: classifyFastReadOnlyQuestion,
    interpret: interpretOperationalQuery,
    async execute(request, ctx, options) {
      const startedAtDate = typeof options?.now === "function" ? options.now() : options?.now ?? clock();
      const startedAt = startedAtDate.toISOString();
      const start = performance.now();
      const executionOptions: OperationalQueryOptions = {
        ...options,
        ...(ctx.employeeId ? { employeeId: ctx.employeeId } : {}),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        // The canonical executor expects a function-valued clock. Keeping it
        // stable makes replay and focused tests deterministic.
        now: () => startedAtDate,
        ...(options?.workId ? { executionKey: options.executionKey ?? stableExecutionKey(request, options.workId) } : {}),
      };
      let raw: unknown;
      if (deps.cashCollections && request.intent === "money_summary") {
        raw = legacyCashResult(await deps.cashCollections(ctx.tenantId), clock().toISOString());
      } else {
        raw = await (deps.executeOperationalQuery ?? canonicalExecuteOperationalQuery)(ctx.tenantId, request, executionOptions);
      }
      const completedAt = clock().toISOString();
      const sourceTruthLoader = deps.sourceTruth ?? (!deps.executeOperationalQuery && !deps.cashCollections ? tenantSourceTruthReport : undefined);
      let sourceTruth: OperationalQuerySourceTruth | undefined;
      if (sourceTruthLoader) {
        try {
          sourceTruth = querySourceTruth(request.intent, await sourceTruthLoader(ctx.tenantId, startedAtDate), completedAt);
        } catch {
          sourceTruth = {
            assessedAt: completedAt,
            status: "unknown",
            provenance: "tenant_integrations+integration_sync_checkpoints+external_refs",
            sources: [],
          };
        }
      }
      return normalizeCanonicalExecution(request, raw, startedAt, completedAt, Math.max(0, Math.round(performance.now() - start)), sourceTruth);
    },
    async route(instruction, ctx) {
      const decision = interpretOperationalQuery(instruction);
      if (decision.route !== "fast_read") return null;
      const execution = await router.execute!(decision.request, ctx);
      return router.answer!(execution);
    },
    answer: answerForExecution,
  };
  return router;
}

export const defaultFastReadOnlyRouter = createFastReadOnlyRouter();
