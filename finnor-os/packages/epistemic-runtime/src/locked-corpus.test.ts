import { describe, expect, it } from "vitest";
import { LOCKED_CORPUS, runLockedCorpus } from "../fixtures/locked-corpus";

describe("permanent P3 frozen corpus", () => {
  it("passes every uniquely named case with a fixed clock and seed", async () => {
    const results = await runLockedCorpus();
    expect(LOCKED_CORPUS.fixedClock).toBe("2026-08-31T00:00:00.000Z");
    expect(LOCKED_CORPUS.fixedSeed).toBe(31082026);
    expect(results).toHaveLength(24);
    expect(new Set(results.map((result) => result.id)).size).toBe(results.length);
    expect(results.filter((result) => !result.passed)).toEqual([]);
  });
});
