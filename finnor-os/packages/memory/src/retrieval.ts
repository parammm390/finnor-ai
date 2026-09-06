// §5.3 (JARVIS 95% MAESTRO PACK): hybrid retrieval. Retrieval order is law — (1)
// structured read-models first, (2) tenant-scoped semantic second, (3) merged with
// citations — "the LLM never answers from semantic memory alone when a structured
// source exists." This module owns the merge/citation/confidence machinery; each
// answer action supplies its own structured facts (for example, a canonical Deal
// query or current Work projection) rather than this module guessing what's relevant.

import { querySemantic, type SemanticHit } from "./semantic";
import { findMatchingCorrection } from "./corrections";

export interface StructuredFact {
  /** Which real source this came from — becomes a citation's `source`. */
  source: string;
  /** What within that source — a row id, a topic key, "current" for a snapshot. */
  ref: string;
  data: unknown;
  /** When the underlying fact was true/recorded — defaults to retrieval time (now) if
   *  the fact has no natural timestamp of its own (e.g. a live snapshot). */
  timestamp?: string;
}

export interface Citation {
  source: string;
  ref: string;
  timestamp: string;
}

export interface HybridRetrievalResult {
  /** Structured facts merged by source — ground truth, always preferred over semantic. */
  facts: Record<string, unknown>;
  /** Every citation this answer could point to — structured facts first, then semantic
   *  hits — in the same {source, ref, timestamp} shape a DecisionReceipt's evidence
   *  field already uses, so this flows straight through with no reshaping. */
  citations: Citation[];
  /** Raw semantic hits (chunk text) for the caller's prompt — kept separate from facts
   *  since semantic snippets are supporting context, never ground truth on their own. */
  semanticHits: SemanticHit[];
  asOf: string;
  /** §5.5: "high" when at least one structured fact grounds the answer, or the best
   *  semantic hit clears confidenceThreshold. "low" means the caller should say what's
   *  missing rather than guess — real refusal logic lives in the caller (it knows what
   *  a good refusal sounds like for its domain), this just carries the honest signal. */
  confidence: "high" | "low";
}

const DEFAULT_SEMANTIC_LIMIT = 5;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

export interface HybridRetrieveParams {
  tenantId: string;
  query: string;
  /** Already-fetched structured facts — this module does no DB I/O of its own for
   *  structured data, only for the semantic step. */
  structured?: StructuredFact[];
  semanticLimit?: number;
  /** §5.5: policy-configured minimum best-hit similarity for confidence:"high" when no
   *  structured fact exists. Thresholds live in policy rows, not code — callers read
   *  this from domain_policies and pass it through. */
  confidenceThreshold?: number;
}

export async function hybridRetrieve(params: HybridRetrieveParams): Promise<HybridRetrievalResult> {
  const asOf = new Date().toISOString();
  const structured = [...(params.structured ?? [])];
  // Semantic memory failing (unconfigured embeddings, a transient DB blip) must never
  // break an answer that structured facts alone can already ground — same
  // graceful-degradation convention buildMemorySnapshot already applies.
  const [semanticHits, correction] = await Promise.all([
    // Callers with a complete exact read model can explicitly disable approximate
    // semantic recall. This prevents unrelated same-tenant snippets from bleeding
    // into identity-critical answers and avoids paying for an embedding that cannot
    // improve the result.
    params.semanticLimit === 0
      ? Promise.resolve([] as SemanticHit[])
      : querySemantic(params.tenantId, params.query, params.semanticLimit ?? DEFAULT_SEMANTIC_LIMIT).catch(() => [] as SemanticHit[]),
    // §5.6: a human correction always wins — checked BEFORE anything else so it lands
    // first in `structured` (and therefore first in `citations`), ahead of every other
    // structured fact a caller supplied, not just ahead of semantic hits.
    findMatchingCorrection(params.tenantId, params.query).catch(() => null),
  ]);
  if (correction) {
    structured.unshift({
      source: "correction",
      ref: correction.id,
      data: { correctedFact: correction.correctedFact, originalQuestion: correction.question, correctedBy: correction.correctedBy },
    });
  }

  const facts: Record<string, unknown> = {};
  const citations: Citation[] = [];
  for (const f of structured) {
    facts[f.source] = f.data;
    citations.push({ source: f.source, ref: f.ref, timestamp: f.timestamp ?? asOf });
  }
  for (const hit of semanticHits) {
    citations.push({ source: "semantic_memory", ref: hit.sourceDocId ?? "unknown", timestamp: hit.occurredAt ?? asOf });
  }

  const bestSimilarity = semanticHits.reduce((max, h) => Math.max(max, h.similarity), Number.NEGATIVE_INFINITY);
  const threshold = params.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const confidence: "high" | "low" = structured.length > 0 || bestSimilarity >= threshold ? "high" : "low";

  return { facts, citations, semanticHits, asOf, confidence };
}
