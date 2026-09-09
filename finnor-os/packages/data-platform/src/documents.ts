import { documents, documentContents, type Db } from "@finnor/db";
import { and, eq, sql } from "drizzle-orm";
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

/** Idempotent Core Document identity for a provider-observed file. The provider
 * package never calls this; vertical mapping decides whether an observation is a
 * real file and Core keeps canonical Document ownership. */
export async function ensureProviderDocumentTx(db: Db, params: {
  tenantId: string;
  provider: string;
  externalId: string;
  kind: string;
  title: string;
  storageRef?: string | null;
  createdBy: string;
}): Promise<{ documentId: string; created: boolean; changed: boolean }> {
  if (params.provider !== "microsoft_graph") throw new Error("Provider Document identity is not registered");
  if (!params.externalId.trim() || !params.title.trim()) throw new Error("Provider Document identity and title are required");
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.tenantId}:${params.provider}:${params.externalId}`}, 919))`);
  const [existing] = await db.select().from(documents).where(and(
    eq(documents.tenantId, params.tenantId),
    eq(documents.sourceSystem, params.provider),
    eq(documents.externalId, params.externalId),
  )).limit(1);
  if (existing) {
    const changed = existing.kind !== params.kind || existing.title !== params.title || existing.storageRef !== (params.storageRef ?? null);
    if (changed) {
      await db.update(documents).set({
        kind: params.kind,
        title: params.title,
        storageRef: params.storageRef ?? null,
      }).where(and(eq(documents.tenantId, params.tenantId), eq(documents.id, existing.id)));
    }
    return { documentId: existing.id, created: false, changed };
  }
  const [created] = await db.insert(documents).values({
    tenantId: params.tenantId,
    kind: params.kind,
    title: params.title,
    storageRef: params.storageRef ?? null,
    sourceSystem: params.provider,
    externalId: params.externalId,
    createdBy: params.createdBy,
  }).onConflictDoNothing().returning({ id: documents.id });
  if (created) return { documentId: created.id, created: true, changed: true };
  const [raced] = await db.select({ id: documents.id }).from(documents).where(and(
    eq(documents.tenantId, params.tenantId),
    eq(documents.sourceSystem, params.provider),
    eq(documents.externalId, params.externalId),
  )).limit(1);
  if (!raced) throw new Error("Provider Document replay claim disappeared");
  return { documentId: raced.id, created: false, changed: false };
}

export interface RecordDocumentContentParams {
  tenantId: string;
  documentId: string;
  bytes: Buffer;
  contentType?: string;
}

/** Compatibility projection. The database captures each changed byte state in
 * immutable document_versions in this same transaction; historical bytes are
 * never overwritten. Identical retries retain the current immutable version. */
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
  const current = await db.execute(sql`SELECT c.bytes,c.media_type FROM finnor_os.document_version_heads h
    JOIN finnor_os.document_version_contents c ON c.tenant_id=h.tenant_id AND c.version_id=h.version_id
    WHERE h.document_id=${documentId}::uuid AND h.kind='current' AND h.head_key='default'`);
  if (current.rows[0]) return { bytes: Buffer.from(current.rows[0].bytes as Buffer), contentType: current.rows[0].media_type as string };
  const [row] = await db.select().from(documentContents).where(eq(documentContents.documentId, documentId));
  if (!row) return null;
  return { bytes: row.bytes, contentType: row.contentType };
}
