/** Ordinary private artifacts and existing durable Work/jobs/S5, never a second ledger. */
import {constants} from 'node:fs';
import {mkdir,lstat,open,link,unlink,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {EvidenceDependency,ExperimentRef} from '@finnor/shared-types';
import {recordBusinessEvent} from '@finnor/data-platform';
import type {JobExecutionContext} from '../../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../../types';
import {authorize,assertDependencies,principal,revisions,tx,unavailable} from '../../owner-context';
import {assertApplicationAllocationCurrent,chargeApplicationParent,applicationParentCharges,type ApplicationAllocation} from '../../application-semantics/allocation';
import {withS5PortfolioTransaction} from '../../allocation-store';
import type {NativeReceipt,NativeMeters} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/native';
import type {ExactRequest} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import type {CheckedExecution} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {canonical,acceptedDefinition,planReference,developmentOnly,JOB,sha,safePredicate,type Submit} from './contracts';
export {principal,tx,authorize,revisions,unavailable};
import {codeIdentity} from './identity';
export {codeIdentity};
export interface Original {
 schema:'finnor.z4.original.v1';sessionId:string;tenantId:string;principalId:string;request:Submit;
 exact:ExactRequest;workInputDigest:string;rightsRevision:number;rightsRef:string;rightsFingerprint:string;ownerSourceDigest:string;
 dependencies:EvidenceDependency[];code:Awaited<ReturnType<typeof codeIdentity>>;
 preparationRef:ExperimentRef;allocation:ApplicationAllocation;obligations:Awaited<ReturnType<typeof obligations>>;
 createdAt:string;
}
export interface Delivery {
 useId:string;idempotencyKey:string;targetDigest:string;owner:'S3'|'S4';capsuleDigest:string;
 state:'DELIVERING'|'ACKNOWLEDGED'|'UNKNOWN';leaseUntil:string;acks:Array<'BEFORE'|'AFTER'>;resultDigest?:string;
}
export interface JobState {
 schema:'finnor.z4.job.v1';principalId:string;sessionId:string;originalDigest:string;
 status:'QUEUED'|'RUNNING'|'CHECKED'|'CANCELLED'|'STALE'|'INCOMPLETE';
 checkpointDigest?:string;capsuleDigest?:string;failure?:string;attempts:number;events:string[];delivery?:Delivery;
 cpuReservedSeconds:number;cpuLimitSeconds:number;retainedBytes:number;retainedByteLimit:number;
 activeAttempt?:{deliveryAttemptId:string;claimFence:number;workerId:string;startedAt:string};
}
export interface JobRow {id:string;tenant_id:string;status:string;payload:{tenantId:string;principalId:string;sessionId:string;workId:string;
 workInputId:string;workRevisionRef:ExperimentRef;definitionDigest:string;z4:JobState};claim_token:string|null;claim_fence:number}
export interface Capsule {
 schema:'finnor.z4.execution-proof-capsule.v2';originalDigest:string;sessionId:string;
 envelope:Record<string,unknown>;checked:CheckedExecution;createdAt:string;
 executionAuthorityGranted:false;protectedAdmission:'NOT_RUN';securityAdmission:'NOT_RUN';
}
function base(){
 const value=process.env.FINNOR_Z4_CAPSULE_STORE;
 if(!value||!value.startsWith('/'))throw Error('Z4_PRIVATE_CAPSULE_STORE_REQUIRED');
 return resolve(value);
}
async function privateDirectory(path:string){
 await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);
 if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||await realpath(path)!==path)throw unavailable();
}
async function directory(ctx:PeMutationContext,category:string){
 if(![ctx.auth.tenantId,principal(ctx)].every(s=>/^[a-f0-9-]{36}$/i.test(s))||!['original','checkpoint','capsule','event','delivery'].includes(category))throw unavailable();
 const root=base(),tenant=join(root,ctx.auth.tenantId),actor=join(tenant,principal(ctx)),path=join(actor,category);
 for(const p of [root,tenant,actor,path])await privateDirectory(p);
 return path;
}
export async function retain(ctx:PeMutationContext,category:string,body:unknown,c?:PoolClient){
 const bytes=canonical(body),digest=sha(body),dir=await directory(ctx,category);
 if(Buffer.byteLength(bytes)>12*1024*1024)throw Error('Z4_ARTIFACT_BYTE_BOUND');
 if(category!=='original'){
  const sessionId=(body as {sessionId?:unknown})?.sessionId;
  if(typeof sessionId!=='string')throw Error('Z4_ARTIFACT_ORIGINAL_SESSION_REQUIRED');
  const reserve=async(client:PoolClient)=>{
   const row=await job(ctx,sessionId,client,true),state=row.payload.z4,n=Buffer.byteLength(bytes);
   if(state.retainedBytes+n>state.retainedByteLimit)throw Error('Z4_ORIGINAL_RETAINED_BYTE_BUDGET_EXHAUSTED');
   await setState(ctx,row,{...state,retainedBytes:state.retainedBytes+n},client);
  };
  if(c)await reserve(c);else await tx(ctx,reserve);
 }
 const temporary=join(dir,`.${randomUUID()}.tmp`),target=join(dir,digest+'.json');
 const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 try{
  await link(temporary,target);
 }catch(e){
  if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  if(canonical(await artifact(ctx,category,digest))!==bytes)throw Error('Z4_IMMUTABLE_ARTIFACT_CONFLICT');
 }finally{await unlink(temporary).catch(()=>undefined);}
 const fd=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}
 return digest;
}
export async function artifact<T=unknown>(ctx:PeMutationContext,category:string,digest:string):Promise<T>{
 if(!/^[a-f0-9]{64}$/.test(digest))throw unavailable();
 const f=await open(join(await directory(ctx,category),digest+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const s=await f.stat();if(!s.isFile()||s.size>12*1024*1024||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw unavailable();
  const body=JSON.parse(await f.readFile('utf8'));if(sha(body)!==digest)throw Error('Z4_ARTIFACT_INTEGRITY');return body as T;
 }finally{await f.close();}
}
export async function job(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false):Promise<JobRow>{
 if(!/^[a-f0-9-]{36}$/i.test(id))throw unavailable();
 const read=async(client:PoolClient)=>{
  const row=(await client.query<JobRow>(
   `SELECT id::text,tenant_id::text,status,payload,claim_token::text,claim_fence FROM finnor_os.jobs
    WHERE tenant_id=$1 AND id=$2 AND type=$3 AND payload->>'principalId'=$4`+(lock?' FOR UPDATE':''),
   [ctx.auth.tenantId,id,JOB,principal(ctx)])).rows[0];
  if(!row||row.payload.z4?.schema!=='finnor.z4.job.v1'||row.payload.z4.sessionId!==id||row.payload.sessionId!==id||
   row.payload.tenantId!==ctx.auth.tenantId||row.payload.z4.principalId!==principal(ctx))throw unavailable();
  return row;
 };
 return c?read(c):tx(ctx,read,true);
}
export async function original(ctx:PeMutationContext,row:JobRow){
 const o=await artifact<Original>(ctx,'original',row.payload.z4.originalDigest);
 if(o.schema!=='finnor.z4.original.v1'||o.sessionId!==row.id||o.tenantId!==ctx.auth.tenantId||o.principalId!==principal(ctx)||
  o.request.workId!==row.payload.workId||o.request.workInputId!==row.payload.workInputId||
  sha(o.request.workRevisionRef)!==sha(row.payload.workRevisionRef)||sha(acceptedDefinition(o.request))!==row.payload.definitionDigest)throw unavailable();
 await authorize(ctx,o.request.root,[{type:'work',id:o.request.workId}]);return o;
}
export async function workSnapshot(ctx:PeMutationContext,request:Submit,c?:PoolClient,historicalRead=false){
 const read=async(client:PoolClient)=>{
  const row=(await client.query<{id:string;body:{context_snapshot?:{executionProofAcceptedRequestDigest?:string};instruction_text?:string;created_by?:string};status:string;created_by:string}>(
   `SELECT i.id::text,to_jsonb(i) body,w.status,w.created_by::text FROM finnor_os.works w
    JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
    WHERE w.tenant_id=$1 AND w.id=$2 ORDER BY i.created_at DESC,i.id DESC LIMIT 1`,
   [ctx.auth.tenantId,request.workId])).rows[0];
  if(!row||row.id!==request.workInputId||row.created_by!==principal(ctx)||row.body.created_by!==principal(ctx)||
   row.body.instruction_text!==request.purpose||row.body.context_snapshot?.executionProofAcceptedRequestDigest!==sha(acceptedDefinition(request))||
   ['cancelled','failed','closed'].includes(row.status)||row.status==='completed'&&!historicalRead)throw Error('Z4_ORIGINAL_CURRENT_WORK_INPUT_REQUIRED');
  const plan=(await client.query(`SELECT id::text,revision,semantic_hash,work_input_id::text,status,constraint_set,goal_spec,completion_proof
   FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 AND id=$3`,
   [ctx.auth.tenantId,request.workId,request.workRevisionRef.id])).rows[0];
  const completedHistory=historicalRead&&row.status==='completed'&&plan?.status==='completed'&&
   plan.completion_proof?.verified===true&&plan.completion_proof?.planRevisionId===request.workRevisionRef.id&&
   plan.completion_proof?.finalPlanRevisionId===request.workRevisionRef.id;
  if(!plan||plan.status!=='active'&&!completedHistory||plan.work_input_id!==request.workInputId||sha(planReference(plan))!==sha(request.workRevisionRef)||
   plan.constraint_set?.deadlineAt!==request.deadlineAt)throw Error('Z4_ORIGINAL_PLAN_OR_DEADLINE_CHANGED');
  for(const [field,expected] of Object.entries({status:'CHECKED',definitionDigest:sha(acceptedDefinition(request)),nativeOwnerConsumed:true}))
   if(!plan.goal_spec?.criteria?.some((item:{criterion?:{kind?:string;request?:{intent?:string;workId?:string};assertion?:{operator?:string;path?:string[];expected?:unknown}}})=>{
    const q=item.criterion;return q?.kind==='canonical_query'&&q.request?.intent==='execution_proof_capsule_v1'&&q.request.workId===request.workId&&
     q.assertion?.operator==='eq'&&q.assertion.path?.join('.')==='data.'+field&&q.assertion.expected===expected;
   }))throw Error('Z4_ORIGINAL_COMPLETION_CONDITION_CHANGED');
  return {id:row.id,digest:sha(row.body),status:row.status,planRevision:request.workRevisionRef};
 };
 return c?read(c):tx(ctx,read,true);
}
export async function obligations(ctx:PeMutationContext){
 return tx(ctx,async c=>{
  const complete=(await c.query<{complete:boolean}>('SELECT finnor_os.y4_control_context_complete() complete')).rows[0]?.complete===true;
  const refs=(await c.query<{id:string;status:string}>(`SELECT id::text,status FROM finnor_os.business_effects WHERE tenant_id=$1
   AND status NOT IN ('verified','cancelled','compensated') ORDER BY id LIMIT 129`,[ctx.auth.tenantId])).rows;
  if(refs.length>128)throw Error('Z4_NATIVE_OBLIGATION_PAGINATION_REQUIRED');
  return {contextComplete:complete,refs:refs.map(r=>({owner:'S6',id:r.id,status:r.status})),unknown:!complete||refs.some(r=>r.status==='unknown')};
 },true);
}
export async function claim(ctx:PeMutationContext,row:JobRow,execution:Readonly<JobExecutionContext>,c?:PoolClient){
 const check=async(client:PoolClient)=>{
  const fresh=await job(ctx,row.id,client,true);
  if(fresh.status!=='running'||fresh.claim_token!==execution.claimToken||Number(fresh.claim_fence)!==execution.claimFence||
   fresh.payload.z4.status==='CANCELLED'||fresh.payload.z4.status==='STALE')throw Error('Z4_PHYSICAL_JOB_CLAIM_FENCED');
  const live=(await client.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a
   ON a.tenant_id=j.tenant_id AND a.job_id=j.id AND a.id=$3
   WHERE j.tenant_id=$1 AND j.id=$2 AND j.lease_owner=$4 AND j.lease_expires_at>clock_timestamp()
    AND a.worker_id=j.lease_owner AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence
    AND a.outcome='running' AND a.finished_at IS NULL FOR SHARE OF a`,
   [ctx.auth.tenantId,row.id,execution.deliveryAttemptId,execution.workerId])).rows[0];
  if(!live)throw Error('Z4_PHYSICAL_JOB_LEASE_EXPIRED');
  return fresh;
 };
 return c?check(c):tx(ctx,check);
}
export async function setState(ctx:PeMutationContext,row:JobRow,state:JobState,c:PoolClient){
 if(state.sessionId!==row.id||state.originalDigest!==row.payload.z4.originalDigest)throw Error('Z4_ORIGINAL_IDENTITY_CHANGE_FORBIDDEN');
 const changed=await c.query("UPDATE finnor_os.jobs SET payload=jsonb_set(payload,'{z4}',$3::jsonb),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND payload->'z4'=$4::jsonb",
  [ctx.auth.tenantId,row.id,canonical(state),canonical(row.payload.z4)]);
 if(changed.rowCount!==1)throw Error('Z4_CONCURRENT_ORIGINAL_STATE_CHANGED');
}
export async function current(ctx:PeMutationContext,o:Original,options:{historicalRead?:boolean}={}){
 developmentOnly();
 if(Date.parse(o.request.deadlineAt)<=Date.now())throw Error('Z4_ORIGINAL_DEADLINE_EXHAUSTED');
 const rights=await authorize(ctx,o.request.root,[{type:'work',id:o.request.workId}]);
 if(rights.revision!==o.rightsRevision)throw Error('Z4_RIGHTS_REVISED_OR_REVOKED');
 if((await workSnapshot(ctx,o.request,undefined,options.historicalRead)).digest!==o.workInputDigest)throw Error('Z4_WORK_INPUT_CHANGED');
 await assertDependencies(ctx,o.dependencies);
 if((await codeIdentity()).digest!==o.code.digest)throw Error('Z4_COMPILER_CHECKER_OR_NATIVE_CHANGED');
 const allocation=await assertApplicationAllocationCurrent(ctx,o.allocation.certificate.ref);
 if(allocation.certificate.workId!==o.request.workId||allocation.certificate.deadlineAt!==o.request.deadlineAt||
  allocation.certificate.rightsRef!==o.rightsRef||sha(allocation.certificate)!==sha(o.allocation.certificate))throw Error('Z4_ORIGINAL_S5_ENVELOPE_CHANGED');
 const {ownerSource}=await import('./source');const source=await ownerSource(ctx,o.request);
 if(source.digest!==o.ownerSourceDigest||source.rightsFingerprint!==o.rightsFingerprint||canonical(source.inputs)!==canonical(o.exact.inputs))throw Error('Z4_CURRENT_OWNER_SOURCE_OR_TERMS_CHANGED');
 return source;
}
export async function event(ctx:PeMutationContext,id:string,kind:string,detail:unknown,c?:PoolClient){
 const body={schema:'finnor.z4.event.v1',sessionId:id,tenantId:ctx.auth.tenantId,principalId:principal(ctx),kind,
  at:new Date().toISOString(),nonce:randomUUID(),detail},digest=await retain(ctx,'event',body,c);
 const write=async(client:PoolClient)=>{
  const row=await job(ctx,id,client,true);
  if(row.payload.z4.events.length>=256)throw Error('Z4_EVENT_BOUND');
  await setState(ctx,row,{...row.payload.z4,events:[...row.payload.z4.events,digest]},client);
 };
 if(c)await write(c);else await tx(ctx,write);
 return digest;
}
export async function charge(ctx:PeMutationContext,o:Original,operation:string,cpuSeconds=1){
 if(!Number.isSafeInteger(cpuSeconds)||cpuSeconds<1||cpuSeconds>900)throw Error('Z4_PROCESS_CPU_BOUND');
 return withS5PortfolioTransaction(ctx,async c=>{
  const charged=await chargeApplicationParent(ctx,{allocationRef:o.allocation.certificate.ref,consumptionRef:o.allocation.rootConsumption.ref,
   requestRef:o.preparationRef,phase:operation==='prove'?'EXECUTION':operation==='RECOVERY'?'RECOVERY':'CHECKING',
   key:`z4:${o.sessionId}:${operation}:${randomUUID()}`,units:1},c);
  const row=await job(ctx,o.sessionId,c,true),state=row.payload.z4;
  if(['CANCELLED','STALE'].includes(state.status)||state.cpuReservedSeconds+cpuSeconds>state.cpuLimitSeconds)throw Error('Z4_ORIGINAL_CPU_BUDGET_EXHAUSTED_OR_CANCELLED');
  await setState(ctx,row,{...state,cpuReservedSeconds:state.cpuReservedSeconds+cpuSeconds},c);
  return charged;
 });
}
export async function observe(ctx:PeMutationContext,o:Original,receipt:NativeReceipt|{operation:string;failure:string;meters:NativeMeters|null}){
 const safe='failure'in receipt?receipt:{operation:receipt.operation,meters:receipt.meters,binarySha256:receipt.binarySha256,sourceDigest:receipt.sourceDigest};
 const receiptRef=await event(ctx,o.sessionId,'NATIVE_COST_OBSERVED',safe);
 await tx(ctx,async(_c,db)=>recordBusinessEvent(db,{tenantId:ctx.auth.tenantId,entityType:'work',entityId:o.request.workId,
  eventType:'z4_execution_proof_cost_recorded',payload:{workId:o.request.workId,sessionId:o.sessionId,receiptDigest:receiptRef,
   operation:receipt.operation,meters:receipt.meters,money:null,status:'LOCAL_COST_UNMETERED',executionAuthorityGranted:false},source:'@finnor/private-equity'}));
}
export async function costs(ctx:PeMutationContext,o:Original,row:JobRow){
 const recorded=await Promise.all(row.payload.z4.events.map(d=>artifact<{kind:string;detail:unknown;at:string}>(ctx,'event',d)));
 const events=recorded.map(e=>({kind:e.kind,at:e.at,...(e.kind==='NATIVE_COST_OBSERVED'?{process:e.detail}:{})}));
 return {events,charges:await applicationParentCharges(ctx,o.allocation.certificate.ref),money:null,tokens:null,humanSeconds:null,
  aggregateRSS:null,eligibleReuseN:0,eligibleReuseBasis:'NO_INDEPENDENT_ELIGIBLE_DEMAND_REGISTRATION',
  observedAnalyticalDeliveries:recorded.filter(e=>e.kind==='NATIVE_OWNER_ACKNOWLEDGED').length,
  releaseSufficient:false,unknownAttemptCosts:events.filter(e=>e.kind==='LOST_PHYSICAL_ATTEMPT').length};
}
export async function failureEvent(ctx:PeMutationContext,id:string,error:unknown){
 await event(ctx,id,'INCOMPLETE',{predicate:safePredicate(error),usableProof:false,money:null,remainingObligations:'RETAINED_BY_ORIGINAL_S6'});
}
