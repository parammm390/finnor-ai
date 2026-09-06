import { describe, expect, it, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "../../packages/db/migrate";
import {
  appointments,
  calls,
  closePool,
  commands,
  communicationsLog,
  contacts,
  contactMethods,
  domainActions,
  getPool,
  households,
  inventoryItems,
  invoices,
  leads,
  opportunities,
  payments,
  procurementOrders,
  receiveWork,
  serviceVisits,
  tasks,
  technicians,
  users,
  warehouseStock,
  warehouses,
  workflowRuns,
  workOrders,
  workPlannerAttempts,
  workQueryExecutions,
  works,
  workAggregate,
  withTenant,
} from "@finnor/db";
import { executeOperationalQuery } from "@finnor/read-models";
import type { OperationalQueryRequest } from "@finnor/shared-types";
import { createFastReadOnlyRouter } from "@finnor/orchestration";
import { FinnorOrchestrator, type Planner } from "@finnor/orchestration";
import type { Executor } from "../../packages/orchestration/src/executor";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER_A = randomUUID();
const TECH_A = randomUUID();
const TECH_B = randomUUID();
const HOUSEHOLD_QUALIFYING = randomUUID();
const HOUSEHOLD_NEVER_ACTIVE = randomUUID();
const HOUSEHOLD_ACTIVE = randomUUID();
const HOUSEHOLD_AT_CUTOFF = randomUUID();
const HOUSEHOLD_NEW = randomUUID();
const HOUSEHOLD_B = randomUUID();
const CONTACT_A = randomUUID();
const CONTACT_METHOD_A = randomUUID();
const INVOICE_A = randomUUID();
const WAREHOUSE_A = randomUUID();
const WORK_ORDER_A = randomUUID();
const APPOINTMENT_A = randomUUID();
const VISIT_A = randomUUID();
const WORK_A = randomUUID();
const COMMAND_A = randomUUID();
const WORKFLOW_A = randomUUID();
const ACTION_A = randomUUID();
const CALL_A = randomUUID();
const TASK_A = randomUUID();
const LEAD_A = randomUUID();
const OPPORTUNITY_A = randomUUID();

const DST_RANGE = {
  // America/New_York local Mar 8–9, 2026. The end is local midnight on Mar 10
  // after the spring-forward transition: a 47-hour UTC interval, not 48 hours.
  start: "2026-03-08T05:00:00.000Z",
  end: "2026-03-10T04:00:00.000Z",
} as const;
const FIXED_AS_OF = new Date("2026-08-12T00:00:00.000Z");
const DST_AS_OF = new Date("2026-03-08T05:00:00.000Z");
const RECENT_ACTIVITY_AT = new Date("2026-08-01T00:00:00.000Z");
const EXACT_CUTOFF_AT = new Date("2026-05-14T00:00:00.000Z");

const available = await (async () => {
  const client = new pg.Client({ connectionString: SUPER_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
})();

async function insertFixture(): Promise<void> {
  process.env.DATABASE_URL = SUPER_URL;
  await migrate(SUPER_URL);
  await getPool().query(
    `INSERT INTO finnor_os.tenants (id, name, timezone) VALUES
      ($1, 'Operational Query Tenant A', 'America/New_York'),
      ($2, 'Operational Query Tenant B', 'America/Chicago')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );

  await withTenant(TENANT_A, async (db) => {
    await db.insert(users).values({ id: USER_A, tenantId: TENANT_A, email: `${USER_A}@example.invalid`, role: "owner" });
    await db.insert(technicians).values([
      { id: TECH_A, tenantId: TENANT_A, name: "Avery Technician", contactInfo: {}, availability: {} },
      { id: TECH_B, tenantId: TENANT_A, name: "Blair Technician", contactInfo: {}, availability: {} },
    ]);
    await db.insert(households).values([
      { id: HOUSEHOLD_QUALIFYING, tenantId: TENANT_A, address: "10 Qualifying Lane", contactInfo: { name: "No Consent Household" }, marketingConsent: false, createdAt: new Date("2025-01-01T00:00:00.000Z") },
      { id: HOUSEHOLD_NEVER_ACTIVE, tenantId: TENANT_A, address: "20 Never Active Lane", contactInfo: { name: "Never Active Household" }, marketingConsent: false, createdAt: new Date("2025-01-02T00:00:00.000Z") },
      { id: HOUSEHOLD_ACTIVE, tenantId: TENANT_A, address: "30 Active Lane", contactInfo: { name: "Recently Active Household" }, marketingConsent: true, createdAt: new Date("2025-01-03T00:00:00.000Z") },
      { id: HOUSEHOLD_AT_CUTOFF, tenantId: TENANT_A, address: "40 Cutoff Lane", contactInfo: { name: "Exactly At Cutoff Household" }, marketingConsent: false, createdAt: EXACT_CUTOFF_AT },
      { id: HOUSEHOLD_NEW, tenantId: TENANT_A, address: "50 New Lane", contactInfo: { name: "New Never Active Household" }, marketingConsent: false, createdAt: new Date("2026-08-11T00:00:00.000Z") },
    ]);
    await db.insert(contacts).values({ id: CONTACT_A, tenantId: TENANT_A, householdId: HOUSEHOLD_QUALIFYING, name: "No Consent Household", role: "primary" });
    await db.insert(contactMethods).values({ id: CONTACT_METHOD_A, tenantId: TENANT_A, contactId: CONTACT_A, methodType: "email", value: "no-consent@example.invalid", consent: false });
    await db.insert(communicationsLog).values([
      { id: randomUUID(), householdId: HOUSEHOLD_QUALIFYING, channel: "email", direction: "inbound", content: "old interaction", timestamp: new Date("2025-01-01T00:00:00.000Z") },
      { id: randomUUID(), householdId: HOUSEHOLD_ACTIVE, channel: "email", direction: "inbound", content: "recent interaction", timestamp: RECENT_ACTIVITY_AT },
    ]);
    await db.insert(serviceVisits).values([
      { id: randomUUID(), householdId: HOUSEHOLD_QUALIFYING, technicianId: TECH_A, type: "maintenance", scheduledAt: new Date("2025-01-02T00:00:00.000Z"), completedAt: new Date("2025-01-02T01:00:00.000Z"), notes: null },
      { id: VISIT_A, householdId: HOUSEHOLD_QUALIFYING, technicianId: TECH_A, type: "spring_service", scheduledAt: new Date("2026-03-09T14:00:00.000Z"), completedAt: null, notes: null },
      { id: randomUUID(), householdId: HOUSEHOLD_ACTIVE, technicianId: TECH_B, type: "maintenance", scheduledAt: RECENT_ACTIVITY_AT, completedAt: new Date(RECENT_ACTIVITY_AT.getTime() + 60 * 60 * 1_000), notes: null },
    ]);
    await db.insert(appointments).values([
      { id: APPOINTMENT_A, tenantId: TENANT_A, subjectType: "household", subjectId: HOUSEHOLD_QUALIFYING, technicianId: TECH_A, status: "confirmed", scheduledAt: new Date("2026-03-08T05:00:00.000Z"), durationMinutes: 60, notes: null },
      { id: randomUUID(), tenantId: TENANT_A, subjectType: "household", subjectId: HOUSEHOLD_ACTIVE, technicianId: TECH_B, status: "confirmed", scheduledAt: new Date("2026-03-10T03:59:59.000Z"), durationMinutes: 60, notes: null },
      { id: randomUUID(), tenantId: TENANT_A, subjectType: "household", subjectId: HOUSEHOLD_ACTIVE, technicianId: TECH_B, status: "confirmed", scheduledAt: new Date(DST_RANGE.end), durationMinutes: 60, notes: null },
    ]);
    await db.insert(workOrders).values({ id: WORK_ORDER_A, tenantId: TENANT_A, householdId: HOUSEHOLD_QUALIFYING, type: "repair", status: "scheduled", technicianId: TECH_A, scheduledAt: new Date("2026-03-09T20:00:00.000Z"), completedAt: null, depositAmountUsd: null, stockReservation: {} });
    await db.insert(inventoryItems).values({ id: randomUUID(), tenantId: TENANT_A, sku: "A-FILTER", name: "Filter A", quantity: 1, reorderThreshold: 5, unitCostUsd: "12.50" });
    await db.insert(warehouses).values({ id: WAREHOUSE_A, tenantId: TENANT_A, name: "A Warehouse", address: "1 Depot Way", isDefault: true });
    await db.insert(warehouseStock).values({ id: randomUUID(), tenantId: TENANT_A, warehouseId: WAREHOUSE_A, sku: "A-FILTER", quantity: 1, unitOfMeasure: "each", reorderThreshold: 5 });
    await db.insert(procurementOrders).values({ id: randomUUID(), tenantId: TENANT_A, warehouseId: WAREHOUSE_A, sku: "A-FILTER", quantityOrdered: 20, status: "ordered", expectedAt: new Date("2026-03-09T00:00:00.000Z"), receivedAt: null });
    await db.insert(invoices).values({ id: INVOICE_A, tenantId: TENANT_A, householdId: HOUSEHOLD_QUALIFYING, amountUsd: "450.00", status: "paid", memo: "A invoice", dueDate: new Date("2026-03-10T00:00:00.000Z"), createdAt: new Date("2026-03-08T12:00:00.000Z") });
    await db.insert(payments).values({ id: randomUUID(), tenantId: TENANT_A, invoiceId: INVOICE_A, amountUsd: "450.00", method: "card", status: "succeeded", receivedAt: new Date("2026-03-09T12:00:00.000Z") });
    await db.insert(works).values({ id: WORK_A, tenantId: TENANT_A, status: "completed", initialChannel: "console", initialInstruction: "Fixture Work", activeContext: {}, createdAt: new Date("2026-03-08T12:00:00.000Z"), updatedAt: new Date("2026-03-09T12:00:00.000Z") });
    await db.insert(commands).values({ id: COMMAND_A, tenantId: TENANT_A, commandType: "fixture", payload: {}, status: "completed", requestedBy: USER_A });
    await db.insert(workflowRuns).values({ id: WORKFLOW_A, tenantId: TENANT_A, commandId: COMMAND_A, workId: WORK_A, workflowType: "fixture", status: "completed" });
    await db.insert(domainActions).values({ id: ACTION_A, tenantId: TENANT_A, actionType: "fixture_read", payload: {}, status: "completed" });
    await db.insert(calls).values({ id: CALL_A, tenantId: TENANT_A, conversationId: null, direction: "inbound", fromNumber: null, toNumber: null, transcript: "fixture transcript must not be returned", recordingUrl: null, startedAt: new Date("2026-03-09T10:00:00.000Z"), endedAt: new Date("2026-03-09T10:05:00.000Z"), endedReason: "completed", raw: {}, createdAt: new Date("2026-03-09T10:00:00.000Z") });
    await db.insert(tasks).values({ id: TASK_A, tenantId: TENANT_A, subjectType: "household", subjectId: HOUSEHOLD_QUALIFYING, title: "Fixture task", dueAt: new Date("2026-03-09T18:00:00.000Z"), assigneeType: "user", assigneeId: USER_A, status: "open", priority: "normal" });
    await db.insert(leads).values({ id: LEAD_A, tenantId: TENANT_A, householdId: HOUSEHOLD_QUALIFYING, contactMethodId: CONTACT_METHOD_A, name: "Fixture Lead", phone: null, email: null, address: "10 Qualifying Lane", status: "qualified", source: "test", notes: null });
    await db.insert(opportunities).values({ id: OPPORTUNITY_A, tenantId: TENANT_A, leadId: LEAD_A, householdId: HOUSEHOLD_QUALIFYING, pipelineStage: "open", expectedValueUsd: "1000.00" });
    // Deliberately uneven section sizes exercise the root cursor: one section
    // exhausts while another continues, so a later page must not restart it.
    for (let index = 0; index < 2; index += 1) {
      await db.insert(works).values({ id: randomUUID(), tenantId: TENANT_A, status: index === 0 ? "received" : "completed", initialChannel: "console", initialInstruction: `Pagination Work ${index}`, activeContext: {} });
    }
    for (let index = 0; index < 2; index += 1) {
      await db.insert(workOrders).values({ id: randomUUID(), tenantId: TENANT_A, householdId: HOUSEHOLD_QUALIFYING, type: "other", status: "scheduled", technicianId: TECH_A, scheduledAt: new Date(`2026-03-09T2${index + 1}:00:00.000Z`), completedAt: null, depositAmountUsd: null, stockReservation: {} });
    }
    for (let index = 0; index < 3; index += 1) {
      await db.insert(tasks).values({ id: randomUUID(), tenantId: TENANT_A, subjectType: "household", subjectId: HOUSEHOLD_QUALIFYING, title: `Pagination Task ${index}`, dueAt: new Date(`2026-03-09T1${index}:00:00.000Z`), assigneeType: "user", assigneeId: USER_A, status: "open", priority: "normal" });
    }
    for (let index = 0; index < 2; index += 1) {
      await db.insert(inventoryItems).values({ id: randomUUID(), tenantId: TENANT_A, sku: `A-PAGE-${index}`, name: `Pagination Item ${index}`, quantity: index, reorderThreshold: 5, unitCostUsd: "9.00" });
      await db.insert(warehouseStock).values({ id: randomUUID(), tenantId: TENANT_A, warehouseId: WAREHOUSE_A, sku: `A-PAGE-${index}`, quantity: index, unitOfMeasure: "each", reorderThreshold: 5 });
    }
    for (let index = 0; index < 3; index += 1) {
      await db.insert(procurementOrders).values({ id: randomUUID(), tenantId: TENANT_A, warehouseId: WAREHOUSE_A, sku: `A-PAGE-${index}`, quantityOrdered: 10, status: "ordered", expectedAt: new Date("2026-03-09T00:00:00.000Z"), receivedAt: null });
    }
    for (let index = 0; index < 2; index += 1) {
      await db.insert(users).values({ id: randomUUID(), tenantId: TENANT_A, email: `pagination-user-${index}-${USER_A}@example.invalid`, role: index === 0 ? "dispatcher" : "technician" });
      await db.insert(domainActions).values({ id: randomUUID(), tenantId: TENANT_A, actionType: `pagination_action_${index}`, payload: {}, status: "completed" });
      await db.insert(calls).values({ id: randomUUID(), tenantId: TENANT_A, conversationId: null, direction: "inbound", fromNumber: null, toNumber: null, transcript: `pagination transcript ${index}`, recordingUrl: null, startedAt: new Date(`2026-03-09T1${index}:00:00.000Z`), endedAt: new Date(`2026-03-09T1${index}:05:00.000Z`), endedReason: "completed", raw: {}, createdAt: new Date(`2026-03-09T1${index}:00:00.000Z`) });
    }
  });
  await withTenant(TENANT_B, (db) => db.insert(households).values({ id: HOUSEHOLD_B, tenantId: TENANT_B, address: "10 Qualifying Lane", contactInfo: { name: "No Consent Household" }, marketingConsent: false }));
}

describe.skipIf(!available)("Upgrade 3 operational query plane against migrated PostgreSQL", () => {
  beforeAll(async () => {
    await insertFixture();
  });

  afterAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await closePool();
  });

  it("executes all eight typed intents with bounded canonical results", async () => {
    const requests: OperationalQueryRequest[] = [
      { intent: "customer_lookup", householdId: HOUSEHOLD_QUALIFYING, page: { limit: 20 } },
      { intent: "customer_cohort", cohort: "inactive", minDaysInactive: 90, page: { limit: 20 } },
      { intent: "schedule_range", range: DST_RANGE, page: { limit: 20 } },
      { intent: "money_summary", range: DST_RANGE, page: { limit: 20 } },
      { intent: "work_list", section: "all", page: { limit: 20 } },
      { intent: "inventory_status", lowStockOnly: false, includeOpenProcurement: true, page: { limit: 20 } },
      { intent: "agent_activity", range: DST_RANGE, page: { limit: 20 } },
      { intent: "business_state", page: { limit: 20 } },
    ];
    const results = await Promise.all(requests.map((request) => executeOperationalQuery(TENANT_A, request)));
    expect(results.map((result) => result.intent)).toEqual(requests.map((request) => request.intent));
    for (const result of results) {
      expect(result.version).toBe(1);
      expect(result.source.kind).toBe("canonical_postgres");
      expect(result.page.returned).toBeLessThanOrEqual(result.page.limit);
      expect(result.page.truncated).toBe(result.page.hasMore);
      expect(JSON.stringify(result).length).toBeLessThan(100_000);
      expect(JSON.stringify(result)).not.toContain("fixture transcript must not be returned");
    }
  });

  it("keeps uneven work, inventory, and agent sections keyset-paginated without restarting exhausted sections", async () => {
    const collect = async (
      request: OperationalQueryRequest,
      section: "work" | "inventory" | "agent",
    ): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const result = await executeOperationalQuery(TENANT_A, {
          ...request,
          page: { limit: 1, ...(cursor ? { cursor } : {}) },
        } as OperationalQueryRequest);
        expect(result.page.returned).toBeLessThanOrEqual(result.page.limit);
        if (section === "work") {
          expect(result.intent).toBe("work_list");
          if (result.intent === "work_list") ids.push(...result.works.map((row) => row.id), ...result.workOrders.map((row) => row.id), ...result.tasks.map((row) => row.id));
        } else if (section === "inventory") {
          expect(result.intent).toBe("inventory_status");
          if (result.intent === "inventory_status") ids.push(...result.items.map((row) => row.id), ...result.warehouseStock.map((row) => row.id), ...result.openProcurement.map((row) => row.id));
        } else {
          expect(result.intent).toBe("agent_activity");
          if (result.intent === "agent_activity") ids.push(...result.users.map((row) => row.id), ...result.technicians.map((row) => row.id), ...result.actions.map((row) => row.id), ...result.workflows.map((row) => row.id), ...result.calls.map((row) => row.id));
        }
        if (!result.page.hasMore) return ids;
        expect(result.page.nextCursor).toEqual(expect.any(String));
        cursor = result.page.nextCursor ?? undefined;
      }
      throw new Error(`pagination did not terminate for ${section}`);
    };

    const workIds = await collect({ intent: "work_list", section: "all" }, "work");
    const inventoryIds = await collect({ intent: "inventory_status", lowStockOnly: false, includeOpenProcurement: true }, "inventory");
    const agentIds = await collect({ intent: "agent_activity", range: { start: "2026-01-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" } }, "agent");
    expect(workIds.length).toBeGreaterThan(3);
    expect(inventoryIds.length).toBeGreaterThan(3);
    expect(agentIds.length).toBeGreaterThan(3);
    expect(new Set(workIds).size).toBe(workIds.length);
    expect(new Set(inventoryIds).size).toBe(inventoryIds.length);
    expect(new Set(agentIds).size).toBe(agentIds.length);
  });

  it("returns every qualifying inactive household, including no-consent/no-phone and never-active rows, with stable exact pagination and no mutations", async () => {
    const before = await withTenant(TENANT_A, async (db) => ({
      actions: (await db.select({ id: domainActions.id }).from(domainActions).where(eq(domainActions.tenantId, TENANT_A))).length,
      calls: (await db.select({ id: calls.id }).from(calls).where(eq(calls.tenantId, TENANT_A))).length,
    }));
    const request: OperationalQueryRequest = { intent: "customer_cohort", cohort: "inactive", minDaysInactive: 90, page: { limit: 2 } };
    const complete = await executeOperationalQuery(TENANT_A, { ...request, page: { limit: 20 } });
    expect(complete.intent).toBe("customer_cohort");
    expect(complete.page.totalCountExact).toBe(true);
    expect(complete.page.totalCount).toBeGreaterThanOrEqual(2);
    expect(complete.rows.some((row) => row.householdId === HOUSEHOLD_QUALIFYING)).toBe(true);
    expect(complete.rows.some((row) => row.householdId === HOUSEHOLD_NEVER_ACTIVE)).toBe(true);
    expect(complete.rows.some((row) => row.householdId === HOUSEHOLD_ACTIVE)).toBe(false);
    const fixedBoundary = await executeOperationalQuery(TENANT_A, { ...request, page: { limit: 20 } }, { now: () => FIXED_AS_OF });
    expect(fixedBoundary.rows.some((row) => row.householdId === HOUSEHOLD_AT_CUTOFF)).toBe(false);
    expect(fixedBoundary.rows.some((row) => row.householdId === HOUSEHOLD_NEW)).toBe(false);
    const expectedIds = complete.rows.map((row) => row.householdId);
    const pagedIds: string[] = [];
    let cursor: string | undefined;
    let lastPage: typeof complete | null = null;
    do {
      lastPage = await executeOperationalQuery(TENANT_A, { ...request, page: { limit: 2, ...(cursor ? { cursor } : {}) } });
      pagedIds.push(...lastPage.rows.map((row) => row.householdId));
      cursor = lastPage.page.nextCursor ?? undefined;
    } while (lastPage.page.hasMore && cursor);
    expect(new Set(pagedIds).size).toBe(pagedIds.length);
    expect(pagedIds).toEqual(expectedIds);
    expect(lastPage?.page.totalCount).toBe(complete.page.totalCount);
    expect(lastPage?.page.hasMore).toBe(false);
    const repeat = await executeOperationalQuery(TENANT_A, { ...request, page: { limit: 2 } });
    expect(repeat.rows.map((row) => row.householdId)).toEqual(pagedIds.slice(0, 2));
    const after = await withTenant(TENANT_A, async (db) => ({
      actions: (await db.select({ id: domainActions.id }).from(domainActions).where(eq(domainActions.tenantId, TENANT_A))).length,
      calls: (await db.select({ id: calls.id }).from(calls).where(eq(calls.tenantId, TENANT_A))).length,
    }));
    expect(after).toEqual(before);
  });

  it("uses a DST-safe half-open range and returns appointments, visits, and work orders while excluding the end boundary", async () => {
    const result = await executeOperationalQuery(TENANT_A, { intent: "schedule_range", range: DST_RANGE, page: { limit: 20 } });
    const rows = result.rows;
    expect(rows.some((row) => row.kind === "appointment" && row.id === APPOINTMENT_A)).toBe(true);
    expect(rows.some((row) => row.kind === "service_visit" && row.id === VISIT_A)).toBe(true);
    expect(rows.some((row) => row.kind === "work_order" && row.id === WORK_ORDER_A)).toBe(true);
    expect(rows.every((row) => row.scheduledAt >= DST_RANGE.start && row.scheduledAt < DST_RANGE.end)).toBe(true);
    expect(rows.some((row) => row.scheduledAt === DST_RANGE.end)).toBe(false);
  });

  it("routes today-through-tomorrow through the tenant timezone/DST resolver and records one Work query receipt without planning", async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await closePool();
    let plannerInvocations = 0;
    const forbiddenPlanner = {
      async plan(): Promise<never> {
        plannerInvocations += 1;
        throw new Error("NL operational query invoked the planner");
      },
    } as unknown as Planner;
    const orchestrator = new FinnorOrchestrator({
      planner: forbiddenPlanner,
      executor: { execute: async () => { throw new Error("NL operational query invoked the executor"); } } as unknown as Executor,
      fastReadOnlyRouter: createFastReadOnlyRouter({ now: () => DST_AS_OF }),
    });
    const result = await orchestrator.handleInstructionResult("Show everything today through tomorrow", { tenantId: TENANT_A, userId: USER_A, role: "owner" }, {
      channel: "console",
      idempotencyKey: `nl-schedule-${randomUUID()}`,
    });
    expect(plannerInvocations).toBe(0);
    expect(result.query?.request).toMatchObject({ intent: "schedule_range", localDateRange: { startDate: "today", endDate: "tomorrow" } });
    expect(result.query?.result.intent).toBe("schedule_range");
    if (result.query?.result.intent === "schedule_range") {
      expect(result.query.result.timeZone).toBe("America/New_York");
      expect(result.query.result.range).toEqual(DST_RANGE);
      expect(result.query.result.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "appointment", id: APPOINTMENT_A }),
        expect.objectContaining({ kind: "service_visit", id: VISIT_A }),
        expect.objectContaining({ kind: "work_order", id: WORK_ORDER_A }),
      ]));
    }
    expect(result.workId).toBeDefined();
    const aggregate = await workAggregate(TENANT_A, result.workId!);
    expect(aggregate?.queryExecutions).toHaveLength(1);
    expect(aggregate?.queryExecutions[0]).toMatchObject({ workId: result.workId, status: "succeeded" });
    const plannerAttempts = await withTenant(TENANT_A, (db) => db.select().from(workPlannerAttempts).where(eq(workPlannerAttempts.workId, result.workId!)));
    expect(plannerAttempts).toHaveLength(0);
  });

  it("keeps tenant reads isolated and does not enumerate a foreign household id, even when RLS is bypassed", async () => {
    const foreign = await executeOperationalQuery(TENANT_B, { intent: "customer_lookup", householdId: HOUSEHOLD_QUALIFYING, page: { limit: 20 } });
    expect(foreign.resolution).toBe("not_found");
    expect(foreign.rows).toEqual([]);
    const cohort = await executeOperationalQuery(TENANT_B, { intent: "customer_cohort", cohort: "inactive", minDaysInactive: 90, page: { limit: 20 } });
    expect(cohort.rows.every((row) => row.householdId !== HOUSEHOLD_QUALIFYING && row.householdId !== HOUSEHOLD_NEVER_ACTIVE)).toBe(true);
    expect(cohort.source.tables).toContain("households");
  });

  it("repeats the same isolation proof through the restricted RLS role", async () => {
    process.env.DATABASE_URL = APP_URL;
    await closePool();
    const foreign = await executeOperationalQuery(TENANT_B, { intent: "customer_lookup", householdId: HOUSEHOLD_QUALIFYING, page: { limit: 20 } });
    expect(foreign.resolution).toBe("not_found");
    expect(foreign.rows).toEqual([]);
    const mine = await executeOperationalQuery(TENANT_A, { intent: "customer_lookup", householdId: HOUSEHOLD_QUALIFYING, page: { limit: 20 } });
    expect(mine.rows.map((row) => row.householdId)).toEqual([HOUSEHOLD_QUALIFYING]);
    process.env.DATABASE_URL = SUPER_URL;
    await closePool();
  });

  it("links a successful and failed query to Work/Input without creating planner attempts, and deduplicates execution claims", async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await closePool();
    const received = await receiveWork({ tenantId: TENANT_A, instruction: "typed query acceptance", channel: "console", userId: USER_A });
    const request: OperationalQueryRequest = { intent: "business_state", page: { limit: 20 } };
    const options = { workId: received.workId, workInputId: received.workInputId, executionKey: "acceptance:business-state" };
    const first = await executeOperationalQuery(TENANT_A, request, options);
    const second = await executeOperationalQuery(TENANT_A, request, options);
    expect(first.execution?.status).toBe("succeeded");
    expect(second.execution?.id).toBe(first.execution?.id);
    const aggregate = await workAggregate(TENANT_A, received.workId);
    expect(aggregate?.queryExecutions).toHaveLength(1);
    expect((aggregate?.queryExecutions as Array<Record<string, unknown>>)[0]).toMatchObject({ workId: received.workId, workInputId: received.workInputId, status: "succeeded" });
    const plannerAttempts = await withTenant(TENANT_A, (db) => db.select().from(workPlannerAttempts).where(eq(workPlannerAttempts.workId, received.workId)));
    expect(plannerAttempts).toHaveLength(0);
    const [durable] = await withTenant(TENANT_A, (db) => db.select().from(workQueryExecutions).where(eq(workQueryExecutions.id, first.execution!.id)));
    expect(durable?.startedAt).toBeInstanceOf(Date);
    expect(durable?.completedAt).toBeInstanceOf(Date);
    expect(durable?.durationMs).toBeGreaterThanOrEqual(0);

    const badRequest = { intent: "schedule_range", range: { start: DST_RANGE.end, end: DST_RANGE.start }, page: { limit: 20 } } as OperationalQueryRequest;
    const failedOptions = { workId: received.workId, workInputId: received.workInputId, executionKey: "acceptance:failed-query" };
    await expect(executeOperationalQuery(TENANT_A, badRequest, failedOptions)).rejects.toThrow();
    const [failed] = await withTenant(TENANT_A, (db) => db.select().from(workQueryExecutions).where(eq(workQueryExecutions.executionKey, failedOptions.executionKey)));
    expect(failed?.status).toBe("failed");
    expect(failed?.startedAt).toBeInstanceOf(Date);
    expect(failed?.completedAt).toBeInstanceOf(Date);
    expect(failed?.durationMs).toBeGreaterThanOrEqual(0);
    expect(failed?.failure).not.toBeNull();
  });
});
