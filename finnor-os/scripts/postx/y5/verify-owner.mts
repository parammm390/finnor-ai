import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {receiveWork} from '@finnor/db';
import {employeeAuthoritySnapshot} from '@finnor/authority';
import {startEnvironment} from '../../x3/environment.mts';
import {createUpstreamFixtureSupport} from '../../s5/owner-fixture.mts';
import {POST as s3Post} from '../../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4Post} from '../../../apps/api/app/api/policies/[operation]/route';
import {allocationRef} from '../../../packages/epistemic-runtime/src/allocation-contracts';
import {uniformProblemIdentity} from '../../../packages/epistemic-runtime/src/uniform-algorithms/applicability';
import {verifyCanonicalAllocation} from '../../../packages/epistemic-runtime/src/allocation-checker';
import {resolveEnterpriseAllocationProblem} from '../../../packages/private-equity/src/enterprise-allocation';
import {verifyUniformS8} from './verify-s8.mts';
import {verifyRecovery} from './verify-recovery.mts';
import {verifyReviewRepairs} from './verify-review-repairs.mts';
import {seedMountedWork,startMountedSession} from './mounted-session.mts';

const root=resolve(import.meta.dirname,'../../../..'),os=join(root,'finnor-os');
const onlyCompiledFaults=process.argv.includes('--review-faults');
assert(!(onlyCompiledFaults&&process.argv.includes('--review-repairs')),'REVIEW_SELECTION_FLAGS_ARE_EXCLUSIVE');
if(onlyCompiledFaults)assert(process.argv.includes('--built-api')&&process.argv.includes('--installed-worker'),'COMPILED_FAULT_SELECTION_REQUIRES_BUILT_API_AND_EMITTED_WORKER');
const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??join(root,'evidence/y5-owner'));
await mkdir(evidence,{recursive:true,mode:0o700});
const artifact=async(name:string,value:unknown)=>{const path=join(evidence,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const observations:unknown[]=[],started=Date.now();
process.env.FINNOR_Y5_PROFILE='ORDINARY_NATIVE_DIAGNOSTIC';
process.env.FINNOR_S3_MODEL_STORE=join(evidence,'s3-owner');
process.env.FINNOR_S4_POLICY_STORE=join(evidence,'s4-owner');
const env=await startEnvironment(evidence,{builtApi:process.argv.includes('--built-api')}).catch(async error=>{
 await artifact('failure.json',{status:'FAIL',phase:'ENVIRONMENT',error:String(error),observations});throw error;
});
const tokens=new Map<string,string>();
let s8:Awaited<ReturnType<typeof verifyUniformS8>>|undefined;
let mountedSeeds:Awaited<ReturnType<typeof seedMountedWork>>|undefined,mounted:Awaited<ReturnType<typeof startMountedSession>>|undefined;
try{
 const python=process.env.FINNOR_S3_PYTHON;
 assert(python,'The actual pinned scientific interpreter is required for original S3/S4 setup');
 const generated=spawnSync(python,[join(os,'scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000});
 assert.equal(generated.status,0,generated.stderr);
 const call=async(f:any,family:string,operation:string,body:unknown)=>{
  const response=await env.http!.api(tokens.get(f.principal)! ,family,operation,body);
  observations.push({family,operation,status:response.status,disposition:response.body?.disposition,
   ownerStatus:response.body?.status,code:response.body?.code,error:response.body?.error});return response as {status:number;body:any};
 };
 const ok=(r:{status:number;body:any},status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const support=createUpstreamFixtureSupport({admin:()=>env.admin,generatedRows:JSON.parse(generated.stdout).rows,
  begin:new Date(Math.floor(Date.now()/86400000)*86400000-128*86400000).toISOString(),day:86400000,fixtures:{},
  api:(f:any,op:string,body:unknown,handler?:unknown)=>call(f,handler===s3Post?'interventions':handler===s4Post?'policies':'allocations',op,body),
  artifact,
 });
 const evaluator=randomUUID();let work:Awaited<ReturnType<typeof receiveWork>>|undefined;
 const f=await support.fixture('y5-public-development',1,[{id:'cash',unit:'USD',capacity:1000,totalLimit:1000}],{
  beforeFit:async f=>{
   env.http!.register(f.principal,f.name+'@s5.example.test');tokens.set(f.principal,await env.http!.login(f.principal));
   await env.admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
    [evaluator,f.tenant,'y5-evaluator-'+evaluator+'@s5.example.test']);
   env.http!.register(evaluator,'y5-evaluator-'+evaluator+'@s5.example.test');
   tokens.set(evaluator,await env.http!.login(evaluator));
   await employeeAuthoritySnapshot({...f.ctx.auth,userId:evaluator,employeeId:evaluator});
   work=await receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',
    instruction:'Discover and independently check a uniform algorithm for the current supplied original allocation family.',
    idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'Y5:public-development'}]});
   if(process.argv.includes('--mounted')){
    assert(process.argv.includes('--built-api')&&process.argv.includes('--installed-worker'),'Y5_MOUNTED_REQUIRES_INSTALLED_API_AND_WORKER');
    mountedSeeds=await seedMountedWork(f,work.workId,evaluator);
   }
  },
 });
 await support.policy(f,'negative',{cash:1});await support.policy(f,'zero',{cash:1});await support.policy(f,'positive',{cash:1});
 await support.resource(f,'cash','USD','STOCK',['1000','1000']);
 const input=support.clearing(f,{negative:['-3'],zero:['0'],positive:['5']});
 assert(work,'Original Work must precede the accepted scientific source and rights cut');
 const request={root:f.root,workId:work.workId,allocation:input,idempotencyKey:'y5-discovery',
  limits:{wallMs:process.argv.includes('--mounted')?3600000:process.argv.includes('--with-s8')||process.argv.includes('--with-recovery')?600000:180000,maxAttempts:2,maxUses:8},baselineManifestRef:null};
 await artifact('owner-input.json',{request});
 const submitResponse=await call(f,'uniform-algorithms','submit',request);
 if(submitResponse.status!==202)try{await resolveEnterpriseAllocationProblem(f.ctx,input);}
 catch(error){await artifact('original-owner-refusal.json',{error:String(error),stack:(error as Error).stack});}
 const submitted=ok(submitResponse,202);
 const replay=ok(await call(f,'uniform-algorithms','submit',request),202);assert.equal(submitted.discoveryId,replay.discoveryId);
 const conflict=await call(f,'uniform-algorithms','submit',{...request,limits:{...request.limits,maxUses:7}});assert.equal(conflict.status,409);
 const raw=await fetch(env.http!.apiBase+'/api/uniform-algorithms/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discoveryId:submitted.discoveryId})});
 assert.equal(raw.status,401);
 const installedWorker=process.argv.includes('--installed-worker'),entry=installedWorker?join(os,'y5-runtime/worker-once.mjs'):null;
 if(entry){
  const identity=JSON.parse(await readFile(join(os,'y5-runtime/identity.json'),'utf8'));
  for(const file of ['worker-once',...(process.argv.includes('--with-recovery')?['queue-control']:[])]){
   const expected=identity.emittedFiles.find((item:any)=>item.path===`finnor-os/y5-runtime/${file}.mjs`);
   assert(expected);assert.equal(createHash('sha256').update(await readFile(join(os,`y5-runtime/${file}.mjs`))).digest('hex'),expected.sha256);
  }
  await artifact('installed-runtime.json',{identity,workerEntry:'finnor-os/y5-runtime/worker-once.mjs',workerByteIdentityVerified:true});
 }
 if(process.argv.includes('--with-recovery'))await verifyRecovery({env,os,root,tenant:f.tenant,discoveryId:submitted.discoveryId,jobId:submitted.jobId,installed:installedWorker,artifact});
 else{
  const run=spawnSync(process.execPath,entry?[entry,submitted.jobId]:['--import=tsx',join(os,'scripts/postx/y5/worker-once.mts'),submitted.jobId],{
   cwd:os,env:{...process.env,DATABASE_URL:env.workerUrl},encoding:'utf8',timeout:220000,maxBuffer:1048576,
  });
  await artifact('worker-process.json',{status:run.status,signal:run.signal,stdout:run.stdout,stderr:run.stderr});
  assert.equal(run.status,0,run.stderr);
 }
 const read=ok(await call(f,'uniform-algorithms','read',{discoveryId:submitted.discoveryId}));
 await artifact('discovery.json',read);assert.equal(read.status,'CHECKED');assert(read.capsule);
 assert.equal(read.capsule.theorem.mathematicalSizes,'ALL_FINITE_LIST_LENGTHS');
 assert.equal(read.protectedAdmission,false);assert.equal(read.productionActive,false);
 const use=ok(await call(f,'uniform-algorithms','consume',{discoveryId:submitted.discoveryId,allocation:input,idempotencyKey:'use-1',fallback:'NONE'}));
 await artifact('use.json',use);
 assert.equal(use.status,'CHECKED');assert.equal(use.actualMethod,'Y5_SAME_LEAN_DEFINITION');
 assert.equal(use.result.check.objective,'5');
 assert.deepEqual(use.result.check.selectedPolicyIds.map((id:string)=>f.labels[id]),['positive']);
 assert.equal(use.executionAuthorityGranted,false);assert.equal(use.reservationCreated,false);
 const rows=(await env.admin!.query('SELECT body FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2',[f.tenant,submitted.discoveryId])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].body.digest,use.digest);
 const same=ok(await call(f,'uniform-algorithms','consume',{discoveryId:submitted.discoveryId,allocation:input,idempotencyKey:'use-1',fallback:'NONE'}));
 assert.equal(same.digest,use.digest);
 const noConfig=await call(f,'uniform-algorithms','s8-propose',{discoveryId:submitted.discoveryId,idempotencyKey:'propose-without-custody'});
 assert.equal(noConfig.status,503);assert.equal(noConfig.body.code,'Y5_S8_INDEPENDENT_CONFIGURATION_REQUIRED');
 const assigned=ok(await call(f,'uniform-algorithms','assign-evaluation',{discoveryId:submitted.discoveryId,evaluatorId:evaluator,idempotencyKey:'assignment-1'}));
 if(process.argv.includes('--with-s8'))s8=await verifyUniformS8({env,evidence,tenant:f.tenant,principal:f.principal,evaluator,discoveryId:submitted.discoveryId,assignment:assigned,
  artifact,builtApi:process.argv.includes('--built-api'),api:(role,operation,body)=>call(role==='owner'?f:{...f,principal:evaluator},'uniform-algorithms',operation,body)});
 const evaluated=s8?.evaluation??ok(await call({...f,principal:evaluator},'uniform-algorithms','evaluate',{evaluationId:assigned.evaluationId}));
 await artifact('independent-native-evaluation.json',evaluated);
 await artifact('durable-uses.json',(await env.admin!.query('SELECT id,status,deadline_at,body,content_digest FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2 ORDER BY created_at,id',[f.tenant,submitted.discoveryId])).rows);
 assert.equal(evaluated.disposition,'SUPPORTED_DEVELOPMENT');assert.equal(evaluated.protectedAdmission,false);
 assert.equal(evaluated.oracle.maximum,'5');assert.equal(evaluated.oracle.complete,true);
 const problem=use.originalProblem;let optimum:bigint|null=null;
 for(let mask=0;mask<8;mask++){const selected=problem.policies.filter((_:unknown,i:number)=>mask&(2**i)).map((p:any)=>p.ref.id),checked=verifyCanonicalAllocation(problem,selected);if(checked.feasible&&checked.objective!==null){const v=BigInt(checked.objective);if(optimum===null||v>optimum)optimum=v;}}
 assert.equal(optimum,5n);assert.equal(uniformProblemIdentity(problem),use.applicability.problemIdentity);
 if(mountedSeeds){
  mounted=await startMountedSession({root,evidence,env,tenant:f.tenant,principal:f.principal,evaluator,discoveryId:submitted.discoveryId,seeds:mountedSeeds,artifact});
  await mounted.wait('current');
 }
 const changed=structuredClone(input),joint=changed.jointModel;
 joint.choiceConstraints=[{id:'coupled-original',policyIds:changed.policyRefs.map((p:any)=>p.id),minimum:0,maximum:1,sourceRef:input.mandate.businessOwnerRef}];
 const {ref,...jointBody}=joint;changed.jointModel={...jointBody,ref:allocationRef('BUSINESS_OWNER','joint-allocation-model',jointBody,'s5-joint-model-v1')};
 const rejected=ok(await call(f,'uniform-algorithms','consume',{discoveryId:submitted.discoveryId,allocation:changed,idempotencyKey:'assumption-broken',fallback:'NONE'}));
 assert.equal(rejected.status,'UNKNOWN');assert(rejected.applicability.reasons.some((s:string)=>s.startsWith('BOX_DECOMPOSITION_REJECTED:')));
 const invalidation=ok(await call(f,'uniform-algorithms','invalidate',{discoveryId:submitted.discoveryId,dependency:'implementation',reason:'development changed-runtime challenge',idempotencyKey:'invalidate-1'}));
 assert(invalidation.affected.includes('correspondence'));assert(!invalidation.affected.includes('theorem'));
 const invalid=ok(await call(f,'uniform-algorithms','read',{discoveryId:submitted.discoveryId}));
 assert.equal(invalid.current,false);assert.equal(invalid.capsule,null);assert.equal(invalid.historyRetained,true);
 assert.equal(invalid.sourceVisibility,'AUTHORIZED');assert.equal(invalid.historyPayloadsWithheld,false);
 assert(invalid.history.some((event:any)=>event.kind==='KERNEL_ACCEPTED'&&event.body?.capsule));
 await s8?.afterNativeInvalidation();
 if(process.argv.includes('--with-s6')){
  const cleared=ok(await call(f,'allocations','clear',{...input,idempotencyKey:'original-s5-s6-control'}));
  assert.equal(cleared.status,'FEASIBLE');assert.equal(cleared.certificate.check.objective,'5');
  const policy=f.policies[2],handoff=ok(await call(f,'policies','handoff',{
   policyRef:policy.ref,allocationRef:cleared.certificate.ref,decision:support.decision(f,cleared.certificate.ref),
  }));
  assert(handoff.preparationRef&&handoff.consumptionRef&&handoff.intervention);
  const obligation=ok(await call(f,'obligations','prepare',{preparationRef:handoff.preparationRef,allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef}));
  assert.equal(obligation.executionAuthorityGranted,false);assert.equal(obligation.method.status,'UNADMITTED');
  const unresolved=ok(await call(f,'allocations','reconcile',{allocationRef:handoff.allocationRef}));
  assert.equal(unresolved.reservation.status,'UNKNOWN_OUTCOME');
  const snapshot=async()=>({
   effects:(await env.admin!.query('SELECT id,status,semantic_hash,effect FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY id',[f.tenant])).rows,
   reservations:(await env.admin!.query('SELECT reservation_id,status,revision,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',[f.tenant])).rows,
   consumptions:(await env.admin!.query('SELECT consumption_id,status,revision,effect_ref FROM finnor_os.s5_consumption_states WHERE tenant_id=$1 ORDER BY consumption_id',[f.tenant])).rows,
   externalOperations:(await env.admin!.query('SELECT domain_action_id,operation_key,status FROM finnor_os.external_operations WHERE tenant_id=$1 ORDER BY domain_action_id,operation_key',[f.tenant])).rows,
  });
  const before=await snapshot();
  assert.equal(before.effects.length,1);assert.equal(before.effects[0].status,'compiled');
  assert(before.consumptions.some((row:any)=>row.status==='UNKNOWN_OUTCOME'));assert.equal(before.externalOperations.length,0);
  const refused=await call(f,'uniform-algorithms','consume',{discoveryId:submitted.discoveryId,allocation:input,idempotencyKey:'preserve-s6-unknown',fallback:'NONE'});
  assert.equal(refused.body.code,'BLOCKED_AUTHORITY');assert(refused.status>=400);
  let originalGuard='';
  try{await resolveEnterpriseAllocationProblem(f.ctx,input);}catch(error){originalGuard=(error as Error).message;}
  assert.equal(originalGuard,'NATIVE_UNRECONCILED_EFFECTS_REQUIRE_S6_QUALIFIED_RESOURCE_ACCOUNTING');
  const retained=ok(await call(f,'obligations','read',{obligationRef:obligation.ref})),after=await snapshot();
  assert.deepEqual(after,before);assert.deepEqual(retained.ref,obligation.ref);assert.equal(retained.executionAuthorityGranted,false);
  await artifact('s6-responsibility.json',{status:'PASS',scope:'REAL_PREPARED_S6_AND_OWNER_RECONCILIATION_UNKNOWN_NO_EGRESS_ATTEMPT',
   cleared,handoff,obligation,unresolved,before,refused,originalGuard,after,retained,settlementEstablished:false,effectRetried:false});
 }
 let reviewRepairs:Awaited<ReturnType<typeof verifyReviewRepairs>>|undefined;
 if(process.argv.includes('--review-repairs')||onlyCompiledFaults)reviewRepairs=await verifyReviewRepairs({
  env,support,root,os,evidence,deadlineAt:started+900000,installedWorker,builtApi:process.argv.includes('--built-api'),
  selection:onlyCompiledFaults?'compiled-faults':'all',
  coupledProblem:rejected.originalProblem,call,artifact,
  register:async fixture=>{if(!tokens.has(fixture.principal)){
   env.http!.register(fixture.principal,fixture.name+'@s5.example.test');tokens.set(fixture.principal,await env.http!.login(fixture.principal));
  }},
 });
 if(mounted){await mounted.wait('withdrawn');await mounted.close();mounted=undefined;}
 await artifact('results.json',{status:'PASS',
  scope:onlyCompiledFaults?'PUBLIC_DEVELOPMENT_INSTALLED_OWNER_AND_COMPILED_FAULTS_ONLY':'PUBLIC_DEVELOPMENT_REAL_AUTH_HTTP_QUEUE_NATIVE_KERNEL_AND_S5_NO_PROTECTED_AUTHORITY',wallMs:Date.now()-started,observations,
  sourceRoute:!process.argv.includes('--built-api'),actualBuiltNextApi:process.argv.includes('--built-api'),emittedProductionWorker:installedWorker,
  hostedAuthQualified:false,reviewRepairs:reviewRepairs??null,completeMoney:null,aggregatePeakMemory:null});
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started}));
}catch(error){await artifact('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,observations});throw error;}
finally{await mounted?.close();await s8?.close();await env.close();}
