// §5.2 (CENTROPY 95% MAESTRO PACK): chunking spec — receipts/reports/transcripts split
// by semantic unit (paragraph, falling back to sentence for an oversized paragraph),
// packed to a 200-500 token target. Token count is estimated (~4 chars/token, the
// standard English rule of thumb) — good enough for a chunk-size heuristic, not
// billing-accurate; Voyage's own tokenizer would differ slightly and that's fine here.

const DEFAULT_MIN_TOKENS = 200;
const DEFAULT_MAX_TOKENS = 500;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

function splitLongUnit(unit: string, maxTokens: number): string[] {
  const sentences = unit.split(SENTENCE_SPLIT_RE).filter(Boolean);
  if (sentences.length <= 1) return [unit]; // nothing to split on — ship it whole
  const parts: string[] = [];
  let buf = "";
  for (const s of sentences) {
    const candidate = buf ? `${buf} ${s}` : s;
    if (buf && estimateTokens(candidate) > maxTokens) {
      parts.push(buf);
      buf = s;
    } else {
      buf = candidate;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

export interface ChunkTextOptions {
  minTokens?: number;
  maxTokens?: number;
}

/** Splits free text into 200-500 token chunks along semantic-unit boundaries
 *  (paragraph first, sentence for an oversized paragraph) — never mid-sentence, never
 *  mid-word. Chunks under minTokens are merged into a neighbor rather than shipped as
 *  a near-empty embedding with too little context to be useful in retrieval. */
export function chunkText(text: string, opts: ChunkTextOptions = {}): string[] {
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const trimmed = text.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const units = paragraphs.length > 0 ? paragraphs : [trimmed];

  const raw: string[] = [];
  let buffer = "";
  for (const unit of units) {
    const pieces = estimateTokens(unit) > maxTokens ? splitLongUnit(unit, maxTokens) : [unit];
    for (const piece of pieces) {
      const candidate = buffer ? `${buffer}\n\n${piece}` : piece;
      if (buffer && estimateTokens(candidate) > maxTokens) {
        raw.push(buffer);
        buffer = piece;
      } else {
        buffer = candidate;
      }
    }
  }
  if (buffer) raw.push(buffer);

  const merged: string[] = [];
  for (const chunk of raw) {
    const prevIdx = merged.length - 1;
    const prev = merged[prevIdx];
    const chunkIsSmall = estimateTokens(chunk) < minTokens;
    if (chunkIsSmall && prev !== undefined && estimateTokens(`${prev}\n\n${chunk}`) <= maxTokens * 1.5) {
      merged[prevIdx] = `${prev}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

export interface ChunkSourceInput {
  text: string;
  entityRefs?: unknown[];
  occurredAt?: Date;
}

export interface ChunkWithMetadata {
  chunk: string;
  entityRefs: unknown[];
  occurredAt?: Date;
}

/** Applies chunkText and stamps every resulting chunk with the source's metadata —
 *  {tenantId, sourceDocId, entityRefs, occurredAt} is completed by the caller
 *  (writeSemantic takes tenantId/sourceDocId separately; this only carries the
 *  per-chunk fields). */
export function chunkSource(source: ChunkSourceInput, opts: ChunkTextOptions = {}): ChunkWithMetadata[] {
  return chunkText(source.text, opts).map((chunk) => ({
    chunk,
    entityRefs: source.entityRefs ?? [],
    occurredAt: source.occurredAt,
  }));
}
