import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

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

function databaseUrl(name: string): string {
  const url = new URL(SOURCE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

const available = await canConnect();

describe.skipIf(!available)("P1 populated PE database upgrade", () => {
  const databaseName = `finnor_p1_upgrade_${randomUUID().replaceAll("-", "_")}`;
  const targetUrl = databaseUrl(databaseName);
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const organizationId = randomUUID();
  const dealId = randomUUID();
  const workstreamId = randomUUID();
  const documentId = randomUUID();
  const documentLinkId = randomUUID();
  let client: pg.Client;
  let baselineAt: Date;
  let linkBaselineAt: Date;

  beforeAll(async () => {
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    await source.query(`CREATE DATABASE ${databaseName}`);
    await source.end();

    const preP1 = MIGRATIONS.filter(({ name }) => name < "0110_canonical_temporal_truth.sql");
    expect(preP1.at(-1)?.name).toBe("0109b_pgcrypto_digest_compatibility.sql");
    await migrate(targetUrl, preP1);
    client = new pg.Client({ connectionString: targetUrl });
    await client.connect();
    await client.query("SET app.test_vertical_mode = 'explicit'");
    await client.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Populated P1 upgrade project')",
      [tenantId, `p1-upgrade-${randomUUID()}`],
    );
    await client.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES ($1,$2,$3,'owner','active','Upgrade Owner')",
      [ownerId, tenantId, `p1-upgrade-${randomUUID()}@test.invalid`],
    );
    await client.query(
      "INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES ($1,$2,'upgrade-target','Upgrade Target','other')",
      [organizationId, tenantId],
    );
    await client.query(
      "INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES ($1,$2,'loi','Existing LOI','integration:p1-upgrade',$3)",
      [documentId, tenantId, ownerId],
    );
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenantId, ownerId]);
    await client.query(
      "SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'integration:p1-upgrade')",
      [tenantId, ownerId],
    );
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenantId, ownerId]);
    await client.query(
      `INSERT INTO finnor_os.pe_deals(
        id,tenant_id,target_organization_id,name,deal_lead_employee_id,signed_loi_at,
        signed_loi_document_id,target_closing_at,source_system,created_by
       ) VALUES ($1,$2,$3,'Existing signed-LOI Deal',$4::uuid,now()-interval '1 day',$5,
         now()+interval '30 days','integration:p1-upgrade',$4::text)`,
      [dealId, tenantId, organizationId, ownerId, documentId],
    );
    await client.query(
      `INSERT INTO finnor_os.pe_workstreams(
        id,tenant_id,deal_id,kind,name,owner_party_type,owner_party_id,source_system,created_by
       ) VALUES ($1,$2,$3,'commercial','Existing commercial diligence','employee',$4::uuid,'integration:p1-upgrade',$4::text)`,
      [workstreamId, tenantId, dealId, ownerId],
    );
    await client.query(
      `INSERT INTO finnor_os.pe_document_links(
        id,tenant_id,deal_id,entity_type,entity_id,document_id,link_role,source_system,created_by
       ) VALUES ($1,$2,$3,'pe_deal',$3,$4,'governing','integration:p1-upgrade',$5)`,
      [documentLinkId, tenantId, dealId, documentId, ownerId],
    );
    await client.query("COMMIT");

    const applied = await migrate(targetUrl, MIGRATIONS);
    // P1's populated upgrade must remain a regression gate as later phases add
    // forward migrations. Prove both P1 migrations ran, and that the complete
    // pending migration sequence was applied without gaps or reordering.
    expect(applied.slice(0, 2)).toEqual(["0110_canonical_temporal_truth.sql", "0111_pe_world_truth.sql"]);
    expect(applied).toEqual(MIGRATIONS
      .filter(({ name }) => name >= "0110_canonical_temporal_truth.sql")
      .map(({ name }) => name).sort());
    baselineAt = (await client.query<{ at: Date }>(
      "SELECT coverage_started_at at FROM finnor_os.canonical_history_coverage WHERE entity_type='pe_deal'",
    )).rows[0]!.at;
    linkBaselineAt = (await client.query<{ at: Date }>(
      "SELECT coverage_started_at at FROM finnor_os.canonical_history_coverage WHERE entity_type='pe_document_link'",
    )).rows[0]!.at;
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    await source.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await source.end();
  }, 30_000);

  it("preserves populated PE truth and records explicit non-fabricated owner baselines", async () => {
    const result = await client.query(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_deals WHERE id=$1 AND tenant_id=$2) deals,
        (SELECT count(*)::int FROM finnor_os.pe_workstreams WHERE id=$3 AND tenant_id=$2) workstreams,
        (SELECT count(*)::int FROM finnor_os.pe_document_links WHERE id=$4 AND tenant_id=$2) document_links,
        (SELECT count(*)::int FROM finnor_os.canonical_history_coverage WHERE vertical_key='private_equity') coverage_types,
        (SELECT count(*)::int FROM finnor_os.canonical_entity_versions
          WHERE tenant_id=$2 AND entity_type='pe_deal' AND entity_id=$1 AND origin='baseline') deal_history,
        (SELECT count(*)::int FROM finnor_os.canonical_entity_versions
          WHERE tenant_id=$2 AND entity_type='pe_workstream' AND entity_id=$3 AND origin='baseline') child_history,
        (SELECT count(*)::int FROM finnor_os.canonical_entity_versions
          WHERE tenant_id=$2 AND entity_type='pe_document_link' AND entity_id=$4 AND origin='baseline') link_history,
        (SELECT world_root_type FROM finnor_os.pe_document_links WHERE id=$4) root_type,
        (SELECT world_root_id FROM finnor_os.pe_document_links WHERE id=$4) root_id`,
      [dealId, tenantId, workstreamId, documentLinkId],
    );
    expect(result.rows[0]).toEqual({
      deals: 1,
      workstreams: 1,
      document_links: 1,
      // The original twenty P1/legacy PE owners plus the eight P5 IC process
      // entities that join the same canonical temporal-history substrate.
      coverage_types: 28,
      deal_history: 1,
      child_history: 1,
      // 0110 captures the legacy row and 0111 captures the root-scope backfill.
      link_history: 2,
      root_type: "pe_deal",
      root_id: dealId,
    });
    expect(baselineAt).toBeInstanceOf(Date);
    expect(linkBaselineAt).toBeInstanceOf(Date);
    expect(linkBaselineAt.getTime()).toBeGreaterThanOrEqual(baselineAt.getTime());
    const p5Coverage = await client.query<{ entity_type: string }>(
      `SELECT entity_type FROM finnor_os.canonical_history_coverage
        WHERE entity_type=ANY($1::text[]) ORDER BY entity_type`,
      [[
        "pe_ic_case", "pe_ic_memo", "pe_ic_question", "pe_ic_recommendation",
        "pe_ic_vote", "pe_ic_dissent", "pe_ic_condition", "pe_ic_decision_proposal",
      ]],
    );
    expect(p5Coverage.rows.map((row) => row.entity_type)).toEqual([
      "pe_ic_case", "pe_ic_condition", "pe_ic_decision_proposal", "pe_ic_dissent",
      "pe_ic_memo", "pe_ic_question", "pe_ic_recommendation", "pe_ic_vote",
    ]);
  });

  it("does not fabricate history before the recorded baseline", async () => {
    const before = new Date(baselineAt.getTime() - 1);
    const row = await client.query<{ count: number }>(
      `SELECT count(*)::int count FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[]) AND recorded_at<=$3`,
      [tenantId, [dealId, workstreamId, documentLinkId], before],
    );
    expect(row.rows[0]?.count).toBe(0);
  });

  it("is idempotent at the new migration head", async () => {
    await expect(migrate(targetUrl, MIGRATIONS)).resolves.toEqual([]);
    expect((await client.query(
      "SELECT count(*)::int count FROM finnor_os._migrations WHERE name IN ('0110_canonical_temporal_truth.sql','0111_pe_world_truth.sql')",
    )).rows[0]?.count).toBe(2);
  });
});
