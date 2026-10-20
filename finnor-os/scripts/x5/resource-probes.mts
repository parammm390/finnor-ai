/** Actual contention, elapsed deadline and retained-data exhaustion. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {artifact,repo} from '../x3/environment.mts';
import {reconciliation} from '../x3/business-fixtures.mts';

export async function learningResourceProbes(f:{
 e:any;evidence:string;tenant:string;root:any;main:any;compilation:any;
 native:(who:string,operation:string,body:unknown)=>Promise<any>;learn:(who:string,operation:string,body:unknown)=>Promise<any>;
 values:(label:string,currency:string,lines:readonly string[],bank:string,isTransfer?:boolean)=>Promise<any>;worker:()=>Promise<any>;workerPid:()=>number|undefined;install:(specification:any)=>Promise<any>;
}){
 const {e,evidence,tenant,root,learn,native}=f,steps:any[]=[];
 const ok=(v:any,status=200)=>{assert.equal(v.status,status,JSON.stringify(v));return v.body;};
 const sleep=(ms:number)=>new Promise(yes=>setTimeout(yes,Math.max(0,ms)));
 const save=async(id:string,value:unknown)=>{steps.push({id,value});await artifact(evidence,'resource-progress.json',{steps,complete:false});};
 const original=(await e.admin.query('SELECT request FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2',[tenant,f.compilation.compilationId])).rows[0].request;
 const submit=async(limits={deadlineMs:3600000,maxAttempts:8,maxUses:256})=>ok(await learn('analyst','submit',{
  schema:'finnor.x5.compile-request.v1',root,experience:original.experience,knowledgeCut:original.knowledgeCut,idempotencyKey:randomUUID(),limits,
 }),202);
 const view=(id:string)=>learn('analyst','read',{compilationId:id}).then(v=>ok(v));
 const create=(input:any,app=f.main)=>native('analyst','command',{applicationId:app.id,entityId:'reconciliation',actionId:'create',input,idempotencyKey:randomUUID()}).then(v=>ok(v).record);
 const record=(id:string,app=f.main)=>native('analyst','record',{applicationId:app.id,recordId:id}).then(v=>ok(v));
 const binding=(compilation:any,r:any,app=f.main)=>({compilationId:compilation.compilationId,releaseId:compilation.headReleaseId,
  applicationId:app.id,recordId:r.id,expectedRevision:r.revision,expectedReference:r.reference,mode:'NATIVE_EXACT',stratum:'RETENTION',idempotencyKey:randomUUID()});
 const unchanged=(a:any,b:any)=>{assert.equal(a.counters.deadlineAt,b.counters.deadlineAt);assert.equal(a.counters.maxAttempts,b.counters.maxAttempts);assert.equal(a.counters.maxUses,b.counters.maxUses);assert(b.counters.dataBytes>=a.counters.dataBytes);};
 try{
  const first=await submit(),second=await submit(),beforeFirst=await view(first.compilationId),beforeSecond=await view(second.compilationId);
  let pending:Promise<PromiseSettledResult<any>[]>|undefined,competitor:ReturnType<typeof spawn>|undefined,competingLogs='',child:number|undefined;
  try{
   pending=Promise.allSettled([f.worker()]);const until=Date.now()+10000;
   const parent=f.workerPid();assert(parent);
   while(!child){
    const children=(await readFile(`/proc/${parent}/task/${parent}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
    for(const pid of children){try{if((await readFile('/proc/'+pid+'/cmdline','utf8')).includes('policy-learning/core-child.mts')){child=pid;break;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    assert(Date.now()<until,'REAL_FIRST_WORK_CORE_CHILD_REQUIRED');if(!child)await sleep(5);
   }
   process.kill(child,'SIGSTOP');
   competitor=spawn(process.execPath,['--import=tsx','scripts/x5/worker-loop.mts'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe','ipc']});
   for(const stream of [competitor.stdout!,competitor.stderr!])stream.on('data',b=>{competingLogs+=String(b);if(Buffer.byteLength(competingLogs)>262144)competitor!.kill('SIGKILL');});
   const observed=await new Promise<any>((yes,no)=>{const timer=setTimeout(()=>{competitor!.kill('SIGKILL');no(Error('BOUNDED_COMPETING_WORKER'));},8000);competitor!.once('error',error=>{clearTimeout(timer);no(error);});competitor!.once('message',value=>{clearTimeout(timer);yes(value);});competitor!.send({operation:'TICK',id:1});});
   assert.equal(observed.ordinaryQueueTick,true);assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(competingLogs));
   const blocked=await view(second.compilationId);assert.equal(blocked.status,'QUEUED');assert.equal(blocked.counters.attempts,0);unchanged(beforeSecond,blocked);
   const job=(await e.admin.query("SELECT id,status,run_at,attempts,capacity_defer_count,capacity_defer_reason FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'compilationId'=$2",[tenant,second.compilationId])).rows[0];
   assert.equal(job.status,'queued');assert.equal(job.attempts,0);assert.equal(job.capacity_defer_count,1);assert.equal(job.capacity_defer_reason,'native:x5-learning');
   const early=(await e.admin.query("SELECT kind,body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND kind IN('TRAINING_STARTED','TRAINING_METRICS')",[tenant,second.compilationId])).rows;assert.equal(early.length,0);
   process.kill(child,'SIGCONT');child=undefined;const [worked]=await pending;if(worked!.status==='rejected')throw worked!.reason;
   assert(job.run_at.getTime()-Date.now()<60000);await sleep(job.run_at.getTime()-Date.now()+30);await f.worker();
   const afterFirst=await view(first.compilationId),afterSecond=await view(second.compilationId);
   assert.equal(afterFirst.status,'DEVELOPMENT_READY');assert.equal(afterSecond.status,'DEVELOPMENT_READY');assert.equal(afterFirst.counters.attempts,1);assert.equal(afterSecond.counters.attempts,1);assert.notEqual(first.workId,second.workId);
   unchanged(beforeFirst,afterFirst);unchanged(beforeSecond,afterSecond);
   const leases=(await e.admin.query(`SELECT l.owner_id,l.fence,l.acquired_at,l.expires_at,l.released_at FROM finnor_os.compute_resource_leases l
    JOIN finnor_os.job_delivery_attempts d ON l.owner_id='x5:'||d.id::text JOIN finnor_os.jobs j ON j.id=d.job_id
    WHERE j.tenant_id=$1 AND j.payload->>'compilationId'=ANY($2::text[]) ORDER BY l.fence`,[tenant,[first.compilationId,second.compilationId]])).rows;
   assert.equal(leases.length,2);assert(leases[0].released_at.getTime()<=leases[1].acquired_at.getTime());assert(Number(leases[1].fence)>Number(leases[0].fence));
   await save('two-original-Works-real-capacity-defer-and-exclusive-leases',{first,second,beforeFirst,beforeSecond,blocked,job,early,competingWorker:{pid:competitor.pid,observed},competingLogs,afterFirst,afterSecond,leases});
  }finally{
   if(child){try{process.kill(child,'SIGCONT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
   if(pending)await pending;
   if(competitor&&competitor.exitCode===null&&competitor.signalCode===null){
    const closed=new Promise<void>(yes=>competitor!.once('close',()=>yes()));if(competitor.connected)competitor.send({operation:'STOP',id:2});
    await Promise.race([closed,sleep(3000)]);if(competitor.exitCode===null&&competitor.signalCode===null){competitor.kill('SIGKILL');await closed;}
   }
  }

  const short=await submit({deadlineMs:10000,maxAttempts:2,maxUses:4});await f.worker();
  const alive=await view(short.compilationId);assert.equal(alive.status,'DEVELOPMENT_READY');assert(alive.current);
  const target=await create(await f.values('actual-deadline-target','USD',['45','55'],'100'));
  const originalDeadline=Date.parse(alive.counters.deadlineAt);assert(Date.now()<originalDeadline);await sleep(originalDeadline-Date.now()+30);
  const clock=(await e.admin.query('SELECT clock_timestamp() now')).rows[0].now;assert(clock.getTime()>originalDeadline);
  const denied=await learn('analyst','execute',binding(alive,target));assert.equal(denied.status,409);assert.equal(denied.body.code,'X5_ORIGINAL_DEADLINE_EXPIRED');
  assert.deepEqual(await record(target.id),target);
  const retrain=await learn('analyst','retrain',{compilationId:short.compilationId,experience:original.experience,knowledgeCut:original.knowledgeCut,reason:'Actual elapsed original deadline',idempotencyKey:randomUUID()});assert.equal(retrain.status,409);
  const replacement=await learn('analyst','submit',{...original,workId:short.workId,idempotencyKey:randomUUID()});assert.equal(replacement.status,409);
  const cancelled=ok(await learn('analyst','cancel',{compilationId:short.compilationId,reason:'Stop the actually expired Work without renewal',idempotencyKey:randomUUID()})),expired=await view(short.compilationId);
  assert.equal(expired.current,false);assert.equal(expired.counters.attempts,1);assert.equal(expired.counters.uses,0);unchanged(alive,expired);
  await save('actual-elapsed-original-deadline-no-renewal',{short,alive,target,clock,denied,retrain,replacement,cancelled,expired});

  const allocation=await submit();await f.worker();const ready=await view(allocation.compilationId);assert(ready.current);
  const destinations:any[]=[];
  for(let i=0;i<2;i++){const specification=reconciliation(tenant,root.entityId);specification.id='x5-storage-native-destination-'+i;destinations.push(await f.install(specification));}
  const large=await f.values('actual-retained-storage','USD',Array.from({length:128},()=> '1'),'128');large.memo='R'.repeat(8000);
  const attempts:any[]=[];let failed:any;
  for(let i=0;i<256;i++){
   const destination=destinations[i%2]!,before=await create(large,destination),input=binding(ready,before,destination),accepted=ok(await learn('analyst','execute',input),202);await f.worker();
   const use=(await e.admin.query('SELECT id,status,result FROM finnor_os.x5_uses WHERE tenant_id=$1 AND id=$2',[tenant,accepted.useId])).rows[0],after=await record(before.id,destination),current=await view(allocation.compilationId);
   assert(Number(current.counters.dataBytes)<=16*1024*1024);assert.equal(current.counters.uses,i+1);unchanged(ready,current);
   attempts.push({index:i+1,destination:destination.id,useId:use.id,status:use.status,dataBytes:current.counters.dataBytes,nativeRevision:after.revision});
   await artifact(evidence,'storage-progress.json',{allocation,ready,destinations,attempts,complete:false});
   if(use.status!=='DONE'){
    assert.equal(use.status,'FAILED');assert.deepEqual(after,before);
    const mutations=(await e.admin.query("SELECT h.id::text,h.kind FROM finnor_os.x3_events h WHERE h.tenant_id=$1 AND h.record_id=$2 AND h.body->'input'->>'idempotencyKey'=$3",[tenant,before.id,'x5-native:'+use.id])).rows;assert.equal(mutations.length,0);
    failed={index:i+1,before,input,accepted,use,after,current,mutations};break;
   }
   assert.equal(after.state,'RECONCILED');assert.equal(after.values.quantity.amount,'128');assert.equal(after.values.deltaMinor,'0');
  }
  assert(failed,'REAL_RETAINED_STORAGE_EXHAUSTION_REQUIRED_BEFORE_256_USES');
  const failures=(await e.admin.query(`SELECT j.id,j.status,d.id delivery_id,d.outcome,d.failure_kind,d.failure_detail FROM finnor_os.jobs j
   JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.tenant_id=$1 AND j.payload->>'useId'=$2`,[tenant,failed.use.id])).rows;
  assert(failures.some((v:any)=>v.failure_kind&&v.failure_detail?.includes('x5_compilations_data_bytes_check')),JSON.stringify(failures));
  const cancellation=ok(await learn('analyst','cancel',{compilationId:allocation.compilationId,reason:'Stop actual retained-data exhausted Work',idempotencyKey:randomUUID()})),afterCancellation=await view(allocation.compilationId);
  assert.equal(afterCancellation.current,false);assert.equal(afterCancellation.capsule,null);assert.equal(afterCancellation.counters.uses,attempts.length);assert.equal(afterCancellation.counters.attempts,1);unchanged(failed.current,afterCancellation);
  await save('actual-storage-bound-atomic-native-rollback-no-meter-reset',{allocation,ready,destinations,inputShape:{entries:128,oneMinorEach:true,memoCharacters:8000},attempts,failed,failures,cancellation,afterCancellation});
  const report={schema:'finnor.x5.installed-resource-probes.v1',allPassed:true,steps,protectedAdmission:false,productionActive:false,
   cost:'UNKNOWN',humanWork:'UNKNOWN',aggregateRSSContainment:'NOT_ESTABLISHED'};
  await artifact(evidence,'resource-probes.json',report);return report;
 }catch(error){await artifact(evidence,'resources-FAILED.json',{error:String(error),stack:(error as Error).stack,steps});throw error;}
}
