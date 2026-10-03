import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, configureTenantVertical, withTenant } from "@finnor/db";
import {
  loadDocumentVersion,
  recordExternalReferenceAcknowledgement,
  setDocumentVersionHead,
} from "@finnor/data-platform";
import { MicrosoftDelegatedExcelTransport, MicrosoftDriveArtifactTransport, MicrosoftGraphClient, MicrosoftGraphError, type MicrosoftGraphMutationAudit } from "@finnor/provider-microsoft365";
import { ProviderAuthError } from "@finnor/security";
import { OfficePackage, writeZip } from "@finnor/ooxml";
import { DeterministicLocalEmbedder, appendEvidenceVersion, createEvidenceSource, querySemantic, querySemanticDocumentVersion, writeSemantic } from "@finnor/memory";
import { createAssumption, createDeal, createInvestmentCase, type PeMutationContext } from "@finnor/private-equity";
import {
  addArtifactComment,
  addArtifactLineage,
  applyArtifactPatch,
  artifactContext,
  bindArtifact,
  compareArtifacts,
  createBlankArtifact,
  createDraft,
  getArtifact,
  ingestArtifact,
  instantiateArtifactTemplate,
  publishArtifact,
  publishNewArtifactToMicrosoft,
  queryArtifactIR,
  recalculateArtifactWorkbook,
  registerArtifactTemplate,
  reviewArtifact,
  type ArtifactActor,
} from "@finnor/artifacts";
import { migrate } from "../../packages/db/migrate";
import { GET as downloadDocument } from "../../apps/api/app/api/documents/[id]/route";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
const CORPUS = resolve(import.meta.dirname, "../artifact-corpus");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await canConnect(SUPER_URL);

function artifactError(code: string) {
  return expect.objectContaining({ code });
}

function metadata(bytes: Buffer, input: { driveId?: string; itemId?: string; name?: string; eTag?: string } = {}) {
  return {
    driveId: input.driveId ?? "drive-p3",
    itemId: input.itemId ?? "item-p3",
    id: input.itemId ?? "item-p3",
    name: input.name ?? "model.xlsx",
    size: bytes.length,
    eTag: input.eTag ?? '"etag-p3"',
    cTag: '"ctag-p3"',
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    providerVersionId: input.eTag ?? '"etag-p3"',
    lastModifiedDateTime: "2026-09-09T00:00:00.000Z",
    webUrl: "https://example.invalid/model.xlsx",
    sensitivityLabelPresent: false,
    raw: {},
  };
}

describe.skipIf(!available)("P3 Artifact OS persistence and provider truth", () => {
  let admin: pg.Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const integrationId = randomUUID();
  const scopeId = randomUUID();
  const targetA = randomUUID();
  const actorA: ArtifactActor = { tenantId: tenantA, userId: ownerA, role: "owner", correlationId: randomUUID() };
  const actorB: ArtifactActor = { tenantId: tenantB, userId: ownerB, role: "owner" };
  const peA: PeMutationContext = {
    auth: { tenantId: tenantA, userId: ownerA, employeeId: ownerA, role: "owner" },
    provenance: { sourceSystem: "test:p3-artifacts", createdBy: ownerA },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'P3 Artifact A'),($3,$4,'P3 Artifact B')",
      [tenantA, `p3-artifact-a-${randomUUID()}`, tenantB, `p3-artifact-b-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
       ($1,$2,$3,'owner','active','P3 Owner A'),($4,$5,$6,'owner','active','P3 Owner B')`,
      [ownerA, tenantA, `p3-owner-a-${randomUUID()}@test.invalid`, ownerB, tenantB, `p3-owner-b-${randomUUID()}@test.invalid`],
    );
    await admin.query(
      "INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'P3 Artifact Target','other')",
      [targetA, tenantA, `p3-artifact-target-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode,credential_provider)
       VALUES ($1,$2,'documents','microsoft_graph','real','aws-iam-federated')`,
      [integrationId, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.integration_source_scopes(
         id,tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,
         scope_key,sync_strategy,recovery_strategy,required_permissions,effective_permissions,
         permission_verified_at,configuration,configured_by
       ) VALUES(
         $1,$2,$3,'microsoft_graph','sharepoint_drive','drive_subtree','drive-p3/root-p3',
         'drive:p3-artifacts','delta','EXACT_DELTA',ARRAY['Files.ReadWrite.Selected'],
         ARRAY['Files.ReadWrite.Selected'],now(),$4::jsonb,$5
       )`,
      [scopeId, tenantA, integrationId, JSON.stringify({ driveId: "drive-p3", rootItemId: "root-p3" }), ownerA],
    );
    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerA, sourceSystem: "test:p3-artifacts" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerB, sourceSystem: "test:p3-artifacts" });
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  async function bindProviderDocument(label: string) {
    const bytes = readFileSync(resolve(CORPUS, "lbo-style.xlsx"));
    const externalId = `drive-p3/item-${label}-${randomUUID()}`;
    const eTag = `"etag-${label}"`;
    const base = await ingestArtifact(actorA, {
      title: `${label}.xlsx`,
      bytes,
      origin: "provider_observation",
      sourceSystem: "microsoft_graph",
      sourceRef: externalId,
      providerEtag: eTag,
      providerVersionId: eTag,
      headKind: "current",
    });
    const externalRefId = await withTenant(tenantA, (db) => recordExternalReferenceAcknowledgement(db, {
      tenantId: tenantA,
      integrationId,
      provider: "microsoft_graph",
      canonicalEntity: "document",
      canonicalEntityId: base.documentId,
      externalObjectType: "microsoft_drive_item",
      externalId,
    }));
    await admin.query(
      `UPDATE finnor_os.external_refs SET observed_state=$2::jsonb,source_version=$3,
       provenance=$4::jsonb WHERE tenant_id=$1 AND id=$5`,
      [tenantA, JSON.stringify({ driveId: "drive-p3", id: `item-${label}`, eTag }), eTag, JSON.stringify({ sourceScopeId: scopeId }), externalRefId],
    );
    await withTenant(tenantA, (db) => setDocumentVersionHead(db, {
      tenantId: tenantA,
      documentId: base.documentId,
      kind: "provider",
      key: externalRefId,
      versionId: base.version.id,
      expectedVersionId: null,
    }));
    return { ...base, bytes, externalId, externalRefId, eTag, itemId: `item-${label}` };
  }

  async function createEditedDraft(base: Awaited<ReturnType<typeof bindProviderDocument>>) {
    const draft = await createDraft(actorA, base.documentId, base.version.id);
    const cell = base.ir.nodes.find((node) => node.id === "cell:2!D5")!;
    const patched = await applyArtifactPatch(actorA, base.documentId, {
      baseVersionId: base.version.id,
      draftKey: draft.draftKey,
      operations: [{ type: "set_value", sheetId: "2", address: "D5", value: 31, expectedHash: cell.hash }],
    });
    if (patched.replayed) throw new Error("first draft patch unexpectedly replayed");
    const loaded = await withTenant(tenantA, (db) => loadDocumentVersion(db, tenantA, base.documentId, patched.version.id));
    if (!loaded) throw new Error("draft bytes missing");
    return { draft, patched, bytes: loaded.bytes };
  }

  function withProviderCoreNormalization(bytes: Buffer): Buffer {
    const source = new OfficePackage(bytes);
    const parts = new Map([...source.parts].map(([name, part]) => [name, Buffer.from(part.bytes)]));
    const core = source.text("docProps/core.xml");
    parts.set("docProps/core.xml", Buffer.from(core.replace("</cp:coreProperties>", "<cp:keywords>provider-normalized</cp:keywords></cp:coreProperties>")));
    return writeZip(parts);
  }

  it("keeps Core Document canonical while versions, bytes, heads, and tenant isolation remain exact", async () => {
    const created = await createBlankArtifact(actorA, { kind: "xlsx", title: "Canonical model" });
    expect(created.ir.kind).toBe("xlsx");
    expect(created.version).toMatchObject({ version_ordinal: 1, origin: "finnor_generated", format: "xlsx" });
    const artifact = await getArtifact(actorA, created.documentId);
    expect(artifact.document).toMatchObject({ id: created.documentId, kind: "xlsx", title: "Canonical model.xlsx" });
    expect(artifact.heads).toEqual([expect.objectContaining({ kind: "current", version_id: created.version.id })]);
    expect((await queryArtifactIR(actorA, created.documentId, created.version.id, { kinds: ["cell"], limit: 1 }))).toMatchObject({ total: 1, limit: 1 });
    await expect(getArtifact(actorB, created.documentId)).rejects.toEqual(artifactError("DOCUMENT_NOT_FOUND"));

    const metadataOnly = randomUUID();
    await admin.query(
      "INSERT INTO finnor_os.documents(id,tenant_id,kind,title,created_by) VALUES($1,$2,'memo','Metadata only',$3)",
      [metadataOnly, tenantA, ownerA],
    );
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.document_versions WHERE document_id=$1", [metadataOnly])).rows[0].count).toBe(0);
    await expect(admin.query("UPDATE finnor_os.document_versions SET byte_sha256=repeat('0',64) WHERE id=$1", [created.version.id])).rejects.toThrow(/immutable/i);

    const persisted = await withTenant(tenantA, (db) => loadDocumentVersion(db, tenantA, created.documentId, created.version.id));
    if (!persisted) throw new Error("created artifact bytes missing");
    const beforeArchivedRetry = (await admin.query("SELECT count(*)::int count FROM finnor_os.document_versions WHERE document_id=$1", [created.documentId])).rows[0].count;
    await admin.query("UPDATE finnor_os.documents SET archived_at=now() WHERE tenant_id=$1 AND id=$2", [tenantA, created.documentId]);
    await expect(ingestArtifact(actorA, {
      documentId: created.documentId,
      title: "Archived while parse completes.xlsx",
      bytes: persisted.bytes,
      origin: "manual_upload",
    })).rejects.toThrow(/DOCUMENT_NOT_FOUND/);
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.document_versions WHERE document_id=$1", [created.documentId])).rows[0].count).toBe(beforeArchivedRetry);
  });

  it("serves XLSX, DOCX, PPTX, and PDF exact versions with truthful media type and filename", async () => {
    const previousBypass = process.env.AUTH_DEV_BYPASS;
    process.env.AUTH_DEV_BYPASS = "1";
    try {
    const inputs = [
      { kind: "xlsx" as const, title: "Download model", media: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" },
      { kind: "docx" as const, title: "Download memo", media: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" },
      { kind: "pptx" as const, title: "Download deck", media: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: "pptx" },
    ];
    for (const input of inputs) {
      const artifact = await createBlankArtifact(actorA, input);
      const response = await downloadDocument(new Request(`http://localhost/api/documents/${artifact.documentId}?versionId=${artifact.version.id}`, {
        headers: { "x-tenant-id": tenantA, "x-user-id": ownerA, "x-user-role": "owner" },
      }), { params: Promise.resolve({ id: artifact.documentId }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(input.media);
      expect(response.headers.get("content-disposition")).toContain(`filename="${input.title}.${input.extension}"`);
      expect(Buffer.from(await response.arrayBuffer()).length).toBeGreaterThan(0);
    }
    const pdf = await ingestArtifact(actorA, { title: "Download evidence.pdf", bytes: readFileSync(resolve(CORPUS, "text-evidence.pdf")), origin: "manual_upload" });
    const response = await downloadDocument(new Request(`http://localhost/api/documents/${pdf.documentId}?versionId=${pdf.version.id}`, {
      headers: { "x-tenant-id": tenantA, "x-user-id": ownerA, "x-user-role": "owner" },
    }), { params: Promise.resolve({ id: pdf.documentId }) });
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain('inline; filename="Download evidence.pdf"');
    } finally {
      if (previousBypass === undefined) delete process.env.AUTH_DEV_BYPASS;
      else process.env.AUTH_DEV_BYPASS = previousBypass;
    }
  });

  it("serves bounded spreadsheet ranges and exact dependency/dependent slices", async () => {
    const workbook = await ingestArtifact(actorA, {
      title: "Bounded model.xlsx",
      bytes: readFileSync(resolve(CORPUS, "lbo-style.xlsx")),
      origin: "manual_upload",
    });
    const range = await queryArtifactIR(actorA, workbook.documentId, workbook.version.id, { sheetId: "2", range: "D5:D6", kinds: ["cell"], limit: 10 });
    expect(range.nodes.map((node) => node.id)).toEqual(["cell:2!D5", "cell:2!D6"]);
    const dependencies = await queryArtifactIR(actorA, workbook.documentId, workbook.version.id, { dependencyOf: "cell:1!D5", limit: 10 });
    expect(dependencies).toMatchObject({ relation: { direction: "dependencies", anchorId: "cell:1!D5" } });
    expect(dependencies.nodes.map((node) => node.id).sort()).toEqual(["cell:2!D5", "cell:2!D6"]);
    const dependents = await queryArtifactIR(actorA, workbook.documentId, workbook.version.id, { dependentOf: "cell:2!D5", limit: 10 });
    expect(dependents.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["cell:1!D5", "cell:1!D6", "cell:4!D7"]));
    await expect(queryArtifactIR(actorA, workbook.documentId, workbook.version.id, { range: "A1:ZZ1000" })).rejects.toEqual(artifactError("RANGE_LIMIT"));
  });

  it("applies typed patches atomically, records exact remaps/comments/review/bindings, and replays once", async () => {
    const created = await createBlankArtifact(actorA, { kind: "xlsx", title: "Draft mechanics.xlsx" });
    const cell = created.ir.nodes.find((node) => node.kind === "cell")!;
    const comment = await addArtifactComment(actorA, created.documentId, { versionId: created.version.id, anchorId: cell.id, anchorHash: cell.hash, body: "Pin this source value." });
    if (!comment) throw new Error("comment insert returned no row");
    await reviewArtifact(actorA, created.documentId, { versionId: created.version.id, state: "requested" });
    await reviewArtifact(actorA, created.documentId, { versionId: created.version.id, state: "comment_resolved", commentId: String(comment.id) });
    const authorityBefore = (await admin.query(
      "SELECT count(*)::int count FROM finnor_os.authority_decisions WHERE tenant_id=$1",
      [tenantA],
    )).rows[0].count;
    await reviewArtifact(actorA, created.documentId, { versionId: created.version.id, state: "approved" });
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.authority_decisions WHERE tenant_id=$1", [tenantA])).rows[0].count).toBe(authorityBefore);
    await bindArtifact(actorA, created.documentId, { versionId: created.version.id, anchorId: cell.id, anchorHash: cell.hash, targetKind: "document_version", targetId: created.version.id });
    const draft = await createDraft(actorA, created.documentId, created.version.id);
    const patch = {
      baseVersionId: created.version.id,
      draftKey: draft.draftKey,
      operations: [{ type: "set_value" as const, sheetId: "1", address: "A1", value: "IC-ready", expectedHash: cell.hash }],
    };
    const applied = await applyArtifactPatch(actorA, created.documentId, patch);
    if (applied.replayed) throw new Error("first patch unexpectedly replayed");
    expect(applied).toMatchObject({ replayed: false, version: { version_ordinal: 2, parent_version_id: created.version.id } });
    expect((await applyArtifactPatch(actorA, created.documentId, patch))).toMatchObject({ replayed: true, versionId: applied.version.id });
    expect((await compareArtifacts(actorA, created.documentId, created.version.id, applied.version.id)).changes).toEqual(expect.arrayContaining([expect.objectContaining({ id: cell.id, kind: "value-change" })]));
    const context = await artifactContext(actorA, created.documentId, applied.version.id);
    expect(context.remaps).toEqual([expect.objectContaining({ source_anchor_id: cell.id, target_anchor_id: cell.id, status: "exact" })]);
    expect((await artifactContext(actorA, created.documentId, created.version.id)).comments).toEqual([expect.objectContaining({ id: comment.id, body: "Pin this source value." })]);
    const versionCount = (await admin.query("SELECT count(*)::int count FROM finnor_os.document_versions WHERE document_id=$1", [created.documentId])).rows[0].count;
    await expect(applyArtifactPatch(actorA, created.documentId, {
      baseVersionId: applied.version.id,
      draftKey: draft.draftKey,
      operations: [{ type: "set_value", sheetId: "1", address: "A1", value: "bad", expectedHash: "0".repeat(64) }],
    })).rejects.toEqual(artifactError("STALE_ANCHOR"));
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.document_versions WHERE document_id=$1", [created.documentId])).rows[0].count).toBe(versionCount);
    const appliedArtifact = await getArtifact(actorA, created.documentId, applied.version.id);
    const appliedCell = appliedArtifact.ir.nodes.find((node) => node.id === cell.id)!;
    await expect(applyArtifactPatch(actorA, created.documentId, {
      baseVersionId: applied.version.id,
      draftKey: draft.draftKey,
      operations: [
        { type: "set_value", sheetId: "1", address: "A1", value: "first would succeed", expectedHash: appliedCell.hash },
        { type: "set_value", sheetId: "1", address: "A1", value: "second is stale", expectedHash: "0".repeat(64) },
      ],
    })).rejects.toEqual(artifactError("STALE_ANCHOR"));
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.document_versions WHERE document_id=$1", [created.documentId])).rows[0].count).toBe(versionCount);
    await expect(applyArtifactPatch(actorA, created.documentId, {
      baseVersionId: created.version.id,
      draftKey: draft.draftKey,
      operations: [{ type: "set_value", sheetId: "1", address: "A1", value: "stale base", expectedHash: cell.hash }],
    })).rejects.toEqual(artifactError("STALE_BRANCH_HEAD"));
  });

  it("pins EvidenceVersion, PE entity, and P1 Assumption bindings to one immutable version and rejects cross-tenant targets", async () => {
    const foreign = await createBlankArtifact(actorB, { kind: "docx", title: "Foreign source.docx" });
    const evidenceSource = await createEvidenceSource(tenantA, {
      sourceKey: `p3-binding-evidence:${randomUUID()}`,
      sourceType: "provider_observation",
      title: "P3 exact binding evidence",
    });
    const evidence = await appendEvidenceVersion(tenantA, evidenceSource.id, {
      content: "The exact source supports the artifact input at this retrieved version.",
      retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
      asOf: new Date("2026-09-01T00:00:00.000Z"),
    });
    const deal = await createDeal(peA, {
      targetOrganizationId: targetA,
      name: "P3 Artifact Binding Deal",
      dealLeadEmployeeId: ownerA,
      signedLoiAt: new Date("2026-09-01T00:00:00.000Z"),
      targetClosingAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    const investmentCase = await createInvestmentCase(peA, { dealId: String(deal.row.id), title: "Artifact-linked case" });
    const assumption = await createAssumption(peA, {
      dealId: String(deal.row.id),
      investmentCaseId: String(investmentCase.row.id),
      assumptionKey: "entry_multiple",
      statement: "Entry multiple is 9.0x.",
      valueType: "number",
      value: 9,
      materiality: "high",
    });
    const artifact = await createBlankArtifact(actorA, { kind: "xlsx", title: "Exact binding model.xlsx" });
    const cell = artifact.ir.nodes.find((node) => node.kind === "cell")!;
    const bindings = await Promise.all([
      bindArtifact(actorA, artifact.documentId, { versionId: artifact.version.id, anchorId: cell.id, anchorHash: cell.hash, targetKind: "evidence_version", targetId: evidence.versionId }),
      bindArtifact(actorA, artifact.documentId, { versionId: artifact.version.id, anchorId: cell.id, anchorHash: cell.hash, targetKind: "canonical_entity", targetId: String(deal.row.id), targetEntityType: "pe_deal" }),
      bindArtifact(actorA, artifact.documentId, { versionId: artifact.version.id, anchorId: cell.id, anchorHash: cell.hash, targetKind: "canonical_entity", targetId: String(assumption.row.id), targetEntityType: "pe_assumption" }),
    ]);
    expect(bindings.map((binding) => binding!.target_kind).sort()).toEqual(["canonical_entity", "canonical_entity", "evidence_version"]);
    expect((await artifactContext(actorA, artifact.documentId, artifact.version.id)).bindings).toHaveLength(3);

    const draft = await createDraft(actorA, artifact.documentId, artifact.version.id);
    const changed = await applyArtifactPatch(actorA, artifact.documentId, {
      baseVersionId: artifact.version.id,
      draftKey: draft.draftKey,
      operations: [{ type: "set_value", sheetId: "1", address: "A1", value: "new version", expectedHash: cell.hash }],
    });
    if (changed.replayed) throw new Error("binding version patch unexpectedly replayed");
    expect((await artifactContext(actorA, artifact.documentId, changed.version.id)).bindings).toHaveLength(0);
    expect((await artifactContext(actorA, artifact.documentId, artifact.version.id)).bindings).toHaveLength(3);

    await expect(bindArtifact(actorA, artifact.documentId, {
      versionId: artifact.version.id,
      anchorId: cell.id,
      anchorHash: cell.hash,
      targetKind: "document_version",
      targetId: foreign.version.id,
    })).rejects.toEqual(artifactError("ARTIFACT_BINDING_TARGET_NOT_VISIBLE"));
    await expect(bindArtifact(actorA, artifact.documentId, {
      versionId: artifact.version.id,
      anchorId: cell.id,
      anchorHash: cell.hash,
      targetKind: "evidence_version",
      targetId: randomUUID(),
    })).rejects.toEqual(artifactError("ARTIFACT_BINDING_TARGET_NOT_VISIBLE"));
  });

  it("records exact artifact memory versions, excludes old-version chunks from current retrieval, and permits explicit history", async () => {
    const embedder = new DeterministicLocalEmbedder();
    const artifact = await createBlankArtifact(actorA, { kind: "xlsx", title: "Memory version model.xlsx" });
    const cell = artifact.ir.nodes.find((node) => node.kind === "cell")!;
    await writeSemantic(tenantA, `artifact-old:${artifact.documentId}`, [{
      chunk: "artifact version memory truth old baseline",
      documentId: artifact.documentId,
      documentVersionId: artifact.version.id,
      sourceKind: "artifact_version",
    }], embedder);
    const draft = await createDraft(actorA, artifact.documentId, artifact.version.id);
    const changed = await applyArtifactPatch(actorA, artifact.documentId, {
      baseVersionId: artifact.version.id,
      draftKey: draft.draftKey,
      operations: [{ type: "set_value", sheetId: "1", address: "A1", value: "current memory", expectedHash: cell.hash }],
    });
    if (changed.replayed) throw new Error("memory version patch unexpectedly replayed");
    await withTenant(tenantA, (db) => setDocumentVersionHead(db, {
      tenantId: tenantA,
      documentId: artifact.documentId,
      kind: "current",
      key: "default",
      versionId: changed.version.id,
      expectedVersionId: artifact.version.id,
    }));
    await writeSemantic(tenantA, `artifact-new:${artifact.documentId}`, [{
      chunk: "artifact version memory truth current revision",
      documentId: artifact.documentId,
      documentVersionId: changed.version.id,
      sourceKind: "artifact_version",
    }], embedder);

    const persisted = await admin.query(
      "SELECT source_doc_id,document_id::text,document_version_id::text FROM finnor_os.embeddings WHERE tenant_id=$1 AND document_id=$2 ORDER BY source_doc_id",
      [tenantA, artifact.documentId],
    );
    expect(persisted.rows).toEqual([
      expect.objectContaining({ source_doc_id: `artifact-new:${artifact.documentId}`, document_id: artifact.documentId, document_version_id: changed.version.id }),
      expect.objectContaining({ source_doc_id: `artifact-old:${artifact.documentId}`, document_id: artifact.documentId, document_version_id: artifact.version.id }),
    ]);
    const current = await querySemantic(tenantA, "artifact version memory truth", 10, embedder);
    expect(current.some((hit) => hit.documentVersionId === changed.version.id)).toBe(true);
    expect(current.some((hit) => hit.documentVersionId === artifact.version.id)).toBe(false);
    const history = await querySemanticDocumentVersion(tenantA, artifact.documentId, artifact.version.id, "artifact version memory truth", 10, embedder);
    expect(history).toEqual([expect.objectContaining({ documentId: artifact.documentId, documentVersionId: artifact.version.id })]);
    expect((await querySemantic(tenantB, "artifact version memory truth", 10, embedder)).some((hit) => hit.documentId === artifact.documentId)).toBe(false);
  });

  it("instantiates an immutable template and supports cross-Document lineage without changing its source", async () => {
    const template = await createBlankArtifact(actorA, { kind: "docx", title: "IC memo template.docx" });
    await registerArtifactTemplate(actorA, template.documentId, { versionId: template.version.id, templateKey: "ic_memo_v1" });
    const instance = await instantiateArtifactTemplate(actorA, { templateKey: "ic_memo_v1", title: "Project Atlas IC Memo.docx" });
    expect(instance).toMatchObject({ version: { origin: "template_instantiation", source_ref: template.version.id } });
    const source = await getArtifact(actorA, template.documentId, template.version.id);
    const target = await getArtifact(actorA, instance.documentId, instance.version.id);
    expect(target.version.byte_sha256).toBe(source.version.byte_sha256);
    await addArtifactLineage(actorA, { sourceVersionId: template.version.id, targetVersionId: instance.version.id, relation: "derived_from" });
    expect((await artifactContext(actorA, instance.documentId, instance.version.id)).lineage).toHaveLength(2);
  });

  function artifactGraphFixture(mutationAudit: MicrosoftGraphMutationAudit | undefined, transportFetch: typeof fetch) {
    return new MicrosoftGraphClient({
      kind: "delegated_user", tenantId: tenantA, principalId: ownerA,
      provider: "microsoft_graph", authProfileId: randomUUID(), authProfileRef: "disposable-s6-physical-artifact",
      connectionRevision: 1, directoryTenantId: randomUUID(), applicationClientId: randomUUID(), cloud: "global",
      requiredPermissions: ["Files.ReadWrite.Selected"], consentedPermissions: ["Files.ReadWrite.Selected"],
      cacheKey: `s6-artifact-${randomUUID()}`, accessToken: "disposable-fixture-token",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "disposable-fixture-refresh",
      persistTokens: async () => undefined, markReauthorizationRequired: async () => undefined,
    }, { mutationAudit, fetch: transportFetch });
  }

  async function recordArtifactTransportEvidence(name: string, documentId: string, requests: unknown) {
    const out = process.env.FINNOR_S6_NATIVE_EVIDENCE_DIR;
    if (!out) return;
    const operations = (await admin.query("SELECT o.* FROM finnor_os.external_operations o WHERE o.tenant_id=$1 AND o.owner_type='artifact_operation' AND (o.owner_key=$2 OR EXISTS(SELECT 1 FROM finnor_os.artifact_provider_creations c WHERE c.tenant_id=o.tenant_id AND c.id::text=o.owner_key AND c.document_id=$2::uuid)) ORDER BY o.created_at", [tenantA, documentId])).rows;
    const invocations = (await admin.query("SELECT i.* FROM finnor_os.provider_invocations i JOIN finnor_os.provider_operation_attempts a ON a.id=i.provider_operation_attempt_id AND a.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND a.external_operation_id=ANY($2::uuid[]) ORDER BY i.ordinal", [tenantA, operations.map(row => row.id)])).rows;
    const decisions = (await admin.query("SELECT * FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_id=$2 AND event_type='artifact_dispatch_authorized' ORDER BY occurred_at", [tenantA, documentId])).rows;
    await mkdir(out, { recursive: true }); await writeFile(resolve(out, `${name}.json`), JSON.stringify({
      schema: "finnor.s6.artifact-transport-owner.v1", inputs: { actor: actorA, documentId, integrationId, sourceScopeId: scopeId },
      requests, operations, invocations, decisions, qualification: "Actual Graph client/adapters, native authority/attempt/readback owner; HTTP/token fixture, not live Graph or protected admission" }, null, 2) + "\n");
    return { operations, invocations };
  }

  it("refuses publication when persisted authority is revoked after transport resolution", async () => {
    const base=await bindProviderDocument('replace-revoked'),local=await createEditedDraft(base);
    let providerBytes=Buffer.from(base.bytes),providerETag=base.eTag,mutations=0,revoked=false;
    let error:string|null=null,result:unknown;
    try {
      try {
        result=await publishArtifact(actorA,{documentId:base.documentId,localVersionId:local.patched.version.id,baseVersionId:base.version.id,mode:'APP_ONLY_FILE_REPLACE'},{
          transport:async input=>{
            if(input.mutationAudit){await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenantA,ownerA]);revoked=true;}
            return {
              metadata:async()=>metadata(providerBytes,{itemId:base.itemId,name:'replace-revoked.xlsx',eTag:providerETag}),
              replaceConditional:async input=>{mutations++;providerBytes=Buffer.from(input.bytes);providerETag='"etag-revoked-2"';return metadata(providerBytes,{itemId:base.itemId,name:'replace-revoked.xlsx',eTag:providerETag});},
              download:async()=>({metadata:metadata(providerBytes,{itemId:base.itemId,name:'replace-revoked.xlsx',eTag:providerETag}),bytes:providerBytes}),
            };
          },enqueue:async()=>undefined,
        });
      } catch(e){error=String(e);}
      const publications=(await admin.query('SELECT * FROM finnor_os.artifact_publications WHERE tenant_id=$1 AND document_id=$2',[tenantA,base.documentId])).rows;
      const operations=(await admin.query("SELECT * FROM finnor_os.external_operations WHERE tenant_id=$1 AND owner_type='artifact_operation' AND owner_key=$2",[tenantA,publications[0]?.id])).rows;
      const out=process.env.FINNOR_S6_NATIVE_EVIDENCE_DIR;
      if(out){await mkdir(out,{recursive:true});await writeFile(resolve(out,'artifact-revocation-after-resolution.json'),JSON.stringify({schema:'finnor.s6.artifact-owner-challenge.v1',inputs:{actor:actorA,documentId:base.documentId,baseVersionId:base.version.id,localVersionId:local.patched.version.id},fault:'persisted principal suspended during mutation transport resolution',revoked,mutations,providerUnchanged:providerBytes.equals(base.bytes),error,result,publications,operations,qualification:'Actual publication/authority/database owner; provider fixture, not live Graph or protected isolation'},null,2)+'\n');}
      expect({revoked,mutations,providerUnchanged:providerBytes.equals(base.bytes)}).toEqual({revoked:true,mutations:0,providerUnchanged:true});
      expect(error??'').toMatch(/DENIED|suspend|authority/i);
      expect(publications).toHaveLength(1);expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({status:'failed',execution_state:'known_failed'});
    } finally {await admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2",[tenantA,ownerA]);}
  });

  it.each(["before_session", "after_session", "none", "wrong_record_readback"] as const)("retains authority and physical upload responsibility at %s", async (fault) => {
    const base = await bindProviderDocument(`physical-${fault}`);
    const local = await createEditedDraft(base);
    let providerBytes = Buffer.from(base.bytes), providerETag = base.eTag;
    let sessions = 0, chunks = 0, revoked = false;
    const requests: Array<{ method: string; path: string; requestBodyBytes: number }> = [];
    const suspend = async () => {
      await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2", [tenantA, ownerA]);
      revoked = true;
    };
    const providerItem = () => ({ id: fault === "wrong_record_readback" && chunks > 0 ? "decoy-drive-item" : base.itemId, name: `physical-${fault}.xlsx`, size: providerBytes.length,
      eTag: providerETag, cTag: '"ctag-physical"', file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    let error: string | null = null, result: unknown;
    try {
      try {
        result = await publishArtifact(actorA, {
          documentId: base.documentId, localVersionId: local.patched.version.id,
          baseVersionId: base.version.id, mode: "DELEGATED_FILE_REPLACE",
        }, {
          transport: async ({ mutationAudit }) => {
            // Only provider transport/credentials are fixtures; the client emits
            // and the native owner persists every physical invocation itself.
            let metadataReads = 0;
            const client = artifactGraphFixture(mutationAudit, async (url, init) => {
              const path = new URL(String(url)).pathname, method = init?.method ?? "GET";
              requests.push({ method, path, requestBodyBytes: init?.body instanceof Uint8Array ? init.body.length : 0 });
              if (method === "GET" && path.endsWith("/content")) return new Response(new Uint8Array(providerBytes));
              if (method === "GET") {
                metadataReads += 1;
                if (mutationAudit && metadataReads === 1 && fault === "before_session") await suspend();
                return Response.json(providerItem());
              }
              if (method === "POST" && path.endsWith("/createUploadSession")) {
                sessions += 1;
                expect(new Headers(init?.headers).get("if-match")).toBe(base.eTag);
                if (fault === "after_session") await suspend();
                return Response.json({ uploadUrl: "https://fixture.sharepoint.com/upload/disposable-s6" });
              }
              if (method === "PUT" && path === "/upload/disposable-s6") {
                chunks += 1; providerBytes = Buffer.from(init!.body as Uint8Array); providerETag = '"etag-physical-final"';
                return Response.json({ ...providerItem(), id: base.itemId });
              }
              throw new Error(`Unexpected fixture request ${method} ${path}`);
            });
            return new MicrosoftDriveArtifactTransport(client, "delegated");
          }, enqueue: async () => undefined,
        });
      } catch (e) { error = String(e); }
      const publications = (await admin.query("SELECT * FROM finnor_os.artifact_publications WHERE tenant_id=$1 AND document_id=$2", [tenantA, base.documentId])).rows;
      const operations = (await admin.query("SELECT * FROM finnor_os.external_operations WHERE tenant_id=$1 AND owner_type='artifact_operation' AND owner_key=$2", [tenantA, publications[0]?.id])).rows;
      const attempts = (await admin.query("SELECT * FROM finnor_os.provider_operation_attempts WHERE tenant_id=$1 AND external_operation_id=$2 ORDER BY ordinal", [tenantA, operations[0]?.id])).rows;
      const invocations = (await admin.query("SELECT i.* FROM finnor_os.provider_invocations i JOIN finnor_os.provider_operation_attempts a ON a.id=i.provider_operation_attempt_id AND a.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND a.external_operation_id=$2 ORDER BY i.ordinal", [tenantA, operations[0]?.id])).rows;
      const evidence = { schema: "finnor.s6.artifact-physical-challenge.v1", inputs: { actor: actorA, documentId: base.documentId, baseVersionId: base.version.id, localVersionId: local.patched.version.id },
        fault, revoked, sessions, chunks, providerUnchanged: providerBytes.equals(base.bytes), requests, error, result, publications, operations, attempts, invocations,
        qualification: "Actual Graph client/adapter and native authority/operation/readback owners; fixture provider/token, no live Graph or protected admission" };
      const out = process.env.FINNOR_S6_NATIVE_EVIDENCE_DIR;
      if (out) { await mkdir(out, { recursive: true }); await writeFile(resolve(out, `artifact-physical-${fault}.json`), JSON.stringify(evidence, null, 2) + "\n"); }
      expect(publications).toHaveLength(1); expect(operations).toHaveLength(1); expect(attempts).toHaveLength(1);
      if (fault === "none") {
        expect({ sessions, chunks, error }).toEqual({ sessions: 1, chunks: 1, error: null });
        expect(result).toMatchObject({ status: "verified" });
        expect(operations[0]).toMatchObject({ status: "succeeded", verification_status: "verified" });
        expect(invocations).toHaveLength(2);
        expect(invocations.every(row => row.outcome === "provider_acknowledged")).toBe(true);
      } else if (fault === "wrong_record_readback") {
        expect({ revoked, sessions, chunks }).toEqual({ revoked: false, sessions: 1, chunks: 1 });
        expect(publications[0]).toMatchObject({ status: "unknown_delivery" });
        expect(operations[0].verification_status).not.toBe("verified");
        expect(["provider_in_flight", "awaiting_observation", "unknown_outcome", "reconciliation_required"]).toContain(operations[0].execution_state);
      } else {
        expect(revoked).toBe(true); expect(chunks).toBe(0); expect(providerBytes.equals(base.bytes)).toBe(true);
        if (fault === "before_session") {
          expect(sessions).toBe(0); expect(error ?? "").toMatch(/DENIED|suspend|authority/i);
          expect(operations[0]).toMatchObject({ status: "failed", execution_state: "known_failed" });
          expect(invocations).toEqual([expect.objectContaining({ outcome: "definite_pre_dispatch_failure", request_may_have_left_at: null })]);
        } else {
          expect(sessions).toBe(1); expect(publications[0]).toMatchObject({ status: "unknown_delivery" });
          expect(operations[0].status).toBe("unknown");
          expect(["unknown_outcome", "reconciliation_required"]).toContain(operations[0].execution_state);
          expect(invocations).toEqual([expect.objectContaining({ outcome: "provider_acknowledged" }), expect.objectContaining({ outcome: "definite_pre_dispatch_failure", request_may_have_left_at: null })]);
        }
      }
    } finally { await admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2", [tenantA, ownerA]); }
  });

  it("publishes a replacement only after eTag check and exact readback, then replays without a second write", async () => {
    const base = await bindProviderDocument("replace-ok");
    const local = await createEditedDraft(base);
    let providerBytes = base.bytes;
    let providerETag = base.eTag;
    const replaceConditional = vi.fn(async (input: { bytes: Buffer; expectedETag: string }) => {
      expect(input.expectedETag).toBe(base.eTag);
      providerBytes = Buffer.from(input.bytes);
      providerETag = '"etag-replace-ok-2"';
      return metadata(providerBytes, { itemId: base.itemId, name: "replace-ok.xlsx", eTag: providerETag });
    });
    const enqueue = vi.fn(async () => undefined);
    const dependencies = {
      transport: async () => ({
        metadata: async () => metadata(providerBytes, { itemId: base.itemId, name: "replace-ok.xlsx", eTag: providerETag }),
        replaceConditional,
        download: async () => {
          const state = await admin.query("SELECT status FROM finnor_os.artifact_publications WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at DESC LIMIT 1", [tenantA, base.documentId]);
          expect(state.rows[0]?.status).toBe("acknowledged");
          return { metadata: metadata(providerBytes, { itemId: base.itemId, name: "replace-ok.xlsx", eTag: providerETag }), bytes: providerBytes };
        },
      }),
      enqueue,
    };
    const published = await publishArtifact(actorA, { documentId: base.documentId, localVersionId: local.patched.version.id, baseVersionId: base.version.id, mode: "APP_ONLY_FILE_REPLACE" }, dependencies);
    expect(published).toMatchObject({ status: "verified", localVersionId: local.patched.version.id, baseVersionId: base.version.id });
    expect(published.readbackVersionId).not.toBe(local.patched.version.id);
    expect(replaceConditional).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("sync_source", expect.objectContaining({ sourceScopeId: scopeId }), expect.stringContaining("artifact-publish-source-convergence"), actorA.correlationId);
    const countsBeforeReplay = await admin.query(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.document_versions WHERE tenant_id=$1 AND document_id=$2) versions,
        (SELECT count(*)::int FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_type='document' AND entity_id=$2 AND event_type='artifact_publish_verified') events`,
      [tenantA, base.documentId],
    );
    const replay = await publishArtifact(actorA, { documentId: base.documentId, localVersionId: local.patched.version.id, baseVersionId: base.version.id, mode: "APP_ONLY_FILE_REPLACE" }, dependencies);
    expect(replay).toMatchObject({ id: published.id, status: "verified", readbackVersionId: published.readbackVersionId });
    expect(replaceConditional).toHaveBeenCalledTimes(1);
    const countsAfterReplay = await admin.query(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.document_versions WHERE tenant_id=$1 AND document_id=$2) versions,
        (SELECT count(*)::int FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_type='document' AND entity_id=$2 AND event_type='artifact_publish_verified') events`,
      [tenantA, base.documentId],
    );
    expect(countsAfterReplay.rows[0]).toEqual(countsBeforeReplay.rows[0]);
  });

  it("classifies provider-only metadata normalization and fails an unexpected semantic readback", async () => {
    const normalizedBase = await bindProviderDocument("replace-normalized");
    const normalizedLocal = await createEditedDraft(normalizedBase);
    let normalizedBytes = normalizedBase.bytes;
    let normalizedETag = normalizedBase.eTag;
    const normalized = await publishArtifact(actorA, {
      documentId: normalizedBase.documentId,
      localVersionId: normalizedLocal.patched.version.id,
      baseVersionId: normalizedBase.version.id,
      mode: "APP_ONLY_FILE_REPLACE",
    }, {
      transport: async () => ({
        metadata: async () => metadata(normalizedBytes, { itemId: normalizedBase.itemId, name: "replace-normalized.xlsx", eTag: normalizedETag }),
        replaceConditional: async (input) => {
          normalizedBytes = Buffer.from(withProviderCoreNormalization(input.bytes));
          normalizedETag = '"etag-normalized-2"';
          return metadata(normalizedBytes, { itemId: normalizedBase.itemId, name: "replace-normalized.xlsx", eTag: normalizedETag });
        },
        download: async () => ({ metadata: metadata(normalizedBytes, { itemId: normalizedBase.itemId, name: "replace-normalized.xlsx", eTag: normalizedETag }), bytes: normalizedBytes }),
      }),
      enqueue: async () => undefined,
    });
    expect(normalized).toMatchObject({ status: "verified_provider_normalized", failure: null });
    expect(normalized.verificationDiff).toEqual([expect.objectContaining({ id: "docProps/core.xml", kind: "OPAQUE_PART_CHANGED" })]);

    const failedBase = await bindProviderDocument("replace-verification-failure");
    const failedLocal = await createEditedDraft(failedBase);
    const failed = await publishArtifact(actorA, {
      documentId: failedBase.documentId,
      localVersionId: failedLocal.patched.version.id,
      baseVersionId: failedBase.version.id,
      mode: "APP_ONLY_FILE_REPLACE",
    }, {
      transport: async () => ({
        metadata: async () => metadata(failedBase.bytes, { itemId: failedBase.itemId, name: "replace-verification-failure.xlsx", eTag: failedBase.eTag }),
        replaceConditional: async () => metadata(failedBase.bytes, { itemId: failedBase.itemId, name: "replace-verification-failure.xlsx", eTag: '"etag-failed-2"' }),
        download: async () => ({ metadata: metadata(failedBase.bytes, { itemId: failedBase.itemId, name: "replace-verification-failure.xlsx", eTag: '"etag-failed-2"' }), bytes: failedBase.bytes }),
      }),
      enqueue: async () => undefined,
    });
    expect(failed).toMatchObject({ status: "verification_failed", failure: "UNEXPECTED_PROVIDER_SEMANTIC_CHANGE" });
    const heads = (await getArtifact(actorA, failedBase.documentId)).heads;
    expect(heads.find((head) => head.kind === "current")?.version_id).toBe(failedBase.version.id);
    expect(heads.some((head) => head.kind === "published")).toBe(false);
  });

  it("detects remote provider change and never calls the conditional writer", async () => {
    const base = await bindProviderDocument("replace-conflict");
    const local = await createEditedDraft(base);
    const replaceConditional = vi.fn();
    const result = await publishArtifact(actorA, { documentId: base.documentId, localVersionId: local.patched.version.id, baseVersionId: base.version.id, mode: "APP_ONLY_FILE_REPLACE" }, {
      transport: async () => ({
        metadata: async () => metadata(base.bytes, { itemId: base.itemId, name: "replace-conflict.xlsx", eTag: '"remote-etag"' }),
        replaceConditional,
        download: async () => ({ metadata: metadata(base.bytes, { itemId: base.itemId, name: "replace-conflict.xlsx", eTag: '"remote-etag"' }), bytes: base.bytes }),
      }),
      enqueue: async () => undefined,
    });
    expect(result).toMatchObject({ status: "conflict", failure: "PROVIDER_HEAD_CHANGED" });
    expect(replaceConditional).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous replacement by readback instead of issuing a blind retry", async () => {
    const base = await bindProviderDocument("replace-recover");
    const local = await createEditedDraft(base);
    let providerBytes = base.bytes;
    let providerETag = base.eTag;
    const replaceConditional = vi.fn(async (input: { bytes: Buffer }) => {
      providerBytes = Buffer.from(input.bytes);
      providerETag = '"etag-recovered"';
      throw new MicrosoftGraphError("provider_down", "connection lost after upload", 503, true);
    });
    const dependencies = {
      transport: async () => ({
        metadata: async () => metadata(providerBytes, { itemId: base.itemId, name: "replace-recover.xlsx", eTag: providerETag }),
        replaceConditional,
        download: async () => ({ metadata: metadata(providerBytes, { itemId: base.itemId, name: "replace-recover.xlsx", eTag: providerETag }), bytes: providerBytes }),
      }),
      enqueue: async () => undefined,
    };
    const first = await publishArtifact(actorA, { documentId: base.documentId, localVersionId: local.patched.version.id, baseVersionId: base.version.id, mode: "APP_ONLY_FILE_REPLACE" }, dependencies);
    expect(first.status).toBe("unknown_delivery");
    const recovered = await publishArtifact(actorA, { documentId: base.documentId, localVersionId: local.patched.version.id, baseVersionId: base.version.id, mode: "APP_ONLY_FILE_REPLACE" }, dependencies);
    expect(recovered).toMatchObject({ status: "verified", providerAck: expect.objectContaining({ recoveredAfterAmbiguousDelivery: true }) });
    expect(replaceConditional).toHaveBeenCalledTimes(1);
  });

  it.each(["create_transport", "recalculate_transport", "recalculate_after_session"] as const)("refuses sibling artifact effects after revocation at %s", async (fault) => {
    const createdLocal = fault === "create_transport" ? await createBlankArtifact(actorA, { kind: "xlsx", title: "sibling-create_transport.xlsx" }) : null;
    const base = createdLocal ? { documentId: createdLocal.documentId, version: createdLocal.version,
      bytes: (await withTenant(tenantA, db => loadDocumentVersion(db, tenantA, createdLocal.documentId, createdLocal.version.id)))!.bytes,
      itemId: "unbound-sibling", eTag: '"unbound-sibling"' } : await bindProviderDocument(`sibling-${fault}`);
    const calls: string[] = [];
    let revoked = false, error: string | null = null, result: unknown;
    const suspend = async () => {
      await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2", [tenantA, ownerA]); revoked = true;
    };
    try {
      try {
        if (fault === "create_transport") {
          result = await publishNewArtifactToMicrosoft(actorA, {
            documentId: base.documentId, localVersionId: base.version.id, integrationId, sourceScopeId: scopeId,
            driveId: "drive-p3", parentItemId: "root-p3", name: `sibling-${fault}.xlsx`, mode: "APP_ONLY_FILE_CREATE", conflictBehavior: "fail",
          }, {
            transport: async ({ mutationAudit }) => {
              if (mutationAudit) await suspend();
              return {
                createFile: async () => { calls.push("create_file"); return metadata(base.bytes, { itemId: "sibling-new-file", name: `sibling-${fault}.xlsx` }); },
                metadataByPath: async () => { throw new MicrosoftGraphError("not_found", "absent", 404, false); },
                download: async () => ({ metadata: metadata(base.bytes, { itemId: "sibling-new-file", name: `sibling-${fault}.xlsx` }), bytes: base.bytes }),
              };
            }, enqueue: async () => undefined,
          });
        } else {
          result = await recalculateArtifactWorkbook(actorA, {
            documentId: base.documentId, versionId: base.version.id, ranges: [{ worksheetId: "Assumptions", address: "D5:D6" }],
          }, { transports: async (_actor, audit) => {
            if (audit && fault === "recalculate_transport") await suspend();
            return {
              excel: {
                createSession: async () => { calls.push("create_session"); if (fault === "recalculate_after_session") await suspend(); return "sibling-session"; },
                calculate: async () => { calls.push("calculate"); },
                closeSession: async () => { calls.push("close_session"); },
                readRange: async () => ({ address: "D5:D6", values: [[25], [8]] }),
              }, file: {
                metadata: async () => metadata(base.bytes, { itemId: base.itemId, eTag: base.eTag }),
                download: async () => ({ metadata: metadata(base.bytes, { itemId: base.itemId, eTag: base.eTag }), bytes: base.bytes }),
              },
            };
          } });
        }
      } catch (e) { error = String(e); }
      const creations = (await admin.query("SELECT * FROM finnor_os.artifact_provider_creations WHERE tenant_id=$1 AND document_id=$2", [tenantA, base.documentId])).rows;
      const operations = (await admin.query("SELECT * FROM finnor_os.external_operations WHERE tenant_id=$1 AND owner_type='artifact_operation' AND owner_key=$2", [tenantA, fault === "create_transport" ? creations[0]?.id : base.documentId])).rows;
      const out = process.env.FINNOR_S6_NATIVE_EVIDENCE_DIR;
      if (out) { await mkdir(out, { recursive: true }); await writeFile(resolve(out, `artifact-sibling-${fault}.json`), JSON.stringify({ schema: "finnor.s6.artifact-sibling-challenge.v1",
        inputs: { actor: actorA, documentId: base.documentId, versionId: base.version.id, integrationId, sourceScopeId: scopeId },
        fault, revoked, calls, error, result, creations, operations, qualification: "Actual sibling artifact/authority/native operation owner; fixture provider primitives, no protected/live-provider admission" }, null, 2) + "\n"); }
      expect(revoked).toBe(true);
      expect(calls).toEqual(fault === "recalculate_after_session" ? ["create_session"] : []);
      expect(error ?? "").toMatch(/DENIED|suspend|authority/i);
      expect(operations).toHaveLength(1);
      expect(operations[0].status).toBe(fault === "recalculate_after_session" ? "unknown" : "failed");
    } finally { await admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2", [tenantA, ownerA]); }
  });

  it("creates a new Microsoft file at the exact allowed target, verifies readback, and never silently renames", async () => {
    const local = await createBlankArtifact(actorA, { kind: "pptx", title: "New IC deck.pptx" });
    const bytes = (await withTenant(tenantA, (db) => loadDocumentVersion(db, tenantA, local.documentId, local.version.id)))!.bytes;
    let createSessions = 0, chunks = 0, providerBytes = Buffer.alloc(0);
    const requests: Array<{ method: string; path: string }> = [];
    const providerItem = () => ({ id: "created-deck", name: "New IC deck.pptx", size: providerBytes.length,
      eTag: '"created-1"', cTag: '"created-ctag"', file: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" } });
    const enqueue = vi.fn(async () => undefined);
    const dependencies = {
      transport: async ({ mutationAudit }: { mutationAudit?: MicrosoftGraphMutationAudit }) => {
        const client = artifactGraphFixture(mutationAudit, async (url, init) => {
          const path = new URL(String(url)).pathname, method = init?.method ?? "GET";
          requests.push({ method, path });
          if (method === "POST") {
            expect(path).toBe("/v1.0/drives/drive-p3/items/root-p3:/New%20IC%20deck.pptx:/createUploadSession");
            expect(JSON.parse(String(init?.body))).toEqual({ item: { "@microsoft.graph.conflictBehavior": "fail", name: "New IC deck.pptx" } });
            createSessions += 1; return Response.json({ uploadUrl: "https://fixture.sharepoint.com/upload/new-deck" });
          }
          if (method === "PUT") {
            expect(path).toBe("/upload/new-deck"); chunks += 1; providerBytes = Buffer.from(init!.body as Uint8Array);
            expect(providerBytes.equals(bytes)).toBe(true); return Response.json(providerItem());
          }
          if (method === "GET" && path.endsWith("/content")) return new Response(new Uint8Array(providerBytes));
          if (method === "GET") { expect(path.startsWith("/v1.0/drives/drive-p3/items/created-deck")).toBe(true); return Response.json(providerItem()); }
          throw new Error(`Unexpected creation request ${method} ${path}`);
        });
        return new MicrosoftDriveArtifactTransport(client, "delegated");
      }, enqueue,
    };
    const input = { documentId: local.documentId, localVersionId: local.version.id, integrationId, sourceScopeId: scopeId, driveId: "drive-p3", parentItemId: "root-p3", name: "New IC deck.pptx", mode: "APP_ONLY_FILE_CREATE" as const, conflictBehavior: "fail" as const };
    const created = await publishNewArtifactToMicrosoft(actorA, input, dependencies);
    expect(created).toMatchObject({ status: "verified", providerItemId: "created-deck", conflictBehavior: "fail" });
    expect(created.externalRefId).toMatch(/[0-9a-f-]{36}/);
    expect({ createSessions, chunks }).toEqual({ createSessions: 1, chunks: 1 });
    expect((await publishNewArtifactToMicrosoft(actorA, input, dependencies)).id).toBe(created.id);
    expect({ createSessions, chunks }).toEqual({ createSessions: 1, chunks: 1 });

    const evidence = await recordArtifactTransportEvidence("artifact-real-client-create", local.documentId, requests);
    if (evidence) {
      expect(evidence.invocations).toHaveLength(2);
      expect(evidence.invocations.every(row => row.outcome === "provider_acknowledged")).toBe(true);
    }

    const conflictLocal = await createBlankArtifact(actorA, { kind: "docx", title: "Existing name.docx" });
    const conflict = await publishNewArtifactToMicrosoft(actorA, { ...input, documentId: conflictLocal.documentId, localVersionId: conflictLocal.version.id, name: "Existing name.docx" }, {
      transport: async () => ({
        createFile: async () => { throw new MicrosoftGraphError("conflict", "name exists", 409, false); },
        metadataByPath: async () => { throw new Error("should not resolve before first create"); },
        download: async () => { throw new Error("should not download conflict"); },
      }),
      enqueue: async () => undefined,
    });
    expect(conflict).toMatchObject({ status: "conflict", failure: "PROVIDER_CREATE_NAME_CONFLICT", providerItemId: null });
  });

  it.each(["exact", "wrong_record_readback"] as const)("uses delegated Excel sessions and exact readback at %s", async (readback) => {
    const base = await bindProviderDocument("recalculate");
    const requests: Array<{ method: string; path: string }> = [];
    const item = { id: base.itemId, name: "recalculate.xlsx", size: base.bytes.length,
      eTag: base.eTag, cTag: '"recalc-ctag"', file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } };
    let result: unknown, error: string | null = null;
    try { result = await recalculateArtifactWorkbook(actorA, { documentId: base.documentId, versionId: base.version.id, ranges: [{ worksheetId: "Assumptions", address: "D5:D6" }] }, {
      transports: async (_actor, mutationAudit) => {
        const client = artifactGraphFixture(mutationAudit, async (url, init) => {
          const path = new URL(String(url)).pathname, method = init?.method ?? "GET";
          requests.push({ method, path });
          expect(path.startsWith(`/v1.0/drives/drive-p3/items/${base.itemId}`)).toBe(true);
          if (method === "POST" && path.endsWith("/createSession")) {
            expect(JSON.parse(String(init?.body))).toEqual({ persistChanges: true }); return Response.json({ id: "session-p3" });
          }
          if (method === "POST") {
            expect(new Headers(init?.headers).get("workbook-session-id")).toBe("session-p3");
            if (path.endsWith("/calculate")) { expect(JSON.parse(String(init?.body))).toEqual({ calculationType: "FullRebuild" }); return Response.json({}); }
            if (path.endsWith("/closeSession")) return new Response(null, { status: 204 });
          }
          if (method === "GET" && path.includes("/range(")) return Response.json({ address: "D5:D6", values: [[25], [8]] });
          if (method === "GET" && path.endsWith("/content")) return new Response(new Uint8Array(base.bytes));
          if (method === "GET") return Response.json({ ...item, id: readback === "wrong_record_readback" && requests.some(row => row.path.endsWith("/closeSession")) ? "decoy-calculation-item" : base.itemId });
          throw new Error(`Unexpected recalculation request ${method} ${path}`);
        });
        return { excel: new MicrosoftDelegatedExcelTransport(client), file: new MicrosoftDriveArtifactTransport(client, "delegated") };
      },
    }); } catch (e) { error = String(e); }
    if (readback === "exact") { expect(error).toBeNull(); expect(result).toMatchObject({ status: "verified", outputs: [{ worksheetId: "Assumptions", address: "D5:D6", value: { address: "D5:D6", values: [[25], [8]] } }] }); }
    expect(requests.filter(row => row.method === "POST").map(row => row.path.split("/").at(-1))).toEqual(["createSession", "calculate", "closeSession"]);
    const evidence = await recordArtifactTransportEvidence(`artifact-real-client-recalculation-${readback}`, base.documentId, { readback, requests, error, result });
    if (evidence) {
      expect(evidence.invocations).toHaveLength(3);
      expect(evidence.invocations.every(row => row.outcome === "provider_acknowledged")).toBe(true);
      if (readback === "wrong_record_readback") expect(evidence.operations[0].verification_status).not.toBe("verified");
    }
    if (readback === "wrong_record_readback") { expect(error ?? "").toMatch(/TARGET|identity|DriveItem ID/i); return; }

    const unavailable = await bindProviderDocument("recalculate-unavailable");
    const stale = await recalculateArtifactWorkbook(actorA, { documentId: unavailable.documentId, versionId: unavailable.version.id, ranges: [{ worksheetId: "Assumptions", address: "D5" }] }, {
      transports: async () => { throw new ProviderAuthError("blocked_config", "No delegated profile"); },
    });
    expect(stale).toEqual({ status: "stale", versionId: unavailable.version.id, reason: "DELEGATED_EXCEL_UNAVAILABLE", outputs: [] });
  });
});
