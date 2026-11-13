import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool, receiveWork, tenants, transitionWork, users, workAggregate, withTenant } from "@finnor/db";
import { GET as listWorks } from "../../apps/api/app/api/works/route";
import { GET as getWork } from "../../apps/api/app/api/works/[id]/route";
import { POST as retryWork } from "../../apps/api/app/api/works/[id]/retry/route";

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
    });
    const terminalWorkIds: string[] = [];
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const terminal = await receiveWork({
        tenantId: TENANT_ID,
        instruction: `Exclude ${status} Work from active discovery`,
        sessionId,
        channel: "text",
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
