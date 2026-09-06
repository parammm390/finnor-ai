// D2.T4 acceptance: POST /api/actions/:id/revert — honest undo. approved -> pending
// ONLY while the row is still "approved" (the atomic conditional UPDATE, keyed on
// status since domain_actions has no version column, IS the optimistic-concurrency
// guard); once claimed for execution (any other status), it truthfully 409s instead
// of pretending to succeed. Real architectural note tested here too: this route is
// reached via seeding a row directly at status="approved" (bypassing decide(), which
// in production chains straight into runAction() and claims "executing" in the same
// request — see the route file's own header for the full writeup) so the "still
// approved" case is actually exercisable in a test, the same way rbac-approval.test.ts
// drives the real HTTP handler directly rather than only unit-testing canApprove().

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, domainActions, actionLog, rolePermissions } from "@finnor/db";
import { eq, and } from "drizzle-orm";
import { POST as revertPOST } from "../../apps/api/app/api/actions/[id]/revert/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ea";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000000eb";

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

function req(tenantId: string, role: string, body: unknown = {}): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "x-tenant-id": tenantId, "x-user-role": role, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedAction(tenantId: string, status: "approved" | "pending" | "executing" | "completed", actionType = "send_service_reminder"): Promise<string> {
  const [row] = await withTenant(tenantId, (db) => db.insert(domainActions).values({ tenantId, actionType, payload: {}, status, summary: "revert test" }).returning());
  return row!.id;
}

async function actionStatus(tenantId: string, id: string): Promise<string> {
  const [row] = await withTenant(tenantId, (db) => db.select({ status: domainActions.status }).from(domainActions).where(eq(domainActions.id, id)));
  return row!.status;
}

describe.skipIf(!available)("POST /api/actions/:id/revert (D2.T4)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await getPoolInsertTenants();
    await withTenant(TENANT_ID, (db) =>
      db.insert(rolePermissions).values([{ tenantId: TENANT_ID, role: "owner", actionType: "*", canApprove: true }]).onConflictDoNothing(),
    );
  });

  async function getPoolInsertTenants(): Promise<void> {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Revert Test'), ($2, 'Revert Test Other') ON CONFLICT (id) DO NOTHING`, [TENANT_ID, OTHER_TENANT_ID]);
    await c.end();
  }

  // No row cleanup: action_log is append-only (a DB trigger enforces it, see §1's
  // "Audit immutability" ground truth) and domain_actions rows it references can't be
  // deleted either as a result — same reason rbac-approval.test.ts's afterAll only
  // closes the pool. TENANT_ID/OTHER_TENANT_ID are dedicated to this file, so leftover
  // rows never leak into another test's assertions.
  afterAll(async () => {
    await closePool();
  });

  it("reverts approved -> pending while genuinely unclaimed, and logs the revert", async () => {
    const id = await seedAction(TENANT_ID, "approved");
    const res = await revertPOST(req(TENANT_ID, "owner"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "pending", reverted: true });
    expect(await actionStatus(TENANT_ID, id)).toBe("pending");

    const [logRow] = await withTenant(TENANT_ID, (db) =>
      db.select().from(actionLog).where(and(eq(actionLog.domainActionId, id), eq(actionLog.step, "reverted"))),
    );
    expect(logRow).toBeDefined();
  });

  it("honestly 409s — already claimed — for an action that's executing, and does NOT change its status", async () => {
    const id = await seedAction(TENANT_ID, "executing");
    const res = await revertPOST(req(TENANT_ID, "owner"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("executing");
    expect(body.error).toMatch(/already been claimed/);
    expect(await actionStatus(TENANT_ID, id)).toBe("executing");
  });

  it("honestly 409s for an action that never left pending (nothing to undo)", async () => {
    const id = await seedAction(TENANT_ID, "pending");
    const res = await revertPOST(req(TENANT_ID, "owner"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    expect(await actionStatus(TENANT_ID, id)).toBe("pending");
  });

  it("404s for an action that doesn't exist", async () => {
    const res = await revertPOST(req(TENANT_ID, "owner"), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) });
    expect(res.status).toBe(404);
  });

  it("RBAC: a role without canApprove on this action_type is rejected 403, status unchanged", async () => {
    const id = await seedAction(TENANT_ID, "approved");
    const res = await revertPOST(req(TENANT_ID, "analyst"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(403);
    expect(await actionStatus(TENANT_ID, id)).toBe("approved");
  });

  it("tenant isolation: tenant B cannot revert tenant A's action (404, not leaked)", async () => {
    const id = await seedAction(TENANT_ID, "approved");
    const res = await revertPOST(req(OTHER_TENANT_ID, "owner"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect(await actionStatus(TENANT_ID, id)).toBe("approved");
  });

  it("racing the same revert twice — only the first wins (atomic conditional UPDATE, no double-revert)", async () => {
    const id = await seedAction(TENANT_ID, "approved");
    const [first, second] = await Promise.all([revertPOST(req(TENANT_ID, "owner"), { params: Promise.resolve({ id }) }), revertPOST(req(TENANT_ID, "owner"), { params: Promise.resolve({ id }) })]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await actionStatus(TENANT_ID, id)).toBe("pending");
  });
});
