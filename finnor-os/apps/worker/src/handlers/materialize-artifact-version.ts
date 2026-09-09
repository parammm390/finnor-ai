import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { ingestArtifact, interpret, recordArtifactMetric, saveArtifactIRSnapshot } from "@finnor/artifacts";
import { enqueueJob, withTenant } from "@finnor/db";
import { recordBusinessEvent, setDocumentVersionHead } from "@finnor/data-platform";
import { ingestMemory } from "@finnor/memory";
import { MicrosoftDriveArtifactTransport, MicrosoftGraphClient, MicrosoftGraphError } from "@finnor/provider-microsoft365";
import { resolveMicrosoftProviderAuthContext } from "@finnor/security";
import { logWithTrace } from "@finnor/tools";
import type { JobHandler } from "../queue";

const SUPPORTED_MEDIA = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
]);

function required(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`materialize_artifact_version requires ${key}`);
  return value;
}

async function indexArtifactMemory(tenantId: string, documentId: string, versionId: string, ir: Awaited<ReturnType<typeof interpret>>): Promise<void> {
  const text = ir.nodes
    .map((node) => `${node.kind} ${node.id}\n${JSON.stringify(node.data)}`)
    .join("\n\n")
    .slice(0, 1_048_576);
  await ingestMemory({
    tenantId,
    sourceDocId: `artifact:${documentId}`,
    documentId,
    documentVersionId: versionId,
    text,
    sourceKind: "artifact_document_version",
    provenance: { documentId, documentVersionId: versionId, semanticHash: ir.semanticHash, contentTreatment: "untrusted_evidence", instructionEligible: false },
  });
}

/** P2 commits provider evidence first. This job then fetches exact bounded bytes,
 * parses them outside the P2 delta transaction, and advances P3 heads by CAS. */
export const materializeArtifactVersion: JobHandler = async (payload) => {
  const tenantId = required(payload, "tenantId");
  const integrationId = required(payload, "integrationId");
  const documentId = required(payload, "documentId");
  const externalRefId = required(payload, "externalRefId");
  const expectedETag = required(payload, "expectedETag");
  const sourceScopeId = required(payload, "sourceScopeId");
  const evidenceVersionId = typeof payload.evidenceVersionId === "string" ? payload.evidenceVersionId : null;
  const traceId = typeof payload._correlationId === "string" ? payload._correlationId : undefined;
  if (!evidenceVersionId) {
    recordArtifactMetric({ tenantId, traceId, documentId }, "artifact_unresolved_source_binding_count", 1, "count");
  }
  const binding = await withTenant(tenantId, async (db) => {
    const result = await db.execute(sql`
      SELECT r.external_id,r.observed_state,
             h.version_id::text provider_head,
             c.version_id::text current_head
      FROM finnor_os.external_refs r
      LEFT JOIN finnor_os.document_version_heads h ON h.tenant_id=r.tenant_id AND h.document_id=r.internal_id AND h.kind='provider' AND h.head_key=r.id::text
      LEFT JOIN finnor_os.document_version_heads c ON c.tenant_id=r.tenant_id AND c.document_id=r.internal_id AND c.kind='current' AND c.head_key='default'
      WHERE r.tenant_id=${tenantId}::uuid AND r.id=${externalRefId}::uuid AND r.internal_id=${documentId}::uuid
        AND r.integration_id=${integrationId}::uuid AND r.provider='microsoft_graph' AND r.entity='document'
        AND r.external_object_type='microsoft_drive_item' AND r.mapping_status='mapped' AND NOT r.provider_deleted
        AND EXISTS (
          SELECT 1 FROM finnor_os.documents d
          WHERE d.tenant_id=r.tenant_id AND d.id=r.internal_id AND d.archived_at IS NULL
        )
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Artifact provider binding is missing or crosses tenant");
    const state = row.observed_state && typeof row.observed_state === "object" && !Array.isArray(row.observed_state)
      ? row.observed_state as Record<string, unknown> : {};
    if (typeof state.driveId !== "string" || typeof state.id !== "string") throw new Error("Artifact provider binding lacks Drive identity");
    return {
      externalId: String(row.external_id),
      driveId: state.driveId,
      itemId: state.id,
      name: typeof state.name === "string" ? state.name : `artifact-${documentId}`,
      mediaType: typeof state.mimeType === "string" ? state.mimeType.toLowerCase() : "",
      providerHead: (row.provider_head as string | null) ?? null,
      currentHead: (row.current_head as string | null) ?? null,
    };
  });
  if (!SUPPORTED_MEDIA.has(binding.mediaType)) return;

  const auth = await resolveMicrosoftProviderAuthContext({ tenantId, integrationId });
  const transport = new MicrosoftDriveArtifactTransport(new MicrosoftGraphClient(auth), "app_only");
  const downloaded = await transport.download(binding);
  if (downloaded.metadata.eTag !== expectedETag) {
    await withTenant(tenantId, (db) => recordBusinessEvent(db, {
      tenantId,
      entityType: "document",
      entityId: documentId,
      eventType: "artifact_binary_materialization_unavailable",
      payload: { expectedETag, observedETag: downloaded.metadata.eTag, sourceScopeId, evidenceVersionId, reason: "provider_fetch_race" },
      source: "microsoft_graph",
    }));
    await enqueueJob("sync_source", { tenantId, integrationId, sourceScopeId, reason: "artifact_fetch_race" }, `artifact-fetch-race:${tenantId}:${externalRefId}:${downloaded.metadata.eTag}`, traceId, "interactive", 90);
    return;
  }
  const ir = await interpret(downloaded.bytes, { fileName: downloaded.metadata.name || binding.name });
  const hash = createHash("sha256").update(downloaded.bytes).digest("hex");
  const reused = await withTenant(tenantId, async (db) => {
    const result = await db.execute(sql`
      SELECT id::text FROM finnor_os.document_versions
      WHERE tenant_id=${tenantId}::uuid AND document_id=${documentId}::uuid AND byte_sha256=${hash}
        AND (provider_etag=${expectedETag} OR (origin='readback' AND source_ref=${binding.externalId}))
      ORDER BY version_ordinal DESC LIMIT 1
    `);
    const id = result.rows[0]?.id as string | undefined;
    if (!id) return null;
    await saveArtifactIRSnapshot(db, tenantId, id, ir);
    if (binding.providerHead !== id) {
      await setDocumentVersionHead(db, { tenantId, documentId, kind: "provider", key: externalRefId, versionId: id, expectedVersionId: binding.providerHead });
    }
    if (!binding.currentHead || binding.currentHead === binding.providerHead) {
      if (binding.currentHead !== id) await setDocumentVersionHead(db, { tenantId, documentId, kind: "current", key: "default", versionId: id, expectedVersionId: binding.currentHead });
    }
    if (evidenceVersionId) {
      const sourceAnchor = ir.nodes.find((node) => ["workbook", "document", "presentation", "page"].includes(node.kind)) ?? ir.nodes[0];
      if (sourceAnchor) await db.execute(sql`
        INSERT INTO finnor_os.artifact_bindings(
          tenant_id,version_id,anchor_id,anchor_hash,target_kind,target_id,target_entity_type,target_anchor,actor_id,created_by
        ) VALUES(
          ${tenantId}::uuid,${id}::uuid,${sourceAnchor.id},${sourceAnchor.hash},'evidence_version',${evidenceVersionId}::uuid,NULL,NULL,NULL,'system:microsoft-graph-worker'
        ) ON CONFLICT DO NOTHING
      `);
    }
    return id;
  });
  if (reused) {
    await indexArtifactMemory(tenantId, documentId, reused, ir);
    logWithTrace({ traceId, tenantId }).info({ event: "artifact_materialized", documentId, versionId: reused, replayed: true, format: ir.kind, sizeBytes: downloaded.bytes.length }, "[artifact] provider materialization converged");
    return;
  }

  const created = await ingestArtifact({ tenantId, userId: "system:microsoft-graph-worker", role: "owner", correlationId: traceId }, {
    documentId,
    title: downloaded.metadata.name || binding.name,
    bytes: downloaded.bytes,
    origin: "provider_observation",
    parentVersionId: binding.providerHead ?? undefined,
    sourceSystem: "microsoft_graph",
    sourceRef: binding.externalId,
    providerVersionId: downloaded.metadata.providerVersionId ?? undefined,
    providerEtag: downloaded.metadata.eTag,
    providerCtag: downloaded.metadata.cTag ?? undefined,
    headKind: "provider",
    headKey: externalRefId,
    expectedHead: binding.providerHead,
  });
  await withTenant(tenantId, async (db) => {
    if (!binding.currentHead || binding.currentHead === binding.providerHead) {
      await setDocumentVersionHead(db, { tenantId, documentId, kind: "current", key: "default", versionId: created.version.id, expectedVersionId: binding.currentHead });
    }
    if (evidenceVersionId) {
      const sourceAnchor = created.ir.nodes.find((node) => ["workbook", "document", "presentation", "page"].includes(node.kind)) ?? created.ir.nodes[0];
      if (sourceAnchor) await db.execute(sql`
        INSERT INTO finnor_os.artifact_bindings(
          tenant_id,version_id,anchor_id,anchor_hash,target_kind,target_id,target_entity_type,target_anchor,actor_id,created_by
        ) VALUES(
          ${tenantId}::uuid,${created.version.id}::uuid,${sourceAnchor.id},${sourceAnchor.hash},'evidence_version',${evidenceVersionId}::uuid,NULL,NULL,NULL,'system:microsoft-graph-worker'
        ) ON CONFLICT DO NOTHING
      `);
    }
  });
  await indexArtifactMemory(tenantId, documentId, created.version.id, created.ir);
  logWithTrace({ traceId, tenantId }).info({ event: "artifact_materialized", documentId, versionId: created.version.id, replayed: false, format: ir.kind, sizeBytes: downloaded.bytes.length }, "[artifact] provider materialization complete");
};

export function artifactMaterializationRetry(error: unknown): { retryable: boolean; retryAfterMs?: number } {
  return error instanceof MicrosoftGraphError ? { retryable: error.retryable, retryAfterMs: error.retryAfterMs } : { retryable: false };
}
