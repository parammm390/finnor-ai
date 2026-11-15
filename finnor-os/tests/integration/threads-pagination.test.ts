import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  closePool, createEmployeeConversationThread, listEmployeeConversationThreads,
  tenants, users, withTenant,
} from "@finnor/db";
import { GET as listThreads } from "../../apps/api/app/api/threads/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT = randomUUID(), FOREIGN_TENANT = randomUUID();
const OWNER = randomUUID(), PEER = randomUUID(), FOREIGN_OWNER = randomUUID();

async function databaseAvailable() {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; }
  catch { return false; }
}

const available = await databaseAvailable();

function request(cursor?: string, employeeId = OWNER, tenantId = TENANT, limit = 7) {
  const url = new URL("http://localhost/api/threads");
  url.searchParams.set("limit", String(limit));
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  return new Request(url, { headers: {
    "x-tenant-id": tenantId, "x-user-id": employeeId, "x-user-role": "owner",
  } });
}

describe.skipIf(!available)("employee Investigation history keyset pagination", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT, db => db.insert(tenants).values({ id: TENANT, name: "Investigation paging" }));
    await withTenant(FOREIGN_TENANT, db => db.insert(tenants).values({ id: FOREIGN_TENANT, name: "Foreign paging" }));
    await withTenant(TENANT, db => db.insert(users).values([
      { id: OWNER, tenantId: TENANT, email: `page-owner-${OWNER}@example.test`, role: "owner" },
      { id: PEER, tenantId: TENANT, email: `page-peer-${PEER}@example.test`, role: "owner" },
    ]));
    await withTenant(FOREIGN_TENANT, db => db.insert(users).values({
      id: FOREIGN_OWNER, tenantId: FOREIGN_TENANT,
      email: `page-foreign-${FOREIGN_OWNER}@example.test`, role: "owner",
    }));
    for (let index = 0; index < 36; index++) {
      await createEmployeeConversationThread({
        tenantId: TENANT, ownerEmployeeId: OWNER, title: `Investigation ${index}`,
      });
    }
    await createEmployeeConversationThread({
      tenantId: TENANT, ownerEmployeeId: PEER, title: "Peer private Investigation",
    });
    await createEmployeeConversationThread({
      tenantId: FOREIGN_TENANT, ownerEmployeeId: FOREIGN_OWNER, title: "Foreign private Investigation",
    });
  });

  afterAll(async () => { await closePool(); });

  it("recovers all 36 threads without duplicates or omissions, preserving canonical descending order", async () => {
    const expected = (await listEmployeeConversationThreads(TENANT, OWNER, 100)).map(thread => thread.id);
    expect(expected).toHaveLength(36);
    const actual: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 8; page++) {
      const response = await listThreads(request(cursor ?? undefined));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json() as {
        threads: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(body.threads.length).toBeGreaterThan(0);
      expect(body.threads.length).toBeLessThanOrEqual(7);
      actual.push(...body.threads.map(thread => thread.id));
      if (!body.nextCursor) break;
      expect(seenCursors.has(body.nextCursor)).toBe(false);
      seenCursors.add(body.nextCursor);
      cursor = body.nextCursor;
    }
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(36);
  });

  it("rejects malformed cursors instead of treating them as page 1", async () => {
    for (const invalid of ["", "not-a-cursor", "x".repeat(513), "%%%"]) {
      const response = await listThreads(request(invalid));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid Investigations page cursor" });
    }
    expect((await listThreads(request(undefined, OWNER, TENANT, 0))).status).toBe(400);
  });

  it("never treats another employee's or tenant's cursor as a share grant", async () => {
    const first = await listThreads(request());
    expect(first.status).toBe(200);
    const { nextCursor } = await first.json() as { nextCursor: string };
    expect(nextCursor).toBeTruthy();
    const peerPage = await listThreads(request(nextCursor, PEER));
    const foreignPage = await listThreads(request(nextCursor, FOREIGN_OWNER, FOREIGN_TENANT));
    expect(peerPage.status).toBe(200);
    expect(foreignPage.status).toBe(200);
    expect((await peerPage.json()).threads).toEqual([]);
    expect((await foreignPage.json()).threads).toEqual([]);
    expect((await listThreads(request(undefined, PEER))).status).toBe(200);
  });
});
