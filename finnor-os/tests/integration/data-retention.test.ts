import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closePool, getPool } from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { purgeTenantRetention } from "../../apps/worker/src/handlers/purge-retention";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT = "00000000-0000-4000-8000-0000000000b7";
const old = new Date(Date.now() - 91 * 86_400_000);
const available = await (async () => { const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 }); try { await client.connect(); await client.end(); return true; } catch { return false; } })();

describe.skipIf(!available)("data retention", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await getPool().query("INSERT INTO tenants (id, name) VALUES ($1, 'Retention Test') ON CONFLICT (id) DO NOTHING", [TENANT]);
    await getPool().query("INSERT INTO tenant_data_retention_policies (tenant_id, retention_days) VALUES ($1, 90) ON CONFLICT (tenant_id) DO UPDATE SET retention_days = EXCLUDED.retention_days", [TENANT]);
  });

  afterAll(async () => { await getPool().query("DELETE FROM data_retention_holds WHERE tenant_id = $1", [TENANT]); await getPool().query("DELETE FROM jobs WHERE payload->>'tenantId' = $1", [TENANT]); await closePool(); });

  it("deletes eligible Core job payload data and preserves active holds", async () => {
    const db = getPool();
    const jobs = await db.query<{ id: string }>("INSERT INTO jobs (type, payload, status, completed_at) VALUES ('test', jsonb_build_object('tenantId', $1::text), 'completed', $2), ('test', jsonb_build_object('tenantId', $1::text), 'completed', $2) RETURNING id", [TENANT, old]);
    await db.query("INSERT INTO data_retention_holds (tenant_id, resource_type, resource_id, reason) VALUES ($1, 'job', $2, 'investigation')", [TENANT, jobs.rows[1]!.id]);

    const result = await purgeTenantRetention(TENANT);
    expect(result).toMatchObject({ retentionDays: 90, callsScrubbed: 0, messagesDeleted: 0, jobsDeleted: 1 });
    const keptJob = await db.query("SELECT id FROM jobs WHERE id = $1", [jobs.rows[1]!.id]);
    const removedJob = await db.query("SELECT id FROM jobs WHERE id = $1", [jobs.rows[0]!.id]);
    expect(keptJob.rowCount).toBe(1); expect(removedJob.rowCount).toBe(0);
  });
});
