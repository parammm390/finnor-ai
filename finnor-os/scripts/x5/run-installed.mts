/** Preregistered installed development driver. No fake success rows, labels,
 * terminal records or handler calls. See scope-x5/acceptance before running. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {configureTenantVertical,closePool,withTenantClientTransaction} from '@finnor/db';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {startEnvironment,artifact,repo,hash,recordPriorReleaseProbeRefusal} from '../x3/environment.mts';
import {reconciliation,quantity} from '../x3/business-fixtures.mts';
import {training,transfer,retention,modes,rename,transferSpecification,poisonSpecification} from './business-fixtures.mts';
import {preparePendingReplicas} from './pending-fixture.mts';
import {learningS8Proof} from './s8-installed.mts';
import {learningBoundaryProbes} from './boundary-probes.mts';
const evidence=resolve(process.env.FINNOR_X5_EVIDENCE_DIR??join(repo,'scope-x5/evidence/installed-'+Date.now()));
await mkdir(evidence,{recursive:true});
const phase=process.env.FINNOR_X5_PHASE??'full',smoke=phase==='smoke',full=phase==='full',pendingOnly=phase==='pending';
assert(['full','smoke','pending','probes','review-probes','faults','resources','browser','caller-expiry'].includes(phase),'REGISTERED_PHASE_REQUIRED');
const nativeFactory=process.env.FINNOR_X_PHASE_NATIVE_WORKER==='1';
if(nativeFactory)assert(full,'NATIVE_FACTORY_PROOF_REQUIRES_UNCHANGED_FULL_PROFILE');
if(full||pendingOnly)for(const name of ['FINNOR_S3_PYTHON','FINNOR_S4_PYTHON'])assert(process.env[name]?.startsWith('/'),name+'_ABSOLUTE_PIN_REQUIRED_BEFORE_CAMPAIGN');
const observations:any[]=[],armResults:any[]=[],useIds:string[]=[],retainedUseIds:string[]=[];
const privateArtifacts=await mkdtemp(join(tmpdir(),'finnor-x5-owners-'));
process.env.FINNOR_S3_MODEL_STORE=join(privateArtifacts,'models');process.env.FINNOR_S4_POLICY_STORE=join(privateArtifacts,'policies');
const e=await startEnvironment(evidence,{builtApi:process.env.FINNOR_X5_BUILT_API==='1',commitClock:true,baseHead:'0189_x3_enterprise_applications.sql'});
const tenant=randomUUID(),root={entityType:'external_organization',entityId:randomUUID()},people:Record<string,string>={},tokens:Record<string,string>={},roles:Record<string,string>={};
const sourceRefs:Record<string,any>={};
let workers=0,workerRestarts=0,compilation:any,main:any,b1:any,b2:any,physicalWorker:ChildProcess|null=null,physicalLogs='',workerFailure:Error|null=null;
let s8:Awaited<ReturnType<typeof learningS8Proof>>|undefined;
const ticks=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const api=(who:string,op:string,body:unknown)=>e.http!.api(tokens[who]!, 'company-brain',op,body);
const native=(who:string,op:string,body:unknown)=>api(who,'application-'+op,body);
const learn=(who:string,op:string,body:unknown)=>api(who,'learning-'+op,body);
async function worker(){
 const at=performance.now(),n=++workers;
 if(!physicalWorker){
  physicalWorker=spawn(process.execPath,['--import=tsx','scripts/x5/worker-loop.mts'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe','ipc']});
  for(const stream of [physicalWorker.stdout!,physicalWorker.stderr!])stream.on('data',b=>{physicalLogs+=String(b);if(Buffer.byteLength(physicalLogs)>262144)physicalWorker!.kill('SIGKILL');});
  physicalWorker.on('message',(value:any)=>{const waiting=ticks.get(value.id);if(waiting){ticks.delete(value.id);waiting.resolve(value);}});
  physicalWorker.once('error',error=>{workerFailure=error;for(const tick of ticks.values())tick.reject(error);ticks.clear();});
  physicalWorker.once('close',(code,signal)=>{workerFailure=Error('PHYSICAL_WORKER_EXIT:'+code+':'+signal);for(const tick of ticks.values())tick.reject(workerFailure);ticks.clear();});
 }
 if(workerFailure)throw workerFailure;
 const out=await new Promise<any>((yes,no)=>{
  const timer=setTimeout(()=>{ticks.delete(n);physicalWorker!.kill('SIGKILL');no(Error('ORIGINAL_WORKER_TICK_DEADLINE'));},45000);
  ticks.set(n,{resolve:value=>{clearTimeout(timer);yes({...value,code:0,signal:null,pid:physicalWorker!.pid,logs:physicalLogs});},reject:error=>{clearTimeout(timer);no(error);}});
  physicalWorker!.send({operation:'TICK',id:n});
 });
 assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(out.logs),'Credentials cannot enter worker evidence');
 await artifact(evidence,'workers/'+n+'.json',{...out,wallMs:performance.now()-at,ordinaryPhysicalWorker:true,persistentOrdinaryClaimLoop:true});
 if(nativeFactory){assert.equal(out.productionWorkerFactory,true);assert.equal(out.effectiveLeaseSeconds,300);assert.equal(out.workloadClass,null);}
 assert.equal(out.code,0,JSON.stringify(out));return out;
}
async function restartWorker(){
 const old=physicalWorker;
 if(old&&old.exitCode===null&&old.signalCode===null){
  const closed=new Promise<void>(yes=>old.once('close',()=>yes()));old.kill('SIGKILL');await closed;
 }
 assert.equal(ticks.size,0,'No unfinished ordinary tick may cross a worker restart');
 assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(physicalLogs),'Credentials cannot enter worker evidence');
 const stopped={pid:old?.pid??null,exitCode:old?.exitCode??null,signal:old?.signalCode??null,logs:physicalLogs,
  onlyTaskOwnedWorkerStopped:true,originalDatabaseAllocationsUnchanged:true};
 await artifact(evidence,'worker-restarts/'+(++workerRestarts)+'.json',stopped);
 physicalWorker=null;physicalLogs='';workerFailure=null;return stopped;
}
async function install(specification:any){
 const accepted=ok(await native('analyst','submit',{schema:'finnor.x3.application-request.v1',root,specification,idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxBuilds:16,maxMutations:10000}}),202);
 let view:any;
 for(let i=0;i<8;i++){await worker();view=ok(await native('analyst','read',{applicationId:accepted.applicationId}));if(view.status==='INSTALLED')break;if(view.status==='FAILED')throw Error('NATIVE_INSTALL_FAILED:'+JSON.stringify(view.builds));}
 assert.equal(view.status,'INSTALLED');return {id:accepted.applicationId,workId:accepted.workId,releaseId:view.headReleaseId,specification};
}
async function source(label:string){
 const semantic=label.replace(/:(COMPILED_ORIGINAL|COMPILED_TRAINED|NATIVE_EXACT|COMPILED_NO_NEURAL)/g,'');
 const s=await createEvidenceSource(tenant,{sourceKey:'x5:'+label+':'+randomUUID(),sourceType:'manual',title:'Declared disposable '+label});
 const v=await appendEvidenceVersion(tenant,s.id,{content:'Literal development observation '+semantic,snapshot:{qualification:'PUBLIC_GENERATED_BUSINESS_INPUT_NOT_PROTECTED'},asOf:new Date('2026-03-07T00:00:00Z')});
 const h=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[v.versionId])).rows[0].content_hash;
 return {kind:'EVIDENCE',sourceId:s.id,versionId:v.versionId,contentDigest:h};
}
async function advance(ref:any,label:string){
 const semantic=label.replace(/:(COMPILED_ORIGINAL|COMPILED_TRAINED|NATIVE_EXACT|COMPILED_NO_NEURAL)/g,'');
 const v=await appendEvidenceVersion(tenant,ref.sourceId,{content:'Explicit later observation '+semantic,snapshot:{qualification:'PUBLIC_GENERATED_BUSINESS_INPUT'},asOf:new Date('2026-03-07T00:00:00Z')});
 const h=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[v.versionId])).rows[0].content_hash;
 return {...ref,versionId:v.versionId,contentDigest:h};
}
async function values(label:string,currency:string,lines:readonly string[],bank:string,isTransfer=false,unknown=false,extra:Record<string,unknown>={}):Promise<any>{
 const bookRef=await source(label+'-book'),bankRef=await source(label+'-export'),custody= isTransfer?await source(label+'-custody'):null;
 sourceRefs[label]={bookRef,bankRef,custody};
 const q=(s:string)=>({...quantity(s,currency,root.entityId),time:{kind:'AS_OF',asOf:'2026-03-07T00:00:00.000Z'}});
 const semantic=label.replace(/:(COMPILED_ORIGINAL|COMPILED_TRAINED|NATIVE_EXACT|COMPILED_NO_NEURAL)/g,'');
 const v={memo:'Private development memo '+semantic,book:{kind:'QUANTITY_LIST',entries:lines.map(q)},bank:unknown?{kind:'UNKNOWN',reason:'Export not yet observed'}:{kind:'QUANTITY_LIST',entries:[q(bank)]},
  bookStatus:'KNOWN',bankStatus:unknown?'UNKNOWN':'KNOWN',bookEvidence:bookRef,bankEvidence:bankRef,operation:'LOCAL_PREPARE',channel:'LOCAL'};
 return {...(isTransfer?rename(v):v),...(isTransfer?{feedCertified:true,custodyEvidence:custody}:{}),...extra};
}
async function command(app:any,action:string,record:any,input:any={},who='analyst',extra:Record<string,unknown>={}){
 const t=app.id!==main?.id&&app.specification.id!=='x5-poison-native-spec',actionId=t?rename(action):action;
 return native(who,'command',{applicationId:app.id,entityId:t?'settlementLot':'reconciliation',actionId,input,idempotencyKey:randomUUID(),...(record?{recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference}:{}),...extra});
}
async function record(app:any,id:string,who='analyst'){return ok(await native(who,'record',{applicationId:app.id,recordId:id}));}
async function rights(app:any,key=randomUUID()){
 const knowledgeCut=new Date().toISOString();
 const result=ok(await learn('analyst','consent',{schema:'finnor.x5.training-rights.v1',applicationId:app.id,purposes:['TRAIN_STRUCTURAL_CONTROLLER','EXECUTE_DERIVED_POLICY'],
  transfer:'SAME_TENANT_COMPATIBLE_APPLICATIONS',failures:'NONPOSITIVE_STRUCTURAL_OBSERVATIONS_ONLY',data:'STRUCTURAL_BOOLEANS_ONLY_NO_TEXT_AMOUNTS_IDENTIFIERS_CREDENTIALS',
  retention:'RETAIN_AUDIT_REVOKE_DERIVED_USE_NO_UNLEARNING_CLAIM',knowledgeCut,validUntil:new Date(Date.now()+3400000).toISOString(),idempotencyKey:key}));
 return {...result,knowledgeCut};
}
async function membership(who:string,role:string,active:boolean){
 await e.admin.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,active) VALUES($1,$2,$3,$4::jsonb,$5)
  ON CONFLICT(employee_id,role_id) DO UPDATE SET active=EXCLUDED.active`,[tenant,people[who],roles[role],JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]}),active]);
}
async function accept(app:any,r:any,count:number,isTransfer=false){
 const a=ok(await command(app,'approve',r,{},isTransfer?'finance':'partner'));assert(a.decision.allowed,JSON.stringify(a));r=a.record;
 if(count===2){assert.equal(r.state,isTransfer?'TIED_OUT':'RECONCILED');const b=ok(await command(app,'approve',r,{},isTransfer?'risk':'compliance'));assert(b.decision.allowed,JSON.stringify(b));r=b.record;}
 assert.equal(r.state,isTransfer?'ATTESTED':'APPROVED');assert.equal(r.approvals.length,count);return r;
}
async function invoke(app:any,r:any,mode:string,stratum:string,assignmentRef?:any,who='analyst',key=randomUUID()){
 const body={compilationId:compilation.compilationId,releaseId:compilation.headReleaseId,applicationId:app.id,recordId:r.id,expectedRevision:r.revision,expectedReference:r.reference,mode,stratum,idempotencyKey:key,...(assignmentRef?{assignmentRef}:{})};
 const accepted=ok(await learn(who,'execute',body),202);(stratum==='RETENTION'?retainedUseIds:useIds).push(accepted.useId);
 await worker();
 const row=(await e.admin.query('SELECT id,status,result,checkpoint_digest,policy_digest,created_at FROM finnor_os.x5_uses WHERE tenant_id=$1 AND id=$2',[tenant,accepted.useId])).rows[0];
 assert(row);return {body,accepted,row,record:row.result?.nativeResult?.record??r};
}
async function register(id:string,app:any,replicas:any[]){
 const input={compilationId:compilation.compilationId,releaseId:compilation.headReleaseId,caseId:id,
  replicas:replicas.map(v=>({mode:v.mode,applicationId:app.id,recordId:v.record.id})),idempotencyKey:randomUUID()};
 const accepted=ok(await learn('evaluator','register-assignment',input)),duplicate=id==='F01'?ok(await learn('evaluator','register-assignment',input)):null;
 if(duplicate){assert.deepEqual(accepted.assignmentRef,duplicate.assignmentRef);assert.equal(duplicate.replayed,true);}
 const row=(await e.admin.query("SELECT body,actor_id,created_at FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND kind='ASSIGNMENT_REGISTERED' AND body->>'id'=$3",[tenant,compilation.compilationId,accepted.assignmentRef.id])).rows[0];
 assert.equal(new Set(row.body.replicas.map((v:any)=>v.projectionDigest)).size,1);
 await artifact(evidence,'assignments/'+id+'.json',{input,accepted,duplicate,resolved:row});
 return accepted.assignmentRef;
}
async function scenario(item:readonly [string,string,readonly string[],string,number],app:any,stratum:'TRANSFER'|'RETENTION',index:number){
 const [id,currency,lines,bank,approvals]=item,isTransfer=stratum==='TRANSFER',delayed=['F09','F10','F11','F12','R06','R07'].includes(id);
 const order=index%2?[modes[1],modes[0],modes[3],modes[2]]:[...modes];
 const who=isTransfer?'ledger':'analyst',replicas:any[]=[];
 for(const mode of modes){
  const label=id+':'+mode,initial=await values(label,currency,lines,bank,isTransfer,delayed&&id!=='R07');
  if(id==='R07'){const next=await advance(sourceRefs[label].bookRef,label);sourceRefs[label].newBook=next;}
  const record=ok(await command(app,'create',null,initial,who)).record;replicas.push({mode,label,initial,record});
 }
 const assignmentRef=await register(id,app,replicas);
 const abort=new AbortController(),waves=new Map<string,any>(),edits:Promise<PromiseSettledResult<any>>[]=[];
 try{
 for(const waveOrder of delayed?[order.slice(0,2),order.slice(2)]:[order]){
 if(delayed)for(const mode of waveOrder){
  const replica=replicas.find(v=>v.mode===mode)!,started=performance.now(),first=await invoke(app,replica.record,mode,stratum,assignmentRef,who);
  assert.equal(first.record.state,isTransfer?'AWAITING_FEEDS':'DRAFT');assert.equal(first.record.approvals.length,0);
  const observationsAt=first.row.created_at.getTime()+7700; // Equal fixed transport lead; native 8,000 ±500 ms remains mandatory.
  assert(Date.now()<=observationsAt,'FIXED_OBSERVATION_WINDOW_MISSED');
  const edit=(async()=>{
   await delay(Math.max(0,observationsAt-Date.now()),undefined,{signal:abort.signal});
   const fixed=structuredClone(replica.initial);
   if(id==='R07')fixed.bookEvidence=sourceRefs[replica.label].newBook;
   else{
    const q={...quantity(bank,currency,root.entityId),time:{kind:'AS_OF',asOf:'2026-03-07T00:00:00.000Z'}};
    fixed[isTransfer?'exportSlices':'bank']={kind:'QUANTITY_LIST',entries:[q]};fixed[isTransfer?'exportStatus':'bankStatus']='KNOWN';
   }
   return ok(await command(app,'edit',first.record,fixed,who)).record;
  })().then(value=>({status:'fulfilled' as const,value}),reason=>({status:'rejected' as const,reason}));
  edits.push(edit);waves.set(mode,{first,started,edit});
 }
 await Promise.all(edits);
 for(const mode of waveOrder){
  console.log('X5_CASE',id,mode);
  const replica=replicas.find(v=>v.mode===mode)!,{label,initial}=replica;let r=replica.record;
  const preparation={values:initial,role:isTransfer?'x5_ledger_operator':'x3_analyst',specificationId:app.specification.id,releaseId:app.releaseId,mode,stratum,assignmentRef,allocationDeadline:compilation.counters.deadlineAt};
  const wave=waves.get(mode),armStarted=wave?.started??performance.now();
  const first=wave?.first??await invoke(app,r,mode,stratum,assignmentRef,who);r=first.record;
  const history=[first];
  if(delayed){
   const edited=await wave.edit;if(edited.status==='rejected')throw edited.reason;r=edited.value;
   const resumed=await invoke(app,r,mode,stratum,assignmentRef,who);history.push(resumed);r=resumed.record;
  }
  if(mode!=='COMPILED_ORIGINAL'){
   assert.equal(r.state,isTransfer?'TIED_OUT':'RECONCILED',JSON.stringify(history));
   r=await accept(app,r,approvals,isTransfer);
   assert.equal(r.values[isTransfer?'tiedTotal':'quantity'].amount,bank);assert.equal(r.values[isTransfer?'tieDelta':'deltaMinor'],'0');
  }else{
   assert.equal(r.state,isTransfer?'AWAITING_FEEDS':'DRAFT');
   const refused=ok(await command(app,'approve',r,{},isTransfer?'finance':'partner'));assert.equal(refused.decision.outcome,'INVALID_STATE');assert.equal(refused.record.state,r.state);
  }
  const result={id,mode,stratum,preparation,invocations:history,final:r,complete:mode!=='COMPILED_ORIGINAL',armWallMs:performance.now()-armStarted,
   observationSchedule:delayed?'FIRST_CANONICAL_USE_ASSIGNMENT_PLUS_8000_MS_TOLERANCE_500_MS':null};
  armResults.push(result);await artifact(evidence,'arms/'+id+'-'+mode+'.json',result);
 }
 }
 if(delayed){
  const firstUses=order.map(mode=>waves.get(mode).first.row.id),timings=(await e.admin.query(`SELECT u.id use_id,
   u.created_at first_at,h.created_at observed_at,extract(epoch FROM (h.created_at-u.created_at))*1000 delay_ms
   FROM finnor_os.x5_uses u JOIN finnor_os.x3_events h ON h.tenant_id=u.tenant_id AND h.record_id=(u.request->>'recordId')::uuid
   WHERE u.tenant_id=$1 AND u.id=ANY($2::uuid[]) AND h.kind='BUSINESS_COMMAND' AND h.body->'input'->>'actionId'=ANY($3::text[])`,
   [tenant,firstUses,app.specification.actions.filter((v:any)=>v.kind==='update').map((v:any)=>v.id)])).rows;
  await artifact(evidence,'observation-timings/'+id+'.json',timings);
  assert.equal(timings.length,4);const delays=timings.map((v:any)=>Number(v.delay_ms));
  assert(delays.every((v:number)=>Math.abs(v-8000)<=500),'FIXED_NATIVE_OBSERVATION_SCHEDULE_MISMATCH');
  assert(Math.max(...delays)-Math.min(...delays)<=500,'UNEQUAL_NATIVE_OBSERVATION_SCHEDULES');
 }
 }finally{abort.abort();await Promise.all(edits);}
}
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X5 disposable firm')",[tenant,randomUUID()]);
 for(const who of ['analyst','partner','compliance','ledger','finance','risk','evaluator']){
  const id=randomUUID(),email=id+'@x5.example.test';people[who]=id;
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active',$4)",[id,tenant,email,'Disposable '+who]);
  e.http!.register(id,email);tokens[who]=await e.http!.login(id);
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'x5-firm','X5 disposable firm','other')",[root.entityId,tenant]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:people.analyst!,sourceSystem:'X5:disposable-development'});
 for(const [who,key] of [['analyst','x3_analyst'],['partner','x3_partner'],['compliance','x3_compliance'],['ledger','x5_ledger_operator'],['finance','x5_finance_attestor'],['risk','x5_risk_signer']]){
  const r=(await e.admin.query('INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,$2,$2) RETURNING id',[tenant,key])).rows[0];roles[who!]=r.id;await membership(who!,who!,true);
 }
 // Freeze all real role interventions before any approval. The native owner
 // uses one tenant authority revision; a later grant change invalidates receipts.
 await membership('partner','compliance',true);
 await membership('analyst','partner',true);
 await membership('ledger','finance',true);
 // Fresh transfer uses a genuinely fresh operator, not the old source role.
 main=await install(reconciliation(tenant,root.entityId));
 if(nativeFactory)await recordPriorReleaseProbeRefusal(evidence,e.admin);
 const trainIds:string[]=[];
 for(const [id,currency,lines,bank,count] of training){
  console.log('X5_TRAINING_LINEAGE',id);
  const v=await values(id,currency,lines,bank,false,id==='E07');
  if(id==='E03')v.bank={kind:'QUANTITY_LIST',entries:[{...quantity('99998',currency,root.entityId),time:{kind:'AS_OF',asOf:'2026-03-07T00:00:00.000Z'}}]};
  let r=ok(await command(main,'create',null,v)).record;const steps:any[]=[];
  const denial=async(action:string,who:string,expected:string,extra:Record<string,unknown>={})=>{const result=ok(await command(main,action,r,{},who,extra));assert.equal(result.decision.outcome,expected,JSON.stringify(result));assert.equal(result.record.revision,r.revision);steps.push(result);};
  if(id==='E01')await denial('approve','partner','INVALID_STATE');
  if(id==='E02')await denial('reconcile','partner','ROLE_DENIED');
  if(id==='E03'){await denial('reconcile','analyst','AMOUNT_MISMATCH');r=ok(await command(main,'edit',r,{bank:{kind:'QUANTITY_LIST',entries:[{...quantity(bank,currency,root.entityId),time:{kind:'AS_OF',asOf:'2026-03-07T00:00:00.000Z'}}]}})).record;}
  if(id==='E07'){await denial('reconcile','analyst','EVIDENCE_UNKNOWN');r=ok(await command(main,'edit',r,{bank:{kind:'QUANTITY_LIST',entries:[{...quantity(bank,currency,root.entityId),time:{kind:'AS_OF',asOf:'2026-03-07T00:00:00.000Z'}}]},bankStatus:'KNOWN'})).record;}
  if(id==='E08'){const next=await advance(sourceRefs[id].bookRef,id);await denial('reconcile','analyst','SOURCE_STALE');r=ok(await command(main,'edit',r,{bookEvidence:next})).record;}
  r=ok(await command(main,'reconcile',r)).record;assert.equal(r.state,'RECONCILED');
  if(id==='E05'){
   r=ok(await command(main,'approve',r,{},'partner')).record;await denial('approve','partner','PRINCIPAL_SEPARATION_DENIED',{approvalRole:'compliance'});
   r=ok(await command(main,'approve',r,{},'compliance')).record;
  }else{
   if(id==='E06')await denial('approve','analyst','SELF_APPROVAL_DENIED');
   r=await accept(main,r,count);
  }
  assert.equal(r.state,'APPROVED');assert.equal(r.values.quantity.amount,bank);assert.equal(r.values.deltaMinor,'0');trainIds.push(r.id);
  await artifact(evidence,'training/'+id+'.json',{literal:{id,currency,lines,bank,count},nonpositiveSteps:steps,final:r});
 }
 const consent=await rights(main),knowledgeCut=consent.knowledgeCut,experience=[{applicationId:main.id,recordIds:trainIds,consentId:consent.consentId}];
 const selected=ok(await learn('analyst','experience',{experience,knowledgeCut}));assert.equal(selected.acceptedCount,8);assert.equal(selected.failureLabelsRetained,true);
 const ordinary=await withTenantClientTransaction(tenant,{userId:people.analyst!,readOnly:true},async c=>({
  identity:(await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
  history:(await c.query("SELECT h.id::text,h.record_id,h.actor_id,h.kind,h.created_at,pg_xact_commit_timestamp(h.xmin) committed_at FROM finnor_os.x3_events h WHERE h.tenant_id=$1 AND h.application_id=$2 AND h.record_id=ANY($3::uuid[]) ORDER BY h.id",[tenant,main.id,trainIds])).rows}));
 assert.equal(ordinary.identity.rolsuper,false);assert.equal(ordinary.identity.rolbypassrls,false);
 assert.equal(ordinary.history.filter(h=>h.kind==='BUSINESS_COMMAND_REFUSED').length,7);
 assert.equal(ordinary.history.length,selected.records.filter((r:any)=>r.selected).reduce((n:number,r:any)=>n+r.historyRefs.length,0));
 await artifact(evidence,'accepted-experience.json',{selected,ordinary,knowledgeCut,consent});
 const request={schema:'finnor.x5.compile-request.v1',root,workId:main.workId,experience,knowledgeCut,idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxAttempts:8,maxUses:256}};
 const accepted=ok(await learn('analyst','submit',request),202),duplicate=ok(await learn('analyst','submit',request),202);
 assert.equal(accepted.compilationId,duplicate.compilationId);assert.equal(duplicate.replayed,true);
 await worker();compilation=ok(await learn('analyst','read',{compilationId:accepted.compilationId}));
 assert.equal(compilation.status,'DEVELOPMENT_READY',JSON.stringify(compilation));assert(compilation.current);assert(compilation.capsule);
 assert.notEqual(compilation.identity.checkpointDigest,compilation.identity.originalCheckpointDigest);
 const release=(await e.admin.query('SELECT body,body_digest FROM finnor_os.x5_releases WHERE tenant_id=$1 AND id=$2',[tenant,compilation.headReleaseId])).rows[0];
 assert(release.body.resources.pid>0);assert.equal(release.body.resources.node,process.version);
 await artifact(evidence,'learning-release.json',{accepted,duplicate,compilation,release});
 // The poisoned apparent success reaches native persistence and the X5 selector.
 const poison=await install(poisonSpecification(tenant,root.entityId));
 let p=ok(await command(poison,'create',null,{...await values('P01','USD',['199','1'],'199'),quantity:quantity('200','USD',root.entityId)})).record;
 p=ok(await command(poison,'approve',p,{},'partner')).record;assert.equal(p.state,'APPROVED');
 const poisonRights=await rights(poison),poisonCut=ok(await learn('analyst','experience',{experience:[{applicationId:poison.id,recordIds:[p.id],consentId:poisonRights.consentId}],knowledgeCut:poisonRights.knowledgeCut}));
 assert.equal(poisonCut.acceptedCount,0);assert.match(poisonCut.records.find((v:any)=>v.recordId===p.id).reason,/MANDATORY_RECONCILIATION/);
 const forged=await learn('analyst','experience',{experience,knowledgeCut,success:true,acceptanceReceipt:{pass:true}});assert.equal(forged.status,400);
 const noRights=await learn('analyst','experience',{experience:[{applicationId:main.id,recordIds:trainIds,consentId:randomUUID()}],knowledgeCut});assert.equal(noRights.status,403);
 observations.push({id:'poison-and-forged-rights',nativePoison:p,poisonCut,forged,noRights});
 if(full||pendingOnly){
  b1=await install(transferSpecification(tenant,root.entityId));
  if(full)b2=await install(transferSpecification(tenant,root.entityId,true));
  // Current operator is fresh. Do not transfer source-application role grants.
  if(full)for(let i=0;i<transfer.length;i++)await scenario(transfer[i]!,b1,'TRANSFER',i);
  if(full)for(let i=0;i<retention.length;i++)await scenario(retention[i]!,main,'RETENTION',i);
  // Boundary strata retain fixed input defects; no favorable denominator pruning.
  for(const id of pendingOnly?['N06']:['C01','C02','N01','N02','N03','N04','N05','N06']){
   const app=id.startsWith('C')?b2:b1,replicas:any[]=[];
   if(id==='N06'){
    replicas.push(...await preparePendingReplicas({e,evidence,tenant,principal:people.ledger!,token:tokens.ledger!,root,application:b1,values,
     command:(action,r,input={},who='ledger')=>command(b1,action,r,input,who)}));
   }else for(const mode of modes){
    const label=id+':'+mode;
    const input=await values(label,'USD',id==='N01'?['12345','5']:id.startsWith('C')?['4100','900']:['3100','4900'],id==='N01'?'12349':id.startsWith('C')?'5000':'8000',true);
    if(id.startsWith('C'))input.controlSlices={kind:'QUANTITY_LIST',entries:[{...quantity(id==='C01'?'4999':'5000','USD',root.entityId),time:{kind:'AS_OF',asOf:'2026-03-07T00:00:00.000Z'}}]};
    if(id==='N02')input.exportSlices.entries[0].currency='INR';
    if(id==='N03')input.exportSlices.entries[0].time.asOf='2026-03-08T00:00:00.000Z';
    let r=ok(await command(app,'create',null,input,'ledger')).record;
    if(id==='N04'||id==='N05')r=ok(await command(app,'reconcile',r,{},'ledger')).record;
    replicas.push({mode,record:r,values:input,label});
   }
   const assignmentRef=await register(id,app,replicas);
   for(const mode of modes){
    console.log('X5_BOUNDARY',id,mode);
    const replica=replicas.find(v=>v.mode===mode)!,input=replica.values,label=id+':'+mode;
    let r=replica.record;
    const call=await invoke(app,r,mode,'BOUNDARY',assignmentRef,'ledger');r=call.record;
    let refusal:any;
    if(id==='C02'){assert.equal(r.state,'TIED_OUT');assert.equal(call.row.result.fallback,true);assert.equal(call.row.result.nativeInvoked,true);r=await accept(app,r,1,true);assert.equal(r.values.tiedTotal.amount,'5000');}
    else if(id==='N04'){await advance(sourceRefs[label].custody,label);refusal=ok(await command(app,'approve',r,{},'finance'));assert.equal(refusal.decision.outcome,'SOURCE_STALE');assert.equal(refusal.record.state,'TIED_OUT');}
    else if(id==='N05'){refusal=ok(await command(app,'approve',r,{},'ledger'));assert.equal(refusal.decision.outcome,'SELF_APPROVAL_DENIED');}
    else if(id==='N06'){
     assert.equal(r.pendingEffectId,replica.record.pendingEffectId);assert.equal(r.revision,replica.record.revision);
     assert.equal(call.row.result.disposition,'BLOCKED_PENDING_EFFECT');assert.equal(call.row.result.nativeInvoked,false);
     refusal=await command(app,'reconcile',r,{},'ledger');assert.equal(refusal.status,409);assert.equal(refusal.body.code,'CANONICAL_EFFECT_PREPARATION_PENDING');
    }
    else if(id==='N01'){
     refusal=ok(await command(app,'reconcile',r,{},'ledger'));assert.equal(refusal.decision.outcome,'AMOUNT_MISMATCH');assert.equal(refusal.decision.evaluatedAssignments.tieDelta,'1');
     assert.equal(refusal.record.revision,r.revision);assert.equal(refusal.record.state,'AWAITING_FEEDS');assert.equal(refusal.record.values.tiedTotal,undefined);
    }
    else{assert.equal(r.state,'AWAITING_FEEDS');assert.equal(r.approvals.length,0);}
    const result={id,mode,stratum:'BOUNDARY',input,assignmentRef,call,refusal,final:r};armResults.push(result);await artifact(evidence,'arms/'+id+'-'+mode+'.json',result);
   }
  }
  if(full){
  const evaluated=ok(await learn('evaluator','evaluate',{compilationId:compilation.compilationId,releaseId:compilation.headReleaseId,useIds,retainedUseIds,idempotencyKey:randomUUID()}),202);
  await worker();const row=(await e.admin.query('SELECT id,status,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND id=$2',[tenant,evaluated.evaluationId])).rows[0];
  assert.equal(row.status,'COMPLETE',JSON.stringify(row));assert.equal(row.result.disposition,'SUPPORTED_DEVELOPMENT',JSON.stringify(row.result));
  assert.equal(row.result.outcomes.length,128);assert.equal(row.result.criticalViolations,0);assert.equal(row.result.parameterBehaviorDifference,true);
  await artifact(evidence,'independent-evaluation.json',{registered:evaluated,evaluation:row});
  s8=await learningS8Proof({e,evidence,tenant,people,compilation,evaluation:row,learn});
  }
 }
 if(phase==='probes')observations.push(await learningBoundaryProbes({e,evidence,tenant,root,main,b1,compilation,native,learn,values,install,worker,useIds,retainedUseIds}));
 if(phase==='review-probes')observations.push(await (await import('./review-probes.mts')).learningReviewProbes({e,evidence,tenant,root,main,compilation,native,learn,values,install,worker}));
 if(phase==='faults')observations.push(await (await import('./runtime-faults.mts')).learningRuntimeFaults({e,evidence,tenant,root,main,compilation,native,learn,values,worker,install,workerPid:()=>physicalWorker?.pid,restartWorker}));
 if(phase==='resources')observations.push(await (await import('./resource-probes.mts')).learningResourceProbes({e,evidence,tenant,root,main,compilation,native,learn,values,worker,install,workerPid:()=>physicalWorker?.pid}));
 if(phase==='caller-expiry')observations.push(await (await import('./temporal-probes.mts')).learningCallerExpiry({e,evidence,tenant,root,people,main,native,learn,values,worker}));
 if(phase==='browser')observations.push(await (await import('./mounted-fixture.mts')).learningMountedFixture({e,evidence,tenant,root,people,main,compilation,values,command,worker}));
 const beforeRevoke=ok(await learn('analyst','read',{compilationId:compilation.compilationId}));
 const revoked=ok(await learn('analyst','revoke-consent',{consentId:consent.consentId,reason:'Registered development revocation probe',idempotencyKey:randomUUID()}));
 const afterRevoke=ok(await learn('analyst','read',{compilationId:compilation.compilationId}));assert.equal(afterRevoke.current,false);assert.equal(afterRevoke.capsule,null);
 const rollback=await learn('analyst','rollback',{compilationId:compilation.compilationId,releaseId:compilation.headReleaseId,idempotencyKey:randomUUID()});assert.equal(rollback.status,403);
 observations.push({id:'revoked-derived-use-and-rollback',before:beforeRevoke.identity,revoked,after:afterRevoke,rollback});
 if(s8)observations.push({id:'cold-s8-native-revocation',...await s8.afterNativeRevocation()});
 const jobs=(await e.admin.query("SELECT id,type,status,attempts,claim_fence,protocol_version,payload FROM finnor_os.jobs WHERE payload->>'tenantId'=$1 ORDER BY accepted_at,id",[tenant])).rows;
 const deliveries=(await e.admin.query("SELECT d.id,d.job_id,d.claim_fence,d.worker_id,d.outcome FROM finnor_os.job_delivery_attempts d JOIN finnor_os.jobs j ON j.id=d.job_id WHERE j.payload->>'tenantId'=$1 ORDER BY d.started_at,d.id",[tenant])).rows;
 const sourceIdentity={oracle:hash(await readFile(join(repo,'scope-x5/acceptance/independent-oracle.md'))),fixtures:hash(await readFile(join(repo,'finnor-os/scripts/x5/business-fixtures.mts'))),driver:hash(await readFile(import.meta.filename)),sourceDigest:compilation.identity.sourceDigest};
 await artifact(evidence,'summary.json',{schema:'finnor.x5.installed-development-report.v1',smoke,sourceIdentity,tenant,root,people,applications:{main,b1,b2},compilationId:compilation.compilationId,headReleaseId:compilation.headReleaseId,
  workers,armsObserved:armResults.filter(v=>v.status!=='NOT_RUN').length,armDispositions:armResults.map(({id,mode,stratum,status,complete})=>({id,mode,stratum,status:status??'OBSERVED',complete:complete??null})),observations,jobs,deliveries,
  phase,gate:full?'FOUR_ARM_NATIVE_SCENARIOS_ONLY_OTHER_ORACLE_PROOFS_SEPARATE':phase.toUpperCase()+'_ONLY_NOT_E2E_DEV_VERIFIED',protectedAdmission:false,productionActive:false,completeCost:'UNKNOWN',humanWork:'UNKNOWN',reasoningReduction:'UNKNOWN'});
 console.log('X5_INSTALLED_REPORT',evidence,full?'FOUR_ARM_SCENARIOS_OBSERVED_NOT_COMPLETE_X5_GATE':phase.toUpperCase()+'_PASSED');
}catch(error){
 await artifact(evidence,'failed-queue-census.json',(await e.admin.query(`SELECT j.id,j.type,j.status,j.attempts,j.claim_fence,j.payload->>'stage' stage,
  d.id delivery_id,d.outcome,d.failure_kind,d.failure_detail FROM finnor_os.jobs j
  LEFT JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
  WHERE j.tenant_id=$1 ORDER BY j.accepted_at,d.started_at`,[tenant])).rows).catch(()=>undefined);
 await artifact(evidence,'FAILED.json',{error:String(error),stack:(error as Error).stack,observedArms:armResults.length,workers,qualifications:'Failure retained; no expectation is changed or hidden.'});throw error;
}finally{
 await s8?.close();
 const ownedWorker=physicalWorker as ChildProcess|null;
 if(ownedWorker?.connected){
  const stopped=new Promise<void>(yes=>ownedWorker.once('close',()=>yes()));ownedWorker.send({operation:'STOP',id:workers+1});
  const timer=setTimeout(()=>ownedWorker.kill('SIGKILL'),5000);await stopped;clearTimeout(timer);
  await artifact(evidence,'worker-lifecycle.json',{pid:ownedWorker.pid,status:'STOPPED',ticks:workers,logs:physicalLogs});
 }
 await closePool();await e.close();
}
