// §5.2: chunking spec — 200-500 token semantic-unit chunks, never mid-sentence.

import { describe, it, expect } from "vitest";
import { chunkText, chunkSource } from "@finnor/memory";

function words(n: number, prefix = "word"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("a short text stays as one chunk", () => {
    const text = "Net leverage is 4.2x. The deal team needs lender evidence.";
    expect(chunkText(text)).toEqual([text]);
  });

  it("packs multiple short paragraphs into one chunk under the max", () => {
    const text = "Paragraph one is short.\n\nParagraph two is also short.\n\nParagraph three too.";
    const chunks = chunkText(text, { maxTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Paragraph one");
    expect(chunks[0]).toContain("Paragraph three");
  });

  it("splits into multiple chunks once the max token budget is exceeded", () => {
    // ~4 chars/token estimate: 600 "word" tokens per paragraph ≈ 2400+ chars, well over maxTokens=100.
    const text = `${words(60)}.\n\n${words(60)}.\n\n${words(60)}.`;
    const chunks = chunkText(text, { minTokens: 20, maxTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100 * 4 * 1.6); // allow the merge slack, never wildly over
    }
  });

  it("never splits mid-sentence when a single paragraph exceeds the max", () => {
    const longParagraph = `First sentence is here. Second sentence follows along. Third sentence closes it out. ${words(80)}.`;
    const chunks = chunkText(longParagraph, { minTokens: 10, maxTokens: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.trim().length).toBeGreaterThan(0);
      // every chunk ends on a sentence boundary or is the final trailing piece
      expect(/[.!?]\s*$/.test(c.trim()) || c === chunks[chunks.length - 1]).toBe(true);
    }
  });

  it("merges an undersized trailing chunk into its neighbor rather than shipping a near-empty chunk", () => {
    const text = `${words(60)}.\n\ntiny.`;
    const chunks = chunkText(text, { minTokens: 20, maxTokens: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("tiny");
  });
});

describe("chunkSource", () => {
  it("stamps every chunk with the source's entityRefs and occurredAt", () => {
    const occurredAt = new Date("2026-01-15T00:00:00Z");
    const result = chunkSource({ text: "A short document.", entityRefs: [{ type: "pe_deal", id: "deal-1" }], occurredAt });
    expect(result).toEqual([{ chunk: "A short document.", entityRefs: [{ type: "pe_deal", id: "deal-1" }], occurredAt }]);
  });

  it("defaults entityRefs to [] when not given", () => {
    const result = chunkSource({ text: "No refs here." });
    expect(result[0]!.entityRefs).toEqual([]);
  });
});

describe("ingestMemory — best effort", () => {
  it("skips empty text with zero chunks written and no error, with no DB access", async () => {
    const { ingestMemory } = await import("@finnor/memory");
    await expect(ingestMemory({ tenantId: "t1", sourceDocId: "doc1", text: "   " })).resolves.toBe(0);
  });
});
