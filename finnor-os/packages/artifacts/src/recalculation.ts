import { sql } from "drizzle-orm";
import { evaluateAuthority } from "@finnor/authority";
import { withTenant, type Db } from "@finnor/db";
import { appendDocumentVersion, loadDocumentVersion, recordBusinessEvent, setDocumentVersionHead, type DocumentVersion } from "@finnor/data-platform";
import {
  MicrosoftDelegatedExcelTransport,
  MicrosoftDriveArtifactTransport,
  MicrosoftGraphClient,
  type MicrosoftGraphMutationAudit,
  type MicrosoftDriveItemMetadata,
} from "@finnor/provider-microsoft365";
import { ProviderAuthError, resolveMicrosoftDelegatedAuthContext } from "@finnor/security";
import { diffIR, ensure, type SemanticIR } from "@finnor/ooxml";
import {
  claimOwnedExternalOperation,
  markOwnedExternalOperationDivergent,
  readOwnedExternalOperation,
  reconcileOwnedExternalOperation,
  recordOwnedExternalOperationResult,
  type ClaimedProviderOperation,
  type ExternalOperationRow,
} from "@finnor/tools";
import type { ArtifactActor } from "./service";
import { interpret, loadArtifactIRSnapshot, saveArtifactIRSnapshot } from "./service";
import { recordArtifactMetric } from "./telemetry";
import { artifactOperationRequestHash, microsoftGraphMutationAudit } from "./provider-operation";

export interface RecalculationRange {
  worksheetId: string;
  address: string;
}

interface ExcelTransport {
  createSession(driveId: string, itemId: string, persistChanges?: boolean): Promise<string>;
  readRange(driveId: string, itemId: string, worksheetId: string, address: string, sessionId?: string): Promise<Record<string, unknown>>;
  calculate(driveId: string, itemId: string, sessionId: string, calculationType?: "Recalculate" | "Full" | "FullRebuild"): Promise<void>;
  closeSession(driveId: string, itemId: string, sessionId: string): Promise<void>;
}

interface FileTransport {
  metadata(identity: { driveId: string; itemId: string }): Promise<MicrosoftDriveItemMetadata>;
  download(identity: { driveId: string; itemId: string }): Promise<{ metadata: MicrosoftDriveItemMetadata; bytes: Buffer }>;
}

export interface ArtifactRecalculationDependencies {
  transports(actor: ArtifactActor, mutationAudit?: MicrosoftGraphMutationAudit): Promise<{ excel: ExcelTransport; file: FileTransport }>;
}

export const defaultArtifactRecalculationDependencies: ArtifactRecalculationDependencies = {
  async transports(actor, mutationAudit) {
    const auth = await resolveMicrosoftDelegatedAuthContext({ tenantId: actor.tenantId, principalId: actor.employeeId ?? actor.userId });
    const client = new MicrosoftGraphClient(auth, { ...(mutationAudit ? { mutationAudit } : {}) });
    return {
      excel: new MicrosoftDelegatedExcelTransport(client),
      file: new MicrosoftDriveArtifactTransport(client, "delegated"),
    };
  },
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function loadBinding(db: Db, actor: ArtifactActor, documentId: string, versionId: string, requireCurrentProviderHead: boolean) {
  const result = await db.execute(sql`
    SELECT r.id::text external_ref_id,r.integration_id::text,r.external_id,r.observed_state,
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
  ensure(row, "MICROSOFT_DOCUMENT_BINDING_NOT_FOUND");
  if (requireCurrentProviderHead) ensure(row.provider_head_version_id === versionId, "STALE_PROVIDER_BASE_VERSION");
  const payload = object(row.observed_state);
  ensure(typeof payload.driveId === "string" && typeof payload.id === "string", "MICROSOFT_FILE_IDENTITY_MISSING");
  return {
    externalRefId: String(row.external_ref_id),
    integrationId: String(row.integration_id),
    externalId: String(row.external_id),
    driveId: payload.driveId,
    itemId: payload.id,
    providerHeadVersionId: String(row.provider_head_version_id),
  };
}

const recalculationOperationKey = (versionId: string): string => `artifact-recalculate:${versionId}:full-rebuild`;

function recalculationRequestHash(input: {
  documentId: string;
  versionId: string;
  integrationId: string;
  driveId: string;
  itemId: string;
}): string {
  return artifactOperationRequestHash({ ...input, calculationType: "FullRebuild" });
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
  const owner = { type: "artifact_operation" as const, key: input.documentId };
  const operationKey = recalculationOperationKey(input.versionId);
  let providerOperation: ExternalOperationRow | null = await readOwnedExternalOperation(actor.tenantId, owner, operationKey);
  const prepared = await withTenant(actor.tenantId, async (db) => {
    const loaded = await loadDocumentVersion(db, actor.tenantId, input.documentId, input.versionId);
    ensure(loaded && (loaded.version.format === "xlsx" || loaded.version.format === "xlsm"), "RECALCULATION_REQUIRES_WORKBOOK");
    const snapshot = await loadArtifactIRSnapshot(db, actor.tenantId, input.versionId);
    const ir = snapshot?.ir ?? await interpret(loaded.bytes);
    const binding = await loadBinding(db, actor, input.documentId, input.versionId, providerOperation === null);
    return { loaded, ir, binding };
  });
  const providerRequestHash = recalculationRequestHash({
    documentId: input.documentId,
    versionId: input.versionId,
    integrationId: prepared.binding.integrationId,
    driveId: prepared.binding.driveId,
    itemId: prepared.binding.itemId,
  });
  if (providerOperation && providerOperation.requestHash !== providerRequestHash) {
    throw new Error("Artifact recalculation logical operation conflicts with immutable provider intent");
  }

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

  // Metadata is read-only and may precede the effect claim. It prevents a new
  // operation from starting against a provider head that already diverged.
  if (!providerOperation) {
    const providerHead = await transports.file.metadata(prepared.binding);
    ensure(providerHead.eTag === prepared.loaded.version.provider_etag, "PROVIDER_BASE_ETAG_MISMATCH");
  }

  const claim = await claimOwnedExternalOperation(
    actor.tenantId,
    owner,
    operationKey,
    providerRequestHash,
    "microsoft_graph",
    undefined,
    undefined,
    {
      protocolVersion: 2,
      targetKey: `${prepared.binding.driveId}/${prepared.binding.itemId}`,
      integrationId: prepared.binding.integrationId,
      retrySafety: "readback_required",
      verification: "readback",
      idempotency: {
        mode: "readback",
        scope: `tenant-integration:${prepared.binding.integrationId}:excel-workbook`,
      },
    },
  );
  let providerClaim: ClaimedProviderOperation | null = claim.claimed ? claim : null;
  providerOperation = claim.claimed ? claim.operation : claim.existing;
  if (providerOperation.requestHash !== providerRequestHash) {
    throw new Error("Artifact recalculation logical operation conflicts with immutable provider intent");
  }

  let mutationAudit: ReturnType<typeof microsoftGraphMutationAudit> | null = null;
  let providerMutationEntered = false;
  if (providerClaim) {
    mutationAudit = microsoftGraphMutationAudit({
      tenantId: actor.tenantId,
      claim: providerClaim,
      logicalRequestHash: providerRequestHash,
    });
    transports = await dependencies.transports(actor, mutationAudit);
  }

  let sessionId: string | null = null;
  const outputs: Array<{ worksheetId: string; address: string; value: Record<string, unknown> }> = [];
  let outputBytes = 0;
  const collectRanges = async (activeSessionId?: string) => {
    for (const range of input.ranges) {
      const value = await transports.excel.readRange(
        prepared.binding.driveId,
        prepared.binding.itemId,
        range.worksheetId,
        range.address,
        activeSessionId,
      );
      const rangeBytes = Buffer.byteLength(JSON.stringify(value));
      ensure(rangeBytes <= 1_048_576, "EXCEL_RANGE_RESPONSE_TOO_LARGE");
      outputBytes += rangeBytes;
      ensure(outputBytes <= 4_194_304, "EXCEL_OUTPUT_RESPONSE_TOO_LARGE");
      outputs.push({ ...range, value });
    }
  };

  try {
    if (providerClaim) {
      const providerHead = await transports.file.metadata(prepared.binding);
      ensure(providerHead.eTag === prepared.loaded.version.provider_etag, "PROVIDER_BASE_ETAG_MISMATCH");
      providerMutationEntered = true;
      sessionId = await transports.excel.createSession(prepared.binding.driveId, prepared.binding.itemId, true);
      await transports.excel.calculate(prepared.binding.driveId, prepared.binding.itemId, sessionId, "FullRebuild");
      providerOperation = await recordOwnedExternalOperationResult(
        actor.tenantId,
        providerOperation.id,
        "succeeded",
        { calculationType: "FullRebuild", providerAcknowledged: true },
        providerClaim.providerOperationAttemptId,
      );
      if (!providerOperation) throw new Error("Artifact recalculation provider acknowledgement was not persisted");
      await collectRanges(sessionId);
    } else {
      // Duplicate delivery performs observation only. Range GETs do not create a
      // workbook session and therefore cannot repeat the consequential calculation.
      await collectRanges();
    }
  } catch (error) {
    if (providerClaim && providerOperation && mutationAudit?.preparedInvocationCount() === 0) {
      await recordOwnedExternalOperationResult(
        actor.tenantId,
        providerOperation.id,
        providerMutationEntered ? "unknown" : "failed",
        {
          failure: error instanceof Error ? error.message : "ARTIFACT_RECALCULATION_FAILED",
          definitePreDispatch: !providerMutationEntered,
        },
        providerClaim.providerOperationAttemptId,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (sessionId) await transports.excel.closeSession(prepared.binding.driveId, prepared.binding.itemId, sessionId).catch(() => undefined);
  }

  const readback = await transports.file.download(prepared.binding);
  const readbackIR = await interpret(readback.bytes, { fileName: readback.metadata.name });
  if (!readbackIsCalculationOnly(prepared.ir, readbackIR)) {
    await markOwnedExternalOperationDivergent(actor.tenantId, providerOperation.id, {
      verification: "divergent",
      driveItemId: readback.metadata.id,
      eTag: readback.metadata.eTag,
      readbackSemanticHash: readbackIR.semanticHash,
    }, providerClaim?.providerOperationAttemptId);
    ensure(false, "EXCEL_RECALCULATION_CHANGED_UNEXPECTED_SEMANTICS");
  }
  if (providerOperation.executionState !== "verified" && providerOperation.executionState !== "reconciled") {
    providerOperation = await reconcileOwnedExternalOperation(actor.tenantId, providerOperation.id, "succeeded", {
      verification: "calculation_only_readback",
      driveItemId: readback.metadata.id,
      eTag: readback.metadata.eTag,
      readbackSemanticHash: readbackIR.semanticHash,
    });
  }
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
      head: { kind: "provider", key: prepared.binding.externalRefId, expectedVersionId: prepared.binding.providerHeadVersionId },
    });
    await saveArtifactIRSnapshot(db, actor.tenantId, version.id, readbackIR, "verified");
    const current = await db.execute(sql`SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${input.documentId}::uuid AND kind='current' AND head_key='default'`);
    await setDocumentVersionHead(db, { tenantId: actor.tenantId, documentId: input.documentId, kind: "current", key: "default", versionId: version.id, expectedVersionId: (current.rows[0]?.version_id as string | undefined) ?? null });
    const priorEvent = await db.execute(sql`SELECT id FROM finnor_os.business_events
      WHERE tenant_id=${actor.tenantId}::uuid AND entity_type='document' AND entity_id=${input.documentId}::uuid
        AND event_type='artifact_excel_recalculated' AND payload->>'operationKey'=${operationKey} LIMIT 1`);
    if (!priorEvent.rows[0]) await recordBusinessEvent(db, {
      tenantId: actor.tenantId,
      entityType: "document",
      entityId: input.documentId,
      eventType: "artifact_excel_recalculated",
      payload: { operationKey, documentVersionId: version.id, sourceVersionId: input.versionId, calculationStatus: "verified", ranges: input.ranges, authorityDecisionId: decision.id },
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
