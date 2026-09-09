import { createHash } from "node:crypto";
import {
  ensureProviderDocumentTx,
  openProviderReconciliationTx,
  persistProviderObservationTx,
  providerObservationKey,
  recordBusinessEvent,
  resolveProviderRootReconciliationTx,
  type ProviderObservationPersistenceResult,
} from "@finnor/data-platform";
import {
  evidenceSources,
  externalRefs,
  ingestIntegrationEventTx,
  integrationSourceScopes,
  providerObjectRootBindings,
  type Db,
} from "@finnor/db";
import { appendEvidenceVersionTx, createEvidenceSourceTx } from "@finnor/memory";
import type { ProviderObservation, ProviderObservationParentRef } from "@finnor/shared-types";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PoolClient } from "pg";
import { attachDocumentTx, attachEvidenceTx, peTransaction } from "./repository";
import { PE_ENTITY_TYPES, PeDomainError, type PeEntityRef, type PeMutationContext, type PeWorldRootRef } from "./types";

const ROOT_TYPES = new Set<PeWorldRootRef["entityType"]>(["pe_strategy", "pe_opportunity", "pe_deal"]);
const PE_TYPES = new Set<string>(PE_ENTITY_TYPES);
const MAX_PARENT_REFS = 64;

interface RootCandidate {
  root: PeWorldRootRef;
  proofs: Set<string>;
}

interface RootResolution {
  status: "mapped" | "unresolved" | "ambiguous";
  root: PeWorldRootRef | null;
  candidates: Array<{ root: PeWorldRootRef; proofs: string[] }>;
}

interface CanonicalReference {
  entityType: string;
  entityId: string;
}

export interface Microsoft365EvidenceObservationReceipt {
  persistence: ProviderObservationPersistenceResult;
  evidenceSourceId: string;
  evidenceVersionId: string;
  evidenceContentHash: string;
  documentId: string | null;
  rootResolution: RootResolution;
  evidenceAttached: boolean;
  documentAttached: boolean;
  businessEventType: string | null;
  integrationEventId: string | null;
  matchedWaitIds: string[];
  wakeClaimIds: string[];
  reconciliationCaseId: string | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

function parsedDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PeDomainError("PE_INVALID_OBSERVATION", `${label} must be an ISO timestamp`);
  return parsed;
}

function boundedText(value: unknown, fallback: string, max = 1_000): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, max);
}

function addCandidate(
  candidates: Map<string, RootCandidate>,
  rootType: string | null | undefined,
  rootId: string | null | undefined,
  proof: string,
): void {
  if (!rootId || !ROOT_TYPES.has(rootType as PeWorldRootRef["entityType"])) return;
  const root = { entityType: rootType as PeWorldRootRef["entityType"], entityId: rootId };
  const key = `${root.entityType}:${root.entityId}`;
  const current = candidates.get(key);
  if (current) current.proofs.add(proof);
  else candidates.set(key, { root, proofs: new Set([proof]) });
}

export function providerEvidenceSourceKey(observation: Pick<ProviderObservation,
  "tenantId" | "integrationId" | "provider" | "resourceKind" | "externalObjectType" | "externalObjectId"
>): string {
  const digest = createHash("sha256").update(stableJson({
    tenantId: observation.tenantId,
    integrationId: observation.integrationId,
    provider: observation.provider,
    resourceKind: observation.resourceKind,
    externalObjectType: observation.externalObjectType,
    externalObjectId: observation.externalObjectId,
  })).digest("hex");
  return `provider-observation:${digest}`;
}

function evidenceSnapshot(observation: ProviderObservation): Record<string, unknown> {
  return {
    schema: "finnor.provider-evidence-observation.v1",
    provider: observation.provider,
    integrationId: observation.integrationId,
    sourceScopeId: observation.sourceScopeId,
    resourceKind: observation.resourceKind,
    externalObjectType: observation.externalObjectType,
    externalObjectId: observation.externalObjectId,
    providerParentRefs: observation.providerParentRefs,
    providerVersion: observation.providerVersion ?? null,
    providerSequence: observation.providerSequence ?? null,
    observedAt: observation.observedAt,
    deleted: observation.deleted,
    payloadHash: observation.payloadHash,
    payload: observation.payload,
    providerMetadata: observation.providerMetadata,
    contentTreatment: "untrusted_evidence",
    instructionEligible: false,
  };
}

async function exactCanonicalReferences(
  db: Db,
  observation: ProviderObservation,
  identity: Pick<ProviderObservation, "externalObjectType" | "externalObjectId">,
): Promise<CanonicalReference[]> {
  const rows = await db.select({
    entityType: externalRefs.entity,
    entityId: externalRefs.internalId,
  }).from(externalRefs).where(and(
    eq(externalRefs.tenantId, observation.tenantId),
    eq(externalRefs.integrationId, observation.integrationId),
    eq(externalRefs.provider, observation.provider),
    eq(externalRefs.externalObjectType, identity.externalObjectType),
    eq(externalRefs.externalId, identity.externalObjectId),
    eq(externalRefs.mappingStatus, "mapped"),
  ));
  return rows.flatMap((row) => row.entityId ? [{ entityType: row.entityType, entityId: row.entityId }] : []);
}

async function addDocumentRoots(
  client: PoolClient,
  tenantId: string,
  documentId: string,
  candidates: Map<string, RootCandidate>,
  proof: string,
): Promise<void> {
  const links = await client.query<{ world_root_type: string; world_root_id: string }>(
    `SELECT world_root_type,world_root_id::text
       FROM finnor_os.pe_document_links
      WHERE tenant_id=$1 AND document_id=$2::uuid AND archived_at IS NULL`,
    [tenantId, documentId],
  );
  for (const row of links.rows) addCandidate(candidates, row.world_root_type, row.world_root_id, proof);
}

async function addEvidenceRoots(
  client: PoolClient,
  tenantId: string,
  evidenceSourceId: string,
  candidates: Map<string, RootCandidate>,
  proof: string,
): Promise<void> {
  const links = await client.query<{ world_root_type: string; world_root_id: string }>(
    `SELECT world_root_type,world_root_id::text
       FROM finnor_os.pe_evidence_links
      WHERE tenant_id=$1 AND evidence_source_id=$2::uuid AND archived_at IS NULL`,
    [tenantId, evidenceSourceId],
  );
  for (const row of links.rows) addCandidate(candidates, row.world_root_type, row.world_root_id, proof);
}

async function addCanonicalReferenceRoot(
  client: PoolClient,
  tenantId: string,
  reference: CanonicalReference,
  candidates: Map<string, RootCandidate>,
  proof: string,
): Promise<void> {
  if (reference.entityType === "document") {
    await addDocumentRoots(client, tenantId, reference.entityId, candidates, `${proof}:document_link`);
    return;
  }
  if (!PE_TYPES.has(reference.entityType)) return;
  const roots = await client.query<{ root_type: string; root_id: string }>(
    "SELECT root_type,root_id::text FROM finnor_os.pe_entity_world_root($1,$2::uuid)",
    [reference.entityType, reference.entityId],
  );
  for (const row of roots.rows) addCandidate(candidates, row.root_type, row.root_id, proof);
}

async function addBindingRoots(
  db: Db,
  observation: ProviderObservation,
  identity: Pick<ProviderObservation, "resourceKind" | "externalObjectType" | "externalObjectId">,
  levels: Array<"object" | "document" | "parent" | "thread" | "series" | "meeting">,
  candidates: Map<string, RootCandidate>,
  proof: string,
): Promise<void> {
  const bindings = await db.select({
    worldRootType: providerObjectRootBindings.worldRootType,
    worldRootId: providerObjectRootBindings.worldRootId,
    bindingLevel: providerObjectRootBindings.bindingLevel,
  }).from(providerObjectRootBindings).where(and(
    eq(providerObjectRootBindings.tenantId, observation.tenantId),
    eq(providerObjectRootBindings.integrationId, observation.integrationId),
    eq(providerObjectRootBindings.provider, observation.provider),
    eq(providerObjectRootBindings.resourceKind, identity.resourceKind),
    eq(providerObjectRootBindings.externalObjectType, identity.externalObjectType),
    eq(providerObjectRootBindings.externalObjectId, identity.externalObjectId),
    inArray(providerObjectRootBindings.bindingLevel, levels),
    isNull(providerObjectRootBindings.supersededAt),
  ));
  for (const row of bindings) {
    addCandidate(candidates, row.worldRootType, row.worldRootId, `${proof}:${row.bindingLevel}`);
  }
}

function parentBindingLevel(parent: ProviderObservationParentRef): "parent" | "thread" | "series" | "meeting" {
  if (parent.relationship === "thread") return "thread";
  if (parent.relationship === "series") return "series";
  if (parent.relationship === "meeting") return "meeting";
  return "parent";
}

async function addEvidenceIdentityRoots(
  db: Db,
  client: PoolClient,
  observation: ProviderObservation,
  identity: Pick<ProviderObservation, "resourceKind" | "externalObjectType" | "externalObjectId">,
  candidates: Map<string, RootCandidate>,
  proof: string,
): Promise<void> {
  const sourceKey = providerEvidenceSourceKey({
    tenantId: observation.tenantId,
    integrationId: observation.integrationId,
    provider: observation.provider,
    ...identity,
  });
  const [source] = await db.select({ id: evidenceSources.id }).from(evidenceSources).where(and(
    eq(evidenceSources.scope, "tenant"),
    eq(evidenceSources.tenantId, observation.tenantId),
    eq(evidenceSources.sourceKey, sourceKey),
  )).limit(1);
  if (source) await addEvidenceRoots(client, observation.tenantId, source.id, candidates, proof);
}

async function addExactParentRelationshipRoots(
  client: PoolClient,
  observation: ProviderObservation,
  parent: ProviderObservationParentRef,
  candidates: Map<string, RootCandidate>,
  proof: string,
): Promise<void> {
  // Some exact provider relationships (Outlook conversation IDs and the
  // calendar/transcript meeting join identity) are shared parent identities,
  // not standalone observed objects. Inherit only through a prior observation
  // carrying the exact same provider parent tuple and an existing PE evidence
  // link. Distinct roots are all returned and therefore become AMBIGUOUS.
  const linked = await client.query<{ world_root_type: string; world_root_id: string }>(
    `SELECT DISTINCT l.world_root_type,l.world_root_id::text
       FROM finnor_os.external_ref_observations o
       JOIN finnor_os.pe_evidence_links l
         ON l.tenant_id=o.tenant_id
        AND l.evidence_source_id=o.evidence_source_id
        AND l.archived_at IS NULL
      WHERE o.tenant_id=$1::uuid
        AND o.integration_id=$2::uuid
        AND o.provider=$3
        AND o.provider_parent_refs @> $4::jsonb`,
    [observation.tenantId, observation.integrationId, observation.provider, JSON.stringify([parent])],
  );
  for (const row of linked.rows) addCandidate(candidates, row.world_root_type, row.world_root_id, proof);
}

async function validateCandidateRoots(
  client: PoolClient,
  tenantId: string,
  candidates: Map<string, RootCandidate>,
): Promise<void> {
  for (const candidate of candidates.values()) {
    const result = await client.query<{ tenant_id: string | null }>(
      "SELECT finnor_os.canonical_entity_tenant($1,$2::uuid)::text tenant_id",
      [candidate.root.entityType, candidate.root.entityId],
    );
    if (result.rows[0]?.tenant_id !== tenantId) {
      throw new PeDomainError("PE_CROSS_TENANT_REFERENCE", "Provider root proof crosses tenant boundary or the root is missing");
    }
  }
}

async function resolveRootTx(
  db: Db,
  client: PoolClient,
  observation: ProviderObservation,
  evidenceSourceId: string,
  documentId: string | null,
): Promise<RootResolution> {
  const candidates = new Map<string, RootCandidate>();

  // 1. Exact object/document binding.
  await addBindingRoots(db, observation, observation, ["object", "document"], candidates, "exact_object_binding");

  // 2. Exact Core Document/provider reference/evidence link.
  if (documentId) await addDocumentRoots(client, observation.tenantId, documentId, candidates, "exact_core_document_link");
  const directReferences = await exactCanonicalReferences(db, observation, observation);
  for (const reference of directReferences) {
    await addCanonicalReferenceRoot(client, observation.tenantId, reference, candidates, "exact_external_ref");
  }
  await addEvidenceRoots(client, observation.tenantId, evidenceSourceId, candidates, "existing_evidence_link");

  // 3. Exact parent/thread/series/meeting inheritance. Every proof is retained;
  // disagreement at any deterministic level is ambiguity, never precedence guessing.
  for (const parent of observation.providerParentRefs) {
    const level = parentBindingLevel(parent);
    await addBindingRoots(db, observation, parent, [level], candidates, `exact_${parent.relationship}_binding`);
    const parentReferences = await exactCanonicalReferences(db, observation, parent);
    for (const reference of parentReferences) {
      await addCanonicalReferenceRoot(client, observation.tenantId, reference, candidates, `exact_${parent.relationship}_external_ref`);
    }
    await addEvidenceIdentityRoots(db, client, observation, parent, candidates, `exact_${parent.relationship}_evidence_link`);
    await addExactParentRelationshipRoots(client, observation, parent, candidates, `exact_${parent.relationship}_observed_relationship`);
  }

  // 4. A root is inherited from the source scope only when the whole configured
  // source was explicitly dedicated to that world.
  const [scope] = await db.select({
    rootBindingType: integrationSourceScopes.rootBindingType,
    rootBindingId: integrationSourceScopes.rootBindingId,
  }).from(integrationSourceScopes).where(and(
    eq(integrationSourceScopes.tenantId, observation.tenantId),
    eq(integrationSourceScopes.integrationId, observation.integrationId),
    eq(integrationSourceScopes.id, observation.sourceScopeId),
    eq(integrationSourceScopes.provider, observation.provider),
    eq(integrationSourceScopes.enabled, true),
  )).limit(1);
  addCandidate(candidates, scope?.rootBindingType, scope?.rootBindingId, "dedicated_source_scope");

  await validateCandidateRoots(client, observation.tenantId, candidates);
  const resolved = [...candidates.values()].map((candidate) => ({
    root: candidate.root,
    proofs: [...candidate.proofs].sort(),
  })).sort((left, right) => `${left.root.entityType}:${left.root.entityId}`.localeCompare(`${right.root.entityType}:${right.root.entityId}`));
  if (resolved.length === 0) return { status: "unresolved", root: null, candidates: [] };
  if (resolved.length > 1) return { status: "ambiguous", root: null, candidates: resolved };
  return { status: "mapped", root: resolved[0]!.root, candidates: resolved };
}

function existingDocumentId(references: CanonicalReference[]): string | null {
  const documents = [...new Set(references.filter((reference) => reference.entityType === "document").map((reference) => reference.entityId))];
  if (documents.length > 1) throw new PeDomainError("PE_AMBIGUOUS_PROVIDER_IDENTITY", "Provider object maps to multiple Core Documents");
  return documents[0] ?? null;
}

function eventTypeFor(observation: ProviderObservation, versionNumber: number): string {
  if (observation.deleted) return "external_evidence_deleted";
  return versionNumber > 1 ? "external_evidence_changed" : "external_evidence_observed";
}

function providerConversationId(observation: ProviderObservation): string | null {
  return observation.providerParentRefs.find((ref) => ["thread", "series", "meeting"].includes(ref.relationship))?.externalObjectId ?? null;
}

/** Faithful PE evidence ingestion for Microsoft Graph observations. Graph transport
 * is complete before this short transaction starts. It never manufactures claims,
 * lifecycle state, people, Work, or a PE root. */
export async function recordPrivateEquityProviderEvidenceObservation(
  ctx: PeMutationContext,
  observation: ProviderObservation,
): Promise<Microsoft365EvidenceObservationReceipt> {
  if (observation.tenantId !== ctx.auth.tenantId) {
    throw new PeDomainError("PE_CROSS_TENANT_REFERENCE", "Provider observation tenant does not match the authenticated PE tenant");
  }
  if (observation.provider !== "microsoft_graph") {
    throw new PeDomainError("PE_PROVIDER_UNSUPPORTED", "PE Microsoft evidence mapping requires provider microsoft_graph");
  }
  if (observation.providerParentRefs.length > MAX_PARENT_REFS) {
    throw new PeDomainError("PE_INVALID_OBSERVATION", `Provider observation may contain at most ${MAX_PARENT_REFS} parent references`);
  }
  const observedAt = parsedDate(observation.observedAt, "observedAt");
  const retrievedAt = parsedDate(observation.retrievedAt, "retrievedAt");
  const transactionContext: PeMutationContext = {
    auth: ctx.auth,
    provenance: {
      sourceSystem: observation.provider,
      externalId: observation.externalObjectId,
      createdBy: ctx.provenance?.createdBy ?? ctx.auth.employeeId ?? ctx.auth.userId,
      observedAt,
    },
  };

  return peTransaction(transactionContext, async (db, client) => {
    const source = await createEvidenceSourceTx(db, observation.tenantId, {
      sourceKey: providerEvidenceSourceKey(observation),
      sourceType: "provider_observation",
      title: `${observation.provider} ${observation.resourceKind} evidence`,
      publisher: observation.provider,
      metadata: {
        schema: "finnor.provider-evidence-source.v1",
        integrationId: observation.integrationId,
        sourceScopeId: observation.sourceScopeId,
        resourceKind: observation.resourceKind,
        externalObjectType: observation.externalObjectType,
        externalObjectId: observation.externalObjectId,
        contentTreatment: "untrusted_evidence",
        instructionEligible: false,
      },
    });
    const snapshot = evidenceSnapshot(observation);
    const evidenceVersion = await appendEvidenceVersionTx(db, observation.tenantId, source.id, {
      content: stableJson(snapshot),
      snapshot,
      asOf: observedAt,
      retrievedAt,
      entityRefs: [{
        type: "provider_object",
        key: `${observation.provider}:${observation.resourceKind}:${observation.externalObjectType}:${observation.externalObjectId}`,
      }],
      timeRefs: [{ kind: "provider_observed_at", occurredAt: observation.observedAt }],
    });

    const directReferences = await exactCanonicalReferences(db, observation, observation);
    let documentId = existingDocumentId(directReferences);
    if (observation.resourceKind === "sharepoint_drive" && observation.payload.itemType === "file") {
      const document = await ensureProviderDocumentTx(db, {
        tenantId: observation.tenantId,
        provider: observation.provider,
        externalId: observation.externalObjectId,
        kind: boundedText(observation.payload.mimeType, "microsoft_365_file", 240),
        title: boundedText(observation.payload.name, `Microsoft 365 file ${observation.externalObjectId}`),
        storageRef: typeof observation.payload.webUrl === "string" ? observation.payload.webUrl.slice(0, 4_096) : null,
        createdBy: transactionContext.provenance!.createdBy!,
      });
      if (documentId && documentId !== document.documentId) {
        throw new PeDomainError("PE_AMBIGUOUS_PROVIDER_IDENTITY", "Provider object resolves to conflicting Core Document identities");
      }
      documentId = document.documentId;
    }

    const rootResolution = await resolveRootTx(db, client, observation, source.id, documentId);
    // A provider message belongs to a PE root as evidence, but it is not the PE
    // root's one-to-one external identity. Only a genuine Core object (currently a
    // Drive file backed by Core Document) receives an external_refs projection.
    const canonicalTarget = documentId ? { entityType: "document", entityId: documentId } : null;
    const persistence = await persistProviderObservationTx(db, {
      observation,
      evidenceSourceId: source.id,
      evidenceVersionId: evidenceVersion.versionId,
      canonicalTarget,
      rootMappingStatus: rootResolution.status,
      candidateRootIds: canonicalTarget ? [] : rootResolution.candidates.map((candidate) => candidate.root.entityId),
      reason: rootResolution.status === "unresolved"
        ? "No deterministic PE world-root proof exists"
        : rootResolution.status === "ambiguous"
          ? "Deterministic PE world-root proofs disagree"
          : undefined,
    });

    let reconciliationCaseId: string | null = null;
    if (rootResolution.status !== "mapped") {
      reconciliationCaseId = await openProviderReconciliationTx(db, {
        observation,
        sourceLinkId: persistence.sourceLinkId,
        caseType: rootResolution.status === "ambiguous" ? "mapping_ambiguous" : "unresolved_world_root",
        classification: rootResolution.status === "ambiguous" ? "deterministic_world_root_conflict" : "no_deterministic_world_root",
        details: { candidateRoots: rootResolution.candidates },
      });
    } else {
      await resolveProviderRootReconciliationTx(db, observation);
    }

    let evidenceAttached = false;
    let documentAttached = false;
    if (rootResolution.root) {
      const rootEntity: PeEntityRef = {
        entityType: rootResolution.root.entityType,
        entityId: rootResolution.root.entityId,
      };
      const evidenceLink = await attachEvidenceTx(client, transactionContext, {
        dealId: rootResolution.root.entityType === "pe_deal" ? rootResolution.root.entityId : null,
        worldRoot: rootResolution.root,
        entity: rootEntity,
        evidenceSourceId: source.id,
        evidenceVersionId: evidenceVersion.versionId,
        relationship: "supports",
      });
      evidenceAttached = evidenceLink.changed;
      if (documentId) {
        const documentLink = await attachDocumentTx(client, transactionContext, {
          dealId: rootResolution.root.entityType === "pe_deal" ? rootResolution.root.entityId : null,
          worldRoot: rootResolution.root,
          entity: rootEntity,
          documentId,
          linkRole: "source",
        });
        documentAttached = documentLink.changed;
      }
    }

    const realtimeEligible = observation.ingestionMode === "incremental" || observation.ingestionMode === "exact_read";
    let businessEventType: string | null = null;
    let integrationEventId: string | null = null;
    let matchedWaitIds: string[] = [];
    let wakeClaimIds: string[] = [];
    const businessEventTarget = documentId
      ? { entityType: "document", entityId: documentId }
      : { entityType: "evidence_source", entityId: source.id };
    const integrationEventTarget = rootResolution.root
      ? { entityType: rootResolution.root.entityType, entityId: rootResolution.root.entityId }
      : businessEventTarget;
    const tracePayload = {
      integrationId: observation.integrationId,
      sourceScopeId: observation.sourceScopeId,
      provider: observation.provider,
      resourceKind: observation.resourceKind,
      externalObjectType: observation.externalObjectType,
      externalObjectId: observation.externalObjectId,
      evidenceSourceId: source.id,
      evidenceVersionId: evidenceVersion.versionId,
      documentId,
      worldRoot: rootResolution.root,
      mappingStatus: rootResolution.status,
      ingestionMode: observation.ingestionMode,
      observedAt: observation.observedAt,
      retrievedAt: observation.retrievedAt,
      traceId: observation.traceId,
    };

    if (realtimeEligible && persistence.materialChanged && persistence.status !== "duplicate") {
      businessEventType = eventTypeFor(observation, evidenceVersion.versionNumber);
      await recordBusinessEvent(db, {
        tenantId: observation.tenantId,
        entityType: businessEventTarget.entityType,
        entityId: businessEventTarget.entityId,
        eventType: businessEventType,
        payload: tracePayload,
        source: observation.provider,
      });
      const integrationEvent = await ingestIntegrationEventTx(db, {
        tenantId: observation.tenantId,
        source: "provider_observation",
        provider: observation.provider,
        sourceEventId: `provider-observation:${providerObservationKey(observation)}`,
        eventType: businessEventType,
        occurredAt: observedAt,
        resource: { type: integrationEventTarget.entityType, id: integrationEventTarget.entityId },
        providerConversationId: providerConversationId(observation),
        providerMessageId: observation.externalObjectId,
        applicationRef: documentId,
        correlationId: observation.traceId,
        payload: tracePayload,
        evidenceRefs: [{ evidenceSourceId: source.id, evidenceVersionId: evidenceVersion.versionId }],
      });
      integrationEventId = integrationEvent.eventId;
      matchedWaitIds = integrationEvent.matchedWaitIds;
      wakeClaimIds = integrationEvent.wakeClaimIds;
    } else if (realtimeEligible && (persistence.status === "conflict" || persistence.status === "out_of_order")) {
      businessEventType = "source_reconciliation_required";
      await recordBusinessEvent(db, {
        tenantId: observation.tenantId,
        entityType: businessEventTarget.entityType,
        entityId: businessEventTarget.entityId,
        eventType: businessEventType,
        payload: { ...tracePayload, materializationStatus: persistence.status },
        source: observation.provider,
      });
    } else if (persistence.status === "duplicate" && (evidenceAttached || documentAttached)) {
      businessEventType = "external_evidence_mapped";
      await recordBusinessEvent(db, {
        tenantId: observation.tenantId,
        entityType: businessEventTarget.entityType,
        entityId: businessEventTarget.entityId,
        eventType: businessEventType,
        payload: tracePayload,
        source: observation.provider,
      });
    }

    return {
      persistence,
      evidenceSourceId: source.id,
      evidenceVersionId: evidenceVersion.versionId,
      evidenceContentHash: evidenceVersion.contentHash,
      documentId,
      rootResolution,
      evidenceAttached,
      documentAttached,
      businessEventType,
      integrationEventId,
      matchedWaitIds,
      wakeClaimIds,
      reconciliationCaseId,
    };
  });
}
