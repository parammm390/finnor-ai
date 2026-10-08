/** Genuine native-owner/outbox/separate-ledger crash and integrity challenges. */
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { closePool } from '@finnor/db';
import { prepareEnterpriseDurableObligation, readEnterpriseDurableObligation } from '../../packages/private-equity/src/enterprise-obligations.js';
import { readEnterpriseAllocation } from '../../packages/private-equity/src/enterprise-allocation.js';
import { loadEnterpriseBeliefView } from '../../packages/private-equity/src/enterprise-beliefs.js';

const output=resolve(process.env.FINNOR_S6_OWNER_EVIDENCE_DIR!);await mkdir(output);
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort((a,b)=>a.localeCompare(b)).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:any)=>createHash('sha256').update(canonical(v)).digest('hex');
const bytesHash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const root=await realpath(await mkdtemp(join(tmpdir(),'finnor-owner-transport-')));
const nativePath=process.env.FINNOR_S6_NATIVE_OBLIGATION_RESULTS!;
const native=JSON.parse(await readFile(nativePath,'utf8'));
const nativeCase=native.results.find((r:any)=>r.id==='actual-upstream-handoff-and-one-native-responsibility'&&r.status==='PASS');assert(nativeCase);
const obligation=nativeCase.observed.obligation,tenant=obligation.tenantId,principal=obligation.principalId;
assert(/^[a-f0-9-]{36}$/i.test(tenant)&&/^[a-f0-9-]{36}$/i.test(principal));
const scope={semanticOwner:'S6',tenantId:tenant,principalId:principal};
const s5Scope={...scope,semanticOwner:'S5'};
const ctx:any={auth:{tenantId:tenant,userId:principal,employeeId:principal,role:'owner'},commandId:randomUUID()};
const signer=generateKeyPairSync('ed25519'),reviewer=generateKeyPairSync('ed25519'),origin=generateKeyPairSync('ed25519');
const s5Origin=generateKeyPairSync('ed25519');
const pem=(key:any)=>key.export({type:'spki',format:'pem'}).toString();
const token=randomUUID()+randomUUID();
const s5Token=randomUUID()+randomUUID();
const businessToken=randomUUID()+randomUUID();
const nativeDir=dirname(createRequire(import.meta.url).resolve('fs-ext/package.json'));
const ledgerPaths=['packages/governed-execution/src/ledger.ts','packages/governed-execution/src/ledger-server.mts','packages/governed-execution/src/protocol.ts','packages/governed-execution/src/request-verifier.ts','packages/governed-execution/src/adapter-contract.ts',join(nativeDir,'fs-ext.js'),join(nativeDir,'build/Release/fs_ext.node'),join(nativeDir,'package.json')];
const sources=await Promise.all(ledgerPaths.map(async path=>({path,sha256:bytesHash(await readFile(path))})));
const runPaths=[...ledgerPaths,'packages/governed-execution/src/owner-transport.ts','packages/governed-execution/src/owner-delivery-store.ts','packages/governed-execution/src/owner-delivery-worker.mts','packages/private-equity/src/enterprise-obligations.ts','packages/private-equity/src/allocation-store.ts','packages/private-equity/src/enterprise-allocation.ts','packages/private-equity/src/enterprise-beliefs.ts','packages/private-equity/src/world-state.ts','packages/epistemic-runtime/src/allocation-contracts.ts','packages/epistemic-runtime/src/source-precedence.ts','packages/private-equity/src/obligation-contracts.ts','apps/api/app/api/obligations/[operation]/route.ts','apps/api/app/api/allocations/[operation]/route.ts','packages/db/migrations/0152_authenticated_owner_transport.sql','packages/db/migrations/0153_owner_delivery_read_recovery.sql','packages/db/migrations-bundle.ts','packages/db/migration-head.ts','scripts/s6/run-owner-transport-e2e.mts','package-lock.json'];
const snapshot=async()=>Object.fromEntries(await Promise.all(runPaths.map(async path=>[path,await readFile(path).then(bytesHash,()=>null)])));
const exhaustRecovery=process.argv.includes('--exhaust-recovery');
const finalAttempt=process.argv.includes('--final-attempt')||exhaustRecovery;
const selectedCase=process.env.FINNOR_S6_OWNER_CASE_FILTER;
const manifest:any={schema:'finnor.s6.owner-transport-e2e.v1',startedAt:new Date().toISOString(),sources:await snapshot(),nativeOwnerInput:{path:resolve(nativePath),sha256:bytesHash(await readFile(nativePath))},command:process.argv,cwd:process.cwd(),node:process.version,authorityScope:scope,additionalAuthorityScopes:[s5Scope],selection:selectedCase??'FULL_REGISTERED_RUN',finalAttempt,exhaustRecovery,qualification:'ACTUAL_NATIVE_OWNER_AND_DISPOSABLE_DATABASE; SEPARATE_PROCESS_LEDGER; DISPOSABLE_TEST_AUTHORITY; NO_PRODUCTION_ADMISSION_OR_LIVE_PROVIDER'};
manifest.resources={supervisorStart:process.resourceUsage(),scope:'SUPERVISOR_ONLY; WORKER_LEDGER_CPU_MEMORY_AND_PROVIDER_BILLING_NOT_CAPTURED',money:null,productionQuotaEnforcement:'NOT_ESTABLISHED'};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
const results:any[]=[];let ledger:ChildProcess|undefined,worker:ChildProcess|undefined,ledgerBase='',workerLogs='';let tamperReadback=false,loseRecoveryResponse=false;
let transport:any,store:any,triggerInstalled=false;
const admin=new pg.Client({connectionString:process.env.FINNOR_S6_ADMIN_DATABASE_URL});await admin.connect();
const upstreamOwners=['S1','S2','S3','S4','BUSINESS_OWNER','SUPPLIED',...(await admin.query("SELECT DISTINCT writable_owner FROM finnor_os.canonical_truth_registry WHERE active")).rows.map(r=>r.writable_owner)].filter((v,i,a)=>a.indexOf(v)===i);
const initialBelief=await loadEnterpriseBeliefView(ctx,{root:obligation.intervention.targets[0]});
const historicalPolicy=JSON.parse(await readFile(join(process.env.FINNOR_S4_POLICY_STORE!,tenant,principal,'policies',obligation.policyRef.contentDigest+'.json'),'utf8'));
const {ref:historicalPolicyRef,...historicalPolicyBody}=historicalPolicy;assert.deepEqual(historicalPolicyRef,obligation.policyRef);assert.equal(hash(historicalPolicyBody),historicalPolicyRef.contentDigest);assert.equal(historicalPolicy.tenantId,tenant);assert.equal(historicalPolicy.principalId,principal);
const upstreamRights=[...new Set([obligation.rightsRef,initialBelief.rights.ref,...historicalPolicy.bindings.beliefPins.map((pin:any)=>`authority:${tenant}:${pin.rightsRevision}`)])];
const upstreamIdentities=new Map<string,{token:string;origin:ReturnType<typeof generateKeyPairSync>;tokenPath:string;originPath:string}>();
for(const owner of upstreamOwners){const key=generateKeyPairSync('ed25519'),credential=randomUUID()+randomUUID(),stem=hash(owner);
 const entry={token:credential,origin:key,tokenPath:join(root,stem+'.token'),originPath:join(root,stem+'.pem')};
 await writeFile(entry.tokenPath,credential,{mode:0o600});await writeFile(entry.originPath,key.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});upstreamIdentities.set(owner,entry);
}
const preconfiguredExperience=(await admin.query('SELECT body FROM finnor_os.s5_experience WHERE tenant_id=$1 AND principal_id=$2 ORDER BY event_id',[tenant,principal])).rows.map(r=>r.body);
const preconfiguredEventIds=new Set(preconfiguredExperience.map((event:any)=>event.eventId));
const policy={schema:'finnor.s6.ledger-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',owners:[{tokenHash:bytesHash(token),owner:'S6',tenantId:tenant,principalId:principal,rightsRefs:[obligation.rightsRef],append:true,read:true,sealedAppend:false,sealedRead:false}],signerPublicKey:pem(signer.publicKey),maxEntries:256};
policy.owners.push({...policy.owners[0]!,tokenHash:bytesHash(s5Token),owner:'S5'});
policy.owners.push({...policy.owners[0]!,tokenHash:bytesHash(businessToken),owner:'BUSINESS_OWNER'});
for(const owner of upstreamOwners)policy.owners.push({...policy.owners[0]!,tokenHash:bytesHash(upstreamIdentities.get(owner)!.token),owner,rightsRefs:upstreamRights});
const releaseBody={schema:'finnor.s6.ledger-release.v2',releaseId:'disposable-owner-transport-candidate',sourceDigests:sources,runtime:{node:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch},policyDigest:hash(policy),validUntil:new Date(Date.now()+3600000).toISOString()};
const release={...releaseBody,signature:sign(null,Buffer.from(canonical(releaseBody)),reviewer.privateKey).toString('base64')};
await writeFile(join(root,'ledger.pem'),signer.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
await writeFile(join(root,'origin.pem'),origin.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
await writeFile(join(root,'s5-origin.pem'),s5Origin.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
await writeFile(join(root,'token'),token,{mode:0o600});
await writeFile(join(root,'s5-token'),s5Token,{mode:0o600});
const ledgerConfig={policy,release,signerPath:join(root,'ledger.pem'),protectedDirectory:join(root,'protected'),contentDirectory:join(root,'ordinary'),port:0};
await writeFile(join(root,'ledger.json'),JSON.stringify(ledgerConfig),{mode:0o600});
const proxyRequests:any[]=[];
const proxy=createServer(async(req,res)=>{
 try{
  const chunks:Buffer[]=[];let size=0;for await(const raw of req){size+=raw.length;if(size>8*1024*1024)throw Error('PROXY_BYTE_BOUND');chunks.push(Buffer.from(raw));}
  const observed:any={method:req.method,path:req.url,bytes:size,bodyDigest:size?bytesHash(Buffer.concat(chunks)):null};proxyRequests.push(observed);
  const reply=await fetch(ledgerBase+(req.url??'/'),{method:req.method,headers:{authorization:req.headers.authorization??'','content-type':'application/json'},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
  const body:any=await reply.json();observed.protectedStatus=reply.status;
  if(loseRecoveryResponse&&req.method==='GET'){observed.responseLost=true;observed.protectedCheckpoint=body.receipt?.checkpointDigest??null;res.destroy();return;}
  if(tamperReadback&&req.method==='GET'&&body.receipt)body.receipt.requestDigest='0'.repeat(64);
  res.writeHead(reply.status,{'content-type':'application/json'});res.end(JSON.stringify(body));
 }catch{res.writeHead(503);res.end('{"error":"PROXY_UNAVAILABLE"}');}
});
await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
const until=new Date(Date.now()+3600000).toISOString(),after=new Date(Date.now()-1000).toISOString();
const ownerPolicy={schema:'finnor.s6.owner-transport-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',validAfter:after,validUntil:until,routes:[{...scope,rightsRefs:[obligation.rightsRef],originKeys:[{id:'disposable-origin',publicKey:pem(origin.publicKey),validAfter:after,validUntil:until,revoked:false}],originSigner:{keyId:'disposable-origin',path:join(root,'origin.pem')},tokenPath:join(root,'token'),tokenSha256:bytesHash(token),ledger:{endpoint:`http://127.0.0.1:${(proxy.address() as any).port}`,acceptedReceipts:[{signerPublicKey:pem(signer.publicKey),releaseId:releaseBody.releaseId,verifierDigest:hash(sources),policyDigest:hash(policy)}]},requestTimeoutMs:2000,leaseMs:5000}]};
ownerPolicy.routes.push({...ownerPolicy.routes[0]!,...s5Scope,originKeys:[{id:'disposable-s5-origin',publicKey:pem(s5Origin.publicKey),validAfter:after,validUntil:until,revoked:false}],originSigner:{keyId:'disposable-s5-origin',path:join(root,'s5-origin.pem')},tokenPath:join(root,'s5-token'),tokenSha256:bytesHash(s5Token)});
const ownerConfig={policy:ownerPolicy,signature:sign(null,Buffer.from(canonical(ownerPolicy)),reviewer.privateKey).toString('base64')};
await writeFile(join(root,'owner.json'),JSON.stringify(ownerConfig),{mode:0o600});
process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG=join(root,'owner.json');process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT=pem(reviewer.publicKey);
async function bootLedger(){
 let logs='';ledger=spawn(process.execPath,['--import=tsx','packages/governed-execution/src/ledger-server.mts'],{env:{PATH:process.env.PATH,HOME:root,FINNOR_S6_LEDGER_CONFIG:join(root,'ledger.json'),FINNOR_S6_LEDGER_RELEASE_ROOT:pem(reviewer.publicKey)},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('LEDGER_BOOT_TIMEOUT')),15000);ledger!.stdout!.on('data',b=>{logs+=b;for(const line of logs.split('\n'))try{const v=JSON.parse(line);if(v.status==='READY'){ledgerBase=`http://127.0.0.1:${v.port}`;clearTimeout(timer);yes();}}catch{}});ledger!.stderr!.on('data',b=>logs+=b);ledger!.once('exit',()=>{clearTimeout(timer);no(Error('LEDGER_BOOT_EXIT:'+logs));});});
}
async function stopChild(child:ChildProcess|undefined,signal:NodeJS.Signals='SIGKILL'){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('CHILD_REAP_TIMEOUT')),5000);child.once('exit',()=>{clearTimeout(timer);yes();});child.kill(signal);});
}
const sqlState=async()=> (await admin.query("SELECT o.identity,o.kind,o.payload_digest,o.envelope,o.signature,d.status,d.attempts,d.lease_until,d.last_error,d.receipt,to_jsonb(d)->>'delivery_mode' AS delivery_mode,(to_jsonb(d)->>'recovery_checks')::integer AS recovery_checks FROM finnor_os.s6_owner_delivery_origins o JOIN finnor_os.s6_owner_delivery_states d USING(tenant_id,principal_id,semantic_owner,kind,identity) WHERE o.tenant_id=$1 ORDER BY (o.semantic_owner='S6') DESC,o.created_at,o.identity",[tenant])).rows;
const rawRead=async()=>{const r=await fetch(ledgerBase+'/references/'+encodeURIComponent(obligation.ref.id),{headers:{authorization:'Bearer '+token}});return {status:r.status,body:await r.json() as any};};
async function waitNativeLeaseExpiry(){
 const deadline=Date.now()+8000;
 for(;;){
  const expired=await admin.query("SELECT lease_until<=clock_timestamp() AS expired FROM finnor_os.s6_owner_delivery_states WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='S6' AND kind='REFERENCE' AND identity=$3",[tenant,principal,obligation.ref.id]);
  if(expired.rows[0]?.expired===true)return;assert(Date.now()<deadline,'Lease did not expire');await new Promise(r=>setTimeout(r,50));
 }
}
async function startReceiptFaultWorker(){
 workerLogs='';worker=spawn(process.execPath,['--import=tsx','packages/governed-execution/src/owner-delivery-worker.mts'],{env:{PATH:process.env.PATH,HOME:root,NODE_ENV:'test',DATABASE_URL:process.env.DATABASE_URL,LOG_LEVEL:'silent',FINNOR_S6_OWNER_TRANSPORT_CONFIG:join(root,'owner.json'),FINNOR_S6_OWNER_TRANSPORT_ROOT:pem(reviewer.publicKey),FINNOR_S6_OWNER_TRANSPORT_OWNER:'S6',FINNOR_S6_OWNER_TRANSPORT_TENANT:tenant,FINNOR_S6_OWNER_TRANSPORT_PRINCIPAL:principal},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('WORKER_FAULT_BOUNDARY_NOT_REACHED')),20000);worker!.stdout!.on('data',b=>{workerLogs+=b;for(const line of workerLogs.split('\n'))try{const v=JSON.parse(line);if(v.failures?.some((f:any)=>f.code==='RECEIPT_PERSISTENCE_UNAVAILABLE')){clearTimeout(timer);yes();}}catch{}});worker!.stderr!.on('data',b=>workerLogs+=b);worker!.once('exit',()=>{clearTimeout(timer);no(Error('WORKER_EXIT_BEFORE_FAULT:'+workerLogs));});});
}
async function killAndRecordWorker(path:string){
 const before=await sqlState(),protectedRead=await rawRead(),killedPid=worker!.pid;
 const osIdentity=spawnSync('/bin/ps',['-p',String(killedPid),'-o','pid=,ppid=,pgid=,uid=,command='],{encoding:'utf8'});assert.equal(osIdentity.status,0,osIdentity.stderr);
 await stopChild(worker);const signal=worker!.signalCode;assert.equal(signal,'SIGKILL');worker=undefined;
 const evidence={before,committed:protectedRead,killedPid,osIdentity:osIdentity.stdout,signal,workerLogs,finalAttempt,exhaustRecovery,requests:structuredClone(proxyRequests)};
 await writeFile(join(output,path),JSON.stringify(evidence,null,2));return evidence;
}
async function challenge(id:string,fn:()=>Promise<any>){if(selectedCase&&id!==selectedCase)return;try{results.push({id,status:'PASS',observed:await fn()});}catch(error){results.push({id,status:'FAIL',error:error instanceof Error?{message:error.message,stack:error.stack}:String(error)});}await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.s6.owner-transport-e2e.v1',selection:manifest.selection,results,requests:proxyRequests,qualification:manifest.qualification},null,2));console.log(JSON.stringify({id,status:results.at(-1).status}));}
let firstOrigin:any,committed:any;
runPaths.push('packages/private-equity/src/enterprise-experiments.ts','packages/private-equity/src/enterprise-interventions.ts','packages/private-equity/src/enterprise-control.ts','packages/private-equity/src/native-experience-transport.ts','packages/epistemic-runtime/src/interventions.ts','packages/epistemic-runtime/src/intervention-backend.ts','packages/epistemic-runtime/src/contingent-control.ts','packages/epistemic-runtime/src/experiments.ts','packages/epistemic-runtime/src/experiment-realization.ts');
manifest.sources=await snapshot();await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
try{
 await bootLedger();
 transport=await import('../../packages/governed-execution/src/owner-transport.js');store=await import('../../packages/governed-execution/src/owner-delivery-store.js');
 await challenge('actual-native-replay-enqueues-one-authenticated-origin-without-authority',async()=>{
  transport=await import('../../packages/governed-execution/src/owner-transport.js');store=await import('../../packages/governed-execution/src/owner-delivery-store.js');
  const input={preparationRef:obligation.preparationRef,allocationRef:obligation.allocationRef,consumptionRef:obligation.consumptionRef};
  const bodies=await Promise.all(Array.from({length:8},()=>prepareEnterpriseDurableObligation(ctx,input)));assert(bodies.every(b=>hash(b)===hash(obligation)));
  const rows=(await sqlState()).filter((r:any)=>r.envelope.semanticOwner==='S6');assert.equal(rows.length,1);firstOrigin=rows[0];const envelope=firstOrigin.envelope;
  assert(verify(null,Buffer.from(canonical(envelope)),pem(origin.publicKey),Buffer.from(firstOrigin.signature,'base64')));
  assert.equal(envelope.semanticOwner,'S6');assert.equal(envelope.identity,obligation.ref.id);assert.equal(envelope.payload.reference.contentDigest,obligation.ref.contentDigest);
  const {ref,...body}=obligation;assert.deepEqual(envelope.payload.reference,{...ref,content:body});assert.equal(rows[0].receipt,null);
  assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows[0].n,1);
  return {native:obligation,rows,executionAuthorityGranted:false,semanticTruth:'UNADMITTED_PREPARED_CONTENT'};
 });
 if(!firstOrigin&&!selectedCase)throw Error('MISSING_NATIVE_OWNER_TRANSPORT_CAPABILITY');
 await challenge('ledger-commit-local-receipt-failure-SIGKILL-recovers-same-receipt',async()=>{
  const priorFailures:any[]=[];
  if(finalAttempt){
   await rename(join(root,'token'),join(root,'token.suspended'));
   try{for(let attempt=1;attempt<=63;attempt++){
    const report=await store.deliverOwnerTransportBatch(scope,{limit:1}),rows=await sqlState();
    assert.equal(report.inspected,1);assert.equal(report.accepted,0);assert.equal(rows[0].attempts,attempt);assert.equal(rows[0].status,'RETRY');assert.equal(rows[0].receipt,null);
    priorFailures.push({report,state:rows[0]});
    await admin.query("UPDATE finnor_os.s6_owner_delivery_states SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='S6' AND kind='REFERENCE' AND identity=$3",[tenant,principal,obligation.ref.id]);
   }}finally{await rename(join(root,'token.suspended'),join(root,'token'));await writeFile(join(output,'final-attempt-preparation.json'),JSON.stringify({priorFailures,fault:'DISPOSABLE_ADMIN_ADVANCES_ONLY_RETRY_DUE_TIME; ACTUAL_NATIVE_CLAIMS_AND_FAILURES',requestCount:proxyRequests.length},null,2));}
   assert.equal(proxyRequests.length,0);
  }
  await admin.query("CREATE FUNCTION finnor_os.s6_transport_e2e_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='ACCEPTED' AND NEW.tenant_id='"+tenant+"'::uuid THEN RAISE EXCEPTION 'S6_E2E_RECEIPT_PERSISTENCE_FAULT'; END IF; RETURN NEW; END $$");
  await admin.query('CREATE TRIGGER s6_transport_e2e_receipt_fault BEFORE UPDATE ON finnor_os.s6_owner_delivery_states FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_transport_e2e_receipt_fault()');triggerInstalled=true;
  await startReceiptFaultWorker();
  const crash=await killAndRecordWorker('crash-boundary.json'),{before,killedPid,osIdentity,signal}=crash;committed=crash.committed;
  assert.equal(committed.status,200);assert.equal(committed.body.receipt.sequence,1);assert.equal(before[0].receipt,null);assert.notEqual(before[0].status,'ACCEPTED');
  if(finalAttempt)assert.equal(before[0].attempts,64);
  await waitNativeLeaseExpiry();
  const recoveryFailures:any[]=[];let finalReadCrash:any=null;
  if(exhaustRecovery){
   loseRecoveryResponse=true;
   try{for(let count=1;count<=63;count++){
    const report=await store.deliverOwnerTransportBatch(scope,{limit:1}),rows=await sqlState();
    recoveryFailures.push({report,state:rows[0],requestCount:proxyRequests.length});
    await writeFile(join(output,'recovery-exhaustion-preparation.json'),JSON.stringify({recoveryFailures,requests:proxyRequests,fault:'REAL_PROTECTED_GET_RESPONSE_LOST; ADMIN_ADVANCES_ONLY_RETRY_DUE_TIME'},null,2));
    assert.equal(report.inspected,1);assert.equal(report.accepted,0);assert(report.failures.some((f:any)=>f.code==='LEDGER_TRANSPORT_UNAVAILABLE'));
    assert.equal(rows[0].status,'RETRY');assert.equal(rows[0].attempts,64);assert.equal(rows[0].delivery_mode,'RECOVERY_READ');assert.equal(rows[0].recovery_checks,count);assert.equal(rows[0].receipt,null);
    await admin.query("UPDATE finnor_os.s6_owner_delivery_states SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='S6' AND kind='REFERENCE' AND identity=$3",[tenant,principal,obligation.ref.id]);
   }}finally{loseRecoveryResponse=false;}
   await startReceiptFaultWorker();finalReadCrash=await killAndRecordWorker('recovery-crash-boundary.json');
   assert.equal(finalReadCrash.before[0].attempts,64);assert.equal(finalReadCrash.before[0].recovery_checks,64);assert.equal(finalReadCrash.before[0].status,'CLAIMED');assert.equal(finalReadCrash.before[0].receipt,null);
   assert.deepEqual(finalReadCrash.committed.body.receipt,committed.body.receipt);
   await waitNativeLeaseExpiry();
  }
  await admin.query('DROP TRIGGER s6_transport_e2e_receipt_fault ON finnor_os.s6_owner_delivery_states');await admin.query('DROP FUNCTION finnor_os.s6_transport_e2e_receipt_fault()');triggerInstalled=false;
  const requestsBeforeRecovery=proxyRequests.length,recovered=await store.deliverOwnerTransportBatch(scope,{limit:1});
  const afterRows=await sqlState(),afterRead=await rawRead();assert.deepEqual(afterRead.body.receipt,committed.body.receipt);
  if(exhaustRecovery){
   assert.equal(recovered.inspected,0);assert.equal(recovered.accepted,0);assert.equal(afterRows[0].status,'REQUIRES_OPERATOR');assert.equal(afterRows[0].last_error,'OWNER_TRANSPORT_RECOVERY_BUDGET_EXHAUSTED');assert.equal(afterRows[0].receipt,null);
   assert.equal(afterRows[0].attempts,64);assert.equal(afterRows[0].recovery_checks,64);assert.equal(proxyRequests.length,requestsBeforeRecovery);
   const later=await store.deliverOwnerTransportBatch(scope,{limit:1});assert.equal(later.inspected,0);assert.equal(proxyRequests.length,requestsBeforeRecovery);
  }else{assert.equal(recovered.accepted,1,JSON.stringify(recovered));assert.equal(afterRows[0].status,'ACCEPTED');assert.deepEqual(afterRows[0].receipt,committed.body.receipt);}
  const {ref,...body}=obligation;assert.deepEqual(afterRead.body.reference,{...ref,content:body});assert.equal(afterRead.body.receipt.sequence,1);
  if(finalAttempt){assert.equal(afterRows[0].attempts,64);assert.equal(afterRows[0].delivery_mode,'RECOVERY_READ');assert.equal(afterRows[0].recovery_checks,exhaustRecovery?64:1);assert.equal(proxyRequests.filter(r=>r.method==='POST').length,1,'Final-attempt recovery appended again');}
  return {fault:'ACTUAL_DATABASE_BEFORE_ACCEPTED_UPDATE',finalAttempt,exhaustRecovery,priorFailures,recoveryFailures,before,committed,killedPid,osIdentity,signal,workerLogs:crash.workerLogs,finalReadCrash,recovered,afterRows,afterRead};
 });
 await challenge('forged-ordinary-origin-refused-before-transport-credential-use',async()=>{
  const forged=structuredClone(firstOrigin.envelope);forged.identity='forged:'+randomUUID();forged.payload.reference.id=forged.identity;forged.payload.reference.content={attacker:'INVENTED_NATIVE_CONTENT'};forged.payload.reference.contentDigest=hash(forged.payload.reference.content);
  await admin.query('INSERT INTO finnor_os.s6_owner_delivery_origins(tenant_id,principal_id,semantic_owner,kind,identity,payload_digest,envelope,signature) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[tenant,principal,'S6','REFERENCE',forged.identity,hash(forged.payload),JSON.stringify(forged),firstOrigin.signature]);
  await admin.query("INSERT INTO finnor_os.s6_owner_delivery_states(tenant_id,principal_id,semantic_owner,kind,identity,status,attempts) VALUES($1,$2,'S6','REFERENCE',$3,'PENDING',0)",[tenant,principal,forged.identity]);
  const requestCount=proxyRequests.length;let report:any;
  await rename(join(root,'token'),join(root,'token.suspended'));
  try{
   report=await store.deliverOwnerTransportBatch(scope,{limit:1});
   await assert.rejects(()=>transport.deliverOwnerTransportIntent(scope,forged,firstOrigin.signature),{code:'OWNER_ORIGIN_SIGNATURE_INVALID'});
  }finally{await rename(join(root,'token.suspended'),join(root,'token'));}
  const rows=await sqlState();
  assert.equal(proxyRequests.length,requestCount,'Forged storage caused an authenticated transport request');assert.equal(report.accepted,0);assert(report.failures.some((f:any)=>f.code==='OWNER_ORIGIN_SIGNATURE_INVALID'));
  const rejected=rows.find((r:any)=>r.identity===forged.identity);assert.equal(rejected.status,'REFUSED_ORIGIN');assert.equal(rejected.receipt,null);assert.equal((await rawRead()).body.receipt.sequence,1);
  return {forged,report,rejected,credentialFileAbsentDuringChallenge:true,requestCountBefore:requestCount,requestCountAfter:proxyRequests.length};
 });
 await challenge('authenticated-consumer-readback-rejects-changed-receipt-and-preserves-preparation',async()=>{
  const accepted=await transport.readOwnerTransportReference(scope,obligation.ref.id);assert.deepEqual(accepted.receipt,committed.body.receipt);assert.equal(accepted.executionAuthorityGranted,false);
  tamperReadback=true;let rejected='';try{await transport.readOwnerTransportReference(scope,obligation.ref.id);}catch(e:any){rejected=e.code??e.message;}finally{tamperReadback=false;}assert.equal(rejected,'LEDGER_RECEIPT_SIGNATURE_INVALID');
  await assert.rejects(()=>transport.readOwnerTransportReference({...scope,tenantId:randomUUID()},obligation.ref.id));
  const nativeRead=await readEnterpriseDurableObligation(ctx,obligation.ref);assert.deepEqual(nativeRead,obligation);assert.equal(nativeRead.protectedReceipt,null);assert.equal(nativeRead.executionAuthorityGranted,false);
  return {accepted,rejected,nativeRead,qualification:'AUTHENTICATED_BYTES_AND_COMMITMENT_ONLY'};
 });
 await challenge('native-authenticated-API-consumes-commitment-without-authority-amplification',async()=>{
  const {POST}=await import('../../apps/api/app/api/obligations/[operation]/route.js');
  const call=async(body:any,requestedTenant=tenant)=>{
   const response=await POST(new Request('http://localhost/api/obligations/read-commitment',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':requestedTenant,'x-user-id':principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation:'read-commitment'})});
   return {status:response.status,body:await response.json() as any};
  };
  const accepted=await call({obligationRef:obligation.ref});assert.equal(accepted.status,200,JSON.stringify(accepted));assert.deepEqual(accepted.body.commitmentReceipt,committed.body.receipt);assert.equal(accepted.body.executionAuthorityGranted,false);assert.equal(accepted.body.settlementEstablished,false);
  const before=proxyRequests.length,foreign=await call({obligationRef:obligation.ref},randomUUID()),widened=await call({obligationRef:obligation.ref,executionAuthorityGranted:true});assert(foreign.status>=400);assert.equal(widened.status,400);assert.equal(proxyRequests.length,before);
  tamperReadback=true;let changed:any;try{changed=await call({obligationRef:obligation.ref});}finally{tamperReadback=false;}assert.equal(changed.status,503);assert.equal(changed.body.code,'LEDGER_RECEIPT_SIGNATURE_INVALID');
  return {accepted,foreign,widened,changed,qualification:'REAL_AUTHENTICATED_HANDLER_AND_NATIVE_OWNER; DEVELOPMENT_HEADERS; NO_BUSINESS_EXECUTION_ADMISSION'};
 });
 await challenge('genuine-S5-immutable-origins-commit-with-separate-owner-authority',async()=>{
  const proposal=(await admin.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',[tenant,principal,obligation.allocationRef.contentDigest])).rows[0];assert(proposal);
  const reservation=(await admin.query('SELECT body FROM finnor_os.s5_reservation_origins WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3',[tenant,principal,obligation.reservationRef.id])).rows[0]?.body;
  const consumption=(await admin.query('SELECT body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND consumption_id=$3',[tenant,principal,obligation.consumptionRef.id])).rows[0]?.body;
  assert(reservation&&consumption);
  const originals=[proposal.problem,proposal.certificate,reservation,consumption,...proposal.problem.resources];
  assert.equal(originals.length,5,'This declared fixture must contain one actual S5 resource');
  const nativeRead=await readEnterpriseAllocation(ctx,obligation.allocationRef);assert.deepEqual(nativeRead.certificate,proposal.certificate);assert.equal(nativeRead.executionAuthorityGranted,false);assert.equal(nativeRead.protectedReceipt,null);
  const rows=(await sqlState()).filter((r:any)=>r.envelope.semanticOwner==='S5'&&r.kind==='REFERENCE');
  await writeFile(join(output,'s5-native-issuance.json'),JSON.stringify({originals,nativeRead,rows},null,2));
  assert.equal(rows.length,originals.length,'Actual S5 owner has not issued its immutable delivery origins');
  for(const original of originals){
   const {ref,...content}=original;assert.equal(ref.owner,'S5');assert.equal(hash(content),ref.contentDigest);
   const row=rows.find((r:any)=>r.identity===ref.id);assert(row);assert.equal(row.receipt,null);
   assert.deepEqual(row.envelope.payload,{reference:{...ref,content},rightsRefs:[obligation.rightsRef]});
   assert(verify(null,Buffer.from(canonical(row.envelope)),pem(s5Origin.publicKey),Buffer.from(row.signature,'base64')));
  }
  const delivered=await store.deliverOwnerTransportBatch(s5Scope,{limit:8});assert.equal(delivered.accepted,originals.length,JSON.stringify(delivered));
  const readbacks:any[]=[];
  for(const original of originals){const {ref,...content}=original,read=await transport.readOwnerTransportReference(s5Scope,ref.id);assert.deepEqual(read.reference,{...ref,content});assert.equal(read.receipt.semanticOwner,'S5');assert.equal(read.receipt.principalId,principal);assert.equal(read.executionAuthorityGranted,false);readbacks.push(read);}
  const before=proxyRequests.length;await assert.rejects(()=>readEnterpriseAllocation({...ctx,auth:{...ctx.auth,tenantId:randomUUID()}},obligation.allocationRef));
  await rename(join(root,'s5-token'),join(root,'s5-token.suspended'));
  try{await assert.rejects(()=>transport.deliverOwnerTransportIntent(s5Scope,rows[0].envelope,firstOrigin.signature),{code:'OWNER_ORIGIN_SIGNATURE_INVALID'});}
  finally{await rename(join(root,'s5-token.suspended'),join(root,'s5-token'));}
  assert.equal(proxyRequests.length,before,'Foreign native context or cross-owner signature acquired a transport request');
  const unchanged=(await admin.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2',[tenant,obligation.allocationRef.contentDigest])).rows[0];assert.deepEqual(unchanged,proposal);
  assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows[0].n,1);
  const originalResource=originals.find((v:any)=>v.schema==='finnor.allocation-resource.v1');assert(originalResource);
  const {ref:oldResourceRef,revision:oldRevision,priorRef:oldPrior,...resourceInput}=originalResource;
  const {POST:allocationPost}=await import('../../apps/api/app/api/allocations/[operation]/route.js');
  const allocationCall=async(operation:string,body:any)=>{
   const response=await allocationPost(new Request('http://localhost/api/allocations/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':tenant,'x-user-id':principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});
   return {status:response.status,body:await response.json() as any};
  };
  const staleRevisionInput={...resourceInput,knowledgeAt:new Date().toISOString()},requestsBeforeStale=proxyRequests.length;
  const staleCreation=await allocationCall('resource',{resource:staleRevisionInput,expectedRef:oldResourceRef});
  assert.equal(staleCreation.status,409,JSON.stringify(staleCreation));assert.equal(staleCreation.body.code,'STALE_INPUT');assert.match(staleCreation.body.error,/source or rights witness/i);
  assert.equal((await sqlState()).filter((r:any)=>r.envelope.semanticOwner==='S5'&&r.kind==='REFERENCE').length,originals.length);assert.equal(proxyRequests.length,requestsBeforeStale);
  const freshS1Views=await Promise.all(Array.from(originalResource.beliefPins as any[],(pin:any)=>loadEnterpriseBeliefView(ctx,{root:pin.root,validAt:pin.validAt})));
  const revisionInput={...resourceInput,knowledgeAt:new Date().toISOString(),beliefPins:freshS1Views.map(view=>view.pin)},created=await allocationCall('resource',{resource:revisionInput,expectedRef:oldResourceRef});assert.equal(created.status,200,JSON.stringify(created));
  const revised=created.body;assert.equal(revised.revision,oldRevision+1);assert.deepEqual(revised.priorRef,oldResourceRef);assert.equal(revised.knowledgeAt,revisionInput.knowledgeAt);
  const creationOrigin=(await sqlState()).find((r:any)=>r.identity===revised.ref.id);assert(creationOrigin,'Configured native resource writer did not retain delivery before return');assert.equal(creationOrigin.status,'PENDING');assert.equal(creationOrigin.attempts,0);
  const {ref:newResourceRef,...newResourceContent}=revised;assert.equal(hash(newResourceContent),newResourceRef.contentDigest);
  assert.deepEqual(creationOrigin.envelope.payload.reference,{...newResourceRef,content:newResourceContent});assert(verify(null,Buffer.from(canonical(creationOrigin.envelope)),pem(s5Origin.publicKey),Buffer.from(creationOrigin.signature,'base64')));
  const creationDelivery=await store.deliverOwnerTransportBatch(s5Scope,{limit:8});assert.equal(creationDelivery.accepted,1,JSON.stringify(creationDelivery));
  const newProtectedRead=await transport.readOwnerTransportReference(s5Scope,newResourceRef.id),oldProtectedRead=await transport.readOwnerTransportReference(s5Scope,oldResourceRef.id);
  assert.deepEqual(newProtectedRead.reference,{...newResourceRef,content:newResourceContent});assert.deepEqual(oldProtectedRead,readbacks.find(r=>r.reference.id===oldResourceRef.id));
  const retained=(await admin.query('SELECT o.body,s.status,s.envelopes,s.revocation_reason,s.revision FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id) WHERE o.tenant_id=$1 AND o.reservation_id=$2',[tenant,obligation.reservationRef.id])).rows[0];assert(retained);assert.deepEqual(retained.body,reservation);assert.deepEqual(retained.envelopes,reservation.envelopes);assert.equal(retained.revocation_reason,'RESOURCE_REVISION_CHANGED');assert.notEqual(retained.status,'RELEASED');
  const stale=await allocationCall('validate',{allocationRef:obligation.allocationRef});assert.equal(stale.status,200,JSON.stringify(stale));assert.equal(stale.body.status,'STALE_INPUT');assert.equal(stale.body.executionAuthorityGranted,false);assert(stale.body.reasons.includes('RESOURCE_REVISION_CHANGED'));
  const creation={staleRevisionInput,staleCreation,freshS1Views,revisionInput,created,creationOrigin,creationDelivery,newProtectedRead,oldProtectedRead,retained,stale};await writeFile(join(output,'s5-configured-creation.json'),JSON.stringify(creation,null,2));
  return {originals,nativeRead,rows,delivered,readbacks,creation,credentialAbsentForCrossOwnerChallenge:true,qualification:'ACTUAL_AUTHENTICATED_S5_OWNER_IMMUTABLE_BYTE_COMMITMENTS_ONLY; NO_OPAQUE_UPSTREAM_PREIMAGE_OR_ACTUAL_CONSUMPTION_SETTLEMENT_ADMISSION'};
 });
 await challenge('native-S5-experience-retains-uncommitted-dependencies-and-original-owner-content',async()=>{
  const prepared=(await admin.query('SELECT body FROM finnor_os.s5_experience WHERE tenant_id=$1 AND principal_id=$2 ORDER BY event_id',[tenant,principal])).rows.map(r=>r.body);
  const events=prepared.filter((event:any)=>!preconfiguredEventIds.has(event.eventId)&&['REVISION','INVALIDATION'].includes(event.type));assert(events.length>=2&&events.some((event:any)=>event.type==='REVISION')&&events.some((event:any)=>event.type==='INVALIDATION'),'Configured native resource revision and allocation validation did not produce their ordinary prepared events');
  assert.deepEqual(prepared.filter((event:any)=>preconfiguredEventIds.has(event.eventId)),preconfiguredExperience,'Configured delivery changed historical prepared experience');
  const origins=(await sqlState()).filter((r:any)=>r.kind==='EVENT'&&r.envelope.semanticOwner==='S5');
  await writeFile(join(output,'s5-event-native-baseline.json'),JSON.stringify({prepared,origins},null,2));
  for(const event of events){
   const row=origins.find((r:any)=>r.identity===event.eventId);assert(row,'Actual native S5 experience writer did not retain its authenticated delivery origin');
   assert.deepEqual(row.envelope.payload,{event,references:[]});assert.equal(row.receipt,null);
   assert(verify(null,Buffer.from(canonical(row.envelope)),pem(s5Origin.publicKey),Buffer.from(row.signature,'base64')));
   assert.equal(event.protectedReceipt,null);assert.equal(event.appendAuthorityGranted,false);
  }
  const chosen=origins.find((r:any)=>r.identity===events[0].eventId)!;
  await assert.rejects(()=>transport.deliverOwnerTransportIntent(s5Scope,chosen.envelope,chosen.signature),{code:'UNCOMMITTED_OR_UNAUTHORIZED_REFERENCE'});
  const proposal=(await admin.query('SELECT problem FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2',[tenant,obligation.allocationRef.contentDigest])).rows[0].problem;
  const {ref:mandateRef,...mandateContent}=proposal.mandate;
  const utilityContent=proposal.mandate.utility;assert.equal(hash(utilityContent),proposal.mandate.utilityRef.contentDigest,'The issued utility reference does not bind the actual owner-supplied utility object');
  const dependencies=[{...mandateRef,content:mandateContent},{...proposal.mandate.utilityRef,content:utilityContent}],acceptedDependencies=[];
  for(const reference of dependencies){
   assert.equal(reference.owner,'BUSINESS_OWNER');assert.equal(hash(reference.content),reference.contentDigest);
   const response=await fetch(ledgerBase+'/references',{method:'POST',headers:{authorization:'Bearer '+businessToken,'content-type':'application/json'},body:canonical({reference,rightsRefs:[obligation.rightsRef]})});
   const answer:any=await response.json();assert.equal(response.status,200,JSON.stringify(answer));assert.equal(answer.receipt.semanticOwner,'BUSINESS_OWNER');acceptedDependencies.push(answer);
  }
  const readbacks=[];
  for(const event of events){
   const row=origins.find((r:any)=>r.identity===event.eventId)!;
   const accepted=await transport.deliverOwnerTransportIntent(s5Scope,row.envelope,row.signature),duplicate=await transport.deliverOwnerTransportIntent(s5Scope,row.envelope,row.signature),read=await transport.readOwnerTransportEvent(s5Scope,event.eventId);
   assert.deepEqual(read.event,event);assert.deepEqual(read.receipt,accepted.receipt);assert.deepEqual(duplicate.receipt,accepted.receipt);assert.equal(read.receipt.semanticOwner,'S5');assert.equal(read.receipt.protectedExecution,false);readbacks.push({event,accepted,duplicate,read});
  }
  const after=(await admin.query('SELECT body FROM finnor_os.s5_experience WHERE tenant_id=$1 AND principal_id=$2 ORDER BY event_id',[tenant,principal])).rows.map(r=>r.body);assert.deepEqual(after,prepared,'Transport rewrote original prepared owner experience');
  await new Promise(done=>setTimeout(done,1500));
  const nativeDelivery=await store.deliverOwnerTransportBatch(s5Scope,{limit:8}),finalStates=(await sqlState()).filter((r:any)=>r.kind==='EVENT'&&r.envelope.semanticOwner==='S5');
  assert.equal(nativeDelivery.accepted,events.length,JSON.stringify(nativeDelivery));assert.equal(nativeDelivery.failures.length,0);
  for(const proof of readbacks){const state=finalStates.find((r:any)=>r.identity===proof.event.eventId);assert(state);assert.equal(state.status,'ACCEPTED');assert.deepEqual(state.receipt,proof.read.receipt);}
  const liabilities=(await admin.query('SELECT status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2',[tenant,obligation.reservationRef.id])).rows[0];assert(liabilities);assert.notEqual(liabilities.status,'RELEASED');
  const proof={events,origins,dependencies,acceptedDependencies,readbacks,nativeDelivery,finalStates,preconfiguredExperience,prepared,after,liabilities,qualification:'AUTHENTICATED_PREPARED_S5_BYTES_AND_REFERENCE_ORDER_ONLY; HISTORICAL_PRECONFIGURATION_EVENTS_RETAINED_WITHOUT_RE_SIGNING; BUSINESS_OWNER_PREIMAGES_SUPPLIED_BY_SEPARATE_DISPOSABLE_TEST_AUTHORITY; NO_ECONOMIC_TRUTH_OR_RELEASE'};await writeFile(join(output,'s5-events-protected-readbacks.json'),JSON.stringify(proof,null,2));return proof;
 });
 await challenge('actual-S1-S4-native-producers-preserve-original-transport-contracts',async()=>{
  for(const owner of upstreamOwners){const identity=upstreamIdentities.get(owner)!;
   ownerPolicy.routes.push({...ownerPolicy.routes[0]!,semanticOwner:owner,rightsRefs:upstreamRights,originKeys:[{id:owner+'-native-origin',publicKey:pem(identity.origin.publicKey),validAfter:after,validUntil:until,revoked:false}],originSigner:{keyId:owner+'-native-origin',path:identity.originPath},tokenPath:identity.tokenPath,tokenSha256:bytesHash(identity.token)});
  }
  ownerConfig.signature=sign(null,Buffer.from(canonical(ownerPolicy)),reviewer.privateKey).toString('base64');await writeFile(join(root,'owner.json'),JSON.stringify(ownerConfig),{mode:0o600});
  const scopes=(owner:string)=>({...scope,semanticOwner:owner});
  const view=await loadEnterpriseBeliefView(ctx,{root:obligation.intervention.targets[0]});
  const initialOrigins=(await sqlState()).filter(r=>r.envelope.semanticOwner==='S1');
  await writeFile(join(output,'s1-native-producer-issuance.json'),JSON.stringify({view,initialOrigins},null,2));
  assert(initialOrigins.some(r=>r.identity===view.experience.event.eventId),'Actual S1 producer did not issue its original event through the authenticated outbox');
  assert.equal(view.experience.receipt,null);assert.equal(view.experience.appendAuthorityGranted,false);
  const s3=await import('../../packages/private-equity/src/enterprise-interventions.js'),s4=await import('../../packages/private-equity/src/enterprise-control.js'),s2=await import('../../packages/private-equity/src/enterprise-experiments.js');
  const policy=historicalPolicy,initialPolicyValidation=await s4.validateEnterpriseContingentPolicy(ctx,obligation.policyRef),model=await s3.readEnterpriseInterventionMetadataForObservation(ctx,policy.bindings.modelRef);
  assert.equal(initialPolicyValidation.executionAuthorityGranted,false);
  const fitted=await s3.fitEnterpriseInterventionModel(ctx,model.request);assert.equal(fitted.status,'FITTED');assert(fitted.model);assert.equal(fitted.admission.executionAuthorityGranted,false);
  const specification=(dose:number)=>({...obligation.intervention,timing:{...obligation.intervention.timing,durationMs:obligation.intervention.timing.periodMs*2},channels:obligation.intervention.channels.map((c:any)=>({...c,doses:[dose,dose]}))});
  const response=await s3.queryEnterpriseInterventionModel(ctx,{modelRef:fitted.model.ref,query:{schema:'finnor.s3.response-query.v1',id:'owner-transport-query',episodeId:'owner-transport-query',kind:'POPULATION_INTERVENTION',targets:model.request.roots,context:model.request.validity.contexts[0],regime:model.request.validity.regimes[0],horizon:2,intervention:specification(.15),comparator:specification(0),simulations:256,seed:20261002}});
  assert.equal(response.admission.executionAuthorityGranted,false);assert.equal(response.lineage.attributionGranted,false);
  const assessment=await s4.recordEnterpriseControlAssessment(ctx,{policyRef:policy.ref,type:'HUMAN_OVERRIDE',reason:'Disposable original-owner transport assertion; grants no policy change',requestedActionId:null,humanSeconds:0,evidenceRefs:[]});
  assert.equal(assessment.executionAuthorityGranted,false);assert.equal(assessment.policyChanged,false);assert.equal(assessment.protectedReceipt,null);
  const rejected=await s4.synthesizeEnterpriseControl(ctx,{mandate:policy.mandate,problem:{...policy.problem,modelRef:fitted.model.ref},protocols:[],scenarios:{pathsPerMechanism:16,seed:20261002}});
  assert.equal(rejected.policy,null,'The actual retained upstream effect must still block a new policy search');
  const supplied=new Map<string,any>();const suppliedRef=(id:string,content:any)=>{const descriptor={owner:'SUPPLIED',id:'native-s2-supplied:'+id,version:'supplied-finite-v1',contentDigest:hash(content)};supplied.set(descriptor.id,{...descriptor,content});return descriptor;};
  const end=new Date(Date.now()+600000).toISOString(),start=new Date().toISOString(),population=suppliedRef('population',{meaning:'Same disposable canonical native root',root:view.root}),instrument=suppliedRef('instrument',{meaning:'Supplied finite binary instrument, no field calibration'}),method=suppliedRef('method',{meaning:'Supplied conditional IID reference method'}),h0=suppliedRef('h0',{meaning:'Supplied H0, uncalibrated'}),h1=suppliedRef('h1',{meaning:'Supplied H1, uncalibrated'}),decision=suppliedRef('decision',{meaning:'Supplied normalized finite decision loss'});
  const request={schema:'finnor.s2.design-request.v1',inquiryId:'native-s2-transport',episodeId:'native-s2-cross-episode',mandateRef:policy.mandate.ref,decisionContext:{ref:decision,utilityRef:policy.mandate.utilityRef,horizonEnd:end,lossUnit:'normalized-loss',actionIds:['a0','a1'],lossByHypothesis:[['0','1'],['1','0']]},hypotheses:[{ref:h0,prior:'0.5',meaning:'Supplied H0'},{ref:h1,prior:'0.5',meaning:'Supplied H1'}],requiredClaimRefs:[],validUntil:end,maxBeliefAgeMs:3600000,constraints:{maxSamples:24,maxElapsedMs:3600000,maxExposureUnits:'24',maxPrivacyUnits:'0',moneyLimit:{value:'0',unit:'USD'},permittedPopulationRefs:[population],permittedInstrumentRefs:[instrument]},candidates:[{id:'informative',instrumentRef:instrument,endpoint:{id:'binary',unit:'category',categories:['negative','positive']},populationRef:population,measurementUnit:'independent-item',assignment:{kind:'OBSERVATIONAL',unit:'independent-item',probability:'1'},timing:{startAt:start,endAt:end,minimumIntervalMs:0},process:{methodRef:method,instrumentError:'IN_LIKELIHOOD',missingness:'NONE',dependence:'CONDITIONAL_IID',interference:'NONE',reactivity:'NONE',nuisance:'FIXED_SUPPLIED'},likelihood:{status:'SUPPLIED_CONDITIONAL',probabilities:[['0.8','0.2'],['0.2','0.8']],calibrationRef:null,assumptions:['Supplied local law; no field calibration']},samples:8,stopping:{method:'FIXED_SAMPLE',alpha:'0.05',beta:'0.05',minimumPower:'0'},costEstimate:{money:{value:'0',unit:'USD'},elapsedMs:100,humanSeconds:0,dataBytes:1024,integrationUnits:0,computeMs:null},exposure:{unitsPerSample:'1',privacyUnitsPerSample:'0',riskAssumptions:['Disposable supplied input']}}]};
  const {withTenantTransaction}=await import('@finnor/db');await withTenantTransaction(tenant,{userId:principal},async(_db,c)=>{for(const reference of supplied.values())await store.enqueueOwnerDeliveryInTransaction(c,scopes('SUPPLIED'),{kind:'REFERENCE',identity:reference.id,payload:{reference,rightsRefs:[view.rights.ref]}});});
  const design=await s2.designEnterpriseExperiments(ctx,{root:view.root as any,request}),protocol=design.designs[0]!.protocol!;assert(protocol);assert.equal(protocol.admission.executionAuthorityGranted,false);
  const realized=await s2.projectEnterpriseExperiment(ctx,{protocol,events:[]});assert.equal(realized.realization.admission.executionAuthorityGranted,false);
  const deliveries:any[]=[];const order=[...upstreamOwners.filter(o=>!/^S[1-4]$/.test(o)&&o!=='SUPPLIED'),'S1','S3','S4','SUPPLIED','S2'];
  const drain=async()=>{for(let round=0;round<4;round++){for(const owner of order)deliveries.push({owner,round,...await store.deliverOwnerTransportBatch(scopes(owner),{limit:32})});await new Promise(done=>setTimeout(done,1100));}};
  await drain();
  const expected=[view.experience.event,...fitted.experience,...response.experience,assessment.event,...rejected.experience,...design.experience,...realized.realization.experience];
  const readbacks:any[]=[];for(const event of expected){const nativeRow=(await sqlState()).find(r=>r.identity===event.eventId);assert(nativeRow,'Native owner did not retain event '+event.eventId);assert.equal(nativeRow.status,'ACCEPTED',JSON.stringify({event:nativeRow.identity,error:nativeRow.last_error,deliveries}));const accepted=await transport.readOwnerTransportEvent(scopes(event.semanticOwner),event.eventId);assert.deepEqual(accepted.event,event);assert.equal(accepted.receipt.semanticOwner,event.semanticOwner);assert.equal(accepted.receipt.protectedExecution,false);readbacks.push(accepted);}
  const provenance:any[]=[];for(const claim of view.claims){const read=await transport.readOwnerTransportReference(scopes('S1'),claim.ownerRef.revisionId);assert.equal(read.reference.owner,claim.ownerRef.owner);assert.equal(read.reference.contentDigest,claim.ownerRef.contentDigest);provenance.push({claim:claim.ownerRef,reference:read.reference,receipt:read.receipt});}
  const s2Origin=(await sqlState()).find(r=>r.identity===protocol.experience.event.eventId);assert(s2Origin);const parent=await transport.readOwnerTransportEvent(scopes('S2'),protocol.experience.event.preparedParentRefs[0]!);assert.notEqual(parent.event.episodeId,protocol.episodeId);assert(s2Origin.receipt.parentCheckpoints.includes(parent.receipt.checkpointDigest));
  const forged:any=structuredClone(protocol.experience.event);forged.causalParents=[parent.event.eventId];const {eventId,...body}=forged;forged.eventId='s2-event:'+hash(body);
  const rejectedParent=await fetch(ledgerBase+'/append',{method:'POST',headers:{authorization:'Bearer '+upstreamIdentities.get('S2')!.token,'content-type':'application/json'},body:JSON.stringify({event:forged,parents:[parent.receipt],references:[]})});assert.equal(rejectedParent.status,409,'Cross-episode causal parent was accepted');
  const measured=view.claims.find(c=>c.ownerRef.entityType==='pe_metric_observation')!;const original=measured.exactSnapshotJson;assert(original);
  await admin.query('UPDATE finnor_os.pe_metric_observations SET superseded_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2',[tenant,measured.ownerRef.id]);
  const {validateBeliefViewPin}=await import('../../packages/private-equity/src/enterprise-beliefs.js');const invalidS1=await validateBeliefViewPin(ctx,view.pin),invalidS2=await s2.validateEnterpriseExperiment(ctx,protocol),invalidS3=await s3.validateEnterpriseInterventionModel(ctx,fitted.model.ref),invalidS4=await s4.validateEnterpriseContingentPolicy(ctx,policy.ref);assert.equal(invalidS1.status,'INVALIDATED');assert.equal(invalidS2.status,'INVALIDATED');assert.equal(invalidS3.status,'INVALIDATED');assert.equal(invalidS4.status,'STALE_INPUT');
  await drain();const invalidRows=(await sqlState()).filter(r=>['BELIEF_INVALIDATION','INVALIDATION','VALIDITY_CHANGE'].includes(r.envelope.payload.event?.type)&&/^S[1-4]$/.test(r.envelope.semanticOwner));assert(new Set(invalidRows.filter(r=>r.status==='ACCEPTED').map(r=>r.envelope.semanticOwner)).size===4,JSON.stringify(invalidRows.map(r=>({owner:r.envelope.semanticOwner,status:r.status,error:r.last_error}))));
  for(const proof of provenance){const read=await transport.readOwnerTransportReference(scopes('S1'),proof.claim.revisionId);assert.deepEqual(read.reference,proof.reference);}
  const evidence={view,fitted,response,policy,initialPolicyValidation,assessment,rejected,request,design,realized,deliveries,readbacks,provenance,crossEpisodeParent:parent,rejectedCausalStatus:rejectedParent.status,invalidS1,invalidS2,invalidS3,invalidS4,invalidRows,qualification:'ACTUAL_NATIVE_S1_S4_PRODUCERS_AND_EXACT_AUTHENTICATED_BYTE_READBACK; ORIGINAL_POLICY_WITNESS_CAN_ALREADY_BE_REVOKED_BY_NATIVE_INPUT_CORPUS; HISTORICAL_BYTES_DO_NOT_GAIN_CURRENT_AUTHORITY; SUPPLIED_S2_INSTRUMENT_LAW_UNCALIBRATED; ORIGINAL_UNADMITTED_FIELDS_UNCHANGED; NO_BUSINESS_EXECUTION_OR_SCIENTIFIC_PROMOTION'};await writeFile(join(output,'native-upstream-transport.json'),JSON.stringify(evidence,null,2));return evidence;
 });
}catch(error){results.push({id:'runner-boundary',status:'FAIL',error:String(error)});process.exitCode=1;}
finally{
 await stopChild(worker);await stopChild(ledger);await new Promise<void>(done=>proxy.close(()=>done()));
 if(triggerInstalled){await admin.query('DROP TRIGGER IF EXISTS s6_transport_e2e_receipt_fault ON finnor_os.s6_owner_delivery_states');await admin.query('DROP FUNCTION IF EXISTS finnor_os.s6_transport_e2e_receipt_fault()');}
 await admin.end();await closePool();
 await writeFile(join(output,'worker.log'),workerLogs);await writeFile(join(output,'test-authority.json'),JSON.stringify({ownerConfig,release,publicLedgerKey:pem(signer.publicKey),reviewerRoot:pem(reviewer.publicKey),root,qualification:'DISPOSABLE_TEST_AUTHORITY_ONLY; PRIVATE_KEYS_AND_TOKENS_NOT_IN_EVIDENCE'},null,2));
 manifest.finishedAt=new Date().toISOString();manifest.sourcesUnchanged=hash(await snapshot())===hash(manifest.sources);manifest.rerun='NODE_ENV=test CI=1 AUTH_DEV_BYPASS=1 LOG_LEVEL=silent DATABASE_URL=<ordinary-disposable-role> FINNOR_S6_ADMIN_DATABASE_URL=<disposable-admin> FINNOR_S6_NATIVE_OBLIGATION_RESULTS=<fresh-native-results> FINNOR_S6_OWNER_EVIDENCE_DIR=<new-directory> node --import=tsx scripts/s6/run-owner-transport-e2e.mts'+(exhaustRecovery?' --exhaust-recovery':finalAttempt?' --final-attempt':'');
 manifest.resources.supervisorFinish=process.resourceUsage();
 await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.s6.owner-transport-e2e.v1',results,requests:proxyRequests,qualification:manifest.qualification},null,2));
 if(!manifest.sourcesUnchanged||results.some(r=>r.status!=='PASS')||results.length!==(selectedCase?1:8))process.exitCode=1;
 console.log(JSON.stringify({output,sourcesUnchanged:manifest.sourcesUnchanged,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length}));
}
