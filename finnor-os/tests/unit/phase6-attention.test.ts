import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildAttentionRankVector,
  compareAttentionItems,
  executeAttentionQueueQuery,
} from "@finnor/read-models";
import { validateOperationalQueryRequest } from "@finnor/orchestration";
import type { AttentionItem, AttentionKind } from "@finnor/shared-types";
import { attentionItemsInServerOrder } from "../../apps/console/lib/work-planning";

const AS_OF = new Date("2026-09-10T08:00:00.000Z");

function item(input: {
  id: string;
  kind: AttentionKind;
  deadline?: string | null;
  downstream?: number;
  criteria?: number;
  authority?: boolean;
  createdAt?: string;
}): AttentionItem {
  const draft = {
    id: input.id,
    workId: "00000000-0000-4000-8000-000000000001",
    rootRefs: [],
    kind: input.kind,
    reason: "source-backed test boundary",
    assignedOrEligibleActor: {
      employeeId: "00000000-0000-4000-8000-000000000002",
      basis: "work_assignment" as const,
      capability: null,
    },
    deadline: input.deadline ?? null,
    blocks: [],
    unblocks: [],
    authorityBoundary: input.authority ? {
      operation: "approval" as const,
      capability: "approve:test",
      resource: { type: "work", id: "00000000-0000-4000-8000-000000000001" },
      authorityRevision: 1,
      selectionGrantsAuthority: false as const,
    } : null,
    recoveryBoundary: null,
    impact: {
      blocksWorkCompletion: Boolean(input.criteria),
      downstreamPlanNodes: input.downstream ?? 0,
      completionCriteria: input.criteria ?? 0,
      sourceBackedMateriality: null,
    },
    evidenceRefs: [],
    nextHumanBoundary: {
      kind: "accept_assignment" as const,
      description: "Open the Work.",
      capability: null,
      executable: false as const,
    },
    rankReason: { primary: "test", factors: [] },
    createdAt: input.createdAt ?? "2026-09-09T08:00:00.000Z",
  };
  const rankVector = buildAttentionRankVector(draft, AS_OF);
  return { ...draft, slackMs: rankVector.slackMs, rankVector };
}

describe("Phase 6 deterministic causal attention", () => {
  it("ranks recovery ahead of ordinary assigned Work", () => {
    const recovery = item({ id: "recovery", kind: "work_recovery" });
    const assigned = item({ id: "assigned", kind: "work_assigned" });
    expect([assigned, recovery].sort(compareAttentionItems).map((entry) => entry.id)).toEqual(["recovery", "assigned"]);
  });

  it("surfaces an overdue explicit deadline before an undated authority boundary", () => {
    const overdue = item({ id: "overdue", kind: "deadline_overdue", deadline: "2026-09-10T07:59:59.000Z" });
    const approval = item({ id: "approval", kind: "approval_required", authority: true });
    expect([approval, overdue].sort(compareAttentionItems).map((entry) => entry.id)).toEqual(["overdue", "approval"]);
    expect(overdue.slackMs).toBe(-1_000);
  });

  it("ranks an approval that unblocks more completion criteria and nodes first", () => {
    const narrow = item({ id: "narrow", kind: "approval_required", authority: true, criteria: 1, downstream: 2 });
    const broad = item({ id: "broad", kind: "approval_required", authority: true, criteria: 2, downstream: 12 });
    expect([narrow, broad].sort(compareAttentionItems).map((entry) => entry.id)).toEqual(["broad", "narrow"]);
  });

  it("uses a stable id tie-break independent of database row order", () => {
    const entries = [
      item({ id: "item:c", kind: "work_assigned" }),
      item({ id: "item:a", kind: "work_assigned" }),
      item({ id: "item:b", kind: "work_assigned" }),
    ];
    const forward = [...entries].sort(compareAttentionItems).map((entry) => entry.id);
    const reverse = [...entries].reverse().sort(compareAttentionItems).map((entry) => entry.id);
    expect(forward).toEqual(["item:a", "item:b", "item:c"]);
    expect(reverse).toEqual(forward);
  });

  it("renders the canonical server order without client-side reranking", () => {
    const lowerServerRank = item({ id: "server-rank-1", kind: "work_assigned" });
    const locallyTempting = item({ id: "server-rank-2", kind: "work_recovery" });
    const serverResponse = [lowerServerRank, locallyTempting] as const;

    const rendered = attentionItemsInServerOrder(serverResponse);

    expect(rendered).toBe(serverResponse);
    expect(rendered.map((entry) => entry.id)).toEqual(["server-rank-1", "server-rank-2"]);
  });

  it("is deterministic for arbitrary input ordering", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 40 }),
      (ids) => {
        const entries = ids.map((id) => item({ id, kind: "work_assigned" }));
        const expected = [...entries].sort(compareAttentionItems).map((entry) => entry.id);
        const permuted = [...entries].sort((left, right) => right.id.localeCompare(left.id));
        expect(permuted.sort(compareAttentionItems).map((entry) => entry.id)).toEqual(expected);
      },
    ), { numRuns: 100 });
  });

  it("does not accept tenant or employee selectors from the client", () => {
    expect(validateOperationalQueryRequest({ intent: "attention_queue", employeeId: "00000000-0000-4000-8000-000000000002" })).toEqual({
      success: false,
      error: "Attention queue accepts only intent and page; employee identity comes from authentication",
    });
    expect(validateOperationalQueryRequest({ intent: "attention_queue", tenantId: "00000000-0000-4000-8000-000000000001" }).success).toBe(false);
  });

  it("reports missing authenticated employee context as unavailable, never queue-clear", async () => {
    const result = await executeAttentionQueueQuery(
      "00000000-0000-4000-8000-000000000001",
      { intent: "attention_queue" },
      {},
      AS_OF,
    );
    expect(result.status).toBe("unavailable");
    expect(result.sourceStatus.status).toBe("unavailable");
    expect(result.sourceStatus.unavailableSources).toContain("identity");
    expect(result.page.totalCountExact).toBe(false);
  });
});
