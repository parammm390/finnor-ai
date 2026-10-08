/** Registered real owner/queue boundary before the M3 heartbeat implementation. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JobQueue,type JobExecutionContext} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '@finnor/db';
import {runCapitalProgramJob} from '../../packages/private-equity/src/capital-program/worker';

export async function m3Heartbeat(input:{
 scope:any;request:any;admin:any;api:(scope:any,operation:string,body:unknown)=>Promise<any>;
 artifact:(name:string,value:unknown)=>Promise<unknown>;
 cancelAfterRegistration?:boolean;
}){
 const {scope,admin,api,artifact}=input,observations:any[]=[],callbacks:Array<()=>Promise<boolean>>=[];
 let cancellation:Promise<any>|undefined;
 const business=async()=>(await admin.query(`SELECT
  (SELECT count(*)::int FROM finnor_os.s5_reservations WHERE tenant_id=$1) reservations,
  (SELECT count(*)::int FROM finnor_os.s5_consumptions WHERE tenant_id=$1) consumptions,
  (SELECT count(*)::int FROM finnor_os.business_effects WHERE tenant_id=$1) effects`,[scope.tenant])).rows[0];
 const before=await business(),submitted=await api(scope,'capital-program-submit',{
  ...structuredClone(input.request),idempotencyKey:randomUUID(),
  permitted:{...input.request.permitted,terms:['0.15'],structures:['IMMEDIATE']},
 });
 assert.equal(submitted.status,202);const queryId=submitted.body.queryId;
 const queue=new JobQueue('completion-b-m3-heartbeat:'+randomUUID(),3);
 let actualExecution:Readonly<JobExecutionContext>|undefined;
 queue.register('run_capital_program_v2',async(payload,execution)=>{
  assert(execution);assert.equal(payload.queryId,queryId);
  actualExecution=execution;
  const observedExecution=Object.freeze({...execution,registerHeartbeat(callback:()=>Promise<boolean>){
   callbacks.push(callback);
   execution.registerHeartbeat(async()=>{
    const accepted=await callback();observations.push({phase:'ACTUAL_QUEUE_HEARTBEAT',accepted,at:new Date().toISOString()});return accepted;
   });
   if(input.cancelAfterRegistration)cancellation??=api(scope,'capital-program-cancel',{queryId});
  }});
  await runCapitalProgramJob(payload,observedExecution);
  if(cancellation)assert.equal((await cancellation).body.status,'CANCELLED');
  const row=(await admin.query('SELECT status,deadline_at,attempted,refinement_steps FROM finnor_os.m3_queries WHERE id=$1',[queryId])).rows[0];
  for(const callback of callbacks)observations.push({
   phase:'AFTER_PUBLICATION_BEFORE_REAL_QUEUE_ACK',accepted:await callback(),query:row,at:new Date().toISOString(),
  });
 },PRODUCTION_JOB_CONTRACTS.run_capital_program_v2);
 assert(await queue.tick(),'Actual canonical queue did not claim the submitted query');
 const query=(await admin.query(`SELECT id,status,first_started_at,deadline_at,generation,
  active_claim_token,active_claim_fence,attempted,refinement_steps,result_digest
  FROM finnor_os.m3_queries WHERE id=$1`,[queryId])).rows[0];
 const job=(await admin.query(`SELECT id,status,claim_token,claim_fence,lease_expires_at
  FROM finnor_os.jobs WHERE id=$1`,[actualExecution!.jobId])).rows[0];
 const events=(await admin.query(`SELECT attempt_id,kind,body,created_at FROM finnor_os.m3_events
  WHERE query_id=$1 ORDER BY created_at,id`,[queryId])).rows;
 const read=await api(scope,'capital-program-read',{queryId}),after=await business();
 await artifact(input.cancelAfterRegistration?'m3-heartbeat/actual-cancelled-queue.json':'m3-heartbeat/actual-queue.json',
  {queryId,registeredCallbacks:callbacks.length,observations,
  actualExecution,query,job,events,read,before,after,usd:null,
  qualification:'ACTUAL_CANONICAL_QUEUE_CALLBACK_AND_PUBLICATION_NOT_PHYSICAL_ABORT_OR_GATE'});
 assert.equal(callbacks.length,1,'M3 did not register its actual query heartbeat with the canonical queue');
 assert(actualExecution);assert.equal(query.active_claim_token,actualExecution.claimToken);
 assert.equal(String(query.active_claim_fence),String(actualExecution.claimFence));
 assert.equal(read.status,200);
 if(input.cancelAfterRegistration){
  assert(cancellation);assert.equal(query.status,'CANCELLED');assert.equal(query.result_digest,null);
  assert.equal(query.generation,2);assert.equal(read.body.program,null);
  assert(observations.some(value=>value.phase==='AFTER_PUBLICATION_BEFORE_REAL_QUEUE_ACK'&&!value.accepted));
  assert(events.some((value:any)=>value.kind==='CANCELLED'));
  assert(events.some((value:any)=>value.kind==='FENCED'&&value.body.attemptCost?.money===null));
 }else{
  assert.equal(job.status,'completed');assert(['PARTIAL','TESTED'].includes(query.status));assert(query.result_digest);
  assert(read.body.program);
  assert(observations.some(value=>value.phase==='AFTER_PUBLICATION_BEFORE_REAL_QUEUE_ACK'&&value.accepted));
  assert(observations.filter(value=>value.phase==='ACTUAL_QUEUE_HEARTBEAT').every(value=>value.accepted));
  assert(events.some((value:any)=>value.kind==='FINISHED'&&value.body.attemptCost?.money===null));
 }
 const started=events.find((value:any)=>value.kind==='STARTED');assert(started);
 assert.equal(started.body.deadlineAt,query.deadline_at.toISOString());
 assert.deepEqual(after,before);
 return {queryId,registeredCallbacks:callbacks.length,observations,query,job,businessUnchanged:true,
  physicalAbortQualified:false,originalDeadlineUnchanged:true,usd:null};
}
