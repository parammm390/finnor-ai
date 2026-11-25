import { describe, expect, it } from "vitest";
import { LLMPlanner, createDefaultPluginRegistry, plannerActionTypesForVertical } from "@finnor/orchestration";
import type { LLMProvider } from "@finnor/orchestration";
import type { MemorySnapshot, OperatingContext } from "@finnor/shared-types";
import { privateEquityObjectiveSuccessCondition } from "../../packages/orchestration/src/objective-success";

const memory: MemorySnapshot = { shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null };

function privateEquityContext(): OperatingContext {
  return {
    version: 1,
    assembledAt: "2026-09-05T12:00:00.000Z",
    truthPrecedence: ["CANONICAL", "WORK", "PROFILE", "SESSION", "MEMORY", "WEB"],
    tenant: {
      id: "11111111-1111-4111-8111-111111111111",
      companyName: "Atlas Sponsor",
      timezone: "America/New_York",
      vertical: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        verticalKey: "private_equity",
        version: 1,
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        sourceSystem: "unit:pe3",
        sourceRef: null,
      },
      profile: {
        industry: "private equity",
        niche: "lower middle market buyouts",
        description: null,
        primaryGeographies: ["United States"],
        foundedYear: null,
        idealCustomerProfile: {},
        businessFacts: {},
        comparisonDefaults: {},
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    },
    employee: {
      userId: "22222222-2222-4222-8222-222222222222",
      employeeId: "22222222-2222-4222-8222-222222222222",
      displayName: "Deal Lead",
      role: "owner",
      authorityRoles: ["owner"],
      profile: { title: "Partner", profileFacts: {}, updatedAt: "2026-09-05T00:00:00.000Z" },
    },
    activeWork: null,
    companyDirectory: {
      employee: null,
      teams: [],
      locations: [],
      reporting: { manager: null, reports: [], backups: [], assistants: [] },
      currentWork: [],
      currentTasks: [],
      authorityRoles: [],
      referencedParties: [],
      sourceTables: [],
    },
    identityAccess: { communicationIdentities: [], applicationAccounts: [], authProfiles: [] },
    referencedEntities: [],
    epistemicWarnings: [{
      propositionId: "pe:v1:deal:item:closing_item.verified",
      predicate: "closing_item.verified",
      status: "UNKNOWN",
      reason: "No exact verification evidence",
      evidenceRefs: [],
    }],
    canonicalSummaries: [],
    memory: { conversation: null, semantic: [], episodic: [] },
    integrationHealth: {
      documents: {
        capability: "documents",
        binding: "internal",
        source: "default",
        health: "ok",
        circuit: "closed",
        unavailable: false,
        reason: null,
      },
    },
    authority: {
      principal: "22222222-2222-4222-8222-222222222222",
      employeeId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      roles: ["owner"],
    },
    sources: [],
    health: { status: "complete", missing: [], errors: [] },
  };
}

describe("Private Equity planner isolation", () => {
  it("selects the requested revenue downside rather than a cited-entry baseline", async () => {
    const dealId = "33333333-3333-4333-8333-333333333333";
    const investmentCaseId = "44444444-4444-4444-8444-444444444444";
    const citedVersion = "55555555-5555-4555-8555-555555555555";
    const forecastVersion = "66666666-6666-4666-8666-666666666666";
    const baseRunId = "77777777-7777-4777-8777-777777777777";
    const operatingContext = privateEquityContext();
    const objective = "Prepare the Investment Committee memo and challenge the revenue assumptions.";
    const result = await new LLMPlanner(createDefaultPluginRegistry(), {
      name: "unused", async complete() { throw Error("Expected deterministic planning"); },
    }).plan(objective, { tenantId: operatingContext.tenant.id, userId: operatingContext.employee.userId, role: "owner" }, memory, {
      operatingContext,
      successCondition: privateEquityObjectiveSuccessCondition({ objective, dealId }),
      planningContext: {
        queryExecutions: [{ intent: "pe_world_state", status: "succeeded" }],
        privateEquityIcBasis: {
          dealId,
          investmentCases: [{ id: investmentCaseId, state: "active" }],
          modelVersions: [
            { id: citedVersion, investmentCaseId, modelKey: "cited-entry-economics" },
            { id: forecastVersion, investmentCaseId, inputNodes: [{ id: "operating.revenue_explicit", shape: "series" }] },
          ],
          recentRuns: [{
            id: baseRunId, investmentCaseId, modelVersionId: forecastVersion, status: "SUCCEEDED", validity: "VALID",
            revenueInput: { nodeId: "operating.revenue_explicit", status: "KNOWN", value: { "2026": "100" } },
          }],
        },
      },
    });
    expect(result.candidates).toEqual([expect.objectContaining({
      candidateKey: "deterministic-ic-revenue-sensitivity",
      nodes: expect.arrayContaining([expect.objectContaining({
        actionType: "create_underwriting_run",
        payload: expect.objectContaining({ baseRunId, scenario: expect.objectContaining({
          overrides: [expect.objectContaining({ nodeId: "operating.revenue_explicit", value: { "2026": "80" } })],
        }) }),
      })]),
    })]);
  });

  it("composes shared and PE actions without exposing Water actions", () => {
    const registry = createDefaultPluginRegistry();
    const actions = plannerActionTypesForVertical(registry, "private_equity");
    expect(actions).toContain("clarification_request");
    expect(actions).toContain("send_message");
    expect(actions).toContain("computer_task");
    expect(actions).toContain("declare_deal_closed");
    expect(actions).not.toContain("waive_closing_condition");
    expect(registry.payloadSpecJson(actions)).not.toMatch(/create_invoice|schedule_water_test/i);
    expect(() => plannerActionTypesForVertical(registry, "water")).toThrow(/retired/i);
  });

  it("uses PE doctrine, exposes epistemic warnings, and rejects a legacy Water Action[] envelope", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    const provider: LLMProvider = {
      name: "capturing-pe-planner",
      async complete(options) {
        capturedSystem = options.system;
        capturedUser = options.user;
        return JSON.stringify({ actions: [{ action_type: "create_invoice", payload: { amountUsd: 500 }, reasoning: "wrong vertical" }] });
      },
    };
    const planner = new LLMPlanner(createDefaultPluginRegistry(), provider);
    const result = await planner.plan(
      "Create an invoice for Atlas.",
      { tenantId: privateEquityContext().tenant.id, userId: privateEquityContext().employee.userId, role: "owner" },
      memory,
      { operatingContext: privateEquityContext() },
    );
    expect(result.compilation.selected).toBeNull();
    expect(result.compilation.candidates).toHaveLength(1);
    expect(result.compilation.candidates[0]).toMatchObject({
      accepted: false,
      violations: [expect.objectContaining({ code: "CANDIDATE_SCHEMA_INVALID" })],
    });
    expect(capturedSystem).toMatch(/Task is not Request.*Document is not Deliverable.*ready is not verified/i);
    expect(capturedSystem).toMatch(/provider acknowledgement is not verified external outcome/i);
    expect(capturedSystem).not.toMatch(/water treatment|schedule_water_test|create_invoice/i);
    expect(capturedUser).toContain("closing_item.verified");
    expect(capturedUser).toContain("UNKNOWN");
  });
});
