/** Physical failures and recovery through actual owners. No forged persistence. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {appendEvidenceVersion} from '@finnor/memory';
import {artifact} from '../x3/environment.mts';
import {modes,transfer,retention,transferSpecification} from './business-fixtures.mts';

export async function learningRuntimeFaults(f:{
 e:any;evidence:string;tenant:string;root:any;main:any;compilation:any;
 native:(who:string,op:string,body:unknown)=>Promise<any>;learn:(who:string,op:string,body:unknown)=>Promise<any>;
 values:(label:string,currency:string,lines:readonly string[],bank:string,isTransfer?:boolean)=>Promise<any>;
 worker:()=>Promise<any>;workerPid:()=>number|undefined;restartWorker:()=>Promise<any>;install:(specification:any)=>Promise<any>;
}){
 const {e,evidence,tenant,root,learn,native}=f,steps:any[]=[];
 const ok=(v:any,status=200)=>{assert.equal(v.status,status,JSON.stringify(v));return v.body;};
 const sleep=(ms:number)=>new Promise(yes=>setTimeout(yes,Math.max(0,ms)));
 const save=async(id:string,value:unknown)=>{steps.push({id,value});await artifact(evidence,'runtime-progress.json',{steps,complete:false});};
 const original=(await e.admin.query('SELECT request FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2',[tenant,f.compilation.compilationId])).rows[0].request;
 const submit=async(experience=original.experience,knowledgeCut=original.knowledgeCut)=>ok(await learn('analyst','submit',{
  schema:'finnor.x5.compile-request.v1',root,experience,knowledgeCut,idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxAttempts:8,maxUses:256},
 }),202);
 const view=(id:string)=>learn('analyst','read',{compilationId:id}).then(v=>ok(v));
 const releases=(id:string)=>e.admin.query('SELECT id,body FROM finnor_os.x5_releases WHERE tenant_id=$1 AND compilation_id=$2 ORDER BY attempt',[tenant,id]).then((v:any)=>v.rows);
 const events=(id:string)=>e.admin.query('SELECT h.id::text,h.kind,h.body FROM finnor_os.x5_events h WHERE h.tenant_id=$1 AND h.compilation_id=$2 ORDER BY h.id',[tenant,id]).then((v:any)=>v.rows);
 const command=(actionId:string,record:any,input:any={},who='analyst')=>native(who,'command',{
  applicationId:f.main.id,entityId:'reconciliation',actionId,input,idempotencyKey:randomUUID(),
  ...(record?{recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference}:{}),
 });
 const use=(compilation:any,record:any,mode='COMPILED_TRAINED')=>({
  compilationId:compilation.compilationId,releaseId:compilation.headReleaseId,applicationId:f.main.id,recordId:record.id,
  expectedRevision:record.revision,expectedReference:record.reference,mode,stratum:'RETENTION',idempotencyKey:randomUUID(),
 });
 const snapshotUse=(id:string)=>e.admin.query('SELECT id,status,request,checkpoint_digest,policy_digest,result FROM finnor_os.x5_uses WHERE tenant_id=$1 AND id=$2',[tenant,id]).then((v:any)=>v.rows[0]);
 const gone=async(pid:number)=>{try{await readFile('/proc/'+pid+'/cmdline');return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}};
 const child=async()=>{
  const worker=f.workerPid();assert(worker);const until=Date.now()+8000;
  for(;;){
   const pids=(await readFile(`/proc/${worker}/task/${worker}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
   for(const pid of pids){
    try{if((await readFile('/proc/'+pid+'/cmdline','utf8')).includes('policy-learning/core-child.mts'))return {worker,pid};}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   }
   assert(Date.now()<until,'ACTUAL_OWNED_CORE_CHILD_REQUIRED');await sleep(5);
  }
 };
 const grant=async()=>{
  const knowledgeCut=new Date().toISOString(),deadline=(await e.admin.query('SELECT deadline_at FROM finnor_os.x3_applications WHERE tenant_id=$1 AND id=$2',[tenant,f.main.id])).rows[0].deadline_at.toISOString();
  return {...ok(await learn('analyst','consent',{schema:'finnor.x5.training-rights.v1',applicationId:f.main.id,
   purposes:['TRAIN_STRUCTURAL_CONTROLLER','EXECUTE_DERIVED_POLICY'],transfer:'SAME_TENANT_COMPATIBLE_APPLICATIONS',
   failures:'NONPOSITIVE_STRUCTURAL_OBSERVATIONS_ONLY',data:'STRUCTURAL_BOOLEANS_ONLY_NO_TEXT_AMOUNTS_IDENTIFIERS_CREDENTIALS',
   retention:'RETAIN_AUDIT_REVOKE_DERIVED_USE_NO_UNLEARNING_CLAIM',knowledgeCut,validUntil:deadline,idempotencyKey:randomUUID()})),knowledgeCut};
 };
 const waitResources=async(id:string)=>{
  const job=(await e.admin.query("SELECT id,lease_expires_at,claim_fence FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'compilationId'=$2 AND status='running' ORDER BY accepted_at DESC LIMIT 1",[tenant,id])).rows[0];assert(job);
  const compute=(await e.admin.query(`SELECT resource_key,owner_id,fence,expires_at,released_at FROM finnor_os.compute_resource_leases
   WHERE owner_id IN(SELECT 'x5:'||d.id::text FROM finnor_os.job_delivery_attempts d WHERE d.job_id=$1 AND d.outcome='running')`,[job.id])).rows;
  const expiries=[job.lease_expires_at.getTime(),...compute.filter((v:any)=>!v.released_at).map((v:any)=>v.expires_at.getTime())];
  const due=Math.max(...expiries);assert(due-Date.now()<330000,'ORDINARY_LEASE_RECOVERY_BOUND');await sleep(due-Date.now()+40);
  return {job,compute,observedWaitUntil:new Date(due).toISOString()};
 };
 const recovered=async(id:string,stage:string)=>{
  for(let i=0;i<8;i++){
   await f.worker();
   const jobs=(await e.admin.query("SELECT id,status,run_at,attempts,claim_fence FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'compilationId'=$2 AND payload->>'stage'=$3 ORDER BY accepted_at DESC",[tenant,id,stage])).rows;
   if(jobs[0]?.status==='completed')return jobs;
   const due=jobs.find((v:any)=>v.status==='queued')?.run_at?.getTime();assert(due&&due-Date.now()<120000,JSON.stringify(jobs));await sleep(due-Date.now()+30);
  }
  throw Error('BOUNDED_ORDINARY_RECOVERY_NOT_COMPLETE');
 };
 try{
  for(const kind of ['kill','wall','cancel','rights']){
   const rights=kind==='rights'?await grant():null,selection=rights?original.experience.map((v:any)=>({...v,consentId:rights.consentId})):original.experience;
   const accepted=await submit(selection,rights?.knowledgeCut??original.knowledgeCut),before=await view(accepted.compilationId);
   const pending=Promise.allSettled([f.worker()]);let physical:{worker:number;pid:number}|undefined;
   try{
    physical=await child();let intervention:any;
    if(kind==='kill')process.kill(physical.pid,'SIGKILL');
    if(kind==='wall')process.kill(physical.pid,'SIGSTOP');
    if(kind==='cancel')intervention=ok(await learn('analyst','cancel',{compilationId:accepted.compilationId,reason:'Cancellation during actual physical training',idempotencyKey:randomUUID()}));
    if(kind==='rights')intervention=ok(await learn('analyst','revoke-consent',{consentId:rights!.consentId,reason:'Revocation during actual physical training',idempotencyKey:randomUUID()}));
    const [worked]=await pending;if(worked!.status==='rejected')throw worked!.reason;
    const after=await view(accepted.compilationId),history=await events(accepted.compilationId);
    assert.equal(after.status,kind==='cancel'?'CANCELLED':'FAILED');assert.equal(after.headReleaseId,null);assert.equal(after.counters.attempts,1);
    assert.equal(after.counters.deadlineAt,before.counters.deadlineAt);assert.equal((await releases(accepted.compilationId)).length,0);assert(await gone(physical.pid));
    if(kind==='wall')assert(history.some((v:any)=>v.kind==='OPERATION_FAILED'&&v.body.physicalReceipt?.supervisorWallMs>=29000));
    let retry:any;
    if(kind==='kill'){
     await save('actual-child-kill-before-retry',{accepted,before,physical,after,history,descendantGone:true});
     retry=ok(await learn('analyst','retry',{compilationId:accepted.compilationId,reason:'Same original Work after actual child loss',idempotencyKey:randomUUID()}),202);await f.worker();
     const ready=await view(accepted.compilationId);assert.equal(ready.status,'DEVELOPMENT_READY');assert.equal(ready.counters.attempts,2);assert.equal(ready.counters.deadlineAt,before.counters.deadlineAt);retry={accepted:retry,ready};
    }
    await save('actual-child-'+kind,{accepted,before,physical,rights,intervention,after,history,retry,descendantGone:true});
   }finally{if(physical&&!await gone(physical.pid))process.kill(physical.pid,'SIGKILL');await pending;}
  }

  const interrupted=await submit(),before=await view(interrupted.compilationId),gate=74505022;
  let pending:Promise<PromiseSettledResult<any>[]>|undefined;
  await e.admin.query('SELECT pg_advisory_lock($1::bigint)',[gate]);
  try{
   await e.admin.query(`CREATE FUNCTION finnor_os.x5_runtime_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.compilation_id=TG_ARGV[0]::uuid AND NEW.kind=TG_ARGV[1]
     THEN PERFORM pg_advisory_xact_lock(74505022::bigint);END IF;RETURN NEW;END $$`);
   await e.admin.query(`CREATE TRIGGER x5_runtime_gate AFTER INSERT ON finnor_os.x5_events FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_runtime_gate('${interrupted.compilationId}','TRAINING_METRICS')`);
   pending=Promise.allSettled([f.worker()]);const until=Date.now()+10000;
   for(;;){if((await e.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND NOT granted",[gate])).rowCount)break;assert(Date.now()<until,'ACTUAL_POST_CHILD_METRICS_GATE_REQUIRED');await sleep(20);}
   const worker=f.workerPid();assert(worker);process.kill(worker,'SIGKILL');
   const [lost]=await pending;assert.equal(lost!.status,'rejected');
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);
   const rolledBack=await view(interrupted.compilationId);assert.equal(rolledBack.status,'TRAINING');assert.equal(rolledBack.headReleaseId,null);assert.equal((await releases(interrupted.compilationId)).length,0);
   const restart=await f.restartWorker(),wait=await waitResources(interrupted.compilationId),jobs=await recovered(interrupted.compilationId,'TRAIN');
   const after=await view(interrupted.compilationId);assert.equal(after.status,'DEVELOPMENT_READY');assert.equal(after.counters.attempts,2);assert.equal(after.counters.deadlineAt,before.counters.deadlineAt);
   const deliveries=(await e.admin.query('SELECT d.id,d.outcome,d.claim_fence,d.worker_id FROM finnor_os.job_delivery_attempts d WHERE d.job_id=$1 ORDER BY d.started_at',[wait.job.id])).rows;
   assert(deliveries.some((v:any)=>v.outcome==='lease_lost'));assert(deliveries.some((v:any)=>v.outcome==='completed'&&Number(v.claim_fence)>Number(wait.job.claim_fence)));
   await save('post-child-worker-loss-atomic-publication-and-real-lease-recovery',{interrupted,before,worker,rolledBack,restart,wait,jobs,after,deliveries});
  }finally{
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);if(pending)await pending;
   await e.admin.query('DROP TRIGGER IF EXISTS x5_runtime_gate ON finnor_os.x5_events');await e.admin.query('DROP FUNCTION IF EXISTS finnor_os.x5_runtime_gate()');
  }

  // Genuine, deliberately incomplete two-case census. This exercises a real
  // evaluation transaction, not a supplied grade or a successful full gate.
  const target=await f.install(transferSpecification(tenant,root.entityId)),used:string[]=[],retained:string[]=[],cases:any[]=[];
  for(const [tuple,application,who,isTransfer] of [[transfer[0]!,target,'ledger',true],[retention[0]!,f.main,'analyst',false]] as const){
   const [id,currency,lines,bank,count]=tuple,replicas:any[]=[];
   for(const mode of modes){
    const input=await f.values(id+':'+mode,currency,lines,bank,isTransfer);
    const created=ok(await native(who,'command',{applicationId:application.id,entityId:application.specification.model.entities[0].id,
     actionId:isTransfer?'openLot':'create',input,idempotencyKey:randomUUID()})).record;replicas.push({mode,record:created});
   }
   const assigned=ok(await learn('evaluator','register-assignment',{compilationId:f.compilation.compilationId,releaseId:f.compilation.headReleaseId,caseId:id,
    replicas:replicas.map(v=>({mode:v.mode,applicationId:application.id,recordId:v.record.id})),idempotencyKey:randomUUID()}));
   for(const replica of replicas){
    const input={...use(f.compilation,replica.record,replica.mode),applicationId:application.id,stratum:isTransfer?'TRANSFER':'RETENTION',assignmentRef:assigned.assignmentRef};
    const accepted=ok(await learn(who,'execute',input),202);(isTransfer?used:retained).push(accepted.useId);await f.worker();
    let record=ok(await native(who,'record',{applicationId:application.id,recordId:replica.record.id}));
    const approve=async(principal:string)=>{
     record=ok(await native(principal,'command',{applicationId:application.id,entityId:application.specification.model.entities[0].id,actionId:isTransfer?'attest':'approve',
      recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference,input:{},idempotencyKey:randomUUID()})).record;
    };
    if(record.state===(isTransfer?'TIED_OUT':'RECONCILED')){await approve(isTransfer?'finance':'partner');if(Number(count)===2)await approve(isTransfer?'risk':'compliance');}
    cases.push({id,mode:replica.mode,input,accepted,record});
   }
  }
  const evaluated=ok(await learn('evaluator','evaluate',{compilationId:f.compilation.compilationId,releaseId:f.compilation.headReleaseId,useIds:used,retainedUseIds:retained,idempotencyKey:randomUUID()}),202);
  let grading:Promise<PromiseSettledResult<any>[]>|undefined;
  await e.admin.query('SELECT pg_advisory_lock($1::bigint)',[gate]);
  try{
   await e.admin.query(`CREATE FUNCTION finnor_os.x5_runtime_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.compilation_id=TG_ARGV[0]::uuid AND NEW.kind=TG_ARGV[1]
     THEN PERFORM pg_advisory_xact_lock(74505022::bigint);END IF;RETURN NEW;END $$`);
   await e.admin.query(`CREATE TRIGGER x5_runtime_gate AFTER INSERT ON finnor_os.x5_events FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_runtime_gate('${f.compilation.compilationId}','EVALUATION_COMPLETED')`);
   grading=Promise.allSettled([f.worker()]);const until=Date.now()+15000;
   for(;;){if((await e.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND NOT granted",[gate])).rowCount)break;assert(Date.now()<until,'ACTUAL_EVALUATION_COMPLETION_GATE_REQUIRED');await sleep(20);}
   const worker=f.workerPid();assert(worker);process.kill(worker,'SIGKILL');const [lost]=await grading;assert.equal(lost!.status,'rejected');
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);
   const rolledBack=(await e.admin.query('SELECT id,status,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND id=$2',[tenant,evaluated.evaluationId])).rows[0];assert.equal(rolledBack.status,'QUEUED');assert.equal(rolledBack.result,null);
   const restart=await f.restartWorker(),wait=await waitResources(f.compilation.compilationId),jobs=await recovered(f.compilation.compilationId,'EVALUATE');
   const after=(await e.admin.query('SELECT id,status,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND id=$2',[tenant,evaluated.evaluationId])).rows[0];assert.equal(after.status,'COMPLETE');assert.equal(after.result.disposition,'REFUSED_OR_INCOMPLETE');assert.equal(after.result.outcomes.length,8);
   const deliveries=(await e.admin.query('SELECT id,outcome,claim_fence,worker_id FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at',[wait.job.id])).rows;
   assert(deliveries.some((v:any)=>v.outcome==='lease_lost'));assert(deliveries.some((v:any)=>v.outcome==='completed'&&Number(v.claim_fence)>Number(wait.job.claim_fence)));
   await save('evaluation-worker-loss-atomic-rollback-and-real-lease-recovery',{cases,evaluated,worker,rolledBack,restart,wait,jobs,after,deliveries,notFullBusinessAcceptance:true});
  }finally{
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);if(grading)await grading;
   await e.admin.query('DROP TRIGGER IF EXISTS x5_runtime_gate ON finnor_os.x5_events');await e.admin.query('DROP FUNCTION IF EXISTS finnor_os.x5_runtime_gate()');
  }

  const ready=await view(interrupted.compilationId),r=ok(await command('create',null,await f.values('runtime-wait','USD',['1400','2600'],'4000'))).record;
  const waitInput=use(ready,r,'COMPILED_ORIGINAL'),queued=ok(await learn('analyst','execute',waitInput),202);await f.worker();
  const waiting=await snapshotUse(queued.useId);assert.equal(waiting.status,'WAIT');assert.equal(waiting.result.nativeInvoked,false);
  const restarted=await f.restartWorker();
  let extra=ok(await command('create',null,await f.values('E09-new-independent-training-only','USD',['199','1'],'200'))).record;
  extra=ok(await command('reconcile',extra)).record;extra=ok(await command('approve',extra,{},'partner')).record;
  const newRights=await grant(),selection=original.experience.map((v:any)=>({...v,recordIds:[...v.recordIds,extra.id],consentId:newRights.consentId}));
  const retrained=ok(await learn('analyst','retrain',{compilationId:ready.compilationId,experience:selection,knowledgeCut:newRights.knowledgeCut,reason:'E09 new independently accepted training history, no F/R input',idempotencyKey:randomUUID()}),202);await f.worker();
  const newHead=await view(ready.compilationId);assert.equal(newHead.counters.attempts,3);assert.equal(newHead.counters.deadlineAt,ready.counters.deadlineAt);assert.notEqual(newHead.headReleaseId,ready.headReleaseId);assert.notEqual(newHead.identity.checkpointDigest,ready.identity.checkpointDigest);
  const replay=await learn('analyst','execute',waitInput);
  if(replay.status===202){assert.equal(replay.body.useId,queued.useId);assert.equal(replay.body.replayed,true);}else assert([403,409].includes(replay.status));
  assert.deepEqual(await snapshotUse(queued.useId),waiting);
  const rollback=ok(await learn('analyst','rollback',{compilationId:ready.compilationId,releaseId:ready.headReleaseId,idempotencyKey:randomUUID()}));
  const oldHead=await view(ready.compilationId);assert.equal(oldHead.headReleaseId,ready.headReleaseId);assert(oldHead.current);
  const both=await releases(ready.compilationId);assert.equal(both.length,2);
  const shared=both[0].body.experience.records.flatMap((v:any)=>v.sourceRefs).find((v:any)=>v.owner==='S1_EVIDENCE'&&both[1].body.experience.records.some((x:any)=>x.sourceRefs.some((r:any)=>r.id===v.id&&r.revision===v.revision)));assert(shared);
  const correction=await appendEvidenceVersion(tenant,shared.id,{content:'Actual source correction shared by both learned revisions',snapshot:{qualification:'PUBLIC_DEVELOPMENT_RUNTIME_FAULT'},asOf:new Date('2026-03-07T00:00:00Z')});
  const stale=await view(ready.compilationId);assert.equal(stale.current,false);assert.equal(stale.capsule,null);
  const refusals=[];
  for(const release of both){const refused=await learn('analyst','execute',{...use(ready,r),releaseId:release.id});assert([403,409].includes(refused.status));refusals.push(refused);}
  assert.equal((await view(ready.compilationId)).counters.uses,1);
  await save('WAIT-pinned-across-restart-retrain-compatible-rollback-and-shared-source-invalidation',{ready,waitInput,queued,waiting,restarted,extra,newRights,retrained,newHead,replay,rollback,oldHead,shared,correction,stale,refusals});
  const report={schema:'finnor.x5.physical-runtime-faults.v1',allPassed:true,steps,protectedAdmission:false,productionActive:false,
   notEstablished:['COMPETING_WORKS','STORAGE_AND_ELAPSED_DEADLINE_EXHAUSTION','OS_SANDBOX_OR_AGGREGATE_RSS_CONTAINMENT']};
  await artifact(evidence,'runtime-faults.json',report);return report;
 }catch(error){await artifact(evidence,'runtime-FAILED.json',{error:String(error),stack:(error as Error).stack,steps});throw error;}
}
