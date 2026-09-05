// P2.T1 — the Work correlation matrix against the real tenant-scoped projection.
// The fixture intentionally reuses one household/invoice across distinct instruction
// roots to prove those records do not merge. No customer/time/text grouping is used.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { workCases } from "../../packages/read-models";
import {
  actionLog,
  businessEvents,
  calls,
  closePool,
  commands,
  decisionReceipts,
  domainActions,
  instructionEvents,
  instructionSessions,
  pendingConfirmations,
  tenants,
  voiceSessions,
  voiceTurns,
  withTenant,
  works,
  workflowRuns,
  workflowSteps,
} from "@finnor/db";
import { GET } from "../../apps/api/app/api/read-models/[view]/route";
import { and, eq, sql } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000002f1";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000002f2";
const HOUSEHOLD_ID = "00000000-0000-4000-8000-0000000002a1";
const INVOICE_ID = "00000000-0000-4000-8000-0000000002a2";
const INSTRUCTION_A = "00000000-0000-4000-8000-0000000002b1";
const INSTRUCTION_B = "00000000-0000-4000-8000-0000000002b2";
const INSTRUCTION_C = "00000000-0000-4000-8000-0000000002b3";
const ACTION_A1 = "00000000-0000-4000-8000-0000000002c1";
const ACTION_A2 = "00000000-0000-4000-8000-0000000002c2";
const ACTION_B = "00000000-0000-4000-8000-0000000002c3";
const ACTION_C = "00000000-0000-4000-8000-0000000002c4";
const COMMAND_A = "00000000-0000-4000-8000-0000000002d1";
const RUN_A = "00000000-0000-4000-8000-0000000002e1";
const STEP_A = "00000000-0000-4000-8000-0000000002f1";
const RECEIPT_A = "00000000-0000-4000-8000-0000000002f2";
const VOICE_SESSION = "00000000-0000-4000-8000-0000000002f3";
const CALL_EXTERNAL_ID = "p2-t1-call-0001";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await dbUp();

function request(query = ""): Request {
  return new Request(`http://localhost/api/read-models/work-cases${query}`, {
    headers: { "x-tenant-id": TENANT_ID, "x-user-role": "owner" },
  });
}

describe.skipIf(!available)("P2.T1 Work correlation + derived projection", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, async (db) => {
      await db.insert(tenants).values({ id: TENANT_ID, name: "P2 T1 Work Correlation" }).onConflictDoNothing();
      await db.insert(tenants).values({ id: OTHER_TENANT_ID, name: "P2 T1 Other Tenant" }).onConflictDoNothing();
      await db.insert(instructionSessions).values([
        { id: INSTRUCTION_A, tenantId: TENANT_ID, instructionText: "Prepare Henderson service and payment follow-up", source: "typed" },
        { id: INSTRUCTION_B, tenantId: TENANT_ID, instructionText: "Follow up with the Henderson household", source: "typed" },
        { id: INSTRUCTION_C, tenantId: TENANT_ID, instructionText: "Run the failed Henderson repair", source: "typed" },
      ]);
      await db.insert(instructionEvents).values([
        { tenantId: TENANT_ID, instructionId: INSTRUCTION_A, seq: 1, phase: "action_created", payload: { actionId: ACTION_A1 } },
        { tenantId: TENANT_ID, instructionId: INSTRUCTION_A, seq: 2, phase: "action_gated", payload: { actionId: ACTION_A2 } },
        { tenantId: TENANT_ID, instructionId: INSTRUCTION_B, seq: 1, phase: "action_gated", payload: { actionId: ACTION_B } },
        { tenantId: TENANT_ID, instructionId: INSTRUCTION_C, seq: 1, phase: "failed", payload: { actionId: ACTION_C } },
      ]);
      await db.insert(domainActions).values([
        { id: ACTION_A1, tenantId: TENANT_ID, actionType: "schedule_water_test", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "completed", summary: "Schedule the Henderson service", instructionId: INSTRUCTION_A },
        { id: ACTION_A2, tenantId: TENANT_ID, actionType: "send_payment_reminder", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "pending", summary: "Ask for approval to send the payment reminder", instructionId: INSTRUCTION_A },
        { id: ACTION_B, tenantId: TENANT_ID, actionType: "send_payment_reminder", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "pending", summary: "Send a separate Henderson payment reminder", instructionId: INSTRUCTION_B },
        { id: ACTION_C, tenantId: TENANT_ID, actionType: "repair_visit", payload: { householdId: HOUSEHOLD_ID }, status: "failed", summary: "Repair the Henderson system", instructionId: INSTRUCTION_C },
        { id: "00000000-0000-4000-8000-0000000002c5", tenantId: OTHER_TENANT_ID, actionType: "send_payment_reminder", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "pending", summary: "Other tenant action" },
      ]);
      await db.insert(voiceSessions).values({ id: VOICE_SESSION, tenantId: TENANT_ID, callExternalId: CALL_EXTERNAL_ID });
      await db.insert(pendingConfirmations).values({ tenantId: TENANT_ID, voiceSessionId: VOICE_SESSION, domainActionId: ACTION_B, promptText: "Send the separate reminder" });
      await db.insert(commands).values({ id: COMMAND_A, tenantId: TENANT_ID, commandType: "schedule_water_test", payload: { householdId: HOUSEHOLD_ID }, correlationId: "p2-t1-trace" });
      await db.insert(workflowRuns).values({ id: RUN_A, tenantId: TENANT_ID, commandId: COMMAND_A, workflowType: "single_action", status: "completed" });
      await db.insert(workflowSteps).values({ tenantId: TENANT_ID, id: STEP_A, workflowRunId: RUN_A, stepType: "schedule_water_test", sequence: 0, status: "completed", idempotencyKey: "p2-t1-step", domainActionId: ACTION_A1, evidence: { invoiceId: INVOICE_ID } });
      await db.insert(decisionReceipts).values({ id: RECEIPT_A, tenantId: TENANT_ID, workflowRunId: RUN_A, workflowStepId: STEP_A, domainActionId: ACTION_A1, objective: "Schedule the Henderson service", evidence: [{ source: "test", ref: "p2-t1" }], actualResult: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, finalizedAt: new Date() });
      await db.insert(voiceTurns).values({ tenantId: TENANT_ID, voiceSessionId: VOICE_SESSION, sequence: 1, role: "caller", transcriptText: "yes", resolvedActionIds: [ACTION_B] });
      await db.insert(calls).values({ tenantId: TENANT_ID, direction: "inbound", transcript: "Please follow up", sourceSystem: "vapi", externalId: CALL_EXTERNAL_ID });
      await db.insert(businessEvents).values({ tenantId: TENANT_ID, entityType: "household", entityId: HOUSEHOLD_ID, eventType: "service_scheduled", source: "p2-t1" });
    });
  });

  afterAll(async () => {
    await withTenant(TENANT_ID, async (db) => {
      await db.execute(sql`SELECT set_config('app.allow_audit_mutation', 'true', true)`);
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.tenantId, TENANT_ID));
      await db.delete(voiceTurns).where(eq(voiceTurns.tenantId, TENANT_ID));
      await db.delete(calls).where(eq(calls.tenantId, TENANT_ID));
      await db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_ID));
      await db.delete(workflowSteps).where(eq(workflowSteps.tenantId, TENANT_ID));
      await db.delete(workflowRuns).where(eq(workflowRuns.tenantId, TENANT_ID));
      await db.delete(commands).where(eq(commands.tenantId, TENANT_ID));
      await db.delete(domainActions).where(eq(domainActions.tenantId, TENANT_ID));
      await db.delete(instructionEvents).where(eq(instructionEvents.tenantId, TENANT_ID));
      await db.delete(instructionSessions).where(eq(instructionSessions.tenantId, TENANT_ID));
      await db.delete(voiceSessions).where(eq(voiceSessions.tenantId, TENANT_ID));
      await db.delete(businessEvents).where(and(eq(businessEvents.tenantId, TENANT_ID), eq(businessEvents.source, "p2-t1")));
    });
    await withTenant(OTHER_TENANT_ID, async (db) => {
      await db.delete(domainActions).where(eq(domainActions.tenantId, OTHER_TENANT_ID));
    });
    await closePool();
  });

  it("keeps one instruction root for multiple exact actions and carries action → run → step → receipt", async () => {
    const result = await workCases(TENANT_ID);
    const root = result.find((item) => item.root.kind === "instruction" && item.root.id === INSTRUCTION_A);
    expect(root).toBeDefined();
    expect(root!.actions.map((action) => action.id)).toEqual([ACTION_A1, ACTION_A2]);
    expect(root!.workflows.map((workflow) => workflow.id)).toEqual([RUN_A]);
    expect(root!.workflows[0]!.steps.map((step) => step.id)).toEqual([STEP_A]);
    expect(root!.receipts.map((receipt) => receipt.id)).toEqual([RECEIPT_A]);
    expect(root!.linkedEntities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "household", entityId: HOUSEHOLD_ID }),
      expect.objectContaining({ entityType: "invoice", entityId: INVOICE_ID }),
    ]));
    expect(root!.businessEvents.map((event) => event.eventType)).toContain("service_scheduled");
    expect(root!.status).toBe("Needs you");
  });

  it("does not merge same customer or same invoice across separate instruction roots", async () => {
    const result = await workCases(TENANT_ID);
    const first = result.find((item) => item.root.kind === "instruction" && item.root.id === INSTRUCTION_A)!;
    const second = result.find((item) => item.root.kind === "instruction" && item.root.id === INSTRUCTION_B)!;
    expect(first.id).not.toBe(second.id);
    expect(first.linkedEntities.some((link) => link.entityId === HOUSEHOLD_ID)).toBe(true);
    expect(second.linkedEntities.some((link) => link.entityId === HOUSEHOLD_ID)).toBe(true);
    expect(first.linkedEntities.some((link) => link.entityId === INVOICE_ID)).toBe(true);
    expect(second.linkedEntities.some((link) => link.entityId === INVOICE_ID)).toBe(true);
  });

  it("keeps approval pending without inventing a run or receipt and links the exact call", async () => {
    const result = await workCases(TENANT_ID);
    const root = result.find((item) => item.root.kind === "instruction" && item.root.id === INSTRUCTION_B)!;
    expect(root.approvals).toEqual([expect.objectContaining({ actionId: ACTION_B, status: "pending" })]);
    expect(root.workflows).toHaveLength(0);
    expect(root.receipts).toHaveLength(0);
    expect(root.calls).toHaveLength(1);
  });

  it("projects terminal failure as Failed and exposes the exact tenant boundary", async () => {
    const result = await workCases(TENANT_ID);
    const failed = result.find((item) => item.root.kind === "instruction" && item.root.id === INSTRUCTION_C)!;
    expect(failed.status).toBe("Failed");
    expect(result.some((item) => item.title === "Other tenant action")).toBe(false);
    expect((await GET(new Request("http://localhost/api/read-models/work-cases"), { params: Promise.resolve({ view: "work-cases" }) })).status).toBe(401);
    const response = await GET(request(), { params: Promise.resolve({ view: "work-cases" }) });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: WorkCaseProjection[] }).data.some((item) => item.root.id === INSTRUCTION_A)).toBe(true);
  });

  it("paginates bounded legacy roots and reports its completeness contract", async () => {
    const first = await GET(request("?limit=2"), { params: Promise.resolve({ view: "work-cases" }) });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      data: WorkCaseProjection[];
      page: { limit: number; hasMore: boolean; nextCursor: string | null; rootScope: string; childRowsTruncated: boolean };
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.page).toMatchObject({ limit: 2, hasMore: true, rootScope: "legacy_instruction", childRowsTruncated: false });
    expect(firstBody.page.nextCursor).toEqual(expect.any(String));

    const second = await GET(request(`?limit=2&cursor=${encodeURIComponent(firstBody.page.nextCursor!)}`), { params: Promise.resolve({ view: "work-cases" }) });
    const secondBody = await second.json() as { data: WorkCaseProjection[]; page: { hasMore: boolean; nextCursor: string | null } };
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...firstBody.data, ...secondBody.data].map((item) => item.id)).size).toBe(3);
  });

  it("continues from canonical Work into legacy history without hiding either scope", async () => {
    const [work] = await withTenant(TENANT_ID, (db) => db.insert(works).values({
      tenantId: TENANT_ID,
      initialChannel: "text",
      initialInstruction: "Canonical root before legacy history",
      status: "executing",
    }).returning());
    const canonical = await GET(request("?limit=1"), { params: Promise.resolve({ view: "work-cases" }) });
    const canonicalBody = await canonical.json() as {
      data: WorkCaseProjection[];
      page: { rootScope: string; hasMore: boolean; nextCursor: string | null };
    };
    expect(canonicalBody.data.map((item) => item.root.id)).toEqual([work!.id]);
    expect(canonicalBody.page).toMatchObject({ rootScope: "canonical_work", hasMore: true });

    const legacy = await GET(request(`?limit=1&cursor=${encodeURIComponent(canonicalBody.page.nextCursor!)}`), { params: Promise.resolve({ view: "work-cases" }) });
    const legacyBody = await legacy.json() as { data: WorkCaseProjection[]; page: { rootScope: string } };
    expect(legacyBody.page.rootScope).toBe("legacy_instruction");
    expect(legacyBody.data[0]?.root.kind).toBe("instruction");
    // Operational deltas are append-only and may retain this Work as provenance.
    // The isolated test database owns the fixture lifecycle; deleting Work would
    // attempt to rewrite that immutable audit record through ON DELETE SET NULL.
  });
});

type WorkCaseProjection = Awaited<ReturnType<typeof workCases>>[number];
