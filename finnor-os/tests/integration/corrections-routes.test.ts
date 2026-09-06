// §5.6 correction loop — POST /api/corrections (receipt-linked, owner-only by default).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, decisionReceipts, memoryCorrections } from "@finnor/db";
import { eq } from "drizzle-orm";
import { openReceipt, finalizeReceipt } from "@finnor/workflow-runtime";
import { POST as submitCorrection, GET as listCorrections } from "../../apps/api/app/api/corrections/route";

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

function req(url: string, opts: { role?: string; method?: string; body?: unknown } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    headers: { "x-tenant-id": TENANT_ID, "x-user-role": opts.role ?? "owner", "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe.skipIf(!available)("corrections routes (§5.6)", () => {
  let receiptId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Corrections Route Test Project" }).onConflictDoNothing());
    const { receiptId: id } = await openReceipt({
      tenantId: TENANT_ID,
      objective: "review_diligence_finding: what evidence supports the leverage claim",
      evidence: [],
      policyApplied: null,
      riskTier: "low",
      proposedAction: {},
      approval: { required: false },
    });
    await finalizeReceipt(TENANT_ID, id, { actualResult: { output: { answer: "The claim uses the draft lender model." } } });
    receiptId = id;
  });
  afterAll(async () => {
    await withTenant(TENANT_ID, async (db) => {
      await db.delete(memoryCorrections).where(eq(memoryCorrections.tenantId, TENANT_ID));
      await db.delete(decisionReceipts).where(eq(decisionReceipts.tenantId, TENANT_ID));
    });
    await closePool();
  });

  it("a non-owner role is forbidden from submitting a correction", async () => {
    const res = await submitCorrection(req("/api/corrections", { method: "POST", role: "analyst", body: { receiptId, correctedFact: "x" } }));
    expect(res.status).toBe(403);
  });

  it("400 on a malformed body", async () => {
    const res = await submitCorrection(req("/api/corrections", { method: "POST", body: { receiptId: "not-a-uuid" } }));
    expect(res.status).toBe(400);
  });

  it("404 when the receipt doesn't exist", async () => {
    const res = await submitCorrection(
      req("/api/corrections", { method: "POST", body: { receiptId: "00000000-0000-4000-9000-000000000000", correctedFact: "x" } }),
    );
    expect(res.status).toBe(404);
  });

  it("owner submits a correction — derives question/wrongAnswer from the real receipt, links it back", async () => {
    const res = await submitCorrection(
      req("/api/corrections", { method: "POST", body: { receiptId, correctedFact: "The signed lender model is the authoritative evidence." } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();

    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(memoryCorrections).where(eq(memoryCorrections.id, body.id)));
    expect(row!.receiptId).toBe(receiptId);
    expect(row!.question).toBe("review_diligence_finding: what evidence supports the leverage claim");
    expect(row!.wrongAnswer).toBe("The claim uses the draft lender model.");
    expect(row!.correctedFact).toBe("The signed lender model is the authoritative evidence.");
    expect(row!.correctedBy).toBeTruthy();
  });

  it("owner lists corrections", async () => {
    const res = await listCorrections(req("/api/corrections"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.corrections.some((c: { receiptId: string }) => c.receiptId === receiptId)).toBe(true);
  });
});
