import { createHmac, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool } from "@finnor/db";
import { POST as ghlWebhook } from "../../apps/api/app/api/webhooks/ghl/route";
import { POST as esignWebhook } from "../../apps/api/app/api/webhooks/esign/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await databaseAvailable();

async function executionCounts(client: pg.Client): Promise<Record<string, number>> {
  return (await client.query<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM finnor_os.domain_actions) actions,
    (SELECT count(*)::int FROM finnor_os.jobs) jobs,
    (SELECT count(*)::int FROM finnor_os.business_events) events`)).rows[0]!;
}

describe.skipIf(!available)("retired signed webhook quarantine", () => {
  beforeAll(async () => { process.env.DATABASE_URL = DB_URL; await migrate(DB_URL); });
  afterEach(() => {
    delete process.env.GHL_WEBHOOK_PUBLIC_KEY;
    delete process.env.DOCUSIGN_CONNECT_SECRET;
  });
  afterAll(async () => { await closePool(); });

  it("authenticates and idempotently quarantines a delayed GHL callback without business mutation", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GHL_WEBHOOK_PUBLIC_KEY = publicKey.export({ format: "pem", type: "spki" }).toString();
    const eventId = `phase5-ghl-${randomUUID()}`;
    const body = JSON.stringify({ eventId, contactId: "historical-contact", tenantId: randomUUID() });
    const signature = createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64");
    const request = (value?: string) => new Request("http://localhost/api/webhooks/ghl", {
      method: "POST",
      headers: { "content-type": "application/json", ...(value ? { "x-wh-signature": value } : {}) },
      body,
    });
    expect((await ghlWebhook(request())).status).toBe(401);

    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const before = await executionCounts(client);
    const accepted = await ghlWebhook(request(signature));
    expect(accepted.status).toBe(410);
    expect(await accepted.json()).toMatchObject({ received: true, quarantined: true, duplicate: false, status: "retired" });
    const replay = await ghlWebhook(request(signature));
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ duplicate: true, quarantined: true });
    const after = await executionCounts(client);
    const receipts = Number((await client.query(
      "SELECT count(*)::int count FROM finnor_os.webhook_receipts WHERE provider='retired_water:ghl' AND event_id=$1",
      [eventId],
    )).rows[0]!.count);
    await client.end();
    expect(after).toEqual(before);
    expect(receipts).toBe(1);
  });

  it("authenticates and idempotently quarantines a delayed e-sign callback without business mutation", async () => {
    const secret = "phase5-esign-secret";
    process.env.DOCUSIGN_CONNECT_SECRET = secret;
    const eventId = `phase5-esign-${randomUUID()}`;
    const body = JSON.stringify({ eventId, envelopeId: "historical-envelope", tenantId: randomUUID() });
    const signature = createHmac("sha256", secret).update(body).digest("base64");
    const request = (value: string) => new Request("http://localhost/api/webhooks/esign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-docusign-signature-1": value },
      body,
    });
    expect((await esignWebhook(request("invalid"))).status).toBe(401);

    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const before = await executionCounts(client);
    const accepted = await esignWebhook(request(signature));
    expect(accepted.status).toBe(410);
    expect(await accepted.json()).toMatchObject({ received: true, quarantined: true, duplicate: false, status: "retired" });
    const replay = await esignWebhook(request(signature));
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ duplicate: true, quarantined: true });
    const after = await executionCounts(client);
    const receipts = Number((await client.query(
      "SELECT count(*)::int count FROM finnor_os.webhook_receipts WHERE provider='retired_water:esign' AND event_id=$1",
      [eventId],
    )).rows[0]!.count);
    await client.end();
    expect(after).toEqual(before);
    expect(receipts).toBe(1);
  });
});
