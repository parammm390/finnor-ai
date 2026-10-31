import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {receiveWork} from '@finnor/db';
import {startEnvironment} from '../../x3/environment.mts';
import {createUpstreamFixtureSupport} from '../../s5/owner-fixture.mts';
import {POST as s3Post} from '../../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4Post} from '../../../apps/api/app/api/policies/[operation]/route';
import {allocationRef} from '../../../packages/epistemic-runtime/src/allocation-contracts';
import {seedTotalMountedWork,startMountedSession} from './mounted-session.mts';
import {verifyTotalS8} from './verify-total-s8.mts';
const root=resolve(import.meta.dirname,'../../../..'),os=join(root,'finnor-os');
const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??join(root,'evidence/y5-total-owner'));
await mkdir(evidence,{recursive:true,mode:0o700});
const started=Date.now(),observed:unknown[]=[],tokens=new Map<string,string>();
const save=async(name:string,value:unknown)=>{const p=join(evidence,name);await mkdir(resolve(p,'..'),{recursive:true});await writeFile(p,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
process.env.FINNOR_Y5_PROFILE='ORDINARY_NATIVE_DIAGNOSTIC';
process.env.FINNOR_S3_MODEL_STORE=join(evidence,'s3-owner');process.env.FINNOR_S4_POLICY_STORE=join(evidence,'s4-owner');
let env:Awaited<ReturnType<typeof startEnvironment>>|undefined;
let mounted:Awaited<ReturnType<typeof startMountedSession>>|undefined;
let s8:Awaited<ReturnType<typeof verifyTotalS8>>|undefined;
try{
 await import(new URL('../../../packages/private-equity/src/uniform-algorithms/total-service.ts',import.meta.url).href);
 env=await startEnvironment(evidence,{commitClock:true,builtApi:process.argv.includes('--built-api')});
 const python=process.env.FINNOR_S3_PYTHON;assert(python,'PINNED_SCIENTIFIC_INTERPRETER_REQUIRED');
 const generated=spawnSync(python,[join(os,'scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000});
 assert.equal(generated.status,0,generated.stderr);
 const call=async(f:any,family:string,operation:string,body:unknown)=>{
  const r=await env!.http!.api(tokens.get(f.principal)!,family,operation,body);
  observed.push({family,operation,status:r.status,result:r.body?.status,code:r.body?.code});return r;
 };
 const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
 const support=createUpstreamFixtureSupport({admin:()=>env!.admin,generatedRows:JSON.parse(generated.stdout).rows,
  begin:new Date(Math.floor(Date.now()/86400000)*86400000-128*86400000).toISOString(),day:86400000,fixtures:{},artifact:save,
  api:(f:any,op:string,body:unknown,handler?:unknown)=>call(f,handler===s3Post?'interventions':handler===s4Post?'policies':'allocations',op,body)});
 const f=await support.fixture('y5-total-first',1,[{id:'cashA',unit:'USD',capacity:1000,totalLimit:1000,resourceClass:'CASH'}],{
  beforeFit:async f=>{env!.http!.register(f.principal,f.name+'@s5.example.test');tokens.set(f.principal,await env!.http!.login(f.principal));}});
 const g=await support.fixture('y5-total-second',1,[{id:'cashB',unit:'USD',capacity:1000,totalLimit:1000,resourceClass:'CASH'}],{
  identity:{tenant:f.tenant,principal:f.principal}});
 // S5 clears against the tenant's complete current resource registry, so both episodes cite every resource.
 const registry=()=>[...f.resources,...g.resources].map((r:any)=>r.ref);
 let original:any;
 for(const [episode,cash] of [[f,'cashA'],[g,'cashB']] as const){
  await support.policy(episode,'negative',{[cash]:1});await support.policy(episode,'positive',{[cash]:1});
  await support.resource(episode,cash,'USD','STOCK',['1000','1000']);
  const input={...support.clearing(episode,{negative:['-3'],positive:['5']}),resourceRefs:registry()};
  const accepted=ok(await call(episode,'allocations','clear',input));assert.equal(accepted.status,'FEASIBLE');
  if(episode===f)original=input;
 }
 const bad={...structuredClone(original),resourceRefs:registry()},{ref:_,...joint}=bad.jointModel,ids=bad.policyRefs.map((r:any)=>r.id);
 const impossible={...joint,choiceConstraints:[{id:'must-select',policyIds:ids,minimum:1,maximum:ids.length,sourceRef:bad.mandate.businessOwnerRef},
  {id:'select-none',policyIds:ids,minimum:0,maximum:0,sourceRef:bad.mandate.businessOwnerRef}]};
 bad.jointModel={...impossible,ref:allocationRef('BUSINESS_OWNER','joint-allocation-model',impossible,'s5-joint-model-v1')};
 bad.idempotencyKey='adverse-original-sibling';assert.equal(ok(await call(f,'allocations','clear',bad)).status,'INFEASIBLE');
 const definition={schema:'finnor.y5.total-family-definition.v2',input:'ALL_FINITE_INTEGER_LISTS',output:'MATHEMATICAL_INTEGER',semanticState:'INT',
  safe:{op:'LE',left:{op:'INT',value:'0'},right:{op:'VAR',index:0}},advance:{op:'ADD',left:{op:'VAR',index:0},right:{op:'VAR',index:1}},
  objective:'LEAST_FEASIBLE_INITIAL_STATE',prefixes:'INCLUDING_EMPTY_AND_COMPLETE',numericalMeaning:'EXACT_UNBOUNDED_INTEGER',
  tie:'EQUAL_INTEGER_OUTPUT',costModel:'CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2'};
 const work=await receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',
  instruction:JSON.stringify({schema:'finnor.y5.work-specification.v2',definition,acceptanceReceipt:null}),
  idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'Y5:public-typed-owner'}]});
 const specification=ok(await call(f,'uniform-algorithms','specification',{root:f.root,workId:work.workId})).specification;
 const task=async(values:string[])=>receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',
  instruction:JSON.stringify({schema:'finnor.s5.total-task-instance.v2',specificationRef:specification.sourceRef,values}),
  idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'S5:public-typed-task'}]});
 const firstValues=['1','-3','4'],secondValues=['-4','2','-3','8'],firstTask=await task(firstValues),secondTask=await task(secondValues);
 const other=randomUUID();await env.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[other,f.tenant,other+'@s5.example.test']);
 env.http!.register(other,other+'@s5.example.test');tokens.set(other,await env.http!.login(other));
 const request={schema:'finnor.y5.total-discovery-request.v2',root:f.root,workId:work.workId,taskWorkId:firstTask.workId,idempotencyKey:'matching-typed-recurrence',
  limits:{wallMs:180000,maxAttempts:2,maxUses:8,maxPrograms:20000,maxPropositions:10000,maxProofAttempts:12,maxRetainedBytes:8388608},baselineManifestRef:null};
 await save('registered-input.json',{request,specification,firstTask,secondTask,firstValues,secondValues,
  scope:'PUBLIC_AUTHENTICATED_OWNER_NOT_PROTECTED_OR_INSTALLED'});
 const {verifyTotalEpisodes}=await import(new URL('./verify-total-episodes.mjs',import.meta.url).href);
 const recurring=await verifyTotalEpisodes({call:(operation:string,body:unknown)=>call(f,'uniform-algorithms',operation,body),
  task,request,specification,save});
 const submitted=recurring.submitted;
 assert.equal(ok(await call(f,'uniform-algorithms','submit-total',request),202).discoveryId,submitted.discoveryId);
 assert.equal((await call(f,'uniform-algorithms','submit-total',{...request,definition})).status,400);
 assert.equal((await call(f,'uniform-algorithms','submit-total',{...request,knowledgeCut:new Date(0).toISOString()})).status,400);
 assert.equal((await call(f,'uniform-algorithms','submit-total',{...request,limits:{...request.limits,maxUses:7}})).status,409);
 const worker=spawnSync(process.execPath,process.argv.includes('--installed-worker')?[join(os,'y5-runtime/worker-once.mjs'),submitted.jobId]:
  ['--import=tsx',join(os,'scripts/postx/y5/worker-once.mts'),submitted.jobId],{
  cwd:os,env:{...process.env,DATABASE_URL:env.workerUrl},encoding:'utf8',timeout:200000,maxBuffer:1048576});
 await save('worker-process.json',{status:worker.status,signal:worker.signal,stdout:worker.stdout,stderr:worker.stderr});
 assert.equal(worker.status,0,worker.stderr);
 const summary=ok(await call(f,'uniform-algorithms','read',{discoveryId:submitted.discoveryId}));
 assert.equal(summary.status,'CHECKED');assert.equal(summary.capsule,null);assert.equal(summary.capsuleAvailable,true);
 const campaign=(await env.admin.query('SELECT deadline_at FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',
  [f.tenant,submitted.discoveryId])).rows[0];
 assert.equal(summary.counters.deadlineAt,new Date(campaign.deadline_at).toISOString(),'SHARED_UI_DEADLINE_COUNTER_REQUIRED');
 const read=ok(await call(f,'uniform-algorithms','read',{discoveryId:submitted.discoveryId,includeCapsule:true,includeHistory:true}));
 await save('discovery.json',read);assert.equal(read.capsule.schema,'finnor.algorithm-theory-capsule.v2');
 assert(!read.capsule.search.developmentInputs.some((xs:string[])=>JSON.stringify(xs)===JSON.stringify(secondValues)),
  'FUTURE_TASK_VECTOR_LEAKED_INTO_DEVELOPMENT');
 assert.equal(read.capsule.origin.selectionRule,'ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL');
 assert.equal(read.capsule.origin.episodeCutDigest,read.episodeCut.cutDigest);
 assert.equal(read.episodeCut.episodes.length,5);assert(read.episodeCut.recordKinds.includes('REFUSAL'));
 assert.deepEqual(new Set(read.episodeCut.acceptedModelEpisodes),
  new Set(['total-task:'+recurring.first.workId,'total-task:'+recurring.second.workId]));
 assert.equal(read.episodeCut.allocationContextAcceptedModelEpisodes.length,2);
 assert(read.episodeCut.recordKinds.includes('COST'));assert.equal(read.protectedAdmission,false);
 const checkedUses=[];
 for(const [inputWork,values,expected] of [[firstTask,firstValues,'2'],[secondTask,secondValues,'5']] as const){
  const useInput={discoveryId:submitted.discoveryId,taskWorkId:inputWork.workId,idempotencyKey:'use-'+inputWork.workId};
  const use=ok(await call(f,'uniform-algorithms','consume-total',useInput));await save('use-'+expected+'.json',use);
  assert.equal(use.status,'CHECKED');assert.equal(use.result.value,expected);assert.equal(use.actualMethod,'Y5_SAME_LEAN_TOTAL_DEFINITION');
  assert.equal(use.originalCheck.feasible,true);assert.equal(use.reservationCreated,false);assert.deepEqual(use.s6EffectsCreated,[]);
  assert.equal(use.protectedAdmission,false);assert.equal(use.executionAuthorityGranted,false);
  assert(use.cost.wallMs<28500);let balance=BigInt(use.result.value);assert(balance>=0n);
  for(const value of values){balance+=BigInt(value);assert(balance>=0n);}
  assert.equal(ok(await call(f,'uniform-algorithms','consume-total',useInput)).digest,use.digest);
  assert.equal((await call(f,'uniform-algorithms','consume-total',{...useInput,values:['0']})).status,400);
  checkedUses.push(use.digest);
 }
 assert.equal((await call({...f,principal:other},'uniform-algorithms','read',{discoveryId:submitted.discoveryId,includeCapsule:true})).status,404);
 assert.equal((await call({...f,principal:other},'uniform-algorithms','consume-total',{discoveryId:submitted.discoveryId,taskWorkId:firstTask.workId,idempotencyKey:'foreign'})).status,404);
 assert.equal((await call(f,'uniform-algorithms','consume',{discoveryId:submitted.discoveryId,allocation:original,idempotencyKey:'wrong-protocol',fallback:'NONE'})).status,409);
 const before=Number((await env.admin.query('SELECT use_count FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,submitted.discoveryId])).rows[0].use_count);
 assert.equal(before,2);
 let mountedExtraUses=0;
 if(process.argv.includes('--mounted')){
  const seeded=await seedTotalMountedWork({tenant:f.tenant,principal:f.principal,root:f.root,
   workId:work.workId,evaluator:other,loginEmail:f.name+'@s5.example.test',specification,
   tasks:[{workId:firstTask.workId,values:firstValues,expected:'2'},{workId:secondTask.workId,values:secondValues,expected:'5'}],
   resolveSpecification:async workId=>ok(await call(f,'uniform-algorithms','specification',{root:f.root,workId})).specification,
   recordTaskEpisode:async(workId,taskWorkId,idempotencyKey)=>ok(await call(f,'uniform-algorithms','record-task-episode',
    {root:f.root,workId,taskWorkId,idempotencyKey}))});
  await save('mounted-typed-seed.json',{...seeded,scope:'PUBLIC_MODEL_FIXTURES_NOT_INDEPENDENT_QUALIFICATION'});
  mounted=await startMountedSession({root,evidence,env,tenant:f.tenant,principal:f.principal,evaluator:other,
   discoveryId:submitted.discoveryId,seeds:seeded.seeds,typed:seeded.typed,artifact:save});
  const initialMounted=await mounted.snapshot('owner-before-current');
  assert.equal(Number(initialMounted.discovery.use_count),before);
  await mounted.wait('current');
  const completedMounted=await mounted.snapshot('owner-current-complete');
  const originalUseIds=new Set(initialMounted.uses.map((u:any)=>u.id));
  const extra=completedMounted.uses.filter((u:any)=>!originalUseIds.has(u.id));
  assert.equal(extra.length,2,'TWO_ADDITIONAL_REAL_MOUNTED_USES_REQUIRED');
  assert.equal(Number(completedMounted.discovery.use_count),before+2);
  assert.deepEqual(new Set(extra.map((u:any)=>u.body.taskWorkId)),new Set([firstTask.workId,secondTask.workId]));
  assert(extra.every((u:any)=>u.status==='COMPLETE'&&u.body.status==='CHECKED'&&u.body.originalCheck.feasible&&
   u.body.actualMethod==='Y5_SAME_LEAN_TOTAL_DEFINITION'&&!u.body.protectedAdmission&&!u.body.executionAuthorityGranted&&
   !u.body.reservationCreated&&u.body.s6EffectsCreated.length===0));
  assert.deepEqual(completedMounted.effects,initialMounted.effects);
  assert.deepEqual(completedMounted.reservations,initialMounted.reservations);
  assert.equal(new Date(completedMounted.discovery.deadline_at).toISOString(),new Date(campaign.deadline_at).toISOString());
  mountedExtraUses=extra.length;checkedUses.push(...extra.map((u:any)=>u.body.digest));
  await save('mounted-owner-use-check.json',{status:'PASS_CANONICAL_OWNER_USES_NOT_BROWSER_QUALIFICATION',
   before:initialMounted,after:completedMounted,extraUseIds:extra.map((u:any)=>u.id),
   protectedQualification:false,businessCompletionAccepted:false});
 }
 let s8ExtraUses=0;
 if(process.argv.includes('--with-total-s8')||process.env.FINNOR_Y5_TOTAL_S8_REQUIRED==='1'){
  s8=await verifyTotalS8({env,evidence,tenant:f.tenant,principal:f.principal,evaluator:other,
   discoveryId:submitted.discoveryId,builtApi:process.argv.includes('--built-api'),artifact:save,
   api:(role,operation,body)=>call(role==='owner'?f:{...f,principal:other},'uniform-algorithms',operation,body)});
  checkedUses.push(s8.useDigest);s8ExtraUses=1;
  assert.equal(Number((await env.admin.query('SELECT use_count FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',
   [f.tenant,submitted.discoveryId])).rows[0].use_count),2+mountedExtraUses+s8ExtraUses);
 }
 await receiveWork({tenantId:f.tenant,userId:f.principal,workId:secondTask.workId,channel:'console',
  instruction:'The recorded typed instance is superseded.',idempotencyKey:randomUUID()});
 assert.equal((await call(f,'uniform-algorithms','consume-total',{discoveryId:submitted.discoveryId,taskWorkId:secondTask.workId,idempotencyKey:'use-'+secondTask.workId})).status,409);
 const invalid=ok(await call(f,'uniform-algorithms','invalidate',{discoveryId:submitted.discoveryId,dependency:'implementation',reason:'public typed runtime challenge',idempotencyKey:'invalidate-total'}));
 assert(!invalid.affected.includes('theorem'));assert(invalid.affected.includes('correspondence'));
 const stale=ok(await call(f,'uniform-algorithms','read',{discoveryId:submitted.discoveryId,includeCapsule:true}));
 assert.equal(stale.current,false);assert.equal(stale.capsule,null);assert.equal(stale.historyRetained,true);
 assert.equal((await call(f,'uniform-algorithms','consume-total',{discoveryId:submitted.discoveryId,taskWorkId:firstTask.workId,idempotencyKey:'after-p7'})).status,409);
 await s8?.afterNativeInvalidation();
 if(mounted){await mounted.wait('withdrawn');await mounted.close();mounted=undefined;}
 const ledger=(await env.admin.query('SELECT status,body,content_digest,deadline_at FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2 ORDER BY created_at',[f.tenant,submitted.discoveryId])).rows;
 assert.equal(ledger.length,2+mountedExtraUses+s8ExtraUses);assert(ledger.every((r:any)=>r.status==='COMPLETE'&&r.body.status==='CHECKED'));
 await save('durable-uses.json',ledger);
 await save('results.json',{status:'PASS',wallMs:Date.now()-started,discoveryId:submitted.discoveryId,checkedUses,observed,mountedExtraUses,s8ExtraUses,
  scope:'AUTHENTICATED_PUBLIC_S5_TYPED_TASK_OWNER_QUEUE_KERNEL_REUSE_NOT_ALLOCATION_OPTIMUM_OR_PROTECTED',
  completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,
  rerun:'FINNOR_S3_PYTHON=<pinned-python> FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-total-owner.mts'});
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started}));
}catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,receipt:(error as any).receipt??null,observed});throw error;}
finally{try{await s8?.close();}finally{try{await mounted?.close();}finally{await env?.close();}}}
