/** Real durable queue claims, physical acceptance, process death and ordinary
 * lease/backoff recovery. No status/date/counter/effect rows are patched. */
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {identifyDigitalSystemJob} from '../../packages/private-equity/src/system-identification/worker';
import type {BlackBox} from './black-box.mts';
import {artifact,repo} from '../x3/environment.mts';
const pause=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,Math.max(0,ms)));
export async function identificationRecoveryProof(f:{
 e:any;evidence:string;tenant:string;people:Record<string,string>;identificationId:string;source:BlackBox;
 api:(who:string,operation:string,body:unknown)=>Promise<any>;tick:()=>Promise<any>;startWorker:()=>Promise<void>;workerPid:()=>number|undefined;killWorker:()=>Promise<void>;
}){
 const {e,evidence,tenant,identificationId,source}=f,mode=process.env.FINNOR_X4_RECOVERY;
 if(mode==='concurrent'){
  const competitor=spawn(process.execPath,['--import=tsx','scripts/x4/worker-loop.mts'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe','ipc']});
  let logs=0;for(const stream of [competitor.stdout!,competitor.stderr!])stream.on('data',b=>{logs+=b.length;if(logs>65536)competitor.kill('SIGKILL');});
  try{
   await new Promise<void>((yes,no)=>{const t=setTimeout(()=>no(Error('SECOND_WORKER_READY_TIMEOUT')),10000);competitor.once('message',(m:any)=>{clearTimeout(t);m.kind==='READY'?yes():no(Error('SECOND_WORKER_READY_REQUIRED'));});competitor.once('error',no);});
   const second=new Promise<any>((yes,no)=>{const t=setTimeout(()=>no(Error('SECOND_QUEUE_TICK_TIMEOUT')),45000);competitor.on('message',(m:any)=>{if(m.id===1){clearTimeout(t);yes(m);}});competitor.send({id:1,operation:'TICK'});});
   const reports=await Promise.all([f.tick(),second]);
   const jobs=(await e.admin.query("SELECT id,status,attempts,claim_fence FROM finnor_os.jobs WHERE tenant_id=$1 AND type='identify_digital_system_v1'",[tenant])).rows;
   assert.equal(jobs.length,1);assert.equal(jobs[0].attempts,1);assert.equal(jobs[0].status,'completed');assert.notEqual(reports[0].pid,reports[1].pid);
   const deliveries=(await e.admin.query('SELECT id,job_id,claim_fence,outcome FROM finnor_os.job_delivery_attempts WHERE job_id=$1',[jobs[0].id])).rows;
   assert.equal(deliveries.length,1);assert.equal(deliveries[0].outcome,'completed');
   await artifact(evidence,'recovery.json',{schema:'finnor.x4.recovery-proof.v1',mode,allPassed:true,reports,jobs,deliveries,twoActualQueueProcesses:true,oneDurableOriginalClaim:true,patchedRows:0});return;
  }finally{
   if(competitor.exitCode===null&&competitor.signalCode===null){const ended=new Promise<void>(yes=>competitor.once('close',()=>yes()));competitor.kill('SIGTERM');await ended;}
  }
 }
 const run=f.tick().then(value=>({value,error:null}),error=>({value:null,error:String(error)})),until=Date.now()+20000;
 let accepted:Awaited<ReturnType<BlackBox['readAdminState']>>;
 for(;;){accepted=await source.readAdminState();if(accepted.acceptedCount===1)break;assert(Date.now()<until,'REAL_PHYSICAL_ACCEPTANCE_NOT_REACHED');await pause(40);}
 const original=(await e.admin.query("SELECT * FROM finnor_os.jobs WHERE tenant_id=$1 AND type='identify_digital_system_v1'",[tenant])).rows[0];
 const experiment=(await e.admin.query('SELECT id,status,protocol,created_at FROM finnor_os.x4_experiments WHERE tenant_id=$1 AND identification_id=$2',[tenant,identificationId])).rows[0];
 assert.equal(experiment.status,'REGISTERED','Refuse a missed crash boundary, never fabricate it');
 const originalOperations=(await e.admin.query('SELECT id,domain_action_id,business_effect_id,operation_key FROM finnor_os.external_operations WHERE tenant_id=$1',[tenant])).rows;
 assert.equal(originalOperations.length,1);const originalOperation=originalOperations[0];
 assert.equal(originalOperation.operation_key,experiment.protocol.effect.operationKey);
 const allocation=(await e.admin.query('SELECT deadline_at,max_experiments,max_observations,max_analysis,max_uses,experiment_count,analysis_count,generation FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0];
 if(mode==='inflight-cancel'){
  const cancelled=await f.api('author','cancel',{identificationId,reason:'Cancel after independently observed actual acceptance, retain physical liability',idempotencyKey:randomUUID()});
  assert.equal(cancelled.status,200);assert.equal(cancelled.body.externalEffectsUndone,false);await run;
  const state=await source.readAdminState();assert.equal(state.postCount,1);assert.equal(state.acceptedCount,1);
  await artifact(evidence,'recovery.json',{schema:'finnor.x4.recovery-proof.v1',mode,allPassed:true,cancelled,originalJobId:original.id,originalExperimentId:experiment.id,
   acceptedOperationId:accepted.operations[0]!.readback.id,originalOperation,postCount:state.postCount,acceptedCount:state.acceptedCount,allocation,patchedRows:0});return;
 }
 assert.equal(mode,'crash');
 const killedPid=f.workerPid();await f.killWorker();const interrupted=await run;assert(interrupted.error);
 await e.http.restartApi();await f.startWorker();assert.notEqual(f.workerPid(),killedPid);
 const early=await f.tick(),still=(await e.admin.query('SELECT id,status,attempts,claim_fence,lease_expires_at FROM finnor_os.jobs WHERE id=$1',[original.id])).rows[0];
 assert.equal(still.status,'running');assert.equal(still.claim_fence,original.claim_fence);assert.equal(still.attempts,1);
 await artifact(evidence,'recovery-progress.json',{phase:'BEFORE_REAL_LEASE_EXPIRY',killedPid,restartedPid:f.workerPid(),early,still,patchedRows:0});
 await pause(new Date(still.lease_expires_at).getTime()-Date.now()+100);
 await f.tick();
 const queued=(await e.admin.query('SELECT id,status,attempts,claim_fence,run_at FROM finnor_os.jobs WHERE id=$1',[original.id])).rows[0];
 assert.equal(queued.status,'queued');assert.equal(queued.attempts,1);
 const lost=(await e.admin.query('SELECT id,job_id,claim_fence,outcome,failure_kind FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at',[original.id])).rows;
 assert.equal(lost[0].outcome,'lease_lost');
 // Negative re-entry uses the exact old claim captured from the real queue.
 // It cannot acquire a new effect, charge or authority.
 let stale:any;
 try{await identifyDigitalSystemJob(original.payload,{jobId:original.id,tenantId:tenant,claimToken:original.claim_token,claimFence:Number(original.claim_fence),
  deliveryAttemptId:lost[0].id,protocolVersion:1,registerHeartbeat:()=>{throw Error('STALE_OWNER_REACHED_HEARTBEAT');}} as any);}catch(error){stale=error;}
 assert.equal(stale?.message,'X4_PHYSICAL_DELIVERY_FENCE');
 const compute=(await e.admin.query("SELECT max(expires_at) at FROM finnor_os.compute_resource_leases WHERE owner_id=$1",['x4:'+lost[0].id])).rows[0]?.at;
 await pause(Math.max(new Date(queued.run_at).getTime(),new Date(compute??queued.run_at).getTime())-Date.now()+100);
 await f.tick();
 const current=(await e.admin.query('SELECT id,status,attempts,claim_fence,last_error FROM finnor_os.jobs WHERE id=$1',[original.id])).rows[0];
 assert.equal(current.attempts,2);assert(Number(current.claim_fence)>Number(original.claim_fence));
 const retained=(await e.admin.query('SELECT id,status,protocol FROM finnor_os.x4_experiments WHERE tenant_id=$1 AND identification_id=$2',[tenant,identificationId])).rows;
 assert.equal(retained.length,1);assert.equal(retained[0].id,experiment.id);assert.deepEqual(retained[0].protocol,experiment.protocol);
 const state=await source.readAdminState();assert.equal(state.postCount,1);assert.equal(state.acceptedCount,1);
 const operations=(await e.admin.query('SELECT id,domain_action_id,business_effect_id,operation_key FROM finnor_os.external_operations WHERE tenant_id=$1',[tenant])).rows;
 assert.deepEqual(operations,[originalOperation]);
 assert.equal(operations[0].domain_action_id,experiment.protocol.effect.domainActionId);assert.equal(operations[0].business_effect_id,experiment.protocol.effect.businessEffectId);
 assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.provider_invocations WHERE tenant_id=$1',[tenant])).rows[0].n,1);
 const events=(await e.admin.query("SELECT kind,body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND kind IN('DELIVERY_CLASSIFIED','OPERATION_FAILED') ORDER BY id",[tenant,identificationId])).rows;
 assert(events.some((v:any)=>v.kind==='DELIVERY_CLASSIFIED'&&v.body.reconciliationOnly===true));
 assert(events.some((v:any)=>v.kind==='OPERATION_FAILED'&&v.body.error==='X4_TRANSPORT_UNAVAILABLE'));
 const after=(await e.admin.query('SELECT deadline_at,max_experiments,max_observations,max_analysis,max_uses,experiment_count,analysis_count,generation FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0];
 assert.deepEqual(after,allocation);
 await artifact(evidence,'recovery.json',{schema:'finnor.x4.recovery-proof.v1',mode,allPassed:true,killedPid,restartedPid:f.workerPid(),originalJobId:original.id,
  interrupted,early,still,queued,lost,staleDenial:stale.message,current,originalExperimentId:experiment.id,originalEffect:experiment.protocol.effect,operations,events,allocation,after,
  postCount:state.postCount,acceptedCount:state.acceptedCount,actualProviderEntireLifetimeLimitMs:30000,expiredProviderDisposition:'UNKNOWN_NO_CHECKED_MODEL_NO_BLIND_POST',
  patchedRows:0,clockOrLeaseDatesForged:false,originalOperationAndAllocationPreserved:true});
}
