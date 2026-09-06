// GET /api/workflows/runs (Phase 10): real Postgres, real dev-bypass Request, calling
// the route handler's GET directly — proves the response shape and status filtering
// against real workflow_runs/workflow_steps rows, not a mock.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { inArray } from "drizzle-orm";
import { closePool, withTenant, commands, workflowRuns, workflowSteps, integrationOperations, outboxEvents } from "@finnor/db";
import { GET } from "../../apps/api/app/api/workflows/runs/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

function req(qs = ""): Request {
  return new Request(`http://localhost/api/workflows/runs${qs}`, {
    headers: { "x-tenant-id": SEED_TENANT_ID, "x-user-role": "owner" },
  });
}

describe.skipIf(!available)("GET /api/workflows/runs (Phase 10)", () => {
  let runningRunId: string;
  let completedRunId: string;
  let stuckRunId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await seed(DB_URL);

    await withTenant(SEED_TENANT_ID, async (db) => {
      // Idempotent across repeated runs against the real, persistent dev DB: this
      // fixture owns exactly these two idempotencyKeys, so FK-ordered cleanup here
      // scopes strictly to rows created by a prior run of this test.
      const stale = await db
        .select({ id: commands.id })
        .from(commands)
        .where(inArray(commands.idempotencyKey, ["wf-runs-test-1", "wf-runs-test-2", "wf-runs-test-stuck"]));
      const staleCmdIds = stale.map((c) => c.id);
      if (staleCmdIds.length > 0) {
        const staleRuns = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(inArray(workflowRuns.commandId, staleCmdIds));
        const staleRunIds = staleRuns.map((r) => r.id);
        if (staleRunIds.length > 0) {
          const staleSteps = await db.select({ id: workflowSteps.id }).from(workflowSteps).where(inArray(workflowSteps.workflowRunId, staleRunIds));
          const staleStepIds = staleSteps.map((s) => s.id);
          if (staleStepIds.length > 0) {
            await db.delete(integrationOperations).where(inArray(integrationOperations.workflowStepId, staleStepIds));
            await db.delete(outboxEvents).where(inArray(outboxEvents.workflowStepId, staleStepIds));
          }
          await db.delete(workflowSteps).where(inArray(workflowSteps.workflowRunId, staleRunIds));
        }
        await db.delete(workflowRuns).where(inArray(workflowRuns.commandId, staleCmdIds));
        await db.delete(commands).where(inArray(commands.id, staleCmdIds));
      }

      const [cmd1] = await db
        .insert(commands)
        .values({ tenantId: SEED_TENANT_ID, commandType: "record_finding", payload: {}, idempotencyKey: "wf-runs-test-1" })
        .returning();
      const [runningRun] = await db
        .insert(workflowRuns)
        .values({ tenantId: SEED_TENANT_ID, commandId: cmd1!.id, workflowType: "private_equity_diligence", status: "running" })
        .returning();
      runningRunId = runningRun!.id;
      await db.insert(workflowSteps).values([
        { tenantId: SEED_TENANT_ID, workflowRunId: runningRunId, stepType: "schedule_visit", sequence: 1, status: "completed", idempotencyKey: "step-1" },
        { tenantId: SEED_TENANT_ID, workflowRunId: runningRunId, stepType: "notify_customer", sequence: 2, status: "leased", idempotencyKey: "step-2" },
      ]);

      const [cmd2] = await db
        .insert(commands)
        .values({ tenantId: SEED_TENANT_ID, commandType: "record_finding", payload: {}, idempotencyKey: "wf-runs-test-2" })
        .returning();
      const [completedRun] = await db
        .insert(workflowRuns)
        .values({ tenantId: SEED_TENANT_ID, commandId: cmd2!.id, workflowType: "private_equity_diligence", status: "completed" })
        .returning();
      completedRunId = completedRun!.id;
      await db.insert(workflowSteps).values([
        { tenantId: SEED_TENANT_ID, workflowRunId: completedRunId, stepType: "schedule_visit", sequence: 1, status: "completed", idempotencyKey: "step-3" },
      ]);

      const [cmd3] = await db
        .insert(commands)
        .values({ tenantId: SEED_TENANT_ID, commandType: "record_finding", payload: {}, idempotencyKey: "wf-runs-test-stuck" })
        .returning();
      const [stuckRun] = await db
        .insert(workflowRuns)
        .values({ tenantId: SEED_TENANT_ID, commandId: cmd3!.id, workflowType: "single_action", status: "running", updatedAt: new Date(Date.now() - 16 * 60_000) })
        .returning();
      stuckRunId = stuckRun!.id;
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("returns running runs first plus recent terminal runs, each with ordered steps", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ id: string; status: string; version: number; watchdogFlagged: boolean; steps: Array<{ sequence: number; status: string }> }> };
    const running = body.runs.find((r) => r.id === runningRunId);
    const completed = body.runs.find((r) => r.id === completedRunId);
    expect(running).toBeDefined();
    expect(completed).toBeDefined();
    expect(running!.steps.map((s) => s.sequence)).toEqual([1, 2]);
    expect(running!.steps[1]!.status).toBe("leased");
    // Phase 7 (§7.2): the cockpit's run controls need this to condition their
    // optimistic-concurrency UPDATE — a fresh run defaults to version 1.
    expect(running!.version).toBe(1);
    expect(running!.watchdogFlagged).toBe(false);
    expect(body.runs.find((r) => r.id === stuckRunId)!.watchdogFlagged).toBe(true);
  });

  it("?status=running filters to only running runs", async () => {
    const res = await GET(req("?status=running"));
    const body = (await res.json()) as { runs: Array<{ id: string; status: string }> };
    expect(body.runs.every((r) => r.status === "running")).toBe(true);
    expect(body.runs.some((r) => r.id === runningRunId)).toBe(true);
    expect(body.runs.some((r) => r.id === completedRunId)).toBe(false);
  });

  it("rejects requests without tenant context", async () => {
    const res = await GET(new Request("http://localhost/api/workflows/runs"));
    expect(res.status).toBe(401);
  });
});
