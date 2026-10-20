/** Additional installed predicates frozen in acceptance/integration-plan.md.
 * These are real HTTP/SQL/queue episodes, not isolated candidate unit tests. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {withTenantClientTransaction,acquireComputeResourceLeases,releaseComputeResourceLeases} from '@finnor/db';
import {reconciliation} from './business-fixtures.mts';
import {artifact,hash} from './environment.mts';
export async function installedChecks(f:any){
 const {e,tenant,root,main,api,command,record,runWorker,finish,maintenance,people,roles,evidence,second,secondCommand,secondInput,support,refreshSource}=f;
 const checks:any[]=[],ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 // Literal second-declaration negative episodes, each starting from real data.
 let r=ok(await secondCommand('create',null,secondInput)).record;
 await refreshSource(support,'S1/support/2');
 const stale=ok(await secondCommand('document',r));assert.equal(stale.decision.outcome,'SOURCE_STALE');assert.equal(stale.record.state,'OPEN');
 r=ok(await secondCommand('create',null,{...secondInput,support:support.current})).record;
 r=ok(await secondCommand('document',r)).record;
 const before=(await e.admin.query('SELECT id,active FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND employee_id=$2 AND role_id=$3',[tenant,people.analyst,roles.partner])).rows[0];
 await e.admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,active) VALUES($1,$2,$3,$4::jsonb,true) ON CONFLICT(employee_id,role_id) DO UPDATE SET active=true",[tenant,people.analyst,roles.partner,JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]})]);
 const self=ok(await secondCommand('close',r));assert.equal(self.decision.outcome,'SELF_APPROVAL_DENIED');
 await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=$4 WHERE tenant_id=$1 AND employee_id=$2 AND role_id=$3',[tenant,people.analyst,roles.partner,before?.active??false]);
 await e.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenant,people.partner]);
 const revoked=await secondCommand('close',r,{},'partner');assert([401,403,404].includes(revoked.status));
 await e.admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2",[tenant,people.partner]);
 checks.push({id:'second-application-frozen-negatives',stale,self,revoked,authorityFromCanonicalOwners:true});

 // Exactly one CAS winner across sixteen real simultaneous authenticated clients.
 let view=ok(await api('analyst','read',{applicationId:main.id,limit:100})),target=view.records[0];
 target=ok(await command(main.id,'edit',target,{memo:'Explicit rebase before concurrency proof'})).record;
 const contenders=await Promise.all(Array.from({length:16},(_,i)=>command(main.id,'edit',target,{memo:'Competing edit '+i})));
 assert.equal(contenders.filter(x=>x.status===200&&x.body.decision.allowed).length,1);
 assert.equal(contenders.filter(x=>x.status===409&&x.body.code==='COMMIT_CONFLICT').length,15);
 target=await record(main.id,target.id);
 const body={applicationId:main.id,entityId:'reconciliation',actionId:'edit',recordId:target.id,expectedRevision:target.revision,expectedReference:target.reference,input:{memo:'One idempotent edit'},idempotencyKey:randomUUID()};
 const repeated=await Promise.all(Array.from({length:4},()=>api('analyst','command',body)));
 assert(repeated.every(x=>x.status===200));assert.equal(repeated.filter(x=>x.body.replayed).length,3);
 const ordinary=await withTenantClientTransaction(tenant,{userId:people.analyst,readOnly:true},async(c:any)=>{
  const identity=(await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  const count=(await c.query('SELECT count(*)::integer n FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND actor_id=$3 AND idempotency_key=$4',[tenant,main.id,people.analyst,'command:'+body.idempotencyKey])).rows[0];
  return {identity,count:count.n};
 });
 assert.equal(ordinary.identity.current_user,'finnor_app');assert.equal(ordinary.identity.rolbypassrls,false);assert.equal(ordinary.count,1);
 checks.push({id:'sixteen-clients-and-idempotency',contenders:contenders.map(x=>({status:x.status,code:x.body.code,outcome:x.body.decision?.outcome})),ordinary});

 // Both remaining maintenance classes use the actual build/install path.
 view=await maintenance(main,3,'IDENTITY_AUTHORIZATION_CONCURRENCY');
 const beforeSchema=view.records.map((x:any)=>({id:x.id,values:x.values,origin:x.originReleaseId}));
 const schema=reconciliation(tenant,root.entityId,4);
 schema.model.entities[0]!.fields.push({id:'retentionNote',title:'Retention note',type:'text',required:true,allowUnknown:false,maxLength:200});
 // This is an explicit migration default, not a fabricated historical value.
 // Generated creation must also ask for the new required business field.
 schema.actions.find((x:any)=>x.id==='create')!.inputFields.push('retentionNote');
 for(const c of schema.acceptanceCases)c.input.record!.values.retentionNote='Explicit development migration default';
 const migrated=await maintenance(main,4,'DEPENDENCY_SCHEMA_DEPLOYMENT',[{kind:'ADD_FIELD',entityId:'reconciliation',field:'retentionNote',value:'Explicit development migration default'}],schema);
 for(const old of beforeSchema){const current=migrated.records.find((x:any)=>x.id===old.id);assert(current);assert.deepEqual(Object.fromEntries(Object.keys(old.values).map(k=>[k,current.values[k]])),old.values);assert.equal(current.originReleaseId,old.origin);assert.equal(current.values.retentionNote,'Explicit development migration default');}
 const incompatible=structuredClone(schema);incompatible.version='5';
 const memo=incompatible.model.entities[0]!.fields.find(x=>x.id==='memo');assert(memo?.type==='text');memo.maxLength=1;
 for(const c of incompatible.acceptanceCases)c.input.record!.values.memo='X';
 const accepted=ok(await api('analyst','maintain',{applicationId:main.id,expectedReleaseId:migrated.headReleaseId,specification:incompatible,idempotencyKey:randomUUID(),changeClass:'DEPENDENCY_SCHEMA_DEPLOYMENT',migration:[]}),202);
 for(let i=0;i<8;i++){await runWorker();view=ok(await api('analyst','read',{applicationId:main.id,limit:100}));if(view.status==='FAILED')break;}
 assert.equal(view.status,'FAILED');assert.equal(view.headReleaseId,migrated.headReleaseId);
 assert.deepEqual(view.records.map((x:any)=>({id:x.id,values:x.values})),migrated.records.map((x:any)=>({id:x.id,values:x.values})));
 const unsafe=ok(await api('analyst','rollback',{applicationId:main.id,expectedReleaseId:view.headReleaseId,releaseId:main.installed.headReleaseId,idempotencyKey:randomUUID()}));
 assert.equal(unsafe.status,'ROLLBACK_BLOCKED');
 const repaired=await maintenance(main,4,'DEPENDENCY_SCHEMA_DEPLOYMENT',[],schema);
 const safe=ok(await api('analyst','rollback',{applicationId:main.id,expectedReleaseId:repaired.headReleaseId,releaseId:migrated.headReleaseId,idempotencyKey:randomUUID()}));
 assert.equal(safe.status,'ROLLED_BACK_DEVELOPMENT');assert.equal(safe.externalEffectsUndone,false);
 checks.push({id:'schema-migration-unsafe-rollback-forward-repair-safe-rollback',accepted,unsafe,safe,preservedRecords:beforeSchema.length,originalDeadlineAt:migrated.counters.deadlineAt,countersAfterFailure:view.counters});

 const impact=ok(await api('analyst','impact',{applicationId:main.id,changed:['identity','sources','checker']}));
 assert.equal(impact.authorityGranted,false);
 checks.push({id:'p7-affected-closure',impact});
 const request=()=>({schema:'finnor.x3.application-request.v1',root,specification:reconciliation(tenant,root.entityId),idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxBuilds:16,maxMutations:10000}});
 // Hold actual compute capacity. The deferred attempt must not spend a build.
 const leases=await acquireComputeResourceLeases({tenantId:tenant,resourceKeys:['native:x3-build'],requiredResourceKeys:['native:x3-build'],workloadClass:'INTERACTIVE',ownerId:'X3_DISPOSABLE_CAPACITY_PROOF'});
 let queued:any;
 try{
  queued=ok(await api('analyst','submit',request()),202);await runWorker();
  const held=ok(await api('analyst','read',{applicationId:queued.applicationId}));assert.equal(held.counters.builds,0);assert.equal(held.headReleaseId,null);
  checks.push({id:'governor-defers-before-physical-build',applicationId:queued.applicationId,status:held.status,counters:held.counters});
 }finally{await releaseComputeResourceLeases(leases,'disposable_capacity_proof_finished');}
 // Queue defer backoff is real; advance no clocks and renew no allocations.
 const due=(await e.admin.query('SELECT run_at FROM finnor_os.jobs WHERE id=$1',[queued.jobId])).rows[0].run_at;
 await new Promise(yes=>setTimeout(yes,Math.max(0,due.getTime()-Date.now()+100)));const resumed=await finish(queued.applicationId);assert.equal(resumed.counters.builds,1);
 const stagedInput={...request(),installNotBefore:new Date(Date.now()+7000).toISOString()};
 const staged=ok(await api('analyst','submit',stagedInput),202);await runWorker();
 const pending=ok(await api('analyst','read',{applicationId:staged.applicationId}));assert.equal(pending.status,'INSTALLING');assert.equal(pending.headReleaseId,null);
 await new Promise(yes=>setTimeout(yes,Math.max(0,Date.parse(stagedInput.installNotBefore)-Date.now()+100)));
 const installed=await finish(staged.applicationId);assert.equal(installed.counters.builds,1);assert.equal(installed.counters.deadlineAt,pending.counters.deadlineAt);
 checks.push({id:'staged-process-replacement-retains-original-allocation',applicationId:staged.applicationId,before:pending.counters,after:installed.counters});
 const cancelInput={...request(),installNotBefore:new Date(Date.now()+7000).toISOString()};
 const cancelled=ok(await api('analyst','submit',cancelInput),202);await runWorker();
 const beforeCancel=ok(await api('analyst','read',{applicationId:cancelled.applicationId}));
 const cancel=ok(await api('analyst','cancel',{applicationId:cancelled.applicationId,expectedReleaseId:null,idempotencyKey:randomUUID()}));assert.equal(cancel.status,'CANCELLED');
 await new Promise(yes=>setTimeout(yes,Math.max(0,Date.parse(cancelInput.installNotBefore)-Date.now()+100)));await runWorker();
 const afterCancel=ok(await api('analyst','read',{applicationId:cancelled.applicationId}));assert.equal(afterCancel.headReleaseId,null);assert.equal(afterCancel.status,'CANCELLED');assert.equal(afterCancel.counters.builds,beforeCancel.counters.builds);
 checks.push({id:'cancel-fences-staged-installation',cancel,before:beforeCancel.counters,after:afterCancel.counters});
 const expiredInput=request();expiredInput.limits.deadlineMs=1000;
 const expired=ok(await api('analyst','submit',expiredInput),202);await new Promise(yes=>setTimeout(yes,1100));await runWorker();
 const expiredState=ok(await api('analyst','read',{applicationId:expired.applicationId}));assert.equal(expiredState.headReleaseId,null);assert.equal(expiredState.status,'FAILED');
 const oversize=await api('analyst','submit',{...request(),untrusted:'x'.repeat(128*1024)});assert.equal(oversize.status,413);
 const foreignAsset=await api('foreign','asset',{applicationId:main.id,releaseId:migrated.headReleaseId,path:'backend/program.json'});assert.equal(foreignAsset.status,404);
 const traversal=await api('analyst','asset',{applicationId:main.id,releaseId:migrated.headReleaseId,path:'../../secret'});assert.equal(traversal.status,404);
 checks.push({id:'deadline-body-and-private-asset-bounds',expired:expiredState.counters,oversize,foreignAsset,traversal});
 await artifact(evidence,'installed-maintenance-recovery-resources.json',{checks,allPassed:true,finiteProfileNotAnAggregateMemoryOrFinancialMeter:true});
 return checks;
}
