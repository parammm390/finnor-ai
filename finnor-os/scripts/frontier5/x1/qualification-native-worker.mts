/** Finite supervision of the existing native queue; no new execution engine. */
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {getPool,withTenantClientTransaction} from '@finnor/db';
import type {JobQueue} from '../../../apps/worker/src/queue';
import {digest} from '../../../packages/capability-evolution/src/contracts';
import {NativeWorkerRegistration,executeNativeQueueSlice} from './qualification-runtime.mjs';

const hex=z.string().regex(/^[a-f0-9]{64}$/);
export const NativeWorkerControl=z.object({schema:z.literal('finnor.x1.qualification-native-worker-control.v1'),
  registration:NativeWorkerRegistration,evidenceRoot:z.string().startsWith('/'),cursorPath:z.string().startsWith('/'),
  durationSeconds:z.number().int().min(1).max(600),recoverLockDigest:hex.optional()}).strict();
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

export async function runRegisteredNativeWorker(queue:JobQueue,signal:AbortSignal,
  runtime:z.infer<typeof NativeWorkerRegistration>['runtime'],assertRuntime:()=>void|Promise<void>){
  const path=process.env.FINNOR_X1_QUAL_NATIVE_CONTROL,expectedHash=process.env.FINNOR_X1_QUAL_NATIVE_CONTROL_SHA256;
  if(!path?.startsWith('/')||!hex.safeParse(expectedHash).success||!process.env.DATABASE_URL)
    throw Error('EXISTING_PINNED_NATIVE_WORKER_CONTROL_AND_DATABASE_BINDING_REQUIRED');
  if((await stat(path)).size>1024*1024)throw Error('NATIVE_WORKER_CONTROL_INPUT_BOUND');
  const bytes=await readFile(path);if(sha(bytes)!==expectedHash)throw Error('ORIGINAL_NATIVE_WORKER_CONTROL_PREIMAGE_CHANGED');
  const control=NativeWorkerControl.parse(JSON.parse(bytes.toString('utf8')));
  const dbIdentity=(await getPool().query(`SELECT current_database() database,inet_server_addr()::text host,
    inet_server_port() port`)).rows[0];
  const originalEpisodes=[];
  for(const registered of control.registration.originalEpisodes){
    const row=await withTenantClientTransaction(registered.tenantId,{userId:registered.principalId,readOnly:true},async c=>
      (await c.query(`SELECT e.id::text original_episode_id,e.parent_reservation,e.original_deadline,r.work_id::text
        FROM finnor_os.x1_compiler_episodes e JOIN finnor_os.x1_compiler_requests r
          ON r.tenant_id=e.tenant_id AND r.episode_id=e.id
        WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.id=$3 AND r.work_id=$4`,
      [registered.tenantId,registered.principalId,registered.originalEpisodeId,registered.workId])).rows[0]);
    if(!row)throw Error('ACTUAL_ORIGINAL_NATIVE_EPISODE_REQUIRED');
    originalEpisodes.push({...registered,originalEpisodeId:row.original_episode_id,workId:row.work_id,
      originalGrantDigest:sha(JSON.stringify(row.parent_reservation)),originalDeadline:row.original_deadline.toISOString()});
  }
  const result=await executeNativeQueueSlice({registration:control.registration,evidenceRoot:control.evidenceRoot,
    cursorPath:control.cursorPath,durationSeconds:control.durationSeconds,signal,runtime,
    databaseIdentityDigest:digest(dbIdentity),originalEpisodes,queue,assertRuntime,
    readDeliveryAttempts:async()=> (await getPool().query(`SELECT to_jsonb(a) body FROM finnor_os.job_delivery_attempts a
      WHERE worker_id=$1 ORDER BY id LIMIT $2`,[queue.instanceId,control.registration.envelope.maxNativeDeliveries+1])).rows.map(r=>r.body),
    ...(control.recoverLockDigest?{recovery:{expectedLockDigest:control.recoverLockDigest}}:{})});
  console.log(JSON.stringify({event:'X1_QUALIFICATION_NATIVE_SLICE_RECORDED',pid:process.pid,phase:control.registration.phase,
    cursorPath:control.cursorPath,possibleTickExposures:result.state.resources.acquisitionExposures,
    actualDeliveryAttempts:result.segment.actualDeliveryAttempts.length,deliveryAllowanceExhausted:result.deliveryAllowanceExhausted,
    protectedQualificationEstablished:false,sevenElapsedDaysEstablished:false}));
  return result;
}
