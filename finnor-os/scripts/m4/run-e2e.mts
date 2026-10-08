/** Registered before M4 feature code. Expected values are original closed-form predicates. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { closePool, configureTenantVertical, receiveWork, withTenantTransaction } from '@finnor/db';
import { createAssumption, createDeal, createInvestmentCase, createUnderwritingModel,
  createUnderwritingModelVersion, attachWorkToDealGraph, invalidateAssumption, type PeMutationContext } from '@finnor/private-equity';
import { UNDERWRITING_ENGINE_VERSION, FINANCIAL_CONVENTION_VERSION } from '@finnor/underwriting';
import { migrate } from '../../packages/db/migrate';
import { POST } from '../../apps/api/app/api/company-brain/[operation]/route';
import { JobQueue } from '../../apps/worker/src/queue';
import { ownerChallenges } from './owner-challenges.mjs';
import { storageChallenges } from './storage-challenges.mjs';
import { p4Challenges } from './p4-challenges.mjs';
import { recoveryChallenges } from './recovery-challenges.mjs';
import { browserChallenges } from './browser.mjs';
import { boundaryChallenges } from './boundary-challenges.mjs';
import { liabilityChallenges } from './liability-challenges.mjs';
import { partialChallenges } from './partial-challenges.mjs';
import { currentCodeIdentity } from '../../packages/private-equity/src/evidence-execution/store';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const output=process.env.FINNOR_M4_EVIDENCE_DIR!;
const registration=JSON.parse(await readFile(join(repo,'scope-pm/phase-06-m4-counterexample-search/registration.json'),'utf8'));
const selected=process.env.FINNOR_M4_CASE_FILTER?.split(',');
const cases:any[]=[],calls:any[]=[],children=new Set<ChildProcess>(),startedAt=new Date().toISOString();
const artifacts:Record<string,string>={};
async function artifact(name:string,value:unknown){const path=join(output,name);await mkdir(dirname(path),{recursive:true});const bytes=JSON.stringify(value,null,2)+'\n';await writeFile(path,bytes);if(name!=='results.json')artifacts[name]=createHash('sha256').update(bytes).digest('hex');return path;}
const closure:any[]=[];
async function sourceFiles(directory:string):Promise<string[]>{
  const found:string[]=[];
  for(const entry of await readdir(join(repo,directory),{withFileTypes:true})){
    if(entry.name.startsWith('.')||entry.name==='node_modules')continue;
    const path=directory+'/'+entry.name;
    if(entry.isDirectory())found.push(...await sourceFiles(path));
    else if(/\.(ts|tsx|mts|mjs|css|py|sql|json)$/.test(entry.name))found.push(path);
  }
  return found;
}
const sourcePaths=[...new Set((await currentCodeIdentity()).files.map(f=>f.path).concat(
  await sourceFiles('finnor-os/scripts/m4'),await sourceFiles('finnor-os/packages/db/migrations'),
  await sourceFiles('finnor-os/packages/private-equity/src/counterexample-search'),
  await sourceFiles('src'),[
  'finnor-os/scripts/s5/owner-fixture.mts','finnor-os/scripts/s3/reference.py',
  'finnor-os/scripts/s6/governed-dispatch-proof.mts','scripts/centropy/generate-capability-manifest.mjs',
  'scope-pm/phase-06-m4-counterexample-search/registration.json','scope-pm/phase-06-m4-counterexample-search/failure-model.md',
  'scope-pm/phase-06-m4-counterexample-search/domain-claim-contract.md','finnor-os/package-lock.json','package-lock.json']))].sort();
for(const path of sourcePaths){
  closure.push({path,sha256:createHash('sha256').update(await readFile(join(repo,path))).digest('hex')});
}
await artifact('source-closure.json',{schema:'finnor.m4.executed-source-closure.v1',files:closure,
  closureDigest:createHash('sha256').update(JSON.stringify(closure)).digest('hex'),
  localPackages:await Promise.all(['db','private-equity','underwriting','epistemic-runtime']
    .map(async name=>({name,path:await realpath(join(repo,'finnor-os/node_modules/@finnor',name))}))),
  relativeNativeModules:[{name:'governed-execution',path:await realpath(join(repo,'finnor-os/packages/governed-execution'))}],
  node:process.version,numericalPython:process.env.FINNOR_S3_PYTHON,referencePython:process.env.FINNOR_M4_PYTHON,
  qualification:'SOURCE_AND_LOCK_IDENTITY_NOT_PRODUCTION_IMAGE_OR_AGGREGATE_OS_ATTESTATION'});
async function save(){await artifact('results.json',{schema:'finnor.m4.e2e.v1',startedAt,finishedAt:new Date().toISOString(),cases,calls,
  registration,closure,artifacts,selection:selected??'FULL_REGISTERED_DEVELOPMENT',
  unmatchedSelection:selected?.filter(id=>!cases.some(c=>c.id===id))??[],
  excluded:registration.cases.filter((c:any)=>!cases.some(r=>r.id===c.id)).map((c:any)=>({id:c.id,status:'NOT_RUN',families:c.families})),
  node:process.version,environmentNames:Object.keys(process.env).sort(),
  qualification:'Real ordinary-role Work/API/queue/M1/native/original-input reference; generated H0/H1, development-header identity. Not hosted JWT, sealed GateM4, genuine M3, provider admission, aggregate OS or H2.',
  costs:{usd:null,status:'UNMETERED'},replay:'python3 finnor-os/scripts/m4/run-local.py'});}
async function challenge(id:string,expected:string,fn:()=>Promise<unknown>){
  if(selected&&!selected.includes(id))return;const t=performance.now();
  try{const observed=await fn();cases.push({id,expected,status:'PASS',observed,elapsedMs:performance.now()-t});}
  catch(e){cases.push({id,expected,status:'FAIL',observed:{message:(e as Error).message,stack:(e as Error).stack},elapsedMs:performance.now()-t});}
  console.log(JSON.stringify({id,status:cases.at(-1).status}));await save();
}
async function api(f:any,operation:string,body:unknown,handler=POST){
  const t=performance.now(),response=await handler(new Request(`http://127.0.0.1/api/company-brain/${operation}`,{
    method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body),
  }),{params:Promise.resolve({operation})});
  const result={status:response.status,body:await response.json() as any};
  calls.push({operation,status:result.status,elapsedMs:performance.now()-t});
  if(handler!==POST)await artifact('owner-calls/'+calls.length+'-'+operation+'.json',{body,result});
  return result;
}
function ok(r:any,status=200){assert.equal(r.status,status,JSON.stringify(r));return r.body;}
async function port(){return new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return no(Error('PORT'));s.close(()=>yes(a.port));});});}
let workerModule:any;
try{workerModule=await import('../../packages/private-equity/src/counterexample-search/worker');}
catch(error){
  cases.push({id:'work-queue-cold-durable',status:'FAIL',expected:'Registered real M4 worker module exists',observed:{message:(error as Error).message}});
  await save();process.exit(1);
}
const dir=await mkdtemp(join(tmpdir(),'finnor-m4-')),dbPort=await port();
const postgres=new EmbeddedPostgres({databaseDir:dir,user:'finnor',password:'finnor',port:dbPort,persistent:false,onLog:()=>undefined});
let admin:pg.Client|undefined;
const f:any={tenant:randomUUID(),principal:randomUUID(),foreignPrincipal:randomUUID(),rootId:randomUUID()};
f.ctx={auth:{tenantId:f.tenant,userId:f.principal,employeeId:f.principal,role:'owner'}} as PeMutationContext;
let slice:any,request:any,result:any,submission:any;
const queue=new JobQueue('m4-real-e2e',30);
queue.register('run_counterexample_search_v1',workerModule.runCounterexampleSearchJob,{protocolVersions:[1],retrySafety:'locally_idempotent'});
async function run(body:any={...request,idempotencyKey:randomUUID()}){const sent=ok(await api(f,'counterexample-diagnostic-submit',body),202);await queue.tick();
  const read=ok(await api(f,'counterexample-read',{searchId:sent.searchId}));
  if(read.status!=='COMPLETED')await artifact('failed-job-'+sent.searchId+'.json',{
    read,ledger:await api(f,'counterexample-ledger',{searchId:sent.searchId}),
    jobs:(await admin!.query("SELECT id,status,type,last_error FROM finnor_os.jobs WHERE payload->>'searchId'=$1",[sent.searchId])).rows,
  });
  assert.equal(read.status,'COMPLETED',JSON.stringify(read));assert(read.report);return {sent,read,report:read.report};
}
try{
  await postgres.initialise();await appendFile(join(dir,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');
  await postgres.start();await postgres.createDatabase('m4_e2e');const url=`postgres://finnor:finnor@127.0.0.1:${dbPort}/m4_e2e`;
  await migrate(url);admin=new pg.Client({connectionString:url});await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'M4 disposable project')",[f.tenant,randomUUID()]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,'m4@example.test','owner','active')",[f.principal,f.tenant]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,'other-m4@example.test','owner','active')",[f.foreignPrincipal,f.tenant]);
  await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'m4-exact','M4 generated target','other')",[f.rootId,f.tenant]);
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('provider:m1-native',2,2,0,120,true,'M4 disposable fixture') ON CONFLICT(resource_key) DO NOTHING");
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('provider:m4-native',1,1,0,120,true,'M4 disposable fixture') ON CONFLICT(resource_key) DO NOTHING");
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('native:p4',2,2,0,60,true,'M4 authentic P4 disposable fixture') ON CONFLICT(resource_key) DO NOTHING");
  process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${dbPort}/m4_e2e`;await closePool();
  // Canonical getPool uses DATABASE_URL for queue and scoped transactions.
  // Do not pretend an unconsumed WORKER_DATABASE_URL selects another role.
  await configureTenantVertical({tenantId:f.tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:f.principal,sourceSystem:'m4:e2e'});
  f.dealId=(await createDeal(f.ctx,{targetOrganizationId:f.rootId,name:'M4 original-source case',dealLeadEmployeeId:f.principal,
    signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)})).row.id;
  f.caseId=(await createInvestmentCase(f.ctx,{dealId:f.dealId,title:'M4 native model'})).row.id;
  const assumptions:any={};
  for(const [id,value] of [['x','0'],['y','0'],['cap','1']])assumptions[id!]=String((await createAssumption(f.ctx,{
    dealId:f.dealId,investmentCaseId:f.caseId,assumptionKey:id!,statement:`Generated original ${id}`,valueType:'number',value:Number(value),unit:'ratio',
  })).row.id);
  const definition:any={schemaVersion:'underwriting-model-ir.v1',modelKey:'m4-compound',modelVersion:'1',
    financialConventionVersion:FINANCIAL_CONVENTION_VERSION,minimumEngineVersion:UNDERWRITING_ENGINE_VERSION,
    periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
      ...['x','y','cap'].map(id=>({id,kind:'input',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:[],required:true,
        source:{kind:'p1_assumption',assumptionId:assumptions[id]}})),
      {id:'product',kind:'expression',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['x','y'],
        expression:{op:'multiply',args:[{op:'ref',nodeId:'x'},{op:'ref',nodeId:'y'}]}},
      {id:'score',kind:'output',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['product'],sourceNodeId:'product'},
    ]};
  f.modelId=String((await createUnderwritingModel(f.ctx,{investmentCaseId:f.caseId,modelKey:definition.modelKey,name:'M4 exact compound'})).id);
  f.versionId=String((await createUnderwritingModelVersion(f.ctx,{modelId:f.modelId,definition})).id);
  f.workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Challenge exact supplied mechanical bounds, no live effect',
    channel:'console',idempotencyKey:'m4-initial'})).workId;
  await attachWorkToDealGraph(f.ctx,{workId:f.workId,dealId:f.dealId,entities:[{entityType:'pe_investment_case',entityId:f.caseId}]});
  slice=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
    source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
    resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
  request={schema:'finnor.m4.diagnostic-request.v1',workId:f.workId,sliceRef:slice.ref,idempotencyKey:randomUUID(),
    evaluations:[{kind:'MECHANICAL_BOUND',candidateId:f.versionId,nodeId:'score',relation:'LTE',value:'0.5',unit:'ratio',
      claimKind:'UNIVERSAL_DETERMINISTIC'}],
    domain:{parameters:[{candidateId:f.versionId,nodeId:'x',values:['1']},{candidateId:f.versionId,nodeId:'y',values:['1']},
      {candidateId:f.versionId,nodeId:'cap',values:['2']}],maxCombination:3},
    limits:{deadlineMs:30000,maxTargets:64,maxCells:128,maxTrials:512,maxReductions:64,maxWitnesses:32,maxBytes:4194304}};
  await artifact('original-inputs.json',{definition,assumptions,slice,request,oracle:{baseline:'0',xOnly:'0',yOnly:'0',pair:'1',maximum:'0.5'}});
  await challenge('m3-pending-no-ref-cast','A fabricated obsolete M3 ref still cannot enter the integrated current v2 reader',async()=>{
    const pending=await api(f,'challenge-submit',{schema:'finnor.m4.challenge-request.v1',workId:f.workId,
      candidate:{owner:'M3',id:'capital-program:'+'a'.repeat(64),version:'capital-program-v1',contentDigest:'a'.repeat(64)},
      idempotencyKey:randomUUID(),limits:request.limits});
    assert.equal(pending.status,404);assert.equal(pending.body.code,'UNAVAILABLE');assert(!pending.body.candidate);assert(!pending.body.result);
    return pending;
  });
  await challenge('compound-native-fraction-reduction','Pair-only exact failure and meaning-preserving sufficient reduction; original retained',async()=>{
    const ran=await run();submission=ran.sent;result=ran.report;
    assert.equal(result.schema,'finnor.m4.owner-artifact-diagnostic.v1');assert(!('candidate' in result));
    assert.equal(result.result,'FAILURE_WITNESS');assert.equal(result.executionAuthorityGranted,false);
    const witness=result.witnesses.find((w:any)=>w.class==='NUMERICAL_CONTRACT');
    assert(witness);assert.equal(witness.validation.status,'VALID');assert.equal(witness.validation.independent.checker,'M4_FRACTION_ORIGINAL_IR_V1');
    assert.equal(witness.validation.independent.observed,'1');assert.equal(witness.validation.native.observed,'1');
    assert(witness.original.components.some((c:any)=>c.nodeId==='x'));assert(witness.original.components.some((c:any)=>c.nodeId==='y'));
    assert(!witness.minimized.components.some((c:any)=>c.nodeId==='cap'));assert(witness.minimization.trace.length);
    assert(result.repairDependencies.regions.some((r:any)=>r.nativeId==='x'));
    assert(result.repairDependencies.regions.some((r:any)=>r.nativeId==='y'));
    assert(result.unresolved.length);assert(result.ledger.trials>0);await artifact('compound.json',ran);
    const singles=await run({...request,idempotencyKey:randomUUID(),domain:{...request.domain,maxCombination:1}});
    assert.equal(singles.report.result,'NO_WITNESS_WITHIN_BUDGET');
    assert.equal(singles.report.witnesses.length,0);
    assert.equal(singles.report.coverage.totalDeclaredCells,4);
    assert.equal(singles.report.coverage.completeFiniteDeclaredCells,true);
    assert.equal(singles.report.identity.contextDigest,result.identity.contextDigest);
    await artifact('compound-mechanism-ablation.json',{compound:ran,singleOnly:singles,
      changedOperator:'MAX_COMBINATION_3_TO_1_ONLY',predicateUnchanged:true,exactOwnerContextUnchanged:true,
      qualification:'FINITE_NATIVE_MECHANISM_ABLATION_NOT_SEALED_OR_PROVIDER_CONTROLLER_COMPARISON',costUSD:null});
    return {compound:ran,singleOnly:singles};
  });
  await challenge('distinct-coupled-witnesses-and-root-input-cap','Distinct reduced coupled inputs survive deduplication and one root witness allocation cannot be reused for a new input',async()=>{
    const distinct=await run({...request,idempotencyKey:randomUUID(),domain:{...request.domain,parameters:[
      {...request.domain.parameters[0],values:['1','2']},request.domain.parameters[1],request.domain.parameters[2]]}});
    await artifact('distinct-coupled-inputs.json',distinct);
    const reduced=distinct.report.witnesses.filter((w:any)=>w.class==='NUMERICAL_CONTRACT');
    assert.equal(reduced.length,2,'Different coupled failing inputs collapsed into one generic predicate witness');
    assert.deepEqual(reduced.map((w:any)=>w.validation.independent.observed).sort(),['1','2']);
    assert(reduced.every((w:any)=>!w.minimized.components.some((c:any)=>c.nodeId==='cap')));
    const root=await run({...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxWitnesses:1}});
    assert.equal(root.report.witnesses.length,1);
    const child=ok(await api(f,'counterexample-repair-request',{searchId:root.sent.searchId,replacement:{
      ...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxWitnesses:1},
      domain:{...request.domain,parameters:[{...request.domain.parameters[0],values:['2']},request.domain.parameters[1]]}}}),202);
    await queue.tick();
    const limited=ok(await api(f,'counterexample-ledger',{searchId:child.searchId}));
    const allocations=(await admin!.query("SELECT allocation_key FROM finnor_os.m4_allocations WHERE root_search_id=$1 AND kind='WITNESS'",
      [root.sent.searchId])).rows;
    await artifact('distinct-root-witness-cap.json',{root,limited,allocations});
    assert.equal(allocations.length,1);
    assert.equal(limited.report.result,'BLOCKED');
    assert(limited.report.unresolved.some((g:any)=>g.reason==='WITNESS_ALLOCATION_EXHAUSTED'));
    assert(!limited.ledger.some((e:any)=>e.kind==='VALID_ORIGINAL'),'A new failing input borrowed a different root witness allocation');
    assert.equal(ok(await api(f,'counterexample-read',{searchId:root.sent.searchId})).report.result,'FAILURE_WITNESS');
    return {distinct:distinct.report.ref,root:root.report.ref,limited:limited.report.ref};
  });
  await challenge('positive-no-witness-and-budget','Valid exact candidate remains available; exhausted cells and unsupported work honest',async()=>{
    const valid=await run({...request,idempotencyKey:randomUUID(),evaluations:[{...request.evaluations[0],value:'1'}]});
    assert.equal(valid.report.result,'NO_WITNESS_WITHIN_BUDGET');assert.equal(valid.report.witnesses.length,0);assert(valid.report.coverage.checkedCells>0);
    const limited=await run({...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxCells:1}});
    assert.equal(limited.report.result,'NO_WITNESS_WITHIN_BUDGET');assert(limited.report.unresolved.some((g:any)=>g.reason==='SEARCH_BUDGET_EXHAUSTED'));
    const noCheck=await run({...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxTrials:1}});
    assert.equal(noCheck.report.result,'BLOCKED');assert.equal(noCheck.report.coverage.checkedCells,0);
    const retained=await run({...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxTrials:10}});
    assert.equal(retained.report.result,'FAILURE_WITNESS');assert(retained.report.witnesses.length);
    assert.equal(retained.report.witnesses[0].minimization.status,'SUFFICIENT_NOT_MINIMAL');
    assert(retained.report.unresolved.some((g:any)=>g.reason==='SEARCH_BUDGET_EXHAUSTED'));
    assert(retained.report.ledger.trials<=10);
    for(const value of ['NaN','1e100','0.'+'1'.repeat(100)]){
      const bad=await api(f,'counterexample-diagnostic-submit',{...request,idempotencyKey:randomUUID(),
        domain:{...request.domain,parameters:[{candidateId:f.versionId,nodeId:'x',values:[value]}]}});
      assert.equal(bad.status,400);
    }
    await artifact('positive-and-budget.json',{valid,limited,noCheck,retained});return {valid,limited,noCheck,retained};
  });
  await challenge('claim-kind-refusal','Single adverse input cannot refute expectation/probability/causality/ex-ante quality/agreement',async()=>{
    const rows=[];
    for(const claimKind of ['PROBABILITY','EXPECTATION','CAUSAL','EX_ANTE_QUALITY','AGREEMENT']){
      const row=await run({...request,idempotencyKey:randomUUID(),evaluations:[{...request.evaluations[0],claimKind}]});
      assert.equal(row.report.result,'BLOCKED');assert.equal(row.report.witnesses.length,0);
      assert(row.report.unresolved.some((g:any)=>g.reason==='CLAIM_PROTOCOL_UNSUPPORTED'));rows.push(row);
    }
    return rows;
  });
  await challenge('source-literal-and-private-context','Exact same-entity original owner literal contradicts the diagnostic; ambiguous or missing source remains unresolved; ordinary RLS denies foreign principal',async()=>{
    const evaluate=(expected:string,interpretation='EXACT_RECORDED_LITERAL',entityId=assumptions.x)=>({
      kind:'SOURCE_LITERAL',entityType:'pe_assumption',entityId,field:'statement',expected,claimKind:'EXACT_SOURCE',interpretation,
    });
    const failed=await run({...request,idempotencyKey:randomUUID(),evaluations:[evaluate('A fabricated agreement')],
      domain:{parameters:[],maxCombination:1}});
    assert.equal(failed.report.result,'FAILURE_WITNESS');assert.equal(failed.report.witnesses[0].class,'GROUNDING_INTERPRETATION');
    assert.equal(failed.report.witnesses[0].validation.independent.observed,'Generated original x');
    const positive=await run({...request,idempotencyKey:randomUUID(),evaluations:[evaluate('Generated original x')],
      domain:{parameters:[],maxCombination:1}});
    assert.equal(positive.report.result,'NO_WITNESS_WITHIN_BUDGET');
    const ambiguous=await run({...request,idempotencyKey:randomUUID(),evaluations:[evaluate('An agreed waiver','LEGAL_MEANING')],
      domain:{parameters:[],maxCombination:1}});
    assert.equal(ambiguous.report.result,'BLOCKED');assert(ambiguous.report.unresolved.some((g:any)=>g.reason==='LEGAL_INTERPRETATION_UNSUPPORTED'));
    const missing=await run({...request,idempotencyKey:randomUUID(),evaluations:[evaluate('No amendment','EXACT_RECORDED_LITERAL',randomUUID())],
      domain:{parameters:[],maxCombination:1}});
    assert.equal(missing.report.result,'BLOCKED');assert.equal(missing.report.witnesses.length,0);
    const other=f.foreignPrincipal;
    const denied=await api({...f,principal:other},'counterexample-read',{searchId:failed.sent.searchId});
    const absent=await api({...f,principal:other},'counterexample-read',{searchId:randomUUID()});
    assert.equal(denied.status,404);assert.deepEqual(denied.body,absent.body);
    const sql=await withTenantTransaction(f.tenant,{userId:other,readOnly:true},async(_db,c)=>({
      searches:(await c.query('SELECT id FROM finnor_os.m4_searches')).rows,
      payloads:(await c.query('SELECT digest FROM finnor_os.m4_payloads')).rows,
    }));assert.equal(sql.searches.length,0);assert.equal(sql.payloads.length,0);
    const ciphertext=(await admin!.query('SELECT ciphertext FROM finnor_os.m4_payloads WHERE search_id=$1',[failed.sent.searchId])).rows;
    assert(ciphertext.every((r:any)=>!r.ciphertext.includes(Buffer.from('Generated original x'))));
    await artifact('source-and-private.json',{failed,positive,ambiguous,missing,denied,absent,sql,encryption:'NO_PLAINTEXT_SOURCE_IN_SQL_PAYLOAD'});
    return {failed:failed.report.ref,positive:positive.report.result,ambiguous:ambiguous.report.result,missing:missing.report.result,denied,sql};
  });
  await challenge('exact-effect-and-null-readback','Actual isolated POST and independent full GET distinguish C_01/C_010, 20/200, explicit null, and unknown; replay never POSTs',async()=>{
    const rows=[];
    for(const fixture of ['CORRECT','WRONG_TARGET','WRONG_AMOUNT','CLEAR','UNKNOWN']){
      const input={kind:'EFFECT_FIXTURE',fixture,request:{entityId:'C_01',field:'credit_limit',operation:'SET',value:'20',
        unit:'USD',currency:'USD',idempotencyKey:'effect-'+fixture},claimKind:'EXACT_EFFECT'};
      const ran=await run({...request,idempotencyKey:randomUUID(),evaluations:[input],domain:{parameters:[],maxCombination:1}});
      assert.equal(ran.report.result,fixture==='CORRECT'?'NO_WITNESS_WITHIN_BUDGET':fixture==='UNKNOWN'?'BLOCKED':'FAILURE_WITNESS');
      if(ran.report.witnesses.length){
        const witness=ran.report.witnesses[0];assert.equal(witness.class,'EFFECT_INTERFACE');
        assert.equal(witness.validation.independent.observed.requestedEntity,'C_01');
        assert.equal(witness.validation.independent.observed.observedEntity,fixture==='WRONG_TARGET'?'C_010':'C_01');
        assert.equal(witness.validation.independent.observed.observed,fixture==='WRONG_AMOUNT'?'200':fixture==='CLEAR'?null:'20');
        const replay=ok(await api(f,'counterexample-witness-replay',{searchId:ran.sent.searchId,witnessRef:witness.ref}));
        assert.equal(replay.effectReexecuted,false);assert.equal(replay.replay,'RETAINED_INDEPENDENT_OBSERVATION_ONLY');
      }rows.push(ran);
    }
    const clear=await run({...request,idempotencyKey:randomUUID(),evaluations:[{kind:'EFFECT_FIXTURE',fixture:'CORRECT',
      request:{entityId:'C_01',field:'credit_limit',operation:'CLEAR',value:null,unit:'USD',currency:'USD',idempotencyKey:'exact-clear'},
      claimKind:'EXACT_EFFECT'}],domain:{parameters:[],maxCombination:1}});
    assert.equal(clear.report.result,'NO_WITNESS_WITHIN_BUDGET');await artifact('exact-effects.json',{rows,clear});
    return {rows:rows.map(r=>({searchId:r.sent.searchId,result:r.report.result,witnesses:r.report.witnesses})),clear:clear.report.result};
  });
  await challenge('work-queue-cold-durable','Actual queue and ordinary RLS cold read reproduce exact persisted result',async()=>{
    if(!submission){const ran=await run();submission=ran.sent;result=ran.report;}
    const path=await artifact('cold-input.json',{tenantId:f.tenant,principalId:f.principal,searchId:submission.searchId});
    const child=spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m4/cold.mts'),path],{
      cwd:join(repo,'finnor-os'),env:process.env,stdio:['ignore','pipe','pipe','ipc']});children.add(child);
    const cold=await new Promise<any>((yes,no)=>{let stderr='',message:any;const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('COLD_TIMEOUT'));},30000);
      child.stderr!.on('data',b=>stderr+=b);child.on('message',m=>{message=m;});child.on('error',no);
      child.on('exit',(code,signal)=>{clearTimeout(timer);children.delete(child);if(code!==0||signal||!message)no(Error(`COLD_EXIT:${code}:${signal}:${stderr}`));else yes(message);});});
    assert.equal(cold.status,200);assert.equal(cold.body.report.ref.contentDigest,result.ref.contentDigest);
    const sql=await withTenantTransaction(f.tenant,{userId:f.principal,readOnly:true},async(_db,c)=>({
      role:(await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
      rows:(await c.query('SELECT id,status FROM finnor_os.m4_searches WHERE id=$1',[submission.searchId])).rows,
    }));
    assert.equal(sql.role.rolsuper,false);assert.equal(sql.role.rolbypassrls,false);assert.equal(sql.rows.length,1);
    await artifact('cold-results.json',{cold,sql});return {cold,sql};
  });
  await challenge('idempotency-cancel-fence-crash','Exact duplicate reuses durable query; changed content conflicts; before-start cancellation fences worker',async()=>{
    const first=ok(await api(f,'counterexample-diagnostic-submit',{...request,idempotencyKey:'m4-idempotency'}),202);
    const duplicate=ok(await api(f,'counterexample-diagnostic-submit',{...request,idempotencyKey:'m4-idempotency'}),202);
    assert.equal(first.searchId,duplicate.searchId);
    const conflict=await api(f,'counterexample-diagnostic-submit',{...request,idempotencyKey:'m4-idempotency',
      evaluations:[{...request.evaluations[0],value:'1'}]});assert.equal(conflict.status,409);
    const cancelled=ok(await api(f,'counterexample-cancel',{searchId:first.searchId}));
    assert.equal(cancelled.status,'CANCELLED');await queue.tick();
    const read=ok(await api(f,'counterexample-read',{searchId:first.searchId}));assert.equal(read.status,'CANCELLED');assert.equal(read.report,null);
    return {first,duplicate,conflict,cancelled,read};
  });
  await challenge('parent-cancel-fences-repair-descendants','Cancelling the parent fences queued descendants and dependent use of completed descendants without erasing evidence',async()=>{
    const fresh=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
      source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
      resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
    slice=fresh;request={...request,sliceRef:fresh.ref};
    const body={...request,sliceRef:fresh.ref,domain:{parameters:[],maxCombination:1},
      evaluations:[{...request.evaluations[0],value:'-1'}],limits:{...request.limits,maxReductions:0}};
    const first=await run({...body,idempotencyKey:randomUUID()});
    const queued=ok(await api(f,'counterexample-repair-request',{searchId:first.sent.searchId,
      replacement:{...body,idempotencyKey:randomUUID()}}),202);
    ok(await api(f,'counterexample-cancel',{searchId:first.sent.searchId}));await queue.tick();
    const refused=ok(await api(f,'counterexample-ledger',{searchId:queued.searchId}));
    await artifact('parent-cancel-before-start.json',{first,queued,refused});
    assert.equal(refused.status,'CANCELLED');assert.equal(refused.report,null);assert.equal(refused.trials,0);
    const second=await run({...body,idempotencyKey:randomUUID()});
    const completed=ok(await api(f,'counterexample-repair-request',{searchId:second.sent.searchId,
      replacement:{...body,idempotencyKey:randomUUID()}}),202);
    await queue.tick();const before=ok(await api(f,'counterexample-read',{searchId:completed.searchId}));
    ok(await api(f,'counterexample-cancel',{searchId:second.sent.searchId}));
    const after=ok(await api(f,'counterexample-read',{searchId:completed.searchId}));
    assert.equal(after.report.ref.contentDigest,before.report.ref.contentDigest);
    assert.equal(after.applicability.status,'CANCELLED');
    const replay=await api(f,'counterexample-witness-replay',{searchId:completed.searchId,witnessRef:before.report.witnesses[0].ref});
    assert.equal(replay.status,409);
    const next=await api(f,'counterexample-repair-request',{searchId:completed.searchId,
      replacement:{...body,idempotencyKey:randomUUID()}});
    assert.equal(next.status,409);
    await artifact('parent-cancel-after-publication.json',{second,completed,before,after,replay,next});
    return {queuedRefusal:refused.status,historicalReport:after.report.ref,applicability:after.applicability,replay,next};
  });
  await storageChallenges({f,api,ok,run,challenge,artifact});
  await challenge('repair-affected-closure','New diagnostic version links earlier result and rechecks witnesses without in-place mutation',async()=>{
    // A repair is inside its own initial challenge episode, not a fresh allowance
    // on a root that waited through unrelated registered cases.
    const initial=await run();
    const repaired=ok(await api(f,'counterexample-repair-request',{searchId:initial.sent.searchId,
      replacement:{...request,idempotencyKey:randomUUID(),evaluations:[{...request.evaluations[0],value:'1'}]}}),202);
    await queue.tick();const read=ok(await api(f,'counterexample-read',{searchId:repaired.searchId}));
    assert.equal(read.report.result,'NO_WITNESS_WITHIN_BUDGET');assert.equal(read.report.parentResultRef.contentDigest,initial.report.ref.contentDigest);
    assert(read.report.repairReplay.length);assert(read.report.repairReplay.every((r:any)=>r.scopeChange==='PREDICATE_CHANGED'));
    const prior=ok(await api(f,'counterexample-read',{searchId:initial.sent.searchId}));
    assert.equal(prior.report.result,'FAILURE_WITNESS');
    for(const bound of ['maxTargets','maxReductions','maxWitnesses']){
      const narrow={...request.limits,[bound]:bound==='maxReductions'?0:1};
      const parent=await run({...request,idempotencyKey:randomUUID(),limits:narrow});
      const widened=await api(f,'counterexample-repair-request',{searchId:parent.sent.searchId,
        replacement:{...request,idempotencyKey:randomUUID(),limits:{...narrow,[bound]:narrow[bound]+1}}});
      assert.equal(widened.status,400,`Repair widened ${bound}`);
    }
    const bounded=await run({...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxTrials:20,maxWitnesses:1}});
    const linked=ok(await api(f,'counterexample-repair-request',{searchId:bounded.sent.searchId,
      replacement:{...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxTrials:20,maxWitnesses:1}}}),202);
    await queue.tick();const next=ok(await api(f,'counterexample-read',{searchId:linked.searchId}));
    assert.equal(next.report.result,'FAILURE_WITNESS');
    const replayAttempts=[];
    for(let i=0;i<20;i++){
      const replay=await api(f,'counterexample-witness-replay',{searchId:linked.searchId,witnessRef:next.report.witnesses[0].ref});
      replayAttempts.push(replay);
      if(replay.status===413)break;
      assert.equal(replay.status,200);
    }
    const charged=(await admin!.query('SELECT id,trials FROM finnor_os.m4_searches WHERE id=ANY($1::uuid[])',
      [[bounded.sent.searchId,linked.searchId]])).rows;
    assert.equal(replayAttempts.at(-1)!.status,413,'Linked replay acquired an independent allowance');
    assert(charged.every((row:any)=>row.trials<=20));
    assert.equal(charged.find((row:any)=>row.id===bounded.sent.searchId)!.trials,20);
    await artifact('repair-parent-budget.json',{bounded,linked,next,replayAttempts,charged});
    return {repaired,read,prior,charged};
  });
  await challenge('owner-version-repair-and-s4-stop-fallback','The native owner changes its version, not the asserted bound; earlier failing inputs are rechecked on the new bytes',async()=>{
    const fresh=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
      source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
      resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
    const original={...request,sliceRef:fresh.ref,idempotencyKey:randomUUID(),limits:{...request.limits,maxReductions:0}};
    const failed=await run(original);
    const repairedDefinition={...definition,modelVersion:'2',nodes:[
      ...definition.nodes.filter((n:any)=>n.id!=='score'),
      {id:'repair_offset',kind:'constant',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:[],
        value:'0.5',truthClass:'MODEL_PARAMETER'},
      {id:'repaired_score',kind:'expression',valueType:'decimal',unit:'ratio',shape:'scalar',
        dependencies:['product','repair_offset'],expression:{op:'subtract',
          args:[{op:'ref',nodeId:'product'},{op:'ref',nodeId:'repair_offset'}]}},
      {id:'score',kind:'output',valueType:'decimal',unit:'ratio',shape:'scalar',
        dependencies:['repaired_score'],sourceNodeId:'repaired_score'},
    ]};
    const version=await createUnderwritingModelVersion(f.ctx,{modelId:f.modelId,definition:repairedDefinition,
      parentVersionId:f.versionId});
    const repairedId=String(version.id);
    const next=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
      source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:repairedId},purpose:'MODEL_EVIDENCE',
      resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
    const linked=ok(await api(f,'counterexample-repair-request',{searchId:failed.sent.searchId,replacement:{
      ...original,sliceRef:next.ref,idempotencyKey:randomUUID(),
      evaluations:original.evaluations.map((e:any)=>({...e,candidateId:repairedId})),
      domain:{...original.domain,parameters:original.domain.parameters.map((a:any)=>({...a,candidateId:repairedId}))},
    }}),202);
    await queue.tick();const read=ok(await api(f,'counterexample-ledger',{searchId:linked.searchId}));
    await artifact('owner-version-repair.json',{failed,repairedDefinition,version,next,linked,read});
    assert.equal(read.report.result,'NO_WITNESS_WITHIN_BUDGET');
    assert.equal(read.report.parentResultRef.contentDigest,failed.report.ref.contentDigest);
    assert(read.report.repairReplay.every((r:any)=>r.outcome==='INVALID'&&r.scopeChange==='CANDIDATE_VERSION_CHANGED'),
      'Changing the owner version skipped the original failing input');
    const replayed=read.ledger.find((e:any)=>e.kind==='REPAIR_CHECK');
    assert(replayed,'No actual original-input repair check was retained');
    assert.equal(replayed.body.validation.independent.checker,'M4_FRACTION_ORIGINAL_IR_V1');
    assert.equal(replayed.body.validation.independent.observed,'1/2');
    assert.equal(ok(await api(f,'counterexample-read',{searchId:failed.sent.searchId})).report.result,'FAILURE_WITNESS');
    return {originalResult:failed.report.ref,newOwnerVersion:repairedId,repairedResult:read.report.ref,
      replay:read.report.repairReplay,normativeM3Join:'PENDING_READER'};
  });
  if(!selected||selected.some(id=>['original-s5-covenant-and-bound','dated-signed-resource-semantics','lawful-s3-s4-common-worlds'].includes(id)))
    await ownerChallenges({repo,admin,api,ok,artifact,challenge,request,queue});
  await liabilityChallenges({repo,admin,api,ok,artifact,challenge,request,queue});
  await challenge('currentness-and-owner-noninterference','Dry challenge does not mutate S4/S5/S6; changed Work preserves historical witness but refuses current use',async()=>{
    // Earlier owner fixtures can outlive the original slice's validity. Start
    // this independent currentness test at a new authentic owner read, never by
    // extending the original cut or weakening its expiry check.
    const refreshed=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
      source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
      resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
    await artifact('currentness-starting-cut.json',{originalSliceRef:slice.ref,refreshed});
    request={...request,sliceRef:refreshed.ref};
    const state=async()=>admin!.query("SELECT (SELECT count(*) FROM finnor_os.business_effects WHERE tenant_id=$1)::text effects,(SELECT count(*) FROM finnor_os.s5_reservations WHERE tenant_id=$1)::text reservations",[f.tenant]);
    const before=(await state()).rows;const ran=await run();const after=(await state()).rows;assert.deepEqual(after,before);
    await receiveWork({tenantId:f.tenant,userId:f.principal,workId:f.workId,instruction:'New exact Work input invalidates old dependent use',
      channel:'console',idempotencyKey:'m4-new-input'});
    const old=ok(await api(f,'counterexample-read',{searchId:ran.sent.searchId}));
    assert.equal(old.applicability.status,'STALE');assert.equal(old.report.result,'FAILURE_WITNESS');
    const replay=await api(f,'counterexample-witness-replay',{searchId:ran.sent.searchId,witnessRef:ran.report.witnesses[0].ref});
    assert.equal(replay.status,409);return {before,after,old,replay};
  });
  await p4Challenges({f,api,ok,challenge,artifact,request,queue});
  await boundaryChallenges({f,admin,api,ok,queue,request,challenge,artifact});
  await partialChallenges({f,repo,admin,api,ok,queue,request,challenge,artifact,children});
  await recoveryChallenges({f,repo,admin,api,ok,challenge,artifact,request,children});
  await browserChallenges({f,repo,output,admin,queue,challenge,artifact});
}catch(error){
  cases.push({id:'harness-setup-or-prerequisite',status:'FAIL',observed:{message:(error as Error).message,stack:(error as Error).stack}});await save();
}finally{
  for(const child of children)child.kill('SIGKILL');
  await closePool();await admin?.end();await postgres.stop();await save();
}
process.exit(cases.some(c=>c.status==='FAIL')||!cases.length?1:0);
