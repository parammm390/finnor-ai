// A2.T5 acceptance: GET /api/vitals — auth required, and each section reflects real
// DB state (queue depth/oldest-pending age from a real queued job, DLQ count scoped to
// THIS tenant only, heartbeat age from the canonical release-heartbeat fleet).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { getPool, withTenant, closePool, tenants, deadLetters } from "@finnor/db";
import { GET as vitalsRoute } from "../../apps/api/app/api/vitals/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_A = "00000000-0000-4000-8000-0000000000fa";
const TENANT_B = "00000000-0000-4000-8000-0000000000fb";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

function req(tenantId?: string): Request {
  const headers: Record<string, string> = { "x-user-role": "owner" };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  return new Request("http://localhost/api/vitals", { headers });
}

describe.skipIf(!available)("GET /api/vitals", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_A, (db) => db.insert(tenants).values({ id: TENANT_A, name: "Vitals Test Dealer A" }).onConflictDoNothing());
    await withTenant(TENANT_B, (db) => db.insert(tenants).values({ id: TENANT_B, name: "Vitals Test Dealer B" }).onConflictDoNothing());
  });
  afterAll(async () => {
    // Never leave a queued job sitting in the shared jobs table — a stray row here
    // gets claimed by the NEXT thing to call JobQueue.tick() against this same local
    // DB (another test file, a dev script), not just this suite.
    await getPool().query(`DELETE FROM jobs WHERE type = 'vitals_test_job'`);
    await closePool();
  });

  it("401s without a bearer token / dev-bypass headers", async () => {
    const original = process.env.AUTH_DEV_BYPASS;
    delete process.env.AUTH_DEV_BYPASS;
    const res = await vitalsRoute(new Request("http://localhost/api/vitals"));
    expect(res.status).toBe(401);
    process.env.AUTH_DEV_BYPASS = original;
  });

  it("reports real queue depth and oldest-pending age off an actually-queued job", async () => {
    await getPool().query(`DELETE FROM jobs WHERE type = 'vitals_test_job'`);
    await getPool().query(
      `INSERT INTO jobs (type, payload, run_at) VALUES ('vitals_test_job', '{}', now() - interval '5 seconds')`,
    );
    const res = await vitalsRoute(req(TENANT_A));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queue.depth).toBeGreaterThanOrEqual(1);
    expect(body.queue.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(4);
  });

  it("scopes DLQ count to the requesting tenant only — tenant B's entries never leak into A's count", async () => {
    await getPool().query(`DELETE FROM dead_letters WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await withTenant(TENANT_A, (db) =>
      db.insert(deadLetters).values({ tenantId: TENANT_A, envelope: {}, errorKind: "terminal", lastError: "vitals test A" }),
    );
    await withTenant(TENANT_B, (db) =>
      db.insert(deadLetters).values([
        { tenantId: TENANT_B, envelope: {}, errorKind: "terminal", lastError: "vitals test B 1" },
        { tenantId: TENANT_B, envelope: {}, errorKind: "terminal", lastError: "vitals test B 2" },
      ]),
    );
    const [resA, resB] = await Promise.all([vitalsRoute(req(TENANT_A)), vitalsRoute(req(TENANT_B))]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
    expect(bodyA.dlq.openCount).toBe(1);
    expect(bodyB.dlq.openCount).toBe(2);
  });

  it("reports exact worker release/migration identity and becomes unhealthy when the fleet is stale", async () => {
    await getPool().query(`DELETE FROM service_release_heartbeats WHERE service='worker'`);
    const res1 = await vitalsRoute(req(TENANT_A));
    const body1 = await res1.json();
    expect(body1.heartbeat.ageSeconds).toBeNull();
    expect(body1.heartbeat.healthy).toBe(false);

    await getPool().query(`INSERT INTO service_release_heartbeats
      (service,instance_id,release_sha,build_id,version,release_source,core_certification_id,migration_head,capabilities,environment,last_beat_at)
      VALUES ('worker','vitals-worker','phase5-sha','finnor-phase5','0.1.0+phase5','test','corecert-test','0094_phase4_tenant_experience_v2.sql',ARRAY['jobs','orchestration'],'test',now())`);
    const res2 = await vitalsRoute(req(TENANT_A));
    const body2 = await res2.json();
    expect(body2.heartbeat.ageSeconds).toBeLessThan(5);
    expect(body2.heartbeat.healthy).toBe(true);
    expect(body2.heartbeat).toMatchObject({ releaseSha: "phase5-sha", migrationHead: "0094_phase4_tenant_experience_v2.sql" });

    await getPool().query(`UPDATE service_release_heartbeats SET last_beat_at=now()-interval '10 minutes' WHERE service='worker'`);
    const res3 = await vitalsRoute(req(TENANT_A));
    const body3 = await res3.json();
    expect(body3.heartbeat.healthy).toBe(false);
  });

  it("includes the active Core capabilities", async () => {
    const res = await vitalsRoute(req(TENANT_A));
    const body = await res.json();
    expect(body.capabilities).toBeDefined();
    expect(typeof body.capabilities).toBe("object");
  });
});
