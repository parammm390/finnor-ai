import { describe, expect, it } from "vitest";
import {
  advanceEpistemicClock,
  appendEvidenceAndRecompute,
  applyInformationObservation,
} from "./belief-update";
import {
  consequentialProvenanceSatisfied,
  propositionById,
  requirementResolved,
} from "./state";
import { TEST_NOW, testDefinition, testEvidence, testRequirement, testState } from "./test-support";

describe("deterministic belief updates", () => {
  it("supports the required status transitions without mutating evidence history", () => {
    const initial = testState();
    const uncertain = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "memory:low", value: "unpaid", confidence: "LOW" }),
    ], TEST_NOW);
    expect(propositionById(uncertain, "invoice.balance")?.status).toBe("UNCERTAIN");

    const known = appendEvidenceAndRecompute(uncertain, [
      testEvidence({ state: initial, id: "memory:fresh", value: "paid", observedAt: "2026-08-31T00:01:00.000Z" }),
    ], "2026-08-31T00:01:00.000Z");
    expect(propositionById(known, "invoice.balance")?.status).toBe("KNOWN");
    expect(known.evidence.map((record) => record.id)).toEqual(["memory:fresh", "memory:low"]);

    const stale = advanceEpistemicClock(appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "memory:expiring", value: "paid", maxAgeMs: 1_000 }),
    ], TEST_NOW), "2026-08-31T00:00:02.000Z");
    expect(propositionById(stale, "invoice.balance")?.status).toBe("STALE");
    expect(stale.transitions.at(-1)).toMatchObject({ from: "KNOWN", to: "STALE" });
    const refreshed = appendEvidenceAndRecompute(stale, [
      testEvidence({ state: initial, id: "memory:refreshed", value: "paid", observedAt: "2026-08-31T00:00:03.000Z", maxAgeMs: 1_000 }),
    ], "2026-08-31T00:00:03.000Z");
    expect(propositionById(refreshed, "invoice.balance")?.status).toBe("KNOWN");
    expect(refreshed.transitions.at(-1)).toMatchObject({ from: "STALE", to: "KNOWN" });

    const conflictBase = testState();
    const conflicting = appendEvidenceAndRecompute(conflictBase, [
      testEvidence({ state: conflictBase, id: "work:a", value: "paid", kind: "ACTIVE_WORK" }),
      testEvidence({ state: conflictBase, id: "work:b", value: "unpaid", kind: "ACTIVE_WORK" }),
    ], TEST_NOW);
    expect(propositionById(conflicting, "invoice.balance")?.status).toBe("CONFLICTING");

    const resolved = appendEvidenceAndRecompute(conflicting, [
      testEvidence({
        state: conflictBase,
        id: "work:resolution",
        value: "paid",
        kind: "ACTIVE_WORK",
        observedAt: "2026-08-31T00:02:00.000Z",
        supersedesEvidenceRefs: ["work:a", "work:b"],
      }),
    ], "2026-08-31T00:02:00.000Z");
    expect(propositionById(resolved, "invoice.balance")?.status).toBe("KNOWN");
    expect(resolved.conflicts.some((item) => item.resolution === "EXPLICIT_SUPERSESSION")).toBe(true);
    expect(resolved.evidence).toHaveLength(3);

    const knownBase = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "work:known", value: "paid", kind: "ACTIVE_WORK" }),
    ], TEST_NOW);
    const knownToConflict = appendEvidenceAndRecompute(knownBase, [
      testEvidence({ state: initial, id: "work:contradiction", value: "unpaid", kind: "ACTIVE_WORK" }),
    ], TEST_NOW);
    expect(propositionById(knownToConflict, "invoice.balance")?.status).toBe("CONFLICTING");
    expect(knownToConflict.transitions.at(-1)).toMatchObject({ from: "KNOWN", to: "CONFLICTING" });
  });

  it("always selects canonical truth over contradictory lower-authority evidence", () => {
    const initial = testState();
    const next = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "memory:newer", value: "unpaid", observedAt: "2026-08-31T00:10:00.000Z" }),
      testEvidence({ state: initial, id: "canonical:balance", value: "paid", kind: "CANONICAL_DB", observedAt: "2026-08-30T00:00:00.000Z" }),
    ], "2026-08-31T00:10:00.000Z");
    const proposition = propositionById(next, "invoice.balance");
    expect(proposition?.value).toEqual({ kind: "DETERMINISTIC", value: "paid" });
    expect(proposition?.evidenceRefs).toEqual(["canonical:balance"]);
    expect(proposition?.contradictingEvidenceRefs).toContain("memory:newer");
    expect(next.conflicts).toContainEqual(expect.objectContaining({ resolution: "HIGHER_AUTHORITY_WINS" }));
    expect(next.canonicalTruth).toHaveLength(1);
  });

  it("requires complete answer evidence provenance for a consequential precondition", () => {
    const initial = testState();
    const contextOnly = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "context:memory", value: true, role: "context_only" }),
    ], TEST_NOW);
    expect(propositionById(contextOnly, "invoice.balance")?.status).toBe("KNOWN");
    expect(consequentialProvenanceSatisfied(contextOnly, "invoice.balance")).toBe(false);
    expect(requirementResolved(contextOnly, testRequirement())).toBe(false);
  });

  it("rejects cross-tenant observations, invalid derived evidence, and immutable id collisions", () => {
    const initial = testState();
    expect(() => applyInformationObservation(initial, {
      actionId: "info:test",
      adapterId: "CANONICAL_OPERATIONAL_QUERY",
      tenantId: "22222222-2222-4222-8222-222222222222",
      observedAt: TEST_NOW,
      evidence: [],
      propositionIds: ["invoice.balance"],
      outcome: "NO_RESULT",
    })).toThrow(/Cross-tenant/);

    expect(() => appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "derived:no-parent", value: true, kind: "DERIVED" }),
    ], TEST_NOW)).toThrow(/DERIVED_EVIDENCE_REQUIRES_PARENTS/);
    expect(() => appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "derived:missing-parent", value: true, kind: "DERIVED", parentEvidenceRefs: ["missing:evidence"] }),
    ], TEST_NOW)).toThrow(/DERIVED_PARENT_EVIDENCE_NOT_FOUND/);

    const once = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "memory:immutable", value: "a" }),
    ], TEST_NOW);
    expect(() => appendEvidenceAndRecompute(once, [
      testEvidence({ state: initial, id: "memory:immutable", value: "b" }),
    ], TEST_NOW)).toThrow(/Immutable evidence id collision/);
  });

  it("supports external UNKNOWN to KNOWN through a governed observation", () => {
    const initial = testState([testDefinition("provider.delivery", { kind: "external", type: "delivery", id: "delivery-1" })]);
    const next = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "provider:delivery", propositionId: "provider.delivery", value: "delivered", kind: "PROVIDER_OBSERVATION" }),
    ], TEST_NOW);
    expect(propositionById(next, "provider.delivery")?.status).toBe("KNOWN");
    expect(next.transitions.at(-1)).toMatchObject({ from: "UNKNOWN", to: "KNOWN" });
  });

  it("materializes proposition dependencies and keeps a dependent belief uncertain until its prerequisite is known", () => {
    const dependent = testDefinition("decision.ready", { kind: "system", type: "decision" });
    dependent.dependencyRefs = ["legal.permission"];
    const initial = testState([
      dependent,
      testDefinition("legal.permission", { kind: "system", type: "permission" }),
    ]);
    expect(initial.dependencies).toEqual([
      expect.objectContaining({ propositionId: "decision.ready", dependsOnPropositionId: "legal.permission", kind: "DERIVED_FROM" }),
    ]);
    const onlyDecision = appendEvidenceAndRecompute(initial, [
      testEvidence({ state: initial, id: "work:decision", propositionId: "decision.ready", value: true, kind: "ACTIVE_WORK" }),
    ], TEST_NOW);
    expect(propositionById(onlyDecision, "decision.ready")?.status).toBe("UNCERTAIN");
    const complete = appendEvidenceAndRecompute(onlyDecision, [
      testEvidence({ state: initial, id: "canonical:permission", propositionId: "legal.permission", value: true, kind: "CANONICAL_DB" }),
    ], TEST_NOW);
    expect(propositionById(complete, "decision.ready")?.status).toBe("KNOWN");
  });
});
