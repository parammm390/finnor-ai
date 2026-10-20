/** Actual source-owner setup of generated originals. No inference/oracle imports. */
import {readFile,realpath,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {getPool,withTenantTransaction} from '@finnor/db';
import {appendDocumentVersion} from '@finnor/data-platform';
import {registerInstitutionCoreSource} from '../../../packages/private-equity/src/institution-program/inputs';
import {authorizeInstitutionWork,loadInstitutionProfile} from '../../../packages/private-equity/src/institution-program/store';
import {authenticateOwner,type OwnerEndpoint} from './qualification-runtime.mts';

const hex=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
export const GeneratedOriginalInstantiation=z.object({schema:z.literal('finnor.x1.generated-original-instantiation.v1'),
  publicPacket:z.object({path:z.string().startsWith('/'),sha256:hex}).strict(),workId:uuid,
  purpose:z.string().min(1).max(2000),expiresAt:z.string().datetime({precision:3}),
  originals:z.array(z.object({sourceId:z.string().min(1),grantId:uuid,documentId:uuid,parentVersionId:uuid,
    sourceClass:z.string().min(1)}).strict()).min(8).max(16)}).strict();
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

export async function instantiateGeneratedOriginals(input:{control:unknown;owner:OwnerEndpoint;deadlineAt:number;
  onObservation?:(observation:Record<string,unknown>)=>void|Promise<void>}){
  const database=new URL(process.env.DATABASE_URL??'');
  if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname))throw Error('GENERATED_SETUP_DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
  const control=GeneratedOriginalInstantiation.parse(input.control),identity=await authenticateOwner(input.owner,input.deadlineAt);
  if(Date.parse(control.expiresAt)<=Date.now())throw Error('ORIGINAL_GENERATED_SOURCE_EXPIRY_REFUSED');
  const role=(await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
    pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if(role.current_user!=='finnor_app'||role.rolsuper||role.rolbypassrls||role.app_inherits_worker)
    throw Error('GENERATED_SETUP_RESTRICTED_APP_ROLE_REQUIRED');
  if((await stat(control.publicPacket.path)).size>1024*1024)throw Error('PUBLIC_GENERATED_PACKET_BOUND');
  const packetBytes=await readFile(control.publicPacket.path);if(sha(packetBytes)!==control.publicPacket.sha256)
    throw Error('PUBLIC_GENERATED_PACKET_PREIMAGE_CHANGED');
  const packet=JSON.parse(packetBytes.toString('utf8')),profile=loadInstitutionProfile();
  if(packet.schema!=='finnor.x1.generated-original-institution-inputs.v1'||packet.independentHiddenOracleIncluded!==false
    ||packet.ownerHandles?.workId!==control.workId||packet.ownerHandles?.owner?.tenantId!==input.owner.tenantId
    ||packet.ownerHandles?.owner?.principalId!==input.owner.principalId||typeof packet.institutionId!=='string'
    ||!Array.isArray(packet.sources)||packet.sources.length!==control.originals.length
    ||new Set(packet.sources.map((s:any)=>s.sourceId)).size!==packet.sources.length)
    throw Error('EXACT_GENERATED_PUBLIC_SOURCE_POPULATION_REQUIRED');
  const root=await realpath(dirname(control.publicPacket.path)),ctx={auth:{tenantId:input.owner.tenantId,
    userId:input.owner.principalId,employeeId:input.owner.principalId,role:'owner' as const},
    provenance:{sourceSystem:'independent-generated-original-setup',createdBy:input.owner.principalId}};
  await authorizeInstitutionWork(ctx,control.workId);
  const planned=[];let rawBytes=0;
  for(const source of packet.sources){
    if(!/^[a-f0-9-]+-[0-9]+\.bin$/.test(source.originalFile)||!hex.safeParse(source.sha256).success
      ||!profile.sourceClasses.some(c=>c.id===source.sourceClass&&c.protocols.includes(source.protocol)))
      throw Error('GENERATED_ORIGINAL_PATH_OR_PROTOCOL_REFUSED');
    const path=await realpath(join(root,source.originalFile));if(!path.startsWith(root+'/'))throw Error('GENERATED_ORIGINAL_PATH_ESCAPED');
    if((await stat(path)).size>profile.bounds.objectBytes)throw Error('GENERATED_OBJECT_BYTE_BOUND');
    const bytes=await readFile(path);rawBytes+=bytes.length;
    if(bytes.length!==source.bytes||sha(bytes)!==source.sha256||rawBytes>profile.bounds.rawBytes)
      throw Error('GENERATED_SOURCE_BYTE_PREIMAGE_OR_AGGREGATE_BOUND');
    const original=control.originals.find(o=>o.sourceId===source.sourceId&&o.sourceClass===source.sourceClass&&o.grantId===source.grantId);
    if(!original)throw Error('ORIGINAL_GENERATED_SOURCE_GRANT_BINDING_REQUIRED');
    await withTenantTransaction(input.owner.tenantId,{userId:input.owner.principalId,readOnly:true},async(_db,c)=>{
      const row=(await c.query(`SELECT g.id FROM finnor_os.x1_source_grants g
        JOIN finnor_os.documents d ON d.tenant_id=g.tenant_id AND d.id=g.document_id
        WHERE g.tenant_id=$1 AND g.principal_id=$2 AND g.work_id=$3 AND g.id=$4 AND g.source_id=$5
          AND g.document_id=$6 AND g.document_version_id=$7 AND g.source_class=$8 AND d.created_by=$2::text
          AND g.institution_id=$9 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
          AND EXISTS(SELECT 1 FROM finnor_os.x1_source_grants current_grant
            WHERE current_grant.tenant_id=g.tenant_id AND current_grant.principal_id=g.principal_id
              AND current_grant.work_id=g.work_id AND current_grant.source_id=g.source_id
              AND (finnor_os.x1_source_scope(g.work_id,current_grant.id)->'body'->>'originalReadAllowed')::boolean
              AND (current_grant.id=g.id OR (current_grant.document_id=g.document_id AND current_grant.original_sha256=$10
                AND current_grant.protocol=$11 AND current_grant.purpose=$12 AND current_grant.expires_at=$13::timestamptz
                AND EXISTS(SELECT 1 FROM finnor_os.document_versions installed_version
                  WHERE installed_version.tenant_id=g.tenant_id AND installed_version.document_id=g.document_id
                    AND installed_version.id=current_grant.document_version_id AND installed_version.parent_version_id=g.document_version_id
                    AND installed_version.created_by=$2::text AND installed_version.byte_sha256=$10
                    AND installed_version.provider_version_id=$10 AND installed_version.origin='manual_upload'
                    AND installed_version.source_system='independent-source-export' AND installed_version.source_ref=g.source_id
                    AND installed_version.media_type='application/octet-stream' AND installed_version.format=$14
                    AND installed_version.size_bytes=$15))))`,
      [input.owner.tenantId,input.owner.principalId,control.workId,original.grantId,original.sourceId,
        original.documentId,original.parentVersionId,original.sourceClass,packet.institutionId,source.sha256,
        source.protocol,control.purpose,control.expiresAt,['xlsx','docx'].includes(source.protocol)?source.protocol:'unknown',bytes.length])).rows[0];
      if(!row)throw Error('ACTUAL_OWNED_ORIGINAL_SOURCE_PARENT_REQUIRED');
    });
    planned.push({source,original,bytes});
  }
  const observations=[];
  for(const {source,original,bytes}of planned){
    if(Date.now()>=input.deadlineAt)throw Error('ORIGINAL_SOURCE_SETUP_DEADLINE_EXHAUSTED');
    await input.onObservation?.({status:'EXPOSED',sourceId:source.sourceId,byteSha256:sha(bytes),
      originalGrantId:original.grantId,originalVersionId:original.parentVersionId,workId:control.workId});
    const version=await withTenantTransaction(input.owner.tenantId,{userId:input.owner.principalId},async db=>
      appendDocumentVersion(db,{tenantId:input.owner.tenantId,documentId:original.documentId,bytes,
        mediaType:'application/octet-stream',format:['xlsx','docx'].includes(source.protocol)?source.protocol:'unknown',
        origin:'manual_upload',actor:input.owner.principalId,parentVersionId:original.parentVersionId,
        sourceSystem:'independent-source-export',sourceRef:original.sourceId,providerVersionId:source.sha256}));
    await input.onObservation?.({status:'VERSION_RETAINED',sourceId:source.sourceId,version,
      originalGrantId:original.grantId,originalVersionId:original.parentVersionId,byteSha256:sha(bytes)});
    const grant=await registerInstitutionCoreSource(ctx,{workId:control.workId,documentId:original.documentId,
      documentVersionId:version.id,sourceClass:source.sourceClass,protocol:source.protocol,purpose:control.purpose,expiresAt:control.expiresAt});
    observations.push({sourceId:source.sourceId,sourceClass:source.sourceClass,protocol:source.protocol,version,grant,
      originalGrantId:original.grantId,originalVersionId:original.parentVersionId,byteSha256:sha(bytes)});
    await input.onObservation?.({status:'SOURCE_REGISTERED',...observations.at(-1)});
  }
  return {schema:'finnor.x1.generated-original-instantiation-observation.v1',identity,role,workId:control.workId,
    publicPacketDigest:sha(packetBytes),rawBytes,observations,compilerCompletionEstablished:false,
    protectedCustodyEstablished:false,executionAuthorityGranted:false,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
}
