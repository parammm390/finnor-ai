// A4.T4: pure-JS logical dump/restore — deliberately NOT pg_dump/pg_restore. This code
// runs inside the persistent worker process, whose runtime image has no guaranteed
// Postgres client tools on PATH (confirmed absent even in this dev sandbox — no pg_dump,
// no docker to check inside the production image either). scripts/backup-restore-
// drill.ts already covers the pg_dump-based path for a real dev machine/CI image that DOES
// have client tools; this is the production-path alternative that has zero binary
// dependency, so it can run anywhere `pg` (already a dependency everywhere) can connect.
//
// Every table's primary key in this schema is `uuid().defaultRandom()` — zero serial/
// identity columns anywhere (grepped, confirmed) — so restore needs no sequence resets.
// FK ordering is sidestepped entirely via `session_replication_role = replica`, the
// standard Postgres trick for bulk logical restores (disables trigger/FK enforcement for
// the session, not the whole database).

import pg from "pg";

const MAX_BIND_PARAMETERS = 60_000;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function encodeValue(value: unknown, arrayColumns: Set<string> | undefined, column: string): unknown {
  // A real Postgres array must remain a native array so node-postgres encodes it
  // as an array literal. JSON arrays/objects need an explicit JSON representation.
  if (Array.isArray(value) && arrayColumns?.has(column)) return value;
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export interface DatabaseDump {
  schemaVersion: 1;
  generatedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

async function listFinnorTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'finnor_os' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function listFinnorArrayColumns(client: pg.Client): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'finnor_os' AND data_type = 'ARRAY'`,
  );
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = result.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    result.set(row.table_name, columns);
  }
  return result;
}

async function listFinnorGeneratedColumns(client: pg.Client): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'finnor_os' AND is_generated = 'ALWAYS'`,
  );
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = result.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    result.set(row.table_name, columns);
  }
  return result;
}

/** Dumps every real table in the finnor_os schema. Development/reference-scale only,
 *  not a real multi-tenant production body of data) — a straight `SELECT *` per table
 *  is the honest scope here; a real production-scale dump would need streaming/paging,
 *  noted as a known limit rather than pretended away. */
export async function dumpAllTables(databaseUrl: string): Promise<DatabaseDump> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tableNames = await listFinnorTables(client);
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const name of tableNames) {
      const { rows } = await client.query(`SELECT * FROM finnor_os.${name}`);
      tables[name] = rows;
    }
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), tables };
  } finally {
    await client.end();
  }
}

/** Restores a dump into a target database whose schema has ALREADY had migrations
 *  applied (this does not run migrate() itself — the caller decides that, same
 *  separation of concerns as scripts/backup-restore-drill.ts's own pg_restore-into-an-
 *  already-createdb'd-database step). TRUNCATEs every dumped table first — this is a
 *  full-replace restore, not a merge. */
export async function restoreAllTables(databaseUrl: string, dump: DatabaseDump): Promise<{ restoredTables: number; restoredRows: number }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let restoredRows = 0;
  try {
    await client.query("BEGIN");
    await client.query("SET session_replication_role = replica");
    const tableNames = Object.keys(dump.tables);
    // pg returns Postgres arrays as JavaScript arrays, just as it returns JSON arrays
    // as JavaScript arrays. The restore path must distinguish them: JSON needs an
    // explicit JSON string (see below), while a real `uuid[]`/`text[]` must remain a
    // native array for pg to encode as a Postgres array literal.
    const arrayColumns = await listFinnorArrayColumns(client);
    const generatedColumns = await listFinnorGeneratedColumns(client);
    // Truncate the complete restore set in one statement. Repeating a CASCADE
    // catalog-lock walk once per table made this round trip exceed Vitest's timeout
    // on a slower CI runner even though the database was healthy. One statement is
    // both faster and atomic; the transaction still gives us full-replace semantics.
    if (tableNames.length > 0) {
      await client.query(`TRUNCATE TABLE ${tableNames.map((name) => `finnor_os.${quoteIdentifier(name)}`).join(", ")} CASCADE`);
    }
    for (const name of tableNames) {
      const rows = dump.tables[name]!;
      let offset = 0;
      while (offset < rows.length) {
        const firstRow = rows[offset]!;
        // Stored generated columns (currently search_vector) must be recomputed by
        // PostgreSQL; an INSERT may not provide an explicit value for them.
        const columns = Object.keys(firstRow).filter((column) => !generatedColumns.get(name)?.has(column));
        if (columns.length === 0) {
          offset++;
          continue;
        }

        // Keep the legacy per-row column omission behavior for hand-authored dumps,
        // while batching the normal dumpAllTables shape. A single INSERT cannot bind
        // more than 65,535 parameters; stay below that server limit with headroom.
        const rowsPerBatch = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columns.length));
        const batch: Record<string, unknown>[] = [firstRow];
        offset++;
        while (offset < rows.length && batch.length < rowsPerBatch) {
          const candidate = rows[offset]!;
          const candidateColumns = Object.keys(candidate).filter((column) => !generatedColumns.get(name)?.has(column));
          if (candidateColumns.join("\0") !== columns.join("\0")) break;
          batch.push(candidate);
          offset++;
        }

        const placeholders = batch.map((_, rowIndex) =>
          `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(", ")})`,
        ).join(", ");
        // node-postgres's implicit array-vs-JSON handling picks the WRONG one for a
        // jsonb column whose value is a JS array (e.g. decision_receipts.evidence) —
        // it formats it as a Postgres array literal ("{...}"), not JSON, which Postgres
        // then rejects as "invalid input syntax for type json". Explicitly
        // JSON.stringify-ing every plain object/array ourselves sidesteps pg's
        // ambiguous auto-detection entirely; Dates and primitives pass through as-is
        // (pg already binds those correctly for timestamp/text/numeric/uuid columns).
        const values = batch.flatMap((row) => columns.map((column) => encodeValue(row[column], arrayColumns.get(name), column)));
        await client.query(
          `INSERT INTO finnor_os.${quoteIdentifier(name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${placeholders}`,
          values,
        );
        restoredRows += batch.length;
      }
    }
    await client.query("SET session_replication_role = DEFAULT");
    await client.query("COMMIT");
    return { restoredTables: tableNames.length, restoredRows };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
