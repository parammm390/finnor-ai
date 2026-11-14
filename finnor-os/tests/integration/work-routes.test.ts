import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool, receiveWork, tenants, transitionWork, users, works, workAggregate, WorkControlAuthorizationError, withTenant } from "@finnor/db";
import { GET as listWorks } from "../../apps/api/app/api/works/route";
import { GET as getWork } from "../../apps/api/app/api/works/[id]/route";
import { GET as getWorkObjective } from "../../apps/api/app/api/works/[id]/objective/route";
import { GET as getWorkExecution } from "../../apps/api/app/api/works/[id]/execution/route";
import { GET as getWorkReplay } from "../../apps/api/app/api/works/[id]/replay/route";
import { eq } from "drizzle-orm";
import { POST as retryWork } from "../../apps/api/app/api/works/[id]/retry/route";
import { POST as controlObjective } from "../../apps/api/app/api/works/[id]/objective/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000093f2";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000093f3";
const RECOVERY_OWNER_ID = randomUUID();
const RECOVERY_PEER_ID = randomUUID();

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await dbUp();

function request(path: string, tenantId = TENANT_ID, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-role": "owner", "x-user-id": RECOVERY_OWNER_ID, ...init?.headers },
  });
}

describe.skipIf(!available)("durable Work APIs", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Work Route Dealer" }).onConflictDoNothing());
    await withTenant(OTHER_TENANT_ID, (db) => db.insert(tenants).values({ id: OTHER_TENANT_ID, name: "Other Work Route Dealer" }).onConflictDoNothing());
    await withTenant(TENANT_ID, db => db.insert(users).values([
      { id: RECOVERY_OWNER_ID, tenantId: TENANT_ID, role: "owner", email: `work-route-owner-${RECOVERY_OWNER_ID}@example.test` },
      { id: RECOVERY_PEER_ID, tenantId: TENANT_ID, role: "dispatcher", email: `work-route-peer-${RECOVERY_PEER_ID}@example.test` },
    ]));
  });

  afterAll(async () => {
    await closePool();
  });

  it("lists session-scoped active Work and returns its complete aggregate", async () => {
    const received = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Expose this Work",
      instructionId: randomUUID(),
      sessionId: "work-route-session",
      channel: "text",
      userId: RECOVERY_OWNER_ID,
    });
    const list = await listWorks(request("/api/works?sessionId=work-route-session&active=true"));
    expect(list.status).toBe(200);
    expect((await list.json()).works).toEqual(expect.arrayContaining([expect.objectContaining({ id: received.workId, status: "received" })]));

    const detail = await getWork(request(`/api/works/${received.workId}`), { params: Promise.resolve({ id: received.workId }) });
    expect(detail.status).toBe(200);
    expect((await detail.json()).work).toMatchObject({
      work: { id: received.workId },
      inputs: [expect.objectContaining({ instructionId: received.instructionId })],
      events: [expect.objectContaining({ eventType: "received" })],
    });
  });

  it("filters every terminal Work before applying the active result limit", async () => {
    const sessionId = `active-work-${randomUUID()}`;
    const active = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "Keep this active Work discoverable",
      sessionId,
      channel: "text",
      userId: RECOVERY_OWNER_ID,
    });
    const terminalWorkIds: string[] = [];
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const terminal = await receiveWork({
        tenantId: TENANT_ID,
        instruction: `Exclude ${status} Work from active discovery`,
        sessionId,
        channel: "text",
        userId: RECOVERY_OWNER_ID,
      });
      await transitionWork(
        TENANT_ID,
        terminal.workId,
        status,
        `test_${status}`,
        {},
        status === "failed" ? { failure: { kind: "test" } } : { finalOutcome: { kind: "test" } },
      );
      terminalWorkIds.push(terminal.workId);
    }

    const response = await listWorks(request(`/api/works?sessionId=${sessionId}&active=true`));
    expect(response.status).toBe(200);
    const body = await response.json() as { works: Array<{ id: string; status: string }> };
    expect(body.works).toEqual(expect.arrayContaining([expect.objectContaining({ id: active.workId, status: "received" })]));
    expect(body.works.some((work) => terminalWorkIds.includes(work.id))).toBe(false);
  });

  it("denies same-tenant private Work reads across all five read surfaces until assignment", async () => {
    const sessionId = `private-work-${randomUUID()}`;
    const secret = `private-intake-${randomUUID()}`;
    const ownerWork = await receiveWork({
      tenantId: TENANT_ID, instruction: secret, channel: "text",
      userId: RECOVERY_OWNER_ID, sessionId,
      activeContext: { internalSecret: "private-frozen-work-context" },
    });
    const sharedSessionForeignWork = await receiveWork({
      tenantId: TENANT_ID, instruction: "Peer's own Work", channel: "text",
      userId: RECOVERY_PEER_ID, sessionId,
    });
    const actorHeaders = { "x-user-id": RECOVERY_PEER_ID };
    const peerList = await listWorks(request(`/api/works?sessionId=${sessionId}`, TENANT_ID, { headers: actorHeaders }));
    expect(peerList.status).toBe(200);
    expect(peerList.headers.get("cache-control")).toBe("private, no-store");
    const peerBody = await peerList.json() as { works: Array<{ id: string; initialInstruction: string }> };
    expect(peerBody.works.map(work => work.id)).toContain(sharedSessionForeignWork.workId);
    expect(peerBody.works.map(work => work.id)).not.toContain(ownerWork.workId);
    expect(JSON.stringify(peerBody)).not.toContain(secret);

    const routes = [
      (await getWork(request(`/api/works/${ownerWork.workId}`, TENANT_ID, { headers: actorHeaders }), { params: Promise.resolve({ id: ownerWork.workId }) })),
      (await getWorkObjective(request(`/api/works/${ownerWork.workId}/objective`, TENANT_ID, { headers: actorHeaders }), { params: Promise.resolve({ id: ownerWork.workId }) })),
      (await getWorkExecution(request(`/api/works/${ownerWork.workId}/execution`, TENANT_ID, { headers: actorHeaders }), { params: Promise.resolve({ id: ownerWork.workId }) })),
      (await getWorkReplay(request(`/api/works/${ownerWork.workId}/replay`, TENANT_ID, { headers: actorHeaders }), { params: Promise.resolve({ id: ownerWork.workId }) })),
    ];
    for (const response of routes) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Work not found" });
    }
    const ownerDetail = await getWork(request(`/api/works/${ownerWork.workId}`), { params: Promise.resolve({ id: ownerWork.workId }) });
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.headers.get("cache-control")).toBe("private, no-store");
    const ownerBody = await ownerDetail.json();
    expect(JSON.stringify(ownerBody)).toContain(secret);

    // Assignment is an existing canonical Work relationship, not an invented share grant.
    await withTenant(TENANT_ID, db => db.update(works).set({ assignedTo: RECOVERY_PEER_ID })
      .where(eq(works.id, ownerWork.workId)));
    const assignedList = await listWorks(request(`/api/works?sessionId=${sessionId}`, TENANT_ID, { headers: actorHeaders }));
    expect((await assignedList.json() as { works: Array<{ id: string }> }).works.map(work => work.id)).toContain(ownerWork.workId);
    const assignedDetail = await getWork(request(`/api/works/${ownerWork.workId}`, TENANT_ID, { headers: actorHeaders }), { params: Promise.resolve({ id: ownerWork.workId }) });
    expect(assignedDetail.status).toBe(200);

    // Suspension immediately revokes the assigned person's read access.
    await withTenant(TENANT_ID, db => db.update(users).set({ status: "suspended" })
      .where(eq(users.id, RECOVERY_PEER_ID)));
    const suspendedDetail = await getWork(request(`/api/works/${ownerWork.workId}`, TENANT_ID, { headers: actorHeaders }), { params: Promise.resolve({ id: ownerWork.workId }) });
    expect(suspendedDetail.status).toBe(404);
    const suspendedList = await listWorks(request(`/api/works?sessionId=${sessionId}`, TENANT_ID, { headers: actorHeaders }));
    expect((await suspendedList.json() as { works: Array<{ id: string }> }).works).toHaveLength(0);
    await withTenant(TENANT_ID, db => db.update(users).set({ status: "active" })
      .where(eq(users.id, RECOVERY_PEER_ID)));
  });

  it("does not silently grant a human access to ownerless system Work", async () => {
    const secret = `ownerless-system-work-${randomUUID()}`;
    const received = await receiveWork({
      tenantId: TENANT_ID,
      instruction: secret,
      channel: "console",
      sessionId: `system-session-${randomUUID()}`,
    });
    const detail = await getWork(request(`/api/works/${received.workId}`), {
      params: Promise.resolve({ id: received.workId }),
    });
    expect(detail.status).toBe(404);
    expect(JSON.stringify(await detail.json())).not.toContain(secret);
    const list = await listWorks(request(`/api/works?sessionId=${encodeURIComponent((await workAggregate(TENANT_ID, received.workId))!.work.sessionId as string)}`));
    expect((await list.json() as { works: Array<{ id: string }> }).works.some(row => row.id === received.workId)).toBe(false);
  });

  it("does not expose Work across tenants", async () => {
    const received = await receiveWork({ tenantId: TENANT_ID, instruction: "Private Work", channel: "console" });
    const response = await getWork(request(`/api/works/${received.workId}`, OTHER_TENANT_ID), { params: Promise.resolve({ id: received.workId }) });
    expect(response.status).toBe(404);
  });

  it("never exposes or mutates a different employee's Work on HTTP retry", async () => {
    const received = await receiveWork({
      tenantId: TENANT_ID, instruction: "Recover private employee Work",
      channel: "text", userId: RECOVERY_OWNER_ID,
    });
    await transitionWork(TENANT_ID, received.workId, "failed", "test_failed", { source: "test" },
      { failure: { kind: "test" } });
    const response = await retryWork(request(`/api/works/${received.workId}/retry`, TENANT_ID, {
      method: "POST",
      headers: { "x-user-id": RECOVERY_PEER_ID },
      body: JSON.stringify({ idempotencyKey: "foreign-user-should-not-retry" }),
    }), { params: Promise.resolve({ id: received.workId }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Work not found" });
    expect((await workAggregate(TENANT_ID, received.workId))!.work).toMatchObject({ status: "failed" });
  });

  it("refuses same-tenant objective cancellation and redirect from a different employee", async () => {
    const original = await receiveWork({
      tenantId: TENANT_ID, userId: RECOVERY_OWNER_ID,
      instruction: "Complete the original company's diligence", channel: "text",
    });
    const unauthorized = { "x-user-id": RECOVERY_PEER_ID };
    for (const body of [
      { command: "cancel" },
      { command: "interrupt" },
      { command: "continue" },
      { command: "redirect", objective: "Replace original objective without permission" },
    ]) {
      const response = await controlObjective(request(`/api/works/${original.workId}/objective`, TENANT_ID, {
        method: "POST", headers: unauthorized, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: original.workId }) });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Work not found" });
    }
    const after = await workAggregate(TENANT_ID, original.workId);
    expect(after?.work).toMatchObject({ status: "received" });
    expect(after?.inputs).toHaveLength(1);
  });

  it("checks current ownership before any redirected intake or idempotent replay", async () => {
    const original = await receiveWork({
      tenantId: TENANT_ID, userId: RECOVERY_OWNER_ID,
      instruction: "Deliver the baseline Work outcome", channel: "text",
    });
    const redirected = {
      tenantId: TENANT_ID, workId: original.workId, channel: "text" as const,
      instruction: "Change the Work objective", idempotencyKey: `redirect:${randomUUID()}`,
      requireCurrentEmployeeOwner: true,
    };
    await expect(receiveWork({ ...redirected, userId: RECOVERY_PEER_ID }))
      .rejects.toBeInstanceOf(WorkControlAuthorizationError);
    expect((await workAggregate(TENANT_ID, original.workId))?.inputs).toHaveLength(1);
    const allowed = await receiveWork({ ...redirected, userId: RECOVERY_OWNER_ID });
    expect(allowed).toMatchObject({ workId: original.workId, duplicate: false });
    await expect(receiveWork({ ...redirected, userId: RECOVERY_PEER_ID }))
      .rejects.toBeInstanceOf(WorkControlAuthorizationError);
    expect((await workAggregate(TENANT_ID, original.workId))?.inputs).toHaveLength(2);
  });

  it("rejects retry for a completed Work before invoking the planner", async () => {
    const received = await receiveWork({ tenantId: TENANT_ID, instruction: "Already done", channel: "console", userId: RECOVERY_OWNER_ID });
    await transitionWork(TENANT_ID, received.workId, "completed", "test_completed", {}, { finalOutcome: { kind: "test" } });
    const response = await retryWork(request(`/api/works/${received.workId}/retry`, TENANT_ID, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "completed-work-retry" }),
    }), { params: Promise.resolve({ id: received.workId }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/only failed Work/i);
  });
});
