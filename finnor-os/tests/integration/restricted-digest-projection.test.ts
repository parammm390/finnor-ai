import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { expect, it } from "vitest";

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

it("verifies canonical hashes as the restricted app role when pgcrypto lives in extensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "finnor-digest-projection-"));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "finnor", port, persistent: false, onLog: () => undefined });
  let owner: pg.Client | undefined;
  let app: pg.Client | undefined;
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("digest_test");
    owner = new pg.Client({ connectionString: `postgres://finnor:finnor@127.0.0.1:${port}/digest_test` });
    await owner.connect();
    await owner.query("CREATE ROLE finnor_app LOGIN PASSWORD 'finnor_app' NOSUPERUSER NOBYPASSRLS");
    await owner.query("CREATE SCHEMA extensions");
    await owner.query("CREATE EXTENSION pgcrypto WITH SCHEMA extensions");
    await owner.query(await readFile(new URL("../../packages/db/migrations/0109b_pgcrypto_digest_compatibility.sql", import.meta.url), "utf8"));

    app = new pg.Client({ connectionString: `postgres://finnor_app:finnor_app@127.0.0.1:${port}/digest_test` });
    await app.connect();
    const digest = "SELECT encode(public.digest(convert_to('canonical','UTF8'),'sha256'),'hex') AS hash";
    await expect(app.query(digest)).rejects.toMatchObject({ code: "42501" });

    await owner.query(await readFile(new URL("../../packages/db/migrations/0141_restricted_digest_projection_access.sql", import.meta.url), "utf8"));
    const verified = await app.query<{ hash: string }>(digest);
    expect(verified.rows[0]?.hash).toBe(createHash("sha256").update("canonical").digest("hex"));
    const privileges = await owner.query<{ extensions_usage: boolean; definer: boolean }>(
      "SELECT has_schema_privilege('finnor_app','extensions','USAGE') AS extensions_usage, " +
      "(SELECT prosecdef FROM pg_proc WHERE oid='public.digest(bytea,text)'::regprocedure) AS definer",
    );
    expect(privileges.rows[0]).toEqual({ extensions_usage: false, definer: true });
  } finally {
    await app?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
