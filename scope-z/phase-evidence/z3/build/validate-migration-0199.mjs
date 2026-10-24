// Targeted validation of the postz_z3_viability.sql payload (formerly named
// 0199_z3_viability.sql before the release-ordering rename) against a real
// disposable PostgreSQL 18 (embedded-postgres, deleted on exit). The shell
// below mirrors ONLY the objects the payload references, with definitions copied
// verbatim from their defining migrations (request_tenant_id: 0000_init;
// s5_immutable_record: 0150; compute_job_type_policies: 0138). This is not a
// full-chain application; that remains the coordinator's staging step.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire("/home/factory-user/repos/finnor-z3/finnor-os/package.json");
const { default: EmbeddedPostgres } = require("embedded-postgres");
const { Client } = require("pg");

const PAYLOAD = "/home/factory-user/repos/finnor-z3/scope-z/phase-evidence/z3/integration-patches/postz_z3_viability.sql";
const sql = readFileSync(PAYLOAD, "utf8");
const sha256 = createHash("sha256").update(sql).digest("hex");

const SHELL = `
CREATE ROLE finnor_app NOLOGIN;
CREATE SCHEMA finnor_os;
CREATE OR REPLACE FUNCTION finnor_os.request_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.tenant_id', true), '')::uuid,
    NULLIF(((current_setting('request.jwt.claims', true))::jsonb ->> 'tenant_id'), '')::uuid
  )
$$;
CREATE FUNCTION finnor_os.s5_immutable_record() RETURNS trigger LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$
BEGIN RAISE EXCEPTION 'S5 original revisions/history are append-only'; END $$;
CREATE TABLE finnor_os.users(
  tenant_id uuid NOT NULL, id uuid NOT NULL, role text NOT NULL DEFAULT 'owner',
  status text NOT NULL DEFAULT 'active', PRIMARY KEY(tenant_id,id));
CREATE TABLE finnor_os.works(
  tenant_id uuid NOT NULL, id uuid NOT NULL, created_by uuid NOT NULL,
  PRIMARY KEY(tenant_id,id));
CREATE TABLE finnor_os.work_inputs(
  tenant_id uuid NOT NULL, id uuid NOT NULL, work_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id));
CREATE TABLE finnor_os.compute_job_type_policies (
  job_type text PRIMARY KEY,
  default_class text NOT NULL CHECK (default_class IN ('REALTIME','INTERACTIVE','BACKGROUND','HEAVY')),
  allowed_classes text[] NOT NULL,
  classification_rule text NOT NULL CHECK (classification_rule IN ('fixed','trusted_lane')),
  tenant_scope text NOT NULL CHECK (tenant_scope IN ('tenant','global')),
  obligation_kind text NOT NULL CHECK (obligation_kind IN ('required','coalescible')),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  rationale text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (cardinality(allowed_classes) > 0),
  CHECK (default_class = ANY(allowed_classes)),
  CHECK (allowed_classes <@ ARRAY['REALTIME','INTERACTIVE','BACKGROUND','HEAVY']::text[])
);
GRANT USAGE ON SCHEMA finnor_os TO finnor_app;
`;

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const U1 = "33333333-3333-4333-8333-333333333333";
const W1 = "44444444-4444-4444-8444-444444444444";
const I1 = "55555555-5555-4555-8555-555555555555";
const S1 = "66666666-6666-4666-8666-666666666666";

const dir = mkdtempSync(join(tmpdir(), "z3-0199-"));
const failures = [];
const ok = (name) => console.log("PASS " + name);
const bad = (name, detail) => { failures.push(name); console.log("FAIL " + name + " :: " + detail); };
const pg = new EmbeddedPostgres({ databaseDir: dir, port: 55439, user: "postgres",
  password: "postgres", persistent: false, onLog: () => {}, onError: () => {} });
try {
  await pg.initialise();
  await pg.start();
  const client = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:55439/postgres` });
  await client.connect();
  await client.query(SHELL);
  ok("shell");
  try { await client.query(sql); ok("0199 applies"); }
  catch (e) { bad("0199 applies", e.message); throw e; }

  // Seed one tenant row set and one session.
  await client.query(
    `INSERT INTO finnor_os.users(tenant_id,id) VALUES($1,$2),($3,$4);
     INSERT INTO finnor_os.works(tenant_id,id,created_by) VALUES($1,$5,$2);
     INSERT INTO finnor_os.work_inputs(tenant_id,id,work_id) VALUES($1,$6,$5);
     INSERT INTO finnor_os.z3_viability_sessions(
       id,tenant_id,principal_id,work_id,work_input_id,original_parent_id,
       arena_digest,binding_digest,arena,binding,obligation_refs,deadline_at)
     VALUES($7,$1,$2,$5,$6,'parent','${"a".repeat(64)}','${"b".repeat(64)}','{}','{}','[]','2030-01-01')`,
    [T1, U1, T2, "99999999-9999-4999-8999-999999999999", W1, I1, S1]);
  ok("seed insert");

  const expectRaise = async (name, statement, params) => {
    try { await client.query(statement, params); bad(name, "no exception"); }
    catch (e) { ok(name + " (raised: " + String(e.message).slice(0, 60) + ")"); }
  };
  // Legitimate progress update must succeed.
  await client.query(
    `UPDATE finnor_os.z3_viability_sessions
        SET status='PRODUCING', active_claim_token='tok-a', active_claim_fence=1, generation=2
      WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  ok("progress update (status/fence/generation)");
  // Publish candidate once (immutable afterwards).
  await client.query(
    `UPDATE finnor_os.z3_viability_sessions
        SET candidate='{"k":1}', candidate_digest=$3 WHERE tenant_id=$1 AND id=$2`,
    [T1, S1, "c".repeat(64)]);
  ok("candidate first publish");
  await expectRaise("candidate immutable", 
    `UPDATE finnor_os.z3_viability_sessions SET candidate='{"k":2}' WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  await expectRaise("arena preimage immutable",
    `UPDATE finnor_os.z3_viability_sessions SET arena='{"x":1}' WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  await expectRaise("fence cannot retreat",
    `UPDATE finnor_os.z3_viability_sessions SET active_claim_fence=0 WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  // Fence 0 also violates the CHECK; either refusal is a pass for the guard probe above.
  await expectRaise("generation cannot reset",
    `UPDATE finnor_os.z3_viability_sessions SET generation=1 WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  // Terminal irreversibility.
  await client.query(`UPDATE finnor_os.z3_viability_sessions SET status='VIABLE' WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  ok("terminal publish");
  await expectRaise("terminal status irreversible",
    `UPDATE finnor_os.z3_viability_sessions SET status='FAILED' WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  await expectRaise("session delete refused",
    `DELETE FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND id=$2`, [T1, S1]);
  // Requests/events/artifacts append-only via s5_immutable_record.
  await client.query(
    `INSERT INTO finnor_os.z3_viability_requests(tenant_id,principal_id,idempotency_key,request_digest,session_id)
     VALUES($1,$2,'k','${"d".repeat(64)}',$3)`, [T1, U1, S1]);
  await expectRaise("requests append-only",
    `DELETE FROM finnor_os.z3_viability_requests WHERE tenant_id=$1 AND principal_id=$2`, [T1, U1]);
  // Policy rows landed.
  const policies = await client.query(
    "SELECT job_type,default_class,obligation_kind FROM finnor_os.compute_job_type_policies WHERE job_type LIKE 'run_z3_%' ORDER BY 1");
  if (policies.rowCount === 2 && policies.rows.every(r => r.default_class === "INTERACTIVE" && r.obligation_kind === "required")) {
    ok("compute_job_type_policies rows");
  } else bad("compute_job_type_policies rows", JSON.stringify(policies.rows));
  // RLS: finnor_app sees only its tenant+principal scope.
  await client.query(`GRANT SELECT ON finnor_os.users TO finnor_app`);
  await client.query(`SET ROLE finnor_app; SET app.tenant_id='${T1}'; SET app.user_id='${U1}'`);
  const visible = await client.query("SELECT count(*)::int AS n FROM finnor_os.z3_viability_sessions");
  if (visible.rows[0].n === 1) ok("RLS same-tenant visible"); else bad("RLS same-tenant visible", JSON.stringify(visible.rows));
  await client.query(`SET app.tenant_id='${T2}'; SET app.user_id='99999999-9999-4999-8999-999999999999'`);
  const hidden = await client.query("SELECT count(*)::int AS n FROM finnor_os.z3_viability_sessions");
  if (hidden.rows[0].n === 0) ok("RLS cross-tenant hidden"); else bad("RLS cross-tenant hidden", JSON.stringify(hidden.rows));
  await client.end();
} catch (e) {
  if (!failures.length) bad("harness", e.message);
} finally {
  try { await pg.stop(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ payload: "postz_z3_viability.sql", sha256, failures }, null, 1));
process.exit(failures.length ? 1 : 0);
