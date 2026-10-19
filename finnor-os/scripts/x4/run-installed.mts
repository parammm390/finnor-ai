/** Preregistered physical development campaign. Setup creates only ordinary
 * identity/rights/business inputs. All X4 outcomes pass authenticated HTTP and
 * the actual durable JobQueue. Independent provider state is read afterwards. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {configureTenantVertical,closePool,receiveWork,transitionWork} from '@finnor/db';
import {createDeal,createWorkstream,createInvestmentCase,type PeMutationContext} from '@finnor/private-equity';
import {startEnvironment,artifact,repo,hash} from '../x3/environment.mts';
import {prepareBlackBox,type BlackBox,type BehaviorMode,type InstrumentFault} from './black-box.mts';
import {identificationS8Proof} from './s8-installed.mts';
const evidence=resolve(process.env.FINNOR_X4_EVIDENCE_DIR??join(repo,'scope-x4/evidence/installed-'+Date.now()));
await mkdir(evidence,{recursive:true});
process.env.FINNOR_X4_PROFILE='DISPOSABLE';
const privateDirectory=await mkdtemp(join(tmpdir(),'x4-host-bindings-'));
process.env.FINNOR_X4_BINDINGS=join(privateDirectory,'bindings.json');
const mode=(process.env.FINNOR_X4_CASE??'snapshot-request') as BehaviorMode;
assert(['snapshot-request','snapshot-start','page-truncate','role-filter','combined','affine','unrepresentable'].includes(mode));
const fault=(process.env.FINNOR_X4_INSTRUMENT_FAULT??'none') as InstrumentFault;
assert(['none','duplicate','missing','wrong-unit','stale','truncated','wrong-event'].includes(fault));
const phase=process.env.FINNOR_X4_PHASE??'full';
assert(['full','discovery','browser'].includes(phase));
const boundary=process.env.FINNOR_X4_BOUNDARY??'none';
assert(['none','cancel','revoke','deadline','observations','experiments','analysis','role','version','authority','work','work-cancel'].includes(boundary));
const recovery=process.env.FINNOR_X4_RECOVERY??'none';
assert(['none','crash','inflight-cancel','concurrent'].includes(recovery));
if(recovery==='crash')process.env.WORKER_JOB_LEASE_SECONDS='30';
const e=await startEnvironment(evidence,{builtApi:process.env.FINNOR_X4_BUILT_API==='1',commitClock:true,baseHead:'0190_x5_experience_policy.sql'});
const tenant=randomUUID(),people:Record<string,string>={},tokens:Record<string,string>={};
const boxes:BlackBox[]=[];
let frozenStates:Awaited<ReturnType<BlackBox['readAdminState']>>[]|undefined,s8:Awaited<ReturnType<typeof identificationS8Proof>>|undefined;
let worker:ChildProcess|null=null,workerReady:Promise<void>|null=null,workerOutput='',ticks=0;
const waiting=new Map<number,{yes:(value:any)=>void;no:(error:Error)=>void}>();
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const api=(who:string,operation:string,body:unknown)=>e.http!.api(tokens[who]!, 'company-brain','identification-'+operation,body);
async function startWorker(){
 if(!worker){
  worker=spawn(process.execPath,['--import=tsx','scripts/x4/worker-loop.mts'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe','ipc']});
  const physical=worker;
  workerReady=new Promise<void>((yes,no)=>{
   const timer=setTimeout(()=>{physical.kill('SIGKILL');no(Error('X4_WORKER_START_DEADLINE'));},10000);
   physical.once('message',(message:any)=>{clearTimeout(timer);message?.kind==='READY'?yes():no(Error('X4_WORKER_READY_REQUIRED'));});
   physical.once('error',error=>{clearTimeout(timer);no(error);});
   physical.once('exit',()=>{clearTimeout(timer);no(Error('X4_WORKER_START_FAILED'));});
  });
  for(const stream of [worker.stdout!,worker.stderr!])stream.on('data',b=>{workerOutput+=String(b);if(Buffer.byteLength(workerOutput)>262144)worker!.kill('SIGKILL');});
  worker.on('message',(value:any)=>{const w=waiting.get(value.id);if(w){waiting.delete(value.id);w.yes(value);}});
  worker.once('error',error=>{for(const w of waiting.values())w.no(error);waiting.clear();});
  worker.once('close',(code,signal)=>{for(const w of waiting.values())w.no(Error('X4_WORKER_EXIT:'+code+':'+signal));waiting.clear();});
 }
 await workerReady;
}
async function tick(){
 const n=++ticks;await startWorker();
 const result=await new Promise<any>((yes,no)=>{
  const timer=setTimeout(()=>{waiting.delete(n);worker!.kill('SIGKILL');no(Error('X4_ORIGINAL_WORKER_TICK_DEADLINE'));},45000);
  waiting.set(n,{yes:value=>{clearTimeout(timer);yes(value);},no:error=>{clearTimeout(timer);no(error);}});
  worker!.send({id:n,operation:'TICK'});
 });
 assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(workerOutput),'Credentials cannot enter worker evidence');
 await artifact(evidence,'workers/'+n+'.json',{...result,logs:workerOutput});return result;
}
async function dump(id?:string){
 const statements={
  identifications:'SELECT * FROM finnor_os.x4_identifications WHERE tenant_id=$1',
  events:'SELECT * FROM finnor_os.x4_events WHERE tenant_id=$1 ORDER BY id',
  experiments:'SELECT * FROM finnor_os.x4_experiments WHERE tenant_id=$1 ORDER BY created_at,id',
  charges:'SELECT * FROM finnor_os.s5_identification_charges WHERE tenant_id=$1 ORDER BY created_at,id',
  jobs:"SELECT id,type,status,payload,attempts,claim_fence,last_error FROM finnor_os.jobs WHERE tenant_id=$1 AND type='identify_digital_system_v1' ORDER BY id",
  effects:"SELECT b.* FROM finnor_os.business_effects b JOIN finnor_os.domain_actions d ON d.tenant_id=b.tenant_id AND d.id=b.domain_action_id WHERE b.tenant_id=$1 AND d.action_type='digital_identification_experiment'",
  models:'SELECT * FROM finnor_os.x4_models WHERE tenant_id=$1',
  uses:'SELECT * FROM finnor_os.x4_uses WHERE tenant_id=$1',
 };
 for(const [name,sql] of Object.entries(statements)){
  try{await artifact(evidence,'canonical/'+name+'.json',(await e.admin.query(sql,[tenant])).rows);}
  catch(error){await artifact(evidence,'canonical/'+name+'-read-failure.json',{error:String(error)});}
 }
 if(id)await artifact(evidence,'owner-read.json',await api('author','read',{identificationId:id}));
}
let identificationId:string|undefined;
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X4 disposable firm')",[tenant,randomUUID()]);
 for(const who of ['author','replicator','outsider']){
  const id=randomUUID(),email=id+'@x4.example.test';people[who]=id;
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active',$4)",[id,tenant,email,'Disposable '+who]);
  e.http!.register(id,email);tokens[who]=await e.http!.login(id);
 }
 const company=randomUUID();
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'x4-firm','X4 disposable firm','other')",[company,tenant]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:people.author!,sourceSystem:'X4:disposable-development'});
 const ctx:PeMutationContext={auth:{tenantId:tenant,userId:people.author!,employeeId:people.author!,role:'owner'}};
 const deal=await createDeal(ctx,{targetOrganizationId:company,name:'Independent incomplete export investigation',dealLeadEmployeeId:people.author!,
  signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)}),root={entityType:'pe_deal',entityId:String(deal.row.id)};
 const workstream=await createWorkstream(ctx,{dealId:root.entityId,kind:'technology',name:'Test-service export completeness',owner:{partyType:'employee',partyId:people.author!}}),
  investmentCase=await createInvestmentCase(ctx,{dealId:root.entityId,title:'Development export reconciliation, not financial completion'});
 await startWorker();
 const [source,replica]=await Promise.all([
  prepareBlackBox({mode,instrumentFault:fault,responseLossOnce:process.env.FINNOR_X4_RESPONSE_LOSS==='1',actualExposureMismatch:process.env.FINNOR_X4_EXPOSURE_MISMATCH==='1'}).then(b=>{boxes.push(b);return b;}),
  prepareBlackBox({mode:process.env.FINNOR_X4_REPLICA_FAILURE==='1'?'affine':mode}).then(b=>{boxes.push(b);return b;}),
 ]);
 const sourceTarget=randomUUID(),replicaTarget=randomUUID(),validUntil=new Date(Date.now()+3400000).toISOString();
 await writeFile(process.env.FINNOR_X4_BINDINGS,JSON.stringify({schema:'finnor.x4.disposable-bindings.v1',targets:[
  {id:sourceTarget,tenantId:tenant,rootId:root.entityId,principalIds:[people.author],...source.runtime,validUntil},
  {id:replicaTarget,tenantId:tenant,rootId:root.entityId,principalIds:[people.replicator],...replica.runtime,validUntil},
 ]}),{mode:0o600});
 const domain={
  schema:'finnor.x4.digital-domain.v1',profile:'PE_FIRM_DIGITAL_RELATION_V1',applicationVersion:source.runtime.applicationVersion,role:'analyst',
  records:[{value:'3',update:'PREEXISTING',visibility:'PUBLIC',features:{}},{value:'11',update:'CONTROLLED',visibility:'CONTROLLED',features:{}},
   {value:'-2',update:'PREEXISTING',visibility:'PUBLIC',features:{}},{value:'7',update:'PREEXISTING',visibility:'PUBLIC',features:{}}],
  interventions:{updateTiming:[-1,1,3],pageSize:[1,2,4],visibility:[0,1]},ordinary:{updateTiming:1,pageSize:1,visibility:0},withheld:{updateTiming:3,pageSize:4,visibility:1},costUnits:1,
  assumptions:{deterministic:true,isolatedFreshRecords:true,noInterference:true,completePermittedObservations:true,sameHostClock:true,replicaVersionInvariant:true},
 };
 const consentInput={schema:'finnor.x4.experiment-rights.v1',root,domain,targetIds:[sourceTarget,replicaTarget],actorIds:[people.author,people.replicator],
  purposes:['EXPERIMENT','OBSERVE','REPLICATE','DERIVE_FINDING','USE_IN_DECISION'],retention:'RETAIN_AUDIT_REVOKE_FUTURE_USE_NO_EFFECT_ROLLBACK',validUntil,idempotencyKey:randomUUID()};
 const consent=ok(await api('author','consent',consentInput));
 const request={schema:'finnor.x4.identification-request.v1',root,consentId:consent.consentId,sourceTargetId:sourceTarget,replicationTargetId:replicaTarget,
  question:{text:'Why does the permitted test-service export omit records, and which controlled export is complete?',target:'Role-bound disposable export service',
   affectedDecision:'Wait for a current complete checked export before test reconciliation.',requestedClaimClass:process.env.FINNOR_X4_CLAIM??'INTERVENTION_IDENTIFIED'},
  decision:{workstreamId:workstream.row.id,investmentCaseId:investmentCase.row.id},domain,
  limits:{deadlineMs:boundary==='deadline'?1000:3600000,maxExperiments:boundary==='experiments'?1:32,maxObservationCalls:boundary==='observations'?16:256,maxAnalysisJobs:boundary==='analysis'?1:64,maxUses:4},
  mode:process.env.FINNOR_X4_PASSIVE==='1'?'OBSERVATION_ONLY':'ACTIVE',idempotencyKey:randomUUID()};
 const accepted=ok(await api('author','submit',request),202);identificationId=accepted.identificationId;
 assert(identificationId);
 const duplicate=ok(await api('author','submit',request),202);assert.equal(duplicate.identificationId,identificationId);assert.equal(duplicate.replayed,true);
 await artifact(evidence,'inputs.json',{mode,fault,phase,boundary,recovery,root,tenant,people,domain,consentInput,consent,request,accepted,duplicate,
  sourceFingerprint:{targetId:sourceTarget,instanceId:source.runtime.instanceId,role:source.runtime.role,applicationVersion:source.runtime.applicationVersion},
  replicaFingerprint:{targetId:replicaTarget,instanceId:replica.runtime.instanceId,role:replica.runtime.role,applicationVersion:replica.runtime.applicationVersion},
  candidateReceivedPrivateMechanism:false,candidateReceivedCredential:false,transport:process.env.FINNOR_X4_BUILT_API==='1'?'ACTUAL_BUILT_NEXT_API':'SOURCE_ROUTE_OVER_HTTP'});
 if(boundary==='cancel')ok(await api('author','cancel',{identificationId,reason:'Registered before-wire cancellation negative',idempotencyKey:randomUUID()}));
 if(boundary==='revoke')ok(await api('author','revoke-consent',{consentId:consent.consentId,reason:'Registered before-wire rights negative',idempotencyKey:randomUUID()}));
 if(boundary==='deadline')await new Promise(yes=>setTimeout(yes,1100));
 if(boundary==='authority')await e.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenant,people.author]);
 if(boundary==='work')await receiveWork({tenantId:tenant,userId:people.author!,workId:accepted.workId,channel:'console',instruction:'The canonical current Work input changed before any experiment could be authorized.',idempotencyKey:randomUUID()});
 if(boundary==='work-cancel')await transitionWork(tenant,accepted.workId,'cancelled','x4_development_ordinary_owner_cancel',{reason:'Canonical Work cancelled without a new input'});
 if(boundary==='role'||boundary==='version'){
  const config=JSON.parse(await readFile(process.env.FINNOR_X4_BINDINGS,'utf8'));
  if(boundary==='role')config.targets[0].role='auditor';else config.targets[0].applicationVersion='x4-obsolete-negative';
  await writeFile(process.env.FINNOR_X4_BINDINGS,JSON.stringify(config),{mode:0o600});
 }
 await Promise.all([source.start(),replica.start()]);
 if(recovery==='none')await tick();
 else await (await import('./recovery-proofs.mts')).identificationRecoveryProof({
  e,evidence,tenant,people,identificationId,source,api,tick,startWorker,workerPid:()=>(worker as ChildProcess|null)?.pid,
  killWorker:async()=>{
   const current=worker as ChildProcess|null;assert(current);
   const stopped=new Promise<void>(yes=>current.once('close',()=>yes()));current.kill('SIGKILL');await stopped;worker=null;workerReady=null;
  },
 });
 const ownerRead=await api('author','read',{identificationId});
 let view=boundary==='authority'?(assert([403,404].includes(ownerRead.status)),{status:'AUTHORITY_UNAVAILABLE',model:null}):ok(ownerRead);
 const failureEvents=(await e.admin.query("SELECT kind,body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND kind IN('OPERATION_FAILED','INSTRUMENT_MEASURED','REPRESENTATION_REFUTED','RIGHTS_REVOKED') ORDER BY id",[tenant,identificationId])).rows;
 await artifact(evidence,'expected-boundary.json',{boundary,ownerReadStatus:ownerRead.status,failureEvents});
 await artifact(evidence,'discovery.json',view);
 if(recovery==='crash'||recovery==='inflight-cancel'){
  assert.equal(view.model,null);assert.equal(view.status,recovery==='crash'?'WAITING':'CANCELLED');assert.equal((await source.readAdminState()).postCount,1);
 }else if(boundary!=='none'){
  assert.equal(view.model,null);assert.equal((await source.readAdminState()).postCount,boundary==='experiments'?1:0);
  if(boundary==='cancel')assert.equal(view.status,'CANCELLED');
  else if(boundary==='revoke'){
   assert.equal(view.status,'INVALIDATED');assert(failureEvents.some(v=>v.kind==='RIGHTS_REVOKED'&&v.body.futureModelUse===false));
   assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.x4_consent_revocations WHERE tenant_id=$1 AND consent_id=$2',[tenant,consent.consentId])).rows[0].n,1);
  }
  else if(boundary==='authority'){
   const jobs=(await e.admin.query("SELECT last_error FROM finnor_os.jobs WHERE tenant_id=$1 AND type='identify_digital_system_v1'",[tenant])).rows;
   assert(jobs.some(j=>j.last_error?.includes('CURRENT_CANONICAL_AUTHORITY_UNAVAILABLE')));
  }else{
   const errors:Record<string,string>={revoke:'X4_EXPERIMENT_RIGHTS_REVOKED_OR_EXPIRED',deadline:'X4_ORIGINAL_DEADLINE_EXPIRED',observations:'X4_ORIGINAL_OBSERVATION_ALLOCATION_EXHAUSTED',
    experiments:'X4_ORIGINAL_EXPERIMENT_ALLOCATION_EXHAUSTED',analysis:'X4_ORIGINAL_ANALYSIS_ALLOCATION_EXHAUSTED',role:'X4_APPLICATION_ROLE_VERSION_OR_CREDENTIAL_CHANGED',version:'X4_APPLICATION_ROLE_VERSION_OR_CREDENTIAL_CHANGED',work:'X4_WORK_INPUT_CHANGED','work-cancel':'X4_CANONICAL_WORK_NOT_EXECUTABLE'};
   const expected=errors[boundary];
   assert(failureEvents.some(v=>v.kind==='OPERATION_FAILED'&&v.body.error===expected),JSON.stringify(failureEvents));
  }
 }else if(fault==='wrong-event'){
  assert.equal(view.model,null);assert.equal((await source.readAdminState()).postCount,0);
  assert.equal(view.instruments.length,1);assert.equal(view.instruments[0].body.disposition,'VALIDATED_DEVELOPMENT');
  assert(failureEvents.some(v=>v.kind==='OPERATION_FAILED'&&v.body.error==='X4_INDEPENDENT_CHECK_KNOWN_CONTROL_TIMING'));
  const before=(await e.admin.query('SELECT experiment_count,observation_count,analysis_count,deadline_at FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0];
  const retried=await api('author','retry',{identificationId,reason:'Retry must recheck the retained producer-only certificate, never treat it as independently validated',idempotencyKey:randomUUID()});
  ok(retried,202);await tick();
  const after=(await e.admin.query('SELECT experiment_count,observation_count,analysis_count,deadline_at FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0];
  assert.equal(after.experiment_count,0);assert.equal(after.observation_count,before.observation_count);assert.equal(after.analysis_count,before.analysis_count+1);assert.deepEqual(after.deadline_at,before.deadline_at);
  const validations=(await e.admin.query("SELECT id,body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND kind='INSTRUMENT_INDEPENDENTLY_VALIDATED'",[tenant,identificationId])).rows;
  assert.equal(validations.length,0);assert.equal((await source.readAdminState()).postCount,0);
  assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.x4_instruments WHERE tenant_id=$1 AND identification_id=$2',[tenant,identificationId])).rows[0].n,1);
  await artifact(evidence,'retained-instrument-recheck.json',{allPassed:true,before,after,retried,validations,originalCertificateRetained:true,newControlReads:0,unknownPhysicalExperiments:0,independentCheckerRequiredAgain:true});
 }else if(fault!=='none'){
  assert.equal(view.model,null);assert.equal((await source.readAdminState()).postCount,0);
  const measured=failureEvents.find(v=>v.kind==='INSTRUMENT_MEASURED');
  assert(measured?.body.errors.length>0,'An unrelated failed run is not instrument detection');
  assert(view.instruments.some((v:any)=>v.body.disposition==='INVALID'));
  assert(failureEvents.some(v=>v.kind==='OPERATION_FAILED'&&v.body.error==='X4_INDEPENDENT_CHECK_CERTIFICATE_BINDING'));
 }else if(process.env.FINNOR_X4_EXPOSURE_MISMATCH==='1'){
  assert.equal(view.model,null);assert(failureEvents.some(v=>v.kind==='OPERATION_FAILED'&&v.body.error==='X4_ACTUAL_DELIVERY_UNRESOLVED_OR_DIVERGENT'));
 }else if(request.mode==='OBSERVATION_ONLY'){assert.equal(view.status,'OBSERVATION_ONLY_PARTIAL');assert.equal(view.model,null);}
 else if(mode==='unrepresentable'){assert.equal(view.status,'UNRESOLVED');assert.equal(view.model,null);}
 else{
  assert.equal(view.status,'AWAITING_REPLICATION',JSON.stringify({id:identificationId,status:view.status,reason:view.currentnessReason}));assert.equal(view.model,null);
  const self=await api('author','replicate',{identificationId,expectedModelId:null,idempotencyKey:randomUUID()});assert.equal(self.status,403);
  if(phase!=='discovery'){
   const assigned=ok(await api('replicator','replicate',{identificationId,expectedModelId:null,idempotencyKey:randomUUID()}),202);
   await tick();view=ok(await api('author','read',{identificationId}));
   await artifact(evidence,'replication.json',{assigned,view});
   if(process.env.FINNOR_X4_REPLICA_FAILURE==='1'){assert.equal(view.model,null);assert.equal(view.status,'INVALIDATED');}
   else{
    assert.equal(view.status,'DEVELOPMENT_READY',JSON.stringify({id:identificationId,status:view.status,reason:view.currentnessReason}));assert(view.current);assert(view.model);
    assert.equal(view.model.equivalence.uniqueHiddenMechanism,false);assert.equal(view.model.productionActive,false);assert.equal(view.model.protectedAdmission,false);
    if(process.env.FINNOR_X4_REPEAT_REPLICA==='1'){
     const prior=view.model,before=(await e.admin.query('SELECT body,body_digest FROM finnor_os.x4_models WHERE tenant_id=$1 AND id=$2',[tenant,prior.id])).rows[0];
     const assignedAgain=ok(await api('replicator','replicate',{identificationId,expectedModelId:prior.id,idempotencyKey:randomUUID()}),202);
     await tick();view=ok(await api('author','read',{identificationId}));
     await artifact(evidence,'repeat-replication.json',{priorModelId:prior.id,assignedAgain,view});
     assert.equal(view.status,'DEVELOPMENT_READY');assert(view.current&&view.model);assert.notEqual(view.model.id,prior.id);
     assert.notEqual(view.model.canonicalFindingRef.id,prior.canonicalFindingRef.id);assert.notEqual(view.model.checkDigest,prior.checkDigest);
     assert.deepEqual((await e.admin.query('SELECT body,body_digest FROM finnor_os.x4_models WHERE tenant_id=$1 AND id=$2',[tenant,prior.id])).rows[0],before);
     assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.x4_models WHERE tenant_id=$1 AND identification_id=$2',[tenant,identificationId])).rows[0].n,2);
    }
    if(process.env.FINNOR_X4_DECISION_AFTER_EXPIRY==='1'){
     assert.equal(view.model.requestedClaimSatisfied,true,'The expiry probe must first have a supported checked claim, not refuse before transport');
     await new Promise(yes=>setTimeout(yes,31000));
    }
    const used=ok(await api('author','use',{identificationId,modelId:view.model.id,idempotencyKey:randomUUID()}),202);
    await tick();view=ok(await api('author','read',{identificationId}));
    const use=view.uses.find((u:any)=>u.id===used.useId);
    assert(use);assert(['COMPLETE','WAIT'].includes(use.status),JSON.stringify(use));
    assert(use.decision_id,'A real canonical decision must consume or refuse the model');
    const canonical=(await e.admin.query('SELECT * FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND id=$2',[tenant,use.decision_id])).rows[0];
    assert(canonical);assert.equal(use.result.completionGranted,false);
    if(process.env.FINNOR_X4_DECISION_AFTER_EXPIRY==='1'){
     assert.equal(use.status,'WAIT');assert.equal(use.result.choice,'WAIT_NO_COMPLETION');assert.equal(use.result.reason,'X4_TRANSPORT_UNAVAILABLE');
     assert.equal(use.result.physicalObservation,'UNRESOLVED_NO_COMPLETION');assert(use.experiment_id);
    }
    await artifact(evidence,'decision.json',{used,use,canonical,view});
    // A real owner invalidation must change the subsequent canonical decision,
    // without another external mutation or a new allocation.
    frozenStates=await Promise.all([source,replica].map(box=>box.readAdminState()));
    await Promise.all(boxes.map(box=>box.close()));
    const before=(await e.admin.query("SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1",[tenant])).rows[0].n;
    if(process.env.FINNOR_X4_DATABASE_PROOFS==='1')await (await import('./database-proofs.mts')).identificationDatabaseProofs({e,evidence,tenant,identificationId});
    if(process.env.FINNOR_X4_SECURITY_PROOFS==='1')await (await import('./security-proofs.mts')).identificationSecurityProofs({e,evidence,tenant,people,root,identificationId,view,request,api});
    if(process.env.FINNOR_X4_S8==='1')s8=await identificationS8Proof({e,evidence,tenant,people,identificationId,model:view.model,api});
    if(phase==='browser')await (await import('./mounted-fixture.mts')).identificationMountedFixture({e,evidence,tenant,people,root,identificationId,view,consent,request});
    if(process.env.FINNOR_X4_CANONICAL_WORK_CANCEL==='1'){
     await transitionWork(tenant,accepted.workId,'cancelled','x4_development_ordinary_owner_cancel',{reason:'Canonical Work cancellation must fence a previously checked model'});
     const cancelledRead=ok(await api('author','read',{identificationId}));assert.equal(cancelledRead.current,false);assert.equal(cancelledRead.currentnessReason,'X4_CANONICAL_WORK_NOT_EXECUTABLE');
     const denied=ok(await api('author','use',{identificationId,modelId:view.model.id,idempotencyKey:randomUUID()}),202);assert.equal(denied.choice,'WAIT_NO_COMPLETION');assert.equal(denied.externalOperationCreated,false);
     await artifact(evidence,'canonical-work-cancellation.json',{cancelledRead,denied,ordinaryNativeOwnerTransition:true,scientificTerminalRowsInjected:0});
    }
    const invalidated=ok(await api('author','invalidate',{identificationId,changed:['observations'],reason:'Registered negative: observation dependency changed',idempotencyKey:randomUUID()}));
    const wait=ok(await api('author','use',{identificationId,modelId:view.model.id,idempotencyKey:randomUUID()}),202);
    assert.equal(wait.choice,'WAIT_NO_COMPLETION');assert(wait.decisionId);assert.equal(wait.externalOperationCreated,false);
    const after=(await e.admin.query("SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1",[tenant])).rows[0].n;
    assert.equal(after,before);await s8?.afterNativeInvalidation();
    await artifact(evidence,'changed-validity-wait.json',{invalidated,wait,beforeExternalOperations:before,afterExternalOperations:after,providerJournalsFrozenAfterActualCompletedExperiments:true});
   }
  }
 }
 const states=frozenStates??await Promise.all([source,replica].map(box=>box.readAdminState()));
 await artifact(evidence,'independent-provider-journals.json',states);
 const posted=states.flatMap(s=>s.operations),registered=(await e.admin.query('SELECT protocol,created_at FROM finnor_os.x4_experiments WHERE tenant_id=$1 ORDER BY created_at,id',[tenant])).rows;
 for(const op of posted){
  const experiment=registered.find(r=>r.protocol.trial.id===op.requested.id);assert(experiment,'No unregistered physical experiment is allowed');
  assert(experiment.created_at.getTime()<=Date.parse(op.readback.requestedAt));assert.deepEqual(experiment.protocol.trial,op.requested);
  const expectedMode=op.requested.instanceId===source.runtime.instanceId?mode:process.env.FINNOR_X4_REPLICA_FAILURE==='1'?'affine':mode;
  const expected=op.readback.delivered.records.filter(r=>
   (!['snapshot-request','combined'].includes(expectedMode)||r.features.updatedSlot!<0)
   &&(expectedMode!=='snapshot-start'||r.features.updatedSlot!<2)
   &&(expectedMode!=='page-truncate'||r.features.position!<=r.features.pageWindow!)
   &&(!['role-filter','combined'].includes(expectedMode)||r.features.roleVisible===1)
  ).map(r=>({id:r.id,value:(expectedMode==='affine'?2n*BigInt(r.value)+1n:expectedMode==='unrepresentable'?BigInt(r.value)**2n:BigInt(r.value)).toString()}));
  assert.deepEqual(op.output,expected,'Independent private-mechanism outcome differs from the delivered finite trial');
 }
 assert.equal(new Set(posted.map(op=>op.requested.id)).size,posted.length);
 assert(states.every(s=>s.postCount===s.acceptedCount&&s.acceptedCount===s.operations.length),'No blind duplicate mutation is allowed');
 const allocation=(await e.admin.query('SELECT experiment_count,observation_count,analysis_count,use_count FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0];
 const charges=(await e.admin.query('SELECT kind,count(*)::int n,sum(amount)::int amount FROM finnor_os.s5_identification_charges WHERE tenant_id=$1 AND identification_id=$2 GROUP BY kind',[tenant,identificationId])).rows;
 for(const [kind,column] of Object.entries({EXPERIMENT:'experiment_count',OBSERVATION:'observation_count',ANALYSIS:'analysis_count',USE:'use_count'})){
  const charge=charges.find(c=>c.kind===kind);assert.equal(allocation[column],charge?.amount??0);assert.equal(charge?.n??0,charge?.amount??0);
 }
 const canonicalBytes=Number((await e.admin.query(`SELECT sum(octet_length(r.body::text))::bigint bytes FROM (
  SELECT to_jsonb(s) body FROM finnor_os.evidence_sources s WHERE s.tenant_id=$1 AND s.metadata->>'identificationId'=$2
  UNION ALL SELECT to_jsonb(v) FROM finnor_os.evidence_source_versions v JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id WHERE v.tenant_id=$1 AND s.metadata->>'identificationId'=$2
  UNION ALL SELECT to_jsonb(k) FROM finnor_os.evidence_chunks k JOIN finnor_os.evidence_sources s ON s.tenant_id=k.tenant_id AND s.id=k.source_id WHERE k.tenant_id=$1 AND s.metadata->>'identificationId'=$2
 ) r`,[tenant,identificationId])).rows[0].bytes??0);
 const canonicalCharged=charges.find(c=>c.kind==='RETAINED_BYTES')?.amount??0;
 assert(canonicalCharged>=canonicalBytes);
 await artifact(evidence,'original-allocation-proof.json',{allocation,charges,canonicalBytes,canonicalCharged,counterProjectionMatchesAppendOnlyOriginalParentCharges:true,
  storageUnit:'LOGICAL_SCIENTIFIC_OWNER_AND_CANONICAL_EVIDENCE_ROWS_INCLUDING_CHUNKS_NOT_TOTAL_PHYSICAL_DISK_OR_FINANCIAL_COST'});
 await dump(identificationId);
 await artifact(evidence,'receipt.json',{schema:'finnor.x4.installed-campaign.v1',allPassed:true,mode,fault,phase,boundary,recovery,identificationId,
  providerPids:states.map(s=>s.pid),workerPid:(worker as ChildProcess|null)?.pid,physicalExperiments:posted.length,qualification:'DEVELOPMENT_ONLY_BUILDER_CONTROLLED_NOT_ORIGINAL_POPULATION',
  sourceCutDigest:hash(await readFile(join(repo,'finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts'))),
  money:{kind:'UNKNOWN',reason:'No complete independently metered money or human-work denominator.'}});
 console.log('X4_DEVELOPMENT_CAMPAIGN_PASS',mode,fault,phase,boundary);
}catch(error){
 if(!/postgres(?:ql)?:\/\/|Bearer /i.test(workerOutput))await artifact(evidence,'worker-failure.json',{logs:workerOutput,pid:(worker as ChildProcess|null)?.pid??null});
 await dump(identificationId).catch(()=>undefined);
 await artifact(evidence,'failure.json',{error:String(error),stack:(error as Error).stack,mode,fault,phase});
 throw error;
}finally{
 const physical=worker as ChildProcess|null;
 if(physical&&physical.exitCode===null&&physical.signalCode===null){
  const closed=new Promise<void>(yes=>physical.once('close',()=>yes()));physical.kill('SIGTERM');await closed;
 }
 await s8?.close();await Promise.allSettled(boxes.map(b=>b.close()));await closePool();await e.close();
}
