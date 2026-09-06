// Phase 2 (§2.3) DLQ API routes: list/inspect/replay/discard, owner-only.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, outboxEvents, deadLetters, commands, workflowRuns, workflowSteps } from "@finnor/db";
import { eq } from "drizzle-orm";
import { GET as listDlq } from "../../apps/api/app/api/dlq/route";
import { GET as inspectDlq } from "../../apps/api/app/api/dlq/[id]/route";
import { POST as replayDlq } from "../../apps/api/app/api/dlq/[id]/replay/route";
import { POST as discardDlq } from "../../apps/api/app/api/dlq/[id]/discard/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000e9";

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

function req(url: string, opts: { role?: string; method?: string } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    headers: { "x-tenant-id": TENANT_ID, "x-user-role": opts.role ?? "owner" },
  });
}

describe.skipIf(!available)("DLQ routes (§2.3)", () => {
  let openOutboxEventId: string;
  let openDeadLetterId: string;
  let discardedDeadLetterId: string;
  let linkedWorkflowRunId: string;
  let linkedCommandId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "DLQ Route Test Dealer" }).onConflictDoNothing());

    const [command] = await withTenant(TENANT_ID, (db) =>
      db.insert(commands).values({ tenantId: TENANT_ID, commandType: "dlq_route_test", payload: {} }).returning(),
    );
    linkedCommandId = command!.id;
    const [workflowRun] = await withTenant(TENANT_ID, (db) =>
      db.insert(workflowRuns).values({ tenantId: TENANT_ID, commandId: linkedCommandId, workflowType: "single_action" }).returning(),
    );
    linkedWorkflowRunId = workflowRun!.id;
    const [workflowStep] = await withTenant(TENANT_ID, (db) =>
      db.insert(workflowSteps).values({ tenantId: TENANT_ID, workflowRunId: linkedWorkflowRunId, stepType: "dlq_route_probe", sequence: 1, idempotencyKey: `dlq-route-${Date.now()}` }).returning(),
    );
    const [outboxRow] = await withTenant(TENANT_ID, (db) =>
      db.insert(outboxEvents).values({ tenantId: TENANT_ID, workflowStepId: workflowStep!.id, eventType: "dlq.route.probe", payload: {}, status: "failed" }).returning(),
    );
    openOutboxEventId = outboxRow!.id;
    const [openDl] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(deadLetters)
        .values({
          tenantId: TENANT_ID,
          relatedOutboxEventId: openOutboxEventId,
          envelope: { type: "dlq.route.probe", version: 1, tenantId: TENANT_ID, occurredAt: new Date().toISOString(), payload: {} },
          errorKind: "retryable",
          attempts: 3,
          lastError: "provider timeout",
          replayable: true,
          status: "open",
        })
        .returning(),
    );
    openDeadLetterId = openDl!.id;
    const [discardedDl] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(deadLetters)
        .values({
          tenantId: TENANT_ID,
          envelope: { type: "dlq.route.probe.2", version: 1, tenantId: TENANT_ID, occurredAt: new Date().toISOString(), payload: {} },
          errorKind: "terminal",
          attempts: 1,
          lastError: "bad payload",
          replayable: false,
          status: "discarded",
          resolvedAt: new Date(),
        })
        .returning(),
    );
    discardedDeadLetterId = discardedDl!.id;
  });

  afterAll(async () => {
    await withTenant(TENANT_ID, async (db) => {
      await db.delete(deadLetters).where(eq(deadLetters.tenantId, TENANT_ID));
      await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_ID));
      await db.delete(workflowSteps).where(eq(workflowSteps.workflowRunId, linkedWorkflowRunId));
      await db.delete(workflowRuns).where(eq(workflowRuns.id, linkedWorkflowRunId));
      await db.delete(commands).where(eq(commands.id, linkedCommandId));
    });
    await closePool();
  });

  it("a non-owner role is forbidden from listing the DLQ", async () => {
    const res = await listDlq(req("/api/dlq", { role: "analyst" }));
    expect(res.status).toBe(403);
  });

  it("owner lists open dead letters", async () => {
    const res = await listDlq(req("/api/dlq"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deadLetters.some((d: { id: string }) => d.id === openDeadLetterId)).toBe(true);
    expect(body.deadLetters.find((d: { id: string; relatedWorkflowRunId?: string }) => d.id === openDeadLetterId)?.relatedWorkflowRunId).toBe(linkedWorkflowRunId);
    expect(body.deadLetters.some((d: { id: string }) => d.id === discardedDeadLetterId)).toBe(false);
  });

  it("owner filters by status", async () => {
    const res = await listDlq(req("/api/dlq?status=discarded"));
    const body = await res.json();
    expect(body.deadLetters.map((d: { id: string }) => d.id)).toEqual([discardedDeadLetterId]);
  });

  it("owner inspects a single dead letter; 404 for an unknown id", async () => {
    const res = await inspectDlq(req(`/api/dlq/${openDeadLetterId}`), { params: Promise.resolve({ id: openDeadLetterId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deadLetter.lastError).toBe("provider timeout");

    const missing = await inspectDlq(req(`/api/dlq/00000000-0000-4000-9000-000000000000`), {
      params: Promise.resolve({ id: "00000000-0000-4000-9000-000000000000" }),
    });
    expect(missing.status).toBe(404);
  });

  it("replay resets the linked outbox event to pending and marks the dead letter replayed", async () => {
    const res = await replayDlq(req(`/api/dlq/${openDeadLetterId}/replay`, { method: "POST" }), { params: Promise.resolve({ id: openDeadLetterId }) });
    expect(res.status).toBe(200);
    expect((await res.json() as { workflowRunId: string | null }).workflowRunId).toBe(linkedWorkflowRunId);
    const [dl] = await withTenant(TENANT_ID, (db) => db.select().from(deadLetters).where(eq(deadLetters.id, openDeadLetterId)));
    expect(dl!.status).toBe("replayed");
    const [outboxRow] = await withTenant(TENANT_ID, (db) => db.select().from(outboxEvents).where(eq(outboxEvents.id, openOutboxEventId)));
    expect(outboxRow!.status).toBe("pending");

    // Already replayed — a second replay is a conflict, not a silent success.
    const again = await replayDlq(req(`/api/dlq/${openDeadLetterId}/replay`, { method: "POST" }), { params: Promise.resolve({ id: openDeadLetterId }) });
    expect(again.status).toBe(409);
  });

  it("discard on a non-replayable/terminal dead letter still works — discard never checks replayable", async () => {
    const [terminalDl] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(deadLetters)
        .values({
          tenantId: TENANT_ID,
          envelope: { type: "dlq.route.probe.3", version: 1, tenantId: TENANT_ID, occurredAt: new Date().toISOString(), payload: {} },
          errorKind: "terminal",
          attempts: 1,
          lastError: "bad payload",
          replayable: false,
          status: "open",
        })
        .returning(),
    );
    const res = await discardDlq(req(`/api/dlq/${terminalDl!.id}/discard`, { method: "POST" }), { params: Promise.resolve({ id: terminalDl!.id }) });
    expect(res.status).toBe(200);
    const [dl] = await withTenant(TENANT_ID, (db) => db.select().from(deadLetters).where(eq(deadLetters.id, terminalDl!.id)));
    expect(dl!.status).toBe("discarded");
  });
});
