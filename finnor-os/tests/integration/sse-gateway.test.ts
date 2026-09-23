// B1 EXIT GATE: "SSE event within 2s of a Dealer Zero action (curl pasted)". This test
// is the real, local equivalent — a genuine http.Server (the actual createSseGateway(),
// not a mock), a genuine EventSource-shaped SSE client reading raw response bytes, a
// real jarvis_events LISTEN connection, and a real domain_actions insert (which fires
// migration 0037's trigger). Also proves tenant scoping (a second tenant's connection
// receives nothing) and the 401 path when no credentials are presented.
//
// Auth uses AUTH_DEV_BYPASS, the same standing convention every other integration test
// in this repo already uses for identity — not a shortcut invented for this test.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import http from "node:http";
import { migrate } from "../../packages/db/migrate";
import { getPool, closePool, adminDb, tenants, domainActions } from "@finnor/db";
import { startCentropyEventListener, stopCentropyEventListener, onCentropyEvent } from "../../apps/worker/src/sse/listener";
import { createSseGateway } from "../../apps/worker/src/sse/gateway";

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

function connectSse(port: number, tenantId: string, lastEventId?: string): Promise<{ req: http.ClientRequest; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const req = http.get(
      { host: "127.0.0.1", port, path: "/events", headers: { "x-tenant-id": tenantId, ...(lastEventId ? { "last-event-id": lastEventId } : {}) } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Expected 200, got ${res.statusCode}`));
          return;
        }
        res.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
        resolve({ req, chunks });
      },
    );
    req.on("error", reject);
  });
}

function operationalFrames(chunks: string[]): Array<{ id: string; data: Record<string, unknown> }> {
  return chunks.join("").split("\n\n").flatMap((frame) => {
    if (!frame.includes("event: operational_delta")) return [];
    const id = frame.split("\n").find((line) => line.startsWith("id: "))?.slice(4);
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return id && data ? [{ id, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}

describe.skipIf(!available)("B1.T2 — SSE gateway", () => {
  let server: http.Server;
  let port: number;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    vi.stubEnv("NODE_ENV", "test");
    await migrate(DB_URL);

    const [tenant] = await adminDb().insert(tenants).values({ name: "B1.T2 SSE gateway test tenant" }).returning();
    tenantId = tenant!.id;
    const [otherTenant] = await adminDb().insert(tenants).values({ name: "B1.T2 SSE gateway other tenant" }).returning();
    otherTenantId = otherTenant!.id;

    await startCentropyEventListener();
    server = createSseGateway();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    await stopCentropyEventListener();
    await closePool();
  });

  it("rejects a request with no credentials", async () => {
    await new Promise<void>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
          expect(res.statusCode).toBe(401);
          resolve();
        })
        .on("error", reject);
    });
  });

  it("streams a durable safe delta to the connected tenant within 2s, and not to another tenant", async () => {
    const [own, other] = await Promise.all([connectSse(port, tenantId), connectSse(port, otherTenantId)]);
    // Give both SSE connections a moment to register their onCentropyEvent subscriber
    // before the write happens, same as a real client's connect-then-listen race.
    await new Promise((r) => setTimeout(r, 100));

    const start = Date.now();
    const [action] = await adminDb()
      .insert(domainActions)
      .values({ tenantId, actionType: "test_action", payload: {}, status: "draft" })
      .returning();

    const deadline = Date.now() + 2000;
    let received: Record<string, unknown> | null = null;
    while (Date.now() < deadline && !received) {
      received = operationalFrames(own.chunks).find((frame) =>
        Array.isArray(frame.data.entityRefs) && frame.data.entityRefs.some((ref) => (ref as { entityId?: unknown }).entityId === action!.id),
      )?.data ?? null;
      if (!received) await new Promise((r) => setTimeout(r, 25));
    }
    const elapsedMs = Date.now() - start;

    expect(received).not.toBeNull();
    expect(received!.changeType).toBe("domain_actions.insert");
    expect(received).not.toHaveProperty("tenantId");
    expect(received).not.toHaveProperty("payload");
    expect(elapsedMs).toBeLessThan(2000);

    // Tenant isolation: the other tenant's stream must never see this event.
    expect(other.chunks.join("")).not.toContain(action!.id);
    own.req.destroy();
    other.req.destroy();
  });

  it("replays a delta written while disconnected and rejects another tenant's cursor", async () => {
    const first = await connectSse(port, tenantId);
    const [seen] = await adminDb().insert(domainActions).values({ tenantId, actionType: "cursor_seed", payload: {}, status: "draft" }).returning();
    const deadline = Date.now() + 2000;
    let cursor: string | undefined;
    while (Date.now() < deadline && !cursor) {
      cursor = operationalFrames(first.chunks).find((frame) => JSON.stringify(frame.data.entityRefs).includes(seen!.id))?.id;
      if (!cursor) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(cursor).toBeTruthy();
    first.req.destroy();

    const [missed] = await adminDb().insert(domainActions).values({ tenantId, actionType: "cursor_replay", payload: {}, status: "draft" }).returning();
    const resumed = await connectSse(port, tenantId, cursor);
    let replayed = false;
    while (Date.now() < deadline + 2000 && !replayed) {
      replayed = operationalFrames(resumed.chunks).some((frame) => JSON.stringify(frame.data.entityRefs).includes(missed!.id));
      if (!replayed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(replayed).toBe(true);
    resumed.req.destroy();

    await new Promise<void>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/events", headers: { "x-tenant-id": otherTenantId, "last-event-id": cursor! } }, (res) => {
        expect(res.statusCode).toBe(409);
        resolve();
      }).on("error", reject);
    });
  });
});
