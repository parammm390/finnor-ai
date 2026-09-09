import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withTenant, type Db } from "@finnor/db";
import {
  appendDocumentVersion,
  createDocument,
  documentHeads,
  listDocumentVersions,
  loadDocumentVersion,
  recordBusinessEvent,
  type DocumentFormat,
  type DocumentVersionOrigin,
} from "@finnor/data-platform";
import {
  ARTIFACT_LIMITS,
  ArtifactError,
  OfficePackage,
  canonical,
  diffIR,
  ensure,
  semanticHash,
  sha256,
  withArtifactDeadline,
  type SemanticIR,
  type SemanticNode,
} from "@finnor/ooxml";
import { parseWorkbook, patchWorkbook, rangeAddresses, type SpreadsheetOperation } from "@finnor/spreadsheet-ir";
import { parseDocument, patchDocument, type DocumentOperation } from "@finnor/document-ir";
import { parsePresentation, patchPresentation, type PresentationOperation } from "@finnor/presentation-ir";
import type { Role } from "@finnor/shared-types";
import { recordArtifactMetric } from "./telemetry";

export interface ArtifactActor {
  tenantId: string;
  userId: string;
  role: Role;
  employeeId?: string;
  correlationId?: string;
}

export const MEDIA: Record<DocumentFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  unknown: "application/octet-stream",
};

export type CalculationStatus = "not_applicable" | "unknown" | "stale" | "verified";

function withWarning(ir: SemanticIR, warning: string): SemanticIR {
  const warnings = [...new Set([...ir.warnings, warning])].sort();
  const { semanticHash: _oldHash, ...base } = ir;
  const value = { ...base, warnings };
  return { ...value, semanticHash: semanticHash(value) };
}

function expectedExtension(title: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(title.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function inferredCalculationStatus(ir: SemanticIR): CalculationStatus {
  if (ir.kind !== "xlsx" && ir.kind !== "xlsm") return "not_applicable";
  const formulas = ir.nodes.filter((item) => item.kind === "cell" && item.data.formula !== null);
  if (!formulas.length) return "not_applicable";
  return formulas.some((item) => item.data.calculation === "cached_stale" || item.data.calculation === "uncalculated") ? "stale" : "unknown";
}

export async function interpret(bytes: Buffer, options: { fileName?: string; timeoutMs?: number } = {}): Promise<SemanticIR> {
  ensure(bytes.length <= ARTIFACT_LIMITS.bytes, "ARTIFACT_TOO_LARGE");
  const timeoutMs = options.timeoutMs ?? ARTIFACT_LIMITS.parseMs;
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, "INVALID_ARTIFACT_PARSE_TIMEOUT");
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => {
    const value = deadline - Date.now();
    ensure(value > 0, "ARTIFACT_PARSE_TIMEOUT");
    return value;
  };
  let ir: SemanticIR;
  if (bytes.subarray(0, 5).toString() === "%PDF-") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try {
      const info = await withArtifactDeadline(parser.getInfo(), remaining());
      ensure(info.total <= ARTIFACT_LIMITS.pdfPages, "PDF_PAGE_LIMIT");
      const text = await withArtifactDeadline(parser.getText(), remaining());
      const nodes = text.pages.map((page) => {
        const data = {
          page: page.num,
          text: page.text,
          status: page.text.trim() ? "TEXT_AVAILABLE" : "TEXT_UNAVAILABLE_OCR_REQUIRED",
          editable: false,
        };
        return {
          id: `pdf:page:${page.num}`,
          part: "pdf",
          path: `page:${page.num}`,
          kind: "page",
          data,
          hash: semanticHash(data),
        };
      });
      const base = {
        schema: "pdf-ir.v1",
        kind: "pdf",
        nodes,
        warnings: nodes.some((node) => node.data.status !== "TEXT_AVAILABLE") ? ["OCR_REQUIRED"] : [],
        opaqueParts: { pdf: sha256(bytes) },
      };
      ensure(Buffer.byteLength(canonical(base)) <= ARTIFACT_LIMITS.irBytes, "IR_TOO_LARGE");
      ir = { ...base, semanticHash: semanticHash(base) };
    } finally {
      await parser.destroy();
    }
  } else {
    const pkg = new OfficePackage(bytes);
    ir = pkg.format === "xlsx" || pkg.format === "xlsm"
      ? parseWorkbook(pkg)
      : pkg.format === "docx"
        ? parseDocument(pkg)
        : parsePresentation(pkg);
  }
  remaining();
  const extension = options.fileName ? expectedExtension(options.fileName) : null;
  if (extension && extension !== ir.kind) ir = withWarning(ir, `EXTENSION_FORMAT_MISMATCH:${extension}->${ir.kind}`);
  return ir;
}

export async function saveArtifactIRSnapshot(
  db: Db,
  tenantId: string,
  versionId: string,
  ir: SemanticIR,
  calculationStatus: CalculationStatus = inferredCalculationStatus(ir),
): Promise<void> {
  await db.execute(sql`
    INSERT INTO finnor_os.artifact_ir_snapshots(
      tenant_id,version_id,parser_schema,kind,semantic_hash,parse_status,fidelity_status,calculation_status,ir,warnings,unsupported_features
    ) VALUES(
      ${tenantId}::uuid,${versionId}::uuid,${ir.schema},${ir.kind},${ir.semanticHash},'parsed',
      ${ir.kind === "pdf" ? "read_only" : "preserved"},${calculationStatus},${JSON.stringify(ir)}::jsonb,${JSON.stringify(ir.warnings)}::jsonb,
      ${JSON.stringify(ir.warnings.filter((warning) => /UNSUPPORTED|OPAQUE|PRESERVED|EXTERNAL|DYNAMIC|OCR_REQUIRED/.test(warning)))}::jsonb
    ) ON CONFLICT DO NOTHING
  `);
  const result = await db.execute(sql`
    SELECT semantic_hash,calculation_status FROM finnor_os.artifact_ir_snapshots
    WHERE tenant_id=${tenantId}::uuid AND version_id=${versionId}::uuid AND parser_schema=${ir.schema}
  `);
  ensure(result.rows[0]?.semantic_hash === ir.semanticHash, "IR_SNAPSHOT_IDENTITY_CONFLICT");
}

export async function loadArtifactIRSnapshot(db: Db, tenantId: string, versionId: string): Promise<{ ir: SemanticIR; calculationStatus: CalculationStatus } | null> {
  const result = await db.execute(sql`
    SELECT ir,calculation_status FROM finnor_os.artifact_ir_snapshots
    WHERE tenant_id=${tenantId}::uuid AND version_id=${versionId}::uuid AND parse_status='parsed'
    ORDER BY created_at DESC LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { ir: row.ir as SemanticIR, calculationStatus: row.calculation_status as CalculationStatus };
}

export async function ingestArtifact(ctx: ArtifactActor, input: {
  documentId?: string;
  title: string;
  bytes: Buffer;
  origin: DocumentVersionOrigin;
  parentVersionId?: string;
  sourceSystem?: string;
  sourceRef?: string;
  providerEtag?: string;
  providerCtag?: string;
  providerVersionId?: string;
  headKind?: "current" | "provider";
  headKey?: string;
  expectedHead?: string | null;
  calculationStatus?: CalculationStatus;
}) {
  const materializationStarted = Date.now();
  const metricContext = { tenantId: ctx.tenantId, traceId: ctx.correlationId, documentId: input.documentId };
  recordArtifactMetric(metricContext, "artifact_bytes", input.bytes.length, "bytes");
  const parseStarted = Date.now();
  let ir: SemanticIR;
  try {
    ir = await interpret(input.bytes, { fileName: input.title });
  } catch (error) {
    recordArtifactMetric(metricContext, "artifact_parse_latency", Date.now() - parseStarted, "milliseconds");
    recordArtifactMetric(metricContext, "artifact_parse_failures", 1, "count");
    throw error;
  }
  recordArtifactMetric({ ...metricContext, format: ir.kind }, "artifact_parse_latency", Date.now() - parseStarted, "milliseconds");
  recordArtifactMetric({ ...metricContext, format: ir.kind }, "artifact_ir_bytes", Buffer.byteLength(canonical(ir)), "bytes");
  recordArtifactMetric({ ...metricContext, format: ir.kind }, "artifact_unsupported_features", ir.warnings.length, "count");
  const result = await withTenant(ctx.tenantId, async (db) => {
    let documentId = input.documentId;
    if (!documentId) {
      documentId = (await createDocument(db, {
        tenantId: ctx.tenantId,
        kind: ir.kind,
        title: input.title,
        provenance: { createdBy: ctx.userId, sourceSystem: input.origin },
      })).documentId;
    }
    const version = await appendDocumentVersion(db, {
      tenantId: ctx.tenantId,
      documentId,
      bytes: input.bytes,
      mediaType: MEDIA[ir.kind as DocumentFormat],
      format: ir.kind as DocumentFormat,
      origin: input.origin,
      actor: ctx.userId,
      parentVersionId: input.parentVersionId,
      sourceSystem: input.sourceSystem,
      sourceRef: input.sourceRef,
      providerEtag: input.providerEtag,
      providerCtag: input.providerCtag,
      providerVersionId: input.providerVersionId,
      head: {
        kind: input.headKind ?? "current",
        key: input.headKey ?? "default",
        expectedVersionId: input.expectedHead ?? null,
      },
    });
    await saveArtifactIRSnapshot(db, ctx.tenantId, version.id, ir, input.calculationStatus);
    await recordBusinessEvent(db, {
      tenantId: ctx.tenantId,
      entityType: "document",
      entityId: documentId,
      eventType: "document_version_observed",
      payload: { documentVersionId: version.id, format: ir.kind, semanticHash: ir.semanticHash, origin: input.origin },
      source: input.sourceSystem,
    });
    return { documentId, version, ir, calculationStatus: input.calculationStatus ?? inferredCalculationStatus(ir) };
  });
  const completedContext = { ...metricContext, documentId: result.documentId, versionId: result.version.id, format: ir.kind };
  recordArtifactMetric(completedContext, "artifact_versions_created", 1, "count");
  recordArtifactMetric(completedContext, "artifact_materializations_total", 1, "count");
  recordArtifactMetric(completedContext, "artifact_materialization_latency", Date.now() - materializationStarted, "milliseconds");
  return result;
}

export async function getArtifact(ctx: ArtifactActor, documentId: string, versionId?: string) {
  return withTenant(ctx.tenantId, async (db) => {
    const documentResult = await db.execute(sql`
      SELECT id::text,title,kind,storage_ref,source_system,external_id,created_at,archived_at
      FROM finnor_os.documents WHERE tenant_id=${ctx.tenantId}::uuid AND id=${documentId}::uuid
    `);
    const document = documentResult.rows[0];
    ensure(document, "DOCUMENT_NOT_FOUND");
    const versions = await listDocumentVersions(db, ctx.tenantId, documentId);
    const heads = await documentHeads(db, ctx.tenantId, documentId);
    const id = versionId ?? heads.find((head) => head.kind === "current" && head.head_key === "default")?.version_id ?? versions[0]?.id;
    ensure(id, "DOCUMENT_VERSION_NOT_FOUND");
    const loaded = await loadDocumentVersion(db, ctx.tenantId, documentId, id);
    ensure(loaded, "DOCUMENT_VERSION_NOT_FOUND");
    const snapshot = await loadArtifactIRSnapshot(db, ctx.tenantId, id);
    const ir = snapshot?.ir ?? await interpret(loaded.bytes);
    return { document, version: loaded.version, versions, heads, ir, calculationStatus: snapshot?.calculationStatus ?? inferredCalculationStatus(ir) };
  });
}

export async function queryArtifactIR(ctx: ArtifactActor, documentId: string, versionId: string, input: {
  ids?: string[];
  kinds?: string[];
  search?: string;
  sheetId?: string;
  address?: string;
  range?: string;
  dependencyOf?: string;
  dependentOf?: string;
  offset?: number;
  limit?: number;
} = {}) {
  const artifact = await getArtifact(ctx, documentId, versionId);
  const ids = input.ids?.slice(0, 200);
  const kinds = input.kinds?.slice(0, 20);
  const search = input.search?.trim().toLowerCase().slice(0, 200);
  ensure(!(input.dependencyOf && input.dependentOf), "AMBIGUOUS_RELATION_QUERY");
  const exactRange = input.range ? rangeAddresses(input.range) : null;
  ensure(!exactRange || exactRange.length <= 5_000, "IR_RANGE_QUERY_LIMIT");
  const rangeSet = exactRange ? new Set(exactRange) : null;
  let relationIds: Set<string> | null = null;
  const relationTargetId = input.dependencyOf ?? input.dependentOf;
  if (relationTargetId) {
    ensure(artifact.ir.kind === "xlsx" || artifact.ir.kind === "xlsm", "RELATION_QUERY_REQUIRES_WORKBOOK");
    const target = artifact.ir.nodes.find((node) => node.id === relationTargetId);
    ensure(target, "ARTIFACT_ANCHOR_NOT_FOUND");
    if (input.dependentOf) {
      relationIds = new Set(Array.isArray(target.data.dependents) ? target.data.dependents.map(String) : []);
    } else {
      relationIds = new Set<string>();
      const sheets = new Map(artifact.ir.nodes.filter((node) => node.kind === "worksheet").map((node) => [String(node.data.name), node.id.replace(/^sheet:/, "")]));
      for (const dependency of Array.isArray(target.data.dependencies) ? target.data.dependencies : []) {
        const item = dependency && typeof dependency === "object" && !Array.isArray(dependency) ? dependency as Record<string, unknown> : {};
        const sheetId = sheets.get(String(item.sheet ?? ""));
        if (!sheetId || typeof item.range !== "string") continue;
        const addresses = rangeAddresses(item.range);
        ensure(relationIds.size + addresses.length <= 5_000, "IR_RELATION_QUERY_LIMIT");
        for (const address of addresses) relationIds.add(`cell:${sheetId}!${address}`);
      }
    }
  }
  const filtered = artifact.ir.nodes.filter((node) => {
    if (ids?.length && !ids.includes(node.id)) return false;
    if (kinds?.length && !kinds.includes(node.kind)) return false;
    if (input.sheetId && node.id !== `sheet:${input.sheetId}` && String(node.data.sheetId ?? "") !== input.sheetId) return false;
    if (input.address && !(node.kind === "cell" && node.data.address === input.address)) return false;
    if (rangeSet && !(node.kind === "cell" && rangeSet.has(String(node.data.address ?? "")))) return false;
    if (relationIds && !relationIds.has(node.id)) return false;
    if (search && !canonical(node.data).toLowerCase().includes(search) && !node.id.toLowerCase().includes(search)) return false;
    return true;
  });
  const requestedOffset = Number.isSafeInteger(input.offset) ? input.offset! : 0;
  const requestedLimit = Number.isSafeInteger(input.limit) ? input.limit! : 100;
  const offset = Math.min(Math.max(requestedOffset, 0), filtered.length);
  const limit = Math.min(Math.max(requestedLimit, 1), 500);
  return {
    schema: artifact.ir.schema,
    kind: artifact.ir.kind,
    semanticHash: artifact.ir.semanticHash,
    calculationStatus: artifact.calculationStatus,
    total: filtered.length,
    offset,
    limit,
    nodes: filtered.slice(offset, offset + limit),
    warnings: artifact.ir.warnings,
    relation: relationTargetId ? { direction: input.dependencyOf ? "dependencies" : "dependents", anchorId: relationTargetId } : null,
  };
}

export async function createDraft(ctx: ArtifactActor, documentId: string, baseVersionId: string): Promise<{ draftKey: string; versionId: string }> {
  return withTenant(ctx.tenantId, async (db) => {
    ensure(await loadDocumentVersion(db, ctx.tenantId, documentId, baseVersionId), "DOCUMENT_VERSION_NOT_FOUND");
    const draftKey = `${ctx.userId}:${randomUUID()}`;
    await db.execute(sql`
      INSERT INTO finnor_os.document_version_heads(tenant_id,document_id,kind,head_key,version_id)
      VALUES(${ctx.tenantId}::uuid,${documentId}::uuid,'draft',${draftKey},${baseVersionId}::uuid)
    `);
    return { draftKey, versionId: baseVersionId };
  });
}

export interface ArtifactPatch {
  baseVersionId: string;
  draftKey: string;
  operations: Array<SpreadsheetOperation | DocumentOperation | PresentationOperation>;
  expectedSemanticHash?: string;
}

export function remapArtifactAnchor(node: SemanticNode, after: SemanticIR): { target: SemanticNode | null; status: "exact" | "stale" | "ambiguous"; reason: string } {
  const sameId = after.nodes.find((candidate) => candidate.id === node.id);
  if (sameId) return { target: sameId, status: "exact", reason: sameId.hash === node.hash ? "stable_identity_unchanged" : "stable_identity_modified" };
  const candidates = after.nodes.filter((candidate) => candidate.kind === node.kind && candidate.hash === node.hash);
  if (candidates.length === 1) return { target: candidates[0]!, status: "exact", reason: "unique_semantic_match" };
  if (candidates.length > 1) return { target: null, status: "ambiguous", reason: "multiple_semantic_matches" };
  return { target: null, status: "stale", reason: "anchor_removed_or_unresolved" };
}

async function recordAnchorRemaps(db: Db, ctx: ArtifactActor, baseVersionId: string, resultVersionId: string, before: SemanticIR, after: SemanticIR): Promise<void> {
  const references = await db.execute(sql`
    SELECT anchor_id,anchor_hash FROM finnor_os.artifact_comments WHERE tenant_id=${ctx.tenantId}::uuid AND version_id=${baseVersionId}::uuid
    UNION
    SELECT anchor_id,anchor_hash FROM finnor_os.artifact_bindings WHERE tenant_id=${ctx.tenantId}::uuid AND version_id=${baseVersionId}::uuid
  `);
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  for (const row of references.rows) {
    const anchorId = String(row.anchor_id);
    const node = beforeById.get(anchorId);
    if (!node || node.hash !== row.anchor_hash) continue;
    const remap = remapArtifactAnchor(node, after);
    await db.execute(sql`
      INSERT INTO finnor_os.artifact_anchor_remaps(
        tenant_id,source_version_id,target_version_id,source_anchor_id,source_anchor_hash,target_anchor_id,target_anchor_hash,status,reason
      ) VALUES(
        ${ctx.tenantId}::uuid,${baseVersionId}::uuid,${resultVersionId}::uuid,${node.id},${node.hash},
        ${remap.target?.id ?? null},${remap.target?.hash ?? null},${remap.status},${remap.reason}
      ) ON CONFLICT DO NOTHING
    `);
  }
}

async function applyArtifactPatchInternal(ctx: ArtifactActor, documentId: string, patch: ArtifactPatch) {
  ensure(patch && typeof patch === "object" && typeof patch.baseVersionId === "string" && typeof patch.draftKey === "string" && Array.isArray(patch.operations), "INVALID_ARTIFACT_PATCH");
  ensure(patch.operations.length > 0 && patch.operations.length <= 1_000 && Buffer.byteLength(canonical(patch)) <= 1_048_576, "PATCH_LIMIT");
  ensure(patch.draftKey.startsWith(`${ctx.userId}:`), "DRAFT_ACTOR_MISMATCH");
  const patchHash = semanticHash(patch);
  const prepared = await withTenant(ctx.tenantId, async (db) => {
    const replay = await db.execute(sql`
      SELECT result_version_id,semantic_diff,status,error FROM finnor_os.artifact_operations
      WHERE tenant_id=${ctx.tenantId}::uuid AND document_id=${documentId}::uuid AND base_version_id=${patch.baseVersionId}::uuid AND patch_hash=${patchHash}
    `);
    if (replay.rows[0]) return { replay: replay.rows[0] } as const;
    const head = await db.execute(sql`
      SELECT version_id FROM finnor_os.document_version_heads
      WHERE tenant_id=${ctx.tenantId}::uuid AND document_id=${documentId}::uuid AND kind='draft' AND head_key=${patch.draftKey}
    `);
    ensure(head.rows[0]?.version_id === patch.baseVersionId, "STALE_BRANCH_HEAD");
    const loaded = await loadDocumentVersion(db, ctx.tenantId, documentId, patch.baseVersionId);
    ensure(loaded, "DOCUMENT_VERSION_NOT_FOUND");
    return { loaded } as const;
  });
  if ("replay" in prepared) {
    const replay = prepared.replay;
    ensure(replay, "ARTIFACT_OPERATION_REPLAY_MISSING");
    ensure(replay.status === "succeeded", String(replay.error ?? "PATCH_PREVIOUSLY_FAILED"));
    return { versionId: replay.result_version_id as string, diff: replay.semantic_diff, replayed: true as const };
  }

  const before = await interpret(prepared.loaded.bytes);
  ensure(before.kind !== "pdf", "PDF_READ_ONLY");
  const pkg = new OfficePackage(prepared.loaded.bytes);
  const bytes = pkg.format === "xlsx" || pkg.format === "xlsm"
    ? patchWorkbook(pkg, patch.operations as SpreadsheetOperation[])
    : pkg.format === "docx"
      ? patchDocument(pkg, patch.operations as DocumentOperation[])
      : patchPresentation(pkg, patch.operations as PresentationOperation[]);
  const after = await interpret(bytes);
  if (patch.expectedSemanticHash) ensure(patch.expectedSemanticHash === after.semanticHash, "UNEXPECTED_SEMANTIC_RESULT");
  const diff = diffIR(before, after);

  return withTenant(ctx.tenantId, async (db) => {
    const result = await appendDocumentVersion(db, {
      tenantId: ctx.tenantId,
      documentId,
      bytes,
      mediaType: prepared.loaded.version.media_type,
      format: pkg.format,
      origin: "finnor_edit",
      actor: ctx.userId,
      parentVersionId: patch.baseVersionId,
      sourceRef: patchHash,
      head: { kind: "draft", key: patch.draftKey, expectedVersionId: patch.baseVersionId },
    });
    await saveArtifactIRSnapshot(db, ctx.tenantId, result.id, after);
    await db.execute(sql`
      INSERT INTO finnor_os.artifact_operations(
        tenant_id,document_id,base_version_id,result_version_id,operation_type,patch_hash,patch,semantic_diff,status,error,actor_id
      ) VALUES(
        ${ctx.tenantId}::uuid,${documentId}::uuid,${patch.baseVersionId}::uuid,${result.id}::uuid,'typed_patch',${patchHash},
        ${JSON.stringify(patch)}::jsonb,${JSON.stringify(diff)}::jsonb,'succeeded',NULL,${ctx.userId}::uuid
      ) ON CONFLICT DO NOTHING
    `);
    await recordAnchorRemaps(db, ctx, patch.baseVersionId, result.id, before, after);
    await recordBusinessEvent(db, {
      tenantId: ctx.tenantId,
      entityType: "document",
      entityId: documentId,
      eventType: "artifact_draft_created",
      payload: { documentVersionId: result.id, baseVersionId: patch.baseVersionId, patchHash, semanticDiff: diff },
    });
    return { version: result, diff, semanticHash: after.semanticHash, replayed: false as const };
  });
}

export async function applyArtifactPatch(ctx: ArtifactActor, documentId: string, patch: ArtifactPatch) {
  recordArtifactMetric({ tenantId: ctx.tenantId, traceId: ctx.correlationId, documentId }, "artifact_operations", 1, "count");
  try {
    return await applyArtifactPatchInternal(ctx, documentId, patch);
  } catch (error) {
    recordArtifactMetric({ tenantId: ctx.tenantId, traceId: ctx.correlationId, documentId }, "artifact_operation_failures", 1, "count");
    throw error;
  }
}

export async function compareArtifacts(ctx: ArtifactActor, documentId: string, left: string, right: string) {
  const [a, b] = await Promise.all([getArtifact(ctx, documentId, left), getArtifact(ctx, documentId, right)]);
  const changes = diffIR(a.ir, b.ir);
  recordArtifactMetric({ tenantId: ctx.tenantId, traceId: ctx.correlationId, documentId }, "artifact_diffs", 1, "count");
  return { left, right, changes };
}

export async function addArtifactLineage(ctx: ArtifactActor, input: { sourceVersionId: string; targetVersionId: string; relation: "supersedes" | "derived_from" | "copied_from" | "template_instantiation" | "rendered_from" | "merged_from" }) {
  ensure(input.sourceVersionId !== input.targetVersionId, "SELF_LINEAGE");
  return withTenant(ctx.tenantId, async (db) => {
    const result = await db.execute(sql`
      INSERT INTO finnor_os.artifact_lineage_edges(tenant_id,source_version_id,target_version_id,relation)
      VALUES(${ctx.tenantId}::uuid,${input.sourceVersionId}::uuid,${input.targetVersionId}::uuid,${input.relation})
      ON CONFLICT DO NOTHING RETURNING *
    `);
    return result.rows[0] ?? input;
  });
}

export async function addArtifactComment(ctx: ArtifactActor, documentId: string, input: { versionId: string; anchorId: string; anchorHash: string; body: string; parentCommentId?: string }) {
  ensure(input.body.trim().length > 0 && input.body.length <= 10_000, "INVALID_COMMENT");
  const { ir } = await getArtifact(ctx, documentId, input.versionId);
  ensure(ir.nodes.some((node) => node.id === input.anchorId && node.hash === input.anchorHash), "STALE_ANCHOR");
  return withTenant(ctx.tenantId, async (db) => {
    const result = await db.execute(sql`
      INSERT INTO finnor_os.artifact_comments(tenant_id,version_id,anchor_id,anchor_hash,author_id,body,parent_comment_id)
      VALUES(${ctx.tenantId}::uuid,${input.versionId}::uuid,${input.anchorId},${input.anchorHash},${ctx.userId}::uuid,${input.body},${input.parentCommentId ?? null}::uuid)
      RETURNING *
    `);
    return result.rows[0];
  });
}

export async function reviewArtifact(ctx: ArtifactActor, documentId: string, input: { versionId: string; state: "requested" | "approved" | "changes_requested" | "withdrawn" | "comment_resolved"; commentId?: string }) {
  await getArtifact(ctx, documentId, input.versionId);
  return withTenant(ctx.tenantId, async (db) => {
    const result = await db.execute(sql`
      INSERT INTO finnor_os.artifact_reviews(tenant_id,version_id,actor_id,state,comment_id)
      VALUES(${ctx.tenantId}::uuid,${input.versionId}::uuid,${ctx.userId}::uuid,${input.state},${input.commentId ?? null}::uuid)
      RETURNING *
    `);
    return result.rows[0];
  });
}

export async function bindArtifact(ctx: ArtifactActor, documentId: string, input: { versionId: string; anchorId: string; anchorHash: string; targetKind: "evidence_version" | "canonical_entity" | "document_version"; targetId: string; targetEntityType?: string; targetAnchor?: string }) {
  const { ir } = await getArtifact(ctx, documentId, input.versionId);
  ensure(ir.nodes.some((node) => node.id === input.anchorId && node.hash === input.anchorHash), "STALE_ANCHOR");
  return withTenant(ctx.tenantId, async (db) => {
    const target = input.targetKind === "evidence_version"
      ? await db.execute(sql`SELECT id FROM finnor_os.evidence_source_versions WHERE tenant_id=${ctx.tenantId}::uuid AND id=${input.targetId}::uuid`)
      : input.targetKind === "document_version"
        ? await db.execute(sql`SELECT id FROM finnor_os.document_versions WHERE tenant_id=${ctx.tenantId}::uuid AND id=${input.targetId}::uuid`)
        : await db.execute(sql`SELECT finnor_os.canonical_entity_tenant(${input.targetEntityType ?? null},${input.targetId}::uuid)::text target_tenant`);
    const targetVisible = input.targetKind === "canonical_entity"
      ? target.rows[0]?.target_tenant === ctx.tenantId
      : Boolean(target.rows[0]);
    ensure(targetVisible, "ARTIFACT_BINDING_TARGET_NOT_VISIBLE");
    const result = await db.execute(sql`
      INSERT INTO finnor_os.artifact_bindings(tenant_id,version_id,anchor_id,anchor_hash,target_kind,target_id,target_entity_type,target_anchor,actor_id,created_by)
      VALUES(${ctx.tenantId}::uuid,${input.versionId}::uuid,${input.anchorId},${input.anchorHash},${input.targetKind},${input.targetId}::uuid,${input.targetEntityType ?? null},${input.targetAnchor ?? null},${ctx.userId}::uuid,${ctx.userId})
      RETURNING *
    `);
    return result.rows[0];
  });
}

export async function registerArtifactTemplate(ctx: ArtifactActor, documentId: string, input: { versionId: string; templateKey: string }) {
  ensure(/^[a-z0-9][a-z0-9_-]{1,158}[a-z0-9]$/.test(input.templateKey), "INVALID_TEMPLATE_KEY");
  const artifact = await getArtifact(ctx, documentId, input.versionId);
  ensure(["xlsx", "xlsm", "docx", "pptx"].includes(artifact.ir.kind), "UNSUPPORTED_TEMPLATE_KIND");
  return withTenant(ctx.tenantId, async (db) => {
    const result = await db.execute(sql`
      INSERT INTO finnor_os.artifact_templates(tenant_id,template_key,version_id,kind,status,actor_id)
      VALUES(${ctx.tenantId}::uuid,${input.templateKey},${input.versionId}::uuid,${artifact.ir.kind},'active',${ctx.userId}::uuid)
      ON CONFLICT DO NOTHING RETURNING *
    `);
    return result.rows[0];
  });
}

export async function listArtifactTemplates(ctx: ArtifactActor) {
  return withTenant(ctx.tenantId, async (db) => {
    const result = await db.execute(sql`
      SELECT DISTINCT ON(template_key) * FROM finnor_os.artifact_templates
      WHERE tenant_id=${ctx.tenantId}::uuid ORDER BY template_key,created_at DESC LIMIT 200
    `);
    return result.rows;
  });
}

export async function instantiateArtifactTemplate(ctx: ArtifactActor, input: { templateKey: string; title: string }) {
  const prepared = await withTenant(ctx.tenantId, async (db) => {
    const template = await db.execute(sql`
      SELECT version_id FROM finnor_os.artifact_templates WHERE tenant_id=${ctx.tenantId}::uuid AND template_key=${input.templateKey}
      ORDER BY created_at DESC LIMIT 1
    `);
    ensure(template.rows[0], "TEMPLATE_NOT_FOUND");
    const versionId = String(template.rows[0]!.version_id);
    const source = await db.execute(sql`SELECT document_id FROM finnor_os.document_versions WHERE tenant_id=${ctx.tenantId}::uuid AND id=${versionId}::uuid`);
    ensure(source.rows[0], "TEMPLATE_VERSION_NOT_FOUND");
    const loaded = await loadDocumentVersion(db, ctx.tenantId, String(source.rows[0]!.document_id), versionId);
    ensure(loaded, "TEMPLATE_VERSION_NOT_FOUND");
    return { versionId, loaded };
  });
  const ir = await interpret(prepared.loaded.bytes, { fileName: input.title });
  return withTenant(ctx.tenantId, async (db) => {
    const document = await createDocument(db, { tenantId: ctx.tenantId, kind: ir.kind, title: input.title, provenance: { createdBy: ctx.userId, sourceSystem: "template_instantiation" } });
    const version = await appendDocumentVersion(db, {
      tenantId: ctx.tenantId,
      documentId: document.documentId,
      bytes: prepared.loaded.bytes,
      mediaType: prepared.loaded.version.media_type,
      format: prepared.loaded.version.format,
      origin: "template_instantiation",
      actor: ctx.userId,
      sourceRef: prepared.versionId,
      head: { kind: "current", key: "default", expectedVersionId: null },
    });
    await saveArtifactIRSnapshot(db, ctx.tenantId, version.id, ir);
    await db.execute(sql`
      INSERT INTO finnor_os.artifact_lineage_edges(tenant_id,source_version_id,target_version_id,relation)
      VALUES(${ctx.tenantId}::uuid,${prepared.versionId}::uuid,${version.id}::uuid,'template_instantiation')
    `);
    return { documentId: document.documentId, version, ir };
  });
}

export async function artifactContext(ctx: ArtifactActor, documentId: string, versionId: string) {
  await getArtifact(ctx, documentId, versionId);
  return withTenant(ctx.tenantId, async (db) => {
    // One transaction-scoped client is intentionally queried serially.
    const comments = await db.execute(sql`SELECT * FROM finnor_os.artifact_comments WHERE tenant_id=${ctx.tenantId}::uuid AND version_id=${versionId}::uuid ORDER BY created_at LIMIT 200`);
    const reviews = await db.execute(sql`SELECT * FROM finnor_os.artifact_reviews WHERE tenant_id=${ctx.tenantId}::uuid AND version_id=${versionId}::uuid ORDER BY created_at LIMIT 200`);
    const bindings = await db.execute(sql`SELECT * FROM finnor_os.artifact_bindings WHERE tenant_id=${ctx.tenantId}::uuid AND version_id=${versionId}::uuid LIMIT 200`);
    const lineage = await db.execute(sql`SELECT * FROM finnor_os.artifact_lineage_edges WHERE tenant_id=${ctx.tenantId}::uuid AND (source_version_id=${versionId}::uuid OR target_version_id=${versionId}::uuid) LIMIT 200`);
    const remaps = await db.execute(sql`SELECT * FROM finnor_os.artifact_anchor_remaps WHERE tenant_id=${ctx.tenantId}::uuid AND (source_version_id=${versionId}::uuid OR target_version_id=${versionId}::uuid) LIMIT 200`);
    const publications = await db.execute(sql`SELECT * FROM finnor_os.artifact_publications WHERE tenant_id=${ctx.tenantId}::uuid AND document_id=${documentId}::uuid AND (local_version_id=${versionId}::uuid OR readback_version_id=${versionId}::uuid) ORDER BY created_at DESC LIMIT 50`);
    const providerCreations = await db.execute(sql`SELECT * FROM finnor_os.artifact_provider_creations WHERE tenant_id=${ctx.tenantId}::uuid AND document_id=${documentId}::uuid AND (local_version_id=${versionId}::uuid OR readback_version_id=${versionId}::uuid) ORDER BY created_at DESC LIMIT 50`);
    return { comments: comments.rows, reviews: reviews.rows, bindings: bindings.rows, lineage: lineage.rows, remaps: remaps.rows, publications: publications.rows, providerCreations: providerCreations.rows };
  });
}

export { ArtifactError };
