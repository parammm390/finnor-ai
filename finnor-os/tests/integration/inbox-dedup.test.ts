// Inbox dedup acceptance (Phase 2 proof item 2): send one inbound provider event twice
// (once normal, once replayed) — confirm one business effect and one inbox_events row
// marked duplicate.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, workflowSteps, workflowRuns, commands, inboxEvents, reconciliationCases, decisionReceipts } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { submitCommand, claimStep, completeStep, receiveInboxEvent } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000d3";

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

async function newStep(): Promise<{ stepId: string; workflowRunId: string }> {
  const submitted = await withTenant(TENANT_ID, (db) =>
    submitCommand(db, {
      tenantId: TENANT_ID,
      commandType: "inbox_dedup_test",
      payload: {},
      workflowType: "inbox_dedup_test",
      steps: [{ stepType: "step_a", payload: {} }],
    }),
  );
  return { stepId: submitted.stepIds[0]!, workflowRunId: submitted.workflowRunId };
}

describe.skipIf(!available)("inbox event dedup + matching", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Inbox Dedup Test Dealer" }).onConflictDoNothing());
  });
  afterAll(async () => {
    await withTenant(TENANT_ID, async (db) => {
      await db.delete(reconciliationCases).where(eq(reconciliationCases.tenantId, TENANT_ID));
      await db.delete(inboxEvents).where(eq(inboxEvents.tenantId, TENANT_ID));
      await db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_ID));
      await db.delete(workflowSteps).where(eq(workflowSteps.tenantId, TENANT_ID));
      await db.delete(workflowRuns).where(eq(workflowRuns.tenantId, TENANT_ID));
      await db.delete(commands).where(eq(commands.tenantId, TENANT_ID));
    });
    await closePool();
  });

  it("sending the same (provider, event_id) twice applies the business effect once and marks the replay duplicate", async () => {
    const { stepId } = await newStep();
    // An inbound provider event settles an open execution, so the durable step
    // must be leased before the event can finalize it.
    expect(await claimStep(TENANT_ID, stepId)).toBeTruthy();
    let appliedCount = 0;

    async function deliver() {
      const result = await receiveInboxEvent({
        tenantId: TENANT_ID,
        provider: "test_provider",
        eventId: "evt-replay-1",
        payload: { confirmed: true },
        matchStepId: stepId,
      });
      // Mirrors the real caller contract: only apply the business effect on a genuine
      // (non-duplicate) match — never on a replay.
      if (result.status === "matched") {
        appliedCount++;
        await completeStep(TENANT_ID, stepId, { confirmedByProvider: true });
      }
      return result;
    }

    const first = await deliver(); // normal delivery
    const second = await deliver(); // replayed delivery

    expect(first.status).toBe("matched");
    expect(second.status).toBe("duplicate");
    expect(appliedCount).toBe(1); // exactly one business effect

    const rows = await withTenant(TENANT_ID, (db) =>
      db.select().from(inboxEvents).where(and(eq(inboxEvents.provider, "test_provider"), eq(inboxEvents.eventId, "evt-replay-1"))),
    );
    expect(rows).toHaveLength(1); // never a second row for the same (provider, event_id)
    // A replay result is duplicate, but the durable processing state retains the
    // original semantic outcome instead of regressing matched -> duplicate.
    expect(rows[0]!.status).toBe("matched");

    const [step] = await withTenant(TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)));
    expect(step!.status).toBe("completed");
  });

  it("an inbound event that can't be matched to any open step opens a reconciliation_case", async () => {
    const result = await receiveInboxEvent({
      tenantId: TENANT_ID,
      provider: "test_provider",
      eventId: "evt-unmatched-1",
      payload: { foo: "bar" },
      // no matchStepId — nothing to correlate this to
    });
    expect(result.status).toBe("unmatched");

    const cases = await withTenant(TENANT_ID, (db) =>
      db.select().from(reconciliationCases).where(and(eq(reconciliationCases.tenantId, TENANT_ID), eq(reconciliationCases.caseType, "unmatched_inbox_event"))),
    );
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });
});
