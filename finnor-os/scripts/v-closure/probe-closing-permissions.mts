/** Finite actual-role SQL diagnosis, not closing functional qualification. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";

process.umask(0o077);
const out = process.env.FINNOR_PERMISSION_EVIDENCE_DIR;
const expectComposition = process.argv.includes("--expect-custody-composition");
assert(out && out.startsWith("/"), "Fresh absolute evidence directory required");
await mkdir(out, { recursive: true });
const root = resolve(import.meta.dirname, "../../..");
const disk = await statfs(root);
assert(disk.bavail * disk.bsize >= 3 * 1024 ** 3);
const directory = await mkdtemp(join(tmpdir(), "finnor-closing-permission-"));
const server = createServer();
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert(address && typeof address !== "string");
const port = address.port;
await new Promise<void>(done => server.close(() => done()));
const password = randomBytes(24).toString("hex");
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "permission_admin", password, port,
  persistent: true, onLog: () => undefined });
const result: Record<string, unknown> = { startedAt: new Date().toISOString(), directory, port,
  qualification: "ACTUAL_RESTRICTED_ROLE_PERMISSION_DIAGNOSIS_ONLY" };
let admin: pg.Client | undefined, checker: pg.Client | undefined, running = false;
try {
  process.env.NODE_ENV = "test";
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  await postgres.initialise(); await postgres.start(); running = true;
  await postgres.createDatabase("permission_probe");
  const url = (role: string) => `postgres://${role}:${password}@127.0.0.1:${port}/permission_probe`;
  result.migrations = await migrate(url("permission_admin"));
  admin = new pg.Client({ connectionString: url("permission_admin") }); await admin.connect();
  await admin.query(`ALTER ROLE finnor_closing_checker LOGIN PASSWORD '${password}'`);
  checker = new pg.Client({ connectionString: url("finnor_closing_checker"), statement_timeout: 10000 });
  await checker.connect();
  const role = (await checker.query("SELECT current_user role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert(role.role === "finnor_closing_checker" && !role.rolsuper && !role.rolbypassrls);
  result.role = role;
  const tenantId = randomUUID();
  await checker.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
  result.helperExecute = (await checker.query("SELECT has_function_privilege(current_user,'finnor_os.primary_evidence_scope_allowed(text,text)','EXECUTE') allowed")).rows[0].allowed;
  const observations = [];
  for (const [label, sql, parameters] of [
    ["original-material-cut", "WITH material AS MATERIALIZED(SELECT finnor_os.pe_closing_cut($1,$2) body) SELECT body AS cut,encode(sha256(convert_to(body::text,'UTF8')),'hex') AS digest,finnor_os.pe_closing_execution_basis_from_cut(body,NULL) AS basis FROM material", [tenantId, randomUUID()]],
    ["ordinary-evidence-read", "SELECT id FROM finnor_os.evidence_sources LIMIT 1", []],
  ] as const) {
    try {
      const response = await checker.query(sql, [...parameters]);
      observations.push({ label, status: "RETURNED", rows: response.rowCount });
    } catch (error) {
      const e = error as Error & { code?: string };
      const match = /^permission denied for (function|table|schema|relation) ([a-zA-Z_][a-zA-Z0-9_]{0,127})$/.exec(e.message);
      observations.push({ label, status: "REFUSED", sqlCode: /^[0-9A-Z]{5}$/.test(e.code ?? "") ? e.code : undefined,
        objectKind: match?.[1], object: match?.[2] });
    }
  }
  result.observations = observations;
  if (expectComposition) {
    assert(observations.every(row => row.status === "RETURNED"), "Original cut and ordinary evidence queries must execute");
    assert.deepEqual(await migrate(url("permission_admin")), [], "Filename migration replay must be idempotent");
    await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Custody composition probe')", [tenantId]);
    const otherTenantId = randomUUID();
    await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Other custody tenant')", [otherTenantId]);
    const ordinaryId = randomUUID();
    for (const [sourceId, tenant, type] of [
      [ordinaryId, tenantId, "closing_observation"],
      [randomUUID(), tenantId, "primary_record"],
      [randomUUID(), tenantId, "bilateral_record"],
      [randomUUID(), otherTenantId, "closing_observation"],
    ]) {
      await admin.query("INSERT INTO finnor_os.evidence_sources(id,tenant_id,source_key,source_type,title) VALUES($1,$2,$3,$4,'Controlled custody fixture')",
        [sourceId, tenant, `custody-probe:${sourceId}`, type]);
      await admin.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,1,encode(sha256(convert_to('controlled-fixture','UTF8')),'hex'),'controlled-fixture',$3::jsonb,now())",
        [sourceId, tenant, JSON.stringify({ requestId: randomUUID() })]);
    }
    const composition = [];
    for (const name of ["finnor_closing_checker", "finnor_closing_broker"]) {
      await admin.query(`ALTER ROLE ${name} LOGIN PASSWORD '${password}'`);
      const reader = new pg.Client({ connectionString: url(name), statement_timeout: 10000 });
      await reader.connect();
      try {
        const identity = (await reader.query("SELECT current_user role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
        assert(identity.role === name && !identity.rolsuper && !identity.rolbypassrls);
        await reader.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        const privileges = (await reader.query(`SELECT
          has_function_privilege(current_user,'finnor_os.bilateral_evidence_scope_allowed(jsonb)','EXECUTE') bilateral_execute,
          has_function_privilege(current_user,'finnor_os.primary_evidence_scope_allowed(text,text)','EXECUTE') primary_execute,
          has_function_privilege(current_user,'finnor_os.primary_evidence_profile_ref_allowed(jsonb)','EXECUTE') primary_profile_execute,
          has_table_privilege(current_user,'finnor_os.v1_programmes','SELECT') v1_select,
          has_table_privilege(current_user,'finnor_os.v2_programmes','SELECT') v2_select`)).rows[0];
        assert(privileges.bilateral_execute && privileges.primary_execute && privileges.primary_profile_execute
          && !privileges.v1_select && !privileges.v2_select,
          "Only custody predicate execution, never raw programme SELECT, is allowed");
        const sources = (await reader.query("SELECT id FROM finnor_os.evidence_sources ORDER BY id")).rows;
        const versions = (await reader.query("SELECT source_id FROM finnor_os.evidence_source_versions ORDER BY source_id")).rows;
        assert.deepEqual(sources.map(row => row.id), [ordinaryId], "Private and foreign sources must remain hidden");
        assert.deepEqual(versions.map(row => row.source_id), [ordinaryId], "Private and foreign versions must remain hidden");
        const predicates = "SELECT finnor_os.bilateral_evidence_scope_allowed('{}'::jsonb) bilateral,finnor_os.primary_evidence_scope_allowed('probe',NULL) primary,finnor_os.primary_evidence_profile_ref_allowed('{}'::jsonb) profile";
        const missing = (await reader.query(predicates)).rows[0];
        assert(!missing.bilateral && !missing.primary && !missing.profile);
        await reader.query("SELECT set_config('app.user_id',$1,false),set_config('app.bilateral_programme_id',$2,false),set_config('app.primary_programme_id',$2,false),set_config('app.primary_data_purpose','probe',false)", [randomUUID(), randomUUID()]);
        const forged = (await reader.query(predicates)).rows[0];
        assert(!forged.bilateral && !forged.primary && !forged.profile, "Forged session context cannot acquire private custody");
        composition.push({ role: name, privileges, ordinarySourceCount: sources.length, ordinaryVersionCount: versions.length,
          missingContextRefused: true, forgedContextRefused: true, privateAndForeignRowsHidden: true });
      } finally { await reader.end(); }
    }
    result.composition = composition;
    result.status = "PASS_ASSIGNED_CUSTODY_COMPOSITION";
  }
} finally {
  await checker?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  if (running) await postgres.stop();
  result.finishedAt = new Date().toISOString();
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify(result));
process.exit(0);
