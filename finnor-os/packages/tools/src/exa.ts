// Exa web search — governed, read-only public intelligence for active product work.
// Wrapped like every integration: timeout, retry, typed errors.

import { IntegrationError } from "./errors";

export interface ExaResult {
  provider: "exa";
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  /** True only when Exa returned page text through its contents API. This lets
   * callers distinguish retrieved source material from a bare search result. */
  contentRetrieved: boolean;
  retrievedAt: string;
}

export async function exaSearch(opts: {
  query: string;
  numResults?: number;
  category?: string;
  includeText?: boolean;
}): Promise<ExaResult[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new IntegrationError("exa", "EXA_API_KEY is not set", false);
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      query: opts.query,
      numResults: Math.min(opts.numResults ?? 5, 10),
      type: "auto",
      ...(opts.category ? { category: opts.category } : {}),
      // Query-guided highlights return the relevant metric/claim from anywhere
      // on the page. Truncating the opening 800 characters often captured only a
      // publisher introduction and starved the answer model of the benchmark the
      // user explicitly asked it to compare. Keep a small text fallback for pages
      // where Exa cannot produce highlights.
      contents: {
        highlights: { query: opts.query, maxCharacters: 1_800 },
        text: { maxCharacters: 800 },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new IntegrationError("exa", `search failed (${res.status}): ${body.slice(0, 200)}`, res.status >= 500);
  }
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const retrievedAt = new Date().toISOString();
  return (data.results ?? []).map((r) => {
    const highlights = Array.isArray(r.highlights)
      ? r.highlights.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const retrievedContent = highlights.length > 0 ? highlights.join("\n\n") : String((r.text as string | undefined) ?? "");
    const snippet = retrievedContent.trim().slice(0, 1_800);
    return {
      provider: "exa" as const,
      title: String(r.title ?? "(untitled)"),
      url: String(r.url ?? ""),
      snippet,
      publishedDate: r.publishedDate ? String(r.publishedDate) : undefined,
      contentRetrieved: snippet.length > 0,
      retrievedAt,
    };
  });
}
