/** Frozen R1 real-boundary proof. Named local Auth fixture, production owners,
 * genuine S5/P1, PostgreSQL queue, separate physical worker/checker. */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {strict as assert} from 'node:assert';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,mkdtemp,writeFile,appendFile,readFile,rm,readdir,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {migrate} from '../../packages/db/migrate';
import {closePool} from '@finnor/db';
import {startR1HttpFixture} from './http-fixture.mts';
import {prepareR1Owners,ok} from './owner-fixture.mts';
const repo=resolve(import.meta.dirname,'../../..'),evidence=process.env.FINNOR_R1_EVIDENCE_DIR;
if(!evidence)throw Error('R1_PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
await mkdir(evidence,{recursive:true});
const results:any[]=[],startedAt=new Date().toISOString(),started=performance.now(),cpu=process.cpuUsage();
const selected=process.argv[2]??'owners';let postgres!:EmbeddedPostgres,admin!:pg.Client,http!:Awaited<ReturnType<typeof startR1HttpFixture>>,migrationCount=0,legacyJobId:string|undefined;
const directory=await mkdtemp(join(tmpdir(),'finnor-r1-')),children=new Set<ChildProcess>();
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const artifact=async(name:string,value:unknown)=>{await mkdir(join(evidence!,name,'..'),{recursive:true});await writeFile(join(evidence!,name),JSON.stringify(value,null,2)+'\n');};
const save=()=>artifact('results.json',{schema:'finnor.r1.owner-boundary-e2e.v1',startedAt,generatedAt:new Date().toISOString(),durationMs:performance.now()-started,selected,migrationCount,
 status:results.some(x=>x.status==='FAIL')?'FAIL':results.some(x=>x.status==='PASS')?'PASS_LOCAL':'NOT_EXECUTED',results,
 authority:{authBypass:false,hostedAuthQualified:false,ordinaryDevelopment:true,protectedAdmission:false,effectAuthority:false,economicQualification:false},
 costs:{parentCpuMicros:process.cpuUsage(cpu),parentResourceUsage:process.resourceUsage(),usd:null,aggregateSimultaneousPeak:null},
 rerun:'python3 finnor-os/scripts/r1/run-native.py '+selected});
async function test(id:string,predicate:string,fn:()=>Promise<unknown>){
 const filters=process.env.FINNOR_R1_CASE_FILTER?.split(',');if(filters&&!filters.some(x=>id.includes(x))){results.push({id,status:'NOT_RUN',predicate});await save();return;}
 const t=performance.now();try{results.push({id,status:'PASS',predicate,observed:await fn(),durationMs:performance.now()-t});}
 catch(error){results.push({id,status:'FAIL',predicate,observed:{error:String(error),stack:(error as Error).stack},durationMs:performance.now()-t});}
 await save();
}
async function worker(mode='RUN'){
 const startup=performance.now();
 const child=spawn(process.execPath,['--import=tsx',join(import.meta.dirname,'child-worker.mts')],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:process.env.DATABASE_URL!.replace('finnor_app:finnor_app@','finnor_worker:finnor_worker@'),FINNOR_R1_CHILD_MODE:mode},stdio:['ignore','pipe','pipe','ipc']});children.add(child);
 let stdout='',stderr='';child.stdout!.on('data',b=>stdout+=b);child.stderr!.on('data',b=>stderr+=b);
 const exited=new Promise<number|null>(yes=>child.once('exit',code=>{children.delete(child);yes(code);}));
 child.once('error',()=>undefined);
 const log=async()=>artifact('workers/'+child.pid+'.json',{pid:child.pid,mode,stdout,stderr,exitCode:child.exitCode,signalCode:child.signalCode,startupObservationMs:performance.now()-startup});
 for(let i=0;i<600&&!stdout.includes('"kind":"READY"')&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(yes=>setTimeout(yes,25));
 if(!stdout.includes('"kind":"READY"')){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(yes=>setTimeout(yes,2000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}await log();throw Error('Physical queue worker did not start; failed owned process reaped: '+stderr);}
 await artifact('workers/'+child.pid+'-ready.json',{pid:child.pid,mode,observedReady:true,startupObservationMs:performance.now()-startup,originalEpisodeClocksUnchanged:true});
 return {child,exited,log,stop:async()=>{if(child.exitCode===null&&child.signalCode===null){child.send('stop');await Promise.race([exited,new Promise(yes=>setTimeout(yes,4000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}await log();}};
}
async function waitRun(f:any,id:string){
 for(let i=0;i<140;i++){const r=ok(await http.api(f.token,'policies','r1-read',{runId:id}));if(!['QUEUED','RUNNING'].includes(r.status))return r;await new Promise(yes=>setTimeout(yes,200));}
 const rows=(await admin.query('SELECT * FROM finnor_os.r1_runs WHERE id=$1',[id])).rows;await artifact('observer-deadline-'+id+'.json',{rows});
 throw Error('Original bounded run did not reach a decisive state within the observer window');
}
async function snapshot(f:any,id:string){
 const tables:any={};for(const [name,key] of [['r1_runs','id'],['r1_attempts','run_id'],['r1_artifacts','run_id'],['r1_events','run_id']] as const)tables[name]=(await admin.query('SELECT * FROM finnor_os.'+name+' WHERE '+key+'=$1',[id])).rows;
 tables.jobs=(await admin.query("SELECT * FROM finnor_os.jobs WHERE type IN('run_certified_state_reduction_v1','run_r1_dependency_continuation_v1') AND payload->>'runId'=$1",[id])).rows;
 tables.deliveries=(await admin.query("SELECT d.* FROM finnor_os.job_delivery_attempts d JOIN finnor_os.jobs j ON j.id=d.job_id WHERE j.payload->>'runId'=$1",[id])).rows;
 tables.episodes=(await admin.query('SELECT * FROM finnor_os.p1_episodes WHERE id=$1',[tables.r1_runs[0]?.episode_id])).rows;
 tables.grantUsage=(await admin.query('SELECT * FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND grant_digest=$2',[f.tenant,f.allocation.certificate.ref.contentDigest])).rows;
 tables.businessEffects=(await admin.query('SELECT * FROM finnor_os.business_effects WHERE tenant_id=$1',[f.tenant])).rows;
 await artifact(f.name+'/sql-'+id+'.json',tables);return tables;
}
const env=()=>({admin,http,evidence,repo});
try{
 process.env.NODE_ENV='test';process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';process.env.FINNOR_P4_PROFILE='ordinary_disposable';process.env.AUTH_DEV_BYPASS='0';
 process.env.FINNOR_S4_POLICY_STORE=join(evidence,'ordinary-policies');process.env.FINNOR_S3_MODEL_STORE=join(evidence,'ordinary-models');process.env.FINNOR_M1_STORE=join(evidence,'ordinary-producer');
 const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return no(Error('Local database port'));s.close(()=>yes(a.port));});});
 postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
 await artifact('database-lifecycle.json',{directory,port,database:'r1_e2e',role:'finnor_app',status:'INITIALIZING',retention:'Disposable database; exact SQL/input/source receipts retained separately'});
 await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('r1_e2e');
 const postmasterPid=Number((await readFile(join(directory,'postmaster.pid'),'utf8')).split('\n')[0]);await artifact('database-lifecycle.json',{directory,port,database:'r1_e2e',role:'finnor_app',postmasterPid,status:'RUNNING'});
 const adminUrl='postgres://finnor:finnor@127.0.0.1:'+port+'/r1_e2e';
 if(selected==='runtime'){
  const migrations=join(repo,'finnor-os/packages/db/migrations'),files=await Promise.all((await readdir(migrations)).filter(p=>p.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(join(migrations,name),'utf8')})));
  const prior=files.filter(p=>p.name!=='0172_r1_certified_state_reduction.sql');assert.equal(prior.length,files.length-1);
  const priorApplied=await migrate(adminUrl,prior),c=new pg.Client({connectionString:adminUrl});await c.connect();
  try{
   const old=(await c.query("INSERT INTO finnor_os.jobs(type,payload,idempotency_key,protocol_version,max_attempts) VALUES('release_probe',$1::jsonb,'r1-existing-release-probe',1,1) RETURNING *",[JSON.stringify({commitSha:process.env.FINNOR_COMMIT_SHA})])).rows[0];legacyJobId=old.id;
   const catalogSql="SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='finnor_os' AND table_name='jobs' ORDER BY ordinal_position",before=(await c.query(catalogSql)).rows;
   const upgrade=await migrate(adminUrl,files),replay=await migrate(adminUrl,files),after=(await c.query(catalogSql)).rows,preserved=(await c.query('SELECT * FROM finnor_os.jobs WHERE id=$1',[old.id])).rows[0];
   await artifact('migration-upgrade-replay.json',{priorApplied,upgrade,replay,old,preserved,before,after,migrations:files.map(f=>({name:f.name,sha256:sha(f.sql)})),ordinaryDisposable:true});
   assert.deepEqual(upgrade,['0172_r1_certified_state_reduction.sql']);assert.deepEqual(replay,[]);assert.deepEqual(preserved,old);assert.deepEqual(after,before);migrationCount=priorApplied.length+upgrade.length;
  }finally{await c.end();}
 }else migrationCount=(await migrate(adminUrl)).length;
 admin=new pg.Client({connectionString:adminUrl});await admin.connect();await admin.query("SET app.test_vertical_mode='explicit'");
 await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
 await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'finnor_worker'");
 await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p2',2,2,0,60,'Frozen disposable physical capacity; not a protected S5 funding grant') ON CONFLICT(resource_key) DO UPDATE SET capacity=2,per_tenant_capacity=2,interactive_reserve=0,lease_seconds=60,source=EXCLUDED.source");
 process.env.DATABASE_URL='postgres://finnor_app:finnor_app@127.0.0.1:'+port+'/r1_e2e';await closePool();
 http=await startR1HttpFixture(repo,evidence,{builtApi:selected==='runtime'});
 const cut=await (await import('../../packages/private-equity/src/r1/runtime')).r1SourceCut();
 const tests=await Promise.all((await readdir(import.meta.dirname)).filter(p=>/\.(mts|py|json)$/.test(p)).sort().map(async p=>({path:'finnor-os/scripts/r1/'+p,sha256:sha(await readFile(join(import.meta.dirname,p)))})));
 let commit:string,tree:string,dirtyPatchDigest:string|null=null,reconstruction:any,imageAttestation:any=null;
 if(process.env.FINNOR_R1_PACKAGED_SOURCE==='1'){
  assert.equal(selected,'runtime');assert.equal(repo,'/app');
  commit=process.env.FINNOR_COMMIT_SHA!;tree=process.env.FINNOR_R1_SOURCE_TREE!;
  assert(/^[a-f0-9]{40}$/.test(commit));assert(/^[a-f0-9]{40}$/.test(tree));assert(/^sha256:[a-f0-9]{64}$/.test(process.env.FINNOR_R1_IMAGE_ID??''));
  imageAttestation={imageId:process.env.FINNOR_R1_IMAGE_ID,gitMetadataQualification:'BUILD_INVOCATION_METADATA; SOURCE_BYTES_INDEPENDENTLY_HASHED_HERE',sourceFiles:cut.files};
  reconstruction={kind:'FINAL_LINUX_PACKAGE',commit,tree,imageId:process.env.FINNOR_R1_IMAGE_ID,sourceManifest:cut.files,gitIncluded:false};
 }else{
  const git=(args:string[])=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  commit=git(['rev-parse','HEAD']);tree=git(['rev-parse','HEAD^{tree}']);
  const dirty=spawnSync('git',['ls-files','--modified','--others','--exclude-standard','-z'],{cwd:repo,encoding:'utf8'});assert.equal(dirty.status,0,dirty.stderr);
  const overlay:any[]=[];let overlayBytes=0;
  for(const path of [...new Set(dirty.stdout.split('\0').filter(Boolean))].sort()){
   try{await lstat(join(repo,path));}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    overlay.push({path,deleted:true,sha256:null,bytes:0});continue;
   }
   const bytes=await readFile(join(repo,path));overlayBytes+=bytes.length;assert(overlayBytes<=20*1024*1024,'R1_RECONSTRUCTION_OVERLAY_BOUND');
   const target=join(evidence,'source-cut','dirty',path);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,bytes);overlay.push({path,sha256:sha(bytes),bytes:bytes.length});
  }
  const patch=spawnSync('git',['diff','--binary','HEAD'],{cwd:repo,encoding:'utf8'});assert.equal(patch.status,0,patch.stderr);await writeFile(join(evidence,'source-cut','tracked.patch'),patch.stdout);dirtyPatchDigest=sha(git(['diff','--binary']));
  reconstruction={parentCommit:commit,trackedPatch:'source-cut/tracked.patch',trackedPatchSha256:sha(patch.stdout),overlayRoot:'source-cut/dirty',overlay,overlayBytes};
 }
 await artifact('pre-run-freeze.json',{frozenAt:new Date().toISOString(),source:cut,commit,tree,dirtyPatchDigest,tests,reconstruction,
  node:{path:await realpath(process.execPath),version:process.version},auth:http.qualification,finiteVerification:'scope-r/r1-certified-state-reduction/verification-plan.json',database:'Disposable genuine PostgreSQL / ordinary finnor_app FORCED RLS',imageAttestation});
 if(selected==='owners'||selected==='runtime'){
  if(selected==='owners')await test('co-funded-cost-tail','One canonical cash resource includes action cost2, terminal debt3 and original resource one-third exactly once; the 5 USD pool cannot select that policy',async()=>{
   const f=await prepareR1Owners(env(),{tail:true,name:'co-funded-owner'});assert.equal(f.allocation.status,'FEASIBLE',JSON.stringify({status:f.allocation.status,reasons:f.allocation.reasons}));assert.deepEqual(f.allocation.certificate.check.selectedPolicyIds,[]);return {status:f.allocation.status,selected:f.allocation.certificate.check.selectedPolicyIds,expectedOriginalDemand:'16/3',available:'5',authorityGranted:false};
  });
  for(const upper of selected==='runtime'?[false]:[false,true])await test(upper?'upper-owner-128-8-12':'positive-owner-reduction','Authenticated real owners, actual durable queue/worker/checker, positive S4 representation reuse, original policy aliases and S5 exact rational demand with authority blocked',async()=>{
   const f=await prepareR1Owners(env(),{upper,name:upper?'upper-owner':'positive-owner'});
   if(selected==='runtime'){
    const foreign='00000000-0000-4000-8000-000000000001';assert.notEqual(f.tenant,foreign);const probes:any[]=[];
    for(const [method,path,expected] of [['GET',f.tenant+'/clarification_request',404],['GET',foreign+'/clarification_request',403],['PUT',foreign+'/clarification_request',403],['POST',foreign+'/clarification_request/simulate',403]] as const){
     const response=await fetch(http.apiBase+'/api/policies/'+path,{method,headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},...(method==='GET'?{}:{body:'{}'})}),body=await response.json();probes.push({method,path,status:response.status,body,expected});await artifact('built-legacy-policy-boundaries.json',probes);assert.equal(response.status,expected,JSON.stringify(probes.at(-1)));
    }
   }
   const commonRequest={schema:'finnor.r1.run.v2',problem_ref:f.runRequest.problem_ref,envelope_inputs:f.runRequest.envelope_inputs,existing_work_revision:f.runRequest.work_rev,domain_profile_ref:f.source.sourceRef,budget_grant_ref:f.runRequest.grant,cancellation_ref:null,idempotencyKey:f.runRequest.idempotencyKey};
   await f.artifact('common-owner-request.json',commonRequest);
   const submitted=ok(await http.api(f.token,'policies','r1-submit',commonRequest),202);
   assert.equal(submitted.schema,'finnor.r1.common-result.v1');assert.equal(submitted.status,'INCOMPLETE');assert.equal(submitted.runtime_status,'QUEUED');assert.equal(submitted.artifact_ref,null);assert(submitted.unresolved_claim_refs.some((r:any)=>r.claim_id==='COMPLETE_RELATION'));assert(submitted.resource_receipt_refs.some((r:any)=>r.kind==='COMMON_PREPARATION_CHARGED'));
   const pending=ok(await http.api(f.token,'policies','r1-read',{runId:submitted.runId}));assert.equal(pending.status,'QUEUED');assert.equal(pending.head,null);
   const replay=ok(await http.api(f.token,'policies','r1-submit',f.runRequest),202);assert.equal(replay.runId,submitted.runId);assert.equal(replay.replayed,true);
   if(selected==='runtime'){
    assert(legacyJobId);const old=await worker('COMPATIBILITY_OLD');
    try{for(let i=0;i<120;i++){if((await admin.query('SELECT status FROM finnor_os.jobs WHERE id=$1',[legacyJobId])).rows[0]?.status==='completed')break;await new Promise(yes=>setTimeout(yes,25));}}finally{await old.stop();}
    const legacy=(await admin.query('SELECT * FROM finnor_os.jobs WHERE id=$1',[legacyJobId])).rows[0],accepted=(await admin.query("SELECT * FROM finnor_os.jobs WHERE type='run_certified_state_reduction_v1' AND payload->>'runId'=$1",[submitted.runId])).rows[0];
    await artifact('old-worker-new-job-refusal.json',{legacy,accepted,attempts:(await admin.query('SELECT * FROM finnor_os.r1_attempts WHERE run_id=$1',[submitted.runId])).rows});
    assert.equal(legacy.status,'completed');assert.equal(legacy.attempts,1);assert.equal(accepted.status,'queued');assert.equal(accepted.attempts,0);assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.r1_attempts WHERE run_id=$1',[submitted.runId])).rows[0].n,0);
    const future=(await admin.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,protocol_version,idempotency_key,max_attempts,lane) VALUES($1,$2,$3::jsonb,2,$4,1,'interactive') RETURNING *",[accepted.tenant_id,accepted.type,JSON.stringify(accepted.payload),'r1-future-protocol-'+submitted.runId])).rows[0];await artifact('future-protocol-before.json',future);
   }
   const w=await worker();let complete:any;try{complete=await waitRun(f,submitted.runId);}finally{await w.stop();}
   await f.artifact('completed-reader.json',complete);const sql=await snapshot(f,submitted.runId);
   const sourceRecord=(await admin.query('SELECT work_input_digest,model_digest,dependencies FROM finnor_os.r1_models WHERE id=$1',[f.source.sourceId])).rows[0];
   const common=ok(await http.api(f.token,'policies','r1-read',{schema:'finnor.r1.common-read.v1',runId:submitted.runId})),envelope=common.artifact_envelope;
   await f.artifact('common-owner-readback.json',common);assert.equal(common.status,'COMPLETE');assert.equal(common.runtime_status,'COMPLETE');assert.deepEqual(common.artifact_ref,complete.artifact_ref);assert.deepEqual(envelope,complete.head.envelope.artifactEnvelope);assert.equal(envelope.artifact_kind,'ControlQuotient');assert.equal(envelope.work_ref.id,f.work.workId);assert.equal(envelope.work_revision,f.program.workRevision);assert.equal(envelope.work_ref.contentDigest,(await admin.query('SELECT work_input_digest FROM finnor_os.r1_models WHERE id=$1',[f.source.sourceId])).rows[0].work_input_digest);assert.equal(envelope.tenant_ref.id,f.tenant);assert.deepEqual(envelope.budget_grant_ref,f.allocation.certificate.ref);assert.deepEqual(envelope.domain_ref,f.source.sourceRef);assert.equal(envelope.check_basis,'MODEL_RELATIVE_EXACT');assert.equal(envelope.producer_ref.admission_ref,null);assert.equal(envelope.producer_ref.code_digest,cut.codeDigest);assert.equal(envelope.producer_ref.dependency_lock_digest,cut.lockDigest);assert.equal(envelope.claims.length,1);assert(envelope.input_refs.every((r:any)=>r.as_of&&Number.isSafeInteger(r.rights_revision)&&r.content_digest===r.owner_ref.contentDigest));
   const actualArtifact=(ref:any)=>{assert.equal(ref.owner,'R1');const row=sql.r1_artifacts.find((a:any)=>'artifact:'+a.id===ref.id);assert(row,'Actual immutable SQL artifact ref must resolve: '+JSON.stringify(ref));assert.equal(row.digest,ref.contentDigest);return row;};
   const baselineManifest=actualArtifact(envelope.baseline_manifest_ref);assert.equal(baselineManifest.kind,'BASELINE_MANIFEST');assert.equal(baselineManifest.body.completedCumulativeXRef,null);assert.equal(baselineManifest.body.originalS4.policyRef.contentDigest,f.baseline.ref.contentDigest);assert.equal(baselineManifest.body.originalS5.grantRef.contentDigest,f.allocation.certificate.ref.contentDigest);assert.equal(actualArtifact(envelope.assumptions_ref).body.modelDigest,sourceRecord.model_digest);assert.deepEqual(actualArtifact(envelope.programme_grammar_ref).body.actions,f.originalModel.actions);
   const claim=envelope.claims[0],statement=actualArtifact(claim.statement_ref),checkerRecord=actualArtifact(claim.checker_receipt_ref);assert.equal(statement.body.claimId,claim.claim_id);assert.deepEqual(claim.domain_ref,f.source.sourceRef);assert.equal(checkerRecord.kind,'CHECK_RECEIPT');assert.equal(checkerRecord.body.status,'COMPLETE');assert.equal(checkerRecord.body.checkerDigest,complete.head.receipt.checkerDigest);assert.equal(statement.body.causalQualification,'UNQUALIFIED');assert(envelope.gaps.some((g:any)=>g.kind==='COMPLETED_CUMULATIVE_X_UNAVAILABLE'));assert(envelope.gaps.some((g:any)=>g.kind==='ECONOMIC_RELEASE_UNQUALIFIED'));assert(envelope.gaps.every((g:any)=>g.reason&&g.affected_claim_ids.includes(claim.claim_id)));assert.deepEqual(envelope.invalidation_dependency_refs,sourceRecord.dependencies);
   for(const ref of [envelope.baseline_manifest_ref,envelope.assumptions_ref,envelope.programme_grammar_ref,claim.statement_ref,claim.checker_receipt_ref,...envelope.resource_receipt_refs,...envelope.lifecycle_event_refs]){const record=ok(await http.api(f.token,'policies','r1-record',{schema:'finnor.r1.record-read.v1',runId:submitted.runId,ref}));assert.deepEqual(record.ref,ref);assert.equal(record.currentValidityAsserted,false);if(ref.id.startsWith('artifact:'))assert.deepEqual(record.body,actualArtifact(ref).body);await f.artifact('resolved-record-'+ref.id.replace(':','-')+'.json',record);}
   for(const ref of envelope.lifecycle_event_refs){const row=sql.r1_events.find((e:any)=>'event:'+e.id===ref.id);assert(row);assert.equal(row.digest,ref.contentDigest);}assert(sql.r1_events.some((e:any)=>e.kind==='DEVELOPMENT_VERIFIED'&&e.body.s8Admitted===false&&e.body.active===false));assert(common.resource_receipt_refs.some((ref:any)=>ref.id==='artifact:'+checkerRecord.id));assert(common.unresolved_claim_refs.every((ref:any)=>sql.r1_events.some((e:any)=>'event:'+e.id===ref.id&&e.digest===ref.contentDigest)));assert(!common.unresolved_claim_refs.some((ref:any)=>ref.claim_id==='COMPLETE_RELATION'));
   assert.equal(complete.status,'COMPLETE',JSON.stringify(complete));assert.equal(complete.head.receipt.status,'COMPLETE');
   assert.equal(complete.head.originalDeadlineAt,sql.r1_runs[0].original_deadline_at.toISOString());assert.equal(complete.head.decisionDeadlineAt,sql.r1_runs[0].decision_deadline_at.toISOString());
   assert.equal(sql.r1_events.find((v:any)=>v.kind==='ACCEPTED').body.decisionDeadlineAt,complete.head.decisionDeadlineAt);
   assert.equal(complete.head.authority,false);assert(complete.head.candidate.blocks.length<complete.head.beforeStates);
   assert(complete.head.evaluation.stats.reuseHits>0);assert(complete.head.evaluation.stats.continuationEvaluations<f.baseline.exactProfile.evaluation.stats.continuationEvaluations);
   assert.equal(complete.head.evaluation.selectedActions.root,'choice1');assert.deepEqual(complete.head.evaluation.values,f.baseline.exactProfile.evaluation.values);assert.deepEqual(complete.head.evaluation.optimalActions,f.baseline.exactProfile.evaluation.optimalActions);
   assert.deepEqual(sql.r1_attempts.map((a:any)=>a.stage).sort(),['CHECK','PRODUCE','S4_EVALUATE']);assert(sql.r1_attempts.every((a:any)=>a.status==='RETURNED'&&a.child_pid>0));
   assert(sql.deliveries.length===1&&sql.deliveries[0].claim_fence>0);assert.equal(sql.episodes[0].attempts_used,3);
   const p=ok(await http.api(f.token,'policies','read',{policyRef:complete.head.policy.ref}));
   assert.equal(p.nodes.find((n:any)=>n.id===p.rootNodeId).actionId,'choice1');assert.equal(p.demand.schema,'finnor.contingent-resource-demand.exact.v2');assert.equal(p.demand.exact.branches.find((b:any)=>b.nodeId===p.rootNodeId).total.capital.denominator,'3');
   f.policies=[p];f.labels[p.ref.id]='quotient-policy';const clearing=f.support.clearing(f,{'quotient-policy':['7']});
   const allocation=ok(await http.api(f.token,'allocations','clear',clearing));await f.artifact('on-s5-clearing.json',{clearing,allocation});assert.equal(allocation.status,'FEASIBLE',JSON.stringify(allocation));assert(allocation.certificate&&allocation.reservation);
   const decision={period:0,actionHistory:[],observations:[],knowledgeAt:new Date().toISOString(),rightsRef:p.mandate.rightsRef,obligations:p.problem.obligations,allocationRefs:[allocation.certificate.ref]};
   const choice=ok(await http.api(f.token,'policies','decide',{policyRef:p.ref,decision,allocationRef:allocation.certificate.ref}));assert.equal(choice.actionId,'choice1',JSON.stringify(choice));assert.equal(choice.status,'POLICY_AVAILABLE');assert.equal(choice.executionAuthorityGranted,false);
   const projection=ok(await http.api(f.token,'policies','r1-projection',{workId:f.work.workId,root:f.root}));assert.equal(projection.runs[0].id,submitted.runId);assert.equal(projection.runs[0].status,'COMPLETE');
   await f.artifact('positive-consumers.json',{policy:p,decision,choice,projection});
   if(selected==='runtime'){
    const cold=await worker('RECONCILE');try{await Promise.race([cold.exited,new Promise((_,no)=>setTimeout(()=>no(Error('Runtime cold reconciliation did not terminate')),10000))]);}finally{await cold.stop();}
    const current=ok(await http.api(f.token,'policies','r1-read',{runId:submitted.runId})),future=(await admin.query("SELECT * FROM finnor_os.jobs WHERE idempotency_key=$1",['r1-future-protocol-'+submitted.runId])).rows[0],deliveries=(await admin.query('SELECT * FROM finnor_os.job_delivery_attempts WHERE job_id=$1',[future.id])).rows;
    await artifact('cold-restart-and-protocol-compatibility.json',{current,future,deliveries,workerPid:cold.child.pid});assert.equal(current.status,'COMPLETE');assert(complete.artifact_ref);assert.deepEqual(current.artifact_ref,complete.artifact_ref);assert.deepEqual(current.head,complete.head);assert.equal(future.status,'queued');assert.equal(future.attempts,0);assert.deepEqual(deliveries,[]);
   }
   // Real wall clock and original action history, never a synthetic future time.
   if(!upper){const due=Date.parse(p.knowledgeAt)+p.mandate.horizon.periodMs;while(Date.now()<due)await new Promise(yes=>setTimeout(yes,Math.min(500,due-Date.now())));
    const laterDecision={...decision,period:1,actionHistory:['choice1'],knowledgeAt:new Date().toISOString()},later=ok(await http.api(f.token,'policies','decide',{policyRef:p.ref,decision:laterDecision,allocationRef:allocation.certificate.ref}));
    assert.equal(later.actionId,'stop');assert.deepEqual(p.nodes.find((n:any)=>n.id===later.nodeId).actionHistory,['choice1']);await f.artifact('original-history-alias.json',{laterDecision,later});
   }
   if(selected==='runtime'){
    const {startBuiltR1Api}=await import('./built-api-fixture.mts');
    for(const unsetDevBypass of [false,true]){
     const name=unsetDevBypass?'managed-secrets-required':'configured-dev-bypass-refused',production=await startBuiltR1Api(repo,join(evidence!,name),{runtime:'production',unsetDevBypass});
     try{
      const response=await fetch(production.base+'/api/interventions/exact-control-model',{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:'{}'}),body=await response.json();
      await new Promise(yes=>setTimeout(yes,50));const log=production.log(),expected=unsetDevBypass?'Production requires SECRETS_PROVIDER=aws-secrets-manager':'Production refuses to boot while AUTH_DEV_BYPASS is configured';
      await artifact(name+'/refusal.json',{status:response.status,body,expected,observedLog:log,runtime:'production',effectAuthority:false});assert.equal(response.status,500);assert(log.stderr.includes(expected));
     }finally{await production.close();}
    }
   }
   return {runId:submitted.runId,original:complete.head.beforeStates,quotient:complete.head.candidate.blocks.length,stats:complete.head.evaluation.stats,originalStats:f.baseline.exactProfile.evaluation.stats,physicalStages:sql.r1_attempts.map((a:any)=>({stage:a.stage,pid:a.child_pid,status:a.status})),s5:allocation.status,originalEpisode:complete.head.originalEpisode,authorityGranted:false};
  });
 }else if(selected==='lifecycle')await (await import('./run-lifecycle.mts')).runLifecycle({...env(),test,worker,waitRun,snapshot,artifact});
 else if(selected==='browser')await test('mounted-capital-work','Existing authenticated Capital Work initiates and reviews the actual funded owner continuation with clearing under Work/principal/access changes',()=>import('./browser-fixture.mts').then(m=>m.browserFixture({...env(),test,worker,waitRun,snapshot,artifact})));
 else throw Error('R1_SELECTED_DRIVER_NOT_IMPLEMENTED_'+selected);
}catch(error){results.push({id:'setup-or-driver',status:'FAIL',observed:{error:String(error),stack:(error as Error).stack}});}
finally{
 for(const c of children){c.kill('SIGKILL');}
 await save();await http?.close();await closePool();await admin?.end();await postgres?.stop();await artifact('database-teardown.json',{directory,stopReturned:true,remainingPidFile:await readFile(join(directory,'postmaster.pid'),'utf8').catch(()=>null),at:new Date().toISOString()});await rm(directory,{recursive:true,force:true});
}
process.exitCode=results.some(x=>x.status==='FAIL')?1:results.some(x=>x.status==='PASS')?0:1;
