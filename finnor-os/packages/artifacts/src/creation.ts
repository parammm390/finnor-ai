import { createHash } from "node:crypto";
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
  type MicrosoftDriveCreateInput,
  type MicrosoftDriveItemMetadata,
} from "@finnor/provider-microsoft365";
import {
  resolveMicrosoftDelegatedAuthContext,
  resolveMicrosoftProviderAuthContext,
  type MicrosoftGraphAuthContext,
} from "@finnor/security";
import { ensure, writeZip, type SemanticIR } from "@finnor/ooxml";
import type { ArtifactActor } from "./service";
import { ingestArtifact, interpret, loadArtifactIRSnapshot, saveArtifactIRSnapshot } from "./service";
import { classifyReadback } from "./publication";
import { recordArtifactMetric } from "./telemetry";

export type CreatableArtifactKind = "xlsx" | "docx" | "pptx";

const xml = (value: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`, "utf8");

const rootRelationships = (target: string): Buffer => xml(
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`,
);

function blankWorkbook(): Buffer {
  return writeZip(new Map([
    ["[Content_Types].xml", xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`)],
    ["_rels/.rels", rootRelationships("xl/workbook.xml")],
    ["xl/workbook.xml", xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`)],
    ["xl/_rels/workbook.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)],
    ["xl/worksheets/sheet1.xml", xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t></t></is></c></row></sheetData></worksheet>`)],
    ["xl/styles.xml", xml(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`)],
  ]));
}

function blankDocument(): Buffer {
  return writeZip(new Map([
    ["[Content_Types].xml", xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)],
    ["_rels/.rels", rootRelationships("word/document.xml")],
    ["word/document.xml", xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p w14:paraId="00000001"><w:r><w:t></w:t></w:r></w:p><w:sectPr/></w:body></w:document>`)],
  ]));
}

function blankPresentation(): Buffer {
  return writeZip(new Map([
    ["[Content_Types].xml", xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`)],
    ["_rels/.rels", rootRelationships("ppt/presentation.xml")],
    ["ppt/presentation.xml", xml(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>`)],
    ["ppt/_rels/presentation.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`)],
    ["ppt/slides/slide1.xml", xml(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)],
    ["ppt/slides/_rels/slide1.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`)],
    ["ppt/slideLayouts/slideLayout1.xml", xml(`<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`)],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`)],
    ["ppt/slideMasters/slideMaster1.xml", xml(`<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>`)],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`)],
    ["ppt/theme/theme1.xml", xml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="FINNOR"><a:themeElements><a:clrScheme name="FINNOR"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme><a:fontScheme name="FINNOR"><a:majorFont/><a:minorFont/></a:fontScheme><a:fmtScheme name="FINNOR"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`)],
  ]));
}

export function createBlankArtifactBytes(kind: CreatableArtifactKind): Buffer {
  if (kind === "xlsx") return blankWorkbook();
  if (kind === "docx") return blankDocument();
  return blankPresentation();
}

export async function createBlankArtifact(ctx: ArtifactActor, input: { kind: CreatableArtifactKind; title: string }): Promise<{
  documentId: string;
  version: DocumentVersion;
  ir: SemanticIR;
}> {
  const title = input.title.trim();
  if (!title || title.length > 500) throw new Error("INVALID_ARTIFACT_TITLE");
  const created = await ingestArtifact(ctx, {
    title: title.toLowerCase().endsWith(`.${input.kind}`) ? title : `${title}.${input.kind}`,
    bytes: createBlankArtifactBytes(input.kind),
    origin: "finnor_generated",
  });
  return created;
}

export type ArtifactCreateWriteMode = "APP_ONLY_FILE_CREATE" | "DELEGATED_FILE_CREATE";
export type ArtifactProviderCreationStatus =
  | "prepared"
  | "writing"
  | "acknowledged"
  | "verified"
  | "verified_provider_normalized"
  | "conflict"
  | "verification_failed"
  | "unknown_delivery";

export interface ArtifactProviderCreateTransport {
  createFile(input: MicrosoftDriveCreateInput): Promise<MicrosoftDriveItemMetadata>;
  metadataByPath(input: { driveId: string; parentItemId: string; name: string }): Promise<MicrosoftDriveItemMetadata>;
  download(identity: { driveId: string; itemId: string }): Promise<{ metadata: MicrosoftDriveItemMetadata; bytes: Buffer }>;
}

export interface ArtifactProviderCreationDependencies {
  transport(input: { actor: ArtifactActor; integrationId: string; mode: ArtifactCreateWriteMode }): Promise<ArtifactProviderCreateTransport>;
  enqueue(type: string, payload: Record<string, unknown>, idempotencyKey: string, correlationId?: string): Promise<void>;
}

export const defaultArtifactProviderCreationDependencies: ArtifactProviderCreationDependencies = {
  async transport({ actor, integrationId, mode }) {
    let auth: MicrosoftGraphAuthContext;
    if (mode === "APP_ONLY_FILE_CREATE") {
      auth = await resolveMicrosoftProviderAuthContext({ tenantId: actor.tenantId, integrationId });
    } else {
      auth = await resolveMicrosoftDelegatedAuthContext({ tenantId: actor.tenantId, principalId: actor.employeeId ?? actor.userId });
    }
    return new MicrosoftDriveArtifactTransport(new MicrosoftGraphClient(auth), mode === "APP_ONLY_FILE_CREATE" ? "app_only" : "delegated");
  },
  enqueue: (type, payload, idempotencyKey, correlationId) => enqueueJob(type, payload, idempotencyKey, correlationId, "interactive", 80),
};

interface PreparedProviderCreation {
  id: string;
  status: ArtifactProviderCreationStatus;
  providerItemId: string | null;
  externalRefId: string | null;
  local: { version: DocumentVersion; bytes: Buffer; ir: SemanticIR };
  input: {
    documentId: string;
    localVersionId: string;
    integrationId: string;
    sourceScopeId: string;
    driveId: string;
    parentItemId: string;
    name: string;
    mode: ArtifactCreateWriteMode;
    conflictBehavior: "fail";
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function providerExternalId(driveId: string, itemId: string): string {
  const exact = [driveId, itemId].map((part) => encodeURIComponent(part)).join("/");
  return Buffer.byteLength(exact, "utf8") <= 1_024
    ? exact
    : `sha256:${createHash("sha256").update(JSON.stringify([driveId, itemId])).digest("hex")}`;
}

function safeCreationFailure(error: unknown): string {
  if (error instanceof MicrosoftGraphError) return `MICROSOFT_${error.kind.toUpperCase()}`;
  return "ARTIFACT_PROVIDER_CREATE_FAILED";
}

function providerCreationRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    localVersionId: String(row.local_version_id),
    integrationId: String(row.integration_id),
    sourceScopeId: String(row.source_scope_id),
    driveId: String(row.drive_id),
    parentItemId: String(row.parent_item_id),
    name: String(row.file_name),
    mode: String(row.write_mode) as ArtifactCreateWriteMode,
    conflictBehavior: "fail" as const,
    status: String(row.status) as ArtifactProviderCreationStatus,
    providerItemId: typeof row.provider_item_id === "string" ? row.provider_item_id : null,
    externalRefId: typeof row.external_ref_id === "string" ? row.external_ref_id : null,
    readbackVersionId: typeof row.readback_version_id === "string" ? row.readback_version_id : null,
    providerAck: object(row.provider_ack),
    verificationDiff: Array.isArray(row.verification_diff) ? row.verification_diff : [],
    failure: typeof row.failure === "string" ? row.failure : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function readArtifactProviderCreation(actor: ArtifactActor, documentId: string, creationId: string) {
  return withTenant(actor.tenantId, async (db) => {
    const result = await db.execute(sql`
      SELECT * FROM finnor_os.artifact_provider_creations
      WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${documentId}::uuid AND id=${creationId}::uuid
    `);
    return result.rows[0] ? providerCreationRow(result.rows[0]) : null;
  });
}

async function updateProviderCreation(db: Db, actor: ArtifactActor, creationId: string, input: {
  status: ArtifactProviderCreationStatus;
  providerItemId?: string;
  externalRefId?: string;
  readbackVersionId?: string;
  providerAck?: Record<string, unknown>;
  verificationDiff?: unknown;
  failure?: string;
  terminal?: boolean;
}): Promise<void> {
  await db.execute(sql`
    UPDATE finnor_os.artifact_provider_creations SET
      status=${input.status},
      provider_item_id=coalesce(${input.providerItemId ?? null},provider_item_id),
      external_ref_id=coalesce(${input.externalRefId ?? null}::uuid,external_ref_id),
      readback_version_id=coalesce(${input.readbackVersionId ?? null}::uuid,readback_version_id),
      provider_ack=CASE WHEN ${input.providerAck ? true : false} THEN ${JSON.stringify(input.providerAck ?? {})}::jsonb ELSE provider_ack END,
      verification_diff=CASE WHEN ${input.verificationDiff !== undefined} THEN ${JSON.stringify(input.verificationDiff ?? [])}::jsonb ELSE verification_diff END,
      failure=${input.failure ?? null},
      completed_at=CASE WHEN ${input.terminal ?? false} THEN clock_timestamp() ELSE completed_at END
    WHERE tenant_id=${actor.tenantId}::uuid AND id=${creationId}::uuid
  `);
}

async function prepareProviderCreation(
  actor: ArtifactActor,
  input: PreparedProviderCreation["input"],
): Promise<PreparedProviderCreation> {
  ensure(input.conflictBehavior === "fail", "PROVIDER_CREATE_CONFLICT_BEHAVIOR_MUST_FAIL");
  ensure(input.driveId.trim().length > 0 && input.driveId.length <= 1_024, "INVALID_PROVIDER_DRIVE_ID");
  ensure(input.parentItemId.trim().length > 0 && input.parentItemId.length <= 1_024, "INVALID_PROVIDER_PARENT_ID");
  ensure(input.name.trim().length > 0 && input.name.length <= 255 && !/[\\/\u0000-\u001f]/.test(input.name), "INVALID_PROVIDER_FILE_NAME");

  const prepared = await withTenant(actor.tenantId, async (db) => {
    const loaded = await loadDocumentVersion(db, actor.tenantId, input.documentId, input.localVersionId);
    ensure(loaded, "DOCUMENT_VERSION_NOT_FOUND");
    ensure(["xlsx", "xlsm", "docx", "pptx"].includes(loaded.version.format), "UNSUPPORTED_PROVIDER_CREATE_FORMAT");
    ensure(input.name.toLowerCase().endsWith(`.${loaded.version.format}`), "PROVIDER_FILE_EXTENSION_MISMATCH");
    const snapshot = await loadArtifactIRSnapshot(db, actor.tenantId, input.localVersionId);
    const ir = snapshot?.ir ?? await interpret(loaded.bytes, { fileName: input.name });
    const boundary = await db.execute(sql`
      SELECT s.configuration,s.required_permissions,s.effective_permissions,s.permission_verified_at,
             s.enabled,s.source_kind,i.binding,i.mode
      FROM finnor_os.integration_source_scopes s
      JOIN finnor_os.tenant_integrations i ON i.tenant_id=s.tenant_id AND i.id=s.integration_id
      WHERE s.tenant_id=${actor.tenantId}::uuid AND s.id=${input.sourceScopeId}::uuid
        AND s.integration_id=${input.integrationId}::uuid
    `);
    const row = boundary.rows[0];
    ensure(row && row.binding === "microsoft_graph" && row.mode === "real" && row.source_kind === "sharepoint_drive", "PROVIDER_CREATE_SCOPE_MISMATCH");
    ensure(row.enabled === true && row.permission_verified_at, "PROVIDER_CREATE_PERMISSION_NOT_VERIFIED");
    const configuration = object(row.configuration);
    ensure(configuration.driveId === input.driveId, "PROVIDER_CREATE_DRIVE_OUT_OF_SCOPE");
    if (typeof configuration.rootItemId === "string" && configuration.rootItemId.length > 0) {
      ensure(configuration.rootItemId === input.parentItemId, "PROVIDER_CREATE_FOLDER_OUT_OF_SCOPE");
    }
    const requiredPermissions = Array.isArray(row.required_permissions) ? row.required_permissions.map(String) : [];
    const effectivePermissions = new Set(Array.isArray(row.effective_permissions) ? row.effective_permissions.map(String) : []);
    ensure(requiredPermissions.every((permission) => effectivePermissions.has(permission)), "PROVIDER_CREATE_PERMISSION_NOT_VERIFIED");
    const existing = await db.execute(sql`
      SELECT * FROM finnor_os.artifact_provider_creations
      WHERE tenant_id=${actor.tenantId}::uuid AND integration_id=${input.integrationId}::uuid
        AND drive_id=${input.driveId} AND parent_item_id=${input.parentItemId}
        AND file_name=${input.name} AND local_version_id=${input.localVersionId}::uuid
      LIMIT 1
    `);
    if (existing.rows[0]) {
      const rowValue = providerCreationRow(existing.rows[0]);
      ensure(rowValue.mode === input.mode, "PROVIDER_CREATE_WRITE_MODE_MISMATCH");
      ensure(String(existing.rows[0].expected_semantic_hash) === ir.semanticHash, "PROVIDER_CREATE_SEMANTIC_IDENTITY_MISMATCH");
      return { existing: rowValue, loaded, ir } as const;
    }
    return { loaded, ir } as const;
  });

  const existingCreation = "existing" in prepared ? prepared.existing : undefined;
  if (existingCreation) {
    return { id: existingCreation.id, status: existingCreation.status, providerItemId: existingCreation.providerItemId, externalRefId: existingCreation.externalRefId, local: { ...prepared.loaded, ir: prepared.ir }, input };
  }

  const decision = await evaluateAuthority(actor, {
    operation: "execution",
    capability: "artifact:publish",
    resource: { type: "document", id: input.documentId },
    risk: "medium",
  });
  ensure(decision.outcome === "allowed", decision.outcome === "approval_required" ? "ARTIFACT_PUBLISH_APPROVAL_REQUIRED" : "ARTIFACT_PUBLISH_DENIED");

  return withTenant(actor.tenantId, async (db) => {
    const inserted = await db.execute(sql`
      INSERT INTO finnor_os.artifact_provider_creations(
        tenant_id,document_id,local_version_id,integration_id,source_scope_id,drive_id,parent_item_id,file_name,
        write_mode,conflict_behavior,actor_id,authority_decision_id,expected_semantic_hash,status
      ) VALUES(
        ${actor.tenantId}::uuid,${input.documentId}::uuid,${input.localVersionId}::uuid,${input.integrationId}::uuid,
        ${input.sourceScopeId}::uuid,${input.driveId},${input.parentItemId},${input.name},${input.mode},'fail',
        ${actor.userId}::uuid,${decision.id}::uuid,${prepared.ir.semanticHash},'prepared'
      ) ON CONFLICT(tenant_id,integration_id,drive_id,parent_item_id,file_name,local_version_id)
        DO NOTHING RETURNING id::text
    `);
    let id = inserted.rows[0]?.id as string | undefined;
    if (!id) {
      const raced = await db.execute(sql`
        SELECT id::text,write_mode,expected_semantic_hash FROM finnor_os.artifact_provider_creations
        WHERE tenant_id=${actor.tenantId}::uuid AND integration_id=${input.integrationId}::uuid
          AND drive_id=${input.driveId} AND parent_item_id=${input.parentItemId}
          AND file_name=${input.name} AND local_version_id=${input.localVersionId}::uuid
      `);
      ensure(raced.rows[0]?.write_mode === input.mode && raced.rows[0]?.expected_semantic_hash === prepared.ir.semanticHash, "PROVIDER_CREATE_IDEMPOTENCY_CONFLICT");
      id = raced.rows[0]?.id as string | undefined;
    }
    ensure(id, "PROVIDER_CREATE_IDEMPOTENCY_CONFLICT");
    return { id, status: "prepared", providerItemId: null, externalRefId: null, local: { ...prepared.loaded, ir: prepared.ir }, input };
  });
}

async function finishProviderCreateConflict(actor: ArtifactActor, prepared: PreparedProviderCreation, failure: string, diff: unknown = []) {
  await withTenant(actor.tenantId, (db) => updateProviderCreation(db, actor, prepared.id, {
    status: "conflict",
    verificationDiff: diff,
    failure,
    terminal: true,
  }));
  recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: prepared.input.documentId }, "artifact_publish_conflicts", 1, "count");
  return (await readArtifactProviderCreation(actor, prepared.input.documentId, prepared.id))!;
}

/** Creates a provider file only at an explicit, permission-certified target. The
 * local immutable version exists first; Graph acknowledgement is followed by an
 * exact download and semantic verification before this can return VERIFIED. */
export async function publishNewArtifactToMicrosoft(
  actor: ArtifactActor,
  input: PreparedProviderCreation["input"],
  dependencies: ArtifactProviderCreationDependencies = defaultArtifactProviderCreationDependencies,
) {
  recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: input.documentId }, "artifact_publish_attempts", 1, "count");
  const prepared = await prepareProviderCreation(actor, input);
  const terminal = new Set<ArtifactProviderCreationStatus>(["verified", "verified_provider_normalized", "conflict", "verification_failed"]);
  if (terminal.has(prepared.status)) {
    const result = (await readArtifactProviderCreation(actor, input.documentId, prepared.id))!;
    if (result.externalRefId && (result.status === "verified" || result.status === "verified_provider_normalized")) {
      await dependencies.enqueue("sync_source", {
        tenantId: actor.tenantId,
        integrationId: input.integrationId,
        sourceScopeId: input.sourceScopeId,
        reason: "artifact_provider_create_readback",
      }, `artifact-provider-create-convergence:${prepared.id}`, actor.correlationId);
    }
    return result;
  }

  let effectiveStatus = prepared.status;
  let transport: ArtifactProviderCreateTransport | undefined;
  try {
    transport = await dependencies.transport({ actor, integrationId: input.integrationId, mode: input.mode });
    let acknowledged: MicrosoftDriveItemMetadata | undefined;
    let readback: Awaited<ReturnType<ArtifactProviderCreateTransport["download"]>> | undefined;
    let shouldCreate = false;

    if (effectiveStatus === "prepared") {
      await withTenant(actor.tenantId, (db) => updateProviderCreation(db, actor, prepared.id, { status: "writing" }));
      effectiveStatus = "writing";
      shouldCreate = true;
    } else if ((effectiveStatus === "writing" || effectiveStatus === "unknown_delivery") && !prepared.providerItemId) {
      try {
        acknowledged = await transport.metadataByPath({ driveId: input.driveId, parentItemId: input.parentItemId, name: input.name });
        readback = await transport.download({ driveId: input.driveId, itemId: acknowledged.id });
        const recovery = classifyReadback(prepared.local.ir, await interpret(readback.bytes, { fileName: readback.metadata.name }));
        if (recovery.status === "verification_failed") {
          return finishProviderCreateConflict(actor, prepared, "PROVIDER_CREATE_TARGET_OCCUPIED", recovery.diff);
        }
      } catch (error) {
        if (error instanceof MicrosoftGraphError && error.kind === "not_found") shouldCreate = true;
        else throw error;
      }
    } else if (prepared.providerItemId) {
      acknowledged = { id: prepared.providerItemId } as MicrosoftDriveItemMetadata;
    }

    if (shouldCreate) {
      try {
        acknowledged = await transport.createFile({
          driveId: input.driveId,
          parentItemId: input.parentItemId,
          name: input.name,
          bytes: prepared.local.bytes,
          conflictBehavior: "fail",
        });
      } catch (error) {
        if (error instanceof MicrosoftGraphError && error.kind === "conflict") {
          return finishProviderCreateConflict(actor, prepared, "PROVIDER_CREATE_NAME_CONFLICT");
        }
        throw error;
      }
    }
    ensure(acknowledged?.id, "PROVIDER_CREATE_ACKNOWLEDGEMENT_MISSING");

    if (effectiveStatus === "writing" || effectiveStatus === "unknown_delivery") {
      const externalId = providerExternalId(input.driveId, acknowledged.id);
      const ack = {
        provider: "microsoft_graph",
        driveItemId: acknowledged.id,
        eTag: acknowledged.eTag ?? null,
        cTag: acknowledged.cTag ?? null,
        providerVersionId: acknowledged.providerVersionId ?? null,
        acknowledgedAt: new Date().toISOString(),
        ...(readback ? { recoveredAfterAmbiguousDelivery: true } : {}),
      };
      const externalRefId = await withTenant(actor.tenantId, async (db) => {
        const refId = await recordExternalReferenceAcknowledgement(db, {
          tenantId: actor.tenantId,
          integrationId: input.integrationId,
          provider: "microsoft_graph",
          canonicalEntity: "document",
          canonicalEntityId: input.documentId,
          externalObjectType: "microsoft_drive_item",
          externalId,
        });
        await updateProviderCreation(db, actor, prepared.id, {
          status: "acknowledged",
          providerItemId: acknowledged!.id,
          externalRefId: refId,
          providerAck: ack,
        });
        return refId;
      });
      prepared.providerItemId = acknowledged.id;
      prepared.externalRefId = externalRefId;
      effectiveStatus = "acknowledged";
    }

    ensure(prepared.providerItemId && prepared.externalRefId, "PROVIDER_CREATE_BINDING_MISSING");
    if (!readback) readback = await transport.download({ driveId: input.driveId, itemId: prepared.providerItemId });
    const readbackIR = await interpret(readback.bytes, { fileName: readback.metadata.name });
    const verification = classifyReadback(prepared.local.ir, readbackIR);
    await withTenant(actor.tenantId, async (db) => {
      const version = await appendDocumentVersion(db, {
        tenantId: actor.tenantId,
        documentId: input.documentId,
        bytes: readback!.bytes,
        mediaType: readback!.metadata.mimeType ?? prepared.local.version.media_type,
        format: readbackIR.kind as DocumentVersion["format"],
        origin: "readback",
        actor: actor.userId,
        parentVersionId: input.localVersionId,
        sourceSystem: "microsoft_graph",
        sourceRef: providerExternalId(input.driveId, prepared.providerItemId!),
        providerVersionId: readback!.metadata.providerVersionId ?? undefined,
        providerEtag: readback!.metadata.eTag,
        providerCtag: readback!.metadata.cTag ?? undefined,
        head: { kind: "provider", key: prepared.externalRefId!, expectedVersionId: null },
      });
      await saveArtifactIRSnapshot(db, actor.tenantId, version.id, readbackIR);
      if (verification.status !== "verification_failed") {
        const current = await db.execute(sql`SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=${actor.tenantId}::uuid AND document_id=${input.documentId}::uuid AND kind='current' AND head_key='default'`);
        await setDocumentVersionHead(db, { tenantId: actor.tenantId, documentId: input.documentId, kind: "current", key: "default", versionId: version.id, expectedVersionId: (current.rows[0]?.version_id as string | undefined) ?? null });
        await setDocumentVersionHead(db, { tenantId: actor.tenantId, documentId: input.documentId, kind: "published", key: prepared.externalRefId!, versionId: version.id, expectedVersionId: null });
      }
      await updateProviderCreation(db, actor, prepared.id, {
        status: verification.status,
        readbackVersionId: version.id,
        verificationDiff: verification.diff,
        ...(verification.status === "verification_failed" ? { failure: "UNEXPECTED_PROVIDER_SEMANTIC_CHANGE" } : {}),
        terminal: true,
      });
      await recordBusinessEvent(db, {
        tenantId: actor.tenantId,
        entityType: "document",
        entityId: input.documentId,
        eventType: verification.status === "verification_failed" ? "artifact_provider_create_verification_failed" : "artifact_provider_create_verified",
        payload: { creationId: prepared.id, localVersionId: input.localVersionId, readbackVersionId: version.id, verification: verification.status, providerItemId: prepared.providerItemId, semanticHash: readbackIR.semanticHash },
        source: "microsoft_graph",
      });
    });
    effectiveStatus = verification.status;
    if (verification.status === "verification_failed") {
      recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: input.documentId }, "artifact_publish_verification_failures", 1, "count");
    } else if (verification.status === "verified_provider_normalized") {
      recordArtifactMetric({ tenantId: actor.tenantId, traceId: actor.correlationId, documentId: input.documentId }, "artifact_provider_normalizations", 1, "count");
    }
    const result = (await readArtifactProviderCreation(actor, input.documentId, prepared.id))!;
    await dependencies.enqueue("sync_source", {
      tenantId: actor.tenantId,
      integrationId: input.integrationId,
      sourceScopeId: input.sourceScopeId,
      reason: "artifact_provider_create_readback",
    }, `artifact-provider-create-convergence:${prepared.id}`, actor.correlationId);
    return result;
  } catch (error) {
    if (terminal.has(effectiveStatus)) throw error;
    if (effectiveStatus !== "prepared") {
      const status = error instanceof MicrosoftGraphError && error.retryable ? "unknown_delivery" : "verification_failed";
      await withTenant(actor.tenantId, (db) => updateProviderCreation(db, actor, prepared.id, {
        status,
        failure: safeCreationFailure(error),
        terminal: status === "verification_failed",
      })).catch(() => undefined);
      if (status === "unknown_delivery") return (await readArtifactProviderCreation(actor, input.documentId, prepared.id))!;
    }
    throw error;
  }
}
