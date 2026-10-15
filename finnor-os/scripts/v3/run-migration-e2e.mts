/** Registered V3 migration boundary, on an owned disposable PostgreSQL only.
 * This is not authenticated programme, installed-image or domain qualification. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";

process.umask(0o077);
const out = process.env.FINNOR_V3_EVIDENCE_DIR;
if (!out?.startsWith("/")) throw Error("Absolute fresh FINNOR_V3_EVIDENCE_DIR required");
await mkdir(out, { recursive: true });
const root = resolve(import.meta.dirname, "../.."), migrationDir = join(root, "packages/db/migrations");
const files = await Promise.all((await readdir(migrationDir)).filter(n => n.endsWith(".sql")).sort()
  .map(async name => ({ name, sql: await readFile(join(migrationDir, name), "utf8") })));
assert(!files.some(f => f.name.startsWith("0172")), "Unpublished peer migration must not become an implicit dependency");
const hashes = files.map(f => ({ name: f.name, sha256: createHash("sha256").update(f.sql).digest("hex") }));
const startedAt = new Date().toISOString(), directory = await mkdtemp(join(tmpdir(), "finnor-v3-migration-"));
const port = await new Promise<number>((yes, no) => {
  const server = createServer(); server.once("error", no);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return no(Error("Disposable port unavailable"));
    server.close(() => yes(address.port));
  });
});
const password = randomBytes(24).toString("base64url");
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor_v3",
  password, port, persistent: true, onLog: () => undefined });
const report: Record<string, unknown> = {
  schema: "finnor.v3.migration-e2e.v1", startedAt,
  classification: "DISPOSABLE_POSTGRESQL_ENGINEERING_NOT_CLOSING_QUALIFICATION",
  command: "FINNOR_V3_EVIDENCE_DIR=<absolute-fresh-dir> node --import=tsx scripts/v3/run-migration-e2e.mts",
  database: { directory, provider: "embedded-postgres", authority: "DISPOSABLE_LOCAL_ONLY" },
  node: process.version, migrations: hashes, costsUsd: null, passed: false,
};
await writeFile(join(out, "freeze.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
let client: pg.Client | undefined, running = false;
try {
  process.env.NODE_ENV = "test";
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  await postgres.initialise(); await postgres.start(); running = true;
  await postgres.createDatabase("v3_migration");
  const url = `postgres://finnor_v3:${encodeURIComponent(password)}@127.0.0.1:${port}/v3_migration`;
  const baseline = files.filter(f => f.name < "0173");
  report.baselineApplied = await migrate(url, baseline);
  client = new pg.Client({ connectionString: url }); await client.connect();
  report.baselineHead = (await client.query("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1")).rows[0].name;
  assert.equal(report.baselineHead, "0171_runtime_database_role_isolation.sql");
  report.upgradeApplied = await migrate(url, files);
  report.idempotentReplay = await migrate(url, files);
  assert.deepEqual(report.idempotentReplay, []);
  const privileges = (await client.query(`SELECT
    has_table_privilege('finnor_app','finnor_os.pe_closing_checks','INSERT') app_can_certify,
    has_table_privilege('finnor_app','finnor_os.pe_closed_transaction_certificates','INSERT') app_can_issue_certificate,
    has_table_privilege('finnor_closing_checker','finnor_os.pe_closing_checks','INSERT') checker_can_certify,
    has_table_privilege('finnor_closing_broker','finnor_os.role_authority_grants','UPDATE') broker_can_grant_authority,
    has_column_privilege('finnor_closing_broker','finnor_os.provider_invocations','closing_provider_egress_at','UPDATE') broker_can_mark_egress,
    has_function_privilege('finnor_closing_broker','finnor_os.pe_closing_execution_basis_from_cut(jsonb,uuid)','EXECUTE') broker_can_hash_native_basis,
    pg_has_role('finnor_app','finnor_closing_checker','MEMBER') app_is_checker,
    pg_has_role('finnor_app','finnor_closing_broker','MEMBER') app_is_broker`)).rows[0];
  report.privileges = privileges;
  assert.deepEqual(privileges, { app_can_certify: false, app_can_issue_certificate: false,
    checker_can_certify: true, broker_can_grant_authority: false, broker_can_mark_egress: true, broker_can_hash_native_basis: true,
    app_is_checker: false, app_is_broker: false });
  const denials: unknown[] = [];
  for (const table of ["pe_closing_checks", "pe_closed_transaction_certificates"]) {
    await client.query("BEGIN"); await client.query("SET LOCAL ROLE finnor_app");
    try { await client.query(`INSERT INTO finnor_os.${table} DEFAULT VALUES`); assert.fail("App certification bypass succeeded"); }
    catch (error) {
      assert.equal((error as { code?: string }).code, "42501");
      denials.push({ table, sqlstate: "42501", boundary: "ACTUAL_APP_INSERT_PRIVILEGE_DENIED" });
    } finally { await client.query("ROLLBACK"); }
  }
  report.directSqlDenials = denials;
  const guardTenant = randomUUID();
  await client.query("BEGIN"); await client.query("SET LOCAL ROLE finnor_app");
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [guardTenant]);
  try {
    await client.query(`INSERT INTO finnor_os.pe_closing_programmes(
      tenant_id,transaction_id,principal_id,work_id,work_input_id,work_input_digest,
      profile_id,profile_digest,accepted_terms_source_id,accepted_terms_version_id,approved_terms_revision,
      spec,spec_digest,graph,dependency_pins,authority_revision,intake_authority_decision_id,
      original_deadline_at,status,idempotency_key,intake_digest)
      VALUES($1,$2,$2,$2,$2,$3,'guard-fixture',$3,$2,$2,'guard-fixture','{}',$3,'{}','[]',1,$2,
        clock_timestamp()+interval '1 hour','CLOSED','guard-fixture',$3)`,
      [guardTenant, randomUUID(), "0".repeat(64)]);
    assert.fail("Unsafe initial CLOSED state succeeded");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "P0001");
    assert.equal((error as Error).message, "Initial closing programme cannot assert independent check or publication");
    denials.push({ table: "pe_closing_programmes", sqlstate: "P0001",
      boundary: "ACTUAL_APP_INITIAL_CLOSED_GUARD_BEFORE_REFERENTIAL_CHECKS",
      referenceFixture: "DANGLING_REFERENCE_NEGATIVE_NOT_AUTHENTICATED_PROGRAMME_PROOF" });
  } finally { await client.query("ROLLBACK"); }
  await client.query("BEGIN"); await client.query("SET LOCAL ROLE finnor_app");
  try {
    await client.query("SELECT finnor_os.pe_v3_issue_closed_certificate($1,$2,$2,$2)", [guardTenant, randomUUID()]);
    assert.fail("Ordinary app could directly invoke certificate issuance");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "42501");
    denials.push({ function: "pe_v3_issue_closed_certificate", sqlstate: "42501",
      boundary: "DIRECT_ISSUER_EXECUTION_DENIED_CANONICAL_CLOSE_OWNER_ONLY" });
  } finally { await client.query("ROLLBACK"); }
  report.roles = (await client.query("SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_closing_checker','finnor_closing_broker') ORDER BY rolname")).rows;
  report.effectiveFunctions = (await client.query(`SELECT p.proname,pg_get_functiondef(p.oid) definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='finnor_os'
    AND p.proname IN('pe_evaluate_deal_close_eligibility','pe_closing_cut','pe_v3_fence_publication',
      'pe_v3_record_closed_certificate','pe_v3_issue_closed_certificate','pe_declare_deal_closed',
      's6_closing_egress_marker_guard','pe_v3_material_write_fence')
    ORDER BY p.proname`)).rows;
  assert.equal((report.effectiveFunctions as unknown[]).length, 8);
  report.head = (await client.query("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1")).rows[0].name;
  assert.equal(report.head, "0173_v3_autonomous_transaction_closure.sql");
  report.constraints = (await client.query(`SELECT conname,pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE conrelid='finnor_os.work_objective_loops'::regclass
    AND conname IN('work_objective_loops_max_steps_check','work_objective_loops_max_actions_check','work_objective_loops_max_queries_check')
    ORDER BY conname`)).rows;
  report.passed = true;
} catch (error) {
  report.failure = { message: error instanceof Error ? error.message : String(error),
    code: (error as { code?: string }).code ?? null };
  process.exitCode = 1;
} finally {
  await client?.end();
  if (running) await postgres.stop();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "migration-e2e.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, evidence: join(out, "migration-e2e.json"),
    ...(report.failure ? { failure: report.failure } : {}) }));
  // embedded-postgres hooks beforeExit with code 0. A passive exitCode is
  // overwritten by that hook, so exit only after shutdown and evidence flush.
  process.exit(report.passed ? 0 : 1);
}
