/** Preregistered installed-boundary proof, not a post-hoc unit suite.
 * Real bearer HTTP, ordinary RLS, durable claims and separate compiler process.
 * All tenants, employee assignments, sources and business inputs are disposable.
 * No credential, signing key or authenticated browser storage enters evidence. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {readFile,appendFile,mkdir} from 'node:fs/promises';
import {configureTenantVertical,closePool,createEmployeeConversationThread,attachWorkEntity} from '@finnor/db';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {startEnvironment,artifact,repo,hash} from './environment.mts';
import {reconciliation,exceptionRegister,quantity} from './business-fixtures.mts';
import {installedChecks} from './installed-checks.mts';
import {applicationS8Proof} from './s8-installed.mts';
import {installedFaultChecks} from './fault-checks.mts';
import {installedReviewChecks} from './review-checks.mts';
import {checkInstalledEnvelope} from './envelope-check.mts';
import {completionAuthorityChecks} from './completion-authority-checks.mts';

const evidence=resolve(process.env.FINNOR_X3_EVIDENCE_DIR??join(repo,'scope-x3/evidence/installed-'+Date.now()));
await mkdir(evidence,{recursive:true});
const corpus=JSON.parse(await readFile(join(repo,'scope-x3/acceptance/cases.json'),'utf8'));
const results:any[]=[],checks:any[]=[];
const faultProbe=process.env.FINNOR_X3_FAULT_ONLY==='1',limited=process.env.FINNOR_X3_SMOKE_ONLY==='1'||faultProbe;
const e=await startEnvironment(evidence,{builtApi:process.env.FINNOR_X3_BUILT_API==='1'});
const tenant=randomUUID(),foreignTenant=randomUUID(),root={entityType:'external_organization',entityId:randomUUID()},otherRoot=randomUUID();
const people={analyst:randomUUID(),partner:randomUUID(),compliance:randomUUID(),foreign:randomUUID()},tokens:Record<string,string>={};
const roles:Record<string,string>={},refs=new Map<string,string>();
let processCount=0;
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const api=(who:string,op:string,input:unknown)=>e.http!.api(tokens[who]??tokens.analyst!,'company-brain','application-'+op,input);
const record=(applicationId:string,id:string,who='analyst')=>api(who,'record',{applicationId,recordId:id}).then(ok);
async function runWorker(){
 const number=++processCount,started=Date.now();
 const out=await new Promise<{code:number|null;signal:string|null;logs:string}>((yes,no)=>{
  const child=spawn(process.execPath,['--import=tsx','scripts/x3/worker-once.mts'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe']});
  let logs='';const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  child.once('error',no);child.once('close',(code,signal)=>{clearTimeout(timer);yes({code,signal,logs});});
 });
 assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(out.logs),'Worker log unexpectedly contains credentials');
 await artifact(evidence,`workers/${number}.json`,{...out,wallMs:Date.now()-started,ordinaryWorkerRole:true});
 assert.equal(out.code,0,JSON.stringify(out));return out;
}
async function finish(applicationId:string,terminal='INSTALLED'){
 for(let i=0;i<16;i++){
  const state=ok(await api('analyst','read',{applicationId,limit:100}));
  if(state.status===terminal)return state;
  if(['FAILED','CANCELLED'].includes(state.status))throw Error('APPLICATION_TERMINAL:'+JSON.stringify(state.builds));
  await runWorker();
 }
 throw Error('APPLICATION_DID_NOT_INSTALL');
}
async function submit(specification:any,extra:Record<string,unknown>={}){
 const body={schema:'finnor.x3.application-request.v1',root,specification,idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxBuilds:16,maxMutations:10000},...extra};
 const accepted=ok(await api('analyst','submit',body),202);
 const replay=ok(await api('analyst','submit',body),202);assert.equal(replay.applicationId,accepted.applicationId);assert.equal(replay.replayed,true);
 const changed=await api('analyst','submit',{...body,limits:{...body.limits,maxMutations:9999}});assert.equal(changed.status,409);
 const installed=await finish(accepted.applicationId);assert(installed.headReleaseId);assert.equal(installed.package.proofs.protectedCustody,false);
 const envelope=await checkInstalledEnvelope(e,installed,tenant,evidence);
 const reread=ok(await api('analyst','read',{applicationId:accepted.applicationId,limit:100}));
 assert.deepEqual(reread.package.envelope,installed.package.envelope,'Unchanged reads retain exact envelope identity');
 checks.push({id:'complete-common-envelope',...envelope});
 await artifact(evidence,'applications/'+accepted.applicationId+'.json',{input:body,accepted,replay,changed,installed});
 return {id:accepted.applicationId,workId:accepted.workId,installed};
}
async function source(name:string){
 const s=await createEvidenceSource(tenant,{sourceKey:'x3:'+name+':'+randomUUID(),sourceType:'manual',title:'Predeclared disposable '+name});
 const v=await appendEvidenceVersion(tenant,s.id,{content:'Independent development input '+name,snapshot:{qualification:'DECLARED_BUSINESS_ASSERTION_NOT_PROTECTED_FINANCIAL_TRUTH'},asOf:new Date('2026-01-01T00:00:00Z')});
 const row=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[v.versionId])).rows[0];
 const ref={kind:'EVIDENCE',sourceId:s.id,versionId:v.versionId,contentDigest:row.content_hash};
 return {ref,version:1,current:undefined as typeof ref|undefined};
}
async function refreshSource(s:any,label:string){
 const v=await appendEvidenceVersion(tenant,s.ref.sourceId,{content:'Owner published revision '+label,snapshot:{qualification:'DECLARED_BUSINESS_ASSERTION'},asOf:new Date('2026-01-02T00:00:00Z')});
 const row=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[v.versionId])).rows[0];
 s.version++;s.current={...s.ref,versionId:v.versionId,contentDigest:row.content_hash};refs.set(v.versionId,label);
}
async function command(app:string,actionId:string,r:any,input:unknown={},who='analyst',extra:Record<string,unknown>={}){
 return api(who,'command',{applicationId:app,entityId:'reconciliation',actionId,input,idempotencyKey:randomUUID(),...(r?{recordId:r.id,expectedRevision:r.revision,expectedReference:r.reference}:{}),...extra});
}
function projection(r:any,releaseNames:Map<string,string>,logicalRevision=1){
 const values=r.values,amount=values.quantity?.amount;
 return {record_ref:'P1/rec-1/'+logicalRevision,release:releaseNames.get(r.releaseId),state:r.state,currency:values.book.entries[0].currency,
  book_minor:values.book.entries.map((q:any)=>q.amount),bank_minor:values.bank.entries.map((q:any)=>q.amount),...(amount===undefined?{}:{amount_minor:amount}),
  approvers:r.approvals.map((a:any)=>Object.entries(people).find(([,id])=>id===a.principalId)?.[0]).map((a:string)=>({partner:'u-p',compliance:'u-c',analyst:'u-a'}[a])).sort(),
  source_refs:[refs.get(values.bookEvidence.versionId),refs.get(values.bankEvidence.versionId)]};
}
async function maintenance(app:any,version=2,changeClass='BUSINESS_RULES_UNITS',migration:any[]=[],specification=reconciliation(tenant,root.entityId,version),extra:Record<string,unknown>={}){
 const before=ok(await api('analyst','read',{applicationId:app.id,limit:100}));
 const accepted=ok(await api('analyst','maintain',{applicationId:app.id,expectedReleaseId:before.headReleaseId,specification,idempotencyKey:randomUUID(),changeClass,migration,...extra}),202);
 const installed=await finish(app.id);
 assert.notEqual(before.headReleaseId,installed.headReleaseId);
 assert.equal(installed.package.parents[0].id,before.headReleaseId);
 const parent=(await e.admin.query('SELECT body_digest FROM finnor_os.x3_releases WHERE tenant_id=$1 AND id=$2',[tenant,before.headReleaseId])).rows[0];
 assert.equal(installed.package.parents[0].contentDigest,parent.body_digest);
 checks.push({id:'maintenance-'+changeClass,accepted,beforeHead:before.headReleaseId,afterHead:installed.headReleaseId,beforeCounters:before.counters,afterCounters:installed.counters});
 return installed;
}
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X3 disposable firm'),($3,$4,'X3 foreign firm')",[tenant,randomUUID(),foreignTenant,randomUUID()]);
 for(const [name,id] of Object.entries(people)){
  const t=name==='foreign'?foreignTenant:tenant,email=id+'@x3.example.test';
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active',$4)",[id,t,email,'Disposable '+name]);
  e.http!.register(id,email);tokens[name]=await e.http!.login(id);
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'x3-firm','Disposable firm','other'),($3,$2,'x3-other','Other scope','other')",[root.entityId,tenant,otherRoot]);
 for(const t of [tenant,foreignTenant])await configureTenantVertical({tenantId:t,verticalKey:'private_equity',expectedVersion:0,createdBy:t===tenant?people.analyst:people.foreign,sourceSystem:'X3:disposable-development'});
 for(const name of ['analyst','partner','compliance']){
  const row=(await e.admin.query("INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,key) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenant,'x3_'+name,'X3 disposable '+name])).rows[0];roles[name]=row.id;
  await e.admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)",[tenant,people[name as keyof typeof people],row.id,JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]})]);
 }
 const existingErrors=[];
 for(const [operation,input] of [['search',{query:7}],['projection',{}],['belief-view',{}]] as const){
  const response=await e.http!.api(tokens.analyst!,'company-brain',operation,input);
  assert.equal(response.status,400);assert.equal(response.body.code,'INVALID_REQUEST');assert(response.body.issues.length>0&&response.body.issues.length<=20);
  existingErrors.push({operation,input,response});
 }
 checks.push({id:'existing-company-brain-errors-preserved',observations:existingErrors});
 const main=await submit(reconciliation(tenant,root.entityId));
 const releaseNames=new Map([[main.installed.headReleaseId,'r1']]);
 const selected=limited?corpus.cases.slice(0,1):corpus.cases;
 for(const item of selected){
  console.log('X3_CASE',item.id);
  let app=main,names=releaseNames,r:any=null,logicalRevision=1,author='analyst';
  const observations:any[]=[],codes:string[]=[],readbacks:any[]=[],prepared=new Set<string>(),recordInput={...corpus.contexts.base.record,...item.input.record};
  const settings=item.input.set??{},actors=settings.actor_overrides??{},aliases:Record<string,string>={analyst:'analyst',partner:'partner',compliance:'compliance'};
  const savedAssignments=(await e.admin.query('SELECT id,active,resource_scope FROM finnor_os.employee_role_assignments WHERE tenant_id=$1',[tenant])).rows;
  try{
   if(item.id.includes('retains-original')||item.id==='revision-retains-original'){app=await submit(reconciliation(tenant,root.entityId));names=new Map([[app.installed.headReleaseId,'r1']]);}
   if(recordInput.release==='r2'&&!names.has((ok(await api('analyst','read',{applicationId:app.id}))).headReleaseId+'-r2')){
    const current=ok(await api('analyst','read',{applicationId:app.id}));
    if(names.get(current.headReleaseId)!=='r2'){const next=await maintenance(app);names.set(next.headReleaseId,'r2');}
   }
   for(const [name,override] of Object.entries(actors) as any){
    if(override.principal==='u-p')aliases[name]='partner';
    for(const role of override.roles??(override.principal==='u-p'?[name]:[]))
     await e.admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,active) VALUES($1,$2,$3,$4::jsonb,true) ON CONFLICT(employee_id,role_id) DO UPDATE SET active=true",[tenant,people[aliases[name] as keyof typeof people],roles[role],JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]})]);
   }
   const book=await source(item.id+'-book'),bank=await source(item.id+'-bank');refs.set(book.ref.versionId,'S1/book/1');refs.set(bank.ref.versionId,'S1/bank/1');
   const inputValues=(rec=recordInput,status=settings.source_status??['KNOWN','KNOWN'])=>({
    memo:'Independent case '+item.id,book:{kind:'QUANTITY_LIST',entries:rec.book_minor.map((s:any)=>quantity(s,rec.book_currency,root.entityId))},
    bank:{kind:'QUANTITY_LIST',entries:rec.bank_minor.map((s:any)=>quantity(s,rec.bank_currency,root.entityId))},
    bookStatus:status[0]==='STALE'?'KNOWN':status[0],bankStatus:status[1]==='STALE'?'KNOWN':status[1],
    bookEvidence:book.current??book.ref,bankEvidence:bank.current??bank.ref,operation:'LOCAL_PREPARE',channel:'LOCAL',
   });
   author=recordInput.author==='u-p'?'partner':'analyst';
   const created=await command(app.id,'create',null,inputValues(),author);observations.push({step:'create',...created});
   if(item.id.startsWith('invalid-')){
    assert.equal(created.status,400);assert.equal(created.body.code,'INVALID_APPLICATION_REQUEST');
    results.push({id:item.id,classification:'STRICTER_TYPED_BOUNDARY_REFUSAL',literalCaseInstalled:false,expected:item.expected,observations,noRecordCreated:true});
    continue;
   }
   r=ok(created).record;assert(r,'Actual stored DRAFT required');
   for(const [name,override] of Object.entries(actors) as any)if(override.scope)
    await e.admin.query('UPDATE finnor_os.employee_role_assignments SET resource_scope=$3::jsonb WHERE tenant_id=$1 AND employee_id=$2',[tenant,people[name as keyof typeof people],JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[otherRoot]})]);
   if(settings.source_status?.[0]==='STALE')await refreshSource(book,'S1/book/2');
   if(settings.source_status?.[1]==='STALE')await refreshSource(bank,'S1/bank/2');
   for(const event of item.input.events){
    if(event.op==='activate'){
     const next=await maintenance(app);names.set(next.headReleaseId,event.release);codes.push('ACTIVATED');r=await record(app.id,r.id);observations.push({step:'activate',releaseId:next.headReleaseId,postInstallPrecondition:r.reference,concurrencyRevision:r.revision});continue;
    }
    if(event.op==='restart'){
     if(process.env.FINNOR_X3_BUILT_API==='1')await e.http!.restartApi();
     else await closePool();
     await runWorker();codes.push('RESTARTED');observations.push({step:'restart',apiProcessReplaced:process.env.FINNOR_X3_BUILT_API==='1',workerProcessReplaced:true});continue;
    }
    if(event.op==='revoke'){
     await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND employee_id=$2',[tenant,people[event.actor as keyof typeof people]]);
     codes.push('REVOKED');continue;
    }
    if(event.op==='refresh'){await refreshSource(event.source===0?book:bank,event.ref);codes.push('REFRESHED');continue;}
    if(event.op==='read'){
     const who=actors[event.as]?.tenant?'foreign':aliases[event.as]??event.as,response=await api(who,'record',{applicationId:app.id,recordId:r.id});observations.push({step:'read',...response});
     if(response.status===404){codes.push('TENANT_DENIED');assert.equal(who,'foreign');continue;}
     r=ok(response);codes.push('READ');readbacks.push(projection(r,names,logicalRevision));continue;
    }
    const who=aliases[event.as]??event.as;
    const before=r;
    if(event.race){const race=ok(await command(app.id,'edit',r,{memo:'Concurrent business edit'}));r=race.record;}
    const extra:Record<string,unknown>={};
    if(event.ref)extra.expectedReference={...before.reference,revision:event.ref.split('/').at(-1),contentDigest:'0'.repeat(64)};
    if(event.op==='approve')extra.approvalRole=event.as==='analyst'?'partner':event.as;
    const input=event.op==='edit'?inputValues({...recordInput,...event.record}):{};
    const response=await command(app.id,event.op==='edit'?'edit':event.op,event.race?before:r,input,who,extra);
    observations.push({step:event.op,...response});
    if(response.status===404&&item.id==='wrong-scope'){codes.push('SCOPE_DENIED');continue;}
    if(response.status===409&&response.body.code==='COMMIT_CONFLICT'){codes.push('COMMIT_CONFLICT');continue;}
    const body=ok(response);codes.push(body.decision.outcome);if(body.record)r=body.record;
    if(event.op==='edit'&&body.decision.allowed)logicalRevision++;
    if(body.decision.preparedEffectIntent)prepared.add(body.decision.preparedEffectIntent.idempotencyKey);
   }
   const executionObservation=(await e.admin.query('SELECT count(*)::integer external_action_count FROM finnor_os.domain_actions WHERE tenant_id=$1',[tenant])).rows[0];
   assert.equal(executionObservation.external_action_count,0,'No canonical domain action, including a draft, was created by these command-only cases');
   const actual={...projection(r,names,logicalRevision),codes,prepared_count:prepared.size,executed_count:executionObservation.external_action_count,read_count:readbacks.length,readbacks,
    currentness:r.currentness,evidence:settings.source_status?.includes('UNKNOWN')?'UNKNOWN':settings.source_status?.includes('CONFLICTING')?'CONFLICTING':'KNOWN'} as any;
   const diagnostic=observations.find(x=>x.step==='reconcile')?.body?.decision?.evaluatedAssignments?.deltaMinor;
   if(diagnostic!==undefined)actual.delta_minor=diagnostic;
   if(item.expected.binding){
    const bound=observations.find(x=>x.body?.decision?.preparedEffectIntent)?.body.decision.preparedEffectIntent.binding;
    assert.equal(bound.tenantId,tenant);assert.equal(bound.scopeId,root.entityId);assert.deepEqual(bound.recordReference,r.reference);
    actual.binding={tenant:'pe-a',scope:'deal-1',record_ref:'P1/rec-1/1',release:names.get(bound.releaseId),currency:bound.values.quantity.currency,amount_minor:bound.values.quantity.amount,
     source_refs:[refs.get(bound.values.bookEvidence.versionId),refs.get(bound.values.bankEvidence.versionId)]};
   }
   if(item.expected.history){
    const history=ok(await api('analyst','history',{applicationId:app.id,recordId:r.id,limit:100}));
    const previous=history.events.find((x:any)=>x.kind==='BUSINESS_COMMAND'&&x.body.input.actionId==='edit')?.body.before;
    assert(previous,'Original edit preimage must be in canonical immutable history');actual.history=[projection(previous,names,1)];
    actual.history=actual.history.map((x:any)=>Object.fromEntries(Object.keys(item.expected.history[0]).map(key=>[key,x[key]])));
   }
   const compared=Object.fromEntries(Object.keys(item.expected).map(key=>[key,actual[key]]));
   assert.deepEqual(compared,item.expected);
   results.push({id:item.id,classification:item.id==='wrong-scope'||item.id==='wrong-tenant'?'OWNER_BOUNDARY_DENIAL':'INSTALLED_LITERAL_PROJECTION_MATCH',literalCaseInstalled:!['wrong-scope','wrong-tenant'].includes(item.id),
    expected:item.expected,actual,observations,executionObservation:{...executionObservation,scope:'ALL_CANONICAL_EXTERNAL_ACTIONS_IN_DISPOSABLE_TENANT'},canonicalRecordId:r.id,canonicalReference:r.reference});
  }finally{
   // Restore only this disposable fixture's authority configuration. Each actual
   // change still advances the real tenant authority revision.
   for(const saved of savedAssignments)await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=$2,resource_scope=$3::jsonb WHERE id=$1',[saved.id,saved.active,JSON.stringify(saved.resource_scope)]);
   await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[]))',[tenant,savedAssignments.map((s:any)=>s.id)]);
   await artifact(evidence,'independent-cases.json',{frozenCasesDigest:hash(await readFile(join(repo,'scope-x3/acceptance/cases.json'))),results});
  }
 }
 const second=await submit(exceptionRegister(tenant,root.entityId)),support=await source('second-application');
 const secondCommand=async(actionId:string,r:any,input:unknown={},who='analyst')=>api(who,'command',{applicationId:second.id,entityId:'control_exception',actionId,input,idempotencyKey:randomUUID(),...(r?{recordId:r.id,expectedRevision:r.revision,expectedReference:r.reference}:{})});
 const secondInput={memo:'Quarterly access review missing',remediation:'Independent reviewer confirms complete access inventory',support:support.ref};
 let secondRecord=ok(await secondCommand('create',null,secondInput)).record;
 const wrong=ok(await secondCommand('document',secondRecord,{},'partner'));assert.equal(wrong.decision.outcome,'ROLE_DENIED');
 const wrongState=ok(await secondCommand('close',secondRecord,{},'partner'));assert.equal(wrongState.decision.outcome,'INVALID_STATE');
 secondRecord=ok(await secondCommand('document',secondRecord)).record;assert.equal(secondRecord.state,'EVIDENCED');
 await closePool();await runWorker();const persisted=await record(second.id,secondRecord.id);assert.deepEqual(persisted.values,secondInput);assert.equal(persisted.state,'EVIDENCED');
 secondRecord=ok(await secondCommand('close',persisted,{},'partner')).record;assert.equal(secondRecord.state,'CLOSED');
 checks.push({id:'independent-second-application',applicationId:second.id,wrong,wrongState,persisted,closed:secondRecord,compilerEditsBetweenApplications:false});
 if(!limited)checks.push(...await installedChecks({e,tenant,root,main,api,command,record,runWorker,finish,maintenance,people,roles,evidence,second,secondCommand,secondInput,support,refreshSource}));
 if(!limited)checks.push(...await installedReviewChecks({e,tenant,root,main,api,people,evidence,finish,runWorker,support}));
  if(!limited)checks.push(...await completionAuthorityChecks({e,evidence,runWorker}));
 if(!limited||faultProbe)checks.push(...await installedFaultChecks({e,tenant,root,main,api,people,evidence,runWorker,finish,secondInput,support}));
 if(!limited)checks.push(await applicationS8Proof({e,tenant,root,main,second,api,people,evidence}));
 const final=ok(await api('analyst','read',{applicationId:main.id,limit:100}));
 checks.push({id:'final-common-envelope-after-lifecycle',...await checkInstalledEnvelope(e,final,tenant,evidence)});
 await artifact(evidence,'complete-common-envelope.json',{status:'PASS_INSTALLED_COMMON_ENVELOPE',checks:checks.filter(check=>check.id.includes('common-envelope')),package:final.package});
 const raw=(await e.admin.query('SELECT id,type,status,claim_fence,attempts,protocol_version FROM finnor_os.jobs WHERE tenant_id=$1 ORDER BY accepted_at',[tenant])).rows;
 const deliveries=(await e.admin.query('SELECT d.id,d.job_id,d.claim_fence,d.worker_id,d.outcome FROM finnor_os.job_delivery_attempts d JOIN finnor_os.jobs j ON j.id=d.job_id WHERE j.tenant_id=$1 ORDER BY d.started_at',[tenant])).rows;
 assert(raw.some(j=>j.type==='build_enterprise_application_v1'&&j.status==='completed'));assert(deliveries.every(d=>['completed','known_failed','capacity_deferred','lease_lost'].includes(d.outcome)));
 await artifact(evidence,'installed-summary.json',{status:'INSTALLED_DEVELOPMENT_CHECKS_PASS',verificationProfile:faultProbe?'SMOKE_PLUS_FAULTS':limited?'SMOKE':'COMPLETE',sourceRuntime:final.package.runtime,resources:final.counters,
  independentCases:results.map(x=>({id:x.id,classification:x.classification,literalCaseInstalled:x.literalCaseInstalled})),checks,physicalWorkers:processCount,jobs:raw,deliveries,
  qualification:'DEVELOPMENT_NOT_PROTECTED',protectedApplications:0,protectedMaintenanceEpisodes:0,productionActive:false,operational100x:'NOT_RUN',financial:'NOT_RUN',apiProcessReplaced:process.env.FINNOR_X3_BUILT_API==='1'});
 console.log('X3_INSTALLED_DEVELOPMENT_CHECKS_PASS');
}catch(error){
 await artifact(evidence,'failure.json',{error:String(error),stack:(error as Error).stack,results,checks});throw error;
}finally{await e.close();}
