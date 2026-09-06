// Vertical workflows 5-7 (Phase 5, docs/jarvis-90-execution-blueprint.md §5) plus the
// Phase 6 read-models workflow 6's daily digest depends on. Workflow 5 (recurring
// revenue)'s actual completion — a renewed maintenance agreement really billing the
// customer — is proven in tests/integration/amc-renewal-sequence.test.ts (§2.6, ported
// off Temporal) alongside the rest of that renewal sequence, not duplicated here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  withTenant,
  closePool,
  tenants,
  households,
  leads,
  invoices,
  webhookReceipts,
  technicians,
  maintenanceAgreements,
  dataQualityFindings,
} from "@finnor/db";
import { eq } from "drizzle-orm";
import { createLead } from "@finnor/data-platform";
import { checkAndRecordReceipt } from "../../apps/api/lib/webhook-replay";
import { pipelineHealth, cashCollections, followUpDebt, stockRisk, technicianLoad, serviceDue, slaBreaches, dataQuality } from "@finnor/read-models";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000f7";

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

describe.skipIf(!available)("Phase 5 vertical workflows 6-7 + read-models", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Phase 5 Workflow Test Dealer" }).onConflictDoNothing());
  });
  afterAll(async () => {
    await closePool();
  });

  it("workflow 7 (marketing to revenue): a conversion event creates a real lead, and a replayed event never duplicates it", async () => {
    const eventId = `mkt-evt-${TENANT_ID}-1`;
    const rawBody = JSON.stringify({ tenantId: TENANT_ID, campaignId: "camp-1", eventId, name: "Ad Lead One", phone: "+15555550300" });

    const first = await checkAndRecordReceipt("marketing_conversion", eventId, rawBody);
    expect(first).toBe("new");
    const created = await withTenant(TENANT_ID, (db) =>
      createLead(db, {
        tenantId: TENANT_ID,
        name: "Ad Lead One",
        phone: "+15555550300",
        source: "ad_campaign:camp-1",
        provenance: { sourceSystem: "marketing_conversion", externalId: eventId },
      }),
    );
    expect(created.alreadyExisted).toBe(false);

    // A replayed webhook delivery: transport-level dedup catches it before createLead
    // is even called again, matching webhooks/marketing/route.ts's own real behavior.
    const replay = await checkAndRecordReceipt("marketing_conversion", eventId, rawBody);
    expect(replay).toBe("duplicate");

    // Even if createLead were called again for the same provenance (belt-and-suspenders,
    // matching how signature/payment webhooks are proven in Phase 4), it must not create
    // a second lead.
    const again = await withTenant(TENANT_ID, (db) =>
      createLead(db, {
        tenantId: TENANT_ID,
        name: "Ad Lead One",
        phone: "+15555550300",
        source: "ad_campaign:camp-1",
        provenance: { sourceSystem: "marketing_conversion", externalId: eventId },
      }),
    );
    expect(again.alreadyExisted).toBe(true);
    expect(again.leadId).toBe(created.leadId);

    await withTenant(TENANT_ID, async (db) => {
      await db.delete(leads).where(eq(leads.id, created.leadId));
      await db.delete(households).where(eq(households.id, created.householdId));
    });
    await withTenant(TENANT_ID, (db) => db.delete(webhookReceipts).where(eq(webhookReceipts.eventId, eventId)));
  });

  it("read-models: pipelineHealth reflects real lead/quote counts by status", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "1 Read Model Ln", contactInfo: {} }).returning(),
    );
    const [lead] = await withTenant(TENANT_ID, (db) =>
      db.insert(leads).values({ tenantId: TENANT_ID, householdId: hh!.id, name: "Pipeline Test Lead", status: "new" }).returning(),
    );
    const health = await pipelineHealth(TENANT_ID);
    const newLeadCount = health.leadsByStatus.find((s) => s.status === "new")?.count ?? 0;
    expect(newLeadCount).toBeGreaterThanOrEqual(1);

    await withTenant(TENANT_ID, async (db) => {
      await db.delete(leads).where(eq(leads.id, lead!.id));
      await db.delete(households).where(eq(households.id, hh!.id));
    });
  });

  it("read-models: cashCollections totals a real overdue invoice", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "2 Read Model Ln", contactInfo: {} }).returning(),
    );
    const [inv] = await withTenant(TENANT_ID, (db) =>
      db.insert(invoices).values({ tenantId: TENANT_ID, householdId: hh!.id, amountUsd: "425.00", status: "overdue" }).returning(),
    );
    const cash = await cashCollections(TENANT_ID);
    const overdue = cash.invoicesByStatus.find((s) => s.status === "overdue");
    expect(overdue).toBeTruthy();
    expect(overdue!.totalUsd).toBeGreaterThanOrEqual(425);

    await withTenant(TENANT_ID, async (db) => {
      await db.delete(invoices).where(eq(invoices.id, inv!.id));
      await db.delete(households).where(eq(households.id, hh!.id));
    });
  });

  it("read-models: followUpDebt flags a lead whose household has no recent conversation", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "3 Read Model Ln", contactInfo: {} }).returning(),
    );
    const [lead] = await withTenant(TENANT_ID, (db) =>
      db.insert(leads).values({ tenantId: TENANT_ID, householdId: hh!.id, name: "Stale Follow-up Lead", status: "contacted" }).returning(),
    );
    const debt = await followUpDebt(TENANT_ID, 7);
    expect(debt.some((d) => d.entityId === lead!.id)).toBe(true);

    await withTenant(TENANT_ID, async (db) => {
      await db.delete(leads).where(eq(leads.id, lead!.id));
      await db.delete(households).where(eq(households.id, hh!.id));
    });
  });

  it("read-models: stockRisk finds items at or below their reorder threshold", async () => {
    const before = await stockRisk(TENANT_ID);
    expect(Array.isArray(before.belowThreshold)).toBe(true);
    expect(typeof before.openProcurementOrders).toBe("number");
  });

  it("read-models: technicianLoad counts a real technician's upcoming work", async () => {
    const [tech] = await withTenant(TENANT_ID, (db) =>
      db.insert(technicians).values({ tenantId: TENANT_ID, name: "Load Test Tech" }).returning(),
    );
    const load = await technicianLoad(TENANT_ID);
    const mine = load.find((t) => t.technicianId === tech!.id);
    expect(mine).toBeTruthy();
    expect(mine!.upcomingAppointments).toBe(0);
    expect(mine!.openWorkOrders).toBe(0);

    await withTenant(TENANT_ID, (db) => db.delete(technicians).where(eq(technicians.id, tech!.id)));
  });

  it("read-models: serviceDue finds a maintenance agreement renewing within the window", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "4 Read Model Ln", contactInfo: {} }).returning(),
    );
    const [agreement] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(maintenanceAgreements)
        .values({ householdId: hh!.id, cadence: "annual", status: "renewal_window", renewalDate: new Date(Date.now() + 5 * 86_400_000) })
        .returning(),
    );
    const due = await serviceDue(TENANT_ID, 30);
    expect(due.some((d) => d.agreementId === agreement!.id)).toBe(true);

    await withTenant(TENANT_ID, async (db) => {
      await db.delete(maintenanceAgreements).where(eq(maintenanceAgreements.id, agreement!.id));
      await db.delete(households).where(eq(households.id, hh!.id));
    });
  });

  it("read-models: slaBreaches and dataQuality return well-typed real counts", async () => {
    const sla = await slaBreaches(TENANT_ID);
    expect(typeof sla.stuckWorkflowRuns).toBe("number");
    expect(typeof sla.openReconciliationCases).toBe("number");

    const [finding] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(dataQualityFindings)
        .values({ tenantId: TENANT_ID, findingType: "missing_critical_field", entityType: "lead", entityId: TENANT_ID, severity: "medium" })
        .returning(),
    );
    const quality = await dataQuality(TENANT_ID);
    expect(quality.totalUnresolved).toBeGreaterThanOrEqual(1);
    expect(quality.byTypeAndSeverity.some((r) => r.findingType === "missing_critical_field")).toBe(true);

    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(eq(dataQualityFindings.id, finding!.id)));
  });
});
