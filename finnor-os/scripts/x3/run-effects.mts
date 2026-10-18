/** Actual S1/S3 fit, S4 policy/preparation, S5 clearing/consumption and S6
 * obligation. Generated observations demonstrate codec/owner mechanics only.
 * Disposable signatures and a loopback TLS target are development mechanics,
 * not protected admission, independent custody, or a real financial effect. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mjs';
import {startEnvironment,artifact,repo} from './environment.mts';
import {reconciliation,quantity} from './business-fixtures.mts';
import {checkInstalledEnvelope} from './envelope-check.mts';
import {proveGovernedDispatch} from '../s6/governed-dispatch-proof.mts';
import {startMountedFrontend} from './mounted-fixture.mts';

const evidence=resolve(process.env.FINNOR_X3_EVIDENCE_DIR!);
assert(process.env.FINNOR_X3_EVIDENCE_DIR);
await mkdir(evidence,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'finnor-x3-effect-'));
process.env.FINNOR_S3_MODEL_STORE=join(directory,'models');process.env.FINNOR_S4_POLICY_STORE=join(directory,'policies');
assert(process.env.FINNOR_S3_PYTHON?.startsWith('/'),'PINNED_PRIVATE_PYTHON_REQUIRED');
const e=await startEnvironment(evidence,{builtApi:process.env.FINNOR_X3_BUILT_API==='1'});
const tokens=new Map<string,string>(),calls:any[]=[],people={partner:randomUUID(),compliance:randomUUID()};
let mounted:Awaited<ReturnType<typeof startMountedFrontend>>|undefined,closeBrowserControl:(()=>Promise<void>)|undefined;
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);
const upstream=async(f:any,operation:string,body:unknown)=>{
 const family=operation==='fit'?'interventions':['synthesize','handoff'].includes(operation)?'policies':'allocations';
 const result=await e.http!.api(tokens.get(f.principal)!,family,operation,body);calls.push({family,operation,input:body,...result});return result;
};
const day=86400000,begin=new Date(Math.floor(Date.now()/day)*day-128*day).toISOString();
const support=createUpstreamFixtureSupport({admin:()=>e.admin,generatedRows:JSON.parse(generated.stdout).rows,begin,day,fixtures:{},api:upstream,artifact:(name,value)=>artifact(evidence,'upstream/'+name,value)});
async function worker(){
 const result=await new Promise<any>((yes,no)=>{
  const child=spawn(process.execPath,['--import=tsx','scripts/x3/worker-once.mts'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe']});
  let logs='';for(const stream of [child.stdout!,child.stderr!])stream.on('data',b=>logs+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),45000);child.once('error',no);child.once('close',(code,signal)=>{clearTimeout(timer);yes({code,signal,logs});});
 });
 assert.equal(result.code,0,JSON.stringify(result));return result;
}
try{
 let accepted:any,installed:any,literalEvidence:any,browserThread:any;
 const applicationCall=async(f:any,operation:string,body:unknown,principal=f.principal)=>{
  const response=await e.http!.api(tokens.get(principal)!,'company-brain','application-'+operation,body);calls.push({family:'company-brain',operation,input:body,...response});return response;
 };
 const f=await support.fixture('x3-exact-dose-'+randomUUID().slice(0,8),2,[
  {id:'cash',unit:'USD',capacity:100,totalLimit:100},
  {id:'execution',unit:'request',capacity:200,totalLimit:200,resourceClass:'COMPUTE'},
  {id:'human',unit:'seconds',capacity:4,totalLimit:4,resourceClass:'HUMAN_ATTENTION'},
 ],{
  exposureUnit:'USD:minor:RECORDED_MINOR',beforeFit:async f=>{
   e.http!.register(f.principal,f.name+'@s5.example.test','x3-disposable-only');tokens.set(f.principal,await e.http!.login(f.principal));
   for(const [role,principal] of [['analyst',f.principal],...Object.entries(people)] as Array<[string,string]>){
    if(principal!==f.principal){await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[principal,f.tenant,principal+'@x3.example.test']);e.http!.register(principal,principal+'@x3.example.test');tokens.set(principal,await e.http!.login(principal));}
    const r=(await e.admin.query('INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,$2,$2) RETURNING id',[f.tenant,'x3_'+role])).rows[0];
    await e.admin.query('INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)',[f.tenant,principal,r.id,JSON.stringify({kind:'resources',resourceType:f.root.entityType,resourceIds:[f.root.entityId]})]);
   }
   // Original Work attachments must precede the S3/S4 belief cut. Adding new
   // root-owned Work afterwards correctly invalidates that older source cut.
   const literalSource=await createEvidenceSource(f.tenant,{sourceKey:'x3-literal-only',sourceType:'manual',title:'Literal owner fact, not a record field'});
   const literalVersion=await appendEvidenceVersion(f.tenant,literalSource.id,{content:'Current literal owner fact',snapshot:{qualification:'DECLARED_DEVELOPMENT_INPUT'},asOf:new Date()});
   const literalHash=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[literalVersion.versionId])).rows[0].content_hash;
   literalEvidence={kind:'EVIDENCE',sourceId:literalSource.id,versionId:literalVersion.versionId,contentDigest:literalHash};
   const specification=reconciliation(f.tenant,f.root.entityId);
   const prepare=specification.actions.find(a=>a.id==='prepare')!;
   prepare.fromStates=['APPROVED'];
   prepare.guards=[...prepare.guards,{id:'literal-owner-current',condition:{op:'current-evidence',value:{op:'literal',value:literalEvidence}},denialCode:'SOURCE_STALE',requirementIds:['evidence']}];
   accepted=ok(await applicationCall(f,'submit',{schema:'finnor.x3.application-request.v1',root:f.root,specification,idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxBuilds:16,maxMutations:10000}}),202);
   for(let i=0;i<8;i++){
    await worker();installed=ok(await applicationCall(f,'read',{applicationId:accepted.applicationId}));
    if(installed.status==='FAILED'){await applicationCall(f,'history',{applicationId:accepted.applicationId,limit:100});break;}
    if(installed.status==='INSTALLED')break;
   }
   assert.equal(installed.status,'INSTALLED');
   if(process.env.FINNOR_X3_EFFECT_BROWSER==='1'){
    browserThread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'X3 exact application effect and observed Work'});
    await updateEmployeeConversationThreadContext({tenantId:f.tenant,ownerEmployeeId:f.principal,threadId:browserThread.id,activeWorkId:installed.workId,activeReferences:[f.root]});
   }
  },
 });
 const api=(operation:string,body:unknown,principal=f.principal)=>applicationCall(f,operation,body,principal);
 const policy=await support.policy(f,'single-exact-dose',{cash:25,execution:130,human:4});
 await support.resource(f,'cash','USD','STOCK',['100','100','100']);
 await support.resource(f,'execution','request','CUMULATIVE_EXPENDITURE',['200','200','200']);
 await support.resource(f,'human','seconds','CUMULATIVE_EXPENDITURE',['4','4','4']);
 const cleared=ok(await upstream(f,'clear',support.clearing(f,{'single-exact-dose':['100']})));
 assert.equal(cleared.status,'FEASIBLE');
 const handoff=ok(await upstream(f,'handoff',{policyRef:policy.ref,allocationRef:cleared.certificate.ref,decision:support.decision(f,cleared.certificate.ref)}));
 assert(handoff.preparationRef&&handoff.consumptionRef&&handoff.intervention);
 const channel=handoff.intervention.channels[0];assert.equal(channel.unit,'USD:minor:RECORDED_MINOR');assert.equal(channel.doses.length,1);
 const source=await createEvidenceSource(f.tenant,{sourceKey:'x3-exact-dose-support',sourceType:'manual',title:'Declared exact-dose development input'});
 const version=await appendEvidenceVersion(f.tenant,source.id,{content:'Generated declared quantity, not protected financial evidence.',snapshot:{sourceOrigin:'GENERATED_CHALLENGE'},asOf:new Date()});
 const row=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[version.versionId])).rows[0];
 const evidenceRef={kind:'EVIDENCE',sourceId:source.id,versionId:version.versionId,contentDigest:row.content_hash};
 const q={...quantity(String(channel.doses[0]),'USD',f.root.entityId),time:{kind:'AS_OF',asOf:handoff.intervention.timing.startAt}};
 const values={memo:'Actual S4 exact dose, not execution',book:{kind:'QUANTITY_LIST',entries:[q]},bank:{kind:'QUANTITY_LIST',entries:[q]},bookStatus:'KNOWN',bankStatus:'KNOWN',bookEvidence:evidenceRef,bankEvidence:evidenceRef,operation:channel.operation,channel:channel.exposureId};
 const command=async(actionId:string,r:any,input:unknown={},principal=f.principal)=>ok(await api('command',{applicationId:accepted.applicationId,entityId:'reconciliation',actionId,input,idempotencyKey:randomUUID(),...(r?{recordId:r.id,expectedRevision:r.revision,expectedReference:r.reference}:{})},principal));
 let record=(await command('create',null,values)).record;
 for(const [action,principal] of [['reconcile',f.principal],['approve',people.partner],['prepare',f.principal]]){
  const result=await command(action!,record,{},principal);assert.equal(result.decision.allowed,true,JSON.stringify(result));record=result.record;
 }
 const input={applicationId:accepted.applicationId,recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference,preparationRef:handoff.preparationRef,allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef,idempotencyKey:randomUUID()};
 const nonexistent=await api('prepare-effect',{...input,consumptionRef:{...handoff.consumptionRef,id:'nonexistent-consumption:'+randomUUID()},idempotencyKey:randomUUID()});
 assert.equal(nonexistent.status,404);
 const afterNonexistent=ok(await api('record',{applicationId:accepted.applicationId,recordId:record.id}));
 assert.equal(afterNonexistent.pendingEffectId,null);assert.equal(afterNonexistent.revision,record.revision);
 assert.equal((await e.admin.query('SELECT count(*)::integer n FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1',[f.tenant])).rows[0].n,0);
 let uncertainResponsibility:any=null;
 if(process.env.FINNOR_X3_BUILT_API==='1'){
  const gate='x3-disposable-s6-commit:'+randomUUID();
  // A timing-only trigger on this disposable database holds the genuine owner
  // before commit. It neither creates owner facts nor alters its validation.
  await e.admin.query(`CREATE FUNCTION finnor_os.x3_disposable_s6_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0],0));RETURN NEW;END $$`);
  await e.admin.query(`CREATE TRIGGER x3_disposable_s6_commit_gate AFTER INSERT ON finnor_os.s6_obligation_origins
   FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_disposable_s6_commit_gate('${gate}')`);
  await e.admin.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[gate]);
  const inFlight=api('prepare-effect',input).then(result=>({result}),error=>({error:String(error)}));
  let transaction=false;
  try{
   const until=Date.now()+15000;let pending:any;
   do{
    pending=(await e.admin.query('SELECT pending_effect_id FROM finnor_os.x3_records WHERE tenant_id=$1 AND id=$2',[f.tenant,record.id])).rows[0];
    if(pending.pending_effect_id)break;
    assert(Date.now()<until,'ACTUAL_PENDING_RESPONSIBILITY_NOT_OBSERVED');await new Promise(yes=>setTimeout(yes,5));
   }while(true);
   await e.admin.query('BEGIN');transaction=true;
   await e.admin.query('SELECT id FROM finnor_os.x3_applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[f.tenant,accepted.applicationId]);
   await e.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate]);
   let nativeCount=0;
   do{
    nativeCount=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1',[f.tenant])).rows[0].n;
    if(nativeCount===1)break;
    assert(Date.now()<until,'ACTUAL_S6_COMMIT_NOT_OBSERVED');await new Promise(yes=>setTimeout(yes,5));
   }while(true);
   await e.http!.restartApi();
   const lost=await inFlight;assert('error' in lost||lost.result.status!==200);
   uncertainResponsibility={fault:'OWNED_API_STOP_AFTER_GENUINE_S6_COMMIT_BEFORE_BLOCKED_LOCAL_COMPLETION',nativeCount,pendingBeforeStop:pending,lost};
  }finally{
   if(transaction)await e.admin.query('ROLLBACK');
   await e.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate]);
   await e.admin.query('DROP TRIGGER x3_disposable_s6_commit_gate ON finnor_os.s6_obligation_origins');
   await e.admin.query('DROP FUNCTION finnor_os.x3_disposable_s6_commit_gate()');
  }
  const retained=ok(await api('record',{applicationId:accepted.applicationId,recordId:record.id}));
  assert(retained.pendingEffectId);
  const blockedEdit=await api('command',{applicationId:accepted.applicationId,entityId:'reconciliation',actionId:'edit',recordId:record.id,
   expectedRevision:retained.revision,expectedReference:retained.reference,input:{memo:'Cannot discard unresolved responsibility'},idempotencyKey:randomUUID()});
  assert.equal(blockedEdit.status,409);assert.equal(blockedEdit.body.code,'CANONICAL_EFFECT_PREPARATION_PENDING');
  uncertainResponsibility={...uncertainResponsibility,retained,blockedEdit,allocationRetained:true};
 }
 const prepared=ok(await api('prepare-effect',input));
 assert.equal(prepared.status,'PREPARED_UNADMITTED');assert.equal(prepared.executionAuthorityGranted,false);assert.equal(prepared.settlementEstablished,false);
 const repeated=await Promise.all(Array.from({length:4},()=>api('prepare-effect',input)));assert(repeated.every(r=>r.status===200&&r.body.obligationRef.id===prepared.obligationRef.id));
 const native=(await e.admin.query("SELECT o.body,e.status,e.effect,d.status AS action_status FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id JOIN finnor_os.domain_actions d ON d.id=e.domain_action_id WHERE o.tenant_id=$1",[f.tenant])).rows;
 assert.equal(native.length,1);assert.equal(native[0].status,'compiled');assert.equal(native[0].action_status,'draft');assert.deepEqual(native[0].body.intervention,handoff.intervention);
 const final=ok(await api('record',{applicationId:accepted.applicationId,recordId:record.id}));assert.equal(final.pendingEffectId,null);
 let wrong=(await command('create',null,{...values,operation:'DECLARED_BUT_DIFFERENT_OPERATION'})).record;
 for(const [action,principal] of [['reconcile',f.principal],['approve',people.partner],['prepare',f.principal]])wrong=(await command(action!,wrong,{},principal)).record;
 const mismatch=await api('prepare-effect',{...input,recordId:wrong.id,expectedRevision:wrong.revision,expectedReference:wrong.reference,idempotencyKey:randomUUID()});
 assert.equal(mismatch.status,409);assert.equal(mismatch.body.code,'APPLICATION_S4_EXACT_BINDING_MISMATCH');
 const wrongAfter=ok(await api('record',{applicationId:accepted.applicationId,recordId:wrong.id}));
 assert.equal(wrongAfter.pendingEffectId,null);assert.equal(wrongAfter.revision,wrong.revision);
 const repaired=(await command('edit',wrongAfter,{memo:'Definitively refused before an owner call, record remains editable'})).record;
 assert.equal(repaired.state,'DRAFT');
 assert.equal((await e.admin.query('SELECT count(*)::integer n FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1',[f.tenant])).rows[0].n,1);
 const rollback=ok(await api('rollback',{applicationId:accepted.applicationId,expectedReleaseId:installed.headReleaseId,releaseId:installed.headReleaseId,idempotencyKey:randomUUID()}));
 assert.equal(rollback.status,'ROLLBACK_BLOCKED');assert.equal(rollback.forwardRepairAllowed,true);assert.equal(rollback.dataRetained,true);
 assert(rollback.reasons.includes('CANONICAL_OBLIGATION_HISTORY_REQUIRES_FORWARD_REPAIR'));
 assert(!Object.values(record.values).some((v:any)=>v?.kind==='EVIDENCE'&&v.sourceId===literalEvidence.sourceId));
 const ownerCall=async(operation:string,body:unknown)=>{
  const family=['resource','settle'].includes(operation)?'allocations':'obligations';
  const response=await e.http!.api(tokens.get(f.principal)!,family,operation,body);calls.push({family,operation,input:body,...response});return response;
 };
 const obligation=ok(await ownerCall('read',{obligationRef:prepared.obligationRef}));
 const dispatch=await proveGovernedDispatch(f,obligation,(_actor:any,operation:string,body:unknown)=>ownerCall(operation,body),e.admin,
  (name:string,value:unknown)=>artifact(evidence,'dispatch/'+name,value),false,undefined,false,{
   ownerCall,workerDatabaseUrl:e.workerUrl,
   mapping:{field:'recordedMinorAmount',recordPrefix:'x3-recorded-minor',dose:0.15,operation:'PRICE_CHANGE',unit:'USD:minor:RECORDED_MINOR'},
   onTransportConfigured:process.env.FINNOR_X3_BUILT_API==='1'?async()=>{await e.http!.restartApi();}:undefined,
   onUnresolved:async context=>{
    const retained=ok(await api('record',{applicationId:accepted.applicationId,recordId:record.id}));
    const origin=(await e.admin.query("SELECT body->'workLineage'->>'workId' AS work_id,effect_id,body->'allocationRef'->>'id' AS allocation_id,consumption_id FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1 AND obligation_id=$2",[f.tenant,prepared.obligationRef.id])).rows;
    await artifact(evidence,'dispatch/x3-unresolved-responsibility.json',{context,retained,origin,prepared});
    assert.equal(origin.length,1);assert.equal(origin[0].work_id,installed.workId);assert.equal(context.uncertain[0].status,'UNKNOWN_OUTCOME');
   },
  });
 assert(dispatch.authorityCalls.every((call:any)=>call.authentication==='SIGNED_BEARER_REAL_HTTP'));
 assert.equal(dispatch.requests.filter((request:any)=>request.method==='PATCH').length,1);
 assert.equal(dispatch.requests.filter((request:any)=>request.method==='GET').length,3);
 assert('current' in dispatch);assert.equal(dispatch.current.fields.recordedMinorAmount,0.15);
 const nativeAfter=(await e.admin.query("SELECT o.body,e.status,e.verification,d.status AS action_status FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id JOIN finnor_os.domain_actions d ON d.tenant_id=e.tenant_id AND d.id=e.domain_action_id WHERE o.tenant_id=$1",[f.tenant])).rows;
 assert.equal(nativeAfter[0].status,'verified');assert.equal(nativeAfter[0].action_status,'completed');
 const immutablePreparation=(await e.admin.query("SELECT body result FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND kind='S6_BOUND'",[f.tenant,accepted.applicationId])).rows;
 assert.deepEqual(immutablePreparation.map((row:any)=>row.result),[prepared]);
 const application=ok(await api('read',{applicationId:accepted.applicationId})),envelope=await checkInstalledEnvelope(e,application,f.tenant,evidence);
 assert.deepEqual(envelope.obligationRefs,[prepared.obligationRef]);assert.equal(application.package.envelope.S6_obligation_refs.count,'1');
 await artifact(evidence,'complete-common-envelope.json',{status:'PASS_ACTUAL_S6_ENVELOPE_REFERENCES',check:envelope,envelope:application.package.envelope});
 await artifact(evidence,'exact-effect.json',{status:'PASS_DEVELOPMENT',handoff,record,preparationFromStates:['APPROVED'],literalEvidence,literalPinNotStoredInRecord:true,nonexistent,afterNonexistent,uncertainResponsibility,prepared,repeated,native,nativeAfter,immutablePreparation,dispatch,final,mismatch,wrongAfter,repaired,rollback,calls,envelope,qualification:'ACTUAL_EXACT_X3_OWNER_CODEC_DISPATCH_UNCERTAINTY_READBACK_AND_S5_SETTLEMENT; GENERATED_SCIENTIFIC_INPUTS_AND_DISPOSABLE_AUTHORITY; LOOPBACK_TLS_ONLY; NO_INDEPENDENT_CUSTODY_PROTECTED_ADMISSION_LIVE_FINANCIAL_EFFECT_OR_PRODUCTION_ACTIVATION'});
 if(process.env.FINNOR_X3_EFFECT_BROWSER==='1'){
  assert(browserThread);assert('history' in dispatch);
  const verification=dispatch.history.find((entry:any)=>entry.event.type==='VERIFICATION'&&entry.event.detail.status==='VERIFIED');assert(verification);
  assert.equal(nativeAfter[0].verification.settlementEventId,verification.receipt.identity);
  mounted=await startMountedFrontend(evidence,e.http!);
  let stop!:()=>void;const stopped=new Promise<void>(yes=>stop=yes);
  const control=createServer((req,res)=>{
   res.setHeader('content-type','application/json');
   if(req.url==='/stop'&&req.method==='POST'){res.end('{}');stop();return;}
   res.writeHead(404);res.end('{}');
  });
  await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const address=control.address();assert(address&&typeof address!=='string');
  closeBrowserControl=async()=>{control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));};
  const query=new URLSearchParams({threadId:browserThread.id,root:JSON.stringify(f.root),workId:installed.workId,object:JSON.stringify({namespace:'core',owner:'@finnor/db',type:'work',id:installed.workId})});
  const fixture={base:mounted.base,control:'http://127.0.0.1:'+address.port,email:f.name+'@s5.example.test',principal:f.principal,tenant:f.tenant,root:f.root,
   applicationUrl:mounted.base+'/centropy/investigations/'+browserThread.id+'?root='+encodeURIComponent(JSON.stringify(f.root)),
   worldUrl:mounted.base+'/centropy/world?'+query,expected:{applicationId:accepted.applicationId,releaseId:installed.headReleaseId,recordId:record.id,workId:installed.workId,
    obligationRef:prepared.obligationRef,actionId:obligation.domainActionId,effectId:obligation.effectRef.id,semanticHash:obligation.effectRef.semanticHash,settlementEventId:verification.receipt.identity,verification:nativeAfter[0].verification},
   qualification:'SAME_ACTUAL_X3_APPLICATION_WORK_AND_S5_SETTLED_LOOPBACK_EFFECT; DISPOSABLE_AUTHORITY_NOT_PROTECTED_QUALIFICATION'};
  await artifact(evidence,'effect-browser-fixture.json',fixture);console.log(JSON.stringify({status:'X3_EFFECT_BROWSER_FIXTURE_READY',fixture:join(evidence,'effect-browser-fixture.json')}));
  const interrupted=()=>stop();process.once('SIGTERM',interrupted);process.once('SIGINT',interrupted);
  try{await stopped;}finally{process.off('SIGTERM',interrupted);process.off('SIGINT',interrupted);}
 }
 console.log('X3_CANONICAL_EXACT_EFFECT_PASS');
}catch(error){await artifact(evidence,'failure.json',{error:String(error),stack:(error as Error).stack,calls});throw error;}
finally{await closeBrowserControl?.();await mounted?.close();await e.close();}
