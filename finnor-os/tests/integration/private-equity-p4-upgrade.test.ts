import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindArtifact, ingestArtifact, registerArtifactTemplate, type ArtifactActor } from "@finnor/artifacts";
import { recordExternalReferenceAcknowledgement } from "@finnor/data-platform";
import { closePool, configureTenantVertical, withTenant } from "@finnor/db";
import { appendEvidenceVersion, createEvidenceSource } from "@finnor/memory";
import {
  attachCanonicalEvidence,
  createAssumption,
  createDeal,
  createInvestmentCase,
  type PeMutationContext,
} from "@finnor/private-equity";
import { migrate } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const P4_MIGRATION = "0126_pe_underwriting_runtime.sql";
const THROUGH_P4_MIGRATIONS = MIGRATIONS.filter(({ name }) => name <= P4_MIGRATION);
const P4_TABLES = [
  "underwriting_models",
  "underwriting_model_versions",
  "underwriting_model_input_bindings",
  "underwriting_scenarios",
  "underwriting_runs",
  "underwriting_sensitivities",
  "underwriting_sensitivity_cells",
  "underwriting_artifact_bindings",
  "underwriting_artifact_projections",
] as const;
const CORPUS = resolve(import.meta.dirname, "../artifact-corpus/lbo-style.xlsx");

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SOURCE_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function databaseUrl(database: string, role?: { username: string; password: string }): string {
  const url = new URL(SOURCE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.username;
    url.password = role.password;
  }
  return url.toString();
}

function idOf(value: Record<string, unknown>, key = "id"): string {
  const id = value[key];
  if (typeof id !== "string") throw new Error(`${key} was not returned as an ID`);
  return id;
}

async function populatedStateFingerprint(client: pg.Client, tenantId: string): Promise<{ fingerprint: string; fact_count: number }> {
  const result = await client.query<{ fingerprint: string; fact_count: number }>(
    `WITH facts AS (
       SELECT 'pe_deals' kind,to_jsonb(row_value) body FROM (SELECT * FROM finnor_os.pe_deals WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_investment_cases',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_investment_cases WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_assumptions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_assumptions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'canonical_entity_versions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'evidence_sources',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.evidence_sources WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'evidence_source_versions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.evidence_source_versions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_evidence_links',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_evidence_links WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'documents',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.documents WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'document_versions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.document_versions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'document_version_contents',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.document_version_contents WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'document_version_heads',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.document_version_heads WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'artifact_ir_snapshots',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.artifact_ir_snapshots WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'artifact_bindings',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.artifact_bindings WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'artifact_templates',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.artifact_templates WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'artifact_publications',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.artifact_publications WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'tenant_integrations',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.tenant_integrations WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'integration_source_scopes',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.integration_source_scopes WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'external_refs',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.external_refs WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'authority_decisions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.authority_decisions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'business_events',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.business_events WHERE tenant_id=$1) row_value
     )
     SELECT encode(sha256(convert_to(coalesce(string_agg(kind||':'||body::text,E'\\n' ORDER BY kind,body::text),''),'UTF8')),'hex') fingerprint,
       count(*)::int fact_count FROM facts`,
    [tenantId],
  );
  return result.rows[0]!;
}

async function registryFingerprint(client: pg.Client): Promise<string> {
  const result = await client.query<{ fingerprint: string }>(
    `SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(row_value)::text,E'\\n' ORDER BY entity_type),''),'UTF8')),'hex') fingerprint
       FROM (SELECT * FROM finnor_os.canonical_truth_registry ORDER BY entity_type) row_value`,
  );
  return result.rows[0]!.fingerprint;
}

const available = await canConnect();

describe.skipIf(!available)("P4 populated P1/P2/P3 database upgrade", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const database = `finnor_p4_upgrade_${randomUUID().replaceAll("-", "_")}`;
  const targetUrl = databaseUrl(database);
  const targetAppUrl = databaseUrl(database, { username: "finnor_app", password: "finnor_app" });
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const organizationId = randomUUID();
  const integrationId = randomUUID();
  const scopeId = randomUUID();
  const authorityDecisionId = randomUUID();
  const publicationId = randomUUID();
  const bytes = readFileSync(CORPUS);
  const byteSha256 = createHash("sha256").update(bytes).digest("hex");
  const actor: ArtifactActor = {
    tenantId,
    userId: ownerId,
    employeeId: ownerId,
    role: "owner",
    correlationId: randomUUID(),
  };
  const peContext: PeMutationContext = {
    auth: { tenantId, userId: ownerId, employeeId: ownerId, role: "owner" },
    provenance: { sourceSystem: "integration:p4-populated-upgrade", createdBy: ownerId },
  };

  let databaseCreated = false;
  let admin: pg.Client | undefined;
  let dealId = "";
  let investmentCaseId = "";
  let assumptionId = "";
  let evidenceVersionId = "";
  let documentId = "";
  let documentVersionId = "";
  let artifactBindingId = "";
  let templateId = "";
  let externalRefId = "";
  let semanticHash = "";
  let beforeFingerprint: Awaited<ReturnType<typeof populatedStateFingerprint>>;
  let afterFingerprint: Awaited<ReturnType<typeof populatedStateFingerprint>>;
  let registryBefore = "";
  let registryAfter = "";
  let appliedP4: string[] = [];

  beforeAll(async () => {
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    try {
      await source.query(`CREATE DATABASE ${database}`);
      databaseCreated = true;
      await source.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    } finally {
      await source.end();
    }

    const preP4 = MIGRATIONS.filter(({ name }) => name < P4_MIGRATION);
    expect(preP4.at(-1)?.name).toBe("0125_artifact_history_least_privilege.sql");
    expect(await migrate(targetUrl, preP4)).toEqual(preP4.map(({ name }) => name));

    admin = new pg.Client({ connectionString: targetUrl });
    await admin.connect();
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P4 populated upgrade project')",
      [tenantId, `p4-populated-upgrade-${tenantId}`],
    );
    await admin.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P4 Upgrade Owner')",
      [ownerId, tenantId, `p4-upgrade-${ownerId}@test.invalid`],
    );
    await admin.query(
      "INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'P4 Upgrade Target','other')",
      [organizationId, tenantId, `p4-upgrade-target-${organizationId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode)
       VALUES($1,$2,'documents','microsoft_graph','real')`,
      [integrationId, tenantId],
    );
    await admin.query(
      `INSERT INTO finnor_os.integration_source_scopes(
         id,tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,
         scope_key,sync_strategy,recovery_strategy,required_permissions,effective_permissions,
         permission_verified_at,configuration,configured_by
       ) VALUES(
         $1,$2,$3,'microsoft_graph','sharepoint_drive','drive_subtree','drive-upgrade/root-upgrade',
         'drive:p4-populated-upgrade','delta','EXACT_DELTA',ARRAY['Files.ReadWrite.Selected'],
         ARRAY['Files.ReadWrite.Selected'],now(),$4::jsonb,$5
       )`,
      [scopeId, tenantId, integrationId, JSON.stringify({ driveId: "drive-upgrade", rootItemId: "root-upgrade" }), ownerId],
    );

    process.env.DATABASE_URL = targetAppUrl;
    await closePool();
    await configureTenantVertical({
      tenantId,
      verticalKey: "private_equity",
      expectedVersion: 0,
      createdBy: ownerId,
      sourceSystem: "integration:p4-populated-upgrade",
    });

    dealId = idOf((await createDeal(peContext, {
      targetOrganizationId: organizationId,
      name: "Existing populated LBO deal",
      dealLeadEmployeeId: ownerId,
      signedLoiAt: new Date(Date.now() - 86_400_000),
      targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    })).row as Record<string, unknown>);
    investmentCaseId = idOf((await createInvestmentCase(peContext, {
      dealId,
      title: "Existing populated investment case",
    })).row as Record<string, unknown>);
    assumptionId = idOf((await createAssumption(peContext, {
      dealId,
      investmentCaseId,
      assumptionKey: "exit_multiple",
      statement: "Existing exit multiple assumption",
      valueType: "number",
      value: 5,
      unit: "multiple",
      materiality: "critical",
    })).row as Record<string, unknown>);

    const evidenceSource = await createEvidenceSource(tenantId, {
      sourceKey: `p4-upgrade-evidence-${randomUUID()}`,
      sourceType: "underwriting_fixture",
      title: "Existing populated underwriting evidence",
    });
    const evidence = await appendEvidenceVersion(tenantId, evidenceSource.id, {
      content: "The observed base exit multiple is exactly five times.",
      snapshot: { exit: { multiple: "5" } },
      asOf: new Date(),
      retrievedAt: new Date(),
    });
    evidenceVersionId = evidence.versionId;
    await attachCanonicalEvidence(peContext, {
      dealId,
      entity: { entityType: "pe_assumption", entityId: assumptionId },
      evidenceSourceId: evidenceSource.id,
      evidenceVersionId,
      relationship: "supports",
    });

    const artifact = await ingestArtifact(actor, {
      title: "Existing populated LBO.xlsx",
      bytes,
      origin: "provider_observation",
      sourceSystem: "microsoft_graph",
      sourceRef: `drive-upgrade/item-${randomUUID()}`,
      providerEtag: '"p4-upgrade-etag"',
      providerVersionId: '"p4-upgrade-etag"',
    });
    documentId = artifact.documentId;
    documentVersionId = String(artifact.version.id);
    semanticHash = artifact.ir.semanticHash;
    const anchor = artifact.ir.nodes.find((node) => node.kind === "cell");
    if (!anchor) throw new Error("populated upgrade workbook did not produce a SpreadsheetIR cell anchor");
    artifactBindingId = idOf(await bindArtifact(actor, documentId, {
      versionId: documentVersionId,
      anchorId: anchor.id,
      anchorHash: anchor.hash,
      targetKind: "canonical_entity",
      targetId: assumptionId,
      targetEntityType: "pe_assumption",
    }) as Record<string, unknown>);
    templateId = idOf(await registerArtifactTemplate(actor, documentId, {
      versionId: documentVersionId,
      templateKey: "p4_upgrade_lbo_v1",
    }) as Record<string, unknown>);

    externalRefId = await withTenant(tenantId, (db) => recordExternalReferenceAcknowledgement(db, {
      tenantId,
      integrationId,
      provider: "microsoft_graph",
      canonicalEntity: "document",
      canonicalEntityId: documentId,
      externalObjectType: "microsoft_drive_item",
      externalId: `drive-upgrade/item-${documentId}`,
    }));
    await admin.query(
      `UPDATE finnor_os.external_refs SET observed_state=$2::jsonb,source_version=$3,provenance=$4::jsonb
       WHERE tenant_id=$1 AND id=$5`,
      [tenantId, JSON.stringify({ driveId: "drive-upgrade", id: `item-${documentId}`, eTag: '"p4-upgrade-etag"' }),
        '"p4-upgrade-etag"', JSON.stringify({ sourceScopeId: scopeId }), externalRefId],
    );
    await admin.query(
      `INSERT INTO finnor_os.authority_decisions(
         id,tenant_id,employee_id,authority_revision,operation,capability,resource_type,resource_id,
         risk,outcome,reason_code,evidence
       ) VALUES($1,$2,$3,1,'execution','artifact:publish','document',$4,'medium','allowed','P4_UPGRADE_FIXTURE','{}'::jsonb)`,
      [authorityDecisionId, tenantId, ownerId, documentId],
    );
    await admin.query(
      `INSERT INTO finnor_os.artifact_publications(
         id,tenant_id,document_id,local_version_id,base_version_id,integration_id,external_ref_id,base_etag,
         write_mode,provider_binding_key,actor_id,authority_decision_id,expected_semantic_hash,status
       ) VALUES($1,$2,$3,$4,$4,$5,$6,$7,'APP_ONLY_FILE_REPLACE',$8,$9,$10,$11,'prepared')`,
      [publicationId, tenantId, documentId, documentVersionId, integrationId, externalRefId,
        '"p4-upgrade-etag"', `drive-upgrade/item-${documentId}`, ownerId, authorityDecisionId, semanticHash],
    );

    beforeFingerprint = await populatedStateFingerprint(admin, tenantId);
    registryBefore = await registryFingerprint(admin);
    // Keep this regression scoped to the populated P3 -> P4 boundary. Later
    // migrations have their own populated-upgrade suites and must not blur the
    // assertion that 0126 alone preserves pre-P4 state.
    appliedP4 = await migrate(targetUrl, THROUGH_P4_MIGRATIONS);
    afterFingerprint = await populatedStateFingerprint(admin, tenantId);
    registryAfter = await registryFingerprint(admin);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await admin?.end().catch(() => undefined);
    if (databaseCreated) {
      const source = new pg.Client({ connectionString: SOURCE_URL });
      await source.connect();
      try {
        await source.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await source.end();
      }
    }
  }, 30_000);

  it("applies only P4 and preserves the exact populated P1/P2/P3 state", async () => {
    expect(appliedP4).toEqual([P4_MIGRATION]);
    expect(afterFingerprint).toEqual(beforeFingerprint);
    expect(afterFingerprint.fact_count).toBeGreaterThanOrEqual(20);
    expect(registryAfter).toBe(registryBefore);

    const state = await admin!.query(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2) deals,
        (SELECT count(*)::int FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$3) investment_cases,
        (SELECT count(*)::int FROM finnor_os.pe_assumptions WHERE tenant_id=$1 AND id=$4) assumptions,
        (SELECT count(*)::int FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_id=ANY($5::uuid[])) canonical_versions,
        (SELECT count(*)::int FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$6) evidence_versions,
        (SELECT count(*)::int FROM finnor_os.pe_evidence_links WHERE tenant_id=$1 AND entity_id=$4 AND evidence_version_id=$6) evidence_links,
        (SELECT count(*)::int FROM finnor_os.document_versions WHERE tenant_id=$1 AND document_id=$7 AND id=$8) document_versions,
        (SELECT count(*)::int FROM finnor_os.artifact_ir_snapshots WHERE tenant_id=$1 AND version_id=$8 AND semantic_hash=$9) ir_snapshots,
        (SELECT count(*)::int FROM finnor_os.artifact_bindings WHERE tenant_id=$1 AND id=$10) artifact_bindings,
        (SELECT count(*)::int FROM finnor_os.artifact_templates WHERE tenant_id=$1 AND id=$11) artifact_templates,
        (SELECT count(*)::int FROM finnor_os.artifact_publications WHERE tenant_id=$1 AND id=$12 AND status='prepared') artifact_publications,
        (SELECT count(*)::int FROM finnor_os.integration_source_scopes WHERE tenant_id=$1 AND id=$13) source_scopes`,
      [tenantId, dealId, investmentCaseId, assumptionId, [dealId, investmentCaseId, assumptionId],
        evidenceVersionId, documentId, documentVersionId, semanticHash, artifactBindingId, templateId, publicationId, scopeId],
    );
    expect(state.rows[0]).toEqual({
      deals: 1,
      investment_cases: 1,
      assumptions: 1,
      // Deal graph_version advances once for each exact child/link attachment:
      // Deal creation + InvestmentCase + Assumption + EvidenceLink = four Deal
      // snapshots, plus one snapshot for the Case and one for the Assumption.
      canonical_versions: 6,
      evidence_versions: 1,
      evidence_links: 1,
      document_versions: 1,
      ir_snapshots: 1,
      artifact_bindings: 1,
      artifact_templates: 1,
      artifact_publications: 1,
      source_scopes: 1,
    });
    const content = await admin!.query<{ bytes: Buffer; byte_sha256: string; content_sha: string }>(
      `SELECT c.bytes,v.byte_sha256,c.sha256 content_sha
       FROM finnor_os.document_versions v JOIN finnor_os.document_version_contents c
         ON c.tenant_id=v.tenant_id AND c.version_id=v.id
       WHERE v.tenant_id=$1 AND v.id=$2`,
      [tenantId, documentVersionId],
    );
    expect(Buffer.from(content.rows[0]!.bytes).equals(bytes)).toBe(true);
    expect(content.rows[0]).toMatchObject({ byte_sha256: byteSha256, content_sha: byteSha256 });

    const history = await admin!.query<{ entity_type: string; versions: number; sequence: number[] }>(
      `SELECT entity_type,count(*)::int versions,array_agg(entity_version ORDER BY entity_version) sequence
       FROM finnor_os.canonical_entity_versions
       WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[])
       GROUP BY entity_type ORDER BY entity_type`,
      [tenantId, [dealId, investmentCaseId, assumptionId]],
    );
    expect(history.rows).toEqual([
      { entity_type: "pe_assumption", versions: 1, sequence: [1] },
      { entity_type: "pe_deal", versions: 4, sequence: [1, 2, 3, 4] },
      { entity_type: "pe_investment_case", versions: 1, sequence: [1] },
    ]);
  });

  it("creates the nine additive immutable, tenant-isolated P4 tables without fabricated rows or owners", async () => {
    const rowCounts = await admin!.query<{ count: number }>(
      `SELECT sum(row_count)::int count FROM (
         SELECT (xpath('/row/c/text()',query_to_xml(format('SELECT count(*) c FROM finnor_os.%I',table_name),false,true,'')))[1]::text::int row_count
         FROM unnest($1::text[]) table_name
       ) counted`,
      [[...P4_TABLES]],
    );
    expect(rowCounts.rows[0]?.count).toBe(0);

    const rls = await admin!.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE relnamespace='finnor_os'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname`,
      [[...P4_TABLES]],
    );
    expect(rls.rows).toHaveLength(P4_TABLES.length);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const immutable = await admin!.query<{ count: number }>(
      `SELECT count(*)::int count FROM pg_trigger
       WHERE NOT tgisinternal AND tgname='immutable_underwriting_history'
         AND tgrelid=ANY(SELECT ('finnor_os.'||unnest($1::text[]))::regclass)`,
      [[...P4_TABLES]],
    );
    expect(immutable.rows[0]?.count).toBe(P4_TABLES.length);

    const privileges = await admin!.query<{ table_name: string; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
      `SELECT table_name,
         has_table_privilege('finnor_app','finnor_os.'||table_name,'INSERT') can_insert,
         has_table_privilege('finnor_app','finnor_os.'||table_name,'UPDATE') can_update,
         has_table_privilege('finnor_app','finnor_os.'||table_name,'DELETE') can_delete
       FROM unnest($1::text[]) table_name ORDER BY table_name`,
      [[...P4_TABLES]],
    );
    expect(privileges.rows.every((row) => row.can_insert && !row.can_update && !row.can_delete)).toBe(true);

    const duplicateOwners = await admin!.query<{ count: number }>(
      `SELECT count(*)::int count FROM finnor_os.canonical_truth_registry
       WHERE entity_type LIKE 'underwriting%' OR source_table LIKE 'underwriting%'`,
    );
    expect(duplicateOwners.rows[0]?.count).toBe(0);
  });

  it("installs same-tenant owner constraints and reruns idempotently at the exact migration head", async () => {
    const foreignKeys = await admin!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
       WHERE connamespace='finnor_os'::regnamespace AND contype='f'
         AND conrelid=ANY(SELECT ('finnor_os.'||unnest($1::text[]))::regclass)`,
      [[...P4_TABLES]],
    );
    const definitions = foreignKeys.rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("REFERENCES pe_investment_cases(tenant_id, id)");
    expect(definitions).toContain("REFERENCES pe_assumptions(tenant_id, investment_case_id, id)");
    expect(definitions).toContain("REFERENCES document_versions(tenant_id, document_id, id)");
    expect(definitions).toContain("REFERENCES underwriting_runs(tenant_id, investment_case_id, model_version_id, id)");

    await expect(migrate(targetUrl, THROUGH_P4_MIGRATIONS)).resolves.toEqual([]);
    const tracked = await admin!.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os._migrations WHERE name=$1",
      [P4_MIGRATION],
    );
    expect(tracked.rows[0]?.count).toBe(1);
    expect(await populatedStateFingerprint(admin!, tenantId)).toEqual(afterFingerprint);
  });
});
