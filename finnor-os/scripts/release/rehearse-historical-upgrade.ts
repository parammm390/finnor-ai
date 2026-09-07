/** Disposable regression for the production lineage deployed before PE Phase 5.
 * Downloads immutable historical SQL; never reads production credentials. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate, type MigrationFile } from "../../packages/db/migrate";

const historicalCommit = "f40526617c7e22258c12a2b669975ddaaf33e7fc";
const historicalNames = [
  "0104_product_truth_objective_realtime.sql",
  "0105_human_operating_compiler.sql",
  "0106_interactive_runtime_closure.sql",
  "0107_business_truth_registry.sql",
  "0108_operating_product_closure.sql",
];

async function main() {
  const directory = fileURLToPath(new URL("../../packages/db/migrations/", import.meta.url));
  const current: MigrationFile[] = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()
    .map(async (name) => ({ name, sql: await readFile(join(directory, name), "utf8") })));
  const historical = await Promise.all(historicalNames.map(async (name) => {
    const response = await fetch(`https://raw.githubusercontent.com/parammm390/finnor-ai/${historicalCommit}/finnor-os/packages/db/migrations/${name}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Historical migration ${name}: HTTP ${response.status}`);
    return { name, sql: await response.text() };
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
    await migrate(url, historical);
    console.log("Historical 0104–0108 schema installed");
    const applied = await migrate(url, current);
    assert(applied.includes("0109_atomic_water_runtime_retirement.sql"));
    assert.deepEqual(await migrate(url, current), []);
    const verification = new pg.Client({ connectionString: url });
    await verification.connect();
    try {
      assert.equal((await verification.query("SELECT count(*)::int AS n FROM finnor_os.communications_log")).rows[0].n, 1);
      assert.equal((await verification.query("SELECT count(*)::int AS n FROM finnor_os._migrations WHERE name = ANY($1)", [historicalNames])).rows[0].n, historicalNames.length);
    } finally { await verification.end(); }
    await embedded.createDatabase("fresh");
    assert.equal((await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/fresh`, current)).length, current.length);
    console.log(JSON.stringify({ ok: true, historicalCommit, applied, rerun: "no-op" }));
  } finally {
    await embedded.stop();
  }
}
void main().catch((error) => { console.error(error); process.exit(1); });
