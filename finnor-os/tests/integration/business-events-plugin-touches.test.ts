// Phase 3 (3B) proof: the business_events additions to inventory/scheduling/
// technician-reports/customer-comm actually produce a real row, not just typecheck.
// Plugins are called directly (validate/draft/execute), same low-level pattern as
// tests/unit/stub-plugins.test.ts, against real Postgres fixture rows.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  withTenant,
  closePool,
  tenants,
  households,
  technicians,
  serviceVisits,
  inventoryItems,
  businessEvents,
} from "@finnor/db";
import { eq, and, sql } from "drizzle-orm";
import { inventoryPlugin } from "../../packages/domain-plugins/inventory";
import { schedulingPlugin } from "../../packages/domain-plugins/scheduling";
import { technicianReportsPlugin } from "../../packages/domain-plugins/technician-reports";
import { customerCommPlugin } from "../../packages/domain-plugins/customer-comm";
import type { DomainPolicy } from "@finnor/shared-types";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000e1";

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

function policy(): DomainPolicy {
  return {
    id: "policy-1",
    tenantId: TENANT_ID,
    actionType: "test",
    policy: {},
    requiresConfirmation: false,
  } as DomainPolicy;
}

async function eventsFor(entityType: string, entityId: string) {
  return withTenant(TENANT_ID, (db) =>
    db.select().from(businessEvents).where(and(eq(businessEvents.tenantId, TENANT_ID), eq(businessEvents.entityType, entityType), eq(businessEvents.entityId, entityId))),
  );
}

describe.skipIf(!available)("business_events emitted by Phase 3B plugin touches", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Business Events Test Dealer" }).onConflictDoNothing());
    // Clean slate: a prior run of this file must not collide on inventory_items' own
    // UNIQUE(tenant_id, sku) constraint.
    await withTenant(TENANT_ID, async (db) => {
      // business_events is append-only in real use (migration 0015) — this test-only
      // fixture reset opts in via a transaction-local GUC no application code ever sets.
      await db.execute(sql`SELECT set_config('app.allow_audit_mutation', 'true', true)`);
      await db.delete(businessEvents).where(eq(businessEvents.tenantId, TENANT_ID));
      await db.delete(inventoryItems).where(and(eq(inventoryItems.tenantId, TENANT_ID), eq(inventoryItems.sku, "BE-TEST-SKU")));
    });
  });
  afterAll(async () => {
    await closePool();
  });

  it("inventory.log_stock_used_on_visit records a stock_used_on_visit business_event", async () => {
    const [item] = await withTenant(TENANT_ID, (db) =>
      db.insert(inventoryItems).values({ tenantId: TENANT_ID, sku: "BE-TEST-SKU", name: "BE Test Item", quantity: 10, reorderThreshold: 2 }).returning(),
    );
    const draft = await inventoryPlugin.draft("log_stock_used_on_visit", { sku: "BE-TEST-SKU", quantity: 3 }, policy());
    const result = await inventoryPlugin.execute(draft, undefined as never);
    expect(result.status).toBe("success");

    const events = await eventsFor("inventory_item", item!.id);
    expect(events.some((e) => e.eventType === "stock_used_on_visit")).toBe(true);
  });

  it("scheduling.reschedule_visit records a rescheduled business_event", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "1 BE Test Ln", contactInfo: {} }).returning(),
    );
    const [visit] = await withTenant(TENANT_ID, (db) =>
      db.insert(serviceVisits).values({ householdId: hh!.id, type: "water_test", scheduledAt: new Date() }).returning(),
    );
    const draft = await schedulingPlugin.draft("reschedule_visit", { visitId: visit!.id, newTime: new Date(Date.now() + 86_400_000).toISOString() }, policy());
    const result = await schedulingPlugin.execute(draft, undefined as never);
    expect(result.status).toBe("success");

    const events = await eventsFor("service_visit", visit!.id);
    expect(events.some((e) => e.eventType === "rescheduled")).toBe(true);
  });

  it("technician-reports.log_visit_report records a visit_report_logged business_event", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "2 BE Test Ln", contactInfo: {} }).returning(),
    );
    const [visit] = await withTenant(TENANT_ID, (db) =>
      db.insert(serviceVisits).values({ householdId: hh!.id, type: "water_test", scheduledAt: new Date() }).returning(),
    );
    const draft = await technicianReportsPlugin.draft("log_visit_report", { visitId: visit!.id, report: "All good, no issues found." }, policy());
    const result = await technicianReportsPlugin.execute(draft, undefined as never);
    expect(result.status).toBe("success");

    const events = await eventsFor("service_visit", visit!.id);
    expect(events.some((e) => e.eventType === "visit_report_logged")).toBe(true);
  });

  it("customer-comm.send_customer_message records a canonical conversations/messages pair alongside communications_log", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "3 BE Test Ln", contactInfo: { phone: "+13195559988" } }).returning(),
    );
    const draft = await customerCommPlugin.draft(
      "send_customer_message",
      { householdId: hh!.id, message: "Your service is scheduled.", channel: "sms" },
      policy(),
    );
    // customer-comm's execute() calls tools.call("ghl_send_sms", ...) — use the real
    // sandbox-mode registry so the send actually succeeds against native infra.
    const { createDefaultRegistry } = await import("@finnor/tools");
    process.env.COMMS_MODE = "native";
    const registry = createDefaultRegistry();
    const result = await customerCommPlugin.execute(draft, registry);
    expect(result.status).toBe("success");

    const { conversations, messages } = await import("@finnor/db");
    const convs = await withTenant(TENANT_ID, (db) => db.select().from(conversations).where(eq(conversations.householdId, hh!.id)));
    expect(convs.length).toBeGreaterThanOrEqual(1);
    const msgs = await withTenant(TENANT_ID, (db) => db.select().from(messages).where(eq(messages.conversationId, convs[0]!.id)));
    expect(msgs.some((m) => m.content === "Your service is scheduled.")).toBe(true);
  });
});
