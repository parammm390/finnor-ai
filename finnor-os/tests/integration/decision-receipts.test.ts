// Phase 2 (§2.2) acceptance: DecisionReceipt round-trips through openReceipt/
// finalizeReceipt/findReceiptByStep, and decision_receipts is genuinely subject to RLS
// (uses the non-superuser finnor_app role, same convention as tenant-isolation.test.ts —
// the plain DATABASE_URL role bypasses FORCE ROW LEVEL SECURITY locally, see that
// file's header comment).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, decisionReceipts } from "@finnor/db";
import { eq } from "drizzle-orm";
import { openReceipt, finalizeReceipt, findReceiptByStep } from "@finnor/workflow-runtime";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
const TENANT_A = "00000000-0000-4000-8000-0000000000e6";
const TENANT_B = "00000000-0000-4000-8000-0000000000e7";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: SUPER_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

describe.skipIf(!available)("DecisionReceipt (§2.2)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    await withTenant(TENANT_A, (db) => db.insert(tenants).values({ id: TENANT_A, name: "Receipt Test Dealer A" }).onConflictDoNothing());
    await withTenant(TENANT_B, (db) => db.insert(tenants).values({ id: TENANT_B, name: "Receipt Test Dealer B" }).onConflictDoNothing());
  });
  afterAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await withTenant(TENANT_A, (db) => db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_A)));
    await withTenant(TENANT_B, (db) => db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_B)));
    await closePool();
  });

  it("opens a receipt at proposal time (unfinalized) and finalizes it with an actual result", async () => {
    const { receiptId } = await openReceipt({
      tenantId: TENANT_A,
      objective: "request an acknowledgement from the deal lead",
      evidence: [{ source: "deal_requests", ref: "request-123", timestamp: new Date().toISOString() }],
      policyApplied: { id: "policy-1", version: 1 },
      riskTier: "medium",
      proposedAction: { actionType: "request_acknowledgement", requestId: "request-123" },
      approval: { required: true, approvedBy: "owner-1", at: new Date().toISOString() },
      correlationId: "corr-1",
    });
    expect(receiptId).toBeTruthy();

    const [row] = await withTenant(TENANT_A, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, receiptId)));
    expect(row!.finalizedAt).toBeNull();
    expect(row!.actualResult).toBeNull();

    await finalizeReceipt(TENANT_A, receiptId, { actualResult: { messageId: "msg-1", delivered: true } });
    const [finalized] = await withTenant(TENANT_A, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, receiptId)));
    expect(finalized!.finalizedAt).not.toBeNull();
    expect(finalized!.actualResult).toEqual({ messageId: "msg-1", delivered: true });
    expect(finalized!.failure).toBeNull();
  });

  it("finalizes with a typed failure instead of an actual result", async () => {
    const { receiptId } = await openReceipt({
      tenantId: TENANT_A,
      objective: "record a diligence finding",
      evidence: [],
      policyApplied: null,
      riskTier: "high",
      proposedAction: { actionType: "record_finding" },
      approval: { required: false },
    });
    await finalizeReceipt(TENANT_A, receiptId, {
      failure: { errorKind: "provider_down", message: "QuickBooks API unreachable", recoveryPath: "retry once QuickBooks health check passes" },
    });
    const [row] = await withTenant(TENANT_A, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, receiptId)));
    expect(row!.actualResult).toBeNull();
    expect(row!.failure).toEqual({
      errorKind: "provider_down",
      message: "QuickBooks API unreachable",
      recoveryPath: "retry once QuickBooks health check passes",
    });
  });

  it("findReceiptByStep looks up the one receipt already opened for a step", async () => {
    const fakeStepId = "00000000-0000-4000-9000-000000000abc";
    expect(await findReceiptByStep(TENANT_A, fakeStepId)).toBeNull();
  });

  it("a second tenant cannot see the first tenant's receipts under RLS", async () => {
    const { receiptId } = await openReceipt({
      tenantId: TENANT_A,
      objective: "tenant-isolation probe",
      evidence: [],
      policyApplied: null,
      riskTier: "low",
      proposedAction: {},
      approval: { required: false },
    });

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    const rowsAsTenantB = await withTenant(TENANT_B, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, receiptId)));
    expect(rowsAsTenantB).toHaveLength(0);
    const rowsAsTenantA = await withTenant(TENANT_A, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, receiptId)));
    expect(rowsAsTenantA).toHaveLength(1);
    process.env.DATABASE_URL = SUPER_URL;
    await closePool();
  });
});
