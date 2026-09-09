import { describe, expect, it } from "vitest";
import { PE_TRANSITIONS, isMilestoneLate, isRequestOverdue, transitionAllowed } from "@finnor/private-equity";

describe("Private Equity lifecycle state machines", () => {
  it("contains the exact bounded transition matrices", () => {
    expect(PE_TRANSITIONS).toEqual({
      strategy: { draft: ["active"], active: ["retired"], retired: [] },
      opportunity: {
        identified: ["screening", "rejected"], screening: ["qualified", "rejected"],
        qualified: ["promoted", "rejected"], promoted: [], rejected: [],
      },
      investment_case: {
        draft: ["active", "archived"], active: ["superseded", "archived"],
        superseded: ["archived"], archived: [],
      },
      thesis: { draft: ["active", "retired"], active: ["superseded", "retired"], superseded: ["retired"], retired: [] },
      assumption: { active: ["superseded", "invalidated"], superseded: [], invalidated: [] },
      decision: { draft: ["final"], final: ["superseded"], superseded: [] },
      deal: { active: ["closed", "terminated"], closed: [], terminated: [] },
      deal_party: { active: ["removed"], removed: [] },
      workstream: { not_started: ["active", "cancelled"], active: ["complete", "cancelled"], complete: [], cancelled: [] },
      request: { open: ["acknowledged", "fulfilled", "cancelled"], acknowledged: ["fulfilled", "cancelled"], fulfilled: [], cancelled: [] },
      deliverable: {
        expected: ["received", "superseded", "cancelled"],
        received: ["accepted", "rejected", "superseded", "cancelled"],
        rejected: ["received", "superseded", "cancelled"],
        accepted: ["superseded"], superseded: [], cancelled: [],
      },
      finding: { open: ["resolved", "accepted", "superseded"], resolved: ["superseded"], accepted: ["superseded"], superseded: [] },
      deal_risk: { open: ["mitigating", "resolved", "accepted"], mitigating: ["resolved", "accepted"], resolved: [], accepted: [] },
      milestone: { pending: ["achieved", "cancelled"], achieved: [], cancelled: [] },
      closing_condition: { open: ["evidence_pending", "satisfied", "waived", "failed"], evidence_pending: ["satisfied", "waived", "failed"], satisfied: [], waived: [], failed: [] },
      closing_item: { open: ["ready", "cancelled"], ready: ["verified", "cancelled"], verified: [], cancelled: [] },
    });
  });

  it("rejects every unlisted state transition", () => {
    for (const [lifecycle, matrix] of Object.entries(PE_TRANSITIONS)) {
      const states = Object.keys(matrix);
      for (const from of states) {
        for (const to of states) {
          expect(transitionAllowed(lifecycle as keyof typeof PE_TRANSITIONS, from, to)).toBe(
            (matrix[from] ?? []).includes(to),
          );
        }
      }
    }
  });

  it("derives overdue and late from time without mutable states", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    expect(isRequestOverdue({ state: "open", dueAt: "2026-09-04T12:00:00Z" }, now)).toBe(true);
    expect(isRequestOverdue({ state: "acknowledged", dueAt: "2026-09-04T12:00:00Z" }, now)).toBe(true);
    expect(isRequestOverdue({ state: "fulfilled", dueAt: "2026-09-04T12:00:00Z" }, now)).toBe(false);
    expect(isRequestOverdue({ state: "open", dueAt: "2026-09-06T12:00:00Z" }, now)).toBe(false);
    expect(isMilestoneLate({ state: "pending", targetAt: "2026-09-04T12:00:00Z" }, now)).toBe(true);
    expect(isMilestoneLate({ state: "achieved", targetAt: "2026-09-04T12:00:00Z" }, now)).toBe(false);
  });
});
