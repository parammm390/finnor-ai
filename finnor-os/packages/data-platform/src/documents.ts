import { documents, documentContents, type Db } from "@finnor/db";
import { eq } from "drizzle-orm";
import { recordBusinessEvent } from "./events";

export interface CreateDocumentParams {
  tenantId: string;
  kind: string;
  title: string;
  storageRef?: string;
  provenance?: { sourceSystem: string; externalId?: string; createdBy?: string };
}

export async function createDocument(db: Db, params: CreateDocumentParams): Promise<{ documentId: string }> {
  const [doc] = await db
    .insert(documents)
    .values({
      tenantId: params.tenantId,
      kind: params.kind,
      title: params.title,
      storageRef: params.storageRef ?? null,
      sourceSystem: params.provenance?.sourceSystem ?? null,
      externalId: params.provenance?.externalId ?? null,
      createdBy: params.provenance?.createdBy ?? null,
    })
    .returning();
  await recordBusinessEvent(db, {
    tenantId: params.tenantId,
    entityType: "document",
    entityId: doc!.id,
    eventType: "document_created",
    payload: { kind: params.kind },
  });
  return { documentId: doc!.id };
}

export interface RecordDocumentContentParams {
  tenantId: string;
  documentId: string;
  bytes: Buffer;
  contentType?: string;
}

/** Persists real document bytes (Postgres-backed — see packages/db/columns.ts's
 *  bytea helper). Idempotent: re-generating the same document (same idempotency key
 *  upstream, same documentId) overwrites in place rather than erroring or duplicating. */
export async function recordDocumentContent(db: Db, params: RecordDocumentContentParams): Promise<void> {
  await db
    .insert(documentContents)
    .values({
      documentId: params.documentId,
      tenantId: params.tenantId,
      contentType: params.contentType ?? "application/pdf",
      bytes: params.bytes,
      sizeBytes: params.bytes.byteLength,
    })
    .onConflictDoUpdate({
      target: documentContents.documentId,
      set: { bytes: params.bytes, sizeBytes: params.bytes.byteLength, contentType: params.contentType ?? "application/pdf" },
    });
}

export async function getDocumentContent(db: Db, documentId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const [row] = await db.select().from(documentContents).where(eq(documentContents.documentId, documentId));
  if (!row) return null;
  return { bytes: row.bytes, contentType: row.contentType };
}
