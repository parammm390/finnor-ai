// B3.T6 — ingest an explicitly approved public PDF as tenant-scoped semantic memory.
// The URL is deliberately the sourceDocId so receipt citations expose an exact,
// independently inspectable source rather than an opaque embedding-row identifier.

import { createHash } from "node:crypto";
import type { PDFParse } from "pdf-parse";
import { and, eq, like } from "drizzle-orm";
import { createDocument, recordDocumentContent } from "@finnor/data-platform";
import { documents, embeddings, withTenant } from "@finnor/db";
import { chunkSource } from "./chunking";
import { defaultEmbedder, type EmbeddingProvider, writeSemantic } from "./semantic";

export interface PublicReferenceSource {
  title: string;
  organization: string;
  url: string;
  sha256: string;
}

export interface IngestPublicReferenceResult {
  documentId: string;
  chunks: number;
  alreadyIngested: boolean;
}

/** Extracts text only after checking the byte-level checksum specified in the public
 * source manifest. It does not fetch arbitrary URLs and never treats a filename or
 * a generated test report as a reference source. */
export async function ingestPublicReferencePdf(params: {
  tenantId: string;
  source: PublicReferenceSource;
  bytes: Buffer;
  embedder?: EmbeddingProvider;
}): Promise<IngestPublicReferenceResult> {
  const actualHash = createHash("sha256").update(params.bytes).digest("hex");
  if (actualHash !== params.source.sha256) {
    throw new Error(`Checksum mismatch for ${params.source.url}; expected the manifest's SHA-256 before ingestion.`);
  }
  if (params.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`Reference source is not a PDF: ${params.source.url}`);
  }

  let parser: PDFParse | undefined;
  let text: string;
  try {
    // pdf-parse creates worker threads. Loading it through the @finnor/memory barrel
    // during Next's static generation made unrelated API routes start that machinery
    // and terminated the build worker. Corpus ingestion is an explicit operator job,
    // so defer the runtime import until this function actually receives verified PDF
    // bytes; the type-only import above preserves the public contract without loading
    // any parser code at module evaluation time.
    const { PDFParse } = await import("pdf-parse");
    parser = new PDFParse({ data: params.bytes });
    text = (await parser.getText()).text.trim();
  } finally {
    await parser?.destroy();
  }
  if (text.length < 300) throw new Error(`Reference PDF has too little extractable text: ${params.source.url}`);

  const [existingDocument] = await withTenant(params.tenantId, (db) =>
    db.select({ id: documents.id }).from(documents).where(and(eq(documents.tenantId, params.tenantId), eq(documents.externalId, params.source.url))).limit(1),
  );
  const documentId = existingDocument?.id ?? (await withTenant(params.tenantId, async (db) => {
    const created = await createDocument(db, {
      tenantId: params.tenantId,
      kind: "public_reference",
      title: params.source.title,
      storageRef: params.source.url,
      provenance: { sourceSystem: params.source.organization, externalId: params.source.url, createdBy: "b3_reference_corpus" },
    });
    return created.documentId;
  }));
  await withTenant(params.tenantId, (db) =>
    recordDocumentContent(db, { tenantId: params.tenantId, documentId, bytes: params.bytes, contentType: "application/pdf" }),
  );

  const [existingChunk] = await withTenant(params.tenantId, (db) =>
    db.select({ id: embeddings.id }).from(embeddings).where(and(eq(embeddings.tenantId, params.tenantId), like(embeddings.sourceDocId, `${params.source.url}#chunk=%`))).limit(1),
  );
  if (existingChunk) return { documentId, chunks: 0, alreadyIngested: true };

  const chunks = chunkSource({
    text,
    entityRefs: [{
      kind: "public_reference",
      documentId,
      sourceUrl: params.source.url,
      organization: params.source.organization,
      sha256: actualHash,
    }],
  }).map((chunk, index) => ({
    ...chunk,
    documentId,
    sourceDocId: `${params.source.url}#chunk=${index + 1}`,
    sourceKind: "reference_document",
    provenance: { documentId, sourceUrl: params.source.url, organization: params.source.organization, sha256: actualHash },
  }));
  const chunksWritten = await writeSemantic(params.tenantId, params.source.url, chunks, params.embedder ?? defaultEmbedder());
  return { documentId, chunks: chunksWritten, alreadyIngested: false };
}
