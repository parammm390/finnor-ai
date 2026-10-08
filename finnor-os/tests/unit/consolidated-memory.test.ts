// Zep consolidation layer — unconfigured state must be explicit and never attempt a
// real network call or throw into the gated pipeline it's layered onto, same contract
// every other adapter (quickbooks.ts, ads.ts, exa.ts) holds.

import { describe, it, expect, beforeEach } from "vitest";

describe("consolidated memory (Zep) — unconfigured state", () => {
  beforeEach(() => {
    delete process.env.ZEP_API_KEY;
  });

  it("queryConsolidatedFacts returns [] — never guessed, never a fabricated hit", async () => {
    const { queryConsolidatedFacts } = await import("@finnor/memory");
    const hits = await queryConsolidatedFacts("tenant-1", "what's the renewal price?");
    expect(hits).toEqual([]);
  });

});

describe("buildMemorySnapshot — Zep is additive, never a regression when unconfigured", () => {
  beforeEach(() => {
    delete process.env.ZEP_API_KEY;
  });

  it("semantic array is populated from pgvector alone when no semanticQuery is given, without erroring", async () => {
    const { buildMemorySnapshot } = await import("@finnor/memory");
    const snapshot = await buildMemorySnapshot({ tenantId: "00000000-0000-4000-8000-000000000001" });
    expect(snapshot.semantic).toEqual([]);
    expect(snapshot.shortTerm).toBeNull();
    expect(snapshot.longTerm).toBeNull();
  });
});
