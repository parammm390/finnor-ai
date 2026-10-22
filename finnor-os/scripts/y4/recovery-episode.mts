/** G1 at actual installed queue/worker/native boundaries, never fixture writes. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {sha} from '../../packages/private-equity/src/confidential-computation/contracts';
import {artifact} from './environment.mjs';
import type {installedProcess} from './product-transport.mjs';
const exec=promisify(execFile);
const delay=(ms:number)=>new Promise(yes=>setTimeout(yes,ms));
type Worker=Awaited<ReturnType<typeof installedProcess>>;
type ProcessPin={pid:number;parent:number;started:string;state:string;native:boolean;verifier:boolean;ownerState?:string};
async function processPin(pid:number):Promise<ProcessPin|null>{
 try{
  const stat=await readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/),
   command=await readFile(`/proc/${pid}/cmdline`,'utf8');
  const args=command.split('\0'),stateAt=args.indexOf('--state');
  return {pid,parent:Number(fields[1]),started:fields[19]!,state:fields[0]!,native:command.includes('mascot-party.x'),
   verifier:args.includes('verify-program'),ownerState:stateAt<0?undefined:args[stateAt+1]};
 }catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;}
}
async function descendants(pid:number){
 const pins=(await Promise.all((await readdir('/proc')).filter(n=>/^\d+$/.test(n)).map(n=>processPin(Number(n)))))
  .filter((p):p is ProcessPin=>p!==null),owned=new Set([pid]);
 for(let changed=true;changed;){
  changed=false;
  for(const pin of pins)if(owned.has(pin.parent)&&!owned.has(pin.pid)){owned.add(pin.pid);changed=true;}
 }
 return pins.filter(p=>p.pid!==pid&&owned.has(p.pid));
}
export async function participantState(states:string[],sessionId:string){
 const script="import json,sqlite3,sys;from pathlib import Path;out=[]\n"+
  "for p in json.loads(sys.argv[1]):\n"+
  " with sqlite3.connect((Path(p)/'participant.sqlite').as_uri()+'?mode=ro',uri=True) as d:\n"+
  "  r=d.execute('SELECT state,original_deadline,secret_json IS NULL,release_nonce IS NULL FROM attempts WHERE session=?',(sys.argv[2],)).fetchone()\n"+
  "  out.append({'state':r[0],'originalDeadlineAt':r[1],'secretsBurned':bool(r[2]),'nonceBurned':bool(r[3]),'disclosures':d.execute('SELECT count(*) FROM disclosure').fetchone()[0]})\n"+
  "print(json.dumps(out))";
 const result=await exec('/usr/bin/python3',['-B','-c',script,JSON.stringify(states),sessionId],
  {timeout:5000,maxBuffer:65536});
 return JSON.parse(result.stdout) as Array<{state:string;originalDeadlineAt:string;secretsBurned:boolean;nonceBurned:boolean;disclosures:number}>;
}
export async function cancellationDisposal(input:{
 admin:any;tenant:string;computationId:string;states:string[];deadlineAt:string;evidence:string;
 privateDirectory:string;worker:Worker;call:(operation:string,body:unknown)=>Promise<any>;
}){
 const row=async()=>(await input.admin.query(`SELECT id,status,generation,attempt_count,cpu_reserved_seconds,
  deadline_at,session FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2`,
 [input.tenant,input.computationId])).rows[0],original=await row(),sessionId=original.session.sessionId,
  until=Math.min(Date.parse(input.deadlineAt),Date.now()+650000),ticks:any[]=[],prepared=await participantState(input.states,sessionId),
  checkpoints:Record<string,unknown>={prepared};
 assert.equal(original.status,'READY');
 let paused:ProcessPin|undefined,inFlight:Promise<void>|undefined,tickError:unknown,locker:ReturnType<typeof spawn>|undefined,
  lockClosed:Promise<number|null>|undefined;
 try{
  while(Date.now()<until){
   if(tickError)throw tickError;
   if(!inFlight)inFlight=input.worker.tick(Date.parse(input.deadlineAt)).then(
    t=>{ticks.push(t);inFlight=undefined;},e=>{tickError=e;inFlight=undefined;});
   const local=await participantState(input.states,sessionId);
   if(local[2]!.state==='VERIFYING'){
    const pin=(await descendants(input.worker.child.pid!)).find(p=>p.verifier&&p.ownerState===input.states[2]);
    if(pin){
     const current=await processPin(pin.pid);
     if(current?.started===pin.started){process.kill(pin.pid,'SIGSTOP');paused=pin;break;}
    }
   }
   assert(!local.some(p=>['RUNNING','FINISHED','ABORTED'].includes(p.state)));
   await delay(25);
  }
  assert(paused,'Y4_OWN_THIRD_VERIFIER_PAUSE_NOT_OBSERVED');
  while(Date.now()<until&&(await participantState(input.states,sessionId))[0]!.state!=='VERIFIED'){
   if(tickError)throw tickError;
   await delay(25);
  }
  assert.equal((await participantState(input.states,sessionId))[0]!.state,'VERIFIED');
  const script="import sqlite3,sys\n"+
   "with sqlite3.connect(sys.argv[1],timeout=2) as d:\n"+
   " d.execute('BEGIN IMMEDIATE');print('LOCKED',flush=True);sys.stdin.buffer.read(1);d.commit()\n";
  locker=spawn('/usr/bin/python3',['-B','-c',script,join(input.states[0]!,'participant.sqlite')],
   {stdio:['pipe','pipe','ignore']});
  locker.stdin!.on('error',()=>undefined);
  lockClosed=new Promise(resolve=>locker!.once('close',code=>resolve(code)));
  await Promise.race([new Promise<void>((yes,no)=>{
   locker!.stdout!.once('data',b=>b.toString().trim()==='LOCKED'?yes():no(Error('Y4_PRIVATE_OWNER_BARRIER_INVALID')));
   locker!.once('error',no);locker!.once('exit',()=>no(Error('Y4_PRIVATE_OWNER_BARRIER_EXITED')));
  }),delay(3000).then(()=>{throw Error('Y4_PRIVATE_OWNER_BARRIER_NOT_ACQUIRED');})]);
  const before=await participantState(input.states,sessionId),pins=await descendants(input.worker.child.pid!),
   running=await row();
  Object.assign(checkpoints,{before,pins,running});
  assert.equal(before[0]!.state,'VERIFIED');assert.equal(before[2]!.state,'VERIFYING');
  assert(before.every(p=>!p.secretsBurned));
  assert.deepEqual(before.map(p=>p.nonceBurned),prepared.map(p=>p.nonceBurned));
  assert(!pins.some(p=>p.native));
  const cancel={computationId:input.computationId,idempotencyKey:randomUUID(),
   reason:'Cancel this original session while an earlier verified local owner has a held ordinary writer lock'},
   cancelled=await input.call('confidential-cancel',cancel),started=Date.now();
  checkpoints.cancelled=cancelled;
  assert.equal(cancelled.status,200);assert.equal(cancelled.body.resourcesReplenished,false);
  let whileHeld:Awaited<ReturnType<typeof participantState>>|undefined;
  while(Date.now()-started<3500){
   const local=await participantState(input.states,sessionId);
   if(local.slice(1).every(p=>p.state==='ABORTED'&&p.secretsBurned&&p.nonceBurned)){whileHeld=local;break;}
   await delay(25);
  }
  assert(whileHeld,'Y4_LATER_OWNER_DISPOSALS_WAITED_BEHIND_HELD_FIRST_OWNER');
  checkpoints.whileHeld=whileHeld;
  assert.equal(whileHeld[0]!.state,'VERIFIED');assert(!whileHeld[0]!.secretsBurned);
  locker.stdin!.end('R');assert.equal(await lockClosed,0);
  await inFlight;if(tickError)throw tickError;
  const after=await participantState(input.states,sessionId),retained=await row();
  Object.assign(checkpoints,{after,retained,ticks});
  assert(after.every(p=>p.state==='ABORTED'&&p.secretsBurned&&p.nonceBurned&&p.disclosures===1));
  assert.equal(retained.status,'CANCELLED');assert.deepEqual(retained.session,original.session);
  assert.equal(retained.deadline_at.toISOString(),input.deadlineAt);
  assert.equal(retained.cpu_reserved_seconds,running.cpu_reserved_seconds);
  assert.equal(retained.attempt_count,original.attempt_count);
  assert.deepEqual(await input.call('confidential-cancel',cancel),cancelled);
  const live=await Promise.all(pins.map(p=>processPin(p.pid)));
  assert(live.every((p,i)=>!p||p.started!==pins[i]!.started||p.state==='Z'));
  assert.equal((await descendants(input.worker.child.pid!)).length,0);
  assert.equal((await input.admin.query(`SELECT count(*)::int n FROM finnor_os.y4_disclosures
   WHERE tenant_id=$1 AND computation_id=$2`,[input.tenant,input.computationId])).rows[0].n,3);
  assert.equal((await input.admin.query(`SELECT count(*)::int n FROM finnor_os.y4_releases
   WHERE tenant_id=$1 AND computation_id=$2`,[input.tenant,input.computationId])).rows[0].n,0);
  const summary={actualInstalledApiWorkerCancellation:true,earlierVerifierDurablyCompleted:true,
   ordinaryFirstOwnerWriterLockHeld:true,laterOwnersAbortedBeforeFirstOwnerLockReleased:true,
   allOwnersTerminalAndSecretsAndNoncesBurned:true,noNativeInputDelivery:true,
   physicalSupervisorsStopped:true,originalSessionDeadlineAndChargesRetained:true,
   disclosureReservationsRetained:3,automaticInputRetry:false,resourcesReplenished:false,
   protectedAdmission:false};
  await artifact(input.evidence,'cancellation-disposal.json',{schema:'finnor.y4.cancellation-disposal-e2e.v1',summary});
  await artifact(input.privateDirectory,'cancellation-disposal.private.json',{before,whileHeld,after,pins,live,
   original,running,retained,ticks,cancelled});
  return summary;
 }catch(error){
  await artifact(input.privateDirectory,'cancellation-disposal-observation.private.json',checkpoints);
  throw error;
 }finally{
  if(locker?.stdin&&!locker.stdin.writableEnded&&!locker.stdin.destroyed)locker.stdin.end('R');
  if(locker&&locker.exitCode===null&&!locker.killed)locker.kill('SIGTERM');
  await lockClosed;
  if(paused){
   const p=await processPin(paused.pid);
   if(p?.started===paused.started&&['T','t'].includes(p.state))process.kill(p.pid,'SIGCONT');
  }
 }
}
export async function canonicalCrashAndReconcile(input:{
 admin:any;tenant:string;computationId:string;states:string[];deadlineAt:string;evidence:string;
 privateDirectory:string;worker:Worker;restartWorker:()=>Promise<Worker>;
 call:(operation:string,body:unknown)=>Promise<any>;
}){
 const row=async()=>(await input.admin.query(`SELECT id,status,generation,attempt_count,cpu_reserved_seconds,deadline_at,
  session,runtime_receipt FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2`,
 [input.tenant,input.computationId])).rows[0],
  disclosures=async()=>(await input.admin.query(`SELECT institution_id,source_key,computation_id
   FROM finnor_os.y4_disclosures WHERE tenant_id=$1 AND computation_id=$2 ORDER BY institution_id,source_key`,
  [input.tenant,input.computationId])).rows,
  job=async()=>(await input.admin.query(`SELECT id,status,claim_fence,attempts,lease_expires_at,payload
   FROM finnor_os.jobs WHERE tenant_id=$1 AND type='run_confidential_economic_computation_v1'
    AND payload->>'computationId'=$2 AND payload->>'stage'='EXECUTE'`,[input.tenant,input.computationId])).rows;
 const original=await row(),originalDisclosures=await disclosures(),ticks:any[]=[];
 assert.equal(original.status,'READY');assert.equal(originalDisclosures.length,3);
 const sessionId=original.session.sessionId,stopAt=Math.min(Date.parse(input.deadlineAt),Date.now()+650000);
 let inFlight:Promise<void>|undefined,tickError:unknown,intentionalCrash=false,live:ProcessPin[]=[];
 // Observe application and participant state, not assumed delays or SQL-written
 // RUNNING markers. Tick always crosses the real durable queue.
 while(Date.now()<stopAt){
  if(tickError)throw tickError;
  if(!inFlight)inFlight=input.worker.tick(Date.parse(input.deadlineAt)).then(
   tick=>{ticks.push(tick);inFlight=undefined;},
   error=>{if(!intentionalCrash)tickError=error;inFlight=undefined;});
  const current=await row(),local=await participantState(input.states,sessionId);
  if(current.status==='RUNNING'&&local.every(p=>p.state==='RUNNING'&&p.secretsBurned&&p.nonceBurned)){
   live=await descendants(input.worker.child.pid!);
   if(live.filter(p=>p.native&&p.state!=='Z').length===3)break;
  }
  assert(!['FAILED','CANCELLED','INVALIDATED','RECONCILIATION_REQUIRED','COMPUTED'].includes(current.status));
  await delay(200);
 }
 assert.equal(live.filter(p=>p.native&&p.state!=='Z').length,3,'Y4_THREE_LIVE_NATIVE_PARTIES_REQUIRED');
 const running=await row(),runningJobs=await job();assert.equal(runningJobs.length,1);
 assert.equal(runningJobs[0].status,'running');
 assert(running.cpu_reserved_seconds>original.cpu_reserved_seconds);
 assert.equal(running.deadline_at.toISOString(),input.deadlineAt);
 assert.deepEqual(await disclosures(),originalDisclosures);
 await artifact(input.privateDirectory,'crash-boundary.private.json',{
  workerPid:input.worker.child.pid,original,running,runningJobs,live});
 intentionalCrash=true;
 await new Promise<void>((yes,no)=>{
  input.worker.child.once('exit',()=>yes());
  if(!input.worker.child.kill('SIGKILL'))no(Error('Y4_OWN_WORKER_CRASH_NOT_DELIVERED'));
 });
 await inFlight;assert.equal(input.worker.child.signalCode,'SIGKILL');
 let stopped=false,aborted:Awaited<ReturnType<typeof participantState>>=[];
 const stopDeadline=Date.now()+20000;
 while(Date.now()<stopDeadline){
  aborted=await participantState(input.states,sessionId);
  const current=await Promise.all(live.map(p=>processPin(p.pid)));
  stopped=current.every((p,i)=>!p||p.started!==live[i]!.started||p.state==='Z');
  if(stopped&&aborted.every(p=>p.state==='ABORTED'&&p.secretsBurned&&p.nonceBurned))break;
  await delay(100);
 }
 await artifact(input.privateDirectory,'crash-stop-observation.private.json',{
  stopped,aborted,processes:await Promise.all(live.map(p=>processPin(p.pid)))});
 assert(stopped,'Y4_CRASH_LEFT_LIVE_DESCENDANTS');
 assert(aborted.every(p=>p.state==='ABORTED'&&p.secretsBurned&&p.nonceBurned));
 const stateDigests=await Promise.all(input.states.map(async p=>sha((await readFile(join(p,'participant.sqlite'))).toString('base64'))));
 // Expiry is observed on the original physical lease. Never backdate or update it.
 await delay(Math.max(0,runningJobs[0].lease_expires_at.getTime()-Date.now()+100));
 const replacement=await input.restartWorker();
 ticks.push(await replacement.tick(Date.parse(input.deadlineAt)));
 const quarantined=(await job())[0];assert.equal(quarantined.id,runningJobs[0].id);
 assert.equal(quarantined.status,'quarantined');assert.equal(quarantined.attempts,runningJobs[0].attempts);
 const deliveries=(await input.admin.query(`SELECT id,outcome,claim_fence,failure_kind FROM finnor_os.job_delivery_attempts
  WHERE job_id=$1 ORDER BY started_at`,[quarantined.id])).rows;
 assert.equal(deliveries.length,1);assert.equal(deliveries[0].outcome,'reconciliation_required');
 assert.equal(deliveries[0].failure_kind,'lease_expired');
 const uncertain=await row();assert.equal(uncertain.runtime_receipt,null);
 assert.equal(uncertain.cpu_reserved_seconds,running.cpu_reserved_seconds);
 const reconcileInput={computationId:input.computationId,idempotencyKey:randomUUID(),
  reason:'Read-only reconciliation after the original installed worker and native processes stopped'};
 const requested=await input.call('confidential-reconcile',reconcileInput);
 assert.equal(requested.status,202);
 assert.deepEqual(await input.call('confidential-reconcile',reconcileInput),requested);
 let reconciled:any;
 const reconcileDeadline=Math.min(Date.parse(input.deadlineAt),Date.now()+90000);
 while(Date.now()<reconcileDeadline){
  const events=(await input.admin.query(`SELECT body FROM finnor_os.y4_events WHERE tenant_id=$1 AND computation_id=$2
   AND kind='RECONCILIATION_UNRESOLVED'`,[input.tenant,input.computationId])).rows;
  if(events.length){reconciled=events[0].body;break;}
  ticks.push(await replacement.tick(Date.parse(input.deadlineAt)));
  await delay(250);
 }
 assert(reconciled,'Y4_CANONICAL_READ_ONLY_RECONCILIATION_NOT_OBSERVED');
 assert.equal(reconciled.automaticResubmission,false);assert.equal(reconciled.disclosureRefunded,false);
 const after=await row();assert.equal(after.status,'RECONCILIATION_REQUIRED');
 assert.equal(after.runtime_receipt,null);assert.deepEqual(after.session,original.session);
 assert.equal(after.deadline_at.toISOString(),input.deadlineAt);
 assert.equal(after.cpu_reserved_seconds,running.cpu_reserved_seconds+32);
 assert.equal(after.attempt_count,original.attempt_count);assert.equal(after.generation,original.generation);
 assert.deepEqual(await disclosures(),originalDisclosures);
 assert.deepEqual(await Promise.all(input.states.map(async p=>sha((await readFile(join(p,'participant.sqlite'))).toString('base64')))),stateDigests);
 assert.deepEqual(await participantState(input.states,sessionId),aborted);
 assert.equal((await input.call('confidential-retry',{computationId:input.computationId,idempotencyKey:randomUUID(),
  reason:'Verify that a possibly delivered original session cannot restart'})).status,409);
 const prepared=await input.call('confidential-prepare',{computationId:input.computationId});
 assert.equal(prepared.status,200);assert.equal(prepared.body.session.sessionId,sessionId);
 assert.equal((await job()).length,1);
 const summary={canonicalLeaseExpiry:true,quarantinedOriginalJob:true,automaticInputRedelivery:false,
  originalDeliveryRetained:true,physicallyStoppedNativeParties:3,secretsAndNoncesBurned:true,
  canonicalQueuedReadOnlyReconciliation:true,originalSessionRetained:true,originalAbsoluteDeadlineRetained:true,
  failedCpuReservedSeconds:running.cpu_reserved_seconds,readOnlyReconciliationCpuSeconds:32,
  disclosureReservationsRetained:originalDisclosures.length,compilerRetryDenied:true,prepareReplayDidNotRestart:true,
  originalParticipantBytesUnchangedByReconciliation:true,plaintextFallback:false,protectedAdmission:false};
 await artifact(input.evidence,'canonical-recovery.json',{schema:'finnor.y4.canonical-recovery-e2e.v1',summary,
  computationId:input.computationId,originalSessionId:sessionId,originalJobId:quarantined.id,deliveries,ticks});
 await artifact(input.privateDirectory,'canonical-recovery.private.json',{original,running,uncertain,after,aborted,live,
  runningJobs,quarantined,reconciled,originalDisclosures});
 return {summary,sessionId,retained:after,originalDisclosures};
}
