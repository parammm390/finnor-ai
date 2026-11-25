import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { migrate } from "../../packages/db/migrate";
import { and, inArray } from "drizzle-orm";
import { closePool, domainActions, employeeConversationThreads, MAX_BACKGROUND_SCAN_BATCH, receiveWork, tenants, transitionWork, users, withTenant, workEvents, works } from "@finnor/db";
import { workCasesPage } from "@finnor/read-models";
import { GET as listThreads } from "../../apps/api/app/api/threads/route";
import { GET as listPendingActions } from "../../apps/api/app/api/actions/pending/route";
import { GET as listActivity } from "../../apps/api/app/api/activity/route";
import { POST as cancelInstruction } from "../../apps/api/app/api/instructions/[id]/cancel/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT = randomUUID();
const OWNER = randomUUID();

// PostgreSQL stores these three instants apart; a JavaScript Date cannot. The
// earliest instant goes to the highest id, so a boundary that compares the wrong
// key also loses rows.
const ONE_MILLISECOND = ["2026-03-01T09:00:00.123100Z", "2026-03-01T09:00:00.123500Z", "2026-03-01T09:00:00.123900Z"];
const idsAgainstTime = (ids: string[] = ONE_MILLISECOND.map(() => randomUUID())) => [...ids].sort().reverse();

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

function request(path: string, params: Record<string, string | undefined>): Request {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return new Request(url, { headers: { "x-tenant-id": TENANT, "x-user-id": OWNER, "x-user-role": "owner" } });
}

async function drain(page: (cursor: string | undefined) => Promise<{ ids: string[]; next: string | null }>): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let call = 0; call < 20; call++) {
    const result = await page(cursor);
    seen.push(...result.ids);
    if (!result.next || result.ids.length === 0) return seen;
    cursor = result.next;
  }
  throw new Error(`pagination did not finish after 20 pages: ${seen.join(", ")}`);
}

function expectEachOnceInOrder(seen: string[], expected: string[]): void {
  expect([...seen].sort(), "every row exactly once").toEqual([...expected].sort());
  expect(seen, "in page order").toEqual(expected);
}

const available = await databaseAvailable();

describe.skipIf(!available)("keyset pages keep every row that shares a millisecond", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT, db => db.insert(tenants).values({ id: TENANT, name: "Keyset pagination" }));
    await withTenant(TENANT, db => db.insert(users).values({ id: OWNER, tenantId: TENANT, role: "owner", email: `keyset-${OWNER}@example.test` }));
  });

  afterAll(async () => { await closePool(); });

  it("returns each Investigation once, newest first, one per page", async () => {
    const threadIds = idsAgainstTime();
    await withTenant(TENANT, db => db.insert(employeeConversationThreads).values(threadIds.map((id, index) => ({
      id, tenantId: TENANT, ownerEmployeeId: OWNER, title: `Investigation ${index}`,
      lastActivityAt: sql`${ONE_MILLISECOND[index]}::timestamptz`,
    }))), OWNER);
    const seen = await drain(async (cursor) => {
      const response = await listThreads(request("/api/threads", { limit: "1", cursor }));
      expect(response.status).toBe(200);
      const body = await response.json() as { threads: Array<{ id: string }>; nextCursor: string | null };
      return { ids: body.threads.map(thread => thread.id), next: body.nextCursor };
    });
    expectEachOnceInOrder(seen, [...threadIds].reverse());
  });

  it("returns each Work case once, one per page", async () => {
    const received: string[] = [];
    for (const index of ONE_MILLISECOND.keys()) {
      received.push((await receiveWork({ tenantId: TENANT, instruction: `Keyset Work ${index}`, instructionId: randomUUID(), channel: "text", userId: OWNER })).workId);
    }
    const workIds = idsAgainstTime(received);
    for (const [index, id] of workIds.entries()) {
      await withTenant(TENANT, db => db.update(works).set({ updatedAt: sql`${ONE_MILLISECOND[index]}::timestamptz` }).where(eq(works.id, id)));
    }
    const seen = await drain(async (cursor) => {
      const page = await workCasesPage(TENANT, { limit: 1, cursor, employeeId: OWNER });
      return { ids: page.items.map(item => item.root.id), next: page.page.nextCursor };
    });
    expectEachOnceInOrder(seen.filter(id => workIds.includes(id)), [...workIds].reverse());
  });

  it("returns each pending approval once, newest first, one per page", async () => {
    const actionIds = idsAgainstTime();
    await withTenant(TENANT, db => db.insert(domainActions).values(actionIds.map((id, index) => ({
      id, tenantId: TENANT, actionType: "record_finding", payload: {}, status: "pending" as const,
      summary: `Approval ${index}`, createdAt: sql`${ONE_MILLISECOND[index]}::timestamptz`,
    }))));
    const seen = await drain(async (cursor) => {
      const response = await listPendingActions(request("/api/actions/pending", { limit: "1", cursor }));
      expect(response.status).toBe(200);
      const body = await response.json() as { actions: Array<{ id: string }>; page: { nextCursor: string | null } };
      return { ids: body.actions.map(action => action.id), next: body.page.nextCursor };
    });
    expectEachOnceInOrder(seen, [...actionIds].reverse());
  });

  it("returns each activity item once, oldest first, one per poll", async () => {
    const received = await receiveWork({ tenantId: TENANT, instruction: "Keyset activity", instructionId: randomUUID(), channel: "text", userId: OWNER });
    const eventIds = idsAgainstTime();
    await withTenant(TENANT, db => db.insert(workEvents).values(eventIds.map((id, index) => ({
      id, tenantId: TENANT, workId: received.workId, seq: 1_000 + index, eventType: "keyset_probe",
      toStatus: "received" as const, createdAt: sql`${ONE_MILLISECOND[index]}::timestamptz`,
    }))));
    const seen = await drain(async (cursor) => {
      const response = await listActivity(request("/api/activity", { limit: "1", since: cursor }));
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      return { ids: body.items.map(item => item.id), next: body.nextCursor };
    });
    expectEachOnceInOrder(seen.filter(id => eventIds.includes(id)), eventIds);
  });

  it("rejects every draft action of a cancelled instruction when a whole page shares one transaction timestamp", async () => {
    const instructionId = randomUUID();
    const received = await receiveWork({ tenantId: TENANT, instruction: "Keyset cancellation", instructionId, channel: "text", userId: OWNER });
    await transitionWork(TENANT, received.workId, "planning", "planning_started", {}, { expectedWorkInputId: received.workInputId });
    const draftIds = Array.from({ length: MAX_BACKGROUND_SCAN_BATCH + 1 }, () => randomUUID());
    await withTenant(TENANT, db => db.insert(domainActions).values(draftIds.map(id => ({
      id, tenantId: TENANT, workId: received.workId, instructionId, actionType: "record_finding", payload: {},
      status: "draft" as const, createdAt: sql`${ONE_MILLISECOND[1]}::timestamptz`,
    }))));
    const response = await cancelInstruction(new Request(`http://localhost/api/instructions/${instructionId}/cancel`, {
      method: "POST", headers: { "x-tenant-id": TENANT, "x-user-id": OWNER, "x-user-role": "owner" },
    }), { params: Promise.resolve({ id: instructionId }) });
    expect(response.status).toBe(200);
    const rejected = await withTenant(TENANT, db => db.select({ id: domainActions.id }).from(domainActions)
      .where(and(inArray(domainActions.id, draftIds), eq(domainActions.status, "rejected"))));
    expect(rejected).toHaveLength(draftIds.length);
  }, 20_000);
});

