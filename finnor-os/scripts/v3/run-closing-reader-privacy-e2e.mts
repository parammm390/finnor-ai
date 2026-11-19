import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { verifyClosingReaderPrivacy } from "./closing-reader-privacy.mts";

process.umask(0o077);
const output = process.argv[2];
assert(output && isAbsolute(output), "New absolute privacy evidence directory required");
await mkdir(output);
const report = join(output, "report"); await mkdir(report);
const save = async (path: string, value: unknown) => writeFile(join(report, path), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const space = await statfs(output);
assert(space.bavail * space.bsize >= 4 * 1024 ** 3, "Original global disk floor plus privacy preparation headroom required");
const directory = await mkdtemp(join(output, "private-postgres-"));
const port = await new Promise<number>((accept, reject) => {
  const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
    const number = (server.address() as { port: number }).port; server.close(() => accept(number));
  });
});
const password = randomBytes(24).toString("hex");
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "closing_privacy_admin", password,
  port, persistent: true, onLog: () => undefined });
const startedAt = new Date().toISOString();
let client: pg.Client | null = null, failure: unknown = null, observed: unknown;
process.env.NODE_ENV = "test"; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
const address = `postgres://closing_privacy_admin:${password}@127.0.0.1:${port}/closing_privacy`;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([(async () => {
    await postgres.initialise(); await postgres.start(); await postgres.createDatabase("closing_privacy");
    const migrations = await migrate(address);
    client = new pg.Client({ connectionString: address, statement_timeout: 10000 }); await client.connect();
    await client.query("SET app.test_vertical_mode='explicit'");
    observed = { migrations, ...(await verifyClosingReaderPrivacy(client, save)) };
  })(), new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(Error("PRIVACY_E2E_120_SECOND_LIMIT")), 120000); })]);
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "UNKNOWN" };
} finally {
  if (timer) clearTimeout(timer);
  await (client as pg.Client | null)?.end().catch(() => undefined);
  await postgres.stop().catch(error => { failure ??= { name: "CLEANUP_FAILED", code: error?.code ?? null }; });
  await save("results.json", { status: failure ? "FAIL" : "PASS", startedAt, finishedAt: new Date().toISOString(),
    observed, failure, qualification: "ACTUAL_SQL_PRIVACY_BOUNDARY_ONLY_NOT_OWNING_W_COMPLETION" });
}
console.log(JSON.stringify({ status: failure ? "FAIL" : "PASS", failure, report }));
process.exit(failure ? 1 : 0);
