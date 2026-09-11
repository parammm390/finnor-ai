import { describe, expect, it } from "vitest";
import {
  PE_ENTITY_TYPES,
  buildPrivateEquityWorldEpistemicSnapshot,
  peWorldPropositionId,
  privateEquityAssertionsFromRows,
} from "@finnor/private-equity";
import { interpretOperationalQuery, validateOperationalQueryRequest } from "@finnor/orchestration";

const tenantId = "11111111-1111-4111-8111-111111111111";
const strategyId = "22222222-2222-4222-8222-222222222222";
const root = { entityType: "pe_strategy" as const, entityId: strategyId };
const at = "2026-09-07T12:00:00.000Z";

describe("P1 PE world contracts", () => {
  it("preserves the twenty P1 owners and admits only the eight P5 process-history types", () => {
    const p1Types = PE_ENTITY_TYPES.filter((entityType) => !entityType.startsWith("pe_ic_"));
    const p5Types = PE_ENTITY_TYPES.filter((entityType) => entityType.startsWith("pe_ic_"));
    expect(p1Types).toHaveLength(20);
    expect(p1Types.slice(0, 7)).toEqual([
      "pe_strategy", "pe_opportunity", "pe_deal", "pe_investment_case",
      "pe_thesis", "pe_assumption", "pe_decision",
    ]);
    expect(p5Types).toEqual([
      "pe_ic_case", "pe_ic_memo", "pe_ic_question", "pe_ic_recommendation",
      "pe_ic_vote", "pe_ic_dissent", "pe_ic_condition", "pe_ic_decision_proposal",
    ]);
    expect(PE_ENTITY_TYPES).not.toContain("pe_artifact");
  });

  it("uses the existing Epistemic Runtime for canonical state and contradictory evidence", () => {
    const propositionId = peWorldPropositionId(root, "pe_strategy", strategyId, "strategy.state");
    const snapshot = buildPrivateEquityWorldEpistemicSnapshot({
      tenantId,
      principalId: tenantId,
      root,
      world: {
        strategy: { id: strategyId, state: "active", updatedAt: at },
        opportunity: null,
        investmentCases: [],
        theses: [],
        assumptions: [],
        decisions: [],
      },
      assertions: [{
        propositionId,
        kind: "provider_observation",
        value: "draft",
        ref: "provider:strategy:old",
        observedAt: at,
      }],
      asOf: at,
    });
    expect(snapshot.state.propositions.find((item) => item.id === propositionId)).toMatchObject({
      status: "KNOWN",
      value: { kind: "DETERMINISTIC", value: "active" },
      sourceAuthority: "CANONICAL_OWNER",
    });
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ propositionId, status: "CONTRADICTED" }),
    ]));
  });

  it("retains retrieval time and rejects evidence from another world", () => {
    const propositionId = peWorldPropositionId(root, "pe_strategy", strategyId, "strategy.state");
    const rows = [{
      source_id: "33333333-3333-4333-8333-333333333333",
      version_id: "44444444-4444-4444-8444-444444444444",
      source_type: "pe_provider_observation",
      as_of: new Date("2026-09-01T00:00:00.000Z"),
      retrieved_at: new Date("2026-09-02T00:00:00.000Z"),
      snapshot: {
        worldRoot: root,
        claims: [{ propositionId, predicate: "strategy.state", value: "active" }],
      },
    }];
    expect(privateEquityAssertionsFromRows(rows, 10, root)).toEqual([
      expect.objectContaining({ propositionId, observedAt: "2026-09-01T00:00:00.000Z", ingestedAt: "2026-09-02T00:00:00.000Z" }),
    ]);
    expect(privateEquityAssertionsFromRows(rows, 10, {
      entityType: "pe_strategy",
      entityId: "55555555-5555-4555-8555-555555555555",
    })).toEqual([]);
  });

  it("routes only explicit valid world roots and fails malformed time closed", () => {
    expect(interpretOperationalQuery(`Show Strategy world state ${strategyId}?`)).toMatchObject({
      route: "fast_read",
      request: { intent: "pe_world_state", root },
    });
    expect(validateOperationalQueryRequest({ intent: "pe_world_state", root, at })).toMatchObject({ success: true });
    expect(validateOperationalQueryRequest({ intent: "pe_world_state", root: { ...root, entityType: "pe_thesis" } })).toMatchObject({ success: false });
    expect(validateOperationalQueryRequest({ intent: "pe_world_state", root, at: "not-a-time" })).toMatchObject({ success: false });
  });
});
