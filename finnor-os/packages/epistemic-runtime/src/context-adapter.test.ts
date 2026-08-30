import { describe, expect, it } from "vitest";
import { OPERATING_TRUTH_PRECEDENCE, type OperatingContext } from "@finnor/shared-types";
import { epistemicStateFromOperatingContext } from "./context-adapter";
import { EXISTING_TRUTH_PRECEDENCE } from "./source-precedence";
import { consequentialProvenanceSatisfied, propositionById } from "./state";
import { TEST_NOW, TEST_TENANT, testDefinition } from "./test-support";

function context(tenantId = TEST_TENANT): OperatingContext {
  return {
    version: 1,
    assembledAt: TEST_NOW,
    truthPrecedence: OPERATING_TRUTH_PRECEDENCE,
    tenant: {
      id: tenantId,
      companyName: "Fixture Co",
      timezone: "UTC",
      profile: {
        industry: "water",
        niche: null,
        description: null,
        primaryGeographies: [],
        foundedYear: null,
        idealCustomerProfile: {},
        businessFacts: {},
        comparisonDefaults: {},
        updatedAt: TEST_NOW,
      },
    },
    employee: {
      userId: "user-1",
      employeeId: null,
      displayName: null,
      role: "owner",
      authorityRoles: [],
      profile: { title: null, profileFacts: {}, updatedAt: TEST_NOW },
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
    canonicalSummaries: [{
      name: "business_state",
      asOf: TEST_NOW,
      source: "canonical_postgres",
      data: { overdueInvoices: 4 },
    }],
    memory: { conversation: null, semantic: [], episodic: [] },
    integrationHealth: {},
    authority: { principal: "user-1", employeeId: null, revision: null, roles: [] },
    sources: [{
      kind: "CANONICAL",
      source: "operational_query:business_state",
      ref: "query:1",
      asOf: TEST_NOW,
      role: "context_only",
    }],
    health: { status: "complete", missing: [], errors: [] },
  };
}

describe("existing operating-context adapter", () => {
  it("preserves exact P0 precedence and the answer-evidence/context-only boundary", () => {
    expect(EXISTING_TRUTH_PRECEDENCE).toEqual(OPERATING_TRUTH_PRECEDENCE);
    const state = epistemicStateFromOperatingContext({
      context: context(),
      scope: { tenantId: TEST_TENANT, principalId: "user-1", decisionId: "decision:context" },
      bindings: [{
        proposition: testDefinition("business.overdue_invoice_count", { kind: "system", type: "business_state" }),
        path: "canonicalSummaries.0.data.overdueInvoices",
      }],
    });
    expect(propositionById(state, "business.overdue_invoice_count")?.status).toBe("KNOWN");
    expect(propositionById(state, "business.overdue_invoice_count")?.source).toMatchObject({
      kind: "CANONICAL_DB",
      owner: "operational_query:business_state",
      role: "context_only",
    });
    expect(consequentialProvenanceSatisfied(state, "business.overdue_invoice_count")).toBe(false);
  });

  it("rejects an OperatingContext from another tenant", () => {
    expect(() => epistemicStateFromOperatingContext({
      context: context("22222222-2222-4222-8222-222222222222"),
      scope: { tenantId: TEST_TENANT, principalId: "user-1", decisionId: "decision:context" },
      bindings: [],
    })).toThrow(/tenant/);
  });
});
