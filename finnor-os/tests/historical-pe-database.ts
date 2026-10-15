import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../packages/db/migrate";
import { MIGRATIONS } from "../packages/db/migrations-bundle";

/** Actual historical close fixtures must precede V3, not bypass its new guard. */
export async function historicalPeDatabase(sourceUrl: string) {
  const database = `finnor_legacy_pe_${randomUUID().replaceAll("-", "_")}`;
  const source = new pg.Client({ connectionString: sourceUrl });
  await source.connect();
  try { await source.query(`CREATE DATABASE ${database}`); } finally { await source.end(); }
  const url = new URL(sourceUrl);
  url.pathname = `/${database}`;
  const adminUrl = url.toString();
  url.username = "finnor_app"; url.password = "finnor_app";
  try {
    await migrate(adminUrl, MIGRATIONS.filter(m => m.name < "0173_v3_autonomous_transaction_closure.sql"));
  } catch (error) {
    const cleanup = new pg.Client({ connectionString: sourceUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
    throw error;
  }
  return { adminUrl, appUrl: url.toString(), async close() {
    const cleanup = new pg.Client({ connectionString: sourceUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
  } };
}
