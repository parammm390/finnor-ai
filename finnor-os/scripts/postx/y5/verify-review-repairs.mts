import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {receiveWork} from '@finnor/db';
import {employeeAuthoritySnapshot} from '@finnor/authority';
import type {CanonicalAllocationProblem} from '../../../packages/shared-types/src/allocation';
import {allocationRef,allocationDerivedQuantity} from '../../../packages/epistemic-runtime/src/allocation-contracts';
import {verifyCanonicalAllocation,prepareCanonicalAllocationSubsetEvaluator} from '../../../packages/epistemic-runtime/src/allocation-checker';
import {digest as bytesDigest} from '../../../packages/governed-execution/src/canonical';
import {brokerPrivateFile} from '../../../packages/governed-execution/src/broker-io';
import type {startEnvironment} from '../../x3/environment.mts';
import type {createUpstreamFixtureSupport} from '../../s5/owner-fixture.mts';

export async function verifyReviewRepairs(c:{
 env:Awaited<ReturnType<typeof startEnvironment>>;support:ReturnType<typeof createUpstreamFixtureSupport>;
 root:string;os:string;evidence:string;deadlineAt:number;installedWorker:boolean;builtApi:boolean;selection:'all'|'compiled-faults';
 coupledProblem:CanonicalAllocationProblem;register:(f:any)=>Promise<void>;
 call:(f:any,family:string,operation:string,body:unknown)=>Promise<{status:number;body:any}>;
 artifact:(name:string,value:unknown)=>Promise<void>;
}){
 const began=Date.now(),cases:Array<Record<string,unknown>>=[],skippedCases:string[]=[];
 const completedDeadlineCase='R8-completed-use-retry-keeps-original-oracle-deadline';
 const interruptedUseCase='R5-actual-api-SIGKILL-after-durable-evaluation-use';
 assert(c.selection==='all'||c.selection==='compiled-faults');
 if(c.selection==='compiled-faults')assert(c.builtApi&&c.installedWorker,'COMPILED_FAULT_SELECTION_REQUIRES_BUILT_API_AND_EMITTED_WORKER');
 const save=(name:string,value:unknown)=>c.artifact('review-repairs/'+name,value);
 const ok=(r:{status:number;body:any},status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const budget=()=>assert(Date.now()<c.deadlineAt,'REVIEW_ORIGINAL_OUTER_DEADLINE');
 const scenario=async(id:string,run:()=>Promise<unknown>)=>{
  if(c.selection==='compiled-faults'&&id!==completedDeadlineCase&&id!==interruptedUseCase){
   skippedCases.push(id);await save('progress.json',{selection:c.selection,cases,skippedCases});return;
  }
  budget();const started=Date.now();
  try{const observed=await run();cases.push({id,status:'PASS',wallMs:Date.now()-started,observed});}
  catch(error){cases.push({id,status:'FAIL',wallMs:Date.now()-started,error:String(error)});await save('progress.json',{selection:c.selection,cases,skippedCases});throw error;}
  await save('progress.json',{selection:c.selection,cases,skippedCases});
 };
 const nativeStarts=async(useId:string)=>{
  const files:Array<{path:string;sha256:string;witness:unknown}>=[];let visited=0;
  const walk=async(path:string)=>{let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   for(const entry of entries){assert(++visited<=10000);const child=join(path,entry.name);
    if(entry.isDirectory())await walk(child);
    else if(entry.isFile()&&entry.name.endsWith('.started.json')){
     const body=await brokerPrivateFile(child,undefined,8192);
     files.push({path:relative(c.root,child),sha256:bytesDigest(body),witness:JSON.parse(body.toString())});
    }else assert(!entry.isSymbolicLink());
   }};
  await walk(join(c.root,'.y5-scratch/uses',useId));return files.sort((a,b)=>a.path.localeCompare(b.path));
 };
 const fixture=async(name:string,horizon=1,evaluate=false,identity?:{tenant:string;principal:string})=>c.support.fixture(
  'y5-review-'+name,horizon,[{id:'cash',unit:'USD',capacity:1000,totalLimit:1000}],{
   expiresAt:new Date(Math.min(c.deadlineAt,Date.now()+600000)).toISOString(),...(identity?{identity}:{}),
   beforeFit:async f=>{
    await c.register(f);
    if(!identity)f.reviewWork=await receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',
     instruction:'Verify the registered Y5 review repair against the complete original allocation.',
     idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'Y5:review-repair'}]});
    if(evaluate){
     f.reviewEvaluator=randomUUID();
     await c.env.admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [f.reviewEvaluator,f.tenant,f.reviewEvaluator+'@s5.example.test']);
     await c.register({...f,principal:f.reviewEvaluator,name:f.reviewEvaluator});
     await employeeAuthoritySnapshot({...f.ctx.auth,userId:f.reviewEvaluator,employeeId:f.reviewEvaluator});
    }
   },
  });
 const responsibilities=async(tenant:string)=>({
  effects:(await c.env.admin!.query('SELECT id,status,semantic_hash,effect FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
  reservations:(await c.env.admin!.query('SELECT reservation_id,status,revision,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',[tenant])).rows,
  consumptions:(await c.env.admin!.query('SELECT consumption_id,status,revision,effect_ref FROM finnor_os.s5_consumption_states WHERE tenant_id=$1 ORDER BY consumption_id',[tenant])).rows,
  externalOperations:(await c.env.admin!.query('SELECT domain_action_id,operation_key,status FROM finnor_os.external_operations WHERE tenant_id=$1 ORDER BY domain_action_id,operation_key',[tenant])).rows,
 });
 const discover=async(f:any,allocation:any,work=f.reviewWork,root=f.root)=>{
  budget();
  const request={root,workId:work.workId,allocation,idempotencyKey:randomUUID(),
   limits:{wallMs:600000,maxAttempts:2,maxUses:8},baselineManifestRef:null};
  const submitted=ok(await c.call(f,'uniform-algorithms','submit',request),202);
  const entry=c.installedWorker?join(c.os,'y5-runtime/worker-once.mjs'):join(c.os,'scripts/postx/y5/worker-once.mts');
  const worker=spawnSync(process.execPath,c.installedWorker?[entry,submitted.jobId]:['--import=tsx',entry,submitted.jobId],{
   cwd:c.os,env:{...process.env,DATABASE_URL:c.env.workerUrl},encoding:'utf8',
   timeout:Math.min(220000,Math.max(1,c.deadlineAt-Date.now())),maxBuffer:1048576,
  });
  await save(f.name+'/discovery-process.json',{request,submitted,status:worker.status,signal:worker.signal,stdout:worker.stdout,stderr:worker.stderr});
  assert.equal(worker.status,0,worker.stderr);
  const view=ok(await c.call(f,'uniform-algorithms','read',{discoveryId:submitted.discoveryId}));
  await save(f.name+'/discovery.json',view);
  return {submitted,view};
 };
 const checkedUseAndEvaluation=async(f:any,input:any,discoveryId:string,expected:string)=>{
  const before=await responsibilities(f.tenant);
  const use=ok(await c.call(f,'uniform-algorithms','consume',{discoveryId,allocation:input,idempotencyKey:randomUUID(),fallback:'NONE'}));
  assert.equal(use.completion,'COMPLETE');assert.equal(use.status,'CHECKED');
  assert.equal(allocationDerivedQuantity(use.result.check.objective).compare(allocationDerivedQuantity(expected)),0);
  assert.equal(use.execution.checker.kernelReplay,true);
  const assignment=ok(await c.call(f,'uniform-algorithms','assign-evaluation',{discoveryId,evaluatorId:f.reviewEvaluator,idempotencyKey:randomUUID()}));
  const evaluation=ok(await c.call({...f,principal:f.reviewEvaluator},'uniform-algorithms','evaluate',{evaluationId:assignment.evaluationId}));
  assert.equal(evaluation.disposition,'SUPPORTED_DEVELOPMENT');
  assert.equal(evaluation.oracle.preparationCount,1);assert.equal(evaluation.oracle.complete,true);
  assert.equal(allocationDerivedQuantity(evaluation.oracle.maximum).compare(allocationDerivedQuantity(expected)),0);
  const after=await responsibilities(f.tenant);assert.deepEqual(after,before);
  await save(f.name+'/use-and-evaluation.json',{input,use,assignment,evaluation,before,after});
  return use;
 };

 await scenario('R8-original-prepared-oracle-all-subsets',async()=>{
  const p=c.coupledProblem,prepared=prepareCanonicalAllocationSubsetEvaluator(p),observations=[];
  let infeasible=0;const started=Date.now();
  for(let mask=0;mask<2**p.policies.length;mask++){
   const ids=p.policies.filter((_,i)=>mask&2**i).map(p=>p.ref.id),full=verifyCanonicalAllocation(p,ids),actual=prepared.check(ids);
   assert.deepEqual(actual,{feasible:full.feasible,objective:full.objective,reasons:full.reasons});
   if(!actual.feasible)infeasible++;observations.push({ids,...actual});
  }
  assert(infeasible>0);assert.equal(prepared.preparationCount,1);
  const evidence={source:'ACTUAL_DURABLE_ORIGINAL_COUPLED_USE',observations,infeasible,preparationCount:prepared.preparationCount,wallMs:Date.now()-started};
  await save('prepared-oracle.json',evidence);return evidence;
 });
 await scenario('R2-derived-nineteenth-fractional-place',async()=>{
  const f=await fixture('derived-fraction',1,true);await c.support.policy(f,'positive',{cash:.1});
  const covenant={id:'tiny-derived',sourceRef:allocationRef('BUSINESS_OWNER','review-covenant',{case:'tiny'}),rightsRef:f.mandate.rightsRef,unit:'USD',
   terms:[{resourceId:'cash',coefficient:'0.000000000000000001',coefficientUnit:'USD/USD'}],periods:[0,1],
   maximum:'0.000000000000000001',safetyMargin:'0',basis:'CANONICAL_RESOURCE_USAGE'};
  await c.support.resource(f,'cash','USD','STOCK',['1000','1000'],undefined,[covenant]);
  const input=c.support.clearing(f,{positive:['5']}),{submitted,view}=await discover(f,input);
  assert.equal(view.status,'CHECKED');
  const use=await checkedUseAndEvaluation(f,input,submitted.discoveryId,'5');
  assert(use.applicability.rowProofs.some((row:any)=>row.id.includes('tiny-derived')&&row.upper==='0.0000000000000000001'));
  return {discoveryId:submitted.discoveryId,useId:use.useId,derivedUpper:'0.0000000000000000001'};
 });
 await scenario('R2-derived-objective-above-external-term-bound',async()=>{
  const f=await fixture('derived-sum',1,true);await c.support.policy(f,'a',{cash:1});await c.support.policy(f,'b',{cash:1});
  await c.support.resource(f,'cash','USD','STOCK',['1000','1000']);
  const input=c.support.clearing(f,{a:['1000000000000'],b:['1000000000000']}),{submitted,view}=await discover(f,input);
  assert.equal(view.status,'CHECKED');
  const use=await checkedUseAndEvaluation(f,input,submitted.discoveryId,'2000000000000');
  return {discoveryId:submitted.discoveryId,useId:use.useId,objective:use.result.check.objective};
 });
 await scenario('R2-existing-versioned-rational-joint-model',async()=>{
  const f=await fixture('rational',1,true);await c.support.policy(f,'positive',{cash:1});await c.support.policy(f,'zero',{cash:1});
  await c.support.resource(f,'cash','USD','STOCK',['1000','1000']);
  const input=c.support.clearing(f,{positive:['1/3'],zero:['0']});
  const {ref,...body}=input.jointModel,exact={...body,schema:'finnor.joint-allocation-model.exact.v2'};
  input.jointModel={...exact,ref:allocationRef('BUSINESS_OWNER','joint-allocation-model',exact,'s5-joint-model-exact-v2')};
  const {submitted,view}=await discover(f,input);assert.equal(view.status,'CHECKED');
  const use=await checkedUseAndEvaluation(f,input,submitted.discoveryId,'r3q:1/3');
  const clear=ok(await c.call(f,'allocations','clear',{...input,idempotencyKey:randomUUID()}));
  assert.equal(clear.status,'FEASIBLE');assert.equal(clear.certificate.check.objective,'r3q:1/3');
  await save(f.name+'/original-clear.json',clear);
  return {discoveryId:submitted.discoveryId,useId:use.useId,objective:use.result.check.objective,originalClear:clear.status};
 });
 await scenario('R1-second-root-source-withdrawal-historical-payloads',async()=>{
  const owner=await fixture('visibility-owner'),source=await fixture('visibility-source',1,false,{tenant:owner.tenant,principal:owner.principal});
  await c.support.policy(source,'private-source',{cash:1});await c.support.resource(source,'cash','USD','STOCK',['1000','1000']);
  const marker='987654321098',input=c.support.clearing(source,{'private-source':[marker]});
  const {submitted,view}=await discover(source,input,owner.reviewWork,owner.root);
  assert.equal(view.status,'CHECKED');assert.equal(view.sourceVisibility,'AUTHORIZED');
  assert(JSON.stringify(view.history).includes(marker));
  ok(await c.call(source,'policies','read',{policyRef:source.policies[0].ref}));
  const history=async()=>(await c.env.admin!.query('SELECT id,kind,created_at,body FROM finnor_os.y5_events WHERE tenant_id=$1 AND discovery_id=$2 ORDER BY id',[source.tenant,submitted.discoveryId])).rows;
  const before=await history(),integration=randomUUID(),scope=randomUUID();
  await c.env.admin!.query("INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode) VALUES($1,$2,'communications','microsoft_graph','sandbox')",[integration,source.tenant]);
  await c.env.admin!.query(`INSERT INTO finnor_os.integration_source_scopes
   (id,tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,scope_key,sync_strategy,recovery_strategy,required_permissions,effective_permissions,configured_by,root_binding_type,root_binding_id,enabled,disabled_at)
   VALUES($1,$2,$3,'microsoft_graph','outlook_mail_folder','mail_folder','y5-local-denial','y5:source-withdrawal','delta','EXACT_DELTA',ARRAY['Mail.Read'],ARRAY[]::text[],$4,'external_organization',$5,false,clock_timestamp())`,
   [scope,source.tenant,integration,source.principal,source.root.entityId]);
  const denied=await c.call(source,'policies','read',{policyRef:source.policies[0].ref});assert(denied.status>=400);
  const visible=ok(await c.call(owner,'uniform-algorithms','list',{root:owner.root,workId:owner.reviewWork.workId}));
  assert(visible.discoveries.some((d:any)=>d.id===submitted.discoveryId));
  const withheld=ok(await c.call(owner,'uniform-algorithms','read',{discoveryId:submitted.discoveryId}));
  assert.equal(withheld.sourceVisibility,'WITHHELD');assert.equal(withheld.current,false);assert.equal(withheld.capsule,null);
  assert.equal(withheld.historyPayloadsWithheld,true);
  assert(withheld.history.every((event:any)=>!Object.hasOwn(event,'body')));
  for(const value of [marker,source.root.entityId,source.model.ref.id,...source.policies.map((p:any)=>p.ref.id)])
   assert(!JSON.stringify(withheld).includes(value),'Historical response leaked withdrawn source data');
  const after=await history();assert.deepEqual(after,before);
  await save('source-withdrawal.json',{requestRoot:owner.root,sourceRoot:source.root,before,denied,visible,withheld,after,
   fault:'LOCAL_DISABLED_ROOT_BOUND_PROVIDER_SCOPE_NO_PROVIDER_EXECUTION',immutableHistoryUnchanged:true});
  return {discoveryId:submitted.discoveryId,historyRows:after.length,sourceWithheld:true,historyUnchanged:true};
 });
 await scenario('R3-valid-null-availability-remains-incomplete',async()=>{
  const f=await fixture('null-availability');await c.support.policy(f,'positive',{cash:1});
  await c.support.resource(f,'cash','USD','STOCK',['1000','1000'],undefined,[],{
   availability:[{amount:'1000',basis:'REPORTED_AVAILABLE'},{amount:null,basis:'UNKNOWN'}]});
  const input=c.support.clearing(f,{positive:['5']}),original=ok(await c.call(f,'allocations','clear',input));
  await save('null-availability-original-clear.json',{input,original});
  assert.equal(original.status,'UNCERTAINTY_UNRESOLVED');
  const before=await responsibilities(f.tenant),{submitted,view}=await discover(f,input);
  assert.equal(view.status,'INCOMPLETE');assert.equal(view.capsule,null);
  assert(view.history.some((event:any)=>event.body?.applicability?.reasons.some((r:string)=>r.startsWith('RESOURCE_AVAILABILITY_UNRESOLVED'))));
  assert.equal(await stat(join(c.root,'.y5-scratch/discovery',submitted.discoveryId)).then(()=>true,(error)=>{if(error.code==='ENOENT')return false;throw error;}),false);
  const after=await responsibilities(f.tenant);assert.deepEqual(after,before);
  await save('null-availability.json',{input,original,view,before,after,leanKernelStarted:false,workerLeaseStillCharged:true});
  return {discoveryId:submitted.discoveryId,status:view.status,originalStatus:original.status,leanKernelStarted:false,workerLeaseStillCharged:true};
 });
 await scenario('R4-maximum-covenant-cartesian-expansion-refused',async()=>{
  const f=await fixture('structural-expansion',24);await c.support.policy(f,'positive',{cash:1});
  for(let r=0;r<16;r++){
   const resourceId=r?'pool-'+r:'cash',covenants=Array.from({length:32},(_,i)=>({
    id:`review-${r}-${i}`,sourceRef:allocationRef('BUSINESS_OWNER','review-covenant',{r,i}),rightsRef:f.mandate.rightsRef,unit:'USD',
    terms:[{resourceId,coefficient:'1',coefficientUnit:'USD/USD'}],periods:Array.from({length:25},(_,t)=>t),
    maximum:'1000000000000',safetyMargin:'0',basis:'CANONICAL_RESOURCE_USAGE',
   }));
   await c.support.resource(f,resourceId,'USD','STOCK',Array(25).fill('1000000000000'),undefined,covenants);
  }
  const input=c.support.clearing(f,{positive:Array(32).fill('5')}),before=await responsibilities(f.tenant),{submitted,view}=await discover(f,input);
  assert.equal(view.status,'INCOMPLETE');assert.equal(view.capsule,null);
  const app=view.history.find((event:any)=>event.kind==='SUBMITTED').body.applicability;
  assert(app.reasons.includes('Y5_STRUCTURAL_MODEL_BUDGET_UNSUPPORTED'));
  assert(app.inspection.rowUpperBound>=409600);assert.equal(app.inspection.expanded,false);assert.deepEqual(app.rowProofs,[]);
  const sizes=(await c.env.admin!.query('SELECT kind,octet_length(body::text)::int AS bytes FROM finnor_os.y5_events WHERE tenant_id=$1 AND discovery_id=$2 ORDER BY id',[f.tenant,submitted.discoveryId])).rows;
  assert(sizes.every(row=>row.bytes<65536));
  assert.equal(await stat(join(c.root,'.y5-scratch/discovery',submitted.discoveryId)).then(()=>true,(error)=>{if(error.code==='ENOENT')return false;throw error;}),false);
  const after=await responsibilities(f.tenant);assert.deepEqual(after,before);
  await save('structural-expansion.json',{input,view,sizes,before,after,leanKernelStarted:false,workerLeaseStillCharged:true});
  return {discoveryId:submitted.discoveryId,status:view.status,inspection:app.inspection,eventSizes:sizes,leanKernelStarted:false,workerLeaseStillCharged:true};
 });
 if(c.builtApi)await scenario(completedDeadlineCase,async()=>{
  const f=await fixture('completed-evaluation-deadline',1,true);await c.support.policy(f,'positive',{cash:1});
  await c.support.resource(f,'cash','USD','STOCK',['1000','1000']);
  const input=c.support.clearing(f,{positive:['5']}),{submitted,view}=await discover(f,input);assert.equal(view.status,'CHECKED');
  const assignment=ok(await c.call(f,'uniform-algorithms','assign-evaluation',{discoveryId:submitted.discoveryId,evaluatorId:f.reviewEvaluator,idempotencyKey:randomUUID()}));
  const processReceipt=JSON.parse(await readFile(join(c.evidence,'built-api-source.json'),'utf8'));
  assert.equal(processReceipt.cwd,join(c.os,'apps/api'));assert(Number.isSafeInteger(processReceipt.pid));
  await c.env.admin!.query(`CREATE FUNCTION finnor_os.y5_review_block_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN PERFORM pg_advisory_xact_lock(73164932002026::bigint);RETURN NEW;END $$`);
  await c.env.admin!.query(`CREATE TRIGGER y5_review_block_evaluation BEFORE UPDATE OF result ON finnor_os.y5_evaluations
   FOR EACH ROW WHEN(OLD.result IS NULL AND NEW.result IS NOT NULL) EXECUTE FUNCTION finnor_os.y5_review_block_evaluation()`);
  await c.env.admin!.query('SELECT pg_advisory_lock(73164932002026::bigint)');
  let firstFinished=false;
  const pending=c.call({...f,principal:f.reviewEvaluator},'uniform-algorithms','evaluate',{evaluationId:assignment.evaluationId})
   .then(response=>({response}),error=>({error:String(error)})).finally(()=>{firstFinished=true;});
  let before:any,blocked:any,interrupted:unknown,killed:unknown;
  try{
   const barrierDeadline=Math.min(c.deadlineAt,Date.now()+30000);
   while(Date.now()<barrierDeadline){
    const rows=(await c.env.admin!.query(`SELECT pid,state,wait_event_type,wait_event,query FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock'
      AND wait_event='advisory' AND query LIKE 'UPDATE finnor_os.y5_evaluations SET result%'`)).rows;
    if(rows.length){assert.equal(rows.length,1);blocked=rows[0];break;}
    assert(!firstFinished,'Evaluation ended before the actual publication barrier');
    await new Promise<void>(yes=>setTimeout(yes,50));
   }
   assert(blocked,'REVIEW_ACTUAL_PUBLICATION_BARRIER_DEADLINE');
   process.kill(processReceipt.pid,'SIGSTOP');
   before=(await c.env.admin!.query('SELECT id,status,body,deadline_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2',[f.tenant,submitted.discoveryId])).rows;
   assert.equal(before.length,1);assert.equal(before[0].status,'COMPLETE');assert.equal(before[0].body.status,'CHECKED');
   assert.equal((await c.env.admin!.query('SELECT result FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND id=$2',[f.tenant,assignment.evaluationId])).rows[0].result,null);
   process.kill(processReceipt.pid,'SIGKILL');interrupted=await pending;
  }finally{
   await c.env.admin!.query('SELECT pg_advisory_unlock(73164932002026::bigint)');
   await c.env.admin!.query('DROP TRIGGER y5_review_block_evaluation ON finnor_os.y5_evaluations');
   await c.env.admin!.query('DROP FUNCTION finnor_os.y5_review_block_evaluation()');
  }
  await c.env.http!.restartApi();killed=JSON.parse(await readFile(join(c.evidence,'built-api-process.json'),'utf8'));
  assert.equal((killed as any).pid,processReceipt.pid);assert.equal((killed as any).signal,'SIGKILL');
  const expires=before[0].deadline_at.getTime(),waitMs=Math.max(0,expires-Date.now()+25);
  assert(waitMs<=30000);assert(Date.now()+waitMs<c.deadlineAt);
  if(waitMs)await new Promise<void>(yes=>setTimeout(yes,waitMs));
  assert(Date.now()>=expires);
  const beforeRetryStarts=await nativeStarts(before[0].id);
  const evaluated=ok(await c.call({...f,principal:f.reviewEvaluator},'uniform-algorithms','evaluate',{evaluationId:assignment.evaluationId}));
  assert.equal(evaluated.status,'UNKNOWN');assert.equal(evaluated.useCompletion,'COMPLETE');
  assert.equal(evaluated.useId,before[0].id);assert.equal(evaluated.originalUseDeadline,before[0].deadline_at.toISOString());
  assert.equal(evaluated.oracle.checkedSubsets,0);assert.equal(evaluated.oracle.preparationCount,0);
  const repeated=ok(await c.call({...f,principal:f.reviewEvaluator},'uniform-algorithms','evaluate',{evaluationId:assignment.evaluationId}));
  assert.deepEqual(repeated,evaluated);
  const after=(await c.env.admin!.query('SELECT id,status,body,deadline_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2',[f.tenant,submitted.discoveryId])).rows;
  assert.deepEqual(after,before);
  const counters=(await c.env.admin!.query('SELECT use_count FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,submitted.discoveryId])).rows[0];
  assert.equal(counters.use_count,1);
  const afterRetryStarts=await nativeStarts(before[0].id);assert.deepEqual(afterRetryStarts,beforeRetryStarts);
  await save('completed-evaluation-deadline.json',{processReceipt,killed,assignment,blocked,before,interrupted,waitMs,
   evaluated,repeated,after,counters,beforeRetryStarts,afterRetryStarts,rowPatches:0,originalDeadlineRenewed:false,
   barrier:'TEST_ONLY_ADVISORY_WAIT_RETURNS_NEW_UNCHANGED'});
  return {discoveryId:submitted.discoveryId,useId:before[0].id,status:evaluated.status,originalDeadlineRenewed:false,nativeStartsUnchanged:true};
 });
 if(c.builtApi)await scenario(interruptedUseCase,async()=>{
  const f=await fixture('interrupted-evaluation',1,true);await c.support.policy(f,'positive',{cash:1});
  await c.support.resource(f,'cash','USD','STOCK',['1000','1000']);
  const input=c.support.clearing(f,{positive:['5']}),{submitted,view}=await discover(f,input);assert.equal(view.status,'CHECKED');
  const assignment=ok(await c.call(f,'uniform-algorithms','assign-evaluation',{discoveryId:submitted.discoveryId,evaluatorId:f.reviewEvaluator,idempotencyKey:randomUUID()}));
  const processReceipt=JSON.parse(await readFile(join(c.evidence,'built-api-source.json'),'utf8'));
  assert.equal(processReceipt.cwd,join(c.os,'apps/api'));assert(Number.isSafeInteger(processReceipt.pid));
  await c.env.admin!.query(`CREATE FUNCTION finnor_os.y5_review_notify_use() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN PERFORM pg_notify('y5_review_use_registered',json_build_object('id',NEW.id,'discoveryId',NEW.discovery_id)::text);RETURN NEW;END $$`);
  await c.env.admin!.query('CREATE TRIGGER y5_review_notify_use AFTER INSERT ON finnor_os.y5_uses FOR EACH ROW EXECUTE FUNCTION finnor_os.y5_review_notify_use()');
  let timeout:NodeJS.Timeout|undefined,listener:((message:any)=>void)|undefined;
  try{
   const registered=new Promise<{id:string;discoveryId:string}>((yes,no)=>{
    listener=message=>{if(message.channel!=='y5_review_use_registered')return;const value=JSON.parse(message.payload);
     if(value.discoveryId===submitted.discoveryId)yes(value);};
    c.env.admin!.on('notification',listener);timeout=setTimeout(()=>no(Error('REVIEW_DURABLE_REGISTRATION_DEADLINE')),30000);
   });
   await c.env.admin!.query('LISTEN y5_review_use_registered');
   const pending=c.call({...f,principal:f.reviewEvaluator},'uniform-algorithms','evaluate',{evaluationId:assignment.evaluationId})
    .then(response=>({response}),error=>({error:String(error)}));
   const notice=await Promise.race([registered,pending.then(value=>{throw Error('Evaluation ended before durable registration: '+JSON.stringify(value));})]);
   process.kill(processReceipt.pid,'SIGSTOP');
   const before=(await c.env.admin!.query('SELECT id,status,body,deadline_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND id=$2',[f.tenant,notice.id])).rows[0];
   assert.equal(before.status,'STARTED');assert.equal(before.body,null);
   process.kill(processReceipt.pid,'SIGKILL');
   const interrupted=await pending;await c.env.http!.restartApi();
   const killed=JSON.parse(await readFile(join(c.evidence,'built-api-process.json'),'utf8'));
   assert.equal(killed.pid,processReceipt.pid);assert.equal(killed.signal,'SIGKILL');
   const beforeRetryStarts=await nativeStarts(notice.id);
   const evaluated=ok(await c.call({...f,principal:f.reviewEvaluator},'uniform-algorithms','evaluate',{evaluationId:assignment.evaluationId}));
   assert.equal(evaluated.status,'UNKNOWN');assert.equal(evaluated.disposition,'REFUSED_OR_INCOMPLETE');
   assert.equal(evaluated.useCompletion,'INCOMPLETE');assert.equal(evaluated.useId,notice.id);
   assert.equal(evaluated.originalUseDeadline,before.deadline_at.toISOString());
   assert.equal(evaluated.oracle.checkedSubsets,0);assert.equal(evaluated.oracle.preparationCount,0);
   const repeated=ok(await c.call({...f,principal:f.reviewEvaluator},'uniform-algorithms','evaluate',{evaluationId:assignment.evaluationId}));
   assert.deepEqual(repeated,evaluated);
   const after=(await c.env.admin!.query('SELECT id,status,body,deadline_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2',[f.tenant,submitted.discoveryId])).rows;
   assert.deepEqual(after,[before]);
   const counters=(await c.env.admin!.query('SELECT use_count FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,submitted.discoveryId])).rows[0];
   assert.equal(counters.use_count,1);
   const afterRetryStarts=await nativeStarts(notice.id);assert.deepEqual(afterRetryStarts,beforeRetryStarts);
   await save('interrupted-evaluation.json',{processReceipt,killed,assignment,before,interrupted,evaluated,repeated,after,counters,
    beforeRetryStarts,afterRetryStarts,rowPatches:0,notificationTrigger:'OBSERVATIONAL_AFTER_INSERT_ONLY',automaticReexecution:false});
   return {discoveryId:submitted.discoveryId,useId:notice.id,status:evaluated.status,useCount:counters.use_count,nativeStartsUnchanged:true};
  }finally{
   if(timeout)clearTimeout(timeout);if(listener)c.env.admin!.off('notification',listener);
   await c.env.admin!.query('UNLISTEN y5_review_use_registered');
   await c.env.admin!.query('DROP TRIGGER y5_review_notify_use ON finnor_os.y5_uses');
   await c.env.admin!.query('DROP FUNCTION finnor_os.y5_review_notify_use()');
  }
 });
 if(c.selection==='compiled-faults')assert.equal(cases.length,2);
 const result={schema:'finnor.y5.review-repair-e2e.v1',
  status:c.selection==='compiled-faults'?'PASS_COMPILED_FAULT_CASES_ONLY':'PASS_EXECUTED_BACKEND_REPAIR_CASES',
  selection:c.selection,cases,skippedCases,wallMs:Date.now()-began,
  actualBuiltApi:c.builtApi,emittedWorker:c.installedWorker,builtInterruption:c.builtApi?'PASS':'NOT_RUN_REQUIRES_ACTUAL_BUILT_API',
  completedUseOriginalDeadline:c.builtApi?'PASS':'NOT_RUN_REQUIRES_ACTUAL_BUILT_API',
  mountedPollAndLazyEvidence:'NOT_RUN_RENDERER_BLOCKED',expiryCleanup:'NOT_RUN',protectedDiscoveryCredit:false,
  protectedAdmission:false,completeMoney:null,aggregatePeakBytes:null};
 await save('results.json',result);return result;
}
