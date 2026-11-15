import { z } from "zod";
import type { OperationalQueryResultBase } from "./operational-queries";

const currency = z.string().regex(/^[A-Z]{3}$/);
// The read profile preserves whole milliseconds; finer timestamps are unsupported,
// never silently rounded before quote ordering or currentness comparisons.
const instant = z.string().datetime({ offset: true }).refine(value => (value.match(/[.](\d+)/)?.[1]?.length ?? 0) <= 3, "Millisecond timestamp profile required");
const ref = z.string().min(1).max(160);
const decimal = z.string().max(100).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const symbol = z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,15}$/);
const exchange = z.string().regex(/^[A-Z0-9]{2,12}$/);

export const RevenueReadRequestSchema = z.object({
  intent: z.literal("company_revenue"),
  company: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("TENANT_DEFAULT") }).strict(),
    z.object({ kind: z.literal("ID"), id: z.string().uuid() }).strict(),
    z.object({ kind: z.literal("NAME"), name: z.string().trim().min(1).max(1024) }).strict(),
  ]),
  period: z.literal("LAST_COMPLETED_MONTH"),
  currency: currency.optional(),
  basis: z.enum(["ACCRUAL", "CASH"]).optional(),
  // A selector is not a guessed calendarRef. The reader boundedly refuses these
  // until its owner can establish this exact calendar interpretation.
  calendar: z.enum(["CALENDAR", "FISCAL"]).optional(),
}).strict();

export const QuoteReadRequestSchema = z.object({
  intent: z.literal("stock_quote"),
  instrument: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("SYMBOL"), symbol, exchange: exchange.optional() }).strict(),
    z.object({ kind: z.literal("NAME"), name: z.string().trim().min(1).max(160), exchange: exchange.optional() }).strict(),
  ]),
  currency: currency.optional(),
}).strict();

export const EconomicReadRequestSchema = z.discriminatedUnion("intent", [RevenueReadRequestSchema, QuoteReadRequestSchema]);
export type EconomicReadRequest = z.infer<typeof EconomicReadRequestSchema>;

/** Operator-recorded interpretation, not a new financial-fact store. */
export const ReportingBindingSchema = z.object({
  schema: z.literal("finnor.economic-read-binding.v1"),
  companyId: z.string().uuid(),
  metricKey: ref,
  basis: z.enum(["ACCRUAL", "CASH"]),
  currency,
  calendarRef: ref,
  timeZone: z.string().min(1).max(80),
  consolidationRef: ref,
  months: z.array(z.object({ id: ref, startAt: instant, endAt: instant }).strict()).min(2).max(240),
}).strict();

/** Immutable source statement must agree with the existing metric owner. */
export const RevenueStatementSchema = z.object({
  schema: z.literal("finnor.recorded-revenue-statement.v1"),
  companyId: z.string().uuid(),
  metricKey: ref,
  monthId: ref,
  periodStart: instant,
  periodEnd: instant,
  basis: z.enum(["ACCRUAL", "CASH"]),
  currency,
  calendarRef: ref,
  timeZone: z.string().min(1).max(80),
  consolidationRef: ref,
  reportingStatus: z.enum(["PROVISIONAL", "CLOSED"]),
  amount: decimal,
  sourceUpdatedAt: instant,
}).strict();

/** A source's recorded license never grants employee/source-scope authority. */
export const QuoteStatementSchema = z.object({
  schema: z.literal("finnor.recorded-market-quote.v1"),
  providerRef: ref,
  instrument: z.object({
    symbol,
    exchange,
    currency,
    issuerCompanyId: z.string().uuid(),
  }).strict(),
  price: decimal.refine(value => !value.startsWith("-") && /[1-9]/.test(value), "Positive quote required"),
  providerTimestamp: instant,
  marketSession: z.enum(["PRE_MARKET", "REGULAR", "AFTER_HOURS", "CLOSED"]),
  delaySeconds: z.number().int().nonnegative().max(604800),
  validUntil: instant,
  license: z.object({
    reference: ref,
    displayAllowed: z.boolean(),
    startsAt: instant,
    endsAt: instant,
  }).strict(),
}).strict();

export const EconomicReadWitnessSchema = z.object({
  sourceId: z.string().uuid(),
  versionId: z.string().uuid(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  asOf: instant,
  metricSeriesId: z.string().uuid().optional(),
  observationId: z.string().uuid().optional(),
}).strict();
export type EconomicReadWitness = z.infer<typeof EconomicReadWitnessSchema>;
const observation = { observedAt: instant, witnesses: z.array(EconomicReadWitnessSchema).max(32) };
const disposition = z.enum(["UNAVAILABLE", "AMBIGUOUS", "CONFLICTED"]);
export const RevenueReadOutcomeSchema = z.union([
  z.object({ ...observation, intent: z.literal("company_revenue"), availability: z.literal("AVAILABLE"),
    statement: RevenueStatementSchema, companyName: z.string().min(1).max(1024) }).strict(),
  z.object({ ...observation, intent: z.literal("company_revenue"), availability: disposition, reason: z.string().min(1).max(1024) }).strict(),
]);
export const QuoteReadOutcomeSchema = z.union([
  z.object({ ...observation, intent: z.literal("stock_quote"), availability: z.enum(["CURRENT", "DELAYED"]),
    quote: QuoteStatementSchema, companyName: z.string().min(1).max(1024) }).strict(),
  z.object({ ...observation, intent: z.literal("stock_quote"), availability: z.literal("STALE"),
    lastKnown: QuoteStatementSchema, reason: z.string().min(1).max(1024) }).strict(),
  z.object({ ...observation, intent: z.literal("stock_quote"), availability: disposition, reason: z.string().min(1).max(1024) }).strict(),
]);
export const EconomicReadOutcomeSchema = z.union([RevenueReadOutcomeSchema, QuoteReadOutcomeSchema]);
export type RevenueReadOutcome = z.infer<typeof RevenueReadOutcomeSchema>;
export type QuoteReadOutcome = z.infer<typeof QuoteReadOutcomeSchema>;
export type EconomicReadOutcome = z.infer<typeof EconomicReadOutcomeSchema>;

export const ECONOMIC_READ_QUERY_INTENTS = ["company_revenue", "stock_quote"] as const;
export type RevenueReadRequest = z.infer<typeof RevenueReadRequestSchema>;
export type QuoteReadRequest = z.infer<typeof QuoteReadRequestSchema>;
export type EconomicOperationalQueryResult =
  | (OperationalQueryResultBase<"company_revenue"> & { economicRead: RevenueReadOutcome })
  | (OperationalQueryResultBase<"stock_quote"> & { economicRead: QuoteReadOutcome });

export function economicReadSource(intent: EconomicReadRequest["intent"]) {
  return { kind: "canonical_postgres" as const, tables: intent === "company_revenue"
    ? ["tenant_operating_profiles", "external_organizations", "pe_metric_series", "pe_metric_observations", "evidence_sources", "evidence_source_versions"]
    : ["external_organizations", "evidence_sources", "evidence_source_versions", "external_ref_observations", "external_refs", "integration_source_scopes", "tenant_integrations"] };
}

const querySource = z.object({ kind: z.literal("canonical_postgres"), tables: z.array(z.string().min(1).max(80)).min(1).max(32) }).strict();
const count = z.union([z.literal(0), z.literal(1)]);
const resultFields = {
  kind: z.literal("operational_query_result"), version: z.literal(1),
  status: z.enum(["ok", "partial", "unavailable", "ambiguous"]),
  source: querySource, asOf: instant, count, truncated: z.literal(false),
  data: z.object({ availability: z.enum(["AVAILABLE", "CURRENT", "DELAYED", "STALE", "UNAVAILABLE", "AMBIGUOUS", "CONFLICTED"]) }).strict(),
  page: z.object({ limit: z.literal(1), returned: count, totalCount: count, totalCountExact: z.literal(true),
    hasMore: z.literal(false), nextCursor: z.null(), truncated: z.literal(false) }).strict(),
  meta: z.object({ version: z.literal(1), source: querySource, asOf: instant }).strict(),
  execution: z.object({ id: z.string().uuid(), workId: z.string().uuid(), workInputId: z.string().uuid(),
    executionKey: z.string().min(1).max(256), status: z.literal("succeeded") }).strict(),
};

export const EconomicOperationalQueryResultSchema = z.discriminatedUnion("intent", [
  z.object({ ...resultFields, intent: z.literal("company_revenue"), economicRead: RevenueReadOutcomeSchema }).strict(),
  z.object({ ...resultFields, intent: z.literal("stock_quote"), economicRead: QuoteReadOutcomeSchema }).strict(),
]).superRefine((result, ctx) => {
  const outcome = result.economicRead;
  const expectedCount = ["AVAILABLE", "CURRENT", "DELAYED"].includes(outcome.availability) ? 1 : 0;
  const expectedStatus = expectedCount ? "ok" : outcome.availability === "AMBIGUOUS" ? "ambiguous"
    : outcome.availability === "CONFLICTED" ? "partial" : "unavailable";
  if (outcome.intent !== result.intent || result.data.availability !== outcome.availability
      || result.count !== expectedCount || result.status !== expectedStatus
      || result.page.returned !== expectedCount || result.page.totalCount !== expectedCount
      || result.asOf !== outcome.observedAt || result.meta.asOf !== result.asOf
      || JSON.stringify(result.source) !== JSON.stringify(result.meta.source)
      || JSON.stringify(result.source.tables) !== JSON.stringify(economicReadSource(result.intent).tables)
      || expectedCount === 1 && outcome.witnesses.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent complete economic query result" });
  }
  const quote = "quote" in outcome ? outcome.quote : "lastKnown" in outcome ? outcome.lastKnown : null;
  if (quote) {
    const observed = Date.parse(outcome.observedAt), timestamp = Date.parse(quote.providerTimestamp);
    if (timestamp > observed || timestamp < Date.parse(quote.license.startsAt)
        || Date.parse(quote.validUntil) < timestamp || !quote.license.displayAllowed
        || Date.parse(quote.license.startsAt) > observed || observed >= Date.parse(quote.license.endsAt)
        || outcome.availability === "STALE" && observed < Date.parse(quote.validUntil)
        || outcome.availability !== "STALE" && observed >= Date.parse(quote.validUntil)
        || outcome.availability === "CURRENT" && quote.delaySeconds !== 0
        || outcome.availability === "DELAYED" && quote.delaySeconds <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent quote eligibility" });
    }
  }
  if ("statement" in outcome && (Date.parse(outcome.statement.periodStart) >= Date.parse(outcome.statement.periodEnd)
      || Date.parse(outcome.statement.periodEnd) > Date.parse(outcome.observedAt)
      || Date.parse(outcome.statement.sourceUpdatedAt) > Date.parse(outcome.observedAt))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent reporting statement chronology" });
  }
});

/** This schema parses the complete persisted execution; it is never an annotation
 * cast over a partially checked result, metadata, page or execution identity. */
export const EconomicQueryExecutionSchema = z.object({
  request: EconomicReadRequestSchema,
  result: EconomicOperationalQueryResultSchema,
  metadata: z.object({ queryId: z.string().uuid(), source: z.literal("postgresql"),
    durationMs: z.number().finite().nonnegative(), startedAt: instant, completedAt: instant }).strict(),
}).strict().superRefine(({ request, result, metadata }, ctx) => {
  const outcome = result.economicRead;
  const statement = "statement" in outcome ? outcome.statement : null;
  const quote = "quote" in outcome ? outcome.quote : "lastKnown" in outcome ? outcome.lastKnown : null;
  const mismatch = request.intent !== result.intent || result.execution.id !== metadata.queryId
    || Date.parse(metadata.completedAt) < Date.parse(metadata.startedAt)
    || request.intent === "company_revenue" && statement && (
      request.company.kind === "ID" && request.company.id !== statement.companyId
      || request.company.kind === "NAME" && "companyName" in outcome
        && request.company.name.normalize("NFKC").trim().toLowerCase() !== outcome.companyName.normalize("NFKC").trim().toLowerCase()
      || request.basis !== undefined && request.basis !== statement.basis
      || request.currency !== undefined && request.currency !== statement.currency
      || request.calendar !== undefined)
    || request.intent === "stock_quote" && quote && (
      request.instrument.kind === "SYMBOL" && request.instrument.symbol !== quote.instrument.symbol
      || request.instrument.kind === "NAME" && "companyName" in outcome
        && request.instrument.name.normalize("NFKC").trim().toLowerCase() !== outcome.companyName.normalize("NFKC").trim().toLowerCase()
      || request.instrument.exchange !== undefined && request.instrument.exchange !== quote.instrument.exchange
      || request.currency !== undefined && request.currency !== quote.instrument.currency);
  if (mismatch) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Request/result/metadata identity mismatch" });
});
export type EconomicQueryExecution = z.infer<typeof EconomicQueryExecutionSchema>;
/** Generated queries are not additional human messages. Their private reply
 * remains owned by the original input, with immutable native custody below it. */
export const ObjectiveEconomicQueryOriginSchema = z.object({
  kind: z.literal("objective_query"),
  objectiveLoopId: z.string().uuid(), objectiveRevision: z.number().int().positive(),
  planRevisionId: z.string().uuid(), planNodeId: z.string().min(1).max(200),
  objectiveStepId: z.string().uuid(), attemptNumber: z.number().int().positive(),
  originalPrincipalId: z.string().uuid(), originalWorkInputId: z.string().uuid(),
  originalInstructionId: z.string().uuid(), originalInputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  planSemanticHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  nodeSemanticHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  goalSemanticHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  acceptanceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type ObjectiveEconomicQueryOrigin = z.infer<typeof ObjectiveEconomicQueryOriginSchema>;
export const ObjectiveEconomicReadClaimSchema = z.object({
  stepId: z.string().uuid(), leaseOwner: z.string().min(1).max(200),
}).strict();
export type ObjectiveEconomicReadClaim = z.infer<typeof ObjectiveEconomicReadClaimSchema>;

export const EconomicReadReplySchema = z.object({
  query: EconomicQueryExecutionSchema,
  workId: z.string().uuid(), workInputId: z.string().uuid(), instructionId: z.string().uuid(),
  objective: ObjectiveEconomicQueryOriginSchema.optional(),
}).strict().superRefine((reply, ctx) => {
  if (reply.query.result.execution.workId !== reply.workId || reply.query.result.execution.workInputId !== reply.workInputId
      || reply.objective && (reply.objective.originalWorkInputId !== reply.workInputId || reply.objective.originalInstructionId !== reply.instructionId))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Exact private input identity mismatch" });
});
export type EconomicReadReply = z.infer<typeof EconomicReadReplySchema>;

export function economicReadReplyKey(objectiveStepId?: string): string {
  return objectiveStepId === undefined ? "input" : `objective:${ObjectiveEconomicReadClaimSchema.shape.stepId.parse(objectiveStepId)}`;
}
export function isEconomicReadIntent(value: unknown): value is EconomicReadRequest["intent"] {
  return typeof value === "string" && (ECONOMIC_READ_QUERY_INTENTS as readonly string[]).includes(value);
}
const economicObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** This lane verifies only an explicitly accepted readable-query condition.
 * Financial value comparisons or mixed business goals are not silently weakened. */
export function isEconomicReadMetadataAssertion(value: unknown): boolean {
  const assertion = economicObject(value), path = assertion.path;
  if (!Array.isArray(path) || assertion.operator !== "eq") return false;
  return path.length === 1 && path[0] === "status" && assertion.expected === "ok"
    || path.length === 2 && path[0] === "execution" && path[1] === "status" && assertion.expected === "succeeded";
}
export function economicReadAcceptanceRequests(value: unknown): EconomicReadRequest[] | null {
  const condition = economicObject(value), criteria = condition.criteria;
  if (condition.version !== 1 || condition.source !== "explicit" || !Array.isArray(criteria) || !criteria.length || criteria.length > 25) return null;
  const requests: EconomicReadRequest[] = [];
  for (const item of criteria) {
    const criterion = economicObject(item), request = EconomicReadRequestSchema.safeParse(criterion.request);
    if (criterion.kind !== "canonical_query" || !request.success || !isEconomicReadMetadataAssertion(criterion.assertion)) return null;
    requests.push(request.data);
  }
  return requests;
}

/** Redact at shared/model boundaries before truncation. Typed query requests are
 * public plan semantics; their outcomes, source statements and private envelopes
 * are not. This is deliberately not an authorization or replay parser. */
export function redactEconomicReadPayload(value: unknown, depth = 0): unknown {
  if (depth > 40) return { redacted: true };
  if (Array.isArray(value)) return value.map(item => redactEconomicReadPayload(item, depth + 1));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const row = economicObject(value), query = economicObject(row.query), result = economicObject(query.result ?? row.result);
  const request = economicObject(query.request ?? row.request), execution = economicObject(result.execution ?? row.execution);
  const intent = isEconomicReadIntent(result.intent) ? result.intent : isEconomicReadIntent(request.intent) ? request.intent : row.intent;
  if (row.schema === "finnor.recorded-revenue-statement.v1" || row.schema === "finnor.recorded-market-quote.v1")
    return { kind: "private_economic_fact" };
  if (row.economicRead !== undefined || isEconomicReadIntent(intent) && (row.result !== undefined || row.query !== undefined
      || row.availability !== undefined || row.kind === "operational_query_result")) {
    return {
      kind: "private_economic_query",
      ...(isEconomicReadIntent(intent) ? { intent } : {}),
      ...(typeof execution.id === "string" ? { queryExecutionId: execution.id } : {}),
      ...(["running", "succeeded", "failed"].includes(String(execution.status)) ? { status: execution.status } : {}),
    };
  }
  return Object.fromEntries(Object.entries(row).filter(([key]) =>
    !["economicRead", "economicRevenue", "economicQuote", "objectiveClaimOwner"].includes(key))
    .map(([key, nested]) => [key, redactEconomicReadPayload(nested, depth + 1)]));
}

/** Accept the two historical private HTTP envelope shapes, but only return
 * complete schema-parsed execution bytes. This never reads a shared Work. */
export function storedEconomicQuery(value: unknown): EconomicQueryExecution | null {
  const outer = economicObject(value), body = economicObject(outer.response ?? outer);
  const candidate = body.query ?? (body.request && body.result
    ? { request: body.request, result: body.result, metadata: body.metadata ?? body.execution } : null);
  const parsed = EconomicQueryExecutionSchema.safeParse(candidate);
  const answer = economicObject(body.answer);
  if (parsed.success && answer.query !== undefined) {
    const nested = EconomicQueryExecutionSchema.safeParse(answer.query);
    if (!nested.success || JSON.stringify(nested.data) !== JSON.stringify(parsed.data)) return null;
  }
  return parsed.success ? parsed.data : null;
}
