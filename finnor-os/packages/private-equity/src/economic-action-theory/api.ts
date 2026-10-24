import {z} from 'zod';
import {authorize} from '../owner-context';
import type {PeMutationContext} from '../types';
import {admitEconomicTheory} from '../../../capability-evolution/src/economic-theory-port';
import {reserveEconomicRights,readEconomicReservation,EconomicReservationSchema} from '../economic-allocation';
import {createEconomicProgramme,readEconomicProgramme,programmeTx,EconomicProgrammeSchema} from '../economic-control';
import {PROFILE,SubmitSchema,RootSchema,RefSchema,EconomicFault,digest,byteDigest,fail,same} from './contracts';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {developmentOnly,theoryTx,principal,currentChangesTx,invalidateTx,eventTx,enqueueTx,submitTheory,checkedTheoryTx,workCutTx} from './store';
const TheoryId=z.object({theoryId:z.string().uuid()}).strict(),ProgrammeId=z.object({programmeId:z.string().uuid()}).strict();
const TheoryList=z.object({root:RootSchema,workId:z.string().uuid()}).strict(),
 TheoryComparison=TheoryId.extend({incumbentTheoryId:z.string().uuid().optional()}).strict(),
 ReservationId=z.object({reservationRef:RefSchema}).strict();
export const EconomicOperationSchemas={
 'economic-theory-submit':SubmitSchema,'economic-theory-read':TheoryId,'economic-theory-list':TheoryList,
 'economic-theory-admit':TheoryId,'economic-theory-resume':TheoryId,'economic-theory-cancel':TheoryId,
 'economic-theory-artifact':TheoryId,'economic-theory-compare':TheoryComparison,
 'economic-programme-create':EconomicProgrammeSchema,'economic-programme-run':ProgrammeId,
 'economic-programme-read':ProgrammeId,'economic-programme-reconcile':ProgrammeId,
 'economic-reservation-create':EconomicReservationSchema,'economic-reservation-read':ReservationId,
} satisfies Record<string,z.ZodTypeAny>;
export const EconomicOperations=Object.keys(EconomicOperationSchemas) as ReadonlyArray<keyof typeof EconomicOperationSchemas>;
/** Authentication runs before this bounded transport read. */
export async function readEconomicBody(req:Request):Promise<unknown>{
 if(!req.body)fail('Y1_JSON_BODY_REQUIRED',400);
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0,expired=false;
 const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>undefined);},20_000);
 try{
  for(;;){const {value,done}=await reader.read();if(expired)fail('Y1_BODY_DEADLINE',408);if(done)break;
   size+=value.byteLength;if(size>PROFILE.maxRequestBytes){await reader.cancel();fail('Y1_REQUEST_BOUND',413);}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Y1_JSON_BODY_REQUIRED',400);}
 }finally{clearTimeout(timer);reader.releaseLock();}
}
export async function readEconomicTheory(ctx:PeMutationContext,id:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const row=await theoryTx(ctx,c,id),changes=await currentChangesTx(ctx,c,row);
  await invalidateTx(c,row,changes);
  const events=(await c.query('SELECT kind,body,created_at FROM finnor_os.y1_events WHERE tenant_id=$1 AND theory_id=$2 ORDER BY id LIMIT 2048',[row.tenant_id,row.id])).rows;
  return {schema:'finnor.y1.work-theory-projection.v1',theoryId:row.id,tenantId:row.tenant_id,principalId:row.principal_id,
   workId:row.work_id,workInputId:row.work_input_id,root:row.root,generation:row.generation+(changes.length&&row.status!=='INVALIDATED'&&!row.cancelled?1:0),
   status:row.cancelled?'CANCELLED':changes.length?'INVALIDATED':row.status,current:!row.cancelled&&row.status!=='INVALIDATED'&&!changes.length,
   currentnessReasons:changes,artifact:row.artifact,admission:row.admission,fallbackId:row.fallback_id,
   counters:{episodeId:row.episode_id,attempts:row.attempts_used,maxAttempts:PROFILE.maxAttempts,
    searchStepsOccupied:row.search_steps_used,semanticApplicationsOccupied:row.semantic_applications_used,
    retainedBytes:row.retained_bytes,deadlineAt:row.deadline_at.toISOString()},events,
   resumable:!row.artifact&&!row.cancelled&&!changes.length&&['UNKNOWN','INCOMPLETE'].includes(row.status)&&row.attempts_used<PROFILE.maxAttempts,
   protectedQualification:false,productionActivated:false,externalEffectsSupported:false,financialEfficacyEstablished:false};
 });
}
async function enqueueProgramme(ctx:PeMutationContext,id:string,mode:'RUN'|'RECONCILE'){
 return transaction(ctx,async c=>{
  const programme=await programmeTx(ctx,c,id,mode==='RUN');
  const payload={tenantId:ctx.auth.tenantId,principalId:principal(ctx),programmeId:id,mode};
  const responsibility=(await c.query(
   `SELECT o.obligation_id,e.status FROM finnor_os.s6_economic_obligation_origins o
    JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
    WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.programme_id=$3 ORDER BY o.step_index LIMIT 17`,
   [ctx.auth.tenantId,principal(ctx),id])).rows;
  if(responsibility&&responsibility.length>programme.steps.length)fail('Y1_PROGRAMME_RESPONSIBILITY_BOUND');
  const deliveryKey='y1-programme:'+ctx.auth.tenantId+':'+id+':'+mode+(responsibility?':'+digest(responsibility):'');
  const job=(await c.query<{id:string;status:string}>(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane)
   VALUES($1,'run_economic_programme_v1',$2::jsonb,$3,1,4,'interactive')
   ON CONFLICT(idempotency_key) DO UPDATE SET
    status=CASE WHEN jobs.status IN('failed','dead_letter') AND jobs.attempts<jobs.max_attempts THEN 'queued' ELSE jobs.status END,
    run_at=CASE WHEN jobs.status IN('failed','dead_letter') AND jobs.attempts<jobs.max_attempts THEN clock_timestamp() ELSE jobs.run_at END
    RETURNING id,status`,
   [ctx.auth.tenantId,JSON.stringify(payload),deliveryKey])).rows[0]!;
  if(['failed','dead_letter'].includes(job.status))fail('Y1_PROGRAMME_ORIGINAL_DELIVERY_EXHAUSTED',409);
  const row=await theoryTx(ctx,c,programme.theoryId);
  await eventTx(c,row,'S4_DURABLE_PROGRAMME_ACCEPTED','programme-job:'+deliveryKey,{programmeId:id,jobId:job.id,mode,
   originalEpisodeId:programme.episodeId,existingObligationsRetained:true,externalEffects:false});
  return {programmeId:id,workId:programme.workId,status:job.status,jobId:job.id,mode,originalEpisodeRetained:true};
 });
}
export async function handleEconomicOperation(ctx:PeMutationContext,operation:string,raw:unknown):Promise<{status:number;body:unknown}>{
 try{
  developmentOnly();
  if(operation==='economic-theory-submit')return {status:202,body:await submitTheory(ctx,SubmitSchema.parse(raw))};
  if(operation==='economic-theory-list'){
   const input=TheoryList.parse(raw);
   return {status:200,body:await transaction(ctx,async c=>{
    await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
    await workCutTx(ctx,c,input.workId);
    const rows=(await c.query('SELECT id,status,root,work_id,generation,created_at FROM finnor_os.y1_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root=$4::jsonb ORDER BY created_at DESC,id DESC LIMIT 21',
     [ctx.auth.tenantId,principal(ctx),input.workId,JSON.stringify(input.root)])).rows;
    return {workId:input.workId,root:input.root,theories:rows.slice(0,20),truncated:rows.length>20};
   })};
  }
  if(operation==='economic-theory-read')return {status:200,body:await readEconomicTheory(ctx,TheoryId.parse(raw).theoryId)};
  if(operation==='economic-theory-admit')return {status:200,body:await admitEconomicTheory(ctx,TheoryId.parse(raw).theoryId)};
  if(operation==='economic-theory-cancel'){
   const input=TheoryId.parse(raw);
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await theoryTx(ctx,c,input.theoryId);
    if(!row.cancelled){
     await c.query("UPDATE finnor_os.y1_requests SET cancelled=true,status='CANCELLED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
     await eventTx(c,row,'CANCELLED','cancelled',{originalEpisodeId:row.episode_id,obligationsRetained:true,reservationsRetained:true,observationsRewritten:false});
    }
    return {theoryId:row.id,workId:row.work_id,status:'CANCELLED',responsibilityRetained:true};
   })};
  }
  if(operation==='economic-theory-resume'){
   const input=TheoryId.parse(raw);
   return {status:202,body:await transaction(ctx,async c=>{
    const row=await theoryTx(ctx,c,input.theoryId),changes=await currentChangesTx(ctx,c,row);
    if(changes.length){await invalidateTx(c,row,changes);return {theoryId:row.id,workId:row.work_id,status:'INVALIDATED'};}
    if(row.artifact||row.cancelled||!['UNKNOWN','INCOMPLETE'].includes(row.status)||row.attempts_used>=PROFILE.maxAttempts)fail('Y1_ORIGINAL_RESUME_NOT_AVAILABLE',409);
    const generation=row.generation+1;
    await c.query("UPDATE finnor_os.y1_requests SET status='QUEUED',generation=$3 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id,generation]);
    const jobId=await enqueueTx(c,{tenantId:row.tenant_id,principalId:row.principal_id,theoryId:row.id,generation},row.id+':'+generation);
    await eventTx(c,row,'RESUMED','resume:'+generation,{jobId,originalEpisodeId:row.episode_id,deadlineAt:row.deadline_at,checkpointRetained:!!row.candidate});
    return {theoryId:row.id,workId:row.work_id,status:'QUEUED',jobId,originalEpisodeRetained:true};
   })};
  }
  if(operation==='economic-theory-artifact'){
   const id=TheoryId.parse(raw).theoryId;
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await checkedTheoryTx(ctx,c,id),bytes=Buffer.from(JSON.stringify(row.artifact,null,2)+'\n');
    return {theoryId:id,workId:row.work_id,root:row.root,current:true,fileName:'economic-action-theory-'+id+'.json',
     mediaType:'application/json',sha256:byteDigest(bytes),bytesBase64:bytes.toString('base64'),qualification:'FINITE_CHECKED_DEVELOPMENT_NOT_PROTECTED'};
   })};
  }
  if(operation==='economic-theory-compare'){
   const input=TheoryComparison.parse(raw);
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await theoryTx(ctx,c,input.theoryId),id=input.incumbentTheoryId??row.fallback_id;
    const incumbent=id?await theoryTx(ctx,c,id,false):null;
    if(incumbent&&(incumbent.work_id!==row.work_id||!same(incumbent.root,row.root)))fail('Y1_COMPARISON_SCOPE',404);
    const eligible=!!incumbent&&incumbent.status==='CHECKED'&&!incumbent.cancelled&&!!incumbent.admission&&
     same(incumbent.request.problem,row.request.problem)&&!(await currentChangesTx(ctx,c,incumbent)).length;
    return {theoryId:row.id,incumbentTheoryId:incumbent?.id??null,eligible,comparison:'CURRENT_FINITE_DEVELOPMENT_PREIMAGE_ONLY',
     sameSemanticBody:!!incumbent?.candidate&&!!row.candidate&&same(incumbent.candidate.operators,row.candidate.operators),
     fallbackId:eligible?incumbent!.id:null,protectedNoveltyEstablished:false,qualifiedEquippedBaseline:'UNESTABLISHED',
     existingOwners:['P1','R2','V','R6','X'],costs:{candidate:row.artifact?.envelope.costs??null,incumbent:incumbent?.artifact?.envelope.costs??null}};
   })};
  }
  if(operation==='economic-reservation-create')return {status:200,body:await reserveEconomicRights(ctx,raw)};
  if(operation==='economic-reservation-read')return {status:200,body:await readEconomicReservation(ctx,ReservationId.parse(raw).reservationRef)};
  if(operation==='economic-programme-create')return {status:200,body:await createEconomicProgramme(ctx,raw)};
  if(operation==='economic-programme-read')return {status:200,body:await readEconomicProgramme(ctx,ProgrammeId.parse(raw).programmeId)};
  if(operation==='economic-programme-run'||operation==='economic-programme-reconcile')
   return {status:202,body:await enqueueProgramme(ctx,ProgrammeId.parse(raw).programmeId,operation==='economic-programme-run'?'RUN':'RECONCILE')};
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  if(error instanceof z.ZodError)return {status:400,body:{code:'Y1_STRICT_CONTRACT_REQUIRED'}};
  if(error instanceof EconomicFault)return {status:error.status,body:{code:error.code}};
  if((error as {code?:string}).code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'Y1_AUTHENTICATED_RESOURCE_UNAVAILABLE'}};
  throw error;
 }
}
