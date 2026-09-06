// Repository-layer acceptance: every @finnor/data-platform function against a real
// Postgres — idempotent upserts stay idempotent, and every write records exactly one
// business_events row (the mechanism that makes business_events a trustworthy timeline).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  withTenant,
  closePool,
  tenants,
  businessEvents,
  invoices,
  households,
  leads,
  opportunities,
  tasks,
  appointments,
  workOrders,
  priceBookItems,
  quoteLineItems,
  quotes,
  payments,
  messages,
  calls,
  conversations,
  contactMethods,
  contacts,
  documents,
} from "@finnor/db";
import { eq, and, sql } from "drizzle-orm";
import {
  createLead,
  convertLeadToOpportunity,
  createTask,
  createAppointment,
  createWorkOrder,
  upsertPriceBookItem,
  createQuote,
  recordPayment,
  persistCall,
  persistMessage,
  createDocument,
  createContact,
  addContactMethod,
} from "@finnor/data-platform";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ab";

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

async function eventCountFor(entityType: string, entityId: string): Promise<number> {
  const rows = await withTenant(TENANT_ID, (db) =>
    db
      .select()
      .from(businessEvents)
      .where(and(eq(businessEvents.tenantId, TENANT_ID), eq(businessEvents.entityType, entityType), eq(businessEvents.entityId, entityId))),
  );
  return rows.length;
}

describe.skipIf(!available)("@finnor/data-platform repository layer", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) =>
      db.insert(tenants).values({ id: TENANT_ID, name: "Repository Test Dealer" }).onConflictDoNothing(),
    );
    // Clean slate: a prior run of this file (or the full suite re-running it) must not
    // make the idempotency assertions below see stale rows and report false negatives —
    // children before parents to respect FKs.
    await withTenant(TENANT_ID, async (db) => {
      // business_events is append-only in real use (migration 0015) — this test-only
      // fixture reset opts in via a transaction-local GUC no application code ever sets.
      await db.execute(sql`SELECT set_config('app.allow_audit_mutation', 'true', true)`);
      await db.delete(businessEvents).where(eq(businessEvents.tenantId, TENANT_ID));
      await db.delete(messages).where(eq(messages.tenantId, TENANT_ID));
      await db.delete(calls).where(eq(calls.tenantId, TENANT_ID));
      await db.delete(conversations).where(eq(conversations.tenantId, TENANT_ID));
      await db.delete(quoteLineItems).where(eq(quoteLineItems.tenantId, TENANT_ID));
      await db.delete(quotes).where(eq(quotes.tenantId, TENANT_ID));
      await db.delete(payments).where(eq(payments.tenantId, TENANT_ID));
      await db.delete(invoices).where(eq(invoices.tenantId, TENANT_ID));
      await db.delete(workOrders).where(eq(workOrders.tenantId, TENANT_ID));
      await db.delete(tasks).where(eq(tasks.tenantId, TENANT_ID));
      await db.delete(appointments).where(eq(appointments.tenantId, TENANT_ID));
      await db.delete(opportunities).where(eq(opportunities.tenantId, TENANT_ID));
      await db.delete(leads).where(eq(leads.tenantId, TENANT_ID));
      await db.delete(contactMethods).where(eq(contactMethods.tenantId, TENANT_ID));
      await db.delete(contacts).where(eq(contacts.tenantId, TENANT_ID));
      await db.delete(documents).where(eq(documents.tenantId, TENANT_ID));
      await db.delete(priceBookItems).where(eq(priceBookItems.tenantId, TENANT_ID));
      await db.delete(households).where(eq(households.tenantId, TENANT_ID));
    });
  });
  afterAll(async () => {
    await closePool();
  });

  it("createLead is idempotent by provenance and records one business event", async () => {
    const first = await withTenant(TENANT_ID, (db) =>
      createLead(db, { tenantId: TENANT_ID, name: "Repo Test Lead", phone: "+13195558801", provenance: { sourceSystem: "test", externalId: "repo-lead-1" } }),
    );
    expect(first.alreadyExisted).toBe(false);
    const second = await withTenant(TENANT_ID, (db) =>
      createLead(db, { tenantId: TENANT_ID, name: "Repo Test Lead", phone: "+13195558801", provenance: { sourceSystem: "test", externalId: "repo-lead-1" } }),
    );
    expect(second.alreadyExisted).toBe(true);
    expect(second.leadId).toBe(first.leadId);
    expect(second.householdId).toBe(first.householdId);
    expect(await eventCountFor("lead", first.leadId)).toBe(1);
  });

  it("convertLeadToOpportunity creates then updates the same opportunity, never a duplicate", async () => {
    const lead = await withTenant(TENANT_ID, (db) =>
      createLead(db, { tenantId: TENANT_ID, name: "Opportunity Test Lead", phone: "+13195558802" }),
    );
    const first = await withTenant(TENANT_ID, (db) =>
      convertLeadToOpportunity(db, { tenantId: TENANT_ID, householdId: lead.householdId, status: "quote_sent" }),
    );
    expect(first.opportunityId).toBeTruthy();
    const second = await withTenant(TENANT_ID, (db) =>
      convertLeadToOpportunity(db, { tenantId: TENANT_ID, householdId: lead.householdId, status: "installed" }),
    );
    expect(second.opportunityId).toBe(first.opportunityId);
    const noop = await withTenant(TENANT_ID, (db) =>
      convertLeadToOpportunity(db, { tenantId: TENANT_ID, householdId: lead.householdId, status: "lead" }),
    );
    expect(noop.opportunityId).toBeNull();
  });

  it("createTask and createAppointment each record their entity + one business event", async () => {
    const task = await withTenant(TENANT_ID, (db) =>
      createTask(db, { tenantId: TENANT_ID, subjectType: "test_subject", subjectId: TENANT_ID, title: "Follow up" }),
    );
    expect(await eventCountFor("task", task.taskId)).toBe(1);

    const appt = await withTenant(TENANT_ID, (db) =>
      createAppointment(db, { tenantId: TENANT_ID, subjectType: "test_subject", subjectId: TENANT_ID, scheduledAt: new Date() }),
    );
    expect(await eventCountFor("appointment", appt.appointmentId)).toBe(1);
  });

  it("createWorkOrder records the entity + one business event", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "1 Repo Test Ln", contactInfo: {} }).returning(),
    );
    const wo = await withTenant(TENANT_ID, (db) => createWorkOrder(db, { tenantId: TENANT_ID, householdId: hh!.id, type: "install" }));
    expect(await eventCountFor("work_order", wo.workOrderId)).toBe(1);
  });

  it("upsertPriceBookItem is idempotent by (tenant, sku) — re-upsert updates, never duplicates", async () => {
    const first = await withTenant(TENANT_ID, (db) =>
      upsertPriceBookItem(db, { tenantId: TENANT_ID, sku: "REPO-TEST-SKU", label: "Repo Test Item", priceUsd: 100 }),
    );
    const second = await withTenant(TENANT_ID, (db) =>
      upsertPriceBookItem(db, { tenantId: TENANT_ID, sku: "REPO-TEST-SKU", label: "Repo Test Item Updated", priceUsd: 150 }),
    );
    expect(second.itemId).toBe(first.itemId);
  });

  it("createQuote computes the total and records one business event", async () => {
    const quote = await withTenant(TENANT_ID, (db) =>
      createQuote(db, { tenantId: TENANT_ID, lineItems: [{ label: "Item A", unitPriceUsd: 50, quantity: 2 }, { label: "Item B", unitPriceUsd: 25 }] }),
    );
    expect(quote.totalUsd).toBe(125);
    expect(await eventCountFor("quote", quote.quoteId)).toBe(1);
  });

  it("recordPayment inserts a payment, marks the invoice paid, and records one business event", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "2 Repo Test Ln", contactInfo: {} }).returning(),
    );
    const [inv] = await withTenant(TENANT_ID, (db) =>
      db.insert(invoices).values({ tenantId: TENANT_ID, householdId: hh!.id, amountUsd: "75.00", status: "sent" }).returning(),
    );
    const payment = await withTenant(TENANT_ID, (db) => recordPayment(db, { tenantId: TENANT_ID, invoiceId: inv!.id, amountUsd: 75 }));
    expect(await eventCountFor("payment", payment.paymentId)).toBe(1);
    const [updated] = await withTenant(TENANT_ID, (db) => db.select().from(invoices).where(eq(invoices.id, inv!.id)));
    expect(updated!.status).toBe("paid");
  });

  it("keeps a partially paid invoice open until cumulative succeeded payments settle it", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "3 Partial Payment Ln", contactInfo: {} }).returning(),
    );
    const [inv] = await withTenant(TENANT_ID, (db) =>
      db.insert(invoices).values({ tenantId: TENANT_ID, householdId: hh!.id, amountUsd: "1000.00", status: "sent" }).returning(),
    );
    const partial = await withTenant(TENANT_ID, (db) => recordPayment(db, { tenantId: TENANT_ID, invoiceId: inv!.id, amountUsd: 1 }));
    expect(partial).toMatchObject({ amountPaidUsd: 1, balanceUsd: 999, settled: false });
    expect((await withTenant(TENANT_ID, (db) => db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv!.id))))[0]!.status).toBe("sent");

    const settled = await withTenant(TENANT_ID, (db) => recordPayment(db, { tenantId: TENANT_ID, invoiceId: inv!.id, amountUsd: 999 }));
    expect(settled).toMatchObject({ amountPaidUsd: 1000, balanceUsd: 0, settled: true });
    expect((await withTenant(TENANT_ID, (db) => db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv!.id))))[0]!.status).toBe("paid");
  });

  it("persistCall is idempotent by (tenant, source, external id) and links to a conversation", async () => {
    const first = await withTenant(TENANT_ID, (db) =>
      persistCall(db, { tenantId: TENANT_ID, provenance: { sourceSystem: "test", externalId: "repo-call-1" }, direction: "inbound", transcript: "hello" }),
    );
    expect(first.alreadyExisted).toBe(false);
    const second = await withTenant(TENANT_ID, (db) =>
      persistCall(db, { tenantId: TENANT_ID, provenance: { sourceSystem: "test", externalId: "repo-call-1" }, direction: "inbound", transcript: "hello again" }),
    );
    expect(second.alreadyExisted).toBe(true);
    expect(second.callId).toBe(first.callId);
    expect(second.conversationId).toBe(first.conversationId);

    const msg = await withTenant(TENANT_ID, (db) =>
      persistMessage(db, { tenantId: TENANT_ID, conversationId: first.conversationId, direction: "outbound", channel: "sms", content: "confirmed" }),
    );
    expect(await eventCountFor("message", msg.messageId)).toBe(1);
  });

  it("createContact + addContactMethod is idempotent by (contact, method type, value)", async () => {
    const contact = await withTenant(TENANT_ID, (db) => createContact(db, { tenantId: TENANT_ID, name: "Repo Test Contact" }));
    const first = await withTenant(TENANT_ID, (db) =>
      addContactMethod(db, { tenantId: TENANT_ID, contactId: contact.contactId, methodType: "phone", value: "+13195558899" }),
    );
    const second = await withTenant(TENANT_ID, (db) =>
      addContactMethod(db, { tenantId: TENANT_ID, contactId: contact.contactId, methodType: "phone", value: "+13195558899" }),
    );
    expect(second.contactMethodId).toBe(first.contactMethodId);
  });

  it("createDocument records the entity + one business event", async () => {
    const doc = await withTenant(TENANT_ID, (db) => createDocument(db, { tenantId: TENANT_ID, kind: "test_doc", title: "Repo Test Document" }));
    expect(await eventCountFor("document", doc.documentId)).toBe(1);
  });
});
