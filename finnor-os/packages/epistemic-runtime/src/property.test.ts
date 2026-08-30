import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { appendEvidenceAndRecompute } from "./belief-update";
import type { EvidenceKind } from "./contracts";
import { canonicalJson } from "./source-precedence";
import { propositionById } from "./state";
import { TEST_NOW, testEvidence, testState } from "./test-support";

const LOWER_KINDS: EvidenceKind[] = [
  "ACTIVE_WORK",
  "PROFILE",
  "SESSION",
  "MEMORY",
  "DOCUMENT",
  "PROVIDER_OBSERVATION",
  "COMPUTER_OBSERVATION",
  "WEB_RESEARCH",
];

describe("epistemic property gates", () => {
  it("canonical truth wins for every lower-source value and evidence order", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        kind: fc.constantFrom(...LOWER_KINDS),
        value: fc.oneof(fc.string(), fc.integer(), fc.boolean()),
      }), { minLength: 0, maxLength: 20 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer(),
      (lower, canonicalValue, salt) => {
        const initial = testState();
        const records = lower.map((item, index) => testEvidence({
          state: initial,
          id: `lower:${salt}:${index}`,
          value: item.value,
          kind: item.kind,
          observedAt: "2026-08-31T00:10:00.000Z",
        }));
        records.splice(Math.abs(salt) % (records.length + 1), 0, testEvidence({
          state: initial,
          id: `canonical:${salt}`,
          value: canonicalValue,
          kind: "CANONICAL_DB",
          observedAt: "2026-08-30T00:00:00.000Z",
        }));
        const state = appendEvidenceAndRecompute(initial, records, "2026-08-31T00:10:00.000Z");
        expect(propositionById(state, "invoice.balance")?.value).toEqual({ kind: "DETERMINISTIC", value: canonicalValue });
        expect(propositionById(state, "invoice.balance")?.source?.truthClass).toBe("CANONICAL");
      },
    ), { seed: 31082026, numRuns: 200 });
  });

  it("replay is deterministic under arbitrary input ordering", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.record({
        id: fc.uuid(),
        value: fc.integer(),
        kind: fc.constantFrom<EvidenceKind>("MEMORY", "DOCUMENT", "SESSION"),
        timeOffset: fc.integer({ min: 0, max: 10_000 }),
      }), { selector: (item) => item.id, minLength: 1, maxLength: 15 }),
      (items) => {
        const initial = testState();
        const records = items.map((item) => testEvidence({
          state: initial,
          id: item.id,
          value: item.value,
          kind: item.kind,
          observedAt: new Date(Date.parse(TEST_NOW) + item.timeOffset).toISOString(),
        }));
        const forward = appendEvidenceAndRecompute(initial, records, "2026-08-31T00:00:20.000Z");
        const reverse = appendEvidenceAndRecompute(initial, [...records].reverse(), "2026-08-31T00:00:20.000Z");
        expect(canonicalJson({
          propositions: forward.propositions,
          evidence: forward.evidence,
          conflicts: forward.conflicts,
          provenance: forward.provenance,
        })).toBe(canonicalJson({
          propositions: reverse.propositions,
          evidence: reverse.evidence,
          conflicts: reverse.conflicts,
          provenance: reverse.provenance,
        }));
      },
    ), { seed: 31082026, numRuns: 200 });
  });
});
