/** Actual canonical/provider-owned rows. No compiler summary, inference or oracle. */
import {createHash} from 'node:crypto';
import {getPool,withTenantClientTransaction} from '@finnor/db';
import {callAuthenticatedOwner,type OwnerEndpoint,type IndependentReadProjection} from './qualification-runtime.mts';
import type {z} from 'zod';
type Selector=NonNullable<z.infer<typeof IndependentReadProjection>['nativeSelector']>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function readNativeObservationSnapshot(owner:OwnerEndpoint,selector:Selector,deadlineAt:number,
  measured:<T>(read:()=>Promise<T>)=>Promise<T>=async read=>read()){
  const database=new URL(process.env.DATABASE_URL??'');
  if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname))throw Error('NATIVE_OBSERVER_DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
  const role=(await measured(()=>getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
    pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles WHERE rolname=current_user`))).rows[0];
  if(!role||role.current_user!=='finnor_app'||role.rolsuper||role.rolbypassrls||role.app_inherits_worker)
    throw Error('NATIVE_OBSERVER_RESTRICTED_APP_ROLE_REQUIRED');
  const authorised=await measured(()=>callAuthenticatedOwner(owner,{path:'/api/company-brain/institution-sources',method:'POST',body:{workId:selector.workId}},
    {deadlineAt,maxResponseBytes:1024*1024}));
  if(authorised.status!==200||authorised.body.workId!==selector.workId)throw Error('NATIVE_OBSERVER_AUTHENTICATED_ORIGINAL_WORK_REQUIRED');
  const rows=await withTenantClientTransaction(owner.tenantId,{userId:owner.principalId,readOnly:true},async c=>{
    await c.query("SELECT set_config('statement_timeout',$1,true)",[String(Math.max(1,Math.min(20000,deadlineAt-Date.now())))]);
    const original=(await measured(()=>c.query(`SELECT e.parent_reservation,e.original_deadline FROM finnor_os.x1_compiler_episodes e
      JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.episode_id=e.id
      WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.id=$3 AND r.work_id=$4 LIMIT 1`,
      [owner.tenantId,owner.principalId,selector.originalEpisodeId,selector.workId]))).rows[0];
    if(!original?.parent_reservation||sha(JSON.stringify(original.parent_reservation))!==selector.originalGrantDigest
      ||original.original_deadline.toISOString()!==selector.originalDeadline)throw Error('NATIVE_OBSERVER_ORIGINAL_PARENT_OR_DEADLINE_CHANGED');
    const args=[owner.tenantId,owner.principalId,selector.workId,selector.originalEpisodeId];
    if(selector.kind==='S1_MAPPING_CLAIMS'){
      if(!selector.sourceIds?.length)throw Error('EXACT_NATIVE_SOURCE_POPULATION_REQUIRED');
      return (await measured(()=>c.query(`SELECT v.snapshot||jsonb_build_object('evidenceSourceId',s.id,'evidenceVersionId',v.id,
        'entityRefs',ch.entity_refs,'x1_observed_at',clock_timestamp()) body
        FROM finnor_os.evidence_sources s JOIN finnor_os.evidence_source_versions v ON v.tenant_id=s.tenant_id AND v.source_id=s.id
        JOIN finnor_os.evidence_chunks ch ON ch.tenant_id=v.tenant_id AND ch.source_id=v.source_id AND ch.version_id=v.id
        JOIN finnor_os.x1_source_grants g ON g.tenant_id=v.tenant_id AND g.source_id=v.snapshot->>'sourceId'
          AND g.document_id::text=v.snapshot->>'documentId' AND g.document_version_id::text=v.snapshot->>'documentVersionId'
        WHERE g.tenant_id=$1 AND g.principal_id=$2 AND g.work_id=$3 AND g.source_id=ANY($5::text[])
          AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
          AND (finnor_os.x1_source_scope($3,g.id)->'body'->>'originalReadAllowed')::boolean
          AND g.original_sha256=v.snapshot->>'originalSha256'
          AND EXISTS(SELECT 1 FROM finnor_os.x1_compiler_requests r WHERE r.tenant_id=g.tenant_id AND r.work_id=$3 AND r.episode_id=$4)
        ORDER BY s.id,v.id,ch.id LIMIT 150001`,[...args,selector.sourceIds]))).rows.map(r=>r.body);
    }
    if(selector.kind==='P1_OBLIGATION_CLAIMS')return (await measured(()=>c.query(`SELECT node||jsonb_build_object('programId',q.id,
      'x1_observed_at',clock_timestamp()) body FROM finnor_os.x1_compiler_requests r
      JOIN finnor_os.p1_requests q ON q.tenant_id=r.tenant_id AND q.id=r.program_id
      JOIN finnor_os.p1_programs p ON p.tenant_id=q.tenant_id AND p.id=q.head_id AND p.request_id=q.id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.body->'nodes','[]'::jsonb)) node
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id=$4
        AND r.revision=(SELECT max(latest.revision) FROM finnor_os.x1_compiler_requests latest
          WHERE latest.tenant_id=r.tenant_id AND latest.principal_id=$2 AND latest.work_id=$3)
      ORDER BY q.id,node->>'id' LIMIT 3841`,args))).rows.map(r=>r.body);
    const table=selector.kind==='REQUEST_ROWS'?'pe_requests':selector.kind==='WORKSTREAM_ROWS'?'pe_workstreams':'pe_findings';
    return (await measured(()=>c.query(`SELECT jsonb_build_object('identity',a.authority_context->>'stableIdentity','actionId',a.id,
      'actionStatus',a.status,'effectStatus',e.status,'fields',to_jsonb(n),'x1_observed_at',clock_timestamp(),
      'x1_committed_at',CASE WHEN current_setting('track_commit_timestamp')='on' THEN pg_xact_commit_timestamp(n.xmin) ELSE NULL END) body
      FROM finnor_os.domain_actions a LEFT JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id
      JOIN finnor_os.${table} n ON n.tenant_id=a.tenant_id AND n.id=a.id
      WHERE a.tenant_id=$1 AND a.initiated_by=$2 AND a.work_id=$3 AND a.authority_context->>'kind'='institution_duty'
        AND EXISTS(SELECT 1 FROM finnor_os.p1_requests q JOIN finnor_os.x1_compiler_requests r
          ON r.tenant_id=q.tenant_id AND r.program_id=q.id WHERE q.tenant_id=a.tenant_id
            AND q.id::text=a.authority_context->>'programId' AND q.principal_id=$2 AND q.work_id=$3 AND r.episode_id=$4
            AND q.work_input_id::text=a.authority_context->>'workInputId')
        AND NOT EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins o WHERE o.tenant_id=a.tenant_id AND o.domain_action_id=a.id)
      ORDER BY a.id,e.id LIMIT 3841`,args))).rows.map(r=>r.body);
  });
  if(rows.length>(selector.kind==='S1_MAPPING_CLAIMS'?150000:3840))throw Error('ORIGINAL_NATIVE_OBSERVER_ROW_BOUND');
  const body={workId:selector.workId,originalEpisodeId:selector.originalEpisodeId,selector:selector.kind,
    snapshotStatus:'ACTUAL_NATIVE_OWNER_ROWS_READ',rows,role,authorityGranted:false},bytes=JSON.stringify(body);
  if(Buffer.byteLength(bytes)>6*1024*1024)throw Error('ORIGINAL_NATIVE_OBSERVER_RESPONSE_BOUND');
  return {status:200,body,responseDigest:sha(bytes),responseBytes:Buffer.byteLength(bytes),observedAt:new Date().toISOString()};
}
