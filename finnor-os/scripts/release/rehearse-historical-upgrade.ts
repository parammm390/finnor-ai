/** Disposable regression for the production lineage deployed before PE Phase 5.
 * Downloads immutable historical SQL; never reads production credentials. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate, type MigrationFile } from "../../packages/db/migrate";
import { pgConnectionConfig } from "../../packages/db/index";
import { HISTORICAL_PRODUCTION_MIGRATIONS } from "../../packages/db/historical-migration-lineage";

const historicalNames = HISTORICAL_PRODUCTION_MIGRATIONS.map(({ name }) => name);

interface SchemaFact { kind: string; name: string; detail: string }

async function schemaFacts(client: pg.Client): Promise<Map<string, string>> {
  const result = await client.query<SchemaFact>(`
    SELECT 'relation' AS kind,c.relname::text AS name,c.relkind::text AS detail
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='finnor_os' AND c.relkind IN ('r','p','v','m','S')
    UNION ALL
    SELECT 'column',c.relname||'.'||a.attname,
           format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull::text||'|'||
           coalesce(pg_get_expr(d.adbin,d.adrelid),'')||'|'||a.attidentity::text||'|'||a.attgenerated::text
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE n.nspname='finnor_os' AND c.relkind IN ('r','p','v','m')
       AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint',c.relname||'.'||con.conname,pg_get_constraintdef(con.oid,true)
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='finnor_os' AND con.contype<>'n'
    UNION ALL
    SELECT 'index',c.relname,pg_get_indexdef(c.oid)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='finnor_os' AND c.relkind IN ('i','I')
    UNION ALL
    SELECT 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid)||'|'||t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='finnor_os' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
           pg_get_function_result(p.oid)||'|'||md5(pg_get_functiondef(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='finnor_os'
    ORDER BY kind,name
  `);
  return new Map(result.rows.map((fact) => [`${fact.kind}:${fact.name}`, fact.detail]));
}

async function compareLiveSchema(expectedUrl: string): Promise<void> {
  const secret = execFileSync("aws", ["secretsmanager", "get-secret-value", "--secret-id", "finnor/prod/database-url", "--region", "us-east-1", "--query", "SecretString", "--output", "text"], { encoding: "utf8", timeout: 15_000 }).trim();
  const parsed: unknown = secret.startsWith("{") ? JSON.parse(secret) : secret;
  const liveUrl = typeof parsed === "string" ? parsed
    : parsed && typeof parsed === "object" && "DATABASE_URL" in parsed && typeof parsed.DATABASE_URL === "string"
      ? parsed.DATABASE_URL : null;
  assert(typeof liveUrl === "string" && liveUrl.startsWith("postgres"), "AWS database secret did not contain a PostgreSQL URL");
  const expected = new pg.Client({ connectionString: expectedUrl });
  const live = new pg.Client(pgConnectionConfig(liveUrl));
  await expected.connect();
  try {
    await live.connect();
    try {
      const [expectedFacts, liveFacts] = await Promise.all([schemaFacts(expected), schemaFacts(live)]);
      const names = [...new Set([...expectedFacts.keys(), ...liveFacts.keys()])].sort();
      const missing = names.filter((name) => expectedFacts.has(name) && !liveFacts.has(name));
      const extra = names.filter((name) => !expectedFacts.has(name) && liveFacts.has(name));
      const changed = names.filter((name) => expectedFacts.has(name) && liveFacts.has(name)
        && expectedFacts.get(name) !== liveFacts.get(name));
      const scopeCritical = /^(?:relation|column|constraint|index|trigger|function):(?:jobs|job_|compute_|worker_heartbeat|service_release_heartbeats|product_runtime_authority|works|work_|workflow_|business_effects)/;
      const criticalDiffs = [...missing.map((name) => `missing:${name}`), ...extra.map((name) => `extra:${name}`),
        ...changed.map((name) => `changed:${name}`)].filter((name) => scopeCritical.test(name.slice(name.indexOf(":") + 1)));
      console.log(JSON.stringify({ schemaComparison: "read-only pre-0131 baseline", expectedFacts: expectedFacts.size,
        liveFacts: liveFacts.size, missingCount: missing.length, extraCount: extra.length, changedCount: changed.length,
        criticalDiffs,
        missing: missing.slice(0, 40), extra: extra.slice(0, 40), changed: changed.slice(0, 40),
        criticalChangedDetails: changed.filter((name) => scopeCritical.test(name)).map((name) => ({
          name, expected: expectedFacts.get(name), live: liveFacts.get(name),
        })),
        changedDetails: process.argv.includes("--schema-details") ? changed.slice(0, 100).map((name) => ({
          name, expected: expectedFacts.get(name)?.slice(0, 220), live: liveFacts.get(name)?.slice(0, 220),
        })) : undefined }));
    } finally { await live.end(); }
  } finally { await expected.end(); }
}

async function main() {
  const directory = fileURLToPath(new URL("../../packages/db/migrations/", import.meta.url));
  const current: MigrationFile[] = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()
    .map(async (name) => ({ name, sql: await readFile(join(directory, name), "utf8") })));
  const historical = await Promise.all(HISTORICAL_PRODUCTION_MIGRATIONS.map(async ({ name, commit, sha256 }) => {
    const response = await fetch(`https://raw.githubusercontent.com/parammm390/finnor-ai/${commit}/finnor-os/packages/db/migrations/${name}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Historical migration ${name}: HTTP ${response.status}`);
    const sql = await response.text();
    assert.equal(createHash("sha256").update(sql).digest("hex"), sha256, `Historical migration ${name} digest changed`);
    return { name, sql };
  }));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const embedded = new EmbeddedPostgres({
    databaseDir: await mkdtemp(join(tmpdir(), "finnor-historical-upgrade-")),
    user: "finnor", password: "finnor", port, persistent: false,
    onLog: () => undefined, onError: () => undefined,
  });
  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase("upgrade");
    const url = `postgres://finnor:finnor@127.0.0.1:${port}/upgrade`;
    await migrate(url, current.filter((migration) => migration.name < "0104"));
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO finnor_os.tenants(id,name) VALUES ('11111111-1111-4111-8111-111111111111','Historical rehearsal');
        INSERT INTO finnor_os.households(id,tenant_id,address) VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Synthetic address');
        INSERT INTO finnor_os.communications_log(tenant_id,household_id,channel,direction,content)
          VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','sms','inbound','Historical rehearsal message');
      `);
    } finally { await client.end(); }
    await migrate(url, historical.filter((migration) => migration.name < "0131"));
    console.log("Historical 0102 and 0104–0108 schema installed");
    await migrate(url, current.filter((migration) => migration.name < "0131"));
    await migrate(url, historical.filter((migration) => migration.name >= "0131"));
    if (process.argv.includes("--compare-live")) await compareLiveSchema(url);
    const legacy = new pg.Client({ connectionString: url });
    await legacy.connect();
    try {
      await legacy.query(`INSERT INTO finnor_os.jobs(type,payload,status,idempotency_key)
        VALUES ('historical_unregistered_probe','{}'::jsonb,'dead_letter','historical:terminal'),
               ('historical_unregistered_probe','{}'::jsonb,'queued','historical:pending')`);
    } finally { await legacy.end(); }
    const applied = await migrate(url, current);
    assert(applied.includes("0131_egress_bounded_read_indexes.sql"));
    assert(applied.includes("0138_scope3_compute_plane.sql"));
    assert.deepEqual(await migrate(url, current), []);
    const verification = new pg.Client({ connectionString: url });
    await verification.connect();
    try {
      assert.equal((await verification.query("SELECT count(*)::int AS n FROM finnor_os.communications_log")).rows[0].n, 1);
      assert.equal((await verification.query("SELECT count(*)::int AS n FROM finnor_os._migrations WHERE name = ANY($1)", [historicalNames])).rows[0].n, historicalNames.length);
      const historicalJobs = await verification.query<{ idempotency_key: string; status: string; workload_class: string; classification_policy_revision: number }>(
        "SELECT idempotency_key,status,workload_class,classification_policy_revision FROM finnor_os.jobs WHERE idempotency_key LIKE 'historical:%' ORDER BY idempotency_key",
      );
      assert.deepEqual(historicalJobs.rows, [
        { idempotency_key: "historical:pending", status: "quarantined", workload_class: "BACKGROUND", classification_policy_revision: 0 },
        { idempotency_key: "historical:terminal", status: "dead_letter", workload_class: "BACKGROUND", classification_policy_revision: 0 },
      ]);
    } finally { await verification.end(); }
    await embedded.createDatabase("fresh");
    assert.equal((await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/fresh`, current)).length, current.length);
    // Protected main already carries the production 0131 baseline. Simulate
    // the exact merged migration directory, including the second 0131 file,
    // so a green old-branch fresh install cannot hide a post-merge failure.
    const mergedFresh = [...current, ...historical.filter((migration) => migration.name === "0131_private_equity_release_baseline.sql")]
      .sort((a, b) => a.name.localeCompare(b.name));
    await embedded.createDatabase("merged_fresh");
    const mergedFreshUrl = `postgres://finnor:finnor@127.0.0.1:${port}/merged_fresh`;
    assert.equal((await migrate(mergedFreshUrl, mergedFresh)).length,
      mergedFresh.length);
    const upgradedSchema = new pg.Client({ connectionString: url });
    const freshSchema = new pg.Client({ connectionString: mergedFreshUrl });
    await upgradedSchema.connect();
    try {
      await freshSchema.connect();
      try {
        const upgradedFacts = await schemaFacts(upgradedSchema);
        const freshFacts = await schemaFacts(freshSchema);
        const allNames = [...new Set([...upgradedFacts.keys(), ...freshFacts.keys()])].sort();
        const differences = allNames.filter((name) => upgradedFacts.get(name) !== freshFacts.get(name));
        // Older production has a retained Water/communications table with
        // rows, whereas an empty install takes the later clean-table branch.
        // Record that full-schema drift, but require exact parity for every
        // Scope-3 compute object across both supported migration paths.
        const computeObject = /^(?:relation|column|constraint|index|trigger|function):(?:jobs|job_|compute_|worker_heartbeat|service_release_heartbeats|classify_compute_job|guard_compute_job_claim|register_compute_tenant_state)/;
        const computeDifferences = differences.filter((name) => computeObject.test(name));
        console.log(JSON.stringify({ mergedFreshSchemaFacts: freshFacts.size,
          upgradedSchemaFacts: upgradedFacts.size, historicalSchemaDifferences: differences,
          computeDifferences }));
        assert.deepEqual(computeDifferences, [],
          "Historical production upgrade and protected-main fresh install disagree on compute-plane schema");
      } finally { await freshSchema.end(); }
    } finally { await upgradedSchema.end(); }
    console.log(JSON.stringify({ ok: true, historicalNames, applied, rerun: "no-op", mergedFresh: "PASS" }));
  } finally {
    await embedded.stop();
  }
}
void main().catch((error) => { console.error(error); process.exit(1); });
