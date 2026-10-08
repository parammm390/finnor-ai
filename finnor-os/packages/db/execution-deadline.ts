import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

const execution = new AsyncLocalStorage<{ deadline: number }>();
export class DatabaseExecutionDeadlineError extends Error {
  constructor() { super("Database operation exhausted its execution deadline"); this.name = "DatabaseExecutionDeadlineError"; }
}
export function withDatabaseExecutionDeadline<T>(deadline: number, invoke: () => Promise<T>): Promise<T> {
  const parent = execution.getStore()?.deadline;
  return execution.run({ deadline: Math.min(parent ?? deadline, deadline) }, invoke);
}
function remaining(): number | null {
  const deadline = execution.getStore()?.deadline;
  if (deadline === undefined) return null;
  const milliseconds = Math.floor(deadline - performance.now());
  if (milliseconds <= 0) throw new DatabaseExecutionDeadlineError();
  return Math.min(milliseconds, 30_000);
}
export function executionDeadlineMilliseconds(): number | null { return remaining(); }
export async function queryWithExecutionDeadline<T extends pg.QueryResultRow = any>(
  pool: pg.Pool, text: string, values?: unknown[],
): Promise<pg.QueryResult<T>> {
  if (remaining() === null) return pool.query<T>(text, values);
  const client = await connectWithExecutionDeadline(pool);
  let transaction = false;
  try {
    // A client-side query timeout alone can leave SQL waiting on the server.
    // Use the same bounded transaction path as tenant/owner operations so
    // SET LOCAL statement_timeout cancels the actual PostgreSQL statement.
    await client.query("BEGIN"); transaction = true;
    const result = await client.query<T>(text, values);
    await client.query("COMMIT"); transaction = false;
    return result;
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
/** Scope only trusted owner calls. A timed-out physical client is destroyed,
 * never returned to the pool with an unfinished query or transaction. */
export async function connectWithExecutionDeadline(pool: pg.Pool): Promise<pg.PoolClient> {
  const milliseconds = remaining();
  if (milliseconds === null) return pool.connect();
  const pending = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  const client = await Promise.race([
    pending.then(client => { if (expired) { client.release(true); throw new DatabaseExecutionDeadlineError(); } return client; }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new DatabaseExecutionDeadlineError()); }, milliseconds); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  let discard = false, transaction = false, connectionError: Error | null = null;
  const onConnectionError = (error: Error) => { discard = true; connectionError = error; };
  client.on("error", onConnectionError);
  const original = client.query.bind(client);
  return new Proxy(client, {
    get(target, property) {
      if (property === "release") return (destroy?: boolean) => {
        try { client.release(destroy || discard); }
        finally { client.removeListener("error", onConnectionError); }
      };
      if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return async (query: string | pg.QueryConfig, values?: unknown[]) => {
        if (connectionError) throw connectionError;
        const text = typeof query === "string" ? query : query.text;
        // Rollback is cleanup, not a new owner operation. It has its own small,
        // bounded physical drain and cannot publish anything.
        const rollback = /^\s*ROLLBACK\b/i.test(text);
        try {
          const left = rollback ? 200 : remaining()!;
          if (!rollback && transaction && !/^\s*SET LOCAL statement_timeout\b/i.test(text)) {
            const timeoutQuery: pg.QueryConfig & { query_timeout: number } = { text: `SET LOCAL statement_timeout = ${left}`, query_timeout: left };
            await original(timeoutQuery);
          }
          const boundedText = /^\s*SET LOCAL statement_timeout\b/i.test(text) ? `SET LOCAL statement_timeout = ${left}` : text;
          const boundedQuery: pg.QueryConfig & { query_timeout: number } = { ...(typeof query === "string" ? {} : query), text: boundedText,
            ...(values ? { values } : {}), query_timeout: left };
          const result = await original(boundedQuery);
          if (/^\s*BEGIN\b/i.test(text)) transaction = true;
          if (/^\s*(COMMIT|ROLLBACK)\b/i.test(text)) transaction = false;
          return result;
        } catch (error) {
          if (error instanceof DatabaseExecutionDeadlineError || (error as { code?: string }).code === "57014" ||
            /Query read timeout/.test((error as Error).message)) {
            discard = true; throw new DatabaseExecutionDeadlineError();
          }
          throw error;
        }
      };
    },
  });
}
