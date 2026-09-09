import { createHash } from "node:crypto";
import {
  externalRefObservations,
  externalRefs,
  integrationSourceScopes,
  reconciliationCases,
  tenantIntegrations,
  type Db,
} from "@finnor/db";
import type { ProviderObservation } from "@finnor/shared-types";
import { and, eq, sql } from "drizzle-orm";
import { sourceTruthHash } from "./source-truth";

export type ProviderRootMappingStatus = "mapped" | "unresolved" | "ambiguous";

export interface ProviderObservationCanonicalTarget {
  entityType: string;
  entityId: string;
}

export interface PersistProviderObservationInput {
  observation: ProviderObservation;
  evidenceSourceId: string;
  evidenceVersionId: string;
  canonicalTarget?: ProviderObservationCanonicalTarget | null;
  rootMappingStatus: ProviderRootMappingStatus;
  candidateRootIds?: string[];
  reason?: string;
}

export interface ProviderObservationPersistenceResult {
  status: "observed" | "duplicate" | "conflict" | "out_of_order" | "tombstoned" | "evidence_only" | "ambiguous";
  observationId: string;
  observationKey: string;
  sourceLinkId: string | null;
  materialChanged: boolean;
  canonicalTarget: ProviderObservationCanonicalTarget | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

export function providerObservationKey(observation: ProviderObservation): string {
  return createHash("sha256").update(stableJson({
    tenantId: observation.tenantId,
    integrationId: observation.integrationId,
    sourceScopeId: observation.sourceScopeId,
    provider: observation.provider,
    resourceKind: observation.resourceKind,
    externalObjectType: observation.externalObjectType,
    externalObjectId: observation.externalObjectId,
    providerVersion: observation.providerVersion ?? null,
    providerSequence: observation.providerSequence ?? null,
    observedAt: observation.observedAt,
    deleted: observation.deleted,
    payloadHash: observation.payloadHash,
  })).digest("hex");
}

function parsedDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Provider observation ${label} is invalid`);
  return date;
}

function parsedSequence(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  if (!/^\d+$/.test(value)) throw new Error("Provider sequence must be non-negative decimal text");
  return BigInt(value);
}

function assertBound(value: unknown, maxBytes: number, label: string): void {
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(`Provider observation ${label} exceeds its durable bound`);
}

async function assertObservationBoundary(db: Db, input: PersistProviderObservationInput): Promise<void> {
  const { observation } = input;
  if (!observation.resourceKind.trim() || !observation.externalObjectType.trim() || !observation.externalObjectId.trim() || !observation.traceId.trim()) {
    throw new Error("Provider observation identity and trace fields are required");
  }
  if (!/^[0-9a-f]{64}$/.test(observation.payloadHash) || sourceTruthHash(observation.payload) !== observation.payloadHash) {
    throw new Error("Provider observation payload hash does not match its bounded payload");
  }
  if (observation.externalObjectId.length > 1_024 || observation.externalObjectType.length > 120 || observation.resourceKind.length > 80) {
    throw new Error("Provider observation identity exceeds its durable bound");
  }
  assertBound(observation.payload, 262_144, "payload");
  assertBound(observation.providerMetadata, 32_768, "metadata");
  assertBound(observation.providerParentRefs, 32_768, "parent references");
  const [boundary] = await db.select({
    scopeId: integrationSourceScopes.id,
    scopeEnabled: integrationSourceScopes.enabled,
    scopeProvider: integrationSourceScopes.provider,
    integrationId: tenantIntegrations.id,
    integrationBinding: tenantIntegrations.binding,
  }).from(integrationSourceScopes).innerJoin(tenantIntegrations, and(
    eq(tenantIntegrations.tenantId, observation.tenantId),
    eq(tenantIntegrations.id, integrationSourceScopes.integrationId),
  )).where(and(
    eq(integrationSourceScopes.tenantId, observation.tenantId),
    eq(integrationSourceScopes.id, observation.sourceScopeId),
    eq(integrationSourceScopes.integrationId, observation.integrationId),
  )).limit(1);
  if (!boundary || boundary.integrationBinding !== observation.provider || boundary.scopeProvider !== observation.provider) {
    throw new Error("Provider observation crosses its tenant, integration, provider, or source-scope boundary");
  }
  if (!boundary.scopeEnabled) throw new Error("Disabled Microsoft source scope cannot accept a new provider read");
  if (input.canonicalTarget) {
    const target = await db.execute<{ tenant_id: string | null }>(sql`
      SELECT finnor_os.canonical_entity_tenant(${input.canonicalTarget.entityType}, ${input.canonicalTarget.entityId}::uuid)::text tenant_id
    `);
    if (target.rows[0]?.tenant_id !== observation.tenantId) throw new Error("Provider observation canonical target crosses tenant boundary or is missing");
  }
}

async function upsertProjection(
  db: Db,
  input: PersistProviderObservationInput,
  observedAt: Date,
  retrievedAt: Date,
): Promise<string | null> {
  const { observation, canonicalTarget } = input;
  if (!canonicalTarget) return null;
  // external_refs is a one-to-one canonical identity projection. PE root
  // candidates describe evidence ownership, not alternate identities for a
  // mapped Core object, and therefore never belong on a mapped projection.
  const candidateIds: string[] = [];
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO finnor_os.external_refs(
      tenant_id,entity,internal_id,provider,external_id,integration_id,external_object_type,
      mapping_status,identity_key,candidate_canonical_ids,source_version,source_sequence,
      observed_state,observed_hash,first_observed_at,last_observed_at,last_successful_sync_at,
      freshness_state,sync_status,conflict_state,ownership_policy,provenance,
      provider_deleted,tombstoned_at,synced_at,updated_at
    ) VALUES (
      ${observation.tenantId}::uuid,${canonicalTarget.entityType},${canonicalTarget.entityId}::uuid,
      ${observation.provider},${observation.externalObjectId},${observation.integrationId}::uuid,${observation.externalObjectType},
      ${observation.deleted ? "tombstoned" : "mapped"},
      ${`${observation.resourceKind}:${observation.externalObjectId}`},
      ${`{${candidateIds.join(",")}}`}::uuid[],${observation.providerVersion ?? null},${parsedSequence(observation.providerSequence)},
      ${JSON.stringify(observation.payload)}::jsonb,${observation.payloadHash},${observedAt},${observedAt},${retrievedAt},
      'fresh',${observation.deleted ? "source_missing" : "observed"},'none',
      '{"default":"external","direction":"inbound"}'::jsonb,
      ${JSON.stringify({ schema: "finnor.provider-observation.v1", sourceScopeId: observation.sourceScopeId })}::jsonb,
      ${observation.deleted},${observation.deleted ? observedAt : null},${retrievedAt},${retrievedAt}
    )
    ON CONFLICT (tenant_id,integration_id,external_object_type,external_id) WHERE integration_id IS NOT NULL
    DO UPDATE SET
      entity=EXCLUDED.entity,internal_id=EXCLUDED.internal_id,provider=EXCLUDED.provider,
      mapping_status=EXCLUDED.mapping_status,identity_key=EXCLUDED.identity_key,
      candidate_canonical_ids=EXCLUDED.candidate_canonical_ids,source_version=EXCLUDED.source_version,
      source_sequence=EXCLUDED.source_sequence,observed_state=EXCLUDED.observed_state,
      observed_hash=EXCLUDED.observed_hash,last_observed_at=EXCLUDED.last_observed_at,
      last_successful_sync_at=EXCLUDED.last_successful_sync_at,freshness_state='fresh',
      sync_status=EXCLUDED.sync_status,conflict_state='none',ownership_policy=EXCLUDED.ownership_policy,
      provenance=EXCLUDED.provenance,provider_deleted=EXCLUDED.provider_deleted,
      tombstoned_at=EXCLUDED.tombstoned_at,synced_at=EXCLUDED.synced_at,updated_at=EXCLUDED.updated_at
    RETURNING id::text
  `);
  return result.rows[0]?.id ?? null;
}

async function refreshIntegrationConflictCount(db: Db, tenantId: string, integrationId: string): Promise<void> {
  const rows = await db.execute<{ count: number | string }>(sql`
    SELECT count(*)::int count FROM finnor_os.reconciliation_cases
    WHERE tenant_id=${tenantId}::uuid AND integration_id=${integrationId}::uuid AND status='open'
  `);
  await db.update(tenantIntegrations).set({ unresolvedConflicts: Number(rows.rows[0]?.count ?? 0), updatedAt: new Date() }).where(and(
    eq(tenantIntegrations.tenantId, tenantId),
    eq(tenantIntegrations.id, integrationId),
  ));
}

function providerIdentity(observation: ProviderObservation): string {
  return `${observation.provider}:${observation.resourceKind}:${observation.externalObjectType}:${observation.externalObjectId}`;
}

export async function openProviderReconciliationTx(
  db: Db,
  input: {
    observation: ProviderObservation;
    sourceLinkId?: string | null;
    caseType: "unresolved_world_root" | "mapping_ambiguous" | "coverage_gap" | "provider_permission_drift" | "delete_unverified" | "external_drift";
    classification: string;
    details?: Record<string, unknown>;
  },
): Promise<string> {
  const identity = providerIdentity(input.observation);
  const [existing] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(and(
    eq(reconciliationCases.tenantId, input.observation.tenantId),
    eq(reconciliationCases.integrationId, input.observation.integrationId),
    eq(reconciliationCases.caseType, input.caseType),
    eq(reconciliationCases.status, "open"),
    sql`${reconciliationCases.details}->>'providerIdentity'=${identity}`,
  )).limit(1);
  if (existing) return existing.id;
  const details = {
    providerIdentity: identity,
    sourceScopeId: input.observation.sourceScopeId,
    externalObjectType: input.observation.externalObjectType,
    externalObjectId: input.observation.externalObjectId,
    observationKey: providerObservationKey(input.observation),
    ...input.details,
  };
  assertBound(details, 32_768, "reconciliation details");
  const [created] = await db.insert(reconciliationCases).values({
    tenantId: input.observation.tenantId,
    integrationId: input.observation.integrationId,
    sourceLinkId: input.sourceLinkId ?? null,
    caseType: input.caseType,
    classification: input.classification,
    authoritativeSide: "manual",
    details,
  }).returning({ id: reconciliationCases.id });
  if (!created) throw new Error("Provider reconciliation insert returned no row");
  await refreshIntegrationConflictCount(db, input.observation.tenantId, input.observation.integrationId);
  return created.id;
}

export async function resolveProviderRootReconciliationTx(db: Db, observation: ProviderObservation): Promise<void> {
  const identity = providerIdentity(observation);
  await db.update(reconciliationCases).set({
    status: "resolved",
    resolvedAt: new Date(observation.retrievedAt),
    resolution: { mechanism: "deterministic_provider_root_resolution", observationKey: providerObservationKey(observation) },
  }).where(and(
    eq(reconciliationCases.tenantId, observation.tenantId),
    eq(reconciliationCases.integrationId, observation.integrationId),
    eq(reconciliationCases.status, "open"),
    sql`${reconciliationCases.caseType} IN ('unresolved_world_root','mapping_ambiguous')`,
    sql`${reconciliationCases.details}->>'providerIdentity'=${identity}`,
  ));
  await refreshIntegrationConflictCount(db, observation.tenantId, observation.integrationId);
}

/** Persist the immutable provider boundary and current Source Truth projection in
 * the caller's short tenant transaction. Evidence is already durable in that same
 * transaction; no provider HTTP is permitted here. */
export async function persistProviderObservationTx(
  db: Db,
  input: PersistProviderObservationInput,
): Promise<ProviderObservationPersistenceResult> {
  await assertObservationBoundary(db, input);
  const { observation } = input;
  const observationKey = providerObservationKey(observation);
  const observedAt = parsedDate(observation.observedAt, "observedAt");
  const retrievedAt = parsedDate(observation.retrievedAt, "retrievedAt");
  const [duplicate] = await db.select({
    id: externalRefObservations.id,
    sourceLinkId: externalRefObservations.sourceLinkId,
    canonicalEntityType: externalRefObservations.canonicalEntityType,
    canonicalEntityId: externalRefObservations.canonicalEntityId,
  }).from(externalRefObservations).where(and(
    eq(externalRefObservations.tenantId, observation.tenantId),
    eq(externalRefObservations.integrationId, observation.integrationId),
    eq(externalRefObservations.observationKey, observationKey),
  )).limit(1);
  if (duplicate) {
    let duplicateSourceLinkId = duplicate.sourceLinkId ?? null;
    if (input.canonicalTarget && (!duplicate.canonicalEntityId || !duplicate.canonicalEntityType)) {
      duplicateSourceLinkId = await upsertProjection(db, input, observedAt, retrievedAt);
    } else if (duplicate.sourceLinkId) {
      await db.update(externalRefs).set({ lastSuccessfulSyncAt: retrievedAt, freshnessState: "fresh", syncedAt: retrievedAt, updatedAt: retrievedAt })
        .where(and(eq(externalRefs.tenantId, observation.tenantId), eq(externalRefs.id, duplicate.sourceLinkId)));
    }
    return {
      status: "duplicate",
      observationId: duplicate.id,
      observationKey,
      sourceLinkId: duplicateSourceLinkId,
      materialChanged: false,
      canonicalTarget: input.canonicalTarget ?? (duplicate.canonicalEntityId && duplicate.canonicalEntityType
        ? { entityType: duplicate.canonicalEntityType, entityId: duplicate.canonicalEntityId }
        : null),
    };
  }

  const [projection] = await db.select().from(externalRefs).where(and(
    eq(externalRefs.tenantId, observation.tenantId),
    eq(externalRefs.integrationId, observation.integrationId),
    eq(externalRefs.externalObjectType, observation.externalObjectType),
    eq(externalRefs.externalId, observation.externalObjectId),
  )).limit(1);
  let status: ProviderObservationPersistenceResult["status"] = observation.deleted
    ? "tombstoned"
    : input.rootMappingStatus === "ambiguous"
      ? "ambiguous"
      : input.rootMappingStatus === "mapped" || input.canonicalTarget
        ? "observed"
        : "evidence_only";
  let materialChanged = true;
  let sourceLinkId = projection?.id ?? null;
  if (projection?.observedHash && projection.observedHash !== observation.payloadHash) {
    const existingSequence = projection.sourceSequence;
    const nextSequence = parsedSequence(observation.providerSequence);
    const older = nextSequence !== null && existingSequence !== null
      ? nextSequence < existingSequence
      : nextSequence === null && projection.lastObservedAt !== null && observedAt < projection.lastObservedAt;
    const samePosition = nextSequence !== null && existingSequence !== null
      ? nextSequence === existingSequence
      : nextSequence === null && projection.lastObservedAt !== null && observedAt.getTime() === projection.lastObservedAt.getTime();
    if (older || samePosition) {
      status = older ? "out_of_order" : "conflict";
      materialChanged = false;
      await db.update(externalRefs).set({ syncStatus: "conflict", conflictState: samePosition ? "divergent" : "manual_resolution_required", updatedAt: retrievedAt })
        .where(and(eq(externalRefs.tenantId, observation.tenantId), eq(externalRefs.id, projection.id)));
    }
  }
  if (materialChanged && input.canonicalTarget) {
    if (projection?.internalId && (projection.internalId !== input.canonicalTarget.entityId || projection.entity !== input.canonicalTarget.entityType)) {
      status = "conflict";
      materialChanged = false;
      await db.update(externalRefs).set({ syncStatus: "conflict", conflictState: "ambiguous", updatedAt: retrievedAt })
        .where(and(eq(externalRefs.tenantId, observation.tenantId), eq(externalRefs.id, projection.id)));
    } else {
      sourceLinkId = await upsertProjection(db, input, observedAt, retrievedAt);
    }
  }
  if (!input.canonicalTarget && projection) sourceLinkId = projection.id;
  // Root ambiguity is separate from canonical object identity. A SharePoint file
  // can remain an exact Core Document even while its PE world owner is disputed.
  if (input.rootMappingStatus === "ambiguous" && !input.canonicalTarget && projection) {
    await db.update(externalRefs).set({
      internalId: null,
      mappingStatus: "ambiguous",
      candidateCanonicalIds: input.candidateRootIds ?? [],
      syncStatus: "conflict",
      conflictState: "ambiguous",
      lastSuccessfulSyncAt: retrievedAt,
      updatedAt: retrievedAt,
    }).where(and(eq(externalRefs.tenantId, observation.tenantId), eq(externalRefs.id, projection.id)));
  }
  const [inserted] = await db.insert(externalRefObservations).values({
    tenantId: observation.tenantId,
    integrationId: observation.integrationId,
    sourceScopeId: observation.sourceScopeId,
    sourceLinkId,
    provider: observation.provider,
    resourceKind: observation.resourceKind,
    externalObjectType: observation.externalObjectType,
    externalId: observation.externalObjectId,
    canonicalEntityType: input.canonicalTarget?.entityType ?? null,
    canonicalEntityId: input.canonicalTarget?.entityId ?? null,
    sourceVersion: observation.providerVersion ?? null,
    sourceSequence: parsedSequence(observation.providerSequence),
    observedAt,
    retrievedAt,
    observationKey,
    observedHash: observation.payloadHash,
    observedState: observation.payload,
    providerParentRefs: observation.providerParentRefs,
    providerMetadata: observation.providerMetadata,
    ingestionMode: observation.ingestionMode,
    traceId: observation.traceId,
    evidenceSourceId: input.evidenceSourceId,
    evidenceVersionId: input.evidenceVersionId,
    materializationStatus: status,
    mappingStatus: input.rootMappingStatus,
    conflictState: status === "conflict" ? "divergent" : status === "out_of_order" ? "manual_resolution_required" : input.rootMappingStatus === "ambiguous" ? "ambiguous" : "none",
    providerDeleted: observation.deleted,
    reason: input.reason ?? null,
    provenance: { schema: "finnor.provider-observation.v1", contentTreatment: "untrusted_evidence", instructionEligible: false },
  }).onConflictDoNothing().returning({ id: externalRefObservations.id });
  if (!inserted) {
    const [raced] = await db.select({ id: externalRefObservations.id }).from(externalRefObservations).where(and(
      eq(externalRefObservations.tenantId, observation.tenantId),
      eq(externalRefObservations.integrationId, observation.integrationId),
      eq(externalRefObservations.observationKey, observationKey),
    )).limit(1);
    if (!raced) throw new Error("Provider observation replay claim disappeared");
    return { status: "duplicate", observationId: raced.id, observationKey, sourceLinkId, materialChanged: false, canonicalTarget: input.canonicalTarget ?? null };
  }
  if (status === "conflict" || status === "out_of_order") {
    await openProviderReconciliationTx(db, {
      observation,
      sourceLinkId,
      caseType: "external_drift",
      classification: status === "conflict" ? "same_provider_position_divergent" : "older_provider_observation_without_safe_ordering",
      details: { providerVersion: observation.providerVersion ?? null },
    });
  }
  return { status, observationId: inserted.id, observationKey, sourceLinkId, materialChanged, canonicalTarget: input.canonicalTarget ?? null };
}
