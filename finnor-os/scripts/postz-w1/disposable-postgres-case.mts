/** Real fresh PG lifecycle subject, including setup failure and forced exit. */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ownDisposablePostgres, closeDisposablePostgres } from "./disposable-postgres.mjs";

const [mode, destination] = process.argv.slice(2);
assert(["success", "initialise-failure", "setup-failure", "signal", "timeout", "forced-exit", "hard-kill"].includes(mode!));
assert(destination);
const directory = await mkdtemp(join(tmpdir(), "finnor-w1-cleanup-"));
const owned = ownDisposablePostgres(directory, directory, join(destination, "postgres-cleanup.json"));
let client: pg.Client | undefined;
try {
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close(error => error ? no(error) : yes(address.port));
    });
  });
  const database = owned.attach(new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "finnor",
    port, persistent: true, postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    initdbFlags: mode === "initialise-failure" ? ["--w1-intentionally-invalid-initdb-option"] : [],
    onLog: () => undefined, onError: () => undefined }));
  await database.initialise(); await database.start(); await database.createDatabase("w1_cleanup");
  client = new pg.Client({ host: "127.0.0.1", port, user: "finnor", password: "finnor", database: "w1_cleanup" });
  await client.connect();
  const observed = (await client.query("SELECT 42::integer AS original_value")).rows[0];
  assert.equal(observed.original_value, 42);
  await client.end(); client = undefined;
  const postgresPid = Number((await readFile(join(owned.observation.databaseDirectory, "postmaster.pid"), "utf8")).split("\n")[0]);
  await writeFile(join(destination, "ready.json"), JSON.stringify({ mode, directory, postgresPid, observed }) + "\n",
    { flag: "wx" });
  if (mode === "setup-failure") throw Error("INTENTIONAL_SETUP_FAILURE_AFTER_REAL_POSTGRES");
  if (mode === "forced-exit") process.exit(124);
  if (["signal", "timeout", "hard-kill"].includes(mode!)) await new Promise<never>(() => undefined);
} catch (error) {
  await writeFile(join(destination, "subject-error.json"), JSON.stringify({ mode, error: String(error) }) + "\n",
    { flag: "wx" });
  process.exitCode = 17;
} finally {
  await closeDisposablePostgres(owned, [async () => client?.end()]);
}
