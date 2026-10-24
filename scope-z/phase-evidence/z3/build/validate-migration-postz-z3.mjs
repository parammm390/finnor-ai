// Z3 migration DDL validation against a disposable embedded PostgreSQL
// (deleted on exit). Complements the supervisor's validate-migration-0199.mjs,
// whose harness hit a node-pg multi-statement prepared-statement limit after
// the payload itself applied cleanly. This runner splits the seed into single
// statements, adds finnor_app-role DML (proving the REVOKE on the trigger
// function does not block legitimate role DML under RLS), and checks the
// REVOKE itself. Mirrors ONLY the objects the payload references, with
// definitions copied from their defining migrations (request_tenant_id:
// 0000_init; s5_immutable_record: 0150; compute_job_type_policies: 0138).
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire("/home/factory-user/repos/finnor-z3/finnor-os/package.json");
const { default: EmbeddedPostgres } = require("embedded-postgres");
const { Client } = require("pg");

const REPO = "/home/factory-user/repos/finnor-z3";
const PAYLOAD = join(REPO, "scope-z/phase-evidence/z3/integration-patches/postz_z3_viability.sql");
const OUT = join(REPO, "scope-z/phase-evidence/z3/runs/04-migration-ddl");
const EXPECTED_SHA = "9f4234029d0c01aea276f88a9c909e49d984dc5ab8227f12cd392c67e189b265";
const sql = readFileSync(PAYLOAD, "utf8");
const sha256 = createHash("sha256").update(sql).digest("hex");

const SHELL = [
  "CREATE ROLE finnor_app NOLOGIN;",
  "CREATE SCHEMA finnor_os;",
  "CREATE OR REPLACE FUNCTION finnor_os.request_tenant_id() RETURNS uuid",
  "LANGUAGE sql STABLE AS $$",
  "  SELECT COALESCE(",
  "    NULLIF(current_setting('app.tenant_id', true), '')::uuid,",
  "    NULLIF(((current_setting('request.jwt.claims', true))::jsonb ->> 'tenant_id'), '')::uuid",
  "  )",
  "$$;",
  "CREATE FUNCTION finnor_os.s5_immutable_record() RETURNS trigger LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$",
  "BEGIN RAISE EXCEPTION 'S5 original revisions/history are append-only'; END $$;",
  "CREATE TABLE finnor_os.users(",
  "  tenant_id uuid NOT NULL, id uuid NOT NULL, role text NOT NULL DEFAULT 'owner',",
  "  status text NOT NULL DEFAULT 'active', PRIMARY KEY(tenant_id,id));",
  "CREATE TABLE finnor_os.works(",
  "  tenant_id uuid NOT NULL, id uuid NOT NULL, created_by uuid NOT NULL,",
  "  PRIMARY KEY(tenant_id,id));",
  "CREATE TABLE finnor_os.work_inputs(",
  "  tenant_id uuid NOT NULL, id uuid NOT NULL, work_id uuid NOT NULL,",
  "  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id));",
  "CREATE TABLE finnor_os.compute_job_type_policies (",
  "  job_type text PRIMARY KEY,",
  "  default_class text NOT NULL CHECK (default_class IN ('REALTIME','INTERACTIVE','BACKGROUND','HEAVY')),",
  "  allowed_classes text[] NOT NULL,",
  "  classification_rule text NOT NULL CHECK (classification_rule IN ('fixed','trusted_lane')),",
  "  tenant_scope text NOT NULL CHECK (tenant_scope IN ('tenant','global')),",
  "  obligation_kind text NOT NULL CHECK (obligation_kind IN ('required','coalescible')),",
  "  policy_revision integer NOT NULL CHECK (policy_revision > 0),",
  "  rationale text NOT NULL,",
  "  active boolean NOT NULL DEFAULT true,",
  "  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),",
  "  CHECK (cardinality(allowed_classes) > 0),",
  "  CHECK (default_class = ANY(allowed_classes)),",
  "  CHECK (allowed_classes <@ ARRAY['REALTIME','INTERACTIVE','BACKGROUND','HEAVY']::text[])",
  ");",
  "GRANT USAGE ON SCHEMA finnor_os TO finnor_app;",
].join("\n");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const U1 = "33333333-3333-4333-8333-333333333333";
const U2 = "99999999-9999-4999-8999-999999999999";
const W1 = "44444444-4444-4444-8444-444444444444";
const I1 = "55555555-5555-4555-8555-555555555555";
const S1 = "66666666-6666-4666-8666-666666666666";
const H = (c) => c.repeat(64);

const results = [];
const failures = [];
const run = (name, passed, detail) => {
  results.push({ name, passed, detail: detail ? String(detail).slice(0, 120) : undefined });
  console.log((passed ? "PASS " : "FAIL ") + name + (passed ? "" : " :: " + detail));
  if (!passed) failures.push(name);
};

async function main() {
  if (sha256 !== EXPECTED_SHA) {
    run("payload digest pinned", false, sha256);
    return finish(1);
  }
  run("payload digest pinned", true);
  const dir = mkdtempSync(join(tmpdir(), "z3-postz-"));
  const pgdb = new EmbeddedPostgres({ databaseDir: dir, port: 55441, user: "postgres",
    password: "postgres", persistent: false, onLog: () => {}, onError: () => {} });
  let client;
  try {
    await pgdb.initialise();
    await pgdb.start();
    client = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:55441/postgres" });
    await client.connect();
    await client.query(SHELL);
    run("shell", true);
    try { await client.query(sql); run("payload applies", true); }
    catch (e) { run("payload applies", false, e.message); throw e; }

    // Seed (single statements; node-pg rejects multi-statement with params).
    await client.query("INSERT INTO finnor_os.users(tenant_id,id) VALUES($1,$2)", [T1, U1]);
    await client.query("INSERT INTO finnor_os.users(tenant_id,id) VALUES($1,$2)", [T2, U2]);
    await client.query("INSERT INTO finnor_os.works(tenant_id,id,created_by) VALUES($1,$2,$3)", [T1, W1, U1]);
    await client.query("INSERT INTO finnor_os.work_inputs(tenant_id,id,work_id) VALUES($1,$2,$3)", [T1, I1, W1]);
    await client.query(
      "INSERT INTO finnor_os.z3_viability_sessions(" +
      " id,tenant_id,principal_id,work_id,work_input_id,original_parent_id," +
      " arena_digest,binding_digest,arena,binding,obligation_refs,deadline_at)" +
      " VALUES($1,$2,$3,$4,$5,'parent',$6,$7,'{}','{}','[]','2030-01-01')",
      [S1, T1, U1, W1, I1, H("a"), H("b")]);
    run("seed insert", true);

    const expectRaise = async (name, statement, params) => {
      try { await client.query(statement, params); run(name, false, "no exception"); }
      catch (e) { run(name, true, String(e.message).slice(0, 60)); }
    };

    await client.query(
      "UPDATE finnor_os.z3_viability_sessions" +
      " SET status='PRODUCING', active_claim_token='tok-a', active_claim_fence=1, generation=2" +
      " WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    run("progress update (status/fence/generation)", true);
    await client.query(
      "UPDATE finnor_os.z3_viability_sessions SET candidate='{\"k\":1}', candidate_digest=$3" +
      " WHERE tenant_id=$1 AND id=$2", [T1, S1, H("c")]);
    run("candidate first publish", true);
    await expectRaise("candidate immutable",
      "UPDATE finnor_os.z3_viability_sessions SET candidate='{\"k\":2}' WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    await expectRaise("arena preimage immutable",
      "UPDATE finnor_os.z3_viability_sessions SET arena='{\"x\":1}' WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    await client.query(
      "UPDATE finnor_os.z3_viability_sessions SET active_claim_fence=2 WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    run("fence advance 1->2", true);
    await expectRaise("fence retreat 2->1 refused",
      "UPDATE finnor_os.z3_viability_sessions SET active_claim_fence=1 WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    await expectRaise("generation cannot reset",
      "UPDATE finnor_os.z3_viability_sessions SET generation=1 WHERE tenant_id=$1 AND id=$2", [T1, S1]);

    // finnor_app role DML under RLS (pre-terminal): proves grants, policy WITH
    // CHECK, and that REVOKE ALL ON the trigger function does not block
    // trigger-driven DML for the application role.
    await client.query("GRANT SELECT ON finnor_os.users TO finnor_app");
    await client.query("SET ROLE finnor_app");
    await client.query("SELECT set_config('app.tenant_id',$1,false), set_config('app.user_id',$2,false)", [T1, U1]);
    await client.query(
      "INSERT INTO finnor_os.z3_viability_requests(tenant_id,principal_id,idempotency_key,request_digest,session_id)" +
      " VALUES($1,$2,'k',$3,$4)", [T1, U1, H("d"), S1]);
    await client.query(
      "INSERT INTO finnor_os.z3_viability_events(tenant_id,principal_id,session_id,kind,body)" +
      " VALUES($1,$2,$3,'Z3_TEST','{}')", [T1, U1, S1]);
    await client.query(
      "INSERT INTO finnor_os.z3_viability_artifacts(tenant_id,principal_id,artifact_id,kind,digest,body)" +
      " VALUES($1,$2,'art','candidate',$3,'{}')", [T1, U1, H("e")]);
    run("finnor_app inserts (requests/events/artifacts)", true);
    await client.query(
      "UPDATE finnor_os.z3_viability_sessions SET status='CHECKING' WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    run("finnor_app update as in-scope principal", true);
    await expectRaise("finnor_app candidate rewrite refused",
      "UPDATE finnor_os.z3_viability_sessions SET candidate='{\"k\":3}' WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    const visible = await client.query("SELECT count(*)::int AS n FROM finnor_os.z3_viability_sessions");
    run("RLS same-tenant visible", visible.rows[0].n === 1, JSON.stringify(visible.rows));
    await client.query("SELECT set_config('app.tenant_id',$1,false), set_config('app.user_id',$2,false)", [T2, U2]);
    const hidden = await client.query("SELECT count(*)::int AS n FROM finnor_os.z3_viability_sessions");
    run("RLS cross-tenant hidden", hidden.rows[0].n === 0, JSON.stringify(hidden.rows));
    try {
      await client.query(
        "INSERT INTO finnor_os.z3_viability_events(tenant_id,principal_id,session_id,kind,body)" +
        " VALUES($1,$2,$3,'Z3_TEST','{}')", [T2, U2, S1]);
      run("RLS cross-tenant insert refused", false, "insert succeeded");
    } catch { run("RLS cross-tenant insert refused", true); }
    await client.query("RESET ROLE");

    await client.query("UPDATE finnor_os.z3_viability_sessions SET status='VIABLE' WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    run("terminal publish", true);
    await expectRaise("terminal status irreversible",
      "UPDATE finnor_os.z3_viability_sessions SET status='FAILED' WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    await expectRaise("session delete refused",
      "DELETE FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    await client.query("SET ROLE finnor_app");
    await client.query("SELECT set_config('app.tenant_id',$1,false), set_config('app.user_id',$2,false)", [T1, U1]);
    await expectRaise("finnor_app terminal mutation refused",
      "UPDATE finnor_os.z3_viability_sessions SET status='UNKNOWN' WHERE tenant_id=$1 AND id=$2", [T1, S1]);
    await client.query("RESET ROLE");

    // Append-only auxiliaries via s5_immutable_record (superuser; trigger fires regardless).
    await expectRaise("requests append-only",
      "DELETE FROM finnor_os.z3_viability_requests WHERE tenant_id=$1 AND principal_id=$2", [T1, U1]);
    await expectRaise("events append-only",
      "DELETE FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND session_id=$2", [T1, S1]);
    await expectRaise("artifacts append-only",
      "UPDATE finnor_os.z3_viability_artifacts SET body='{\"x\":1}' WHERE tenant_id=$1 AND artifact_id='art'", [T1]);

    const policies = await client.query(
      "SELECT job_type,default_class,obligation_kind FROM finnor_os.compute_job_type_policies WHERE job_type LIKE 'run_z3_%' ORDER BY 1");
    run("compute_job_type_policies rows",
      policies.rowCount === 2 && policies.rows.every((r) => r.default_class === "INTERACTIVE" && r.obligation_kind === "required"),
      JSON.stringify(policies.rows));
    const revoke = await client.query(
      "SELECT coalesce(bool_or(privilege_type='EXECUTE'),false) AS p" +
      " FROM information_schema.routine_privileges" +
      " WHERE specific_schema='finnor_os' AND routine_name='z3_session_progress' AND grantee='PUBLIC'");
    run("trigger function REVOKE FROM PUBLIC", revoke.rows[0].p === false, JSON.stringify(revoke.rows));
  } catch (e) {
    if (!failures.length) run("harness", false, e.message);
  } finally {
    try { if (client) await client.end(); } catch {}
    try { await pgdb.stop(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  return finish(failures.length ? 1 : 0);
}

function finish(code) {
  mkdirSync(OUT, { recursive: true });
  const report = { schema: "finnor.z3.migration-ddl-validation.v1", payload: "postz_z3_viability.sql",
    sha256, engine: "embedded-postgres disposable (deleted on exit)", results, failures,
    status: failures.length ? "FAIL" : "PASS" };
  const target = join(OUT, "report.json");
  writeFileSync(target, JSON.stringify(report, null, 1) + "\n");
  console.log(JSON.stringify({ status: report.status, failures, sha256 }));
  process.exit(code);
}

await main();
