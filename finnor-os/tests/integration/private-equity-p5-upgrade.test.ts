import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import { appendEvidenceVersion, createEvidenceSource } from "@finnor/memory";
import {
  activateInvestmentCase,
  attachCanonicalDocument,
  attachCanonicalEvidence,
  createAssumption,
  createDeal,
  createInvestmentCase,
  finalizeDecision,
  recordDecision,
  type PeMutationContext,
} from "@finnor/private-equity";
import { migrate } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const P5_MIGRATION = "0127_pe_actions_ic_runtime.sql";
const P5_TABLES = [
  "pe_ic_committee_config_versions",
  "pe_ic_committee_membership_versions",
  "pe_ic_cases",
  "pe_ic_memos",
  "pe_ic_questions",
  "pe_ic_recommendations",
  "pe_ic_votes",
  "pe_ic_dissents",
  "pe_ic_conditions",
  "pe_ic_source_links",
  "pe_ic_decision_proposals",
  "pe_ic_decision_links",
  "pe_ic_decision_condition_links",
] as const;

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

function idOf(value: Record<string, unknown>): string {
  if (typeof value.id !== "string") throw new Error("canonical ID missing");
  return value.id;
}

async function legacyFingerprint(client: pg.Client, tenantId: string): Promise<{ fingerprint: string; facts: number }> {
  const result = await client.query<{ fingerprint: string; facts: number }>(
    `WITH facts AS (
       SELECT 'works' kind,to_jsonb(row_value) body FROM (SELECT * FROM finnor_os.works WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_deals',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_deals WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_investment_cases',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_investment_cases WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_assumptions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_assumptions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_decisions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_decisions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'evidence_sources',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.evidence_sources WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'evidence_source_versions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.evidence_source_versions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_evidence_links',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_evidence_links WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'documents',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.documents WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'document_versions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.document_versions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'artifact_ir_snapshots',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.artifact_ir_snapshots WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'pe_document_links',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.pe_document_links WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'underwriting_models',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.underwriting_models WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'underwriting_model_versions',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'underwriting_runs',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.underwriting_runs WHERE tenant_id=$1) row_value
       UNION ALL SELECT 'business_events',to_jsonb(row_value) FROM (SELECT * FROM finnor_os.business_events WHERE tenant_id=$1) row_value
     )
     SELECT encode(sha256(convert_to(coalesce(string_agg(kind||':'||body::text,E'\n' ORDER BY kind,body::text),''),'UTF8')),'hex') fingerprint,
       count(*)::int facts FROM facts`,
    [tenantId],
  );
  return result.rows[0]!;
}

const available = await canConnect();

describe.skipIf(!available)("P5 populated P1-P4 database upgrade", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const database = `finnor_p5_upgrade_${randomUUID().replaceAll("-", "_")}`;
  const targetUrl = databaseUrl(database);
  const targetAppUrl = databaseUrl(database, { username: "finnor_app", password: "finnor_app" });
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const targetOrganizationId = randomUUID();
  const workId = randomUUID();
  const documentId = randomUUID();
  const documentVersionId = randomUUID();
  const modelId = randomUUID();
  const modelVersionId = randomUUID();
  const runId = randomUUID();
  const context: PeMutationContext = {
    auth: { tenantId, userId: ownerId, employeeId: ownerId, role: "owner" },
    provenance: { sourceSystem: "integration:p5-populated-upgrade", createdBy: ownerId },
  };

  let databaseCreated = false;
  let admin: pg.Client | undefined;
  let dealId = "";
  let investmentCaseId = "";
  let assumptionId = "";
  let decisionId = "";
  let evidenceVersionId = "";
  let before: Awaited<ReturnType<typeof legacyFingerprint>>;
  let after: Awaited<ReturnType<typeof legacyFingerprint>>;
  let applied: string[] = [];

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

    const preP5 = MIGRATIONS.filter(({ name }) => name < P5_MIGRATION);
    expect(preP5.at(-1)?.name).toBe("0126_pe_underwriting_runtime.sql");
    expect(await migrate(targetUrl, preP5)).toEqual(preP5.map(({ name }) => name));

    admin = new pg.Client({ connectionString: targetUrl });
    await admin.connect();
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P5 populated upgrade project')", [tenantId, `p5-upgrade-${tenantId}`]);
    await admin.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P5 Upgrade Owner')",
      [ownerId, tenantId, `p5-upgrade-${ownerId}@test.invalid`],
    );
    await admin.query(
      "INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'P5 Upgrade Target','other')",
      [targetOrganizationId, tenantId, `p5-upgrade-target-${targetOrganizationId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by,idempotency_key)
       VALUES($1,$2,'received','console','Preserve populated P1-P4 truth during P5 migration',$3,$4)`,
      [workId, tenantId, ownerId, `p5-upgrade-work-${workId}`],
    );

    process.env.DATABASE_URL = targetAppUrl;
    await closePool();
    await configureTenantVertical({
      tenantId, verticalKey: "private_equity", expectedVersion: 0,
      createdBy: ownerId, sourceSystem: "integration:p5-populated-upgrade",
    });

    dealId = idOf((await createDeal(context, {
      targetOrganizationId, name: "Populated pre-P5 Deal", dealLeadEmployeeId: ownerId,
      signedLoiAt: new Date(Date.now() - 86_400_000), targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    })).row as Record<string, unknown>);
    investmentCaseId = idOf((await createInvestmentCase(context, { dealId, title: "Populated pre-P5 InvestmentCase" })).row as Record<string, unknown>);
    await activateInvestmentCase(context, { investmentCaseId, expectedVersion: 1 });
    assumptionId = idOf((await createAssumption(context, {
      dealId, investmentCaseId, assumptionKey: "entry_multiple", statement: "Entry multiple is pinned before P5",
      valueType: "number", value: 8, unit: "multiple", materiality: "critical",
    })).row as Record<string, unknown>);

    const sourceEvidence = await createEvidenceSource(tenantId, {
      sourceKey: `p5-upgrade-evidence-${randomUUID()}`,
      sourceType: "diligence_fixture",
      title: "Populated P2 evidence",
    });
    evidenceVersionId = (await appendEvidenceVersion(tenantId, sourceEvidence.id, {
      content: "A pre-P5 diligence observation.", snapshot: { observed: true }, asOf: new Date(), retrievedAt: new Date(),
    })).versionId;
    await attachCanonicalEvidence(context, {
      dealId, entity: { entityType: "pe_assumption", entityId: assumptionId },
      evidenceSourceId: sourceEvidence.id, evidenceVersionId, relationship: "supports",
    });

    await admin.query(
      "INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES($1,$2,'ic_memo','Populated P3 Memo','integration:p5-populated-upgrade',$3)",
      [documentId, tenantId, ownerId],
    );
    await admin.query(
      `INSERT INTO finnor_os.document_versions(
         id,tenant_id,document_id,version_ordinal,origin,format,media_type,byte_sha256,size_bytes,created_by
       ) VALUES($1,$2,$3,1,'finnor_generated','docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,128,$5)`,
      [documentVersionId, tenantId, documentId, "a".repeat(64), ownerId],
    );
    await admin.query(
      `INSERT INTO finnor_os.artifact_ir_snapshots(
         tenant_id,version_id,parser_schema,kind,semantic_hash,parse_status,fidelity_status,ir
       ) VALUES($1,$2,'artifact-ir.v1','docx',$3,'parsed','preserved',$4::jsonb)`,
      [tenantId, documentVersionId, "b".repeat(64), JSON.stringify({ nodes: [{ id: "summary", hash: "c".repeat(64), kind: "paragraph" }] })],
    );
    await attachCanonicalDocument(context, {
      dealId, entity: { entityType: "pe_investment_case", entityId: investmentCaseId },
      documentId, linkRole: "governing",
    });

    const modelHash = `sha256:${"d".repeat(64)}`;
    const inputHash = `sha256:${"e".repeat(64)}`;
    const resultHash = `sha256:${"f".repeat(64)}`;
    await admin.query(
      "INSERT INTO finnor_os.underwriting_models(id,tenant_id,investment_case_id,model_key,name,created_by) VALUES($1,$2,$3,$4,'Populated P4 Model',$5)",
      [modelId, tenantId, investmentCaseId, `p5-upgrade-model-${modelId}`, ownerId],
    );
    await admin.query(
      `INSERT INTO finnor_os.underwriting_model_versions(
         id,tenant_id,investment_case_id,model_id,version_key,schema_version,financial_convention_version,
         minimum_engine_version,semantic_hash,model_definition,created_by
       ) VALUES($1,$2,$3,$4,'v1','underwriting-model-ir.v1','upgrade-convention.v1','upgrade-engine.v1',$5,$6::jsonb,$7)`,
      [modelVersionId, tenantId, investmentCaseId, modelId, modelHash, JSON.stringify({
        schemaVersion: "underwriting-model-ir.v1", financialConventionVersion: "upgrade-convention.v1",
        minimumEngineVersion: "upgrade-engine.v1", modelVersion: "v1", nodes: [{ id: "revenue", kind: "input" }],
      }), ownerId],
    );
    const worldAt = new Date(Date.now() - 60_000);
    await admin.query(
      `INSERT INTO finnor_os.underwriting_runs(
         id,tenant_id,investment_case_id,model_version_id,world_at,computed_at,engine_version,model_semantic_hash,
         input_hash,input_snapshot,result_hash,result,status,validity,idempotency_key,created_by
       ) VALUES($1,$2,$3,$4,$5,clock_timestamp(),'upgrade-engine.v1',$6,$7,$8::jsonb,$9,$10::jsonb,'SUCCEEDED','VALID',$11,$12)`,
      [runId, tenantId, investmentCaseId, modelVersionId, worldAt, modelHash, inputHash,
        JSON.stringify({ semanticHash: inputHash, investmentCaseId, worldAt: worldAt.toISOString(), values: {} }),
        resultHash, JSON.stringify({
          resultSemanticHash: resultHash, modelSemanticHash: modelHash, inputSemanticHash: inputHash,
          engineVersion: "upgrade-engine.v1", status: "SUCCEEDED", validity: "VALID", checks: [],
        }), `p5-upgrade-run-${runId}`, ownerId],
    );

    const draftedDecision = await recordDecision(context, {
      dealId, investmentCaseId, decisionType: "investment_committee",
      title: "Legacy pre-P5 IC Decision", decision: "Proceed to diligence", rationale: "Canonical P1 history remains untouched.",
    });
    decisionId = idOf(draftedDecision.row as Record<string, unknown>);
    await finalizeDecision(context, {
      decisionId, expectedVersion: 1, decidedBy: { partyType: "employee", partyId: ownerId },
    });

    before = await legacyFingerprint(admin, tenantId);
    applied = await migrate(targetUrl, MIGRATIONS);
    after = await legacyFingerprint(admin, tenantId);
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

  it("applies the forward P5/P6/P7 migrations and preserves the byte-stable populated P1/P2/P3/P4 tenant truth", () => {
    const expectedForwardMigrations = MIGRATIONS.filter(({ name }) => name >= P5_MIGRATION).map(({ name }) => name);
    expect(applied).toEqual(expectedForwardMigrations);
    expect(after).toEqual(before);
    expect(after.facts).toBeGreaterThanOrEqual(20);
  });

  it("does not fabricate P5 history for the existing canonical P1 investment_committee Decision", async () => {
    const result = await admin!.query<{ decisions: number; ic_cases: number; ic_links: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND id=$2 AND state='final') decisions,
        (SELECT count(*)::int FROM finnor_os.pe_ic_cases WHERE tenant_id=$1) ic_cases,
        (SELECT count(*)::int FROM finnor_os.pe_ic_decision_links WHERE tenant_id=$1) ic_links`,
      [tenantId, decisionId],
    );
    expect(result.rows[0]).toEqual({ decisions: 1, ic_cases: 0, ic_links: 0 });
  });

  it("creates all thirteen tenant-isolated P5 tables empty on the populated upgrade", async () => {
    const relationRows = await admin!.query<{ tablename: string; rowsecurity: boolean; force_rls: boolean }>(
      `SELECT c.relname tablename,c.relrowsecurity rowsecurity,c.relforcerowsecurity force_rls
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='finnor_os' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [[...P5_TABLES]],
    );
    expect(relationRows.rows).toHaveLength(13);
    expect(relationRows.rows.every((row) => row.rowsecurity && row.force_rls)).toBe(true);
    for (const table of P5_TABLES) {
      const count = await admin!.query<{ count: number }>(`SELECT count(*)::int count FROM finnor_os.${table} WHERE tenant_id=$1`, [tenantId]);
      expect(count.rows[0]!.count, table).toBe(0);
    }
  });

  it("retains exact P1/P2/P3/P4 identities after the P5 migration", async () => {
    const result = await admin!.query<{ assumptions: number; evidence: number; documents: number; runs: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_assumptions WHERE tenant_id=$1 AND id=$2) assumptions,
        (SELECT count(*)::int FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$3) evidence,
        (SELECT count(*)::int FROM finnor_os.document_versions WHERE tenant_id=$1 AND id=$4) documents,
        (SELECT count(*)::int FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$5 AND validity='VALID') runs`,
      [tenantId, assumptionId, evidenceVersionId, documentVersionId, runId],
    );
    expect(result.rows[0]).toEqual({ assumptions: 1, evidence: 1, documents: 1, runs: 1 });
  });
});
