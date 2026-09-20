// Applies SQL migrations in order, tracked in a _migrations table. Idempotent:
// re-running skips already-applied files. Run via CI before deploy (§24).

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConnectionConfig } from "./index";
import { isCanonicalProductionDatabaseTarget } from "./production-target-guard";
import { HISTORICAL_PRODUCTION_MIGRATIONS } from "./historical-migration-lineage";
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

/** A filename-only tracker cannot prove that an unfamiliar production migration
 * is compatible with this checkout. Reject divergent lineage before executing
 * any pending application SQL; reconciliation needs an explicitly reviewed
 * schema snapshot or forward-only bridge, never a filename guess. */
export function assertKnownProductionMigrationLineage(
  appliedNames: readonly string[],
  availableNames: readonly string[],
): void {
  const available = new Set([
    ...availableNames,
    ...HISTORICAL_PRODUCTION_MIGRATIONS.map(({ name }) => name),
  ]);
  const unexpected = [...new Set(appliedNames.filter((name) => !available.has(name)))].sort();
  if (unexpected.length) {
    throw new Error(`Production migration lineage diverges from this release: ${unexpected.join(", ")}. Reconcile the live schema with a reviewed forward-only bridge before applying pending migrations.`);
  }
}

export async function migrate(
  databaseUrl = process.env.DATABASE_URL,
  bundled?: MigrationFile[],
  productionMutationCapability?: ProductionMutationAuthorizationResult,
): Promise<string[]> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const omitManagedPlatformExtensions = process.env.FINNOR_TEST_MANAGED_EXTENSIONS === "omit";
  if (omitManagedPlatformExtensions && isCanonicalProductionDatabaseTarget(databaseUrl)) {
    throw new Error("FINNOR_TEST_MANAGED_EXTENSIONS cannot be used against the canonical production database");
  }
  if (isCanonicalProductionDatabaseTarget(databaseUrl)) {
    const capability = productionMutationCapability ?? await authorizeProductionMutation("database-migrate");
    assertProductionMutationCapability(capability, "database-migrate");
  }
  // Resolve the release's complete lineage before opening a transaction. The
  // production preflight below is deliberately read-only, including when this
  // database still uses the legacy public tracker.
  const files: MigrationFile[] = bundled
    ? [...bundled].sort((a, b) => a.name.localeCompare(b.name))
    : await Promise.all(
        (await readdir(MIGRATIONS_DIR))
          .filter((f) => f.endsWith(".sql"))
          .sort()
          .map(async (name) => ({ name, sql: await readFile(join(MIGRATIONS_DIR, name), "utf8") })),
      );
  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  const applied: string[] = [];
  try {
    if (isCanonicalProductionDatabaseTarget(databaseUrl)) {
      const trackers = await client.query<{ schema_tracker: string | null; public_tracker: string | null }>(
        "SELECT to_regclass('finnor_os._migrations')::text AS schema_tracker, to_regclass('public._migrations')::text AS public_tracker",
      );
      const knownApplied = new Set<string>();
      if (trackers.rows[0]?.schema_tracker) {
        const history = await client.query<{ name: string }>("SELECT name FROM finnor_os._migrations");
        for (const row of history.rows) knownApplied.add(row.name);
      }
      if (trackers.rows[0]?.public_tracker) {
        const history = await client.query<{ name: string }>("SELECT name FROM public._migrations");
        for (const row of history.rows) knownApplied.add(row.name);
      }
      assertKnownProductionMigrationLineage([...knownApplied], files.map((file) => file.name));
    }
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
    for (const { name: file, sql } of files) {
      const { rowCount } = await client.query("SELECT 1 FROM finnor_os._migrations WHERE name = $1", [file]);
      if (rowCount) continue;
      await client.query("BEGIN");
      try {
        // Supabase owns these extensions in deployed projects. Vanilla embedded
        // PostgreSQL cannot install them, so an explicit non-production test seam
        // omits only their CREATE EXTENSION statements and still applies every
        // application object from the immutable historical migration.
        const executableSql = omitManagedPlatformExtensions && file === "0132_platform_objects_and_legacy_compatibility.sql"
          ? sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pg_cron|pg_graphql|pg_net|pgmq).*;$/gm, "-- provider-managed extension omitted by non-production test seam")
          : sql;
        await client.query(executableSql);
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
