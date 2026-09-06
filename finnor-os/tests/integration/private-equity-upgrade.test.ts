import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, type MigrationFile } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function databaseAvailable(): Promise<boolean> {
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

const available = await databaseAvailable();

describe.skipIf(!available)("Private Equity Phase 2 populated database upgrade", () => {
  const database = `finnor_pe2_upgrade_${randomUUID().replaceAll("-", "_")}`;
  const targetUrl = databaseUrl(database);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const householdId = randomUUID();
  const workId = randomUUID();
  const organizationId = randomUUID();
  const documentId = randomUUID();
  let client: pg.Client;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: SOURCE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();

    const beforeVerticalBoundary = MIGRATIONS.filter(({ name }) => name < "0104_core_vertical_runtime_boundary.sql");
    await migrate(targetUrl, beforeVerticalBoundary);
    client = new pg.Client({ connectionString: targetUrl });
    await client.connect();
    await client.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Populated Water Upgrade')",
      [tenantId, `upgrade-${tenantId.slice(0, 8)}`],
    );
    await client.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name) VALUES ($1,$2,$3,'owner','Upgrade Owner')",
      [userId, tenantId, `upgrade-${userId.slice(0, 8)}@test.invalid`],
    );
    await client.query(
      "INSERT INTO finnor_os.households(id,tenant_id,address,contact_info) VALUES ($1,$2,'99 Existing Water Way',$3)",
      [householdId, tenantId, { name: "Existing customer" }],
    );
    await client.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by,idempotency_key)
       VALUES ($1,$2,'received','console','Preserve this existing durable Work',$3,$4)`,
      [workId, tenantId, userId, `upgrade-work-${workId}`],
    );
    await client.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
       VALUES ($1,$2,'existing-vendor','Existing Vendor','vendor')`,
      [organizationId, tenantId],
    );
    await client.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by)
       VALUES ($1,$2,'legacy','Existing Document','integration:pe2-upgrade',$3)`,
      [documentId, tenantId, userId],
    );
    await migrate(targetUrl, MIGRATIONS);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: SOURCE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }, 30_000);

  it("backfills Water identity and preserves populated Core and Water truth", async () => {
    const result = await client.query(
      `SELECT
        (SELECT vertical_key FROM finnor_os.tenant_vertical_assignments WHERE tenant_id=$1) vertical,
        (SELECT count(*)::int FROM finnor_os.households WHERE id=$2 AND tenant_id=$1) households,
        (SELECT count(*)::int FROM finnor_os.works WHERE id=$3 AND tenant_id=$1) works,
        (SELECT count(*)::int FROM finnor_os.external_organizations WHERE id=$4 AND tenant_id=$1) organizations,
        (SELECT count(*)::int FROM finnor_os.documents WHERE id=$5 AND tenant_id=$1) documents,
        to_regclass('finnor_os.pe_deals') IS NOT NULL pe_schema_present,
        (SELECT count(*)::int FROM finnor_os._migrations WHERE name='0105_private_equity_execution_graph.sql') pe_head_count`,
      [tenantId, householdId, workId, organizationId, documentId],
    );
    expect(result.rows[0]).toEqual({
      vertical: "water",
      households: 1,
      works: 1,
      organizations: 1,
      documents: 1,
      pe_schema_present: true,
      pe_head_count: 1,
    });
  });

  it("is idempotent at migration head", async () => {
    await expect(migrate(targetUrl, MIGRATIONS)).resolves.toEqual([]);
    expect((await client.query(
      "SELECT count(*)::int count FROM finnor_os._migrations WHERE name IN ('0104_core_vertical_runtime_boundary.sql','0105_private_equity_execution_graph.sql')",
    )).rows[0]?.count).toBe(2);
  });

  it("rolls a failed migration back without recording partial schema", async () => {
    const broken: MigrationFile = {
      name: "9999_pe2_atomic_recovery_probe.sql",
      sql: "CREATE TABLE finnor_os.pe2_atomic_recovery_probe(id uuid); SELECT finnor_os.no_such_pe2_function();",
    };
    await expect(migrate(targetUrl, [broken])).rejects.toThrow(/9999_pe2_atomic_recovery_probe.*failed/i);
    const result = await client.query(
      `SELECT to_regclass('finnor_os.pe2_atomic_recovery_probe') probe,
        (SELECT count(*)::int FROM finnor_os._migrations WHERE name=$1) tracked`,
      [broken.name],
    );
    expect(result.rows[0]).toEqual({ probe: null, tracked: 0 });
  });
});
