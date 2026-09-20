/** A separate process representing one managed-pool compute task. The parent
 * certification supplies only its disposable loopback PostgreSQL URL. */
import pg from "pg";
import { assertDisposableDatabaseTarget } from "../../../packages/db/production-target-guard";

const url = process.env.DATABASE_URL;
assertDisposableDatabaseTarget(url, "Scope-3 DB capacity child");
if (process.env.FINNOR_SCOPE3_DISPOSABLE_DB !== "1" || !/^\/finnor_scope3_cert_[a-f0-9_]+$/.test(new URL(url).pathname)) {
  throw new Error("Scope-3 DB capacity child requires the dedicated disposable database");
}
const name = process.env.FINNOR_SCOPE3_DB_CHILD_NAME;
if (!name || !/^scope3-db-child-[a-f0-9-]+$/.test(name)) throw new Error("Invalid child identity");

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  application_name: name,
  connectionTimeoutMillis: 5_000,
});

async function main(): Promise<void> {
  try {
    await pool.query("SELECT 1");
    process.stdout.write("READY\n");
    await Promise.all(Array.from({ length: 8 }, () => pool.query("SELECT pg_sleep(2)")));
    await pool.end();
  } catch (error) {
    console.error(error);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  }
}

void main();
