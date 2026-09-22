import { createHash, randomUUID } from "node:crypto";
import {
  assertPeText,
  assertPeUuid,
  insertPeRow,
  peProvenance,
  peTransaction,
  shapePeRow,
  type PeClient,
  type SqlRow,
} from "./repository";
import { PeDomainError, type PeMutationContext, type PeMutationResult } from "./types";

export const PE_COMPLETENESS_STATES = [
  "complete",
  "partial",
  "unknown",
  "conflicting",
  "unavailable_before_history_baseline",
] as const;
export type PeCompletenessState = (typeof PE_COMPLETENESS_STATES)[number];

export interface PeEvidenceRef {
  evidenceSourceId: string;
  evidenceVersionId: string;
}

export interface PeValidInterval {
  validFrom: Date;
  validTo?: Date;
}

type CanonicalRef = { entityType: string; entityId: string };

const COMPLETENESS = new Set<string>(PE_COMPLETENESS_STATES);

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new PeDomainError("PE_INVALID_INPUT", `${label} must be a valid date`);
  }
  return value;
}

function interval(input: PeValidInterval): { valid_from: Date; valid_to: Date | null } {
  const from = validDate(input.validFrom, "validFrom");
  const to = input.validTo ? validDate(input.validTo, "validTo") : null;
  if (to && to <= from) throw new PeDomainError("PE_INVALID_VALID_TIME", "validTo must be after validFrom");
  return { valid_from: from, valid_to: to };
}

function evidence(input: PeEvidenceRef): { evidence_source_id: string; evidence_version_id: string } {
  assertPeUuid(input.evidenceSourceId, "evidenceSourceId");
  assertPeUuid(input.evidenceVersionId, "evidenceVersionId");
  return { evidence_source_id: input.evidenceSourceId, evidence_version_id: input.evidenceVersionId };
}

function completeness(value: PeCompletenessState | undefined): PeCompletenessState {
  const result = value ?? "partial";
  if (!COMPLETENESS.has(result)) throw new PeDomainError("PE_INVALID_COMPLETENESS", `Unsupported completeness state ${result}`);
  return result;
}

function creation(ctx: PeMutationContext): Record<string, unknown> {
  const source = peProvenance(ctx);
  return {
    tenant_id: ctx.auth.tenantId,
    source_system: source.sourceSystem,
    external_id: source.externalId,
    created_by: source.createdBy,
    observed_at: source.observedAt,
  };
}

async function createTwin(
  client: PeClient,
  ctx: PeMutationContext,
  table: string,
  values: Record<string, unknown>,
): Promise<PeMutationResult> {
  const row = await insertPeRow(client, table, { id: values.id ?? randomUUID(), ...creation(ctx), ...values });
  return { row: shapePeRow(row), changed: true, idempotent: false };
}

function createInTransaction(
  ctx: PeMutationContext,
  table: string,
  values: Record<string, unknown>,
): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => createTwin(client, ctx, table, values));
}

export async function createFund(ctx: PeMutationContext, input: {
  id?: string; name: string; legalName?: string; vintageYear?: number; baseCurrency?: string;
  status?: "forming" | "active" | "harvesting" | "liquidated"; validFrom?: Date; validTo?: Date;
}): Promise<PeMutationResult> {
  assertPeText(input.name, "Fund name");
  return createInTransaction(ctx, "pe_funds", {
    id: input.id, name: input.name.trim(), legal_name: input.legalName?.trim() || null,
    vintage_year: input.vintageYear ?? null, base_currency: input.baseCurrency?.trim().toUpperCase() || null,
    status: input.status ?? "active", valid_from: input.validFrom ?? null, valid_to: input.validTo ?? null,
  });
}

export async function createVehicle(ctx: PeMutationContext, input: {
  id?: string; name: string; legalName?: string;
  vehicleType: "main" | "feeder" | "parallel" | "co_invest" | "blocker" | "continuation" | "other";
  jurisdiction?: string; status?: "forming" | "active" | "harvesting" | "liquidated"; validFrom?: Date; validTo?: Date;
}): Promise<PeMutationResult> {
  assertPeText(input.name, "Vehicle name");
  return createInTransaction(ctx, "pe_vehicles", {
    id: input.id, name: input.name.trim(), legal_name: input.legalName?.trim() || null,
    vehicle_type: input.vehicleType, jurisdiction: input.jurisdiction?.trim() || null,
    status: input.status ?? "active", valid_from: input.validFrom ?? null, valid_to: input.validTo ?? null,
  });
}

async function transitionIdentity(ctx: PeMutationContext, input: {
  table: "pe_funds" | "pe_vehicles"; id: string; expectedVersion: number;
  from: readonly string[]; to: "forming" | "active" | "harvesting" | "liquidated";
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<SqlRow>(
      `UPDATE finnor_os.${input.table} SET status=$4,version=version+1
        WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status=ANY($5::text[]) RETURNING *`,
      [ctx.auth.tenantId, input.id, input.expectedVersion, input.to, input.from],
    );
    if (!result.rows[0]) throw new PeDomainError("PE_STALE_VERSION", `${input.table} state or version changed concurrently`);
    return { row: shapePeRow(result.rows[0]), changed: true, idempotent: false };
  });
}

export function transitionFund(ctx: PeMutationContext, input: {
  fundId: string; expectedVersion: number; to: "active" | "harvesting" | "liquidated";
}): Promise<PeMutationResult> {
  const predecessors = input.to === "active" ? ["forming"] : input.to === "harvesting" ? ["active"] : ["harvesting"];
  return transitionIdentity(ctx, { table: "pe_funds", id: input.fundId, expectedVersion: input.expectedVersion, from: predecessors, to: input.to });
}

export function transitionVehicle(ctx: PeMutationContext, input: {
  vehicleId: string; expectedVersion: number; to: "active" | "harvesting" | "liquidated";
}): Promise<PeMutationResult> {
  const predecessors = input.to === "active" ? ["forming"] : input.to === "harvesting" ? ["active"] : ["harvesting"];
  return transitionIdentity(ctx, { table: "pe_vehicles", id: input.vehicleId, expectedVersion: input.expectedVersion, from: predecessors, to: input.to });
}

export function linkFundVehicle(ctx: PeMutationContext, input: {
  id?: string; fundId: string; vehicleId: string;
  relationshipKind: "master" | "feeder" | "parallel" | "co_invest" | "blocker" | "continuation" | "other";
  completeness?: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_fund_vehicle_links", {
    id: input.id, fund_id: input.fundId, vehicle_id: input.vehicleId, relationship_kind: input.relationshipKind,
    ...interval(input), completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export function linkStrategyMandate(ctx: PeMutationContext, input: {
  id?: string; principalType: "pe_fund" | "pe_vehicle"; principalId: string; strategyId: string;
  completeness?: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_strategy_mandates", {
    id: input.id, principal_type: input.principalType, principal_id: input.principalId, strategy_id: input.strategyId,
    ...interval(input), completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export function createPortfolioHolding(ctx: PeMutationContext, input: {
  id?: string; fundId?: string; vehicleId?: string; companyId: string; originDealId: string;
  entryDate: string; completeness?: PeCompletenessState; evidence: PeEvidenceRef;
}): Promise<PeMutationResult> {
  if (Boolean(input.fundId) === Boolean(input.vehicleId)) {
    throw new PeDomainError("PE_INVALID_INPUT", "PortfolioHolding requires exactly one Fund or Vehicle investor");
  }
  return createInTransaction(ctx, "pe_portfolio_holdings", {
    id: input.id, fund_id: input.fundId ?? null, vehicle_id: input.vehicleId ?? null,
    company_id: input.companyId, origin_deal_id: input.originDealId, entry_date: input.entryDate,
    completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export function recordCompanyHierarchy(ctx: PeMutationContext, input: {
  id?: string; parentCompanyId: string; childCompanyId: string;
  relationshipKind: "parent_subsidiary" | "holding_operating";
  completeness?: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_company_hierarchy_relationships", {
    id: input.id, parent_company_id: input.parentCompanyId, child_company_id: input.childCompanyId,
    relationship_kind: input.relationshipKind, ...interval(input),
    completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export function recordCompanyPartyRole(ctx: PeMutationContext, input: {
  id?: string; companyId: string; partyType: "external_organization" | "external_contact"; partyId: string;
  role: "sponsor" | "advisor"; roleDetail?: string; completeness?: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_company_party_roles", {
    id: input.id, company_id: input.companyId, party_type: input.partyType, party_id: input.partyId,
    role: input.role, role_detail: input.roleDetail?.trim() || null, ...interval(input),
    completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export function createSecurity(ctx: PeMutationContext, input: {
  id?: string; issuerCompanyId: string; securityKey: string;
  securityType: "common_equity" | "preferred_equity" | "convertible" | "option" | "warrant" | "other";
  name: string; currencyCode?: string; seniority?: number; completeness?: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  assertPeText(input.securityKey, "securityKey"); assertPeText(input.name, "Security name");
  return createInTransaction(ctx, "pe_securities", {
    id: input.id, issuer_company_id: input.issuerCompanyId, security_key: input.securityKey.trim(), security_type: input.securityType,
    name: input.name.trim(), currency_code: input.currencyCode?.toUpperCase() || null, seniority: input.seniority ?? null,
    ...interval(input), completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export function createDebtFacility(ctx: PeMutationContext, input: {
  id?: string; borrowerCompanyId: string; facilityKey: string; name: string;
  facilityType: "revolver" | "term_loan" | "delayed_draw" | "mezzanine" | "unitranche" | "notes" | "other";
  committedAmount?: string; currencyCode?: string; maturityDate?: string;
  status?: "committed" | "active" | "repaid" | "cancelled" | "defaulted";
  completeness?: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  assertPeText(input.facilityKey, "facilityKey"); assertPeText(input.name, "DebtFacility name");
  return createInTransaction(ctx, "pe_debt_facilities", {
    id: input.id, borrower_company_id: input.borrowerCompanyId, facility_key: input.facilityKey.trim(), name: input.name.trim(),
    facility_type: input.facilityType, committed_amount: input.committedAmount ?? null,
    currency_code: input.currencyCode?.toUpperCase() || null, maturity_date: input.maturityDate ?? null,
    status: input.status ?? "active", ...interval(input), completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export function linkDebtFacilityLender(ctx: PeMutationContext, input: {
  id?: string; debtFacilityId: string; lenderPartyType: "external_organization" | "external_contact"; lenderPartyId: string;
  lenderRole: "agent" | "arranger" | "lender" | "administrative_agent" | "other";
  commitmentAmount?: string; currencyCode?: string; completeness?: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_debt_facility_lenders", {
    id: input.id, debt_facility_id: input.debtFacilityId, lender_party_type: input.lenderPartyType,
    lender_party_id: input.lenderPartyId, lender_role: input.lenderRole,
    commitment_amount: input.commitmentAmount ?? null, currency_code: input.currencyCode?.toUpperCase() || null,
    ...interval(input), completeness: completeness(input.completeness), ...evidence(input.evidence),
  });
}

export interface OwnershipInterestInput extends PeValidInterval {
  id?: string; ownerType: "pe_fund" | "pe_vehicle" | "external_organization"; ownerId: string;
  subjectType: "external_organization" | "pe_security"; subjectId: string;
  economicPercentage?: string; votingPercentage?: string; amount?: string; currencyCode?: string;
  ownershipClass?: string; completeness?: PeCompletenessState; evidence: PeEvidenceRef;
}

function ownershipValues(input: OwnershipInterestInput): Record<string, unknown> {
  return {
    id: input.id, owner_type: input.ownerType, owner_id: input.ownerId, subject_type: input.subjectType, subject_id: input.subjectId,
    economic_percentage: input.economicPercentage ?? null, voting_percentage: input.votingPercentage ?? null,
    amount: input.amount ?? null, currency_code: input.currencyCode?.toUpperCase() || null,
    ownership_class: input.ownershipClass?.trim() || null, ...interval(input),
    completeness: completeness(input.completeness), ...evidence(input.evidence),
  };
}

export function recordOwnershipInterest(ctx: PeMutationContext, input: OwnershipInterestInput): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_ownership_interests", ownershipValues(input));
}

export async function reviseOwnershipInterest(ctx: PeMutationContext, input: {
  priorInterestId: string; expectedVersion: number; validFrom: Date;
  replacement: Omit<OwnershipInterestInput, "validFrom" | "id"> & { id?: string };
}): Promise<PeMutationResult> {
  validDate(input.validFrom, "validFrom");
  return peTransaction(ctx, async (_db, client) => {
    const prior = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_ownership_interests WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ctx.auth.tenantId, input.priorInterestId],
    )).rows[0];
    if (!prior) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "OwnershipInterest was not found in the authenticated tenant");
    if (Number(prior.version) !== input.expectedVersion || prior.superseded_at) throw new PeDomainError("PE_STALE_VERSION", "OwnershipInterest changed concurrently");
    if (input.validFrom <= new Date(String(prior.valid_from))) throw new PeDomainError("PE_INVALID_VALID_TIME", "Ownership revision must begin after the prior validFrom");
    const updated = await client.query(
      "UPDATE finnor_os.pe_ownership_interests SET valid_to=$3,superseded_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$4 AND superseded_at IS NULL",
      [ctx.auth.tenantId, input.priorInterestId, input.validFrom, input.expectedVersion],
    );
    if (updated.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "OwnershipInterest changed concurrently");
    return createTwin(client, ctx, "pe_ownership_interests", {
      ...ownershipValues({ ...input.replacement, id: input.replacement.id, validFrom: input.validFrom }),
      supersedes_interest_id: input.priorInterestId,
    });
  });
}

export function createBenchmark(ctx: PeMutationContext, input: {
  id?: string; benchmarkKey: string; name: string; metricKey: string; unit: string; currencyCode?: string; cohortDefinition?: Record<string, unknown>;
}): Promise<PeMutationResult> {
  for (const [value, label] of [[input.benchmarkKey, "benchmarkKey"], [input.name, "Benchmark name"], [input.metricKey, "metricKey"], [input.unit, "unit"]] as const) assertPeText(value, label);
  return createInTransaction(ctx, "pe_benchmarks", {
    id: input.id, benchmark_key: input.benchmarkKey.trim(), name: input.name.trim(), metric_key: input.metricKey.trim(), unit: input.unit.trim(),
    currency_code: input.currencyCode?.toUpperCase() || null, cohort_definition: input.cohortDefinition ?? {},
  });
}

export function createMetricSeries(ctx: PeMutationContext, input: {
  id?: string; subjectType: "external_organization" | "pe_portfolio_holding"; subjectId: string;
  metricKey: string; name: string; unit: string; currencyCode?: string;
  frequency: "instant" | "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "event"; benchmarkId?: string;
}): Promise<PeMutationResult> {
  for (const [value, label] of [[input.metricKey, "metricKey"], [input.name, "MetricSeries name"], [input.unit, "unit"]] as const) assertPeText(value, label);
  return createInTransaction(ctx, "pe_metric_series", {
    id: input.id, subject_type: input.subjectType, subject_id: input.subjectId, metric_key: input.metricKey.trim(), name: input.name.trim(), unit: input.unit.trim(),
    currency_code: input.currencyCode?.toUpperCase() || null, frequency: input.frequency, benchmark_id: input.benchmarkId ?? null,
  });
}

export interface MetricObservationInput {
  id?: string; metricSeriesId: string; periodStart: Date; periodEnd: Date;
  value: { type: "number"; value: string } | { type: "text"; value: string } | { type: "boolean"; value: boolean };
  evidence: PeEvidenceRef;
}

function metricValues(input: MetricObservationInput): Record<string, unknown> {
  const start = validDate(input.periodStart, "periodStart"); const end = validDate(input.periodEnd, "periodEnd");
  if (end < start) throw new PeDomainError("PE_INVALID_VALID_TIME", "periodEnd must be on or after periodStart");
  return {
    id: input.id, metric_series_id: input.metricSeriesId, period_start: start, period_end: end,
    value_type: input.value.type,
    value_numeric: input.value.type === "number" ? input.value.value : null,
    value_text: input.value.type === "text" ? input.value.value : null,
    value_boolean: input.value.type === "boolean" ? input.value.value : null,
    ...evidence(input.evidence),
  };
}

export function recordMetricObservation(ctx: PeMutationContext, input: MetricObservationInput): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_metric_observations", metricValues(input));
}

export async function restateMetricObservation(ctx: PeMutationContext, input: {
  priorObservationId: string; expectedVersion: number; replacement: Omit<MetricObservationInput, "metricSeriesId" | "periodStart" | "periodEnd"> & { id?: string };
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const prior = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_metric_observations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ctx.auth.tenantId, input.priorObservationId],
    )).rows[0];
    if (!prior) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "MetricObservation was not found in the authenticated tenant");
    if (Number(prior.version) !== input.expectedVersion || prior.superseded_at) throw new PeDomainError("PE_STALE_VERSION", "MetricObservation changed concurrently");
    const changed = await client.query(
      "UPDATE finnor_os.pe_metric_observations SET superseded_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$3 AND superseded_at IS NULL",
      [ctx.auth.tenantId, input.priorObservationId, input.expectedVersion],
    );
    if (changed.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "MetricObservation changed concurrently");
    return createTwin(client, ctx, "pe_metric_observations", {
      ...metricValues({
        ...input.replacement,
        metricSeriesId: String(prior.metric_series_id),
        periodStart: new Date(String(prior.period_start)),
        periodEnd: new Date(String(prior.period_end)),
      }),
      revision: Number(prior.revision) + 1,
      supersedes_observation_id: input.priorObservationId,
    });
  });
}

export function recordBenchmarkObservation(ctx: PeMutationContext, input: {
  id?: string; benchmarkId: string; periodStart: Date; periodEnd: Date; value: string; evidence: PeEvidenceRef;
}): Promise<PeMutationResult> {
  validDate(input.periodStart, "periodStart"); validDate(input.periodEnd, "periodEnd");
  if (input.periodEnd < input.periodStart) throw new PeDomainError("PE_INVALID_VALID_TIME", "periodEnd must be on or after periodStart");
  return createInTransaction(ctx, "pe_benchmark_observations", {
    id: input.id, benchmark_id: input.benchmarkId, period_start: input.periodStart, period_end: input.periodEnd,
    value: input.value, ...evidence(input.evidence),
  });
}

export async function restateBenchmarkObservation(ctx: PeMutationContext, input: {
  priorObservationId: string; expectedVersion: number; id?: string; value: string; evidence: PeEvidenceRef;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const prior = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_benchmark_observations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ctx.auth.tenantId, input.priorObservationId],
    )).rows[0];
    if (!prior) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "BenchmarkObservation was not found in the authenticated tenant");
    if (Number(prior.version) !== input.expectedVersion || prior.superseded_at) throw new PeDomainError("PE_STALE_VERSION", "BenchmarkObservation changed concurrently");
    const changed = await client.query(
      "UPDATE finnor_os.pe_benchmark_observations SET superseded_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$3 AND superseded_at IS NULL",
      [ctx.auth.tenantId, input.priorObservationId, input.expectedVersion],
    );
    if (changed.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "BenchmarkObservation changed concurrently");
    return createTwin(client, ctx, "pe_benchmark_observations", {
      id: input.id, benchmark_id: prior.benchmark_id, period_start: prior.period_start, period_end: prior.period_end,
      value: input.value, revision: Number(prior.revision) + 1, supersedes_observation_id: input.priorObservationId,
      ...evidence(input.evidence),
    });
  });
}

export function recordOutcome(ctx: PeMutationContext, input: {
  id?: string; subjectType: "external_organization" | "pe_portfolio_holding"; subjectId: string; decisionId?: string;
  outcomeType: string; description: string; observedValue?: Record<string, unknown>; observedAt: Date;
  evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  assertPeText(input.outcomeType, "outcomeType"); assertPeText(input.description, "Outcome description");
  validDate(input.observedAt, "observedAt");
  return createInTransaction({ ...ctx, provenance: { ...ctx.provenance, observedAt: input.observedAt } }, "pe_outcomes", {
    id: input.id, subject_type: input.subjectType, subject_id: input.subjectId, decision_id: input.decisionId ?? null,
    outcome_type: input.outcomeType.trim(), description: input.description.trim(), observed_value: input.observedValue ?? {},
    ...interval(input), ...evidence(input.evidence), observed_at: input.observedAt,
  });
}

export async function recordExit(ctx: PeMutationContext, input: {
  id?: string; portfolioHoldingId: string; expectedHoldingVersion: number;
  exitType: "strategic_sale" | "sponsor_sale" | "ipo" | "recapitalization" | "write_off" | "other";
  buyerCompanyId?: string; status: "announced" | "signed" | "closed" | "cancelled";
  announcedAt?: Date; signedAt?: Date; closedAt?: Date; cancelledAt?: Date;
  grossProceeds?: string; currencyCode?: string; observedAt: Date; evidence: PeEvidenceRef;
}): Promise<PeMutationResult> {
  validDate(input.observedAt, "observedAt");
  return peTransaction(ctx, async (_db, client) => {
    if (input.status === "closed") {
      if (!input.closedAt) throw new PeDomainError("PE_INVALID_INPUT", "A closed Exit requires closedAt");
      const holding = (await client.query<SqlRow>(
        "SELECT * FROM finnor_os.pe_portfolio_holdings WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [ctx.auth.tenantId, input.portfolioHoldingId],
      )).rows[0];
      if (!holding) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PortfolioHolding was not found in the authenticated tenant");
      if (Number(holding.version) !== input.expectedHoldingVersion || holding.holding_status === "exited") {
        throw new PeDomainError("PE_STALE_VERSION", "PortfolioHolding changed concurrently");
      }
      const updated = await client.query(
        "UPDATE finnor_os.pe_portfolio_holdings SET holding_status='exited',exit_date=$3::date,version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$4 AND holding_status<>'exited'",
        [ctx.auth.tenantId, input.portfolioHoldingId, input.closedAt, input.expectedHoldingVersion],
      );
      if (updated.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "PortfolioHolding changed concurrently");
    }
    return createTwin(client, { ...ctx, provenance: { ...ctx.provenance, observedAt: input.observedAt } }, "pe_exits", {
      id: input.id, portfolio_holding_id: input.portfolioHoldingId, exit_type: input.exitType,
      buyer_company_id: input.buyerCompanyId ?? null, status: input.status,
      announced_at: input.announcedAt ?? null, signed_at: input.signedAt ?? null,
      closed_at: input.closedAt ?? null, cancelled_at: input.cancelledAt ?? null,
      gross_proceeds: input.grossProceeds ?? null, currency_code: input.currencyCode?.toUpperCase() || null,
      ...evidence(input.evidence), observed_at: input.observedAt,
    });
  });
}

export function recordFactCoverage(ctx: PeMutationContext, input: {
  id?: string; subjectType: "external_organization" | "pe_fund" | "pe_vehicle" | "pe_portfolio_holding"; subjectId: string;
  proposition: "company_ownership" | "company_debt" | "company_parent" | "portfolio_membership" | "ownership_total";
  coverageStatus: PeCompletenessState; evidence: PeEvidenceRef;
} & PeValidInterval): Promise<PeMutationResult> {
  return createInTransaction(ctx, "pe_fact_coverage", {
    id: input.id, subject_type: input.subjectType, subject_id: input.subjectId, proposition: input.proposition,
    coverage_status: completeness(input.coverageStatus), ...interval(input), ...evidence(input.evidence),
  });
}

export async function reviseFactCoverage(ctx: PeMutationContext, input: {
  priorCoverageId: string; expectedVersion: number; coverageStatus: PeCompletenessState; evidence: PeEvidenceRef;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const prior = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_fact_coverage WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ctx.auth.tenantId, input.priorCoverageId],
    )).rows[0];
    if (!prior) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Coverage fact was not found in the authenticated tenant");
    if (Number(prior.version) !== input.expectedVersion || prior.superseded_at) {
      throw new PeDomainError("PE_STALE_VERSION", "Coverage fact changed concurrently");
    }
    const changed = await client.query(
      "UPDATE finnor_os.pe_fact_coverage SET superseded_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$3 AND superseded_at IS NULL",
      [ctx.auth.tenantId, input.priorCoverageId, input.expectedVersion],
    );
    if (changed.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "Coverage fact changed concurrently");
    return createTwin(client, ctx, "pe_fact_coverage", {
      subject_type: prior.subject_type, subject_id: prior.subject_id, proposition: prior.proposition,
      coverage_status: completeness(input.coverageStatus), valid_from: prior.valid_from, valid_to: prior.valid_to,
      revision: Number(prior.revision) + 1, supersedes_coverage_id: input.priorCoverageId,
      ...evidence(input.evidence),
    });
  });
}

export async function closedWorldClaimPermitted(ctx: PeMutationContext, input: {
  subjectType: "external_organization" | "pe_fund" | "pe_vehicle" | "pe_portfolio_holding";
  subjectId: string; proposition: "company_ownership" | "company_debt" | "company_parent" | "portfolio_membership" | "ownership_total";
  validAt: Date; knowledgeAt?: Date;
}): Promise<{ permitted: boolean; coverage: Record<string, unknown> | null; reason: string }> {
  const validAt = validDate(input.validAt, "validAt");
  const knowledgeAt = input.knowledgeAt ? validDate(input.knowledgeAt, "knowledgeAt") : new Date();
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<SqlRow>(
      `SELECT snapshot FROM finnor_os.canonical_entity_versions h
       WHERE tenant_id=$1 AND entity_type='pe_fact_coverage' AND recorded_at<=$2::timestamptz
         AND snapshot->>'subject_type'=$3 AND snapshot->>'subject_id'=$4
         AND snapshot->>'proposition'=$5 AND snapshot->>'coverage_status'='complete'
         AND (snapshot->>'valid_from')::timestamptz<=$6
         AND ((snapshot->>'valid_to') IS NULL OR (snapshot->>'valid_to')::timestamptz>$6)
         AND coalesce((snapshot->>'revision')::int,1)=(
           SELECT max(coalesce((v.snapshot->>'revision')::int,1))
             FROM finnor_os.canonical_entity_versions v
            WHERE v.tenant_id=$1 AND v.entity_type='pe_fact_coverage' AND v.recorded_at<=$2::timestamptz
              AND v.snapshot->>'subject_type'=$3 AND v.snapshot->>'subject_id'=$4
              AND v.snapshot->>'proposition'=$5
              AND (v.snapshot->>'valid_from')::timestamptz<=$6
              AND ((v.snapshot->>'valid_to') IS NULL OR (v.snapshot->>'valid_to')::timestamptz>$6))
       ORDER BY recorded_at DESC,entity_version DESC LIMIT 1`,
      [ctx.auth.tenantId, knowledgeAt, input.subjectType, input.subjectId, input.proposition, validAt],
    );
    const coverage = result.rows[0]?.snapshot as Record<string, unknown> | undefined;
    return coverage
      ? { permitted: true, coverage: shapePeRow(coverage), reason: "Exact complete coverage exists for the subject, proposition, valid time, and knowledge time" }
      : { permitted: false, coverage: null, reason: "UNKNOWN_OR_PARTIAL: no exact complete coverage fact permits this closed-world claim" };
  }, { readOnly: true });
}

function canonicalRefs(value: CanonicalRef[], label: string): CanonicalRef[] {
  if (!value.length) throw new PeDomainError("PE_INVALID_INPUT", `${label} must contain at least one canonical reference`);
  return value.map((ref) => {
    assertPeText(ref.entityType, `${label}.entityType`); assertPeUuid(ref.entityId, `${label}.entityId`);
    return { entityType: ref.entityType, entityId: ref.entityId };
  });
}

export async function recordIdentityResolution(ctx: PeMutationContext, input: {
  decisionId: string; sourceLinkId: string; expectedObservedHash: string | null;
  kind: "merge" | "split" | "correction"; fromRefs: CanonicalRef[]; toRefs: CanonicalRef[];
  decision: string; validFrom?: Date; validTo?: Date; authority: Record<string, unknown>;
  evidence: PeEvidenceRef; observedAt?: Date;
}): Promise<{ observation: Record<string, unknown>; sourceLink: Record<string, unknown> }> {
  assertPeText(input.decisionId, "decisionId"); assertPeText(input.decision, "Identity resolution decision");
  const fromRefs = canonicalRefs(input.fromRefs, "fromRefs"); const toRefs = canonicalRefs(input.toRefs, "toRefs");
  if (input.validFrom) validDate(input.validFrom, "validFrom"); if (input.validTo) validDate(input.validTo, "validTo");
  if (input.validFrom && input.validTo && input.validTo <= input.validFrom) throw new PeDomainError("PE_INVALID_VALID_TIME", "validTo must be after validFrom");
  const payload = { decisionId: input.decisionId, kind: input.kind, fromRefs, toRefs, decision: input.decision, validFrom: input.validFrom?.toISOString() ?? null, validTo: input.validTo?.toISOString() ?? null, authority: input.authority };
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return peTransaction(ctx, async (_db, client) => {
    const link = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.external_refs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ctx.auth.tenantId, input.sourceLinkId],
    )).rows[0];
    if (!link) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Source Truth ExternalRef was not found in the authenticated tenant");
    const observedHash = link.observed_hash === null ? null : String(link.observed_hash);
    if (observedHash !== input.expectedObservedHash) throw new PeDomainError("PE_STALE_VERSION", "ExternalRef changed since the identity decision was prepared");
    const target = toRefs.length === 1 ? toRefs[0]! : null;
    const now = input.observedAt ?? new Date();
    const priorObservation = (await client.query<SqlRow>(
      `SELECT source_scope_id,resource_kind,provider_parent_refs,provider_metadata
         FROM finnor_os.external_ref_observations
        WHERE tenant_id=$1 AND source_link_id=$2 ORDER BY received_at DESC,id DESC LIMIT 1`,
      [ctx.auth.tenantId, input.sourceLinkId],
    )).rows[0];
    if (link.provider === "microsoft_graph" && (!priorObservation?.source_scope_id || !priorObservation.resource_kind)) {
      throw new PeDomainError("PE_IDENTITY_SOURCE_LINEAGE_MISSING", "Microsoft Graph identity resolution requires an existing scoped Source Truth observation");
    }
    const observationKey = createHash("sha256").update(`${ctx.auth.tenantId}:${link.id}:${input.decisionId}:${hash}`).digest("hex");
    const observation = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.external_ref_observations(
         tenant_id,integration_id,source_scope_id,source_link_id,provider,resource_kind,external_object_type,external_id,
         canonical_entity_type,canonical_entity_id,observed_at,retrieved_at,observation_key,
         observed_hash,observed_state,provider_parent_refs,provider_metadata,ingestion_mode,trace_id,
         materialization_status,mapping_status,conflict_state,
         evidence_source_id,evidence_version_id,provenance,
         resolution_kind,resolution_from_refs,resolution_to_refs,resolution_decision,
         resolution_valid_from,resolution_valid_to,resolution_evidence_source_id,
         resolution_evidence_version_id,resolution_authority
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,'exact_read',$17,
         $18,$19,$20,$21,$22,$23::jsonb,$24,$25::jsonb,$26::jsonb,$27,$28,$29,$21,$22,$30::jsonb) RETURNING *`,
      [ctx.auth.tenantId, link.integration_id, priorObservation?.source_scope_id ?? null, link.id, link.provider,
        priorObservation?.resource_kind ?? "identity_resolution", link.external_object_type, link.external_id,
        target?.entityType ?? null, target?.entityId ?? null, now, observationKey, hash, JSON.stringify(payload),
        JSON.stringify(priorObservation?.provider_parent_refs ?? []), JSON.stringify(priorObservation?.provider_metadata ?? {}),
        `identity-resolution:${input.decisionId}`, target ? "mapped" : "ambiguous", target ? "mapped" : "ambiguous", target ? "none" : "ambiguous",
        input.evidence.evidenceSourceId, input.evidence.evidenceVersionId,
        JSON.stringify({ identityResolution: true, decisionId: input.decisionId, authority: input.authority }),
        input.kind, JSON.stringify(fromRefs), JSON.stringify(toRefs), input.decision,
        input.validFrom ?? null, input.validTo ?? null, JSON.stringify(input.authority)],
    )).rows[0]!;
    const updated = (await client.query<SqlRow>(
      `UPDATE finnor_os.external_refs SET entity=$3,internal_id=$4,mapping_status=$5,
         candidate_canonical_ids=$6::uuid[],conflict_state=$7,observed_hash=$8,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [ctx.auth.tenantId, input.sourceLinkId, target?.entityType ?? String(link.entity), target?.entityId ?? null,
        target ? "mapped" : "ambiguous", target ? [] : toRefs.map((ref) => ref.entityId), target ? "none" : "ambiguous", hash],
    )).rows[0]!;
    return { observation: shapePeRow(observation), sourceLink: shapePeRow(updated) };
  });
}

export async function resolveIdentityAsKnown(ctx: PeMutationContext, input: {
  sourceLinkId: string; validAt: Date; knowledgeAt: Date;
}): Promise<Record<string, unknown> | null> {
  validDate(input.validAt, "validAt"); validDate(input.knowledgeAt, "knowledgeAt");
  return peTransaction(ctx, async (_db, client) => {
    const row = (await client.query<SqlRow>(
      `SELECT * FROM finnor_os.external_ref_observations
        WHERE tenant_id=$1 AND source_link_id=$2 AND resolution_kind IS NOT NULL
          AND received_at<=$3::timestamptz
          AND (resolution_valid_from IS NULL OR resolution_valid_from<=$4)
          AND (resolution_valid_to IS NULL OR resolution_valid_to>$4)
        ORDER BY received_at DESC,id DESC LIMIT 1`,
      [ctx.auth.tenantId, input.sourceLinkId, input.knowledgeAt, input.validAt],
    )).rows[0];
    return row ? shapePeRow(row) : null;
  }, { readOnly: true });
}
