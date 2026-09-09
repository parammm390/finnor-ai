import { randomUUID } from "node:crypto";
import {
  materializeSourceRecord,
  recordExternalReferenceAcknowledgement,
  sourceTruthHash,
  type SourceMaterializationResult,
} from "@finnor/data-platform";
import { withTenant, withTenantTransaction } from "@finnor/db";
import { appendEvidenceVersion, createEvidenceSource } from "@finnor/memory";
import type { CanonicalSourceRecord } from "@finnor/shared-types";
import { attachCanonicalEvidence, attachCanonicalEvidenceToWorld } from "./repository";
import { PE_PROPOSITION_PREDICATES, pePropositionId, peWorldPropositionId, type PePropositionPredicate, type PrivateEquityAssertion } from "./epistemic";
import { PE_ENTITY_TYPES, PeDomainError, type PeEntityRef, type PeMutationContext, type PeWorldRootRef } from "./types";

const PREDICATES = new Set<string>(PE_PROPOSITION_PREDICATES);
const ENTITY_TYPES = new Set<string>(PE_ENTITY_TYPES);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

function assertClaim(claim: PrivateEquityObservationClaim): void {
  if (!PREDICATES.has(claim.predicate)) throw new PeDomainError("PE_INVALID_PROPOSITION", `Unsupported PE proposition ${claim.predicate}`);
  if (claim.maximumAgeMs !== undefined && (!Number.isFinite(claim.maximumAgeMs) || claim.maximumAgeMs < 0 || !claim.freshnessPolicyRef)) {
    throw new PeDomainError("PE_INVALID_FRESHNESS_POLICY", "A PE freshness window requires an explicit policy reference");
  }
}

function normalizedWorldRoot(input: { dealId?: string; worldRoot?: PeWorldRootRef }): { root: PeWorldRootRef; dealId: string | null } {
  const root = input.worldRoot ?? (input.dealId ? { entityType: "pe_deal", entityId: input.dealId } as const : null);
  if (!root) throw new PeDomainError("PE_WORLD_ROOT_REQUIRED", "A Deal or explicit PE world root is required");
  if (input.dealId && (root.entityType !== "pe_deal" || root.entityId !== input.dealId)) {
    throw new PeDomainError("PE_WORLD_ROOT_MISMATCH", "dealId and worldRoot describe different PE worlds");
  }
  return { root, dealId: root.entityType === "pe_deal" ? root.entityId : null };
}

async function assertEntityInWorld(
  ctx: PeMutationContext,
  scope: { dealId?: string; worldRoot?: PeWorldRootRef },
  entity: PeEntityRef,
): Promise<{ root: PeWorldRootRef; dealId: string | null }> {
  if (!ENTITY_TYPES.has(entity.entityType)) throw new PeDomainError("PE_INVALID_REFERENCE", "Unknown PE entity type");
  const normalized = normalizedWorldRoot(scope);
  await withTenantTransaction(ctx.auth.tenantId, {
    userId: ctx.auth.userId,
    readOnly: true,
    isolation: "repeatable read",
  }, async (_db, client) => {
    const result = await client.query<{ root_type: string; root_id: string; deal_id: string | null }>(
      "SELECT root_type,root_id::text,deal_id::text FROM finnor_os.pe_entity_world_root($1,$2::uuid)",
      [entity.entityType, entity.entityId],
    );
    if (result.rows[0]?.root_type !== normalized.root.entityType || result.rows[0]?.root_id !== normalized.root.entityId) {
      throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE entity is not part of the authenticated world root");
    }
  });
  return normalized;
}

export interface PrivateEquityObservationClaim {
  entity: PeEntityRef;
  predicate: PePropositionPredicate;
  value: unknown;
  maximumAgeMs?: number;
  freshnessPolicyRef?: string;
  /** Optional immutable evidence references that this observation explicitly
   * supersedes; the core Epistemic Runtime decides the resulting precedence. */
  supersedesEvidenceRefs?: string[];
}

export interface MapPrivateEquitySourceObservationInput {
  tenantId: string;
  integrationId: string;
  provider: string;
  sourceScope: string;
  externalObjectType: string;
  externalId: string;
  dealId?: string;
  worldRoot?: PeWorldRootRef;
  entity: PeEntityRef;
  claims: PrivateEquityObservationClaim[];
  observedAt: string;
  sourceVersion?: string;
  sourceSequence?: string;
  deleted?: boolean;
  provenance?: Record<string, unknown>;
}

/** Provider-neutral mapping. The record can update Source Truth's observation
 * ledger, but `observe_only` prevents the generic canonical import seam from ever
 * writing a PE lifecycle table. */
export function mapPrivateEquitySourceObservation(input: MapPrivateEquitySourceObservationInput): CanonicalSourceRecord {
  const scope = normalizedWorldRoot(input);
  if (!input.claims.length && !input.deleted) throw new PeDomainError("PE_INVALID_OBSERVATION", "A PE observation needs at least one typed claim");
  if (input.claims.length > 100) throw new PeDomainError("PE_INVALID_OBSERVATION", "A PE observation may contain at most 100 typed claims");
  for (const claim of input.claims) {
    assertClaim(claim);
    if (claim.entity.entityType !== input.entity.entityType || claim.entity.entityId !== input.entity.entityId) {
      throw new PeDomainError("PE_INVALID_OBSERVATION", "Every observation claim must describe the mapped PE entity");
    }
  }
  return {
    tenantId: input.tenantId,
    integrationId: input.integrationId,
    provider: input.provider,
    sourceScope: input.sourceScope,
    externalObjectType: input.externalObjectType,
    externalId: input.externalId,
    canonicalEntity: input.entity.entityType,
    candidateCanonicalIds: [input.entity.entityId],
    identityKey: `${input.entity.entityType}:${input.entity.entityId}`,
    sourceVersion: input.sourceVersion,
    sourceSequence: input.sourceSequence,
    observedAt: input.observedAt,
    deleted: input.deleted,
    data: {
      schema: "finnor.pe.observation.v2",
      ...(scope.dealId ? { dealId: scope.dealId } : {}),
      worldRoot: scope.root,
      entity: input.entity,
      claims: input.claims.map((claim) => ({
        propositionId: scope.root.entityType === "pe_deal"
          ? pePropositionId(scope.root.entityId, claim.entity.entityType, claim.entity.entityId, claim.predicate)
          : peWorldPropositionId(scope.root, claim.entity.entityType, claim.entity.entityId, claim.predicate),
        predicate: claim.predicate,
        value: claim.value,
        ...(claim.maximumAgeMs === undefined ? {} : { maximumAgeMs: claim.maximumAgeMs }),
        ...(claim.freshnessPolicyRef ? { freshnessPolicyRef: claim.freshnessPolicyRef } : {}),
        ...(claim.supersedesEvidenceRefs?.length ? { supersedesEvidenceRefs: [...claim.supersedesEvidenceRefs] } : {}),
      })),
    },
    relationships: { root: { entity: scope.root.entityType, canonicalId: scope.root.entityId, required: true } },
    ownership: { default: "finnor", direction: "inbound" },
    provenance: { ...input.provenance, epistemicOnly: true },
    materialization: "observe_only",
  };
}

export async function recordPrivateEquityProviderAcknowledgement(ctx: PeMutationContext, input: {
  dealId?: string;
  worldRoot?: PeWorldRootRef;
  entity: PeEntityRef;
  integrationId: string;
  provider: string;
  externalObjectType: string;
  externalId: string;
  businessEffectId?: string;
}): Promise<string> {
  await assertEntityInWorld(ctx, input, input.entity);
  return withTenant(ctx.auth.tenantId, (db) => recordExternalReferenceAcknowledgement(db, {
    tenantId: ctx.auth.tenantId,
    integrationId: input.integrationId,
    provider: input.provider,
    canonicalEntity: input.entity.entityType,
    canonicalEntityId: input.entity.entityId,
    externalObjectType: input.externalObjectType,
    externalId: input.externalId,
    businessEffectId: input.businessEffectId,
  }), ctx.auth.userId);
}

export interface PrivateEquityObservationReceipt {
  materialization: SourceMaterializationResult;
  evidenceSourceId: string | null;
  evidenceVersionId: string | null;
  contentHash: string | null;
}

export interface PrivateEquityAssertionSourceRow {
  source_id: string;
  version_id: string;
  source_type: string;
  as_of: Date;
  retrieved_at: Date;
  snapshot: Record<string, unknown>;
}

export function privateEquityAssertionsFromRows(
  rows: PrivateEquityAssertionSourceRow[],
  limit: number,
  root: PeWorldRootRef,
): PrivateEquityAssertion[] {
  const assertions: PrivateEquityAssertion[] = [];
  for (const row of rows) {
    const snapshotRoot = row.snapshot?.worldRoot as Record<string, unknown> | undefined;
    const legacyDealMatch = root.entityType === "pe_deal" && row.snapshot?.dealId === root.entityId;
    if (!legacyDealMatch && (snapshotRoot?.entityType !== root.entityType || snapshotRoot?.entityId !== root.entityId)) continue;
    const claims = Array.isArray(row.snapshot?.claims) ? row.snapshot.claims : [];
    for (const claim of claims) {
      if (!claim || typeof claim !== "object") continue;
      const value = claim as Record<string, unknown>;
      if (typeof value.propositionId !== "string" || typeof value.predicate !== "string" || !PREDICATES.has(value.predicate)) continue;
      assertions.push({
        propositionId: value.propositionId,
        kind: row.source_type === "pe_provider_observation" ? "provider_observation" : "document_claim",
        value: value.value as never,
        ref: `evidence-source:${row.source_id}:version:${row.version_id}`,
        observedAt: row.as_of.toISOString(),
        ingestedAt: row.retrieved_at.toISOString(),
        ...(typeof value.maximumAgeMs === "number" ? { maximumAgeMs: value.maximumAgeMs } : {}),
        ...(typeof value.freshnessPolicyRef === "string" ? { freshnessPolicyRef: value.freshnessPolicyRef } : {}),
        ...(Array.isArray(value.supersedesEvidenceRefs) && value.supersedesEvidenceRefs.every((ref) => typeof ref === "string")
          ? { supersedesEvidenceRefs: value.supersedesEvidenceRefs as string[] }
          : {}),
      });
      if (assertions.length >= limit) return assertions.slice(0, limit);
    }
  }
  return assertions;
}

export async function recordPrivateEquitySourceObservation(
  ctx: PeMutationContext,
  input: Omit<MapPrivateEquitySourceObservationInput, "tenantId">,
): Promise<PrivateEquityObservationReceipt> {
  const scope = await assertEntityInWorld(ctx, input, input.entity);
  const record = mapPrivateEquitySourceObservation({ ...input, tenantId: ctx.auth.tenantId });
  const materialization = await withTenant(ctx.auth.tenantId, (db) => materializeSourceRecord(db, record), ctx.auth.userId);
  if (["out_of_order", "conflict", "ambiguous", "unresolved", "tombstoned"].includes(materialization.status)) {
    return { materialization, evidenceSourceId: null, evidenceVersionId: null, contentHash: null };
  }
  const sourceKey = `pe-provider:${input.integrationId}:${input.externalObjectType}:${input.externalId}`;
  const evidenceSource = await createEvidenceSource(ctx.auth.tenantId, {
    sourceKey,
    sourceType: "pe_provider_observation",
    title: `PE provider observation ${input.externalObjectType}/${input.externalId}`,
    publisher: input.provider,
    metadata: { integrationId: input.integrationId, worldRoot: scope.root, entity: input.entity },
  });
  const content = stableJson(record.data);
  const version = await appendEvidenceVersion(ctx.auth.tenantId, evidenceSource.id, {
    content,
    snapshot: record.data,
    asOf: new Date(input.observedAt),
    retrievedAt: new Date(),
    entityRefs: [{ type: input.entity.entityType, id: input.entity.entityId }],
  });
  if (scope.root.entityType === "pe_deal") {
    await attachCanonicalEvidence(ctx, {
      dealId: scope.root.entityId, entity: input.entity, evidenceSourceId: evidenceSource.id,
      evidenceVersionId: version.versionId, relationship: "supports",
    });
  } else {
    await attachCanonicalEvidenceToWorld(ctx, {
      worldRoot: scope.root, entity: input.entity, evidenceSourceId: evidenceSource.id,
      evidenceVersionId: version.versionId, relationship: "supports",
    });
  }
  return {
    materialization,
    evidenceSourceId: evidenceSource.id,
    evidenceVersionId: version.versionId,
    contentHash: version.contentHash,
  };
}

export async function recordPrivateEquityDocumentClaim(ctx: PeMutationContext, input: {
  dealId?: string;
  worldRoot?: PeWorldRootRef;
  entity: PeEntityRef;
  documentId: string;
  predicate: PePropositionPredicate;
  value: unknown;
  observedAt?: string;
  maximumAgeMs?: number;
  freshnessPolicyRef?: string;
  supersedesEvidenceRefs?: string[];
}): Promise<{ evidenceSourceId: string; evidenceVersionId: string; contentHash: string }> {
  assertClaim({
    entity: input.entity,
    predicate: input.predicate,
    value: input.value,
    maximumAgeMs: input.maximumAgeMs,
    freshnessPolicyRef: input.freshnessPolicyRef,
    supersedesEvidenceRefs: input.supersedesEvidenceRefs,
  });
  const scope = await assertEntityInWorld(ctx, input, input.entity);
  await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, async (_db, client) => {
    const linked = await client.query(
      `SELECT 1 FROM finnor_os.pe_document_links
        WHERE tenant_id=$1 AND world_root_type=$2 AND world_root_id=$3
          AND entity_type=$4 AND entity_id=$5 AND document_id=$6
          AND archived_at IS NULL LIMIT 1`,
      [ctx.auth.tenantId, scope.root.entityType, scope.root.entityId,
        input.entity.entityType, input.entity.entityId, input.documentId],
    );
    if (!linked.rows[0]) throw new PeDomainError("PE_DOCUMENT_NOT_LINKED", "Document claim requires an exact canonical PE Document link");
  });
  const propositionId = scope.root.entityType === "pe_deal"
    ? pePropositionId(scope.root.entityId, input.entity.entityType, input.entity.entityId, input.predicate)
    : peWorldPropositionId(scope.root, input.entity.entityType, input.entity.entityId, input.predicate);
  const snapshot = {
    schema: "finnor.pe.document-claim.v1",
    ...(scope.dealId ? { dealId: scope.dealId } : {}),
    worldRoot: scope.root,
    entity: input.entity,
    documentId: input.documentId,
    claims: [{
      propositionId,
      predicate: input.predicate,
      value: input.value,
      ...(input.maximumAgeMs === undefined ? {} : { maximumAgeMs: input.maximumAgeMs }),
      ...(input.freshnessPolicyRef ? { freshnessPolicyRef: input.freshnessPolicyRef } : {}),
      ...(input.supersedesEvidenceRefs?.length ? { supersedesEvidenceRefs: [...input.supersedesEvidenceRefs] } : {}),
    }],
  };
  const source = await createEvidenceSource(ctx.auth.tenantId, {
    sourceKey: `pe-document:${input.documentId}:${input.entity.entityType}:${input.entity.entityId}`,
    sourceType: "pe_document_claim",
    title: `PE document claim ${input.documentId}`,
    metadata: { worldRoot: scope.root, entity: input.entity, documentId: input.documentId },
  });
  const version = await appendEvidenceVersion(ctx.auth.tenantId, source.id, {
    content: stableJson(snapshot),
    snapshot,
    asOf: new Date(input.observedAt ?? new Date().toISOString()),
    retrievedAt: new Date(),
    entityRefs: [{ type: input.entity.entityType, id: input.entity.entityId }],
  });
  if (scope.root.entityType === "pe_deal") {
    await attachCanonicalEvidence(ctx, {
      dealId: scope.root.entityId, entity: input.entity, evidenceSourceId: source.id,
      evidenceVersionId: version.versionId, relationship: "supports",
    });
  } else {
    await attachCanonicalEvidenceToWorld(ctx, {
      worldRoot: scope.root, entity: input.entity, evidenceSourceId: source.id,
      evidenceVersionId: version.versionId, relationship: "supports",
    });
  }
  return { evidenceSourceId: source.id, evidenceVersionId: version.versionId, contentHash: version.contentHash };
}

export async function loadPrivateEquityAssertions(
  ctx: PeMutationContext,
  dealId: string,
  limit = 200,
  asOf = new Date(),
): Promise<PrivateEquityAssertion[]> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return withTenantTransaction(ctx.auth.tenantId, {
    userId: ctx.auth.userId,
    readOnly: true,
    isolation: "repeatable read",
  }, async (_db, client) => {
    const rows = await client.query<PrivateEquityAssertionSourceRow>(
      `SELECT s.id::text source_id,v.id::text version_id,s.source_type,v.as_of,v.retrieved_at,v.snapshot
         FROM finnor_os.pe_evidence_links l
         JOIN finnor_os.evidence_sources s ON s.tenant_id=l.tenant_id AND s.id=l.evidence_source_id
         JOIN finnor_os.evidence_source_versions v ON v.tenant_id=l.tenant_id AND v.id=l.evidence_version_id
        WHERE l.tenant_id=$1 AND l.deal_id=$2 AND l.archived_at IS NULL
          AND s.source_type IN ('pe_provider_observation','pe_document_claim')
          AND v.as_of <= $3 AND v.retrieved_at <= $3
        ORDER BY v.as_of,v.id LIMIT $4`,
      [ctx.auth.tenantId, dealId, asOf, boundedLimit],
    );
    return privateEquityAssertionsFromRows(rows.rows, boundedLimit, { entityType: "pe_deal", entityId: dealId });
  });
}

export async function loadPrivateEquityWorldAssertions(
  ctx: PeMutationContext,
  root: PeWorldRootRef,
  limit = 200,
  asOf = new Date(),
): Promise<PrivateEquityAssertion[]> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return withTenantTransaction(ctx.auth.tenantId, {
    userId: ctx.auth.userId,
    readOnly: true,
    isolation: "repeatable read",
  }, async (_db, client) => {
    const rows = await client.query<PrivateEquityAssertionSourceRow>(
      `SELECT s.id::text source_id,v.id::text version_id,s.source_type,v.as_of,v.retrieved_at,v.snapshot
         FROM finnor_os.pe_evidence_links l
         JOIN finnor_os.evidence_sources s ON s.tenant_id=l.tenant_id AND s.id=l.evidence_source_id
         JOIN finnor_os.evidence_source_versions v ON v.tenant_id=l.tenant_id AND v.id=l.evidence_version_id
        WHERE l.tenant_id=$1 AND l.world_root_type=$2 AND l.world_root_id=$3
          AND l.archived_at IS NULL
          AND s.source_type IN ('pe_provider_observation','pe_document_claim')
          AND v.as_of <= $4 AND v.retrieved_at <= $4
        ORDER BY v.as_of,v.id LIMIT $5`,
      [ctx.auth.tenantId, root.entityType, root.entityId, asOf, boundedLimit],
    );
    return privateEquityAssertionsFromRows(rows.rows, boundedLimit, root);
  });
}

/** Loads one exact, tenant-owned evidence snapshot for a proposed mutation. This
 * does not attach or promote it; the normal Epistemic Runtime still determines
 * whether its claims are known, stale, or conflicting. */
export async function loadPrivateEquityAssertionsForEvidence(
  ctx: PeMutationContext,
  dealId: string,
  evidenceSourceId: string,
  evidenceVersionId?: string,
  asOf = new Date(),
): Promise<PrivateEquityAssertion[]> {
  return withTenantTransaction(ctx.auth.tenantId, {
    userId: ctx.auth.userId,
    readOnly: true,
    isolation: "repeatable read",
  }, async (_db, client) => {
    const rows = await client.query<PrivateEquityAssertionSourceRow>(
      `SELECT s.id::text source_id,v.id::text version_id,s.source_type,v.as_of,v.retrieved_at,v.snapshot
         FROM finnor_os.evidence_sources s
         JOIN finnor_os.evidence_source_versions v
           ON v.tenant_id=s.tenant_id AND v.source_id=s.id
        WHERE s.tenant_id=$1 AND s.scope='tenant' AND s.id=$2::uuid
          AND s.source_type IN ('pe_provider_observation','pe_document_claim')
          AND ($3::uuid IS NULL OR v.id=$3::uuid) AND v.as_of <= $4 AND v.retrieved_at <= $4
        ORDER BY v.version_number DESC,v.id DESC LIMIT 1`,
      [ctx.auth.tenantId, evidenceSourceId, evidenceVersionId ?? null, asOf],
    );
    return privateEquityAssertionsFromRows(rows.rows, 100, { entityType: "pe_deal", entityId: dealId });
  });
}

export function privateEquityObservationFingerprint(input: MapPrivateEquitySourceObservationInput): string {
  return sourceTruthHash(mapPrivateEquitySourceObservation(input));
}

export function privateEquityUserAssertion(input: {
  dealId: string;
  entity: PeEntityRef;
  predicate: PePropositionPredicate;
  value: unknown;
  inputRef?: string;
  observedAt?: string;
  supersedesEvidenceRefs?: string[];
}): PrivateEquityAssertion {
  assertClaim({ entity: input.entity, predicate: input.predicate, value: input.value });
  return {
    propositionId: pePropositionId(input.dealId, input.entity.entityType, input.entity.entityId, input.predicate),
    kind: "user_input",
    value: input.value as never,
    ref: input.inputRef ?? `pe-user-input:${randomUUID()}`,
    observedAt: input.observedAt ?? new Date().toISOString(),
    ...(input.supersedesEvidenceRefs?.length ? { supersedesEvidenceRefs: [...input.supersedesEvidenceRefs] } : {}),
  };
}
