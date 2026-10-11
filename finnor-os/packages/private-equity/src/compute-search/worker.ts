import {env as runtimeEnvironment} from 'node:process';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,ComputeCapacityUnavailableError,DatabaseExecutionDeadlineError,executionDeadlineMilliseconds,withDatabaseExecutionDeadline} from '@finnor/db';
import {z} from 'zod';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {sha,stable,tx,currentDerivation,assertDependencies} from '../evidence-execution/store';
import {requestRow,assertProgramCurrent,trace,reserveCandidate} from '../program-synthesis/store';
import {parseHarnessRequest,type NativeModule} from '../program-synthesis/contracts';
import {constructModules} from '../program-synthesis/compiler';
import {executeHarnessCandidate} from '../program-synthesis/execution';
import {checkNumericalAcceptance} from '../program-synthesis/checker';
import {searchRow,currentSearch,units,append,snapshot} from './store';
import {replan,addCandidateUnits} from './controller';
import {readEndpointConfig} from './endpoints';
import {admit,updateAttempt} from './admission';
import type {UnitRow} from './contracts';
import {executeMetacontroller} from '../deliberation/module';
import {controlSnapshot,readSourceObject} from '../deliberation/store';
import {CurrentModuleRunReceiptSchema} from '../deliberation/contracts';
const replySchema=z.object({model:z.string().min(1).max(128),usage:z.object({inputTokens:z.number().int().min(0),outputTokens:z.number().int().min(0)}).strict(),finishReason:z.literal('stop'),targets:z.array(z.unknown()).min(1).max(16)}).strict();
type UnitPayload=Record<string,unknown>&{tenantId:string;principalId:string;searchId:string;unitId:string};
async function boundedResponse(response:Response,signal:AbortSignal){if(!response.body)throw Error('P2_EMPTY_PROVIDER_BODY');const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];try{for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16384)throw Error('P2_PROVIDER_OUTPUT_BYTE_BOUND');chunks.push(value);}}finally{await reader.cancel().catch(()=>undefined);}return Buffer.concat(chunks).toString('utf8');}
export async function runComputeSearchUnitJob(payload:Record<string,unknown>,x?:Readonly<JobExecutionContext>):Promise<void>{
 if(!x||![1,2].includes(x.protocolVersion)||typeof payload.tenantId!=='string'||x.tenantId!==payload.tenantId||typeof payload.principalId!=='string'||typeof payload.searchId!=='string'||typeof payload.unitId!=='string')throw Error('P2_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED');
 const delivery=payload as UnitPayload;
 if(x.protocolVersion===2){
  const absolute=z.string().datetime().parse(payload.originalDeadlineAt),deadline=Date.parse(absolute);
  if(!Number.isFinite(deadline))throw Error('M2_ORIGINAL_DELIVERY_DEADLINE_REQUIRED');
  // The producer carries the parent's original absolute deadline through the
  // durable queue. Scope the very first owner lookup too; admission is too late
  // to begin limiting IO. A delivery may attenuate time, never renew it.
  const monotone=performance.now()+Math.max(0,deadline-Date.now());
  return withDatabaseExecutionDeadline(monotone,()=>runUnit(delivery,x,deadline,monotone));
 }
 return runUnit(delivery,x,null,null);
}
async function runUnit(payload:UnitPayload,x:Readonly<JobExecutionContext>,deliveryDeadline:number|null,monotoneDeadline:number|null):Promise<void>{
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'},provenance:{sourceSystem:'P2:compute-unit',createdBy:payload.principalId}};
 let s=await searchRow(ctx,payload.searchId);if(x.protocolVersion!==(s.request.deliberation?2:1))throw Error('P2_M2_EXACT_DELIVERY_PROTOCOL_REQUIRED');if(payload.generation!==s.generation||['CANCELLED','INVALIDATED','FAILED','STOPPED'].includes(s.status))return;
 let u=await tx(ctx,async c=>(await units(ctx,s,c)).find(u=>u.id===payload.unitId),true);if(!u||['COMPLETED','FAILED','CANCELLED','UNKNOWN'].includes(u.status))return;
 let attempt:{id:string;body:any}|null=null,leases:Awaited<ReturnType<typeof acquireComputeResourceLeases>>=[],released=false;
 const started=performance.now();let physicalCompleted=false,result:any=null,endpoint:any=null;
 try{
  if(s.request.mode!=='ordinary_disposable'||runtimeEnvironment.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('P2_PROTECTED_FUNDING_AND_RUNTIME_UNAVAILABLE');
  const q=await currentSearch(ctx,s);if(!s.context)throw Error('P2_CURRENT_SOURCE_CONTEXT_REQUIRED');
  if(deliveryDeadline!==null&&deliveryDeadline>Date.parse(q.proposed.bounds.deadlineAt))throw Error('M2_ORIGINAL_DELIVERY_DEADLINE_CANNOT_EXTEND_PARENT');
  const originalDeadline=Math.min(deliveryDeadline??Infinity,Date.parse(q.proposed.bounds.deadlineAt));
  const d=await currentDerivation(ctx,s.context.derivationId),request=parseHarnessRequest(q.request);
  if(u.body.sourceDigest!==d.result?.digest||u.body.inputDigest!==s.context.inputDigest)throw Error('P2_EXACT_UNIT_SOURCE_CUT_MISMATCH');
  const module=s.context.program.modules.find((m:NativeModule)=>m.id===u!.body.moduleId);
  if(u.kind==='MODEL_REFINE'){const endpoints=await readEndpointConfig();const route=u.body.routeIds[Math.min(u.attempts,u.body.routeIds.length-1)];endpoint=endpoints.find(e=>e.id===route);if(!endpoint)throw Error('P2_ROUTE_UNAVAILABLE');}
  const keys=endpoint?['model:global','model-provider:'+endpoint.provider]:['native:p2'];
  leases=await acquireComputeResourceLeases({resourceKeys:keys,requiredResourceKeys:keys,tenantId:s.tenant_id,workloadClass:'INTERACTIVE',ownerId:'p2:'+x.deliveryAttemptId});
  x.registerHeartbeat(async()=>{
   if(released)return true;
   // Queue heartbeats invoke this callback from their own async context.
   // Re-enter this same captured deadline rather than creating a fresh window.
   if(monotoneDeadline===null)return renewComputeResourceLeases(leases);
   return withDatabaseExecutionDeadline(monotoneDeadline,async()=>{executionDeadlineMilliseconds();return renewComputeResourceLeases(leases);});
  });
  const steps=u.kind==='CONTROL_M2'?256:u.kind==='EXECUTE_P1'?(module?.bounds.steps??0)+1:1;
  // Conservative byte ceiling for this local diagnostic protocol; actual
  // returned token counts must fit it. No general provider tokenizer is assumed.
  const providerBody=stable({instruction:request.instruction,accepted:request.acceptance,acceptanceDigest:s.context.acceptanceDigest,sourceSchemas:request.sources});
  const inputTokens=endpoint?Buffer.byteLength(providerBody):0;attempt=await admit(ctx,s,u,x,steps,endpoint,inputTokens);
  await updateAttempt(ctx,s,attempt.id,'SUBMITTED',{submittedAt:new Date().toISOString(),originalDeadlineAt:q.proposed.bounds.deadlineAt,deliveryDeadlineAt:new Date(originalDeadline).toISOString(),physicalDeadlineAt:new Date(Math.min(originalDeadline,Date.now()+10000)).toISOString(),leases:leases.map(l=>({resourceKey:l.resourceKey,fence:l.fence,token:l.token}))});
  if(u.kind==='CONTROL_M2'){
   if(!s.request.deliberation||u.body.moduleId!==s.request.deliberation.moduleRef.id)throw Error('M2_CURRENT_REGISTERED_CONTROL_UNIT_REQUIRED');
   const input=await tx(ctx,c=>controlSnapshot(ctx,s,c),true);
   try{const run=executeMetacontroller(input);if(stable(run.module.ref)!==stable(s.request.deliberation.moduleRef))throw Error('M2_EXECUTED_MODULE_CHANGED');
    const receipt=CurrentModuleRunReceiptSchema.parse({...run.body,schema:'finnor.m2.module-run.v2',execution:{attemptId:attempt.id,deliveryAttemptId:x.deliveryAttemptId,jobId:x.jobId,claimFence:x.claimFence,unitId:u.id,unitBodyDigest:u.digest,unitInvocation:attempt.body.unitInvocation,originalEpisode:q.episode_id,originalDeadlineAt:q.proposed.bounds.deadlineAt,controlUnitLifecycle:run.module.body.config.controlUnitLifecycle}});result={moduleRun:receipt};
    // Physical execution evidence is durable even if a later publication fence
    // fails. It cannot turn a stale proposal into selected work or an incumbent.
    await tx(ctx,c=>c.query('INSERT INTO finnor_os.m2_module_runs(id,tenant_id,principal_id,search_id,unit_id,attempt_id,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(tenant_id,principal_id,attempt_id) DO NOTHING',[receipt.id,s.tenant_id,s.principal_id,s.id,u!.id,attempt!.id,stable(receipt),sha(receipt)]));
   }finally{physicalCompleted=true;}
  }else if(u.kind==='INSPECT_SOURCE'){
   const ref=s.request.deliberation?.sourceInspectionRef;if(!ref)throw Error('M2_CURRENT_SOURCE_INSPECTION_REQUIRED');
   try{const source=await readSourceObject(ctx,q.request.root,ref.sourceId,ref.versionId);if(source.content_hash!==ref.contentDigest)throw Error('M2_SOURCE_INSPECTION_DIGEST_CHANGED');
    const object=z.object({schema:z.literal('finnor.m2.finite-source-object.v1'),entityId:z.string().uuid(),periodStart:z.string().datetime(),periodEnd:z.string().datetime(),unit:z.string().max(128),currencyCode:z.string().regex(/^[A-Z]{3}$/).nullable(),premiseId:z.string().max(128),variants:z.array(z.string().max(2000)).max(50),operativeClause:z.object({id:z.string().max(128),text:z.string().max(4000),changesPremise:z.boolean()}).strict().nullable()}).strict().parse(JSON.parse(source.content));
    if(object.entityId!==q.request.root.entityId||!q.request.sources.some(s=>'periodStart' in s.source&&Date.parse(s.source.periodStart)===Date.parse(object.periodStart)&&Date.parse(s.source.periodEnd)===Date.parse(object.periodEnd)&&s.source.unit===object.unit&&s.source.currencyCode===object.currencyCode))throw Error('M2_SOURCE_EXACT_ENTITY_PERIOD_UNIT_REQUIRED');result={sourceRef:ref,objectDigest:sha(object),premiseId:object.premiseId,variantCount:object.variants.length,independentPremiseCount:1,operativeClause:object.operativeClause,sourceMeaning:'SUPPLIED_FINITE_OBJECT_NOT_LEGAL_OR_FIELD_AUTHORITY',changesPremise:object.operativeClause?.changesPremise??false};
   }finally{physicalCompleted=true;}
  }else if(u.kind==='EXECUTE_P1'){
   if(!module)throw Error('P2_AUTHENTIC_P1_MODULE_REQUIRED');let used=0;
   result=await executeHarnessCandidate(module,request,s.context.input,d,()=>{if(++used>steps||Date.now()>originalDeadline)throw Error('P2_ORIGINAL_EXECUTION_BOUND');},originalDeadline,async isolated=>{physicalCompleted=true;await trace(ctx,q,'ISOLATED_MODULE_EXECUTION',isolated);});
  }else if(u.kind==='VERIFY_P1'){
   const parent=await tx(ctx,async c=>(await units(ctx,s,c)).find(p=>p.id===u!.body.prerequisites[0]),true);
   if(!parent?.result?.values||parent.status!=='COMPLETED'||parent.result.moduleId!==u.body.moduleId)throw Error('P2_INDEPENDENT_CHECK_INPUT_BARRIER');
   const checks=await tx(ctx,c=>checkNumericalAcceptance(c,request.acceptance,s.context.input,parent.result.values),true);
   result={moduleId:parent.result.moduleId,values:parent.result.values,checks};if(checks.some(c=>c.status!=='PASS'))throw Object.assign(Error('P2_INDEPENDENT_ACCEPTANCE_CHECK_FAILED'),{checkResult:result});
  }else{
   const controller=new AbortController(),deadline=Math.min(originalDeadline,Date.now()+8000),timer=setTimeout(()=>controller.abort(Error('P2_SHARED_PROVIDER_DEADLINE')),Math.max(1,deadline-Date.now()));
   let response:Response,raw:string;
   try{response=await fetch(endpoint.url,{method:'POST',headers:{'content-type':'application/json','x-finnor-attempt-id':attempt.id},body:providerBody,signal:controller.signal,redirect:'error'});raw=await boundedResponse(response,controller.signal);}finally{clearTimeout(timer);}
   physicalCompleted=true;
   await updateAttempt(ctx,s,attempt.id,'SUBMITTED',{transportReturnedAt:new Date().toISOString(),statusCode:response.status,responseDigest:sha(raw),costUSD:null});
   if(response.status===429||response.status>=500){const seconds=Number(response.headers.get('retry-after')),retryAfterMs=Number.isFinite(seconds)&&seconds>=0?Math.max(50,Math.min(10000,seconds*1000)):250;
    await updateAttempt(ctx,s,attempt.id,'FAILED',{statusCode:response.status,actualProvider:endpoint.provider,retryAfterMs,elapsedMs:performance.now()-started,responseDigest:sha(raw),usage:null,costUSD:null});
    await tx(ctx,async c=>{await c.query('UPDATE finnor_os.p2_endpoint_windows SET active=active-1 WHERE endpoint_key=$1 AND active>0',[endpoint.key]);const locked=await searchRow(ctx,s.id,c,true);const current=(await units(ctx,locked,c)).find(v=>v.id===u!.id)!;
     if(current.attempts<2&&locked.status==='RUNNING'&&Date.now()+retryAfterMs<Date.parse(q.proposed.bounds.deadlineAt)){
      await c.query("UPDATE finnor_os.p2_units SET status='QUEUED' WHERE id=$1",[u!.id]);
      await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at) VALUES($1,'run_compute_search_unit_v1',$2::jsonb,$3,'interactive',$5,'reconcilable',clock_timestamp()+$4::int*interval '1 millisecond') ON CONFLICT(idempotency_key) DO NOTHING",[s.tenant_id,stable(payload),'p2:'+u!.id+':retry:'+current.attempts,retryAfterMs,s.request.deliberation?2:1]);
      await append(ctx,locked,'THROTTLE_BACKOFF',{unitId:u!.id,attemptId:attempt!.id,retryAfterMs,originalDeadline:q.proposed.bounds.deadlineAt,priorDebitRetained:true,nextRoute:u!.body.routeIds[Math.min(current.attempts,u!.body.routeIds.length-1)],routingBasis:'BOUNDED_PREDECLARED_FALLBACK_AFTER_OBSERVED_THROTTLE_NOT_CALIBRATED_ECONOMIC_ROUTING'},c);await snapshot(ctx,locked,q,c);
     }else {await c.query("UPDATE finnor_os.p2_units SET status='FAILED' WHERE id=$1",[u!.id]);await replan(ctx,locked,q,c);}
    });return;
   }
   if(!response.ok)throw Error('P2_PROVIDER_REJECTED');
   let decoded:unknown;try{decoded=JSON.parse(raw);}catch{throw Error('P2_PROVIDER_JSON_INVALID');}
   const parsed=replySchema.parse(decoded);if(parsed.model!==endpoint.model)throw Error('P2_RETURNED_MODEL_IDENTITY_MISMATCH');
   if(parsed.usage.inputTokens>inputTokens||parsed.usage.outputTokens>endpoint.limits.maxOutputTokens)throw Error('P2_ACTUAL_USAGE_EXCEEDS_RESERVED_BOUND');
   const proposal=parseHarnessRequest({...request,acceptance:{...request.acceptance,targets:parsed.targets}});
   if(stable(proposal.acceptance.targets.map(t=>({key:t.key,unit:t.unit,currencyCode:t.currencyCode})))!==stable(request.acceptance.targets.map(t=>({key:t.key,unit:t.unit,currencyCode:t.currencyCode}))))throw Error('P2_MODEL_ACCEPTANCE_REWRITE');
   const alternate=constructModules(proposal,q.proposed.producer.codeDigest)[0]!;
   result={actualProvider:endpoint.provider,actualModel:parsed.model,usage:parsed.usage,finishReason:parsed.finishReason,responseDigest:sha(raw),proposal:alternate,duplicate:s.context.program.modules.some((m:NativeModule)=>m.structureDigest===alternate.structureDigest),qualification:'DIAGNOSTIC_PROPOSAL_REQUIRES_P1_EXECUTION_AND_ORIGINAL_SQL_CHECK'};
  }
  physicalCompleted=true;
  await currentSearch(ctx,await searchRow(ctx,s.id));if(!await renewComputeResourceLeases(leases))throw Error('P2_PHYSICAL_CAPACITY_LEASE_FENCED');
  await tx(ctx,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+s.tenant_id]);
   const locked=await searchRow(ctx,s.id,c,true),qNow=await requestRow(ctx,q.id,c);
   await assertProgramCurrent(ctx,qNow,c,true);await assertDependencies(ctx,s.context.dependencies,c,true);
   const reservation=(await c.query('SELECT status,revocation_reason FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND allocation_digest=$2 FOR SHARE',[s.tenant_id,s.request.computeGrant.contentDigest])).rows[0];
   if(!reservation||reservation.status==='RELEASED'||reservation.revocation_reason||Date.parse(s.binding.validUntil)<=Date.now())throw Error('P2_S5_PUBLICATION_FENCED');
   const current=(await units(ctx,locked,c)).find(v=>v.id===u!.id)!;
   const claim=(await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 FOR SHARE",[x.jobId,s.tenant_id,x.claimToken,x.claimFence])).rows[0];
   if(!claim||locked.generation!==s.generation||locked.status!=='RUNNING'||current.claim_token!==x.claimToken||Number(current.claim_fence)!==Number(x.claimFence)||current.status!=='RUNNING')throw Error('P2_UNIT_PUBLICATION_FENCED');
   if(u!.kind==='MODEL_REFINE'&&!result.duplicate){
    if(locked.context.program.modules.length>=q.proposed.bounds.maxCandidates||(await units(ctx,locked,c)).length+2>locked.request.limits.maxUnits)throw Error('P2_ORIGINAL_CANDIDATE_OR_UNIT_BOUND');
    const debit=await c.query('UPDATE finnor_os.p1_episodes SET candidates_used=candidates_used+1 WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND candidates_used<max_candidates AND deadline_at>clock_timestamp() RETURNING id',[q.episode_id,s.tenant_id,s.principal_id]);if(!debit.rowCount)throw Error('P2_ORIGINAL_P1_CANDIDATE_BOUND');
    locked.context.program.modules.push(result.proposal);await c.query('INSERT INTO finnor_os.p1_modules(tenant_id,principal_id,digest,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,result.proposal.compiledDigest,stable(result.proposal)]);
    await c.query('UPDATE finnor_os.p2_requests SET context=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[s.tenant_id,s.principal_id,s.id,stable(locked.context)]);await addCandidateUnits(ctx,locked,result.proposal,c);
   }
   result={...result,completedAt:Date.now()};
   await updateAttempt(ctx,s,attempt!.id,'COMPLETED',{...result,proposal:result.proposal?{id:result.proposal.id,compiledDigest:result.proposal.compiledDigest}:undefined,elapsedMs:performance.now()-started,costUSD:null},c);
   if(endpoint)await c.query('UPDATE finnor_os.p2_endpoint_windows SET active=active-1 WHERE endpoint_key=$1 AND active>0',[endpoint.key]);
   const disposition=u!.kind==='CONTROL_M2'?'PENDING':'COMPLETED';
   await c.query("UPDATE finnor_os.p2_units SET status=$4,result=$2::jsonb,result_digest=$3,claim_token=NULL,updated_at=clock_timestamp() WHERE id=$1",[u!.id,stable(result),sha(result),disposition]);
   await append(ctx,locked,u!.kind==='CONTROL_M2'?'M2_CONTROL_INVOCATION_COMPLETED':'UNIT_COMPLETED',{unitId:u!.id,kind:u!.kind,attemptId:attempt!.id,logicalDisposition:disposition,resultDigest:sha(result),sourceResultDigest:s.context.sourceResultDigest,acceptanceDigest:s.context.acceptanceDigest},c);await replan(ctx,locked,qNow,c);
  });
 }catch(error){
  // An expired execution cannot begin a fresh owner transaction in its catch
  // path. Durable INTENT/SUBMITTED cuts and lease expiry remain authoritative;
  // the existing reconciliation operation observes those liabilities later.
  if(error instanceof DatabaseExecutionDeadlineError)throw error;
  if(error instanceof ComputeCapacityUnavailableError)throw error;
  const reason=String((error as Error).message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'P2_OWNER_OR_SCHEMA_PREDICATE_UNPASSED';
  await tx(ctx,async c=>{
   const locked=await searchRow(ctx,s.id,c,true),q=await requestRow(ctx,s.program_id,c),current=(await units(ctx,locked,c)).find(v=>v.id===u!.id);
   const late=locked.generation!==s.generation||['CANCELLED','INVALIDATED','STOPPED'].includes(locked.status)||!current||!!attempt&&current.claim_token!==x.claimToken;
   if(attempt){await updateAttempt(ctx,s,attempt.id,!physicalCompleted?'UNKNOWN':late?'LATE':'FAILED',{predicate:reason,physicalOutcome:physicalCompleted?'RETURNED':'UNKNOWN',elapsedMs:performance.now()-started,actualProvider:endpoint?.provider??null,partialResultDigest:result?sha(result):null,checkResult:(error as any).checkResult??null,costUSD:null,liabilityRetained:true},c);if(endpoint&&physicalCompleted)await c.query('UPDATE finnor_os.p2_endpoint_windows SET active=active-1 WHERE endpoint_key=$1 AND active>0',[endpoint.key]);}
   if(!late){const unknown=!!attempt&&!physicalCompleted;await c.query("UPDATE finnor_os.p2_units SET status=$2,result=$3::jsonb,result_digest=$4,updated_at=clock_timestamp() WHERE id=$1",[u!.id,unknown?'UNKNOWN':'FAILED',stable({predicate:reason,checks:(error as any).checkResult?.checks??null}),sha({predicate:reason,checks:(error as any).checkResult?.checks??null})]);await replan(ctx,locked,q,c);}
   else {await append(ctx,locked,'LATE_COMPLETION_FENCED',{unitId:u!.id,attemptId:attempt?.id??null,predicate:reason,privateResultPublished:false,liabilityRetained:true},c);await snapshot(ctx,locked,q,c);}
  });
 }finally{
  released=true;
  let remaining=true;try{executionDeadlineMilliseconds();}catch(error){if(error instanceof DatabaseExecutionDeadlineError)remaining=false;else throw error;}
  if(leases.length&&remaining)await releaseComputeResourceLeases(leases,'p2_unit_finished');
 }
}
