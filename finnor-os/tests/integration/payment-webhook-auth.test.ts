import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool } from "@finnor/db";
import { POST as paymentWebhook } from "../../apps/api/app/api/webhooks/payment/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await databaseAvailable();

function signedRequest(body: string, secret: string): Request {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return new Request("http://localhost/api/webhooks/payment", {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment-signature": `t=${timestamp},v1=${signature}` },
    body,
  });
}

describe.skipIf(!available)("retired payment webhook quarantine", () => {
  beforeAll(async () => { process.env.DATABASE_URL = DB_URL; await migrate(DB_URL); });
  afterEach(() => { delete process.env.PAYMENT_EMULATOR_WEBHOOK_SECRET; });
  afterAll(async () => { await closePool(); });

  it("rejects bad signatures and quarantines a valid delayed delivery without effects", async () => {
    const secret = "phase5-payment-secret";
    process.env.PAYMENT_EMULATOR_WEBHOOK_SECRET = secret;
    const eventId = `phase5-payment-${randomUUID()}`;
    const body = JSON.stringify({ eventId, historicalReference: randomUUID(), tenantId: randomUUID() });
    expect((await paymentWebhook(signedRequest(body, "wrong"))).status).toBe(401);

    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const before = (await client.query(`SELECT
      (SELECT count(*)::int FROM finnor_os.domain_actions) actions,
      (SELECT count(*)::int FROM finnor_os.jobs) jobs,
      (SELECT count(*)::int FROM finnor_os.business_events) events`)).rows[0];
    const response = await paymentWebhook(signedRequest(body, secret));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ received: true, quarantined: true, duplicate: false, vertical: "water", status: "retired" });
    const after = (await client.query(`SELECT
      (SELECT count(*)::int FROM finnor_os.domain_actions) actions,
      (SELECT count(*)::int FROM finnor_os.jobs) jobs,
      (SELECT count(*)::int FROM finnor_os.business_events) events,
      (SELECT count(*)::int FROM finnor_os.webhook_receipts WHERE provider='retired_water:payment' AND event_id=$1) receipts`, [eventId])).rows[0];
    await client.end();
    expect(after).toMatchObject({ ...before, receipts: 1 });
  });
});
