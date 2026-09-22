import {
  buildPrivateEquityWorldEpistemicSnapshot,
  type PrivateEquityAssertion,
} from "./epistemic";
import {
  peTransaction,
  shapePeRow,
  assertPeUuid,
  type PeClient,
  type SqlRow,
} from "./repository";
import {
  privateEquityAssertionsFromRows,
  type PrivateEquityAssertionSourceRow,
} from "./source-mapping";
import { isMilestoneLate, isRequestOverdue } from "./state-machines";
import {
  PE_ENTITY_TYPES,
  PE_WORLD_ROOT_TYPES,
  PeDomainError,
  type PeEntityType,
  type PeMutationContext,
  type PeWorldRootRef,
  type PeWorldState,
  type TemporalCompletenessStatus,
} from "./types";

const MAX_WORLD_ROWS = 1_000;
const MAX_WORLD_CANDIDATES = 5_000;
const ROOT_TYPES = new Set<PeWorldRootRef["entityType"]>(PE_WORLD_ROOT_TYPES);
const INSTITUTIONAL_TYPES = [
  "pe_fund", "pe_vehicle", "pe_fund_vehicle_link", "pe_strategy_mandate",
  "pe_portfolio_holding", "pe_company_hierarchy", "pe_company_party_role",
  "pe_security", "pe_debt_facility", "pe_debt_facility_lender",
  "pe_ownership_interest", "pe_benchmark", "pe_metric_series",
  "pe_metric_observation", "pe_benchmark_observation", "pe_outcome", "pe_exit",
  "pe_fact_coverage", "external_organization", "external_contact",
] as const;
const DEAL_CHILD_TYPES: PeEntityType[] = [
  "pe_investment_case", "pe_thesis", "pe_assumption", "pe_decision",
  "pe_deal_party", "pe_workstream", "pe_request", "pe_deliverable", "pe_finding",
  "pe_deal_risk", "pe_finding_risk_link", "pe_dependency", "pe_milestone",
  "pe_closing_condition", "pe_closing_item",
];

interface HistoryRow {
  entity_type: string;
  entity_id: string;
  entity_version: number;
  snapshot: Record<string, unknown>;
  snapshot_hash: string;
  recorded_at: Date;
  origin: "mutation" | "baseline";
  hash_valid: boolean;
}

interface CoverageRow {
  entity_type: PeEntityType;
  coverage_started_at: Date;
}

interface ProviderEvidenceRow {
  observation_id: string;
  integration_id: string;
  source_scope_id: string;
  provider: string;
  resource_kind: string;
  external_object_type: string;
  external_id: string;
  source_version: string | null;
  source_sequence: string | null;
  observed_at: Date;
  retrieved_at: Date;
  received_at: Date;
  ingestion_mode: string;
  trace_id: string;
  evidence_source_id: string;
  evidence_version_id: string;
  materialization_status: string;
  mapping_status: string | null;
  conflict_state: string | null;
  provider_deleted: boolean;
  canonical_entity_type: string | null;
  canonical_entity_id: string | null;
}

interface ProviderCoverageRow {
  coverage_history_id: string | null;
  source_scope_id: string;
  integration_id: string;
  source_kind: string;
  scope_key: string;
  current_descriptor_safe: boolean;
  current_provider_scope_type: string;
  current_provider_resource_id: string;
  current_provider_parent_id: string | null;
  current_enabled: boolean;
  current_root_binding_type: string | null;
  current_root_binding_id: string | null;
  current_sync_strategy: string;
  current_recovery_strength: string;
  current_permission_mode: string;
  current_required_permissions: string[];
  current_effective_permissions: string[];
  current_provider_restriction_method: string | null;
  current_permission_verified_at: Date | null;
  current_coverage_policy: Record<string, unknown>;
  current_freshness_policy: Record<string, unknown>;
  current_configuration: Record<string, unknown>;
  current_freshness_state: string;
  current_last_successful_sync_at: Date | null;
  current_last_observed_at: Date | null;
  current_configured_at: Date;
  current_disabled_at: Date | null;
  coverage_revision: number | null;
  coverage_recorded_at: Date | null;
  coverage_effective_from: Date | null;
  coverage_effective_to: Date | null;
  coverage_region: Record<string, unknown> | null;
  coverage_state: string | null;
  coverage_reason: string | null;
  baseline_started_at: Date | null;
  baseline_completed_at: Date | null;
  earliest_provider_at: Date | null;
  latest_provider_at: Date | null;
  unresolved_observations: number | null;
  ambiguous_observations: number | null;
  source_descriptor: Record<string, unknown> | null;
}

interface ProviderWorldContext {
  observedEvidence: Record<string, unknown>[];
  sourceCoverage: Record<string, unknown>[];
  sourceCoverageWarnings: Record<string, unknown>[];
  unresolvedProviderObservations: number;
  ambiguousProviderObservations: number;
  providerFreshnessWarnings: Record<string, unknown>[];
  providerEvidenceCompleteness: PeWorldState["providerEvidenceCompleteness"];
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function historyKey(row: Pick<HistoryRow, "entity_type" | "entity_id">): string {
  return `${row.entity_type}:${row.entity_id}`;
}

function addHistory(target: Map<string, HistoryRow>, rows: HistoryRow[]): void {
  for (const row of rows) {
    if (!row.hash_valid) {
      throw new PeDomainError("PE_HISTORY_HASH_MISMATCH", "Canonical temporal snapshot hash verification failed", {
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityVersion: row.entity_version,
      });
    }
    target.set(historyKey(row), row);
  }
}

async function latestExact(
  client: PeClient,
  tenantId: string,
  at: Date,
  entityTypes: readonly string[],
  entityIds: string[],
): Promise<HistoryRow[]> {
  if (entityTypes.length === 0 || entityIds.length === 0) return [];
  const result = await client.query<HistoryRow>(
    `SELECT DISTINCT ON (entity_type,entity_id)
       entity_type,entity_id::text,entity_version,snapshot,snapshot_hash,recorded_at,origin,
       snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') AS hash_valid
       FROM finnor_os.canonical_entity_versions
      WHERE tenant_id=$1 AND recorded_at<=$2
        AND entity_type=ANY($3::text[]) AND entity_id=ANY($4::uuid[])
      ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC
      LIMIT $5`,
    [tenantId, at, entityTypes, entityIds, MAX_WORLD_ROWS + 1],
  );
  return result.rows;
}

async function latestBySnapshotField(
  client: PeClient,
  tenantId: string,
  at: Date,
  entityTypes: PeEntityType[],
  field: "strategy_id" | "opportunity_id" | "deal_id",
  values: string[],
): Promise<HistoryRow[]> {
  if (entityTypes.length === 0 || values.length === 0) return [];
  const result = await client.query<HistoryRow>(
    `SELECT DISTINCT ON (entity_type,entity_id)
       entity_type,entity_id::text,entity_version,snapshot,snapshot_hash,recorded_at,origin,
       snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') AS hash_valid
       FROM finnor_os.canonical_entity_versions
      WHERE tenant_id=$1 AND recorded_at<=$2 AND entity_type=ANY($3::text[])
        AND snapshot->>$4=ANY($5::text[])
      ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC
      LIMIT $6`,
    [tenantId, at, entityTypes, field, values, MAX_WORLD_ROWS + 1],
  );
  return result.rows;
}

async function latestLinks(
  client: PeClient,
  tenantId: string,
  at: Date,
  root: PeWorldRootRef,
  dealIds: string[],
): Promise<HistoryRow[]> {
  const result = await client.query<HistoryRow>(
    `SELECT DISTINCT ON (entity_type,entity_id)
       entity_type,entity_id::text,entity_version,snapshot,snapshot_hash,recorded_at,origin,
       snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') AS hash_valid
       FROM finnor_os.canonical_entity_versions
      WHERE tenant_id=$1 AND recorded_at<=$2
        AND entity_type IN ('pe_document_link','pe_evidence_link')
        AND (
          (snapshot->>'world_root_type'=$3 AND snapshot->>'world_root_id'=$4)
          OR (cardinality($5::text[])>0 AND snapshot->>'deal_id'=ANY($5::text[]))
        )
      ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC
      LIMIT $6`,
    [tenantId, at, root.entityType, root.entityId, dealIds, MAX_WORLD_ROWS + 1],
  );
  return result.rows;
}

function shaped(row: HistoryRow): Record<string, unknown> {
  return shapePeRow(row.snapshot);
}

function arrayFor(history: Map<string, HistoryRow>, type: string): Record<string, unknown>[] {
  return [...history.values()].filter((row) => row.entity_type === type)
    .sort((left, right) => `${left.recorded_at.toISOString()}:${left.entity_id}`.localeCompare(`${right.recorded_at.toISOString()}:${right.entity_id}`))
    .map(shaped);
}

function emptyWorld(
  root: PeWorldRootRef,
  validAt: string,
  knowledgeAt: string,
  completeness: PeWorldState["temporalCompleteness"],
): PeWorldState {
  return {
    root, stateAt: knowledgeAt, validAt, knowledgeAt, temporalCompleteness: completeness,
    strategy: null, opportunity: null, deal: null, opportunities: [], deals: [],
    investmentCases: [], theses: [], assumptions: [], decisions: [], decisionEffectLinks: [],
    funds: [], vehicles: [], fundVehicleLinks: [], strategyMandates: [], portfolioHoldings: [],
    companies: [], people: [], companyHierarchyRelationships: [], companyPartyRoles: [],
    securities: [], debtFacilities: [], debtFacilityLenders: [], ownershipInterests: [],
    metricSeries: [], metricObservations: [], benchmarks: [], benchmarkObservations: [],
    claims: [], outcomes: [], exits: [], factCoverage: [],
    dealParties: [], workstreams: [], requests: [], deliverables: [], findings: [], dealRisks: [],
    findingRiskLinks: [], dependencies: [], milestones: [], closingConditions: [], closingItems: [],
    documents: [], evidence: [], observedEvidence: [], sourceCoverage: [], sourceCoverageWarnings: [],
    unresolvedProviderObservations: 0, ambiguousProviderObservations: 0, providerFreshnessWarnings: [],
    providerEvidenceCompleteness: {
      status: "not_configured",
      absenceClaimsPermitted: false,
      reasons: ["No provider source coverage existed in this world at stateAt"],
    },
    documentLinks: [], evidenceLinks: [], workLinks: [], taskLinks: [],
    businessEvents: [], authorityDecisions: [], approvalRequests: [], decisionReceipts: [], conflicts: [],
    epistemicWarnings: completeness.status === "unavailable_before_baseline" ? [{
      propositionId: `pe:v1:${root.entityType}:${root.entityId}:history`,
      predicate: "history.available",
      status: "UNKNOWN",
      reason: "HISTORY_UNAVAILABLE_BEFORE_BASELINE",
      evidenceRefs: [],
    }] : [],
    provenance: [],
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function descriptorString(descriptor: Record<string, unknown>, key: string): string | null {
  const value = descriptor[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function descriptorDate(descriptor: Record<string, unknown>, key: string): string | null {
  const value = descriptorString(descriptor, key);
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function providerFreshness(
  sourceScopeId: string,
  sourceKind: string,
  descriptor: Record<string, unknown>,
  clock: Date,
): { projection: Record<string, unknown>; warning: Record<string, unknown> | null } {
  const policy = object(descriptor.freshnessPolicy);
  const maximumAgeSeconds = typeof policy.maxAgeSeconds === "number" && Number.isFinite(policy.maxAgeSeconds)
    ? Math.max(0, policy.maxAgeSeconds)
    : null;
  const lastSuccessfulSyncAt = descriptorDate(descriptor, "lastSuccessfulSyncAt");
  const lastObservedAt = descriptorDate(descriptor, "lastObservedAt");
  const ageMs = lastSuccessfulSyncAt ? Math.max(0, clock.getTime() - Date.parse(lastSuccessfulSyncAt)) : null;
  let state = descriptorString(descriptor, "freshnessState") ?? "unknown";
  if (maximumAgeSeconds !== null && ageMs !== null) {
    if (ageMs > maximumAgeSeconds * 3_000) state = "expired";
    else if (ageMs > maximumAgeSeconds * 1_000) state = "stale";
    else state = "fresh";
  }
  const projection = { state, policy, lastSuccessfulSyncAt, lastObservedAt, ageMs };
  if (state === "fresh") return { projection, warning: null };
  return {
    projection,
    warning: {
      sourceScopeId,
      sourceKind,
      state,
      lastSuccessfulSyncAt,
      asOf: clock.toISOString(),
      reason: state === "unknown"
        ? "No historically valid successful-sync timestamp establishes provider freshness"
        : `Provider source freshness was ${state} at stateAt`,
    },
  };
}

async function loadProviderWorldContext(
  client: PeClient,
  tenantId: string,
  clock: Date,
  rootRefs: Array<{ entityType: string; entityId: string }>,
  evidenceVersionIds: string[],
  evidenceSourceIds: string[],
): Promise<ProviderWorldContext> {
  const observations = evidenceVersionIds.length ? await client.query<ProviderEvidenceRow>(
    `SELECT id::text observation_id,integration_id::text,source_scope_id::text,provider,resource_kind,
            external_object_type,external_id,source_version,source_sequence::text,observed_at,retrieved_at,
            received_at,ingestion_mode,trace_id,evidence_source_id::text,evidence_version_id::text,
            materialization_status,mapping_status,conflict_state,provider_deleted,
            canonical_entity_type,canonical_entity_id::text
       FROM finnor_os.external_ref_observations
      WHERE tenant_id=$1 AND evidence_version_id=ANY($2::uuid[])
        AND retrieved_at<=$3 AND received_at<=$3
      ORDER BY retrieved_at,id LIMIT $4`,
    [tenantId, evidenceVersionIds, clock, MAX_WORLD_ROWS + 1],
  ) : { rows: [] as ProviderEvidenceRow[] };
  const observedEvidence = observations.rows.slice(0, MAX_WORLD_ROWS).map((row) => ({
    observationId: row.observation_id,
    integrationId: row.integration_id,
    sourceScopeId: row.source_scope_id,
    provider: row.provider,
    resourceKind: row.resource_kind,
    externalObjectType: row.external_object_type,
    externalObjectId: row.external_id,
    providerVersion: row.source_version,
    providerSequence: row.source_sequence,
    observedAt: row.observed_at.toISOString(),
    retrievedAt: row.retrieved_at.toISOString(),
    recordedAt: row.received_at.toISOString(),
    ingestionMode: row.ingestion_mode,
    evidenceSourceId: row.evidence_source_id,
    evidenceVersionId: row.evidence_version_id,
    materializationStatus: row.materialization_status,
    mappingStatusAtObservation: row.mapping_status,
    conflictState: row.conflict_state,
    canonicalEntityType: row.canonical_entity_type,
    canonicalEntityId: row.canonical_entity_id,
    deleted: row.provider_deleted,
    traceId: row.trace_id,
    contentTreatment: "untrusted_evidence",
    instructionEligible: false,
  }));

  const coverage = rootRefs.length ? await client.query<ProviderCoverageRow>(
    `WITH roots AS (
       SELECT entity_type,entity_id
         FROM jsonb_to_recordset($3::jsonb) AS root(entity_type text,entity_id text)
     ), linked_scopes AS (
       SELECT DISTINCT source_scope_id
         FROM finnor_os.external_ref_observations
        WHERE tenant_id=$1 AND evidence_source_id=ANY($4::uuid[])
          AND retrieved_at<=$2 AND received_at<=$2
     ), latest_coverage AS (
       SELECT DISTINCT ON (source_scope_id) *
         FROM finnor_os.integration_source_coverage_history
        WHERE tenant_id=$1 AND effective_from<=$2 AND recorded_at<=$2
          AND (effective_to IS NULL OR effective_to>$2)
        ORDER BY source_scope_id,effective_from DESC,recorded_at DESC,coverage_revision DESC
     )
     SELECT c.id::text coverage_history_id,s.id::text source_scope_id,s.integration_id::text,s.source_kind,s.scope_key,
            (s.updated_at<=$2) current_descriptor_safe,
            s.provider_scope_type current_provider_scope_type,s.provider_resource_id current_provider_resource_id,
            s.provider_parent_id current_provider_parent_id,s.enabled current_enabled,
            s.root_binding_type current_root_binding_type,s.root_binding_id::text current_root_binding_id,
            s.sync_strategy current_sync_strategy,s.recovery_strategy current_recovery_strength,
            s.permission_mode current_permission_mode,s.required_permissions current_required_permissions,
            s.effective_permissions current_effective_permissions,
            s.provider_restriction_method current_provider_restriction_method,
            s.permission_verified_at current_permission_verified_at,s.coverage_policy current_coverage_policy,
            s.freshness_policy current_freshness_policy,s.configuration current_configuration,
            s.freshness_state current_freshness_state,s.last_successful_sync_at current_last_successful_sync_at,
            s.last_observed_at current_last_observed_at,s.configured_at current_configured_at,
            s.disabled_at current_disabled_at,c.coverage_revision,c.recorded_at coverage_recorded_at,
            c.effective_from coverage_effective_from,c.effective_to coverage_effective_to,
            c.coverage_region,c.state coverage_state,c.reason coverage_reason,c.baseline_started_at,
            c.baseline_completed_at,c.earliest_provider_at,c.latest_provider_at,
            c.unresolved_observations,c.ambiguous_observations,c.source_descriptor
       FROM finnor_os.integration_source_scopes s
       LEFT JOIN latest_coverage c ON c.source_scope_id=s.id
      WHERE s.tenant_id=$1 AND s.provider='microsoft_graph'
        AND (c.id IS NOT NULL OR (s.configured_at<=$2 AND s.updated_at<=$2))
        AND (
          s.id IN (SELECT source_scope_id FROM linked_scopes)
          OR EXISTS (
            SELECT 1 FROM roots
             WHERE roots.entity_type=coalesce(nullif(c.source_descriptor->>'rootBindingType',''),
                                               CASE WHEN s.updated_at<=$2 THEN s.root_binding_type END)
               AND roots.entity_id=coalesce(nullif(c.source_descriptor->>'rootBindingId',''),
                                             CASE WHEN s.updated_at<=$2 THEN s.root_binding_id::text END)
          )
        )
      ORDER BY s.id LIMIT $5`,
    [
      tenantId,
      clock,
      JSON.stringify(rootRefs.map((root) => ({
        entity_type: root.entityType,
        entity_id: root.entityId,
      }))),
      evidenceSourceIds,
      MAX_WORLD_ROWS + 1,
    ],
  ) : { rows: [] as ProviderCoverageRow[] };

  const sourceCoverage: Record<string, unknown>[] = [];
  const sourceCoverageWarnings: Record<string, unknown>[] = [];
  const providerFreshnessWarnings: Record<string, unknown>[] = [];
  for (const row of coverage.rows.slice(0, MAX_WORLD_ROWS)) {
    const persisted = object(row.source_descriptor);
    const descriptor = Object.keys(persisted).length > 0 ? persisted : row.current_descriptor_safe ? {
      schema: "finnor.source-coverage-descriptor.fallback-current.v1",
      integrationId: row.integration_id,
      provider: "microsoft_graph",
      sourceKind: row.source_kind,
      providerScopeType: row.current_provider_scope_type,
      providerResourceId: row.current_provider_resource_id,
      providerParentId: row.current_provider_parent_id,
      scopeKey: row.scope_key,
      enabled: row.current_enabled,
      rootBindingType: row.current_root_binding_type,
      rootBindingId: row.current_root_binding_id,
      syncStrategy: row.current_sync_strategy,
      recoveryStrength: row.current_recovery_strength,
      permissionMode: row.current_permission_mode,
      requiredPermissions: row.current_required_permissions,
      effectivePermissions: row.current_effective_permissions,
      providerRestrictionMethod: row.current_provider_restriction_method,
      permissionVerifiedAt: row.current_permission_verified_at?.toISOString() ?? null,
      coveragePolicy: row.current_coverage_policy,
      freshnessPolicy: row.current_freshness_policy,
      configuration: row.current_configuration,
      freshnessState: row.current_freshness_state,
      lastSuccessfulSyncAt: row.current_last_successful_sync_at?.toISOString() ?? null,
      lastObservedAt: row.current_last_observed_at?.toISOString() ?? null,
      configuredAt: row.current_configured_at.toISOString(),
      disabledAt: row.current_disabled_at?.toISOString() ?? null,
    } : {};
    const state = row.coverage_state ?? "NOT_CONFIGURED";
    const recoveryStrength = descriptorString(descriptor, "recoveryStrength") ?? row.current_recovery_strength;
    const unresolved = Number(row.unresolved_observations ?? 0);
    const ambiguous = Number(row.ambiguous_observations ?? 0);
    const absenceClaimsPermitted = state === "COMPLETE"
      && recoveryStrength === "EXACT_DELTA"
      && row.baseline_completed_at !== null
      && unresolved === 0
      && ambiguous === 0;
    const freshness = providerFreshness(row.source_scope_id, row.source_kind, descriptor, clock);
    if (freshness.warning) providerFreshnessWarnings.push(freshness.warning);
    const item = {
      coverageHistoryId: row.coverage_history_id,
      sourceScopeId: row.source_scope_id,
      integrationId: row.integration_id,
      provider: "microsoft_graph",
      sourceKind: row.source_kind,
      scopeKey: descriptorString(descriptor, "scopeKey") ?? row.scope_key,
      providerScopeType: descriptorString(descriptor, "providerScopeType"),
      providerResourceId: descriptorString(descriptor, "providerResourceId"),
      providerParentId: descriptorString(descriptor, "providerParentId"),
      rootBinding: descriptorString(descriptor, "rootBindingType") && descriptorString(descriptor, "rootBindingId") ? {
        type: descriptorString(descriptor, "rootBindingType"),
        id: descriptorString(descriptor, "rootBindingId"),
      } : null,
      configuredAt: descriptorDate(descriptor, "configuredAt"),
      disabledAt: descriptorDate(descriptor, "disabledAt"),
      permission: {
        mode: descriptorString(descriptor, "permissionMode"),
        required: stringArray(descriptor.requiredPermissions),
        effective: stringArray(descriptor.effectivePermissions),
        providerRestrictionMethod: descriptorString(descriptor, "providerRestrictionMethod"),
        verifiedAt: descriptorDate(descriptor, "permissionVerifiedAt"),
      },
      freshness: freshness.projection,
      coverage: {
        revision: row.coverage_revision,
        state,
        recoveryStrength,
        region: row.coverage_region ?? {},
        reason: row.coverage_reason ?? (state === "NOT_CONFIGURED" ? "No source coverage fact existed at stateAt" : null),
        recordedAt: row.coverage_recorded_at?.toISOString() ?? null,
        effectiveFrom: row.coverage_effective_from?.toISOString() ?? null,
        effectiveTo: row.coverage_effective_to?.toISOString() ?? null,
        baselineStartedAt: row.baseline_started_at?.toISOString() ?? null,
        baselineCompletedAt: row.baseline_completed_at?.toISOString() ?? null,
        earliestProviderAt: row.earliest_provider_at?.toISOString() ?? null,
        latestProviderAt: row.latest_provider_at?.toISOString() ?? null,
        unresolvedObservations: unresolved,
        ambiguousObservations: ambiguous,
        absenceClaimsPermitted,
      },
      descriptorAvailable: Object.keys(descriptor).length > 0,
      asOf: clock.toISOString(),
    };
    sourceCoverage.push(item);
    if (state !== "COMPLETE" || unresolved > 0 || ambiguous > 0 || !absenceClaimsPermitted) {
      sourceCoverageWarnings.push({
        sourceScopeId: row.source_scope_id,
        sourceKind: row.source_kind,
        state,
        unresolvedObservations: unresolved,
        ambiguousObservations: ambiguous,
        absenceClaimsPermitted,
        reason: state !== "COMPLETE"
          ? row.coverage_reason ?? `Source coverage was ${state} at stateAt`
          : recoveryStrength !== "EXACT_DELTA"
            ? "This source recovery strength cannot prove absence"
            : unresolved > 0 || ambiguous > 0
              ? "Unresolved or ambiguous provider observations prevent complete root evidence"
              : "A terminal baseline was not proven at stateAt",
      });
    }
  }
  const unresolvedProviderObservations = coverage.rows.reduce((sum, row) => sum + Number(row.unresolved_observations ?? 0), 0);
  const ambiguousProviderObservations = coverage.rows.reduce((sum, row) => sum + Number(row.ambiguous_observations ?? 0), 0);
  const reasons = sourceCoverage.length === 0
    ? ["No provider source coverage existed in this world at stateAt"]
    : sourceCoverageWarnings.map((warning) => String(warning.reason));
  const absenceClaimsPermitted = sourceCoverage.length > 0
    && sourceCoverage.every((source) => object(source.coverage).absenceClaimsPermitted === true);
  return {
    observedEvidence,
    sourceCoverage,
    sourceCoverageWarnings,
    unresolvedProviderObservations,
    ambiguousProviderObservations,
    providerFreshnessWarnings,
    providerEvidenceCompleteness: {
      status: sourceCoverage.length === 0 ? "not_configured" : sourceCoverageWarnings.length === 0 ? "complete" : "partial",
      absenceClaimsPermitted,
      reasons: [...new Set(reasons)],
    },
  };
}

function collectUuid(rows: Array<Record<string, unknown>>, field: string): string[] {
  return [...new Set(rows.map((row) => row[field]).filter((value): value is string => typeof value === "string"))];
}

async function latestTenantHistory(
  client: PeClient,
  tenantId: string,
  knowledgeAt: Date,
): Promise<HistoryRow[]> {
  const types = [...new Set<string>([...PE_ENTITY_TYPES, ...INSTITUTIONAL_TYPES])];
  const result = await client.query<HistoryRow>(
    `SELECT entity_type,entity_id::text,entity_version,snapshot,snapshot_hash,recorded_at,origin,
       snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') AS hash_valid
       FROM finnor_os.canonical_entity_versions
      WHERE tenant_id=$1 AND recorded_at<=$2 AND entity_type=ANY($3::text[])
        AND (entity_type IN ('pe_metric_observation','pe_benchmark_observation','pe_fact_coverage') OR recorded_at=(
          SELECT max(v.recorded_at) FROM finnor_os.canonical_entity_versions v
           WHERE v.tenant_id=canonical_entity_versions.tenant_id
             AND v.entity_type=canonical_entity_versions.entity_type
             AND v.entity_id=canonical_entity_versions.entity_id
             AND v.recorded_at<=$2))
      ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC
      LIMIT $4`,
    [tenantId, knowledgeAt, types, MAX_WORLD_CANDIDATES + 1],
  );
  for (const row of result.rows) {
    if (!row.hash_valid) {
      throw new PeDomainError("PE_HISTORY_HASH_MISMATCH", "Canonical temporal snapshot hash verification failed", {
        entityType: row.entity_type, entityId: row.entity_id, entityVersion: row.entity_version,
      });
    }
  }
  return result.rows;
}

function asString(row: HistoryRow, field: string): string | null {
  const value = row.snapshot[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function addId(set: Set<string>, value: string | null): boolean {
  if (!value || set.has(value)) return false;
  set.add(value);
  return true;
}

function validAtRow(row: HistoryRow, validAt: Date): boolean {
  const from = iso(row.snapshot.valid_from);
  const to = iso(row.snapshot.valid_to);
  if (from && Date.parse(from) > validAt.getTime()) return false;
  if (to && Date.parse(to) <= validAt.getTime()) return false;
  const entry = typeof row.snapshot.entry_date === "string" ? Date.parse(`${row.snapshot.entry_date}T00:00:00Z`) : null;
  if (row.entity_type === "pe_portfolio_holding" && entry !== null && entry > validAt.getTime()) return false;
  return true;
}

function correctionKey(row: HistoryRow): string | null {
  const s = row.snapshot;
  if (row.entity_type === "pe_metric_observation") return `${row.entity_type}:${String(s.metric_series_id)}:${String(s.period_start)}:${String(s.period_end)}`;
  if (row.entity_type === "pe_benchmark_observation") return `${row.entity_type}:${String(s.benchmark_id)}:${String(s.period_start)}:${String(s.period_end)}`;
  if (row.entity_type === "pe_fact_coverage") return `${row.entity_type}:${String(s.subject_type)}:${String(s.subject_id)}:${String(s.proposition)}:${String(s.valid_from)}:${String(s.valid_to)}`;
  return null;
}

/** Corrected observations keep stable business identity while each correction has
 * its own canonical row id. At one knowledge time only the highest known revision
 * of that business identity belongs in a world projection. */
function latestCorrections(rows: HistoryRow[]): HistoryRow[] {
  const winners = new Map<string, HistoryRow>();
  for (const row of rows) {
    const key = correctionKey(row);
    if (!key) continue;
    const prior = winners.get(key);
    const revision = Number(row.snapshot.revision ?? 1);
    const priorRevision = Number(prior?.snapshot.revision ?? 0);
    if (!prior || revision > priorRevision || (revision === priorRevision && row.recorded_at > prior.recorded_at)) winners.set(key, row);
  }
  return rows.filter((row) => {
    const key = correctionKey(row);
    return !key || winners.get(key) === row;
  });
}

/** Select the connected institutional graph from immutable snapshots.  The
 * selection is tenant bounded first, then graph bounded; no current table is
 * consulted to infer a historical edge. */
function connectedHistory(rows: HistoryRow[], root: PeWorldRootRef, validAt: Date): HistoryRow[] {
  const selected = new Set<string>();
  const funds = new Set<string>(); const vehicles = new Set<string>();
  const holdings = new Set<string>(); const companies = new Set<string>(); const people = new Set<string>();
  const strategies = new Set<string>(); const opportunities = new Set<string>(); const deals = new Set<string>();
  const securities = new Set<string>(); const facilities = new Set<string>(); const series = new Set<string>();
  const benchmarks = new Set<string>(); const decisions = new Set<string>();
  const seed = root.entityId;
  if (root.entityType === "pe_fund") funds.add(seed);
  else if (root.entityType === "pe_vehicle") vehicles.add(seed);
  else if (root.entityType === "pe_portfolio_holding") holdings.add(seed);
  else if (root.entityType === "external_organization") companies.add(seed);
  else if (root.entityType === "pe_strategy") strategies.add(seed);
  else if (root.entityType === "pe_opportunity") opportunities.add(seed);
  else if (root.entityType === "pe_deal") deals.add(seed);

  const choose = (row: HistoryRow): boolean => {
    const s = row.snapshot;
    const id = row.entity_id;
    switch (row.entity_type) {
      case "pe_fund": return funds.has(id);
      case "pe_vehicle": return vehicles.has(id);
      case "external_organization": return companies.has(id);
      case "external_contact": return people.has(id);
      case "pe_strategy": return strategies.has(id);
      case "pe_opportunity": return opportunities.has(id)
        || (root.entityType === "pe_strategy" && strategies.has(asString(row, "strategy_id") ?? ""));
      case "pe_deal": return deals.has(id) || opportunities.has(asString(row, "opportunity_id") ?? "")
        || (root.entityType === "external_organization" && companies.has(asString(row, "target_organization_id") ?? ""));
      case "pe_fund_vehicle_link": return funds.has(asString(row, "fund_id") ?? "") || vehicles.has(asString(row, "vehicle_id") ?? "");
      case "pe_strategy_mandate": return strategies.has(asString(row, "strategy_id") ?? "")
        || (s.principal_type === "pe_fund" ? funds : vehicles).has(asString(row, "principal_id") ?? "");
      case "pe_portfolio_holding": return holdings.has(id) || funds.has(asString(row, "fund_id") ?? "")
        || vehicles.has(asString(row, "vehicle_id") ?? "") || companies.has(asString(row, "company_id") ?? "")
        || deals.has(asString(row, "origin_deal_id") ?? "");
      case "pe_company_hierarchy": return companies.has(asString(row, "parent_company_id") ?? "") || companies.has(asString(row, "child_company_id") ?? "");
      case "pe_company_party_role": return companies.has(asString(row, "company_id") ?? "")
        || (s.party_type === "external_organization" ? companies : people).has(asString(row, "party_id") ?? "");
      case "pe_security": return securities.has(id) || companies.has(asString(row, "issuer_company_id") ?? "");
      case "pe_debt_facility": return facilities.has(id) || companies.has(asString(row, "borrower_company_id") ?? "");
      case "pe_debt_facility_lender": return facilities.has(asString(row, "debt_facility_id") ?? "");
      case "pe_ownership_interest": return (s.owner_type === "pe_fund" ? funds : s.owner_type === "pe_vehicle" ? vehicles : companies).has(asString(row, "owner_id") ?? "")
        || (s.subject_type === "pe_security" ? securities : companies).has(asString(row, "subject_id") ?? "");
      case "pe_metric_series": return series.has(id) || (s.subject_type === "pe_portfolio_holding" ? holdings : companies).has(asString(row, "subject_id") ?? "");
      case "pe_metric_observation": return series.has(asString(row, "metric_series_id") ?? "");
      case "pe_benchmark": return benchmarks.has(id);
      case "pe_benchmark_observation": return benchmarks.has(asString(row, "benchmark_id") ?? "");
      case "pe_outcome": return (s.subject_type === "pe_portfolio_holding" ? holdings : companies).has(asString(row, "subject_id") ?? "") || decisions.has(asString(row, "decision_id") ?? "");
      case "pe_exit": return holdings.has(asString(row, "portfolio_holding_id") ?? "");
      case "pe_fact_coverage": return (s.subject_type === "pe_fund" ? funds : s.subject_type === "pe_vehicle" ? vehicles : s.subject_type === "pe_portfolio_holding" ? holdings : companies).has(asString(row, "subject_id") ?? "");
      default: return deals.has(asString(row, "deal_id") ?? "")
        || (row.entity_type === "pe_document_link" || row.entity_type === "pe_evidence_link")
          && (String(s.world_root_type) === root.entityType && String(s.world_root_id) === root.entityId);
    }
  };

  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    for (const row of rows) {
      if (!choose(row)) continue;
      const key = historyKey(row);
      if (!selected.has(key)) { selected.add(key); changed = true; }
      const s = row.snapshot;
      switch (row.entity_type) {
        case "pe_fund_vehicle_link": changed = addId(funds, asString(row, "fund_id")) || changed; changed = addId(vehicles, asString(row, "vehicle_id")) || changed; break;
        case "pe_strategy_mandate": changed = addId(strategies, asString(row, "strategy_id")) || changed; changed = (s.principal_type === "pe_fund" ? addId(funds, asString(row, "principal_id")) : addId(vehicles, asString(row, "principal_id"))) || changed; break;
        case "pe_portfolio_holding": changed = addId(holdings, row.entity_id) || changed; changed = addId(funds, asString(row, "fund_id")) || changed; changed = addId(vehicles, asString(row, "vehicle_id")) || changed; changed = addId(companies, asString(row, "company_id")) || changed; changed = addId(deals, asString(row, "origin_deal_id")) || changed; break;
        case "pe_company_hierarchy": changed = addId(companies, asString(row, "parent_company_id")) || changed; changed = addId(companies, asString(row, "child_company_id")) || changed; break;
        case "pe_company_party_role": changed = addId(companies, asString(row, "company_id")) || changed; changed = (s.party_type === "external_organization" ? addId(companies, asString(row, "party_id")) : addId(people, asString(row, "party_id"))) || changed; break;
        case "pe_security": changed = addId(securities, row.entity_id) || changed; changed = addId(companies, asString(row, "issuer_company_id")) || changed; break;
        case "pe_debt_facility": changed = addId(facilities, row.entity_id) || changed; changed = addId(companies, asString(row, "borrower_company_id")) || changed; break;
        case "pe_debt_facility_lender": changed = addId(facilities, asString(row, "debt_facility_id")) || changed; changed = (s.lender_party_type === "external_organization" ? addId(companies, asString(row, "lender_party_id")) : addId(people, asString(row, "lender_party_id"))) || changed; break;
        case "pe_ownership_interest": changed = (s.owner_type === "pe_fund" ? addId(funds, asString(row, "owner_id")) : s.owner_type === "pe_vehicle" ? addId(vehicles, asString(row, "owner_id")) : addId(companies, asString(row, "owner_id"))) || changed; changed = (s.subject_type === "pe_security" ? addId(securities, asString(row, "subject_id")) : addId(companies, asString(row, "subject_id"))) || changed; break;
        case "pe_metric_series": changed = addId(series, row.entity_id) || changed; changed = addId(benchmarks, asString(row, "benchmark_id")) || changed; changed = (s.subject_type === "pe_portfolio_holding" ? addId(holdings, asString(row, "subject_id")) : addId(companies, asString(row, "subject_id"))) || changed; break;
        case "pe_opportunity": changed = addId(opportunities, row.entity_id) || changed; changed = addId(strategies, asString(row, "strategy_id")) || changed; break;
        case "pe_deal": changed = addId(deals, row.entity_id) || changed; changed = addId(opportunities, asString(row, "opportunity_id")) || changed; changed = addId(companies, asString(row, "target_organization_id")) || changed; break;
        case "pe_decision": changed = addId(decisions, row.entity_id) || changed; break;
        default: break;
      }
    }
    if (!changed) break;
  }
  return rows.filter((row) => selected.has(historyKey(row)) && validAtRow(row, validAt));
}

export interface PeWorldTemporalQuery {
  validAt?: Date | string;
  knowledgeAt?: Date | string;
}

/** Historical meaning: only canonical snapshots recorded at or before `at`, and
 * only evidence both effective and retrieved at or before `at`, are eligible. */
export async function loadPrivateEquityWorldState(
  ctx: PeMutationContext,
  root: PeWorldRootRef,
  at?: Date | string | PeWorldTemporalQuery,
): Promise<PeWorldState> {
  if (!ROOT_TYPES.has(root.entityType)) throw new PeDomainError("PE_UNSUPPORTED_WORLD_ROOT", `Unsupported PE world root ${root.entityType}`);
  assertPeUuid(root.entityId, "world root entityId");
  const temporal = at && typeof at === "object" && !(at instanceof Date) ? at : null;
  const parseAt = (value: Date | string | undefined): Date | null => value === undefined ? null : value instanceof Date ? value : new Date(value);
  const requestedKnowledgeAt = parseAt(temporal?.knowledgeAt ?? (temporal ? undefined : at as Date | string | undefined));
  const requestedValidAt = parseAt(temporal?.validAt);
  if ((requestedKnowledgeAt && Number.isNaN(requestedKnowledgeAt.getTime())) || (requestedValidAt && Number.isNaN(requestedValidAt.getTime()))) {
    throw new PeDomainError("PE_INVALID_TEMPORAL_TIMESTAMP", "PE world-state validAt or knowledgeAt timestamp is malformed");
  }

  return peTransaction(ctx, async (_db, client) => {
    const transactionAt = (await client.query<{ at: Date }>("SELECT transaction_timestamp() AS at")).rows[0]!.at;
    const clock = requestedKnowledgeAt ?? transactionAt;
    const validClock = requestedValidAt ?? clock;
    const stateAt = clock.toISOString();
    const validAt = validClock.toISOString();
    const tenant = await client.query<{ tenant_id: string | null }>(
      "SELECT finnor_os.canonical_entity_tenant($1,$2::uuid)::text AS tenant_id",
      [root.entityType, root.entityId],
    );
    if (tenant.rows[0]?.tenant_id !== ctx.auth.tenantId) {
      throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE world root was not found in the authenticated tenant");
    }

    const coverage = await client.query<CoverageRow>(
      `SELECT entity_type,coverage_started_at FROM finnor_os.canonical_history_coverage
        WHERE entity_type=ANY($1::text[])`,
      [[...PE_ENTITY_TYPES, "external_organization", "external_contact"]],
    );
    const coverageByType = new Map<string, Date>(coverage.rows.map((row) => [row.entity_type, row.coverage_started_at]));
    const rootCoverage = coverageByType.get(root.entityType);
    if (!rootCoverage) throw new PeDomainError("PE_HISTORY_COVERAGE_MISSING", "PE world root has no declared temporal coverage");
    const unavailableTypes = PE_ENTITY_TYPES.filter((type) => {
      const started = coverageByType.get(type);
      return !started || started.getTime() > clock.getTime();
    });
    const allCoverageTimes = [...coverageByType.values()].map((value) => value.getTime());
    const fullBaselineAt = allCoverageTimes.length ? new Date(Math.max(...allCoverageTimes)).toISOString() : null;
    if (clock.getTime() < rootCoverage.getTime()) {
      return emptyWorld(root, validAt, stateAt, {
        status: "unavailable_before_baseline",
        baselineAt: rootCoverage.toISOString(),
        unavailableEntityTypes: [...unavailableTypes],
        reasons: ["HISTORY_UNAVAILABLE_BEFORE_BASELINE"],
      });
    }

    const history = new Map<string, HistoryRow>();
    const rootRows = await latestExact(client, ctx.auth.tenantId, clock, [root.entityType], [root.entityId]);
    addHistory(history, rootRows);
    const rootRow = rootRows[0];
    // A root created after `at` is truthfully absent then. Never substitute its
    // current row or traverse current relationships backwards in time.
    if (!rootRow || !validAtRow(rootRow, validClock)) {
      return emptyWorld(root, validAt, stateAt, {
        status: unavailableTypes.length ? "partial" : "complete",
        baselineAt: fullBaselineAt,
        unavailableEntityTypes: [...unavailableTypes],
        reasons: unavailableTypes.length ? ["Some PE types did not yet have history coverage"] : [],
      });
    }

    const tenantCandidates = await latestTenantHistory(client, ctx.auth.tenantId, clock);
    const connectedRows = connectedHistory(latestCorrections(tenantCandidates), root, validClock);
    addHistory(history, connectedRows);
    let strategyRows: HistoryRow[] = [];
    let opportunityRows: HistoryRow[] = [];
    let dealRows: HistoryRow[] = [];
    if (root.entityType === "pe_strategy") {
      strategyRows = rootRows;
      opportunityRows = await latestBySnapshotField(client, ctx.auth.tenantId, clock, ["pe_opportunity"], "strategy_id", [root.entityId]);
      addHistory(history, opportunityRows);
      dealRows = await latestBySnapshotField(client, ctx.auth.tenantId, clock, ["pe_deal"], "opportunity_id", opportunityRows.map((row) => row.entity_id));
    } else if (root.entityType === "pe_opportunity") {
      opportunityRows = rootRows;
      dealRows = await latestBySnapshotField(client, ctx.auth.tenantId, clock, ["pe_deal"], "opportunity_id", [root.entityId]);
      const strategyId = rootRow.snapshot.strategy_id;
      if (typeof strategyId === "string") strategyRows = await latestExact(client, ctx.auth.tenantId, clock, ["pe_strategy"], [strategyId]);
    } else if (root.entityType === "pe_deal") {
      dealRows = rootRows;
      const opportunityId = rootRow.snapshot.opportunity_id;
      if (typeof opportunityId === "string") {
        opportunityRows = await latestExact(client, ctx.auth.tenantId, clock, ["pe_opportunity"], [opportunityId]);
        const strategyId = opportunityRows[0]?.snapshot.strategy_id;
        if (typeof strategyId === "string") strategyRows = await latestExact(client, ctx.auth.tenantId, clock, ["pe_strategy"], [strategyId]);
      }
    } else {
      strategyRows = connectedRows.filter((row) => row.entity_type === "pe_strategy");
      opportunityRows = connectedRows.filter((row) => row.entity_type === "pe_opportunity");
      dealRows = connectedRows.filter((row) => row.entity_type === "pe_deal");
    }
    addHistory(history, strategyRows);
    addHistory(history, opportunityRows);
    addHistory(history, dealRows);
    const dealIds = dealRows.map((row) => row.entity_id);
    const childRows = root.entityType === "pe_strategy" || root.entityType === "pe_opportunity" || root.entityType === "pe_deal"
      ? await latestBySnapshotField(client, ctx.auth.tenantId, clock, DEAL_CHILD_TYPES, "deal_id", dealIds)
      : connectedRows.filter((row) => DEAL_CHILD_TYPES.includes(row.entity_type as PeEntityType));
    addHistory(history, childRows);
    const linkRows = await latestLinks(client, ctx.auth.tenantId, clock, root, dealIds);
    addHistory(history, linkRows);

    const reasons: string[] = [];
    if (tenantCandidates.length > MAX_WORLD_CANDIDATES) reasons.push(`Tenant history exceeded the ${MAX_WORLD_CANDIDATES}-row graph candidate bound`);
    if ([rootRows, opportunityRows, dealRows, childRows, linkRows].some((rows) => rows.length > MAX_WORLD_ROWS)) {
      reasons.push(`World history exceeded the ${MAX_WORLD_ROWS}-row deterministic bound`);
    }
    if (history.size > MAX_WORLD_ROWS) {
      reasons.push(`Combined world history exceeded the ${MAX_WORLD_ROWS}-row deterministic bound`);
    }
    const safeHistory = [...history.values()].slice(0, MAX_WORLD_ROWS);
    const safeMap = new Map(safeHistory.map((row) => [historyKey(row), row]));
    const strategyValues = arrayFor(safeMap, "pe_strategy");
    const opportunityValues = arrayFor(safeMap, "pe_opportunity");
    const dealValues = arrayFor(safeMap, "pe_deal");
    const primaryOpportunity = root.entityType === "pe_opportunity"
      ? opportunityValues.find((row) => row.id === root.entityId) ?? null
      : root.entityType === "pe_deal"
        ? opportunityValues.find((row) => row.id === rootRow.snapshot.opportunity_id) ?? null
        : null;
    const primaryDeal = root.entityType === "pe_deal"
      ? dealValues.find((row) => row.id === root.entityId) ?? null
      : root.entityType === "pe_opportunity"
        ? dealValues.find((row) => row.opportunityId === root.entityId) ?? null
        : null;
    const primaryStrategy = root.entityType === "pe_strategy"
      ? strategyValues.find((row) => row.id === root.entityId) ?? null
      : primaryOpportunity && typeof primaryOpportunity.strategyId === "string"
        ? strategyValues.find((row) => row.id === primaryOpportunity.strategyId) ?? null
        : strategyValues[0] ?? null;
    const documentLinks = arrayFor(safeMap, "pe_document_link").filter((row) => !row.archivedAt);
    const evidenceLinks = arrayFor(safeMap, "pe_evidence_link").filter((row) => !row.archivedAt);
    const entityRefs = safeHistory.map((row) => ({ entity_type: row.entity_type, entity_id: row.entity_id }));
    const encodedEntityRefs = JSON.stringify(entityRefs);

    const documentIds = collectUuid(documentLinks, "documentId");
    const documentsRaw = documentIds.length ? await client.query<SqlRow>(
      `SELECT id::text,kind,title,source_system,created_at
         FROM finnor_os.documents WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND created_at<=$3
        ORDER BY created_at,id LIMIT $4`,
      [ctx.auth.tenantId, documentIds, clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    if (documentsRaw.rows.length) {
      reasons.push("Core Document metadata has no temporal version; historical payload is an explicitly marked current projection");
    }
    const documents = documentsRaw.rows.map((row) => ({
      ...shapePeRow(row),
      temporalPayload: "current_projection_unversioned",
    }));

    const evidenceSourceIds = collectUuid(evidenceLinks, "evidenceSourceId");
    const evidenceVersionsRaw = evidenceSourceIds.length ? await client.query<PrivateEquityAssertionSourceRow & SqlRow>(
      `SELECT s.id::text source_id,v.id::text version_id,s.source_type,v.as_of,v.retrieved_at,v.snapshot,
              v.version_number,v.content_hash
         FROM finnor_os.evidence_sources s
         JOIN finnor_os.evidence_source_versions v ON v.tenant_id=s.tenant_id AND v.source_id=s.id
        WHERE s.tenant_id=$1 AND s.id=ANY($2::uuid[])
          AND v.as_of<=$3 AND v.retrieved_at<=$4
        ORDER BY s.id,v.version_number DESC,v.id DESC LIMIT $5`,
      [ctx.auth.tenantId, evidenceSourceIds, validClock, clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as Array<PrivateEquityAssertionSourceRow & SqlRow> };
    if (evidenceVersionsRaw.rows.length > MAX_WORLD_ROWS) reasons.push(`Evidence exceeded the ${MAX_WORLD_ROWS}-row deterministic bound`);
    const explicitVersionsBySource = new Map<string, Set<string>>();
    const floatingVersionSources = new Set<string>();
    for (const link of evidenceLinks) {
      const sourceId = typeof link.evidenceSourceId === "string" ? link.evidenceSourceId : null;
      if (!sourceId) continue;
      if (typeof link.evidenceVersionId === "string") {
        const versions = explicitVersionsBySource.get(sourceId) ?? new Set<string>();
        versions.add(link.evidenceVersionId);
        explicitVersionsBySource.set(sourceId, versions);
      } else {
        floatingVersionSources.add(sourceId);
      }
    }
    const seenSources = new Set<string>();
    const eligibleEvidenceRows = evidenceVersionsRaw.rows.filter((row) => {
      const explicitVersions = explicitVersionsBySource.get(row.source_id);
      if (explicitVersions?.has(row.version_id)) return true;
      if (explicitVersions?.size && !floatingVersionSources.has(row.source_id)) return false;
      if (seenSources.has(row.source_id)) return false;
      seenSources.add(row.source_id);
      return true;
    }).slice(0, MAX_WORLD_ROWS);
    const evidence = eligibleEvidenceRows.map((row) => ({
      sourceId: row.source_id,
      versionId: row.version_id,
      sourceType: row.source_type,
      versionNumber: row.version_number,
      contentHash: row.content_hash,
      asOf: row.as_of.toISOString(),
      retrievedAt: row.retrieved_at.toISOString(),
      snapshot: row.snapshot,
    }));
    const worldRootRefs = [...new Map(safeHistory
      .filter((row) => ROOT_TYPES.has(row.entity_type as PeWorldRootRef["entityType"]))
      .map((row) => [`${row.entity_type}:${row.entity_id}`, { entityType: row.entity_type, entityId: row.entity_id }])).values()];
    const providerContext = await loadProviderWorldContext(
      client,
      ctx.auth.tenantId,
      clock,
      worldRootRefs,
      eligibleEvidenceRows.map((row) => row.version_id),
      eligibleEvidenceRows.map((row) => row.source_id),
    );

    const workRaw = entityRefs.length ? await client.query<SqlRow>(
      `SELECT l.* FROM finnor_os.work_entity_links l
        WHERE l.tenant_id=$1 AND l.created_at<=$3 AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS scoped(entity_type text,entity_id uuid)
           WHERE scoped.entity_type=l.entity_type AND scoped.entity_id=l.entity_id
        )
        ORDER BY l.created_at,l.id LIMIT $4`,
      [ctx.auth.tenantId, encodedEntityRefs, clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    const taskRaw = entityRefs.length ? await client.query<SqlRow>(
      `SELECT t.* FROM finnor_os.tasks t
        WHERE t.tenant_id=$1 AND t.created_at<=$3 AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS scoped(entity_type text,entity_id uuid)
           WHERE scoped.entity_type=t.subject_type AND scoped.entity_id=t.subject_id
        )
        ORDER BY t.created_at,t.id LIMIT $4`,
      [ctx.auth.tenantId, encodedEntityRefs, clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    const taskLinks = taskRaw.rows.map((row) => {
      const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at));
      if (updatedAt.getTime() <= clock.getTime()) return shapePeRow(row);
      reasons.push(`Task ${String(row.id)} changed after stateAt; historical payload is reference-only`);
      return { id: String(row.id), subjectType: row.subject_type, subjectId: String(row.subject_id), temporalPayload: "reference_only" };
    });

    const workLinks = workRaw.rows.map((row) => ({
      ...shapePeRow(row),
      temporalPayload: "current_projection_unversioned",
    }));
    if (workLinks.length) {
      reasons.push("Core Work relationship metadata has no temporal version; historical payload is an explicitly marked current projection");
    }

    const eventsRaw = entityRefs.length ? await client.query<SqlRow>(
      `SELECT e.* FROM finnor_os.business_events e
        WHERE e.tenant_id=$1 AND e.occurred_at<=$2
          AND (EXISTS (
            SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS scoped(entity_type text,entity_id uuid)
             WHERE scoped.entity_type=e.entity_type AND scoped.entity_id=e.entity_id
          ) OR e.payload->>'dealId'=ANY($4::text[]))
        ORDER BY e.occurred_at,e.id LIMIT $5`,
      [ctx.auth.tenantId, clock, encodedEntityRefs, dealIds, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    if ([workRaw.rows, taskRaw.rows, eventsRaw.rows].some((rows) => rows.length > MAX_WORLD_ROWS)) {
      reasons.push(`Related Core graph rows exceeded the ${MAX_WORLD_ROWS}-row deterministic bound`);
    }

    const authorityRaw = entityRefs.length ? await client.query<SqlRow>(
      `SELECT a.* FROM finnor_os.authority_decisions a
        WHERE a.tenant_id=$1 AND a.created_at<=$3 AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS scoped(entity_type text,entity_id uuid)
           WHERE scoped.entity_type=a.resource_type AND scoped.entity_id=a.resource_id
        )
        ORDER BY a.created_at,a.id LIMIT $4`,
      [ctx.auth.tenantId, encodedEntityRefs, clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    const authorityIds = authorityRaw.rows.map((row) => String(row.id));
    const approvalRaw = authorityIds.length ? await client.query<SqlRow>(
      `SELECT * FROM finnor_os.authority_approval_requests
        WHERE tenant_id=$1 AND authority_decision_id=ANY($2::uuid[]) AND created_at<=$3
        ORDER BY created_at,id LIMIT $4`,
      [ctx.auth.tenantId, authorityIds, clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    if (approvalRaw.rows.length) {
      reasons.push("Core approval requests have no temporal versions; historical payload is explicitly marked current or reference-only");
    }
    const approvalRequests = approvalRaw.rows.map((row) => {
      const resolvedAt = iso(row.resolved_at);
      if (!resolvedAt || Date.parse(resolvedAt) <= clock.getTime()) {
        return { ...shapePeRow(row), temporalPayload: "current_projection_unversioned" };
      }
      return {
        id: String(row.id),
        domainActionId: String(row.domain_action_id),
        requesterId: row.requester_id ? String(row.requester_id) : null,
        authorityDecisionId: String(row.authority_decision_id),
        approvalChainId: String(row.approval_chain_id),
        status: "pending",
        currentStep: null,
        createdAt: iso(row.created_at),
        resolvedAt: null,
        temporalPayload: "reference_only",
      };
    });

    const decisionEffectRaw = arrayFor(safeMap, "pe_decision").length ? await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_decision_effect_links
        WHERE tenant_id=$1 AND decision_id=ANY($2::uuid[]) AND created_at<=$3
        ORDER BY created_at,id LIMIT $4`,
      [ctx.auth.tenantId, collectUuid(arrayFor(safeMap, "pe_decision"), "id"), clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    const receiptIds = new Set<string>();
    for (const row of [...dealValues, ...arrayFor(safeMap, "pe_closing_condition")]) {
      for (const field of ["closeDecisionReceiptId", "terminationDecisionReceiptId", "waiverDecisionReceiptId"]) {
        if (typeof row[field] === "string") receiptIds.add(row[field] as string);
      }
    }
    for (const row of decisionEffectRaw.rows) if (row.effect_type === "decision_receipt") receiptIds.add(String(row.effect_id));
    const receiptsRaw = receiptIds.size ? await client.query<SqlRow>(
      `SELECT * FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND created_at<=$3
        ORDER BY created_at,id LIMIT $4`,
      [ctx.auth.tenantId, [...receiptIds], clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };
    if (receiptsRaw.rows.length) {
      reasons.push("Core DecisionReceipts have no temporal versions; historical payload is explicitly marked current or reference-only");
    }
    const decisionReceipts = receiptsRaw.rows.map((row) => {
      const finalizedAt = iso(row.finalized_at);
      if (!finalizedAt || Date.parse(finalizedAt) <= clock.getTime()) {
        return { ...shapePeRow(row), temporalPayload: "current_projection_unversioned" };
      }
      return {
        id: String(row.id),
        objective: row.objective,
        createdAt: iso(row.created_at),
        finalizedAt: null,
        temporalState: "open",
        temporalPayload: "reference_only",
      };
    });

    const conflictsRaw = entityRefs.length ? await client.query<SqlRow>(
      `SELECT id::text,integration_id::text,source_link_id::text,provider,external_object_type,external_id,
              canonical_entity_type,canonical_entity_id::text,source_version,source_sequence::text,
              observed_at,received_at,observed_hash,materialization_status,mapping_status,conflict_state,
              provider_deleted,reason
         FROM finnor_os.external_ref_observations
        WHERE tenant_id=$1 AND received_at<=$3 AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS scoped(entity_type text,entity_id uuid)
           WHERE scoped.entity_type=canonical_entity_type AND scoped.entity_id=canonical_entity_id
        )
          AND materialization_status IN ('conflict','ambiguous','unresolved','out_of_order')
        ORDER BY received_at,id LIMIT $4`,
      [ctx.auth.tenantId, encodedEntityRefs, clock, MAX_WORLD_ROWS + 1],
    ) : { rows: [] as SqlRow[] };

    const investmentCases = arrayFor(safeMap, "pe_investment_case");
    const theses = arrayFor(safeMap, "pe_thesis");
    const assumptions = arrayFor(safeMap, "pe_assumption");
    const decisions = arrayFor(safeMap, "pe_decision");
    const portfolioHoldings = arrayFor(safeMap, "pe_portfolio_holding").map((row) => {
      const entryAt = typeof row.entryDate === "string" ? Date.parse(`${row.entryDate}T00:00:00Z`) : Number.NaN;
      const exitAt = typeof row.exitDate === "string" ? Date.parse(`${row.exitDate}T00:00:00Z`) : Number.NaN;
      return {
        ...row,
        holdingStatus: Number.isFinite(exitAt) && exitAt <= validClock.getTime()
          ? "exited"
          : Number.isFinite(entryAt) && entryAt <= validClock.getTime() ? "active" : row.holdingStatus,
      };
    });
    const assertions: PrivateEquityAssertion[] = privateEquityAssertionsFromRows(eligibleEvidenceRows, 200, root);
    const epistemic = buildPrivateEquityWorldEpistemicSnapshot({
      tenantId: ctx.auth.tenantId,
      principalId: ctx.auth.employeeId ?? ctx.auth.userId,
      root,
      world: {
        strategy: primaryStrategy,
        opportunity: root.entityType === "pe_opportunity" ? primaryOpportunity : null,
        investmentCases, theses, assumptions, decisions,
      },
      assertions,
      asOf: stateAt,
    });
    const completenessStatus: TemporalCompletenessStatus = unavailableTypes.length || reasons.length ? "partial" : "complete";
    const baselineWarnings = unavailableTypes.length ? [{
      propositionId: `pe:v1:${root.entityType}:${root.entityId}:history`,
      predicate: "history.available",
      status: "UNKNOWN" as const,
      reason: "HISTORY_UNAVAILABLE_BEFORE_BASELINE",
      evidenceRefs: [] as string[],
    }] : [];

    return {
      root,
      stateAt,
      validAt,
      knowledgeAt: stateAt,
      temporalCompleteness: {
        status: completenessStatus,
        baselineAt: fullBaselineAt,
        unavailableEntityTypes: [...unavailableTypes],
        reasons: [...new Set(reasons)],
      },
      strategy: primaryStrategy,
      opportunity: root.entityType === "pe_opportunity" || root.entityType === "pe_deal" ? primaryOpportunity : null,
      deal: root.entityType === "pe_opportunity" || root.entityType === "pe_deal" ? primaryDeal : null,
      opportunities: opportunityValues,
      deals: dealValues,
      investmentCases,
      theses,
      assumptions,
      decisions,
      funds: arrayFor(safeMap, "pe_fund"),
      vehicles: arrayFor(safeMap, "pe_vehicle"),
      fundVehicleLinks: arrayFor(safeMap, "pe_fund_vehicle_link"),
      strategyMandates: arrayFor(safeMap, "pe_strategy_mandate"),
      portfolioHoldings,
      companies: arrayFor(safeMap, "external_organization"),
      people: arrayFor(safeMap, "external_contact"),
      companyHierarchyRelationships: arrayFor(safeMap, "pe_company_hierarchy"),
      companyPartyRoles: arrayFor(safeMap, "pe_company_party_role"),
      securities: arrayFor(safeMap, "pe_security"),
      debtFacilities: arrayFor(safeMap, "pe_debt_facility"),
      debtFacilityLenders: arrayFor(safeMap, "pe_debt_facility_lender"),
      ownershipInterests: arrayFor(safeMap, "pe_ownership_interest"),
      metricSeries: arrayFor(safeMap, "pe_metric_series"),
      metricObservations: arrayFor(safeMap, "pe_metric_observation"),
      benchmarks: arrayFor(safeMap, "pe_benchmark"),
      benchmarkObservations: arrayFor(safeMap, "pe_benchmark_observation"),
      claims: epistemic.state.propositions.map((proposition) => ({ ...proposition, owner: "@finnor/epistemic-runtime" })),
      outcomes: arrayFor(safeMap, "pe_outcome"),
      exits: arrayFor(safeMap, "pe_exit"),
      factCoverage: arrayFor(safeMap, "pe_fact_coverage"),
      decisionEffectLinks: decisionEffectRaw.rows.slice(0, MAX_WORLD_ROWS).map(shapePeRow),
      dealParties: arrayFor(safeMap, "pe_deal_party"),
      workstreams: arrayFor(safeMap, "pe_workstream"),
      requests: arrayFor(safeMap, "pe_request").map((row) => ({
        ...row,
        overdue: isRequestOverdue({ state: String(row.state), dueAt: row.dueAt as string | null }, validClock),
      })),
      deliverables: arrayFor(safeMap, "pe_deliverable"),
      findings: arrayFor(safeMap, "pe_finding"),
      dealRisks: arrayFor(safeMap, "pe_deal_risk"),
      findingRiskLinks: arrayFor(safeMap, "pe_finding_risk_link"),
      dependencies: arrayFor(safeMap, "pe_dependency"),
      milestones: arrayFor(safeMap, "pe_milestone").map((row) => ({
        ...row,
        late: isMilestoneLate({ state: String(row.state), targetAt: row.targetAt as string }, validClock),
      })),
      closingConditions: arrayFor(safeMap, "pe_closing_condition"),
      closingItems: arrayFor(safeMap, "pe_closing_item"),
      documents: documents.slice(0, MAX_WORLD_ROWS),
      evidence,
      ...providerContext,
      documentLinks,
      evidenceLinks,
      workLinks: workLinks.slice(0, MAX_WORLD_ROWS),
      taskLinks,
      businessEvents: eventsRaw.rows.slice(0, MAX_WORLD_ROWS).map(shapePeRow),
      authorityDecisions: authorityRaw.rows.slice(0, MAX_WORLD_ROWS).map(shapePeRow),
      approvalRequests,
      decisionReceipts,
      conflicts: conflictsRaw.rows.slice(0, MAX_WORLD_ROWS).map(shapePeRow),
      epistemicWarnings: [...baselineWarnings, ...epistemic.warnings],
      provenance: safeHistory.map((row) => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityVersion: row.entity_version,
        snapshotHash: row.snapshot_hash,
        recordedAt: row.recorded_at.toISOString(),
        origin: row.origin,
      })),
    };
  }, { readOnly: true });
}
