/** Failure-first real-boundary stories. Oracles do not import P2 selection/value functions. */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mjs';
import {createMetricSeries,recordMetricObservation} from '@finnor/private-equity';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {receiveWork} from '@finnor/db';
import {POST as allocationPost} from '../../apps/api/app/api/allocations/[operation]/route';

const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>Promise<any>,timeoutMs=20000){const end=Date.now()+timeoutMs;while(Date.now()<end){const value=await fn();if(value)return value;await pause(25);}throw Error('INDEPENDENT_OBSERVER_TIMEOUT');}
function child(e:any,extra:Record<string,string>={}){
 const process=spawn(globalThis.process.execPath,['--import=tsx','scripts/p2/child-worker.mts'],{cwd:join(e.repo,'finnor-os'),env:{...globalThis.process.env,...extra},stdio:['ignore','pipe','pipe','ipc']});
 let output='',error='';process.stdout.on('data',b=>{output+=b;});process.stderr.on('data',b=>{error+=b;});
 const closed=new Promise<any>((resolve,reject)=>{process.once('error',reject);process.once('close',(code,signal)=>resolve({pid:process.pid,code,signal,output,error}));});
 return {process,closed,output:()=>output,stop:()=>{if(process.connected)process.send('stop');},kill:()=>process.kill('SIGKILL')};
}
async function stage(e:any,fixtures:any[]){
 const {JobQueue}=await import('../../apps/worker/src/queue'),contracts=(await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS;
 const q=new JobQueue('p2-stage-'+randomUUID(),3);
 q.register('run_harness_program_v1',(await import('../../packages/private-equity/src/program-synthesis/worker')).runHarnessProgramJob,contracts.run_harness_program_v1);
 q.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,contracts.run_evidence_derivation_v1);
 for(const f of fixtures)if(!f.submitted){f.submitted=await e.api('compute-search-submit',f.search,f.identity);ok(f.submitted,202);}
 for(let i=0;i<80;i++){await q.tick();const rows=(await e.admin.query('SELECT id,context FROM finnor_os.p2_requests WHERE id=ANY($1::uuid[])',[fixtures.map(f=>f.submitted.body.searchId)])).rows;if(rows.length===fixtures.length&&rows.every((r:any)=>r.context))return;await pause(25);}throw Error('REAL_P1_SOURCE_STAGE_TIMEOUT');
}
async function deferNative(e:any,fixtures:any[]){
 // Disposable scheduling fault isolates the quota contest from native jobs;
 // claims and admission remain the unmodified real production boundaries.
 return (await e.admin.query("UPDATE finnor_os.jobs j SET run_at=clock_timestamp()+interval '2 minutes' FROM finnor_os.p2_units u WHERE j.type='run_compute_search_unit_v1' AND j.payload->>'unitId'=u.id::text AND u.search_id=ANY($1::uuid[]) AND u.kind<>'MODEL_REFINE' AND j.status='queued' RETURNING j.id,j.payload,j.run_at",[fixtures.map(f=>f.submitted.body.searchId)])).rows;
}
async function releaseNative(e:any,rows:any[]){await e.admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=ANY($1::uuid[]) AND status='queued'",[rows.map(r=>r.id)]);}
export async function prepared(e:any,topology='ADAPTIVE',extra:any={}) {
 const {deferSearch,beforeFit,beforePolicy,omittedInput,...searchExtra}=extra;
 const dir=join(e.evidence,topology+'-'+randomUUID());await mkdir(dir,{recursive:true});
 const artifact=async(path:string,body:unknown)=>{const p=join(dir,path);await mkdir(join(p,'..'),{recursive:true});await writeFile(p,JSON.stringify(body,null,2));};
 const api=async(f:any,op:string,body:any,handler=allocationPost)=>{const response=await handler(new Request('http://localhost/api/allocations/'+op,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation:op})});return {status:response.status,body:await response.json()};};
 const rows=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(e.repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8'});assert.equal(rows.status,0,rows.stderr);
 const day=86400000;
 const support=createUpstreamFixtureSupport({admin:()=>e.admin,generatedRows:JSON.parse(rows.stdout).rows,begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures:{},artifact,api:async(f:any,op:string,body:any,handler=allocationPost)=>{
  if(op==='fit') {
   await artifact('s3-request-before-fit.json',body);
   if(beforeFit)await beforeFit(f);
   f.work=await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:e.request().instruction,channel:'console',idempotencyKey:randomUUID()});
   await (await import('../../packages/orchestration/src/workforce-runtime')).configureAgentProfile(f.tenant,(await import('../../packages/orchestration/src/plugin-registry')).createDefaultPluginRegistry(),{key:'p2-native',name:'Disposable real native query executor',actor:f.ctx.auth,capabilityGrants:[{kind:'query',capability:'query:harness_program_v1'},{kind:'check',capability:'check:objective_success'}],autonomyLimits:{maxActions:1,maxQueries:8,maxReplans:6,maxPlannerCalls:8,maxWallClockMs:3600000}});
   const source=await createEvidenceSource(f.tenant,{sourceKey:'p2-values',sourceType:'manual',title:'Original predeclared liability inputs'}),version=await appendEvidenceVersion(f.tenant,source.id,{content:'EV120 debt70 liability7 EBITDA20',snapshot:{values:{EV:'120',debt:'70',liability:'7',EBITDA:'20'}},asOf:new Date(e.periodStart)});
   f.p2Observations={};for(const [key,value] of Object.entries({EV:'120',debt:'70',liability:'7',EBITDA:'20'})) {if(key===omittedInput)continue;const series=await createMetricSeries(f.ctx,{subjectType:f.root.entityType,subjectId:f.root.entityId,metricKey:key,name:key,unit:'currency',currencyCode:'USD',frequency:'annual'});f.p2Observations[key]=await recordMetricObservation(f.ctx,{metricSeriesId:String(series.row.id),periodStart:new Date(e.periodStart),periodEnd:new Date(e.periodEnd),value:{type:'number',value},evidence:{evidenceSourceId:source.id,evidenceVersionId:version.versionId}});}
  }
  if(op==='fit'&&f.browser){const view=await (await import('../../packages/private-equity/src/enterprise-beliefs')).loadEnterpriseBeliefView(f.ctx,{root:f.root,validAt:body.request.time.endAt});await artifact('browser-before-fit-view.json',view);}
  return api(f,op,body,handler);
 }});
 const f=await support.fixture('p2-'+randomUUID(),1,[{id:'compute',unit:'native-attempt',capacity:8,totalLimit:8,resourceClass:'COMPUTE'}]);
 if(beforePolicy)await beforePolicy(f);
 const policy=await support.policy(f,'compute',{compute:8});await support.resource(f,'compute','native-attempt','CUMULATIVE_EXPENDITURE',['8','8']);
 const allocation=ok(await api(f,'clear',support.clearing(f,{compute:['1']})));assert.equal(allocation.status,'FEASIBLE');
 const identity={tenant:f.tenant,actor:f.principal},request=e.request();request.computeSearch='P2_REQUIRED';if(f.browser)request.threadId=f.browser.thread.id;request.root=f.root;request.workId=f.work.workId;request.workInputId=f.work.workInputId;request.ownerBindings={policyRef:policy.ref,allocationRef:allocation.certificate.ref};request.sources=request.sources.map((s:any)=>({...s,source:{...s.source,subject:f.root}}));request.limits={maxCandidates:8,maxAttempts:8,maxSteps:4096,deadlineMs:300000};
 const response=await e.api('program-submit',request,identity);await artifact('p1-submission.json',{request,response});if(response.status!==202){try{await (await import('../../packages/private-equity/src/program-synthesis/api')).submitHarnessProgram(f.ctx,request);}catch(error){await artifact('p1-replay-diagnostic.json',{message:String(error),stack:(error as Error).stack,cause:String((error as any).cause)});}}const p=ok(response,202);let held:any;for(let tick=0;tick<40;tick++){await e.queue.tick();held=(await e.admin.query('SELECT p.status,e.attempts_used FROM finnor_os.p1_requests p JOIN finnor_os.p1_episodes e ON e.id=p.episode_id WHERE p.id=$1',[p.programId])).rows[0];if(held.status==='WAITING')break;await new Promise(r=>setTimeout(r,25));}assert.equal(held.status,'WAITING');assert.equal(held.attempts_used,0);await artifact('p1-held-for-allocation.json',held);
 const search={schema:'finnor.compute-search-request.v1',programId:p.programId,policyRequest:policy.ref,computeGrant:allocation.certificate.ref,idempotencyKey:randomUUID(),mode:'ordinary_disposable',strategy:topology,limits:{maxUnits:8,maxParallel:2},...searchExtra};
 const submitted=deferSearch?null:await e.api('compute-search-submit',search,identity);await artifact('before-implementation-boundary.json',{request,p,search,submitted,policyRef:policy.ref,certificateRef:allocation.certificate.ref});
 return {f,policy,allocation,p,request,search,identity,submitted,artifact,dir,api};
}
export async function finish(e:any,p:any) {let plan:any,program:any;for(let i=0;i<100;i++){await e.queue.tick();plan=await e.api('compute-search-read',{searchId:p.searchId},p.identity);if(plan.status!==200)throw Error(JSON.stringify(plan));program=await e.api('program-read',{programId:p.programId},p.identity);if(['STOPPED','FAILED','CANCELLED','INVALIDATED'].includes(plan.body.status)&&['TESTED','FAILED','INVALIDATED','PARTIAL','CANCELLED'].includes(program.body.status))return {plan:plan.body,program:program.body};await new Promise(r=>setTimeout(r,40));}throw Error('P2_REAL_QUEUE_BOUND_EXHAUSTED');}
export async function ownerBackedSearch(e:any) {
 const f=await prepared(e);const accepted=ok(f.submitted,202),replay=ok(await e.api('compute-search-submit',f.search,f.identity),202);assert.equal(replay.searchId,accepted.searchId);
 const conflict=await e.api('compute-search-submit',{...f.search,strategy:'FIXED_SEQUENTIAL'},f.identity);assert.equal(conflict.status,422);
 const done=await finish(e,{...accepted,programId:f.p.programId,identity:f.identity});await f.artifact('done.json',done);assert.equal(done.program.status,'TESTED');assert.equal(done.program.program.result.values.netEquity.value,'43');assert.equal(done.program.program.result.values.leverage.value,'3.5');
 const oracle=(await e.admin.query('SELECT 120::numeric-70::numeric-7::numeric equity,70::numeric/20::numeric leverage')).rows[0];assert.equal(done.program.program.result.values.netEquity.value,oracle.equity);
 const draft=ok(await e.api('program-artifact',{programId:f.p.programId},f.identity));const bytes=Buffer.from(draft.bytesBase64,'base64');await writeFile(join(f.dir,'actual.docx'),bytes);const ir=await (await import('@finnor/artifacts')).interpret(bytes);assert(JSON.stringify(ir).includes('43'));assert(JSON.stringify(ir).includes('liability'));
 assert.equal(done.plan.plan.computeGrant.contentDigest,f.allocation.certificate.ref.contentDigest);assert(done.plan.plan.incumbent);assert.equal(done.plan.plan.stop.certifiedGap,undefined);assert(done.plan.plan.stop.heuristic);
 const units=(await e.admin.query('SELECT id,kind,status,body,result,attempts FROM finnor_os.p2_units WHERE search_id=$1 ORDER BY created_at,id',[accepted.searchId])).rows;assert(units.some((u:any)=>u.kind==='EXECUTE_P1'&&u.status==='COMPLETED'));assert(units.some((u:any)=>u.kind==='VERIFY_P1'&&u.status==='COMPLETED'));
 for(const unit of units.filter((u:any)=>u.kind==='VERIFY_P1'&&u.status==='COMPLETED')){const parent=units.find((u:any)=>u.id===unit.body.prerequisites[0]);assert(parent?.status==='COMPLETED');assert(unit.result.checks.every((c:any)=>c.status==='PASS'));}
 const foreign=await e.api('compute-search-read',{searchId:accepted.searchId});assert.equal(foreign.status,404);assert(!JSON.stringify(foreign.body).includes('43'));
 const forged=await e.api('compute-search-submit',{...f.search,idempotencyKey:randomUUID(),computeGrant:{...f.search.computeGrant,contentDigest:'0'.repeat(64)}},f.identity);assert(forged.status>=400);assert(!JSON.stringify(forged.body).includes('43'));
 const protectedRefusal=await e.api('compute-search-submit',{...f.search,idempotencyKey:randomUUID(),mode:'protected'},f.identity);assert.equal(protectedRefusal.status,422);assert.equal(protectedRefusal.body.predicate,'P2_PROTECTED_FUNDING_AND_RUNTIME_UNAVAILABLE');
 assert(units.filter((u:any)=>u.status==='CANCELLED').every((u:any)=>u.attempts===0));
 const episode=(await e.admin.query('SELECT * FROM finnor_os.p1_episodes WHERE id=$1',[done.program.program.bounds.episodeId])).rows[0];assert(episode.attempts_used<=episode.max_attempts);assert(episode.steps_used<=episode.max_steps);assert.equal(episode.candidates_used,2);
 assert.equal(done.plan.plan.bindings.marginalWorkEstimate.netValue,null);assert.equal(done.plan.plan.bindings.marginalWorkEstimate.completionProbability,null);assert(done.plan.plan.quotaProfile.some((q:any)=>q.schema==='finnor.p2.physical-capacity-snapshot.v1'));
 await f.artifact('independent-observations.json',{oracle,units,episode,foreign,forged,ir});
 const curve:any[]=[{strategy:'ADAPTIVE',accepted:done.program.status==='TESTED',values:done.program.program.result.values,physicalAttempts:done.plan.plan.costs.physicalAttempts,parentCosts:done.plan.plan.costs.parent,dollars:null}];
 for(const strategy of ['FIXED_SEQUENTIAL','FIXED_WIDE']){const baseline=await prepared(e,strategy),a=ok(baseline.submitted,202),result=await finish(e,{...a,programId:baseline.p.programId,identity:baseline.identity});assert.equal(result.program.status,'TESTED');assert.equal(result.program.program.result.values.netEquity.value,oracle.equity);assert.equal(result.program.program.result.values.leverage.value,'3.5');assert.equal(result.plan.plan.costs.physicalAttempts,4);curve.push({strategy,accepted:true,values:result.program.program.result.values,physicalAttempts:result.plan.plan.costs.physicalAttempts,parentCosts:result.plan.plan.costs.parent,dollars:null,originalLimits:baseline.request.limits});await baseline.artifact('fixed-controller-public-easy-result.json',result);}
 assert.equal(curve[0].physicalAttempts,2);await f.artifact('public-easy-topology-mechanics.json',{curve,scope:'Predeclared easy finite arithmetic only; equal original maxima and owner fixtures. No independent economic labels, metered matched cost, hard-search strata, equipped comparison or original GateP2 pass.'});
 return {searchId:accepted.searchId,dir:f.dir,oracle,unitCount:units.length,curve,qualification:'PUBLIC_NATIVE_OWNER_MECHANICS_NO_ECONOMIC_ROUTING_CLAIM'};
}
async function endpointConfig(e:any,servers:any[],ids=['diagnostic']){
 const endpoints=servers.map((server,index)=>{const address=server.address();assert(address&&typeof address!=='string');return {id:ids[index],kind:'DIAGNOSTIC_MODEL',provider:'LOCAL_HTTP_FIXTURE',model:index?'diagnostic-alt':'diagnostic-v1',region:null,tier:'ordinary-diagnostic',url:`http://127.0.0.1:${address.port}`,limits:{concurrency:1,rpm:8,inputTpm:16384,outputTpm:64,tpd:32768,maxOutputTokens:16},source:'PREDECLARED_LOCAL_POLICY_NOT_PROVIDER_QUOTA',windowMs:60000,expiresAt:new Date(Date.now()+600000).toISOString(),price:null};});
 const path=join(e.evidence,'endpoint-config-'+randomUUID()+'.json');await writeFile(path,JSON.stringify({schema:'finnor.p2.endpoint-config.v1',endpoints}));process.env.FINNOR_P2_ENDPOINT_CONFIG=path;return {path,endpoints};
}
async function listening(server:any){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return server;}
function reply(res:any,body:any,model='diagnostic-v1',alternate=false){const targets=structuredClone(body.accepted.targets);if(alternate)targets[0].expression={kind:'subtract',left:{kind:'subtract',left:{kind:'input',key:'EV'},right:{kind:'input',key:'liability'}},right:{kind:'input',key:'debt'}};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model,usage:{inputTokens:8,outputTokens:4},finishReason:'stop',targets}));}
export async function endpointAdmission(e:any) {
 const rejectedResponses=await rejectedEndpointResponses(e);
 const calls:any[]=[];
 const throttled=await listening(createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({route:'throttled',headers:req.headers,body:JSON.parse(raw),at:Date.now()});res.writeHead(429,{'retry-after':'0.05'});res.end('throttled');}));
 const alternate=await listening(createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({route:'alternate',headers:req.headers,body:JSON.parse(raw),at:Date.now()});reply(res,JSON.parse(raw),'diagnostic-alt',true);}));
 let fallback:any;
 try {const config=await endpointConfig(e,[throttled,alternate],['diagnostic','alternate']);const f=await prepared(e,'ADAPTIVE',{requestedKinds:['MODEL_REFINE'],routeIds:['diagnostic','alternate']}),a=ok(f.submitted,202);const done=await finish(e,{...a,programId:f.p.programId,identity:f.identity});await f.artifact('endpoint-observations.json',{done,calls,config});assert.equal(done.program.status,'TESTED');assert.equal(calls.length,2);assert(calls[1].at-calls[0].at>=40);assert.notEqual(calls[0].headers['x-finnor-attempt-id'],calls[1].headers['x-finnor-attempt-id']);assert.deepEqual(calls.map(c=>c.route),['throttled','alternate']);
 const attempts=(await e.admin.query('SELECT status,body FROM finnor_os.p2_attempts WHERE search_id=$1 ORDER BY created_at,id',[a.searchId])).rows;assert(attempts.some((x:any)=>x.body.statusCode===429));assert(attempts.some((x:any)=>x.body.actualModel==='diagnostic-alt'));assert.equal(done.plan.plan.costs.usd,null);
 const modules=done.program.program.modules;assert.equal(modules.length,3);const units=(await e.admin.query('SELECT kind,status,body,result FROM finnor_os.p2_units WHERE search_id=$1',[a.searchId])).rows;const newer=modules[2];assert(units.some((u:any)=>u.kind==='VERIFY_P1'&&u.body.moduleId===newer.id&&u.status==='COMPLETED'&&u.result.checks.every((c:any)=>c.status==='PASS')));assert.equal(done.program.program.result.values.netEquity.value,'43');
 fallback={dir:f.dir,calls,attempts,modules:modules.map((m:any)=>({id:m.id,structureDigest:m.structureDigest})),originalEpisode:done.program.program.bounds.episodeId};await f.artifact('independent-fallback-and-new-module.json',fallback);
 }finally{await Promise.all([throttled,alternate].map(s=>new Promise<void>(r=>s.close(()=>r()))));}
 const contention=await endpointContention(e);delete process.env.FINNOR_P2_ENDPOINT_CONFIG;return {fallback,contention,rejectedResponses};
}
async function rejectedEndpointResponses(e:any){
 const records=[];
 for(const fault of ['truncated','wrong-model','usage-bound']){
  const calls:any[]=[];const server=await listening(createServer(async(req,res)=>{let raw='';for await(const bytes of req)raw+=bytes;const body=JSON.parse(raw),response={model:fault==='wrong-model'?'unrequested-model':'diagnostic-v1',usage:{inputTokens:8,outputTokens:fault==='usage-bound'?17:4},finishReason:fault==='truncated'?'length':'stop',targets:body.accepted.targets};calls.push({attemptId:req.headers['x-finnor-attempt-id'],response});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));}));
  try{
   const config=await endpointConfig(e,[server]),f=await prepared(e,'ADAPTIVE',{requestedKinds:['MODEL_REFINE'],routeIds:['diagnostic']}),a=ok(f.submitted,202),done=await finish(e,{...a,programId:f.p.programId,identity:f.identity});
   const attempts=(await e.admin.query('SELECT status,body FROM finnor_os.p2_attempts WHERE search_id=$1 AND endpoint_key IS NOT NULL',[a.searchId])).rows,units=(await e.admin.query("SELECT kind,status FROM finnor_os.p2_units WHERE search_id=$1 AND kind='MODEL_REFINE'",[a.searchId])).rows,window=(await e.admin.query('SELECT active,requests,output_tokens FROM finnor_os.p2_endpoint_windows WHERE endpoint_key=$1',[done.plan.plan.quotaProfile.find((p:any)=>p.id==='diagnostic').key])).rows;
   await f.artifact('returned-response-refusal-'+fault+'.json',{fault,calls,config,done,attempts,units,window});
   assert.equal(calls.length,1);assert.equal(attempts.length,1);assert.equal(attempts[0].status,'FAILED');assert.equal(attempts[0].body.responseDigest,createHash('sha256').update(JSON.stringify(calls[0].response)).digest('hex'));assert.equal(units[0].status,'FAILED');assert.equal(window[0].active,0);assert.equal(window[0].requests,1);assert.equal(Number(window[0].output_tokens),16);assert.equal(done.program.status,'TESTED');assert.equal(done.program.program.modules.length,2);assert.equal(done.program.program.result.values.netEquity.value,'43');
   records.push({fault,dir:f.dir,attemptId:calls[0].attemptId,status:attempts[0].status});
  }finally{delete process.env.FINNOR_P2_ENDPOINT_CONFIG;server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
 }
 return records;
}
async function endpointContention(e:any){
 const calls:any[]=[];let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const server=await listening(createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({headers:req.headers,at:Date.now(),body:JSON.parse(raw)});if(calls.length===1)await gate;reply(res,JSON.parse(raw));}));
 const children:any[]=[];let deferred:any[]=[];const fixtures:any[]=[];
 try{
  const config=await endpointConfig(e,[server]);for(let i=0;i<2;i++)fixtures.push(await prepared(e,'ADAPTIVE',{deferSearch:true,requestedKinds:['MODEL_REFINE'],routeIds:['diagnostic']}));await stage(e,fixtures);deferred=await deferNative(e,fixtures);
  const before=(await e.admin.query('SELECT p.id,e.attempts_used,e.steps_used,e.max_attempts,e.deadline_at FROM finnor_os.p1_requests p JOIN finnor_os.p1_episodes e ON e.id=p.episode_id WHERE p.id=ANY($1::uuid[])',[fixtures.map(f=>f.p.programId)])).rows;
  children.push(child(e),child(e));await until(async()=>children.every(c=>c.output().includes('READY')),20000);
  await until(async()=>calls.length===1,20000);
  const blocked=await until(async()=>{const row=(await e.admin.query("SELECT j.id,j.payload,j.attempts,j.capacity_defer_count,j.capacity_defer_reason,d.outcome FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.type='run_compute_search_unit_v1' AND j.payload->>'searchId'=ANY($1::text[]) AND d.outcome='capacity_deferred' AND j.capacity_defer_reason LIKE '%p2-endpoint:%'",[fixtures.map(f=>f.submitted.body.searchId)])).rows[0];return row;},6000);
  const windows=(await e.admin.query('SELECT * FROM finnor_os.p2_endpoint_windows WHERE active>0')).rows;assert.equal(windows.length,1);assert.equal(windows[0].active,1);assert.equal(windows[0].requests,1);
  const admitted=(await e.admin.query('SELECT id,search_id,status,body FROM finnor_os.p2_attempts WHERE search_id=ANY($1::uuid[])',[fixtures.map(f=>f.submitted.body.searchId)])).rows;assert.equal(admitted.length,1);assert.equal(admitted[0].status,'SUBMITTED');assert.equal(calls.length,1);assert.equal(blocked.attempts,0);
  const debits=(await e.admin.query("SELECT p.id,e.attempts_used,e.steps_used,g.spent FROM finnor_os.p1_requests p JOIN finnor_os.p1_episodes e ON e.id=p.episode_id LEFT JOIN finnor_os.p2_grant_usage g ON g.tenant_id=p.tenant_id AND g.grant_digest=p.request->'ownerBindings'->'allocationRef'->>'contentDigest' WHERE p.id=ANY($1::uuid[])",[fixtures.map(f=>f.p.programId)])).rows;assert.equal(debits.reduce((n:number,r:any)=>n+Number(r.attempts_used)-Number(before.find((b:any)=>b.id===r.id).attempts_used),0),1);assert(debits.some((d:any)=>d.attempts_used===before.find((b:any)=>b.id===d.id).attempts_used&&d.spent===null));
  release();await until(async()=>calls.length===2,30000);await until(async()=>(await e.admin.query("SELECT count(*)::int n FROM finnor_os.p2_units WHERE search_id=ANY($1::uuid[]) AND kind='MODEL_REFINE' AND status='COMPLETED'",[fixtures.map(f=>f.submitted.body.searchId)])).rows[0].n===2,30000);
  children.forEach(c=>c.stop());const receipts=await Promise.all(children.map(c=>c.closed));assert(receipts.every(r=>r.code===0));assert.notEqual(receipts[0].pid,receipts[1].pid);await releaseNative(e,deferred);
  const done=[];for(const f of fixtures)done.push(await finish(e,{...f.submitted.body,programId:f.p.programId,identity:f.identity}));assert(done.every(d=>d.program.status==='TESTED'));
  const observed={config,disposableSchedulingFault:deferred,before,blocked,windows,admitted,debits,calls,receipts,done};await fixtures[0].artifact('two-process-atomic-quota.json',observed);return {dir:fixtures[0].dir,workerPids:receipts.map(r=>r.pid),blocked,physicalCalls:calls.length};
 }finally{
  if(fixtures.length){const ids=fixtures.filter(f=>f.submitted).map(f=>f.submitted.body.searchId),cuts:any={calls,children:children.map(c=>({pid:c.process.pid,output:c.output()})),disposableSchedulingFault:deferred};for(const [key,sql]of Object.entries({windows:'SELECT * FROM finnor_os.p2_endpoint_windows',units:'SELECT id,search_id,kind,status,attempts,claim_token,claim_fence FROM finnor_os.p2_units WHERE search_id=ANY($1::uuid[])',attempts:'SELECT id,search_id,unit_id,status,body FROM finnor_os.p2_attempts WHERE search_id=ANY($1::uuid[])',jobs:"SELECT j.id,j.status,j.payload,j.attempts,j.capacity_defer_count,j.capacity_defer_reason,j.last_error,d.outcome,d.failure_detail FROM finnor_os.jobs j LEFT JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.type='run_compute_search_unit_v1' AND j.payload->>'searchId'=ANY($1::text[])"})){cuts[key]=(await e.admin.query(sql,key==='windows'?[]:[ids])).rows;}await fixtures[0].artifact('two-process-observed-cuts.json',cuts);}
  release();for(const c of children){c.stop();if(c.process.exitCode===null)c.kill();}if(deferred.length)await releaseNative(e,deferred);delete process.env.FINNOR_P2_ENDPOINT_CONFIG;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
async function parentPreparationFailure(e:any){
 const f=await prepared(e,'ADAPTIVE',{omittedInput:'EBITDA'}),id=ok(f.submitted,202).searchId;
 let parent:any;for(let i=0;i<100;i++){await e.queue.tick();parent=await e.api('program-read',{programId:f.p.programId},f.identity);if(['FAILED','INVALIDATED','PARTIAL'].includes(parent.body.status))break;await pause(40);}
 assert.equal(parent.status,200);assert(['FAILED','INVALIDATED','PARTIAL'].includes(parent.body.status));
 const durable=(await e.admin.query('SELECT status,reason FROM finnor_os.p2_requests WHERE id=$1',[id])).rows[0];assert.equal(durable.status,'INVALIDATED');assert.equal(durable.reason,'P2_PARENT_PROGRAM_WITHOUT_ACCEPTED_DELIVERY');
 const read=await e.api('compute-search-read',{searchId:id},f.identity),units=(await e.admin.query('SELECT id,status FROM finnor_os.p2_units WHERE search_id=$1',[id])).rows;
 await f.artifact('parent-preparation-failure-before-assertions.json',{parent,read,units});
 assert.equal(read.status,200);assert(['FAILED','INVALIDATED'].includes(read.body.status));assert.equal(read.body.plan.incumbent,null);assert.equal(read.body.plan.costs.physicalAttempts,0);assert.equal(units.length,0);assert.equal(read.body.reason,'P2_PARENT_PROGRAM_WITHOUT_ACCEPTED_DELIVERY');
 return {dir:f.dir,status:read.body.status,parentStatus:parent.body.status};
}
export async function recoveryCurrentness(e:any) {
 const preparationFailure=await parentPreparationFailure(e);
 const f=await prepared(e),a=ok(f.submitted,202);const cancel=ok(await e.api('compute-search-cancel',{searchId:a.searchId},f.identity));assert.equal(cancel.status,'CANCELLED');await e.queue.tick();const current=ok(await e.api('compute-search-read',{searchId:a.searchId},f.identity));assert.equal(current.status,'CANCELLED');assert.equal(current.plan.incumbent,null);
 const changed=await receiveWork({tenantId:f.f.tenant,userId:f.f.principal,workId:f.p.workId,instruction:'Explicit changed liability mandate',channel:'console',idempotencyKey:randomUUID()});assert.notEqual(changed.workInputId,f.p.workRevision);const stale=ok(await e.api('compute-search-read',{searchId:a.searchId},f.identity));assert.equal(stale.status,'CANCELLED');assert.equal(stale.plan.incumbent,null);
 const rows=(await e.admin.query('SELECT kind,body FROM finnor_os.p2_events WHERE search_id=$1 ORDER BY created_at,id',[a.searchId])).rows;assert(rows.some((r:any)=>r.kind==='CANCELLED'));await f.artifact('durable-cancel-currentness.json',{a,cancel,current,changed,stale,rows});
 const crash=await submittedCrash(e);return {dir:f.dir,status:stale.status,crash,preparationFailure,qualification:'Actual cold submitted-attempt recovery; browser and independent economic gates separately required'};
}

async function submittedCrash(e:any){
 const calls:any[]=[];let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const server=await listening(createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({headers:req.headers,body:JSON.parse(raw),at:Date.now()});await gate;reply(res,JSON.parse(raw));}));
 let worker:any,cold:any,f:any,deferred:any[]=[];
 try{
  const config=await endpointConfig(e,[server]);f=await prepared(e,'ADAPTIVE',{deferSearch:true,requestedKinds:['MODEL_REFINE'],routeIds:['diagnostic']});await stage(e,[f]);deferred=await deferNative(e,[f]);const id=f.submitted.body.searchId;
  const before=(await e.admin.query('SELECT e.attempts_used,e.steps_used,e.deadline_at,e.max_attempts FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1',[f.p.programId])).rows[0];
  worker=child(e);await until(async()=>calls.length===1,30000);
  const submitted=(await e.admin.query("SELECT id,status,body FROM finnor_os.p2_attempts WHERE search_id=$1 AND status='SUBMITTED'",[id])).rows;assert.equal(submitted.length,1);assert.equal(calls[0].headers['x-finnor-attempt-id'],submitted[0].id);
  worker.kill();const killed=await worker.closed;assert.equal(killed.signal,'SIGKILL');await pause(4000);
  cold=child(e,{FINNOR_P2_CHILD_MODE:'RECONCILE',FINNOR_P2_CHILD_INPUT:JSON.stringify({...f.identity,searchId:id})});const recovered=await cold.closed;assert.equal(recovered.code,0,recovered.error);
  await f.artifact('cold-process-recovery-before-assertions.json',{submitted,killed,recovered,calls,config});
  const receipt=recovered.output.split('\n').filter(Boolean).map((s:string)=>{try{return JSON.parse(s);}catch{return {};}}).find((r:any)=>r.kind==='COLD_RECONCILIATION');assert(receipt);assert(receipt.recovered>=1);const delivery=(await e.admin.query('SELECT j.status,d.outcome FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.id=$1',[submitted[0].body.jobId])).rows;assert.equal(delivery.length,1);assert.equal(delivery[0].status,'quarantined');assert.equal(delivery[0].outcome,'reconciliation_required');
  const plan=receipt.results.find((r:any)=>r.operation==='compute-search-read');assert.equal(plan.status,200);assert.equal(plan.body.status,'WAITING');assert.equal(plan.body.plan.incumbent,null);assert.equal(plan.body.plan.outstanding.length,1);assert.equal(plan.body.plan.outstanding[0].status,'UNKNOWN');assert.equal(calls.length,1);assert.equal(plan.body.plan.costs.physicalAttempts,1);
  const retained=(await e.admin.query('SELECT a.status,a.body,e.attempts_used,e.steps_used,g.spent,w.active FROM finnor_os.p2_attempts a JOIN finnor_os.p1_requests p ON p.id=$2 JOIN finnor_os.p1_episodes e ON e.id=p.episode_id JOIN finnor_os.p2_grant_usage g ON g.grant_digest=a.body->>\'grantDigest\' AND g.tenant_id=a.tenant_id JOIN finnor_os.p2_endpoint_windows w ON w.endpoint_key=a.endpoint_key WHERE a.search_id=$1',[id,f.p.programId])).rows;assert.equal(retained.length,1);assert.equal(retained[0].status,'UNKNOWN');assert.equal(retained[0].attempts_used,before.attempts_used+1);assert.equal(Number(retained[0].spent),1);assert.equal(retained[0].active,1);
  const cancelled=ok(await e.api('compute-search-cancel',{searchId:id},f.identity));assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.plan.outstanding.length,1);
  release();await pause(100);const late=ok(await e.api('compute-search-read',{searchId:id},f.identity));assert.equal(late.plan.incumbent,null);assert.equal(late.plan.outstanding[0].status,'UNKNOWN');assert.equal(calls.length,1);
  const events=(await e.admin.query('SELECT kind,body FROM finnor_os.p2_events WHERE search_id=$1 ORDER BY created_at,id',[id])).rows;assert(events.some((r:any)=>r.kind==='RECOVERY_RECONCILED'));
  const observed={config,before,delivery,disposableSchedulingFault:deferred,submitted,killed,recovered,receipt,retained,cancelled,late,calls,events,unavailable:'Provider settlement receipt and actual dollars remain unavailable; no assertion of free or completed work'};await f.artifact('submitted-crash-cold-recovery.json',observed);return {dir:f.dir,killedPid:killed.pid,coldPid:recovered.pid,unknownAttempts:late.plan.outstanding.length,retainedDebit:retained[0].spent};
 }finally{release();for(const c of [worker,cold].filter(Boolean)){if(c.process.exitCode===null)c.kill();}if(deferred.length)await releaseNative(e,deferred);delete process.env.FINNOR_P2_ENDPOINT_CONFIG;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}

export async function browserStory(e:any){
 const f=await prepared(e,'ADAPTIVE',{deferSearch:true,beforeFit:async(f:any)=>{
  const {createEmployeeConversationThread}=await import('@finnor/db');
  const thread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'P2 original owner-bound computation'}),otherThread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'P2 other thread with no allocated Work'});
  f.browser={canvasRoot:f.root,thread,otherThread};
 }});
 await (await import('./browser-fixture.mts')).browserFixture({...e,f});
 const receipt=JSON.parse(await readFile(join(e.evidence,'browser','run','results.json'),'utf8'));assert.equal(receipt.status,'PASS_LOCAL',JSON.stringify(receipt.steps));assert.equal(receipt.steps.length,9);return {dir:join(e.evidence,'browser'),steps:receipt.steps,profile:receipt.profile};
}
