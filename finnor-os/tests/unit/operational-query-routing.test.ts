import { describe, expect, it } from "vitest";
import { classifyFastReadOnlyQuestion, createFastReadOnlyRouter, interpretOperationalQuery, validateOperationalQueryRequest } from "../../packages/orchestration/src/fast-read-lane";
import { queryAuthorityRequest } from "../../packages/orchestration/src/authority-runtime";

const supportedReads: Array<[string, string]> = [
  ["Find the customer record for Alice Johnson", "customer_lookup"],
  ["Find every customer inactive for more than 90 days", "customer_cohort"],
  ["Show everything today through tomorrow", "schedule_range"],
  ["Pull up all the free technicians for me for today", "schedule_range"],
  ["Can you show me the available technicians for today?", "schedule_range"],
  ["Who is free today for service visits?", "schedule_range"],
  ["How much cash have we collected?", "money_summary"],
  ["What work is open right now?", "work_list"],
  ["Which inventory items are low?", "inventory_status"],
  ["Show agent activity for today", "agent_activity"],
  ["What is the current business state?", "business_state"],
  ["Show the complete customer history for Alice Johnson", "company_context"],
];

describe("Upgrade 3 deterministic operational-query classification", () => {
  it.each(supportedReads)("routes %s to the typed %s intent", (question, intent) => {
    const result = interpretOperationalQuery(question) as unknown as Record<string, unknown>;
    expect(result.route).toBe("fast_read");
    expect((result.request as Record<string, unknown>).intent).toBe(intent);
    const legacy = classifyFastReadOnlyQuestion(question) as unknown as Record<string, unknown>;
    expect(legacy.route).toBe("fast_read");
  });

  it("preserves the legacy cash_collections classifier alias while carrying money_summary for execution", () => {
    const legacy = classifyFastReadOnlyQuestion("How are cash collections?") as unknown as Record<string, unknown>;
    expect(legacy).toMatchObject({ route: "fast_read", intent: "cash_collections" });
    const typed = interpretOperationalQuery("How are cash collections?") as unknown as Record<string, unknown>;
    expect((typed.request as Record<string, unknown>).intent).toBe("money_summary");
  });

  it.each([
    "Show the schedule tomorrow. Read only: do not create, update, cancel, approve, or execute any business action.",
    "Show the schedule tomorrow and do not cancel appointments",
    "Show the schedule tomorrow, but never update any appointment",
  ])("keeps an explicit trailing non-effect guard on the deterministic read lane: %s", (question) => {
    expect(interpretOperationalQuery(question)).toMatchObject({
      route: "fast_read",
      request: { intent: "schedule_range", localDateRange: { startDate: "tomorrow" } },
    });
  });

  it.each([
    "Can you cancel tomorrow's appointment?",
    "Show the schedule tomorrow, then cancel the first appointment",
    "Show the schedule tomorrow. Create a follow-up task, but do not send it",
    "Do not cancel tomorrow's appointments",
  ])("never strips a consequential primary request: %s", (question) => {
    expect(interpretOperationalQuery(question).route).toBe("planner");
  });

  it.each([
    "Create an invoice for Alice Johnson",
    "Send a payment reminder to every overdue customer",
    "Schedule a service visit for tomorrow",
    "Delete the duplicate household",
    "How can we improve cash collections?",
    "Should we reorder the low-stock items?",
    "Why did revenue fall last month?",
    "Forecast next month's collections",
    "Show appointments sometime next week",
    "Show the customer record for Alex",
    "hi",
    "Good morning",
    "How are QuickBooks collections?",
    "Show customers'; DROP TABLE households; --",
    "Show inventory and reorder anything below threshold",
    "Find every inactive customer and text them an offer",
  ])("fails closed to planner for non-deterministic or consequential input: %s", (question) => {
    const result = classifyFastReadOnlyQuestion(question);
    expect(result.route).toBe("planner");
  });

  it("does not treat a tenant selector, action, provider, or arbitrary payload as a query request", () => {
    const result = classifyFastReadOnlyQuestion(
      "Show the customer record for Alice Johnson; tenantId=other-tenant; action=send_sms; provider=quickbooks; payload={role:'owner'}",
    ) as unknown as Record<string, unknown>;
    expect(result.route).toBe("planner");
    expect(result.intent).toBeUndefined();
    expect(result.request).toBeUndefined();
  });

  it("validates the four canonical party reads without a tenant selector or resolver bypass", () => {
    const ref = { partyType: "employee", partyId: "11111111-1111-4111-8111-111111111111" } as const;
    const requests = [
      { intent: "party_lookup", ref },
      { intent: "party_context", query: "my manager" },
      { intent: "team_roster", teamRef: { partyType: "team", partyId: ref.partyId } },
      { intent: "party_availability", ref, localDateRange: { startDate: "today" }, includeCapacity: true },
    ];
    for (const request of requests) {
      const parsed = validateOperationalQueryRequest(request);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.request).not.toHaveProperty("tenantId");
    }
    expect(validateOperationalQueryRequest({ intent: "party_lookup", query: "Ada", tenantId: "other" }).success).toBe(false);
    expect(validateOperationalQueryRequest({ intent: "party_context", query: "Ada", includeInactive: true }).success).toBe(false);
    expect(validateOperationalQueryRequest({ intent: "team_roster", teamRef: ref }).success).toBe(false);
  });

  it("accepts both canonical and PartyRef company-context anchors", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(validateOperationalQueryRequest({ intent: "company_context", anchor: { entityType: "household", entityId: id } }).success).toBe(true);
    expect(validateOperationalQueryRequest({ intent: "company_context", anchor: { partyType: "employee", partyId: id } }).success).toBe(true);
    expect(validateOperationalQueryRequest({ intent: "company_context", anchor: { entityType: "household", entityId: id, tenantId: "other" } }).success).toBe(false);
    expect(validateOperationalQueryRequest({ intent: "company_context", anchor: { partyType: "employee", partyId: id, tenantId: "other" } }).success).toBe(false);
    expect(validateOperationalQueryRequest({ intent: "company_context", anchor: { entityType: "household", entityId: id, extra: true } }).success).toBe(false);
  });

  it("scopes party authority to the typed PartyRef when one is supplied", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(queryAuthorityRequest({ intent: "party_availability", ref: { partyType: "employee", partyId: id } }).resource).toEqual({ type: "employee", id });
    expect(queryAuthorityRequest({ intent: "team_roster", teamRef: { partyType: "team", partyId: id } }).resource).toEqual({ type: "team", id });
    expect(queryAuthorityRequest({ intent: "company_context", anchor: { partyType: "team", partyId: id } }).resource).toEqual({ type: "team", id });
  });

  it("preserves an explicit inactive result status through the fast-read envelope", async () => {
    const source = { kind: "canonical_postgres" as const, tables: ["users"] };
    const raw = {
      kind: "operational_query_result" as const,
      status: "inactive" as const,
      data: {},
      version: 1 as const,
      intent: "party_lookup" as const,
      source,
      asOf: "2026-08-21T00:00:00.000Z",
      count: 1,
      truncated: false,
      page: { limit: 1, returned: 1, totalCount: 1, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false },
      meta: { version: 1 as const, source, asOf: "2026-08-21T00:00:00.000Z" },
    };
    const router = createFastReadOnlyRouter({
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      executeOperationalQuery: (async () => raw) as never,
    });
    const execution = await router.execute!({ intent: "party_lookup", query: "Former employee" }, { tenantId: "tenant-a", userId: "11111111-1111-4111-8111-111111111111" });
    expect(execution.result.status).toBe("inactive");
  });

  it("carries upstream source provenance and stale truth into the answer without remote fanout", async () => {
    const source = { kind: "canonical_postgres" as const, tables: ["households", "contacts"] };
    const asOf = "2026-08-24T12:00:00.000Z";
    const raw = {
      kind: "operational_query_result" as const,
      status: "ok" as const,
      data: {}, version: 1 as const, intent: "customer_lookup" as const, source, asOf,
      count: 1, truncated: false,
      page: { limit: 1, returned: 1, totalCount: 1, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false },
      meta: { version: 1 as const, source, asOf },
      rows: [], resolution: "unique",
    };
    let sourceChecks = 0;
    const router = createFastReadOnlyRouter({
      now: () => new Date(asOf),
      executeOperationalQuery: (async () => raw) as never,
      sourceTruth: async () => {
        sourceChecks += 1;
        return {
          sources: [{
            integrationId: "11111111-1111-4111-8111-111111111111",
            capability: "crm", binding: "ghl", mode: "sandbox", syncScopes: ["contacts"], outcomePacks: ["customer_operations"], sourcePolicyConfigured: true,
            configured: true, authenticated: true, reachable: false, syncInitialized: true,
            lastSuccessfulSyncAt: "2026-08-24T11:00:00.000Z", freshness: "stale", webhook: "healthy", reconciliation: "degraded",
            unresolvedConflicts: 1, state: "degraded",
          }],
          outcomeCoverage: { customer_operations: { ready: false, sources: ["11111111-1111-4111-8111-111111111111"], reasons: ["crm/ghl:degraded"] } },
          requiredOutcomePacks: ["customer_operations"], ready: false,
        };
      },
    });
    const execution = await router.execute!({ intent: "customer_lookup", query: "Ada" }, { tenantId: "tenant-a" });
    const answer = router.answer!(execution);
    expect(sourceChecks).toBe(1);
    expect(answer.freshness).toMatchObject({
      status: "stale",
      observedAt: "2026-08-24T11:00:00.000Z",
      sourceTruth: {
        provenance: "tenant_integrations+integration_sync_checkpoints+external_refs",
        sources: [expect.objectContaining({ provider: "ghl", state: "degraded", unresolvedConflicts: 1 })],
      },
    });
  });
});
