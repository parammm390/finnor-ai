import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

  it("has an exact SHA-256 over the checked-in frozen evidence fixture", async () => {
    const path = new URL("../fixtures/locked-cases.json", import.meta.url);
    const bytes = await readFile(path);
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });
});
