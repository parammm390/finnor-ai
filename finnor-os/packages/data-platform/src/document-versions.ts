import {sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import type {Db} from '@finnor/db';
export const MAX_DOCUMENT_VERSION_BYTES=10_485_760;
export type DocumentFormat='xlsx'|'xlsm'|'docx'|'pptx'|'pdf'|'unknown';
export type DocumentVersionOrigin='baseline'|'legacy_write'|'provider_observation'|'manual_upload'|'finnor_edit'|'finnor_generated'|'template_instantiation'|'merge'|'readback';
export interface DocumentVersion {id:string;tenant_id:string;document_id:string;version_ordinal:number;parent_version_id:string|null;origin:DocumentVersionOrigin;format:DocumentFormat;media_type:string;source_system:string|null;source_ref:string|null;provider_version_id:string|null;provider_etag:string|null;provider_ctag:string|null;byte_sha256:string;size_bytes:number;created_by:string;created_at:Date}
export interface DocumentVersionContent {storageBackend:'postgres'|'external';storageRef:string|null;bytes:Buffer|null;mediaType:string;sizeBytes:number;sha256:string}
export interface DocumentVersionContentStore {
 readonly backend:'postgres';
 put(db:Db,input:{tenantId:string;versionId:string;bytes:Buffer;mediaType:string;sha256:string}):Promise<void>;
 get(db:Db,input:{tenantId:string;versionId:string}):Promise<DocumentVersionContent|null>;
}
export const postgresDocumentVersionContentStore:DocumentVersionContentStore={
 backend:'postgres',
 async put(db,input){await db.execute(sql`INSERT INTO finnor_os.document_version_contents(tenant_id,version_id,storage_backend,storage_ref,bytes,media_type,size_bytes,sha256) VALUES(${input.tenantId}::uuid,${input.versionId}::uuid,'postgres',NULL,${input.bytes},${input.mediaType},${input.bytes.length},${input.sha256})`);},
 async get(db,input){const result=await db.execute(sql`SELECT storage_backend,storage_ref,bytes,media_type,size_bytes,sha256 FROM finnor_os.document_version_contents WHERE tenant_id=${input.tenantId}::uuid AND version_id=${input.versionId}::uuid`);const row=result.rows[0];if(!row)return null;return {storageBackend:row.storage_backend as 'postgres'|'external',storageRef:(row.storage_ref as string|null)??null,bytes:row.bytes===null?null:Buffer.from(row.bytes as Buffer),mediaType:String(row.media_type),sizeBytes:Number(row.size_bytes),sha256:String(row.sha256)};},
};
export async function listDocumentVersions(db:Db,tenantId:string,documentId:string,limit=100):Promise<DocumentVersion[]> {
 const r=await db.execute(sql`SELECT * FROM finnor_os.document_versions WHERE tenant_id=${tenantId}::uuid AND document_id=${documentId}::uuid ORDER BY version_ordinal DESC LIMIT ${Math.min(Math.max(limit,1),100)}`);return r.rows as unknown as DocumentVersion[];
}
export async function loadDocumentVersion(db:Db,tenantId:string,documentId:string,versionId:string):Promise<{version:DocumentVersion;bytes:Buffer}|null>{
 const result=await db.execute(sql`SELECT v.* FROM finnor_os.document_versions v WHERE v.tenant_id=${tenantId}::uuid AND v.document_id=${documentId}::uuid AND v.id=${versionId}::uuid`);const row=result.rows[0];if(!row)return null;const content=await postgresDocumentVersionContentStore.get(db,{tenantId,versionId});if(!content)throw new Error('DOCUMENT_VERSION_CONTENT_MISSING');if(content.storageBackend!=='postgres'||!content.bytes)throw new Error('DOCUMENT_VERSION_CONTENT_BACKEND_UNAVAILABLE');return {version:row as unknown as DocumentVersion,bytes:content.bytes};
}
export async function documentHeads(db:Db,tenantId:string,documentId:string){const r=await db.execute(sql`SELECT kind,head_key,version_id,updated_at FROM finnor_os.document_version_heads WHERE tenant_id=${tenantId}::uuid AND document_id=${documentId}::uuid ORDER BY kind,head_key`);return r.rows as unknown as Array<{kind:string;head_key:string;version_id:string;updated_at:Date}>;}
/** Caller must use Core withTenant/withTenantTransaction. Exact bytes are immutable,
 * while current/draft/provider heads are separate compare-and-swap projections. */
export async function appendDocumentVersion(db:Db,input:{tenantId:string;documentId:string;bytes:Buffer;mediaType:string;format:DocumentFormat;origin:DocumentVersionOrigin;actor:string;parentVersionId?:string;sourceSystem?:string;sourceRef?:string;providerVersionId?:string;providerEtag?:string;providerCtag?:string;head?:{kind:'current'|'provider'|'draft'|'published';key:string;expectedVersionId:string|null}}):Promise<DocumentVersion>{
 if(input.bytes.length>MAX_DOCUMENT_VERSION_BYTES)throw new Error('ARTIFACT_TOO_LARGE');
 const doc=await db.execute(sql`SELECT id FROM finnor_os.documents WHERE tenant_id=${input.tenantId}::uuid AND id=${input.documentId}::uuid AND archived_at IS NULL FOR UPDATE`);if(!doc.rows.length)throw new Error('DOCUMENT_NOT_FOUND');
 if(input.head){const result=await db.execute(sql`SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=${input.tenantId}::uuid AND document_id=${input.documentId}::uuid AND kind=${input.head.kind} AND head_key=${input.head.key}`);const head=(result.rows[0]?.version_id as string|undefined)??null;if(head!==input.head.expectedVersionId)throw new Error('STALE_BRANCH_HEAD');}
 const hash=createHash('sha256').update(input.bytes).digest('hex');
 const existing=await db.execute(sql`SELECT * FROM finnor_os.document_versions WHERE tenant_id=${input.tenantId}::uuid AND document_id=${input.documentId}::uuid AND byte_sha256=${hash} AND media_type=${input.mediaType} AND origin=${input.origin} AND parent_version_id IS NOT DISTINCT FROM ${input.parentVersionId??null}::uuid AND source_ref IS NOT DISTINCT FROM ${input.sourceRef??null} AND provider_etag IS NOT DISTINCT FROM ${input.providerEtag??null} AND provider_version_id IS NOT DISTINCT FROM ${input.providerVersionId??null} ORDER BY version_ordinal DESC LIMIT 1`);
 let version=existing.rows[0] as unknown as DocumentVersion|undefined;
 if(!version){const result=await db.execute(sql`INSERT INTO finnor_os.document_versions(tenant_id,document_id,version_ordinal,parent_version_id,origin,format,media_type,source_system,source_ref,provider_version_id,provider_etag,provider_ctag,byte_sha256,size_bytes,created_by) SELECT ${input.tenantId}::uuid,${input.documentId}::uuid,COALESCE(max(version_ordinal),0)+1,${input.parentVersionId??null}::uuid,${input.origin},${input.format},${input.mediaType},${input.sourceSystem??null},${input.sourceRef??null},${input.providerVersionId??null},${input.providerEtag??null},${input.providerCtag??null},${hash},${input.bytes.length},${input.actor} FROM finnor_os.document_versions WHERE tenant_id=${input.tenantId}::uuid AND document_id=${input.documentId}::uuid RETURNING *`);version=result.rows[0] as unknown as DocumentVersion;
 await postgresDocumentVersionContentStore.put(db,{tenantId:input.tenantId,versionId:version.id,bytes:input.bytes,mediaType:input.mediaType,sha256:hash});
 if(input.parentVersionId)await db.execute(sql`INSERT INTO finnor_os.artifact_lineage_edges(tenant_id,source_version_id,target_version_id,relation) VALUES(${input.tenantId}::uuid,${input.parentVersionId}::uuid,${version.id}::uuid,'supersedes') ON CONFLICT DO NOTHING`);
 }
 if(input.head)await db.execute(sql`INSERT INTO finnor_os.document_version_heads(tenant_id,document_id,kind,head_key,version_id) VALUES(${input.tenantId}::uuid,${input.documentId}::uuid,${input.head.kind},${input.head.key},${version.id}::uuid) ON CONFLICT(tenant_id,document_id,kind,head_key) DO UPDATE SET version_id=EXCLUDED.version_id,updated_at=clock_timestamp()`);
 return version;
}

export async function setDocumentVersionHead(db:Db,input:{tenantId:string;documentId:string;kind:'current'|'provider'|'draft'|'published';key:string;versionId:string;expectedVersionId:string|null}):Promise<void>{
 const existing=await db.execute(sql`SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=${input.tenantId}::uuid AND document_id=${input.documentId}::uuid AND kind=${input.kind} AND head_key=${input.key}`);const current=(existing.rows[0]?.version_id as string|undefined)??null;if(current!==input.expectedVersionId)throw new Error('STALE_BRANCH_HEAD');
 await db.execute(sql`INSERT INTO finnor_os.document_version_heads(tenant_id,document_id,kind,head_key,version_id) VALUES(${input.tenantId}::uuid,${input.documentId}::uuid,${input.kind},${input.key},${input.versionId}::uuid) ON CONFLICT(tenant_id,document_id,kind,head_key) DO UPDATE SET version_id=EXCLUDED.version_id,updated_at=clock_timestamp()`);
}
