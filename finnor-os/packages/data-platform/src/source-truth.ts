import { createHash } from "node:crypto";
import {
  externalRefs,
  externalRefObservations,
  reconciliationCases,
  tenantIntegrations,
  type Db,
} from "@finnor/db";
import type {
  CanonicalSourceRecord,
  ExternalEffectObservation,
  SourceFreshnessPolicy,
  SourceFreshnessState,
  SourceRelationshipRef,
} from "@finnor/shared-types";
import { RetiredVerticalError, isRetiredWaterCanonicalEntity } from "@finnor/shared-types";
import { and, eq, sql } from "drizzle-orm";
import { recordBusinessEvent } from "./events";

export type SourceMaterializationStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "duplicate"
  | "out_of_order"
  | "ambiguous"
  | "unresolved"
  | "conflict"
  | "observed"
  | "tombstoned";

export interface SourceMaterializationResult {
  status: SourceMaterializationStatus;
  sourceLinkId: string;
  canonicalEntityId?: string;
  canonicalEntityType?: string;
  businessEffectId?: string;
  reason?: string;
}

export class SourceTruthError extends Error {
  constructor(
    readonly code:
      | "integration_not_found"
      | "provider_binding_mismatch"
      | "invalid_record"
      | "unresolved_relationship"
      | "cross_tenant_reference",
    message: string,
  ) {
    super(message);
    this.name = "SourceTruthError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

export function sourceTruthHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseObservedAt(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new SourceTruthError("invalid_record", "source observedAt is invalid");
  return date;
}

function parseSequence(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new SourceTruthError("invalid_record", "sourceSequence must be non-negative decimal text");
  }
}

function changedFields(before: unknown, after: Record<string, unknown>): string[] {
  const prior = before && typeof before === "object" && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {};
  return Object.keys(after).filter((field) => sourceTruthHash(prior[field]) !== sourceTruthHash(after[field]));
}

function externalOwnedData(record: CanonicalSourceRecord): { writable: Record<string, unknown>; conflicts: string[] } {
  const writable: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const [field, value] of Object.entries(record.data)) {
    const authority = record.ownership.fields?.[field] ?? record.ownership.default;
    if (authority === "external" && record.ownership.direction !== "outbound") writable[field] = value;
    else conflicts.push(field);
  }
  return { writable, conflicts };
}

async function resolveRelationship(db: Db, record: CanonicalSourceRecord, relationship: SourceRelationshipRef): Promise<string | undefined> {
  if (relationship.canonicalId) return relationship.canonicalId;
  if (!relationship.externalId || !relationship.externalObjectType) return undefined;
  const [link] = await db.select({
    tenantId: externalRefs.tenantId,
    internalId: externalRefs.internalId,
    mappingStatus: externalRefs.mappingStatus,
  }).from(externalRefs).where(and(
    eq(externalRefs.tenantId, record.tenantId),
    eq(externalRefs.integrationId, record.integrationId),
    eq(externalRefs.externalObjectType, relationship.externalObjectType),
    eq(externalRefs.externalId, relationship.externalId),
  )).limit(1);
  if (link?.tenantId && link.tenantId !== record.tenantId) {
    throw new SourceTruthError("cross_tenant_reference", "source relationship crosses tenant boundary");
  }
  return link?.mappingStatus === "mapped" ? link.internalId ?? undefined : undefined;
}

async function resolveRelationships(db: Db, record: CanonicalSourceRecord): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, relationship] of Object.entries(record.relationships ?? {})) {
    const canonicalId = await resolveRelationship(db, record, relationship);
    if (!canonicalId && relationship.required !== false) {
      throw new SourceTruthError(
        "unresolved_relationship",
        `${record.externalObjectType}/${record.externalId} is waiting for ${name}`,
      );
    }
    if (canonicalId) resolved[name] = canonicalId;
  }
  return resolved;
}

async function upsertSourceLink(
  db: Db,
  record: CanonicalSourceRecord,
  values: {
    internalId?: string | null;
    mappingStatus: "mapped" | "unresolved" | "ambiguous" | "tombstoned";
    candidateCanonicalIds?: string[];
    observedHash: string;
    canonicalHash?: string | null;
    syncStatus: "acknowledged" | "observed" | "materialized" | "reconciled" | "conflict" | "source_missing" | "failed";
    conflictState?: "none" | "canonical_newer" | "external_newer" | "divergent" | "ambiguous" | "manual_resolution_required";
    providerDeleted?: boolean;
    tombstonedAt?: Date | null;
  },
): Promise<string> {
  const observedAt = parseObservedAt(record.observedAt);
  const sourceSequence = parseSequence(record.sourceSequence);
  const candidateCanonicalIds = `{${(values.candidateCanonicalIds ?? []).join(",")}}`;
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO finnor_os.external_refs(
      tenant_id,entity,internal_id,provider,external_id,integration_id,external_object_type,
      mapping_status,identity_key,candidate_canonical_ids,source_version,source_sequence,
      observed_state,observed_hash,canonical_hash,first_observed_at,last_observed_at,
      last_successful_sync_at,freshness_state,sync_status,conflict_state,ownership_policy,
      provenance,provider_deleted,tombstoned_at,last_effect_id,synced_at,updated_at
    ) VALUES (
      ${record.tenantId}::uuid,${record.canonicalEntity},${values.internalId ?? null}::uuid,
      ${record.provider},${record.externalId},${record.integrationId}::uuid,${record.externalObjectType},
      ${values.mappingStatus},${record.identityKey ?? null},${candidateCanonicalIds}::uuid[],
      ${record.sourceVersion ?? null},${sourceSequence},${JSON.stringify(record.data)}::jsonb,
      ${values.observedHash},${values.canonicalHash ?? null},${observedAt},${observedAt},now(),'fresh',
      ${values.syncStatus},${values.conflictState ?? "none"},${JSON.stringify(record.ownership)}::jsonb,
      ${JSON.stringify(record.provenance ?? {})}::jsonb,${values.providerDeleted ?? false},
      ${values.tombstonedAt ?? null},${record.businessEffectId ?? null}::uuid,now(),now()
    )
    ON CONFLICT (tenant_id,integration_id,external_object_type,external_id) WHERE integration_id IS NOT NULL
    DO UPDATE SET
      entity=EXCLUDED.entity,
      internal_id=EXCLUDED.internal_id,
      provider=EXCLUDED.provider,
      mapping_status=EXCLUDED.mapping_status,
      identity_key=EXCLUDED.identity_key,
      candidate_canonical_ids=EXCLUDED.candidate_canonical_ids,
      source_version=EXCLUDED.source_version,
      source_sequence=EXCLUDED.source_sequence,
      observed_state=EXCLUDED.observed_state,
      observed_hash=EXCLUDED.observed_hash,
      canonical_hash=EXCLUDED.canonical_hash,
      last_observed_at=EXCLUDED.last_observed_at,
      last_successful_sync_at=now(),
      freshness_state='fresh',
      sync_status=EXCLUDED.sync_status,
      conflict_state=EXCLUDED.conflict_state,
      ownership_policy=EXCLUDED.ownership_policy,
      provenance=EXCLUDED.provenance,
      provider_deleted=EXCLUDED.provider_deleted,
      tombstoned_at=EXCLUDED.tombstoned_at,
      last_effect_id=coalesce(EXCLUDED.last_effect_id,finnor_os.external_refs.last_effect_id),
      synced_at=now(),updated_at=now()
    RETURNING id::text
  `);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("source link upsert returned no id");
  return id;
}

async function recordSourceObservation(
  db: Db,
  record: CanonicalSourceRecord,
  result: SourceMaterializationResult,
  observedHash: string,
): Promise<SourceMaterializationResult> {
  const [projection] = await db.select({
    mappingStatus: externalRefs.mappingStatus,
    conflictState: externalRefs.conflictState,
    internalId: externalRefs.internalId,
  }).from(externalRefs).where(and(
    eq(externalRefs.tenantId, record.tenantId),
    eq(externalRefs.id, result.sourceLinkId),
  )).limit(1);
  await db.insert(externalRefObservations).values({
    tenantId: record.tenantId,
    integrationId: record.integrationId,
    sourceLinkId: result.sourceLinkId,
    provider: record.provider,
    externalObjectType: record.externalObjectType,
    externalId: record.externalId,
    canonicalEntityType: record.canonicalEntity,
    canonicalEntityId: result.canonicalEntityId ?? projection?.internalId ?? null,
    sourceVersion: record.sourceVersion ?? null,
    sourceSequence: parseSequence(record.sourceSequence),
    observedAt: parseObservedAt(record.observedAt),
    observedHash,
    observedState: record.data,
    materializationStatus: result.status,
    mappingStatus: projection?.mappingStatus ?? null,
    conflictState: projection?.conflictState ?? null,
    providerDeleted: record.deleted ?? false,
    reason: result.reason ?? null,
    businessEffectId: record.businessEffectId ?? null,
    provenance: record.provenance ?? {},
  });
  return result;
}

async function openReconciliationCase(
  db: Db,
  record: CanonicalSourceRecord,
  sourceLinkId: string,
  caseType: "external_drift" | "mapping_ambiguous",
  classification: string,
  authoritativeSide: "finnor" | "external" | "manual",
  details: Record<string, unknown>,
): Promise<void> {
  const [existing] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(and(
    eq(reconciliationCases.tenantId, record.tenantId),
    eq(reconciliationCases.sourceLinkId, sourceLinkId),
    eq(reconciliationCases.caseType, caseType),
    eq(reconciliationCases.status, "open"),
  )).limit(1);
  if (!existing) {
    await db.insert(reconciliationCases).values({
      tenantId: record.tenantId,
      caseType,
      integrationId: record.integrationId,
      sourceLinkId,
      businessEffectId: record.businessEffectId ?? null,
      classification,
      authoritativeSide,
      details,
    });
  }
  await refreshIntegrationConflictCount(db, record.tenantId, record.integrationId);
}

async function refreshIntegrationConflictCount(db: Db, tenantId: string, integrationId: string): Promise<void> {
  const result = await db.execute<{ count: string | number }>(sql`
    SELECT count(*) AS count FROM finnor_os.reconciliation_cases
    WHERE tenant_id=${tenantId}::uuid AND integration_id=${integrationId}::uuid AND status='open'
  `);
  const unresolvedConflicts = Number(result.rows[0]?.count ?? 0);
  await db.update(tenantIntegrations).set({ unresolvedConflicts, updatedAt: new Date() }).where(and(
    eq(tenantIntegrations.tenantId, tenantId),
    eq(tenantIntegrations.id, integrationId),
  ));
}

async function resolveSourceCases(db: Db, record: CanonicalSourceRecord, sourceLinkId: string): Promise<void> {
  await db.update(reconciliationCases).set({
    status: "resolved",
    resolution: { mechanism: "source_reconciled", observedAt: record.observedAt },
    resolvedAt: new Date(),
  }).where(and(
    eq(reconciliationCases.tenantId, record.tenantId),
    eq(reconciliationCases.integrationId, record.integrationId),
    eq(reconciliationCases.sourceLinkId, sourceLinkId),
    eq(reconciliationCases.status, "open"),
  ));
  await refreshIntegrationConflictCount(db, record.tenantId, record.integrationId);
}

/** Records only the provider identity returned by a successful mutation. This is an
 * acknowledgement link—not an observation—so freshness stays unknown and no effect
 * may become verified until materializeSourceRecord/read-back supplies remote state. */
export async function recordExternalReferenceAcknowledgement(db: Db, params: {
  tenantId: string;
  integrationId: string;
  provider: string;
  canonicalEntity: string;
  canonicalEntityId: string;
  externalObjectType: string;
  externalId: string;
  businessEffectId?: string;
}): Promise<string> {
  const [integration] = await db.select({ id: tenantIntegrations.id, binding: tenantIntegrations.binding }).from(tenantIntegrations).where(and(
    eq(tenantIntegrations.tenantId, params.tenantId),
    eq(tenantIntegrations.id, params.integrationId),
  )).limit(1);
  if (!integration || integration.binding !== params.provider) {
    throw new SourceTruthError("provider_binding_mismatch", "acknowledgement does not match the configured tenant integration/account");
  }
  const [existing] = await db.select({ id: externalRefs.id, internalId: externalRefs.internalId, entity: externalRefs.entity }).from(externalRefs).where(and(
    eq(externalRefs.tenantId, params.tenantId),
    eq(externalRefs.integrationId, params.integrationId),
    eq(externalRefs.externalObjectType, params.externalObjectType),
    eq(externalRefs.externalId, params.externalId),
  )).limit(1);
  if (existing?.entity && existing.entity !== params.canonicalEntity) {
    throw new SourceTruthError("invalid_record", "provider object is already mapped to a different canonical entity type");
  }
  if (existing?.internalId && existing.internalId !== params.canonicalEntityId) {
    throw new SourceTruthError("invalid_record", "provider object is already mapped to a different canonical entity");
  }
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO finnor_os.external_refs(
      tenant_id,entity,internal_id,provider,external_id,integration_id,external_object_type,
      mapping_status,observed_state,freshness_state,sync_status,conflict_state,
      ownership_policy,provenance,last_effect_id,synced_at,updated_at
    ) VALUES (
      ${params.tenantId}::uuid,${params.canonicalEntity},${params.canonicalEntityId}::uuid,
      ${params.provider},${params.externalId},${params.integrationId}::uuid,${params.externalObjectType},
      'mapped','{}'::jsonb,'unknown','acknowledged','none','{}'::jsonb,
      ${JSON.stringify({ acknowledgement: true })}::jsonb,${params.businessEffectId ?? null}::uuid,now(),now()
    )
    ON CONFLICT (tenant_id,integration_id,external_object_type,external_id) WHERE integration_id IS NOT NULL
    DO UPDATE SET internal_id=EXCLUDED.internal_id,entity=EXCLUDED.entity,
      last_effect_id=coalesce(EXCLUDED.last_effect_id,finnor_os.external_refs.last_effect_id),
      synced_at=now(),updated_at=now()
    RETURNING id::text
  `);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("external acknowledgement link returned no id");
  // P2 requires every Microsoft observation to carry an exact source scope,
  // retrievedAt, observation identity, and immutable EvidenceVersion. A write
  // acknowledgement proves none of those facts, so it remains only on the
  // ExternalRef until provider read-back flows through the normal Source Truth
  // materializer. Other legacy providers retain acknowledgement history.
  if (params.provider !== "microsoft_graph") {
    const acknowledgedAt = new Date();
    const acknowledgement = { acknowledgement: true, canonicalEntityId: params.canonicalEntityId };
    await db.insert(externalRefObservations).values({
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      sourceLinkId: id,
      provider: params.provider,
      externalObjectType: params.externalObjectType,
      externalId: params.externalId,
      canonicalEntityType: params.canonicalEntity,
      canonicalEntityId: params.canonicalEntityId,
      observedAt: acknowledgedAt,
      observedHash: sourceTruthHash(acknowledgement),
      observedState: acknowledgement,
      materializationStatus: "acknowledged",
      mappingStatus: "mapped",
      conflictState: "none",
      providerDeleted: false,
      businessEffectId: params.businessEffectId ?? null,
      provenance: { acknowledgement: true },
    });
  }
  return id;
}

/** Materializes one normalized provider observation inside the caller's existing
 * tenant transaction. The external source link and canonical write therefore commit
 * together. It is convergent by provider identity and fail-closed on tenant/account. */
export async function materializeSourceRecord(db: Db, record: CanonicalSourceRecord): Promise<SourceMaterializationResult> {
  if (!record.externalId || !record.externalObjectType || !record.canonicalEntity || !record.sourceScope) {
    throw new SourceTruthError("invalid_record", "source identity fields are required");
  }
  if (!record.ownership || !["finnor", "external", "manual"].includes(record.ownership.default)) {
    throw new SourceTruthError("invalid_record", "an explicit source ownership policy is required");
  }
  if (record.materialization !== "observe_only") {
    if (isRetiredWaterCanonicalEntity(record.canonicalEntity)) throw new RetiredVerticalError("water");
    throw new SourceTruthError("invalid_record", `No active governed source materializer is registered for ${record.canonicalEntity}`);
  }
  const [integration] = await db.select({
    id: tenantIntegrations.id,
    tenantId: tenantIntegrations.tenantId,
    binding: tenantIntegrations.binding,
  }).from(tenantIntegrations).where(and(
    eq(tenantIntegrations.tenantId, record.tenantId),
    eq(tenantIntegrations.id, record.integrationId),
  )).limit(1);
  if (!integration) throw new SourceTruthError("integration_not_found", "configured tenant integration was not found");
  if (integration.tenantId !== record.tenantId) throw new SourceTruthError("cross_tenant_reference", "integration crosses tenant boundary");
  if (integration.binding !== record.provider) {
    throw new SourceTruthError("provider_binding_mismatch", `integration binding ${integration.binding} cannot observe ${record.provider}`);
  }

  const observedAt = parseObservedAt(record.observedAt);
  const sourceSequence = parseSequence(record.sourceSequence);
  const observedHash = sourceTruthHash(record.data);
  const [existing] = await db.select().from(externalRefs).where(and(
    eq(externalRefs.tenantId, record.tenantId),
    eq(externalRefs.integrationId, record.integrationId),
    eq(externalRefs.externalObjectType, record.externalObjectType),
    eq(externalRefs.externalId, record.externalId),
  )).limit(1);
  if (existing?.entity && existing.entity !== record.canonicalEntity) {
    throw new SourceTruthError("invalid_record", "provider object is already mapped to a different canonical entity type");
  }

  if (existing) {
    if (sourceSequence !== null && existing.sourceSequence !== null && sourceSequence < existing.sourceSequence) {
      return recordSourceObservation(db, record, {
        status: "out_of_order", sourceLinkId: existing.id,
        canonicalEntityId: existing.internalId ?? undefined, reason: "provider sequence regressed",
      }, observedHash);
    }
    if (sourceSequence === null && existing.lastObservedAt && observedAt.getTime() < existing.lastObservedAt.getTime()) {
      await db.update(externalRefs).set({ conflictState: "manual_resolution_required", syncStatus: "conflict", updatedAt: new Date() }).where(eq(externalRefs.id, existing.id));
      await openReconciliationCase(db, record, existing.id, "external_drift", "ordering_unprovable", "manual", {
        retainedObservedAt: existing.lastObservedAt.toISOString(), rejectedObservedAt: observedAt.toISOString(),
      });
      return recordSourceObservation(db, record, {
        status: "conflict", sourceLinkId: existing.id,
        canonicalEntityId: existing.internalId ?? undefined, reason: "older event without provider sequence",
      }, observedHash);
    }
    if (existing.observedHash === observedHash && !record.deleted) {
      await db.update(externalRefs).set({
        sourceVersion: record.sourceVersion ?? existing.sourceVersion,
        sourceSequence: sourceSequence ?? existing.sourceSequence,
        lastObservedAt: observedAt,
        lastSuccessfulSyncAt: new Date(),
        freshnessState: "fresh",
        updatedAt: new Date(),
      }).where(eq(externalRefs.id, existing.id));
      return recordSourceObservation(db, record, {
        status: "duplicate", sourceLinkId: existing.id,
        canonicalEntityId: existing.internalId ?? undefined, businessEffectId: record.businessEffectId,
      }, observedHash);
    }
  }

  // Observe-only records still use Source Truth's ordering/conflict semantics.
  // A changed payload at the same provider position cannot be called "newer";
  // retain the source link and open a reconciliation case instead of silently
  // replacing the observation. A strictly newer sequence (or newer timestamp
  // when sequence is unavailable) proceeds below and becomes a new evidence
  // version without touching canonical business state.
  if (record.materialization === "observe_only" && existing?.observedHash && existing.observedHash !== observedHash) {
    const sameProviderPosition = sourceSequence !== null && existing.sourceSequence !== null
      ? sourceSequence === existing.sourceSequence
      : sourceSequence === null && existing.sourceSequence === null && existing.lastObservedAt !== null
        ? observedAt.getTime() === existing.lastObservedAt.getTime()
        : false;
    if (sameProviderPosition) {
      const sourceLinkId = await upsertSourceLink(db, record, {
        internalId: existing.internalId,
        mappingStatus: existing.internalId ? "mapped" : "unresolved",
        observedHash,
        canonicalHash: existing.canonicalHash,
        syncStatus: "conflict",
        conflictState: "divergent",
      });
      await openReconciliationCase(db, record, sourceLinkId, "external_drift", "observe_only_divergent", "manual", {
        previousObservedHash: existing.observedHash,
        observedHash,
        sourceSequence: record.sourceSequence ?? null,
        sourceVersion: record.sourceVersion ?? null,
      });
      return recordSourceObservation(db, record, {
        status: "conflict", sourceLinkId, canonicalEntityId: existing.internalId ?? undefined,
        reason: "changed payload at the same provider position",
      }, observedHash);
    }
  }

  if ((record.candidateCanonicalIds?.length ?? 0) > 1) {
    const sourceLinkId = await upsertSourceLink(db, record, {
      internalId: null,
      mappingStatus: "ambiguous",
      candidateCanonicalIds: record.candidateCanonicalIds,
      observedHash,
      syncStatus: "conflict",
      conflictState: "ambiguous",
    });
    await openReconciliationCase(db, record, sourceLinkId, "mapping_ambiguous", "multiple_deterministic_candidates", "manual", {
      candidateCanonicalIds: record.candidateCanonicalIds,
    });
    return recordSourceObservation(db, record, {
      status: "ambiguous", sourceLinkId, reason: "multiple deterministic candidates",
    }, observedHash);
  }

  let observeOnlyCandidate: string | undefined;
  if (record.materialization === "observe_only") {
    observeOnlyCandidate = record.candidateCanonicalIds?.length === 1
      ? record.candidateCanonicalIds[0]
      : existing?.internalId ?? undefined;
    if (!observeOnlyCandidate) {
      const sourceLinkId = await upsertSourceLink(db, record, {
        internalId: null,
        mappingStatus: "unresolved",
        observedHash,
        canonicalHash: existing?.canonicalHash,
        syncStatus: "failed",
        conflictState: "manual_resolution_required",
      });
      return recordSourceObservation(db, record, {
        status: "unresolved", sourceLinkId, reason: "observe-only source requires one resolved canonical candidate",
      }, observedHash);
    }
    if (existing?.internalId && existing.internalId !== observeOnlyCandidate) {
      throw new SourceTruthError("invalid_record", "observe-only provider object is mapped to a different canonical entity");
    }
    // `observe_only` is public Source Truth vocabulary, so the generic seam must
    // independently prove the candidate is an active-vertical canonical row. PE's
    // vertical mapper performs the stronger exact-Deal check before reaching here.
    const candidate = await db.execute<{ available: boolean; canonical_tenant: string | null }>(sql`
      SELECT scope.available,
        CASE WHEN scope.available THEN finnor_os.canonical_entity_tenant(${record.canonicalEntity}, ${observeOnlyCandidate}::uuid) END::text AS canonical_tenant
      FROM (SELECT finnor_os.canonical_entity_available(${record.tenantId}::uuid, ${record.canonicalEntity}) AS available) scope
    `);
    if (!candidate.rows[0]?.available) {
      throw new SourceTruthError("invalid_record", "observe-only canonical entity is unavailable for the tenant vertical");
    }
    if (candidate.rows[0].canonical_tenant !== record.tenantId) {
      throw new SourceTruthError("cross_tenant_reference", "observe-only canonical candidate crosses tenant boundary or is missing");
    }
  }

  if (record.deleted) {
    const sourceLinkId = await upsertSourceLink(db, record, {
      internalId: existing?.internalId ?? observeOnlyCandidate ?? null,
      mappingStatus: "tombstoned",
      observedHash,
      canonicalHash: existing?.canonicalHash,
      syncStatus: "source_missing",
      providerDeleted: true,
      tombstonedAt: observedAt,
    });
    if (existing?.internalId && record.materialization !== "observe_only") {
      await recordBusinessEvent(db, {
        tenantId: record.tenantId,
        entityType: record.canonicalEntity,
        entityId: existing.internalId,
        eventType: "external_source_tombstoned",
        source: String(record.provider),
        payload: { sourceLinkId, externalObjectType: record.externalObjectType },
      });
    }
    return recordSourceObservation(db, record, {
      status: "tombstoned", sourceLinkId, canonicalEntityId: existing?.internalId ?? observeOnlyCandidate,
    }, observedHash);
  }

  if (record.materialization === "observe_only") {
    const candidate = observeOnlyCandidate!;
    const sourceLinkId = await upsertSourceLink(db, record, {
      internalId: candidate,
      mappingStatus: "mapped",
      observedHash,
      canonicalHash: existing?.canonicalHash,
      syncStatus: "observed",
      conflictState: "none",
    });
    await resolveSourceCases(db, record, sourceLinkId);
    return recordSourceObservation(db, record, {
      status: "observed",
      sourceLinkId,
      canonicalEntityId: candidate,
      canonicalEntityType: record.canonicalEntity,
      businessEffectId: record.businessEffectId,
    }, observedHash);
  }

  throw new SourceTruthError("invalid_record", "Only observe-only source evidence is supported by the active product runtime.");
}

export function freshnessState(lastSuccessfulSyncAt: Date | string | null | undefined, policy: SourceFreshnessPolicy, now = new Date()): SourceFreshnessState {
  if (!lastSuccessfulSyncAt) return "unknown";
  const observed = lastSuccessfulSyncAt instanceof Date ? lastSuccessfulSyncAt : new Date(lastSuccessfulSyncAt);
  if (Number.isNaN(observed.getTime()) || policy.maxAgeSeconds <= 0) return "unknown";
  const ageSeconds = Math.max(0, (now.getTime() - observed.getTime()) / 1000);
  if (ageSeconds <= policy.maxAgeSeconds) return "fresh";
  if (ageSeconds <= policy.maxAgeSeconds * 3) return "stale";
  return "expired";
}

function compareExpected(expected: unknown, observed: unknown, path = ""): Array<{ path: string; expected: unknown; observed: unknown }> {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const actual = observed && typeof observed === "object" && !Array.isArray(observed) ? observed as Record<string, unknown> : {};
    return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) => compareExpected(value, actual[key], path ? `${path}.${key}` : key));
  }
  return sourceTruthHash(expected) === sourceTruthHash(observed) ? [] : [{ path, expected, observed }];
}

/** Exact expected-subset comparison used by read-after-write, polling, and webhook
 * confirmation. Provider HTTP success is deliberately absent from this function. */
export function observeExternalEffect(input: Omit<ExternalEffectObservation, "classification" | "mismatches"> & { definitelyAbsent?: boolean }): ExternalEffectObservation {
  if (input.definitelyAbsent) return { ...input, classification: "absent", mismatches: [] };
  if (!input.observed) return { ...input, classification: "unknown", mismatches: [] };
  const mismatches = compareExpected(input.expected, input.observed);
  return { ...input, classification: mismatches.length === 0 ? "present" : "divergent", mismatches };
}
