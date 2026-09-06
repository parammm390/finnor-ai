import { describe, expect, it } from "vitest";
import { resolveCompetitorResearch } from "@finnor/orchestration";
import type { OperatingContext } from "@finnor/shared-types";

const EXACT = "Find competitors in Florida around my age, doing better/worse than us, in the $5M–$15M bracket.";

function context(overrides: Partial<OperatingContext["tenant"]["profile"]> = {}, userFacts: Record<string, unknown> = {}): OperatingContext {
  return {
    version: 1,
    assembledAt: "2026-08-17T12:00:00.000Z",
    truthPrecedence: ["CANONICAL", "WORK", "PROFILE", "SESSION", "MEMORY", "WEB"],
    tenant: {
      id: "tenant-1",
      companyName: "Apex Capital",
      timezone: "America/New_York",
      profile: {
        industry: "private equity",
        niche: "lower-middle-market buyout",
        description: null,
        primaryGeographies: ["Florida"],
        foundedYear: null,
        idealCustomerProfile: { segment: "founder-owned B2B software" },
        businessFacts: {},
        comparisonDefaults: {},
        updatedAt: "2026-08-17T00:00:00.000Z",
        ...overrides,
      },
    },
    employee: {
      userId: "user-1",
      employeeId: "user-1",
      displayName: "Owner",
      role: "owner",
      authorityRoles: ["owner"],
      profile: { title: "Founder", profileFacts: userFacts, updatedAt: "2026-08-17T00:00:00.000Z" },
    },
    activeWork: { id: "work-1", status: "understanding", sessionId: "session-1", initialInstruction: EXACT, activeContext: {}, updatedAt: "2026-08-17T12:00:00.000Z" },
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
    canonicalSummaries: [],
    memory: { conversation: null, semantic: [], episodic: [] },
    integrationHealth: {},
    authority: { principal: "user-1", employeeId: "user-1", revision: 1, roles: ["owner"] },
    sources: [],
    health: { status: "complete", missing: [], errors: [] },
  };
}

describe("authenticated competitor research resolution", () => {
  it("turns the exact ambiguous prompt into one clarification and never guessed research", () => {
    const result = resolveCompetitorResearch(EXACT, context());
    expect(result.route).toBe("clarification");
    if (result.route !== "clarification") throw new Error("Expected clarification");
    expect(result.action.action_type).toBe("clarification_request");
    expect(result.action.payload.missingFields).toEqual([
      "authenticated user age",
      "scale metric",
      "comparison metric",
      "company comparison baseline",
    ]);
    expect(result.action.payload.question).toMatch(/age.*revenue.*better\/worse/i);
    expect(JSON.stringify(result)).not.toMatch(/ARR assumption|generic market statistics/i);
  });

  it("resolves all supplied clarification dimensions in one continuation", () => {
    const continued = `${EXACT}\nClarification supplied in this turn: I am 39; annual revenue; compare lead conversion rate; our lead conversion rate is 31%.`;
    const result = resolveCompetitorResearch(continued, context());
    expect(result.route).toBe("resolved");
    if (result.route !== "resolved") throw new Error("Expected one-turn clarification resolution");
    expect(result.action.payload.researchContext.comparison).toMatchObject({
      founderAge: 39,
      scaleMetric: "annual revenue",
      performanceMetric: "lead conversion rate",
      companyBaseline: "31%",
    });
  });

  it("routes resolved authenticated context to company-specific WEB research", () => {
    const result = resolveCompetitorResearch(EXACT, context({
      comparisonDefaults: { scaleMetric: "annual revenue", performanceMetric: "lead conversion rate" },
      businessFacts: { leadConversionRate: "31%" },
    }, { age: 39 }));
    expect(result.route).toBe("resolved");
    if (result.route !== "resolved") throw new Error("Expected resolved research");
    expect(result.action).toMatchObject({
      action_type: "search_web",
      payload: {
        researchContext: {
          companyName: "Apex Capital",
          industry: "private equity",
          geographies: ["Florida"],
          comparison: {
            founderAge: 39,
            scaleMetric: "annual revenue",
            minScaleUsd: 5_000_000,
            maxScaleUsd: 15_000_000,
            performanceMetric: "lead conversion rate",
            companyBaseline: "31%",
          },
          sourceKinds: ["PROFILE", "WEB"],
        },
      },
    });
    expect(result.action.payload.query).toMatch(/actual lower-middle-market buyout companies in Florida/i);
    expect(result.action.payload.query).toMatch(/exclude generic market statistics/i);
  });
});
