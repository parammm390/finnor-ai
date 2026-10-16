import pg from "pg";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";

/** Observe actual SQL failures in this owned process, never queries or values. */
export function observeOwnedSqlFailures() {
  assertDisposableDatabaseTarget(process.env.DATABASE_URL, "V1 fixture diagnostics");
  if (process.env.NODE_ENV !== "test") throw Error("OWNED_SQL_DIAGNOSTICS_ONLY");
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: any[]) {
    const result = (original as any).apply(this, args);
    if (!result || typeof result.catch !== "function") return result;
    return result.catch((error: any) => {
      console.error(JSON.stringify({ diagnostic: "OWNED_SQL_FAILURE", code: error.code, table: error.table,
        column: error.column, constraint: error.constraint, message: error.message }));
      throw error;
    });
  } as typeof original;
}
