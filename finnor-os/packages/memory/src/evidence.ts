// Source-backed evidence corpus and retrieval. This is intentionally separate from
// `business_events` (the operational ledger) and from semantic memory's embeddings:
// evidence keeps immutable source versions, bounded chunks, and reproducible research
// hits that can be cited later.

import { createHash } from "node:crypto";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import {
  evidenceChunks,
  evidenceSources,
  evidenceSourceVersions,
  getPool,
  researchRunHits,
  researchRuns,
  withTenant,
  type Db,
} from "@finnor/db";
import { defaultEmbedder, embedManyCached, type EmbeddingProvider } from "./semantic";

export type EvidenceScope = "tenant" | "public";
export type EvidenceSearchScope = EvidenceScope | "all";

export interface EvidenceEntityRef {
  type: string;
  id?: string;
  key?: string;
  label?: string;
  [key: string]: unknown;
}

export interface EvidenceTimeRef {
  kind?: string;
  occurredAt?: string;
  validFrom?: string;
  validTo?: string;
  [key: string]: unknown;
}

export interface EvidenceChunkText {
  content: string;
  tokenCount: number;
  entityRefs: EvidenceEntityRef[];
  timeRefs: EvidenceTimeRef[];
}

export interface EvidenceSourceInput {
  sourceKey: string;
  sourceType: string;
  title: string;
  canonicalUrl?: string;
  publisher?: string;
  metadata?: Record<string, unknown>;
  scope?: EvidenceScope;
}

export interface EvidenceVersionInput {
  content: string;
  snapshot?: Record<string, unknown>;
  asOf?: Date;
  retrievedAt?: Date;
  entityRefs?: EvidenceEntityRef[];
  timeRefs?: EvidenceTimeRef[];
  embeddingProvider?: EmbeddingProvider;
  embeddings?: number[][];
}

export interface EvidenceVersionResult {
  sourceId: string;
  versionId: string;
  versionNumber: number;
  chunks: number;
  contentHash: string;
}

export interface ResearchRunInput {
  query: string;
  asOf?: Date;
  searchConfig?: Record<string, unknown>;
}

export interface EvidenceCitation {
  source: string;
  sourceId: string;
  sourceKey: string;
  sourceTitle: string;
  sourceUrl: string | null;
  version: number;
  versionId: string;
  asOf: string;
  excerpt: string;
  chunkId: string;
  ordinal: number;
  scope: EvidenceScope;
}

export interface EvidenceCandidate {
  chunkId: string;
  sourceId: string;
  sourceKey: string;
  sourceTitle: string;
  sourceUrl: string | null;
  versionId: string;
  versionNumber: number;
  asOf: string;
  scope: EvidenceScope;
  ordinal: number;
  content: string;
  entityRefs: EvidenceEntityRef[];
  timeRefs: EvidenceTimeRef[];
  lexicalScore?: number;
  vectorScore?: number;
  fusedScore?: number;
}

export interface EvidenceHit extends EvidenceCandidate {
  fusedScore: number;
  citation: EvidenceCitation;
}

export interface EvidenceSearchResult {
  hits: EvidenceHit[];
  citations: EvidenceCitation[];
}

export interface EvidenceSearchInput {
  tenantId: string;
  query: string;
  limit?: number;
  candidateLimit?: number;
  scope?: EvidenceSearchScope;
  asOf?: Date;
  researchRunId?: string;
  embeddingProvider?: EmbeddingProvider;
}

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_MIN_TOKENS = 200;
const DEFAULT_EXCERPT_CHARS = 420;
const DEFAULT_RRF_K = 60;

function tokenCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** A bounded, deterministic chunker for source snapshots. It never emits an empty
 * chunk and merges a short tail when the merge remains within the hard bound. */
export function chunkEvidenceText(
  text: string,
  opts: { minTokens?: number; maxTokens?: number } = {},
): string[] {
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(minTokens) || minTokens < 1 || minTokens > maxTokens) throw new Error("Invalid evidence chunk token bounds");
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const raw: string[] = [];
  for (let i = 0; i < words.length; i += maxTokens) raw.push(words.slice(i, i + maxTokens).join(" "));
  const merged: string[] = [];
  for (const chunk of raw) {
    const previous = merged.at(-1);
    if (previous && tokenCount(chunk) < minTokens && tokenCount(previous) + tokenCount(chunk) <= maxTokens) {
      merged[merged.length - 1] = `${previous} ${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

export function excerptForEvidence(content: string, maxChars = DEFAULT_EXCERPT_CHARS): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sourceScopeWhere(tenantId: string, scope: EvidenceScope) {
  return scope === "tenant"
    ? and(eq(evidenceSources.scope, "tenant"), eq(evidenceSources.tenantId, tenantId))
    : and(eq(evidenceSources.scope, "public"), isNull(evidenceSources.tenantId));
}

/** Creates tenant-owned source metadata. Public-cache writes are intentionally not
 * exposed through the normal tenant service; a privileged ingestion process must
 * populate ownerless public rows. */
export async function createEvidenceSource(tenantId: string, input: EvidenceSourceInput): Promise<{ id: string; scope: EvidenceScope }> {
  const scope = input.scope ?? "tenant";
  if (scope === "public") {
    throw new Error("Public evidence writes require a privileged cache-ingestion process");
  }
  return withTenant(tenantId, async (db) => {
    const [existing] = await db
      .select({ id: evidenceSources.id, scope: evidenceSources.scope })
      .from(evidenceSources)
      .where(and(sourceScopeWhere(tenantId, scope), eq(evidenceSources.sourceKey, input.sourceKey)))
      .limit(1);
    if (existing) return { id: existing.id, scope: existing.scope as EvidenceScope };
    const [row] = await db
      .insert(evidenceSources)
      .values({
        scope,
        tenantId: scope === "tenant" ? tenantId : null,
        sourceKey: input.sourceKey,
        sourceType: input.sourceType,
        canonicalUrl: input.canonicalUrl ?? null,
        title: input.title,
        publisher: input.publisher ?? null,
        metadata: input.metadata ?? {},
      })
      .returning({ id: evidenceSources.id, scope: evidenceSources.scope });
    if (!row) throw new Error("Evidence source insert returned no row");
    return { id: row.id, scope: row.scope as EvidenceScope };
  });
}

/** Core Evidence transaction seam for callers that must atomically persist a wider
 * observation outcome. It retains the same tenant ownership and idempotent source
 * identity as createEvidenceSource without opening a nested transaction. */
export async function createEvidenceSourceTx(
  db: Db,
  tenantId: string,
  input: EvidenceSourceInput,
): Promise<{ id: string; scope: EvidenceScope }> {
  const scope = input.scope ?? "tenant";
  if (scope !== "tenant") throw new Error("Public evidence writes require a privileged cache-ingestion process");
  const [existing] = await db
    .select({ id: evidenceSources.id, scope: evidenceSources.scope })
    .from(evidenceSources)
    .where(and(sourceScopeWhere(tenantId, scope), eq(evidenceSources.sourceKey, input.sourceKey)))
    .limit(1);
  if (existing) return { id: existing.id, scope: existing.scope as EvidenceScope };
  const [row] = await db.insert(evidenceSources).values({
    scope,
    tenantId,
    sourceKey: input.sourceKey,
    sourceType: input.sourceType,
    canonicalUrl: input.canonicalUrl ?? null,
    title: input.title,
    publisher: input.publisher ?? null,
    metadata: input.metadata ?? {},
  }).onConflictDoNothing().returning({ id: evidenceSources.id, scope: evidenceSources.scope });
  if (row) return { id: row.id, scope: row.scope as EvidenceScope };
  const [raced] = await db.select({ id: evidenceSources.id, scope: evidenceSources.scope }).from(evidenceSources)
    .where(and(sourceScopeWhere(tenantId, scope), eq(evidenceSources.sourceKey, input.sourceKey))).limit(1);
  if (!raced) throw new Error("Evidence source insert returned no row");
  return { id: raced.id, scope: raced.scope as EvidenceScope };
}

function storageSafeChunks(content: string): EvidenceChunkText[] {
  const logical = chunkEvidenceText(content);
  const stored: EvidenceChunkText[] = [];
  for (const chunk of logical) {
    for (let offset = 0; offset < chunk.length; offset += 24_000) {
      const part = chunk.slice(offset, offset + 24_000).trim();
      if (part) stored.push({ content: part, tokenCount: Math.min(600, Math.max(1, tokenCount(part))), entityRefs: [], timeRefs: [] });
    }
  }
  return stored;
}

/** Append-only Core Evidence version inside an existing tenant transaction. Network
 * embedding is intentionally unavailable here; transaction callers must keep remote
 * work outside Postgres and may supply already-computed vectors if ever required. */
export async function appendEvidenceVersionTx(
  db: Db,
  tenantId: string,
  sourceId: string,
  input: Omit<EvidenceVersionInput, "embeddingProvider">,
): Promise<EvidenceVersionResult> {
  const content = input.content.trim();
  if (!content) throw new Error("Evidence version content cannot be empty");
  if (Buffer.byteLength(content, "utf8") > 262_144) throw new Error("Evidence version content exceeds the 262144-byte transaction bound");
  const snapshot = input.snapshot ?? {};
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (snapshotBytes > 262_144) throw new Error("Evidence snapshot exceeds the 262144-byte transaction bound");
  const hash = contentHash(content);
  const chunks = storageSafeChunks(content).map((chunk) => ({
    ...chunk,
    entityRefs: input.entityRefs ?? [],
    timeRefs: input.timeRefs ?? [],
  }));
  if (!chunks.length) throw new Error("Evidence version produced no chunks");
  if (input.embeddings?.length && input.embeddings.length !== chunks.length) {
    throw new Error("Evidence embeddings must match chunk count");
  }
  const [source] = await db.select().from(evidenceSources).where(and(
    eq(evidenceSources.id, sourceId),
    eq(evidenceSources.scope, "tenant"),
    eq(evidenceSources.tenantId, tenantId),
  )).limit(1);
  if (!source) throw new Error("Evidence source is not visible in this tenant context");
  await db.execute(sql`SELECT id FROM ${evidenceSources} WHERE ${evidenceSources.id}=${sourceId} FOR UPDATE`);
  const [existing] = await db.select({ id: evidenceSourceVersions.id, versionNumber: evidenceSourceVersions.versionNumber })
    .from(evidenceSourceVersions).where(and(
      eq(evidenceSourceVersions.sourceId, sourceId),
      eq(evidenceSourceVersions.contentHash, hash),
    )).limit(1);
  if (existing) {
    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(evidenceChunks)
      .where(eq(evidenceChunks.versionId, existing.id));
    return { sourceId, versionId: existing.id, versionNumber: existing.versionNumber, chunks: Number(countRow?.count ?? 0), contentHash: hash };
  }
  const [previous] = await db.select({ versionNumber: max(evidenceSourceVersions.versionNumber) })
    .from(evidenceSourceVersions).where(eq(evidenceSourceVersions.sourceId, sourceId));
  const versionNumber = Number(previous?.versionNumber ?? 0) + 1;
  const [version] = await db.insert(evidenceSourceVersions).values({
    sourceId,
    scope: "tenant",
    tenantId,
    versionNumber,
    contentHash: hash,
    content,
    snapshot,
    asOf: input.asOf ?? new Date(),
    retrievedAt: input.retrievedAt ?? new Date(),
  }).returning({ id: evidenceSourceVersions.id });
  if (!version) throw new Error("Evidence version insert returned no row");
  await db.insert(evidenceChunks).values(chunks.map((chunk, index) => ({
    sourceId,
    versionId: version.id,
    scope: "tenant" as const,
    tenantId,
    ordinal: index + 1,
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    entityRefs: chunk.entityRefs,
    timeRefs: chunk.timeRefs,
    ...(input.embeddings?.[index] ? { embedding: input.embeddings[index] } : {}),
  })));
  return { sourceId, versionId: version.id, versionNumber, chunks: chunks.length, contentHash: hash };
}

/** Appends one immutable source version and its bounded chunks. Embeddings are
 * caller-supplied or produced only when an explicit provider is passed, so lexical
 * evidence remains ingestible while an embedding integration is unavailable. */
export async function appendEvidenceVersion(
  tenantId: string,
  sourceId: string,
  input: EvidenceVersionInput,
): Promise<EvidenceVersionResult> {
  const content = input.content.trim();
  if (!content) throw new Error("Evidence version content cannot be empty");
  const hash = contentHash(content);
  if (input.snapshot && typeof input.snapshot !== "object") throw new Error("Evidence snapshot must be an object");
  const chunks = chunkEvidenceText(content).map((chunk) => ({
    content: chunk,
    tokenCount: tokenCount(chunk),
    entityRefs: input.entityRefs ?? [],
    timeRefs: input.timeRefs ?? [],
  }));
  if (chunks.length === 0) throw new Error("Evidence version produced no chunks");

  return withTenant(tenantId, async (db) => {
    const [source] = await db.select().from(evidenceSources).where(eq(evidenceSources.id, sourceId)).limit(1);
    if (!source) throw new Error("Evidence source is not visible in this tenant context");
    if (source.scope !== "tenant" || source.tenantId !== tenantId) {
      throw new Error("Public evidence ingestion requires a privileged cache-ingestion process");
    }

    const [existing] = await db
      .select({ id: evidenceSourceVersions.id, versionNumber: evidenceSourceVersions.versionNumber })
      .from(evidenceSourceVersions)
      .where(and(eq(evidenceSourceVersions.sourceId, sourceId), eq(evidenceSourceVersions.contentHash, hash)))
      .limit(1);
    if (existing) {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(evidenceChunks)
        .where(eq(evidenceChunks.versionId, existing.id));
      return {
        sourceId,
        versionId: existing.id,
        versionNumber: existing.versionNumber,
        chunks: Number(countRow?.count ?? 0),
        contentHash: hash,
      };
    }

    let vectors = input.embeddings ?? [];
    if (input.embeddingProvider) {
      vectors = await embedManyCached(tenantId, chunks.map((chunk) => chunk.content), input.embeddingProvider);
    }
    if (vectors.length > 0 && vectors.length !== chunks.length) throw new Error("Evidence embeddings must match chunk count");

    const [previous] = await db
      .select({ versionNumber: max(evidenceSourceVersions.versionNumber) })
      .from(evidenceSourceVersions)
      .where(eq(evidenceSourceVersions.sourceId, sourceId));
    const versionNumber = Number(previous?.versionNumber ?? 0) + 1;
    const [version] = await db
      .insert(evidenceSourceVersions)
      .values({
        sourceId,
        scope: source.scope,
        tenantId: source.tenantId,
        versionNumber,
        contentHash: hash,
        content,
        snapshot: input.snapshot ?? {},
        asOf: input.asOf ?? new Date(),
        retrievedAt: input.retrievedAt ?? new Date(),
      })
      .returning({ id: evidenceSourceVersions.id });
    if (!version) throw new Error("Evidence version insert returned no row");

    const rows = chunks.map((chunk, index) => ({
      sourceId,
      versionId: version.id,
      scope: source.scope,
      tenantId: source.tenantId,
      ordinal: index + 1,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      entityRefs: chunk.entityRefs,
      timeRefs: chunk.timeRefs,
      ...(vectors[index] ? { embedding: vectors[index] } : {}),
    }));
    await db.insert(evidenceChunks).values(rows);
    return { sourceId, versionId: version.id, versionNumber, chunks: rows.length, contentHash: hash };
  });
}

export async function startResearchRun(tenantId: string, input: ResearchRunInput): Promise<string> {
  if (!input.query.trim()) throw new Error("Research query cannot be empty");
  const [row] = await withTenant(tenantId, (db) =>
    db
      .insert(researchRuns)
      .values({ query: input.query.trim(), asOf: input.asOf ?? new Date(), searchConfig: input.searchConfig ?? {}, tenantId })
      .returning({ id: researchRuns.id }),
  );
  if (!row) throw new Error("Research run insert returned no row");
  return row.id;
}

export async function finishResearchRun(
  tenantId: string,
  runId: string,
  status: "completed" | "failed",
  error?: string,
): Promise<void> {
  await withTenant(tenantId, (db) =>
    db
      .update(researchRuns)
      .set({ status, error: error ?? null, completedAt: new Date() })
      .where(and(eq(researchRuns.id, runId), eq(researchRuns.tenantId, tenantId))),
  );
}

interface EvidenceRow extends EvidenceCandidate {
  embedding?: unknown;
}

function asDate(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapEvidenceRow(row: Record<string, unknown>): EvidenceRow {
  return {
    chunkId: String(row.chunk_id),
    sourceId: String(row.source_id),
    sourceKey: String(row.source_key),
    sourceTitle: String(row.source_title),
    sourceUrl: (row.source_url as string | null) ?? null,
    versionId: String(row.version_id),
    versionNumber: Number(row.version_number),
    asOf: asDate(row.as_of),
    scope: row.scope as EvidenceScope,
    ordinal: Number(row.ordinal),
    content: String(row.content),
    entityRefs: parseJsonArray(row.entity_refs) as EvidenceEntityRef[],
    timeRefs: parseJsonArray(row.time_refs) as EvidenceTimeRef[],
    embedding: row.embedding,
    ...(row.lexical_score == null ? {} : { lexicalScore: Number(row.lexical_score) }),
    ...(row.vector_score == null ? {} : { vectorScore: Number(row.vector_score) }),
  };
}

function scopeSql(scope: EvidenceSearchScope): string {
  if (scope === "tenant") return "c.scope = 'tenant' AND c.tenant_id = $1";
  if (scope === "public") return "c.scope = 'public'";
  return "(c.scope = 'public' OR c.tenant_id = $1)";
}

function latestAsOfSql(): string {
  return `v.id = (
    SELECT latest.id FROM finnor_os.evidence_source_versions latest
    WHERE latest.source_id = c.source_id AND latest.as_of <= $3
    ORDER BY latest.version_number DESC LIMIT 1
  )`;
}

function baseEvidenceSelect(scope: EvidenceSearchScope): string {
  return `
    SELECT c.id::text AS chunk_id, c.source_id::text AS source_id,
      s.source_key, s.title AS source_title, s.canonical_url AS source_url,
      c.version_id::text AS version_id, v.version_number, v.as_of,
      c.scope, c.ordinal, c.content, c.entity_refs, c.time_refs, c.embedding
    FROM finnor_os.evidence_chunks c
    JOIN finnor_os.evidence_sources s ON s.id = c.source_id
    JOIN finnor_os.evidence_source_versions v ON v.id = c.version_id
    WHERE ${scopeSql(scope)} AND ${latestAsOfSql()}`;
}

/** Reciprocal-rank fusion keeps lexical matches useful when embeddings are absent,
 * and lets vector matches rescue vocabulary mismatches without pretending scores from
 * the two systems share a scale. */
export function fuseEvidenceCandidates(
  lexical: EvidenceCandidate[],
  vector: EvidenceCandidate[],
  opts: { limit?: number; rrfK?: number } = {},
): EvidenceCandidate[] {
  const rrfK = opts.rrfK ?? DEFAULT_RRF_K;
  const merged = new Map<string, EvidenceCandidate>();
  lexical.forEach((candidate, index) => {
    const current = merged.get(candidate.chunkId) ?? { ...candidate };
    current.lexicalScore = candidate.lexicalScore;
    current.fusedScore = (current.fusedScore ?? 0) + 1 / (rrfK + index + 1);
    merged.set(candidate.chunkId, current);
  });
  vector.forEach((candidate, index) => {
    const current = merged.get(candidate.chunkId) ?? { ...candidate };
    current.vectorScore = candidate.vectorScore;
    current.fusedScore = (current.fusedScore ?? 0) + 1 / (rrfK + index + 1);
    merged.set(candidate.chunkId, current);
  });
  return [...merged.values()]
    .sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0) || a.chunkId.localeCompare(b.chunkId))
    .slice(0, opts.limit ?? 5);
}

function toCitation(hit: EvidenceCandidate): EvidenceCitation {
  return {
    source: hit.sourceKey,
    sourceId: hit.sourceId,
    sourceKey: hit.sourceKey,
    sourceTitle: hit.sourceTitle,
    sourceUrl: hit.sourceUrl,
    version: hit.versionNumber,
    versionId: hit.versionId,
    asOf: hit.asOf,
    excerpt: excerptForEvidence(hit.content),
    chunkId: hit.chunkId,
    ordinal: hit.ordinal,
    scope: hit.scope,
  };
}

/** Runs lexical retrieval, optional pgvector retrieval, and records exact hits for a
 * research run when supplied. DB failures in the vector leg do not erase lexical
 * evidence; callers still get a useful citation-backed result. */
export async function searchEvidence(input: EvidenceSearchInput): Promise<EvidenceSearchResult> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 50);
  const candidateLimit = Math.min(Math.max(input.candidateLimit ?? Math.max(limit * 4, 20), limit), 200);
  const asOf = input.asOf ?? new Date();
  const lexical: EvidenceCandidate[] = [];
  const vector: EvidenceCandidate[] = [];

  let queryVector: number[] | null = null;
  const provider = input.embeddingProvider ?? defaultEmbedder();
  try {
    const [embedded] = await embedManyCached(input.tenantId, [input.query], provider);
    queryVector = embedded ?? null;
  } catch {
    queryVector = null;
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = finnor_os, public");
    await client.query("SET LOCAL statement_timeout = 10000");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
    const params = [input.tenantId, input.query, asOf.toISOString(), candidateLimit];
    const base = baseEvidenceSelect(input.scope ?? "all");
    if (input.query.trim()) {
      const result = await client.query(
        `${base.replace("c.scope, c.ordinal, c.content, c.entity_refs, c.time_refs, c.embedding", "c.scope, c.ordinal, c.content, c.entity_refs, c.time_refs, c.embedding, ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', $2)) AS lexical_score")} AND c.search_vector @@ websearch_to_tsquery('simple', $2)
         ORDER BY ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', $2)) DESC, c.id
         LIMIT $4`,
        params,
      );
      lexical.push(
        ...result.rows.map((row) => ({ ...mapEvidenceRow(row), lexicalScore: Number(row.lexical_score ?? 0) })),
      );
    }

    if (queryVector) {
      const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      if (extension.rowCount) {
        const result = await client.query(
          `${base.replace("c.scope, c.ordinal, c.content, c.entity_refs, c.time_refs, c.embedding", "c.scope, c.ordinal, c.content, c.entity_refs, c.time_refs, c.embedding, 1 - (c.embedding <=> $2::vector) AS vector_score")} AND c.embedding IS NOT NULL
           ORDER BY c.embedding <=> $2::vector, c.id
           LIMIT $4`,
          [input.tenantId, JSON.stringify(queryVector), asOf.toISOString(), candidateLimit],
        );
        vector.push(...result.rows.map((row) => ({ ...mapEvidenceRow(row), vectorScore: Number(row.vector_score ?? 0) })));
      } else {
        // Keep $2 typed in the no-pgvector fallback: `base` uses $1 (tenant) and
        // $3 (as-of), while the shared parameter layout reserves $2 for the query.
        // PostgreSQL rejects an otherwise-unused $2 because it cannot infer its type.
        const result = await client.query(`${base} AND c.embedding IS NOT NULL AND $2::text IS NOT NULL ORDER BY c.id LIMIT $4`, params);
        const scored = result.rows.map((row) => {
          const candidate = mapEvidenceRow(row);
          const embedding = parseJsonArray(row.embedding).map(Number);
          const similarity = queryVector!.reduce((sum, value, index) => sum + value * (embedding[index] ?? 0), 0);
          return { ...candidate, vectorScore: similarity };
        });
        vector.push(...scored.sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0)).slice(0, candidateLimit));
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const hits = fuseEvidenceCandidates(lexical, vector, { limit }).map((hit) => ({
    ...hit,
    fusedScore: hit.fusedScore ?? 0,
    citation: toCitation(hit),
  }));
  if (input.researchRunId && hits.length > 0) {
    await withTenant(input.tenantId, (db) =>
      db
        .insert(researchRunHits)
        .values(
          hits.map((hit, index) => ({
            tenantId: input.tenantId,
            researchRunId: input.researchRunId!,
            sourceId: hit.sourceId,
            versionId: hit.versionId,
            chunkId: hit.chunkId,
            scope: hit.scope,
            rank: index + 1,
            fusedScore: hit.fusedScore,
            lexicalScore: hit.lexicalScore ?? null,
            vectorScore: hit.vectorScore ?? null,
            excerpt: hit.citation.excerpt,
          })),
        )
        .onConflictDoNothing({ target: [researchRunHits.researchRunId, researchRunHits.chunkId] }),
    );
  }
  return { hits, citations: hits.map((hit) => hit.citation) };
}

export type EvidenceDb = Db;
