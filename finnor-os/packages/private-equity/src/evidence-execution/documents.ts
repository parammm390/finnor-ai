import {loadDocumentVersion} from '@finnor/data-platform';
import {withTenantTransaction} from '@finnor/db';
import type {EvidenceSource} from '@finnor/shared-types';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {authorize,sha,unavailable} from './store';
import {nativeBackend} from './backend';
import type {DocumentExtraction} from './documents-parser';
export async function extractDocumentRows(ctx:PeMutationContext,root:PeWorldRootRef,source:Extract<EvidenceSource,{kind:'artifact'}>,times:{knowledgeAt:string}):Promise<DocumentExtraction & {nativeInvocations:import('./backend').BackendReceipt[]}>{
 await authorize(ctx,root,[{type:'document',id:source.documentId}]);await authorize(ctx,source.subject as PeWorldRootRef);
 const loaded=await withTenantTransaction(ctx.auth.tenantId,{userId:ctx.auth.userId,readOnly:true,isolation:'repeatable read'},async(db,c)=>{
  const tracking=(await c.query("SELECT current_setting('track_commit_timestamp') enabled")).rows[0]?.enabled;if(tracking!=='on')throw Error('DOCUMENT_HISTORICAL_COMMIT_VISIBILITY_UNAVAILABLE');
  const document=(await c.query('SELECT id FROM finnor_os.documents WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',[ctx.auth.tenantId,source.documentId])).rows[0];if(!document)throw unavailable();
  const binding=(await c.query(`SELECT b.id FROM finnor_os.artifact_bindings b WHERE b.tenant_id=$1 AND b.version_id=$2 AND b.target_kind='canonical_entity' AND b.target_entity_type=$3 AND b.target_id=$4 AND b.created_at<=$5 AND pg_xact_commit_timestamp(b.xmin)<=$5`,[ctx.auth.tenantId,source.documentVersionId,source.subject.entityType,source.subject.entityId,times.knowledgeAt])).rows[0];if(!binding)throw unavailable();
  const version=await loadDocumentVersion(db,ctx.auth.tenantId,source.documentId,source.documentVersionId);if(!version)throw unavailable();
  const visible=(await c.query('SELECT created_at<=$4 AND pg_xact_commit_timestamp(xmin)<=$4 AS visible FROM finnor_os.document_versions WHERE tenant_id=$1 AND document_id=$2 AND id=$3',[ctx.auth.tenantId,source.documentId,source.documentVersionId,times.knowledgeAt])).rows[0]?.visible;if(!visible)throw Error('DOCUMENT_NOT_KNOWN_AT_CUT');
  if(sha(version.bytes)!==version.version.byte_sha256)throw Error('DOCUMENT_VERSION_BYTES_INTEGRITY_FAILED');return version;
 });
 const extraction=await nativeBackend<DocumentExtraction>(ctx.auth.tenantId,'document',{bytes:loaded.bytes.toString('base64'),source,digest:loaded.version.byte_sha256,version:loaded.version.id});
 await authorize(ctx,root,[{type:'document',id:source.documentId}]);return {...extraction.data,nativeInvocations:[extraction.receipt]};
}
