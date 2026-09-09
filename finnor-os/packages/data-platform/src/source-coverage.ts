import {
  integrationSourceCoverageHistory,
  integrationSourceScopes,
  reconciliationCases,
  type Db,
} from "@finnor/db";
import type { SourceCoverageSnapshot, SourceCoverageState } from "@finnor/shared-types";
import { and, desc, eq, sql } from "drizzle-orm";

export interface AppendSourceCoverageInput {
  tenantId: string;
  sourceScopeId: string;
  sourceKind: string;
  state: SourceCoverageState;
  recoveryStrength: SourceCoverageSnapshot["recoveryStrength"];
  region: Readonly<Record<string, unknown>>;
  reason?: string | null;
  checkpointId?: string | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  baselineStartedAt?: Date | null;
  baselineCompletedAt?: Date | null;
  earliestProviderAt?: Date | null;
  latestProviderAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface AppendSourceCoverageResult {
  snapshot: SourceCoverageSnapshot;
  created: boolean;
  id: string;
  revision: number;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stable(nested)]));
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function bounded(value: Readonly<Record<string, unknown>>, limit: number, label: string): Record<string, unknown> {
  const normalized = stable(value) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > limit) throw new Error(`${label} exceeds its durable bound`);
  return normalized;
}

async function unresolvedCounts(db: Db, tenantId: string, sourceScopeId: string): Promise<{ unresolved: number; ambiguous: number }> {
  const result = await db.execute<{ unresolved: number | string; ambiguous: number | string }>(sql`
    SELECT
      count(*) FILTER (WHERE case_type='unresolved_world_root')::int unresolved,
      count(*) FILTER (WHERE case_type='mapping_ambiguous')::int ambiguous
    FROM ${reconciliationCases}
    WHERE tenant_id=${tenantId}::uuid AND integration_id IS NOT NULL AND status='open'
      AND details->>'sourceScopeId'=${sourceScopeId}
  `);
  return {
    unresolved: Number(result.rows[0]?.unresolved ?? 0),
    ambiguous: Number(result.rows[0]?.ambiguous ?? 0),
  };
}

function snapshotFromRow(
  row: typeof integrationSourceCoverageHistory.$inferSelect,
  sourceKind: string,
  recoveryStrength: SourceCoverageSnapshot["recoveryStrength"],
): SourceCoverageSnapshot {
  const sourceDescriptor = row.sourceDescriptor as Record<string, unknown>;
  const recordedSourceKind = typeof sourceDescriptor.sourceKind === "string"
    ? sourceDescriptor.sourceKind
    : sourceKind;
  const recordedRecoveryStrength = sourceDescriptor.recoveryStrength;
  const historicalRecoveryStrength = recordedRecoveryStrength === "EXACT_DELTA"
    || recordedRecoveryStrength === "BOUNDED_RECONCILIATION"
    || recordedRecoveryStrength === "BEST_EFFORT_NOTIFICATION_RECOVERY"
    ? recordedRecoveryStrength
    : recoveryStrength;
  return {
    sourceScopeId: row.sourceScopeId,
    sourceKind: recordedSourceKind,
    state: row.state,
    recoveryStrength: historicalRecoveryStrength,
    region: row.coverageRegion as Record<string, unknown>,
    recordedAt: row.recordedAt.toISOString(),
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: iso(row.effectiveTo),
    reason: row.reason,
    baselineStartedAt: iso(row.baselineStartedAt),
    baselineCompletedAt: iso(row.baselineCompletedAt),
    earliestProviderAt: iso(row.earliestProviderAt),
    latestProviderAt: iso(row.latestProviderAt),
    unresolvedObservations: row.unresolvedObservations,
    ambiguousObservations: row.ambiguousObservations,
    sourceDescriptor,
  };
}

function sourceDescriptorFromScope(scope: typeof integrationSourceScopes.$inferSelect): Record<string, unknown> {
  return bounded({
    schema: "finnor.source-coverage-descriptor.v1",
    integrationId: scope.integrationId,
    provider: scope.provider,
    sourceKind: scope.sourceKind,
    providerScopeType: scope.providerScopeType,
    providerResourceId: scope.providerResourceId,
    providerParentId: scope.providerParentId,
    scopeKey: scope.scopeKey,
    enabled: scope.enabled,
    rootBindingType: scope.rootBindingType,
    rootBindingId: scope.rootBindingId,
    syncStrategy: scope.syncStrategy,
    recoveryStrength: scope.recoveryStrategy,
    permissionMode: scope.permissionMode,
    requiredPermissions: scope.requiredPermissions,
    effectivePermissions: scope.effectivePermissions,
    providerRestrictionMethod: scope.providerRestrictionMethod,
    permissionVerifiedAt: iso(scope.permissionVerifiedAt),
    coveragePolicy: scope.coveragePolicy,
    freshnessPolicy: scope.freshnessPolicy,
    configuration: scope.configuration,
    freshnessState: scope.freshnessState,
    lastSuccessfulSyncAt: iso(scope.lastSuccessfulSyncAt),
    lastObservedAt: iso(scope.lastObservedAt),
    configuredBy: scope.configuredBy,
    configuredAt: scope.configuredAt.toISOString(),
    disabledAt: iso(scope.disabledAt),
  }, 131_072, "Coverage source descriptor");
}

/** Append one historical coverage fact inside the caller's checkpoint transaction.
 * Identical facts converge without churning revisions. The safe descriptor records
 * the source/root/permission/freshness context that was knowable with this fact. */
export async function appendSourceCoverageTx(db: Db, input: AppendSourceCoverageInput): Promise<AppendSourceCoverageResult> {
  const [scope] = await db.select().from(integrationSourceScopes).where(and(
    eq(integrationSourceScopes.tenantId, input.tenantId),
    eq(integrationSourceScopes.id, input.sourceScopeId),
  )).limit(1);
  if (!scope || scope.sourceKind !== input.sourceKind || scope.recoveryStrategy !== input.recoveryStrength) {
    throw new Error("Coverage fact does not match its tenant-owned source descriptor");
  }
  const region = bounded(input.region, 65_536, "Coverage region");
  const metadata = bounded(input.metadata ?? {}, 32_768, "Coverage metadata");
  const sourceDescriptor = sourceDescriptorFromScope(scope);
  const counts = await unresolvedCounts(db, input.tenantId, input.sourceScopeId);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.tenantId}:${input.sourceScopeId}`},5112))`);
  const [previous] = await db.select().from(integrationSourceCoverageHistory).where(and(
    eq(integrationSourceCoverageHistory.tenantId, input.tenantId),
    eq(integrationSourceCoverageHistory.sourceScopeId, input.sourceScopeId),
  )).orderBy(desc(integrationSourceCoverageHistory.coverageRevision)).limit(1);
  const effectiveFrom = input.effectiveFrom ?? new Date();
  const comparable = {
    state: input.state,
    reason: input.reason ?? null,
    region,
    checkpointId: input.checkpointId ?? null,
    effectiveTo: iso(input.effectiveTo),
    baselineStartedAt: iso(input.baselineStartedAt),
    baselineCompletedAt: iso(input.baselineCompletedAt),
    earliestProviderAt: iso(input.earliestProviderAt),
    latestProviderAt: iso(input.latestProviderAt),
    unresolved: counts.unresolved,
    ambiguous: counts.ambiguous,
    sourceDescriptor,
    metadata,
  };
  const priorComparable = previous ? {
    state: previous.state,
    reason: previous.reason,
    region: stable(previous.coverageRegion),
    checkpointId: previous.checkpointId,
    effectiveTo: iso(previous.effectiveTo),
    baselineStartedAt: iso(previous.baselineStartedAt),
    baselineCompletedAt: iso(previous.baselineCompletedAt),
    earliestProviderAt: iso(previous.earliestProviderAt),
    latestProviderAt: iso(previous.latestProviderAt),
    unresolved: previous.unresolvedObservations,
    ambiguous: previous.ambiguousObservations,
    sourceDescriptor: stable(previous.sourceDescriptor),
    metadata: stable(previous.metadata),
  } : null;
  if (previous && JSON.stringify(comparable) === JSON.stringify(priorComparable)) {
    return {
      snapshot: snapshotFromRow(previous, input.sourceKind, input.recoveryStrength),
      created: false,
      id: previous.id,
      revision: previous.coverageRevision,
    };
  }
  const [created] = await db.insert(integrationSourceCoverageHistory).values({
    tenantId: input.tenantId,
    sourceScopeId: input.sourceScopeId,
    coverageRevision: (previous?.coverageRevision ?? 0) + 1,
    effectiveFrom: previous && effectiveFrom < previous.effectiveFrom ? previous.effectiveFrom : effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    coverageRegion: region,
    state: input.state,
    reason: input.reason ?? null,
    checkpointId: input.checkpointId ?? null,
    baselineStartedAt: input.baselineStartedAt ?? null,
    baselineCompletedAt: input.baselineCompletedAt ?? null,
    earliestProviderAt: input.earliestProviderAt ?? null,
    latestProviderAt: input.latestProviderAt ?? null,
    unresolvedObservations: counts.unresolved,
    ambiguousObservations: counts.ambiguous,
    sourceDescriptor,
    metadata,
  }).returning();
  if (!created) throw new Error("Coverage fact insert returned no row");
  return {
    snapshot: snapshotFromRow(created, input.sourceKind, input.recoveryStrength),
    created: true,
    id: created.id,
    revision: created.coverageRevision,
  };
}

/** Historical coverage is constrained by both effective time and when FINNOR
 * actually recorded the fact, preserving P1's no-hindsight semantics. */
export async function sourceCoverageAtTx(
  db: Db,
  tenantId: string,
  sourceScopeId: string,
  asOf: Date,
): Promise<SourceCoverageSnapshot | null> {
  const [row] = await db.select({
    coverage: integrationSourceCoverageHistory,
    sourceKind: integrationSourceScopes.sourceKind,
    recoveryStrength: integrationSourceScopes.recoveryStrategy,
  }).from(integrationSourceCoverageHistory).innerJoin(integrationSourceScopes, and(
    eq(integrationSourceScopes.tenantId, integrationSourceCoverageHistory.tenantId),
    eq(integrationSourceScopes.id, integrationSourceCoverageHistory.sourceScopeId),
  )).where(and(
    eq(integrationSourceCoverageHistory.tenantId, tenantId),
    eq(integrationSourceCoverageHistory.sourceScopeId, sourceScopeId),
    sql`${integrationSourceCoverageHistory.effectiveFrom}<=${asOf}`,
    sql`${integrationSourceCoverageHistory.recordedAt}<=${asOf}`,
    sql`(${integrationSourceCoverageHistory.effectiveTo} IS NULL OR ${integrationSourceCoverageHistory.effectiveTo}>${asOf})`,
  )).orderBy(desc(integrationSourceCoverageHistory.coverageRevision)).limit(1);
  return row ? snapshotFromRow(row.coverage, row.sourceKind, row.recoveryStrength) : null;
}
