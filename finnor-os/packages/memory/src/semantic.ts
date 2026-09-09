// Semantic memory: pgvector embeddings, namespaced by tenant_id, queried only within
// that namespace (§10). Tenant isolation is enforced by RLS AND the explicit predicate.

import { createHash } from "node:crypto";
import { withTenant, getPool, embeddingCache } from "@finnor/db";
import { embeddings } from "@finnor/db";
import { PLACEHOLDER_NEEDS_REAL_VALUE } from "@finnor/shared-types";
import { and, eq, inArray, isNull } from "drizzle-orm";

export interface SemanticHit {
  id?: string;
  chunk: string;
  sourceDocId: string | null;
  documentId?: string | null;
  documentVersionId?: string | null;
  similarity: number;
  relevanceScore?: number;
  contentHash?: string;
  sourceKind?: string;
  provenance?: Record<string, unknown>;
  occurredAt?: string;
  entityRefs?: unknown[];
}

/**
 * Embedding provider abstraction. §5.1 (JARVIS 95% MAESTRO PACK): the chosen real
 * provider is Voyage AI voyage-3.5 (VoyageEmbedder below). DeterministicLocalEmbedder
 * hashes token n-grams into a fixed vector — NOT semantically meaningful, a mechanical
 * stand-in that keeps ingestion/retrieval *plumbing* testable without a live API key.
 * Per §5's decision, it may only run under NODE_ENV=test — see defaultEmbedder().
 */
export interface EmbeddingProvider {
  /** Stable identifier for this provider+config, used as the embedding_cache "model"
   *  key so a future provider swap never serves a stale-dimension vector from cache. */
  readonly name: string;
  embed(text: string): Promise<number[]>;
  /** Optional batch path — providers without a real batch API fall back to per-text
   *  embed() calls in embedManyCached() below. */
  embedBatch?(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIMENSIONS = 1024;

export class DeterministicLocalEmbedder implements EmbeddingProvider {
  readonly name = "deterministic-local-v1";

  async embed(text: string): Promise<number[]> {
    const dims = EMBEDDING_DIMENSIONS;
    const vec = new Array<number>(dims).fill(0);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % dims;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

const FAIL_CLOSED_MESSAGE =
  "Embeddings are not configured for this environment: EMBEDDINGS_API_KEY is unset " +
  "(or still the placeholder). Real memory never silently falls back to a fake " +
  "embedder outside tests — set a real Voyage AI key, or see " +
  "finnor-os/docs/owner-actions.md for signup steps. Callers must treat this as a " +
  "degraded-mode signal (log + continue), never let it crash an unrelated request.";

/** §5.1: "the silent fallback... is a security-grade bug." This is the fix — instead of
 *  quietly returning fake-but-plausible-looking vectors, any real (non-test) call site
 *  without a real provider gets a loud, typed failure. Deliberately does NOT crash the
 *  process at import time (that would take down unrelated routes/jobs that have nothing
 *  to do with memory) — every caller in this codebase already wraps semantic memory
 *  calls in try/catch or .catch() and degrades gracefully, matching the existing
 *  provider-circuit-breaker convention ("queue as degraded, never silently emulated"). */
export class FailClosedEmbedder implements EmbeddingProvider {
  readonly name = "fail-closed";
  async embed(): Promise<number[]> {
    throw new Error(FAIL_CLOSED_MESSAGE);
  }
  async embedBatch(): Promise<number[][]> {
    throw new Error(FAIL_CLOSED_MESSAGE);
  }
}

const VOYAGE_MODEL = "voyage-3.5";
const VOYAGE_BATCH_SIZE = 128;
const VOYAGE_TIMEOUT_MS = 20_000;
const VOYAGE_MAX_RETRIES = 3;
const VOYAGE_429_MAX_RETRIES = 1;
const VOYAGE_RATE_LIMIT_COOLDOWN_MS = 60_000;
let voyageRateLimitedUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter exponential backoff — same shape as workflow-runtime/src/outbox.ts's
 *  jitteredBackoffMs, reimplemented locally rather than adding a cross-package dep. */
function jitteredBackoffMs(attempt: number): number {
  const cap = Math.min(1000 * 2 ** attempt, 8000);
  return Math.floor(Math.random() * cap);
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = new Date(raw).getTime();
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Real Voyage AI embedder — plain fetch, no SDK dependency (matches this repo's
 * provider wrappers' convention). §5.1's exact model name/output_dimension
 * parameter should be reconfirmed against Voyage's live docs at signup time (see
 * docs/owner-actions.md) — this implementation follows Voyage's documented
 * Matryoshka output_dimension option for voyage-3.5 as of this writing, but has never
 * been exercised against a real account (no key exists in this environment).
 */
export class VoyageEmbedder implements EmbeddingProvider {
  readonly name = `voyage-3.5-${EMBEDDING_DIMENSIONS}`;
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.EMBEDDINGS_API_KEY;
    if (!key || key === PLACEHOLDER_NEEDS_REAL_VALUE) {
      throw new Error("VoyageEmbedder requires a real EMBEDDINGS_API_KEY");
    }
    this.apiKey = key;
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
      out.push(...(await this.embedBatchOnce(texts.slice(i, i + VOYAGE_BATCH_SIZE))));
    }
    return out;
  }

  private async embedBatchOnce(batch: string[], attempt = 0): Promise<number[][]> {
    if (Date.now() < voyageRateLimitedUntil) {
      throw new Error(`Voyage embeddings are cooling down after a provider rate limit until ${new Date(voyageRateLimitedUntil).toISOString()}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VOYAGE_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          input: batch,
          model: VOYAGE_MODEL,
          output_dimension: EMBEDDING_DIMENSIONS,
          input_type: "document",
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 429) {
          const providerDelay = retryAfterMs(res);
          // Voyage's low-volume tier commonly asks callers to wait tens of
          // seconds. Retrying three times inside one overview request only burns
          // more quota and log volume, so respect a meaningful Retry-After with
          // a module-level circuit. A missing/very short header gets one retry for
          // transient edge throttles and preserves the existing bounded behavior.
          if ((providerDelay === null || providerDelay <= 2_000) && attempt < VOYAGE_429_MAX_RETRIES) {
            await sleep(providerDelay ?? jitteredBackoffMs(attempt));
            return this.embedBatchOnce(batch, attempt + 1);
          }
          voyageRateLimitedUntil = Date.now() + Math.max(providerDelay ?? 0, VOYAGE_RATE_LIMIT_COOLDOWN_MS);
          throw new Error(`Voyage embeddings API error (429): ${body.slice(0, 300)}`);
        }
        if (res.status >= 500 && attempt < VOYAGE_MAX_RETRIES) {
          await sleep(jitteredBackoffMs(attempt));
          return this.embedBatchOnce(batch, attempt + 1);
        }
        throw new Error(`Voyage embeddings API error (${res.status}): ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
      return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err) {
      if ((err as Error).name === "AbortError" && attempt < VOYAGE_MAX_RETRIES) {
        await sleep(jitteredBackoffMs(attempt));
        return this.embedBatchOnce(batch, attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function embeddingsConfigured(): boolean {
  const key = process.env.EMBEDDINGS_API_KEY;
  return Boolean(key) && key !== PLACEHOLDER_NEEDS_REAL_VALUE;
}

export function embeddingsProviderStatus(): { configured: boolean; provider: string; healthy: boolean | null } {
  // healthy stays null (never tested) rather than guessed — a real round-trip health
  // check would cost a real embedding call on every /api/setup/status poll, which is
  // not worth it for a provider with no per-call side effects to worry about failing
  // silently; "configured" is the honest signal this endpoint can cheaply give.
  return { configured: embeddingsConfigured(), provider: VOYAGE_MODEL, healthy: embeddingsConfigured() ? null : false };
}

/** §5's binding decision: DeterministicLocalEmbedder may only stand in for a real
 *  provider under NODE_ENV=test. Everywhere else — local dev included — a missing key
 *  is a loud FailClosedEmbedder, never a silent fake. */
export function defaultEmbedder(): EmbeddingProvider {
  if (embeddingsConfigured()) return new VoyageEmbedder();
  if (process.env.NODE_ENV === "test") return new DeterministicLocalEmbedder();
  return new FailClosedEmbedder();
}

export function semanticContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** §5.1: content-hash cache wrapping any embedder — skips re-embedding chunks whose
 *  exact text was embedded before under the same provider/model, tenant-scoped (see
 *  migration 0028 for why not a global cache). Falls back to per-text embed() calls
 *  when the provider has no embedBatch. */
export async function embedManyCached(
  tenantId: string,
  texts: string[],
  embedder: EmbeddingProvider,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const hashes = texts.map(semanticContentHash);
  // Raw client, not Drizzle's typed `.select()` — Drizzle's pgvector column mapper
  // assumes the on-the-wire value is always pgvector's text format, but the dev-machine
  // jsonb fallback (no pgvector extension, same convention as querySemantic below)
  // returns an already-parsed JS array from node-postgres, which that mapper chokes on.
  // A raw query sidesteps the mapper entirely and handles both shapes explicitly, same
  // pattern querySemantic already uses for its own dual pgvector/jsonb read path.
  const client = await getPool().connect();
  let cached: Array<{ content_hash: string; embedding: unknown }>;
  try {
    // This raw path deliberately bypasses Drizzle's vector mapper, but it must not
    // bypass the transaction boundary that makes the tenant GUC safe for a
    // transaction-mode pooler. `set_config(..., true)` outside BEGIN is scoped only
    // to that one implicit statement, so the following cache read would otherwise
    // have no RLS context on a reused PgBouncer backend.
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = finnor_os, public");
    await client.query("SET LOCAL statement_timeout = 10000");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query(
      `SELECT content_hash, embedding FROM embedding_cache
       WHERE tenant_id = $1 AND model = $2 AND content_hash = ANY($3::text[])`,
      [tenantId, embedder.name, hashes],
    );
    cached = rows;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const byHash = new Map(
    cached.map((r) => [
      r.content_hash,
      (typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding) as number[],
    ]),
  );
  const result: (number[] | null)[] = texts.map((_, i) => byHash.get(hashes[i]!) ?? null);
  const missIdx = result.reduce<number[]>((acc, v, i) => (v === null ? [...acc, i] : acc), []);

  if (missIdx.length > 0) {
    const missTexts = missIdx.map((i) => texts[i]!);
    const fresh = embedder.embedBatch ? await embedder.embedBatch(missTexts) : await Promise.all(missTexts.map((t) => embedder.embed(t)));
    await withTenant(tenantId, (db) =>
      db
        .insert(embeddingCache)
        .values(missIdx.map((idx, j) => ({ tenantId, contentHash: hashes[idx]!, model: embedder.name, embedding: fresh[j]! })))
        .onConflictDoNothing({ target: [embeddingCache.tenantId, embeddingCache.contentHash, embeddingCache.model] }),
    );
    missIdx.forEach((idx, j) => {
      result[idx] = fresh[j]!;
    });
  }
  return result as number[][];
}

export interface WriteSemanticChunk {
  chunk: string;
  /** Optional per-chunk source identity, e.g. a public PDF URL with #chunk=N. */
  sourceDocId?: string;
  /** Optional canonical document row for source-backed chunks. */
  documentId?: string;
  /** Exact immutable artifact version. Required for artifact-derived chunks. */
  documentVersionId?: string;
  entityRefs?: unknown[];
  occurredAt?: Date;
  /** Stable provenance class, e.g. receipt, voice_transcript, source_document. */
  sourceKind?: string;
  /** Non-secret source metadata. Never include credentials or raw auth headers. */
  provenance?: Record<string, unknown>;
}

export async function writeSemantic(
  tenantId: string,
  sourceDocId: string,
  chunksInput: string[] | WriteSemanticChunk[],
  embedder: EmbeddingProvider = defaultEmbedder(),
): Promise<number> {
  const chunks = chunksInput
    .map((input): WriteSemanticChunk => (typeof input === "string" ? { chunk: input } : input))
    .map((chunk) => ({ ...chunk, chunk: chunk.chunk.trim() }))
    .filter((chunk) => chunk.chunk.length > 0);
  if (chunks.length === 0) return 0;

  const prepared = chunks.map((chunk) => {
    const effectiveSourceDocId = chunk.sourceDocId ?? sourceDocId;
    return {
      ...chunk,
      effectiveSourceDocId,
      contentHash: semanticContentHash(chunk.chunk),
      sourceKind: chunk.sourceKind ?? "semantic_history",
      provenance: {
        sourceDocId: effectiveSourceDocId,
        ingestion: "writeSemantic",
        ...(chunk.provenance ?? {}),
      },
    };
  });
  const sourceIds = [...new Set(prepared.map((chunk) => chunk.effectiveSourceDocId))];

  // Read before embedding so an unchanged source is genuinely idempotent: the
  // content-hash cache avoids provider cost, while this check also avoids creating
  // duplicate memory rows and misleading duplicate citations.
  const activeBefore = await withTenant(tenantId, (db) =>
    db
      .select({ id: embeddings.id, sourceDocId: embeddings.sourceDocId, contentHash: embeddings.contentHash, documentVersionId: embeddings.documentVersionId })
      .from(embeddings)
      .where(and(eq(embeddings.tenantId, tenantId), inArray(embeddings.sourceDocId, sourceIds), isNull(embeddings.supersededAt))),
  );
  const activeKeys = new Set(activeBefore.map((row) => `${row.sourceDocId}:${row.contentHash}:${row.documentVersionId ?? ""}`));
  const candidates = prepared.filter((chunk) => !activeKeys.has(`${chunk.effectiveSourceDocId}:${chunk.contentHash}:${chunk.documentVersionId ?? ""}`));
  const vectors = await embedManyCached(tenantId, candidates.map((chunk) => chunk.chunk), embedder);

  return withTenant(tenantId, async (db) => {
    // Re-read inside the write transaction to close the race between the initial
    // idempotency check and insertion. The partial unique index remains the final
    // concurrency guard.
    const active = await db
      .select({ id: embeddings.id, sourceDocId: embeddings.sourceDocId, contentHash: embeddings.contentHash, documentVersionId: embeddings.documentVersionId })
      .from(embeddings)
      .where(and(eq(embeddings.tenantId, tenantId), inArray(embeddings.sourceDocId, sourceIds), isNull(embeddings.supersededAt)));
    const incomingBySource = new Map<string, Set<string>>();
    for (const chunk of prepared) {
      const hashes = incomingBySource.get(chunk.effectiveSourceDocId) ?? new Set<string>();
      hashes.add(`${chunk.contentHash}:${chunk.documentVersionId ?? ""}`);
      incomingBySource.set(chunk.effectiveSourceDocId, hashes);
    }
    const obsolete = active.filter((row) => !incomingBySource.get(row.sourceDocId)?.has(`${row.contentHash}:${row.documentVersionId ?? ""}`));
    if (obsolete.length > 0) {
      await db
        .update(embeddings)
        .set({ supersededAt: new Date() })
        .where(inArray(embeddings.id, obsolete.map((row) => row.id)));
    }

    const stillActiveKeys = new Set(active.filter((row) => !obsolete.some((old) => old.id === row.id)).map((row) => `${row.sourceDocId}:${row.contentHash}:${row.documentVersionId ?? ""}`));
    const linkedSources = new Set<string>();
    const values = candidates
      .map((chunk, i) => ({ chunk, vector: vectors[i]! }))
      .filter(({ chunk }) => !stillActiveKeys.has(`${chunk.effectiveSourceDocId}:${chunk.contentHash}:${chunk.documentVersionId ?? ""}`))
      .map(({ chunk, vector }) => {
        const prior = linkedSources.has(chunk.effectiveSourceDocId)
          ? undefined
          : obsolete.find((row) => row.sourceDocId === chunk.effectiveSourceDocId);
        linkedSources.add(chunk.effectiveSourceDocId);
        return {
          tenantId,
          sourceDocId: chunk.effectiveSourceDocId,
          documentId: chunk.documentId ?? null,
          documentVersionId: chunk.documentVersionId ?? null,
          chunk: chunk.chunk,
          embedding: vector,
          entityRefs: chunk.entityRefs ?? [],
          occurredAt: chunk.occurredAt ?? new Date(),
          contentHash: chunk.contentHash,
          sourceKind: chunk.sourceKind,
          provenance: chunk.provenance,
          // A source revision may replace several old chunks. Link the first new
          // chunk for EACH source to that source's prior row; every old row also
          // retains superseded_at for complete history.
          supersedesId: prior?.id ?? null,
        };
      });
    if (values.length === 0) return 0;
    const inserted = await db.insert(embeddings).values(values).onConflictDoNothing().returning({ id: embeddings.id });
    return inserted.length;
  });
}

const MIN_SEMANTIC_SIMILARITY = 0.2;

function rankSemanticHit(hit: SemanticHit, nowMs: number): SemanticHit {
  const occurredMs = hit.occurredAt ? new Date(hit.occurredAt).getTime() : Number.NaN;
  const ageDays = Number.isFinite(occurredMs) ? Math.max(0, (nowMs - occurredMs) / 86_400_000) : 365;
  const recency = Math.exp(-ageDays / 365);
  return { ...hit, relevanceScore: hit.similarity * 0.85 + recency * 0.15 };
}

export async function querySemantic(
  tenantId: string,
  query: string,
  limit = 5,
  embedder: EmbeddingProvider = defaultEmbedder(),
): Promise<SemanticHit[]> {
  const [qvec] = await embedManyCached(tenantId, [query], embedder);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = finnor_os, public");
    await client.query("SET LOCAL statement_timeout = 10000");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows: ext } = await client.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
    );
    let hits: SemanticHit[];
    if (ext.length > 0) {
      // pgvector path (Supabase, CI): ANN search in SQL.
      const { rows } = await client.query(
        `SELECT e.id,e.chunk,e.source_doc_id,e.document_id,e.document_version_id,e.content_hash,e.source_kind,e.provenance,
                e.entity_refs,e.occurred_at,1-(e.embedding <=> $2::vector) AS similarity
         FROM embeddings e
         WHERE e.tenant_id=$1 AND e.embedding IS NOT NULL AND e.superseded_at IS NULL
           AND (e.document_version_id IS NULL OR EXISTS (
             SELECT 1 FROM document_version_heads h WHERE h.tenant_id=e.tenant_id AND h.document_id=e.document_id
               AND h.kind='current' AND h.head_key='default' AND h.version_id=e.document_version_id
           ))
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
        [tenantId, JSON.stringify(qvec), Math.max(limit * 3, limit)],
      );
      hits = rows.map((r) => ({
        id: r.id as string,
        chunk: r.chunk as string,
        sourceDocId: (r.source_doc_id as string | null) ?? null,
        documentId: (r.document_id as string | null) ?? null,
        documentVersionId: (r.document_version_id as string | null) ?? null,
        similarity: Number(r.similarity),
        contentHash: r.content_hash as string,
        sourceKind: r.source_kind as string,
        provenance: (r.provenance as Record<string, unknown> | null) ?? {},
        occurredAt: (r.occurred_at as Date | null)?.toISOString?.(),
        entityRefs: (r.entity_refs as unknown[] | null) ?? [],
      }));
    } else {
      // jsonb fallback (dev machine without pgvector): cosine similarity in-process.
      // Fine at dev-corpus scale; production always has pgvector.
      const { rows } = await client.query(
        `SELECT e.id,e.chunk,e.source_doc_id,e.document_id,e.document_version_id,e.content_hash,e.source_kind,e.provenance,
                e.entity_refs,e.occurred_at,e.embedding FROM embeddings e
         WHERE e.tenant_id=$1 AND e.embedding IS NOT NULL AND e.superseded_at IS NULL
           AND (e.document_version_id IS NULL OR EXISTS (
             SELECT 1 FROM document_version_heads h WHERE h.tenant_id=e.tenant_id AND h.document_id=e.document_id
               AND h.kind='current' AND h.head_key='default' AND h.version_id=e.document_version_id
           ))`,
        [tenantId],
      );
      hits = rows
        .map((r) => {
          const vec = (typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding) as number[];
          const dot = qvec!.reduce((s, v, i) => s + v * (vec[i] ?? 0), 0);
          return {
            id: r.id as string,
            chunk: r.chunk as string,
            sourceDocId: (r.source_doc_id as string | null) ?? null,
            documentId: (r.document_id as string | null) ?? null,
            documentVersionId: (r.document_version_id as string | null) ?? null,
            similarity: dot, // vectors are normalized, so dot product == cosine
            contentHash: r.content_hash as string,
            sourceKind: r.source_kind as string,
            provenance: (r.provenance as Record<string, unknown> | null) ?? {},
            occurredAt: (r.occurred_at as Date | null)?.toISOString?.(),
            entityRefs: (r.entity_refs as unknown[] | null) ?? [],
          };
        })
        .sort((a, b) => b.similarity - a.similarity);
    }
    await client.query("COMMIT");
    const nowMs = Date.now();
    return hits
      .filter((hit) => hit.similarity >= MIN_SEMANTIC_SIMILARITY)
      .map((hit) => rankSemanticHit(hit, nowMs))
      .sort((a, b) => (b.relevanceScore ?? b.similarity) - (a.relevanceScore ?? a.similarity))
      .slice(0, limit);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Explicit historical artifact retrieval. General current retrieval above only
 * admits the current DocumentVersion; callers must name an old version here. */
export async function querySemanticDocumentVersion(
  tenantId: string,
  documentId: string,
  documentVersionId: string,
  query: string,
  limit = 5,
  embedder: EmbeddingProvider = defaultEmbedder(),
): Promise<SemanticHit[]> {
  const [qvec] = await embedManyCached(tenantId, [query], embedder);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = finnor_os, public");
    await client.query("SET LOCAL statement_timeout = 10000");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows: ext } = await client.query(`SELECT 1 FROM pg_extension WHERE extname='vector'`);
    const params = [tenantId, JSON.stringify(qvec), documentId, documentVersionId, Math.max(limit * 3, limit)];
    const { rows } = ext.length > 0
      ? await client.query(
          `SELECT id,chunk,source_doc_id,document_id,document_version_id,content_hash,source_kind,provenance,
                  entity_refs,occurred_at,1-(embedding <=> $2::vector) AS similarity
             FROM embeddings
            WHERE tenant_id=$1 AND document_id=$3 AND document_version_id=$4
              AND embedding IS NOT NULL
            ORDER BY embedding <=> $2::vector LIMIT $5`,
          params,
        )
      : await client.query(
          `SELECT id,chunk,source_doc_id,document_id,document_version_id,content_hash,source_kind,provenance,
                  entity_refs,occurred_at,embedding
             FROM embeddings
            WHERE tenant_id=$1 AND document_id=$2 AND document_version_id=$3
              AND embedding IS NOT NULL`,
          [tenantId, documentId, documentVersionId],
        );
    await client.query("COMMIT");
    const hits = rows.map((row) => {
      const similarity = ext.length > 0
        ? Number(row.similarity)
        : qvec!.reduce((sum, value, index) => {
            const vector = (typeof row.embedding === "string" ? JSON.parse(row.embedding) : row.embedding) as number[];
            return sum + value * (vector[index] ?? 0);
          }, 0);
      return {
        id: row.id as string,
        chunk: row.chunk as string,
        sourceDocId: (row.source_doc_id as string | null) ?? null,
        documentId: (row.document_id as string | null) ?? null,
        documentVersionId: (row.document_version_id as string | null) ?? null,
        similarity,
        contentHash: row.content_hash as string,
        sourceKind: row.source_kind as string,
        provenance: (row.provenance as Record<string, unknown> | null) ?? {},
        occurredAt: (row.occurred_at as Date | null)?.toISOString?.(),
        entityRefs: (row.entity_refs as unknown[] | null) ?? [],
      } satisfies SemanticHit;
    });
    return hits
      .filter((hit) => hit.similarity >= MIN_SEMANTIC_SIMILARITY)
      .map((hit) => rankSemanticHit(hit, Date.now()))
      .sort((left, right) => (right.relevanceScore ?? right.similarity) - (left.relevanceScore ?? left.similarity))
      .slice(0, limit);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
