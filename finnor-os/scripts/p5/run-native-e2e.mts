import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {evidence,target,repo} from './test-support.mts';
import {nativeFixture} from './native-fixture.mts';
const run=await evidence('native');
let e:Awaited<ReturnType<typeof nativeFixture>>|undefined;
await run.story('native-before-implementation',[],async()=>{e=await nativeFixture();return {migrations:e.migrations,domain:'Actual PostgreSQL/app RLS/Work/Company Brain/JobQueue; nonproduction auth bypass, not hosted authentication'};});
const op=()=>({meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()});
const body=(w:any,substrate='API')=>({schema:'finnor.p5.acquisition-request.v1',root:e!.root,workId:w.workId,sourceAccessId:w.accessId,substrate,operation:op(),idempotencyKey:randomUUID(),mode:'ordinary_disposable'});
async function accepted(input:any){const r=await e!.api('interface-acquire',input);assert.equal(r.status,202,JSON.stringify(r));return r.body;}
await run.story('actual-api-queue-practice-and-reload',['P5-03','P5-05','P5-08','P5-18','P5-27','P5-33','P5-34'],async()=>{
 assert.ok(e,'Native producer unavailable');const f=await target(run.directory);
 try{
  const w=await e.work(f.origin),input=body(w),a=await accepted(input),r=await e.finish(a.acquisitionId);
  assert.equal(r.status,'PRACTICED',JSON.stringify(r));assert.equal(r.admission,null);
  assert.equal(r.capability.postcondition.owner,'P5');assert.equal(r.practice.status,'VERIFIED');
  assert.equal((await f.reference()).writes.length,1);assert.equal((await f.reference()).records.C_010.price,1000);
  const reread=await e.api('interface-read',{acquisitionId:a.acquisitionId});assert.equal(reread.body.capability.adapterModule.contentDigest,r.capability.adapterModule.contentDigest);
  const p=await e.api('interface-projection',{root:e.root,workId:w.workId});assert.equal(p.body.acquisitions[0].acquisitionId,a.acquisitionId);
  const replay=await accepted(input);assert.equal(replay.acquisitionId,a.acquisitionId);assert.equal((await f.reference()).writes.length,1);
  const forged=await e.api('interface-acquire',{...input,claimFence:99});assert.equal(forged.status,400);
  const invocation=await e.api('interface-invoke',{acquisitionId:a.acquisitionId,operation:input.operation,idempotencyKey:randomUUID()});assert.equal(invocation.status,424);
  const count=(await e.admin.query("SELECT count(*)::int n FROM finnor_os.p5_attempts WHERE acquisition_id=$1 AND possible_egress",[a.acquisitionId])).rows[0].n;assert.equal(count,1);
  const module=await e.api('interface-module',{acquisitionId:a.acquisitionId,kind:'ADAPTER'});assert.equal(module.status,200);assert.equal(module.body.module.digest,r.capability.adapterModule.contentDigest);
  const foreign=await e.api('interface-read',{acquisitionId:a.acquisitionId},{tenant:e.foreignTenant,actor:e.foreignActor});assert.equal(foreign.status,404);assert.ok(!JSON.stringify(foreign).includes('C_01'));
  return {accepted:a,reread:reread.body,projection:p.body,invocation,count,foreign,reference:await f.reference()};
 }finally{await f.close();}
});
await run.story('missing-practice-access-and-cross-account-refusal',['P5-05','P5-09'],async()=>{
 assert.ok(e);const f=await target(run.directory);try{
  const w=await e.work(f.origin);await e.admin.query('UPDATE finnor_os.p5_test_access SET permit_practice=false WHERE id=$1',[w.accessId]);
  const a=await accepted(body(w)),r=await e.finish(a.acquisitionId);assert.equal(r.status,'PROTOTYPE');assert.equal(r.admission,null);assert.equal((await f.reference()).writes.length,0);
  const w2=await e.work(f.origin),other=body(w2);other.operation.account='private-other-account';
  const denied=await e.api('interface-acquire',other);assert.equal(denied.status,404);assert.equal((await f.reference()).writes.length,0);
  return {prototype:r,denied,reference:await f.reference()};
 }finally{await f.close();}
});
await run.story('interface-currentness-unit-drift-and-catalogue',['P5-01','P5-02','P5-14','P5-29'],async()=>{
 assert.ok(e);const f=await target(run.directory);try{
  const w=await e.work(f.origin),input=body(w),a=await accepted(input);await e.finish(a.acquisitionId);
  const catalogue=await e.api('interface-catalogue',{root:e.root,workId:w.workId,operation:{...input.operation,value:'200.00'}});assert.equal(catalogue.body.reusable.length,0,'Unadmitted prototype cannot become catalogue reuse');
  await f.control({variant:'beta'});
  const r=await e.api('interface-read',{acquisitionId:a.acquisitionId});assert.equal(r.body.status,'QUARANTINED');assert.equal(r.body.capability,null);
  const module=await e.api('interface-module',{acquisitionId:a.acquisitionId,kind:'ADAPTER'});assert.equal(module.status,422);
  const history=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.p5_capabilities WHERE acquisition_id=$1',[a.acquisitionId])).rows[0].n;assert.ok(history>0);
  return {catalogue,r,history,reference:await f.reference(),p7:'PENDING_P7_COMMITTED_PORT'};
 }finally{await f.close();}
});
await run.story('work-revocation-integrity-cancel-and-original-costs',['P5-21','P5-26','P5-27','P5-28','P5-33','P5-34'],async()=>{
 assert.ok(e);const f=await target(run.directory);try{
  const w=await e.work(f.origin),input=body(w),a=await accepted(input);
  const conflict=await e.api('interface-acquire',{...input,operation:{...input.operation,value:'200.00'}});assert.equal(conflict.status,409);
  const cancel=await e.api('interface-cancel',{acquisitionId:a.acquisitionId});assert.equal(cancel.body.status,'CANCELLED');
  await e.queue.tick();assert.equal((await f.reference()).writes.length,0);
  const resume=await e.api('interface-resume',{acquisitionId:a.acquisitionId});assert.equal(resume.status,422);
  const w2=await e.work(f.origin),b=await accepted(body(w2));await e.admin.query('UPDATE finnor_os.p5_test_access SET revoked=true WHERE id=$1',[w2.accessId]);await e.queue.tick();
  const revoked=await e.api('interface-read',{acquisitionId:b.acquisitionId});assert.equal(revoked.status,404);
  const count=(await e.admin.query('SELECT attempts_used FROM finnor_os.p5_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3',[e.tenant,e.actor,w.workId])).rows[0].attempts_used;assert.equal(count,0);
  return {conflict,cancel,resume,revoked,attemptsUsed:count,reference:await f.reference()};
 }finally{await f.close();}
});
await run.story('physical-worker-loss-after-mutation-and-cold-reconcile',['P5-24','P5-25','P5-27','P5-28'],async()=>{
 assert.ok(e);const f=await target(run.directory);let child:ReturnType<typeof spawn>|undefined;
 try{
  await f.control({mode:'pause-after-write'});
  const w=await e.work(f.origin),a=await accepted(body(w));
  child=spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/p5/physical-worker.mts')],{cwd:join(repo,'finnor-os'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',DATABASE_URL:process.env.DATABASE_URL,AUTH_DEV_BYPASS:'1',FINNOR_P4_PROFILE:'ordinary_disposable'},stdio:['ignore','pipe','pipe']});
  let persisted=false;
  for(let i=0;i<200;i++){if((await f.reference()).writes.length){persisted=true;break;}if(child.exitCode!==null)throw Error('WORKER_EXITED_BEFORE_MUTATION');await new Promise(r=>setTimeout(r,25));}
  assert.ok(persisted,'Original worker must actually mutate before SIGKILL');
  const pid=child.pid;await new Promise<void>(yes=>{child!.once('close',()=>yes());child!.kill('SIGKILL');});
  await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE type='run_interface_acquisition_v1' AND status='running'");
  await e.queue.recoverExpiredRunningJobs(3);
  const count=(await f.reference()).writes.length;assert.equal(count,1);
  const pending=await e.api('interface-read',{acquisitionId:a.acquisitionId});assert.ok(['UNKNOWN','RUNNING'].includes(pending.body.status));
  const recovered=await e.api('interface-reconcile',{acquisitionId:a.acquisitionId});assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.practice.status,'VERIFIED');
  assert.equal((await f.reference()).writes.length,1);
  const cancel=await e.api('interface-cancel',{acquisitionId:a.acquisitionId});assert.equal(cancel.body.liabilityReleased,false);
  return {ownedPid:pid,signal:'SIGKILL',pending,recovered,cancel,reference:await f.reference()};
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null)await new Promise<void>(yes=>{child!.once('close',()=>yes());child!.kill('SIGKILL');});
  await f.close();
 }
});
await run.story('forged-job-and-protected-adapter-refused',['P5-22','P5-31'],async()=>{
 const worker=await import('../../packages/private-equity/src/interface-synthesis/worker');
 await assert.rejects(()=>worker.runInterfaceAcquisitionJob({tenantId:e!.tenant,principalId:e!.actor,acquisitionId:randomUUID()}),/P5_ACTUAL_DURABLE_JOB/);
 const {requireProtectedAdapter}=await import('../../packages/governed-execution/src/adapter-contract');
 assert.throws(()=>requireProtectedAdapter('BROWSER'),/S6_PROTECTED_EGRESS_ADAPTER_UNADMITTED/);
 return {refusedBeforeEgress:true,p3:'PENDING_AUTHENTICATED_GENERATED_HARNESS_RUNTIME',p7:'PENDING_P7_COMMITTED_PORT',originalGate31:'NOT_RUN'};
});
await e?.close();await run.finish();
