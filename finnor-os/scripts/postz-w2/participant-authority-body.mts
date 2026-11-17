import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { closePool, withTenantTransaction } from "@finnor/db";
import { canExerciseWorkforceAuthorityTx, evaluateAuthority } from "@finnor/authority";
import { migrate } from "../../packages/db/migrate";
import { orderMigrationNames } from "../../packages/db/migration-order";
import { assertParticipantBodyOutput } from "./participant-authority-supervisor.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output" && args[1]!.startsWith("/"), "NEW_ABSOLUTE_OUTPUT_REQUIRED");
const output = args[1]!;
const requireClaim = () => assertParticipantBodyOutput(output, fileURLToPath(import.meta.url));
requireClaim();
const started = Date.now(), disk = statfsSync(root, { bigint: true });
assert(disk.bavail * disk.bsize >= 2n * 1024n ** 3n, "ORIGINAL_DISK_FLOOR");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const migrationsDir = join(root, "finnor-os/packages/db/migrations");
const migrationHashes = await Promise.all(orderMigrationNames((await readdir(migrationsDir)).filter(name => name.endsWith(".sql")))
  .map(async name => ({ name, sha256: sha(await readFile(join(migrationsDir, name))) })));
const cases: Array<{ id: string; status: string; expected: unknown; observed?: unknown; failure?: unknown }> = [];
const report: Record<string, unknown> = {
  schema: "finnor.postz.w2.participant-authority-e2e.v1", status: "RUNNING",
  qualification: "CONTROLLED_ACTUAL_DATABASE_AND_AUTHORITY_NOT_SIGNED_HTTP_OR_HUMAN",
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDiffSha256: sha(execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: root })),
  driverSha256: sha(await readFile(fileURLToPath(import.meta.url))), migrationHashes, cases,
  limits: { bodySeconds: 180, statementSeconds: 10, closerSeconds: 10, databaseInstances: 1 },
  rerun: `cd ${root}/finnor-os && node --import=tsx scripts/postz-w2/run-participant-authority-e2e.mts --output /absolute/new/output`,
};
const save = () => {
  requireClaim();
  return writeFile(join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
};
const check = async (id: string, expected: unknown, run: () => Promise<unknown>) => {
  assert(Date.now() - started < 180000, "ORIGINAL_BODY_WALL_LIMIT");
  try {
    const observed = await run();
    cases.push({ id, status: "PASS", expected, observed });
  } catch (error) {
    const failure = error as Error & { code?: string };
    cases.push({ id, status: "FAIL", expected, failure: { name: failure.name, code: failure.code ?? null, message: failure.message } });
  }
  await save();
};
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address(); assert(address && typeof address !== "string");
    server.close(() => resolve(address.port));
  });
});
const password = randomBytes(32).toString("hex"), appPassword = randomBytes(32).toString("hex");
const cluster = new EmbeddedPostgres({ databaseDir: join(output, "owned-postgres"), user: "w2_identity_fixture",
  password, port, persistent: false, postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=",
    "-c", "statement_timeout=10000"], onLog: () => {} });
let admin: pg.Client | undefined, startedDatabase = false;
try {
  process.env.NODE_ENV = "test"; process.env.AUTH_DEV_BYPASS = "0";
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  await save(); await cluster.initialise(); await cluster.start(); startedDatabase = true;
  await cluster.createDatabase("w2_identity");
  const url = (user: string, secret: string) => `postgres://${user}:${secret}@127.0.0.1:${port}/w2_identity`;
  report.appliedMigrations = await migrate(url("w2_identity_fixture", password));
  admin = new pg.Client({ connectionString: url("w2_identity_fixture", password), connectionTimeoutMillis: 5000, query_timeout: 10000 });
  await admin.connect();
  await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD " + admin.escapeLiteral(appPassword));
  process.env.DATABASE_URL = url("finnor_app", appPassword); await closePool();
  const tenant = randomUUID(), otherTenant = randomUUID(), participant = randomUUID();
  for (const id of [tenant, otherTenant])
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Controlled W2 identity boundary')", [id, randomUUID()]);
  const insert = (id: string, role: string, tenantId = tenant) => admin!.query(
    "INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,$4,'active')",
    [id, tenantId, id + "@test.invalid", role]);
  const assignments = async (id: string) => (await admin!.query(
    `SELECT a.id,a.active,r.legacy_role,r.key FROM finnor_os.employee_role_assignments a
     JOIN finnor_os.employee_roles r ON r.id=a.role_id AND r.tenant_id=a.tenant_id
     WHERE a.tenant_id=$1 AND a.employee_id=$2 ORDER BY r.key`, [tenant, id])).rows;
  report.inputs = { tenant, otherTenant, participant, controlled: true, realPerson: false };
  await check("fresh-participant-without-inherited-role-or-grant", "Inserted, zero assignments and no general authority", async () => {
    await insert(participant, "participant");
    assert.deepEqual(await assignments(participant), []);
    const automatic = (await admin!.query(`SELECT
      (SELECT count(*)::int FROM finnor_os.employee_roles WHERE tenant_id=$1) roles,
      (SELECT count(*)::int FROM finnor_os.role_authority_grants WHERE tenant_id=$1) grants`, [tenant])).rows[0];
    assert.deepEqual(automatic, { roles: 0, grants: 0 });
    const ctx = { tenantId: tenant, userId: participant, employeeId: participant, role: "participant" as const };
    const request = { operation: "query" as const, capability: "query:work", resource: { type: "work" }, risk: "low" as const };
    const decision = await evaluateAuthority(ctx, request);
    assert.equal(decision.outcome, "denied");
    const scoped = await withTenantTransaction(tenant, { userId: participant },
      (_db, client) => canExerciseWorkforceAuthorityTx(ctx, request, client));
    assert.equal(scoped, false);
    return { participant, assignments: [], automatic, generic: decision.outcome, scopedWorkforceAllowed: scoped };
  });
  for (const role of ["owner", "dispatcher", "technician"]) {
    await check("legacy-demotion-and-restoration-" + role, "Only the legacy assignment deactivates, restoration reuses its identity", async () => {
      const id = randomUUID(), explicitRole = randomUUID();
      await insert(id, role);
      const original = (await assignments(id)).find(row => row.legacy_role === role);
      assert(original?.active);
      await admin!.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Explicit existing role')",
        [explicitRole, tenant, "explicit-" + id]);
      await admin!.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,effect,max_risk)
        VALUES($1,$2,'query:work','allow','low')`, [tenant, explicitRole]);
      await admin!.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id)
        VALUES($1,$2,$3)`, [tenant, id, explicitRole]);
      const beforeRevision = (await admin!.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenant])).rows[0].revision;
      await admin!.query("UPDATE finnor_os.users SET role='participant' WHERE id=$1 AND tenant_id=$2", [id, tenant]);
      const demoted = await assignments(id);
      assert.equal(demoted.find(row => row.id === original.id)?.active, false);
      assert.equal(demoted.find(row => row.legacy_role === null)?.active, true);
      const afterRevision = (await admin!.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenant])).rows[0].revision;
      assert(afterRevision > beforeRevision);
      const ctx = { tenantId: tenant, userId: id, employeeId: id, role: "participant" as const };
      const request = { operation: "query" as const, capability: "query:work", resource: { type: "work" }, risk: "low" as const };
      assert.equal((await evaluateAuthority(ctx, request)).outcome, "denied");
      assert.equal(await withTenantTransaction(tenant, { userId: id },
        (_db, client) => canExerciseWorkforceAuthorityTx(ctx, request, client)), true);
      await admin!.query("UPDATE finnor_os.users SET role=$2 WHERE id=$1 AND tenant_id=$3", [id, role, tenant]);
      const restored = await assignments(id);
      assert.equal(restored.filter(row => row.legacy_role !== null && row.active).length, 1);
      assert.equal(restored.find(row => row.id === original.id)?.active, true);
      return { id, originalAssignment: original.id, demoted, restored, beforeRevision, afterRevision,
        generalAuthorityDenied: true, explicitWorkforceGrantPreserved: true };
    });
  }
  const local = randomUUID(), foreign = randomUUID();
  await insert(local, "owner"); await insert(foreign, "owner", otherTenant);
  const localRole = (await admin.query("SELECT id FROM finnor_os.employee_roles WHERE tenant_id=$1 AND key='owner'", [tenant])).rows[0].id;
  const foreignRole = (await admin.query("SELECT id FROM finnor_os.employee_roles WHERE tenant_id=$1 AND key='owner'", [otherTenant])).rows[0].id;
  for (const [id, employee, roleId, expected] of [
    ["foreign-role-still-refused", local, foreignRole, "employee authority role crosses tenant boundary"],
    ["foreign-employee-still-refused", foreign, localRole, "employee authority assignment crosses tenant boundary"],
  ]) await check(id!, expected, async () => {
    await assert.rejects(admin!.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id)
      VALUES($1,$2,$3)`, [tenant, employee, roleId]), (error: any) => error.code === "P0001" && error.message === expected);
    return { refusedByUnchangedTenantGuard: true };
  });
  await check("owner-authority-and-migration-replay", "Owner remains allowed, no migration is reapplied", async () => {
    const ctx = { tenantId: tenant, userId: local, employeeId: local, role: "owner" as const };
    const decision = await evaluateAuthority(ctx, { operation: "query", capability: "query:work", resource: { type: "work" }, risk: "low" });
    assert.equal(decision.outcome, "allowed");
    assert.deepEqual(await migrate(url("w2_identity_fixture", password)), []);
    return { owner: decision.outcome, reappliedMigrations: 0 };
  });
  report.status = cases.some(row => row.status === "FAIL") ? "FAIL" : "PASS";
} catch (error) {
  const failure = error as Error & { code?: string };
  report.status = "FAIL"; report.failure = { name: failure.name, code: failure.code ?? null, message: failure.message };
} finally {
  const cleanup: Array<{ name: string; status: string; error?: string }> = [];
  for (const [name, close] of [
    ["application-pool", () => closePool()],
    ["admin-connection", async () => { await admin?.end(); }],
    ["owned-postgres", async () => { if (startedDatabase) { requireClaim(); await cluster.stop(); } }],
  ] as const) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("OWNED_CLOSER_TIMEOUT")), 10000); })]);
      cleanup.push({ name, status: "PASS" });
    } catch (error) { report.status = "FAIL"; cleanup.push({ name, status: "FAIL", error: (error as Error).name }); }
    finally { clearTimeout(timer); }
  }
  report.cleanup = cleanup; report.elapsedMs = Date.now() - started;
  if (Date.now() - started >= 180000) {
    report.status = "FAIL"; report.deadlineFailure = "ORIGINAL_BODY_WALL_LIMIT";
  }
  await save();
}
console.log(JSON.stringify({ status: report.status, cases: cases.length, failures: cases.filter(row => row.status === "FAIL"),
  artifact: join(output, "receipt.json") }));
process.exit(report.status === "PASS" ? 0 : 1);
