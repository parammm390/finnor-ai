import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {discoverUniformAlgorithmJob} from '../../../packages/private-equity/src/uniform-algorithms/worker';
const pause=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,Math.max(0,ms)));
async function control(os:string,workerUrl:string,installed:boolean){
 const entry=join(os,installed?'y5-runtime/queue-control.mjs':'scripts/postx/y5/queue-control.mts');
 const child=spawn(process.execPath,installed?[entry]:['--import=tsx',entry],{
  cwd:os,env:{...process.env,DATABASE_URL:workerUrl,WORKER_JOB_LEASE_SECONDS:'6'},stdio:['ignore','pipe','pipe','ipc'],
 });
 const pending=new Map<number,{yes:(value:any)=>void;no:(error:Error)=>void;timer:NodeJS.Timeout}>(),logs:string[]=[];
 let id=0,logBytes=0;
 for(const stream of [child.stdout!,child.stderr!])stream.on('data',b=>{
  logBytes+=b.length;if(logBytes<=65536)logs.push(b.toString());else child.kill('SIGKILL');
 });
 const ended=new Promise<void>(yes=>child.once('close',()=>{
  for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('Y5_REAL_QUEUE_PROCESS_CLOSED'));}pending.clear();yes();
 }));
 child.on('message',(m:any)=>{const p=pending.get(m?.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);
  if(m.error)p.no(Error(m.error));else p.yes(m);
 });
 try{await new Promise<void>((yes,no)=>{
  const timer=setTimeout(()=>no(Error('Y5_REAL_QUEUE_READY_TIMEOUT')),10000);
  child.once('error',error=>{clearTimeout(timer);no(error);});
  child.once('message',(m:any)=>{clearTimeout(timer);try{assert.equal(m.kind,'READY');assert.equal(m.productionWorkerFactory,true);assert.equal(m.leaseSeconds,6);yes();}catch(error){no(error as Error);}});
 });}catch(error){child.kill('SIGKILL');await ended;throw error;}
 return {child,logs,ended,command:(operation:'TICK'|'RECOVER')=>new Promise<any>((yes,no)=>{
  const current=++id,timer=setTimeout(()=>{pending.delete(current);no(Error('Y5_REAL_QUEUE_COMMAND_TIMEOUT'));},180000);
  pending.set(current,{yes,no,timer});child.send({id:current,operation},error=>{if(error){clearTimeout(timer);pending.delete(current);no(error);}});
 }),kill:async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}},
 close:async()=>{if(child.exitCode===null&&child.signalCode===null){child.send({id:++id,operation:'STOP'},()=>undefined);await Promise.race([ended,pause(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}}}};
}
export async function verifyRecovery(f:{env:any;os:string;root:string;tenant:string;discoveryId:string;jobId:string;installed:boolean;
 artifact:(name:string,value:unknown)=>Promise<void>}){
 const {env,tenant,discoveryId,jobId}=f,workers:Awaited<ReturnType<typeof control>>[]=[],reports:unknown[]=[];
 let locked=false;
 const job=async()=>(await env.admin.query('SELECT * FROM finnor_os.jobs WHERE id=$1',[jobId])).rows[0];
 const allocation=async()=>(await env.admin.query('SELECT id,episode_id,deadline_at,max_attempts,max_uses,generation FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[tenant,discoveryId])).rows[0];
 const withoutClaim=(row:any)=>{const {claim_token:_,...safe}=row;return safe;},originalAllocation=await allocation();
 const waitUntil=async<T,>(fn:()=>Promise<T|null>,description:string,limitMs=60000):Promise<T>=>{
  const deadline=Date.now()+limitMs;for(;;){const value=await fn();if(value!==null)return value;assert(Date.now()<deadline,description);await pause(25);}
 };
 try{
  const first=await control(f.os,env.workerUrl,f.installed);workers.push(first);reports.push(await first.command('RECOVER'));
  reports.push(await first.command('TICK'));assert.equal((await job()).status,'queued');
  const interrupted=first.command('TICK').then(value=>({value,error:null}),error=>({value:null,error:String(error)}));
  const nativeStart=await waitUntil(async()=>{
   try{return JSON.parse(await readFile(join(f.root,'.y5-scratch/discovery',discoveryId,'1/specification-build.started.json'),'utf8'));}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  },'Y5_REAL_NATIVE_START_NOT_REACHED');
  assert(nativeStart.pid>0&&nativeStart.guardianPid>0);
  await env.admin.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['s5-portfolio:'+tenant]);locked=true;
  const accepted=await waitUntil(async()=>{
   const row=(await env.admin.query("SELECT id,kind,body FROM finnor_os.y5_events WHERE tenant_id=$1 AND discovery_id=$2 AND kind='KERNEL_ACCEPTED' ORDER BY id LIMIT 1",[tenant,discoveryId])).rows[0];
   return row??null;
  },'Y5_DURABLE_ACCEPTED_CHILD_NOT_REACHED');
  const unpublished=(await env.admin.query('SELECT status,result_digest,attempt_count FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[tenant,discoveryId])).rows[0];
  assert.equal(unpublished.status,'RUNNING');assert.equal(unpublished.result_digest,null);assert.equal(unpublished.attempt_count,1);
  const original=await job();assert.equal(original.status,'running');assert.equal(original.attempts,1);
  await f.artifact('recovery-boundary.json',{phase:'REAL_KERNEL_ACCEPTED_PUBLICATION_BLOCKED_BY_ORIGINAL_S5_LOCK',nativeStart,unpublished,original:withoutClaim(original),accepted});
  await first.kill();const stopped=await interrupted;assert(stopped.error);assert.equal(first.child.signalCode,'SIGKILL');
  await env.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['s5-portfolio:'+tenant]);locked=false;
  const second=await control(f.os,env.workerUrl,f.installed);workers.push(second);
  const earlyRecovery=await second.command('RECOVER'),earlyTick=await second.command('TICK'),still=await job();
  assert.equal(earlyRecovery.result,0);assert.equal(earlyTick.result,false);assert.equal(still.status,'running');
  assert.equal(still.claim_fence,original.claim_fence);assert.equal(still.attempts,1);
  const leases=(await env.admin.query("SELECT resource_key,owner_id,fence,expires_at,released_at FROM finnor_os.compute_resource_leases WHERE owner_id=$1",['y5:'+(await env.admin.query('SELECT id FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at LIMIT 1',[jobId])).rows[0].id])).rows;
  assert.equal(leases.length,1);assert.equal(leases[0].resource_key,'native:y5-proof');assert.equal(leases[0].released_at,null);
  const expiresAt=Math.max(new Date(still.lease_expires_at).getTime(),...leases.map((lease:any)=>new Date(lease.expires_at).getTime()));
  await f.artifact('recovery-progress.json',{phase:'WAIT_FOR_REAL_ORIGINAL_LEASE_EXPIRY',earlyRecovery,earlyTick,still:withoutClaim(still),leases,expiresAt,clockOrLeaseDatesForged:false});
  await pause(expiresAt-Date.now()+150);
  const recovered=await second.command('RECOVER'),queued=await job();assert.equal(recovered.result,1);assert.equal(queued.status,'queued');
  const lost=(await env.admin.query('SELECT id,job_id,claim_fence,outcome,failure_kind FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at',[jobId])).rows;
  assert.equal(lost.length,1);assert.equal(lost[0].outcome,'lease_lost');
  let stale='';
  try{await discoverUniformAlgorithmJob(original.payload,{jobId,tenantId:tenant,claimToken:original.claim_token,claimFence:Number(original.claim_fence),
   deliveryAttemptId:lost[0].id,protocolVersion:1,workerId:original.lease_owner,retrySafety:'locally_idempotent',
   registerHeartbeat:()=>{throw Error('STALE_CLAIM_REACHED_HEARTBEAT');}});}
  catch(error){stale=(error as Error).message;}
  assert.equal(stale,'Y5_PHYSICAL_DELIVERY_FENCE');
  const resumed=await second.command('TICK'),current=await job();assert.equal(resumed.result,true);
  assert.equal(current.status,'completed');assert.equal(current.attempts,2);assert(Number(current.claim_fence)>Number(original.claim_fence));
  const after=await allocation();assert.deepEqual(after,originalAllocation);
  const events=(await env.admin.query('SELECT kind,body FROM finnor_os.y5_events WHERE tenant_id=$1 AND discovery_id=$2 ORDER BY id',[tenant,discoveryId])).rows;
  const completion=events.filter((event:any)=>event.kind==='DISCOVERY_COMPLETED');assert.equal(completion.length,1);
  assert.equal(completion[0].body.attempts[0].stage,'DURABLE_ACCEPTED_CHILD_RECHECKED_NO_RECONSTRUCTION');
  assert(events.some((event:any)=>event.kind==='PHYSICAL_STARTED'&&event.body.attempt===2&&event.body.priorPhysicalCostUnknown===true));
  const capsules=(await env.admin.query('SELECT content_digest FROM finnor_os.y5_capsules WHERE tenant_id=$1 AND discovery_id=$2',[tenant,discoveryId])).rows;
  assert.equal(capsules.length,1);
  const stored=(await env.admin.query('SELECT body FROM finnor_os.y5_capsules WHERE tenant_id=$1 AND discovery_id=$2',[tenant,discoveryId])).rows[0].body;
  assert.equal(stored.digest,accepted.body.capsule.digest);
  const deliveries=(await env.admin.query('SELECT id,job_id,claim_fence,outcome,failure_kind FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at',[jobId])).rows;
  assert.equal(deliveries.length,2);assert.equal(deliveries[1].outcome,'completed');
  await f.artifact('recovery.json',{status:'PASS',scope:'ACTUAL_PRODUCTION_FACTORY_ACCEPTED_CHILD_CRASH_AND_LEASE_RECOVERY',reports,nativeStart,
   original:withoutClaim(original),stopped,earlyRecovery,earlyTick,leases,recovered,queued:withoutClaim(queued),staleDenial:stale,resumed,
   current:withoutClaim(current),originalAllocation,after,events,capsules,deliveries,
   workers:workers.map(worker=>({pid:worker.child.pid,logs:worker.logs.map(line=>line.replace(/postgres(?:ql)?:\/\/\S+/gi,'[private connection]').replace(/Bearer \S+/gi,'[private bearer]'))})),
   rowPatches:0,clockOrLeaseDatesForged:false,unknownEarlierPhysicalCostPossible:true});
 }finally{
  if(locked)await env.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['s5-portfolio:'+tenant]).catch(()=>undefined);
  await Promise.allSettled(workers.map(worker=>worker.close()));
 }
}
