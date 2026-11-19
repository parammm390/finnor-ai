// P2.T1 — the Work correlation matrix against the real tenant-scoped projection.
// The fixture intentionally reuses one household/invoice across distinct instruction
// roots to prove those records do not merge. No customer/time/text grouping is used.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../packages/db/migrate";
import { workCases, workCasesPage } from "../../packages/read-models";
import {
  actionLog,
  businessEvents,
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
  users,
  workflowRuns,
  workflowSteps,
} from "@finnor/db";
import { GET } from "../../apps/api/app/api/read-models/[view]/route";
import { and, eq, sql } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
// Canonical Work retains append-only deltas after this fixture's legacy rows are
// cleaned up. A fresh tenant keeps repeated runs independent without erasing it.
const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const HOUSEHOLD_ID = randomUUID();
const INVOICE_ID = randomUUID();
const OWNER_ID = randomUUID();
const PEER_ID = randomUUID();
const INSTRUCTION_A = randomUUID();
const INSTRUCTION_B = randomUUID();
const INSTRUCTION_C = randomUUID();
const ACTION_A1 = randomUUID();
const ACTION_A2 = randomUUID();
const ACTION_B = randomUUID();
const ACTION_C = randomUUID();
const COMMAND_A = randomUUID();
const RUN_A = randomUUID();
const STEP_A = randomUUID();
const RECEIPT_A = randomUUID();
const VOICE_SESSION = randomUUID();
const CALL_EXTERNAL_ID = `p2-t1-call-${VOICE_SESSION}`;

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
    headers: { "x-tenant-id": TENANT_ID, "x-user-role": "owner", "x-user-id": OWNER_ID },
  });
}

describe.skipIf(!available)("P2.T1 Work correlation + derived projection", () => {
  beforeAll(async () => {
    console.log("WORK_CASE_FIXTURE_INPUTS", JSON.stringify({ tenantId: TENANT_ID, otherTenantId: OTHER_TENANT_ID,
      instructionIds: [INSTRUCTION_A, INSTRUCTION_B, INSTRUCTION_C], actionIds: [ACTION_A1, ACTION_A2, ACTION_B, ACTION_C],
      workflowRunId: RUN_A, workflowStepId: STEP_A, receiptId: RECEIPT_A, voiceSessionId: VOICE_SESSION }));
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, async (db) => {
      await db.insert(tenants).values({ id: TENANT_ID, name: "P2 T1 Work Correlation" }).onConflictDoNothing();
      await db.insert(tenants).values({ id: OTHER_TENANT_ID, name: "P2 T1 Other Tenant" }).onConflictDoNothing();
      await db.insert(users).values([
        { id: OWNER_ID, tenantId: TENANT_ID, email: `case-owner-${OWNER_ID}@example.test`, role: "owner" },
        { id: PEER_ID, tenantId: TENANT_ID, email: `case-peer-${PEER_ID}@example.test`, role: "dispatcher" },
      ]);
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
        { id: ACTION_A1, tenantId: TENANT_ID, actionType: "schedule_water_test", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "completed", summary: "Schedule the Henderson service", instructionId: INSTRUCTION_A, createdAt: new Date("2026-09-01T00:00:00.000Z") },
        { id: ACTION_A2, tenantId: TENANT_ID, actionType: "send_payment_reminder", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "pending", summary: "Ask for approval to send the payment reminder", instructionId: INSTRUCTION_A, createdAt: new Date("2026-09-01T00:00:01.000Z") },
        { id: ACTION_B, tenantId: TENANT_ID, actionType: "send_payment_reminder", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "pending", summary: "Send a separate Henderson payment reminder", instructionId: INSTRUCTION_B },
        { id: ACTION_C, tenantId: TENANT_ID, actionType: "repair_visit", payload: { householdId: HOUSEHOLD_ID }, status: "failed", summary: "Repair the Henderson system", instructionId: INSTRUCTION_C },
        { id: randomUUID(), tenantId: OTHER_TENANT_ID, actionType: "send_payment_reminder", payload: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, status: "pending", summary: "Other tenant action" },
      ]);
      await db.insert(voiceSessions).values({ id: VOICE_SESSION, tenantId: TENANT_ID, callExternalId: CALL_EXTERNAL_ID });
      await db.insert(pendingConfirmations).values({ tenantId: TENANT_ID, voiceSessionId: VOICE_SESSION, domainActionId: ACTION_B, promptText: "Send the separate reminder" });
      await db.insert(commands).values({ id: COMMAND_A, tenantId: TENANT_ID, commandType: "schedule_water_test", payload: { householdId: HOUSEHOLD_ID }, correlationId: "p2-t1-trace" });
      await db.insert(workflowRuns).values({ id: RUN_A, tenantId: TENANT_ID, commandId: COMMAND_A, workflowType: "single_action", status: "completed" });
      await db.insert(workflowSteps).values({ tenantId: TENANT_ID, id: STEP_A, workflowRunId: RUN_A, stepType: "schedule_water_test", sequence: 0, status: "completed", idempotencyKey: `p2-t1-step-${STEP_A}`, domainActionId: ACTION_A1, evidence: { invoiceId: INVOICE_ID } });
      await db.insert(decisionReceipts).values({ id: RECEIPT_A, tenantId: TENANT_ID, workflowRunId: RUN_A, workflowStepId: STEP_A, domainActionId: ACTION_A1, objective: "Schedule the Henderson service", evidence: [{ source: "test", ref: "p2-t1" }], actualResult: { householdId: HOUSEHOLD_ID, invoiceId: INVOICE_ID }, finalizedAt: new Date() });
      await db.insert(voiceTurns).values({ tenantId: TENANT_ID, voiceSessionId: VOICE_SESSION, sequence: 1, role: "caller", transcriptText: "yes", resolvedActionIds: [ACTION_B] });
      await db.insert(businessEvents).values({ tenantId: TENANT_ID, entityType: "household", entityId: HOUSEHOLD_ID, eventType: "service_scheduled", source: "p2-t1" });
    });
  });

  afterAll(async () => {
    await withTenant(TENANT_ID, async (db) => {
      await db.execute(sql`SELECT set_config('app.allow_audit_mutation', 'true', true)`);
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.tenantId, TENANT_ID));
      await db.delete(voiceTurns).where(eq(voiceTurns.tenantId, TENANT_ID));
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

  it("keeps approval pending without inventing a run or receipt and preserves the exact voice confirmation context", async () => {
    const result = await workCases(TENANT_ID);
    const root = result.find((item) => item.root.kind === "instruction" && item.root.id === INSTRUCTION_B)!;
    expect(root.approvals).toEqual([expect.objectContaining({ actionId: ACTION_B, status: "pending" })]);
    expect(root.workflows).toHaveLength(0);
    expect(root.receipts).toHaveLength(0);
    // The retired Water call table is unavailable to a Core/none tenant. The
    // durable voice session/turn still proves the confirmation context without
    // manufacturing an unsupported call row.
    expect(root.calls).toHaveLength(0);
  });

  it("projects terminal failure as Failed and exposes the exact tenant boundary", async () => {
    const result = await workCases(TENANT_ID);
    const failed = result.find((item) => item.root.kind === "instruction" && item.root.id === INSTRUCTION_C)!;
    expect(failed.status).toBe("Failed");
    expect(result.some((item) => item.title === "Other tenant action")).toBe(false);
    expect((await GET(new Request("http://localhost/api/read-models/work-cases"), { params: Promise.resolve({ view: "work-cases" }) })).status).toBe(401);
    const response = await GET(request(), { params: Promise.resolve({ view: "work-cases" }) });
    expect(response.status).toBe(200);
    const scoped = await response.json() as { data: WorkCaseProjection[]; page: { rootScope: string } };
    expect(scoped.data).toEqual([]);
    expect(scoped.page.rootScope).toBe("canonical_work");
    expect(JSON.stringify(scoped)).not.toContain("Henderson");
  });

  it("preserves bounded legacy paging internally without exposing unowned history through HTTP", async () => {
    const first = await workCasesPage(TENANT_ID, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.page).toMatchObject({ limit: 2, hasMore: true, rootScope: "legacy_instruction", childRowsTruncated: false });
    expect(first.page.nextCursor).toEqual(expect.any(String));

    const second = await workCasesPage(TENANT_ID, { limit: 2, cursor: first.page.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(3);
  });

  it("preserves internal legacy fallthrough but lets employees see only participating Work", async () => {
    const secret = `case-private-${randomUUID()}`;
    const [work] = await withTenant(TENANT_ID, db => db.insert(works).values({
      tenantId: TENANT_ID, createdBy: OWNER_ID, currentOwnerId: OWNER_ID,
      initialChannel: "text", initialInstruction: "Canonical root before legacy history",
      status: "executing",
    }).returning());
    const internal = await workCasesPage(TENANT_ID, { limit: 1 });
    expect(internal.items.map(item => item.root.id)).toEqual([work!.id]);
    expect(internal.page).toMatchObject({ rootScope: "canonical_work", hasMore: true });
    const legacy = await workCasesPage(TENANT_ID, { limit: 1, cursor: internal.page.nextCursor! });
    expect(legacy.page.rootScope).toBe("legacy_instruction");
    expect(legacy.items[0]?.root.kind).toBe("instruction");

    const foreign = await withTenant(TENANT_ID, db => db.insert(works).values({
      tenantId: TENANT_ID, createdBy: PEER_ID, currentOwnerId: PEER_ID,
      initialChannel: "text", initialInstruction: secret, status: "received",
    }).returning());
    const owner = await GET(request("?limit=100"), { params: Promise.resolve({ view: "work-cases" }) });
    const ownerPage = await owner.json() as { data: WorkCaseProjection[]; page: { rootScope: string } };
    expect(ownerPage.page.rootScope).toBe("canonical_work");
    expect(owner.headers.get("cache-control")).toBe("private, no-store");
    expect(ownerPage.data.map(item => item.root.id)).toContain(work!.id);
    expect(ownerPage.data.map(item => item.root.id)).not.toContain(foreign[0]!.id);
    expect(JSON.stringify(ownerPage)).not.toContain(secret);

    const peerRequest = new Request("http://localhost/api/read-models/work-cases", {
      headers: { "x-tenant-id": TENANT_ID, "x-user-id": PEER_ID, "x-user-role": "owner" },
    });
    const peerResponse = await GET(peerRequest, { params: Promise.resolve({ view: "work-cases" }) });
    const peerPage = await peerResponse.json() as { data: WorkCaseProjection[] };
    expect(peerPage.data.map(item => item.root.id)).toContain(foreign[0]!.id);
    expect(peerPage.data.map(item => item.root.id)).not.toContain(work!.id);

    // An explicit assignment is a valid existing Work relationship.
    await withTenant(TENANT_ID, db => db.update(works).set({ assignedTo: OWNER_ID }).where(eq(works.id, foreign[0]!.id)));
    const assigned = await GET(request("?limit=100"), { params: Promise.resolve({ view: "work-cases" }) });
    const assignedPage = await assigned.json() as { data: WorkCaseProjection[] };
    expect(assignedPage.data.map(item => item.root.id)).toContain(foreign[0]!.id);

    await withTenant(TENANT_ID, db => db.update(users).set({ status: "suspended" }).where(eq(users.id, PEER_ID)));
    const suspended = await GET(peerRequest, { params: Promise.resolve({ view: "work-cases" }) });
    expect((await suspended.json() as { data: WorkCaseProjection[] }).data).toEqual([]);
    await withTenant(TENANT_ID, db => db.update(users).set({ status: "active" }).where(eq(users.id, PEER_ID)));
    // Historical internal retention is untouched. No destructive cleanup of audit truth.
  });

});

type WorkCaseProjection = Awaited<ReturnType<typeof workCases>>[number];
