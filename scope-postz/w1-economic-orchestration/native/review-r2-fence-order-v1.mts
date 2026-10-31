/** Failure-first R2 driver v2 (remaining-roots-failure-contract-v1.md).
 * Two real concurrent sessions on a real disposable migrated PostgreSQL.
 * Session A executes the fence-first owner order with every statement
 * extracted verbatim by string markers from the current sources:
 *   lockTenantMaterialCutTx call (packages/db/index.ts transitionWorkTx),
 *   the works UPDATE (transitionWorkTx), then the ObjectiveLoop step/query
 *   counter UPDATE (objective-loop.ts, the worker continuation).
 * Session B executes the real rearm order extracted from
 * beginWorkQueryExecution/objectiveEconomicReadOriginTx: the claim-path
 * material fence (present only after the repair), the loop FOR NO KEY UPDATE,
 * the works FOR NO KEY UPDATE, then the rearm's workObjectiveLoops UPDATE
 * (with its real work_objective_steps subselect).
 * FOR NO KEY UPDATE pairs are mutually compatible (iteration 1 finding);
 * the deadlock needs UPDATE-strength locks, which both sides now use.
 * Broken: barrier-interleaved A(works UPDATE held, wants loop) vs B(loop
 * lock held, wants works) -> PostgreSQL deadlock detection aborts one
 * session, SQLSTATE 40P01 = R2_REARM_FENCE_LOCK_ORDER_DEADLOCK (exit 1).
 * Repaired: B takes the material fence before any row lock; sessions
 * serialize; no 40P01 = R2_FENCE_FIRST_REARM_SERIALIZED (exit 0).
 * Exit 2: inconclusive (no fence and no deadlock). */
import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { ownDisposablePostgres, closeDisposablePostgres } from "../../../finnor-os/scripts/postz-w1/disposable-postgres.mjs";

const destination = process.argv[2] ?? "";
assert(isAbsolute(destination) && !existsSync(destination), "NEW_ABSOLUTE_REGRESSION_RECEIPT_REQUIRED");
const root = resolve(import.meta.dirname, "../../..");
const dbSource = readFileSync(join(root, "finnor-os/packages/db/index.ts"), "utf8");
const loopSource = readFileSync(join(root, "finnor-os/packages/orchestration/src/objective-loop.ts"), "utf8");

const block = (text: string, start: string, end: string) => {
  const a = text.indexOf(start);
  assert(a > 0, "MARKER_CHANGED:" + start.slice(0, 60));
  const b = text.indexOf(end, a);
  assert(b > a, "MARKER_CHANGED:" + end.slice(0, 60));
  return text.slice(a, b + end.length);
};
// The real lockTenantMaterialCutTx requires the db package's scoped handle,
// so execute its verbatim advisory-lock SQL expression on the raw client.
const fenceSql = block(dbSource, "SELECT pg_advisory_xact_lock(hashtextextended('v3-material-cut:'", "0))");
const stripTs = (statement: string) => statement.replaceAll(" as object", "").replaceAll("[0]!", "[0]");
const aWorksUpdate = stripTs(block(dbSource, "await db.update(schema.works).set({\n    status: toStatus,", ".where(eq(schema.works.id, workId));"));
const aLoopUpdate = block(loopSource, "await db.update(workObjectiveLoops).set({ stepCount: loop.stepCount + 1, queryCount: loop.queryCount + 1, updatedAt: new Date() })",
  ".where(eq(workObjectiveLoops.id, loop.id));");
const beginStart = dbSource.indexOf("export async function beginWorkQueryExecution");
const beginEnd = dbSource.indexOf("export async function recordWorkQueryResponse", beginStart);
const beginBody = dbSource.slice(beginStart, beginEnd);
const fenceFirst = beginBody.includes("await lockTenantMaterialCutTx(db, params.tenantId);");
const bFence = fenceFirst ? "FENCE" : null;
const bLoopFnku = block(dbSource, "await db.execute(sql`SELECT id FROM ${schema.workObjectiveLoops} WHERE tenant_id=${scope.tenantId} AND id=${stepIdentity.loopId} FOR NO KEY UPDATE`);", ";");
const bWorksFnku = block(dbSource, "await db.execute(sql`SELECT id FROM ${schema.works} WHERE tenant_id=${scope.tenantId} AND id=${scope.workId} FOR NO KEY UPDATE`);", ";");
const bRearmUpdate = stripTs(block(dbSource, "const [spent] = await db.update(schema.workObjectiveLoops).set({", ".returning({ id: schema.workObjectiveLoops.id });"));

const scratch = mkdtempSync(join(tmpdir(), "finnor-w1-r2-"));
const owned = ownDisposablePostgres(scratch, join(scratch, "db"), destination + ".cleanup.json");
try {
const port = await new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const requireFinnor = createRequire(join(root, "finnor-os/package.json"));
const embeddedModule = requireFinnor("embedded-postgres");
const EmbeddedPostgres = embeddedModule.default ?? embeddedModule;
const database = owned.attach(new EmbeddedPostgres({ databaseDir: join(scratch, "db"), user: "finnor", password: "finnor", port,
  persistent: true, postgresFlags: ["-c", "listen_addresses=127.0.0.1"], onLog: () => undefined, onError: () => undefined }));
await database.initialise(); await database.start();
await database.createDatabase("w1_r2");
process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
const { migrate } = await import("../../../finnor-os/packages/db/migrate");
await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/w1_r2`);
const url = `postgres://finnor:finnor@127.0.0.1:${port}/w1_r2`;
const dbModule = await import("../../../finnor-os/packages/db/index");
const { lockTenantMaterialCutTx, workObjectiveLoops, workObjectiveSteps, works, tenants } = dbModule as never as Record<string, any>;
const pg = requireFinnor("pg");
const { drizzle } = requireFinnor("drizzle-orm/node-postgres");
const drizzleOrm = requireFinnor("drizzle-orm");
const { sql, and, eq, lt } = drizzleOrm;

const tenantId = randomUUID(), workId = randomUUID(), loopId = randomUUID(), stepId = randomUUID();
{
  const seed = new pg.Client({ connectionString: url });
  await seed.connect();
  await seed.query("INSERT INTO finnor_os.tenants (id, name) VALUES ($1, 'w1-r2')", [tenantId]);
  await seed.query("INSERT INTO finnor_os.works (id, tenant_id, initial_channel, initial_instruction) VALUES ($1, $2, 'text', 'r2')", [workId, tenantId]);
  await seed.query("INSERT INTO finnor_os.work_objective_loops (id, tenant_id, work_id, objective, initial_channel, success_condition, query_count, max_queries, node_attempt_count, max_node_attempts) VALUES ($1, $2, $3, 'r2', 'text', '{}'::jsonb, 0, 10, 0, 10)", [loopId, tenantId, workId]);
  await seed.query("INSERT INTO finnor_os.work_objective_steps (id, tenant_id, work_id, objective_loop_id, step_number, idempotency_key, phase) VALUES ($1, $2, $3, $4, 1, 'w1-r2', 'inspecting')", [stepId, tenantId, workId, loopId]);
  await seed.end();
}

let aReady!: () => void, bHeld!: () => void;
const aReadyP = new Promise<void>((r) => { aReady = r; });
const bHeldP = new Promise<void>((r) => { bHeld = r; });
const schema = { works, workObjectiveLoops, workObjectiveSteps };
const jsonObject = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const runSession = async (name: string, statements: string[], onHeld: number) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const db = drizzle(client);
  const scope = { tenantId, workId };
  const stepIdentity = { loopId };
  const params = { loop: { id: loopId }, tenantId, objectiveClaim: { stepId } };
  const loop = { id: loopId, stepCount: 0, queryCount: 0 };
  const toStatus = "executing";
  const patch: Record<string, unknown> = {};
  const work = { activeContext: null };
  let deadlock = false;
  let errorText = "";
  try {
    await client.query("BEGIN");
    for (let i = 0; i < statements.length; i += 1) {
      if (statements[i] === "FENCE") {
        await client.query(fenceSql, [tenantId]);
      } else
      await new Function("db", "sql", "and", "eq", "lt", "schema", "workObjectiveLoops", "lockTenantMaterialCutTx",
        "tenantId", "workId", "scope", "stepIdentity", "params", "loop", "toStatus", "patch", "work", "jsonObject",
        `return (async () => { ${statements[i]!} })()`)(
        db, sql, and, eq, lt, schema, workObjectiveLoops, lockTenantMaterialCutTx,
        tenantId, workId, scope, stepIdentity, params, loop, toStatus, patch, work, jsonObject);
      if (i === onHeld) {
        if (name === "A") aReady(); else bHeld();
        const peer = name === "A" ? bHeldP : aReadyP;
        await Promise.race([peer, new Promise((r) => setTimeout(r, 3000))]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    const anyError = error as { code?: string; cause?: { code?: string; message?: string } };
    deadlock = anyError.code === "40P01" || anyError.cause?.code === "40P01";
    errorText = (anyError.cause?.message ?? (error instanceof Error ? error.message : String(error))).slice(0, 220);
    try { await client.query("ROLLBACK"); } catch { /* aborted */ }
  } finally {
    await client.end().catch(() => undefined);
  }
  return { name, deadlock, errorText };
};

const [a, b] = await Promise.all([
  runSession("A", ["FENCE", aWorksUpdate, aLoopUpdate], 1),
  runSession("B", bFence ? [bFence, bLoopFnku, bWorksFnku, bRearmUpdate] : [bLoopFnku, bWorksFnku, bRearmUpdate], bFence ? 1 : 0),
]);
const deadlock = a.deadlock || b.deadlock;
const observed = deadlock ? "R2_REARM_FENCE_LOCK_ORDER_DEADLOCK"
  : fenceFirst ? "R2_FENCE_FIRST_REARM_SERIALIZED" : "R2_INVERSION_PRESENT_UNDETECTED";
const receipt = { schema: "finnor.w1.r2-fence-order.v2", sessions: [a, b], rearmFenceFirst: fenceFirst, observed };
writeFileSync(destination, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ observed, a, b, rearmFenceFirst: fenceFirst }));
process.exitCode = fenceFirst ? deadlock ? 1 : 0 : deadlock ? 1 : 2;
} finally {
  await closeDisposablePostgres(owned, [async () => (await import("../../../finnor-os/packages/db/index")).closePool()]);
}
