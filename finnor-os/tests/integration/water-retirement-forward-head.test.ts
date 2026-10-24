import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { migrate } from "../../packages/db/migrate";
// @ts-ignore The production release helper is intentionally native ESM outside the TS workspace.
import {
  drainAuditedWaterFixtures,
  readWaterOperationalCensus,
} from "../../../scripts/release/p8-water-retirement-store.mjs";

const sourceUrl = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
const roles = ["api", "worker", "orchestrator", "supplier-canary", "scheduler-owner"] as const;
const releaseSha = "8".repeat(40);

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: sourceUrl, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

function databaseUrl(database: string): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

const available = await canConnect();

describe.skipIf(!available)("Water retirement forward-migration compatibility", () => {
  const database = `finnor_p8_cutover_${randomUUID().replaceAll("-", "_")}`;
  const targetUrl = databaseUrl(database);
  let client: pg.Client;

  beforeAll(async () => {
    const source = new pg.Client({ connectionString: sourceUrl });
    await source.connect();
    try { await source.query(`CREATE DATABASE ${database}`); } finally { await source.end(); }
    await migrate(targetUrl);
    client = new pg.Client({ connectionString: targetUrl });
    await client.connect();
  }, 180_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    const source = new pg.Client({ connectionString: sourceUrl });
    await source.connect();
    try { await source.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await source.end(); }
  }, 30_000);

  it("preserves Y episode budgets against delete and recreate", async () => {
    const tenant = randomUUID(), principal = randomUUID(), work = randomUUID(), episode = randomUUID();
    await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Y budget deletion regression')", [tenant]);
    await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [principal, tenant, `${principal}@budget.test.invalid`]);
    await client.query("INSERT INTO finnor_os.works(id,tenant_id,initial_channel,initial_instruction,created_by) VALUES($1,$2,'text','Preserve original episode',$3)", [work, tenant, principal]);
    await client.query("INSERT INTO finnor_os.y1_episodes(tenant_id,id,principal_id,work_id,deadline_at,attempts_used) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 minute',1)", [tenant, episode, principal, work]);
    const before = (await client.query("SELECT to_jsonb(e) body FROM finnor_os.y1_episodes e WHERE id=$1", [episode])).rows[0].body;
    await expect(client.query("DELETE FROM finnor_os.y1_episodes WHERE id=$1", [episode])).rejects.toThrow(/immutable|append-only|cannot.*delet|delete.*forbidden/i);
    const privileges = (await client.query("SELECT has_table_privilege('finnor_app','finnor_os.y1_episodes','DELETE') allowed")).rows[0];
    expect(privileges.allowed).toBe(false);
    expect((await client.query("SELECT to_jsonb(e) body FROM finnor_os.y1_episodes e WHERE id=$1", [episode])).rows[0].body).toEqual(before);
    const directory=process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR??join(tmpdir(),"finnor-y-budget-proof");
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,"episode-delete-refusal.json"),JSON.stringify({inputs:{tenant,principal,work,episode},
      steps:["Apply all migrations to a disposable database","Create original episode with one occupied attempt","Attempt administrator DELETE","Check app privileges and original preimage"],
      observed:{original:before,deleteRejected:true,appDeleteAllowed:privileges.allowed,preimageRetained:true},
      rerun:"FINNOR_TEST_MANAGED_EXTENSIONS=omit DATABASE_URL=<disposable-postgres> npm --prefix finnor-os test -- --run tests/integration/water-retirement-forward-head.test.ts"},null,2));
  });

  it("requires the actual current migration head while preserving the Phase-5 freeze and activation barriers", async () => {
    const migration = await client.query<{ head: string }>("SELECT max(name COLLATE \"C\") head FROM finnor_os._migrations");
    expect(migration.rows[0]?.head).toBe(CURRENT_MIGRATION_HEAD);

    const waterTenantId = randomUUID();
    const waterActionId = randomUUID();
    await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES ($1,'P8 historical fixture')", [waterTenantId]);
    await client.query(
      `INSERT INTO finnor_os.water_tenant_retirement_dispositions
         (tenant_id,classification,authorized,authorization_ref,obligations,classified_by)
       VALUES ($1,'TEST',true,'test:p8-cutover','["preserve_historical_truth"]'::jsonb,'p8:test')`,
      [waterTenantId],
    );
    await client.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,status)
       VALUES ($1,$2,'send_customer_message','pending')`,
      [waterActionId, waterTenantId],
    );

    for (const role of roles) {
      await client.query(
        `INSERT INTO finnor_os.service_release_heartbeats
           (service,instance_id,release_sha,build_id,version,release_source,migration_head,
            capabilities,environment,last_beat_at,cutover_protocol,product_epoch)
         VALUES ($1,$2,$3,'p8-build','8.0.0','p8-test',$4,'{}','test',now(),5,5)`,
        [role, `${role}-p8`, releaseSha, role === "worker" ? "0109_atomic_water_runtime_retirement.sql" : CURRENT_MIGRATION_HEAD],
      );
    }

    await expect(client.query(
      `SELECT finnor_os.freeze_water_intake(5,'p8:test','{"p0P4Verified":true}'::jsonb)`,
    )).rejects.toThrow(/mixed-fleet freeze blocked/i);

    await client.query(
      "UPDATE finnor_os.service_release_heartbeats SET migration_head=$1,last_beat_at=now() WHERE service='worker'",
      [CURRENT_MIGRATION_HEAD],
    );
    await expect(client.query(
      `SELECT finnor_os.freeze_water_intake(5,'p8:test','{"p0P4Verified":true}'::jsonb)`,
    )).resolves.toMatchObject({ rows: [{ freeze_water_intake: 5 }] });

    const blockers = await client.query<{ category: string; blocking_count: string }>(
      "SELECT * FROM finnor_os.water_retirement_blockers()",
    );
    expect(blockers.rows.find((row) => row.category === "water_domain_action")?.blocking_count).toBe("1");
    const operationalCensusBefore = await readWaterOperationalCensus(client, { tenantIds: [waterTenantId] });
    expect(operationalCensusBefore).toMatchObject({
      tenantIds: [waterTenantId],
      byStatus: { domainActions: { pending: 1 } },
      live: { activeDomainActions: 1 },
      legacyCanonical: { verticals: { private_equity: true, water: true } },
    });
    await expect(client.query(
      `SELECT finnor_os.activate_private_equity_product_authority(5,'p8:test','{"safetyCensusZero":true}'::jsonb)`,
    )).rejects.toThrow(/water_domain_action=1/i);

    const drain = await drainAuditedWaterFixtures(client, {
      actor: "p8:test",
      authorizationRef: "test:p8-cutover",
      releaseSha,
      tenantIds: [waterTenantId],
    });
    expect(drain).toMatchObject({
      actions: { terminalized: 1, rejected: 1, failed: 0, audit_rows: 1 },
      effects: 0,
      objectives: 0,
      jobs: 0,
      works: { cancelled: 0, audit_rows: 0 },
    });
    const zeroBlockers = await client.query<{ category: string; blocking_count: string }>(
      "SELECT * FROM finnor_os.water_retirement_blockers()",
    );
    expect(zeroBlockers.rows.every((row) => Number(row.blocking_count) === 0)).toBe(true);
    const operationalCensusAfterDrain = await readWaterOperationalCensus(client, { tenantIds: [waterTenantId] });
    expect(operationalCensusAfterDrain.live.activeDomainActions).toBe(0);

    await expect(client.query(
      `SELECT finnor_os.activate_private_equity_product_authority(5,'p8:test','{"safetyCensusZero":true}'::jsonb)`,
    )).resolves.toMatchObject({ rows: [{ activate_private_equity_product_authority: 6 }] });
    await expect(client.query(
      "SELECT epoch,state,active_product_vertical FROM finnor_os.product_runtime_authority WHERE authority_key='product'",
    )).resolves.toMatchObject({ rows: [{ epoch: 6, state: "water_retired", active_product_vertical: "private_equity" }] });
    await expect(client.query(
      "SELECT id,status FROM finnor_os.domain_actions WHERE id=$1",
      [waterActionId],
    )).resolves.toMatchObject({ rows: [{ id: waterActionId, status: "rejected" }] });
    const operationalCensusAfter = await readWaterOperationalCensus(client, { tenantIds: [waterTenantId] });
    expect(operationalCensusAfter).toMatchObject({
      byStatus: { domainActions: { rejected: 1 } },
      live: { activeDomainActions: 0 },
      legacyCanonical: { verticals: { private_equity: true, water: false } },
    });

    const privileges = await client.query<{ app_freeze: boolean; app_activate: boolean }>(
      `SELECT
         has_function_privilege('finnor_app','finnor_os.freeze_water_intake(integer,text,jsonb)','EXECUTE') app_freeze,
         has_function_privilege('finnor_app','finnor_os.activate_private_equity_product_authority(integer,text,jsonb)','EXECUTE') app_activate`,
    );
    expect(privileges.rows[0]).toEqual({ app_freeze: false, app_activate: false });
  });
});
