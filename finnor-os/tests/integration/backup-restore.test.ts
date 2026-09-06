// A4.T4 acceptance: packages/db/backup.ts's pure-JS dump/restore round-trip against a
// REAL throwaway Postgres database (created via plain SQL `CREATE DATABASE`, no pg_dump/
// createdb CLI needed) — this is the mechanism that actually runs inside the Railway
// worker process; scripts/backup-restore-drill.ts remains the separate pg_dump-based
// drill for a dev machine/CI image that has Postgres client tools on PATH.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { withTenant, closePool, tenants } from "@finnor/db";
import { eq } from "drizzle-orm";
import { dumpAllTables, restoreAllTables } from "../../packages/db/backup";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: SOURCE_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

function targetUrl(dbName: string): string {
  const u = new URL(SOURCE_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!available)("backup/restore round-trip (A4.T4, no pg_dump dependency)", () => {
  const targetDb = `finnor_backup_drill_${randomUUID().replace(/-/g, "_")}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = SOURCE_URL;
    await migrate(SOURCE_URL);
    await seed(SOURCE_URL);

    const admin = new pg.Client({ connectionString: SOURCE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${targetDb}`);
    await admin.end();

    // migrate() itself already tries CREATE EXTENSION vector and gracefully falls back
    // to jsonb on failure (migration 0000_init.sql's own DO block) — this dev Postgres
    // genuinely doesn't have pgvector installed at all (confirmed: it's not just
    // "not yet enabled" on this database, the extension isn't available server-wide),
    // so both the source db and this fresh target db run in the same jsonb-fallback
    // mode — no separate CREATE EXTENSION call needed or wanted here.
    await migrate(targetUrl(targetDb));
  }, 60_000);

  afterAll(async () => {
    await closePool();
    const admin = new pg.Client({ connectionString: SOURCE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`);
    await admin.end();
  }, 30_000);

  it("dumps every finnor_os table and restores it into a fresh database with matching row counts", async () => {
    const dump = await dumpAllTables(SOURCE_URL);
    expect(dump.schemaVersion).toBe(1);
    expect(Object.keys(dump.tables).length).toBeGreaterThan(30); // real table count, not a stub
    expect(dump.tables.tenants!.length).toBeGreaterThan(0); // real seeded data present

    const result = await restoreAllTables(targetUrl(targetDb), dump);
    expect(result.restoredTables).toBe(Object.keys(dump.tables).length);

    const target = new pg.Client({ connectionString: targetUrl(targetDb) });
    await target.connect();
    try {
      for (const table of ["tenants", "domain_actions", "households", "action_log"]) {
        const sourceCount = dump.tables[table]!.length;
        const { rows } = await target.query(`SELECT count(*)::int AS n FROM finnor_os.${table}`);
        expect(rows[0].n).toBe(sourceCount);
      }
      // Content check, not just counts — the actual seeded tenant row round-tripped
      // with its real id and name intact, not just a same-sized placeholder.
      const [sourceTenant] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(tenants).where(eq(tenants.id, SEED_TENANT_ID)));
      const { rows: targetTenantRows } = await target.query("SELECT id, name FROM finnor_os.tenants WHERE id = $1", [SEED_TENANT_ID]);
      expect(targetTenantRows[0].id).toBe(SEED_TENANT_ID);
      expect(targetTenantRows[0].name).toBe(sourceTenant?.name);
    } finally {
      await target.end();
    }
  }, 60_000);
});
