/** Finite cumulative schema proof. No production database or phase qualification. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate, type MigrationFile } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";

process.umask(0o077);
const repo = resolve(import.meta.dirname, "../../.."), startedAt = new Date().toISOString();
const hardStop = Date.now() + 600_000, floor = 3 * 1024 ** 3;
const output = join(repo, "scope-v/v1-v5-cumulative-closure/evidence",
  "migrations-" + startedAt.replaceAll(":", "-") + "-" + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true });
const sha = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const root = join(repo, "finnor-os/packages/db/migrations");
const files: MigrationFile[] = await Promise.all((await readdir(root)).filter(n => n.endsWith(".sql")).sort()
  .map(async name => ({ name, sql: await readFile(join(root, name), "utf8") })));
const identity = (list: MigrationFile[]) => list.map(f => ({ name: f.name, sha256: sha(f.sql) }));
const v2 = ["0172_v2_primary_diligence.sql", "0173_v2_primary_privacy.sql", "0174_v2_primary_profile_custody.sql"];
const phases: Record<string, string[]> = {
  FRESH: [], V1: [...v2, "0177_v1_bilateral_opportunities.sql"], V2: v2,
  V3: ["0173_v3_autonomous_transaction_closure.sql"],
  V4: ["0175_v4_autonomous_capital_formation.sql"], V5: ["0176_v5_live_institutional_control.sql"],
};
const freeze = {
  schema: "finnor.v.cumulative-migration-freeze.v1", startedAt, hardStop: new Date(hardStop).toISOString(),
  command: "cd finnor-os && node --import=tsx scripts/v-closure/run-migration-e2e.mts",
  classification: "DISPOSABLE_NATIVE_SCHEMA_NOT_PHASE_ARTIFACT_OR_INFLIGHT_QUALIFICATION",
  node: process.version, cleanInstall: false, floorBytes: floor,
  runnerSha256: sha(await readFile(new URL(import.meta.url))), migrations: identity(files), phases,
  managedExtensions: "OMITTED_LOCAL_ONLY", maximumClusters: 1, maximumCaseDatabases: 1,
};
await writeFile(join(output, "freeze.json"), JSON.stringify(freeze, null, 2) + "\n", { flag: "wx" });
const results: Array<Record<string, unknown>> = [];
let directory: string | undefined, postgres: EmbeddedPostgres | undefined, control: pg.Client | undefined;
let running = false, passed = true;
const preflight = async () => {
  assert(Date.now() < hardStop, "REGISTERED_CUMULATIVE_MIGRATION_DEADLINE_EXHAUSTED");
  const disk = await statfs(repo), free = disk.bavail * disk.bsize;
  assert(free >= floor, "UNCHANGED_THREE_GIB_RESOURCE_FLOOR");
  return free;
};
try {
  assert.deepEqual(identity(MIGRATIONS), identity(files), "BUNDLE_AND_DIRECTORY_BYTES_OR_ORDER_DIFFER");
  for (const names of Object.values(phases)) for (const name of names) assert(files.some(f => f.name === name), name);
  const freeBefore = await preflight();
  directory = await mkdtemp(join(tmpdir(), "finnor-v-cumulative-migration-"));
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close(() => yes(address.port));
    });
  });
  const password = randomBytes(24).toString("base64url");
  postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor_v_cumulative",
    password, port, persistent: true, onLog: () => undefined });
  process.env.NODE_ENV = "test"; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  await postgres.initialise(); await postgres.start(); running = true;
  const url = (database: string) => `postgres://finnor_v_cumulative:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?options=${encodeURIComponent("-c statement_timeout=90000 -c lock_timeout=15000")}`;
  control = new pg.Client({ connectionString: url("postgres") }); await control.connect();
  results.push({ id: "bundle-directory-identity", status: "PASS", freeBefore, count: files.length });
  for (const [phase, names] of Object.entries(phases)) {
    const caseResult: Record<string, unknown> = { id: phase, status: "NOT_RUN", startedAt: new Date().toISOString() };
    const database = "v_cumulative_" + randomUUID().replaceAll("-", "");
    let client: pg.Client | undefined, created = false;
    try {
      caseResult.freeBefore = await preflight();
      await postgres.createDatabase(database); created = true;
      client = new pg.Client({ connectionString: url(database) }); await client.connect();
      const predecessor = phase === "FRESH" ? [] : files.filter(f => f.name < "0172" || names.includes(f.name));
      caseResult.predecessor = identity(predecessor);
      if (predecessor.length) await migrate(url(database), predecessor);
      const tenant = randomUUID(), principal = randomUUID(), work = randomUUID(), input = randomUUID();
      if (predecessor.length) {
        await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Cumulative migration synthetic native identity')", [tenant, randomUUID()]);
        await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role) VALUES($1,$2,$3,'owner')", [principal, tenant, principal + "@synthetic.invalid"]);
        await client.query("INSERT INTO finnor_os.works(id,tenant_id,initial_channel,initial_instruction,created_by) VALUES($1,$2,'console','Preserve the same native Work/input during cumulative upgrade',$3)", [work, tenant, principal]);
        await client.query("INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by) VALUES($1,$2,$3,$4,'console','Frozen native upgrade identity',$5)", [input, tenant, work, randomUUID(), principal]);
      }
      // Exercise the actual directory loader, then the bundled restart path.
      caseResult.applied = await migrate(url(database));
      const replay = await migrate(url(database), MIGRATIONS);
      assert.deepEqual(replay, []); caseResult.bundledReplay = replay;
      const applied = (await client.query("SELECT name FROM finnor_os._migrations ORDER BY name")).rows.map(r => r.name);
      assert.deepEqual(applied, files.map(f => f.name));
      caseResult.appliedNames = applied;
      if (predecessor.length) {
        const preserved = (await client.query(`SELECT w.id::text work_id,i.id::text input_id,i.work_id::text input_work_id,w.created_by::text principal
          FROM finnor_os.works w JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
          WHERE w.tenant_id=$1 AND w.id=$2 AND i.id=$3`, [tenant, work, input])).rows[0];
        assert.deepEqual(preserved, { work_id: work, input_id: input, input_work_id: work, principal });
        caseResult.nativeIdentityPreserved = preserved;
      }
      const privileges = (await client.query(`SELECT
        has_table_privilege('finnor_app','finnor_os.pe_closing_checks','INSERT') app_closing_check,
        has_table_privilege('finnor_app','finnor_os.pe_closed_transaction_certificates','INSERT') app_close_certificate,
        has_table_privilege('finnor_closing_checker','finnor_os.pe_closing_checks','INSERT') checker_closing_check,
        pg_has_role('finnor_app','finnor_closing_checker','MEMBER') app_is_closing_checker,
        pg_has_role('finnor_app','finnor_v1_checker','MEMBER') app_is_bilateral_checker,
        has_table_privilege('finnor_app','finnor_os.v1_claim_checks','INSERT') app_bilateral_receipt`)).rows[0];
      assert.deepEqual(privileges, { app_closing_check: false, app_close_certificate: false,
        checker_closing_check: true, app_is_closing_checker: false, app_is_bilateral_checker: false, app_bilateral_receipt: false });
      caseResult.privileges = privileges;
      caseResult.constraints = (await client.query(`SELECT c.relname,p.conname,pg_get_constraintdef(p.oid) definition
        FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='finnor_os' AND c.relname IN('jobs','work_objective_loops','pe_investment_cases')
        ORDER BY c.relname,p.conname`)).rows;
      caseResult.jobPolicies = (await client.query("SELECT job_type FROM finnor_os.compute_job_type_policies WHERE job_type LIKE '%primary%' OR job_type LIKE '%bilateral%' OR job_type LIKE '%capital%' OR job_type LIKE '%closing%' ORDER BY job_type")).rows;
      caseResult.status = "PASS";
    } catch (error) {
      passed = false; caseResult.status = "FAIL";
      caseResult.failure = { message: (error as Error).message, code: (error as { code?: string }).code ?? null };
    } finally {
      await client?.end();
      if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
      caseResult.finishedAt = new Date().toISOString(); results.push(caseResult);
      await writeFile(join(output, phase + ".json"), JSON.stringify(caseResult, null, 2) + "\n", { flag: "wx" });
      console.log(JSON.stringify({ id: phase, status: caseResult.status, failure: caseResult.failure }));
    }
  }
} catch (error) {
  passed = false; results.push({ id: "campaign", status: "FAIL", failure: { message: (error as Error).message } });
} finally {
  await control?.end();
  if (running) { await postgres!.stop(); running = false; }
  if (directory && !running) await rm(directory, { recursive: true, force: true });
  await writeFile(join(output, "result.json"), JSON.stringify({
    ...freeze, schema: "finnor.v.cumulative-migration-e2e.v1", finishedAt: new Date().toISOString(),
    status: passed ? "PASS_ASSIGNED_SCHEMA_BOUNDARIES" : "FAIL", results,
    limitations: ["No phase-specific populated artifact preservation", "No authenticated programme or business conjunction",
      "No installed image, managed extension, production lineage, deployment, S8 or economic qualification"],
  }, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ passed, evidence: output }));
process.exit(passed ? 0 : 1);
