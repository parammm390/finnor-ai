// A4.T6 acceptance: the canonical Work intake primitives used by POST /api/actions
// make an idempotencyKey a durable, tenant-scoped claim before orchestration begins.
// These tests exercise receiveWork()/recordWorkResponse() directly so the invariant
// remains provable without requiring a real or mocked LLM planner call.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../packages/db/migrate";
import { closePool, receiveWork, recordWorkResponse, tenants, withTenant } from "@finnor/db";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000f2";

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

describe.skipIf(!available)("intake idempotency (A4.T6)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Intake Idempotency Test Dealer" }).onConflictDoNothing());
  });
  afterAll(async () => {
    await closePool();
  });

  it("a fresh key creates exactly one canonical Work and input", async () => {
    const key = `test-${randomUUID()}`;
    const result = await receiveWork({
      tenantId: TENANT_ID,
      instruction: "test fresh canonical Work intake",
      channel: "text",
      instructionId: randomUUID(),
      idempotencyKey: key,
    });
    expect(result.created).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.status).toBe("received");
    expect(result.workId).toBeTruthy();
    expect(result.workInputId).toBeTruthy();
  });

  it("concurrent submissions with the SAME key resolve to one canonical Work", async () => {
    const key = `test-${randomUUID()}`;
    const [first, second] = await Promise.all([
      receiveWork({ tenantId: TENANT_ID, instruction: "concurrent intake A", channel: "text", instructionId: randomUUID(), idempotencyKey: key }),
      receiveWork({ tenantId: TENANT_ID, instruction: "concurrent intake B", channel: "text", instructionId: randomUUID(), idempotencyKey: key }),
    ]);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.workId).toBe(second.workId);
    expect(first.duplicate || second.duplicate).toBe(true);
  });

  it("after response recording, a repeat with the SAME key replays the exact response", async () => {
    const key = `test-${randomUUID()}`;
    const instructionId = randomUUID();
    const claim = await receiveWork({ tenantId: TENANT_ID, instruction: "record canonical response", channel: "text", instructionId, idempotencyKey: key });
    const realResponse = { planned: [{ actionType: "schedule_water_test", payload: {} }] };
    await recordWorkResponse(TENANT_ID, claim.workId, realResponse);

    const repeat = await receiveWork({ tenantId: TENANT_ID, instruction: "record canonical response", channel: "text", instructionId, idempotencyKey: key });
    expect(repeat.duplicate).toBe(true);
    expect(repeat.workId).toBe(claim.workId);
    expect((repeat.finalOutcome as { response?: unknown })?.response).toEqual(realResponse);

    const third = await receiveWork({ tenantId: TENANT_ID, instruction: "record canonical response", channel: "text", instructionId, idempotencyKey: key });
    expect(third.duplicate).toBe(true);
    expect(third.workId).toBe(claim.workId);
  });

  it("different idempotency keys for the same tenant create independently", async () => {
    const a = await receiveWork({ tenantId: TENANT_ID, instruction: "independent A", channel: "text", instructionId: randomUUID(), idempotencyKey: `test-a-${randomUUID()}` });
    const b = await receiveWork({ tenantId: TENANT_ID, instruction: "independent B", channel: "text", instructionId: randomUUID(), idempotencyKey: `test-b-${randomUUID()}` });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.workId).not.toBe(b.workId);
  });

  it("the SAME idempotency key for a DIFFERENT tenant creates independently", async () => {
    const otherTenantId = randomUUID();
    await withTenant(otherTenantId, (db) => db.insert(tenants).values({ id: otherTenantId, name: "Other Tenant" }).onConflictDoNothing());
    const key = `shared-key-${randomUUID()}`;
    const first = await receiveWork({ tenantId: TENANT_ID, instruction: "tenant A shared key", channel: "text", instructionId: randomUUID(), idempotencyKey: key });
    const second = await receiveWork({ tenantId: otherTenantId, instruction: "tenant B shared key", channel: "text", instructionId: randomUUID(), idempotencyKey: key });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true); // tenant is part of the canonical claim scope
    expect(first.workId).not.toBe(second.workId);
  });
});
