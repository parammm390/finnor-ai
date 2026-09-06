// POST /api/admin/migrate — runs migrations + seed server-side, where the database
// credentials live (Vercel-injected POSTGRES_URL). Guarded by ADMIN_SECRET; used
// exactly like a CI migrate step, never from application code paths.

import { migrate } from "@finnor/db/migrate";
import { MIGRATIONS } from "@finnor/db/migrations-bundle";
import { seed, SEED_TENANT_ID } from "@finnor/db/seed";
import { pgConnectionConfig } from "@finnor/db";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers.get("x-admin-secret") !== secret) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  // Phase 8 (§8.1): DATABASE_URL now points at the restricted, least-privilege
  // finnor_app role (no DDL rights, by design — see migration 0032) so migrations
  // need a distinct, still-owner-level connection. MIGRATIONS_DATABASE_URL is that
  // escape hatch; falling back to DATABASE_URL keeps every environment that hasn't
  // set it (local dev, CI, any not-yet-migrated deployment) working exactly as before.
  const url =
    process.env.MIGRATIONS_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL;
  if (!url) return Response.json({ error: "No database configured" }, { status: 500 });
  try {
    const applied = await migrate(url, MIGRATIONS);
    await seed(url);
    // Critical finding (2026-07-22): nothing in the deploy pipeline ever provisioned
    // the finnor_langgraph checkpoint schema against a real staging/prod database —
    // graph/setup.ts's own header says "run once in CI right after db:migrate", but
    // that was only ever wired into CI's ephemeral test Postgres (.github/workflows/
    // ci.yml), never staging or prod. Every graph-routed action type
    // legacy action/workflow rows crashed with
    // `relation "finnor_langgraph.checkpoints" does not exist` the moment it was
    // actually invoked. Runs against the SAME migrations-capable connection as
    // migrate() above (a dedicated pool, not the shared getPool()/DATABASE_URL,
    // which may be the restricted finnor_app role after A5's eventual role cutover)
    // — PostgresSaver.setup() is idempotent, safe on every future call here.
    const migrationsPool = new pg.Pool(pgConnectionConfig(url));
    try {
      await new PostgresSaver(migrationsPool, undefined, { schema: "finnor_langgraph" }).setup();
    } finally {
      await migrationsPool.end();
    }
    return Response.json({ ok: true, applied, seededTenant: SEED_TENANT_ID, langGraphSchemaReady: true });
  } catch (err) {
    console.error("[admin/migrate]", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
