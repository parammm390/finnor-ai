// Phase 7 MAESTRO PACK §7.1: GET /api/actions/pending now embeds each action's most
// recent DecisionReceipt so the Approval Inbox can render objective/evidence/policy/
// risk-tier without a second round trip per card.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, domainActions, decisionReceipts } from "@finnor/db";
import { eq } from "drizzle-orm";
import { openReceipt, finalizeReceipt } from "@finnor/workflow-runtime";
import { GET as pendingGET } from "../../apps/api/app/api/actions/pending/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ee";

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

function req(): Request {
  return new Request("http://localhost/api/actions/pending", { headers: { "x-tenant-id": TENANT_ID, "x-user-role": "owner" } });
}

describe.skipIf(!available)("GET /api/actions/pending — embedded receipts (Phase 7.1)", () => {
  afterAll(async () => {
    await withTenant(TENANT_ID, (db) => db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_ID)));
    await withTenant(TENANT_ID, (db) => db.delete(domainActions).where(eq(domainActions.tenantId, TENANT_ID)));
    await closePool();
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Pending Receipts Test" }).onConflictDoNothing());
  });

  it("embeds the latest receipt on a pending action with two receipts (retry case), and null on one with none", async () => {
    const [withReceiptAction] = await withTenant(TENANT_ID, (db) =>
      db.insert(domainActions).values({ tenantId: TENANT_ID, actionType: "send_service_reminder", payload: {}, status: "pending", summary: "has receipts" }).returning(),
    );
    const [noReceiptAction] = await withTenant(TENANT_ID, (db) =>
      db.insert(domainActions).values({ tenantId: TENANT_ID, actionType: "record_finding", payload: {}, status: "pending", summary: "no receipts yet" }).returning(),
    );

    const first = await openReceipt({
      tenantId: TENANT_ID,
      domainActionId: withReceiptAction!.id,
      objective: "first attempt",
      evidence: [],
      policyApplied: { id: "p1", version: 1 },
      riskTier: "medium",
      proposedAction: { actionType: "send_service_reminder" },
      approval: { required: true },
    });
    await finalizeReceipt(TENANT_ID, first.receiptId, { failure: { errorKind: "retryable", message: "transient", recoveryPath: "retried" } });
    // A short real delay so the second receipt's createdAt sorts strictly after the first.
    await new Promise((r) => setTimeout(r, 5));
    const second = await openReceipt({
      tenantId: TENANT_ID,
      domainActionId: withReceiptAction!.id,
      objective: "retry attempt (the latest one, should win)",
      evidence: [{ source: "diligence_documents", ref: "doc-1", timestamp: new Date().toISOString() }],
      policyApplied: { id: "p1", version: 2 },
      riskTier: "high",
      proposedAction: { actionType: "send_service_reminder" },
      approval: { required: true },
    });

    const res = await pendingGET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const withReceipt = body.actions.find((a: { id: string }) => a.id === withReceiptAction!.id);
    const noReceipt = body.actions.find((a: { id: string }) => a.id === noReceiptAction!.id);

    expect(withReceipt.receipt).not.toBeNull();
    expect(withReceipt.receipt.id).toBe(second.receiptId);
    expect(withReceipt.receipt.objective).toContain("retry attempt");
    expect(withReceipt.receipt.riskTier).toBe("high");
    expect(withReceipt.receipt.policyApplied).toEqual({ id: "p1", version: 2 });

    expect(noReceipt.receipt).toBeNull();
  });
});
