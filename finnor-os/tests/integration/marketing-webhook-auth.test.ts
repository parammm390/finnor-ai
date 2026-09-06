// Phase 4: the marketing conversion-intake webhook (apps/api/app/api/webhooks/
// marketing/route.ts) previously accepted ANY POST with a caller-supplied tenantId —
// a real, unauthenticated way to inject fake leads into any tenant's pipeline. This
// proves the fix: a shared secret is now required, same fail-closed-in-prod posture
// as every other webhook route in this repo.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, leads, households, integrationEvents, tenantIntegrations } from "@finnor/db";
import { eq } from "drizzle-orm";
import { POST as marketingWebhook } from "../../apps/api/app/api/webhooks/marketing/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-100000000f71";
const ROUTE_ID = "marketing-route-f71";

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

function payload(eventId: string) {
  return { campaignId: "camp-1", eventId, name: "Auth Probe Lead", phone: "+15555550199" };
}

function req(body: unknown, secretHeader?: string, routeId = ROUTE_ID): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secretHeader !== undefined) headers["x-webhook-secret"] = secretHeader;
  if (routeId) headers["x-finnor-route-id"] = routeId;
  return new Request("http://localhost/api/webhooks/marketing", { method: "POST", headers, body: JSON.stringify(body) });
}

describe.skipIf(!available)("Phase 4: marketing webhook requires a real shared secret", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, async (db) => {
      await db.insert(tenants).values({ id: TENANT_ID, name: "Marketing Webhook Auth Test" }).onConflictDoNothing();
      await db.insert(tenantIntegrations).values({
        tenantId: TENANT_ID,
        capability: "marketing",
        binding: "marketing_conversion",
        mode: "sandbox",
        config: { webhookRouteId: ROUTE_ID },
      }).onConflictDoUpdate({
        target: [tenantIntegrations.tenantId, tenantIntegrations.capability],
        set: { binding: "marketing_conversion", mode: "sandbox", config: { webhookRouteId: ROUTE_ID }, updatedAt: new Date() },
      });
    });
  }, 30_000);
  afterAll(async () => {
    await closePool();
  });
  afterEach(async () => {
    delete process.env.MARKETING_WEBHOOK_SECRET;
    delete (process.env as Record<string, string | undefined>).NODE_ENV_OVERRIDE;
  });

  it("with a configured secret: wrong or missing secret is rejected with 401, real key is accepted", async () => {
    process.env.MARKETING_WEBHOOK_SECRET = "real-secret-abc123";
    const eventId = `evt-correct-${Date.now()}`;

    const noHeader = await marketingWebhook(req(payload("evt-noheader")));
    expect(noHeader.status).toBe(401);

    const wrongSecret = await marketingWebhook(req(payload("evt-wrong"), "not-the-secret"));
    expect(wrongSecret.status).toBe(401);

    const correct = await marketingWebhook(req(payload(eventId), "real-secret-abc123"));
    expect(correct.status).toBe(200);
    const body = await correct.json();
    expect(body.leadId).toBeTruthy();
    expect(body.duplicate).toBe(false);

    const replay = await marketingWebhook(req(payload(eventId), "real-secret-abc123"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true, leadId: body.leadId, eventId: body.eventId });

    await withTenant(TENANT_ID, async (db) => {
      const [lead] = await db.select().from(leads).where(eq(leads.id, body.leadId));
      expect(lead).toBeTruthy();
      const events = await db.select().from(integrationEvents).where(eq(integrationEvents.sourceEventId, eventId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ trustClass: "untrusted_external", contentTreatment: "untrusted_evidence", instructionEligible: false });
      await db.delete(integrationEvents).where(eq(integrationEvents.id, body.eventId));
      await db.delete(leads).where(eq(leads.id, body.leadId));
      if (lead?.householdId) await db.delete(households).where(eq(households.id, lead.householdId));
    });
  });

  it("rejects caller-supplied tenant identity and an unmapped route", async () => {
    process.env.MARKETING_WEBHOOK_SECRET = "real-secret-abc123";
    expect((await marketingWebhook(req({ ...payload("forged-tenant"), tenantId: TENANT_ID }, "real-secret-abc123"))).status).toBe(400);
    expect((await marketingWebhook(req(payload("unmapped-route"), "real-secret-abc123", "not-mapped"))).status).toBe(400);
  });

  it("a mismatched-length secret is rejected without throwing (timingSafeEqual guard)", async () => {
    process.env.MARKETING_WEBHOOK_SECRET = "a-fairly-long-real-secret-value";
    const res = await marketingWebhook(req(payload("evt-short"), "x"));
    expect(res.status).toBe(401);
  });
});
