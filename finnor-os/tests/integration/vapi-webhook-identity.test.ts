// Route-level proof for the zod call-object stripping fix (ground-truth §6): before
// the fix, call.customer.number was silently stripped by VapiWebhookSchema on every
// parse, so resolveVoiceIdentity() was never even called with a real number — every
// caller on the owner line got the "can't verify this line" handoff regardless of who
// was actually calling. This test seeds a real owner phone number, POSTs a realistic
// tool-calls webhook body with call.customer.number matching it, and asserts the
// response is NOT the handoff message — proving identity resolution now actually runs.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { closePool, getPool, withTenant, tenants } from "@finnor/db";
import { eq } from "drizzle-orm";
import { POST } from "../../apps/api/app/api/webhooks/vapi/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const OWNER_PHONE = "+15555550100";
const PHONE_NUMBER_ID = "phone-identity-test";
const DIALED_NUMBER = "+15555550101";

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

function toolCallsRequest(callId: string, customerNumber: string): Request {
  const body = {
    message: {
      type: "tool-calls",
      call: { id: callId, phoneNumberId: PHONE_NUMBER_ID, phoneNumber: { number: DIALED_NUMBER }, customer: { number: customerNumber } },
      toolCallList: [{ id: "tc-1", function: { name: "finnor_confirm", arguments: { decision: "yes" } } }],
    },
  };
  return new Request("http://localhost/api/webhooks/vapi", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!available)("POST /api/webhooks/vapi — caller identity resolves post-fix", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.VAPI_WEBHOOK_SECRET = "";
    await migrate(DB_URL);
    await seed(DB_URL);
    await getPool().query(
      `INSERT INTO tenant_phone_numbers (tenant_id, phone_number, vapi_phone_number_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (vapi_phone_number_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, phone_number = EXCLUDED.phone_number`,
      [SEED_TENANT_ID, DIALED_NUMBER, PHONE_NUMBER_ID],
    );
    await withTenant(SEED_TENANT_ID, (db) => db.update(tenants).set({ ownerPhone: OWNER_PHONE }).where(eq(tenants.id, SEED_TENANT_ID)));
  });

  afterAll(async () => {
    await closePool();
  });

  it("a caller matching tenants.ownerPhone is resolved as owner — no handoff message", async () => {
    const res = await POST(toolCallsRequest(`call-identity-test-${randomUUID()}`, OWNER_PHONE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ toolCallId: string; result: string }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.result).not.toMatch(/can't verify this line/);
  });

  it("an unrecognized number still gets the handoff (identity resolution is real, not bypassed)", async () => {
    const res = await POST(toolCallsRequest(`call-identity-test-${randomUUID()}`, "+15559990000"));
    const body = (await res.json()) as { results: Array<{ toolCallId: string; result: string }> };
    expect(body.results[0]!.result).toMatch(/cannot verify an active employee on this line/);
  });
});
