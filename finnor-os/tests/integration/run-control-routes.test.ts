// Phase 2 (§2.7) run-control API routes: owner-only RBAC, body validation, and
// result->status mapping (200/403/400/404/409), one test per verb's route.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants } from "@finnor/db";
import { submitCommand } from "@finnor/workflow-runtime";
import { POST as pauseRoute } from "../../apps/api/app/api/workflows/runs/[id]/pause/route";
import { POST as resumeRoute } from "../../apps/api/app/api/workflows/runs/[id]/resume/route";
import { POST as cancelRoute } from "../../apps/api/app/api/workflows/runs/[id]/cancel/route";
import { POST as retryRoute } from "../../apps/api/app/api/workflows/runs/[id]/retry/route";
import { POST as escalateRoute } from "../../apps/api/app/api/workflows/runs/[id]/escalate/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ec";

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

function req(url: string, opts: { role?: string; body?: unknown } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "x-tenant-id": TENANT_ID, "x-user-role": opts.role ?? "owner", "content-type": "application/json" },
    body: JSON.stringify(opts.body ?? { expectedVersion: 1 }),
  });
}

async function newRun(): Promise<string> {
  const submitted = await withTenant(TENANT_ID, (db) =>
    submitCommand(db, {
      tenantId: TENANT_ID,
      commandType: "run_control_routes_test",
      payload: {},
      workflowType: "run_control_routes_test",
      steps: [{ stepType: "step_a", payload: {} }],
    }),
  );
  return submitted.workflowRunId;
}

describe.skipIf(!available)("run-control routes (§2.7)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Run Control Routes Test Dealer" }).onConflictDoNothing());
  });
  afterAll(async () => {
    await closePool();
  });

  it("pause: non-owner gets 403, owner gets 200, malformed body gets 400", async () => {
    const runId = await newRun();
    const forbidden = await pauseRoute(req(`/api/workflows/runs/${runId}/pause`, { role: "analyst" }), { params: Promise.resolve({ id: runId }) });
    expect(forbidden.status).toBe(403);

    const badBody = await pauseRoute(req(`/api/workflows/runs/${runId}/pause`, { body: { expectedVersion: "not-a-number" } }), { params: Promise.resolve({ id: runId }) });
    expect(badBody.status).toBe(400);

    const ok = await pauseRoute(req(`/api/workflows/runs/${runId}/pause`), { params: Promise.resolve({ id: runId }) });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.run.status).toBe("paused");
  });

  it("pause on an unknown run id is 404", async () => {
    const res = await pauseRoute(req(`/api/workflows/runs/00000000-0000-4000-9000-000000000abc/pause`), {
      params: Promise.resolve({ id: "00000000-0000-4000-9000-000000000abc" }),
    });
    expect(res.status).toBe(404);
  });

  it("resume: 200 from paused, 409 (illegal transition) from running", async () => {
    const runId = await newRun();
    await pauseRoute(req(`/api/workflows/runs/${runId}/pause`), { params: Promise.resolve({ id: runId }) });
    const ok = await resumeRoute(req(`/api/workflows/runs/${runId}/resume`, { body: { expectedVersion: 2 } }), { params: Promise.resolve({ id: runId }) });
    expect(ok.status).toBe(200);

    const runId2 = await newRun();
    const illegal = await resumeRoute(req(`/api/workflows/runs/${runId2}/resume`), { params: Promise.resolve({ id: runId2 }) });
    expect(illegal.status).toBe(409);
    const body = await illegal.json();
    expect(body.error).toBe("illegal_transition");
  });

  it("cancel: 200 from running, 409 on a stale version", async () => {
    const runId = await newRun();
    const stale = await cancelRoute(req(`/api/workflows/runs/${runId}/cancel`, { body: { expectedVersion: 99 } }), { params: Promise.resolve({ id: runId }) });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json();
    expect(staleBody.error).toBe("version_conflict");

    const ok = await cancelRoute(req(`/api/workflows/runs/${runId}/cancel`), { params: Promise.resolve({ id: runId }) });
    expect(ok.status).toBe(200);
  });

  it("retry: 409 (illegal transition) on a run that never failed", async () => {
    const runId = await newRun();
    const res = await retryRoute(req(`/api/workflows/runs/${runId}/retry`), { params: Promise.resolve({ id: runId }) });
    expect(res.status).toBe(409);
  });

  it("escalate: 200 from running", async () => {
    const runId = await newRun();
    const res = await escalateRoute(req(`/api/workflows/runs/${runId}/escalate`), { params: Promise.resolve({ id: runId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.status).toBe("escalated");
  });
});
