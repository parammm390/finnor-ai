import { describe, expect, it } from "vitest";
import { OUTCOME_PACK_IDS } from "@finnor/shared-types";
import { bindOutcomePack, OUTCOME_PACK_DEFINITIONS, outcomePackFingerprint } from "@finnor/orchestration";

const DEAL_ID = "11111111-1111-4111-8111-111111111111";

describe("Private Equity outcome-pack contracts", () => {
  it("exposes only the four active Private Equity/Core packs", () => {
    expect(Object.keys(OUTCOME_PACK_DEFINITIONS).sort()).toEqual([...OUTCOME_PACK_IDS].sort());
    expect(OUTCOME_PACK_IDS).toEqual([
      "deal_to_verified_closing_readiness",
      "deal_request_resolution",
      "critical_deal_dependency_resolution",
      "general_operator_objective",
    ]);
    for (const pack of Object.values(OUTCOME_PACK_DEFINITIONS)) {
      expect(pack).toMatchObject({ contractVersion: 1, version: 1 });
      expect(pack.evidenceRequirements.length).toBeGreaterThan(0);
      expect(pack.verificationRules.length).toBeGreaterThan(0);
    }
  });

  it("binds each deal pack to exact deal-scoped canonical evidence", () => {
    const cases = [
      ["deal_to_verified_closing_readiness", "closing_readiness"],
      ["deal_request_resolution", "open_requests"],
      ["critical_deal_dependency_resolution", "critical_dependencies"],
    ] as const;
    for (const [packId, intent] of cases) {
      const bound = bindOutcomePack(packId, { dealId: DEAL_ID, mode: "approval" });
      expect(bound.subjectRefs).toEqual([{ entityType: "pe_deal", entityId: DEAL_ID }]);
      expect(bound.successCondition.criteria).toContainEqual(expect.objectContaining({
        kind: "canonical_query",
        request: { intent, dealId: DEAL_ID },
      }));
      expect(bound.certificationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rejects retired entity types at the general objective boundary", () => {
    expect(() => bindOutcomePack("general_operator_objective", {
      objective: "Resolve the exact item.",
      subjectRefs: [{ entityType: "household", entityId: DEAL_ID }],
      successCondition: {
        version: 1,
        statement: "The request is resolved.",
        mode: "all",
        source: "explicit",
        criteria: [{ kind: "canonical_query", request: { intent: "open_requests", dealId: DEAL_ID }, assertion: { path: ["rows", 0], operator: "not_exists" } }],
      },
    })).toThrow(/retired/i);
  });

  it("uses distinct, content-addressed pack fingerprints", () => {
    const fingerprints = OUTCOME_PACK_IDS.map(outcomePackFingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});
