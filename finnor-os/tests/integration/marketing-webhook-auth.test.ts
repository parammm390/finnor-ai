import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool } from "@finnor/db";
import { POST as marketingWebhook } from "../../apps/api/app/api/webhooks/marketing/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await databaseAvailable();

function request(eventId: string, secret?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-webhook-secret"] = secret;
  return new Request("http://localhost/api/webhooks/marketing", {
    method: "POST",
    headers,
    body: JSON.stringify({ eventId, campaignId: "historical-delivery", tenantId: randomUUID() }),
  });
}

describe.skipIf(!available)("retired marketing webhook quarantine", () => {
  beforeAll(async () => { process.env.DATABASE_URL = DB_URL; await migrate(DB_URL); });
  afterEach(() => { delete process.env.MARKETING_WEBHOOK_SECRET; });
  afterAll(async () => { await closePool(); });

  it("authenticates, receipts, deduplicates, returns 410, and creates no executable work", async () => {
    process.env.MARKETING_WEBHOOK_SECRET = "phase5-marketing-secret";
    const eventId = `phase5-marketing-${randomUUID()}`;
    expect((await marketingWebhook(request(eventId))).status).toBe(401);
    expect((await marketingWebhook(request(eventId, "wrong"))).status).toBe(401);

    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const before = (await client.query(`SELECT
      (SELECT count(*)::int FROM finnor_os.domain_actions) actions,
      (SELECT count(*)::int FROM finnor_os.jobs) jobs,
      (SELECT count(*)::int FROM finnor_os.business_events) events`)).rows[0];

    const accepted = await marketingWebhook(request(eventId, "phase5-marketing-secret"));
    expect(accepted.status).toBe(410);
    expect(await accepted.json()).toMatchObject({ received: true, quarantined: true, duplicate: false, vertical: "water", status: "retired" });
    const replay = await marketingWebhook(request(eventId, "phase5-marketing-secret"));
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ quarantined: true, duplicate: true });

    const after = (await client.query(`SELECT
      (SELECT count(*)::int FROM finnor_os.domain_actions) actions,
      (SELECT count(*)::int FROM finnor_os.jobs) jobs,
      (SELECT count(*)::int FROM finnor_os.business_events) events,
      (SELECT count(*)::int FROM finnor_os.webhook_receipts WHERE provider='retired_water:marketing' AND event_id=$1) receipts`, [eventId])).rows[0];
    await client.end();
    expect(after).toMatchObject({ ...before, receipts: 1 });
  });
});
