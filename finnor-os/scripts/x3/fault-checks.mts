/** Preregistered physical/domain fences, checker mutations and finite bounds.
 * Fault injection is limited to this disposable database and owned worker. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {withTenantClientTransaction} from '@finnor/db';
import {artifact,repo} from './environment.mts';
import {reconciliation,exceptionRegister} from './business-fixtures.mts';
export async function installedFaultChecks(f:any){
 const {e,tenant,root,main,api,people,evidence,runWorker,finish,secondInput,support}=f,checks:any[]=[];
 const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const request=(specification=reconciliation(tenant,root.entityId),limits={deadlineMs:3600000,maxBuilds:16,maxMutations:10000})=>({schema:'finnor.x3.application-request.v1',root,specification,idempotencyKey:randomUUID(),limits});
 const release=(await e.admin.query('SELECT body FROM finnor_os.x3_releases WHERE tenant_id=$1 AND id=$2',[tenant,main.installed.headReleaseId])).rows[0].body;
 await artifact(evidence,'checker-controls-input.json',{specification:release.specification,built:release.built});
 const probe=spawnSync(process.execPath,['--import=tsx','--max-old-space-size=256','scripts/x3/check-controls.mts',join(evidence,'checker-controls-input.json')],{cwd:join(repo,'finnor-os'),env:{PATH:process.env.PATH,NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
 assert.equal(probe.status,0,probe.stderr);const controls=JSON.parse(probe.stdout);
 assert.equal(controls.base.status,'PASS');assert(controls.controls.every((c:any)=>c.check.status==='FAIL'));
 checks.push({id:'self-consistent-mutated-instruction-and-omitted-action-refused',...controls,neverPublished:true});

 const accepted=ok(await api('analyst','submit',request()),202);
 let workerFinished=false;
 const launchWorker=()=>runWorker().finally(()=>{workerFinished=true;});
 let oldWorker=launchWorker();
 let pid:number|undefined,paused=false,old:any;
 try{
  const until=Date.now()+15000;
  while(Date.now()<until){
   old=(await e.admin.query("SELECT b.status,b.attempt_count,a.deadline_at,a.build_count,a.release_count,d.id AS delivery_id,d.worker_id,j.claim_fence FROM finnor_os.x3_builds b JOIN finnor_os.x3_applications a ON a.tenant_id=b.tenant_id AND a.id=b.application_id JOIN finnor_os.jobs j ON j.id=$3 JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id AND d.outcome='running' WHERE b.tenant_id=$1 AND b.id=$2",[tenant,accepted.buildId,accepted.jobId])).rows[0];
   if(old?.status==='BUILDING')break;
   if(workerFinished){await oldWorker;workerFinished=false;oldWorker=launchWorker();}
   await new Promise(yes=>setTimeout(yes,5));
  }
  assert.equal(old?.status,'BUILDING','Actual physical build must be observed');
  assert.match(old.worker_id,/^x3-physical-\d+$/);pid=Number(old.worker_id.split('-').at(-1));assert(pid>1);
  process.kill(pid,'SIGSTOP');paused=true;
  assert.equal(old.release_count,0);
  // Accelerate only expiry in the owned disposable fault fixture. Do not
  // manufacture a new claim, allocation, deadline or increased resource limit.
  await e.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND status='running'",[accepted.jobId]);
  await e.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=clock_timestamp() WHERE owner_id=$1 AND released_at IS NULL",['x3:'+old.delivery_id]);
  await runWorker();
  process.kill(pid,'SIGCONT');paused=false;await oldWorker;
  const installed=await finish(accepted.applicationId);
  assert.equal(installed.counters.builds,2);assert.equal(installed.counters.releases,1);assert.equal(installed.counters.deadlineAt,old.deadline_at.toISOString());
  const deliveries=(await e.admin.query('SELECT id,worker_id,claim_fence,outcome FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at',[accepted.jobId])).rows;
  assert.equal(deliveries[0].outcome,'lease_lost');assert.equal(BigInt(deliveries[1].claim_fence),BigInt(old.claim_fence)+1n);
  checks.push({id:'expired-old-physical-delivery-cannot-publish-over-replacement',injection:'OWNED_WORKER_SIGSTOP_AND_DISPOSABLE_LEASE_EXPIRY_ONLY',original:old,deliveries,counters:installed.counters,releaseId:installed.headReleaseId,unknownEarlierPhysicalCostRetained:true});
 }finally{if(paused&&pid)process.kill(pid,'SIGCONT');await oldWorker;}

 const limited=ok(await api('analyst','submit',request(exceptionRegister(tenant,root.entityId),{deadlineMs:3600000,maxBuilds:1,maxMutations:1})),202),installed=await finish(limited.applicationId);
 const created=ok(await api('analyst','command',{applicationId:limited.applicationId,entityId:'control_exception',actionId:'create',input:{...secondInput,support:support.current??support.ref},idempotencyKey:randomUUID()}));
 const exhausted=await api('analyst','command',{applicationId:limited.applicationId,entityId:'control_exception',actionId:'document',recordId:created.record.id,expectedRevision:created.record.revision,expectedReference:created.record.reference,input:{},idempotencyKey:randomUUID()});
 assert.equal(exhausted.status,409);assert.equal(exhausted.body.code,'ORIGINAL_APPLICATION_MUTATION_BOUND');
 const tooMany=await api('analyst','maintain',{applicationId:limited.applicationId,expectedReleaseId:installed.headReleaseId,specification:exceptionRegister(tenant,root.entityId),changeClass:'BUSINESS_RULES_UNITS',migration:[],idempotencyKey:randomUUID()});
 assert.equal(tooMany.status,409);assert.equal(tooMany.body.code,'ORIGINAL_APPLICATION_BUILD_BOUND');
 await assert.rejects(()=>withTenantClientTransaction(tenant,{userId:people.analyst},(c:any)=>c.query("UPDATE finnor_os.x3_applications SET deadline_at=deadline_at+interval '1 hour' WHERE tenant_id=$1 AND id=$2",[tenant,limited.applicationId])),/cannot reset/);
 const unchanged=ok(await api('analyst','read',{applicationId:limited.applicationId}));assert.equal(unchanged.records[0].state,'OPEN');assert.equal(unchanged.counters.mutations,1);
 checks.push({id:'original-build-mutation-and-deadline-allocation-cannot-renew',exhausted,tooMany,counters:unchanged.counters});
 // A declared near-exhaustion SQL-ledger fixture, not physical disk or memory
 // metering. The next ordinary HTTP write must roll back atomically.
 await e.admin.query('UPDATE finnor_os.x3_applications SET data_bytes=16777200 WHERE tenant_id=$1 AND id=$2',[tenant,limited.applicationId]);
 const storage=await api('analyst','rollback',{applicationId:limited.applicationId,expectedReleaseId:installed.headReleaseId,releaseId:installed.headReleaseId,idempotencyKey:randomUUID()});
 assert.equal(storage.status,409);assert.equal(storage.body.code,'APPLICATION_STORAGE_BOUND');
 const after=ok(await api('analyst','read',{applicationId:limited.applicationId}));assert.equal(after.counters.dataBytes,16777200);assert.equal(after.headReleaseId,installed.headReleaseId);
 const unsupported=await api('analyst','submit',{...request(),sourceCode:'process.exit(0)'});assert.equal(unsupported.status,400);
 checks.push({id:'retained-storage-and-unsupported-guest-input-refused',storage,unsupported,fixtureBasis:'DECLARED_NEAR_EXHAUSTION_LEDGER_NOT_A_CAPACITY_OR_PHYSICAL_USAGE_MEASUREMENT'});
 if(process.env.FINNOR_X3_BUILT_API==='1'){
  const previous=process.env.FINNOR_ENVIRONMENT;process.env.FINNOR_ENVIRONMENT='production';
  try{
   await e.http.restartApi();
   const declaredProduction=await api('analyst','submit',request());
   assert.equal(declaredProduction.status,403);assert.equal(declaredProduction.body.code,'APPLICATION_PRODUCTION_UNADMITTED');
   checks.push({id:'ordinary-runtime-explicit-production-environment-refuses-x3',declaredProduction,runtime:'test',environment:'production',authBypass:false,productionActive:false});
   const before=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_applications WHERE tenant_id=$1',[tenant])).rows[0].n;
   await e.http.restartApi({runtime:'production',unsetDevBypass:true});
   const production=await api('analyst','submit',request());assert.equal(production.status,500);
   const after=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_applications WHERE tenant_id=$1',[tenant])).rows[0].n;
   assert.equal(after,before);
   checks.push({id:'actual-production-bootstrap-refuses-before-x3-handler',production,runtime:'production',environment:'production',applicationCounts:{before,after},
    qualification:'CANONICAL_MANAGED_SECRETS_PROVIDER_UNAVAILABLE_FAILS_CLOSED_NO_OVERRIDE; X3_HANDLER_IN_PRODUCTION_NOT_REACHED',authBypass:false,productionActive:false});
  }finally{if(previous===undefined)delete process.env.FINNOR_ENVIRONMENT;else process.env.FINNOR_ENVIRONMENT=previous;await e.http.restartApi();}
 }
 await artifact(evidence,'installed-faults-and-bounds.json',{checks,allPassed:true});return checks;
}
