/** Failure-first M1 owner/API/persistence/consumer contracts, authored before production code. */
import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { closePool, configureTenantVertical, receiveWork, withTenantTransaction } from '@finnor/db';
import { createAssumption, createDeal, createInvestmentCase, createUnderwritingModel, createUnderwritingModelVersion,
  createUnderwritingScenario, attachWorkToDealGraph, invalidateAssumption, type PeMutationContext } from '@finnor/private-equity';
import { createMetricSeries, recordMetricObservation, restateMetricObservation } from '@finnor/private-equity';
import { createEvidenceSource, appendEvidenceVersion } from '@finnor/memory';
import { loadEnterpriseBeliefView, validateBeliefViewPin } from '../../packages/private-equity/src/enterprise-beliefs';
import { UNDERWRITING_ENGINE_VERSION, FINANCIAL_CONVENTION_VERSION, decimal, type UnderwritingModelIR } from '@finnor/underwriting';
import { epistemicHash } from '@finnor/epistemic-runtime';
import { migrate } from '../../packages/db/migrate';
import { POST } from '../../apps/api/app/api/company-brain/[operation]/route';
import { checkDecisionProjection } from '../../packages/private-equity/src/decision-slice/checker';
import { publicReference } from './reference.mjs';
import { createUpstreamFixtureSupport } from '../s5/owner-fixture.mjs';
import { POST as allocationPost } from '../../apps/api/app/api/allocations/[operation]/route';
import { browserChallenge } from './browser.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const output=process.env.FINNOR_M1_EVIDENCE_DIR!;
const selected=process.env.FINNOR_M1_CASE_FILTER?.split(',');
const startedAt=new Date().toISOString(),cases:any[]=[],calls:any[]=[],children=new Set<ChildProcess>();
const artifact=async(name:string,value:unknown)=>{const path=join(output,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');return path;};
async function save(){await artifact('results.json',{schema:'finnor.m1.e2e.v1',startedAt,finishedAt:new Date().toISOString(),cases,calls,
  sourceIdentity,preregistration:JSON.parse(await readFile(join(repo,'scope-pm/phase-02-m1-decision-slice/scope-evidence/test-registration.json'),'utf8')),
  selection:selected??'FULL_REGISTERED_RUN',unmatchedSelection:selected?.filter(id=>!cases.some(c=>c.id===id))??[],node:process.version,environmentNames:Object.keys(process.env).sort(),
  qualification:'Public/generated H0/H1; actual ordinary-role SQL/S1/native owners/API/Work/store/consumer, development header identity. No hosted JWT, protected admission, sealed comparison or H2 evidence.',
  costs:{money:null,status:'UNMETERED',externalModelCalls:0},rerun:'python3 finnor-os/scripts/m1/run-local.py'});}
async function challenge(id:string,expected:string,fn:()=>Promise<unknown>){if(selected&&!selected.includes(id))return;const t=performance.now();
  try{const observed:any=await fn();cases.push({id,expected,status:observed?.validationStatus&&observed.validationStatus!=='PASS'?observed.validationStatus:'PASS',observed,elapsedMs:performance.now()-t});}
  catch(e){cases.push({id,expected,status:'FAIL',observed:e instanceof Error?{message:e.message,stack:e.stack}:String(e),elapsedMs:performance.now()-t});}
  console.log(JSON.stringify({id,status:cases.at(-1).status}));await save();}
async function api(f:any,operation:string,body:unknown,handler=POST){const t=performance.now();
  const response=await handler(new Request(`http://127.0.0.1/api/company-brain/${operation}`,{method:'POST',
    headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body)}),
    {params:Promise.resolve({operation})});
  const result={status:response.status,body:await response.json() as any};
  calls.push({operation,httpStatus:result.status,tenantId:f.tenant,elapsedMs:performance.now()-t});return result;}
function success(r:any){assert.equal(r.status,200,JSON.stringify(r));return r.body;}
const sourceIdentity:any[]=[];
for(const path of ['finnor-os/scripts/m1/run-e2e.mts','finnor-os/scripts/m1/reference.mts','scope-pm/phase-02-m1-decision-slice/failure-model.md',
  'scope-pm/phase-02-m1-decision-slice/scope-evidence/test-registration.json','finnor-os/package-lock.json','package-lock.json']){
  sourceIdentity.push({path,sha256:createHash('sha256').update(await readFile(join(repo,path))).digest('hex')});}
const dir=await mkdtemp(join(tmpdir(),'finnor-m1-'));
const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return no(Error('port'));s.close(()=>yes(a.port));});});
const postgres=new EmbeddedPostgres({databaseDir:dir,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
let admin:pg.Client|undefined;
const f:any={tenant:randomUUID(),principal:randomUUID(),rootId:randomUUID()};
f.ctx={auth:{tenantId:f.tenant,userId:f.principal,employeeId:f.principal,role:'owner'}} as PeMutationContext;
let slice:any,request:any,forged:any;
async function cold(operation:string,body:unknown,scope=f,options:{pauseAfterResult?:boolean}={}){
  const path=await artifact(`cold/${randomUUID()}.json`,{tenantId:scope.tenant,principalId:scope.principal,operation,body,...options});
  const child=spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m1/cold.mts'),path],{cwd:join(repo,'finnor-os'),env:process.env,stdio:['ignore','pipe','pipe','ipc']});
  children.add(child);let stderr='';child.stderr!.on('data',b=>stderr+=b);
  const result=new Promise<any>((yes,no)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('COLD_TIMEOUT'));},30000);
    child.on('message',(m:any)=>{if(m.kind==='RESULT'){clearTimeout(timer);yes(m.result);}});
    child.on('error',no);child.on('exit',(code,signal)=>{clearTimeout(timer);children.delete(child);if(code!==0||signal)no(Error(`COLD_EXIT:${code}:${signal}:${stderr}`));});});
  const exit=new Promise<any>(yes=>child.on('exit',(code,signal)=>yes({code,signal})));void result.catch(()=>undefined);
  return {child,result,exit};
}
try{
  await postgres.initialise();await appendFile(join(dir,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('m1_e2e');
  const url=`postgres://finnor:finnor@127.0.0.1:${port}/m1_e2e`;await migrate(url);
  admin=new pg.Client({connectionString:url});await admin.connect();await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'M1 disposable project')",[f.tenant,randomUUID()]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,'m1@example.test','owner','active')",[f.principal,f.tenant]);
  await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'m1-target','M1 generated target','other')",[f.rootId,f.tenant]);
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('provider:m1-native',2,2,0,120,true,'M1 disposable native E2E with two CAS contenders') ON CONFLICT(resource_key) DO NOTHING");
  process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/m1_e2e`;await closePool();
  await configureTenantVertical({tenantId:f.tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:f.principal,sourceSystem:'m1:e2e'});
  f.dealId=(await createDeal(f.ctx,{targetOrganizationId:f.rootId,name:'M1 source-backed case',dealLeadEmployeeId:f.principal,signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)})).row.id;
  f.caseId=(await createInvestmentCase(f.ctx,{dealId:f.dealId,title:'M1 actual numerical case'})).row.id;
  const assumptions:any={};
  for(const [id,value]of[['x','0'],['y','0'],['cap','1'],['alternate','7']])assumptions[id!]=String((await createAssumption(f.ctx,{dealId:f.dealId,investmentCaseId:f.caseId,assumptionKey:id!,statement:`Generated ${id}`,valueType:'number',value:Number(value),unit:'ratio'})).row.id);
  const input=(id:string)=>({id,kind:'input' as const,valueType:'decimal' as const,unit:'ratio' as const,shape:'scalar' as const,dependencies:[],required:true,source:{kind:'p1_assumption' as const,assumptionId:assumptions[id]}});
  const definition:UnderwritingModelIR={schemaVersion:'underwriting-model-ir.v1',modelKey:'m1-source-backed',modelVersion:'1',financialConventionVersion:FINANCIAL_CONVENTION_VERSION,minimumEngineVersion:UNDERWRITING_ENGINE_VERSION,
    periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
      ...['x','y','cap','alternate'].map(input),
      {id:'product',kind:'expression',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['x','y'],expression:{op:'multiply',args:[{op:'ref',nodeId:'x'},{op:'ref',nodeId:'y'}]}},
      {id:'choice',kind:'expression',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['cap','product','alternate'],expression:{op:'if',condition:{op:'compare',comparison:'gte',left:{op:'ref',nodeId:'cap'},right:{op:'literal',value:'1',valueType:'decimal',unit:'ratio'}},then:{op:'ref',nodeId:'product'},else:{op:'ref',nodeId:'alternate'}}},
      {id:'covenant',kind:'check',valueType:'boolean',unit:'boolean',shape:'scalar',dependencies:['cap'],assertion:{op:'compare',comparison:'lte',left:{op:'ref',nodeId:'cap'},right:{op:'literal',value:'1',valueType:'decimal',unit:'ratio'}},failureCode:'LIQUIDITY_SHORTFALL',severity:'error'},
      {id:'score',kind:'output',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['choice'],sourceNodeId:'choice'},
      {id:'unrelated',kind:'constant',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:[],value:'999',truthClass:'MODEL_PARAMETER'},
    ]};
  f.modelId=String((await createUnderwritingModel(f.ctx,{investmentCaseId:f.caseId,modelKey:definition.modelKey,name:'M1 native dependency model'})).id);
  f.versionId=String((await createUnderwritingModelVersion(f.ctx,{modelId:f.modelId,definition})).id);
  const work=await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Compare registered model score while retaining legal gaps',channel:'console',idempotencyKey:'m1-first'});
  f.workId=work.workId;await attachWorkToDealGraph(f.ctx,{workId:f.workId,dealId:f.dealId,entities:[{entityType:'pe_investment_case',entityId:f.caseId}]});
  request={schema:'finnor.decision-slice-request.v1',workId:f.workId,source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'ACQUISITION',resource:{deadlineMs:30000,maxNodes:2048,maxBytes:8388608,maxDemands:128}};
  await artifact('native/inputs.json',{request,definition,assumptions,qualification:'Generated owner assumptions, not observed or calibrated economic truth'});
  const viewProbe=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId}});
  const currentProbe=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId},validAt:viewProbe.validAt});
  await artifact('native/s1-clock-probe.json',{view:viewProbe,current:currentProbe,validation:await validateBeliefViewPin(f.ctx,viewProbe.pin)});
  if(selected&&!selected.includes('native-api-work-consumer-witness-cold-reconstruction'))
    slice=success(await api(f,'decision-slice-compile',request)).slice;

  await challenge('native-api-work-consumer-witness-cold-reconstruction','Actual Work → independently checked slice → native numerical consumer → witness → cold context, score0; closure retains x,y,cap,alternate/product/covenant',async()=>{
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    assert.equal(slice.schema,'finnor.decision-slice.v1');assert.equal(slice.envelope.executionAuthorityGranted,false);
    const ids=slice.materialVariables.map((v:any)=>v.nativeId);
    for(const id of ['x','y','cap','alternate','product','choice','covenant','score'])assert(ids.includes(id),`Missing preregistered dependency ${id}`);
    assert.equal(slice.projectionLoss,null);assert.equal(slice.projectionSupport.status,'EXACT_DEPENDENCY_PRESERVATION');
    const consumed=success(await api(f,'decision-slice-consume',{sliceRef:slice.ref,use:'NUMERICAL_ONLY'}));
    assert.equal(consumed.status,'NATIVE_NUMERICAL_ONLY');assert.equal(consumed.runs[0].result.outputs.score.value,'0');
    const witness=success(await api(f,'decision-slice-witness',{sliceRef:slice.ref,variableId:slice.materialVariables.find((v:any)=>v.nativeId==='x').id}));
    assert(witness.native.length);assert.equal(witness.executionAuthorityGranted,false);
    const before=success(await api(f,'decision-slice-context',{sliceRef:slice.ref}));
    await rm(join(process.env.FINNOR_M1_STORE!,f.tenant,f.principal,'working',slice.ref.contentDigest+'.json'));
    const child=await cold('decision-slice-context',{sliceRef:slice.ref}),reconstructed=success(await child.result);await child.exit;
    assert.equal(reconstructed.context.qualifiedDigest,before.context.qualifiedDigest);
    const path=await artifact('native/results.json',{slice,consumed,witness,before,reconstructed});return {path,exactDeps:ids,score:'0'};
  });
  await challenge('fatal-remote-change-of-control-appendix','Correct200-page summary cannot close operative clause completeness; DECISION use refuses',async()=>{
    assert(slice);const appendix='Appendix Z page200: on a change of control the material customer contract terminates automatically.';
    await artifact('appendix/room.json',{pageCount:200,summary:'Financial summary is correct.',remoteOperativeClause:appendix,oracle:'Must retain exact clause or keep material gap, never absence from summary'});
    assert(slice.unresolvedCoverage.some((g:any)=>/CHANGE_OF_CONTROL|OPERATIVE_DOCUMENT/.test(g.code)));
    const refused=success(await api(f,'decision-slice-consume',{sliceRef:slice.ref,use:'DECISION'}));assert.equal(refused.status,'INSUFFICIENT_DECISION_COVERAGE');assert.equal(refused.executionAuthorityGranted,false);
    return {refused,materialLegalGap:true};
  });
  await challenge('joint-product-threshold-conditional-arms','Zero single-variable marginal sensitivity cannot exclude x or y or inactive alternate; checker catches missing joint group',async()=>{
    assert(slice);for(const id of ['x','y','alternate'])assert(slice.materialVariables.some((v:any)=>v.nativeId===id));
    const native=success(await api(f,'decision-slice-read',{sliceRef:slice.ref}));
    forged=structuredClone(native.slice.projectionSupport.witness);forged.retainedIds=forged.retainedIds.filter((id:string)=>!id.endsWith(':x'));
    const checked=checkDecisionProjection(native.projectionInput,forged);assert.equal(checked.status,'REJECTED');
    return {oneAtATimeValues:{base:0,xOnly:0,yOnly:0,joint:1},checked};
  });
  await challenge('missing-budget-and-tampered-projection-witness','No maxRegret or caller budget may authorize numeric omission; tamper graph or bound refuses',async()=>{
    const illegal=await api(f,'decision-slice-compile',{...request,projectionBudget:{unit:'USD',maximum:100}});assert.equal(illegal.status,400);
    const read=success(await api(f,'decision-slice-read',{sliceRef:slice.ref}));
    const witness=structuredClone(read.slice.projectionSupport.witness);witness.graphDigest='0'.repeat(64);
    assert.equal(checkDecisionProjection(read.projectionInput,witness).status,'REJECTED');
    assert(read.slice.projectionBudgetRequest);assert.equal(read.slice.projectionBudgetRequest.authorizationGranted,false);
    return {illegal,projectionLoss:read.slice.projectionLoss};
  });
  await challenge('bounded-owner-io-and-failed-liability','A locked real governor query cannot outlive the whole request envelope, no late publication occurs, and the failed attempt stays recorded',async()=>{
    await admin!.query('BEGIN');
    await admin!.query("SELECT resource_key FROM finnor_os.compute_resource_policies WHERE resource_key='provider:m1-native' FOR UPDATE");
    const release=setTimeout(()=>{void admin!.query('COMMIT');},1500),started=performance.now();
    let refused:any;
    try{refused=await api(f,'decision-slice-compile',{...request,resource:{...request.resource,deadlineMs:350}});}
    finally{clearTimeout(release);await admin!.query('COMMIT');}
    const elapsed=performance.now()-started;
    await artifact('bounded-owner-io.json',{deadlineMs:350,elapsedMs:elapsed,refused,expected:'413 before 1250ms; failed liability and incumbent retained'});
    assert.equal(refused.status,413);assert(elapsed<1250,'Native SQL acquisition exceeded the whole request deadline');
    const current=success(await api(f,'decision-slice-read',{sliceRef:slice.ref}));assert.equal(current.slice.ref.id,slice.ref.id);
    const records=await import('node:fs/promises').then(fs=>fs.readdir(join(process.env.FINNOR_M1_STORE!,f.tenant,f.principal,'attempts')));
    const attempts=await Promise.all(records.map(async name=>JSON.parse(await readFile(join(process.env.FINNOR_M1_STORE!,f.tenant,f.principal,'attempts',name),'utf8'))));
    const failures=attempts.filter(record=>record.body.status==='FAILED');assert(failures.length>0);
    return {elapsedMs:elapsed,failedAttemptRefs:failures.map(record=>record.ref),incumbent:slice.ref};
  });
  await challenge('whole-authentication-and-body-stream-deadline','The same attenuated deadline bounds real runtime authorization SQL and physical body streaming before dispatch',async()=>{
    const body=JSON.stringify({...request,resource:{...request.resource,deadlineMs:350}}),encoder=new TextEncoder();
    let timer:ReturnType<typeof setTimeout>,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(encoder.encode(body.slice(0,1)));timer=setTimeout(()=>{controller.enqueue(encoder.encode(body.slice(1)));controller.close();},1000);},
      cancel(){cancelled=true;clearTimeout(timer);},
    });
    const headers={'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal,'x-decision-slice-deadline-ms':'350'};
    const init:RequestInit&{duplex:'half'}={method:'POST',headers,body:stream,duplex:'half'};
    const t=performance.now(),response=await POST(new Request('http://127.0.0.1/api/company-brain/decision-slice-compile',init),
      {params:Promise.resolve({operation:'decision-slice-compile'})});
    const bodyResult={status:response.status,body:await response.json(),elapsedMs:performance.now()-t,cancelled};
    await artifact('deadline/auth-body.json',{bodyResult});assert.equal(response.status,413);assert(bodyResult.elapsedMs<800);assert(cancelled,'Body stream must be physically cancelled');
    await admin!.query('BEGIN');await admin!.query('LOCK TABLE finnor_os.product_runtime_authority IN ACCESS EXCLUSIVE MODE');
    const release=setTimeout(()=>{void admin!.query('COMMIT');},1800),authStart=performance.now();
    try{
      const result=await POST(new Request('http://127.0.0.1/api/company-brain/decision-slice-read',{method:'POST',headers,body:JSON.stringify({sliceRef:slice.ref})}),
        {params:Promise.resolve({operation:'decision-slice-read'})});
      const authResult={status:result.status,body:await result.json(),elapsedMs:performance.now()-authStart};
      await artifact('deadline/auth-body.json',{bodyResult,authResult});assert.equal(result.status,413);assert(authResult.elapsedMs<800);
      return {bodyResult,authResult};
    }finally{clearTimeout(release);await admin!.query('COMMIT');}
  });
  await challenge('semantic-period-currency-entity-instrument-mismatch','Independent checks bind native owner unit/currency/period/entity preimages, and unregistered instrument claims never satisfy a demand',async()=>{
    const current=success(await api(f,'decision-slice-read',{sliceRef:slice.ref})),checks=[];
    for(const [field,value]of[['unit','currency'],['currency','EUR'],['periods',[{frequency:'fiscal',forecastStart:'2026-04-01',count:1}]],['ownerRef',{owner:'other-entity',id:randomUUID(),version:'1',contentDigest:'0'.repeat(64)}]]){
      const proposal=structuredClone(current.projectionInput),node=proposal.graph.nodes.find((node:any)=>node.nativeId==='x');node[field as string]=value;
      const {ref:_ref,...body}=proposal.graph,digest=epistemicHash(body);proposal.graph.ref={...proposal.graph.ref,contentDigest:digest,id:'decision-graph:'+digest};
      const witness={...structuredClone(current.slice.projectionSupport.witness),graphDigest:digest};
      const checked=checkDecisionProjection(proposal,witness);assert.equal(checked.status,'REJECTED');checks.push({field,value,checked});
    }
    const unsupported=await api(f,'decision-slice-compile',{...request,source:{...request.source,instrument:'calibrated-survey',consolidation:'all-affiliates',currency:'EUR'}});
    assert.equal(unsupported.status,400);
    const demands=current.slice.evidenceDemands.filter((d:any)=>d.requiredProducer==='NATIVE');assert(demands.length);
    assert(demands.every((d:any)=>d.semantics.instrument==='NATIVE_ASSUMPTION_OR_OWNER_SOURCE_NOT_A_NEW_MEASUREMENT'));
    const delayed=structuredClone(current.projectionInput),edge=delayed.graph.edges.find((edge:any)=>edge.from.endsWith(':product')&&edge.to.endsWith(':x'));
    edge.lagPeriods=1;const {ref:_delayRef,...delayedBody}=delayed.graph,delayedDigest=epistemicHash(delayedBody);
    delayed.graph.ref={...delayed.graph.ref,contentDigest:delayedDigest,id:'decision-graph:'+delayedDigest};
    const lagCheck=checkDecisionProjection(delayed,{...structuredClone(current.slice.projectionSupport.witness),graphDigest:delayedDigest});
    await artifact('semantics/lag.json',{delayed,lagCheck});assert.equal(lagCheck.status,'REJECTED','A forged lag changes the causal/computational period domain');
    await artifact('semantics/results.json',{checks,unsupported,demands});return {checks,unsupported};
  });
  await challenge('physical-kill-cancel-and-late-publication','Physical death before/after publication retains immutable history and incumbent; owner cancellation fences a blocked old worker without waiting on its source read',async()=>{
    const headPath=join(process.env.FINNOR_M1_STORE!,f.tenant,f.principal,'heads',epistemicHash('work:'+f.workId)+'.json');
    const prior=JSON.parse(await readFile(headPath,'utf8'));
    await admin!.query('BEGIN');await admin!.query('LOCK TABLE finnor_os.pe_assumptions IN ACCESS EXCLUSIVE MODE');
    const child=await cold('decision-slice-compile',request),before=performance.now();
    try{
      let observed:any;
      for(let i=0;i<1000;i++){observed=JSON.parse(await readFile(headPath,'utf8'));if(observed.generation>prior.generation)break;await new Promise(r=>setTimeout(r,10));}
      assert(observed.generation>prior.generation,'Physical child did not reach its publication generation');
      const release=setTimeout(()=>{void admin!.query('COMMIT');},2000);
      const cancellationStarted=performance.now();let cancelled:any;
      try{cancelled=await api(f,'decision-slice-cancel',{sliceRef:slice.ref});}
      finally{clearTimeout(release);await admin!.query('COMMIT');}
      const cancellationMs=performance.now()-cancellationStarted;
      const late=await child.result;await child.exit;
      await artifact('races/cancel.json',{prior,observed,cancelled,cancellationMs,late,totalMs:performance.now()-before});
      assert.equal(cancelled.status,200);assert(cancellationMs<1250,'Cancellation waited on the blocked source query');assert.equal(late.status,409);
      assert.equal((await api(f,'decision-slice-read',{sliceRef:slice.ref})).status,409);
    }finally{await admin!.query('COMMIT');child.child.kill('SIGKILL');}
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    const incumbent=JSON.parse(await readFile(headPath,'utf8'));
    await admin!.query('BEGIN');await admin!.query('LOCK TABLE finnor_os.pe_assumptions IN ACCESS EXCLUSIVE MODE');
    const doomed=await cold('decision-slice-compile',request);
    try{
      let reached=false;for(let i=0;i<1000;i++){const head=JSON.parse(await readFile(headPath,'utf8'));if(head.generation>incumbent.generation){reached=true;break;}await new Promise(r=>setTimeout(r,10));}
      assert(reached);doomed.child.kill('SIGKILL');await doomed.exit;
    }finally{await admin!.query('COMMIT');}
    assert.equal(success(await api(f,'decision-slice-read',{sliceRef:slice.ref})).slice.ref.id,slice.ref.id);
    const published=await cold('decision-slice-compile',request,f,{pauseAfterResult:true});slice=success(await published.result).slice;
    published.child.kill('SIGKILL');await published.exit;
    const context=success(await api(f,'decision-slice-context',{sliceRef:slice.ref}));
    await artifact('races/kill.json',{incumbent,publishedSlice:slice.ref,context,prePublicationDeathPreservedIncumbent:true,postPublicationDeathReconstructed:true});
    return {cancelledOldWorker:true,prePublicationDeathPreservedIncumbent:true,postPublicationDeathReconstructed:true};
  });
  await challenge('presentation-only-patch-cas-corruption-symlink-cold-restart','Notes can change but never verified facts/gaps; forged fields/handles/races/symlinks refuse, corrupt disposable file reconstructs',async()=>{
    const read=success(await api(f,'decision-slice-context',{sliceRef:slice.ref})),revision=read.context.ref;
    const bad=await api(f,'decision-slice-patch',{sliceRef:slice.ref,expectedContextRef:revision,patch:{facts:[],unresolved:[]}});assert.equal(bad.status,400);
    const changes=await Promise.all([api(f,'decision-slice-patch',{sliceRef:slice.ref,expectedContextRef:revision,patch:{notes:['Model agenda only'],agenda:['Inspect the appendix']}}),api(f,'decision-slice-patch',{sliceRef:slice.ref,expectedContextRef:revision,patch:{notes:['Concurrent losing presentation']}})]);
    await artifact('context/concurrent-results.json',changes);
    assert.deepEqual(changes.map(x=>x.status).sort(),[200,409]);
    const after=success(await api(f,'decision-slice-context',{sliceRef:slice.ref}));assert.equal(after.context.qualifiedDigest,read.context.qualifiedDigest);
    const file=join(process.env.FINNOR_M1_STORE!,f.tenant,f.principal,'working',slice.ref.contentDigest+'.json');
    await writeFile(file,'{"corrupted":true}');const repaired=success(await api(f,'decision-slice-context',{sliceRef:slice.ref}));assert.equal(repaired.context.qualifiedDigest,read.context.qualifiedDigest);
    const held=file+'.fixture-backup';await rename(file,held);let denied:any;try{await symlink(held,file);denied=await api(f,'decision-slice-context',{sliceRef:slice.ref});assert.equal(denied.status,404);}finally{await unlink(file);await rename(held,file);}
    const traversal=await api(f,'decision-slice-read',{sliceRef:{...slice.ref,contentDigest:'../../escape'}});assert(traversal.status>=400);
    return {bad,changes,denied,repaired};
  });
  await challenge('foreign-denied-forged-revoked-read-witness-context','Cross-tenant forged refs and revoked principal get indistinguishable unavailable responses with no values/counts',async()=>{
    const foreign={tenant:randomUUID(),principal:randomUUID()};
    await admin!.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'M1 foreign')",[foreign.tenant,randomUUID()]);
    await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,'m1-foreign@example.test','owner','active')",[foreign.principal,foreign.tenant]);
    await configureTenantVertical({tenantId:foreign.tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:foreign.principal,sourceSystem:'m1:e2e'});
    const denied=await api(foreign,'decision-slice-read',{sliceRef:slice.ref});
    const absent=await api(foreign,'decision-slice-read',{sliceRef:{...slice.ref,id:'decision-slice:'+'0'.repeat(64),contentDigest:'0'.repeat(64)}});
    assert.equal(denied.status,404);assert.deepEqual(denied.body,absent.body);
    await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1",[f.principal]);
    let revoked:any;try{revoked=await api(f,'decision-slice-context',{sliceRef:slice.ref});assert.equal(revoked.status,404);}finally{await admin!.query("UPDATE finnor_os.users SET status='active' WHERE id=$1",[f.principal]);}
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    return {denied,absent,revoked};
  });
  await challenge('resource-denied-witness-context-no-existence-leak','Actual S1 resource denial is indistinguishable from an absent private slice on read, context and witness',async()=>{
    const role=(await admin!.query("SELECT role_id FROM finnor_os.employee_role_assignments WHERE employee_id=$1 AND active LIMIT 1",[f.principal])).rows[0].role_id;
    const deny=(await admin!.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:pe_world_state','pe_assumption','deny') RETURNING id",[f.tenant,role])).rows[0].id;
    try{
      const absentRef={...slice.ref,id:'decision-slice:'+'0'.repeat(64),contentDigest:'0'.repeat(64)},responses=[];
      for(const operation of ['decision-slice-read','decision-slice-context','decision-slice-witness']){
        const extra=operation==='decision-slice-witness'?{variableId:slice.materialVariables.find((v:any)=>v.nativeId==='x').id}:{};
        const denied=await api(f,operation,{sliceRef:slice.ref,...extra}),absent=await api(f,operation,{sliceRef:absentRef,...extra});
        responses.push({operation,denied,absent});
        await artifact('access/resource-denial.json',responses);
        assert.equal(denied.status,404);assert.deepEqual(denied.body,absent.body,'Denied and absent refs must not expose different owner paths');
      }
      return {responses};
    }finally{await admin!.query('DELETE FROM finnor_os.role_authority_grants WHERE id=$1',[deny]);slice=success(await api(f,'decision-slice-compile',request)).slice;}
  });
  await challenge('new-financing-collateral-dependency-and-stale-work','Same numeric model with a new financing Work revision invalidates old slice and requires collateral/account-restriction evidence',async()=>{
    const old=slice;await receiveWork({tenantId:f.tenant,userId:f.principal,workId:f.workId,instruction:'New financing cross-collateralizes the restricted account',channel:'console',idempotencyKey:'m1-financing'});
    const stale=await api(f,'decision-slice-consume',{sliceRef:old.ref,use:'NUMERICAL_ONLY'});assert([409,422].includes(stale.status));
    slice=success(await api(f,'decision-slice-compile',{...request,financingChange:true})).slice;
    assert(slice.unresolvedCoverage.some((g:any)=>/COLLATERAL|ACCOUNT_RESTRICTION/.test(g.code)));
    assert.notEqual(slice.envelope.work.inputId,old.envelope.work.inputId);
    return {stale,newSlice:slice.ref,newGaps:slice.unresolvedCoverage};
  });
  await challenge('relevant-membership-change-and-unrelated-root','A genuinely unrelated root preserves the slice; relevant insertion and owner-permitted deletion invalidate it, and immutable history remains',async()=>{
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    const unrelated=randomUUID();await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'M1 unrelated root','other')",[unrelated,f.tenant,unrelated]);
    const unchanged=success(await api(f,'decision-slice-read',{sliceRef:slice.ref}));assert.equal(unchanged.slice.ref.id,slice.ref.id);
    const inserted=await createAssumption(f.ctx,{dealId:f.dealId,investmentCaseId:f.caseId,assumptionKey:'late-collateral-restriction',statement:'A new operative restriction is a membership change even without a financial change',valueType:'number',value:25,unit:'ratio'});
    const invalidated=await api(f,'decision-slice-read',{sliceRef:slice.ref});assert.equal(invalidated.status,409);
    const changes=success(await api(f,'decision-slice-changes',{sliceRef:slice.ref}));assert(changes.changedKeys.some((key:string)=>key.startsWith('s1-membership:')));
    const fresh=success(await api(f,'decision-slice-recompile',{sliceRef:slice.ref})).slice;assert.notEqual(fresh.ref.id,slice.ref.id);
    await invalidateAssumption(f.ctx,{assumptionId:String(inserted.row.id),expectedVersion:1,reason:'Registered logical withdrawal'});
    assert.equal((await api(f,'decision-slice-read',{sliceRef:fresh.ref})).status,409);
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    const history=(await admin!.query("SELECT entity_version,snapshot_hash FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='pe_assumption' AND entity_id=$2 ORDER BY entity_version",[f.tenant,inserted.row.id])).rows;
    assert(history.length>=2);
    await artifact('membership/results.json',{unchanged:unchanged.slice.ref,inserted:inserted.row.id,invalidated,changes,fresh:fresh.ref,history,logicalDeletionSlice:slice.ref});
    return {unrelatedPreserved:true,relevantInsertionInvalidated:true,immutableHistoryRetained:true,logicalDeletionInvalidated:true};
  });
  await challenge('bounded-tail-source-standing-and-knowledge-visibility','A bounded S1 view cannot certify absence; an uncommitted backdated correction stays out of an immutable knowledge cut and present changes invalidate it',async()=>{
    const full=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId}});
    const bounded=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId},knowledgeAt:full.knowledgeAt,maxClaims:1});
    assert(bounded.coverage.truncated);assert.equal(bounded.coverage.absenceClaimsPermitted,false);
    const prehistory=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId},knowledgeAt:'2020-01-01T00:00:00.000Z'});
    assert.equal(prehistory.coverage.canonicalStatus,'UNAVAILABLE_BEFORE_BASELINE');
    const pendingId=randomUUID();
    let release!:()=>void,inserted!:()=>void,failed!:(error:unknown)=>void;
    const pending=new Promise<void>(yes=>{release=yes;}),ready=new Promise<void>((yes,no)=>{inserted=yes;failed=no;});
    const writer=withTenantTransaction(f.tenant,{userId:f.principal},async(_db,client)=>{
      await client.query("INSERT INTO finnor_os.pe_assumptions(id,tenant_id,deal_id,investment_case_id,assumption_key,statement,value_type,value,unit,materiality,source_system,created_by) VALUES($1,$2,$3,$4,'post-cut-hidden-restriction','A source membership insertion committed after the knowledge cut','number','2'::jsonb,'ratio','high','m1:post-cut-fixture',$5)",[pendingId,f.tenant,f.dealId,f.caseId,f.principal]);
      inserted();await pending;
    });void writer.catch(failed);await ready;
    const clockRow=await withTenantTransaction(f.tenant,{userId:f.principal,readOnly:true},async(_db,client)=>(await client.query('SELECT clock_timestamp()::text cut')).rows[0]);
    const cut=String(clockRow.cut);
    let during:any;try{during=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId},knowledgeAt:new Date(cut).toISOString()});}
    finally{release();await writer;}
    const replay=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId},knowledgeAt: during.knowledgeAt});
    const visible=(view:any)=>view.claims.find((claim:any)=>claim.ownerRef.id===pendingId)?.ownerRef;
    assert.equal(visible(during),undefined);
    assert.deepEqual(visible(replay),visible(during));assert.notDeepEqual(visible(await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:f.dealId}})),visible(during));
    const stale=await api(f,'decision-slice-read',{sliceRef:slice.ref});assert.equal(stale.status,409);
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    assert(slice.unresolvedCoverage.some((gap:any)=>/COVERAGE|STANDING|COMPLETENESS/.test(gap.code)));
    const refused=success(await api(f,'decision-slice-consume',{sliceRef:slice.ref,use:'DECISION'}));assert.equal(refused.status,'INSUFFICIENT_DECISION_COVERAGE');
    await artifact('knowledge/results.json',{full:full.pin,bounded,prehistory,during,replay,stale,sliceRef:slice.ref,refused,oracle:'PostgreSQL actual commit visibility, not recorded_at alone'});
    return {boundedAbsenceRefused:true,historyUnavailable:true,postCutCommitExcluded:true,presentCorrectionInvalidated:true};
  });
  await challenge('p4-pending-and-schema-refusal','Unavailable authentic P4 stays pending, native provenance not relabeled, unsupported schema/injected host code refuses',async()=>{
    assert(slice.evidenceDemands.some((d:any)=>d.status==='PENDING_DEPENDENCY'&&d.requiredProducer==='P4'));
    assert(slice.derivedEvidence.every((e:any)=>e.producer!=='P4'));
    const injected=await api(f,'decision-slice-compile',{...request,code:'SELECT * FROM users',source:{...request.source,path:'/etc/passwd'}});
    assert.equal(injected.status,400);return {injected,pending:slice.evidenceDemands.filter((d:any)=>d.status==='PENDING_DEPENDENCY')};
  });
  await challenge('authentic-p4-work-demand-consumer-witness-restart-invalidation','Actual registered handles, durable JobQueue and P4 checks satisfy typed M1 inputs; same Work revision, native50, P4 witness, restart and relevant correction are enforced',async()=>{
    process.env.FINNOR_P4_PROFILE='ordinary_disposable';
    await admin!.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('native:p4',2,2,0,60,true,'M1 exact P4 join disposable engineering capacity') ON CONFLICT(resource_key) DO NOTHING");
    const origin=await createEvidenceSource(f.tenant,{sourceKey:randomUUID(),sourceType:'manual',title:'M1/P4 public original A source'});
    const evidence=await appendEvidenceVersion(f.tenant,origin.id,{content:'Public A EV120 debt70 equity50',snapshot:{EV:'120',debt:'70'},asOf:new Date('2025-01-01')});
    const provenance={evidenceSourceId:origin.id,evidenceVersionId:evidence.versionId},observations:any={};
    const semantics={entityType:'external_organization',entityId:f.rootId,periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T00:00:00.000Z',
      unit:'currency',currencyCode:'USD',frequency:'annual',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'UNSPECIFIED',scale:'1',sign:'AS_RECORDED'} as const;
    for(const [metric,value]of[['EV','120'],['debt','70']]){
      const series=await createMetricSeries(f.ctx,{subjectType:'external_organization',subjectId:f.rootId,metricKey:metric!,name:`M1/P4 ${metric}`,unit:'currency',currencyCode:'USD',frequency:'annual'});
      observations[metric!]=String((await recordMetricObservation(f.ctx,{metricSeriesId:String(series.row.id),periodStart:new Date(semantics.periodStart),periodEnd:new Date(semantics.periodEnd),value:{type:'number',value:value!},evidence:provenance})).row.id);
    }
    const root={entityType:'external_organization',entityId:f.rootId};
    const {entityType:_type,entityId:_entity,...descriptor}=semantics;
    const handles=success(await api(f,'evidence-handles',{root,inputs:['EV','debt'].map(inputId=>({inputId,source:{kind:'metric',subject:root,metricKey:inputId,...descriptor}}))})).handles;
    const submitted=await api(f,'evidence-submit',{schema:'finnor.evidence-request.v1',root,workId:f.workId,question:'Resolve the typed material equity input, EV120 minus debt70, from the exact registered subject and annual period.',
      idempotencyKey:randomUUID(),mode:'ordinary_disposable',inputs:handles.map((h:any)=>({inputId:h.inputId,handleId:h.id})),program:{schema:'finnor.derivation-ir.v1',
        nodes:[{id:'evrows',op:'source',inputId:'EV'},{id:'EV',op:'unique',input:'evrows'},{id:'debtrows',op:'source',inputId:'debt'},{id:'debt',op:'unique',input:'debtrows'},
          {id:'equity',op:'subtract',left:'EV',right:'debt'}],outputs:['equity']},acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:['equity']}});
    assert.equal(submitted.status,202,JSON.stringify(submitted));
    const {JobQueue}=await import('../../apps/worker/src/queue'),queue=new JobQueue('m1-p4-join',3);
    queue.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,
      (await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
    let produced:any;
    for(let i=0;i<12;i++){await queue.tick();produced=success(await api(f,'evidence-read',{queryId:submitted.body.queryId}));if(produced.status==='TESTED')break;await new Promise(r=>setTimeout(r,25));}
    assert.equal(produced.status,'TESTED',JSON.stringify(produced));assert.equal(produced.derivation.result.outputs.equity.value,'50');
    const definition:UnderwritingModelIR={schemaVersion:'underwriting-model-ir.v1',modelKey:'m1-p4-exact',modelVersion:'1',financialConventionVersion:FINANCIAL_CONVENTION_VERSION,
      minimumEngineVersion:UNDERWRITING_ENGINE_VERSION,periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
        {id:'equity',kind:'input',dependencies:[],valueType:'decimal',unit:'money',currency:'USD',shape:'scalar',required:true,allowedTruthClasses:['DERIVED_VALUE'],evidenceSemantics:semantics},
        {id:'equity_out',kind:'output',dependencies:['equity'],sourceNodeId:'equity',valueType:'decimal',unit:'money',currency:'USD',shape:'scalar'}]};
    const model=await createUnderwritingModel(f.ctx,{investmentCaseId:f.caseId,modelKey:definition.modelKey,name:'M1 real P4 consumer'});
    const version=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition});
    const joinedRequest={...request,purpose:'MODEL_EVIDENCE',source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:String(version.id),
      evidenceDerivationInputs:{equity:{derivationId:produced.derivation.id,output:'equity'}}}};
    const compiled=await api(f,'decision-slice-compile',joinedRequest);await artifact('p4-join/producer.json',{handles,submitted,produced,joinedRequest,compiled});
    const joined=success(compiled).slice;assert.equal(joined.envelope.work.inputId,submitted.body.workRevision);
    assert(joined.derivedEvidence.some((d:any)=>d.producer==='P4'&&d.ownerRef.id===produced.derivation.id));
    assert(joined.evidenceDemands.some((d:any)=>d.status==='P4_RESOLVED'&&d.variableIds.some((id:string)=>id.endsWith(':equity'))));
    const consumed=success(await api(f,'decision-slice-consume',{sliceRef:joined.ref,use:'NUMERICAL_ONLY'}));assert.equal(consumed.runs[0].result.outputs.equity_out.value,'50');
    const variable=joined.materialVariables.find((v:any)=>v.nativeId==='equity'),witness=success(await api(f,'decision-slice-witness',{sliceRef:joined.ref,variableId:variable.id}));
    assert.equal(witness.p4Derivation.id,produced.derivation.id);assert(witness.p4Derivation.witnesses.length>=2);
    const context=success(await api(f,'decision-slice-context',{sliceRef:joined.ref})).context;
    const selected=await api(f,'decision-slice-patch',{sliceRef:joined.ref,expectedContextRef:context.ref,
      patch:{selectedHandles:[produced.derivation.sourceHandles[0].id]}});
    assert.equal(selected.status,200,JSON.stringify(selected));assert.equal(selected.body.context.qualifiedDigest,context.qualifiedDigest);
    const restarted=await cold('decision-slice-context',{sliceRef:joined.ref});assert.equal((await restarted.result).status,200);await restarted.exit;
    const mismatchDefinition={...definition,modelVersion:'2',nodes:definition.nodes.map(node=>node.kind==='input'?{...node,evidenceSemantics:{...semantics,periodStart:'2025-04-01T00:00:00.000Z'}}:node)};
    const mismatch=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition:mismatchDefinition});
    const rejected=success(await api(f,'decision-slice-compile',{...joinedRequest,source:{...joinedRequest.source,modelVersionId:String(mismatch.id)}})).slice;
    assert(rejected.unresolvedCoverage.some((g:any)=>g.code==='P4_SEMANTIC_INPUT_MISMATCH'));assert.equal(success(await api(f,'decision-slice-consume',{sliceRef:rejected.ref,use:'NUMERICAL_ONLY'})).status,'INSUFFICIENT_NATIVE_INPUT');
    const retained=success(await api(f,'decision-slice-compile',joinedRequest)).slice;
    await restateMetricObservation(f.ctx,{priorObservationId:observations.debt,expectedVersion:1,replacement:{value:{type:'number',value:'80'},evidence:provenance}});
    const invalid=await api(f,'decision-slice-read',{sliceRef:retained.ref});assert.equal(invalid.status,409,JSON.stringify(invalid));
    const refused=await api(f,'decision-slice-witness',{sliceRef:retained.ref,variableId:variable.id});assert.equal(refused.status,409);
    await artifact('p4-join/consumer.json',{joined,consumed,witness,rejected,invalid,refused});
    const freshHandles=success(await api(f,'evidence-handles',{root,inputs:['EV','debt'].map(inputId=>({inputId,source:{kind:'metric',subject:root,metricKey:inputId,...descriptor}}))})).handles;
    const failedSubmit=await api(f,'evidence-submit',{schema:'finnor.evidence-request.v1',root,workId:f.workId,question:'Public zero-divisor failure, not an equity zero.',
      idempotencyKey:randomUUID(),mode:'ordinary_disposable',inputs:freshHandles.map((h:any)=>({inputId:h.inputId,handleId:h.id})),program:{schema:'finnor.derivation-ir.v1',nodes:[
        {id:'evrows',op:'source',inputId:'EV'},{id:'EV',op:'unique',input:'evrows'},{id:'debtrows',op:'source',inputId:'debt'},{id:'debt',op:'unique',input:'debtrows'},
        {id:'zero',op:'subtract',left:'debt',right:'debt'},{id:'invalid',op:'ratio',left:'EV',right:'zero'}],outputs:['invalid']},
      acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:['invalid']}});
    assert.equal(failedSubmit.status,202);
    let failed:any;
    for(let i=0;i<12;i++){await queue.tick();failed=success(await api(f,'evidence-read',{queryId:failedSubmit.body.queryId}));if(failed.status==='FAILED')break;await new Promise(r=>setTimeout(r,25));}
    assert.equal(failed.status,'FAILED',JSON.stringify(failed));
    const failedQuery=await (await import('../../packages/private-equity/src/evidence-execution/store')).query(f.ctx,failedSubmit.body.queryId);
    assert(failedQuery.derivation_id,'Actual failed producer envelope must remain retained');
    const failedSlice=success(await api(f,'decision-slice-compile',{...joinedRequest,source:{...joinedRequest.source,
      evidenceDerivationInputs:{equity:{derivationId:failedQuery.derivation_id,output:'invalid'}}}})).slice;
    assert.equal(success(await api(f,'decision-slice-consume',{sliceRef:failedSlice.ref,use:'NUMERICAL_ONLY'})).status,'INSUFFICIENT_NATIVE_INPUT');
    assert(!failedSlice.derivedEvidence.some((d:any)=>d.producer==='P4'));
    await artifact('p4-join/failed-producer.json',{failedSubmit,failed,retainedFailedRef:failedQuery.derivation_id,failedSlice});
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    return {producer:produced.derivation.id,joined:joined.ref,nativeOutput:'50',mismatchUnresolved:true,failedProducerRefused:true,correctedOldReadStatus:invalid.status,correctedWitnessStatus:refused.status};
  });
  await challenge('cycles-zero-denominator-decimal-boundaries-partial-search','Native failure cannot be converted into a sufficient zero; solver/opaque/search gaps survive',async()=>{
    const scenario=await createUnderwritingScenario(f.ctx,{investmentCaseId:f.caseId,modelVersionId:f.versionId,scenario:{schemaVersion:'underwriting-scenario.v1',name:'Exact hard-boundary failure',overrides:[{nodeId:'cap',value:'1.0000000000000001',reason:'Independent exact boundary challenge'}]}});
    const partial=success(await api(f,'decision-slice-compile',{...request,source:{...request.source,scenarioIds:[String(scenario.id)]}})).slice;
    const result=success(await api(f,'decision-slice-consume',{sliceRef:partial.ref,use:'NUMERICAL_ONLY'}));assert(result.runs.some((r:any)=>r.result.validity==='INVALID'));assert.equal(result.executionAuthorityGranted,false);
    const divided:UnderwritingModelIR={...definition,modelKey:'m1-zero-denominator',modelVersion:'1',
      nodes:[...definition.nodes,{id:'zero_denominator',kind:'constant',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:[],value:'0',truthClass:'MODEL_PARAMETER'},
        {id:'divide_by_zero',kind:'expression',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['alternate','zero_denominator'],
        expression:{op:'divide',args:[{op:'ref',nodeId:'alternate'},{op:'ref',nodeId:'zero_denominator'}]}}]};
    const zeroModel=await createUnderwritingModel(f.ctx,{investmentCaseId:f.caseId,modelKey:divided.modelKey,name:'M1 actual zero denominator'});
    const zeroVersion=await createUnderwritingModelVersion(f.ctx,{modelId:String(zeroModel.id),definition:divided});
    const zeroSlice=success(await api(f,'decision-slice-compile',{...request,source:{...request.source,modelVersionId:String(zeroVersion.id)}})).slice;
    assert(zeroSlice.materialVariables.some((v:any)=>v.nativeId==='divide_by_zero'));
    const zero=success(await api(f,'decision-slice-consume',{sliceRef:zeroSlice.ref,use:'NUMERICAL_ONLY'}));
    await artifact('numerics/zero.json',{zeroSlice,zero});
    assert(zero.runs.some((r:any)=>r.result.status==='FAILED'&&r.result.validity!=='VALID'));assert.notEqual(zero.status,'SUFFICIENT_DECISION');
    const cyclic:UnderwritingModelIR={...definition,modelKey:'m1-declared-cycle',modelVersion:'1',nodes:[
      {id:'cycle_a',kind:'expression',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['cycle_b'],expression:{op:'add',args:[{op:'ref',nodeId:'cycle_b'},{op:'literal',value:'1',unit:'ratio',valueType:'decimal'}]}},
      {id:'cycle_b',kind:'expression',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['cycle_a'],expression:{op:'add',args:[{op:'ref',nodeId:'cycle_a'},{op:'literal',value:'1',unit:'ratio',valueType:'decimal'}]}},
      {id:'score',kind:'output',valueType:'decimal',unit:'ratio',shape:'scalar',dependencies:['cycle_a'],sourceNodeId:'cycle_a'},
    ],circularBlocks:[{id:'nonconvergent',nodeIds:['cycle_a','cycle_b'],iterationOrder:['cycle_a','cycle_b'],
      settings:{algorithm:'fixed_point',initialState:'zero',maxIterations:2,absoluteTolerance:decimal('0'),relativeTolerance:decimal('0')}}]};
    const cyclicModel=await createUnderwritingModel(f.ctx,{investmentCaseId:f.caseId,modelKey:cyclic.modelKey,name:'M1 declared unsupported generic cycle'});
    const cyclicVersion=await createUnderwritingModelVersion(f.ctx,{modelId:String(cyclicModel.id),definition:cyclic});
    const cycleSlice=success(await api(f,'decision-slice-compile',{...request,source:{...request.source,modelVersionId:String(cyclicVersion.id)}})).slice;
    assert(cycleSlice.unresolvedCoverage.some((g:any)=>g.code==='UNSUPPORTED_NATIVE_SOLVER_CYCLE'));
    const group=cycleSlice.candidateDependencies.solverGroups[0];assert(group.members.length===2);
    const cycleResult=success(await api(f,'decision-slice-consume',{sliceRef:cycleSlice.ref,use:'NUMERICAL_ONLY'}));
    await artifact('numerics/cycle.json',{cycleSlice,cycleResult});
    assert(cycleResult.runs.some((r:any)=>r.result.status==='FAILED'&&r.result.validity!=='VALID'));
    const opaque=await api(f,'decision-slice-compile',{...request,callback:'function advance(){ return 0 }'});assert.equal(opaque.status,400);
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    await artifact('numerics/results.json',{partial:partial.ref,result,zeroSlice:zeroSlice.ref,zero,cycleSlice,cycleResult,opaque});
    return {boundaryResult:result,zero,cycleResult,opaque,partialSearch:'S4 completeSearch retained and challenged in owner/P4 join suite'};
  });
  await challenge('authenticated-ui-witness-keyboard-reload-refusal','Integrated Work presenter uses a verified local bearer and real proxy/API; keyboard compile, witness, notes/reload, decision refusal and revocation',async()=>{
    return browserChallenge({repo,output,fixture:f,admin,request,artifact,prepareP4UI:async()=>{
      process.env.FINNOR_P4_PROFILE='ordinary_disposable';
      await admin!.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('native:p4',2,2,0,60,true,'M1 actual UI producer disposable engineering capacity') ON CONFLICT(resource_key) DO NOTHING");
      const root={entityType:'external_organization',entityId:f.rootId} as const;
      const semantics={...root,periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T00:00:00.000Z',unit:'currency',
        currencyCode:'USD',frequency:'annual',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'UNSPECIFIED',scale:'1',sign:'AS_RECORDED'} as const;
      const origin=await createEvidenceSource(f.tenant,{sourceKey:randomUUID(),sourceType:'manual',title:'M1 real UI public financial source'});
      const evidence=await appendEvidenceVersion(f.tenant,origin.id,{content:'Public UI EV120 debt70 equity50',snapshot:{EV:'120',debt:'70'},asOf:new Date(semantics.periodStart)});
      for(const [metric,value]of[['ui_EV','120'],['ui_debt','70']]){
        const series=await createMetricSeries(f.ctx,{subjectType:root.entityType,subjectId:root.entityId,metricKey:metric!,name:metric!,unit:'currency',currencyCode:'USD',frequency:'annual'});
        await recordMetricObservation(f.ctx,{metricSeriesId:String(series.row.id),periodStart:new Date(semantics.periodStart),periodEnd:new Date(semantics.periodEnd),value:{type:'number',value:value!},
          evidence:{evidenceSourceId:origin.id,evidenceVersionId:evidence.versionId}});
      }
      const {entityType:_type,entityId:_id,...descriptor}=semantics;
      const handles=success(await api(f,'evidence-handles',{root,inputs:[['EV','ui_EV'],['debt','ui_debt']].map(([inputId,metricKey])=>({inputId,source:{kind:'metric',subject:root,metricKey,...descriptor}}))})).handles;
      const submit=await api(f,'evidence-submit',{schema:'finnor.evidence-request.v1',root,workId:f.workId,question:'Actual UI financial typed equity input, public EV120−debt70=50.',
        idempotencyKey:randomUUID(),mode:'ordinary_disposable',inputs:handles.map((h:any)=>({inputId:h.inputId,handleId:h.id})),
        program:{schema:'finnor.derivation-ir.v1',nodes:[{id:'evrows',op:'source',inputId:'EV'},{id:'EV',op:'unique',input:'evrows'},
          {id:'debtrows',op:'source',inputId:'debt'},{id:'debt',op:'unique',input:'debtrows'},{id:'equity',op:'subtract',left:'EV',right:'debt'}],outputs:['equity']},
        acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:['equity']}});
      assert.equal(submit.status,202);
      const {JobQueue}=await import('../../apps/worker/src/queue'),queue=new JobQueue('m1-p4-real-ui',2);
      queue.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,
        (await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
      let produced:any;
      for(let i=0;i<12;i++){await queue.tick();produced=success(await api(f,'evidence-read',{queryId:submit.body.queryId}));if(produced.status==='TESTED')break;await new Promise(r=>setTimeout(r,25));}
      assert.equal(produced.status,'TESTED');assert.equal(produced.derivation.result.outputs.equity.value,'50');
      const definition:UnderwritingModelIR={schemaVersion:'underwriting-model-ir.v1',modelKey:'m1-p4-real-ui',modelVersion:'1',financialConventionVersion:FINANCIAL_CONVENTION_VERSION,
        minimumEngineVersion:UNDERWRITING_ENGINE_VERSION,periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
          {id:'equity',kind:'input',dependencies:[],valueType:'decimal',unit:'money',currency:'USD',shape:'scalar',required:true,allowedTruthClasses:['DERIVED_VALUE'],evidenceSemantics:semantics},
          {id:'equity_out',kind:'output',dependencies:['equity'],sourceNodeId:'equity',valueType:'decimal',unit:'money',currency:'USD',shape:'scalar'}]};
      const model=await createUnderwritingModel(f.ctx,{investmentCaseId:f.caseId,modelKey:definition.modelKey,name:'Actual P4 UI financial model'});
      const version=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition});
      const joined=success(await api(f,'decision-slice-compile',{...request,source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:String(version.id),
        evidenceDerivationInputs:{equity:{derivationId:produced.derivation.id,output:'equity'}}}})).slice;
      const consumed=success(await api(f,'decision-slice-consume',{sliceRef:joined.ref,use:'NUMERICAL_ONLY'}));assert.equal(consumed.runs[0].result.outputs.equity_out.value,'50');
      await artifact('browser/actual-p4-producer.json',{handles,submit,produced,joined,consumed});
      return {derivationId:produced.derivation.id,nodeId:'equity',output:'equity',modelVersionId:String(version.id)};
    }});
  });
  await challenge('shared-capital-and-unknown-outcome-liability','Actual S1/S3/S4/S5 candidate and resource owners reproduce A+C34, revised A60 B+C32, reserve25 A20; graph retains joint/outstanding objects',async()=>{
    const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
    const day=86400000,fixtures:Record<string,any>={},support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures,
      api:(scope:any,op:string,body:unknown,handler=allocationPost)=>api(scope,op,body,handler),artifact});
    const observations=[];
    for(const [name,cap,reserved]of[['baseline',35n,0n],['tightened',30n,0n],['reserved',35n,25n]] as const){
      const oracle=publicReference(cap,reserved),owner=await support.fixture(`m1-${name}`,1,[{id:'cash',unit:'USD',capacity:95,totalLimit:95}]);
      for(const row of oracle.rows)await support.policy(owner,row.id,{cash:Number(row.equity)});
      await support.resource(owner,'cash','USD','STOCK',['95','95']);
      if(reserved){const hold=await support.policy(owner,'R',{cash:25});success(await api(owner,'clear',support.clearing(owner,{R:['1']},[],[],[hold]),allocationPost));}
      const policies=owner.policies.filter((p:any)=>owner.labels[p.ref.id]!=='R'),clear=success(await api(owner,'clear',support.clearing(owner,{A:['20'],B:['18'],C:['14']},[],[],policies),allocationPost));
      await artifact(`allocation/${name}-clear.json`,clear);
      assert.equal(clear.status,'FEASIBLE',JSON.stringify({status:clear.status,reasons:clear.reasons}));
      assert.deepEqual(clear.certificate.check.selectedPolicyIds.map((id:string)=>owner.labels[id]).sort(),oracle.selected);
      assert.equal(clear.certificate.optimization.incumbent,oracle.payoff);
      const work=await receiveWork({tenantId:owner.tenant,userId:owner.principal,instruction:'Inspect actual joint allocation dependencies',channel:'console'});
      const compiled=success(await api(owner,'decision-slice-compile',{schema:request.schema,workId:work.workId,source:{kind:'ALLOCATION',allocationRef:clear.certificate.ref},purpose:'MODEL_EVIDENCE',resource:request.resource})).slice;
      assert(compiled.materialVariables.some((v:any)=>v.kind==='JOINT_INTERACTION'));
      if(reserved)assert(compiled.materialVariables.some((v:any)=>v.kind==='OUTSTANDING_COMMITMENT'));
      const consumed=success(await api(owner,'decision-slice-consume',{sliceRef:compiled.ref,use:'NUMERICAL_ONLY'}));assert.equal(consumed.status,'NATIVE_CONSTRAINT_ONLY');
      observations.push({name,oracle,clear,slice:compiled,consumed});
    }
    await artifact('allocation/results.json',observations);return observations.map(x=>({name:x.name,selected:x.oracle.selected,payoff:x.oracle.payoff,sliceRef:x.slice.ref}));
  });
  await challenge('bounded-governor-release-and-retained-expiry','Physical permit-release SQL cannot extend an expired request; a failed release retains its fenced expiry and failure liability',async()=>{
    const locker=new pg.Client({host:'127.0.0.1',port,database:'m1_e2e',user:'finnor',password:'finnor'});await locker.connect();
    await admin!.query('BEGIN');await admin!.query('LOCK TABLE finnor_os.pe_assumptions IN ACCESS EXCLUSIVE MODE');
    const before=performance.now(),pending=api(f,'decision-slice-compile',{...request,resource:{...request.resource,deadlineMs:1500}});
    let release:ReturnType<typeof setTimeout>|undefined;
    try{
      let leases:any[]=[];
      for(let i=0;i<100;i++){
        leases=(await locker.query("SELECT id,owner_id,lease_token,fence,expires_at FROM finnor_os.compute_resource_leases WHERE tenant_key=$1 AND resource_key='provider:m1-native' AND released_at IS NULL AND expires_at>clock_timestamp()",[f.tenant])).rows;
        if(leases.length)break;await new Promise(r=>setTimeout(r,10));
      }
      assert(leases.length,'Invocation did not acquire a physical permit');
      await locker.query('BEGIN');await locker.query('LOCK TABLE finnor_os.compute_resource_leases IN ACCESS EXCLUSIVE MODE');
      release=setTimeout(()=>{void Promise.allSettled([admin!.query('COMMIT'),locker.query('COMMIT')]);},2500);
      const result=await pending,elapsedMs=performance.now()-before;
      await artifact('deadline/governor-release.json',{result,elapsedMs,deadlineMs:1500,leaseIds:leases.map(row=>row.id),retainedExpiry:leases.map(row=>row.expires_at),expected:'413 before 2250ms, retained bounded lease and failed attempt'});
      assert.equal(result.status,413);assert(elapsedMs<2250,'Physical release extended the whole request envelope');
      return {result,elapsedMs,leaseIds:leases.map(row=>row.id),retainedExpiry:leases.map(row=>row.expires_at)};
    }finally{
      if(release)clearTimeout(release);
      await Promise.allSettled([admin!.query('COMMIT'),locker.query('COMMIT')]);await pending;await locker.end();
    }
  });
  await challenge('bounded-disposable-fifo-and-byte-growth','A model-managed disposable path replaced by an actual FIFO cannot hold an authenticated context request until a writer appears; no evidence is served and retained context reconstructs',async()=>{
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    const original=success(await api(f,'decision-slice-context',{sliceRef:slice.ref})).context;
    const working=join(process.env.FINNOR_M1_STORE!,f.tenant,f.principal,'working',slice.ref.contentDigest+'.json');
    await unlink(working);const made=spawnSync('mkfifo',['-m','600',working],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
    let writer:ChildProcess|undefined;const before=performance.now();
    const release=setTimeout(()=>{
      writer=spawn(process.execPath,['--input-type=module','--eval',
        'import fs from "node:fs";const fd=fs.openSync(process.argv[1],"w");fs.writeSync(fd,"release fixture FIFO");fs.closeSync(fd);',working],
        {env:{PATH:process.env.PATH},stdio:'ignore'});
    },3000);
    try{
      const response=await api(f,'decision-slice-context',{sliceRef:slice.ref}),elapsedMs=performance.now()-before;
      await artifact('deadline/disposable-fifo.json',{originalRef:original.ref,response,elapsedMs,writerReleaseMs:3000,expected:'Refusal before writer release; no hanging open of nonregular disposable object'});
      assert(response.status>=400);assert(elapsedMs<2400,'FIFO open waited for a writer despite the bounded context contract');
      return {response,elapsedMs,qualifiedDigest:original.qualifiedDigest};
    }finally{
      clearTimeout(release);writer?.kill('SIGKILL');await unlink(working);
      const reconstructed=success(await api(f,'decision-slice-context',{sliceRef:slice.ref})).context;
      assert.equal(reconstructed.qualifiedDigest,original.qualifiedDigest);
    }
  });
  await challenge('physical-native-cpu-deadline','A real large declared native graph cannot monopolize the API event loop past its whole grant; failed computation publishes no context and retains accounting',async()=>{
    const target=randomUUID();
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'M1 independent CPU target','other')",[target,f.tenant,`cpu-${target}`]);
    const deal=String((await createDeal(f.ctx,{targetOrganizationId:target,name:'M1 actual bounded CPU case',dealLeadEmployeeId:f.principal,
      signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)})).row.id);
    const caseId=String((await createInvestmentCase(f.ctx,{dealId:deal,title:'M1 independent6002-node owner model'})).row.id);
    const nodes:UnderwritingModelIR['nodes']=[
      {id:'base',kind:'constant',dependencies:[],valueType:'decimal',unit:'ratio',shape:'scalar',value:'1',truthClass:'MODEL_PARAMETER'},
      ...Array.from({length:6000},(_,i)=>({id:`node_${i}`,kind:'expression' as const,dependencies:['base'],valueType:'decimal' as const,unit:'ratio' as const,shape:'scalar' as const,
        expression:{op:'add' as const,args:[{op:'ref' as const,nodeId:'base'},{op:'literal' as const,value:'1',valueType:'decimal' as const,unit:'ratio' as const}]}})),
      {id:'score',kind:'output',dependencies:['node_5999'],sourceNodeId:'node_5999',valueType:'decimal',unit:'ratio',shape:'scalar'}];
    const large={...definition,modelKey:'m1-cpu-boundary',modelVersion:'1',nodes};
    const model=await createUnderwritingModel(f.ctx,{investmentCaseId:caseId,modelKey:large.modelKey,name:'M1 actual large native graph'});
    const version=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition:large});
    const before=performance.now(),response=await api(f,'decision-slice-compile',{...request,
      source:{...request.source,investmentCaseId:caseId,modelVersionId:String(version.id)},resource:{...request.resource,maxNodes:10000,deadlineMs:1000}});
    const elapsedMs=performance.now()-before;
    await artifact('deadline/native-cpu.json',{nativeNodes:nodes.length,modelVersionId:version.id,deadlineMs:1000,response,elapsedMs,expected:'413 before2500ms; no late publication'});
    assert.equal(response.status,413);assert(elapsedMs<2500,'Synchronous graph/checker CPU exceeded the whole request bound');
    const root=join(process.env.FINNOR_M1_STORE!,f.tenant,f.principal);
    const attempts=await import('node:fs/promises').then(fs=>fs.readdir(join(root,'attempts')));
    assert(attempts.length,'Failed native CPU liability must be retained');
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    return {nativeNodes:nodes.length,response,elapsedMs,attemptRecords:attempts.length};
  });
  await challenge('decisive-native-source-beyond-1000-owner-tail','A declared decisive input sorted after1000 real owner assumptions must remain UNKNOWN when omitted by the bounded S1 view; native consumption cannot fill it with zero or an unpinned current lookup',async()=>{
    const deal=String((await createDeal(f.ctx,{targetOrganizationId:f.rootId,name:'M1 actual1001-source tail',dealLeadEmployeeId:f.principal,
      signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)})).row.id);
    const investmentCaseId=String((await createInvestmentCase(f.ctx,{dealId:deal,title:'M1 decisive bounded source'})).row.id);
    for(let i=0;i<1000;i++)await createAssumption(f.ctx,{id:`00000000-0000-4000-8000-${(i+1).toString(16).padStart(12,'0')}`,
      dealId:deal,investmentCaseId,assumptionKey:`background-${i}`,statement:'Recorded irrelevant background owner assumption',valueType:'number',value:0,unit:'ratio'});
    const decisive=String((await createAssumption(f.ctx,{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',dealId:deal,investmentCaseId,
      assumptionKey:'critical-tail',statement:'A decisive constraint after the first1000 records',valueType:'number',value:9,unit:'ratio',materiality:'high'})).row.id);
    const fullCount=(await admin!.query('SELECT count(*)::int count FROM finnor_os.pe_assumptions WHERE tenant_id=$1 AND deal_id=$2',[f.tenant,deal])).rows[0].count;
    assert.equal(fullCount,1001);
    const world=await loadEnterpriseBeliefView(f.ctx,{root:{entityType:'pe_deal',entityId:deal}});
    assert(world.coverage.truncated||world.coverage.canonicalStatus!=='COMPLETE');assert(!world.claims.some(claim=>claim.ownerRef.id===decisive));
    const tailModel:UnderwritingModelIR={...definition,modelKey:'m1-decisive-tail',nodes:[
      {id:'critical',kind:'input',required:true,source:{kind:'p1_assumption',assumptionId:decisive},dependencies:[],valueType:'decimal',unit:'ratio',shape:'scalar'},
      {id:'score',kind:'output',dependencies:['critical'],sourceNodeId:'critical',valueType:'decimal',unit:'ratio',shape:'scalar'}]};
    const model=await createUnderwritingModel(f.ctx,{investmentCaseId,modelKey:tailModel.modelKey,name:'M1 tail material input'});
    const version=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition:tailModel});
    const compiled=success(await api(f,'decision-slice-compile',{...request,source:{kind:'UNDERWRITING',investmentCaseId,modelVersionId:String(version.id)}})).slice;
    const critical=compiled.materialVariables.find((v:any)=>v.nativeId==='critical');assert.equal(critical.status,'UNKNOWN');
    const consumed=success(await api(f,'decision-slice-consume',{sliceRef:compiled.ref,use:'NUMERICAL_ONLY'}));assert.equal(consumed.status,'INSUFFICIENT_NATIVE_INPUT');assert.deepEqual(consumed.runs,[]);
    const witness=success(await api(f,'decision-slice-witness',{sliceRef:compiled.ref,variableId:critical.id}));assert.equal(witness.native[0].input.value,null);
    await artifact('tail/decisive-1001.json',{fullCount,decisive,world,compiled,consumed,witness});
    return {fullCount,decisive,sourceKnownInDB:true,omittedByOwnerBound:true,nativeStatus:consumed.status};
  });
  await challenge('resource-revocation-during-owner-computation','A real S1 source-resource denial inserted while owner computation is blocked cannot publish a context after that denial; denied read/witness remain generic and the failed attempt stays recorded',async()=>{
    const target=randomUUID();
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'M1 independent revocation target','other')",[target,f.tenant,`revocation-${target}`]);
    const deal=String((await createDeal(f.ctx,{targetOrganizationId:target,name:'M1 live revocation case',dealLeadEmployeeId:f.principal,
      signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)})).row.id);
    const caseId=String((await createInvestmentCase(f.ctx,{dealId:deal,title:'M1 physically blocked source'})).row.id);
    const assumption=String((await createAssumption(f.ctx,{dealId:deal,investmentCaseId:caseId,assumptionKey:'probe',statement:'Real source for live revocation',valueType:'number',value:1,unit:'ratio'})).row.id);
    const raceModel:UnderwritingModelIR={...definition,modelKey:'m1-live-revocation',nodes:[
      {id:'probe',kind:'input',required:true,source:{kind:'p1_assumption',assumptionId:assumption},dependencies:[],valueType:'decimal',unit:'ratio',shape:'scalar'},
      {id:'score',kind:'output',dependencies:['probe'],sourceNodeId:'probe',valueType:'decimal',unit:'ratio',shape:'scalar'}]};
    const model=await createUnderwritingModel(f.ctx,{investmentCaseId:caseId,modelKey:raceModel.modelKey,name:'M1 live revocation model'});
    const version=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition:raceModel});
    const raceRequest={...request,source:{kind:'UNDERWRITING',investmentCaseId:caseId,modelVersionId:String(version.id)}};
    const incumbent=success(await api(f,'decision-slice-compile',raceRequest)).slice;
    await artifact('access/race-incumbent.json',{raceRequest,incumbent,ownerBoundary:'S1 canonical history, not a presumed current-only table read'});
    const role=(await admin!.query("SELECT role_id FROM finnor_os.employee_role_assignments WHERE employee_id=$1 AND active LIMIT 1",[f.principal])).rows[0].role_id;
    const locker=new pg.Client({host:'127.0.0.1',port,database:'m1_e2e',user:'finnor',password:'finnor'});await locker.connect();
    await locker.query('BEGIN');await locker.query('LOCK TABLE finnor_os.canonical_entity_versions IN ACCESS EXCLUSIVE MODE');
    const pending=api(f,'decision-slice-compile',raceRequest);let deny:string|undefined;
    try{
      let blocked=false;
      for(let i=0;i<150;i++){
        const rows=(await admin!.query("SELECT count(*)::int count FROM pg_stat_activity WHERE usename='finnor_app' AND wait_event_type='Lock'")).rows;
        if(rows[0].count){blocked=true;break;}await new Promise(r=>setTimeout(r,10));
      }
      assert(blocked,'Owner query did not reach the physical fixture lock');
      deny=String((await admin!.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:pe_world_state','pe_assumption','deny') RETURNING id",[f.tenant,role])).rows[0].id);
      await locker.query('COMMIT');
      const response=await pending;assert.equal(response.status,404,JSON.stringify(response));
      const denied=await api(f,'decision-slice-witness',{sliceRef:incumbent.ref,variableId:incumbent.materialVariables.find((v:any)=>v.nativeId==='probe').id});
      const absent=await api(f,'decision-slice-witness',{sliceRef:{...incumbent.ref,id:'decision-slice:'+'0'.repeat(64),contentDigest:'0'.repeat(64)},variableId:'absent'});
      assert.equal(denied.status,404);assert.deepEqual(denied.body,absent.body);
      await artifact('access/during-computation.json',{response,denied,absent,physicalOwnerLock:true,realS1Deny:deny});
      return {response,denied,absent,noPublicationAfterDeny:true};
    }finally{
      await locker.query('COMMIT').catch(()=>undefined);await pending;
      if(deny)await admin!.query('DELETE FROM finnor_os.role_authority_grants WHERE id=$1',[deny]);
      await locker.end();
      slice=success(await api(f,'decision-slice-compile',request)).slice;
    }
  });
  await challenge('actual-s6-unknown-effect-liability','An actual native S6 unknown observation leaves its durable effect unresolved, invalidates the prior M1 membership and remains a material obligation; no zero liability or effect grant is inferred',async()=>{
    slice=success(await api(f,'decision-slice-compile',request)).slice;
    const action=randomUUID(),effect=randomUUID(),integration=randomUUID(),command=randomUUID(),run=randomUUID(),step=randomUUID(),operation=randomUUID();
    const semanticHash=createHash('sha256').update('M1 public unknown effect amount125').digest('hex');
    await withTenantTransaction(f.tenant,{userId:f.principal},async(_db,c)=>{
      await c.query("INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode) VALUES($1,$2,'accounting','quickbooks','sandbox')",[integration,f.tenant]);
      await c.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,work_id) VALUES($1,$2,'external_test','{}'::jsonb,'executing',$3)",[action,f.tenant,f.workId]);
      await c.query("INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,status,effect) VALUES($1,$2,$3,$4,$4,'external_side_effect','partially_verified',$5::jsonb)",
        [effect,f.tenant,action,semanticHash,{id:effect,source:{domainActionId:action,actionType:'external_test',workId:f.workId,objectiveStepId:null},
          operation:{external:true},targets:[],bindings:[],delta:{values:{amountUsd:125}},expected:{state:{amountUsd:125}}}]);
      await c.query('UPDATE finnor_os.domain_actions SET business_effect_id=$1 WHERE id=$2',[effect,action]);
      await c.query("INSERT INTO finnor_os.commands(id,tenant_id,command_type,status,business_effect_id) VALUES($1,$2,'external_test','running',$3)",[command,f.tenant,effect]);
      await c.query("INSERT INTO finnor_os.workflow_runs(id,tenant_id,command_id,workflow_type,status) VALUES($1,$2,$3,'single_action','running')",[run,f.tenant,command]);
      await c.query("INSERT INTO finnor_os.workflow_steps(id,tenant_id,workflow_run_id,step_type,sequence,status,execution_state,idempotency_key,domain_action_id,business_effect_id) VALUES($1,$2,$3,'execute_authorized_effect',1,'waiting_observation','awaiting_observation',$4,$5,$6)",
        [step,f.tenant,run,`m1-unknown:${effect}`,action,effect]);
      await c.query("INSERT INTO finnor_os.integration_operations(id,tenant_id,workflow_step_id,operation_key,capability,provider,integration_id,business_effect_id,request_hash,status,response,provider_acknowledged_at,verification_status) VALUES($1,$2,$3,$4,'accounting','quickbooks',$5,$6,$7,'succeeded','{}'::jsonb,clock_timestamp(),'awaiting_observation')",
        [operation,f.tenant,step,`m1-observation:${effect}`,integration,effect,semanticHash]);
    });
    const intent=await (await import('@finnor/workflow-runtime')).openReceipt({
      tenantId:f.tenant,workflowRunId:run,workflowStepId:step,domainActionId:action,businessEffectId:effect,
      intendedEffectHash:semanticHash,objective:'Public unknown-observation boundary, not authorization to execute',
      evidence:[{source:'workflow_step',ref:step,timestamp:new Date().toISOString()}],policyApplied:null,riskTier:'medium',
      proposedAction:{actionType:'external_test',businessEffectId:effect},approval:{required:true},expectedResult:{amountUsd:125},
    });
    await (await import('../../packages/orchestration/src/external-observation')).settleExternalEffectObservation({
      tenantId:f.tenant,businessEffectId:effect,integrationId:integration,provider:'quickbooks',externalObjectType:'invoice',
      externalId:`m1-public-${effect}`,observedAt:new Date().toISOString(),classification:'unknown',expected:{amountUsd:125},
      evidence:{mechanism:'poll'},
    },{integrationOperationId:operation,domainActionId:action});
    const state=(await admin!.query('SELECT status,verification,effect FROM finnor_os.business_effects WHERE id=$1',[effect])).rows[0];
    assert(!['verified','cancelled','compensated'].includes(state.status));
    const stale=await api(f,'decision-slice-read',{sliceRef:slice.ref});assert.equal(stale.status,409);
    const current=success(await api(f,'decision-slice-compile',request)).slice;
    assert(current.materialVariables.some((v:any)=>v.id===`effect:${effect}`&&v.kind==='OBLIGATION'));
    assert(current.unresolvedCoverage.some((g:any)=>g.code==='S6_OUTSTANDING_EFFECT_LIABILITY_UNKNOWN'));
    const refusal=success(await api(f,'decision-slice-consume',{sliceRef:current.ref,use:'DECISION'}));assert.equal(refusal.status,'INSUFFICIENT_DECISION_COVERAGE');assert.equal(refusal.executionAuthorityGranted,false);
    await artifact('effects/unknown-native.json',{intent,state,stale,current,refusal,qualification:'Existing native observation owner with ordinary-role disposable durable fixtures and native intent history; authorizedEffectHash remains null, no real external effect, protected grant or fabricated zero liability'});
    slice=current;return {effect,state:state.status,staleStatus:stale.status,obligationRetained:true,executionAuthorityGranted:false};
  });
}catch(e){cases.push({id:'setup-or-unhandled',status:'FAIL',observed:e instanceof Error?{message:e.message,stack:e.stack}:String(e)});}
finally{for(const child of children)child.kill('SIGKILL');await save();await closePool().catch(()=>undefined);await admin?.end().catch(()=>undefined);await postgres.stop().catch(()=>undefined);await rm(dir,{recursive:true,force:true});}
console.log(JSON.stringify({output,passed:cases.filter(c=>c.status==='PASS').length,failed:cases.filter(c=>c.status==='FAIL').length}));
if(cases.some(c=>c.status!=='PASS')||selected?.some(id=>!cases.some(c=>c.id===id)))process.exitCode=1;
