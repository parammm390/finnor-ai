import {z} from 'zod';
import type {PeMutationContext} from '../types';
import {authorize} from '../owner-context';
import {EconomicFault,RootSchema} from '../economic-action-theory/contracts';
import {handleEconomicOperation} from '../economic-action-theory/api';
import {admitInteraction} from '../../../capability-evolution/src/interaction-port';
import {InteractionFault,byteDigest,fail} from './contracts';
import {SubmitSchema,ProtocolId,RunId,TermsSchema,ConsentSchema,StartSchema,ObserveSchema,ActionSchema,MaterializeSchema,
 LIMITS,same} from './product-contracts';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {developmentOnly,protocolTx,checkedProtocolTx,principal,workCutTx,submitProtocol,
 currentChangesTx,invalidateTx,eventTx,enqueueTx} from './store';
import {createInteractionTerms,localInteraction,recordInteractionConsent,startInteraction,readInteractionRun,
 recordInteractionObservation,recordInteractionAction,materializeInteraction,interactionProgramme} from './continuation';
const List=z.object({root:RootSchema,workId:z.string().uuid()}).strict(),
 Compare=ProtocolId.extend({incumbentProtocolId:z.string().uuid().optional()}).strict();
export const InteractionOperationSchemas={
 'interaction-submit':SubmitSchema,'interaction-read':ProtocolId,'interaction-list':List,'interaction-admit':ProtocolId,
 'interaction-resume':ProtocolId,'interaction-cancel':ProtocolId,'interaction-artifact':ProtocolId,'interaction-compare':Compare,
 'interaction-terms':TermsSchema,'interaction-local':ProtocolId,'interaction-consent':ConsentSchema,'interaction-start':StartSchema,
 'interaction-run-read':RunId,'interaction-observe':ObserveSchema,'interaction-action':ActionSchema,
 'interaction-materialize':MaterializeSchema,'interaction-run':RunId,'interaction-reconcile':RunId,
} satisfies Record<string,z.ZodTypeAny>;
export const InteractionOperations=Object.keys(InteractionOperationSchemas) as ReadonlyArray<keyof typeof InteractionOperationSchemas>;
export async function readInteractionBody(req:Request):Promise<unknown>{
 if(!req.body)fail('Y3_JSON_BODY_REQUIRED',400);
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0,expired=false;
 const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>undefined);},20000);
 try{
  for(;;){
   const {value,done}=await reader.read();if(expired)fail('Y3_BODY_DEADLINE',408);if(done)break;
   size+=value.byteLength;if(size>LIMITS.maxRequestBytes){await reader.cancel();fail('Y3_REQUEST_BYTE_BOUND',413);}chunks.push(value);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Y3_JSON_BODY_REQUIRED',400);}
 }finally{clearTimeout(timer);reader.releaseLock();}
}
export async function readInteraction(ctx:PeMutationContext,id:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const row=await protocolTx(ctx,c,id),changes=await currentChangesTx(ctx,c,row);await invalidateTx(c,row,changes);
  const events=(await c.query('SELECT kind,body,created_at FROM finnor_os.y3_events WHERE tenant_id=$1 AND protocol_id=$2 ORDER BY id LIMIT 2048',
   [row.tenant_id,row.id])).rows;
  return {schema:'finnor.y3.work-interaction-projection.v1',protocolId:row.id,tenantId:row.tenant_id,principalId:row.principal_id,
   workId:row.work_id,workInputId:row.work_input_id,root:row.root,generation:row.generation,
   status:row.cancelled?'CANCELLED':changes.length?'INVALIDATED':row.status,
   current:!row.cancelled&&row.status!=='INVALIDATED'&&!changes.length,currentnessReasons:changes,
   artifact:row.artifact,admission:row.admission,fallbackId:row.fallback_id,currentTermsId:row.current_terms_id,
   counters:{episodeId:row.episode_id,attempts:row.attempts_used,maxAttempts:LIMITS.maxAttempts,
    searchStepsOccupied:row.search_steps_used,retainedBytes:row.retained_bytes,deadlineAt:row.deadline_at.toISOString()},
   resumable:!row.artifact&&!row.cancelled&&!changes.length&&['UNKNOWN','INCOMPLETE'].includes(row.status)&&row.attempts_used<LIMITS.maxAttempts,
   events,sourceParity:'UNKNOWN',protectedQualification:false,productionActivated:false,financialEfficacyEstablished:false,
   externalEffectsSupported:false};
 });
}
export async function handleInteractionOperation(ctx:PeMutationContext,operation:string,raw:unknown):Promise<{status:number;body:unknown}>{
 try{
  developmentOnly();
  if(operation==='interaction-submit')return {status:202,body:await submitProtocol(ctx,SubmitSchema.parse(raw))};
  if(operation==='interaction-list'){
   const input=List.parse(raw);
   return {status:200,body:await transaction(ctx,async c=>{
    await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);await workCutTx(ctx,c,input.workId);
    const rows=(await c.query<{id:string;status:string;principal_id:string}>(`SELECT id,status,principal_id FROM finnor_os.y3_requests
     WHERE tenant_id=$1 AND work_id=$2 AND root=$3::jsonb AND (principal_id=$4 OR
     request->'problem'->'participants' @> jsonb_build_array(jsonb_build_object('principalId',$4::text)))
     ORDER BY created_at DESC,id DESC LIMIT 21`,[ctx.auth.tenantId,input.workId,JSON.stringify(input.root),principal(ctx)])).rows;
    return {workId:input.workId,root:input.root,protocols:rows.slice(0,20).map(r=>({id:r.id,status:r.status,owner:r.principal_id===principal(ctx)})),truncated:rows.length>20};
   })};
  }
  if(operation==='interaction-read')return {status:200,body:await readInteraction(ctx,ProtocolId.parse(raw).protocolId)};
  if(operation==='interaction-local')return {status:200,body:await localInteraction(ctx,ProtocolId.parse(raw).protocolId)};
  if(operation==='interaction-admit')return {status:200,body:await admitInteraction(ctx,ProtocolId.parse(raw).protocolId)};
  if(operation==='interaction-terms')return {status:200,body:await createInteractionTerms(ctx,raw)};
  if(operation==='interaction-consent')return {status:200,body:await recordInteractionConsent(ctx,raw)};
  if(operation==='interaction-start')return {status:200,body:await startInteraction(ctx,raw)};
  if(operation==='interaction-run-read')return {status:200,body:await readInteractionRun(ctx,RunId.parse(raw).runId)};
  if(operation==='interaction-observe')return {status:200,body:await recordInteractionObservation(ctx,raw)};
  if(operation==='interaction-action')return {status:200,body:await recordInteractionAction(ctx,raw)};
  if(operation==='interaction-materialize')return {status:200,body:await materializeInteraction(ctx,raw)};
  if(operation==='interaction-run'||operation==='interaction-reconcile'){
   const programme=await interactionProgramme(ctx,RunId.parse(raw).runId,operation==='interaction-reconcile');
   return handleEconomicOperation(ctx,operation==='interaction-run'?'economic-programme-run':'economic-programme-reconcile',
    {programmeId:programme.programmeId});
  }
  if(operation==='interaction-cancel'){
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await protocolTx(ctx,c,ProtocolId.parse(raw).protocolId);
    if(!row.cancelled){
     await c.query("UPDATE finnor_os.y3_requests SET cancelled=true,status='CANCELLED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
     await eventTx(c,row,'CANCELLED','cancelled',{originalEpisodeId:row.episode_id,consentsRetainedNotRebound:true,
      reservationsRetained:true,unknownEffectsRetained:true,responsibilityRetained:true});
    }
    return {protocolId:row.id,workId:row.work_id,status:'CANCELLED',responsibilityRetained:true};
   })};
  }
  if(operation==='interaction-resume'){
   return {status:202,body:await transaction(ctx,async c=>{
    const row=await protocolTx(ctx,c,ProtocolId.parse(raw).protocolId),changes=await currentChangesTx(ctx,c,row);
    if(changes.length){await invalidateTx(c,row,changes);return {protocolId:row.id,status:'INVALIDATED'};}
    if(row.artifact||row.cancelled||!['UNKNOWN','INCOMPLETE'].includes(row.status)||row.attempts_used>=LIMITS.maxAttempts)
     fail('Y3_ORIGINAL_RESUME_UNAVAILABLE',409);
    const generation=row.generation+1;
    await c.query("UPDATE finnor_os.y3_requests SET status='QUEUED',generation=$3 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id,generation]);
    const jobId=await enqueueTx(c,{tenantId:row.tenant_id,principalId:row.principal_id,protocolId:row.id,generation},row.id+':'+generation);
    await eventTx(c,row,'RESUMED','resume:'+generation,{jobId,originalEpisodeId:row.episode_id,deadlineAt:row.deadline_at,checkpointRetained:!!row.candidate});
    return {protocolId:row.id,status:'QUEUED',jobId,originalEpisodeRetained:true};
   })};
  }
  if(operation==='interaction-artifact'){
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await checkedProtocolTx(ctx,c,ProtocolId.parse(raw).protocolId),bytes=Buffer.from(JSON.stringify(row.artifact,null,2)+'\n');
    return {protocolId:row.id,workId:row.work_id,root:row.root,current:true,fileName:'interaction-protocol-'+row.id+'.json',
     sha256:byteDigest(bytes),bytesBase64:bytes.toString('base64'),qualification:'FINITE_CHECKED_DEVELOPMENT_NOT_PROTECTED'};
   })};
  }
  if(operation==='interaction-compare'){
   const input=Compare.parse(raw);
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await protocolTx(ctx,c,input.protocolId),id=input.incumbentProtocolId??row.fallback_id,
     incumbent=id?await protocolTx(ctx,c,id):null;
    if(incumbent&&(incumbent.work_id!==row.work_id||!same(incumbent.root,row.root)))fail('Y3_COMPARISON_SCOPE',404);
    const eligible=!!incumbent&&incumbent.status==='CHECKED'&&!incumbent.cancelled&&!!incumbent.admission&&
     same(incumbent.request.problem,row.request.problem)&&same(incumbent.request.lowering,row.request.lowering)&&
     same(incumbent.request.sources,row.request.sources)&&!(await currentChangesTx(ctx,c,incumbent)).length;
    return {protocolId:row.id,incumbentProtocolId:incumbent?.id??null,eligible,fallbackId:eligible?incumbent!.id:null,
     fallbackKind:eligible?'CURRENT_CHECKED_DYNAMIC_INCUMBENT':'UNKNOWN_NO_COMPATIBLE_FALLBACK',
     exactSemanticBodyReused:!!incumbent?.candidate&&!!row.candidate&&same(incumbent.candidate,row.candidate),
     protectedNoveltyEstablished:false,equippedBaseline:'UNESTABLISHED',financialEfficacyEstablished:false,
     costs:{candidate:row.artifact?.envelope.costs??null,incumbent:incumbent?.artifact?.envelope.costs??null}};
   })};
  }
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  if(error instanceof z.ZodError)return {status:400,body:{code:'Y3_STRICT_CONTRACT_REQUIRED'}};
  if(error instanceof InteractionFault||error instanceof EconomicFault)return {status:error.status,body:{code:error.code}};
  if((error as {code?:string})?.code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'Y3_AUTHENTICATED_RESOURCE_UNAVAILABLE'}};
  throw error;
 }
}
