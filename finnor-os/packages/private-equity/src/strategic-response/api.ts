import {z} from 'zod';
import type {PeMutationContext} from '../types';
import {admitStrategicResponse} from '../../../capability-evolution/src/strategic-response-port';
import {ControlContractError,parseEconomicMandate,parseControlProblem} from '../../../epistemic-runtime/src/control-contracts';
import {assertStrategicControlDomain} from '../../../epistemic-runtime/src/strategic-response/adapter';
import {StrategicOperations,StrategicOperationSchemas,SubmitSchema,ModelId,UseId,ModelList,ForecastRequest,DecisionRequest,
 PROFILE,StrategicFault,same,bytesDigest,fail} from './contracts';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {developmentOnly,principal,authorize,modelTx,useTx,currentChangesTx,invalidateTx,eventTx,enqueueTx,submitModel,
 checkedModelTx,resolveCurrentModelTx,queueUse,workCutTx} from './store';
export {StrategicOperations,StrategicOperationSchemas};
export async function readStrategicBody(req:Request):Promise<unknown>{
 if(!req.body)fail('Y2_JSON_BODY_REQUIRED',400);
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0,expired=false;
 const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>undefined);},20_000);
 try{
  for(;;){const {done,value}=await reader.read();if(expired)fail('Y2_BODY_DEADLINE',408);if(done)break;
   size+=value.byteLength;if(size>PROFILE.maximumRequestBytes){await reader.cancel();fail('Y2_REQUEST_BOUND',413);}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Y2_JSON_BODY_REQUIRED',400);}
 }finally{clearTimeout(timer);reader.releaseLock();}
}
export async function readResponseModel(ctx:PeMutationContext,id:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const row=await modelTx(ctx,c,id),changes=await currentChangesTx(ctx,c,row);await invalidateTx(c,row,changes);
  const uses=(await c.query('SELECT id,requested_model_id,kind,status,generation,attempts_used,cancelled,created_at FROM finnor_os.y2_uses WHERE tenant_id=$1 AND principal_id=$2 AND (model_id=$3 OR requested_model_id=$3) ORDER BY created_at DESC,id DESC LIMIT 33',
   [row.tenant_id,row.principal_id,row.id])).rows;
  const events=(await c.query('SELECT kind,body,created_at FROM finnor_os.y2_events WHERE tenant_id=$1 AND model_id=$2 ORDER BY id LIMIT 2048',[row.tenant_id,row.id])).rows;
  return {schema:'finnor.y2.work-response-projection.v1',modelId:row.id,tenantId:row.tenant_id,principalId:row.principal_id,
   workId:row.work_id,workInputId:row.work_input_id,root:row.root,generation:row.generation+(changes.length&&row.status!=='INVALIDATED'&&!row.cancelled?1:0),
   status:row.cancelled?'CANCELLED':changes.length?'INVALIDATED':row.status,current:!row.cancelled&&row.status!=='INVALIDATED'&&!changes.length,
   currentnessReasons:changes,artifact:row.artifact,admission:row.admission,fallbackId:row.fallback_id,uses:uses.slice(0,32),truncatedUses:uses.length>32,events,
   counters:{episodeId:row.episode_id,attempts:row.attempts_used,maxAttempts:PROFILE.maximumAttempts,uses:row.uses_used,maxUses:PROFILE.maximumUses,
    useAttempts:row.use_attempts_used,semanticApplicationsOccupied:row.semantic_applications_used,retainedBytes:row.retained_bytes,deadlineAt:row.deadline_at.toISOString()},
   resumable:!row.artifact&&!row.cancelled&&!changes.length&&['UNKNOWN','INCOMPLETE'].includes(row.status)&&row.attempts_used<PROFILE.maximumAttempts,
   protectedQualification:false,productionActivated:false,externalEffectsSupported:false,financialEfficacyEstablished:false};
 });
}
export async function readResponseUse(ctx:PeMutationContext,modelId:string,useId:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const requested=await modelTx(ctx,c,modelId),use=await useTx(ctx,c,modelId,useId),selected=await modelTx(ctx,c,use.model_id);
  const changes=await currentChangesTx(ctx,c,selected);await invalidateTx(c,selected,changes);
  const responsibilityReasons=use.kind==='DECISION'&&await (await import('../enterprise-control')).unresolvedEffects(ctx,c)?
   ['S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED']:[];
  const current=!use.cancelled&&!requested.cancelled&&!['INVALIDATED','CANCELLED'].includes(requested.status)&&
   !selected.cancelled&&selected.status==='CHECKED'&&use.status!=='INVALIDATED'&&!changes.length&&
   !responsibilityReasons.length&&use.model_generation===selected.generation;
  return {modelId,useId,executedModelId:use.model_id,tenantId:requested.tenant_id,principalId:requested.principal_id,
   workId:requested.work_id,root:requested.root,kind:use.kind,status:use.cancelled?'CANCELLED':!current?'INVALIDATED':use.status,
   current,currentnessReasons:[...changes,...responsibilityReasons],artifact:use.artifact,check:use.check,attempts:use.attempts_used,
   resumable:current&&!use.artifact&&['UNKNOWN','INCOMPLETE'].includes(use.status)&&use.attempts_used<PROFILE.maximumAttempts,
   originalEpisodeId:use.episode_id,deadlineAt:selected.deadline_at.toISOString(),executionAuthorityGranted:false};
 });
}
export async function handleStrategicOperation(ctx:PeMutationContext,operation:string,raw:unknown):Promise<{status:number;body:unknown}>{
 try{
  developmentOnly();
  if(operation==='response-model-submit')return {status:202,body:await submitModel(ctx,SubmitSchema.parse(raw))};
  if(operation==='response-model-read')return {status:200,body:await readResponseModel(ctx,ModelId.parse(raw).modelId)};
  if(operation==='response-model-admit')return {status:200,body:await admitStrategicResponse(ctx,ModelId.parse(raw).modelId)};
  if(operation==='response-use-read'){const p=UseId.parse(raw);return {status:200,body:await readResponseUse(ctx,p.modelId,p.useId)};}
  if(operation==='response-model-list'){
   const p=ModelList.parse(raw);
   return {status:200,body:await transaction(ctx,async c=>{
    await authorize(ctx,p.root,[{type:'work',id:p.workId}],[],c);await workCutTx(ctx,c,p.workId);
    const rows=(await c.query('SELECT id,status,generation,created_at FROM finnor_os.y2_models WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root=$4::jsonb ORDER BY created_at DESC,id DESC LIMIT 21',
     [ctx.auth.tenantId,principal(ctx),p.workId,JSON.stringify(p.root)])).rows;
    return {root:p.root,workId:p.workId,models:rows.slice(0,20),truncated:rows.length>20};
   })};
  }
  if(operation==='response-model-cancel'||operation==='response-model-resume'){
   const p=ModelId.parse(raw);
   return {status:operation.endsWith('resume')?202:200,body:await transaction(ctx,async c=>{
    const row=await modelTx(ctx,c,p.modelId);
    if(operation.endsWith('cancel')){
     if(!row.cancelled){
      await c.query("UPDATE finnor_os.y2_models SET cancelled=true,status='CANCELLED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
      await eventTx(c,row,'CANCELLED','cancelled',{originalEpisodeId:row.episode_id,priorCommitmentsRetained:true,observationsRewritten:false});
     }
     return {modelId:row.id,workId:row.work_id,status:'CANCELLED',priorCommitmentsRetained:true};
    }
    const changes=await currentChangesTx(ctx,c,row);if(changes.length){await invalidateTx(c,row,changes);return {modelId:row.id,status:'INVALIDATED'};}
    if(row.artifact||row.cancelled||!['UNKNOWN','INCOMPLETE'].includes(row.status)||row.attempts_used>=PROFILE.maximumAttempts)fail('Y2_ORIGINAL_RESUME_NOT_AVAILABLE',409);
    const generation=row.generation+1;
    await c.query("UPDATE finnor_os.y2_models SET status='QUEUED',generation=$3 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id,generation]);
    const jobId=await enqueueTx(c,{tenantId:row.tenant_id,principalId:row.principal_id,modelId:row.id,generation},row.id+':'+generation);
    await eventTx(c,row,'RESUMED','resume:'+generation,{jobId,originalEpisodeId:row.episode_id,deadlineAt:row.deadline_at,checkpointRetained:!!row.candidate});
    return {modelId:row.id,status:'QUEUED',jobId,originalEpisodeRetained:true};
   })};
  }
  if(operation==='response-use-resume'||operation==='response-use-cancel'){
   const p=UseId.parse(raw);
   return {status:operation.endsWith('resume')?202:200,body:await transaction(ctx,async c=>{
    await modelTx(ctx,c,p.modelId);const use=await useTx(ctx,c,p.modelId,p.useId),row=await modelTx(ctx,c,use.model_id);
    if(operation.endsWith('cancel')){
     if(!use.cancelled)await c.query("UPDATE finnor_os.y2_uses SET cancelled=true,status='CANCELLED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,use.id]);
     await eventTx(c,row,'USE_CANCELLED','use-cancel:'+use.id,{useId:use.id,originalEpisodeId:row.episode_id,priorCommitmentsRetained:true});
     return {modelId:p.modelId,useId:use.id,status:'CANCELLED'};
    }
    await resolveCurrentModelTx(ctx,c,row.id);
    if(use.artifact||use.cancelled||!['UNKNOWN','INCOMPLETE'].includes(use.status)||use.attempts_used>=PROFILE.maximumAttempts)fail('Y2_ORIGINAL_USE_RESUME_NOT_AVAILABLE',409);
    const generation=use.generation+1;
    await c.query("UPDATE finnor_os.y2_uses SET status='QUEUED',generation=$3 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,use.id,generation]);
    const jobId=await enqueueTx(c,{tenantId:row.tenant_id,principalId:row.principal_id,modelId:row.id,useId:use.id,generation},use.id+':'+generation);
    await eventTx(c,row,'USE_RESUMED','use-resume:'+use.id+':'+generation,{useId:use.id,jobId,originalEpisodeId:row.episode_id,checkpointRetained:!!use.candidate});
    return {modelId:p.modelId,useId:use.id,status:'QUEUED',jobId,originalEpisodeRetained:true};
   })};
  }
  if(operation==='response-model-artifact'){
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await checkedModelTx(ctx,c,ModelId.parse(raw).modelId),bytes=Buffer.from(JSON.stringify(row.artifact,null,2)+'\n');
    return {modelId:row.id,workId:row.work_id,root:row.root,current:true,fileName:'strategic-response-model-'+row.id+'.json',
     mediaType:'application/json',sha256:bytesDigest(bytes),bytesBase64:bytes.toString('base64'),qualification:'FINITE_CHECKED_DEVELOPMENT_NOT_PROTECTED'};
   })};
  }
  if(operation==='response-model-compare'){
   return {status:200,body:await transaction(ctx,async c=>{
    const row=await modelTx(ctx,c,ModelId.parse(raw).modelId);let fallback=null;
    try{const selected=await resolveCurrentModelTx(ctx,c,row.id,true);if(selected.fallbackUsed)fallback=selected.row.id;}catch{/* Not eligible is explicit, never a fabricated fallback. */}
    return {modelId:row.id,fallbackId:fallback,eligible:!!fallback,comparison:'IDENTICAL_TYPED_PROBLEM_ORIGINAL_EPISODE_CURRENT_DEVELOPMENT_PREIMAGE',
     qualifiedEquippedXBaseline:'UNESTABLISHED',frontierGainEstablished:false,protectedQualification:false};
   })};
  }
  if(operation==='response-forecast')return {status:202,body:await queueUse(ctx,'PREDICT',ForecastRequest.parse(raw))};
  if(operation==='response-programme'){
   const p=DecisionRequest.parse(raw),m=parseEconomicMandate(p.mandate),control=parseControlProblem(p.problem);
   await transaction(ctx,async c=>{
    const {row}=await resolveCurrentModelTx(ctx,c,p.modelId,true);
    if(ctx.auth.role!=='owner'||m.tenantId!==ctx.auth.tenantId||m.principalId!==principal(ctx)||m.businessOwnerRef.id!==principal(ctx)||
     m.episodeId!==row.episode_id||control.episodeId!==row.episode_id||!same(control.modelRef,row.artifact!.envelope.contentRef)||
     m.horizon.periods!==p.query.ruleIds.length||m.utility.unit!==row.request.problem.payoff.unit)fail('Y2_ORIGINAL_S4_OWNER_MANDATE_SCOPE_REQUIRED');
    assertStrategicControlDomain(row.request.problem,p.query,control,p.actionRules);
    if(await (await import('../enterprise-control')).unresolvedEffects(ctx,c))
     fail('Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
   });
   return {status:202,body:await queueUse(ctx,'DECISION',p)};
  }
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  if(error instanceof z.ZodError)return {status:400,body:{code:'Y2_STRICT_CONTRACT_REQUIRED'}};
  if(error instanceof StrategicFault)return {status:error.status,body:{code:error.code}};
  if(error instanceof ControlContractError)return {status:400,body:{code:'Y2_ORIGINAL_STRICT_S4_CONTRACT_REQUIRED'}};
  if((error as {code?:string}).code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'Y2_AUTHENTICATED_RESOURCE_UNAVAILABLE'}};
  throw error;
 }
}
