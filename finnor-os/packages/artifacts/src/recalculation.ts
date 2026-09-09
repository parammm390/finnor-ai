import { sql } from "drizzle-orm";
import { evaluateAuthority } from "@finnor/authority";
import { withTenant, type Db } from "@finnor/db";
import { appendDocumentVersion, loadDocumentVersion, recordBusinessEvent, setDocumentVersionHead, type DocumentVersion } from "@finnor/data-platform";
import {
  MicrosoftDelegatedExcelTransport,
  MicrosoftDriveArtifactTransport,
  MicrosoftGraphClient,
  type MicrosoftDriveItemMetadata,
} from "@finnor/provider-microsoft365";
import { ProviderAuthError, resolveMicrosoftDelegatedAuthContext } from "@finnor/security";
import { diffIR, ensure, type SemanticIR } from "@finnor/ooxml";
import type { ArtifactActor } from "./service";
import { interpret, loadArtifactIRSnapshot, saveArtifactIRSnapshot } from "./service";
import { recordArtifactMetric } from "./telemetry";

export interface RecalculationRange {
  worksheetId: string;
  address: string;
}

interface ExcelTransport {
  createSession(driveId: string, itemId: string, persistChanges?: boolean): Promise<string>;
  readRange(driveId: string, itemId: string, worksheetId: string, address: string, sessionId: string): Promise<Record<string, unknown>>;
  calculate(driveId: string, itemId: string, sessionId: string, calculationType?: "Recalculate" | "Full" | "FullRebuild"): Promise<void>;
  closeSession(driveId: string, itemId: string, sessionId: string): Promise<void>;
}

interface FileTransport {
  metadata(identity: { driveId: string; itemId: string }): Promise<MicrosoftDriveItemMetadata>;
  download(identity: { driveId: string; itemId: string }): Promise<{ metadata: MicrosoftDriveItemMetadata; bytes: Buffer }>;
}

export interface ArtifactRecalculationDependencies {
  transports(actor: ArtifactActor): Promise<{ excel: ExcelTransport; file: FileTransport }>;
}

export const defaultArtifactRecalculationDependencies: ArtifactRecalculationDependencies = {
  async transports(actor) {
    const auth = await resolveMicrosoftDelegatedAuthContext({ tenantId: actor.tenantId, principalId: actor.employeeId ?? actor.userId });
    const client = new MicrosoftGraphClient(auth);
    return {
      excel: new MicrosoftDelegatedExcelTransport(client),
      file: new MicrosoftDriveArtifactTransport(client, "delegated"),
    };
  },
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function loadBinding(db: Db, actor: ArtifactActor, documentId: string, versionId: string) {
  const result = await db.execute(sql`
    SELECT r.id::text external_ref_id,r.external_id,r.observed_state,
           h.version_id::text provider_head_version_id
    FROM finnor_os.external_refs r
    JOIN finnor_os.document_version_heads h
      ON h.tenant_id=r.tenant_id AND h.document_id=r.internal_id AND h.kind='provider' AND h.head_key=r.id::text
    WHERE r.tenant_id=${actor.tenantId}::uuid AND r.internal_id=${documentId}::uuid AND r.entity='document'
      AND r.provider='microsoft_graph' AND r.external_object_type='microsoft_drive_item'
      AND r.mapping_status='mapped' AND NOT r.provider_deleted
    ORDER BY r.updated_at DESC LIMIT 1
  `);
  const row = result.rows[0];
  ensure(row && row.provider_head_version_id === versionId, "STALE_PROVIDER_BASE_VERSION");
  const payload = object(row.observed_state);
  ensure(typeof payload.driveId === "string" && typeof payload.id === "string", "MICROSOFT_FILE_IDENTITY_MISSING");
  return {
    externalRefId: String(row.external_ref_id),
    externalId: String(row.external_id),
    driveId: payload.driveId,
    itemId: payload.id,
    providerHeadVersionId: String(row.provider_head_version_id),
  };
}

function validRange(range: RecalculationRange): boolean {
  return range.worksheetId.length > 0 && range.worksheetId.length <= 512
    && range.address.length > 0 && range.address.length <= 512
    && !/[\u0000-\u001f]/.test(range.worksheetId + range.address);
}

function readbackIsCalculationOnly(before: SemanticIR, after: SemanticIR): boolean {
  return diffIR(before, after).every((change) =>
    change.kind === "cached-value-change"
    || (change.kind === "modified" && change.id === "workbook")
    || (change.kind === "OPAQUE_PART_CHANGED" && ["docProps/core.xml", "docProps/app.xml", "xl/calcChain.xml"].includes(change.id)),
  );
}

async function recalculateArtifactWorkbookInternal(
  actor: ArtifactActor,
  input: { documentId: string; versionId: string; ranges: RecalculationRange[] },
  dependencies: ArtifactRecalculationDependencies = defaultArtifactRecalculationDependencies,
) {
  ensure(input.ranges.length > 0 && input.ranges.length <= 100 && input.ranges.every(validRange), "INVALID_RECALCULATION_RANGES");
  const prepared = await withTenant(actor.tenantId, async (db) => {
    const loaded = await loadDocumentVersion(db, actor.tenantId, input.documentId, input.versionId);
    ensure(loaded && (loaded.version.format === "xlsx" || loaded.version.format === "xlsm"), "RECALCULATION_REQUIRES_WORKBOOK");
    const snapshot = await loadArtifactIRSnapshot(db, actor.tenantId, input.versionId);
    const ir = snapshot?.ir ?? await interpret(loaded.bytes);
    const binding = await loadBinding(db, actor, input.documentId, input.versionId);
    return { loaded, ir, binding };
  });

  const decision = await evaluateAuthority(actor, {
    operation: "execution",
    capability: "artifact:recalculate",
    resource: { type: "document", id: input.documentId },
    risk: "medium",
  });
  ensure(decision.outcome === "allowed", decision.outcome === "approval_required" ? "ARTIFACT_RECALCULATION_APPROVAL_REQUIRED" : "ARTIFACT_RECALCULATION_DENIED");

  let transports: { excel: ExcelTransport; file: FileTransport };
  try {
    transports = await dependencies.transports(actor);
  } catch (error) {
    if (error instanceof ProviderAuthError) {
      return { status: "stale" as const, versionId: input.versionId, reason: "DELEGATED_EXCEL_UNAVAILABLE", outputs: [] };
    }
    throw error;
  }

  let sessionId: string | null = null;
  const outputs: Array<{ worksheetId: string; address: string; value: Record<string, unknown> }> = [];
  let outputBytes = 0;
  try {
    const providerHead = await transports.file.metadata(prepared.binding);
    ensure(providerHead.eTag === prepared.loaded.version.provider_etag, "PROVIDER_BASE_ETAG_MISMATCH");
    sessionId = await transports.excel.createSession(prepared.binding.driveId, prepared.binding.itemId, true);
    await transports.excel.calculate(prepared.binding.driveId, prepared.binding.itemId, sessionId, "FullRebuild");
    for (const range of input.ranges) {
      const value = await transports.excel.readRange(prepared.binding.driveId, prepared.binding.itemId, range.worksheetId, range.address, sessionId);
      const rangeBytes = Buffer.byteLength(JSON.stringify(value));
      ensure(rangeBytes <= 1_048_576, "EXCEL_RANGE_RESPONSE_TOO_LARGE");
      outputBytes += rangeBytes;
      ensure(outputBytes <= 4_194_304, "EXCEL_OUTPUT_RESPONSE_TOO_LARGE");
      outputs.push({ ...range, value });
    }
  } finally {
    if (sessionId) await transports.excel.closeSession(prepared.binding.driveId, prepared.binding.itemId, sessionId).catch(() => undefined);
  }

  const readback = await transports.file.download(prepared.binding);
  const readbackIR = await interpret(readback.bytes, { fileName: readback.metadata.name });
  ensure(readbackIsCalculationOnly(prepared.ir, readbackIR), "EXCEL_RECALCULATION_CHANGED_UNEXPECTED_SEMANTICS");
  const result = await withTenant(actor.tenantId, async (db) => {
    const version = await appendDocumentVersion(db, {
      tenantId: actor.tenantId,
      documentId: input.documentId,
      bytes: readback.bytes,
      mediaType: readback.metadata.mimeType ?? prepared.loaded.version.media_type,
      format: readbackIR.kind as DocumentVersion["format"],
      origin: "readback",
      actor: actor.userId,
      parentVersionId: input.versionId,
      sourceSystem: "microsoft_graph_excel",
      sourceRef: prepared.binding.externalId,
      providerVersionId: readback.metadata.providerVersionId ?? undefined,
      providerEtag: readback.metadata.eTag,
      providerCtag: readback.metadata.cTag ?? undefined,
      head: { kind: "provider", key: prepared.binding.externalRefId, expectedVersionId: input.versionId },
    });
    await saveArtifactIRSnapshot(db, actor.tenantId, version.id, readbackIR, "verified");
    const current = await db.execute(sql`SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${input.documentId}::uuid AND kind='current' AND head_key='default'`);
    await setDocumentVersionHead(db, { tenantId: actor.tenantId, documentId: input.documentId, kind: "current", key: "default", versionId: version.id, expectedVersionId: (current.rows[0]?.version_id as string | undefined) ?? null });
    await recordBusinessEvent(db, {
      tenantId: actor.tenantId,
      entityType: "document",
      entityId: input.documentId,
      eventType: "artifact_excel_recalculated",
      payload: { documentVersionId: version.id, sourceVersionId: input.versionId, calculationStatus: "verified", ranges: input.ranges, authorityDecisionId: decision.id },
      source: "microsoft_graph_excel",
    });
    return version;
  });
  return { status: "verified" as const, versionId: result.id, outputs };
}

export async function recalculateArtifactWorkbook(
  actor: ArtifactActor,
  input: { documentId: string; versionId: string; ranges: RecalculationRange[] },
  dependencies: ArtifactRecalculationDependencies = defaultArtifactRecalculationDependencies,
) {
  const started = Date.now();
  const context = { tenantId: actor.tenantId, traceId: actor.correlationId, documentId: input.documentId, versionId: input.versionId, format: "xlsx" };
  try {
    const result = await recalculateArtifactWorkbookInternal(actor, input, dependencies);
    recordArtifactMetric(context, "artifact_excel_recalc_latency", Date.now() - started, "milliseconds");
    if (result.status === "stale") {
      recordArtifactMetric(context, "artifact_excel_recalc_failures", 1, "count");
      recordArtifactMetric(context, "artifact_stale_calculation_count", 1, "count");
    }
    return result;
  } catch (error) {
    recordArtifactMetric(context, "artifact_excel_recalc_latency", Date.now() - started, "milliseconds");
    recordArtifactMetric(context, "artifact_excel_recalc_failures", 1, "count");
    recordArtifactMetric(context, "artifact_stale_calculation_count", 1, "count");
    throw error;
  }
}
