// Phase 7 MAESTRO PACK §7.1/§7.3 — the Approval Inbox and the "Why?" view both need to
// fetch a DecisionReceipt from the frontend: by domain-action/step/run id (list lookup)
// or directly by its own id (detail view). Real routes, real DB, real tenant scoping —
// no mocks, matching decision-receipts.test.ts's own conventions.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, decisionReceipts, domainActions } from "@finnor/db";
import { eq } from "drizzle-orm";
import { openReceipt } from "@finnor/workflow-runtime";
import { GET as getReceiptById } from "../../apps/api/app/api/receipts/[id]/route";
import { GET as listReceipts } from "../../apps/api/app/api/receipts/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_A = "00000000-0000-4000-8000-0000000000eb";
const TENANT_B = "00000000-0000-4000-8000-0000000000ec";

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

function req(tenantId: string, url: string): Request {
  return new Request(url, { headers: { "x-tenant-id": tenantId, "x-user-role": "owner" } });
}

describe.skipIf(!available)("GET /api/receipts (Phase 7.1/7.3)", () => {
  let receiptId: string;
  let domainActionId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_A, (db) => db.insert(tenants).values({ id: TENANT_A, name: "Receipts Route Test A" }).onConflictDoNothing());
    await withTenant(TENANT_B, (db) => db.insert(tenants).values({ id: TENANT_B, name: "Receipts Route Test B" }).onConflictDoNothing());
    const [action] = await withTenant(TENANT_A, (db) =>
      db
        .insert(domainActions)
        .values({ tenantId: TENANT_A, actionType: "send_service_reminder", payload: {}, status: "pending", summary: "test" })
        .returning(),
    );
    domainActionId = action!.id;
    const opened = await openReceipt({
      tenantId: TENANT_A,
      domainActionId,
      objective: "request acknowledgement of an open diligence item",
      evidence: [{ source: "deal_requests", ref: "request-42", timestamp: new Date().toISOString() }],
      policyApplied: { id: "policy-amc-reminder", version: 3 },
      riskTier: "low",
      proposedAction: { actionType: "send_service_reminder" },
      approval: { required: true },
    });
    receiptId = opened.receiptId;
  });

  afterAll(async () => {
    await withTenant(TENANT_A, (db) => db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_A)));
    await withTenant(TENANT_B, (db) => db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_B)));
    await withTenant(TENANT_A, (db) => db.delete(domainActions).where(eq(domainActions.tenantId, TENANT_A)));
    await closePool();
  });

  it("fetches a receipt directly by id", async () => {
    const res = await getReceiptById(req(TENANT_A, `http://localhost/api/receipts/${receiptId}`), { params: Promise.resolve({ id: receiptId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt.id).toBe(receiptId);
    expect(body.receipt.objective).toContain("maintenance reminder");
    expect(body.receipt.policyApplied).toEqual({ id: "policy-amc-reminder", version: 3 });
  });

  it("404s for a receipt id from another tenant (RLS/tenant-scoping proof)", async () => {
    const res = await getReceiptById(req(TENANT_B, `http://localhost/api/receipts/${receiptId}`), { params: Promise.resolve({ id: receiptId }) });
    expect(res.status).toBe(404);
  });

  it("looks up a receipt by domainActionId", async () => {
    const res = await listReceipts(req(TENANT_A, `http://localhost/api/receipts?domainActionId=${domainActionId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0].id).toBe(receiptId);
  });

  it("404s an unknown receipt id", async () => {
    const res = await getReceiptById(req(TENANT_A, "http://localhost/api/receipts/00000000-0000-4000-8000-0000000000ff"), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000ff" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a query with none of the id filters", async () => {
    const res = await listReceipts(req(TENANT_A, "http://localhost/api/receipts"));
    expect(res.status).toBe(400);
  });
});
