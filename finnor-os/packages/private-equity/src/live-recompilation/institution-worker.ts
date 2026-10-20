import type { PoolClient } from "pg";
import { employeeAuthoritySnapshot } from "@finnor/authority";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { principal,sha,stable,tx } from "../evidence-execution/store";
import { safePredicate } from "../program-synthesis/store";
import { chargeInstitutionDemand,validateInstitutionDemand } from "../allocation-store";
import { persistInstitutionCompute } from "../institution-program/meter";
import { authorizeInstitutionWork,compilerEpisode,compilerEvent,compilerRow,
  submitInstitutionCompiler } from "../institution-program/store";

type Prepared={workId:string;workInputId:string;grantIds:string[];idempotencyKey:string;parentRequestId:string};
type Update={id:string;tenant_id:string;principal_id:string;work_id:string;episode_id:string;
 trigger_request_id:string;state:string;prepared_request:Prepared|null;prepared_at:Date|null;next_request_id:string|null;polls:number};

/** P7 event payloads are read handles. The existing compiler and its owners
 * alone rehydrate originals, check meaning and bind the original Work parent. */
export async function runInstitutionUpdateJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 if(!execution||execution.protocolVersion!==1||execution.retrySafety!=="reconcilable"
  ||typeof payload.tenantId!=="string"||payload.tenantId!==execution.tenantId
  ||typeof payload.principalId!=="string"||typeof payload.updateId!=="string")
  throw Error("X1_P7_ACTUAL_UPDATE_CLAIM_REQUIRED");
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,
  employeeId:payload.principalId,role:"owner"},provenance:{sourceSystem:"P7:x1-owner-update",createdBy:payload.principalId}};
 const claim=async(c:PoolClient)=>{
  if(!(await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
   AND type='run_x1_institution_update_v1' AND protocol_version=1 AND status='running'
   AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
   [ctx.auth.tenantId,execution.jobId,execution.claimToken,execution.claimFence])).rows[0])
   throw Error("X1_P7_UPDATE_CLAIM_FENCED");
 };
 const read=async(c:PoolClient,lock=false)=>{
  const row=(await c.query<Update>(`SELECT * FROM finnor_os.x1_compiler_updates
   WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock?" FOR UPDATE":""}`,
   [ctx.auth.tenantId,principal(ctx),payload.updateId])).rows[0];
  if(!row)throw Error("X1_P7_UPDATE_UNAVAILABLE");return row;
 };
 let row=await tx(ctx,c=>read(c),true);
 if(["SUBMITTED","COALESCED"].includes(row.state)
  ||(["BLOCKED","CANCELLED"].includes(row.state)&&!row.prepared_request))return;
 const started=performance.now(),startedAt=new Date().toISOString();
 let ordinal:number|null=null,meterStatus="UPDATE_UNCERTAIN";
 const episode=await compilerEpisode(ctx,row.episode_id);
 const trigger=await compilerRow(ctx,row.trigger_request_id);
 const adopt=async(c:PoolClient,current:Update)=>{
  if(!current.prepared_request)return false;
  const accepted=(await c.query<{id:string;request_digest:string}>(`SELECT id::text,request_digest
   FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
   [row.tenant_id,row.principal_id,current.prepared_request.idempotencyKey])).rows[0];
  if(!accepted)return false;
  const frozen={...current.prepared_request,grantIds:[...current.prepared_request.grantIds].sort()};
  if(accepted.request_digest!==sha(frozen))throw Error("X1_P7_ACCEPTED_HANDOFF_INTENT_CHANGED");
  await c.query(`UPDATE finnor_os.x1_compiler_updates SET state='SUBMITTED',next_request_id=$4,
   updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
   [row.tenant_id,row.principal_id,row.id,accepted.id]);
  await c.query(`UPDATE finnor_os.x1_compiler_updates SET state='COALESCED',next_request_id=$4,
   updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND episode_id=$3
    AND state='PENDING' AND created_at<=$5`,
   [row.tenant_id,row.principal_id,row.episode_id,accepted.id,current.prepared_at]);
  await compilerEvent(ctx,trigger,"P7_ACCEPTED_HANDOFF_ADOPTED",{updateId:row.id,
   nextRequestId:accepted.id,newProducerCalled:false,originalEpisode:row.episode_id},c);
  return true;
 };
 try{
  if(row.prepared_request){
   const adopted=await tx(ctx,async c=>{
    await claim(c);const current=await read(c,true);
    return adopt(c,current);
   });
   if(adopted){meterStatus="ACCEPTED_HANDOFF_RECONCILED";return;}
  }
  if(["BLOCKED","CANCELLED"].includes(row.state))return;
  await authorizeInstitutionWork(ctx,row.work_id);
  if(process.env.FINNOR_P4_PROFILE!=="ordinary_disposable"||process.env.NODE_ENV==="production")
   throw Error("X1_P7_DISPOSABLE_INSTALLATION_REQUIRED");
  ordinal=await tx(ctx,async c=>{
   await claim(c);row=await read(c,true);
   const original=await compilerEpisode(ctx,row.episode_id,c,true);
   if(original.wall_deadline.getTime()<=Date.now()||original.coordination_calls>=124)
    throw Error("X1_P7_ORIGINAL_COORDINATION_ENVELOPE_EXHAUSTED");
   const call=(await c.query<{coordination_calls:number}>(`UPDATE finnor_os.x1_compiler_episodes
    SET coordination_calls=coordination_calls+1 WHERE tenant_id=$1 AND id=$2 RETURNING coordination_calls`,
    [row.tenant_id,row.episode_id])).rows[0]!;
   await c.query(`UPDATE finnor_os.x1_compiler_updates SET claim_token=$4,claim_fence=$5,
    updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [row.tenant_id,row.principal_id,row.id,execution.claimToken,execution.claimFence]);
   return 4+call.coordination_calls;
  });
  if(!episode.parent_reservation||(await validateInstitutionDemand(ctx,episode.parent_reservation)).status!=="CURRENT")
   throw Error("X1_P7_ORIGINAL_S5_PARENT_UNAVAILABLE");
  await chargeInstitutionDemand(ctx,episode.parent_reservation,{responsibilityIdentity:`x1-compiler-episode:${episode.id}`,
   phase:"COMPILE",ordinal,units:1});
  if(!row.prepared_request){
   const prepared=await tx(ctx,async c=>{
    await claim(c);row=await read(c,true);
    if(row.prepared_request)return row.prepared_request;
    const latestId=(await c.query<{id:string}>(`SELECT id::text FROM finnor_os.x1_compiler_requests
     WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
     [row.tenant_id,row.principal_id,row.work_id])).rows[0]?.id;
    if(!latestId)throw Error("X1_P7_ORIGINAL_WORK_HEAD_UNAVAILABLE");
    const latest=await compilerRow(ctx,latestId,c);
    if(latest.episode_id!==row.episode_id)throw Error("X1_P7_ORIGINAL_EPISODE_CHANGED");
    const work=(await c.query<{id:string;status:string}>(`SELECT i.id::text,w.status FROM finnor_os.works w
     JOIN LATERAL(SELECT id FROM finnor_os.work_inputs WHERE tenant_id=w.tenant_id AND work_id=w.id
       ORDER BY created_at DESC,id DESC LIMIT 1) i ON true WHERE w.tenant_id=$1 AND w.id=$2 FOR SHARE OF w`,
     [row.tenant_id,row.work_id])).rows[0];
    if(latest.status==="CANCELLED"||work?.status==="cancelled"){
     await c.query("UPDATE finnor_os.x1_compiler_updates SET state='CANCELLED' WHERE tenant_id=$1 AND id=$2",
      [row.tenant_id,row.id]);return null;
    }
    if(["QUEUED","RUNNING"].includes(latest.status)){
     if(row.polls>=124)throw Error("X1_P7_ORIGINAL_PRODUCER_WAIT_EXHAUSTED");
     const remaining=episode.wall_deadline.getTime()-Date.now();
     if(remaining<=0)throw Error("X1_P7_ORIGINAL_DEADLINE_EXPIRED");
     await c.query("UPDATE finnor_os.x1_compiler_updates SET polls=polls+1 WHERE tenant_id=$1 AND id=$2",
      [row.tenant_id,row.id]);
     const stage="producer-"+(row.polls+1),delay=Math.max(1,Math.min(remaining,60000,2000*2**Math.min(row.polls,5)));
     await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at)
      VALUES($1,'run_x1_institution_update_v1',$2::jsonb,$3,'interactive',1,'reconcilable',clock_timestamp()+$4::int*interval '1 millisecond')
      ON CONFLICT(idempotency_key) DO NOTHING`,[row.tenant_id,stable({...payload,stage}),`x1-update:${row.id}:${stage}`,delay]);
     meterStatus="DEFERRED_CURRENT_PRODUCER";return null;
    }
    if(!work)throw Error("X1_P7_EXACT_WORK_INPUT_UNAVAILABLE");
    const grants=(await c.query<{id:string;source_id:string}>(`SELECT latest_grant.id::text,latest_grant.source_id
     FROM finnor_os.x1_source_grants original JOIN LATERAL
      (SELECT g.* FROM finnor_os.x1_source_grants g WHERE g.tenant_id=original.tenant_id
       AND g.principal_id=original.principal_id AND g.work_id=original.work_id AND g.source_id=original.source_id
       ORDER BY g.version DESC LIMIT 1) latest_grant ON true
     WHERE original.tenant_id=$1 AND original.principal_id=$2 AND original.id=ANY($3::uuid[])
      ORDER BY latest_grant.source_id`,
     [row.tenant_id,row.principal_id,latest.grant_ids])).rows;
    if(grants.length!==latest.grant_ids.length||new Set(grants.map(g=>g.source_id)).size!==grants.length)
     throw Error("X1_P7_ORIGINAL_SOURCE_POPULATION_UNAVAILABLE");
    const request:Prepared={workId:row.work_id,workInputId:work.id,grantIds:grants.map(g=>g.id),
     idempotencyKey:`p7-x1:${row.id}`,parentRequestId:latest.id};
    await c.query(`UPDATE finnor_os.x1_compiler_updates SET state='PREPARED',prepared_request=$4::jsonb,prepared_at=clock_timestamp(),
     updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
     [row.tenant_id,row.principal_id,row.id,stable(request)]);
    await compilerEvent(ctx,latest,"P7_AUTOMATIC_UPDATE_PREPARED",{updateId:row.id,preparedDigest:sha(request),
     originalEpisode:row.episode_id,sourcePopulationPreserved:true},c);
    return request;
   });
   if(!prepared)return;row=await tx(ctx,c=>read(c),true);
  }
  // Reclaim repeats these exact handles/key even if acceptance already created
  // a newer head. Producer idempotency adopts it before testing the new parent.
  if(!row.prepared_request)throw Error("X1_P7_IMMUTABLE_PREPARED_REQUEST_REQUIRED");
  const next=await submitInstitutionCompiler(ctx,row.prepared_request,{updateId:row.id,execution});
  await tx(ctx,async c=>{
   await claim(c);const current=await read(c,true);
   if(current.state!=="PREPARED"||sha(current.prepared_request)!==sha(row.prepared_request))
    throw Error("X1_P7_PREPARED_HANDOFF_CHANGED");
   await c.query(`UPDATE finnor_os.x1_compiler_updates SET state='SUBMITTED',next_request_id=$4,
    updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [row.tenant_id,row.principal_id,row.id,next.requestId]);
   await compilerEvent(ctx,trigger,"P7_AUTOMATIC_UPDATE_SUBMITTED",{updateId:row.id,nextRequestId:next.requestId,
    originalEpisode:row.episode_id,possiblePriorEffectsRetained:true},c);
   await c.query(`UPDATE finnor_os.x1_compiler_updates SET state='COALESCED',next_request_id=$4,
    updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND episode_id=$3
      AND state='PENDING' AND created_at<=$5`,
    [row.tenant_id,row.principal_id,row.episode_id,next.requestId,current.prepared_at]);
  });
  meterStatus="CURRENT_OWNER_INPUTS_SUBMITTED";
 }catch(error){
  const predicate=safePredicate(error);meterStatus=predicate;
  await tx(ctx,async c=>{
   await claim(c);const current=await read(c,true);
   // Commit can succeed while its response or our handoff recording is lost.
   // Reconcile the exact key before any failure becomes terminal.
   if(await adopt(c,current)){meterStatus="ACCEPTED_HANDOFF_RECONCILED";return;}
   const original=await compilerEpisode(ctx,row.episode_id,c,true);
   const remaining=original.wall_deadline.getTime()-Date.now();
   const uncertain=current.state==="PREPARED"&&predicate==="PROGRAM_OWNER_OR_CHECK_PREDICATE_UNPASSED";
   const retry=uncertain&&remaining>0&&original.coordination_calls<124&&current.polls<124;
   const state=retry?"PREPARED":predicate==="X1_P7_AUTOMATIC_PARENT_CANCELLED"?"CANCELLED":"BLOCKED";
   if(["PENDING","PREPARED"].includes(current.state))await c.query(`UPDATE finnor_os.x1_compiler_updates
    SET state=$4,failure=$5,polls=polls+$6,updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [row.tenant_id,row.principal_id,row.id,state,predicate,retry?1:0]);
   if(retry){
    const stage="handoff-"+(current.polls+1);
    const delay=Math.max(1,Math.min(remaining,60000,2000*2**Math.min(current.polls,5)));
    await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at)
     VALUES($1,'run_x1_institution_update_v1',$2::jsonb,$3,'interactive',1,'reconcilable',clock_timestamp()+$4::int*interval '1 millisecond')
     ON CONFLICT(idempotency_key) DO NOTHING`,
     [row.tenant_id,stable({...payload,stage}),`x1-update:${row.id}:${stage}`,delay]);
   }
   await compilerEvent(ctx,trigger,retry?"P7_AUTOMATIC_HANDOFF_UNCERTAIN":"P7_AUTOMATIC_UPDATE_BLOCKED",{updateId:row.id,predicate,state,
    preparedDigest:current.prepared_request?sha(current.prepared_request):null,
    originalEpisode:row.episode_id,originalDeadline:episode.original_deadline.toISOString(),
    priorEffectsAndCostsRetained:true},c);
  });
 }finally{
  try{
   const rights=await employeeAuthoritySnapshot(ctx.auth);
   const compute=await persistInstitutionCompute(ctx,{requestId:row.trigger_request_id,workId:row.work_id,
    episodeId:row.episode_id,jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,
    parentReservation:episode.parent_reservation,rightsRevision:String(rights.revision),
    startedAt,elapsedMs:performance.now()-started,phase:"UPDATE_RECOGNITION",status:meterStatus,
    observedAcquisitionAttempts:0,observedCheckerAttempts:0});
   await compilerEvent(ctx,trigger,"P7_UPDATE_COMPUTE_ATTRIBUTED",{updateId:row.id,ordinal,compute:compute.record.ref});
  }catch(error){await compilerEvent(ctx,trigger,"P7_UPDATE_METER_GAP",{updateId:row.id,
   jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,predicate:safePredicate(error)});}
  await tx(ctx,async c=>{
   await claim(c);const current=await read(c,true);
   if(["PENDING","PREPARED"].includes(current.state))return;
   const original=await compilerEpisode(ctx,row.episode_id,c,true);
   if(original.wall_deadline.getTime()<=Date.now()||original.coordination_calls>=124){
    await c.query(`UPDATE finnor_os.x1_compiler_updates SET state='BLOCKED',failure='X1_P7_ORIGINAL_COORDINATION_ENVELOPE_EXHAUSTED'
     WHERE tenant_id=$1 AND principal_id=$2 AND episode_id=$3 AND state='PENDING'`,
     [row.tenant_id,row.principal_id,row.episode_id]);return;
   }
   const pending=(await c.query<{id:string}>(`SELECT id::text FROM finnor_os.x1_compiler_updates
    WHERE tenant_id=$1 AND principal_id=$2 AND episode_id=$3 AND state='PENDING'
      ORDER BY created_at,id LIMIT 1 FOR UPDATE`,[row.tenant_id,row.principal_id,row.episode_id])).rows[0];
   if(pending)await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
    VALUES($1,'run_x1_institution_update_v1',$2::jsonb,$3,'interactive',1,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING`,
    [row.tenant_id,stable({tenantId:row.tenant_id,principalId:row.principal_id,updateId:pending.id}),`x1-update:${pending.id}:after:${row.id}`]);
  });
 }
}
