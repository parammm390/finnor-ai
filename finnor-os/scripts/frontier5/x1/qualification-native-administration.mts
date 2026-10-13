/** Read actual original owner identities; create no episode, grant or authority. */
import {createHash} from 'node:crypto';
import {getPool,withTenantClientTransaction} from '@finnor/db';
import {NativeWorkerRegistration,authenticateOwner,callAuthenticatedOwner,type OwnerEndpoint} from './qualification-runtime.mts';
import {digest} from '../../../packages/capability-evolution/src/contracts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function bindOriginalNativeWorker(input:{
  protocolDigest:string;candidateCutDigest:string;allocationConventionDigest:string;
  runtime:{mode:'SOURCE_DEVELOPMENT'|'COMPILED_DEVELOPMENT';digest:string};phase:'replay'|'soak';
  envelope:{ref:string;registrationDigest:string;maxNativeDeliveries:number;maxAggregateWallMs:number;maxOutputBytes:number};
  owners:Array<{owner:OwnerEndpoint;workId:string}>;deadlineAt:number;
}){
  const database=new URL(process.env.DATABASE_URL??'');
  if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname))throw Error('NATIVE_ADMIN_DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
  const role=(await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
    pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if(!role||role.current_user!=='finnor_app'||role.rolsuper||role.rolbypassrls||role.app_inherits_worker)
    throw Error('NATIVE_ADMIN_RESTRICTED_APP_ROLE_REQUIRED');
  if(input.owners.length<1||input.owners.length>3840||new Set(input.owners.map(o=>o.owner.tenantId+'/'+o.workId)).size!==input.owners.length)
    throw Error('EXACT_ORIGINAL_NATIVE_WORK_POPULATION_REQUIRED');
  const originals=[];
  for(const {owner,workId}of input.owners){
    if(Date.now()>=input.deadlineAt)throw Error('ORIGINAL_NATIVE_ADMIN_WALL_EXHAUSTED');
    await authenticateOwner(owner,input.deadlineAt);
    const authorised=await callAuthenticatedOwner(owner,{path:'/api/company-brain/institution-sources',method:'POST',body:{workId}},
      {deadlineAt:input.deadlineAt,maxResponseBytes:1024*1024});
    if(authorised.status!==200||(authorised.body as {workId?:unknown}).workId!==workId)
      throw Error('AUTHENTICATED_ORIGINAL_NATIVE_WORK_REFUSED');
    const row=await withTenantClientTransaction(owner.tenantId,{userId:owner.principalId,readOnly:true},async c=>
      (await c.query(`SELECT e.id::text,e.parent_reservation,e.original_deadline,r.work_id::text FROM finnor_os.x1_compiler_episodes e
        JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.episode_id=e.id
        JOIN finnor_os.works w ON w.tenant_id=r.tenant_id AND w.id=r.work_id
        WHERE e.tenant_id=$1 AND e.principal_id=$2 AND r.work_id=$3 AND w.created_by=$2
        ORDER BY r.revision DESC LIMIT 1`,[owner.tenantId,owner.principalId,workId])).rows[0]);
    if(!row?.parent_reservation||!row.original_deadline||row.original_deadline.getTime()<=Date.now())
      throw Error('ACTUAL_CURRENT_ORIGINAL_NATIVE_PARENT_AND_DEADLINE_REQUIRED');
    originals.push({tenantId:owner.tenantId,principalId:owner.principalId,workId:row.work_id,
      originalEpisodeId:row.id,originalGrantDigest:sha(JSON.stringify(row.parent_reservation)),
      originalDeadline:row.original_deadline.toISOString()});
  }
  const dbIdentity=(await getPool().query(`SELECT current_database() database,inet_server_addr()::text host,inet_server_port() port`)).rows[0];
  return NativeWorkerRegistration.parse({schema:'finnor.x1.qualification-native-worker-registration.v1',
    protocolDigest:input.protocolDigest,candidateCutDigest:input.candidateCutDigest,allocationConventionDigest:input.allocationConventionDigest,
    runtime:input.runtime,databaseIdentityDigest:digest(dbIdentity),
    phase:input.phase,originalEpisodes:originals,envelope:input.envelope});
}
