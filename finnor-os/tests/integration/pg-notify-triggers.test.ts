// B1.T1 acceptance: every table the plan names (action_log, workflow_steps,
// dead_letters, domain_actions(status)) — plus the canonical Work operational delta — actually
// fires a real 'jarvis_events' NOTIFY carrying {tenantId, kind, id, ts} on a real
// Postgres LISTEN connection. Not a unit test of the trigger SQL in isolation — a real
// dedicated pg.Client LISTENs, real drizzle inserts/updates run through adminDb(), and
// the notification payload's fields are asserted directly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  getPool,
  closePool,
  adminDb,
  tenants,
  domainActions,
  actionLog,
  commands,
  workflowRuns,
  workflowSteps,
  deadLetters,
  works,
} from "@finnor/db";
import { eq } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

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

interface JarvisEvent {
  tenantId: string;
  kind: string;
  id: string;
  ts: string;
}

describe.skipIf(!available)("B1.T1 — jarvis_events NOTIFY triggers", () => {
  let listener: pg.Client;
  let events: JarvisEvent[] = [];
  let tenantId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);

    const [tenant] = await adminDb().insert(tenants).values({ name: "B1.T1 notify-trigger test tenant" }).returning();
    tenantId = tenant!.id;

    listener = new pg.Client({ connectionString: DB_URL });
    await listener.connect();
    await listener.query("LISTEN jarvis_events");
    listener.on("notification", (msg) => {
      if (msg.channel !== "jarvis_events" || !msg.payload) return;
      events.push(JSON.parse(msg.payload) as JarvisEvent);
    });
  });

  afterAll(async () => {
    await listener.query("UNLISTEN jarvis_events").catch(() => undefined);
    await listener.end();
    await closePool();
  });

  async function waitForKind(kind: string, timeoutMs = 3000): Promise<JarvisEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find((e) => e.kind === kind && e.tenantId === tenantId);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`No '${kind}' jarvis_events notification arrived within ${timeoutMs}ms. Seen: ${JSON.stringify(events)}`);
  }

  it("fires on domain_actions insert and on status update", async () => {
    const [action] = await adminDb()
      .insert(domainActions)
      .values({ tenantId, actionType: "test_action", payload: {}, status: "draft" })
      .returning();
    const inserted = await waitForKind("domain_action");
    expect(inserted.id).toBe(action!.id);

    events = [];
    await adminDb().update(domainActions).set({ status: "pending" }).where(eq(domainActions.id, action!.id));
    const updated = await waitForKind("domain_action");
    expect(updated.id).toBe(action!.id);
  });

  it("fires on action_log insert (append-only)", async () => {
    const [action] = await adminDb()
      .insert(domainActions)
      .values({ tenantId, actionType: "test_action", payload: {}, status: "draft" })
      .returning();
    events = [];
    const [log] = await adminDb()
      .insert(actionLog)
      .values({ domainActionId: action!.id, tenantId, step: "drafted", input: {}, output: {} })
      .returning();
    const seen = await waitForKind("action_log");
    expect(seen.id).toBe(log!.id);
  });

  it("fires on workflow_steps insert and update", async () => {
    const [command] = await adminDb().insert(commands).values({ tenantId, commandType: "test_command" }).returning();
    const [run] = await adminDb()
      .insert(workflowRuns)
      .values({ tenantId, commandId: command!.id, workflowType: "test_workflow" })
      .returning();
    events = [];
    const [step] = await adminDb()
      .insert(workflowSteps)
      .values({ tenantId, workflowRunId: run!.id, stepType: "test_step", sequence: 1, idempotencyKey: "test-step-1" })
      .returning();
    const inserted = await waitForKind("workflow_step");
    expect(inserted.id).toBe(step!.id);

    events = [];
    await adminDb().update(workflowSteps).set({ status: "completed" }).where(eq(workflowSteps.id, step!.id));
    const updated = await waitForKind("workflow_step");
    expect(updated.id).toBe(step!.id);
  });

  it("fires on dead_letters insert", async () => {
    events = [];
    const [dl] = await adminDb()
      .insert(deadLetters)
      .values({ tenantId, envelope: { type: "test" }, errorKind: "terminal", lastError: "test failure" })
      .returning();
    const seen = await waitForKind("dead_letter");
    expect(seen.id).toBe(dl!.id);
  });

  it("fires on canonical Work insert (operational delta)", async () => {
    events = [];
    const [work] = await adminDb()
      .insert(works)
      .values({
        tenantId,
        initialChannel: "console",
        initialInstruction: "notify test work",
      })
      .returning();
    const seen = await waitForKind("operational_delta");
    expect(seen.id).toMatch(/^\d+$/);
    expect(work!.id).toBeTruthy();
  });
});
