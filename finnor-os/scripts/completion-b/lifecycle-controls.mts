/** Failure-first actual owner/SQL controls, explicitly selected outside original suites. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readFile,realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {works,withDatabaseExecutionDeadline,DatabaseExecutionDeadlineError,PRODUCTION_JOB_CONTRACTS} from '@finnor/db';
import {peTransaction,peClientTransaction} from '../../packages/private-equity/src/repository';
import {JobQueue,type JobExecutionContext} from '../../apps/worker/src/queue';
import {runCapitalProgramJob} from '../../packages/private-equity/src/capital-program/worker';
import {m3Query,m3Tx} from '../../packages/private-equity/src/capital-program/v2-store';
import type {PeMutationContext} from '../../packages/private-equity/src/types';

interface Support {
 scope:any;request:any;admin:any;api:(scope:any,operation:string,body:unknown)=>Promise<any>;
 artifact:(name:string,value:unknown)=>Promise<unknown>;
}
const context=(scope:any):PeMutationContext=>({auth:{tenantId:scope.tenant,userId:scope.principal,
 employeeId:scope.principal,role:'owner'},provenance:{sourceSystem:'completion-b-lifecycle-control',createdBy:scope.principal}});
const pgCode=(error:any)=>error.code??error.cause?.code;

export async function peCorrespondence(s:Support){
 const ctx=context(s.scope),observations:any[]=[],marker='completion-b-pe-rollback:'+randomUUID(),
  before=(await s.admin.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[s.scope.workId])).rows[0],
  rollback=new Error('owned-PE-rollback');
 const settings=`SELECT pg_backend_pid() pid,current_setting('app.tenant_id') tenant,
  current_setting('app.user_id') principal,current_setting('app.pe_actor') actor,
  current_setting('app.pe_source') source,current_setting('transaction_isolation') isolation,
  current_setting('transaction_read_only') read_only`;
 await assert.rejects(()=>peTransaction(ctx,async(db,client)=>{
  const raw=(await client.query(settings)).rows[0],orm=(await db.execute(sql.raw(settings))).rows[0];
  assert.deepEqual(orm,raw);assert.equal(raw.tenant,s.scope.tenant);assert.equal(raw.principal,s.scope.principal);
  assert.equal(raw.actor,s.scope.principal);assert.equal(raw.source,ctx.provenance!.sourceSystem);
  assert.equal(raw.isolation,'serializable');assert.equal(raw.read_only,'off');
  const relational=await db.query.works.findFirst({where:eq(works.id,s.scope.workId),columns:{id:true,tenantId:true}});
  assert.deepEqual(relational,{id:s.scope.workId,tenantId:s.scope.tenant});
  const prototype=Object.getPrototypeOf(db);assert.equal(prototype.constructor.name,'NodePgDatabase');
  assert.equal(Reflect.get(db,'$client'),client);assert(Reflect.ownKeys(db).includes('query'));
  const key=Symbol('owned-pe-ORM-descriptor');
  Object.defineProperty(db,key,{value:marker,configurable:false});
  assert.equal(Reflect.get(db,key),marker);assert.equal(Reflect.deleteProperty(db,key),false);
  await db.update(works).set({sessionId:marker}).where(eq(works.id,s.scope.workId));
  assert.equal((await client.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[s.scope.workId])).rows[0].session_id,marker);
  Object.freeze(db);assert(Object.isFrozen(db));assert.equal(Object.getPrototypeOf(db),prototype);
  assert.deepEqual((await db.execute(sql.raw(settings))).rows[0],raw);
  observations.push({guard:'ACTUAL_PE_ORM_RAW_ACTOR_SOURCE_ISOLATION_REFLECTION',raw,relational,frozenSameBackend:true});
  throw rollback;
 }),error=>error===rollback);
 assert.deepEqual((await s.admin.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[s.scope.workId])).rows[0],before);
 const raw=await peClientTransaction(ctx,async client=>{
  const scope=(await client.query(settings)).rows[0],
   rows=(await client.query('SELECT id::text,tenant_id::text FROM finnor_os.works WHERE id=$1',[s.scope.workId])).rows;
  assert.equal(scope.isolation,'repeatable read');assert.equal(scope.read_only,'on');
  assert.deepEqual(rows,[{id:s.scope.workId,tenant_id:s.scope.tenant}]);return {scope,rows};
 },{readOnly:true});
 observations.push({guard:'ACTUAL_PE_RAW_REPEATABLE_READ',...raw});
 const foreign=await peTransaction({...ctx,auth:{...ctx.auth,tenantId:randomUUID()}},async()=>true)
  .then(()=>({code:'UNEXPECTED_ACCEPTANCE'}),error=>({code:pgCode(error)}));
 assert.equal(foreign.code,'PE_VERTICAL_INACTIVE');
 await assert.rejects(()=>peTransaction(ctx,db=>db.update(works).set({sessionId:marker}).where(eq(works.id,s.scope.workId)),
  {readOnly:true}),(error:any)=>pgCode(error)==='25006');
 await assert.rejects(()=>withDatabaseExecutionDeadline(performance.now()+100,()=>peTransaction(ctx,async db=>{
  await db.execute(sql`SELECT pg_sleep(1)`);
 })),error=>error instanceof DatabaseExecutionDeadlineError||(error as any).cause instanceof DatabaseExecutionDeadlineError);
 const independent=(await s.admin.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[s.scope.workId])).rows[0];
 assert.deepEqual(independent,before);
 await s.artifact('lifecycle/pe-transaction-correspondence.json',{observations,foreign,independent,
  qualification:'ACTUAL_ORDINARY_PE_WRAPPERS_NOT_SPEEDUP_OR_OWNER_CACHE_PROOF',usd:null});
 return {observations,foreign,rollbackObserved:true,physicalSQLDeadlineObserved:true,usd:null};
}

export async function queryLifecycleCorrespondence(s:Support){
 const module:Record<string,unknown>=await import('../../packages/private-equity/src/capital-program/v2-store');
 const lifecycle=module.m3Lifecycle as undefined|((ctx:PeMutationContext,id:string,c?:any,lock?:boolean)=>Promise<Record<string,unknown>>);
 await s.artifact('lifecycle/projection-availability.json',{actualOwnerFunction:typeof lifecycle,
  qualification:'ACTUAL_EXPORTED_OWNER_PORT_NOT_FABRICATED_RESULT',usd:null});
 assert.equal(typeof lifecycle,'function','Actual authenticated M3 lifecycle projection is unavailable');
 const ctx=context(s.scope),observations:any[]=[];
 const submitted=await s.api(s.scope,'capital-program-submit',{...structuredClone(s.request),idempotencyKey:randomUUID(),
  permitted:{...s.request.permitted,terms:['0.15'],structures:['IMMEDIATE']}});
 assert.equal(submitted.status,202);const queryId=submitted.body.queryId;
 const observe=async(phase:string,id=queryId)=>m3Tx(ctx,async c=>{
  const full=await m3Query(ctx,id,c,true),projected=await lifecycle!(ctx,id,c),
   expected=Object.fromEntries(Object.entries(full).filter(([key])=>key!=='request'&&key!=='acceptance'));
  assert.deepEqual(projected,expected);assert(!('request'in projected)&&!('acceptance'in projected));
  observations.push({phase,queryId:id,status:projected.status,generation:projected.generation,
   firstStartedAt:projected.first_started_at,deadlineAt:projected.deadline_at,
   projectedKeys:Object.keys(projected).sort(),fullAcceptanceBytes:Buffer.byteLength(JSON.stringify(full.acceptance)),
   sameCurrentRowObserved:true});
  return projected;
 });
 assert.equal((await observe('ACTUAL_QUEUED_ROW')).status,'QUEUED');
 let actual:Readonly<JobExecutionContext>|undefined,registered:Promise<void>|undefined;
 let activeId=queryId,mode:'SUCCESS'|'CANCELLED'|'FAILED'='SUCCESS';
 const queue=new JobQueue('completion-b-lifecycle:'+randomUUID(),3);
 queue.register('run_capital_program_v2',async(payload,execution)=>{
  assert(execution);assert.equal(payload.queryId,activeId);actual=execution;registered=undefined;
  const callbacks:Array<()=>Promise<boolean>>=[];
  await runCapitalProgramJob(payload,Object.freeze({...execution,registerHeartbeat(callback:()=>Promise<boolean>){
   callbacks.push(callback);registered=observe('ACTUAL_REGISTERED_RUNNING_'+mode+'_ROW',activeId).then(row=>{
    assert.equal(row.status,'RUNNING');
   });
   execution.registerHeartbeat(async()=>{await registered;return callback();});
  }}));
  await registered;
  const row=await observe('ACTUAL_'+mode+'_BEFORE_ACK',activeId);
  if(mode==='SUCCESS'){
   assert(['PARTIAL','TESTED'].includes(row.status as string));assert(row.result_digest);
   assert.equal(callbacks.length,1);assert(await callbacks[0]!(),'Matching durable publication was fenced before ACK');
  }else{
   assert.equal(row.status,mode);assert.equal(row.result_digest,null);
   if(mode==='FAILED'){assert.equal(callbacks.length,1);assert.equal(await callbacks[0]!(),false);}
   else assert.equal(callbacks.length,0,'A queued cancellation registered new search work');
  }
 },PRODUCTION_JOB_CONTRACTS.run_capital_program_v2);
 assert(await queue.tick());assert(actual);
 const job=(await s.admin.query('SELECT status FROM finnor_os.jobs WHERE id=$1',[actual.jobId])).rows[0];
 assert.equal(job.status,'completed');await observe('ACTUAL_POST_ACK_ROW');
 const submit=async()=>{
  const accepted=await s.api(s.scope,'capital-program-submit',{...structuredClone(s.request),idempotencyKey:randomUUID(),
   permitted:{...s.request.permitted,terms:['0.15'],structures:['IMMEDIATE']}});
  assert.equal(accepted.status,202);return accepted.body.queryId as string;
 };
 const cancelId=await submit(),beforeCancel=await observe('ACTUAL_QUEUED_BEFORE_CANCEL_ROW',cancelId),
  cancelled=await s.api(s.scope,'capital-program-cancel',{queryId:cancelId});
 assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'CANCELLED');
 const afterCancel=await observe('ACTUAL_CANCELLED_GENERATION_ROW',cancelId);
 assert.equal(afterCancel.status,'CANCELLED');assert.equal(afterCancel.generation,Number(beforeCancel.generation)+1);
 assert.deepEqual(afterCancel.deadline_at,beforeCancel.deadline_at);
 activeId=cancelId;mode='CANCELLED';assert(await queue.tick());
 const cancelJob=(await s.admin.query('SELECT status FROM finnor_os.jobs WHERE id=$1',[actual.jobId])).rows[0];
 assert.equal(cancelJob.status,'completed');assert.equal((await observe('ACTUAL_CANCELLED_POST_ACK_ROW',cancelId)).status,'CANCELLED');
 const failedId=await submit(),root=resolve(process.env.FINNOR_S4_POLICY_STORE!),
  parent=join(root,s.scope.tenant,s.scope.principal,'policies'),
  policyPath=join(parent,s.request.incumbentPolicyRef.contentDigest+'.json');
 assert(root.startsWith(resolve(process.env.FINNOR_COMPLETION_B_EVIDENCE_DIR!)+sep),'Fault target is outside this owned invocation');
 assert(/^[a-f0-9]{64}$/.test(s.request.incumbentPolicyRef.contentDigest));
 for(const directory of [root,join(root,s.scope.tenant),join(root,s.scope.tenant,s.scope.principal),parent]){
  const st=await lstat(directory);assert(st.isDirectory()&&!st.isSymbolicLink());
  assert.equal(st.uid,process.getuid?.());assert.equal(st.mode&0o077,0);assert.equal(await realpath(directory),directory);
 }
 const policy=await open(policyPath,constants.O_RDONLY|constants.O_NOFOLLOW),st=await policy.stat();
 assert(st.isFile());assert.equal(st.uid,process.getuid?.());assert.equal(st.nlink,1);assert.equal(st.mode&0o777,0o400);
 const policySHA256=createHash('sha256').update(await policy.readFile()).digest('hex');
 activeId=failedId;mode='FAILED';
 try{await policy.chmod(0);assert(await queue.tick());}
 finally{try{await policy.chmod(st.mode&0o777);}finally{await policy.close();}}
 assert.equal(createHash('sha256').update(await readFile(policyPath)).digest('hex'),policySHA256);
 assert.equal((await lstat(policyPath)).mode&0o777,st.mode&0o777);
 const failed=await observe('ACTUAL_FAILED_POST_ACK_ROW',failedId),
  failureEvents=(await s.admin.query("SELECT kind,body-'claimToken' body FROM finnor_os.m3_events WHERE query_id=$1 ORDER BY created_at,id",[failedId])).rows,
  failedJob=(await s.admin.query('SELECT status FROM finnor_os.jobs WHERE id=$1',[actual.jobId])).rows[0];
 assert.equal(failed.status,'FAILED');assert.equal(failed.result_digest,null);
 assert.equal((failed.failure as any).code,'OWNER_OR_STORAGE_FAILURE');
 assert.equal(failedJob.status,'completed');
 assert(failureEvents.some((event:any)=>event.kind==='FAILED'&&event.body.costsRetained&&event.body.attemptCost.money===null));
 assert.equal((await s.admin.query('SELECT count(*)::int n FROM finnor_os.m3_publications WHERE query_id=$1',[failedId])).rows[0].n,0);
 const denied:string[]=[];
 for(const auth of [{...ctx.auth,tenantId:randomUUID()},{...ctx.auth,userId:randomUUID(),employeeId:randomUUID()}]){
  await assert.rejects(()=>lifecycle!({...ctx,auth},queryId),(error:any)=>{denied.push(error.code);return error.code==='UNAVAILABLE';});
 }
 const originalStatus=(await s.admin.query('SELECT status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',
  [s.scope.tenant,s.scope.principal])).rows[0].status;
 try{
  await s.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[s.scope.tenant,s.scope.principal]);
  await assert.rejects(()=>lifecycle!(ctx,queryId),(error:any)=>{denied.push(error.code);return error.code==='UNAVAILABLE';});
 }finally{await s.admin.query('UPDATE finnor_os.users SET status=$3 WHERE tenant_id=$1 AND id=$2',
  [s.scope.tenant,s.scope.principal,originalStatus]);}
 await s.artifact('lifecycle/query-projection-correspondence.json',{queryId,observations,denied,job,cancelled,cancelJob,
  failedId,failedJob,failureEvents,permissionFault:{policySHA256,originalMode:st.mode&0o777,exactBytesAndPermissionsRestored:true},
  physicalAbortQualified:false,ownerReplayRetained:true,qualification:'ACTUAL_LIVE_ROW_PROJECTION_NOT_CURRENT_OWNER_CACHE_OR_GATE',usd:null});
 return {queryId,observations,denied,job,cancelId,failedId,originalDeadlineUnchanged:true,physicalAbortQualified:false,usd:null};
}
