import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PeMutationContext} from '../types';
import {authorize,codeIdentity,principal,sha,stable,tx,unavailable} from '../evidence-execution/store';
import {readCurrentProgram} from '../program-synthesis/store';
import {bounded,hash,readModule,AcquisitionRequestSchema,IdSchema,ProjectionSchema,ModuleRequestSchema,CatalogueRequestSchema,InvocationRequestSchema,type Operation} from './contracts';
import {acquisition,access,assertCurrent,append,readCurrent,attemptRow,practicePort,buildCapability,publish} from './store';
import {boundedFetch,observeHttp,requireAccess} from './runtime';
import {wireValue} from './compiler';
import {interfaceConsumerPolicy,currentInterfaceCandidate} from '../../../capability-evolution/src/interface-consumer';
export const INTERFACE_OPERATIONS=['interface-acquire','interface-read','interface-projection','interface-catalogue','interface-module','interface-cancel','interface-resume','interface-reconcile','interface-admission','interface-invoke','interface-ports'] as const;
export const INTERFACE_OPERATION_SCHEMAS={
 'interface-acquire':AcquisitionRequestSchema,'interface-read':IdSchema,'interface-projection':ProjectionSchema,'interface-catalogue':CatalogueRequestSchema,
 'interface-module':ModuleRequestSchema,'interface-cancel':IdSchema,'interface-resume':IdSchema,'interface-reconcile':IdSchema,'interface-admission':IdSchema,
 'interface-invoke':InvocationRequestSchema,'interface-ports':ProjectionSchema,
} as const;
const operational=()=>{if(process.env.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('P5_DISPOSABLE_OPERATIONAL_PROFILE_REQUIRED');};
async function enqueue(ctx:PeMutationContext,row:Awaited<ReturnType<typeof acquisition>>,stage:string,c:import('pg').PoolClient){
 await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_interface_acquisition_v1',$2::jsonb,$3,'interactive',1,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING",
  [row.tenant_id,stable({tenantId:row.tenant_id,principalId:row.principal_id,acquisitionId:row.id,generation:row.generation}),'p5:'+row.id+':'+row.generation+':'+stage]);
}
async function reusableCurrent(ctx:PeMutationContext,current:Awaited<ReturnType<typeof readCurrent>>,requested:Operation){
 if(!current.capability||!current.admission||current.status!=='SUPPORTED_DISPOSABLE')return null;
 const original=current.requestedOperation;
 if(original.meaning!==requested.meaning||original.account!==requested.account||original.entity!==requested.entity||original.field!==requested.field||original.unit!==requested.unit||original.currency!==requested.currency)return null;
 const row=await acquisition(ctx,current.acquisitionId);
 try{
  const ir=readModule(current.capability.generated.observerModule);
  if(ir.schema!=='finnor.p5.http-module.v1'||requested.value===null&&!ir.nullable)return null;
  // Matching names do not establish representability in the admitted module.
  wireValue(requested.value,ir.decimalPlaces,ir.encoding);
  const {grant}=await assertCurrent(ctx,row),port=practicePort(ctx,row,grant);
  await requireAccess(port,requested);
  const path=ir.path.replace('{'+ir.parameters.account+'}',encodeURIComponent(requested.account)).replace('{'+ir.parameters.entity+'}',encodeURIComponent(requested.entity));
  await tx(ctx,async c=>{
   const debit=await c.query('UPDATE finnor_os.p5_episodes SET reads_used=reads_used+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND reads_used<64 RETURNING id',[row.tenant_id,row.principal_id,row.episode_id]);
   if(!debit.rowCount)throw Error('P5_RECOVERY_READ_BOUND_EXHAUSTED');
   await append(ctx,row,'CATALOGUE_PRECONDITION_READ',{requestDigest:sha(requested),pathDigest:hash(path),readOnly:true},c);
  });
  const raw=await boundedFetch(new URL(path,grant.origin),'GET');
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const data=raw as Record<string,unknown>,fields=ir.readFields,keys=Object.values(fields);
  if(Object.keys(data).length!==keys.length||!keys.every(key=>Object.hasOwn(data,key))||
   data[fields.account]!==requested.account||data[fields.entity]!==requested.entity||data[fields.unit]!==requested.unit||data[fields.currency]!==requested.currency||
   data[fields.revision]!==requested.priorRevision||data[fields.operationId]===requested.operationId)return null;
  await requireAccess(port,requested);
  const again=await readCurrent(ctx,row.id);
  if(again.status!=='SUPPORTED_DISPOSABLE'||hash(again.admission)!==hash(current.admission)||
   again.capability?.generated.adapterModule.digest!==current.capability.generated.adapterModule.digest)return null;
  return again;
 }catch{
  await append(ctx,row,'CATALOGUE_PRECONDITION_REFUSED',{requestDigest:sha(requested),authorityGranted:false});
  return null;
 }
}
export async function handleInterfaceOperation(ctx:PeMutationContext,operation:string,body:unknown):Promise<{status:number;body:unknown}>{
 try{
  bounded(body);
  if(operation==='interface-acquire'){
   const request=AcquisitionRequestSchema.parse(body);operational();
   const rights=await authorize(ctx,request.root,[{type:'work',id:request.workId}]),grant=await access(ctx,request.sourceAccessId,request.workId);
   if(grant.account!==request.operation.account)throw unavailable();
   if(request.substrate==='UI'&&!grant.ui_path)throw Error('P5_UI_ACCESS_REQUIRED');
   if(request.programId){
    const p=await readCurrentProgram(ctx,request.programId);
    if(!p.program||p.workId!==request.workId)throw Error('P5_ACTUAL_ISSUED_PROGRAMME_REQUIRED');
   }
   const code=await codeIdentity(),digest=sha(request);
   const accepted=await tx(ctx,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5010))',[ctx.auth.tenantId+':'+principal(ctx)+':'+request.idempotencyKey]);
    const prior=(await c.query('SELECT id,request_digest,status FROM finnor_os.p5_acquisitions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
    if(prior){if(prior.request_digest!==digest)throw Error('P5_IDEMPOTENCY_REQUEST_CONFLICT');return {acquisitionId:prior.id,workId:request.workId,status:prior.status,replayed:true};}
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5011))',[ctx.auth.tenantId+':'+principal(ctx)+':'+request.workId]);
    await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.auth.tenantId,request.workId]);
    const input=(await c.query<{id:string;body:unknown}>('SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.auth.tenantId,request.workId])).rows[0];if(!input)throw unavailable();
    const episode=randomUUID();
    await c.query("INSERT INTO finnor_os.p5_episodes(id,tenant_id,principal_id,work_id,deadline_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '180 seconds') ON CONFLICT(tenant_id,principal_id,work_id) DO NOTHING",[episode,ctx.auth.tenantId,principal(ctx),request.workId]);
    const debit=(await c.query('UPDATE finnor_os.p5_episodes SET acquisition_count=acquisition_count+1 WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND acquisition_count<4 AND deadline_at>clock_timestamp() RETURNING id',[ctx.auth.tenantId,principal(ctx),request.workId])).rows[0];if(!debit)throw Error('P5_ORIGINAL_WORK_LEARNING_BOUND_EXHAUSTED');
    const id=randomUUID();
    await c.query('INSERT INTO finnor_os.p5_acquisitions(id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,episode_id,access_id,idempotency_key,request_digest,request,code_digest,rights_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)',
     [id,ctx.auth.tenantId,principal(ctx),request.workId,input.id,sha(input.body),debit.id,grant.id,request.idempotencyKey,digest,stable(request),code.digest,rights.revision]);
    const row=await acquisition(ctx,id,c);
    await append(ctx,row,'ACCEPTED',{sourceAccessRef:grant.id,requestedOperationDigest:sha(request.operation),requestDigest:digest,originalEpisode:debit.id,
     permittedDomain:'DISPOSABLE_NONCONSEQUENTIAL',operationalLimits:'4 acquisitions/Work, 4 learning deliveries, 4 physical mutations, 64 recovery reads, original 180 seconds',s5Grant:false,admission:null},c);
    await enqueue(ctx,row,'initial',c);
    return {acquisitionId:id,workId:request.workId,workRevision:input.id,status:'QUEUED',replayed:false};
   });return {status:202,body:accepted};
  }
  if(operation==='interface-projection'||operation==='interface-catalogue'||operation==='interface-ports'){
   const catalogueInput=operation==='interface-catalogue'?CatalogueRequestSchema.parse(body):null;
   const input=catalogueInput??ProjectionSchema.parse(body);
   await authorize(ctx,input.root,[{type:'work',id:input.workId}]);
   if(operation==='interface-ports')return {status:200,body:{schema:'finnor.p5.ports.v1',p1:{dependencyReader:'interface-read',issuedProgramInput:'programId',status:'CURRENT_ISSUED_WORK_BINDING_NOT_HARNESS_EFFECT_AUTHORITY'},
    p3:{status:'PENDING_AUTHENTICATED_GENERATED_HARNESS_PORT',localPureInterpreter:'S6_LOCAL_MACOS_SEATBELT',aggregateLimitsQualified:false},
    s6:{status:'ORIGINAL_PROTECTED_GATE_UNCHANGED',request:'EXACT_S3_S4_S5_CONDITIONAL_JSON_OWNER_BINDING_REQUIRED',generatedBrowserProtected:false},
    s8:{status:'ORDINARY_INTERFACE_PAYLOAD_PORT_IMPLEMENTED_INDEPENDENT_EVALUATION_REQUIRED',schema:'finnor.s8.interface-candidate.v1',protectedAdmission:false},
    p7:{status:'PENDING_P7_COMMITTED_PORT',changedInterfaceQuarantinesLocalCurrentUse:true,globalContinuationAuthority:false}}};
   const ids=await tx(ctx,async c=>(await c.query<{id:string;request:any}>('SELECT id,request FROM finnor_os.p5_acquisitions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT 4',[ctx.auth.tenantId,principal(ctx),input.workId])).rows,true);
   const acquisitions=[],reusable=[];
   for(const id of ids){
    if(stable(id.request.root)!==stable(input.root))continue;
    const current=await readCurrent(ctx,id.id);acquisitions.push(current);
    if(catalogueInput){const compatible=await reusableCurrent(ctx,current,catalogueInput.operation);if(compatible)reusable.push(compatible);}
   }
   await authorize(ctx,input.root,[{type:'work',id:input.workId}]);
   return {status:200,body:{schema:'finnor.p5.work-projection.v1',workId:input.workId,acquisitions,reusable,admissionAuthority:'S8_ONLY',protectedExecution:false}};
  }
  if(operation==='interface-read')return {status:200,body:await readCurrent(ctx,IdSchema.parse(body).acquisitionId)};
  if(operation==='interface-module'){
   const input=ModuleRequestSchema.parse(body),current=await readCurrent(ctx,input.acquisitionId);
   if(!current.capability||['CANCELLED','QUARANTINED','FAILED'].includes(current.status))throw Error('P5_CURRENT_MODULE_REQUIRED');
   const module=input.kind==='ADAPTER'?current.capability.generated.adapterModule:current.capability.generated.observerModule;
   if(hash(module.bytes)!==module.digest)throw Error('P5_MODULE_STORED_INTEGRITY');
   const again=await readCurrent(ctx,input.acquisitionId);
   if(again.capability?.generated.adapterModule.digest!==current.capability.generated.adapterModule.digest||again.status!==current.status)throw Error('P5_MODULE_CURRENTNESS_CHANGED');
   return {status:200,body:{module,admission:current.admission,protectedExecution:false}};
  }
  const input=operation==='interface-invoke'?InvocationRequestSchema.parse(body):IdSchema.parse(body),row=await acquisition(ctx,input.acquisitionId);
  await authorize(ctx,row.request.root,[{type:'work',id:row.work_id}]);const grant=await access(ctx,row.access_id,row.work_id);
  if(operation==='interface-cancel'){
   await tx(ctx,async c=>{const locked=await acquisition(ctx,row.id,c,true);if(locked.status==='CANCELLED')return;
    await c.query("UPDATE finnor_os.p5_acquisitions SET status='CANCELLED',generation=generation+1,reason='USER_CANCELLED_NEW_WORK_ONLY' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[row.tenant_id,row.principal_id,row.id]);
    await append(ctx,locked,'CANCELLED',{liabilityReleased:false,originalAttemptRetained:true,automaticMutationReplay:false},c);
   });return {status:200,body:await readCurrent(ctx,row.id)};
  }
  if(operation==='interface-resume'){
   operational();await assertCurrent(ctx,row,undefined,true);
   if(!['FAILED','RUNNING','QUEUED'].includes(row.status))throw Error('P5_ORIGINAL_RESUMABLE_FRONTIER_REQUIRED');
   const attempted=await attemptRow(ctx,row);if(attempted?.possible_egress)throw Error('P5_RECONCILE_POSSIBLE_EGRESS_BEFORE_RETRY');
   await tx(ctx,async c=>{
    const locked=await acquisition(ctx,row.id,c,true);
    const active=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'acquisitionId'=$2 AND status='running' AND lease_expires_at>clock_timestamp() LIMIT 1",[row.tenant_id,row.id])).rows[0];
    if(active)throw Error('P5_CURRENT_DELIVERY_STILL_ACTIVE');
    const counts=(await c.query('SELECT attempts_used,deadline_at FROM finnor_os.p5_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE',[row.tenant_id,row.principal_id,row.episode_id])).rows[0];
    if(counts.attempts_used>=4||counts.deadline_at.getTime()<=Date.now())throw Error('P5_ORIGINAL_LEARNING_BOUND_EXHAUSTED');
    await c.query("UPDATE finnor_os.p5_acquisitions SET status='QUEUED',claim_token=NULL,claim_fence=NULL WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[row.tenant_id,row.principal_id,row.id]);
    await enqueue(ctx,locked,'resume:'+counts.attempts_used,c);await append(ctx,locked,'RESUMED_ORIGINAL_FRONTIER',{originalGrantRetained:true,provenNoPossibleEgress:true},c);
   });return {status:202,body:{acquisitionId:row.id,originalGrantRetained:true}};
  }
  if(operation==='interface-reconcile'){
   operational();await assertCurrent(ctx,row,undefined,true);
   const attempted=await attemptRow(ctx,row);
   if(!attempted?.possible_egress||!row.generated)throw Error('P5_ORIGINAL_POSSIBLE_ATTEMPT_REQUIRED');
   const port=practicePort(ctx,row,grant);
   const practice=await observeHttp(row.generated,row.request.operation,port,attempted.body);
   await port.record({stage:'COMPLETED',attempt:attempted.body,body:practice});
   await tx(ctx,async c=>{
    const locked=await acquisition(ctx,row.id,c,true);await assertCurrent(ctx,locked,c);
    if(locked.generation!==row.generation||['CANCELLED','QUARANTINED'].includes(locked.status)){
     await append(ctx,locked,'LATE_OBSERVATION_FENCED',{digest:sha(practice),liabilityReleased:false},c);return;
    }
    const counts=(await c.query('SELECT attempts_used FROM finnor_os.p5_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.episode_id])).rows[0];
    const execution={workerId:'AUTHENTICATED_READ_ONLY_RECONCILIATION',jobId:'none-read-only',deliveryAttemptId:attempted.body.id,claimFence:0};
    await publish(ctx,locked,buildCapability(locked,locked.generated!,practice,execution,counts.attempts_used),c);
   });return {status:200,body:await readCurrent(ctx,row.id)};
  }
  if(operation==='interface-admission'){
   await assertCurrent(ctx,row,undefined,true);
   const current=await readCurrent(ctx,row.id);
   if(current.practice?.status!=='VERIFIED'||!current.capability||!row.s8_candidate)throw Error('P5_INDEPENDENT_EVALUATED_CANDIDATE_REQUIRED');
   const policy=await interfaceConsumerPolicy({tenantId:row.tenant_id,principalId:row.principal_id});
   if(!policy)throw Error('P5_S8_INTERFACE_CONSUMER_UNAVAILABLE');
   const admission=await currentInterfaceCandidate(row.s8_candidate,policy,'p5-admission-read:'+randomUUID());
   if(!admission)return {status:424,body:{predicate:'S8_INDEPENDENT_EVALUATION_AND_PROMOTION_REQUIRED',admission:null}};
   await tx(ctx,async c=>{const locked=await acquisition(ctx,row.id,c,true);await assertCurrent(ctx,locked,c);
    if(locked.generation!==row.generation||['CANCELLED','QUARANTINED'].includes(locked.status))throw Error('P5_ADMISSION_PUBLICATION_FENCED');
    const old=current.capability!;
    await publish(ctx,locked,buildCapability(locked,old.generated,old.practice,old.runtime,old.costs.attempts,admission),c);
   });return {status:200,body:await readCurrent(ctx,row.id)};
  }
  if(operation==='interface-invoke'){
   await assertCurrent(ctx,row,undefined,true);
   const current=await readCurrent(ctx,row.id);
   // An ordinary interface admission is not an S3/S4/S5/S6 effect receipt.
   // No supplied JSON reference can cross that missing protected owner join.
   return {status:424,body:{predicate:current.admission?'P5_CURRENT_S3_S4_S5_S6_EXACT_EFFECT_BINDING_REQUIRED':'P5_CURRENT_INDEPENDENT_S8_ADMISSION_REQUIRED',
    admission:current.admission,protectedDispatch:false,originalOperationDigest:sha('operation'in input?input.operation:row.request.operation),
    p1:row.request.programId??null,p3:'PENDING_QUALIFIED_GENERATED_HARNESS_PORT',p7:'PENDING_P7_COMMITTED_PORT'}};
  }
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  if((error as {code?:string}).code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'PE_ENTITY_NOT_FOUND',error:'Interface unavailable in authenticated scope'}};
  if(error instanceof z.ZodError)return {status:400,body:{code:'P5_SCHEMA_INVALID'}};
  const predicate=String((error as Error).message).match(/^P5_[A-Z0-9_]+$/)?.[0]??'P5_OWNER_OR_RUNTIME_UNAVAILABLE';
  return {status:predicate==='P5_IDEMPOTENCY_REQUEST_CONFLICT'?409:422,body:{code:'P5_PREDICATE_UNPASSED',predicate}};
 }
}
