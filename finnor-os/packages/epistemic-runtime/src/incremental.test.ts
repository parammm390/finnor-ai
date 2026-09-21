import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { EpistemicState, EvidenceRecord, PropositionDefinition } from "./contracts";
import { appendEvidenceAndRecompute, appendEvidenceIncrementally, propositionSemanticFingerprint } from "./belief-update";
import { canonicalJson } from "./source-precedence";
import { createEpistemicState } from "./state";
import { TEST_NOW, TEST_TENANT, testDefinition, testEvidence } from "./test-support";

const scope = { tenantId: TEST_TENANT, principalId: "employee:test", decisionId: "decision:test" };

function semantic(state: EpistemicState): string {
  return canonicalJson({
    propositions: state.propositions.map((row) => propositionSemanticFingerprint(row)).sort(),
    conflicts: state.conflicts,
    canonicalTruth: state.canonicalTruth,
    unknowns: [...state.unknowns].sort((a, b) => a.propositionId.localeCompare(b.propositionId)),
    provenance: [...state.provenance].sort((a, b) => a.propositionId.localeCompare(b.propositionId)),
    freshness: state.freshness.map((row) => ({ propositionId: row.propositionId, status: row.status })).sort((a, b) => a.propositionId.localeCompare(b.propositionId)),
  });
}

function stateFor(definitions: PropositionDefinition[]): EpistemicState {
  return createEpistemicState({ scope, asOf: TEST_NOW, propositions: definitions });
}

describe("Scope-5 incremental belief equivalence", () => {
  it("matches the full oracle for randomized evidence delivery and contradictions", () => {
    fc.assert(fc.property(fc.array(fc.record({
      proposition: fc.constantFrom("root", "child", "other"),
      kind: fc.constantFrom("CANONICAL_DB" as const, "MEMORY" as const, "PROVIDER_OBSERVATION" as const),
      value: fc.integer({ min: -4, max: 4 }),
      offsetMs: fc.integer({ min: 0, max: 3_000 }),
      maxAgeMs: fc.option(fc.constantFrom(1_000, 2_000), { nil: undefined }),
    }), { minLength: 0, maxLength: 20 }), (items) => {
      const definitions = [testDefinition("root"), { ...testDefinition("child"), dependencyRefs: ["root"] }, testDefinition("other")];
      let full = stateFor(definitions);
      let incremental = stateFor(definitions);
      const asOf = "2026-08-31T00:00:05.000Z";
      for (const [index, item] of items.entries()) {
        const record = testEvidence({
          state: full, id: `random:${index}`, propositionId: item.proposition,
          kind: item.kind, value: item.value,
          observedAt: new Date(Date.parse(TEST_NOW) + item.offsetMs).toISOString(),
          ...(item.maxAgeMs === undefined ? {} : { maxAgeMs: item.maxAgeMs }),
        });
        full = appendEvidenceAndRecompute(full, [record], asOf);
        incremental = appendEvidenceIncrementally(incremental, [record], asOf).state;
        expect(semantic(incremental)).toBe(semantic(full));
      }
    }), { seed: 5092026, numRuns: 80 });
  });

  it("recomputes a direct dependent but not unrelated propositions", () => {
    const child = { ...testDefinition("decision.ready"), dependencyRefs: ["legal.permission"] };
    const initial = stateFor([child, testDefinition("legal.permission"), testDefinition("other.value")]);
    const incoming = [testEvidence({ state: initial, id: "canonical:permission", propositionId: "legal.permission", value: true, kind: "CANONICAL_DB" })];
    const incremental = appendEvidenceIncrementally(initial, incoming, TEST_NOW);
    const full = appendEvidenceAndRecompute(initial, incoming, TEST_NOW);
    expect(semantic(incremental.state)).toBe(semantic(full));
    expect(incremental.evaluatedPropositionIds).toEqual(["decision.ready", "legal.permission"]);
    expect(incremental.evaluatedPropositionIds).not.toContain("other.value");
  });

  it("does not propagate a lower-authority supporting duplicate", () => {
    const initial = stateFor([testDefinition("company.value"), { ...testDefinition("decision.ready"), dependencyRefs: ["company.value"] }]);
    const canonical = testEvidence({ state: initial, id: "canonical:1", propositionId: "company.value", value: 42, kind: "CANONICAL_DB" });
    const established = appendEvidenceIncrementally(initial, [canonical], TEST_NOW).state;
    const lower = testEvidence({ state: established, id: "memory:same", propositionId: "company.value", value: 42, kind: "MEMORY" });
    const incremental = appendEvidenceIncrementally(established, [lower], TEST_NOW);
    const full = appendEvidenceAndRecompute(established, [lower], TEST_NOW);
    expect(semantic(incremental.state)).toBe(semantic(full));
    expect(incremental.changedPropositionIds).toEqual([]);
    expect(incremental.evaluatedPropositionIds).toEqual(["company.value"]);
    expect(appendEvidenceIncrementally(incremental.state, [lower], TEST_NOW).evaluatedPropositionIds).toEqual([]);
  });

  it("propagates a freshness transition through a deep dependency chain", () => {
    const definitions = [
      testDefinition("root"),
      { ...testDefinition("child"), dependencyRefs: ["root"] },
      { ...testDefinition("grandchild"), dependencyRefs: ["child"] },
      testDefinition("unrelated"),
    ];
    const initial = stateFor(definitions);
    const records = definitions.map((definition) => testEvidence({
      state: initial, id: `e:${definition.id}`, propositionId: definition.id, value: true,
      kind: "CANONICAL_DB", ...(definition.id === "root" ? { maxAgeMs: 1_000 } : {}),
    }));
    const established = appendEvidenceIncrementally(initial, records, TEST_NOW).state;
    const later = "2026-08-31T00:00:01.001Z";
    const incremental = appendEvidenceIncrementally(established, [], later);
    const full = appendEvidenceAndRecompute(established, [], later);
    expect(semantic(incremental.state)).toBe(semantic(full));
    expect(incremental.evaluatedPropositionIds).toEqual(["child", "grandchild", "root"]);
  });

  it("fences a retroactive correction by knowledge time", () => {
    const initial = stateFor([testDefinition("metric.revenue")]);
    const original = testEvidence({ state: initial, id: "canonical:old", value: 10, kind: "CANONICAL_DB", observedAt: "2026-08-01T00:00:00.000Z", ingestedAt: "2026-08-01T00:00:00.000Z" });
    const correction: EvidenceRecord = {
      ...testEvidence({ state: initial, id: "canonical:correction", value: 12, kind: "CANONICAL_DB", observedAt: "2026-09-02T00:00:00.000Z", ingestedAt: "2026-09-02T00:00:00.000Z" }),
      validAt: "2026-08-01T00:00:00.000Z",
      supersedesEvidenceRefs: [original.id],
    };
    const history = [original, correction];
    const before = appendEvidenceIncrementally(initial, history, "2026-08-31T00:00:00.000Z", {
      validAt: "2026-08-15T00:00:00.000Z", knownAt: "2026-08-31T00:00:00.000Z",
    });
    expect(before.state.propositions[0]?.value).toEqual({ kind: "DETERMINISTIC", value: 10 });
    expect(semantic(before.state)).toBe(semantic(appendEvidenceAndRecompute(initial, history, "2026-08-31T00:00:00.000Z", {
      validAt: "2026-08-15T00:00:00.000Z", knownAt: "2026-08-31T00:00:00.000Z",
    })));
    const after = appendEvidenceIncrementally(before.state, [], "2026-09-03T00:00:00.000Z", {
      validAt: "2026-08-15T00:00:00.000Z", knownAt: "2026-09-03T00:00:00.000Z",
    });
    expect(after.state.propositions[0]?.value).toEqual({ kind: "DETERMINISTIC", value: 12 });
    expect(semantic(after.state)).toBe(semantic(appendEvidenceAndRecompute(before.state, [], "2026-09-03T00:00:00.000Z", {
      validAt: "2026-08-15T00:00:00.000Z", knownAt: "2026-09-03T00:00:00.000Z",
    })));
  });

  it("rejects unknown edges and cycles", () => {
    expect(() => stateFor([{ ...testDefinition("a"), dependencyRefs: ["missing"] }])).toThrow(/unknown proposition/);
    expect(() => stateFor([
      { ...testDefinition("a"), dependencyRefs: ["b"] },
      { ...testDefinition("b"), dependencyRefs: ["a"] },
    ])).toThrow(/dependency cycle/);
  });
});
