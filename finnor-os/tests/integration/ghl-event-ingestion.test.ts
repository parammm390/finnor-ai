import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { eq } from "drizzle-orm";
import { migrate } from "../../packages/db/migrate";
import { adminDb, closePool, jobs } from "@finnor/db";
import { POST as ghlWebhook } from "../../apps/api/app/api/webhooks/ghl/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

const available = await dbUp();

describe.skipIf(!available)("Phase 5 retired GHL webhook quarantine", () => {
  const tenantA = randomUUID();
  const locationId = `ghl-location-${randomUUID()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });

  function request(webhookId: string): Request {
    return new Request("http://localhost/api/webhooks/ghl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ContactUpdate", locationId, contactId: "ghl-contact-123", webhookId }),
    });
  }

  it("authenticates the callback, quarantines it, and never enqueues business work", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GHL_WEBHOOK_PUBLIC_KEY", "");
    const webhookId = `ghl-event-${randomUUID()}`;
    const first = await ghlWebhook(request(webhookId));
    expect(first.status).toBe(410);
    expect(await first.json()).toMatchObject({ received: true, quarantined: true, duplicate: false, status: "retired" });
    const replay = await ghlWebhook(request(webhookId));
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ received: true, quarantined: true, duplicate: true, status: "retired" });

    const queued = await adminDb().select().from(jobs).where(eq(jobs.idempotencyKey, `ghl:${tenantA}:${webhookId}`));
    expect(queued).toHaveLength(0);
  });

  it("rejects unauthenticated production callbacks", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GHL_WEBHOOK_PUBLIC_KEY", "");
    expect((await ghlWebhook(request(`retired-${randomUUID()}`))).status).toBe(410);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GHL_WEBHOOK_PUBLIC_KEY", "");
    expect((await ghlWebhook(request(`unsigned-production-${randomUUID()}`))).status).toBe(401);
  });
});
