import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { interpretOperationalQuery, validateOperationalQueryRequest } from "@finnor/orchestration";
import { buildAttentionRankVector } from "@finnor/read-models";

describe("P7 workforce operational surface", () => {
  it("routes and validates workforce_status without accepting caller tenant selectors", () => {
    expect(interpretOperationalQuery("Show AI worker status?")).toEqual({
      route: "fast_read",
      confidence: "high",
      request: { intent: "workforce_status" },
    });
    expect(validateOperationalQueryRequest({ intent: "workforce_status", page: { limit: 25 } })).toEqual({
      success: true,
      request: { intent: "workforce_status", page: { limit: 25 } },
    });
    expect(validateOperationalQueryRequest({ intent: "workforce_status", tenantId: "00000000-0000-4000-8000-000000000001" }).success).toBe(false);
    expect(validateOperationalQueryRequest({ intent: "workforce_status", page: { cursor: "cross-tenant" } }).success).toBe(false);
    expect(validateOperationalQueryRequest({ intent: "workforce_status", page: { cursor: "00000000-0000-4000-8000-000000000001" } })).toEqual({
      success: true,
      request: { intent: "workforce_status", page: { cursor: "00000000-0000-4000-8000-000000000001" } },
    });
  });

  it("keeps workforce exceptions inside the P6 deterministic attention rank", () => {
    const base = {
      deadline: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      impact: { blocksWorkCompletion: true, downstreamPlanNodes: 1, completionCriteria: 1, sourceBackedMateriality: null },
      authorityBoundary: null,
    } as const;
    const failure = buildAttentionRankVector({ ...base, id: "assignment:a", kind: "ai_assignment_failed" }, new Date("2026-01-02T00:00:00.000Z"));
    const ordinary = buildAttentionRankVector({ ...base, id: "assignment:b", kind: "work_assigned" }, new Date("2026-01-02T00:00:00.000Z"));
    const humanOnly = buildAttentionRankVector({ ...base, id: "boundary:c", kind: "human_only_boundary", authorityBoundary: {
      operation: "human_attestation",
      capability: "verify_closing_item",
      resource: { type: "plan_node", id: "c" },
      authorityRevision: 1,
      selectionGrantsAuthority: false,
    } }, new Date("2026-01-02T00:00:00.000Z"));
    expect(failure.safetyRecoveryRank).toBe(0);
    expect(ordinary.safetyRecoveryRank).toBe(1);
    expect(humanOnly.authorityBottleneckRank).toBe(0);
  });

  it("reads all five workforce reasons from the existing attention implementation", () => {
    const source = readFileSync(join(process.cwd(), "packages/read-models/src/attention-query.ts"), "utf8");
    for (const reason of ["ai_assignment_failed", "no_eligible_ai_worker", "worker_budget_exhausted", "learning_proposal_review", "human_only_boundary"]) {
      expect(source).toContain(reason);
    }
    expect(source).toContain("buildAttentionRankVector");
    expect(source).not.toContain("buildWorkforceAttentionRank");
  });
});
