/** Failure-first M2 stories. Only genuine owner/API/queue/SQL/artifact boundaries.
 * Independent oracle lives in reference.py and imports no production estimator. */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {prepared,finish} from '../p2/stories.mts';
import {allocationRef} from '@finnor/epistemic-runtime';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {receiveWork,acquireComputeResourceLeases,releaseComputeResourceLeases,withDatabaseExecutionDeadline} from '@finnor/db';
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort((a,b)=>a.localeCompare(b)).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const terms={schema:'finnor.s4.finite-deliberation-terms.v1',scope:'PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS',lossWithoutQualifiedResult:100,lossWithQualifiedResult:0,nativeAttemptCost:1,controllerMsCost:.001,delayMsCost:0,unit:'USD',qualification:'SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH'};
async function fixture(e:any,extra:any={}){
 const f=await prepared(e,'ADAPTIVE',{deferSearch:true,beforePolicy:async(f:any)=>{
  const {ref,...body}=f.mandate;body.utility={...body.utility,deliberation:{...terms,...extra.terms}};
  f.mandate={...body,ref:allocationRef('BUSINESS_OWNER','mandate',body,'economic-mandate-v1')};
 },...extra});
 return f;
}
const request=(f:any,extra:any={})=>({...f.search,schema:'finnor.deliberation-request.v1',valueEvidenceRef:null,...extra});
async function done(e:any,f:any,extra:any={}){
 const accepted=ok(await e.api('deliberation-submit',request(f,extra),f.identity),202);
 const result=await finish(e,{...accepted,programId:f.p.programId,identity:f.identity});
 const policy=ok(await e.api('deliberation-read',{searchId:accepted.searchId},f.identity));
 await f.artifact('m2-completed-policy.json',{accepted,result,policy});return {accepted,result,policy};
}
async function originalJoin(e:any){
 const f=await prepared(e,'ADAPTIVE',{deferSearch:true}),a=ok(await e.api('deliberation-submit',request(f),f.identity),202);
 const replay=ok(await e.api('deliberation-submit',request(f),f.identity),202);assert.equal(a.searchId,replay.searchId);
 const result=await finish(e,{...a,programId:f.p.programId,identity:f.identity}),read=ok(await e.api('deliberation-read',{searchId:a.searchId},f.identity));
 assert.equal(result.program.status,'TESTED');
 const sql=(await e.admin.query('SELECT 120::numeric-70::numeric-7::numeric equity,trim_scale(70::numeric/20::numeric)::text leverage')).rows[0];
 assert.equal(result.program.program.result.values.netEquity.value,sql.equity);assert.equal(result.program.program.result.values.leverage.value,sql.leverage);
 const p=read.policy;for(const field of ['policyRequest','computeGrant','frontier','metacontroller','nextWork','marginalValueEvidence','incumbent','stop','outstandingCosts'])assert(field in p,field);
 assert.equal(p.envelope.producerAdmission,null);assert.equal(p.envelope.executionAuthorityGranted,false);assert.equal(p.projection.incumbent.values.netEquity.value,'43');
 const runs=(await e.admin.query('SELECT body,digest FROM finnor_os.m2_module_runs WHERE search_id=$1 ORDER BY created_at,id',[a.searchId])).rows;
 assert(runs.length>=2);assert(runs.every((r:any)=>r.body.executed===true&&r.body.moduleDigest===p.metacontroller.contentDigest&&r.body.outputDigest));
 assert.equal(p.projection.stop.heuristic,true);assert.equal(p.projection.outstandingCosts.usd,null);
 const download=ok(await e.api('program-artifact',{programId:f.p.programId},f.identity));assert.equal(createHash('sha256').update(Buffer.from(download.bytesBase64,'base64')).digest('hex'),download.sha256);
 const parsed=spawnSync(process.env.FINNOR_S3_PYTHON!,['-c','import base64,io,json,sys,zipfile,xml.etree.ElementTree as E; d=json.load(sys.stdin); z=zipfile.ZipFile(io.BytesIO(base64.b64decode(d["bytesBase64"]))); r=E.fromstring(z.read("word/document.xml")); ns={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}; print(json.dumps(["".join(p.itertext()) for p in r.findall(".//w:p",ns)]))'],{input:JSON.stringify(download),encoding:'utf8'});
 assert.equal(parsed.status,0,parsed.stderr);const paragraphs:string[]=JSON.parse(parsed.stdout);assert(paragraphs.some(p=>p.startsWith('netEquity: 43 currency USD;')));assert(paragraphs.some(p=>p.startsWith('leverage: 3.5 multiple;')));assert(!paragraphs.some(p=>p.startsWith('netEquity: 50 currency USD;')));
 await f.artifact('independent-original-P1-observers.json',{sql,read,result,download,paragraphs,runs});
 return {dir:f.dir,moduleRuns:runs.length,originalResult:sql,heuristic:true};
}
async function finiteOwnerAndChains(e:any){
 const f=await fixture(e),{accepted,result,policy}=await done(e,f),p=policy.policy;
 assert.equal(p.utilityConversion.unit,'USD');assert.equal(p.utilityConversion.scope,terms.scope);assert.equal(p.projection.outstandingCosts.usd,null);
 const runs=(await e.admin.query('SELECT body FROM finnor_os.m2_module_runs WHERE search_id=$1 ORDER BY created_at,id',[accepted.searchId])).rows.map((r:any)=>r.body);
 const first=runs.find((r:any)=>r.input&&!r.input.incumbentQualified);assert(first);
 const input={units:first.input.units.map((u:any)=>({id:u.id,kind:u.kind,status:u.status,prerequisites:u.prerequisites,cost:1,durationMs:0})),remainingAttempts:8,remainingMs:300000,incumbentQualified:false,lossGap:100,delayPerMs:0,controllerCallCost:1};
 const oracle=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(e.repo,'finnor-os/scripts/m2/reference.py')],{input:JSON.stringify(input),encoding:'utf8'});assert.equal(oracle.status,0,oracle.stderr);const reference=JSON.parse(oracle.stdout);
 assert.equal(reference.bestNet,'96');assert(first.output.chains.some((c:any)=>c.unitIds.length>=2&&c.conditionalGain===100&&c.netUpper===96));
 assert.equal(p.projection.stop.heuristic,false);assert.equal(p.projection.stop.bound.upper,0);assert.equal(p.projection.stop.bound.scope,terms.scope);
 assert.equal(p.projection.incumbent.values.netEquity.value,'43');assert.equal(result.program.status,'TESTED');
 await f.artifact('finite-independent-chain-reference.json',{input,reference,runs,policy});return {dir:f.dir,bestNet:reference.bestNet,technicalStop:p.projection.stop};
}
async function privacyAndCurrentness(e:any){
 const f=await fixture(e),d=await done(e,f),id=d.accepted.searchId;
 const foreign=await e.api('deliberation-read',{searchId:id},{tenant:e.foreignTenant,actor:e.foreignActor});assert.equal(foreign.status,404);assert(!JSON.stringify(foreign).includes('43'));
 const changed=await receiveWork({tenantId:f.f.tenant,userId:f.f.principal,workId:f.p.workId,instruction:'Owner changes current deliberation objective',channel:'console',idempotencyKey:randomUUID()});
 assert.notEqual(changed.workInputId,f.p.workRevision);const stale=ok(await e.api('deliberation-read',{searchId:id},f.identity));assert.equal(stale.status,'INVALIDATED');assert.equal(stale.policy.projection.incumbent,null);assert(stale.policy.projection.outstandingCosts.retained);
 const histories=(await e.admin.query('SELECT revision,body FROM finnor_os.m2_policies WHERE search_id=$1 ORDER BY revision',[id])).rows;assert(histories.length>=2);assert(histories.some((r:any)=>r.body.projection.incumbent?.values.netEquity.value==='43'));
 await f.artifact('privacy-currentness-history.json',{foreign,changed,stale,histories});return {dir:f.dir,currentStatus:stale.status,history:histories.length};
}
async function calibrationReader(e:any){
 const f=await fixture(e);const rows=[];
 for(const split of ['TRAIN','CALIBRATION','HELD_OUT'])for(let i=0;i<24;i++)rows.push({id:split+'-'+i,split,company:split+'-company-'+i,timeBlock:split+'-time',sourceLineage:split+'-source-'+i,checkerLineage:split+'-checker-'+i,ancestry:split+'-ancestry-'+i,modelLineage:split+'-model-'+i,regime:'finite-local',taskStratum:'mechanics',mechanism:'EXECUTE_CHECK_CHAIN',route:'P1_NATIVE',featuresKnownAt:'2026-01-01T00:00:00.000Z',outcomeKnownAt:'2026-01-02T00:00:00.000Z',beforeLoss:100,afterLoss:i%4===0?100:0,completed:i%4!==0,independentlyAccepted:i%4!==0,elapsedMs:10+i,nativeAttempts:2,costUSD:null,oracleRef:{owner:'PUBLIC_EXACT_REFERENCE',id:split+'-ref-'+i,version:'fixture-v1',contentDigest:digest({split,i})}});
 const dataset={schema:'finnor.m2.public-decision-loss-dataset.v1',scope:'PUBLIC_FINITE_MECHANICS_UNADMITTED',lossUnit:'USD',objectiveRef:f.f.mandate.utilityRef,predeclaredBinFields:['taskStratum','regime','mechanism','route'],rows};
 const source=await createEvidenceSource(f.f.tenant,{sourceKey:'m2-labels-'+randomUUID(),sourceType:'manual',title:'Public finite independent-reference labels'});
 const version=await appendEvidenceVersion(f.f.tenant,source.id,{content:JSON.stringify(dataset,null,2),snapshot:{worldRoot:f.f.root,dataset},asOf:new Date('2026-01-02T00:00:00.000Z')});
 const input={root:f.f.root,workId:f.p.workId,policyRequest:f.policy.ref,sourceId:source.id,versionId:version.versionId,datasetDigest:digest(dataset)};
 const report=ok(await e.api('deliberation-calibrate',input,f.identity));assert.equal(report.report.heldOut.population,24);assert.equal(report.report.heldOut.failed,6);assert.equal(report.report.fieldRoutingAdmitted,false);assert(report.report.heldOut.decisionLossScore!==null);
 const leak=structuredClone(dataset);leak.rows.find((r:any)=>r.split==='HELD_OUT')!.ancestry=leak.rows[0]!.ancestry;
 const bad=await appendEvidenceVersion(f.f.tenant,source.id,{content:JSON.stringify(leak,null,2),snapshot:{worldRoot:f.f.root,dataset:leak},asOf:new Date('2026-01-02T00:00:00.000Z')});
 const refused=ok(await e.api('deliberation-calibrate',{...input,versionId:bad.versionId,datasetDigest:digest(leak)},f.identity));assert.equal(refused.report.status,'REFUSED_SPLIT_LEAKAGE');
 await f.artifact('calibration-real-source-reader.json',{input,report,refused,dataset});return {dir:f.dir,report:report.report.status,failedIncluded:6};
}
async function boundedRequests(e:any){
 const f=await prepared(e,'ADAPTIVE',{deferSearch:true});const tooMany=await e.api('deliberation-submit',request(f,{limits:{maxUnits:50,maxParallel:2}}),f.identity);assert.equal(tooMany.status,400);
 const forged=await e.api('deliberation-submit',request(f,{computeGrant:{...f.allocation.certificate.ref,contentDigest:'0'.repeat(64)}}),f.identity);assert.equal(forged.status,422);
 const protectedRequest=await e.api('deliberation-submit',request(f,{mode:'protected'}),f.identity);assert.equal(protectedRequest.status,422);
 const physical=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.p2_attempts WHERE tenant_id=$1',[f.f.tenant])).rows[0].n;assert.equal(physical,0);
 await f.artifact('bounded-no-authority-no-physical-call.json',{tooMany,forged,protectedRequest,physical});return {dir:f.dir,physical};
}
export async function runRegisteredCases(e:any,test:any){
 await test('M2-A-original-P1-executed-module',{},'Actual original Work/P1/SQL/artifact, all nine fields, repeated executed immutable module and truthful heuristic',()=>originalJoin(e));
 await test('M2-B-owner-finite-complementary-chain-stop',terms,'Authentic S4 conversion; execute+verify complementary chain independently enumerated; model-relative0 bound after current accepted incumbent',()=>finiteOwnerAndChains(e));
 await test('M2-C-current-privacy-immutable-history',{},'Foreign authenticated principal receives no private value; new Work revision invalidates current incumbent and retains history/cost',()=>privacyAndCurrentness(e));
 await test('M2-D-real-source-calibration-leakage',{},'Real source reader, predeclared train/calibration/held-out loss/completion/acceptance, failures retained and ancestry leakage refused',()=>calibrationReader(e));
 await test('M2-E-bounded-decode-grant-protected-refusal',{},'Fifty-call/frontier request, forged grant and protected request refuse before physical invocation',()=>boundedRequests(e));
 await test('M2-F-fifty-correlated-wordings-operative-source',{},'Fifty historical wording variants share one premise; actual cheap source object inspection discovers a material clause, withholds old utility/incumbent and prepares a real S4 request',()=>sourcePremiseStops(e));
 await test('M2-G-frozen-decision-loss-prediction-executed',{},'Permissioned frozen public loss evidence reaches the actual module: redundant unverified work has no admissible gain while a material execute/check chain has separately scored gain, completion, acceptance and uncertainty; corrected source invalidates cached support',()=>calibratedExecution(e));
 await test('M2-I-whole-reader-SQL-cancellation',{},'A real blocked policy SELECT obeys an attenuated350ms whole transport deadline, returns before1250ms, physically ceases waiting before lock release, and preserves the previously qualified incumbent',()=>wholeReaderDeadline(e));
 await test('M2-J-native-contract-discovery-registry',{},'Actual secured OpenAPI, generated client and capability discovery contain all nine M2 operations, preserve six P2 operations, classify mutations/control correctly and retain no autonomous model authority',()=>contractDiscovery(e));
 await test('M2-K-release-server-cancellation-not-only-response',{},'A blocked exact-owned lease release obeys1500ms, returns before2250ms, leaves expiry truthful and has no actual server query waiting before the original lock is released',()=>releaseServerCancellation(e));
 await test('M2-L-transport-body-rate-and-runtime-authorization',{},'Real body streaming, durable rate SQL and runtime authorization SQL are bounded before dispatch, cancelled physically and never left waiting on the original held lock',()=>transportPreparation(e));
 await test('M2-M-exact-work-code-and-complete-cost-history',{},'Actual queued work carries the original episode/input/source/result/checker/admission/lifecycle contract; final immutable cost component accounts for all actual SQL attempts and measured compiler preparation; producer identity is M2 code',()=>completePolicyContract(e));
 await test('M2-N-immutable-exact-missing-owner-requests',{},'Absent conversion, independent field labels, billing, protected admission and producer joins are exact immutable evidence-reader requests bound to current Work/utility/source/grant, never issued authority',()=>missingOwnerRequests(e));
 await test('M2-O-real-bearer-auth-HTTP-and-bootstrap-SQL-deadline',{},'Real cryptographically verified local bearer authentication physically cancels held auth HTTP and bootstrap identity SQL inside350ms, before original release; healthy token remains accepted',()=>bearerPreparation(e));
 await test('M2-P-authoritative-stored-module-and-compiler-bytes',{},'Actual current module read equals immutable tenant-scoped stored bytes; ordinary mutations deny; independently corrupted disposable storage is refused, never silently replaced by freshly compiled bytes; the executed compiler implementation is content-bound',()=>authoritativeModule(e));
 await test('M2-Q-actual-worker-whole-owner-IO-deadline',{},'A real protocol2 durable delivery under an attenuated original deadline cancels blocked owner SQL before independent unlock, returns before1250ms, admits no physical work and preserves original budgets; current reconciliation records the failed pre-admission cut',()=>workerOwnerDeadline(e));
 await test('M2-S-real-model-refinement-original-frontier-budget',{},'An actual permitted loopback model supplies a distinct P1 structure under the original episode; native/check coverage and complete cost survive controller overhead within8 logical units and the same8 physical attempts, with no opinion promoted to incumbent',()=>modelRefinement(e));
 if(process.env.FINNOR_M2_CASE_FILTER?.includes('M2-R'))await test('M2-R-actual-bearer-Work-Canvas',{},'Actual bearer/Work/P2 queue/module/SQL and keyboard/mobile/reload/current privacy trajectory, scoped finite value and truthful liabilities',()=>browserStory(e));
}
async function workerOwnerDeadline(e:any){
 const f=await fixture(e),accepted=ok(await e.api('deliberation-submit',request(f),f.identity),202);
 const {JobQueue}=await import('../../apps/worker/src/queue'),contracts=(await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS;
 const stage=new JobQueue('m2-authentic-source-stage-'+randomUUID(),3);
 stage.register('run_harness_program_v1',(await import('../../packages/private-equity/src/program-synthesis/worker')).runHarnessProgramJob,contracts.run_harness_program_v1);
 stage.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,contracts.run_evidence_derivation_v1);
 for(let i=0;i<80;i++){await stage.tick();const s=(await e.admin.query('SELECT context FROM finnor_os.p2_requests WHERE id=$1',[accepted.searchId])).rows[0];if(s?.context)break;await new Promise(r=>setTimeout(r,25));}
 const job=(await e.admin.query("SELECT j.id,j.payload,j.status,j.protocol_version FROM finnor_os.jobs j JOIN finnor_os.p2_units u ON u.id=(j.payload->>'unitId')::uuid WHERE u.search_id=$1 AND j.type='run_compute_search_unit_v1' AND j.status='queued' ORDER BY j.run_at,j.id LIMIT 1",[accepted.searchId])).rows[0];assert(job);
 const before=(await e.admin.query('SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1',[f.p.programId])).rows[0];
 // Independent diagnostic attenuation of this actual trusted delivery. The
 // original parent/owner budget and deadline remain unchanged in storage.
 const attenuated=new Date(Date.now()+350).toISOString();
 await e.admin.query("UPDATE finnor_os.jobs SET payload=jsonb_set(payload,'{originalDeadlineAt}',$2::jsonb) WHERE id=$1 AND status='queued'",[job.id,JSON.stringify(attenuated)]);
 await e.admin.query('BEGIN');await e.admin.query('LOCK TABLE finnor_os.p2_requests IN ACCESS EXCLUSIVE MODE');
 let held=true;const emergency=setTimeout(()=>{held=false;void e.admin.query('ROLLBACK');},1600);let observed:any;
 try{
  const began=performance.now();await e.queue.tick();
  const waiting=(await e.admin.query("SELECT pid,state,wait_event,left(query,220) query FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%p2_requests%'")).rows;
  observed={job,attenuated,elapsedMs:performance.now()-began,lockHeldAtReturn:held,waiting};
  await f.artifact('worker-owner-deadline-before-assertions.json',observed);
  assert(observed.elapsedMs<1250,'Actual worker owner IO must obey the whole attenuated deadline');assert.equal(held,true);assert.equal(waiting.length,0);
 }finally{clearTimeout(emergency);if(held)await e.admin.query('ROLLBACK');}
 const attempts=(await e.admin.query('SELECT id,status,body FROM finnor_os.p2_attempts WHERE search_id=$1',[accepted.searchId])).rows,after=(await e.admin.query('SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1',[f.p.programId])).rows[0];
 assert.equal(attempts.length,0);assert.equal(after.attempts_used,before.attempts_used);assert.equal(new Date(after.deadline_at).getTime(),new Date(before.deadline_at).getTime());
 assert.equal(Date.parse(job.payload.originalDeadlineAt),new Date(before.deadline_at).getTime(),'Producer must bind the authentic original absolute deadline');
 const recoveryResponse=await e.api('deliberation-reconcile',{searchId:accepted.searchId},f.identity);
 await f.artifact('worker-owner-deadline-recovery-response.json',{recoveryResponse,jobs:(await e.admin.query('SELECT id,status,last_error,payload FROM finnor_os.jobs WHERE id=$1',[job.id])).rows});
 const recovered=ok(recoveryResponse);
 const units=(await e.admin.query('SELECT id,kind,status,result FROM finnor_os.p2_units WHERE search_id=$1',[accepted.searchId])).rows;
 assert(units.some((u:any)=>u.id===job.payload.unitId&&u.status==='FAILED'&&u.result?.predicate==='P2_PRE_ADMISSION_DELIVERY_FAILED'));
 const healthy=await finish(e,{...accepted,programId:f.p.programId,identity:f.identity});assert.equal(healthy.program.status,'TESTED');assert.equal(healthy.program.program.result.values.netEquity.value,'43');
 const finalEpisode=(await e.admin.query('SELECT * FROM finnor_os.p1_episodes WHERE id=$1',[before.id])).rows[0];assert.equal(finalEpisode.max_attempts,before.max_attempts);assert.equal(new Date(finalEpisode.deadline_at).getTime(),new Date(before.deadline_at).getTime());assert(finalEpisode.attempts_used<=before.max_attempts);
 await f.artifact('worker-owner-deadline-reconciliation.json',{observed,before,after,attempts,recovered,units,healthy,finalEpisode});return {dir:f.dir,observed,physicalAttemptsBeforeRecovery:attempts.length,reconciledPreAdmission:true,healthyStatus:healthy.program.status};
}
async function modelRefinement(e:any){
 const calls:any[]=[],previous=process.env.FINNOR_P2_ENDPOINT_CONFIG;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384){res.writeHead(413);res.end();return;}}
  const request=JSON.parse(raw),targets=structuredClone(request.accepted.targets);
  targets[0].expression={kind:'subtract',left:{kind:'subtract',left:{kind:'input',key:'EV'},right:{kind:'input',key:'liability'}},right:{kind:'input',key:'debt'}};
  const response={model:'m2-diagnostic-refiner-v1',usage:{inputTokens:8,outputTokens:4},finishReason:'stop',targets};
  calls.push({attemptId:req.headers['x-finnor-attempt-id'],request,response,at:new Date().toISOString()});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));
 });await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
 try{
  const address=server.address();assert(address&&typeof address!=='string');
  const config={schema:'finnor.p2.endpoint-config.v1',endpoints:[{id:'m2-refinement',kind:'DIAGNOSTIC_MODEL',provider:'LOCAL_HTTP_FIXTURE',model:'m2-diagnostic-refiner-v1',region:null,tier:'ordinary-diagnostic',url:`http://127.0.0.1:${address.port}`,limits:{concurrency:1,rpm:8,inputTpm:16384,outputTpm:64,tpd:32768,maxOutputTokens:16},source:'PREDECLARED_LOCAL_POLICY_NOT_PROVIDER_QUOTA',windowMs:60000,expiresAt:new Date(Date.now()+600000).toISOString(),price:null}]};
  const path=join(e.evidence,'m2-refinement-endpoint.json');await writeFile(path,JSON.stringify(config));process.env.FINNOR_P2_ENDPOINT_CONFIG=path;
  const f=await fixture(e,{requestedKinds:['MODEL_REFINE'],routeIds:['m2-refinement']}),d=await done(e,f);
  const units=(await e.admin.query('SELECT id,kind,status,attempts,body,result FROM finnor_os.p2_units WHERE search_id=$1 ORDER BY created_at,id',[d.accepted.searchId])).rows;
  const attempts=(await e.admin.query('SELECT id,status,body FROM finnor_os.p2_attempts WHERE search_id=$1 ORDER BY created_at,id',[d.accepted.searchId])).rows;
  const episode=(await e.admin.query('SELECT * FROM finnor_os.p1_episodes WHERE id=$1',[d.result.program.program.bounds.episodeId])).rows[0];
  const oracle=(await e.admin.query('SELECT 120::numeric-70::numeric-7::numeric equity,trim_scale(70::numeric/20::numeric)::text leverage')).rows[0];
  await f.artifact('live-refinement-before-assertions.json',{config,calls,d,units,attempts,episode,oracle});
  assert.equal(calls.length,1);assert.equal(d.result.program.status,'TESTED');assert.equal(d.result.program.program.result.values.netEquity.value,oracle.equity);assert.equal(d.result.program.program.result.values.leverage.value,oracle.leverage);
  assert.equal(d.result.program.program.modules.length,3,'The real distinct refinement must fit the original frontier with controller overhead');
  assert(units.some((u:any)=>u.kind==='MODEL_REFINE'&&u.status==='COMPLETED'));assert(attempts.some((a:any)=>a.body.actualModel==='m2-diagnostic-refiner-v1'&&a.status==='COMPLETED'));
  assert(units.length<=8);assert(episode.attempts_used<=8);assert.equal(episode.max_attempts,8);assert.equal(episode.max_steps,4096);
  const incumbent=d.policy.policy.projection.incumbent;assert(incumbent);assert(units.some((u:any)=>u.kind==='VERIFY_P1'&&u.status==='COMPLETED'&&u.body.moduleId===incumbent.moduleId&&u.result.checks.every((c:any)=>c.status==='PASS')));
  return {dir:f.dir,actualModelCalls:calls.length,unitCount:units.length,parentAttempts:episode.attempts_used,controllerRuns:d.policy.policy.projection.outstandingCosts.controllerRuns,qualifiedResult:oracle};
 }finally{if(previous===undefined)delete process.env.FINNOR_P2_ENDPOINT_CONFIG;else process.env.FINNOR_P2_ENDPOINT_CONFIG=previous;server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
}
async function browserStory(e:any){
 const f=await fixture(e,{beforeFit:async(f:any)=>{
  const {createEmployeeConversationThread}=await import('@finnor/db');
  const thread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'M2 current owner-bound deliberation'}),otherThread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'M2 other thread without allocated Work'});
  f.browser={canvasRoot:f.root,thread,otherThread};
 }});
 await (await import('../p2/browser-fixture.mts')).browserFixture({...e,f,delayedOperation:'deliberation-projection'});
 const receipt=JSON.parse(await readFile(join(e.evidence,'browser/run/results.json'),'utf8'));assert.equal(receipt.status,'PASS_LOCAL',JSON.stringify(receipt.steps));assert.equal(receipt.steps.length,9);return {dir:join(e.evidence,'browser'),steps:receipt.steps,profile:receipt.profile};
}
async function authoritativeModule(e:any){
 const f=await fixture(e),d=await done(e,f),searchId=d.accepted.searchId,ref=d.policy.policy.metacontroller;
 const stored=(await e.admin.query('SELECT body,digest FROM finnor_os.m2_modules WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[f.f.tenant,f.f.principal,ref.contentDigest])).rows[0];assert(stored);
 const healthy=ok(await e.api('deliberation-module-read',{searchId},f.identity));assert.deepEqual(healthy.body,stored.body);assert.equal(digest(healthy.body),stored.digest);
 let ordinaryMutationDenied:any;
 try{await (await import('../../packages/private-equity/src/evidence-execution/store')).tx(f.f.ctx,c=>c.query('UPDATE finnor_os.m2_modules SET body=body WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[f.f.tenant,f.f.principal,stored.digest]));}
 catch(error){ordinaryMutationDenied={code:(error as any).code,causeCode:(error as any).cause?.code,message:String(error)};}
 assert(ordinaryMutationDenied,'The ordinary product connection must not mutate immutable executable storage');
 let corruption:any;
 // Fault injection touches only this disposable database after preserving the
 // authoritative preimage. Product code cannot disable the immutable trigger.
 await e.admin.query('ALTER TABLE finnor_os.m2_modules DISABLE TRIGGER m2_immutable');
 try{
  const changed={...stored.body,emitted:stored.body.emitted+'\n/* independent storage corruption */'};
  await e.admin.query('UPDATE finnor_os.m2_modules SET body=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[f.f.tenant,f.f.principal,stored.digest,JSON.stringify(changed)]);
  corruption=await e.api('deliberation-module-read',{searchId},f.identity);
 }finally{
  await e.admin.query('UPDATE finnor_os.m2_modules SET body=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[f.f.tenant,f.f.principal,stored.digest,JSON.stringify(stored.body)]);
  await e.admin.query('ALTER TABLE finnor_os.m2_modules ENABLE TRIGGER m2_immutable');
 }
 await f.artifact('authoritative-module-before-assertions.json',{ref,stored,healthy,ordinaryMutationDenied,corruption});
 assert.equal(corruption.status,422,'Corrupt stored bytes must fail rather than be substituted');
 assert.equal(corruption.body.predicate,'M2_STORED_MODULE_DIGEST_MISMATCH');
 assert(healthy.body.compiler.implementationDigest,'Compiler implementation bytes must be bound');
 // Resolve from the installed backend, independently of the producer manifest.
 const actual=createHash('sha256').update(await readFile(join(e.repo,'finnor-os/node_modules/typescript/lib/typescript.js'))).digest('hex');
 assert.equal(healthy.body.compiler.implementationDigest,actual);
 const restored=ok(await e.api('deliberation-module-read',{searchId},f.identity));assert.deepEqual(restored.body,stored.body);
 return {dir:f.dir,corruptionPredicate:corruption.body.predicate,compilerDigest:actual};
}
async function bearerPreparation(e:any){
 const {POST}=await import('../../apps/api/app/api/company-brain/[operation]/route'),secret=randomBytes(32),identity=(await e.admin.query('SELECT email FROM finnor_os.users WHERE id=$1 AND tenant_id=$2',[e.actor,e.tenant])).rows[0];
 const previous={AUTH_DEV_BYPASS:process.env.AUTH_DEV_BYPASS,SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY};
 let fast=false,held=true,cancelled=false,release!:()=>void,received=0;const gate=new Promise<void>(yes=>release=yes);
 const server=createServer(async(req,res)=>{received++;res.once('close',()=>{if(!res.writableEnded)cancelled=true;});
  const token=String(req.headers.authorization??'').replace(/^Bearer /,''),[h,p,s]=token.split('.');let valid=false;
  try{const actual=Buffer.from(s!,'base64url'),expected=createHmac('sha256',secret).update(h+'.'+p).digest(),claims=JSON.parse(Buffer.from(p!,'base64url').toString());valid=actual.length===expected.length&&timingSafeEqual(actual,expected)&&claims.sub===e.actor&&claims.email===identity.email&&claims.exp>Date.now()/1000;}catch{}
  if(!fast)await gate;res.writeHead(valid?200:401,{'content-type':'application/json'});res.end(JSON.stringify(valid?{id:e.actor,email:identity.email,aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}:{msg:'Invalid signed token'}));
 });await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address() as {port:number},url='http://127.0.0.1:'+address.port;
 const encoded=(o:any)=>Buffer.from(JSON.stringify(o)).toString('base64url'),head=encoded({alg:'HS256',typ:'JWT'})+'.'+encoded({sub:e.actor,email:identity.email,aud:'authenticated',role:'authenticated',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,iss:url+'/auth/v1'}),token=head+'.'+createHmac('sha256',secret).update(head).digest('base64url');
 process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=url;process.env.SUPABASE_SERVICE_ROLE_KEY='disposable-local-auth-key';
 const headers={'content-type':'application/json',authorization:'Bearer '+token,'x-deliberation-deadline-ms':'350'},body=JSON.stringify({searchId:randomUUID()}),observations:any[]=[];
 const invoke=()=>POST(new Request('http://localhost/api/company-brain/deliberation-read',{method:'POST',headers,body}),{params:Promise.resolve({operation:'deliberation-read'})});
 const emergency=setTimeout(()=>{held=false;release();},1600);
 try{
  const started=performance.now(),response=await invoke();await new Promise(yes=>setTimeout(yes,25));observations.push({kind:'AUTH_HTTP',status:response.status,body:await response.json(),elapsedMs:performance.now()-started,held,cancelled,received});clearTimeout(emergency);release();fast=true;
  await e.admin.query('BEGIN');await e.admin.query('LOCK TABLE finnor_os.users IN ACCESS EXCLUSIVE MODE');let locked=true;
  const unlock=setTimeout(()=>{locked=false;void e.admin.query('ROLLBACK');},1600);
  try{const began=performance.now(),result=await invoke();observations.push({kind:'IDENTITY_SQL',status:result.status,body:await result.json(),elapsedMs:performance.now()-began,locked,waiting:(await e.admin.query("SELECT pid,wait_event,state,left(query,200) query FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%resolve_authenticated_identity%'")).rows});}finally{clearTimeout(unlock);if(locked)await e.admin.query('ROLLBACK');}
  const healthy=await invoke();observations.push({kind:'HEALTHY_VERIFIED_TOKEN',status:healthy.status,body:await healthy.json()});
  await writeFile(join(e.evidence,'bearer-preparation-before-assertions.json'),JSON.stringify({profile:'DISPOSABLE_LOCAL_AUTH_SERVICE_REAL_VERIFIED_BEARER_SQL_NOT_HOSTED_SUPABASE',observations},null,2));
  assert.equal(observations[0].status,413);assert(observations[0].elapsedMs<800);assert(observations[0].held);assert(observations[0].cancelled);
  assert.equal(observations[1].status,413);assert(observations[1].elapsedMs<800);assert(observations[1].locked);assert.equal(observations[1].waiting.length,0);assert.equal(healthy.status,404);
  return observations;
 }finally{clearTimeout(emergency);release();for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
}
async function transportPreparation(e:any){
 const {POST}=await import('../../apps/api/app/api/company-brain/[operation]/route');
 const headers={'content-type':'application/json','x-tenant-id':e.tenant,'x-user-id':e.actor,'x-deliberation-deadline-ms':'350'},body=JSON.stringify({searchId:randomUUID()}),observations:any[]=[];
 let cancelled=false,timer:ReturnType<typeof setTimeout>;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{'));timer=setTimeout(()=>{c.enqueue(new TextEncoder().encode(body.slice(1)));c.close();},1000);},cancel(){cancelled=true;clearTimeout(timer);}});
 const began=performance.now(),response=await POST(new Request('http://localhost/api/company-brain/deliberation-read',{method:'POST',headers,body:stream,duplex:'half'} as RequestInit),{params:Promise.resolve({operation:'deliberation-read'})});
 observations.push({kind:'BODY',status:response.status,body:await response.json(),elapsedMs:performance.now()-began,cancelled});
 for(const table of ['api_rate_limits','product_runtime_authority']){
  await e.admin.query('BEGIN');await e.admin.query('LOCK TABLE finnor_os.'+table+' IN ACCESS EXCLUSIVE MODE');
  let held=true;const emergency=setTimeout(()=>{held=false;void e.admin.query('ROLLBACK');},1800);
  try{
   const start=performance.now(),result=await POST(new Request('http://localhost/api/company-brain/deliberation-read',{method:'POST',headers,body}),{params:Promise.resolve({operation:'deliberation-read'})});
   const record={kind:table,status:result.status,body:await result.json(),elapsedMs:performance.now()-start,lockHeldAtResponse:held,waiting:(await e.admin.query("SELECT pid,wait_event,state,left(query,200) query FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",['%'+table+'%'])).rows};observations.push(record);
  }finally{clearTimeout(emergency);if(held)await e.admin.query('ROLLBACK');}
 }
 await writeFile(join(e.evidence,'transport-preparation-before-assertions.json'),JSON.stringify(observations,null,2));
 for(const record of observations){assert.equal(record.status,413,record.kind);assert(record.elapsedMs<800,record.kind);if(record.kind==='BODY')assert(record.cancelled);else{assert(record.lockHeldAtResponse);assert.equal(record.waiting.length,0);}}
 return observations;
}
async function completePolicyContract(e:any){
 const f=await fixture(e),accepted=ok(await e.api('deliberation-submit',request(f),f.identity),202);let queued:any;
 for(let i=0;i<30;i++){await e.queue.tick();queued=ok(await e.api('deliberation-read',{searchId:accepted.searchId},f.identity));if(queued.policy.nextWork.some((w:any)=>w.kind==='EXECUTE_P1'))break;}
 const episode=(await e.admin.query('SELECT p.episode_id,e.* FROM finnor_os.p1_requests p JOIN finnor_os.p1_episodes e ON e.id=p.episode_id WHERE p.id=$1',[f.p.programId])).rows[0];
 await f.artifact('exact-queued-work-before-assertions.json',{accepted,queued,episode});
 const unit=queued.policy.nextWork.find((w:any)=>w.kind==='EXECUTE_P1');assert(unit,'Actual queued execute unit required');
 assert.equal(unit.resources.episodeId,episode.episode_id);assert.equal(unit.resources.maxAttempts,Number(episode.max_attempts));assert.equal(Date.parse(unit.resources.deadlineAt),new Date(episode.deadline_at).getTime());
 assert.equal(unit.inputs.workRevision,f.p.workRevision);assert.equal(unit.inputs.acceptanceDigest,queued.policy.envelope.inputs.find((v:any)=>v.kind==='P1_ACCEPTANCE').digest);
 assert.equal(unit.expectedResult.kind,'NUMERICAL_VALUES');assert.equal(unit.checker.method,'POSTGRES_NUMERIC_ACCEPTED_EXPRESSION');assert.equal(unit.admission.executionAuthorityGranted,false);assert.equal(unit.lifecycle.reconcilePath,'/api/company-brain/deliberation-reconcile');
 const result=await finish(e,{...accepted,programId:f.p.programId,identity:f.identity}),current=ok(await e.api('deliberation-read',{searchId:accepted.searchId},f.identity)),module=ok(await e.api('deliberation-module-read',{searchId:accepted.searchId},f.identity));
 const attempts=(await e.admin.query('SELECT id,unit_id,status,body,digest FROM finnor_os.p2_attempts WHERE search_id=$1 ORDER BY created_at,id',[accepted.searchId])).rows;
 const cost=ok(await e.api('deliberation-evidence-read',{searchId:accepted.searchId,ref:current.policy.outstandingCosts},f.identity));
 await f.artifact('complete-cost-before-assertions.json',{result,current,module,attempts,cost});
 assert.equal(current.policy.envelope.codeDigest,module.body.producerCodeDigest);assert.notEqual(current.policy.envelope.codeDigest,current.policy.envelope.ownerRevisionVector.find((v:any)=>v.owner==='P1').ref.contentDigest);
 assert.equal(cost.evidence.history.length,attempts.length);assert.deepEqual(cost.evidence.history.map((a:any)=>a.attemptId).sort(),attempts.map((a:any)=>a.id).sort());
 for(const row of attempts){const record=cost.evidence.history.find((a:any)=>a.attemptId===row.id);assert.equal(record.status,row.status);assert.equal(record.receiptDigest,row.digest);assert.equal(record.costUSD,null);assert.equal(record.liabilityRetained,true);}
 assert(cost.evidence.preparation.some((p:any)=>p.kind==='M2_REGISTERED_SEMANTIC_COMPILATION'&&p.elapsedMs>0&&p.cpuMicros>0&&p.costUSD===null));assert.equal(cost.evidence.sunkChargedAgain,false);assert.equal(result.program.status,'TESTED');
 return {dir:f.dir,physicalAttempts:attempts.length,preparation:cost.evidence.preparation};
}
async function missingOwnerRequests(e:any){
 const f=await prepared(e,'ADAPTIVE',{deferSearch:true}),completed=await done(e,f),policy=completed.policy.policy,records:any[]=[];
 for(const ref of policy.ownerRequests){const read=ok(await e.api('deliberation-evidence-read',{searchId:completed.accepted.searchId,ref},f.identity));assert.equal(digest(read.evidence),ref.contentDigest);records.push(read.evidence);}
 await f.artifact('missing-owner-requests-before-assertions.json',{policy,records});
 for(const owner of ['S4','S2','S5','S6','S8','M3','M4','M5'])assert(records.some(r=>r.owner===owner),'Missing exact request for '+owner);
 for(const record of records){assert.equal(record.work.id,f.p.workId);assert.equal(record.work.revision,f.p.workRevision);assert.equal(record.originalComputeGrant.contentDigest,f.allocation.certificate.ref.contentDigest);assert.equal(record.authorityGranted,false);assert.equal(record.newFundingRequested,false);assert.equal(record.responseRef,null);assert(record.utilityRef?.contentDigest);assert(record.domain);}
 const m3=records.find(r=>r.owner==='M3'),m4=records.find(r=>r.owner==='M4');assert.equal(m3.observedContract.commit,'993860078282630b72144f2356f8257cef2221a5');assert.equal(m4.observedContract.commit,'ee9018546a587cea4500b7f331c3b073a18d71c7');assert.equal(m3.actualOwnerPort,null);assert.equal(m4.actualOwnerPort,null);
 return {dir:f.dir,requests:records.map(r=>({owner:r.owner,required:r.required,authorityGranted:r.authorityGranted}))};
}
async function releaseServerCancellation(e:any){
 const leases=await acquireComputeResourceLeases({resourceKeys:['native:p2'],requiredResourceKeys:['native:p2'],tenantId:e.tenant,workloadClass:'INTERACTIVE',ownerId:'M2-cancellation-proof-'+randomUUID()});
 const lease=leases[0]!,records:any[]=[];await e.admin.query('BEGIN');
 await e.admin.query('SELECT id FROM finnor_os.compute_resource_leases WHERE lease_token=$1 AND fence=$2 FOR UPDATE',[lease.token,lease.fence]);
 let held=true;const emergency=setTimeout(()=>{held=false;void e.admin.query('ROLLBACK');},3000);
 let error:any,began=performance.now();
 try{
  try{await withDatabaseExecutionDeadline(performance.now()+1500,()=>releaseComputeResourceLeases(leases,'m2-blocked-release'));}catch(e){error=e;}
  const elapsedMs=performance.now()-began,waiting=(await e.admin.query("SELECT pid,wait_event,state,left(query,240) query FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%compute_resource_leases%'")).rows;
  const retained=(await e.admin.query('SELECT released_at,expires_at,fence,owner_id FROM finnor_os.compute_resource_leases WHERE lease_token=$1',[lease.token])).rows[0];
  const observed={elapsedMs,error:error?{name:error.name,message:error.message}:null,lockHeldAtResponse:held,waiting,retained};records.push(observed);
  await writeFile(join(e.evidence,'release-server-cancellation-before-assertions.json'),JSON.stringify(observed,null,2));
  assert(error);assert(elapsedMs<2250);assert.equal(held,true);assert.equal(retained.released_at,null);assert.equal(waiting.length,0);
 }finally{
  clearTimeout(emergency);if(held)await e.admin.query('ROLLBACK');
  await releaseComputeResourceLeases(leases,'m2-test-cleanup');
  records.push({cleanup:(await e.admin.query('SELECT released_at,release_reason FROM finnor_os.compute_resource_leases WHERE lease_token=$1',[lease.token])).rows[0]});
  await writeFile(join(e.evidence,'release-server-cancellation-cleanup.json'),JSON.stringify(records,null,2));
 }
 return {records};
}
async function wholeReaderDeadline(e:any){
 const f=await fixture(e),finished=await done(e,f),id=finished.accepted.searchId;
 const {POST}=await import('../../apps/api/app/api/company-brain/[operation]/route');
 await e.admin.query('BEGIN');await e.admin.query('LOCK TABLE finnor_os.m2_policies IN ACCESS EXCLUSIVE MODE');
 let held=true;const emergency=setTimeout(()=>{held=false;void e.admin.query('ROLLBACK');},1600);
 let observed:any;
 try{
  const began=performance.now(),response=await POST(new Request('http://localhost/api/company-brain/deliberation-read',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.f.tenant,'x-user-id':f.f.principal,'x-deliberation-deadline-ms':'350'},body:JSON.stringify({searchId:id})}),{params:Promise.resolve({operation:'deliberation-read'})});
  observed={status:response.status,body:await response.json(),elapsedMs:performance.now()-began,lockHeldAtResponse:held};
  const waiting=(await e.admin.query("SELECT pid,wait_event,state,left(query,200) query FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%m2_policies%'")).rows;
  observed.waiting=waiting;await f.artifact('whole-reader-deadline-before-assertions.json',observed);
  assert.equal(response.status,413);assert(observed.elapsedMs<1250);assert.equal(held,true);assert.equal(waiting.length,0);
 }finally{clearTimeout(emergency);if(held)await e.admin.query('ROLLBACK');}
 const healthy=ok(await e.api('deliberation-read',{searchId:id},f.identity));assert.equal(healthy.status,'STOPPED');assert.equal(healthy.policy.projection.incumbent.values.netEquity.value,'43');
 await f.artifact('whole-reader-healthy-currentness.json',{observed,healthy});return {dir:f.dir,observed,preservedIncumbent:'43'};
}
async function contractDiscovery(e:any){
 const openapi=JSON.parse(await readFile(join(e.repo,'finnor-os/openapi.json'),'utf8')),manifest=JSON.parse(await readFile(join(e.repo,'src/lib/centropy/capability-manifest.generated.json'),'utf8')),client=await readFile(join(e.repo,'src/lib/jarvis/openapi-types.ts'),'utf8');
 const entries=Array.isArray(manifest)?manifest:manifest.capabilities??manifest.routes;
 const operations=['deliberation-submit','deliberation-read','deliberation-projection','deliberation-cancel','deliberation-resume','deliberation-reconcile','deliberation-calibrate','deliberation-evidence-read','deliberation-module-read'];
 const observed:any[]=[];
 for(const operation of operations){
  const path='/api/company-brain/'+operation,post=openapi.paths[path]?.post,entry=entries?.find((r:any)=>r.routePattern===path.slice(5));
  observed.push({operation,registered:!!post,discovered:!!entry,client:client.includes(path),classification:entry?.classification});
  await writeFile(join(e.evidence,'m2-native-registry-before-assertions.json'),JSON.stringify(observed,null,2));
  assert(post&&post.security?.length,'Actual secured OpenAPI missing '+operation);assert(entry&&client.includes(path),'Discovery/client missing '+operation);assert.equal(entry.modelCallable,false);assert.equal(entry.agentProduct,false);
  const expected=['cancel','resume','reconcile'].some(end=>operation.endsWith('-'+end))?'CONTROL':['deliberation-submit','deliberation-calibrate'].includes(operation)?'MUTATION':'READ';
  assert.equal(entry.classification,expected);
 }
 for(const operation of ['submit','read','projection','cancel','resume','reconcile'])assert(openapi.paths['/api/company-brain/compute-search-'+operation]?.post);
 const denied=await e.api('deliberation-module-read',{searchId:randomUUID()},{tenant:e.foreignTenant,actor:e.foreignActor});assert.equal(denied.status,404);
 return {operations:observed,preservedP2Operations:6,foreignModule:denied};
}
async function calibratedExecution(e:any){
 const f=await fixture(e),rows:any[]=[];
 for(const split of ['TRAIN','CALIBRATION','HELD_OUT'])for(const mechanism of ['EXECUTE_CHECK_CHAIN','UNVERIFIED_EXECUTION'])for(let i=0;i<24;i++){
  const useful=mechanism==='EXECUTE_CHECK_CHAIN',complete=!useful||i%4!==0;
  rows.push({id:split+'-'+mechanism+'-'+i,split,company:split+'-'+mechanism+'-company-'+i,timeBlock:split+'-time',sourceLineage:split+'-'+mechanism+'-source-'+i,checkerLineage:split+'-'+mechanism+'-checker-'+i,ancestry:split+'-'+mechanism+'-ancestry-'+i,modelLineage:split+'-'+mechanism+'-model-'+i,regime:'finite-local',taskStratum:'mechanics',mechanism,route:'P1_NATIVE',featuresKnownAt:'2026-01-01T00:00:00.000Z',outcomeKnownAt:'2026-01-02T00:00:00.000Z',beforeLoss:100,afterLoss:useful&&complete?0:100,completed:complete,independentlyAccepted:useful&&complete,elapsedMs:10+i,nativeAttempts:useful?2:1,costUSD:null,oracleRef:{owner:'PUBLIC_EXACT_REFERENCE',id:split+'-'+mechanism+'-ref-'+i,version:'fixture-v1',contentDigest:digest({split,mechanism,i})}});
 }
 const dataset={schema:'finnor.m2.public-decision-loss-dataset.v1',scope:'PUBLIC_FINITE_MECHANICS_UNADMITTED',lossUnit:'USD',objectiveRef:f.f.mandate.utilityRef,predeclaredBinFields:['taskStratum','regime','mechanism','route'],rows};
 const source=await createEvidenceSource(f.f.tenant,{sourceKey:'m2-prediction-'+randomUUID(),sourceType:'manual',title:'Predeclared public eventual-loss counterexample: execution is distinct from acceptance'});
 const version=await appendEvidenceVersion(f.f.tenant,source.id,{content:JSON.stringify(dataset,null,2),snapshot:{worldRoot:f.f.root,dataset},asOf:new Date('2026-01-02T00:00:00.000Z')});
 const report=ok(await e.api('deliberation-calibrate',{root:f.f.root,workId:f.p.workId,policyRequest:f.policy.ref,sourceId:source.id,versionId:version.versionId,datasetDigest:digest(dataset)},f.identity));
 const useful=report.report.bins.find((b:any)=>b.key.includes('EXECUTE_CHECK_CHAIN')),irrelevant=report.report.bins.find((b:any)=>b.key.includes('UNVERIFIED_EXECUTION'));
 assert.equal(useful.predictedGain,75);assert.equal(useful.completionProbability,.75);assert.equal(useful.acceptanceProbability,.75);assert.equal(irrelevant.predictedGain,0);assert.equal(irrelevant.completionProbability,1);
 const completed=await done(e,f,{valueEvidenceRef:report.ref});
 const runs=(await e.admin.query('SELECT body FROM finnor_os.m2_module_runs WHERE search_id=$1 ORDER BY created_at,id',[completed.accepted.searchId])).rows.map((r:any)=>r.body);
 await f.artifact('prediction-boundary-before-assertions.json',{dataset,report,completed,runs});
 const first=runs.find((r:any)=>!r.input.incumbentQualified);
 assert(first.output.chains.some((c:any)=>c.conditionalGain===100&&c.expectedGain===75&&c.completionProbability===.75&&c.acceptanceProbability===.75&&c.expectedNet===71&&c.support==='PUBLIC_MODEL_RELATIVE_DIAGNOSTIC'));
 assert(first.output.chains.some((c:any)=>c.unitIds.length===1&&c.expectedGain===0&&c.completionProbability===1));
 assert.equal(first.input.valueModel.ref.contentDigest,report.ref.contentDigest);
 const evidence=ok(await e.api('deliberation-evidence-read',{searchId:completed.accepted.searchId,ref:completed.policy.policy.marginalValueEvidence[0]},f.identity));
 assert.equal(evidence.evidence.calibrationRef.contentDigest,report.ref.contentDigest);
 assert.equal(evidence.evidence.fieldRoutingAdmitted,false);
 const corrected=await appendEvidenceVersion(f.f.tenant,source.id,{content:JSON.stringify({...dataset,correction:'New owner-supplied label revision'},null,2),snapshot:{worldRoot:f.f.root,dataset},asOf:new Date('2026-01-03T00:00:00.000Z')});
 const stale=ok(await e.api('deliberation-read',{searchId:completed.accepted.searchId},f.identity));
 assert.equal(stale.status,'INVALIDATED');assert.equal(stale.policy.projection.incumbent,null);
 await f.artifact('frozen-value-currentness.json',{evidence,corrected,stale});
 return {dir:f.dir,reportRef:report.ref,expectedGain:75,completion:.75,redundantGain:0,currentStatus:stale.status};
}
async function sourcePremiseStops(e:any){
 const f=await fixture(e,{beforeFit:async(f:any)=>{
  const object={schema:'finnor.m2.finite-source-object.v1',entityId:f.root.entityId,periodStart:e.periodStart,periodEnd:e.periodEnd,unit:'currency',currencyCode:'USD',premiseId:'one-material-customer-contract',variants:Array.from({length:50},(_,i)=>'Historical wording '+i+': the same customer contract supports the same modeled revenue.'),operativeClause:{id:'appendix-Z-change-of-control',text:'On change of control the material customer contract terminates automatically.',changesPremise:true}};
  const source=await createEvidenceSource(f.tenant,{sourceKey:'m2-operative-'+randomUUID(),sourceType:'manual',title:'Finite public same-premise wording corpus and exact appendix'}),version=await appendEvidenceVersion(f.tenant,source.id,{content:JSON.stringify(object,null,2),snapshot:{worldRoot:f.root,object},asOf:new Date(e.periodEnd)});
  f.inspection={sourceId:source.id,versionId:version.versionId,contentDigest:version.contentHash};
 }});
 const accepted=ok(await e.api('deliberation-submit',request(f,{sourceInspectionRef:f.f.inspection}),f.identity),202);let read:any;
 for(let i=0;i<30;i++){await e.queue.tick();read=ok(await e.api('deliberation-read',{searchId:accepted.searchId},f.identity));if(['WAITING','FAILED','STOPPED','INVALIDATED'].includes(read.status))break;}
 const units=(await e.admin.query('SELECT kind,status,result FROM finnor_os.p2_units WHERE search_id=$1 ORDER BY created_at,id',[accepted.searchId])).rows;
 const inspected=units.find((u:any)=>u.kind==='INSPECT_SOURCE');assert.equal(inspected.status,'COMPLETED');assert.equal(inspected.result.variantCount,50);assert.equal(inspected.result.independentPremiseCount,1);assert.equal(inspected.result.operativeClause.id,'appendix-Z-change-of-control');
 await f.artifact('source-corpus-and-owner-predicate-before-assertions.json',{accepted,read,units});
 assert.equal(read.status,'WAITING');assert.equal(read.reason,'M2_MATERIAL_SOURCE_PREMISE_REQUIRES_S4_RECOMPUTATION');assert.equal(read.policy.projection.incumbent,null);assert.equal(read.policy.projection.stop.heuristic,true);assert(read.policy.ownerRequests.length>0);assert.equal(read.policy.envelope.executionAuthorityGranted,false);
 const runs=(await e.admin.query('SELECT body FROM finnor_os.m2_module_runs WHERE search_id=$1 ORDER BY created_at,id',[accepted.searchId])).rows;assert(runs.some((r:any)=>r.body.input.sourcePremiseChanged===true&&r.body.output.ownerWait===true));
 return {dir:f.dir,sourceId:f.f.inspection.sourceId,wordings:50,independentPremises:1,ownerRequests:read.policy.ownerRequests};
}
