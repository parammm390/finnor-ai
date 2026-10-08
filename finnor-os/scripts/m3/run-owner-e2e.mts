/** Real-boundary contracts authored before delivery05 continuation production. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {appendFile,mkdir,mkdtemp,readFile,writeFile,rename,symlink,unlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawnSync,spawn,type ChildProcess} from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {closePool,receiveWork,withTenantTransaction,PRODUCTION_JOB_CONTRACTS} from '@finnor/db';
import {migrate} from '../../packages/db/migrate';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';
import {POST as allocationPost} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as policyPost} from '../../apps/api/app/api/policies/[operation]/route';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {JobQueue} from '../../apps/worker/src/queue';
import {readEnterpriseControlDecisionContext} from '../../packages/private-equity/src/enterprise-control';
import {epistemicHash} from '@finnor/epistemic-runtime';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),output=process.env.FINNOR_M3_EVIDENCE_DIR!;
const selected=process.env.FINNOR_M3_CASE_FILTER?.split(','),cases:any[]=[],calls:any[]=[],children=new Set<ChildProcess>();
const startedAt=new Date().toISOString();
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const artifact=async(name:string,value:unknown)=>{const path=join(output,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');return path;};
const identity=await Promise.all([
  'finnor-os/scripts/m3/run-owner-e2e.mts','finnor-os/scripts/m3/owner-construction.mts','finnor-os/scripts/m3/browser.mts','finnor-os/scripts/m3/browser-contract.json','finnor-os/scripts/m3/owner-reference.py',
  'scope-pm/phase-05-m3-capital-program/continuation-contracts.md','package-lock.json','finnor-os/package-lock.json',
].map(async path=>({path,sha256:sha(await readFile(join(repo,path)))})));
async function save(){await artifact('results.json',{schema:'finnor.m3.owner-workflow-e2e.v1',startedAt,finishedAt:new Date().toISOString(),
  cases,calls,sourceIdentity:identity,selection:selected??'FULL_REGISTERED_RUN',unmatchedSelection:selected?.filter(id=>!cases.some(row=>row.id===id))??[],
  runtime:{node:process.version,platform:process.platform,architecture:process.arch},
  qualification:'Public generated ordinary-role SQL/S1/S3/S4/S5/M1/API/queue/store and Seatbelt. Native cases use development header authentication. The opt-in mounted case uses a disposable asymmetric bearer issuer with bypass disabled. Neither establishes hosted authentication, final M1 or independent GateM3.',
  costs:{money:null,status:'UNMETERED',externalModelCalls:0},rerun:'python3 finnor-os/scripts/m3/run-owner-local.py'});}
async function challenge(id:string,expected:string,invoke:()=>Promise<unknown>){
  if(selected&&!selected.includes(id))return;
  const begin=performance.now();try{
    const observed=await invoke();
    cases.push({id,expected,status:(observed as any)?.contractStatus==='PARTIAL_VALIDATION'?'PARTIAL_VALIDATION':'PASS',observed,elapsedMs:performance.now()-begin});
  }
  catch(error){cases.push({id,expected,status:'FAIL',observed:{message:String(error),stack:(error as Error).stack},elapsedMs:performance.now()-begin});}
  console.log(JSON.stringify({id,status:cases.at(-1).status}));await save();
}
async function api(f:any,operation:string,body:unknown,handler=POST){
  const start=performance.now(),response=await handler(new Request(`http://127.0.0.1/api/company-brain/${operation}`,{
    method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body),
  }),{params:Promise.resolve({operation})});
  const result={status:response.status,body:await response.json() as any},
    observed={operation,status:result.status,elapsedMs:performance.now()-start};
  calls.push(observed);console.log(JSON.stringify({boundary:'REAL_OWNER_API',...observed}));return result;
}
function ok(result:any,status=200){assert.equal(result.status,status,JSON.stringify(result));return result.body;}
function reference(value:unknown){const result=spawnSync('python3',[join(repo,'finnor-os/scripts/m3/owner-reference.py')],{input:JSON.stringify(value),encoding:'utf8',timeout:20000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
function fraction(value:string){const [a,b='1']=value.split('/');return Number(a)/Number(b);}
const dir=await mkdtemp(join(tmpdir(),'finnor-m3-owner-'));
const port=await new Promise<number>((yes,no)=>{const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return no(Error('PORT_UNAVAILABLE'));server.close(()=>yes(address.port));});});
const postgres=new EmbeddedPostgres({databaseDir:dir,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
let admin:pg.Client|undefined,queue:JobQueue|undefined,f:any,request:any,result:any,submitted:any;
async function drain(queryId:string,scope=f){
  assert(queue,'Actual worker unavailable');
  let value:any;
  for(let ticks=0;ticks<32;ticks++){
    await queue.tick();value=ok(await api(scope,'capital-program-read',{queryId}));
    if(!['QUEUED','RUNNING'].includes(value.status))break;
  }
  await artifact(`durable/${queryId}.json`,{
    query:(await admin!.query('SELECT id,status,generation,attempted,generated,refinement_steps,first_started_at,deadline_at,result_digest,failure FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[scope.tenant,scope.principal,queryId])).rows,
    events:(await admin!.query('SELECT attempt_id,kind,body,created_at FROM finnor_os.m3_events WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 ORDER BY created_at,id',[scope.tenant,scope.principal,queryId])).rows,
  });
  assert(!['QUEUED','RUNNING'].includes(value.status),JSON.stringify(value));return value;
}
async function submit(overrides:any={},scope=f){
  const input={...structuredClone(request),idempotencyKey:randomUUID(),...overrides};
  const accepted=ok(await api(scope,'capital-program-submit',input),202);return {input,accepted,result:await drain(accepted.queryId,scope)};
}
async function businessRows(scope=f){
  return (await admin!.query("SELECT (SELECT count(*)::int FROM finnor_os.s5_reservations WHERE tenant_id=$1) reservations,(SELECT count(*)::int FROM finnor_os.s5_consumptions WHERE tenant_id=$1) consumptions,(SELECT count(*)::int FROM finnor_os.business_effects WHERE tenant_id=$1) effects",[scope.tenant])).rows[0];
}
try{
  await postgres.initialise();await appendFile(join(dir,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('m3_owner');
  const url=`postgres://finnor:finnor@127.0.0.1:${port}/m3_owner`;await migrate(url);
  admin=new pg.Client({connectionString:url});await admin.connect();await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");await admin.query("SET app.test_vertical_mode='explicit'");
  process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/m3_owner`;await closePool();
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('provider:m1-native',2,2,0,120,true,'M3 actual M1 evidence requests') ON CONFLICT(resource_key) DO NOTHING");
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('native:p4',2,2,0,60,true,'M3 authentic P4 fixture; unmetered ordinary capacity') ON CONFLICT(resource_key) DO NOTHING");
  const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000});assert.equal(generated.status,0,generated.stderr);
  const day=86400000,support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,
    begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures:{},
    api:(scope:any,operation:string,body:unknown,handler=allocationPost)=>api(scope,operation,body,handler),artifact});
  f=await support.fixture('m3-generated-price',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
  const incumbent=await support.policy(f,'incumbent',{cash:25});await support.resource(f,'cash','USD','STOCK',['200','200','200']);
  f.incumbent=incumbent;
  f.workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Construct permitted public-price commitments under the current mandate',channel:'console',idempotencyKey:randomUUID()})).workId;
  request={schema:'finnor.capital-program-request.v2',workId:f.workId,idempotencyKey:'m3-first',incumbentPolicyRef:incumbent.ref,purpose:'COMMERCIAL',
    permitted:{actionId:'programme-incumbent',exposureId:'price',unit:'fraction',terms:['0.15','0.3'],startPeriods:[0],
      structures:['IMMEDIATE','STAGED'],stageFractions:['0.5'],resourceRule:'SCALE_REGISTERED_ACTION_LINEAR',agreement:'UNILATERAL_PROPOSAL'},
    resource:{deadlineMs:30000,maxAttempts:8,maxGenerated:64,maxExpansions:50000,maxRefinementSteps:4096,maxRefinementDepth:6,maxModuleBytes:65536,maxResultBytes:8388608}};
  await artifact('inputs/request.json',request);
  try{
    const worker=await import('../../packages/private-equity/src/capital-program/worker');
    queue=new JobQueue('m3-real-worker',3);
    queue.register('run_capital_program_v2',worker.runCapitalProgramJob,(PRODUCTION_JOB_CONTRACTS as any).run_capital_program_v2);
    queue.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,
      PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
  }catch(error){await artifact('worker-load.json',{status:'UNAVAILABLE',error:String(error)});}

  await challenge('economic-owner-workflow','New unsupplied dose0.3 and staged exposure0.15/0.15 execute through real Work/API/queue/module/S4/M1/pureS5; reference agrees; zero speculative business rows',async()=>{
    const before=await businessRows();submitted=ok(await api(f,'capital-program-submit',request),202);result=await drain(submitted.queryId);
    assert(['TESTED','PARTIAL'].includes(result.status),JSON.stringify(result));assert(result.program);
    const program=result.program;assert.equal(program.schema,'finnor.capital-program.v2');assert.equal(program.executionAuthorityGranted,false);
    assert.equal(program.envelope.work.id,f.workId);assert.equal(program.mandate.id,incumbent.mandate.ref.id);
    assert(program.candidates.some((c:any)=>c.terms.some((t:any)=>t.after==='0.3')));
    assert(program.candidates.some((c:any)=>c.structure==='STAGED'&&c.moduleExecution?.termination==='EXITED'));
    assert.deepEqual(await businessRows(),before);
    for(const candidate of program.candidates.filter((c:any)=>c.policyRef)){
      const context=await readEnterpriseControlDecisionContext(f.ctx,candidate.policyRef);
      const oracle=reference({operation:'policy',problem:context.policy.problem,mandate:context.policy.mandate,model:context.model,kernel:context.kernel});
      assert(oracle.value!==null);assert(Math.abs(context.policy.certificate.valueBounds[0]-fraction(oracle.value))<=1e-8);
      assert.equal(candidate.valueBasis,'S4_ROBUST_FIXED_JOINT_WORLDS_NO_PROBABILITIES');
      await artifact(`reference/${candidate.semanticDigest}.json`,{input:context,oracle,candidate});
    }
    assert(program.allocation.checks.some((check:any)=>check.feasible));
    const duplicate=program.allocation.checks.find((check:any)=>check.selectedPolicyIds.length===2);
    assert(duplicate&&!duplicate.feasible,'Actual S5 must refuse two alternative arrangements for one deal');
    assert(program.pendingRequests.some((p:any)=>p.owner==='M4'));assert.equal(program.challengeEvidence.length,0);
    assert(program.evidenceSlice&&program.ownerBoundGraph&&program.programModule);
    return {submitted,before,after:await businessRows(),programRef:program.ref,selected:program.incumbentAndSearchGap,receipt:await artifact('workflow/program.json',program)};
  });
  await challenge('strict-hostile-request','Unknown objective/SQL/hidden-state/authority fields and malformed decimals refuse at real decoder, before any job',async()=>{
    const rows=[];
    for(const change of [{objective:{coefficient:1000000}},{sql:'DELETE FROM works'},{tenantId:randomUUID()},{worldId:'clairvoyant'},
      {permitted:{...request.permitted,terms:['NaN']}},{resource:{...request.resource,maxRefinementDepth:999}}]){
      const observed=await api(f,'capital-program-submit',{...request,idempotencyKey:randomUUID(),...change});assert.equal(observed.status,400);rows.push(observed);
    }
    return rows;
  });
  await challenge('pending-producer-ports','Committed but incompatible P1/P3 and unavailable M4/M2 remain exact pending schemas/domains, no fake grants',async()=>{
    const ports=ok(await api(f,'capital-program-ports',{workId:f.workId}));for(const owner of ['M4','M2','P1','P3'])assert(ports.requests.some((p:any)=>p.owner===owner&&p.status==='PENDING_DEPENDENCY'));
    assert(ports.requests.every((p:any)=>p.executionAuthorityGranted===false));return ports;
  });
  await challenge('pending-port-budget-receipt','Pending requests bind the original SQL deadline and attenuated counters; queued/terminal/cancelled reads cannot invent a transferable fresh grant',async()=>{
    const trial=await submit(),program=trial.result.program;assert(program);
    const row=(await admin!.query('SELECT attempted,generated,refinement_steps,deadline_at FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
      [f.tenant,f.principal,trial.accepted.queryId])).rows[0];
    for(const pending of program.pendingRequests){
      assert.equal(pending.deadlineAt,row.deadline_at.toISOString());
      assert.equal(pending.remaining.maxAttempts,trial.input.resource.maxAttempts-row.attempted);
      assert.equal(pending.remaining.maxRefinementSteps,trial.input.resource.maxRefinementSteps-row.refinement_steps);
      assert.equal(pending.remaining.maxExpansions,trial.input.resource.maxExpansions-program.costs.expansions);
      assert(pending.remaining.deadlineMs>0&&pending.remaining.deadlineMs<trial.input.resource.deadlineMs);
    }
    const terminal=ok(await api(f,'capital-program-ports',{workId:f.workId}));
    assert(terminal.requests.every((p:any)=>p.remaining.deadlineMs===0&&p.remaining.maxAttempts===0));
    const accepted=ok(await api(f,'capital-program-submit',{...request,idempotencyKey:randomUUID()}),202),
      queued=ok(await api(f,'capital-program-ports',{workId:f.workId}));
    assert(queued.requests.every((p:any)=>p.deadlineAt===null&&p.remaining.deadlineMs===0));
    assert.equal(ok(await api(f,'capital-program-cancel',{queryId:accepted.queryId})).status,'CANCELLED');
    const cancelled=ok(await api(f,'capital-program-ports',{workId:f.workId}));
    assert(cancelled.requests.every((p:any)=>p.deadlineAt===null&&p.remaining.deadlineMs===0&&p.remaining.maxAttempts===0));
    await queue!.tick();return {trial:trial.accepted,row,pending:program.pendingRequests,terminal,queued,cancelled};
  });
  await challenge('idempotency-and-queue-replay','Semantic retry returns same durable query; same key changed economic term conflicts; no duplicate result',async()=>{
    const first=ok(await api(f,'capital-program-submit',request),202),second=ok(await api(f,'capital-program-submit',request),202);
    assert.equal(first.queryId,second.queryId);assert.equal(second.replayed,true);
    const conflict=await api(f,'capital-program-submit',{...request,permitted:{...request.permitted,terms:['0.15']}});assert.equal(conflict.status,409);
    const rows=(await admin!.query('SELECT count(*)::int n FROM finnor_os.m3_publications WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3',[f.tenant,f.principal,first.queryId])).rows;assert.equal(rows[0].n,1);
    return {first,second,conflict,rows};
  });
  await challenge('bounded-incomplete-search','One attempted candidate retains incumbent; unvisited generated structures keep unknown upper bound and explicit remaining count',async()=>{
    const trial=await submit({resource:{...request.resource,maxAttempts:1}});assert(trial.result.program);
    const gap=trial.result.program.incumbentAndSearchGap;assert.equal(gap.finiteDomainComplete,false);assert(gap.remainingDescriptors>0);assert.equal(gap.globalOptimalityClaimed,false);assert.equal(gap.upperBound,null);
    return trial;
  });
  await challenge('incumbent-best-under-delay','Independent complete owner/reference comparison keeps the earlier incumbent when all later modeled alternatives are inferior; exact semantic ties are not improvements',async()=>{
    const scope=await support.fixture('m3-incumbent-best',3,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
    const {ref:mandateRef,...mandateBody}=structuredClone(scope.mandate);
    mandateBody.utility.discountFactors=[1,0.8,0.6,0.4];
    mandateBody.utilityRef.contentDigest=epistemicHash(mandateBody.utility);
    scope.mandate={...mandateBody,ref:{...mandateRef,id:'mandate:'+epistemicHash(mandateBody),contentDigest:epistemicHash(mandateBody)}};
    const base=await support.policy(scope,'early',{cash:25}),problem=structuredClone(base.problem);
    problem.actions.find((a:any)=>a.id==='programme-early')!.cost=0.5;
    const incumbent=ok(await api(scope,'replan',{mandate:scope.mandate,problem,protocols:[],
      scenarios:{pathsPerMechanism:4,seed:20261002},priorPolicyRef:base.ref,reason:'Owner-recorded commitment cost before bounded delayed alternatives'},policyPost)).policy;
    assert(incumbent);await support.resource(scope,'cash','USD','STOCK',['200','200','200','200']);
    scope.workId=(await receiveWork({tenantId:scope.tenant,userId:scope.principal,instruction:'Compare later permitted proposals without a novelty reward',channel:'console',idempotencyKey:randomUUID()})).workId;
    const before=await businessRows(scope),trial=await submit({workId:scope.workId,incumbentPolicyRef:incumbent.ref,
      permitted:{...request.permitted,actionId:'programme-early',terms:['0.15'],startPeriods:[1],structures:['IMMEDIATE','STAGED']}},scope),
      program=trial.result.program;
    assert(program);const original=program.candidates.find((c:any)=>c.structure==='INCUMBENT'),changed=program.candidates.filter((c:any)=>c.structure!=='INCUMBENT'&&c.policyRef);
    assert(original?.policyRef&&changed.length===2);
    for(const candidate of [original,...changed]){
      const context=await readEnterpriseControlDecisionContext(scope.ctx,candidate.policyRef),
        oracle=reference({operation:'policy',problem:context.policy.problem,mandate:context.policy.mandate,model:context.model,kernel:context.kernel});
      assert(oracle.value!==null);assert(Math.abs(candidate.valueBounds[0]-fraction(oracle.value))<=1e-8);
      await artifact(`incumbent-best/${candidate.semanticDigest}.json`,{context,oracle,candidate});
    }
    assert(changed.every((c:any)=>c.valueBounds[0]<original.valueBounds[0]-1e-8));
    assert.equal(program.incumbentAndSearchGap.selectedDigest,original.semanticDigest);
    assert.equal(program.incumbentAndSearchGap.modeledImprovement,0);
    const tie=await submit({workId:scope.workId,incumbentPolicyRef:incumbent.ref,
      permitted:{...request.permitted,actionId:'programme-early',terms:['0.150'],startPeriods:[0],structures:['IMMEDIATE']}},scope);
    assert(tie.result.program);
    assert.equal(tie.result.program.candidates.length,1);
    assert.equal(tie.result.program.incumbentAndSearchGap.selectedDigest,tie.result.program.incumbentAndSearchGap.incumbentDigest);
    assert.equal(tie.result.program.incumbentAndSearchGap.modeledImprovement,0);
    assert.deepEqual(await businessRows(scope),before);
    return {trial,tie,before,qualification:'H1_COMPLETE_REGISTERED_DELAYED_SUBCLASS_NOT_HELD_OUT_ECONOMIC_SUPERIORITY'};
  });
  await challenge('recursive-module-and-ablation','Available refinement really executes; zero-step grant cannot silently lower a new composition or reuse an effect',async()=>{
    const trial=await submit({resource:{...request.resource,maxRefinementSteps:0}});
    const candidates=trial.result.program?.candidates??[];
    assert(candidates.some((c:any)=>c.disposition==='REJECTED'&&c.reason==='REFINEMENT_BUDGET_EXHAUSTED'));
    assert(!candidates.some((c:any)=>c.structure!=='INCUMBENT'&&c.moduleExecution));return trial;
  });
  await challenge('agreement-and-missing-observation','New counterparty terms and missing milestone remain proposed/blocked; selection produces no reservation/effect',async()=>{
    const before=await businessRows(),trial=await submit({permitted:{...request.permitted,agreement:'COUNTERPARTY_REQUIRED',structures:['OBSERVABLE_STAGE'],milestone:{instrumentId:'future-revenue',tokens:['HIGH']}}});
    assert(trial.result.program?.blockers.some((b:any)=>/AGREEMENT|OBSERVATION/.test(b.code)));
    const select=await api(f,'capital-program-select',{queryId:trial.accepted.queryId,candidateDigest:trial.result.program.candidates[0].semanticDigest,idempotencyKey:randomUUID()});
    assert.equal(select.status,409);assert.deepEqual(await businessRows(),before);return {trial,select,before};
  });
  await challenge('cancel-resume-work-change','Queued cancellation fences the actual worker; same episode resume does not replenish grant; new Work input invalidates old use',async()=>{
    const input={...request,idempotencyKey:randomUUID()},accepted=ok(await api(f,'capital-program-submit',input),202);
    assert.equal(ok(await api(f,'capital-program-cancel',{queryId:accepted.queryId})).status,'CANCELLED');await queue!.tick();
    assert.equal(ok(await api(f,'capital-program-read',{queryId:accepted.queryId})).status,'CANCELLED');
    const resume=await api(f,'capital-program-resume',{queryId:accepted.queryId});assert.equal(resume.status,409);
    const fresh=await submit();await receiveWork({tenantId:f.tenant,userId:f.principal,workId:f.workId,instruction:'Changed actual Work input',channel:'console',idempotencyKey:randomUUID()});
    const stale=ok(await api(f,'capital-program-read',{queryId:fresh.accepted.queryId}));assert.equal(stale.status,'INVALIDATED');assert.equal(stale.program,null);
    const rebound=ok(await api(f,'capital-program-recompile',{queryId:fresh.accepted.queryId,idempotencyKey:randomUUID()}),202);
    assert.notEqual(rebound.queryId,fresh.accepted.queryId);
    const child=await drain(rebound.queryId);assert(child.program);
    assert(child.program.envelope.parents.some((ref:any)=>ref.id===fresh.result.program.ref.id&&ref.contentDigest===fresh.result.program.ref.contentDigest));
    assert(child.program.envelope.parents.some((ref:any)=>ref.id===fresh.result.program.envelope.requestRef.id));
    assert(!child.program.envelope.parents.some((ref:any)=>ref.id===fresh.accepted.queryId),'A mutable query UUID is not an immutable artifact reference');
    assert.equal(child.parentQueryId,fresh.accepted.queryId);return {accepted,resume,stale,rebound,child};
  });
  await challenge('hostile-linked-parent-and-mandate','Recompilation refuses private foreign parents, different Work, original mandate changes, different-parent replay and unchanged grant replenishment',async()=>{
    const first=await submit(),second=await submit(),key=randomUUID(),before=await businessRows();
    assert(first.result.program&&second.result.program);
    const unchanged=await api(f,'capital-program-recompile',{queryId:second.accepted.queryId,idempotencyKey:key});assert.equal(unchanged.status,409);
    const absent=await api(f,'capital-program-recompile',{queryId:randomUUID(),idempotencyKey:randomUUID()}),
      foreign=await api({...f,principal:randomUUID()},'capital-program-recompile',{queryId:second.accepted.queryId,idempotencyKey:randomUUID()});
    assert.deepEqual(foreign,absent);
    const wrongWork=await api(f,'capital-program-recompile',{queryId:second.accepted.queryId,idempotencyKey:key,
      replacement:{...request,workId:randomUUID(),idempotencyKey:key}});assert.equal(wrongWork.status,400);
    const {ref:oldMandate,...mandateBody}=structuredClone(f.mandate);mandateBody.risk.minimumUtility+=1;
    const mandate={...mandateBody,ref:{...oldMandate,id:'mandate:'+epistemicHash(mandateBody),contentDigest:epistemicHash(mandateBody)}},
      different=ok(await api(f,'replan',{mandate,problem:structuredClone(f.incumbent.problem),protocols:[],
        scenarios:{pathsPerMechanism:4,seed:20261002},priorPolicyRef:f.incumbent.ref,reason:'Explicit changed original risk mandate must not be inherited by M3'},policyPost)).policy;
    assert(different);
    const changedMandate=await api(f,'capital-program-recompile',{queryId:second.accepted.queryId,idempotencyKey:key,
      replacement:{...request,incumbentPolicyRef:different.ref,idempotencyKey:key}});assert.equal(changedMandate.status,400);
    await receiveWork({tenantId:f.tenant,userId:f.principal,workId:f.workId,instruction:'Genuine Work revision for hostile-parent replay guard',channel:'console',idempotencyKey:randomUUID()});
    const child=ok(await api(f,'capital-program-recompile',{queryId:second.accepted.queryId,idempotencyKey:key}),202),
      differentParent=await api(f,'capital-program-recompile',{queryId:first.accepted.queryId,idempotencyKey:key});
    assert.equal(differentParent.status,409);
    assert.equal(ok(await api(f,'capital-program-cancel',{queryId:child.queryId})).status,'CANCELLED');await queue!.tick();
    assert.deepEqual(await businessRows(),before);
    return {first:first.accepted,second:second.accepted,unchanged,absent,foreign,wrongWork,changedMandate,child,differentParent,before};
  });
  await challenge('cold-reconstruct-and-corrupt','A fresh process serves only current immutable bytes; symlink/truncation cannot hang or disclose module data',async()=>{
    const trial=await submit();assert(trial.result.program);
    const descriptor=trial.result.program.programModule;
    const witness=ok(await api(f,'capital-program-witness',{queryId:trial.accepted.queryId,candidateDigest:trial.result.program.candidates[0].semanticDigest}));
    assert(witness.policy&&witness.checks);
    const module=ok(await api(f,'capital-program-module',{queryId:trial.accepted.queryId,moduleDigest:descriptor.contentDigest}));
    assert.equal(sha(module.bytes),module.sha256);
    const spec=await artifact('cold/spec.json',{tenant:f.tenant,principal:f.principal,queryId:trial.accepted.queryId});
    const cold=spawnSync(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m3/cold-owner.mts'),spec],{cwd:join(repo,'finnor-os'),env:process.env,encoding:'utf8',timeout:30000});
    assert.equal(cold.status,0,cold.stderr);const restored=JSON.parse(cold.stdout.trim().split('\n').at(-1)!);assert.equal(restored.program.ref.contentDigest,trial.result.program.ref.contentDigest);
    const path=join(process.env.FINNOR_M3_STORE!,f.tenant,f.principal,'modules',descriptor.contentDigest+'.json'),backup=path+'.owned-backup';
    await rename(path,backup);
    try{await symlink('/dev/null',path);const refused=await api(f,'capital-program-module',{queryId:trial.accepted.queryId,moduleDigest:descriptor.contentDigest});assert.equal(refused.status,422);}
    finally{await unlink(path);await rename(backup,path);}
    return {descriptor,witness,cold:restored.program.ref};
  });
  await challenge('whole-transport-and-sql-deadline','Actual incomplete body and blocked authorization SQL consume one attenuated whole-request clock',async()=>{
    const encoder=new TextEncoder();let timer:ReturnType<typeof setTimeout>,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encoder.encode('{'));timer=setTimeout(()=>{controller.enqueue(encoder.encode('}'));controller.close();},1000);},cancel(){cancelled=true;clearTimeout(timer);}});
    const start=performance.now(),response=await POST(new Request('http://127.0.0.1/api/company-brain/capital-program-list',{
      method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal,'x-capital-program-deadline-ms':'250'},body:stream,duplex:'half',
    } as RequestInit),{params:Promise.resolve({operation:'capital-program-list'})});
    const observed={status:response.status,body:await response.json(),wallMs:performance.now()-start,cancelled};
    await artifact('transport/partial-body-deadline.json',observed);
    assert.equal(observed.status,413);assert(observed.wallMs<1000);assert(cancelled);return observed;
  });
  await challenge('visible-reference-examples','Frozen USD40m threshold and original A/B/C leverage/reservation arithmetic retain complete exact denominator',async()=>{
    const oracle=reference({operation:'examples'});assert.deepEqual(oracle.transaction40m.map((row:any)=>row.value),['13','-12','3']);
    assert.deepEqual(oracle.abc.map((row:any)=>row.best.selected),[['A','C'],['B','C'],['A']]);assert.deepEqual(oracle.abc.map((row:any)=>row.best.payoff),['34','32','20']);
    assert(oracle.abc.every((row:any)=>row.rows.length===8));return oracle;
  });
  if(selected?.includes('mounted-work-lifecycle'))await challenge('mounted-work-lifecycle','Actual authenticated Investigation Work/Canvas, pointer/keyboard, durable worker, witnesses, byte download, reload, cancel and revoked access',async()=>{
    const {mountedCapitalChallenge}=await import('./browser.mts');
    return mountedCapitalChallenge({repo,output,support,admin,queue,api,artifact});
  });
  if(!selected||selected.some(id=>['core-work-link-temporal-owner','lawful-observable-stage','authentic-inquiry-composition','fresh-evidence-and-native-finance','authentic-p4-work-rebind'].includes(id))){
    const {ownerConstructionContracts}=await import('./owner-construction.mts');
    await ownerConstructionContracts({challenge,support,api,ok,submit,request,reference,fraction,artifact,repo,admin,businessRows,queue,drain});
  }
  await challenge('second-economic-instance','Different identities, response topology and resource occupation, not a fixture-to-answer lookup, agree with separate full-horizon interpreter',async()=>{
    const other=await support.fixture('m3-second-independent-topology',3,[{id:'cash',unit:'USD',capacity:180,totalLimit:180}],{additionalExposure:true});
    const policy=await support.policy(other,'different-base',{cash:30});await support.resource(other,'cash','USD','STOCK',['180','180','180','180']);
    other.workId=(await receiveWork({tenantId:other.tenant,userId:other.principal,instruction:'Different supported two-channel commercial arrangement',channel:'console',idempotencyKey:randomUUID()})).workId;
    const trial=await submit({workId:other.workId,incumbentPolicyRef:policy.ref,permitted:{...request.permitted,actionId:'programme-different-base',terms:['0.225'],startPeriods:[1],structures:['IMMEDIATE','STAGED']}},other);
    assert(trial.result.program);assert(trial.result.program.candidates.some((c:any)=>c.terms.some((t:any)=>t.after==='0.225')));
    for(const candidate of trial.result.program.candidates.filter((c:any)=>c.policyRef)){
      const context=await readEnterpriseControlDecisionContext(other.ctx,candidate.policyRef);
      const oracle=reference({operation:'policy',problem:context.policy.problem,mandate:context.policy.mandate,model:context.model,kernel:context.kernel});
      assert(oracle.value!==null);assert(Math.abs(context.policy.certificate.valueBounds[0]-fraction(oracle.value))<=1e-8);
      await artifact(`second-reference/${candidate.semanticDigest}.json`,{context,oracle});
    }return trial.result.program.ref;
  });
  await challenge('out-of-support-dose','A well-typed but unsupported changed dose cannot acquire a qualified candidate value',async()=>{
    const policy=await support.policy(f,'support-refusal',{cash:0});
    const trial=await submit({incumbentPolicyRef:policy.ref,permitted:{...request.permitted,actionId:'programme-support-refusal',terms:['100'],structures:['IMMEDIATE']}});
    const changed=trial.result.program?.candidates.filter((c:any)=>c.structure!=='INCUMBENT')??[];
    assert(changed.length);assert(changed.every((c:any)=>c.disposition==='REJECTED'||c.disposition==='BLOCKED'));return trial;
  });
  await challenge('same-deal-and-complete-resources','Exact owner checker enumerates empty/single/double choices; a current resource revision invalidates use; no search reservation',async()=>{
    const trial=await submit(),program=trial.result.program;assert(program?.allocation.problem);
    const oracle=reference({operation:'allocation',problem:program.allocation.problem});
    for(const checked of program.allocation.checks){
      const expected=oracle.subsets.find((row:any)=>JSON.stringify(row.selectedPolicyIds)===JSON.stringify([...checked.selectedPolicyIds].sort()));
      assert(expected);assert.equal(checked.feasible,expected.feasible);
    }
    const old=f.resources[0],{ref:_ref,revision:_revision,priorRef:_priorRef,...body}=old;
    const current=ok(await api(f,'resource',{resource:{...body,availability:[{amount:'75',basis:'REPORTED_AVAILABLE'},{amount:'75',basis:'REPORTED_AVAILABLE'},{amount:'75',basis:'REPORTED_AVAILABLE'}]},expectedRef:old.ref},allocationPost));
    f.resources[0]=current;
    const invalidated=ok(await api(f,'capital-program-read',{queryId:trial.accepted.queryId}));assert.equal(invalidated.status,'INVALIDATED');assert.equal(invalidated.program,null);
    return {oracle,invalidated};
  });
  await challenge('exact-owner-selection','Authentic M1 decision coverage, not NUMERICAL_ONLY or modeled value, gates actual S5/S4 handoff and preserves zero speculative mutations',async()=>{
    const before=await businessRows(),trial=await submit();assert(trial.result.program);
    const candidate=trial.result.program.candidates.find((c:any)=>c.policyRef);assert(candidate);
    const checked=await api(f,'capital-program-select',{queryId:trial.accepted.queryId,candidateDigest:candidate.semanticDigest,idempotencyKey:randomUUID()});
    assert.equal(checked.status,409);assert(/COVERAGE|AGREEMENT|AUTHORITY|INCOMPLETE/.test(JSON.stringify(checked.body)));assert.deepEqual(await businessRows(),before);return {checked,before};
  });
  await challenge('native-owner-branch-review','An exact native S4 model branch is reviewed durably and replayed without reservation/effect or waived M1 decision coverage',async()=>{
    const scope=await support.fixture('m3-native-branch-review',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]),
      policy=await support.policy(scope,'review',{cash:25});
    await support.resource(scope,'cash','USD','STOCK',['200','200','200']);
    scope.workId=(await receiveWork({tenantId:scope.tenant,userId:scope.principal,instruction:'Review only the exact current modeled S4 branch, not a business effect',channel:'console',idempotencyKey:randomUUID()})).workId;
    const before=await businessRows(scope),trial=await submit({workId:scope.workId,incumbentPolicyRef:policy.ref,
      permitted:{...request.permitted,actionId:'programme-review',terms:['0.3'],structures:['IMMEDIATE']}},scope),
      program=trial.result.program,candidate=program?.candidates.find((c:any)=>c.structure==='IMMEDIATE'&&c.policyRef);
    assert(program&&candidate);
    const input={queryId:trial.accepted.queryId,candidateDigest:candidate.semanticDigest,idempotencyKey:randomUUID(),
      intent:'MODEL_BRANCH_REVIEW'};
    const reviewed=ok(await api(scope,'capital-program-select',input));
    assert.equal(reviewed.review.schema,'finnor.m3.native-branch-review.v2');
    assert.equal(reviewed.review.status,'MODEL_BRANCH_REVIEWED');
    assert.equal(reviewed.review.choice.status,'POLICY_AVAILABLE');
    assert.equal(reviewed.review.policyRef.contentDigest,candidate.policyRef.contentDigest);
    assert.equal(reviewed.review.programRef.contentDigest,program.ref.contentDigest);
    assert.equal(reviewed.review.executionAuthorityGranted,false);
    assert.equal(reviewed.review.reservationCreated,false);
    assert.equal(reviewed.review.decisionCoverageGranted,false);
    const current=await readEnterpriseControlDecisionContext(scope.ctx,candidate.policyRef),
      root=current.policy.nodes.find(n=>n.id===current.policy.rootNodeId);
    assert.equal(reviewed.review.choice.nodeId,root!.id);assert.equal(reviewed.review.choice.actionId,root!.actionId);
    const replay=ok(await api(scope,'capital-program-select',input));assert.equal(replay.replayed,true);
    assert.deepEqual(replay.review,reviewed.review);
    const other=program.candidates.find((c:any)=>c.semanticDigest!==candidate.semanticDigest&&c.policyRef);
    assert(other);
    assert.equal((await api(scope,'capital-program-select',{...input,candidateDigest:other.semanticDigest})).status,409);
    assert.equal((await api(scope,'capital-program-select',{...input,idempotencyKey:randomUUID(),decision:{period:1,worldId:'hidden'}})).status,400);
    const reloaded=ok(await api(scope,'capital-program-read',{queryId:trial.accepted.queryId}));
    assert.deepEqual(reloaded.branchReviews,[reviewed.review]);
    const spec=await artifact('branch-review/cold-spec.json',{tenant:scope.tenant,principal:scope.principal,queryId:trial.accepted.queryId}),
      cold=spawnSync(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m3/cold-owner.mts'),spec],{cwd:join(repo,'finnor-os'),env:process.env,encoding:'utf8',timeout:30000});
    assert.equal(cold.status,0,cold.stderr);
    assert.deepEqual(JSON.parse(cold.stdout.trim().split('\n').at(-1)!).branchReviews,[reviewed.review]);
    const refused=await api(scope,'capital-program-select',{...input,idempotencyKey:randomUUID(),intent:'OWNER_HANDOFF'});
    assert.equal(refused.status,409);assert(/COVERAGE/.test(JSON.stringify(refused.body)));
    assert.deepEqual(await businessRows(scope),before);
    await receiveWork({tenantId:scope.tenant,userId:scope.principal,workId:scope.workId,instruction:'Actual revised Work makes the earlier branch review historical',channel:'console',idempotencyKey:randomUUID()});
    const stale=ok(await api(scope,'capital-program-read',{queryId:trial.accepted.queryId}));
    assert.equal(stale.status,'INVALIDATED');assert.deepEqual(stale.branchReviews,[]);
    assert.equal((await api(scope,'capital-program-select',input)).status,409);
    return {input,reviewed,replay,reloaded:reloaded.branchReviews,refused,stale,before,after:await businessRows(scope)};
  });
  await challenge('unrelated-root-currentness','An actual unrelated company change does not invalidate an unaffected Work result',async()=>{
    const trial=await submit();assert(trial.result.program);
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Actually unrelated native company','other')",[randomUUID(),f.tenant,randomUUID()]);
    const unchanged=ok(await api(f,'capital-program-read',{queryId:trial.accepted.queryId}));assert.equal(unchanged.program?.ref.contentDigest,trial.result.program.ref.contentDigest);return unchanged.program.ref;
  });
  await challenge('actual-sql-deadline','A real authorization table lock cannot refresh the request clock or publish after its grant',async()=>{
    const locker=new pg.Client({connectionString:url});await locker.connect();await locker.query('BEGIN');await locker.query('LOCK TABLE finnor_os.users IN ACCESS EXCLUSIVE MODE');
    try{
      const start=performance.now(),response=await POST(new Request('http://127.0.0.1/api/company-brain/capital-program-list',{
        method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal,'x-capital-program-deadline-ms':'250'},body:JSON.stringify({workId:f.workId}),
      }),{params:Promise.resolve({operation:'capital-program-list'})});
      const body=await response.json(),wallMs=performance.now()-start;assert.equal(response.status,413);assert(wallMs<1000);return {status:response.status,body,wallMs};
    }finally{await locker.query('ROLLBACK');await locker.end();}
  });
  await challenge('queue-claim-kill-and-recover','An actual killed worker leaves retained costs; expired durable claim reuses remaining original episode rather than granting new work',async()=>{
    const accepted=ok(await api(f,'capital-program-submit',{...request,idempotencyKey:randomUUID()}),202);
    const child=spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m3/worker-once.mts')],{cwd:join(repo,'finnor-os'),env:process.env,stdio:'ignore'});children.add(child);
    const limit=Date.now()+10000;let started:any;
    while(Date.now()<limit){started=(await admin!.query("SELECT id FROM finnor_os.m3_events WHERE tenant_id=$1 AND query_id=$2 AND kind='STARTED'",[f.tenant,accepted.queryId])).rows[0];if(started)break;await new Promise(yes=>setTimeout(yes,30));}
    assert(started,'Actual claim did not start');child.kill('SIGKILL');await new Promise(yes=>child.once('close',yes));children.delete(child);
    await admin!.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE payload->>'queryId'=$1 AND status='running'",[accepted.queryId]);
    assert.equal(await queue!.recoverExpiredRunningJobs(),1);await admin!.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE payload->>'queryId'=$1",[accepted.queryId]);
    const original=(await admin!.query('SELECT first_started_at,deadline_at FROM finnor_os.m3_queries WHERE tenant_id=$1 AND id=$2',[f.tenant,accepted.queryId])).rows[0],
      recovered=await drain(accepted.queryId);assert(['TESTED','PARTIAL','FAILED','INVALIDATED'].includes(recovered.status));
    const after=(await admin!.query('SELECT first_started_at,deadline_at FROM finnor_os.m3_queries WHERE tenant_id=$1 AND id=$2',[f.tenant,accepted.queryId])).rows[0];
    assert.deepEqual(after,original);
    const events=(await admin!.query('SELECT kind,body FROM finnor_os.m3_events WHERE tenant_id=$1 AND query_id=$2 ORDER BY created_at,id',[f.tenant,accepted.queryId])).rows;
    assert(events.some((event:any)=>event.body.unknownPhysicalCost===true));
    assert(recovered.attemptCosts.some((attempt:any)=>attempt.physicalCostStatus==='UNKNOWN'&&attempt.wallMs===null&&attempt.money===null));
    return {accepted,original,after,recovered:recovered.status,attemptCosts:recovered.attemptCosts,events};
  });
  await challenge('running-cancel-cost-readback','Actual running cancellation fences publication and retains physical attempt readback without a renewed grant or business effects',async()=>{
    const before=await businessRows(),accepted=ok(await api(f,'capital-program-submit',{...request,idempotencyKey:randomUUID()}),202),
      child=spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m3/worker-once.mts')],{cwd:join(repo,'finnor-os'),env:process.env,stdio:'ignore'});
    children.add(child);
    const closed=new Promise<void>((yes,no)=>{child.once('error',no);child.once('close',()=>yes());}),
      limit=Date.now()+15000;
    let started:any;
    while(Date.now()<limit){
      started=(await admin!.query("SELECT q.status,q.first_started_at,q.deadline_at FROM finnor_os.m3_queries q WHERE q.tenant_id=$1 AND q.id=$2 AND q.status='RUNNING' AND EXISTS(SELECT 1 FROM finnor_os.m3_events e WHERE e.tenant_id=q.tenant_id AND e.query_id=q.id AND e.kind='MODULE_PREPARED')",[f.tenant,accepted.queryId])).rows[0];
      if(started)break;await new Promise(yes=>setTimeout(yes,10));
    }
    assert(started,'Actual running module preparation was not observed');
    const cancelled=ok(await api(f,'capital-program-cancel',{queryId:accepted.queryId}));assert.equal(cancelled.status,'CANCELLED');
    let timer:ReturnType<typeof setTimeout>;
    await Promise.race([closed,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(Error('RUNNING_CANCEL_CHILD_DID_NOT_DRAIN_WITHIN_ORIGINAL_BOUND')),32000);})]).finally(()=>clearTimeout(timer));
    children.delete(child);
    const final=ok(await api(f,'capital-program-read',{queryId:accepted.queryId}));assert.equal(final.status,'CANCELLED');
    assert(final.attemptCosts.some((attempt:any)=>attempt.state==='FENCED'&&attempt.physicalCostStatus==='MEASURED_SUPERVISOR_INTERVAL'&&
      attempt.wallMs>0&&attempt.cpuUserMicros>=0&&attempt.money===null));
    const after=(await admin!.query('SELECT first_started_at,deadline_at,result_digest FROM finnor_os.m3_queries WHERE tenant_id=$1 AND id=$2',[f.tenant,accepted.queryId])).rows[0];
    assert.equal(after.deadline_at.toISOString(),started.deadline_at.toISOString());assert.equal(after.result_digest,null);
    assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.m3_publications WHERE tenant_id=$1 AND query_id=$2',[f.tenant,accepted.queryId])).rows[0].n,0);
    assert.deepEqual(await businessRows(),before);return {accepted,started,cancelled,final,after,before};
  });
  // Revocation genuinely changes owner revisions. Restoring a user never
  // rewinds them; keep this destructive-currentness contract last.
  await challenge('rights-and-private-absence','Revoked principal, foreign and absent queries return equal private failures at read/witness/download/select without values/counts',async()=>{
    const trial=await submit();assert(trial.result.program);
    const p=trial.result.program,candidate=p.candidates.find((c:any)=>c.moduleRef);assert(candidate);
    const absent=await api(f,'capital-program-read',{queryId:randomUUID()}),foreign=await api({...f,principal:randomUUID()},'capital-program-read',{queryId:trial.accepted.queryId});
    assert.deepEqual(foreign,absent);
    await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[f.tenant,f.principal]);
    try{
      const denied=[];
      for(const [operation,body]of [
        ['capital-program-read',{queryId:trial.accepted.queryId}],
        ['capital-program-witness',{queryId:trial.accepted.queryId,candidateDigest:candidate.semanticDigest}],
        ['capital-program-module',{queryId:trial.accepted.queryId,moduleDigest:candidate.moduleRef.contentDigest}],
        ['capital-program-select',{queryId:trial.accepted.queryId,candidateDigest:candidate.semanticDigest,idempotencyKey:randomUUID()}],
      ] as const){const response=await api(f,operation,body);assert.equal(response.status,404);assert.deepEqual(response.body,absent.body);denied.push({operation,...response});}
      return {denied,absent,foreign};
    }finally{await admin!.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2",[f.tenant,f.principal]);}
  });
}catch(error){cases.push({id:'infrastructure',status:'FAIL',observed:{message:String(error),stack:(error as Error).stack}});await save();}
finally{
  for(const child of children)child.kill('SIGKILL');
  await closePool();await admin?.end();await postgres.stop();await save();
}
process.exit(cases.length&&cases.every(row=>row.status==='PASS')&&!selected?.some(id=>!cases.some(row=>row.id===id))?0:1);
