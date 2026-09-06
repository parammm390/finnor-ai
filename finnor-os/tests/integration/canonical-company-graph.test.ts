import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../packages/db/migrate";
import {
  appointments,
  attachWorkEntity,
  businessEvents,
  calls,
  closePool,
  communicationsLog,
  conversations,
  createBusinessOperation,
  domainActions,
  equipment,
  households,
  invoices,
  messages,
  payments,
  receiveWork,
  serviceVisits,
  withTenant,
  workEntityLinks,
} from "@finnor/db";
import { companyContext, executeOperationalQuery, resolveCanonicalHousehold, workCases } from "@finnor/read-models";
import { and, eq } from "drizzle-orm";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SUPER_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const available = await dbUp();

describe.skipIf(!available)("Upgrade 7 canonical company graph", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let householdA: string;
  let householdB: string;
  let paymentA: string;
  let workA: string;

  beforeAll(async () => {
    await migrate(SUPER_URL);
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES ($1,'Graph A'),($2,'Graph B')", [tenantA, tenantB]);
    await admin.end();
    process.env.DATABASE_URL = APP_URL;
    await closePool();

    const seeded = await withTenant(tenantA, async (db) => {
      const [household] = await db.insert(households).values({ tenantId: tenantA, address: "7 Canonical Way", contactInfo: { name: "Casey Graph" } }).returning();
      const [asset] = await db.insert(equipment).values({ householdId: household!.id, type: "softener", model: "Graph-1" }).returning();
      const [visit] = await db.insert(serviceVisits).values({ householdId: household!.id, type: "maintenance", completedAt: new Date() }).returning();
      const [invoice] = await db.insert(invoices).values({ tenantId: tenantA, householdId: household!.id, amountUsd: "125", status: "paid" }).returning();
      const [payment] = await db.insert(payments).values({ tenantId: tenantA, invoiceId: invoice!.id, amountUsd: "125", status: "succeeded" }).returning();
      const [appointment] = await db.insert(appointments).values({ tenantId: tenantA, subjectType: "household", subjectId: household!.id, status: "confirmed", scheduledAt: new Date(Date.now() + 86_400_000) }).returning();
      const [conversation] = await db.insert(conversations).values({ tenantId: tenantA, householdId: household!.id, channel: "sms" }).returning();
      const [message] = await db.insert(messages).values({ tenantId: tenantA, conversationId: conversation!.id, direction: "inbound", channel: "sms", content: "Please confirm tomorrow." }).returning();
      const [call] = await db.insert(calls).values({ tenantId: tenantA, conversationId: conversation!.id, direction: "outbound" }).returning();
      const [communication] = await db.insert(communicationsLog).values({ householdId: household!.id, channel: "email", direction: "outbound", content: "Service confirmation" }).returning();
      await db.insert(businessEvents).values({ tenantId: tenantA, entityType: "payment", entityId: payment!.id, eventType: "payment_received" });
      return { household: household!, asset: asset!, visit: visit!, invoice: invoice!, payment: payment!, appointment: appointment!, conversation: conversation!, message: message!, call: call!, communication: communication! };
    });
    householdA = seeded.household.id;
    paymentA = seeded.payment.id;

    const received = await receiveWork({
      tenantId: tenantA,
      instruction: "Review Casey Graph's service and payment history",
      channel: "console",
      activeContext: { householdId: householdA },
    });
    workA = received.workId;
    const [action] = await withTenant(tenantA, (db) => db.insert(domainActions).values({
      tenantId: tenantA,
      workId: workA,
      instructionId: received.instructionId,
      actionType: "bulk_notify_existing_customers",
      payload: {},
      status: "pending",
    }).returning());
    await createBusinessOperation({
      tenantId: tenantA,
      workId: workA,
      domainActionId: action!.id,
      operationType: "customer_winback",
      configuration: {},
      cohortDefinition: { kind: "explicit_fixture" },
      targets: [{ targetId: householdA, frozenSnapshot: { householdId: householdA }, preparedPayload: {} }],
      summary: "Canonical graph fixture operation",
      policyApplied: null,
    });

    const [other] = await withTenant(tenantB, (db) => db.insert(households).values({ tenantId: tenantB, address: "8 Isolated Way" }).returning());
    householdB = other!.id;
  });

  afterAll(async () => {
    await closePool();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("resolves the complete real customer journey from a payment anchor", async () => {
    expect(await resolveCanonicalHousehold(tenantA, { entityType: "payment", entityId: paymentA })).toBe(householdA);
    const context = await companyContext(tenantA, { entityType: "payment", entityId: paymentA });
    expect(context?.household).toMatchObject({ id: householdA, displayName: "Casey Graph" });
    const types = new Set(context?.nodes.map((node) => node.entityType));
    for (const type of ["household", "equipment", "service_visit", "invoice", "payment", "appointment", "conversation", "message", "call", "communication", "work", "domain_action", "business_operation", "business_operation_target", "decision_receipt", "business_event"]) {
      expect(types.has(type as never), `missing ${type}`).toBe(true);
    }
    expect(context?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationship: "pays", source: { table: "payments", column: "invoice_id" } }),
      expect.objectContaining({ relationship: "billed_to", source: { table: "invoices", column: "household_id" } }),
      expect.objectContaining({ relationship: "about", source: { table: "work_entity_links", column: "entity_id" } }),
      expect.objectContaining({ relationship: "targets", source: { table: "business_operation_targets", column: "target_id" } }),
    ]));
  });

  it("uses the same contract through Query Plane and the Work projection", async () => {
    const result = await executeOperationalQuery(tenantA, { intent: "company_context", anchor: { entityType: "payment", entityId: paymentA } }, { workId: workA });
    expect(result.status).toBe("ok");
    expect(result.context?.household?.id).toBe(householdA);
    const links = await withTenant(tenantA, (db) => db.select().from(workEntityLinks).where(and(eq(workEntityLinks.tenantId, tenantA), eq(workEntityLinks.workId, workA))));
    expect(links).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: "household", entityId: householdA })]));
    const projected = (await workCases(tenantA)).find((row) => row.root.kind === "work" && row.root.id === workA);
    expect(projected?.linkedEntities).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: "household", entityId: householdA, via: expect.stringContaining("work_entity_links") })]));
  });

  it("keeps every resolution and attachment tenant-safe", async () => {
    expect(await companyContext(tenantB, { entityType: "payment", entityId: paymentA })).toBeNull();
    await expect(attachWorkEntity(tenantA, workA, { entityType: "household", entityId: householdB })).rejects.toThrow(/tenant|unknown entity/i);
    await expect(withTenant(tenantA, (db) => db.insert(invoices).values({
      tenantId: tenantA,
      householdId: householdB,
      amountUsd: "1",
      status: "draft",
    }))).rejects.toThrow(/failed query|tenant boundary|missing/i);
    const visible = await withTenant(tenantB, (db) => db.select().from(workEntityLinks).where(eq(workEntityLinks.workId, workA)));
    expect(visible).toHaveLength(0);
  });
});
