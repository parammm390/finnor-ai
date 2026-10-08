import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {join} from 'node:path';
import {evidence,target,repo} from './test-support.mts';
import {nativeFixture} from './native-fixture.mts';
const run=await evidence('crash');
type Fixture=Awaited<ReturnType<typeof nativeFixture>>;
const operation=()=>({meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()});
async function until(predicate:()=>Promise<boolean>,child?:ChildProcess){
 for(let i=0;i<200;i++){
  if(await predicate())return;
  if(child&&(child.exitCode!==null||child.signalCode!==null))throw Error('OWNED_WORKER_EXITED_BEFORE_CRASH_CUT');
  await new Promise(yes=>setTimeout(yes,20));
 }
 throw Error('PHYSICAL_CRASH_CUT_TIMEOUT');
}
function launch(){
 return spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/p5/physical-worker.mts')],{
  cwd:join(repo,'finnor-os'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,
   NODE_ENV:'test',DATABASE_URL:process.env.DATABASE_URL,AUTH_DEV_BYPASS:'1',FINNOR_P4_PROFILE:'ordinary_disposable'},
  stdio:['ignore','ignore','ignore'],
 });
}
async function stop(child:ChildProcess){
 if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(yes=>{child.once('close',()=>yes());child.kill('SIGKILL');});
}
async function snapshot(e:Fixture,id:string){
 const row=(await e.admin.query('SELECT status,head_id,episode_id,request,claim_token,claim_fence FROM finnor_os.p5_acquisitions WHERE id=$1',[id])).rows[0];
 const episode=(await e.admin.query('SELECT deadline_at,attempts_used,wire_attempts,reads_used FROM finnor_os.p5_episodes WHERE id=$1',[row.episode_id])).rows[0];
 const attempts=(await e.admin.query('SELECT id,operation_id,possible_egress,acknowledged,body,result,result_digest FROM finnor_os.p5_attempts WHERE acquisition_id=$1',[id])).rows;
 const events=(await e.admin.query('SELECT kind,digest FROM finnor_os.p5_events WHERE acquisition_id=$1 ORDER BY created_at,id',[id])).rows;
 return {row,episode,attempts,events};
}
async function retire(e:Fixture,id:string){
 await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE payload->>'acquisitionId'=$1 AND status='running'",[id]);
 assert.equal(await e.queue.recoverExpiredRunningJobs(3),1);
}
async function gate(e:Fixture,cut:1|2){
 await e.admin.query('SELECT pg_advisory_lock(71505,$1)',[cut]);
 await e.admin.query(`CREATE FUNCTION finnor_os.p5_test_crash_gate() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN PERFORM pg_catalog.pg_advisory_lock(71505,${cut});PERFORM pg_catalog.pg_advisory_unlock(71505,${cut});RETURN NEW;END $$`);
 const table=cut===1?'p5_attempts':'p5_capabilities';
 await e.admin.query(`CREATE TRIGGER p5_test_crash_gate BEFORE ${cut===1?'UPDATE':'INSERT'} ON finnor_os.${table}
  FOR EACH ROW ${cut===1?'WHEN (NEW.possible_egress AND NOT OLD.possible_egress)':''} EXECUTE FUNCTION finnor_os.p5_test_crash_gate()`);
 return {
  reached:async()=>Number((await e.admin.query("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND classid=71505 AND objid=$1 AND NOT granted",[cut])).rows[0].n)>0,
  release:async()=>{
   await e.admin.query('SELECT pg_advisory_unlock(71505,$1)',[cut]);
   await e.admin.query(`DROP TRIGGER p5_test_crash_gate ON finnor_os.${table}`);
   await e.admin.query('DROP FUNCTION finnor_os.p5_test_crash_gate()');
  },
 };
}
for(const cut of ['before-intent','durable-intent-before-egress','during-observation','after-observation-before-publication'] as const){
 await run.story('physical-'+cut,[...(cut==='before-intent'||cut==='durable-intent-before-egress'?['P5-23']:['P5-24','P5-25']),'P5-27','P5-33','P5-34'],async()=>{
  const e=await nativeFixture(),f=await target(run.directory);
  let child:ChildProcess|undefined,barrier:Awaited<ReturnType<typeof gate>>|undefined;
  try{
   const w=await e.work(f.origin),original=operation();
   const a=await e.api('interface-acquire',{schema:'finnor.p5.acquisition-request.v1',root:e.root,workId:w.workId,
    sourceAccessId:w.accessId,substrate:'API',operation:original,idempotencyKey:randomUUID(),mode:'ordinary_disposable'});
   assert.equal(a.status,202);
   const id=a.body.acquisitionId,initial=await snapshot(e,id);
   if(cut==='before-intent')await f.control({mode:'pause-docs'});
   if(cut==='during-observation')await f.control({mode:'pause-observation'});
   if(cut==='durable-intent-before-egress')barrier=await gate(e,1);
   if(cut==='after-observation-before-publication')barrier=await gate(e,2);
   child=launch();
   await until(async()=>{
    if(barrier)return barrier.reached();
    const state=await f.reference();
    return state.requests.some((request:any)=>request.method==='GET'&&
     request.path===(cut==='before-intent'?'/docs':'/ledgers/test-account/entries/C_01'));
   },child);
   const before=await snapshot(e,id),referenceBefore=await f.reference();
   assert.equal(before.row.head_id,null);
   assert.equal(before.episode.attempts_used,1);
   if(cut==='before-intent'){
    assert.equal(before.attempts.length,0);assert.equal(referenceBefore.writes.length,0);
   }else if(cut==='durable-intent-before-egress'){
    assert.equal(before.attempts.length,1);assert.equal(before.attempts[0].possible_egress,false);
    assert.equal(before.episode.wire_attempts,0);assert.equal(referenceBefore.writes.length,0);
   }else{
    assert.equal(before.attempts.length,1);assert.equal(before.attempts[0].possible_egress,true);
    assert.equal(before.attempts[0].acknowledged,true);assert.equal(referenceBefore.writes.length,1);
    if(cut==='after-observation-before-publication'){
     assert.equal(before.attempts[0].result.status,'VERIFIED');
     assert.ok(before.events.some(event=>event.kind==='COMPLETED'));
    }else assert.equal(before.attempts[0].result,null);
   }
   const pid=child.pid;await stop(child);
   await barrier?.release();barrier=undefined;
   await retire(e,id);await f.control({mode:'normal'});
   const stopped=await snapshot(e,id);
   assert.equal(stopped.row.head_id,null);
   assert.deepEqual(stopped.episode,before.episode,'Death must not renew or erase the original counters/deadline');
   let recovered;
   if(cut==='before-intent'||cut==='durable-intent-before-egress'){
    const resume=await e.api('interface-resume',{acquisitionId:id});assert.equal(resume.status,202,JSON.stringify(resume));
    recovered=await e.finish(id);
   }else{
    const resume=await e.api('interface-resume',{acquisitionId:id});assert.equal(resume.status,422);
    const reconcile=await e.api('interface-reconcile',{acquisitionId:id});assert.equal(reconcile.status,200,JSON.stringify(reconcile));
    recovered=reconcile.body;
   }
   assert.equal(recovered.practice.status,'VERIFIED');
   const after=await snapshot(e,id),referenceAfter=await f.reference();
   assert.equal(after.row.episode_id,initial.row.episode_id);
   assert.deepEqual(after.row.request.operation,original);
   assert.equal(after.episode.deadline_at.getTime(),initial.episode.deadline_at.getTime());
   assert.equal(after.episode.attempts_used,cut==='before-intent'||cut==='durable-intent-before-egress'?2:1);
   assert.equal(after.episode.wire_attempts,1);
   assert.equal(after.attempts.length,1);assert.equal(after.attempts[0].operation_id,original.operationId);
   if(before.attempts.length)assert.equal(after.attempts[0].id,before.attempts[0].id);
   assert.equal(referenceAfter.writes.length,1);
   assert.equal(referenceAfter.writes[0].operationId,original.operationId);
   assert.equal(referenceAfter.records.C_01.price,2000);
   assert.equal(referenceAfter.records.C_010.price,1000);
   return {cut,ownedPid:pid,signal:'SIGKILL',initial,before,stopped,after,recovered,referenceBefore,referenceAfter};
  }finally{
   if(child)await stop(child);
   await barrier?.release();await f.close();await e.close();
  }
 });
}
await run.finish();
