/** A–G/I preregistered installed owner campaign. All positive rows originate in
 * native authenticated product owners. SQL gates only schedule physical faults
 * in this disposable database; they never grant authority or supply results. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import pg from 'pg';
import {appendEvidenceVersion} from '@finnor/memory';
import {receiveWork,isImmutableWorkStatus} from '@finnor/db';
import {artifact,repo,hash,recordPriorReleaseProbeRefusal} from '../x3/environment.mts';
import {startHarness,until} from './harness.mts';
import {canonicalClaim} from './business-fixtures.mts';
import {digest} from '../../packages/private-equity/src/interaction-synthesis/contracts';
import {LIMITS} from '../../packages/private-equity/src/interaction-synthesis/product-contracts';

assert(process.env.FINNOR_Y3_EVIDENCE_DIR,'EXPLICIT_Y3_INSTALLED_EVIDENCE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y3_EVIDENCE_DIR),built=process.env.FINNOR_Y3_BUILT_API==='1',
 started=performance.now(),results:any[]=[];
let h:Awaited<ReturnType<typeof startHarness>>|undefined,passed=false;
async function test(id:string,fn:()=>Promise<unknown>){
 const start=performance.now();
 try{
  const observed=await fn(),result={id,status:'PASS',wallMs:performance.now()-start,observed};
  results.push(result);await artifact(evidence,'cases/'+id+'.json',result);
 }catch(error){
  const result={id,status:'FAIL',wallMs:performance.now()-start,error:String(error),stack:(error as Error).stack};
  results.push(result);await artifact(evidence,'cases/'+id+'.json',result);throw error;
 }
}
try{
 h=await startHarness(evidence,built);
 const {e,tenant,principal,peer,outsider,api,ok,read,fixture,compile,tick}=h;
 let main:any,prepared:any,lowered:any;
 await test('F-authentication-contracts-and-restricted-migration',async()=>{
  const noAuth=await fetch((e.http!.builtBase()??e.http!.apiBase)+'/api/company-brain/interaction-submit',{
   method:'POST',headers:{'content-type':'application/json'},body:built?'not-json':'{}'});
  assert.equal(noAuth.status,401,'Authenticate before reading a malformed body');
  assert.equal((await api('interaction-submit',{mode:'production'})).status,400);
  const roles=(await e.admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker')")).rows;
  assert(roles.length===2&&roles.every(r=>!r.rolsuper&&!r.rolbypassrls));
  const tables=(await e.admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='finnor_os' AND relname IN('y3_episodes','y3_requests','y3_events','s8_interaction_admissions',
   's4_interaction_terms','s4_interaction_consents','s4_interaction_runs','s4_interaction_history','s4_interaction_programme_bindings')`)).rows;
  assert.equal(tables.length,9);assert(tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
  return {noAuth:noAuth.status,strictInput:400,roles,tables,actualBuiltApi:built,authBypass:false};
 });
 await test('F-queued-original-input-to-independently-checked-protocol',async()=>{
  main=await compile(await fixture('positive'));assert.equal(main.view.status,'CHECKED',JSON.stringify(main.view));
  const check=main.view.artifact.envelope.independentChecks[0];
  assert.equal(check.maxRegret,'0');assert.equal(check.globalBeliefConsistency,true);
  assert.equal(check.fullDeviationCoverage,true);assert.equal(check.nontrivial,true);
  assert.equal(new Set(Object.values(main.view.artifact.body.policy)).size,2);
  const native=(await e.admin.query(`SELECT j.id,j.type,j.status,j.protocol_version,d.claim_fence,d.outcome
   FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
   WHERE j.tenant_id=$1 AND j.payload->>'protocolId'=$2`,[tenant,main.accepted.protocolId])).rows;
  assert(native.length&&native.every(r=>Number(r.claim_fence)>0&&r.outcome==='completed'));
  const runtime=main.view.artifact.envelope.provenance.executionRuntime;
  assert(runtime.sourcePins.some((p:any)=>p.path.endsWith('/dist-y3/worker-loop.mjs')&&p.sha256===h!.runtime.worker.sha256),
   'The actual executing mathematical bundle must be pinned');
  assert.equal(runtime.profileDigest,h!.runtime.profileDigest);
  await tick();await recordPriorReleaseProbeRefusal(evidence,e.admin);
  return {protocolId:main.accepted.protocolId,request:main.request,artifact:main.view.artifact,native,
   mathematicalEngine:'EMITTED_BUNDLE_WITH_FRESH_PYTHON_ORACLE',protectedQualification:false};
 });
 await test('F-isolation-replay-download-and-comparison',async()=>{
  assert.equal((await api('interaction-read',{protocolId:main.accepted.protocolId},peer)).status,404);
  assert.equal((await api('interaction-local',{protocolId:main.accepted.protocolId},outsider)).status,404);
  const local=ok(await api('interaction-local',{protocolId:main.accepted.protocolId},peer));
  assert.equal(local.privateModelDataIncluded,false);assert(!JSON.stringify(local).includes('terminalNodeId'));
  const replay=ok(await api('interaction-submit',main.request),202);
  assert.equal(replay.protocolId,main.accepted.protocolId);assert.equal(replay.replayed,true);
  assert.equal((await api('interaction-submit',{...main.request,problem:{...main.request.problem,title:'changed'}})).status,409);
  assert.equal((await api('interaction-submit',{...main.request,candidate:main.view.artifact.body})).status,400);
  const download=ok(await api('interaction-artifact',{protocolId:main.accepted.protocolId}));
  assert.equal(hash(Buffer.from(download.bytesBase64,'base64')),download.sha256);
  const compared=ok(await api('interaction-compare',{protocolId:main.accepted.protocolId}));
  assert.equal(compared.fallbackKind,'UNKNOWN_NO_COMPATIBLE_FALLBACK');
  const app=new pg.Client({connectionString:e.appUrl});await app.connect();
  try{assert.equal((await app.query('SELECT id FROM finnor_os.y3_requests')).rowCount,0);}finally{await app.end();}
  return {peerPrivateArtifact:404,nonparticipant:404,local,replay,download:{sha256:download.sha256},compared,unscopedRlsRows:0};
 });
 await test('E-exact-terms-revision-both-participant-consents-and-S5-contention',async()=>{
  const admission=ok(await api('interaction-admit',{protocolId:main.accepted.protocolId}));
  assert.equal(admission.domain,'INTERACTION_PROTOCOL');assert.equal(admission.protectedAdmission,false);
  const reservation=await h!.reserve(main,'positive'),terms1=await h!.terms(main,reservation.held);
  await h!.consent(main,terms1,principal);
  assert.equal((await api('interaction-start',{protocolId:main.accepted.protocolId,termsRef:terms1.ref,idempotencyKey:randomUUID()})).status,422);
  const terms2=await h!.terms(main,reservation.held);assert.equal(terms2.revision,terms1.revision+1);
  assert.equal((await api('interaction-consent',{protocolId:main.accepted.protocolId,termsRef:terms1.ref,scope:'TERMS',
   subjectDigest:terms1.ref.contentDigest,decision:'ACCEPT',idempotencyKey:randomUUID()},peer)).status,422);
  await h!.consent(main,terms2,peer);
  assert.equal((await api('interaction-start',{protocolId:main.accepted.protocolId,termsRef:terms2.ref,idempotencyKey:randomUUID()})).status,422);
  await h!.consent(main,terms2,principal);
  const contention=await api('economic-reservation-create',{...reservation.request,idempotencyKey:randomUUID()});
  assert.equal(contention.status,409);assert.equal(contention.body.code,'S5_ECONOMIC_SHARED_CAPACITY_EXHAUSTED');
  prepared={f:main,admission,...reservation,terms:terms2,run:await h!.begin(main,terms2)};
  return {admission,terms1,terms2,reservation:reservation.held,contention,oldConsentNotRebound:true};
 });
 await test('F-lawful-local-observation-actions-and-exact-effect-intent',async()=>{
  let run=prepared.run;
  assert.equal(run.local.status,'NEEDS_LAWFUL_OBSERVATION');
  assert.equal((await api('interaction-observe',{runId:run.runId,expectedRevision:run.local.revision,date:0,key:'market',value:'0',
   classification:'AUTHENTICATED_ASSERTION',idempotencyKey:randomUUID()})).status,422);
  assert.equal((await api('interaction-observe',{runId:run.runId,expectedRevision:run.local.revision,date:0,key:'market',value:'0',
   classification:'SOURCED_FACT',idempotencyKey:randomUUID()})).status,422);
  const malformedTimes:any[]=[];
  for(const which of ['observedAt','validUntil']){
   const claim={key:'malformed-time:'+randomUUID(),kind:'INTERACTION_OBSERVATION',problemDigest:digest(main.request.problem),
    participant:'P0',date:0,observationKey:'market',value:'0',classification:'SOURCED_FACT',
    observedAt:new Date().toISOString(),validUntil:new Date(Date.now()+3600000).toISOString(),[which]:'not-a-date'},
    source=await canonicalClaim(e.admin,tenant,h!.root,claim),
    denied=await api('interaction-observe',{runId:run.runId,expectedRevision:run.local.revision,date:0,key:'market',value:'0',
     classification:'SOURCED_FACT',source,idempotencyKey:randomUUID()});
   assert.equal(denied.status,422);malformedTimes.push({which,denied});
  }
  assert.equal((await api('interaction-action',{runId:run.runId,expectedRevision:run.local.revision,viewDigest:run.local.viewDigest,
   actionId:'engage',hiddenNodeId:'0-hold-engage',idempotencyKey:randomUUID()})).status,400);
  const before=run;run=await h!.observe(main,run);
  assert.equal(run.local.status,'AWAITING_LOCAL_ACTION');
  assert(run.local.observations.some((v:any)=>v.key==='market'&&v.verifiedFact));
  assert.equal((await api('interaction-action',{runId:run.runId,expectedRevision:before.local.revision,
   viewDigest:before.local.viewDigest,actionId:'engage',idempotencyKey:randomUUID()})).status,409);
  const p1Before=await h!.runRead(run.runId,peer);
  assert.equal(p1Before.local.actions.length,0);
  run=await h!.action(run,'engage');
  const p1=await h!.runRead(run.runId,peer);
  assert(!p1.local.observations.some((v:any)=>v.key==='private-type'),'Private P0 observation is not disclosed on the low branch');
  assert(p1.local.actions.some((v:any)=>v.id==='accept'));
  run=await h!.action(p1,'accept',peer);assert.equal(run.status,'READY');assert(run.intent);
  assert.equal((await api('interaction-materialize',{runId:run.runId,intentRef:run.intent.ref,idempotencyKey:randomUUID()})).status,422);
  await h!.consent(main,prepared.terms,principal,'EFFECT',run.intent.ref.contentDigest);
  assert.equal((await api('interaction-materialize',{runId:run.runId,intentRef:run.intent.ref,idempotencyKey:randomUUID()})).status,422);
  prepared.run=run;lowered=await h!.materialize(prepared);assert(lowered.programmeId);
  const binding=(await e.admin.query('SELECT body FROM finnor_os.s4_interaction_programme_bindings WHERE tenant_id=$1 AND programme_id=$2',
   [tenant,lowered.programmeId])).rows[0].body;
  assert.equal(binding.originalEpisodeId,main.view.counters.episodeId);assert.equal(binding.intent.ref.contentDigest,run.intent.ref.contentDigest);
  return {before,p1,run,lowered,binding,malformedTimes,assertionNotTruth:true,noCallerHiddenNode:true,termsAloneDidNotAuthorizeEffect:true};
 });
 await test('E-native-Y1-entrypoint-cannot-bypass-current-effect-consent',async()=>{
  await h!.consent(main,prepared.terms,peer,'EFFECT',prepared.run.intent.ref.contentDigest,'WITHDRAW');
  const direct=await api('economic-programme-run',{programmeId:lowered.programmeId});
  assert.equal(direct.status,422);assert.equal(direct.body.code,'Y3_BOTH_EXACT_EFFECT_CONSENTS_REQUIRED');
  // Reacceptance changes the immutable native binding's original consent
  // heads. It cannot silently revive this already materialized programme.
  await h!.consent(main,prepared.terms,peer,'EFFECT',prepared.run.intent.ref.contentDigest);
  const rebound=await api('economic-programme-run',{programmeId:lowered.programmeId});
  assert.equal(rebound.status,422);assert.equal(rebound.body.code,'Y3_ORIGINAL_CONSENT_HEADS_CHANGED');
  assert.equal((await e.admin.query('SELECT effect_id FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1 AND programme_id=$2',
   [tenant,lowered.programmeId])).rowCount,0);
  return {direct,rebound,nativeEffects:0,oldProgrammeNotReauthorized:true};
 });
 await test('F-fixed-lowering-native-S6-effect-separate-S7-observation',async()=>{
  const f=await compile(await fixture('effect')),p=await h!.prepare(f,'effect'),lowered=await h!.materialize(p),
   queued=ok(await api('interaction-run',{runId:p.run.runId}),202);
  let projection:any;
  for(let i=0;i<6;i++){
   await tick();projection=ok(await api('economic-programme-read',{programmeId:lowered.programmeId}));
   if(projection.status==='OBSERVED')break;
  }
  assert.equal(projection.status,'OBSERVED',JSON.stringify(projection));
  assert.equal(projection.observedGoalDigest,digest({available:'1',committed:'4'}));
  assert.equal(projection.obligations.length,1);assert(projection.obligations[0].verification.canonicalObservationRef);
  const reservation=ok(await api('economic-reservation-read',{reservationRef:p.held.origin.ref}));
  assert.deepEqual(reservation.origin.envelopes,p.held.origin.envelopes);
  assert.deepEqual(reservation.economicState.state,{available:'1',committed:'4'});
  const effects=(await e.admin.query(`SELECT e.id,e.status,e.effect,e.verification,o.body
   FROM finnor_os.business_effects e JOIN finnor_os.s6_economic_obligation_origins o ON o.tenant_id=e.tenant_id AND o.effect_id=e.id
   WHERE o.tenant_id=$1 AND o.programme_id=$2`,[tenant,lowered.programmeId])).rows;
  assert.equal(effects.length,1);assert.equal(effects[0].status,'verified');
  const run=await h!.runRead(p.run.runId),work=(await e.admin.query(
   'SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2',[tenant,f.request.workId])).rows[0],
   restart=await api('interaction-start',{protocolId:f.accepted.protocolId,termsRef:p.terms.ref,idempotencyKey:randomUUID()});
  // S7 observes this programme, not completion of the containing Work. The
  // unchanged protocol never renews the terms' original reservation revision.
  assert.equal(run.current,!isImmutableWorkStatus(work.status));
  assert.equal(restart.status,isImmutableWorkStatus(work.status)?422:409);
  if(!isImmutableWorkStatus(work.status))assert.equal(restart.body.code,'Y3_ORIGINAL_RESERVATION_REVISED');
  assert.equal(run.nativeProgramme.status,'OBSERVED');assert.equal(run.nativeProgramme.observedGoalDigest,projection.observedGoalDigest);
  return {protocolId:f.accepted.protocolId,queued,lowered,projection,reservation,effects,run,work,restart,financialOutcomeEstablished:false};
 });
 await test('E-observation-source-head-locks-through-native-commit-and-retains-corrected-readback',async()=>{
  const f=await compile(await fixture('observation_race')),p=await h!.prepare(f,'observation_race'),lowered=await h!.materialize(p),
   observation=(await e.admin.query(`SELECT body->'source' source FROM finnor_os.s4_interaction_history
    WHERE tenant_id=$1 AND run_id=$2 AND kind='OBSERVATION' AND body->>'effective'='true' ORDER BY id LIMIT 1`,
   [tenant,p.run.runId])).rows[0].source,
   snapshot=(await e.admin.query('SELECT snapshot FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',
    [tenant,observation.versionId])).rows[0].snapshot,
   lock=71423004,adminPid=(await e.admin.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  snapshot.interactionClaims[0].value='1';
  assert(/^economic-rights-reservation:[0-9a-f]{64}$/.test(p.held.origin.ref.id));
  await e.admin.query('SELECT pg_advisory_lock($1)',[lock]);
  await e.admin.query(`CREATE FUNCTION finnor_os.y3_test_rights_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF session_user='finnor_worker' AND NEW.reservation_id=TG_ARGV[0]
    AND NEW.economic_state IS DISTINCT FROM OLD.economic_state
   THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`);
  await e.admin.query(`CREATE TRIGGER y3_test_rights_commit_gate BEFORE UPDATE ON finnor_os.s5_reservations
   FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_test_rights_commit_gate('${p.held.origin.ref.id}')`);
  let ticking:Promise<any>|undefined,correction:Promise<any>|undefined,writerDone=false,blocking:any,workerPid:number|undefined;
  try{
   ok(await api('interaction-run',{runId:p.run.runId}),202);ticking=tick().catch(error=>({error:String(error)}));
   await until(async()=>{
    workerPid=(await e.admin.query(`SELECT pid FROM pg_stat_activity
     WHERE usename='finnor_worker' AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))`,[adminPid])).rows[0]?.pid;
    return !!workerPid;
   },'ACTUAL_Y3_RIGHTS_COMMIT_GATE_NOT_REACHED');
   correction=appendEvidenceVersion(tenant,observation.sourceId,{content:'Corrected canonical participant observation',
    snapshot,asOf:new Date()}).then(value=>{writerDone=true;return {value};},error=>{writerDone=true;return {error:String(error)};});
   await until(async()=>{
    blocking=(await e.admin.query(`SELECT pid,wait_event,pg_blocking_pids(pid) blocking FROM pg_stat_activity
     WHERE pid<>$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) AND query ILIKE '%evidence_sources%'`,
    [adminPid,workerPid])).rows[0];return !!blocking;
   },'CANONICAL_OBSERVATION_WRITER_WAS_NOT_SERIALIZED',5000);
   assert.equal(writerDone,false,'A correction cannot commit between the native source check and effect commit');
  }finally{
   await e.admin.query('SELECT pg_advisory_unlock($1)',[lock]);
   const finished=await Promise.all([ticking,correction]);assert(finished.every(v=>!v?.error),JSON.stringify(finished));
   await e.admin.query('DROP TRIGGER y3_test_rights_commit_gate ON finnor_os.s5_reservations');
   await e.admin.query('DROP FUNCTION finnor_os.y3_test_rights_commit_gate()');
  }
  assert(writerDone);
  const programme=ok(await api('economic-programme-read',{programmeId:lowered.programmeId})),run=await h!.runRead(p.run.runId),
   denied=await api('interaction-run',{runId:p.run.runId});
  assert.equal(programme.status,'OBSERVED');assert.equal(programme.obligations.length,1);
  assert.equal(run.current,false);assert.equal(run.status,'INVALIDATED_RESPONSIBILITY_RETAINED');
  assert(run.currentnessReasons.includes('Y3_LOCAL_OBSERVATION_REVISED_OR_UNQUALIFIED'));
  assert.equal(run.nativeProgramme.status,'OBSERVED');assert.equal(denied.status,422);
  return {blocking,workerPid,observation,programme,run,denied,correctionSerializedAfterOriginalCommit:true,originalResponsibilityRetained:true};
 });
 await test('G-prequeued-requests-share-exhausted-original-allocation-with-terminal-readback',async()=>{
  const f=await fixture('queued_exhaustion'),accepted:any[]=[];
  for(let i=0;i<LIMITS.maxAttempts+1;i++)accepted.push(ok(await api('interaction-submit',
   {...f.request,idempotencyKey:randomUUID()}),202));
  const before=await read(accepted[0].protocolId);
  for(let i=0;i<accepted.length;i++)await tick();
  const rows=await Promise.all(accepted.map(v=>read(v.protocolId))),last=rows.at(-1)!,
   delivery=(await e.admin.query('SELECT status FROM finnor_os.jobs WHERE id=$1',[accepted.at(-1).jobId])).rows[0];
  assert.deepEqual(rows.map(v=>v.status),[...Array(LIMITS.maxAttempts).fill('CHECKED'),'INCOMPLETE']);
  assert.equal(delivery.status,'completed');assert.equal(last.resumable,false);assert.equal(last.artifact,null);
  assert.equal(last.counters.episodeId,before.counters.episodeId);assert.equal(last.counters.deadlineAt,before.counters.deadlineAt);
  assert.equal(last.counters.attempts,LIMITS.maxAttempts);
  assert.equal(last.counters.searchStepsOccupied,LIMITS.maxAttempts*LIMITS.maxSearchSteps);
  assert(last.events.some((v:any)=>v.kind==='NATIVE_ATTEMPT_NOT_STARTED'));
  const denied=await api('interaction-resume',{protocolId:last.protocolId});
  assert.equal(denied.status,409);assert.equal(denied.body.code,'Y3_ORIGINAL_RESUME_UNAVAILABLE');
  return {accepted,statuses:rows.map(v=>({protocolId:v.protocolId,status:v.status,counters:v.counters})),last,delivery,denied,originalBudgetNotReset:true};
 });
 await test('G-current-dynamic-incumbent-and-honest-UNKNOWN-fallback',async()=>{
  const before=await read(main.accepted.protocolId),request={...main.request,idempotencyKey:randomUUID(),parentProtocolId:main.accepted.protocolId},
   accepted=ok(await api('interaction-submit',request),202),row=await read(accepted.protocolId),
   compared=ok(await api('interaction-compare',{protocolId:accepted.protocolId}));
  assert.equal(row.fallbackId,main.accepted.protocolId);assert.equal(compared.fallbackKind,'CURRENT_CHECKED_DYNAMIC_INCUMBENT');
  ok(await api('interaction-cancel',{protocolId:accepted.protocolId}));await tick();
  const after=await read(accepted.protocolId);assert.equal(after.status,'CANCELLED');assert.equal(after.counters.episodeId,before.counters.episodeId);
  assert.equal(after.counters.attempts,before.counters.attempts);
  assert.equal(after.counters.deadlineAt,before.counters.deadlineAt);
  return {before:before.counters,accepted,compared,after:after.counters,cancelledDidNotResetOriginalAllocation:true};
 });
 async function catchChecker(fn:(pid:number)=>Promise<void>){
  let found:number|null=null,stopped=false;
  const scanning=(async()=>{
   const end=Date.now()+30000;
   while(!stopped&&!found&&Date.now()<end){
    const worker=h!.worker();
    if(worker?.pid){
     const children=await readFile(`/proc/${worker.pid}/task/${worker.pid}/children`,'utf8').catch(()=> '');
     for(const text of children.trim().split(/\s+/).filter(Boolean)){
      const pid=Number(text),command=await readFile(`/proc/${pid}/cmdline`,'utf8').catch(()=> '');
      if(command.split('\0').some(v=>v.endsWith('/interaction-synthesis/checker.py'))){
       try{process.kill(pid,'SIGSTOP');found=pid;}catch{continue;}
       await fn(pid);break;
      }
     }
    }
    if(!found)await new Promise(yes=>setTimeout(yes,1));
   }
  })();
  return {done:scanning,finish:()=>{stopped=true;},pid:()=>found};
 }
 await test('G-physical-checker-death-checkpoint-and-original-resume',async()=>{
  const f=await fixture('checker_death'),accepted=ok(await api('interaction-submit',f.request),202),
   before=await read(accepted.protocolId);
  const watch=await catchChecker(async pid=>{process.kill(pid,'SIGKILL');});
  try{await tick();await watch.done;}finally{watch.finish();}
  assert(watch.pid(),'Real checker process was not observed');
  const unknown=await read(accepted.protocolId);assert.equal(unknown.status,'UNKNOWN');assert.equal(unknown.artifact,null);
  assert.equal(unknown.resumable,true);assert(unknown.events.some((v:any)=>v.kind==='CANDIDATE_CHECKPOINT'));
  const candidate=(await e.admin.query('SELECT candidate FROM finnor_os.y3_requests WHERE tenant_id=$1 AND id=$2',
   [tenant,accepted.protocolId])).rows[0].candidate;
  const resumed=ok(await api('interaction-resume',{protocolId:accepted.protocolId}),202);await tick();
  const after=await read(accepted.protocolId);assert.equal(after.status,'CHECKED',JSON.stringify(after));
  assert.equal(after.counters.episodeId,before.counters.episodeId);assert.equal(after.counters.deadlineAt,before.counters.deadlineAt);
  assert.equal(after.counters.attempts,2);assert.equal(after.counters.searchStepsOccupied,unknown.counters.searchStepsOccupied);
  assert.equal(digest(after.artifact.body),digest(candidate));
  return {pid:watch.pid(),unknown,resumed,after,realSignal:'SIGKILL',checkpointReusedWithoutFreshSearch:true};
 });
 await test('G-physical-worker-death-stale-claim-native-redelivery',async()=>{
  const f=await fixture('worker_death'),accepted=ok(await api('interaction-submit',f.request),202),before=await read(accepted.protocolId);
  let checkpoint:any;
  const watch=await catchChecker(async pid=>{
   checkpoint=(await e.admin.query('SELECT candidate FROM finnor_os.y3_requests WHERE tenant_id=$1 AND id=$2',[tenant,accepted.protocolId])).rows[0].candidate;
   assert(checkpoint);await h!.stopWorker(true);process.kill(pid,'SIGKILL');
  });
  try{await tick().catch(()=>undefined);await watch.done;}finally{watch.finish();}
  assert(watch.pid(),'Real checker/worker checkpoint boundary was not observed');
  const old=(await e.admin.query('SELECT id,claim_fence,status FROM finnor_os.jobs WHERE id=$1',[accepted.jobId])).rows[0];
  assert.equal(old.status,'running');
  await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1",[accepted.jobId]);
  await e.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE resource_key='native:y3-construction' AND released_at IS NULL");
  await tick();
  let after=await read(accepted.protocolId);
  if(after.status!=='CHECKED'){
   const queued=(await e.admin.query('SELECT run_at FROM finnor_os.jobs WHERE id=$1',[accepted.jobId])).rows[0],
    backoff=new Date(queued.run_at).getTime()-Date.now();
   assert(backoff<=65000);if(backoff>0)await new Promise(yes=>setTimeout(yes,backoff+25));
   await tick();after=await read(accepted.protocolId);
  }
  assert.equal(after.status,'CHECKED',JSON.stringify(after));assert.equal(digest(after.artifact.body),digest(checkpoint));
  assert.equal(after.counters.episodeId,before.counters.episodeId);assert.equal(after.counters.deadlineAt,before.counters.deadlineAt);
  assert.equal(after.counters.attempts,2);
  const deliveries=(await e.admin.query('SELECT claim_fence,outcome FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY claim_fence',[accepted.jobId])).rows;
  assert.deepEqual(deliveries.map(v=>v.outcome),['lease_lost','completed']);
  assert.equal(after.events.filter((v:any)=>v.kind==='NATIVE_ATTEMPT_REGISTERED').length,2);
  assert.equal(after.events.filter((v:any)=>v.kind==='NATIVE_COST').length,1,'Killed attempt cost tail remains UNKNOWN, not zero');
  return {before:before.counters,after,deliveries,killedCostTail:'UNKNOWN',originalCandidateRetained:true};
 });
 await test('G-owner-commit-death-cancellation-and-original-S7-reconciliation',async()=>{
  const f=await compile(await fixture('owner_death')),p=await h!.prepare(f,'owner_death'),lowered=await h!.materialize(p),lock=71423003;
  await e.admin.query('SELECT pg_advisory_lock($1)',[lock]);
  await e.admin.query(`CREATE FUNCTION finnor_os.y3_test_observation_gate() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF session_user='finnor_worker' AND NEW.kind='MEASUREMENT'
    AND NEW.body->'payload'->>'schema'='finnor.s7.economic-right-observation.v1'
   THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`);
  await e.admin.query('CREATE TRIGGER y3_test_observation_gate BEFORE INSERT ON finnor_os.s7_economic_records FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_test_observation_gate()');
  const queued=ok(await api('interaction-run',{runId:p.run.runId}),202),interrupted=tick().catch(error=>({interrupted:String(error)}));
  await until(async()=>(await e.admin.query(`SELECT e.status FROM finnor_os.business_effects e JOIN finnor_os.s6_economic_obligation_origins o
   ON o.tenant_id=e.tenant_id AND o.effect_id=e.id WHERE o.tenant_id=$1 AND o.programme_id=$2`,[tenant,lowered.programmeId])).rows[0]?.status==='executed',
   'Y3_REAL_OWNER_COMMIT_NOT_OBSERVED');
  await h!.stopWorker(true);await interrupted;await e.admin.query('SELECT pg_advisory_unlock($1)',[lock]);
  await e.admin.query('DROP TRIGGER y3_test_observation_gate ON finnor_os.s7_economic_records');
  await e.admin.query('DROP FUNCTION finnor_os.y3_test_observation_gate()');
  const before=ok(await api('economic-programme-read',{programmeId:lowered.programmeId}));assert.equal(before.status,'UNKNOWN');
  ok(await api('interaction-cancel',{protocolId:f.accepted.protocolId}));
  assert.equal((await api('interaction-run',{runId:p.run.runId})).status,422);
  await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1",[queued.jobId]);
  await e.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE resource_key='native:y1-owner' AND released_at IS NULL");
  ok(await api('interaction-reconcile',{runId:p.run.runId}),202);await tick();
  const after=ok(await api('economic-programme-read',{programmeId:lowered.programmeId}));assert.equal(after.status,'OBSERVED');
  assert.equal(after.obligations.length,1);
  assert.equal(digest(after.obligations[0].body),digest(before.obligations[0].body));
  const old=(await e.admin.query('SELECT run_at,status FROM finnor_os.jobs WHERE id=$1',[queued.jobId])).rows[0];
  if(old.status==='queued'){
   const delay=new Date(old.run_at).getTime()-Date.now();assert(delay<=65000);
   if(delay>0)await new Promise(yes=>setTimeout(yes,delay+25));await tick();
  }
  assert.equal((await e.admin.query('SELECT effect_id FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1 AND programme_id=$2',
   [tenant,lowered.programmeId])).rowCount,1);
  return {queued,before,after,cancellationDidNotEraseResponsibility:true,duplicateEffect:false};
 });
 await test('E-source-model-replacement-selective-closure-and-Work-steering',async()=>{
  const f=await compile(await fixture('source_change')),before=await read(f.accepted.protocolId),
   source=f.modelSource,snapshot=(await e.admin.query('SELECT snapshot FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[tenant,source.versionId])).rows[0].snapshot;
  snapshot.interactionClaims[0].validUntil=new Date(Date.now()+3500000).toISOString();
  await appendEvidenceVersion(tenant,source.sourceId,{content:'Revised original supplied model qualification',snapshot,asOf:new Date()});
  const after=await read(f.accepted.protocolId);assert.equal(after.status,'INVALIDATED');assert.equal(digest(after.artifact),digest(before.artifact));
  const invalidation=after.events.find((v:any)=>v.kind==='P7_INVALIDATION');assert(invalidation);
  assert(invalidation.body.keptNodes.some((v:any)=>v.id==='work'));assert(invalidation.body.affectedNodes.some((v:any)=>v.id==='admission'));
  assert.equal((await api('interaction-admit',{protocolId:f.accepted.protocolId})).status,422);
  const steering=await receiveWork({tenantId:tenant,userId:principal,workId:main.request.workId,channel:'console',
   instruction:'Later authenticated Y3 Work steering',idempotencyKey:randomUUID()}),
   mainAfter=await read(main.accepted.protocolId);
  assert.equal(mainAfter.status,'INVALIDATED');assert.equal(digest(mainAfter.artifact),digest(main.view.artifact));
  return {before:before.counters,after,invalidation,steering,mainAfter:mainAfter.counters,oldPreimagesRetained:true};
 });
 await test('E-checker-runtime-substitution-fences-unpublished-request',async()=>{
  const f=await fixture('runtime_change'),accepted=ok(await api('interaction-submit',f.request),202),
   path=join(process.env.FINNOR_Y3_ASSET_ROOT!,'checker.py'),original=await readFile(path);
  try{
   await writeFile(path,Buffer.concat([original,Buffer.from('\n# Disposable runtime-identity mutation, never a checker result.\n')]));
   await tick();
   const row=await read(accepted.protocolId);assert.equal(row.status,'INVALIDATED');assert.equal(row.artifact,null);
   assert(row.currentnessReasons.includes('runtime'));return {row,changedAsset:'checker.py',forgedCheckAccepted:false};
  }finally{await writeFile(path,original);}
 });
 await test('E-database-immutability-budget-and-physical-lease-release',async()=>{
  const denied:any[]=[];
  for(const [name,sql,args] of [
   ['artifact',"UPDATE finnor_os.y3_requests SET artifact='{}'::jsonb WHERE tenant_id=$1 AND id=$2",[tenant,main.accepted.protocolId]],
   ['candidate',"UPDATE finnor_os.y3_requests SET candidate='{}'::jsonb WHERE tenant_id=$1 AND id=$2",[tenant,main.accepted.protocolId]],
   ['episode-reset','UPDATE finnor_os.y3_episodes SET attempts_used=0 WHERE tenant_id=$1 AND id=$2',[tenant,main.view.counters.episodeId]],
   ['deadline-reset',"UPDATE finnor_os.y3_episodes SET deadline_at=deadline_at+interval '1 hour' WHERE tenant_id=$1 AND id=$2",[tenant,main.view.counters.episodeId]],
   ['storage-bound','UPDATE finnor_os.y3_episodes SET retained_bytes=$3 WHERE tenant_id=$1 AND id=$2',[tenant,main.view.counters.episodeId,LIMITS.maxRetainedEpisodeBytes+1]],
   ['terms',"UPDATE finnor_os.s4_interaction_terms SET body='{}'::jsonb WHERE tenant_id=$1",[tenant]],
   ['consent-delete','DELETE FROM finnor_os.s4_interaction_consents WHERE tenant_id=$1',[tenant]],
  ] as Array<[string,string,unknown[]]>){
   let code:string|undefined;try{await e.admin.query(sql,args);}catch(error){code=(error as {code?:string}).code;}
   assert(code&&['P0001','23514','42501'].includes(code),name+':'+code);denied.push({name,sqlState:code});
  }
  const active=(await e.admin.query("SELECT resource_key,owner_id FROM finnor_os.compute_resource_leases WHERE resource_key IN('native:y3-construction','native:y1-owner') AND released_at IS NULL AND expires_at>clock_timestamp()")).rows;
  assert.equal(active.length,0);return {denied,activeNativeLeases:active,episodeBudgetWasNotReset:true};
 });
 await test('E-current-participant-revocation-and-production-refusal',async()=>{
  const f=await compile(await fixture('rights_change')),p=await h!.prepare(f,'rights_change'),lowered=await h!.materialize(p),
   before=await read(f.accepted.protocolId);
  await e.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenant,peer]);
  const suspendedLocal=await api('interaction-local',{protocolId:f.accepted.protocolId},peer);
  assert.equal(suspendedLocal.status,403);
  const denied=await api('economic-programme-run',{programmeId:lowered.programmeId});
  // Canonical suspension bumps tenant authority and invalidates Y1 before the
  // downstream Y3 guard. Do not bypass that earlier owner to force a Y3 code.
  assert.equal(denied.status,422);assert.equal(denied.body.code,'Y1_CURRENT_CHECKED_THEORY_REQUIRED');
  assert.equal((await e.admin.query('SELECT status FROM finnor_os.y1_requests WHERE tenant_id=$1 AND id=$2',
   [tenant,f.theory.accepted.theoryId])).rows[0].status,'INVALIDATED');
  assert.equal((await e.admin.query('SELECT effect_id FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1 AND programme_id=$2',
   [tenant,lowered.programmeId])).rowCount,0);
  const suspendedWithdrawal=await api('interaction-consent',{protocolId:f.accepted.protocolId,termsRef:p.terms.ref,
   scope:'EFFECT',subjectDigest:p.run.intent.ref.contentDigest,decision:'WITHDRAW',idempotencyKey:randomUUID()},peer);
  assert.equal(suspendedWithdrawal.status,403);
  // An active authenticated participant can still withdraw the exact old
  // consent after operational rights invalidate. Suspension grants no access.
  const withdrawn=await h!.consent(f,p.terms,principal,'EFFECT',p.run.intent.ref.contentDigest,'WITHDRAW');
  assert.equal(withdrawn.consent.decision,'WITHDRAW');assert.equal(withdrawn.consent.principalId,principal);
  await e.admin.query('UPDATE finnor_os.authority_states SET revision=revision+1 WHERE tenant_id=$1',[tenant]);
  const after=await read(f.accepted.protocolId);assert.equal(after.status,'INVALIDATED');assert.equal(digest(after.artifact),digest(before.artifact));
  if(built){
   await h!.stopWorker();await e.http!.restartApi({runtime:'production',unsetDevBypass:true});
   const production=await api('interaction-list',{root:h!.root,workId:f.request.workId});
   assert([403,503].includes(production.status));return {suspendedLocal,suspendedWithdrawal,denied,withdrawn,after,production,productionActivated:false};
  }
  return {suspendedLocal,suspendedWithdrawal,denied,withdrawn,after,production:'NOT_RUN_SOURCE_TRANSPORT_ONLY',productionActivated:false};
 });
 passed=true;
}catch(error){
 await artifact(evidence,'failure.json',{error:String(error),stack:(error as Error).stack});throw error;
}finally{
 try{await h?.close();}finally{
  const report={schema:'finnor.y3.installed-owner-campaign.v1',
   status:passed?(built?'PASS_INSTALLED_Y3_DEVELOPMENT':'PASS_SOURCE_TRANSPORT_ONLY'):'FAIL',
   actualBuiltApi:built,emittedNativeWorker:true,wallMs:performance.now()-started,cases:results,
   protectedQualification:false,productionActivated:false,sourceParity:'UNKNOWN',financialEfficacyEstablished:false};
  await artifact(evidence,'report.json',report);console.log(report.status,results.length,evidence);
 }
}
