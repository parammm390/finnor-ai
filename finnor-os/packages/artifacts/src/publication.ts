import { sql } from "drizzle-orm";
import { evaluateAuthority } from "@finnor/authority";
import { enqueueJob, withTenant, type Db } from "@finnor/db";
import {
  appendDocumentVersion,
  loadDocumentVersion,
  recordBusinessEvent,
  recordExternalReferenceAcknowledgement,
  setDocumentVersionHead,
  type DocumentVersion,
} from "@finnor/data-platform";
import {
  MicrosoftDriveArtifactTransport,
  MicrosoftGraphClient,
  MicrosoftGraphError,
  type MicrosoftDriveItemMetadata,
} from "@finnor/provider-microsoft365";
import {
  resolveMicrosoftDelegatedAuthContext,
  resolveMicrosoftProviderAuthContext,
  type MicrosoftGraphAuthContext,
} from "@finnor/security";
import { ArtifactError, diffIR, ensure, type SemanticChange, type SemanticIR } from "@finnor/ooxml";
import type { ArtifactActor } from "./service";
import { interpret, loadArtifactIRSnapshot, saveArtifactIRSnapshot } from "./service";
import { recordArtifactMetric } from "./telemetry";

export type ArtifactWriteMode = "APP_ONLY_FILE_REPLACE" | "DELEGATED_FILE_REPLACE";
export type ArtifactPublicationStatus =
  | "prepared"
  | "writing"
  | "acknowledged"
  | "verified"
  | "verified_provider_normalized"
  | "conflict"
  | "verification_failed"
  | "unknown_delivery";

export interface ArtifactFileTransport {
  metadata(identity: { driveId: string; itemId: string }): Promise<MicrosoftDriveItemMetadata>;
  download(identity: { driveId: string; itemId: string }): Promise<{ metadata: MicrosoftDriveItemMetadata; bytes: Buffer }>;
  replaceConditional(input: { driveId: string; itemId: string; bytes: Buffer; expectedETag: string }): Promise<MicrosoftDriveItemMetadata>;
}

export interface ArtifactPublicationDependencies {
  transport(input: {
    actor: ArtifactActor;
    integrationId: string;
    mode: ArtifactWriteMode;
  }): Promise<ArtifactFileTransport>;
  enqueue(type: string, payload: Record<string, unknown>, idempotencyKey: string, correlationId?: string): Promise<void>;
}

export const defaultArtifactPublicationDependencies: ArtifactPublicationDependencies = {
  async transport({ actor, integrationId, mode }) {
    let auth: MicrosoftGraphAuthContext;
    if (mode === "APP_ONLY_FILE_REPLACE") {
      auth = await resolveMicrosoftProviderAuthContext({ tenantId: actor.tenantId, integrationId });
    } else {
      const principalId = actor.employeeId ?? actor.userId;
      auth = await resolveMicrosoftDelegatedAuthContext({ tenantId: actor.tenantId, principalId });
    }
    return new MicrosoftDriveArtifactTransport(new MicrosoftGraphClient(auth), mode === "APP_ONLY_FILE_REPLACE" ? "app_only" : "delegated");
  },
  enqueue: (type, payload, idempotencyKey, correlationId) => enqueueJob(type, payload, idempotencyKey, correlationId, "interactive", 80),
};

interface PublicationBinding {
  externalRefId: string;
  integrationId: string;
  externalId: string;
  sourceScopeId: string;
  driveId: string;
  itemId: string;
  providerETag: string;
  providerCTag: string | null;
  providerVersionId: string | null;
  providerHeadVersionId: string;
}

interface PreparedPublication {
  id: string;
  binding: PublicationBinding;
  base: { version: DocumentVersion; bytes: Buffer; ir: SemanticIR };
  local: { version: DocumentVersion; bytes: Buffer; ir: SemanticIR };
  status: ArtifactPublicationStatus;
  providerAck: Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, code: string): string {
  ensure(typeof value === "string" && value.trim().length > 0, code);
  return value;
}

function safeFailure(error: unknown): string {
  if (error instanceof MicrosoftGraphError) return `MICROSOFT_${error.kind.toUpperCase()}`;
  if (error instanceof ArtifactError) return error.code;
  return "ARTIFACT_PUBLICATION_FAILED";
}

function providerPayload(row: Record<string, unknown>): Record<string, unknown> {
  const observed = object(row.observed_state);
  return Object.keys(observed).length ? observed : object(row.observation_state);
}

async function loadPublicationBinding(
  db: Db,
  actor: ArtifactActor,
  documentId: string,
  baseVersionId: string,
  externalRefId?: string,
  requireCurrentProviderHead = true,
): Promise<PublicationBinding> {
  const result = await db.execute(sql`
    SELECT r.id::text external_ref_id,r.integration_id::text,r.external_id,r.source_version,r.observed_state,r.provenance,
           o.source_scope_id::text,o.observed_state observation_state,
           h.version_id::text provider_head_version_id
    FROM finnor_os.external_refs r
    LEFT JOIN LATERAL (
      SELECT source_scope_id,observed_state FROM finnor_os.external_ref_observations
      WHERE tenant_id=r.tenant_id AND integration_id=r.integration_id
        AND external_object_type=r.external_object_type AND external_id=r.external_id
      ORDER BY received_at DESC,id DESC LIMIT 1
    ) o ON true
    LEFT JOIN finnor_os.document_version_heads h
      ON h.tenant_id=r.tenant_id AND h.document_id=r.internal_id AND h.kind='provider' AND h.head_key=r.id::text
    WHERE r.tenant_id=${actor.tenantId}::uuid AND r.entity='document' AND r.internal_id=${documentId}::uuid
      AND r.provider='microsoft_graph' AND r.external_object_type='microsoft_drive_item'
      AND r.mapping_status='mapped' AND NOT r.provider_deleted
      AND (${externalRefId ?? null}::uuid IS NULL OR r.id=${externalRefId ?? null}::uuid)
    ORDER BY r.updated_at DESC LIMIT 1
  `);
  const row = result.rows[0];
  ensure(row, "MICROSOFT_DOCUMENT_BINDING_NOT_FOUND");
  const payload = providerPayload(row);
  const driveId = requiredString(payload.driveId, "MICROSOFT_DRIVE_ID_MISSING");
  const itemId = requiredString(payload.id, "MICROSOFT_ITEM_ID_MISSING");
  const providerETag = requiredString(payload.eTag ?? row.source_version, "MICROSOFT_ETAG_MISSING");
  const sourceScopeId = requiredString(row.source_scope_id ?? object(row.provenance).sourceScopeId, "MICROSOFT_SOURCE_SCOPE_MISSING");
  const providerHeadVersionId = typeof row.provider_head_version_id === "string" ? row.provider_head_version_id : baseVersionId;
  if (requireCurrentProviderHead) {
    ensure(typeof row.provider_head_version_id === "string", "PROVIDER_ARTIFACT_HEAD_MISSING");
    ensure(providerHeadVersionId === baseVersionId, "STALE_PROVIDER_BASE_VERSION");
  }
  return {
    externalRefId: String(row.external_ref_id),
    integrationId: String(row.integration_id),
    externalId: String(row.external_id),
    sourceScopeId,
    driveId,
    itemId,
    providerETag,
    providerCTag: typeof payload.cTag === "string" ? payload.cTag : null,
    providerVersionId: typeof row.source_version === "string" ? row.source_version : null,
    providerHeadVersionId,
  };
}

async function exactIR(db: Db, tenantId: string, loaded: { version: DocumentVersion; bytes: Buffer }): Promise<SemanticIR> {
  return (await loadArtifactIRSnapshot(db, tenantId, loaded.version.id))?.ir ?? interpret(loaded.bytes);
}

function publicationRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    localVersionId: String(row.local_version_id),
    baseVersionId: String(row.base_version_id),
    integrationId: String(row.integration_id),
    externalRefId: String(row.external_ref_id),
    writeMode: String(row.write_mode) as ArtifactWriteMode,
    status: String(row.status) as ArtifactPublicationStatus,
    readbackVersionId: typeof row.readback_version_id === "string" ? row.readback_version_id : null,
    providerAck: object(row.provider_ack),
    verificationDiff: Array.isArray(row.verification_diff) ? row.verification_diff : [],
    failure: typeof row.failure === "string" ? row.failure : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function readArtifactPublication(actor: ArtifactActor, documentId: string, publicationId: string) {
  return withTenant(actor.tenantId, async (db) => {
    const result = await db.execute(sql`
      SELECT * FROM finnor_os.artifact_publications
      WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${documentId}::uuid AND id=${publicationId}::uuid
    `);
    return result.rows[0] ? publicationRow(result.rows[0]) : null;
  });
}

async function updatePublication(db: Db, actor: ArtifactActor, publicationId: string, input: {
  status: ArtifactPublicationStatus;
  readbackVersionId?: string;
  providerAck?: Record<string, unknown>;
  verificationDiff?: unknown;
  failure?: string;
  terminal?: boolean;
}): Promise<void> {
  await db.execute(sql`
    UPDATE finnor_os.artifact_publications SET
      status=${input.status},
      readback_version_id=coalesce(${input.readbackVersionId ?? null}::uuid,readback_version_id),
      provider_ack=CASE WHEN ${input.providerAck ? true : false} THEN ${JSON.stringify(input.providerAck ?? {})}::jsonb ELSE provider_ack END,
      verification_diff=CASE WHEN ${input.verificationDiff !== undefined} THEN ${JSON.stringify(input.verificationDiff ?? [])}::jsonb ELSE verification_diff END,
      failure=${input.failure ?? null},completed_at=CASE WHEN ${input.terminal ?? false} THEN clock_timestamp() ELSE completed_at END
    WHERE tenant_id=${actor.tenantId}::uuid AND id=${publicationId}::uuid
  `);
}

export interface ThreeWayArtifactDiff {
  baseSemanticHash: string;
  localSemanticHash: string;
  remoteSemanticHash: string;
  local: SemanticChange[];
  remote: SemanticChange[];
  overlappingAnchorIds: string[];
  autoMergeEligible: boolean;
  reason: string;
}

const SAFE_DISJOINT_CHANGE_KINDS = new Set(["value-change", "formula-change", "format-only", "modified"]);

/** This certifies only semantic target separation. A caller must still recompile the
 * typed local patch against the remote package and pass every refreshed anchor hash. */
export function threeWayArtifactDiff(base: SemanticIR, local: SemanticIR, remote: SemanticIR): ThreeWayArtifactDiff {
  ensure(base.kind === local.kind && base.kind === remote.kind, "THREE_WAY_FORMAT_MISMATCH");
  const localChanges = diffIR(base, local);
  const remoteChanges = diffIR(base, remote);
  const remoteIds = new Set(remoteChanges.map((change) => change.id));
  const overlappingAnchorIds = localChanges.map((change) => change.id).filter((id) => remoteIds.has(id)).sort();
  const safeKinds = [...localChanges, ...remoteChanges].every((change) => SAFE_DISJOINT_CHANGE_KINDS.has(change.kind));
  const autoMergeEligible = overlappingAnchorIds.length === 0 && safeKinds && localChanges.length > 0 && remoteChanges.length > 0;
  return {
    baseSemanticHash: base.semanticHash,
    localSemanticHash: local.semanticHash,
    remoteSemanticHash: remote.semanticHash,
    local: localChanges,
    remote: remoteChanges,
    overlappingAnchorIds,
    autoMergeEligible,
    reason: autoMergeEligible
      ? "DISJOINT_EXACT_SEMANTIC_TARGETS_REQUIRE_TYPED_RECOMPILE"
      : overlappingAnchorIds.length ? "OVERLAPPING_SEMANTIC_TARGETS" : "STRUCTURAL_OR_OPAQUE_CHANGE_REQUIRES_HUMAN",
  };
}

const PROVIDER_NORMALIZATION_PARTS = new Set(["docProps/core.xml", "docProps/app.xml"]);

export function classifyReadback(local: SemanticIR, readback: SemanticIR): {
  status: "verified" | "verified_provider_normalized" | "verification_failed";
  diff: SemanticChange[];
} {
  const changes = diffIR(local, readback);
  if (changes.length === 0) return { status: "verified", diff: changes };
  if (changes.every((change) => change.kind === "OPAQUE_PART_CHANGED" && PROVIDER_NORMALIZATION_PARTS.has(change.id))) {
    return { status: "verified_provider_normalized", diff: changes };
  }
  return { status: "verification_failed", diff: changes };
}

async function preparePublication(
  actor: ArtifactActor,
  input: { documentId: string; localVersionId: string; baseVersionId: string; mode: ArtifactWriteMode },
): Promise<PreparedPublication> {
  // A terminal or recoverable durable operation must be readable even after its
  // verified read-back advances the provider head. Resolve the operation identity
  // before enforcing the pre-write current-head condition.
  const replay = await withTenant(actor.tenantId, async (db) => {
    const current = await db.execute(sql`
      SELECT * FROM finnor_os.artifact_publications
      WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${input.documentId}::uuid
        AND local_version_id=${input.localVersionId}::uuid AND base_version_id=${input.baseVersionId}::uuid
      ORDER BY created_at DESC LIMIT 2
    `);
    if (!current.rows[0]) return null;
    ensure(current.rows.length === 1, "PUBLICATION_REPLAY_AMBIGUOUS");
    const row = publicationRow(current.rows[0]);
    ensure(row.writeMode === input.mode, "PUBLICATION_WRITE_MODE_MISMATCH");
    const base = await loadDocumentVersion(db, actor.tenantId, input.documentId, input.baseVersionId);
    const local = await loadDocumentVersion(db, actor.tenantId, input.documentId, input.localVersionId);
    ensure(base && local, "DOCUMENT_VERSION_NOT_FOUND");
    const binding = await loadPublicationBinding(db, actor, input.documentId, input.baseVersionId, row.externalRefId, false);
    return {
      id: row.id,
      status: row.status,
      providerAck: row.providerAck,
      binding,
      base: { ...base, ir: await exactIR(db, actor.tenantId, base) },
      local: { ...local, ir: await exactIR(db, actor.tenantId, local) },
    } satisfies PreparedPublication;
  });
  if (replay) return replay;

  const existing = await withTenant(actor.tenantId, async (db) => {
    const binding = await loadPublicationBinding(db, actor, input.documentId, input.baseVersionId);
    const base = await loadDocumentVersion(db, actor.tenantId, input.documentId, input.baseVersionId);
    const local = await loadDocumentVersion(db, actor.tenantId, input.documentId, input.localVersionId);
    ensure(base && local, "DOCUMENT_VERSION_NOT_FOUND");
    ensure(base.version.provider_etag === binding.providerETag, "PROVIDER_BASE_ETAG_MISMATCH");
    ensure(base.version.format === local.version.format && base.version.format !== "unknown", "PUBLICATION_FORMAT_MISMATCH");
    const baseIR = await exactIR(db, actor.tenantId, base);
    const localIR = await exactIR(db, actor.tenantId, local);
    ensure(baseIR.semanticHash !== localIR.semanticHash, "NO_SEMANTIC_DRAFT_CHANGE");
    const current = await db.execute(sql`
      SELECT * FROM finnor_os.artifact_publications
      WHERE tenant_id=${actor.tenantId}::uuid AND external_ref_id=${binding.externalRefId}::uuid
        AND local_version_id=${input.localVersionId}::uuid AND base_etag=${binding.providerETag}
      LIMIT 1
    `);
    if (current.rows[0]) {
      const row = publicationRow(current.rows[0]);
      ensure(row.writeMode === input.mode, "PUBLICATION_WRITE_MODE_MISMATCH");
      return { id: row.id, status: row.status, providerAck: row.providerAck, binding, base: { ...base, ir: baseIR }, local: { ...local, ir: localIR } } as const;
    }
    return { binding, base: { ...base, ir: baseIR }, local: { ...local, ir: localIR } } as const;
  });
  if ("id" in existing && typeof existing.id === "string") return existing as PreparedPublication;

  const decision = await evaluateAuthority(actor, {
    operation: "execution",
    capability: "artifact:publish",
    resource: { type: "document", id: input.documentId },
    risk: "medium",
  });
  ensure(decision.outcome === "allowed", decision.outcome === "approval_required" ? "ARTIFACT_PUBLISH_APPROVAL_REQUIRED" : "ARTIFACT_PUBLISH_DENIED");

  return withTenant(actor.tenantId, async (db) => {
    const result = await db.execute(sql`
      INSERT INTO finnor_os.artifact_publications(
        tenant_id,document_id,local_version_id,base_version_id,integration_id,external_ref_id,base_etag,write_mode,
        provider_binding_key,actor_id,authority_decision_id,expected_semantic_hash,status
      ) VALUES(
        ${actor.tenantId}::uuid,${input.documentId}::uuid,${input.localVersionId}::uuid,${input.baseVersionId}::uuid,
        ${existing.binding.integrationId}::uuid,${existing.binding.externalRefId}::uuid,${existing.binding.providerETag},${input.mode},
        ${`${existing.binding.driveId}/${existing.binding.itemId}`},${actor.userId}::uuid,${decision.id}::uuid,${existing.local.ir.semanticHash},'prepared'
      ) ON CONFLICT(tenant_id,external_ref_id,local_version_id,base_etag) DO NOTHING RETURNING id::text
    `);
    let id = result.rows[0]?.id as string | undefined;
    if (!id) {
      const replay = await db.execute(sql`
        SELECT id::text FROM finnor_os.artifact_publications
        WHERE tenant_id=${actor.tenantId}::uuid AND external_ref_id=${existing.binding.externalRefId}::uuid
          AND local_version_id=${input.localVersionId}::uuid AND base_etag=${existing.binding.providerETag}
      `);
      id = replay.rows[0]?.id as string | undefined;
    }
    ensure(id, "PUBLICATION_IDEMPOTENCY_CONFLICT");
    return { id, status: "prepared" as const, providerAck: {}, binding: existing.binding, base: existing.base, local: existing.local };
  });
}

async function captureRemoteConflict(
  actor: ArtifactActor,
  prepared: PreparedPublication,
  transport: ArtifactFileTransport,
  knownRemote?: Awaited<ReturnType<ArtifactFileTransport["download"]>>,
): Promise<ReturnType<typeof publicationRow>> {
  const remote = knownRemote ?? await transport.download(prepared.binding);
  const remoteIR = await interpret(remote.bytes, { fileName: remote.metadata.name });
  const report = threeWayArtifactDiff(prepared.base.ir, prepared.local.ir, remoteIR);
  await withTenant(actor.tenantId, async (db) => {
    const version = await appendDocumentVersion(db, {
      tenantId: actor.tenantId,
      documentId: prepared.local.version.document_id,
      bytes: remote.bytes,
      mediaType: remote.metadata.mimeType ?? prepared.local.version.media_type,
      format: remoteIR.kind as DocumentVersion["format"],
      origin: "provider_observation",
      actor: "system:microsoft-artifact-conflict",
      parentVersionId: prepared.binding.providerHeadVersionId,
      sourceSystem: "microsoft_graph",
      sourceRef: prepared.binding.externalId,
      providerVersionId: remote.metadata.providerVersionId ?? undefined,
      providerEtag: remote.metadata.eTag,
      providerCtag: remote.metadata.cTag ?? undefined,
      head: { kind: "provider", key: prepared.binding.externalRefId, expectedVersionId: prepared.binding.providerHeadVersionId },
    });
    await saveArtifactIRSnapshot(db, actor.tenantId, version.id, remoteIR);
    await updatePublication(db, actor, prepared.id, { status: "conflict", readbackVersionId: version.id, verificationDiff: report, failure: "PROVIDER_HEAD_CHANGED", terminal: true });
    await recordBusinessEvent(db, {
      tenantId: actor.tenantId,
      entityType: "document",
      entityId: prepared.local.version.document_id,
      eventType: "artifact_publish_conflict",
      payload: { publicationId: prepared.id, localVersionId: prepared.local.version.id, remoteVersionId: version.id, overlappingAnchorIds: report.overlappingAnchorIds, autoMergeEligible: report.autoMergeEligible },
      source: "microsoft_graph",
    });
  });
  recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: prepared.local.version.document_id }, "artifact_publish_conflicts", 1, "count");
  return (await readArtifactPublication(actor, prepared.local.version.document_id, prepared.id))!;
}

export async function publishArtifact(
  actor: ArtifactActor,
  input: { documentId: string; localVersionId: string; baseVersionId: string; mode: ArtifactWriteMode },
  dependencies: ArtifactPublicationDependencies = defaultArtifactPublicationDependencies,
) {
  recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: input.documentId }, "artifact_publish_attempts", 1, "count");
  const prepared = await preparePublication(actor, input);
  const terminal = new Set<ArtifactPublicationStatus>(["verified", "verified_provider_normalized", "conflict", "verification_failed"]);
  if (terminal.has(prepared.status)) {
    const result = (await readArtifactPublication(actor, input.documentId, prepared.id))!;
    if (result.readbackVersionId && (result.status === "verified" || result.status === "verified_provider_normalized")) {
      await dependencies.enqueue("sync_source", {
        tenantId: actor.tenantId,
        integrationId: prepared.binding.integrationId,
        sourceScopeId: prepared.binding.sourceScopeId,
        reason: "artifact_publication_readback",
      }, `artifact-publish-source-convergence:${prepared.id}`, actor.correlationId);
    }
    return result;
  }

  let effectiveStatus = prepared.status;
  let transport: ArtifactFileTransport;
  try {
    transport = await dependencies.transport({ actor, integrationId: prepared.binding.integrationId, mode: input.mode });
    let ack = prepared.providerAck;
    let readback: Awaited<ReturnType<ArtifactFileTransport["download"]>> | undefined;
    let shouldWrite = false;

    if (effectiveStatus === "prepared") {
      const metadata = await transport.metadata(prepared.binding);
      if (metadata.eTag !== prepared.binding.providerETag) return captureRemoteConflict(actor, prepared, transport);
      await withTenant(actor.tenantId, (db) => updatePublication(db, actor, prepared.id, { status: "writing" }));
      effectiveStatus = "writing";
      shouldWrite = true;
    } else if (effectiveStatus === "writing" || (effectiveStatus === "unknown_delivery" && typeof ack.eTag !== "string")) {
      const remote = await transport.download(prepared.binding);
      const remoteIR = await interpret(remote.bytes, { fileName: remote.metadata.name });
      const recovered = classifyReadback(prepared.local.ir, remoteIR);
      if (recovered.status !== "verification_failed") {
        readback = remote;
        ack = {
          provider: "microsoft_graph",
          driveItemId: remote.metadata.id,
          eTag: remote.metadata.eTag,
          cTag: remote.metadata.cTag,
          providerVersionId: remote.metadata.providerVersionId,
          acknowledgedAt: new Date().toISOString(),
          recoveredAfterAmbiguousDelivery: true,
        };
      } else if (remote.metadata.eTag === prepared.binding.providerETag && remote.bytes.equals(prepared.base.bytes)) {
        shouldWrite = true;
      } else {
        return captureRemoteConflict(actor, prepared, transport, remote);
      }
    }

    if (shouldWrite) {
      let acknowledged: MicrosoftDriveItemMetadata;
      try {
        acknowledged = await transport.replaceConditional({
          driveId: prepared.binding.driveId,
          itemId: prepared.binding.itemId,
          bytes: prepared.local.bytes,
          expectedETag: prepared.binding.providerETag,
        });
      } catch (error) {
        if (error instanceof MicrosoftGraphError && error.kind === "conflict") return captureRemoteConflict(actor, prepared, transport);
        throw error;
      }
      ack = {
        provider: "microsoft_graph",
        driveItemId: acknowledged.id,
        eTag: acknowledged.eTag,
        cTag: acknowledged.cTag,
        providerVersionId: acknowledged.providerVersionId,
        acknowledgedAt: new Date().toISOString(),
      };
    }

    if (effectiveStatus === "writing" || effectiveStatus === "unknown_delivery") {
      await withTenant(actor.tenantId, async (db) => {
        await recordExternalReferenceAcknowledgement(db, {
          tenantId: actor.tenantId,
          integrationId: prepared.binding.integrationId,
          provider: "microsoft_graph",
          canonicalEntity: "document",
          canonicalEntityId: input.documentId,
          externalObjectType: "microsoft_drive_item",
          externalId: prepared.binding.externalId,
        });
        await updatePublication(db, actor, prepared.id, { status: "acknowledged", providerAck: ack });
      });
      effectiveStatus = "acknowledged";
    }

    if (!readback) readback = await transport.download(prepared.binding);
    const readbackIR = await interpret(readback.bytes, { fileName: readback.metadata.name });
    const verification = classifyReadback(prepared.local.ir, readbackIR);
    await withTenant(actor.tenantId, async (db) => {
      const version = await appendDocumentVersion(db, {
        tenantId: actor.tenantId,
        documentId: input.documentId,
        bytes: readback.bytes,
        mediaType: readback.metadata.mimeType ?? prepared.local.version.media_type,
        format: readbackIR.kind as DocumentVersion["format"],
        origin: "readback",
        actor: actor.userId,
        parentVersionId: input.localVersionId,
        sourceSystem: "microsoft_graph",
        sourceRef: prepared.binding.externalId,
        providerVersionId: readback.metadata.providerVersionId ?? undefined,
        providerEtag: readback.metadata.eTag,
        providerCtag: readback.metadata.cTag ?? undefined,
        head: { kind: "provider", key: prepared.binding.externalRefId, expectedVersionId: prepared.binding.providerHeadVersionId },
      });
      await saveArtifactIRSnapshot(db, actor.tenantId, version.id, readbackIR);
      if (verification.status !== "verification_failed") {
        const current = await db.execute(sql`SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${input.documentId}::uuid AND kind='current' AND head_key='default'`);
        await setDocumentVersionHead(db, { tenantId: actor.tenantId, documentId: input.documentId, kind: "current", key: "default", versionId: version.id, expectedVersionId: (current.rows[0]?.version_id as string | undefined) ?? null });
        const published = await db.execute(sql`SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${input.documentId}::uuid AND kind='published' AND head_key=${prepared.binding.externalRefId}`);
        await setDocumentVersionHead(db, { tenantId: actor.tenantId, documentId: input.documentId, kind: "published", key: prepared.binding.externalRefId, versionId: version.id, expectedVersionId: (published.rows[0]?.version_id as string | undefined) ?? null });
      }
      await updatePublication(db, actor, prepared.id, {
        status: verification.status,
        readbackVersionId: version.id,
        providerAck: ack,
        verificationDiff: verification.diff,
        ...(verification.status === "verification_failed" ? { failure: "UNEXPECTED_PROVIDER_SEMANTIC_CHANGE" } : {}),
        terminal: true,
      });
      await recordBusinessEvent(db, {
        tenantId: actor.tenantId,
        entityType: "document",
        entityId: input.documentId,
        eventType: verification.status === "verification_failed" ? "artifact_publish_verification_failed" : "artifact_publish_verified",
        payload: { publicationId: prepared.id, localVersionId: input.localVersionId, readbackVersionId: version.id, verification: verification.status, semanticHash: readbackIR.semanticHash },
        source: "microsoft_graph",
      });
    });
    effectiveStatus = verification.status;
    if (verification.status === "verification_failed") {
      recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: input.documentId }, "artifact_publish_verification_failures", 1, "count");
    } else if (verification.status === "verified_provider_normalized") {
      recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: input.documentId }, "artifact_provider_normalizations", 1, "count");
    }
    const result = (await readArtifactPublication(actor, input.documentId, prepared.id))!;
    await dependencies.enqueue("sync_source", {
      tenantId: actor.tenantId,
      integrationId: prepared.binding.integrationId,
      sourceScopeId: prepared.binding.sourceScopeId,
      reason: "artifact_publication_readback",
    }, `artifact-publish-source-convergence:${prepared.id}`, actor.correlationId);
    return result;
  } catch (error) {
    if (terminal.has(effectiveStatus)) throw error;
    if (error instanceof MicrosoftGraphError && error.kind === "conflict" && transport!) {
      return captureRemoteConflict(actor, prepared, transport);
    }
    if (error instanceof MicrosoftGraphError && error.retryable && effectiveStatus !== "prepared") {
      await withTenant(actor.tenantId, (db) => updatePublication(db, actor, prepared.id, {
        status: "unknown_delivery",
        failure: safeFailure(error),
      })).catch(() => undefined);
      return (await readArtifactPublication(actor, input.documentId, prepared.id))!;
    }
    if (effectiveStatus !== "prepared") {
      await withTenant(actor.tenantId, (db) => updatePublication(db, actor, prepared.id, {
        status: "verification_failed",
        failure: safeFailure(error),
        terminal: true,
      })).catch(() => undefined);
    }
    throw error;
  }
}
