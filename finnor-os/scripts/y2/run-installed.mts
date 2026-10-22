/** Frozen-contract application campaign: signed HTTP, restrictive DB roles,
 * real createWorker, fitted checkpoints and an independent interpreter.
 * All inputs are public synthetic development data. No provider is contacted. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,cp,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {configureTenantVertical,receiveWork,withTenant} from '@finnor/db';
import {appendEvidenceVersionTx} from '@finnor/memory';
import {startEnvironment,artifact,repo,hash,recordPriorReleaseProbeRefusal} from '../x3/environment.mts';
import {publicProblem,bindCanonicalInputs,oracleQuery,decisionInput} from './business-fixtures.mts';
import {publicProblem as y1Problem,bindCanonicalInputs as bindY1,resourceInput} from '../y1/business-fixtures.mts';
import {PROFILE,digest} from '../../packages/private-equity/src/strategic-response/contracts';
import {strategicRuntimeIdentity,checkStrategicResponse} from '../../packages/epistemic-runtime/src/strategic-response/process';
import {transaction} from '../../packages/private-equity/src/strategic-response/store';
import {strategicResponseJob} from '../../packages/private-equity/src/strategic-response/worker';
const evidence=resolve(process.env.FINNOR_Y2_EVIDENCE_DIR??join(repo,'scope-postx/y2-strategic-response-world-model/evidence/installed-'+Date.now()));
await mkdir(evidence,{recursive:true});process.env.FINNOR_Y2_PROFILE='ordinary_disposable';process.env.FINNOR_Y1_PROFILE='ordinary_disposable';
process.env.FINNOR_S4_POLICY_STORE=await mkdtemp(join(tmpdir(),'finnor-y2-s4-'));
const runtime=JSON.parse(await readFile(join(repo,'finnor-os/dist-y2/manifest.json'),'utf8'));
assert.equal(hash(await readFile(join(repo,'finnor-os/dist-y2/worker-loop.mjs'))),runtime.worker.sha256);
process.env.FINNOR_Y2_ASSET_ROOT=join(repo,'finnor-os/dist-y2',runtime.assetRoot);
const built=process.env.FINNOR_Y2_BUILT_API==='1',started=performance.now(),results:any[]=[];
const e=await startEnvironment(evidence,{builtApi:built,baseHead:'0195_postx_y1_economic_action_theory.sql'});
let worker:ChildProcess|null=null,logs='',sequence=0;
const waits=new Map<number,{yes:(value:any)=>void;no:(error:Error)=>void}>();
async function stopWorker(){
 const old=worker;if(!old)return;
 if(old.exitCode===null&&old.signalCode===null){const ended=new Promise<void>(yes=>old.once('close',()=>yes()));old.kill('SIGKILL');await ended;}
 worker=null;assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(logs),'CREDENTIAL_FREE_WORKER_EVIDENCE');
 await artifact(evidence,'workers/stopped-'+sequence+'.json',{pid:old.pid,code:old.exitCode,signal:old.signalCode,logs});logs='';
}
function launch(python?:string){
 assert(!worker);const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:e.workerUrl};delete env.FINNOR_Y2_PYTHON;
 if(python)env.FINNOR_Y2_PYTHON=python;
 worker=spawn(process.execPath,[join(repo,'finnor-os/dist-y2/worker-loop.mjs')],{cwd:join(repo,'finnor-os'),env,stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [worker.stdout!,worker.stderr!])stream.on('data',b=>{logs+=b;if(logs.length>1048576)worker?.kill('SIGKILL');});
 worker.on('message',(out:any)=>{const waiting=waits.get(out.id);if(waiting){waits.delete(out.id);out.error?waiting.no(Error(out.error)):waiting.yes(out);}});
 worker.once('error',error=>{for(const w of waits.values())w.no(error);waits.clear();});
 worker.once('close',(code,signal)=>{for(const w of waits.values())w.no(Error('Y2_WORKER_EXIT:'+code+':'+signal));waits.clear();});
}
async function tick(retry=true):Promise<any>{
 if(!worker)launch();const id=++sequence;
 const result=await new Promise<any>((yes,no)=>{
  const timer=setTimeout(()=>{waits.delete(id);worker?.kill('SIGKILL');no(Error('Y2_NATIVE_TICK_DEADLINE'));},180000);
  waits.set(id,{yes:v=>{clearTimeout(timer);yes(v);},no:error=>{clearTimeout(timer);no(error);}});worker!.send({id,operation:'TICK'});
 });
 assert.equal(result.productionWorkerFactory,true);await artifact(evidence,'workers/tick-'+id+'.json',result);
 if(!result.claimed&&retry){await new Promise(yes=>setTimeout(yes,2100));return tick(false);}
 return result;
}
async function until(predicate:()=>Promise<boolean>,name:string){
 const deadline=Date.now()+30000;while(!await predicate()){assert(Date.now()<deadline,name);await new Promise(yes=>setTimeout(yes,30));}
}
async function test(id:string,claims:string[],fn:()=>Promise<unknown>){
 const start=performance.now();
 try{const observed=await fn();results.push({id,claims,status:'PASS',wallMs:performance.now()-start,observed});await artifact(evidence,'cases/'+id+'.json',results.at(-1));}
 catch(error){results.push({id,claims,status:'FAIL',wallMs:performance.now()-start,error:String(error),stack:(error as Error).stack});
  await artifact(evidence,'cases/'+id+'.json',results.at(-1));throw error;}
}
const tenant=randomUUID(),principal=randomUUID(),peer=randomUUID(),root={entityType:'external_organization',entityId:randomUUID()};
let token='',peerToken='',main:any,identified:any,prediction:any,decisionBefore:any,decisionAfter:any,retained:any;
const api=(operation:string,input:unknown,who=token)=>e.http!.api(who,'company-brain',operation,input);
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const read=(id:string)=>api('response-model-read',{modelId:id}).then(r=>ok(r));
const useRead=(modelId:string,useId:string)=>api('response-use-read',{modelId,useId}).then(r=>ok(r));
async function fixture(label:string,change?:(p:any)=>void,informative=false){
 const problem=publicProblem(root,informative);change?.(problem);
 return bindCanonicalInputs(e.admin,tenant,principal,root,problem,label);
}
async function compile(f:any){
 const accepted=ok(await api('response-model-submit',f.request),202);
 for(let i=0;i<8;i++){await tick();const view=await read(accepted.modelId);if(!['QUEUED','FITTING','CHECKING'].includes(view.status))return {...f,accepted,view};}
 throw Error('Y2_DURABLE_FIT_DID_NOT_FINISH');
}
async function use(operation:'response-forecast'|'response-programme',input:any){
 const accepted=ok(await api(operation,input),202);
 for(let i=0;i<8;i++){await tick();const view=await useRead(accepted.modelId,accepted.useId);if(!['QUEUED','EVALUATING','CHECKING'].includes(view.status)){
  const checkpoint=(await e.admin.query('SELECT candidate FROM finnor_os.y2_uses WHERE tenant_id=$1 AND id=$2',[tenant,accepted.useId])).rows[0].candidate;
  await artifact(evidence,'use-checkpoints/'+accepted.useId+'.json',{accepted,input,view,checkpoint});return {accepted,view};
 }}
 throw Error('Y2_DURABLE_USE_DID_NOT_FINISH');
}
async function admit(f:any){const a=ok(await api('response-model-admit',{modelId:f.view.modelId}));assert.equal(a.domain,'STRATEGIC_RESPONSE_MODEL_SET');return a;}
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y2 public own-firm financing context')",[tenant,randomUUID()]);
 for(const id of [principal,peer]){
  const email=id+'@y2.example.test';await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[id,tenant,email]);
  e.http!.register(id,email);
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'y2-own-firm','Public own-firm financing desk','other')",[root.entityId,tenant]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'Y2:disposable'});
 token=await e.http!.login(principal);peerToken=await e.http!.login(peer);
 await test('01-authentication-migration-and-strict-body',['Y2-13'],async()=>{
  const unauth=await fetch(e.http!.apiBase+'/api/company-brain/response-model-list',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert([401,404].includes(unauth.status));assert.equal((await api('response-model-submit',{mode:'production'})).status,400);
  assert.equal((await api('response-model-submit',{padding:'x'.repeat(PROFILE.maximumRequestBytes)})).status,413);
  const roles=(await e.admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname")).rows;
  assert(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));
  const migration=JSON.parse(await readFile(join(evidence,'migration-upgrade-replay.json'),'utf8'));
  assert.deepEqual(migration.upgrade,[
    '0195_private_input_responses.sql','0195a_postx_y1_temporal_binding.sql',
    '0196_postx_y2_strategic_response.sql','0196a_postx_y2_requested_model_currentness.sql',
   ]);assert.deepEqual(migration.replay,[]);
  return {unauthenticated:unauth.status,oversized:413,strict:400,roles,upgrade:migration.upgrade,replay:migration.replay};
 });
 await test('02-durable-fitted-complete-model-set',['Y2-01','Y2-02','Y2-14'],async()=>{
  main=await compile(await fixture('incumbent'));assert.equal(main.view.status,'CHECKED',JSON.stringify(main.view));
  const body=main.view.artifact.body;assert.deepEqual(body.identification.structuralFamilies,[-2,0,2]);assert.equal(body.hypotheses.length,6);
  assert.equal(body.holdout.coveredCompleteJointTrajectories,20);assert.equal(body.holdout.empiricalCalibrationEstablished,false);
  assert.deepEqual(body.identification.behaviorSelections,['DECLINE','PARTICIPATE']);
  for(const m of body.hypotheses){
   const bias=m.tie==='PARTICIPATE'?1:2;assert.deepEqual(m.bias,{lender:bias,capital:bias});assert.equal(m.incentiveWeight,1);
  }
  await tick();await recordPriorReleaseProbeRefusal(evidence,e.admin);
  const deliveries=(await e.admin.query("SELECT j.type,j.protocol_version,j.status,d.claim_fence,d.outcome FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.tenant_id=$1 AND j.payload->>'modelId'=$2",[tenant,main.view.modelId])).rows;
  assert(deliveries.length&&deliveries.every(d=>Number(d.claim_fence)>0));
  const download=ok(await api('response-model-artifact',{modelId:main.view.modelId}));
  assert.equal(hash(Buffer.from(download.bytesBase64,'base64')),download.sha256);
  return {body,deliveries,independentCheck:main.view.artifact.envelope.independentChecks[0],downloadDigest:download.sha256,emittedWorker:runtime.worker};
 });
 await test('03-current-principal-root-evidence-and-replay',['Y2-13','Y2-10'],async()=>{
  assert.equal((await api('response-model-read',{modelId:main.view.modelId},peerToken)).status,404);
  assert.equal((await api('response-model-list',{root,workId:randomUUID()})).status,404);
  const replay=ok(await api('response-model-submit',main.request),202);assert(replay.replayed);assert.equal(replay.modelId,main.view.modelId);
  const conflict=structuredClone(main.request);conflict.problem.payoff.jointPayoff='21';assert.equal((await api('response-model-submit',conflict)).status,409);
  const forged={...conflict,idempotencyKey:randomUUID()};assert.equal((await api('response-model-submit',forged)).status,422);
  assert.equal((await api('response-model-submit',{...main.request,candidate:main.view.artifact.body})).status,400);
  const leaking=structuredClone(main.request);leaking.idempotencyKey=randomUUID();leaking.problem.actors[0].privateInformation='ALL_ACTOR_PRIVATE_TYPES';
  assert.equal((await api('response-model-submit',leaking)).status,400);
  const foreignTenant=randomUUID(),foreignActor=randomUUID(),email=foreignActor+'@y2.example.test';
  await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y2 unrelated firm')",[foreignTenant,randomUUID()]);
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[foreignActor,foreignTenant,email]);
  await configureTenantVertical({tenantId:foreignTenant,verticalKey:'private_equity',expectedVersion:0,createdBy:foreignActor,sourceSystem:'Y2:foreign'});
  e.http!.register(foreignActor,email);assert.equal((await api('response-model-read',{modelId:main.view.modelId},await e.http!.login(foreignActor))).status,404);
  const hidden=await transaction({auth:{tenantId:tenant,userId:peer,employeeId:peer,role:'owner'}},c=>c.query('SELECT id FROM finnor_os.y2_models WHERE id=$1',[main.view.modelId]));
  assert.equal(hidden.rowCount,0);return {peer:404,foreignTenant:404,foreignWork:404,canonicalForgery:422,replay,rlsHiddenRows:hidden.rowCount};
 });
 await test('04-uninformative-labels-and-requested-experiments',['Y2-02','Y2-03'],async()=>{
  const renamed=await compile(await fixture('renamed',p=>{for(const e of p.training.concat(p.holdout))e.id='renamed_'+e.id;}));
  assert.deepEqual(renamed.view.artifact.body.hypotheses,main.view.artifact.body.hypotheses);
  const requested=await compile(await fixture('requested',p=>{
   const probe=structuredClone(p.training[0]);probe.id='requested_probe';probe.origin='REQUESTED_EXPERIMENT';probe.execution='REQUESTED';
   probe.assignment='PERMITTED_RANDOMIZED';probe.rounds=[{ruleId:'probe',outsideOptions:{lender:2,capital:1},commonSignal:0,choices:{lender:1,capital:1}}];p.training.push(probe);
  }));
  assert.deepEqual(requested.view.artifact.body.identification.structuralFamilies,[-2,0,2]);assert(requested.view.artifact.body.training.ignoredEpisodeIds.includes('requested_probe'));
  const confounded=await compile(await fixture('confounded',p=>{p.training.at(-1).assignment='CONFOUNDED';},true));
  assert.deepEqual(confounded.view.artifact.body.identification.structuralFamilies,[-2,0,2]);
  return {renamed:renamed.view.artifact.body.identification,requested:requested.view.artifact.body.training,confounded:confounded.view.artifact.body.identification};
 });
 await test('05-separate-admission-and-fresh-withheld-prediction',['Y2-04','Y2-06'],async()=>{
  const blocked=await api('response-forecast',{modelId:main.view.modelId,query:oracleQuery(),idempotencyKey:randomUUID()});assert.equal(blocked.status,422);
  const admission=await admit(main);assert.equal(admission.protectedAdmission,false);assert.equal(admission.executionAuthorityGranted,false);
  prediction=await use('response-forecast',{modelId:main.view.modelId,query:oracleQuery(),idempotencyKey:randomUUID()});
  assert.equal(prediction.view.status,'CHECKED',JSON.stringify(prediction.view));const forecast=prediction.view.artifact.result;
  const byModel=new Map(main.view.artifact.body.hypotheses.map((m:any)=>[m.id,m.peerWeight]));
  const observed=forecast.trajectories.map((t:any)=>({peerWeight:byModel.get(t.hypothesisId),choices:t.rounds[0].choices,payoff:t.rounds[0].jointPayoff}));
  for(const row of observed){
   const expected=row.peerWeight===2?{lender:1,capital:1}:row.peerWeight===-2?{lender:0,capital:0}:{lender:0,capital:1};
   assert.deepEqual(row.choices,expected);assert.equal(row.payoff,row.peerWeight===2?'20':'0');
  }
  assert.equal(forecast.probabilityWeights,null);return {admission,observed,independentCheck:prediction.view.check,noFieldClaim:true};
 });
 await test('06-independent-mutations-are-rejected',['Y2-05'],async()=>{
  const identity=await strategicRuntimeIdentity(),body=main.view.artifact.body,p=main.request.problem,mutations:any[]=[];
  for(const [name,change] of [
   ['missing-alternative',(m:any)=>m.hypotheses.pop()],['fitted-coefficient',(m:any)=>{m.hypotheses[0].bias.lender++;}],
   ['false-holdout',(m:any)=>{m.holdout.coveredCompleteJointTrajectories--;}],
  ] as const){
   const changed=structuredClone(body);change(changed);const check=await checkStrategicResponse('FIT',{problem:p},changed,Date.now()+30000,identity);
   assert.equal(check.status,'REJECTED',name);mutations.push({name,check});
  }
  const forecast=structuredClone(prediction.view.artifact.result);forecast.trajectories[0].rounds[0].choices.lender^=1;
  const joint=await checkStrategicResponse('PREDICT',{problem:p,model:body,query:oracleQuery()},forecast,Date.now()+30000,identity);
  assert.equal(joint.status,'REJECTED');mutations.push({name:'joint-path',check:joint});
  const privateQuery=oracleQuery();privateQuery.jointPrivatePaths.push({id:'undisclosedPeerWithdrawal',outsideOptions:{lender:[3],capital:[8]}});
  const privatePrediction=await use('response-forecast',{modelId:main.view.modelId,query:privateQuery,idempotencyKey:randomUUID()});
  assert.equal(privatePrediction.view.status,'CHECKED');
  const leaking=structuredClone(privatePrediction.view.artifact.result);
  const complement=leaking.trajectories.find((t:any)=>t.privatePathId==='undisclosedPeerWithdrawal'&&
   main.view.artifact.body.hypotheses.find((m:any)=>m.id===t.hypothesisId).peerWeight===2);
  complement.rounds[0].choices.lender=0;
  const leaked=await checkStrategicResponse('PREDICT',{problem:p,model:body,query:privateQuery},leaking,Date.now()+30000,identity);
  assert.equal(leaked.status,'REJECTED');mutations.push({name:'illegally-current-peer-private-type-conditioned-response',check:leaked});
  return mutations;
 });
 await test('07-actual-s4-incumbent-and-identified-programme',['Y2-03','Y2-07'],async()=>{
  const beforeInput=decisionInput(main.view,tenant,principal);decisionBefore=await use('response-programme',beforeInput);
  assert.equal(decisionBefore.view.status,'CHECKED',JSON.stringify(decisionBefore.view));
  const before=decisionBefore.view.artifact.result.policy;assert.equal(before.nodes.find((n:any)=>n.id===before.rootNodeId).actionId,'stop');
  assert.deepEqual(before.certificate.valueBounds,[0,0]);assert.deepEqual(before.mandate,beforeInput.mandate);
  identified=await compile(await fixture('identified',undefined,true));assert.equal(identified.view.status,'CHECKED');
  assert.deepEqual(identified.view.artifact.body.identification.structuralFamilies,[2]);assert.equal(identified.view.artifact.body.hypotheses.length,2);
  assert.equal(identified.view.artifact.body.identification.pointIdentifiedInClass,false);
  await admit(identified);const afterInput=decisionInput(identified.view,tenant,principal);decisionAfter=await use('response-programme',afterInput);
  assert.equal(decisionAfter.view.status,'CHECKED',JSON.stringify(decisionAfter.view));
  const after=decisionAfter.view.artifact.result.policy;assert.equal(after.nodes.find((n:any)=>n.id===after.rootNodeId).actionId,'coordinate');
  assert.deepEqual(after.certificate.valueBounds,[18,18]);assert.deepEqual(after.mandate,afterInput.mandate);
  assert.equal(after.demand.reservationGranted,false);assert.equal(after.admission.executionAuthorityGranted,false);
  const canonical=ok(await e.http!.api(token,'policies','validate',{policyRef:after.ref}));assert.equal(canonical.status,'CURRENT');
  const replay=ok(await e.http!.api(token,'policies','replay',{policyRef:after.ref}));
  assert.equal(replay.programMatches,true);assert.equal(replay.certificateMatches,true);
  const fractional=await compile(await fixture('fractional-binary64',(p:any)=>{p.payoff.jointPayoff='3'},true));
  assert.equal(fractional.view.status,'CHECKED');await admit(fractional);
  const fractionalInput:any=decisionInput(fractional.view,tenant,principal);
  fractionalInput.mandate.utility.periodTerms[0].coefficient=0.1;
  const {ref,...fractionalMandateBody}=fractionalInput.mandate,fractionalDigest=digest(fractionalMandateBody);
  fractionalInput.mandate={...fractionalMandateBody,ref:{...ref,id:'mandate:'+fractionalDigest,contentDigest:fractionalDigest}};
  fractionalInput.problem.actions.find((a:any)=>a.id==='coordinate').cost=0;
  const fractionalUse=await use('response-programme',fractionalInput);
  assert.equal(fractionalUse.view.status,'CHECKED',JSON.stringify(fractionalUse.view));
  assert.deepEqual(fractionalUse.view.artifact.result.policy.certificate.valueBounds,[0.30000000000000004,0.30000000000000004]);
  const lie=structuredClone(before);lie.certificate.valueBounds=[18,18];lie.certificate.optimalBounds=[18,18];
  const rejected=await checkStrategicResponse('DECISION',{problem:main.request.problem,model:main.view.artifact.body,query:beforeInput.query,
   mandate:beforeInput.mandate,control:beforeInput.problem,actionRules:beforeInput.actionRules},lie,Date.now()+30000,await strategicRuntimeIdentity());
  assert.equal(rejected.status,'REJECTED');
  const temporal=await use('response-programme',decisionInput(identified.view,tenant,principal,2));
  assert.equal(temporal.view.status,'CHECKED',JSON.stringify(temporal.view));
  const course=temporal.view.artifact.result.policy;assert.deepEqual(course.certificate.valueBounds,[38,38]);
  assert.equal(course.nodes.find((n:any)=>n.period===0).actionId,'coordinate');
  assert.equal(course.nodes.find((n:any)=>n.period===1).actionId,'stop');
  // Same incentive and numeric exposure. Only the registered public disclosure
  // rule changes; S4 must consume its meaning, not merely its numeric label.
  const hiddenInput=decisionInput(identified.view,tenant,principal);
  hiddenInput.actionRules[0]!.ruleIds=['undisclosed'];
  const hidden=await use('response-programme',hiddenInput);assert.equal(hidden.view.status,'CHECKED');
  const hiddenPolicy=hidden.view.artifact.result.policy;
  assert.equal(hiddenPolicy.nodes.find((n:any)=>n.id===hiddenPolicy.rootNodeId).actionId,'stop');
  assert.deepEqual(hiddenPolicy.certificate.valueBounds,[0,0]);
  return {before:{action:'stop',value:before.certificate.valueBounds},after:{action:'coordinate',value:after.certificate.valueBounds},
   temporal:{nodes:course.nodes,value:course.certificate.valueBounds,stopRetainsOriginalPublicSchedule:true},
   publicDisclosureMeaning:{action:'stop',value:hiddenPolicy.certificate.valueBounds,sameNumericExposure:true},
   causalQualification:'PUBLIC_SYNTHETIC_CONDITIONAL_ONLY',canonical,replay,fractionalBinary64:{accepted:fractionalUse.accepted,check:fractionalUse.view.check,valueBounds:fractionalUse.view.artifact.result.policy.certificate.valueBounds},independentDecisionMutation:rejected,protectedEquippedXGain:false};
 });
 await test('08-actor-local-private-feedback-and-shared-paths',['Y2-08','Y2-04'],async()=>{
  const q=oracleQuery(2);q.jointPrivatePaths.push({id:'privateWithdrawal',outsideOptions:{lender:[3,3],capital:[8,8]}});
  const out=await use('response-forecast',{modelId:identified.view.modelId,query:q,idempotencyKey:randomUUID()});assert.equal(out.view.status,'CHECKED');
  const paths=out.view.artifact.result.trajectories;assert.equal(paths.length,4);
  for(const path of paths)assert.equal(path.rounds[0].choices.lender,1,'NO_CURRENT_PEER_PRIVATE_INFORMATION');
  assert.deepEqual(paths.find((p:any)=>p.privatePathId==='jointOutside').rounds.map((r:any)=>r.choices.lender),[1,1]);
  assert.deepEqual(paths.find((p:any)=>p.privatePathId==='privateWithdrawal').rounds.map((r:any)=>r.choices.lender),[1,0]);
  q.sharedSignalPaths=[{id:'lowThenHigh',values:[-2,2]},{id:'highThenLow',values:[2,-2]}];
  const coupled=await use('response-forecast',{modelId:identified.view.modelId,query:q,idempotencyKey:randomUUID()});assert.equal(coupled.view.status,'CHECKED');
  assert.equal(coupled.view.artifact.result.trajectories.length,8);
  return {privateInformationBoundary:paths,jointCompletePaths:coupled.view.artifact.result.trajectories,probabilityWeights:null};
 });
 await test('09-unavailable-checker-original-resume-and-fallback',['Y2-10','Y2-11'],async()=>{
  await stopWorker();launch('/nonexistent/y2-python');
  const unknown=await compile(await fixture('unavailable'));assert.equal(unknown.view.status,'UNKNOWN');assert.equal(unknown.view.artifact,null);
  const checkpoint=(await e.admin.query('SELECT candidate FROM finnor_os.y2_models WHERE id=$1',[unknown.view.modelId])).rows[0].candidate;
  assert.equal((await api('response-model-admit',{modelId:unknown.view.modelId})).status,422);
  await stopWorker();const resumed=ok(await api('response-model-resume',{modelId:unknown.view.modelId}),202);await tick();
  const recovered=await read(unknown.view.modelId);assert.equal(recovered.status,'CHECKED');assert.equal(recovered.counters.attempts,2);
  assert.equal(digest(recovered.artifact.body),digest(checkpoint));assert.equal(recovered.counters.deadlineAt,unknown.view.counters.deadlineAt);
  await stopWorker();launch('/nonexistent/y2-python');
  const childRequest={...main.request,idempotencyKey:randomUUID(),parentModelId:main.view.modelId};
  const child=await compile({...main,request:childRequest});assert.equal(child.view.status,'UNKNOWN');assert.equal(child.view.fallbackId,main.view.modelId);
  const eligibility=ok(await api('response-model-compare',{modelId:child.view.modelId}));assert(eligibility.eligible);
  await stopWorker();
  const fallback=await use('response-forecast',{modelId:child.view.modelId,query:oracleQuery(),idempotencyKey:randomUUID()});
  assert.equal(fallback.view.status,'CHECKED');assert.equal(fallback.accepted.fallbackUsed,true);assert.equal(fallback.accepted.executedModelId,main.view.modelId);
  assert.equal(fallback.view.originalEpisodeId,main.view.counters.episodeId);
  const independentBefore=await read(main.view.modelId);
  ok(await api('response-model-cancel',{modelId:child.view.modelId}));
  const cancelledFallback=await useRead(child.view.modelId,fallback.accepted.useId),independentAfter=await read(main.view.modelId);
  assert.equal(cancelledFallback.current,false);assert.equal(cancelledFallback.status,'INVALIDATED');
  assert.equal(independentAfter.current,true);assert.equal(digest(independentAfter.artifact),digest(independentBefore.artifact));
  return {unknown:unknown.view.status,resumed,recovered:recovered.counters,eligibility,actualFallback:fallback.accepted,fallbackCheck:fallback.view.check,cancelledFallback,independentFallbackModelRetained:true};
 });
 await test('10-real-worker-checkpoint-death-and-fenced-recovery',['Y2-10'],async()=>{
  const f=await fixture('death'),accepted=ok(await api('response-model-submit',f.request),202),lock=71422002;
  await e.admin.query('SELECT pg_advisory_lock($1)',[lock]);
  await e.admin.query(`CREATE FUNCTION finnor_os.y2_test_checkpoint_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   BEGIN IF session_user='finnor_worker' AND NEW.resource_key='native:y2-strategic-response' AND EXISTS(
    SELECT 1 FROM finnor_os.y2_models WHERE id='${accepted.modelId}'::uuid AND candidate IS NOT NULL
   ) THEN PERFORM pg_advisory_xact_lock(${lock}); END IF;RETURN NEW;END $$`);
  await e.admin.query('CREATE TRIGGER y2_test_checkpoint_gate BEFORE UPDATE ON finnor_os.compute_resource_leases FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_test_checkpoint_gate()');
  const interrupted=tick().then(v=>({completed:v}),error=>({interrupted:String(error)}));
  await until(async()=>!!(await e.admin.query('SELECT candidate FROM finnor_os.y2_models WHERE id=$1',[accepted.modelId])).rows[0]?.candidate,'Y2_CHECKPOINT_NOT_COMMITTED');
  const before=await read(accepted.modelId);
  const checkpoint=(await e.admin.query('SELECT candidate FROM finnor_os.y2_models WHERE id=$1',[accepted.modelId])).rows[0].candidate;
  await stopWorker();const killed=await interrupted;await e.admin.query('SELECT pg_advisory_unlock($1)',[lock]);
  await e.admin.query('DROP TRIGGER y2_test_checkpoint_gate ON finnor_os.compute_resource_leases');await e.admin.query('DROP FUNCTION finnor_os.y2_test_checkpoint_gate()');
  // Explicit disposable failure injection: expired physical job/native leases,
  // not a changed business deadline or a replacement worker implementation.
  await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[accepted.jobId]);
  await e.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE resource_key='native:y2-strategic-response' AND released_at IS NULL");
  await tick();const after=await read(accepted.modelId);assert.equal(after.status,'CHECKED',JSON.stringify(after));
  assert.equal(digest(after.artifact.body),digest(checkpoint));assert.equal(after.counters.attempts,2);
  assert.equal(after.counters.deadlineAt,before.counters.deadlineAt);assert.equal(after.counters.episodeId,before.counters.episodeId);
  await assert.rejects(strategicResponseJob({tenantId:tenant,principalId:principal,modelId:accepted.modelId,generation:1}),/Y2_PHYSICAL_EXECUTION_REQUIRED/);
  const native=(await e.admin.query('SELECT claim_fence,outcome FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at',[accepted.jobId])).rows;
  assert(native.length>=2);assert(Number(native.at(-1).claim_fence)>Number(native[0].claim_fence));
  return {killed,before:before.counters,after:after.counters,checkpointDigest:digest(checkpoint),native,leaseExpiryFailureInjection:true,businessClockUnchanged:true};
 });
 await test('11-no-supported-model-and-untruncated-resource-refusal',['Y2-11'],async()=>{
  const contradiction=await compile(await fixture('contradiction',p=>{
   const row=structuredClone(p.training[0]);row.id='contradiction';row.rounds[0].choices.lender^=1;p.training.push(row);
  }));
  assert.equal(contradiction.view.status,'NO_SUPPORTED_MODEL');assert.equal((await api('response-model-admit',{modelId:contradiction.view.modelId})).status,422);
  const broad=await compile(await fixture('broad',p=>{
   p.actors.push({id:'approver',role:'APPROVER',privateInformation:'OWN_OUTSIDE_OPTION_AND_OWN_PREVIOUS_CHOICE',outcomeVisibility:'PUBLIC'});
   for(const row of p.training.concat(p.holdout)){row.initial={lender:1,capital:1,approver:1};row.rounds=[{ruleId:'inc1',
    outsideOptions:{lender:0,capital:0,approver:0},commonSignal:2,choices:{lender:1,capital:1,approver:1}}];}
  }));
  assert.equal(broad.view.status,'CHECKED');assert.equal(broad.view.artifact.body.hypotheses.length,486);await admit(broad);
  const q=oracleQuery();q.initial.approver=1;q.jointPrivatePaths[0]!.outsideOptions.approver=[1];
  q.jointPrivatePaths.push({id:'secondJoint',outsideOptions:{lender:[2],capital:[3],approver:[1]}});
  const refusal=await use('response-forecast',{modelId:broad.view.modelId,query:q,idempotencyKey:randomUUID()});
  assert.equal(refusal.view.status,'INCOMPLETE');assert.equal(refusal.view.artifact,null);
  assert.equal((await api('response-forecast',{modelId:main.view.modelId,query:{...oracleQuery(),context:'unjustified_transport'},idempotencyKey:randomUUID()})).status,422);
  return {emptyFiniteClass:contradiction.view.status,physicalInfeasibilityClaimed:false,retainedHypotheses:486,requiredJointWorlds:972,refusedWithoutTruncation:refusal.view};
 });
 await test('12-cancellation-original-guards-and-Work-invalidation',['Y2-09','Y2-10','Y2-13'],async()=>{
  const f=await fixture('cancel'),accepted=ok(await api('response-model-submit',f.request),202);
  ok(await api('response-model-cancel',{modelId:accepted.modelId}));await tick();const cancelled=await read(accepted.modelId);
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.artifact,null);assert.equal(cancelled.counters.attempts,0);
  const ctx={auth:{tenantId:tenant,userId:principal,employeeId:principal,role:'owner' as const}},rejected:string[]=[];
  for(const [label,sql,values] of [
   ['deadline',"UPDATE finnor_os.y2_episodes SET deadline_at=deadline_at+interval '1 hour' WHERE tenant_id=$1 AND id=$2",[tenant,main.view.counters.episodeId]],
   ['attempt-reset','UPDATE finnor_os.y2_episodes SET attempts_used=0 WHERE tenant_id=$1 AND id=$2',[tenant,main.view.counters.episodeId]],
   ['model-preimage',"UPDATE finnor_os.y2_models SET candidate='{}'::jsonb WHERE tenant_id=$1 AND id=$2",[tenant,main.view.modelId]],
   ['delete-original','DELETE FROM finnor_os.y2_models WHERE tenant_id=$1 AND id=$2',[tenant,main.view.modelId]],
  ] as const){await assert.rejects(transaction(ctx,c=>c.query(sql,[...values])));rejected.push(label);}
  const steered=await compile(await fixture('steered'));await receiveWork({tenantId:tenant,userId:principal,workId:steered.work.workId,
   channel:'console',instruction:'Later explicit steering preserves original response responsibility',idempotencyKey:randomUUID()});
  const stale=await read(steered.view.modelId);assert.equal(stale.status,'INVALIDATED');assert(stale.events.some((v:any)=>v.kind==='P7_INVALIDATION'));
  return {cancelled:cancelled.status,nativeAttempts:0,rejected,steered:stale.status,preimagesRetained:!!stale.artifact};
 });
 await test('13-retained-y1-canonical-S5-S6-S7-preimage',['Y2-16','Y2-09','Y2-07'],async()=>{
  const horizon={startAt:new Date(Date.now()-3600000).toISOString(),periodMs:7200000,periods:1},
   period={startAt:horizon.startAt,endAt:new Date(Date.parse(horizon.startAt)+horizon.periodMs).toISOString()};
  const f=await bindY1(e.admin,tenant,principal,root,y1Problem(root,period,'retained'),'retained');
  const accepted=ok(await api('economic-theory-submit',f.request),202);let view:any;
  for(let i=0;i<8;i++){await tick();view=ok(await api('economic-theory-read',{theoryId:accepted.theoryId}));if(view.status==='CHECKED')break;}
  assert.equal(view.status,'CHECKED');ok(await api('economic-theory-admit',{theoryId:accepted.theoryId}));
  const resource=ok(await e.http!.api(token,'allocations','resource',{resource:resourceInput(tenant,principal,root,horizon,'y2-retained')}));
  const held=ok(await api('economic-reservation-create',{theoryId:accepted.theoryId,initialState:{available:'3',committed:'2'},
   bindings:f.request.problem.quantities.map((q:any)=>({quantityId:q.id,resourceRef:resource.ref})),idempotencyKey:randomUUID()}));
  const plan=ok(await api('economic-programme-create',{theoryId:accepted.theoryId,reservationRef:held.origin.ref,expectedRevision:held.revision,
   goalState:{available:'1',committed:'4'},parameters:{amount:'2'},idempotencyKey:randomUUID()}));
  ok(await api('economic-programme-run',{programmeId:plan.id}),202);await tick();
  const observed=ok(await api('economic-programme-read',{programmeId:plan.id}));
  assert.equal(observed.status,'OBSERVED',JSON.stringify(observed));
  assert(observed.obligations[0].verification.canonicalObservationRef);
  const pendingPlan=ok(await api('economic-programme-create',{theoryId:accepted.theoryId,reservationRef:held.origin.ref,
   expectedRevision:observed.reservationRevision,goalState:{available:'0',committed:'5'},parameters:{amount:'1'},idempotencyKey:randomUUID()}));
  ok(await api('economic-programme-run',{programmeId:pendingPlan.id}),202);
  // Pause the actual native execution transaction, never fabricate an effect.
  // The real fenced Y1 worker first durably prepares its original S6 intent.
  await e.admin.query(`CREATE FUNCTION finnor_os.y2_fixture_hold_native_commit() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN PERFORM pg_advisory_xact_lock(2026102023); RETURN NEW; END $$;
   CREATE TRIGGER y2_fixture_hold_native_commit BEFORE UPDATE OF status ON finnor_os.business_effects
    FOR EACH ROW WHEN (OLD.status='compiled' AND NEW.status='executed')
    EXECUTE FUNCTION finnor_os.y2_fixture_hold_native_commit()`);
  await e.admin.query('SELECT pg_advisory_lock(2026102023)');
  const running=tick();void running.catch(()=>undefined);
  let responsibility:any,killed:any,originalJob:any,gateLocked=true;
  try{
   await until(async()=>(await e.admin.query("SELECT 1 FROM finnor_os.business_effects WHERE tenant_id=$1 AND status='compiled'",[tenant])).rows.length>0,
    'Y2_REAL_UNRESOLVED_S6_INTENT_NOT_REACHED');
   originalJob=(await e.admin.query("SELECT id,claim_fence FROM finnor_os.jobs WHERE tenant_id=$1 AND type='run_economic_programme_v1' AND payload->>'programmeId'=$2 AND status='running'",[tenant,pendingPlan.id])).rows[0];
   assert(originalJob);
   // Actual process death releases transaction locks without erasing the
   // committed original responsibility or pretending its effect was observed.
   await stopWorker();killed=await running.then(v=>({completed:v}),error=>({interrupted:String(error)}));
   // Let PostgreSQL finish noticing the dead client and roll back its open
   // transaction before testing current reads, not a lock-timeout refusal.
   await e.admin.query('SELECT pg_advisory_unlock(2026102023)');gateLocked=false;
   const pending=(await e.admin.query("SELECT id,status,semantic_hash,scope_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND status='compiled'",[tenant])).rows,
    canonical=ok(await e.http!.api(token,'policies','validate',{policyRef:decisionAfter.view.artifact.result.policy.ref})),
    existingUse=await useRead(identified.view.modelId,decisionAfter.accepted.useId),
    newProgramme=await api('response-programme',decisionInput(identified.view,tenant,principal));
   responsibility={pending,canonical,existingUse,newProgramme,originalJob,killed,
    mechanism:'ACTUAL_CANONICAL_S6_INTENT_AFTER_NATIVE_WORKER_DEATH',effectRowsFabricated:false};
   await artifact(evidence,'s6-outstanding-responsibility.json',responsibility);
   assert.equal(canonical.status,'STALE_INPUT','NEW_UNRESOLVED_S6_EFFECT_MUST_FENCE_OLD_STRATEGIC_POLICY');
   assert.equal(existingUse.current,false);assert.equal(existingUse.status,'INVALIDATED');
   assert.equal(digest(existingUse.artifact),digest(decisionAfter.view.artifact));
   assert.equal(newProgramme.status,422);
   assert.equal(newProgramme.body.code,'Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
  }finally{
   await stopWorker();await running.catch(()=>undefined);
   if(gateLocked)await e.admin.query('SELECT pg_advisory_unlock(2026102023)');
   await e.admin.query('DROP TRIGGER y2_fixture_hold_native_commit ON finnor_os.business_effects; DROP FUNCTION finnor_os.y2_fixture_hold_native_commit()');
   // Explicit expiry of this original physical claim, never its business
   // deadline. Effectful claims must not be blindly replayed on expiry.
   await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND type='run_economic_programme_v1' AND payload->>'programmeId'=$2 AND status='running'",[tenant,pendingPlan.id]);
   await e.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE resource_key='native:y1-owner' AND released_at IS NULL");
   await tick();
  }
  const reconciliation=ok(await api('economic-programme-reconcile',{programmeId:pendingPlan.id}),202);await tick();
  const pendingAfter=ok(await api('economic-programme-read',{programmeId:pendingPlan.id}));
  assert.equal(pendingAfter.status,'PREPARED');assert.equal(pendingAfter.observedGoalDigest,null);
  assert.equal(pendingAfter.obligations.length,1);assert.equal(pendingAfter.obligations[0].status,'compiled');
  assert.equal(pendingAfter.obligations[0].verification,null);
  assert.deepEqual(pendingAfter.currentRightState,{available:'1',committed:'4'});
  const pendingRows=(await e.admin.query("SELECT id,status,semantic_hash,scope_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND status='compiled'",[tenant])).rows;
  assert.deepEqual(pendingRows,responsibility.pending);
  const unresolved=ok(await e.http!.api(token,'policies','validate',{policyRef:decisionAfter.view.artifact.result.policy.ref}));
  assert.equal(unresolved.status,'STALE_INPUT');
  const recovery={reconciliation,pendingAfter,unresolved,originalIntentPreserved:true,blindEffectReplay:false,
   observedSuccessFabricated:false,responsibilityStillRequiresOwner:true};
  await artifact(evidence,'s6-recovery-readback.json',recovery);
  retained={effects:(await e.admin.query('SELECT to_jsonb(b) body FROM finnor_os.business_effects b WHERE tenant_id=$1',[tenant])).rows,
   reservations:(await e.admin.query('SELECT to_jsonb(r) body FROM finnor_os.s5_reservations r WHERE tenant_id=$1',[tenant])).rows};
  assert.equal(retained.effects.length,2);assert(retained.reservations.length>0);
  return {classification:'REUSED_Y1_NATIVE_OWNER_MACHINERY',responsibility,recovery,observed,retained,externalSettlement:false,realizedFinancialEfficacy:false};
 });
 await test('14-transport-withdrawal-fences-new-use-retains-commitments',['Y2-09'],async()=>{
  const beforeArtifact=digest(main.view.artifact),snapshot=structuredClone(main.snapshot);snapshot.strategicResponseProblem.transport.status='WITHDRAWN';
  await withTenant(tenant,db=>appendEvidenceVersionTx(db,tenant,main.sourceId,{content:JSON.stringify(snapshot.strategicResponseProblem),snapshot,asOf:new Date()}));
  const stale=await read(main.view.modelId);assert.equal(stale.status,'INVALIDATED');assert.equal(digest(stale.artifact),beforeArtifact);
  assert.equal((await api('response-forecast',{modelId:main.view.modelId,query:oracleQuery(),idempotencyKey:randomUUID()})).status,422);
  const oldUse=await useRead(main.view.modelId,decisionBefore.accepted.useId);assert.equal(oldUse.status,'INVALIDATED');assert(oldUse.artifact);
  const native={effects:(await e.admin.query('SELECT to_jsonb(b) body FROM finnor_os.business_effects b WHERE tenant_id=$1',[tenant])).rows,
   reservations:(await e.admin.query('SELECT to_jsonb(r) body FROM finnor_os.s5_reservations r WHERE tenant_id=$1',[tenant])).rows};
  assert.deepEqual(native,retained);return {status:stale.status,priorArtifactDigest:beforeArtifact,oldUseStatus:oldUse.status,
   originalS5S6PreimagesUnchanged:true,retainedEffectCount:native.effects.length,retainedReservationCount:native.reservations.length,events:stale.events.filter((v:any)=>v.kind==='P7_INVALIDATION')};
 });
 await test('15-authority-and-runtime-currentness',['Y2-09'],async()=>{
  const method=await compile(await fixture('method-cut'));await admit(method);
  const methodUse=await use('response-forecast',{modelId:method.view.modelId,query:oracleQuery(),idempotencyKey:randomUUID()});
  assert.equal(methodUse.view.status,'CHECKED');
  const oldAssets=process.env.FINNOR_Y2_ASSET_ROOT!,temporary=await mkdtemp(join(tmpdir(),'finnor-y2-changed-assets-'));
  await cp(join(repo,'finnor-os/dist-y2/assets'),join(temporary,'assets'),{recursive:true});
  const changedAssets=join(temporary,'assets/packages/epistemic-runtime/src/strategic-response');
  await appendFile(join(changedAssets,'checker.py'),'\n# Disposable method-identity failure injection, not a new authorized method.\n');
  let methodInvalid:any,imageIdentity:any;
  try{
   process.env.FINNOR_Y2_ASSET_ROOT=changedAssets;if(built)await e.http!.restartApi();
   imageIdentity=await strategicRuntimeIdentity();assert.equal(imageIdentity.assetsMatchEmitted,false);
   assert.equal((await api('response-model-submit',{...method.request,idempotencyKey:randomUUID()})).status,503);
   methodInvalid=await read(method.view.modelId);assert.equal(methodInvalid.status,'INVALIDATED');assert(methodInvalid.currentnessReasons.includes('method'));
   assert.equal(digest(methodInvalid.artifact),digest(method.view.artifact));
   assert.equal((await useRead(method.view.modelId,methodUse.accepted.useId)).status,'INVALIDATED');
  }finally{process.env.FINNOR_Y2_ASSET_ROOT=oldAssets;if(built)await e.http!.restartApi();}
  const before=await read(identified.view.modelId);
  // Canonical authority mutation, not a caller-supplied revision field.
  await e.admin.query('UPDATE finnor_os.authority_states SET revision=revision+1 WHERE tenant_id=$1',[tenant]);
  const invalid=await read(identified.view.modelId);assert.equal(invalid.status,'INVALIDATED');
  assert.equal(digest(invalid.artifact),digest(before.artifact));
  return {status:invalid.status,preimageRetained:true,sourceCut:runtime.source,profileFrozenBeforeCode:true,
   methodStatus:methodInvalid.status,changedAssetMatchedCompiledMethod:imageIdentity.assetsMatchEmitted,descendantUseInvalidated:true};
 });
 await test('16-original-fit-and-durable-use-grants-exhaust',['Y2-10','Y2-11'],async()=>{
  await stopWorker();launch('/nonexistent/y2-python');
  const f=await fixture('exhausted-fits');let last:any,originalDeadline:string|undefined;
  for(let i=0;i<PROFILE.maximumAttempts;i++){
   last=await compile({...f,request:{...f.request,idempotencyKey:randomUUID()}});
   assert.equal(last.view.status,'UNKNOWN');assert.equal(last.view.counters.attempts,i+1);
   originalDeadline??=last.view.counters.deadlineAt;assert.equal(last.view.counters.deadlineAt,originalDeadline);
  }
  assert.equal((await api('response-model-submit',{...f.request,idempotencyKey:randomUUID()})).status,409);
  assert.equal((await api('response-model-resume',{modelId:last.view.modelId})).status,409);
  await stopWorker();
  const g=await compile(await fixture('exhausted-uses'));await admit(g);const accepted:any[]=[];
  for(let i=0;i<PROFILE.maximumUses;i++)accepted.push(ok(await api('response-forecast',{
   modelId:g.view.modelId,query:oracleQuery(),idempotencyKey:randomUUID()}),202));
  assert.equal((await api('response-forecast',{modelId:g.view.modelId,query:oracleQuery(),idempotencyKey:randomUUID()})).status,409);
  for(const u of accepted)ok(await api('response-use-cancel',{modelId:u.modelId,useId:u.useId}));
  const uses=(await e.admin.query("SELECT count(*)::int total,count(*) FILTER(WHERE cancelled)::int cancelled,sum(attempts_used)::int executed_attempts FROM finnor_os.y2_uses WHERE tenant_id=$1 AND model_id=$2",[tenant,g.view.modelId])).rows[0];
  assert.deepEqual(uses,{total:32,cancelled:32,executed_attempts:0});const after=await read(g.view.modelId);assert.equal(after.counters.uses,32);
  assert.equal(after.counters.deadlineAt,g.view.counters.deadlineAt);
  return {fitAttempts:4,nextFitRefused:409,resumeRefused:409,originalDeadline,durableUseGrant:uses,
   acceptedUsesNotClaimedAsExecutedPredictions:true,nextUseRefused:409,originalUseCounterNotReset:after.counters.uses};
 });
 await test('17-production-profile-refuses-development-port',['Y2-13','Y2-14'],async()=>{
  let refused:any,protectedProfile:any;const previous=process.env.NODE_ENV,previousProfile=process.env.FINNOR_Y2_PROFILE;
  try{
   process.env.FINNOR_Y2_PROFILE='protected';
   if(built)await e.http!.restartApi();
   protectedProfile=await api('response-model-list',{root,workId:identified.work.workId});
   assert.equal(protectedProfile.status,403);assert.equal(protectedProfile.body.code,'Y2_DISPOSABLE_DEVELOPMENT_ONLY');
   process.env.FINNOR_Y2_PROFILE=previousProfile;
   if(built)await e.http!.restartApi({runtime:'production',unsetDevBypass:true});else process.env.NODE_ENV='production';
   refused=await api('response-model-list',{root,workId:identified.work.workId});
   // The real production secrets owner rejects this disposable environment
   // before authentication or Y2 dispatch. Never override that guard to make
   // an expected Y2-specific status reachable.
   assert.equal(refused.status,built?500:403);
  }finally{
   process.env.FINNOR_Y2_PROFILE=previousProfile;
   if(built)await e.http!.restartApi();else process.env.NODE_ENV=previous;
  }
  let productionRefusalOwner='Y2_DISPOSABLE_DEVELOPMENT_ONLY';
  if(built){
   const directory=join(evidence,'built-api-processes'),names=await readdir(directory);
   const logs=await Promise.all(names.map(name=>readFile(join(directory,name,'built-api.log'),'utf8')));
   assert(logs.some(log=>log.includes('production refused: SECRETS_PROVIDER=aws-secrets-manager is required')));
   productionRefusalOwner='CANONICAL_PRODUCTION_SECRETS_GUARD_BEFORE_Y2_DISPATCH';
  }
  return {protectedProfile,refused,productionRefusalOwner,y2ReachedInProduction:!built,
   transport:built?'ACTUAL_COMPILED_PRODUCTION_CONFIGURATION':'SOURCE_OWNER_PRODUCTION_CONFIGURATION',
   productionActivated:false,protectedQualification:false};
 });
 await artifact(evidence,'summary.json',{schema:'finnor.y2.application-campaign.v1',status:'PASS',cases:results.map(({id,claims,status,wallMs})=>({id,claims,status,wallMs})),
  wallMs:performance.now()-started,transport:built?'ACTUAL_BUILT_NEXT_API':'SOURCE_ROUTE_OVER_SIGNED_HTTP',emittedNativeWorker:true,
  authBypass:false,publicSyntheticOnly:true,protectedQualification:false,equippedXGainEstablished:false,financialEfficacyEstablished:false});
 console.log('Y2 application campaign PASS',results.length,evidence);
}catch(error){
 await artifact(evidence,'summary.json',{schema:'finnor.y2.application-campaign.v1',status:'FAIL',cases:results,error:String(error),wallMs:performance.now()-started});
 throw error;
}finally{await stopWorker();await e.close();}
