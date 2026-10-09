// Preregistered E2E: real PostgreSQL, independent roles, queue/global semantics,
// cross-tenant refusals and bounded pre-tenant phone routing. No provider claims.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { expect, it } from "vitest";
import { migrate } from "../../packages/db/migrate";
import { verifyRestrictedApplicationRole } from "../../packages/db/production-database-admission.mjs";

it("separates tenant application access from cross-tenant worker queue authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "finnor-runtime-role-isolation-"));
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(Error("No fixture port")); return; }
      server.close(() => resolve(address.port));
    });
  });
  const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "fixture", port, persistent: false });
  let owner: pg.Client | undefined;
  let app: pg.Client | undefined;
  let worker: pg.Client | undefined;
  const priorExtensions = process.env.FINNOR_TEST_MANAGED_EXTENSIONS;
  const observed: Record<string, unknown> = {};
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("finnor");
    const ownerUrl = `postgres://finnor:fixture@127.0.0.1:${port}/finnor`;
    process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
    await migrate(ownerUrl);
    owner = new pg.Client({ host: "127.0.0.1", port, user: "finnor", password: "fixture", database: "finnor" });
    await owner.connect();
    await owner.query("ALTER ROLE finnor_app LOGIN PASSWORD 'fixture'; ALTER ROLE finnor_worker LOGIN PASSWORD 'worker-fixture'");
    const tenantA = randomUUID(), tenantB = randomUUID();
    await owner.query("INSERT INTO finnor_os.tenants(id,name) VALUES ($1,'Isolation A'),($2,'Isolation B')", [tenantA, tenantB]);
    const jobA = randomUUID(), jobB = randomUUID(), globalJob = randomUUID();
    await owner.query(`INSERT INTO finnor_os.jobs(id,tenant_id,type,payload,retry_safety)
      VALUES ($1,$2,'process_instruction','{}','pure'),($3,$4,'process_instruction','{}','pure'),
      ($5,NULL,'release_probe','{}','pure')`, [jobA, tenantA, jobB, tenantB, globalJob]);
    await owner.query(`INSERT INTO finnor_os.tenant_phone_numbers(tenant_id,phone_number,vapi_phone_number_id,label)
      VALUES ($1,'+15555550191','role-isolation-provider-a','private label')`, [tenantA]);
    app = new pg.Client({ host: "127.0.0.1", port, user: "finnor_app", password: "fixture", database: "finnor" });
    worker = new pg.Client({ host: "127.0.0.1", port, user: "finnor_worker", password: "worker-fixture", database: "finnor" });
    await app.connect();
    await worker.connect();
    observed.application = await verifyRestrictedApplicationRole(app, { schema: "finnor_os" });
    observed.worker = await verifyRestrictedApplicationRole(worker, { schema: "finnor_os" }, "worker");
    expect((await app.query("SELECT id FROM finnor_os.jobs WHERE id=ANY($1::uuid[])", [[jobA,jobB,globalJob]])).rows).toHaveLength(0);
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
    expect((await app.query("SELECT id FROM finnor_os.jobs WHERE id=ANY($1::uuid[])", [[jobA,jobB,globalJob]])).rows.map(row => row.id)).toEqual([jobA]);
    await app.query("SAVEPOINT forged");
    await expect(app.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload) VALUES($1,'process_instruction','{}')", [tenantB])).rejects.toMatchObject({ code: "42501" });
    await app.query("ROLLBACK TO SAVEPOINT forged");
    expect((await app.query("UPDATE finnor_os.jobs SET priority=19 WHERE id=$1", [jobB])).rowCount).toBe(0);
    await app.query("ROLLBACK");
    await expect(app.query("SET ROLE finnor_worker")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("SELECT * FROM finnor_os.client_factory_runs")).rejects.toMatchObject({ code: "42501" });
    expect((await app.query("SELECT * FROM finnor_os.tenant_phone_numbers")).rows).toHaveLength(0);
    expect((await app.query("SELECT finnor_os.resolve_phone_routing_tenant($1,NULL) AS tenant", ["role-isolation-provider-a"])).rows[0].tenant).toBe(tenantA);
    expect((await app.query("SELECT finnor_os.resolve_phone_routing_tenant(NULL,$1) AS tenant", ["+15555550191"])).rows[0].tenant).toBe(tenantA);
    expect((await app.query("SELECT finnor_os.resolve_phone_routing_tenant(NULL,NULL) AS tenant")).rows[0].tenant).toBeNull();
    const queue = await worker.query("SELECT id FROM finnor_os.jobs WHERE id=ANY($1::uuid[]) ORDER BY id", [[jobA,jobB,globalJob]]);
    expect(queue.rows.map(row => row.id)).toEqual([jobA,jobB,globalJob].sort());
    expect((await worker.query("SELECT * FROM finnor_os.compute_tenant_claim_state WHERE tenant_id=ANY($1::uuid[]) OR tenant_key='__global__'", [[tenantA,tenantB]])).rows.length).toBeGreaterThanOrEqual(3);
    // Business data stays tenant-scoped even on the queue-authorized worker role.
    expect((await worker.query("SELECT * FROM finnor_os.tenant_phone_numbers")).rows).toHaveLength(0);
    await worker.query("BEGIN");
    await worker.query("SELECT set_config('finnor.compute_epoch','3',true)");
    const claimed = await worker.query("UPDATE finnor_os.jobs SET status='running',started_at=now(),lease_owner='role-proof' WHERE id=$1 RETURNING id", [jobA]);
    expect(claimed.rows[0].id).toBe(jobA);
    await worker.query(`INSERT INTO finnor_os.job_delivery_attempts(job_id,tenant_id,claim_token,claim_fence,worker_id,protocol_version,retry_safety)
      VALUES($1,$2,$3,1,'role-proof',1,'pure')`, [jobA,tenantA,randomUUID()]);
    await worker.query("ROLLBACK");
    observed.refusals = ["unscoped queue read", "cross-tenant read/write", "worker role escalation", "administrative ledger access", "unscoped phone rows"];
    observed.preserved = ["tenant queue inspection", "worker global/tenant queue visibility", "worker claim/attempt", "bounded phone routing"];
    const evidence = process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR ?? directory;
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence,"runtime-database-role-isolation.json"), JSON.stringify({
      schema: "finnor.runtime-database-role-isolation-proof.v1",
      inputs: { fixture: "disposable PostgreSQL", independentRoles: ["finnor_app","finnor_worker"], syntheticTenants: 2 },
      observed,
      rerun: "npm --prefix finnor-os test -- --run tests/integration/runtime-database-role-isolation.test.ts",
      providerDeploymentProof: false,
    },null,2)+"\n");
  } finally {
    if (priorExtensions === undefined) delete process.env.FINNOR_TEST_MANAGED_EXTENSIONS;
    else process.env.FINNOR_TEST_MANAGED_EXTENSIONS = priorExtensions;
    await app?.end();
    await worker?.end();
    await owner?.end();
    await postgres.stop().catch(() => undefined);
  }
}, 120_000);
