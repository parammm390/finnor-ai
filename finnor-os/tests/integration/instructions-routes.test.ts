// jarvis-v3 P3.T5: GET /api/instructions/:id and GET /api/instructions/:id/events —
// same describe.skipIf(!available) + migrate() + direct route-handler-import pattern
// as tests/integration/dlq-routes.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool, receiveWork, transitionWork, withTenant, tenants, users, works, workAggregate, WorkControlAuthorizationError } from "@finnor/db";
import { ensureInstructionSession, emitInstructionEvent, recordInstructionCancellationFence } from "../../packages/orchestration/src/instruction-trace";
import { eq } from "drizzle-orm";
import { GET as getInstruction } from "../../apps/api/app/api/instructions/[id]/route";
import { GET as getInstructionEvents } from "../../apps/api/app/api/instructions/[id]/events/route";
import { POST as cancelInstruction } from "../../apps/api/app/api/instructions/[id]/cancel/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ea";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000000eb";
const OWNER_ID = randomUUID();
const PEER_ID = randomUUID();

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

function req(url: string, tenantId = TENANT_ID, userId = OWNER_ID): Request {
  return new Request(`http://localhost${url}`, { headers: { "x-tenant-id": tenantId, "x-user-role": "owner", "x-user-id": userId } });
}

function postReq(url: string, tenantId = TENANT_ID, userId = OWNER_ID): Request {
  return new Request(`http://localhost${url}`, { method: "POST", headers: { "x-tenant-id": tenantId, "x-user-role": "owner", "x-user-id": userId } });
}

describe.skipIf(!available)("GET /api/instructions/:id and /events (P3.T5)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Instructions Route Test Dealer" }).onConflictDoNothing());
    await withTenant(OTHER_TENANT_ID, (db) => db.insert(tenants).values({ id: OTHER_TENANT_ID, name: "Other Tenant" }).onConflictDoNothing());
    await withTenant(TENANT_ID, db => db.insert(users).values([
      { id: OWNER_ID, tenantId: TENANT_ID, role: "owner", email: `instruction-owner-${OWNER_ID}@example.test` },
      { id: PEER_ID, tenantId: TENANT_ID, role: "dispatcher", email: `instruction-peer-${PEER_ID}@example.test` },
    ]));
  });
  afterAll(async () => {
    await closePool();
  });

  it("GET /api/instructions/:id 404s for an unknown id", async () => {
    const res = await getInstruction(req(`/api/instructions/${randomUUID()}`), { params: Promise.resolve({ id: randomUUID() }) });
    expect(res.status).toBe(404);
  });

  it("GET /api/instructions/:id returns the real session row", async () => {
    const id = randomUUID();
    await ensureInstructionSession(TENANT_ID, id, "chase everyone more than thirty days overdue", { source: "typed", userId: OWNER_ID });
    const res = await getInstruction(req(`/api/instructions/${id}`), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instruction.id).toBe(id);
    expect(body.instruction.instructionText).toBe("chase everyone more than thirty days overdue");
    expect(body.instruction.source).toBe("typed");
  });

  it("a different tenant cannot read another tenant's instruction session (RLS)", async () => {
    const id = randomUUID();
    await ensureInstructionSession(TENANT_ID, id, "tenant isolation check", { userId: OWNER_ID });
    const res = await getInstruction(req(`/api/instructions/${id}`, OTHER_TENANT_ID), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it("GET /api/instructions/:id/events returns events in ascending seq order", async () => {
    const id = randomUUID();
    await ensureInstructionSession(TENANT_ID, id, "events order check", { userId: OWNER_ID });
    await emitInstructionEvent(TENANT_ID, id, "received");
    await emitInstructionEvent(TENANT_ID, id, "context_retrieved", { chips: [] });
    await emitInstructionEvent(TENANT_ID, id, "planning");
    const res = await getInstructionEvents(req(`/api/instructions/${id}/events`), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((e: { phase: string }) => e.phase)).toEqual(["received", "context_retrieved", "planning"]);
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
  });

  it("?after= filters to only newer events — the trace poll's own use case", async () => {
    const id = randomUUID();
    await ensureInstructionSession(TENANT_ID, id, "after filter check", { userId: OWNER_ID });
    await emitInstructionEvent(TENANT_ID, id, "received");
    await emitInstructionEvent(TENANT_ID, id, "context_retrieved", {});
    await emitInstructionEvent(TENANT_ID, id, "planning");
    const res = await getInstructionEvents(req(`/api/instructions/${id}/events?after=1`), { params: Promise.resolve({ id }) });
    const body = await res.json();
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
  });

  it("GET /api/instructions/:id/events 404s for an unknown instructionId", async () => {
    const id = randomUUID();
    const res = await getInstructionEvents(req(`/api/instructions/${id}/events`), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it("denies same-tenant instruction text, trace and cancellation to a non-participant", async () => {
    const instructionId = randomUUID();
    const secret = `private-instruction-${randomUUID()}`;
    const received = await receiveWork({
      tenantId: TENANT_ID, instructionId, instruction: secret, channel: "text", userId: OWNER_ID,
    });
    await emitInstructionEvent(TENANT_ID, instructionId, "planning", { decision: secret });
    for (const response of [
      await getInstruction(req(`/api/instructions/${instructionId}`, TENANT_ID, PEER_ID), { params: Promise.resolve({ id: instructionId }) }),
      await getInstructionEvents(req(`/api/instructions/${instructionId}/events`, TENANT_ID, PEER_ID), { params: Promise.resolve({ id: instructionId }) }),
      await cancelInstruction(postReq(`/api/instructions/${instructionId}/cancel`, TENANT_ID, PEER_ID), { params: Promise.resolve({ id: instructionId }) }),
    ]) {
      expect(response.status).toBe(404);
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain(secret);
    }
    expect((await workAggregate(TENANT_ID, received.workId))?.work).toMatchObject({ status: "received" });
    const own = await getInstruction(req(`/api/instructions/${instructionId}`), { params: Promise.resolve({ id: instructionId }) });
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
    expect((await own.json()).instruction.instructionText).toBe(secret);
  });

  it("rechecks ownership under the instruction cancellation fence after handoff", async () => {
    const instructionId = randomUUID();
    const received = await receiveWork({
      tenantId: TENANT_ID, instructionId, instruction: "Controlled Work cancellation",
      channel: "text", userId: OWNER_ID,
    });
    await withTenant(TENANT_ID, db => db.update(works).set({ currentOwnerId: PEER_ID }).where(eq(works.id, received.workId)));
    await expect(recordInstructionCancellationFence({
      tenantId: TENANT_ID, instructionId, workId: received.workId, requestedBy: OWNER_ID,
    })).rejects.toBeInstanceOf(WorkControlAuthorizationError);
    const previousOwnerCancel = await cancelInstruction(postReq(`/api/instructions/${instructionId}/cancel`), {
      params: Promise.resolve({ id: instructionId }),
    });
    expect(previousOwnerCancel.status).toBe(404);
    expect((await workAggregate(TENANT_ID, received.workId))?.work).toMatchObject({ status: "received" });

    // New current owner may place the fence; this is a transaction-only positive
    // control, not a second irreversible cancellation workflow.
    const fenced = await recordInstructionCancellationFence({
      tenantId: TENANT_ID, instructionId, workId: received.workId, requestedBy: PEER_ID,
    });
    expect(fenced).toBe(true);
  });

  it("POST /cancel persists canonical cancelled Work and is idempotent", async () => {
    const instructionId = randomUUID();
    const received = await receiveWork({
      tenantId: TENANT_ID,
      instructionId,
      instruction: "Slow planning request",
      channel: "text",
      userId: OWNER_ID,
    });
    await transitionWork(TENANT_ID, received.workId, "planning", "planning_started", {}, { expectedWorkInputId: received.workInputId });

    const first = await cancelInstruction(postReq(`/api/instructions/${instructionId}/cancel`), { params: Promise.resolve({ id: instructionId }) });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "cancelled", inFlightActions: 0 });
    expect((await workAggregate(TENANT_ID, received.workId))!.work).toMatchObject({ status: "cancelled", finalOutcome: { kind: "cancelled" } });

    const duplicate = await cancelInstruction(postReq(`/api/instructions/${instructionId}/cancel`), { params: Promise.resolve({ id: instructionId }) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ status: "cancelled", duplicate: true });
  });
});
