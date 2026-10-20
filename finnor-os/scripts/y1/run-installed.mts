/** Preregistered end-to-end driver. Native inputs, actual bearer HTTP, restricted
 * roles, emitted createWorker and separate checker. Never supplies success rows. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdir,readFile,readdir,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {configureTenantVertical,receiveWork,closePool} from '@finnor/db';
import {appendEvidenceVersion,createEvidenceSource} from '@finnor/memory';
import {startEnvironment,artifact,repo,hash,recordPriorReleaseProbeRefusal} from '../x3/environment.mts';
import {publicProblem,bindCanonicalInputs,resourceInput} from './business-fixtures.mts';
import {independentlyCheck,runtimeIdentity} from '../../packages/private-equity/src/economic-action-theory/process';
import {digest,PROFILE,type EconomicProblem} from '../../packages/private-equity/src/economic-action-theory/contracts';
import {transaction} from '../../packages/private-equity/src/economic-action-theory/store';
const evidence=resolve(process.env.FINNOR_Y1_EVIDENCE_DIR??join(repo,'scope-postx/y1-economic-action-theory/evidence/installed-'+Date.now()));
await mkdir(evidence,{recursive:true});process.env.FINNOR_Y1_PROFILE='ordinary_disposable';
const built=process.env.FINNOR_Y1_BUILT_API==='1',started=performance.now(),results:any[]=[];
const runtime=JSON.parse(await readFile(join(repo,'finnor-os/dist-y1/manifest.json'),'utf8'));
assert.equal(hash(await readFile(join(repo,'finnor-os/dist-y1/worker-loop.mjs'))),runtime.worker.sha256);
process.env.FINNOR_Y1_ASSET_ROOT=join(repo,'finnor-os/dist-y1',runtime.assetRoot);
const e=await startEnvironment(evidence,{builtApi:built,baseHead:'0194_x_phase_charge_phase_union.sql'});
let worker:ChildProcess|null=null,workerLogs='',sequence=0;
const waits=new Map<number,{yes:(v:any)=>void;no:(e:Error)=>void}>();
async function stopWorker(){
 const old=worker;if(!old)return;
 if(old.exitCode===null&&old.signalCode===null){const ended=new Promise<void>(yes=>old.once('close',()=>yes()));old.kill('SIGKILL');await ended;}
 worker=null;
 assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(workerLogs),'CREDENTIAL_FREE_WORKER_EVIDENCE');
 await artifact(evidence,'workers/stopped-'+sequence+'.json',{pid:old.pid,code:old.exitCode,signal:old.signalCode,logs:workerLogs});
 workerLogs='';
}
function launch(python?:string){
 assert(!worker);worker=spawn(process.execPath,[join(repo,'finnor-os/dist-y1/worker-loop.mjs')],{
  cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl,...(python?{FINNOR_Y1_PYTHON:python}:{})},
  stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [worker.stdout!,worker.stderr!])stream.on('data',b=>{workerLogs+=b;if(workerLogs.length>1048576)worker!.kill('SIGKILL');});
 worker.on('message',(out:any)=>{const waiting=waits.get(out.id);if(waiting){waits.delete(out.id);out.error?waiting.no(Error(out.error)):waiting.yes(out);}});
 worker.once('error',err=>{for(const w of waits.values())w.no(err);waits.clear();});
 worker.once('close',(code,signal)=>{for(const w of waits.values())w.no(Error('Y1_TASK_WORKER_EXIT:'+code+':'+signal));waits.clear();});
}
async function tick(retryEmpty=true){
 if(!worker)launch();const id=++sequence;
 const out=await new Promise<any>((yes,no)=>{
  const timer=setTimeout(()=>{waits.delete(id);worker?.kill('SIGKILL');no(Error('Y1_ORIGINAL_TICK_DEADLINE'));},180000);
  waits.set(id,{yes:v=>{clearTimeout(timer);yes(v);},no:err=>{clearTimeout(timer);no(err);}});worker!.send({id,operation:'TICK'});
 });
 assert.equal(out.productionWorkerFactory,true);await artifact(evidence,'workers/tick-'+id+'.json',out);
 // The real queue caches an empty probe for two seconds. Honor that poll
 // interval rather than mistaking its idle backoff for delivery failure.
 if(!out.claimed&&retryEmpty){await new Promise(yes=>setTimeout(yes,2100));return tick(false);}
 return out;
}
async function until(predicate:()=>Promise<boolean>,name:string,timeout=30000){
 const end=Date.now()+timeout;
 while(!await predicate()){assert(Date.now()<end,name);await new Promise(yes=>setTimeout(yes,30));}
}
async function test(name:string,fn:()=>Promise<unknown>){
 const start=performance.now();
 try{const observed=await fn();results.push({name,status:'PASS',wallMs:performance.now()-start,observed});await artifact(evidence,'cases/'+name+'.json',results.at(-1));}
 catch(error){results.push({name,status:'FAIL',wallMs:performance.now()-start,error:String(error),stack:(error as Error).stack});
  await artifact(evidence,'cases/'+name+'.json',results.at(-1));throw error;}
}
const tenant=randomUUID(),principal=randomUUID(),peer=randomUUID(),root={entityType:'external_organization',entityId:randomUUID()},
 horizon={startAt:new Date(Date.now()-3600000).toISOString(),periodMs:7200000,periods:1},
 period={startAt:horizon.startAt,endAt:new Date(Date.parse(horizon.startAt)+horizon.periodMs).toISOString()};
let token='',peerToken='',main:any,mainView:any,held:any,programme:any,resource:any;
const api=(operation:string,input:unknown,who=token)=>e.http!.api(who,'company-brain',operation,input);
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const read=(id:string)=>api('economic-theory-read',{theoryId:id}).then(r=>ok(r));
async function fixture(label:string,change?:(problem:EconomicProblem)=>void){
 const p=publicProblem(root,period,label);change?.(p);
 return bindCanonicalInputs(e.admin,tenant,principal,root,p,label);
}
async function compile(f:any){
 const accepted=ok(await api('economic-theory-submit',f.request),202);
 for(let i=0;i<5;i++){await tick();const view=await read(accepted.theoryId);if(!['QUEUED','CONSTRUCTING','CHECKING'].includes(view.status))return {...f,accepted,view};}
 throw Error('Y1_DURABLE_CONSTRUCTION_DID_NOT_FINISH');
}
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y1 disposable public firm')",[tenant,randomUUID()]);
 for(const id of [principal,peer]){
  const email=id+'@y1.example.test';await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[id,tenant,email]);
  e.http!.register(id,email);
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'y1-public','Y1 public finite context','other')",[root.entityId,tenant]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'Y1:disposable'});
 token=await e.http!.login(principal);peerToken=await e.http!.login(peer);
 await test('C-authentication-and-contracts',async()=>{
  const missing=await fetch(e.http!.apiBase+'/api/company-brain/economic-theory-list',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert([401,404].includes(missing.status));
  assert.equal((await api('economic-theory-submit',{mode:'production'})).status,400);
  const roles=(await e.admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker')")).rows;
  assert(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));return {unauthenticated:missing.status,roles,authBypass:false};
 });
 await test('A-durable-construction-and-laws',async()=>{
  main=await compile(await fixture('public'));mainView=main.view;
  assert.equal(mainView.status,'CHECKED',JSON.stringify(mainView));assert.equal(mainView.artifact.envelope.independentChecks[0].status,'CHECKED');
  assert(mainView.artifact.body.laws.some((law:any)=>law.left.length===1&&law.right.length===2));
  assert(mainView.artifact.body.laws.every((law:any)=>law.enabledWitnesses>0));
  // A tick claims one job. Let the unchanged prior background job reach its
  // real handler after the higher-priority construction delivery.
  await tick();
  await recordPriorReleaseProbeRefusal(evidence,e.admin);
  const native=(await e.admin.query("SELECT j.type,j.protocol_version,j.status,d.id,d.claim_fence,d.outcome FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.tenant_id=$1 AND j.payload->>'theoryId'=$2",[tenant,main.accepted.theoryId])).rows;
  assert(native.length&&native.every(n=>n.claim_fence>0));return {artifact:mainView.artifact,native,protectedNovelty:false};
 });
 await test('C-principal-and-work-isolation',async()=>{
  assert.equal((await api('economic-theory-read',{theoryId:main.accepted.theoryId},peerToken)).status,404);
  const foreign=randomUUID();assert.equal((await api('economic-theory-list',{root,workId:foreign})).status,404);
  const foreignTenant=randomUUID(),foreignActor=randomUUID(),email=foreignActor+'@y1.example.test';
  await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y1 unrelated firm')",[foreignTenant,randomUUID()]);
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[foreignActor,foreignTenant,email]);
  await configureTenantVertical({tenantId:foreignTenant,verticalKey:'private_equity',expectedVersion:0,createdBy:foreignActor,sourceSystem:'Y1:foreign'});
  e.http!.register(foreignActor,email);const other=await e.http!.login(foreignActor);
  assert.equal((await api('economic-theory-read',{theoryId:main.accepted.theoryId},other)).status,404);
  return {peer:404,foreignTenant:404,absentWork:404};
 });
 await test('B-request-replay-and-canonical-observation-binding',async()=>{
  const replay=ok(await api('economic-theory-submit',main.request),202);assert(replay.replayed);assert.equal(replay.theoryId,main.accepted.theoryId);
  const changed=structuredClone(main.request);changed.problem.goal.title+=' changed';
  assert.equal((await api('economic-theory-submit',changed)).status,409);
  const forged=structuredClone(main.request);forged.idempotencyKey=randomUUID();forged.problem.operators[0].examples[0].after={available:'1',committed:'0'};
  const denial=await api('economic-theory-submit',forged);assert.equal(denial.status,422);assert.equal(denial.body.code,'Y1_CANONICAL_OPERATOR_OBSERVATIONS_REQUIRED');
  assert.equal((await api('economic-theory-submit',{...main.request,candidate:mainView.artifact.body})).status,400);
  return {replay,canonicalObservationMutation:denial,callerSuppliedBody:400};
 });
 await test('B-independent-body-law-and-certificate-mutations',async()=>{
  const original=mainView.artifact.body,identity=await runtimeIdentity(),mutations:any[]=[];
  for(const [name,mutate] of [
   ['body',(b:any)=>{b.operators[0].rows[0].terms[0].coefficient*=-1;}],
   ['guard',(b:any)=>{b.operators[0].guard.invariantDigest='0'.repeat(64);}],
   ['requirements',(b:any)=>{b.operators[0].requirements=[];}],
   ['law-definedness',(b:any)=>{b.laws[0].left=[];b.laws[0].right=[b.operators[0].id];}],
   ['law-certificate',(b:any)=>{b.laws[0].enabledWitnesses++;}],
   ['profile',(b:any)=>{b.profileDigest='0'.repeat(64);}],
  ] as Array<[string,(b:any)=>void]>){
   const body=structuredClone(original);mutate(body);
   const check=await independentlyCheck(main.request.problem,body,Date.now()+120000,identity);
   assert.equal(check.status,'REJECTED',name+':'+JSON.stringify(check));mutations.push({name,check});
  }
  return {boundary:'ORIGINAL_DURABLE_ARTIFACT_TO_SEPARATE_EXACT_ORACLE',mutations};
 });
 await test('B-exact-dimensional-source-and-meaning-boundaries',async()=>{
  const mutations:any[]=[];
  for(const [name,change] of [
   ['currency',(p:any)=>{p.quantities[0].currency='EUR';}],
   ['accounting-basis',(p:any)=>{p.quantities[0].accountingBasis='UNDECLARED_BASIS';}],
   ['time',(p:any)=>{p.quantities[0].period.endAt=new Date(Date.parse(p.quantities[0].period.endAt)+1000).toISOString();}],
   ['source-version',(p:any)=>{p.meanings[0].versionId=randomUUID();}],
   ['consent-scope',(p:any)=>{p.meanings.find((m:any)=>m.kind==='CONSENT').subjectId=randomUUID();}],
  ] as Array<[string,(p:any)=>void]>){
   const input=structuredClone(main.request);input.idempotencyKey=randomUUID();change(input.problem);
   const reply=await api('economic-theory-submit',input);assert.equal(reply.status,422,name+':'+JSON.stringify(reply));mutations.push({name,reply});
  }
  const noncanonical=structuredClone(main.request);noncanonical.idempotencyKey=randomUUID();noncanonical.problem.quantities[0].values[0]='0.0';
  assert.equal((await api('economic-theory-submit',noncanonical)).status,400);
  return {mutations,noncanonicalDecimal:400,noImplicitFx:true};
 });
 await test('E-typed-admission-and-canonical-reservation',async()=>{
  const blocked=await api('economic-reservation-create',{theoryId:main.accepted.theoryId,initialState:{available:'3',committed:'2'},bindings:[],idempotencyKey:randomUUID()});
  assert([400,422].includes(blocked.status));
  const admission=ok(await api('economic-theory-admit',{theoryId:main.accepted.theoryId}));assert.equal(admission.domain,'ECONOMIC_ACTION_THEORY');assert.equal(admission.protectedAdmission,false);
  const native=resourceInput(tenant,principal,root,horizon,'shared');
  resource=ok(await e.http!.api(token,'allocations','resource',{resource:native}));
  const input={theoryId:main.accepted.theoryId,initialState:{available:'3',committed:'2'},
   bindings:main.request.problem.quantities.map((q:any)=>({quantityId:q.id,resourceRef:resource.ref})),idempotencyKey:randomUUID()};
  held=ok(await api('economic-reservation-create',input));const replay=ok(await api('economic-reservation-create',input));
  assert.deepEqual(replay.origin.ref,held.origin.ref);assert.equal(held.origin.envelopes[0].quantities[0],'5');
  return {admission,reservation:held,replaySameOrigin:true};
 });
 await test('E-shared-capacity-contention',async()=>{
  const requests=Array.from({length:2},()=>api('economic-reservation-create',{theoryId:main.accepted.theoryId,
   initialState:{available:'3',committed:'2'},bindings:main.request.problem.quantities.map((q:any)=>({quantityId:q.id,resourceRef:resource.ref})),idempotencyKey:randomUUID()}));
  const replies=await Promise.all(requests);assert(replies.every(r=>r.status===409),JSON.stringify(replies));
  const count=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1',[tenant])).rows[0].n;assert.equal(count,1);
  return {replies,reservations:count};
 });
 await test('E-native-programme-effect-and-observation',async()=>{
  programme=ok(await api('economic-programme-create',{theoryId:main.accepted.theoryId,reservationRef:held.origin.ref,expectedRevision:held.revision,
   goalState:{available:'1',committed:'4'},parameters:{amount:'2'},idempotencyKey:randomUUID()}));
  assert.equal(programme.steps.length,1);assert(programme.planRevisionId);
  const job=ok(await api('economic-programme-run',{programmeId:programme.id}),202);await tick();
  const projection=ok(await api('economic-programme-read',{programmeId:programme.id}));assert.equal(projection.status,'OBSERVED',JSON.stringify(projection));
  assert.equal(projection.observedGoalDigest,digest(programme.goalState));assert.equal(projection.obligations.length,1);
  assert(projection.obligations[0].verification.canonicalObservationRef);
  const effects=(await e.admin.query('SELECT id,status,operation_class,effect,observed_result FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows;
  assert.equal(effects.length,1);assert.equal(effects[0].operation_class,'internal_write');assert.equal(effects[0].status,'verified');
  const links=(await e.admin.query(`SELECT a.id,a.status,a.payload,a.plan_node_id,a.plan_revision_id,n.value node
   FROM finnor_os.domain_actions a JOIN finnor_os.work_plan_revisions p ON p.tenant_id=a.tenant_id AND p.id=a.plan_revision_id
   CROSS JOIN LATERAL jsonb_array_elements(p.plan_graph->'nodes') n(value)
   WHERE a.tenant_id=$1 AND p.id=$2 AND n.value->>'id'=a.plan_node_id`,[tenant,programme.planRevisionId])).rows;
  assert.equal(links.length,programme.steps.length);assert(links.every(v=>v.node.kind==='action'&&v.node.actionType==='execute_economic_right_transition'));
  assert(links.every(v=>digest(v.payload)===digest(v.node.groundedPayload??v.node.payload)));
  return {programme,job,projection,effects,exactNativeActionPlanLinks:links};
 });
 await test('E-canonical-query-preserves-original-Work',async()=>{
  const cut=async()=>(await e.admin.query(`SELECT w.status,(SELECT count(*)::int FROM finnor_os.work_inputs i
   WHERE i.tenant_id=w.tenant_id AND i.work_id=w.id) inputs FROM finnor_os.works w WHERE w.tenant_id=$1 AND w.id=$2`,
   [tenant,main.work.workId])).rows[0];
  const before=await cut(),body={intent:'economic_programme_v1',programmeId:programme.id,workId:main.work.workId,executionKey:randomUUID()};
  const send=async(input:unknown,who=token)=>{
   const response=await fetch(e.http!.apiBase+'/api/queries',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+who},body:JSON.stringify(input)});
   return {status:response.status,body:await response.json()};
  };
  const observed=ok(await send(body),201);
  assert.equal(observed.result.data.status,'OBSERVED');assert.equal(observed.result.data.observedGoalDigest,digest(programme.goalState));
  assert.equal(observed.workInputId,programme.workInputId);assert.deepEqual(await cut(),before);
  assert.equal((await send({...body,workId:undefined})).status,400);
  assert.equal((await send({...body,workId:randomUUID()})).status,404);
  assert.equal((await send(body,peerToken)).status,404);
  assert.equal((await read(main.accepted.theoryId)).current,true);
  return {before,after:await cut(),observed,canonicalReadDidNotSteerOrCompleteWork:true};
 });
 await test('E-substitution-reuse-and-stale-state',async()=>{
  const current=ok(await api('economic-reservation-read',{reservationRef:held.origin.ref}));
  assert.deepEqual(current.origin.envelopes,held.origin.envelopes);assert.deepEqual(current.economicState.state,{available:'1',committed:'4'});
  const stale=await api('economic-programme-create',{theoryId:main.accepted.theoryId,reservationRef:held.origin.ref,expectedRevision:held.revision,
   goalState:{available:'3',committed:'2'},parameters:{amount:'2'},idempotencyKey:randomUUID()});assert.equal(stale.status,409);
  const next=ok(await api('economic-programme-create',{theoryId:main.accepted.theoryId,reservationRef:held.origin.ref,expectedRevision:current.revision,
   goalState:{available:'3',committed:'2'},parameters:{amount:'2'},idempotencyKey:randomUUID()}));
  ok(await api('economic-programme-run',{programmeId:next.id}),202);await tick();
  assert.equal(ok(await api('economic-programme-read',{programmeId:next.id})).status,'OBSERVED');
  const count=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1',[tenant])).rows[0].n;assert.equal(count,1);
  ok(await api('economic-programme-run',{programmeId:next.id}),202);await tick();
  assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows[0].n,2);
  const superseded=await api('economic-programme-run',{programmeId:programme.id});
  assert.equal(superseded.status,422);assert.equal(superseded.body.code,'S4_ECONOMIC_SELECTED_PLAN_NOT_CURRENT');
  assert.equal(ok(await api('economic-programme-read',{programmeId:programme.id})).status,'OBSERVED');
  return {stale,superseded,count,reusedCanonicalReservation:true,noveltyEvidence:false};
 });
 await test('F-current-admitted-fallback-and-original-episode',async()=>{
  const child={...main.request,idempotencyKey:randomUUID(),parentTheoryId:main.accepted.theoryId};
  const candidate=await compile({...main,request:child});assert.equal(candidate.view.status,'CHECKED');assert.equal(candidate.view.fallbackId,main.accepted.theoryId);
  assert.equal(candidate.view.artifact.envelope.comparison.classification,'REUSED');
  assert.equal(candidate.view.counters.episodeId,mainView.counters.episodeId);assert.equal(candidate.view.counters.deadlineAt,mainView.counters.deadlineAt);
  assert.equal(candidate.view.counters.attempts,2);
  const comparison=ok(await api('economic-theory-compare',{theoryId:candidate.accepted.theoryId}));assert.equal(comparison.eligible,true);
  assert.equal(comparison.qualifiedEquippedBaseline,'UNESTABLISHED');return {comparison,counters:candidate.view.counters};
 });
 await test('A-logical-negative-dispositions',async()=>{
  const ambiguous=await compile(await fixture('ambiguous',p=>{p.operators=[{...p.operators[0]!,examples:[{before:{available:'1',committed:'1'},parameters:{amount:'1'},after:{available:'1',committed:'1'}}]}];}));
  assert.equal(ambiguous.view.status,'UNIDENTIFIED',JSON.stringify(ambiguous.view));
  const contradiction=await compile(await fixture('contradiction',p=>{p.operators[0]!.examples.push({...p.operators[0]!.examples.find(e=>e.after!==null)!,after:null});}));
  assert.equal(contradiction.view.status,'INFEASIBLE');assert.equal(contradiction.view.artifact.envelope.independentChecks[0].exhaustiveWithinFrozenHypothesis,true);
  const missingFixture=await fixture('missing');missingFixture.request.problem.meanings[1]={...missingFixture.request.problem.meanings[1]!,sourceId:null,versionId:null,contentDigest:null};
  const missing=await compile(missingFixture);assert.equal(missing.view.status,'UNIDENTIFIED');
  const unsupported=await compile(await fixture('unsupported',p=>{
   p.quantities=Array.from({length:6},(_,i)=>({...p.quantities[0]!,id:'q'+i,values:Array.from({length:16},(_,j)=>String(j))}));
  }));assert.equal(unsupported.view.status,'UNSUPPORTED');
  const incomplete=await compile(await fixture('incomplete',p=>{
   p.quantities=Array.from({length:6},(_,i)=>({...p.quantities[0]!,id:'q'+i,values:['0','1','2','3']}));
   p.invariants=[];p.operators=[{...p.operators[0]!,examples:[{before:Object.fromEntries(p.quantities.map(q=>[q.id,'1'])),parameters:{amount:'1'},after:Object.fromEntries(p.quantities.map(q=>[q.id,'1']))}]}];
  }));assert.equal(incomplete.view.status,'INCOMPLETE',JSON.stringify(incomplete.view));
  return Object.fromEntries([ambiguous,contradiction,missing,unsupported,incomplete].map(v=>[v.request.problem.goal.id,{status:v.view.status,reasons:v.view.artifact.construction.reasons}]));
 });
 await test('D-checkpoint-death-and-original-fenced-recovery',async()=>{
  const f=await fixture('checkpoint'),accepted=ok(await api('economic-theory-submit',f.request),202),lock=71422001;
  await e.admin.query('SELECT pg_advisory_lock($1)',[lock]);
  // Gate the next physical lease renewal, not SELECT on the candidate table.
  // An RLS SELECT predicate also runs inside the checkpoint UPDATE and would
  // prevent the very commit whose crash recovery this case must observe.
  await e.admin.query(`CREATE FUNCTION finnor_os.y1_test_checkpoint_gate() RETURNS trigger LANGUAGE plpgsql
   SECURITY DEFINER SET search_path=pg_catalog AS $$
   BEGIN IF session_user='finnor_worker' AND NEW.resource_key='native:y1-construction' AND EXISTS(
    SELECT 1 FROM finnor_os.y1_requests WHERE id='${accepted.theoryId}'::uuid AND candidate IS NOT NULL
   ) THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`);
  await e.admin.query('CREATE TRIGGER y1_test_checkpoint_gate BEFORE UPDATE ON finnor_os.compute_resource_leases FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_test_checkpoint_gate()');
  const interrupted=tick().then(v=>({completed:v}),error=>({interrupted:String(error)}));
  await until(async()=>!!(await e.admin.query('SELECT candidate FROM finnor_os.y1_requests WHERE tenant_id=$1 AND id=$2',[tenant,accepted.theoryId])).rows[0]?.candidate,'Y1_CHECKPOINT_NOT_COMMITTED');
  const before=(await e.admin.query('SELECT r.candidate,r.episode_id,e.deadline_at,e.attempts_used,e.search_steps_used FROM finnor_os.y1_requests r JOIN finnor_os.y1_episodes e ON e.tenant_id=r.tenant_id AND e.id=r.episode_id WHERE r.tenant_id=$1 AND r.id=$2',[tenant,accepted.theoryId])).rows[0];
  await stopWorker();await interrupted;await e.admin.query('SELECT pg_advisory_unlock($1)',[lock]);
  await e.admin.query('DROP TRIGGER y1_test_checkpoint_gate ON finnor_os.compute_resource_leases');await e.admin.query('DROP FUNCTION finnor_os.y1_test_checkpoint_gate()');
  await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND payload->>'theoryId'=$2 AND status='running'",[tenant,accepted.theoryId]);
  await e.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE resource_key='native:y1-construction' AND released_at IS NULL");
  await tick();const view=await read(accepted.theoryId);assert.equal(view.status,'CHECKED',JSON.stringify(view));
  assert.equal(digest(view.artifact.body),digest(before.candidate));assert.equal(view.counters.episodeId,before.episode_id);
  assert.equal(view.counters.attempts,2);assert.equal(view.counters.searchStepsOccupied,before.search_steps_used);
  assert.equal(view.counters.deadlineAt,before.deadline_at.toISOString());
  assert(view.events.some((v:any)=>v.kind==='NATIVE_ATTEMPT_REGISTERED'&&v.body.constructorCheckpointReused===true));
  return {before,after:view.counters,checkpointDigest:digest(before.candidate),sourceLoader:false};
 });
 await test('D-unknown-checker-process-is-not-infeasibility',async()=>{
  await stopWorker();launch('/nonexistent/y1-independent-python');
  const unknown=await compile(await fixture('unknown'));assert.equal(unknown.view.status,'UNKNOWN');assert.equal(unknown.view.artifact.envelope.independentChecks[0].status,'UNKNOWN');
  assert.equal((await api('economic-theory-admit',{theoryId:unknown.accepted.theoryId})).status,422);
  await stopWorker();return {status:unknown.view.status,counters:unknown.view.counters,retainedCheck:unknown.view.artifact.envelope.independentChecks[0]};
 });
 await test('D-native-intent-storage-and-original-counter-guards',async()=>{
  const ctx={auth:{tenantId:tenant,userId:principal,employeeId:principal,role:'owner' as const}},rejected:any[]=[];
  for(const [name,sql,values] of [
   ['artifact',`UPDATE finnor_os.y1_requests SET artifact='{"substituted":true}'::jsonb WHERE tenant_id=$1 AND id=$2`,[tenant,main.accepted.theoryId]],
   ['episode-reset','UPDATE finnor_os.y1_episodes SET attempts_used=attempts_used-1 WHERE tenant_id=$1 AND work_id=$2',[tenant,main.work.workId]],
   ['storage-bound','UPDATE finnor_os.y1_episodes SET retained_bytes=$3 WHERE tenant_id=$1 AND work_id=$2',[tenant,main.work.workId,PROFILE.maxRetainedBytes+1]],
   ['effect-body',`UPDATE finnor_os.business_effects SET effect=effect||'{"substituted":true}'::jsonb WHERE tenant_id=$1`,[tenant]],
   ['effect-regression',`UPDATE finnor_os.business_effects SET status='compiled' WHERE tenant_id=$1 AND status='verified'`,[tenant]],
   ['action-principal','UPDATE finnor_os.domain_actions SET initiated_by=$2 WHERE tenant_id=$1',[tenant,peer]],
   ['origin-deletion','DELETE FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1',[tenant]],
  ] as Array<[string,string,unknown[]]>){
   let code:string|undefined;
   try{await transaction(ctx,c=>c.query(sql,values));}catch(error){code=(error as {code?:string}).code;}
   assert(code&&['P0001','23514','42501'].includes(code),name+':'+code);rejected.push({name,sqlState:code});
  }
  assert.equal(digest((await read(main.accepted.theoryId)).artifact),digest(mainView.artifact));
  return {rejected,originalImmutablePreimageRetained:true};
 });
 await test('D-cancellation-generation-and-future-protocol-fences',async()=>{
  const f=await fixture('cancelled-before-claim'),accepted=ok(await api('economic-theory-submit',f.request),202);
  ok(await api('economic-theory-cancel',{theoryId:accepted.theoryId}));await tick();
  const cancelled=await read(accepted.theoryId);assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.artifact,null);assert.equal(cancelled.counters.attempts,0);
  const job=(await e.admin.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane)
   VALUES($1,'construct_economic_action_theory_v1',$2::jsonb,$3,2,4,'interactive') RETURNING id`,
   [tenant,JSON.stringify({tenantId:tenant,principalId:principal,theoryId:main.accepted.theoryId,generation:1}),randomUUID()])).rows[0];
  await tick();
  const retained=(await e.admin.query('SELECT status,attempts,claim_fence,protocol_version FROM finnor_os.jobs WHERE id=$1',[job.id])).rows[0];
  assert.deepEqual(retained,{status:'queued',attempts:0,claim_fence:'0',protocol_version:2});
  return {cancelled,unsupportedProtocolOriginalJob:retained,unsupportedDeliveryAttempts:0};
 });
 await test('D-owner-commit-death-cancel-and-original-effect-recovery',async()=>{
  const f=await compile(await fixture('owner-crash'));assert.equal(f.view.status,'CHECKED');
  ok(await api('economic-theory-admit',{theoryId:f.accepted.theoryId}));
  const owned=ok(await e.http!.api(token,'allocations','resource',{resource:resourceInput(tenant,principal,root,horizon,'owner-crash')}));
  const reservation=ok(await api('economic-reservation-create',{theoryId:f.accepted.theoryId,initialState:{available:'3',committed:'2'},
   bindings:f.request.problem.quantities.map((q:any)=>({quantityId:q.id,resourceRef:owned.ref})),idempotencyKey:randomUUID()}));
  const plan=ok(await api('economic-programme-create',{theoryId:f.accepted.theoryId,reservationRef:reservation.origin.ref,
   expectedRevision:reservation.revision,goalState:{available:'1',committed:'4'},parameters:{amount:'2'},idempotencyKey:randomUUID()}));
  const lock=71422002;await e.admin.query('SELECT pg_advisory_lock($1)',[lock]);
  await e.admin.query(`CREATE FUNCTION finnor_os.y1_test_observation_gate() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF session_user='finnor_worker' AND NEW.kind='MEASUREMENT'
    AND NEW.body->'payload'->>'schema'='finnor.s7.economic-right-observation.v1'
   THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`);
  await e.admin.query('CREATE TRIGGER y1_test_observation_gate BEFORE INSERT ON finnor_os.s7_economic_records FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_test_observation_gate()');
  const accepted=ok(await api('economic-programme-run',{programmeId:plan.id}),202),
   interrupted=tick().then(v=>({completed:v}),error=>({interrupted:String(error)}));
  await until(async()=>(await e.admin.query(`SELECT e.status FROM finnor_os.business_effects e JOIN finnor_os.s6_economic_obligation_origins o
   ON o.tenant_id=e.tenant_id AND o.effect_id=e.id WHERE o.tenant_id=$1 AND o.programme_id=$2`,[tenant,plan.id])).rows[0]?.status==='executed','Y1_OWNER_COMMIT_NOT_OBSERVED');
  await stopWorker();await interrupted;await e.admin.query('SELECT pg_advisory_unlock($1)',[lock]);
  await e.admin.query('DROP TRIGGER y1_test_observation_gate ON finnor_os.s7_economic_records');await e.admin.query('DROP FUNCTION finnor_os.y1_test_observation_gate()');
  const before=ok(await api('economic-programme-read',{programmeId:plan.id}));assert.equal(before.status,'UNKNOWN');assert.equal(before.observedGoalDigest,null);
  ok(await api('economic-theory-cancel',{theoryId:f.accepted.theoryId}));
  assert.equal((await api('economic-programme-run',{programmeId:plan.id})).status,422);
  assert.equal(ok(await api('economic-programme-read',{programmeId:plan.id})).status,'UNKNOWN');
  await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1",[accepted.jobId]);
  await e.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE resource_key='native:y1-owner' AND released_at IS NULL");
  ok(await api('economic-programme-reconcile',{programmeId:plan.id}),202);await tick();
  const after=ok(await api('economic-programme-read',{programmeId:plan.id}));assert.equal(after.status,'OBSERVED');assert.equal(after.obligations.length,1);
  const original=(await e.admin.query('SELECT status,run_at,claim_fence FROM finnor_os.jobs WHERE id=$1',[accepted.jobId])).rows[0];
  assert.equal(original.status,'queued');
  const backoff=new Date(original.run_at).getTime()-Date.now();assert(backoff<=65000);
  if(backoff>0)await new Promise(yes=>setTimeout(yes,backoff+25));
  await tick();
  const deliveries=(await e.admin.query('SELECT claim_fence,outcome FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY claim_fence',[accepted.jobId])).rows;
  assert.equal(deliveries.length,2);assert.deepEqual(deliveries.map(v=>v.outcome),['lease_lost','completed']);
  assert.equal(ok(await api('economic-programme-read',{programmeId:plan.id})).obligations.length,1);
  assert.deepEqual(ok(await api('economic-reservation-read',{reservationRef:reservation.origin.ref})).origin.envelopes,reservation.origin.envelopes);
  return {before,after,deliveries,originalBackoffPreserved:true,noDuplicateEffect:true,cancellationDidNotEraseUnknownResponsibility:true};
 });
 await test('F-selective-closure-and-unaffected-semantic-preimages',async()=>{
  const p=publicProblem(root,period,'selective');p.meanings.push({key:'auxiliary',kind:'INTERPRETATION',subjectId:root.entityId,sourceId:null,versionId:null,contentDigest:null});
  const f=await bindCanonicalInputs(e.admin,tenant,principal,root,p,'selective'),source=await createEvidenceSource(tenant,{
   sourceKey:'y1-auxiliary:'+randomUUID(),sourceType:'manual',title:'Independent unused meaning dependency'}),
   snapshot={worldRoot:root,economicMeanings:[{key:'auxiliary',kind:'INTERPRETATION',subjectId:root.entityId,dimensions:[]}]};
  const version=await appendEvidenceVersion(tenant,source.id,{content:'Original unrelated meaning',snapshot,asOf:new Date()}),
   content=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[tenant,version.versionId])).rows[0].content_hash;
  f.request.problem.meanings=f.request.problem.meanings.map(m=>m.key==='auxiliary'?{...m,sourceId:source.id,versionId:version.versionId,contentDigest:content}:m);
  const first=await compile(f);assert.equal(first.view.status,'CHECKED');
  const revised=await appendEvidenceVersion(tenant,source.id,{content:'Later unrelated meaning',snapshot,asOf:new Date()});
  const invalid=await read(first.accepted.theoryId),event=invalid.events.find((v:any)=>v.kind==='P7_INVALIDATION');
  assert(event);assert(event.body.affected.every((v:any)=>v.id==='meaning:auxiliary'));
  assert(event.body.kept.some((v:any)=>v.id.startsWith('operator:')));assert(event.body.kept.some((v:any)=>v.id.startsWith('law:')));
  const revisedHash=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[tenant,revised.versionId])).rows[0].content_hash;
  const request={...structuredClone(f.request),idempotencyKey:randomUUID(),parentTheoryId:first.accepted.theoryId};
  request.problem.meanings=request.problem.meanings.map(m=>m.key==='auxiliary'?{...m,versionId:revised.versionId,contentDigest:revisedHash}:m);
  const second=await compile({...f,request});assert.equal(second.view.status,'CHECKED');
  assert.equal(digest(second.view.artifact.body.operators),digest(first.view.artifact.body.operators));
  assert.equal(digest(second.view.artifact.body.laws),digest(first.view.artifact.body.laws));
  assert.equal(second.view.artifact.envelope.comparison.classification,'REUSED');
  assert.equal(second.view.counters.episodeId,first.view.counters.episodeId);
  return {event,unaffectedOperatorAndLawDigestsIdentical:true,independentlyRechecked:true,originalEpisodeRetained:true};
 });
 await test('F-maintained-P7-and-responsibility-retention',async()=>{
  const before=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1',[tenant])).rows[0].n;
  await appendEvidenceVersion(tenant,main.sourceId,{content:'Later explicitly changed public meaning',snapshot:main.snapshot,asOf:new Date()});
  const native=(await e.admin.query('SELECT status FROM finnor_os.y1_requests WHERE tenant_id=$1 AND id=$2',[tenant,main.accepted.theoryId])).rows[0];
  assert.equal(native.status,'INVALIDATED');
  const view=await read(main.accepted.theoryId);assert.equal(view.current,false);assert(view.events.some((v:any)=>v.kind==='P7_INVALIDATION'));
  assert.equal((await api('economic-theory-artifact',{theoryId:main.accepted.theoryId})).status,422);
  assert.equal((await api('economic-programme-run',{programmeId:programme.id})).status,422);
  ok(await api('economic-programme-reconcile',{programmeId:programme.id}),202);await tick();
  ok(await api('economic-theory-cancel',{theoryId:main.accepted.theoryId}));
  const after=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1',[tenant])).rows[0].n;
  assert.equal(before,after);assert.equal(ok(await api('economic-programme-read',{programmeId:programme.id})).status,'OBSERVED');
  return {invalidation:view.events.filter((v:any)=>v.kind==='P7_INVALIDATION'),before,after,observationsRetained:true};
 });
 await test('F-canonical-resource-revision-retains-exposure',async()=>{
  const {ref:old,revision,priorRef,...input}=resource;
  const revised=ok(await e.http!.api(token,'allocations','resource',{resource:{...input,revoked:true},expectedRef:old}));
  const recovery=ok(await api('economic-reservation-read',{reservationRef:held.origin.ref}));
  assert.equal(recovery.revocationReason,'RESOURCE_REVISION_CHANGED');assert.deepEqual(recovery.origin.envelopes,held.origin.envelopes);
  assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2',[tenant,held.origin.ref.id])).rows[0].n,1);
  return {revisedRef:revised.ref,revocation:recovery.revocationReason,capacityNeverReleased:true};
 });
 await test('C-current-Work-input-invalidation',async()=>{
  const f=await compile(await fixture('steered'));assert.equal(f.view.status,'CHECKED');
  await receiveWork({tenantId:tenant,userId:principal,workId:f.work.workId,channel:'console',instruction:'Explicit later steering input',idempotencyKey:randomUUID()});
  const native=(await e.admin.query('SELECT status FROM finnor_os.y1_requests WHERE tenant_id=$1 AND id=$2',[tenant,f.accepted.theoryId])).rows[0];
  assert.equal(native.status,'INVALIDATED');assert.equal((await read(f.accepted.theoryId)).current,false);
  return {maintainedStatus:native.status,originalArtifactUnchanged:true};
 });
 await test('C-canonical-authority-revision-invalidation',async()=>{
  const f=await compile(await fixture('authority'));assert.equal(f.view.status,'CHECKED');
  const before=await read(f.accepted.theoryId);
  const changed=await e.admin.query('UPDATE finnor_os.authority_states SET revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 RETURNING revision',[tenant]);
  assert.equal(changed.rowCount,1);
  const native=(await e.admin.query('SELECT status FROM finnor_os.y1_requests WHERE tenant_id=$1 AND id=$2',[tenant,f.accepted.theoryId])).rows[0];
  assert.equal(native.status,'INVALIDATED');const after=await read(f.accepted.theoryId);assert.equal(after.current,false);
  assert.equal(digest(after.artifact),digest(before.artifact));assert.equal((await api('economic-theory-admit',{theoryId:f.accepted.theoryId})).status,422);
  return {revision:changed.rows[0].revision,native,immutableArtifactRetained:true};
 });
 if(built)await test('C-emitted-production-bootstrap-refuses-unprotected-secrets',async()=>{
  const before=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows[0].n;
  await e.http!.restartApi({runtime:'production',unsetDevBypass:true});
  const refusal=await api('economic-theory-submit',main.request);assert.equal(refusal.status,500);
  const retained=join(evidence,'built-api-processes'),logs=await Promise.all((await readdir(retained)).map(name=>readFile(join(retained,name,'built-api.log'),'utf8')));
  assert(logs.some(log=>log.includes('[security] production refused: SECRETS_PROVIDER=aws-secrets-manager is required')));
  assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows[0].n,before);
  return {refusal,earlierCanonicalProductionBootstrapRefused:true,protectedInfrastructureNotProvisioned:true,
   y1SpecificProductionGuardReached:false,authDevBypassUnset:true,emergencyPlaintextOverrideUsed:false};
 });
 await artifact(evidence,'installed-runtime.json',{manifest:runtime,api:built?'EMITTED_NEXT15':'SOURCE_HTTP_PILOT',worker:'EMITTED_ESM_WITH_ACTUAL_CREATE_WORKER',
  node:process.version,checker:await runtimeIdentity(),workerEntrypointUsesSourceLoader:false,
  canonicalOwnerSourceCustodyRequired:true,legacyOwnerMayRegisterTsx:true,protectedQualification:false});
}finally{
 await stopWorker();await closePool();await e.close();
 await artifact(evidence,'report.json',{schema:'finnor.y1.engineering-verification.v1',results,allExecutedPassed:results.every(r=>r.status==='PASS'),
  wallMs:performance.now()-started,builtApi:built,protectedQualification:false,unseenProtectedFamilies:0,qualifiedEquippedBaseline:false,
  mountedWorkProof:'SEPARATE_REQUIRED',cleanReconstruction:'SEPARATE_REQUIRED',financialEfficacy:false,
  rerun:'FINNOR_Y1_BUILT_API=1 FINNOR_Y1_EVIDENCE_DIR=<new absolute directory> node --import=tsx scripts/y1/run-installed.mts'});
}
console.log('Y1_ENGINEERING_CASES_PASSED',results.length,evidence);
