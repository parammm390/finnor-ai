// Learning digest — pure aggregation logic (no DB): outcome stats and the
// deterministic concern shortlist derived from them. DB-touching computeLearningDigest
// and the scanFindings-writing job are covered by tests/integration/learning-digest.test.ts.

import { describe, it, expect } from "vitest";
import { summarizeActionOutcomes, buildTopConcerns, computeUnclearConfirmations, type ActionTypeStats, type CriticFinding } from "@finnor/orchestration";

describe("summarizeActionOutcomes", () => {
  it("buckets rows by actionType and status", () => {
    const rows = [
      { actionType: "record_finding", status: "completed" },
      { actionType: "record_finding", status: "completed" },
      { actionType: "record_finding", status: "failed" },
      { actionType: "record_finding", status: "rejected" },
      { actionType: "record_finding", status: "pending" },
      { actionType: "raise_deal_risk", status: "completed" },
    ];
    const stats = summarizeActionOutcomes(rows);
    const finding = stats.find((s) => s.actionType === "record_finding")!;
    expect(finding.total).toBe(5);
    expect(finding.completed).toBe(2);
    expect(finding.failed).toBe(1);
    expect(finding.rejected).toBe(1);
    expect(finding.pending).toBe(1);
    expect(finding.decided).toBe(4); // total minus draft minus pending
  });

  it("computes failureRate against total and rejectionRate against decided, not total", () => {
    // 10 drafted, 5 still pending (undecided), 3 approved+completed, 2 rejected.
    const rows = [
      ...Array(3).fill({ actionType: "x", status: "completed" }),
      ...Array(2).fill({ actionType: "x", status: "rejected" }),
      ...Array(5).fill({ actionType: "x", status: "pending" }),
    ];
    const [x] = summarizeActionOutcomes(rows);
    expect(x!.total).toBe(10);
    expect(x!.decided).toBe(5); // 10 - 5 pending
    expect(x!.rejectionRate).toBeCloseTo(2 / 5); // NOT 2/10 — pending rows haven't been judged yet
    expect(x!.failureRate).toBe(0);
  });

  it("returns an empty array for no rows", () => {
    expect(summarizeActionOutcomes([])).toEqual([]);
  });

  it("sorts by total volume descending", () => {
    const rows = [
      { actionType: "rare", status: "completed" },
      { actionType: "common", status: "completed" },
      { actionType: "common", status: "completed" },
      { actionType: "common", status: "failed" },
    ];
    const stats = summarizeActionOutcomes(rows);
    expect(stats[0]!.actionType).toBe("common");
  });

  it("ignores transient statuses (approved/executing) safely — never crashes, never miscounts a terminal bucket", () => {
    const rows = [
      { actionType: "x", status: "approved" },
      { actionType: "x", status: "executing" },
      { actionType: "x", status: "completed" },
    ];
    const [x] = summarizeActionOutcomes(rows);
    expect(x!.total).toBe(3);
    expect(x!.completed).toBe(1);
  });
});

describe("buildTopConcerns", () => {
  const noCriticFindings: CriticFinding[] = [];

  it("stays silent below the minimum sample size, even at 100% failure", () => {
    const stats: ActionTypeStats[] = [
      { actionType: "rare_action", total: 2, draft: 0, pending: 0, completed: 0, failed: 2, rejected: 0, needsHumanReview: 0, blockedIntegration: 0, decided: 2, failureRate: 1, rejectionRate: 0 },
    ];
    expect(buildTopConcerns(stats, noCriticFindings, 90)).toEqual([]);
  });

  it("flags an action_type crossing the failure threshold with a real sample", () => {
    const stats: ActionTypeStats[] = [
      { actionType: "record_finding", total: 10, draft: 0, pending: 0, completed: 5, failed: 5, rejected: 0, needsHumanReview: 0, blockedIntegration: 0, decided: 10, failureRate: 0.5, rejectionRate: 0 },
    ];
    const concerns = buildTopConcerns(stats, noCriticFindings, 90);
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toContain("record_finding");
    expect(concerns[0]).toContain("50%");
  });

  it("flags an action_type crossing the rejection threshold with a real decided sample", () => {
    const stats: ActionTypeStats[] = [
      { actionType: "raise_deal_risk", total: 12, draft: 0, pending: 2, completed: 3, failed: 0, rejected: 7, needsHumanReview: 0, blockedIntegration: 0, decided: 10, failureRate: 0, rejectionRate: 0.7 },
    ];
    const concerns = buildTopConcerns(stats, noCriticFindings, 90);
    expect(concerns.some((c) => c.includes("raise_deal_risk") && c.includes("70%"))).toBe(true);
  });

  it("appends a critic summary line when there are flagged findings", () => {
    const findings: CriticFinding[] = [{ actionId: "a1", actionType: "record_finding", reason: "Evidence mismatch", createdAt: new Date().toISOString() }];
    const concerns = buildTopConcerns([], findings, 30);
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toContain("1 action");
  });

  it("returns an empty list when nothing crosses any threshold", () => {
    const stats: ActionTypeStats[] = [
      { actionType: "record_finding", total: 20, draft: 0, pending: 0, completed: 19, failed: 1, rejected: 0, needsHumanReview: 0, blockedIntegration: 0, decided: 20, failureRate: 0.05, rejectionRate: 0 },
    ];
    expect(buildTopConcerns(stats, noCriticFindings, 90)).toEqual([]);
  });
});

describe("computeUnclearConfirmations (Phase 14 retrieval, pure)", () => {
  const turn = (transcriptText: string, minutesAgo: number) => ({ transcriptText, createdAt: new Date(Date.now() - minutesAgo * 60_000) });

  it("surfaces only turns parseSpokenDecision itself calls unclear", () => {
    const turns = [turn("yes go ahead", 10), turn("hmm let me think", 5), turn("no cancel it", 2)];
    const result = computeUnclearConfirmations(turns, {});
    expect(result).toHaveLength(1);
    expect(result[0]!.transcript).toContain("let me think");
  });

  it("newest first", () => {
    const turns = [turn("hmm what", 30), turn("uh, maybe?", 5), turn("beats me", 15)];
    const result = computeUnclearConfirmations(turns, {});
    expect(result.map((r) => r.transcript)).toEqual(["uh, maybe?", "beats me", "hmm what"]);
  });

  it("caps at the given limit", () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(`unclear mumble number ${i}`, i));
    expect(computeUnclearConfirmations(turns, {}, 20)).toHaveLength(20);
  });

  it("a phrase already added to the tenant's own policy stops showing up — self-cleaning", () => {
    const turns = [turn("totally go for it", 5)];
    expect(computeUnclearConfirmations(turns, {})).toHaveLength(1);
    expect(computeUnclearConfirmations(turns, { approve: ["go for it"] })).toHaveLength(0);
  });

  it("redacts PII in the surfaced transcript", () => {
    const turns = [turn("uh, call me back at 555-123-4567 maybe", 1)];
    const result = computeUnclearConfirmations(turns, {});
    expect(result[0]!.transcript).not.toContain("555-123-4567");
  });

  it("empty input yields an empty list", () => {
    expect(computeUnclearConfirmations([], {})).toEqual([]);
  });
});
