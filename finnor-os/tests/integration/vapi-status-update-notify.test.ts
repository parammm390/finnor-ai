// B1.T4 acceptance: a Vapi "status-update" webhook message (in-progress call lifecycle
// — no durable row exists for this yet, see the route's own comment) results in a real
// 'jarvis_events' NOTIFY with kind:"voice_status", carrying the call id and status.
// Real POST through the actual route handler, real LISTEN connection, not a mock.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { closePool, getPool } from "@finnor/db";
import { POST } from "../../apps/api/app/api/webhooks/vapi/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const PHONE_NUMBER_ID = "phone-status-update-test";
const DIALED_NUMBER = "+15555550102";

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

function statusUpdateRequest(callId: string, status: string): Request {
  const body = { message: { type: "status-update", status, call: { id: callId, phoneNumberId: PHONE_NUMBER_ID, phoneNumber: { number: DIALED_NUMBER } } } };
  return new Request("http://localhost/api/webhooks/vapi", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!available)("POST /api/webhooks/vapi — status-update notifies jarvis_events", () => {
  let listener: pg.Client;
  let events: Array<{ tenantId: string; kind: string; id: string; status?: string }> = [];

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

    listener = new pg.Client({ connectionString: DB_URL });
    await listener.connect();
    await listener.query("LISTEN jarvis_events");
    listener.on("notification", (msg) => {
      if (msg.channel !== "jarvis_events" || !msg.payload) return;
      events.push(JSON.parse(msg.payload));
    });
  });

  afterAll(async () => {
    await listener.query("UNLISTEN jarvis_events").catch(() => undefined);
    await listener.end();
    await closePool();
  });

  it("in-progress status fires a voice_status NOTIFY", async () => {
    const callId = `status-update-test-${randomUUID()}`;
    events = [];
    const res = await POST(statusUpdateRequest(callId, "in-progress"));
    expect(res.status).toBe(200);

    const deadline = Date.now() + 3000;
    let found = events.find((e) => e.kind === "voice_status" && e.id === callId);
    while (!found && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      found = events.find((e) => e.kind === "voice_status" && e.id === callId);
    }
    expect(found).toBeDefined();
    expect(found!.tenantId).toBe(SEED_TENANT_ID);
    expect(found!.status).toBe("in-progress");
  });

  it("distinct statuses for the same call are not deduped away", async () => {
    const callId = `status-update-test-${randomUUID()}`;
    events = [];
    await POST(statusUpdateRequest(callId, "ringing"));
    await POST(statusUpdateRequest(callId, "in-progress"));
    await POST(statusUpdateRequest(callId, "ended"));

    const deadline = Date.now() + 3000;
    while (events.filter((e) => e.kind === "voice_status" && e.id === callId).length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const statuses = events.filter((e) => e.kind === "voice_status" && e.id === callId).map((e) => e.status);
    expect(statuses.sort()).toEqual(["ended", "in-progress", "ringing"]);
  });
});
