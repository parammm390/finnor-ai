// Core web research plugin. Domain-neutral research stays reusable while vertical-
// specific monitoring and business wrappers are intentionally absent.

import type { DomainEnginePlugin } from "../shared/plugin-interface";
import type { DraftAction, ExecutionResult, ValidationResult, DomainPolicy } from "@finnor/shared-types";
import { resolveProviderForPurpose, type LLMChannel } from "@finnor/tools/llm";
import type { ToolRegistry } from "@finnor/tools/registry";
import type { FirecrawlScrapeResult, WebCitation } from "@finnor/tools/firecrawl";
import { z } from "zod";
import { createHash } from "node:crypto";

const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v: unknown) => v ?? undefined);
const MAX_DISCOVERY_VERIFICATIONS = 3;

type DiscoveryResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  provider?: "exa";
  contentRetrieved?: boolean;
  retrievedAt?: string;
};
type VerifiedDiscovery = { discovery: DiscoveryResult; firecrawl: FirecrawlScrapeResult };
const ResponseChannelSchema = z.enum(["voice", "text", "console", "background"]);

async function synthesizeVerifiedResearch(
  query: string,
  sources: Array<{ title: string; url: string; excerpt: string }>,
  channel: LLMChannel,
  tenantId: string,
  researchContext?: Record<string, unknown>,
): Promise<string> {
  const provider = resolveProviderForPurpose("answer", channel);
  const excerptLimit = channel === "voice" ? 520 : 1_500;
  const sourceProjection = sources.slice(0, 5).map((source) => ({
    ...source,
    excerpt: source.excerpt.slice(0, excerptLimit),
  }));
  const answer = await provider.complete({
    system: [
      "You are JARVIS answering a business research request from verified web-source excerpts.",
      "Use only the supplied sources. Separate what the sources establish from any inference, and never turn an unverified search snippet into fact.",
      "Lead with the direct answer, then the most decision-useful findings. Mention source titles naturally; the product renders their links separately.",
      "When the user asks for a comparison, state the requested values with their source and explain whether they are actually comparable (industry, date, network, and methodology).",
      "For competitor research, name actual companies supported by the supplied excerpts. Generic market or industry statistics are not competitor candidates and must never substitute for missing company evidence.",
      "Never infer a private company's revenue/ARR, founder age, or performance. If a requested company-level constraint is not established by a source, label it unavailable and do not claim that candidate satisfies it.",
      "Treat researchContext as authenticated PROFILE context for resolving the user's company and requested comparison only. It is not WEB evidence about a candidate, and WEB claims must still cite supplied sources.",
      "When the user asks for a specific number of decisions, give exactly that many numbered, concrete decisions. Tie each decision to an observed metric or an explicit measurement threshold; generic advice such as 'improve targeting' is not sufficient.",
      "If an excerpt does not contain the requested number or methodology, say that clearly instead of inventing it.",
      channel === "voice" ? "Keep the answer to four or five concise spoken sentences." : "Keep the answer concise but substantive, normally six to twelve sentences.",
      "Do not expose hidden reasoning or chain-of-thought. Return only the user-facing answer.",
    ].join("\n"),
    user: JSON.stringify({ query, ...(researchContext ? { researchContext } : {}), verifiedSources: sourceProjection }),
    tenantId,
    purpose: "answer",
    channel,
    // Research synthesis has a larger grounded prompt than a greeting. Give the
    // composite route enough shared budget to reach a healthy fallback provider.
    deadlineMs: channel === "voice" ? 6_500 : 20_000,
  });
  const trimmed = answer.trim();
  if (!trimmed) throw new Error("Research synthesis returned an empty answer");
  // Links are rendered from the separately validated citation envelope. Converting
  // markdown links back to their labels prevents raw `[title](url)` syntax from
  // leaking into the plain conversational answer surface.
  return trimmed.replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, "$1");
}

function typedFirecrawlResult(output: Record<string, unknown>): FirecrawlScrapeResult | undefined {
  const candidate = output.result;
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Partial<FirecrawlScrapeResult>;
  const snapshot = value.snapshot;
  const citation = value.citation;
  if (
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    typeof value.content !== "string" ||
    typeof value.excerpt !== "string" ||
    !snapshot ||
    typeof snapshot !== "object" ||
    typeof snapshot.changeHash !== "string" ||
    !citation ||
    typeof citation !== "object" ||
    typeof citation.citationId !== "string"
  ) return undefined;
  return value as FirecrawlScrapeResult;
}

async function verifyDiscoveredResults(results: DiscoveryResult[], tools: ToolRegistry) {
  const candidateUrls: string[] = [];
  const seenUrls = new Set<string>();
  for (const result of results) {
    if (!result.url || seenUrls.has(result.url) || candidateUrls.length >= MAX_DISCOVERY_VERIFICATIONS) continue;
    seenUrls.add(result.url);
    candidateUrls.push(result.url);
  }

  const attempts = new Map<string, { result?: FirecrawlScrapeResult; error?: string }>();
  for (const url of candidateUrls) {
    const response = await tools.call("firecrawl_scrape", { url });
    const verified = response.ok ? typedFirecrawlResult(response.output) : undefined;
    attempts.set(url, verified
      ? { result: verified }
      : { error: response.error ?? "Firecrawl verification returned no typed source" });
  }

  const verified: VerifiedDiscovery[] = [];
  const citedResults: Array<{
    provider: "firecrawl" | "exa";
    title: string;
    url: string;
    excerpt: string;
    citation: WebCitation;
    snapshot?: FirecrawlScrapeResult["snapshot"];
    discoveredFrom?: string;
  }> = [];
  const citations: WebCitation[] = [];
  const labeledResults = results.map((discovery) => {
    const attempt = attempts.get(discovery.url);
    if (attempt?.result) {
      verified.push({ discovery, firecrawl: attempt.result });
      citedResults.push({
        provider: attempt.result.provider,
        title: attempt.result.title,
        url: attempt.result.url,
        excerpt: attempt.result.excerpt,
        citation: attempt.result.citation,
        snapshot: attempt.result.snapshot,
        discoveredFrom: discovery.url,
      });
      citations.push(attempt.result.citation);
      return {
        ...discovery,
        provider: "firecrawl" as const,
        verificationStatus: "verified" as const,
        citation: attempt.result.citation,
        snapshot: attempt.result.snapshot,
      };
    }
    // Exa's `contents.text` response is retrieved page material, not a search-
    // engine teaser. It remains source-backed when a second provider is not
    // configured, while still being labeled distinctly from Firecrawl snapshots.
    if (discovery.contentRetrieved === true && discovery.snippet.trim()) {
      const retrievedAt = discovery.retrievedAt ?? new Date().toISOString();
      const citation: WebCitation = {
        citationId: `exa:${createHash("sha256").update(`${discovery.url}\n${discovery.snippet}`).digest("hex").slice(0, 24)}`,
        provider: "exa",
        url: discovery.url,
        title: discovery.title,
        retrievedAt,
        freshness: "unknown",
      };
      citedResults.push({
        provider: "exa",
        title: discovery.title,
        url: discovery.url,
        excerpt: discovery.snippet,
        citation,
      });
      citations.push(citation);
      return {
        ...discovery,
        provider: "exa" as const,
        verificationStatus: "source_backed" as const,
        citation,
        verificationReason: attempt?.error ?? "exa_contents_retrieved",
      };
    }
    return {
      ...discovery,
      provider: "exa" as const,
      verificationStatus: "unverified_discovery" as const,
      verificationReason: attempt?.error ?? "not_attempted_bounded_verification",
    };
  });

  const unverifiedCount = labeledResults.filter((result) => result.verificationStatus === "unverified_discovery").length;
  const sourceBackedCount = citedResults.length;
  const exaRetrievedCount = citedResults.filter((result) => result.provider === "exa").length;
  const verificationStatus = sourceBackedCount === 0
    ? results.length === 0 ? "not_attempted" : "unavailable"
    : unverifiedCount === 0 ? "verified" : "partial";
  const spokenSummary = results.length === 0
    ? "The web search came back empty."
    : sourceBackedCount === 0
      ? `Search found ${results.length} candidate source${results.length === 1 ? "" : "s"}, but neither retrieved page content nor a Firecrawl snapshot was available. I won't summarize bare discovery as fact.`
      : `Retrieved ${sourceBackedCount} source-backed result${sourceBackedCount === 1 ? "" : "s"}. Top source: ${citedResults[0]!.title}. ${citedResults[0]!.excerpt.slice(0, 200)}${unverifiedCount > 0 ? ` ${unverifiedCount} discovery candidate${unverifiedCount === 1 ? " remains" : "s remain"} unverified and is not included as fact.` : ""}`;

  return {
    labeledResults,
    citedResults,
    citations,
    verifiedSnapshots: verified.map(({ firecrawl }) => firecrawl.snapshot),
    unverifiedDiscovery: labeledResults.filter((result) => result.verificationStatus === "unverified_discovery"),
    verification: {
      status: verificationStatus,
      attempted: candidateUrls.length,
      verified: sourceBackedCount,
      firecrawlVerified: verified.length,
      exaRetrieved: exaRetrievedCount,
      unverified: unverifiedCount,
      boundedAt: MAX_DISCOVERY_VERIFICATIONS,
    },
    spokenSummary,
  };
}

export const WebSearchSchema = z.object({
  query: z.string().min(2).max(400),
  numResults: opt(z.number().int().min(1).max(10)),
  responseChannel: ResponseChannelSchema.optional(),
  researchContext: z.object({
    companyName: z.string().min(1).max(200),
    industry: z.string().min(1).max(200),
    niche: z.string().min(1).max(200).optional(),
    geographies: z.array(z.string().min(1).max(120)).min(1).max(10),
    idealCustomerProfile: z.record(z.unknown()),
    comparison: z.object({
      founderAge: z.number().int().min(18).max(100).optional(),
      ageToleranceYears: z.number().int().min(0).max(20).optional(),
      founderAgeMin: z.number().int().min(18).max(100).optional(),
      founderAgeMax: z.number().int().min(18).max(100).optional(),
      scaleMetric: z.string().min(1).max(100).optional(),
      minScaleUsd: z.number().nonnegative().optional(),
      maxScaleUsd: z.number().positive().optional(),
      performanceMetric: z.string().min(1).max(120).optional(),
      companyBaseline: z.union([z.string().max(100), z.number()]).optional(),
    }).superRefine((value, ctx) => {
      if (value.founderAgeMin !== undefined && value.founderAgeMax !== undefined && value.founderAgeMin > value.founderAgeMax) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["founderAgeMax"], message: "founderAgeMax must be at least founderAgeMin" });
      }
    }),
    sourceKinds: z.tuple([z.literal("PROFILE"), z.literal("WEB")]),
  }).optional(),
});
const SCHEMAS: Record<string, z.ZodTypeAny> = {
  search_web: WebSearchSchema,
};

export const webResearchPlugin: DomainEnginePlugin = {
  name: "web-research",
  actionTypes: Object.keys(SCHEMAS),
  payloadSchemas: SCHEMAS,
  canHandle(t) {
    return t in SCHEMAS;
  },

  validate(actionType, payload): ValidationResult {
    const schema = SCHEMAS[actionType];
    if (!schema) return { valid: false, errors: [`unhandled action ${actionType}`] };
    const p = schema.safeParse(payload);
    return p.success
      ? { valid: true, errors: [] }
      : { valid: false, errors: p.error.issues.map((i) => `payload.${i.path.join(".")}: ${i.message}`) };
  },

  draft(actionType, payload, policy: DomainPolicy): DraftAction {
    const p = SCHEMAS[actionType]!.parse(payload) as Record<string, unknown>;
    return {
      actionType,
      summary: `Search the web: "${p.query}"`,
      payload: { ...p, tenantId: policy.tenantId },
      requiresConfirmation: policy.requiresConfirmation,
    };
  },

  async execute(draft: DraftAction, tools: ToolRegistry): Promise<ExecutionResult> {
    const p = draft.payload;
    const tenantId = String(p.tenantId ?? "");
    const responseChannel = (p.responseChannel ?? "text") as LLMChannel;
    const query = String(p.query);

    const r = await tools.call("web_search", { query, numResults: Number(p.numResults ?? 5) });
    if (!r.ok) {
      return {
        status: r.integrationUnavailable ? "integration_unavailable" : "failure",
        output: {},
        error: `Web search failed: ${r.error}`,
      };
    }
    const results = (r.output.results ?? []) as DiscoveryResult[];
    const verification = await verifyDiscoveredResults(results, tools);
    let spokenSummary = verification.spokenSummary;
    if (verification.citedResults.length > 0) {
      try {
        spokenSummary = await synthesizeVerifiedResearch(
          query,
          verification.citedResults.map((result) => ({ title: result.title, url: result.url, excerpt: result.excerpt })),
          responseChannel,
          tenantId,
          p.researchContext as Record<string, unknown> | undefined,
        );
      } catch (error) {
        console.warn("[web-research] source synthesis unavailable", {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message.slice(0, 240) : "Unknown provider failure",
        });
        // Keep the deterministic verified-source summary when answer synthesis
        // is unavailable; never substitute unverified discovery text.
      }
    }
    return {
      status: "success",
      output: {
        query,
        results: verification.labeledResults,
        citedResults: verification.citedResults,
        citations: verification.citations.map((citation) => ({ ...citation, evidenceKind: "WEB" })),
        verifiedSnapshots: verification.verifiedSnapshots,
        unverifiedDiscovery: verification.unverifiedDiscovery,
        verification: verification.verification,
        spokenSummary,
        displaySafe: {
          title: "Verified research",
          evidenceKind: "WEB",
          sourceCount: verification.citedResults.length,
          sources: verification.citedResults.map((result) => ({ title: result.title, url: result.url })),
        },
      },
      expected: { answered: true, verifiedSources: verification.verification.verified },
    };
  },
};

export default webResearchPlugin;
