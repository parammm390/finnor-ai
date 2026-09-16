// Applies SQL migrations in order, tracked in a _migrations table. Idempotent:
// re-running skips already-applied files. Run via CI before deploy (§24).

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConnectionConfig } from "./index";
import { isCanonicalProductionDatabaseTarget } from "./production-target-guard";
import {
  assertProductionMutationCapability,
  authorizeProductionMutation,
  type ProductionMutationAuthorizationResult,
} from "../../../scripts/release/production-mutation-guard.mjs";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface MigrationFile {
  name: string;
  sql: string;
}

export async function migrate(
  databaseUrl = process.env.DATABASE_URL,
  bundled?: MigrationFile[],
  productionMutationCapability?: ProductionMutationAuthorizationResult,
): Promise<string[]> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (isCanonicalProductionDatabaseTarget(databaseUrl)) {
    const capability = productionMutationCapability ?? await authorizeProductionMutation("database-migrate");
    assertProductionMutationCapability(capability, "database-migrate");
  }
  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  const applied: string[] = [];
  try {
    // The tracker lives inside finnor_os too — a shared database's public schema may
    // belong to another application entirely.
    await client.query("CREATE SCHEMA IF NOT EXISTS finnor_os");
    await client.query(
      "CREATE TABLE IF NOT EXISTS finnor_os._migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    // Adopt rows from a pre-schema tracker if one exists (local dev DBs from earlier builds).
    await client.query(
      `DO $mig$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migrations') THEN
           INSERT INTO finnor_os._migrations SELECT * FROM public._migrations ON CONFLICT (name) DO NOTHING;
         END IF;
       END $mig$`,
    );
    // Serverless bundles can't readdir untraced folders — callers there pass the
    // migrations in-memory (packages/db/migrations-bundle.ts, generated + checked in).
    const files: MigrationFile[] = bundled
      ? [...bundled].sort((a, b) => a.name.localeCompare(b.name))
      : await Promise.all(
          (await readdir(MIGRATIONS_DIR))
            .filter((f) => f.endsWith(".sql"))
            .sort()
            .map(async (name) => ({ name, sql: await readFile(join(MIGRATIONS_DIR, name), "utf8") })),
        );
    for (const { name: file, sql } of files) {
      const { rowCount } = await client.query("SELECT 1 FROM finnor_os._migrations WHERE name = $1", [file]);
      if (rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO finnor_os._migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

// Allow `tsx packages/db/migrate.ts` as a CLI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate()
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
