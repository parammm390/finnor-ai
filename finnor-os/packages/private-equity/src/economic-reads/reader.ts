import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { withTenantTransaction } from "@finnor/db";
import { canExerciseAuthorityTx, employeeAuthoritySnapshotTx } from "@finnor/authority";
import { authorizeBeliefSourceScopes } from "../enterprise-beliefs";
import { PeDomainError, type PeMutationContext } from "../types";
import {
  EconomicReadRequestSchema, EconomicReadOutcomeSchema, QuoteStatementSchema, ReportingBindingSchema, RevenueStatementSchema,
  type EconomicReadOutcome, type EconomicReadRequest, type EconomicReadWitness, type QuoteReadOutcome, type RevenueReadOutcome,
} from "@finnor/shared-types";

const CANDIDATE_BOUND = 32;
type WitnessRow = { source_id: string; version_id: string; content_hash: string; source_as_of: Date; snapshot: unknown; total: number };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const witness = (row: WitnessRow): EconomicReadWitness => ({
  sourceId: row.source_id, versionId: row.version_id, contentHash: row.content_hash, asOf: row.source_as_of.toISOString(),
});
function decimalIdentity(value: string): string {
  const negative = value.startsWith("-"), [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const tail = fraction.replace(/0+$/, ""), magnitude = `${whole}${tail ? `.${tail}` : ""}`;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}
function unavailable(intent: EconomicReadRequest["intent"], observedAt: string, reason: string): EconomicReadOutcome {
  return { intent, availability: "UNAVAILABLE", observedAt, witnesses: [], reason };
}

/** Resolve first; apply the ordinary current grant/deny owner to each exact
 * resource. A singleton financial read is not a tenant-wide world-state scan. */
async function authorizeEconomicResources(client: PoolClient, ctx: PeMutationContext, intent: EconomicReadRequest["intent"], ids: string[]) {
  try {
    const before = await employeeAuthoritySnapshotTx(ctx.auth, client, false);
    for (const id of new Set(ids)) {
      if (!await canExerciseAuthorityTx(ctx.auth, { operation: "query", capability: `query:${intent}`,
        resource: { type: "external_organization", id }, risk: "low" }, client, false)) throw Error("Unavailable");
    }
    const after = await employeeAuthoritySnapshotTx(ctx.auth, client, false);
    if (after.revision !== before.revision) throw Error("Rights changed");
    return { revision: after.revision };
  } catch {
    throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The authenticated economic source is unavailable.");
  }
}

async function revenue(client: PoolClient, ctx: PeMutationContext, request: Extract<EconomicReadRequest, { intent: "company_revenue" }>, now: Date): Promise<RevenueReadOutcome> {
  const observedAt = now.toISOString();
  const absent = (reason: string): RevenueReadOutcome => ({ intent: request.intent, availability: "UNAVAILABLE", observedAt, witnesses: [], reason });
  const profile = (await client.query<{ binding: unknown }>(
    `SELECT CASE WHEN octet_length((business_facts->'economicReadBinding')::text)<=262144
      THEN business_facts->'economicReadBinding' ELSE NULL END AS binding
      FROM finnor_os.tenant_operating_profiles WHERE tenant_id=$1`, [ctx.auth.tenantId])).rows[0];
  const parsed = ReportingBindingSchema.safeParse(profile?.binding);
  if (!parsed.success) return absent("The company, accounting calendar, basis and currency need an owner-recorded reporting binding.");
  const binding = parsed.data;
  if (request.company.kind === "ID" && request.company.id !== binding.companyId) return absent("No owner-recorded reporting interpretation is configured for that company.");
  // Name resolution uses only the actual bound company; it cannot silently
  // substitute that company's figures for another explicit named target.
  if (request.company.kind === "NAME") {
    const row = (await client.query<{ name: string }>("SELECT name FROM finnor_os.external_organizations WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, binding.companyId])).rows[0];
    if (!row || row.name.normalize("NFKC").trim().toLowerCase() !== request.company.name.normalize("NFKC").trim().toLowerCase())
      return absent("No owner-recorded reporting interpretation is configured for that named company.");
  }
  const before = await authorizeEconomicResources(client, ctx, request.intent, [binding.companyId]);
  if (request.calendar !== undefined) return absent("That explicit calendar selector is not established by the owner-recorded reporting binding; no calendar or fiscal interpretation was substituted.");
  try { new Intl.DateTimeFormat("en", { timeZone: binding.timeZone }).format(now); }
  catch { return absent("The recorded accounting time zone is invalid."); }
  const months = [...binding.months].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  if (new Set(months.map(month => month.id)).size !== months.length
      || months.some((month, index) => Date.parse(month.startAt) >= Date.parse(month.endAt)
        || index > 0 && Date.parse(month.startAt) < Date.parse(months[index - 1]!.endAt))) {
    return absent("The recorded accounting-month boundaries overlap or are invalid.");
  }
  const current = months.findIndex(month => Date.parse(month.startAt) <= now.getTime() && now.getTime() < Date.parse(month.endAt));
  const month = months[current - 1];
  if (current < 1 || !month || Date.parse(month.endAt) !== Date.parse(months[current]!.startAt)) return absent("The recorded calendar does not resolve the last completed accounting month.");
  const root = { entityType: "external_organization" as const, entityId: binding.companyId };
  type Row = WitnessRow & { series_id: string; observation_id: string; company_name: string; numeric_value: string; source_current: boolean };
  const rows = (await client.query<Row>(`
    SELECT s.id::text AS series_id,o.id::text AS observation_id,o.value_numeric::text AS numeric_value,
      CASE WHEN octet_length(c.name)<=1024 THEN c.name ELSE '' END AS company_name,
      e.id::text AS source_id,v.id::text AS version_id,v.content_hash,v.as_of AS source_as_of,
      CASE WHEN octet_length(v.snapshot::text)<=262144 THEN v.snapshot ELSE '{}'::jsonb END AS snapshot,
      NOT EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions newer
        WHERE newer.source_id=v.source_id AND newer.version_number>v.version_number) AS source_current,
      count(*) OVER()::int AS total
    FROM finnor_os.pe_metric_series s
    JOIN finnor_os.pe_metric_observations o ON o.tenant_id=s.tenant_id AND o.metric_series_id=s.id
    JOIN finnor_os.external_organizations c ON c.tenant_id=s.tenant_id AND c.id=s.subject_id
    JOIN finnor_os.evidence_sources e ON e.tenant_id=o.tenant_id AND e.scope='tenant' AND e.id=o.evidence_source_id
    JOIN finnor_os.evidence_source_versions v ON v.tenant_id=e.tenant_id AND v.scope='tenant' AND v.source_id=e.id AND v.id=o.evidence_version_id
    WHERE s.tenant_id=$1 AND s.subject_type='external_organization' AND s.subject_id=$2 AND s.metric_key=$3
      AND s.unit='currency' AND s.currency_code=$4 AND s.frequency='monthly' AND s.active
      AND o.period_start=$5::timestamptz AND o.period_end=$6::timestamptz AND o.superseded_at IS NULL
      AND o.value_type='number' AND o.value_numeric IS NOT NULL
    ORDER BY s.id,o.id LIMIT 33`, [ctx.auth.tenantId, binding.companyId, binding.metricKey, request.currency ?? binding.currency, month.startAt, month.endAt])).rows;
  if (!rows.length) return absent("No exact canonical revenue statement matches the entity, month, currency and accounting basis.");
  if (rows[0]!.total > CANDIDATE_BOUND) return { intent: request.intent, availability: "AMBIGUOUS", observedAt, witnesses: [],
    reason: "The recorded source universe exceeds the direct-read bound; clarify the source." };
  await authorizeBeliefSourceScopes(ctx, root, rows.map(row => row.source_id), client);
  if (request.company.kind === "NAME") {
    const requestedName = request.company.name.normalize("NFKC").trim().toLowerCase();
    if (rows.some(row => row.company_name.normalize("NFKC").trim().toLowerCase() !== requestedName))
      return absent("No owner-recorded reporting interpretation is configured for that named company.");
  }
  const statements = rows.map(row => RevenueStatementSchema.safeParse(object(row.snapshot).economicRevenue));
  if (statements.some(value => !value.success)) return absent("A matching canonical metric lacks an exact typed original accounting statement.");
  const checked = statements.map(value => { if (!value.success) throw Error("UNREACHABLE_STATEMENT"); return value.data; });
  if (rows.some((row, index) => {
    const statement = checked[index]!;
    return !row.company_name || !row.source_current || statement.companyId !== binding.companyId || statement.metricKey !== binding.metricKey
      || statement.monthId !== month.id || Date.parse(statement.periodStart) !== Date.parse(month.startAt) || Date.parse(statement.periodEnd) !== Date.parse(month.endAt)
      || statement.currency !== (request.currency ?? binding.currency) || statement.basis !== (request.basis ?? binding.basis)
      || statement.calendarRef !== binding.calendarRef || statement.timeZone !== binding.timeZone || statement.consolidationRef !== binding.consolidationRef
      || decimalIdentity(statement.amount) !== decimalIdentity(row.numeric_value)
      || Date.parse(statement.sourceUpdatedAt) > now.getTime() || row.source_as_of.getTime() > now.getTime();
  })) return absent("The original statement and current canonical metric do not agree on complete accounting semantics.");
  if (new Set(rows.map((row, index) => `${decimalIdentity(row.numeric_value)}:${checked[index]!.reportingStatus}`)).size !== 1) {
    return { intent: request.intent, availability: "CONFLICTED", observedAt, witnesses: [], reason: "Current canonical revenue statements disagree; no aggregation or silent selection is valid." };
  }
  const after = await authorizeEconomicResources(client, ctx, request.intent, [binding.companyId]);
  if (after.revision !== before.revision) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The authenticated source is unavailable.");
  await authorizeBeliefSourceScopes(ctx, root, rows.map(row => row.source_id), client);
  return { intent: request.intent, availability: "AVAILABLE", observedAt, statement: checked[0]!, companyName: rows[0]!.company_name,
    witnesses: rows.map(row => ({ ...witness(row), metricSeriesId: row.series_id, observationId: row.observation_id })) };
}

type QuoteRow = WitnessRow & { company_name: string | null; source_current: boolean; scope_current: boolean };
async function quotes(client: PoolClient, ctx: PeMutationContext, request: Extract<EconomicReadRequest, { intent: "stock_quote" }>, now: Date): Promise<QuoteReadOutcome> {
  const observedAt = now.toISOString();
  const absent = (reason: string): QuoteReadOutcome => ({ intent: request.intent, availability: "UNAVAILABLE", observedAt, witnesses: [], reason });
  const rows = (await client.query<QuoteRow>(`
    SELECT e.id::text AS source_id,v.id::text AS version_id,v.content_hash,v.as_of AS source_as_of,
      CASE WHEN octet_length(v.snapshot::text)<=262144 THEN v.snapshot ELSE '{}'::jsonb END AS snapshot,
      CASE WHEN octet_length(c.name)<=1024 THEN c.name ELSE '' END AS company_name,
      coalesce(o.evidence_version_id=v.id AND o.mapping_status='mapped' AND o.conflict_state='none' AND NOT o.provider_deleted
        AND o.materialization_status='observed' AND o.canonical_entity_type='external_organization'
        AND o.canonical_entity_id::text=v.snapshot#>>'{economicQuote,instrument,issuerCompanyId}'
        AND r.mapping_status='mapped' AND r.conflict_state='none' AND NOT r.provider_deleted AND r.tombstoned_at IS NULL
        AND r.entity='external_organization' AND r.internal_id=o.canonical_entity_id AND r.freshness_state='fresh'
        AND r.observed_hash=o.observed_hash,false) AND o.id IS NOT NULL AND r.id IS NOT NULL
        AND date_trunc('milliseconds',v.as_of)=v.as_of AS source_current,
      coalesce(sc.enabled AND sc.disabled_at IS NULL AND cardinality(sc.required_permissions)>0
        AND sc.effective_permissions @> sc.required_permissions AND sc.permission_verified_at IS NOT NULL
        AND sc.permission_verified_at<=$7::timestamptz AND i.binding=o.provider AND sc.provider=o.provider,false) AS scope_current,
      count(*) OVER()::int AS total
    FROM finnor_os.evidence_sources e
    JOIN LATERAL(SELECT version.* FROM finnor_os.evidence_source_versions version
      WHERE version.tenant_id=e.tenant_id AND version.scope='tenant' AND version.source_id=e.id ORDER BY version.version_number DESC LIMIT 1) v ON true
    LEFT JOIN finnor_os.external_organizations c ON c.tenant_id=e.tenant_id AND c.id::text=v.snapshot#>>'{economicQuote,instrument,issuerCompanyId}'
    LEFT JOIN LATERAL(SELECT observation.* FROM finnor_os.external_ref_observations observation
      WHERE observation.tenant_id=e.tenant_id AND observation.evidence_source_id=e.id ORDER BY observation.received_at DESC,observation.id DESC LIMIT 1) o ON true
    LEFT JOIN finnor_os.external_refs r ON r.tenant_id=e.tenant_id AND r.id=o.source_link_id
    LEFT JOIN finnor_os.integration_source_scopes sc ON sc.tenant_id=e.tenant_id AND sc.id=o.source_scope_id AND sc.integration_id=o.integration_id
    LEFT JOIN finnor_os.tenant_integrations i ON i.tenant_id=e.tenant_id AND i.id=o.integration_id
    WHERE e.tenant_id=$1 AND e.scope='tenant' AND e.source_type='market_data_quote'
      AND (($2='SYMBOL' AND v.snapshot#>>'{economicQuote,instrument,symbol}'=$3)
        OR ($2='NAME' AND lower(c.name)=lower($4)))
      AND ($5::text IS NULL OR v.snapshot#>>'{economicQuote,instrument,exchange}'=$5)
      AND ($6::text IS NULL OR v.snapshot#>>'{economicQuote,instrument,currency}'=$6)
    ORDER BY e.id LIMIT 33`, [ctx.auth.tenantId, request.instrument.kind,
    request.instrument.kind === "SYMBOL" ? request.instrument.symbol : null,
    request.instrument.kind === "NAME" ? request.instrument.name : null, request.instrument.exchange ?? null, request.currency ?? null, observedAt])).rows;
  if (!rows.length) return absent("No authorized recorded market-data source resolves that instrument.");
  if (rows[0]!.total > CANDIDATE_BOUND) return { intent: request.intent, availability: "AMBIGUOUS", observedAt, witnesses: [],
    reason: "The recorded instrument universe exceeds the direct-read bound." };
  const parsed = rows.map(row => QuoteStatementSchema.safeParse(object(row.snapshot).economicQuote));
  if (parsed.some(value => !value.success)) return absent("A matching market-data source has an invalid original quote or license statement.");
  const checked = parsed.map(value => { if (!value.success) throw Error("UNREACHABLE_QUOTE"); return value.data; });
  const roots = [...new Set(checked.map(quote => quote.instrument.issuerCompanyId))];
  const before = await authorizeEconomicResources(client, ctx, request.intent, roots);
  for (const id of roots) await authorizeBeliefSourceScopes(ctx, { entityType: "external_organization", entityId: id },
    rows.filter((_, index) => checked[index]!.instrument.issuerCompanyId === id).map(row => row.source_id), client);
  if (rows.some(row => !row.company_name || !row.source_current || !row.scope_current)) return absent("Current mapped source ownership and verified provider permissions are unavailable.");
  const keys = new Set(checked.map(quote => `${quote.instrument.exchange}:${quote.instrument.symbol}:${quote.instrument.currency}:${quote.instrument.issuerCompanyId}`));
  if (keys.size !== 1) return { intent: request.intent, availability: "AMBIGUOUS", observedAt, witnesses: [], reason: "The symbol or name resolves to multiple instruments; specify exchange and currency." };
  const lawful = checked.map((quote, index) => ({ quote, row: rows[index]! })).filter(({ quote, row }) =>
    quote.license.displayAllowed && Date.parse(quote.license.startsAt) <= now.getTime() && now.getTime() < Date.parse(quote.license.endsAt)
    && Date.parse(quote.providerTimestamp) >= Date.parse(quote.license.startsAt) && Date.parse(quote.providerTimestamp) <= now.getTime()
    && row.source_as_of.getTime() === Date.parse(quote.providerTimestamp) && Date.parse(quote.validUntil) >= Date.parse(quote.providerTimestamp));
  if (!lawful.length) return absent("No current lawful display license and valid provider timestamp are recorded; no current quote is available.");
  lawful.sort((a, b) => Date.parse(b.quote.providerTimestamp) - Date.parse(a.quote.providerTimestamp));
  const latestTimestamp = lawful[0]!.quote.providerTimestamp;
  const simultaneous = lawful.filter(value => Date.parse(value.quote.providerTimestamp) === Date.parse(latestTimestamp));
  if (new Set(simultaneous.map(value => `${decimalIdentity(value.quote.price)}:${value.quote.marketSession}:${value.quote.delaySeconds}`)).size !== 1) {
    return { intent: request.intent, availability: "CONFLICTED", observedAt, witnesses: [], reason: "Current source quotes disagree at the same provider timestamp." };
  }
  // Freshness is semantic, never stable-sort/source-UUID order. A fresh lawful
  // statement wins over an expired simultaneous statement with agreeing price.
  // Among fresh statements take the earliest expiry (conservative); if all are
  // stale take the latest historical expiry. Complete quote bytes break ties.
  const current = simultaneous.filter(value => now.getTime() < Date.parse(value.quote.validUntil));
  const candidates = current.length ? current : simultaneous;
  candidates.sort((a, b) => (current.length ? 1 : -1) * (Date.parse(a.quote.validUntil) - Date.parse(b.quote.validUntil))
    || JSON.stringify(a.quote).localeCompare(JSON.stringify(b.quote)));
  const latest = candidates[0]!;
  const after = await authorizeEconomicResources(client, ctx, request.intent, roots);
  if (after.revision !== before.revision) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The authenticated source is unavailable.");
  for (const id of roots) await authorizeBeliefSourceScopes(ctx, { entityType: "external_organization", entityId: id },
    rows.filter((_, index) => checked[index]!.instrument.issuerCompanyId === id).map(row => row.source_id), client);
  const witnesses = simultaneous.map(value => witness(value.row));
  if (now.getTime() >= Date.parse(latest.quote.validUntil)) return { intent: request.intent, availability: "STALE", observedAt, witnesses,
    lastKnown: latest.quote, reason: "The recorded quote is stale. Its provider timestamp is historical, not a current price." };
  return { intent: request.intent, availability: latest.quote.delaySeconds > 0 ? "DELAYED" : "CURRENT", observedAt, witnesses,
    quote: latest.quote, companyName: latest.row.company_name! };
}

/** Native read-only owner entry. No queue, workforce, sandbox, reserve or effect import. */
export async function readEconomicQuery(ctx: PeMutationContext, input: unknown): Promise<EconomicReadOutcome> {
  const request = EconomicReadRequestSchema.parse(input);
  return withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, async (_db, client) => {
    // Resolve the actual employee/revision even when there is no configured
    // source. Exact resource/capability checks live beside resolved owner rows.
    const before = await authorizeEconomicResources(client, ctx, request.intent, []);
    const now = new Date((await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now);
    if (!Number.isFinite(now.getTime())) return unavailable(request.intent, new Date().toISOString(), "The source clock is unavailable.");
    const outcome = await (request.intent === "company_revenue" ? revenue(client, ctx, request, now) : quotes(client, ctx, request, now));
    const after = await authorizeEconomicResources(client, ctx, request.intent, []);
    if (after.revision !== before.revision) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The authenticated source is unavailable.");
    return EconomicReadOutcomeSchema.parse(outcome);
  });
}

/** Exact stored replies keep their original as-of time but never bypass current source rights. */
export async function assertEconomicReadReplayAccess(ctx: PeMutationContext, input: unknown, value: unknown): Promise<void> {
  const request = EconomicReadRequestSchema.parse(input), stored = EconomicReadOutcomeSchema.parse(value);
  if (request.intent !== stored.intent) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The original authenticated read is unavailable.");
  // Reuse the actual owner, including current mapping, source scopes, financial
  // restatements, permissions and clock/quote/license eligibility. A cached type
  // annotation or historical source hash is not current use authority.
  const current = await readEconomicQuery(ctx, request);
  const { observedAt: _then, ...original } = stored;
  const { observedAt: _now, ...present } = current;
  if (!isDeepStrictEqual(original, present)) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The original source, interpretation or current display rights changed; request a new read.");
}

/** Compiler preflight reuses this exact resolving/current-rights owner. Only a
 * boolean leaves it: no economic outcome enters compilation facts or the model.
 * An unresolvable/unavailable recorded source cannot admit an Objective node;
 * ordinary direct reads retain their existing bounded-unavailable behavior. */
export async function canReadEconomicQuery(ctx: PeMutationContext, input: unknown): Promise<boolean> {
  try {
    const outcome = await readEconomicQuery(ctx, input);
    return outcome.witnesses.length > 0 && ["AVAILABLE", "CURRENT", "DELAYED", "STALE"].includes(outcome.availability);
  } catch { return false; }
}
