import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closePool, getPool } from "@finnor/db";
import { GET as readiness } from "../../apps/api/app/api/ready/route";
import { migrate } from "../../packages/db/migrate";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const available = await (async () => {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
})();

describe.skipIf(!available)("API dependency readiness", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    delete process.env.FINNOR_COMMIT_SHA;
    await migrate(DB_URL);
    await getPool().query("DELETE FROM service_release_heartbeats WHERE service='worker'");
  });
  afterAll(async () => closePool());

  it("separates liveness from migration/worker readiness and exposes no credential values", async () => {
    const unavailable = await readiness();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      ok: false,
      checks: { database: { ok: true }, migrations: { ok: true }, workerFleet: { ok: false } },
    });

    await getPool().query(`INSERT INTO service_release_heartbeats
      (service,instance_id,release_sha,build_id,version,release_source,core_certification_id,migration_head,capabilities,environment,last_beat_at)
      VALUES ('worker','ready-worker','test-sha','test-build','test-version','test','corecert-test',$1,ARRAY['jobs','orchestration'],'test',now())`,
      [CURRENT_MIGRATION_HEAD],
    );
    const ready = await readiness();
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body).toMatchObject({ ok: true, service: "finnor-api", checks: { workerFleet: { ok: true, detail: 1 } } });
    expect(JSON.stringify(body)).not.toMatch(/password|accessToken|refreshToken|apiKey|cookie/i);
  });
});
