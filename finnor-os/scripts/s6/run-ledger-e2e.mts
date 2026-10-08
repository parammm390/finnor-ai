import {createBeliefView} from '../../packages/epistemic-runtime/src/belief-view.js';
import {prepareS2ExperienceEvent} from '../../packages/epistemic-runtime/src/experiments.js';
/** Preregistered separate-process ledger contracts. Inputs never contain receipts. */
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';

const output = resolve(process.env.FINNOR_S6_LEDGER_EVIDENCE_DIR ?? `../scope-6/scope-evidence/ledger-${Date.now()}`);
await mkdir(output,{recursive:true});
const root = await realpath(await mkdtemp(join(tmpdir(),'finnor-ledger-e2e-')));
const canonical = (v:any):string => v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort((a,b)=>a.localeCompare(b)).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest = (v:any) => createHash('sha256').update(canonical(v)).digest('hex');
const results:any[]=[]; let processHandle:ChildProcess|undefined; let base=''; let logs='';
const tenant=randomUUID(),principal=randomUUID(),token=randomUUID()+randomUUID(),evaluatorToken=randomUUID()+randomUUID(),rights='test-owner-rights',s1Token=randomUUID()+randomUUID(),s1Rights=`authority:${tenant}:1`;
const signer=generateKeyPairSync('ed25519'),reviewer=generateKeyPairSync('ed25519');
const witnessSigner=generateKeyPairSync('ed25519'),ledgerId=randomUUID();
const witnessModePath=join(root,'witness-mode.json'),witnessHeadPath=join(root,'witness-head.json'),witnessTranscriptPath=join(root,'witness-transcript.jsonl');
await writeFile(witnessModePath,JSON.stringify({mode:'NORMAL'}),{mode:0o600});
await writeFile(join(root,'witness-signer.pem'),witnessSigner.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
const ledgerSignerDigest=digest(signer.publicKey.export({type:'spki',format:'pem'}).toString());
await writeFile(join(root,'witness-config.json'),JSON.stringify({ledgerId,signerDigest:ledgerSignerDigest,ledgerPublicKey:signer.publicKey.export({type:'spki',format:'pem'}).toString(),signerPath:join(root,'witness-signer.pem'),modePath:witnessModePath,headPath:witnessHeadPath,transcriptPath:witnessTranscriptPath}),{mode:0o600});
const witnessProcess=spawn(process.execPath,['--import=tsx','scripts/s6/monotonic-witness-fixture.mts',join(root,'witness-config.json')],{stdio:['ignore','pipe','pipe']});
let witnessLogs='';witnessProcess.stderr!.on('data',b=>witnessLogs+=b.toString());
const witnessEndpoint=await new Promise<string>((yes,no)=>{const timer=setTimeout(()=>no(Error('WITNESS_BOOT_TIMEOUT')),15000);witnessProcess.stdout!.on('data',b=>{witnessLogs+=b.toString();for(const line of witnessLogs.split('\n'))try{const row=JSON.parse(line);if(row.status==='READY'){clearTimeout(timer);yes(`http://127.0.0.1:${row.port}`);}}catch{}});witnessProcess.once('exit',(code,signal)=>{clearTimeout(timer);no(Error(`WITNESS_BOOT_EXIT:${code}:${signal}:${witnessLogs}`));});});
const methodIssuer=generateKeyPairSync('ed25519'),s6Token=randomUUID()+randomUUID();
const s2Token=randomUUID()+randomUUID();
const nativeResults=process.env.FINNOR_S6_NATIVE_OBLIGATION_RESULTS?JSON.parse(await readFile(process.env.FINNOR_S6_NATIVE_OBLIGATION_RESULTS,'utf8')):null;
const nativeObligation=nativeResults?.results.find((r:any)=>r.id==='actual-upstream-handoff-and-one-native-responsibility'&&r.status==='PASS')?.observed.obligation;
assert(nativeObligation,'Full ledger qualification requires FINNOR_S6_NATIVE_OBLIGATION_RESULTS from a successful native-owner run');
const publicKey=signer.publicKey.export({type:'spki',format:'pem'}).toString(),reviewerPublic=reviewer.publicKey.export({type:'spki',format:'pem'}).toString();
const fsExtDirectory=dirname(createRequire(import.meta.url).resolve('fs-ext/package.json'));
const sourcePaths=['packages/governed-execution/src/ledger.ts','packages/governed-execution/src/ledger-server.mts','packages/governed-execution/src/protocol.ts','packages/governed-execution/src/request-verifier.ts','packages/governed-execution/src/adapter-contract.ts',join(fsExtDirectory,'fs-ext.js'),join(fsExtDirectory,'build/Release/fs_ext.node'),join(fsExtDirectory,'package.json')];
const sourceDigests=await Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(path))).digest('hex')})));
const runSourcePaths=[...sourcePaths,'packages/governed-execution/src/owner-transport.ts','packages/epistemic-runtime/src/belief-view.ts','packages/epistemic-runtime/src/experiments.ts','packages/orchestration/src/request-compiler.ts','packages/private-equity/src/enterprise-obligations.ts','packages/private-equity/src/obligation-contracts.ts','packages/shared-types/src/durable-obligations.ts','apps/api/app/api/obligations/[operation]/route.ts','scripts/s6/run-ledger-e2e.mts','package-lock.json','tsconfig.base.json'];
runSourcePaths.push('scripts/s6/monotonic-witness-fixture.mts');
const snapshot=async()=>Promise.all(runSourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(path))).digest('hex')})));
const manifest:any={schema:'finnor.s6.protected-boundary-run.v1',startedAt:new Date().toISOString(),sourceDigests:await snapshot(),command:process.argv,cwd:process.cwd(),node:process.version,versions:process.versions,configuration:{NODE_ENV:process.env.NODE_ENV,AUTH_DEV_BYPASS:process.env.AUTH_DEV_BYPASS,FINNOR_TEST_MANAGED_EXTENSIONS:process.env.FINNOR_TEST_MANAGED_EXTENSIONS},nativeOwnerInput:process.env.FINNOR_S6_NATIVE_OBLIGATION_RESULTS?{path:resolve(process.env.FINNOR_S6_NATIVE_OBLIGATION_RESULTS),sha256:createHash('sha256').update(await readFile(process.env.FINNOR_S6_NATIVE_OBLIGATION_RESULTS)).digest('hex')}:null,qualification:'DISPOSABLE_TEST_AUTHORITY; LOCAL_SEPARATE_PROCESS; NO_INDEPENDENT_PRODUCTION_ADMISSION_OR_EGRESS'};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const policy={schema:'finnor.s6.ledger-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',owners:[{tokenHash:createHash('sha256').update(token).digest('hex'),owner:'S5',tenantId:tenant,principalId:principal,rightsRefs:[rights],append:true,read:true,sealedAppend:false,sealedRead:false},{tokenHash:createHash('sha256').update(evaluatorToken).digest('hex'),owner:'S5',tenantId:tenant,principalId:principal,rightsRefs:[rights],append:true,read:true,sealedAppend:true,sealedRead:true},{tokenHash:createHash('sha256').update(s1Token).digest('hex'),owner:'S1',tenantId:tenant,principalId:principal,rightsRefs:[s1Rights],append:true,read:true,sealedAppend:false,sealedRead:false}],signerPublicKey:publicKey,maxEntries:100000};
Object.assign(policy,{witness:{schema:'finnor.s6.monotonic-witness-binding.v1',ledgerId,endpoint:witnessEndpoint,publicKey:witnessSigner.publicKey.export({type:'spki',format:'pem'}).toString(),timeoutMs:5000}});
Object.assign(policy,{methodAdmissionPublicKey:methodIssuer.publicKey.export({type:'spki',format:'pem'}).toString()});
policy.owners.push({tokenHash:createHash('sha256').update(s2Token).digest('hex'),owner:'S2',tenantId:tenant,principalId:principal,rightsRefs:[rights],append:true,read:true,sealedAppend:false,sealedRead:false});
if(nativeObligation)policy.owners.push({tokenHash:createHash('sha256').update(s6Token).digest('hex'),owner:'S6',tenantId:nativeObligation.tenantId,principalId:nativeObligation.principalId,rightsRefs:[nativeObligation.rightsRef],append:true,read:true,sealedAppend:false,sealedRead:false});
const releaseBody={schema:'finnor.s6.ledger-release.v2',releaseId:'test-reviewed-candidate',sourceDigests,runtime:{node:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch},policyDigest:digest(policy),validUntil:new Date(Date.now()+3600000).toISOString()};
const release={...releaseBody,signature:sign(null,Buffer.from(canonical(releaseBody)),reviewer.privateKey).toString('base64')};
await writeFile(join(root,'signer.pem'),signer.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
const config:any={policy,release,reviewerPublicKey:reviewerPublic,signerPath:join(root,'signer.pem'),protectedDirectory:join(root,'protected'),contentDirectory:join(root,'ordinary'),port:0};
await writeFile(join(root,'sealed.key'),createHash('sha256').update(randomUUID()).digest(),{mode:0o600});
config.sealedEncryptionKeyPath=join(root,'sealed.key');
await writeFile(join(root,'config.json'),JSON.stringify(config),{mode:0o600});
async function start(){
  logs='';processHandle=spawn(process.execPath,['--import=tsx','packages/governed-execution/src/ledger-server.mts'],{cwd:process.cwd(),env:{PATH:process.env.PATH!,HOME:root,FINNOR_S6_LEDGER_CONFIG:join(root,'config.json'),FINNOR_S6_LEDGER_RELEASE_ROOT:reviewerPublic},stdio:['ignore','pipe','pipe']});
  return new Promise<void>((yes,no)=>{const timeout=setTimeout(()=>{processHandle?.kill('SIGKILL');no(Error('BOOT_TIMEOUT'));},15000);processHandle!.stdout!.on('data',b=>{logs+=b.toString();for(const line of logs.split('\n'))try{const v=JSON.parse(line);if(v.status==='READY'){base=`http://127.0.0.1:${v.port}`;clearTimeout(timeout);yes();}}catch{}});processHandle!.stderr!.on('data',b=>logs+=b.toString());processHandle!.once('exit',(code,signal)=>{clearTimeout(timeout);no(Error(`BOOT_EXIT:${code}:${signal}:${logs}`));});});
}
async function stop(signal:NodeJS.Signals='SIGTERM'){const p=processHandle;if(!p||p.exitCode!==null)return;await new Promise<void>(done=>{p.once('exit',()=>done());p.kill(signal);});processHandle=undefined;}
async function call(path:string,body?:any,credential=token){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any};}
function event(n:number):any{const detail={quantity:String(n),unit:'test-unit',cost:'UNMETERED_TEST_INPUT'};const body={schema:'finnor.s5.experience.v1',semanticOwner:'S5',episodeId:'ledger-test',type:'COST',tenantId:tenant,principalId:principal,rightsRef:rights,revisionRef:`cost:${n}`,contentDigest:digest(detail),knowledgeAt:new Date(Date.now()-1000).toISOString(),validAt:new Date().toISOString(),preparedParentRefs:[],causalParents:[],dependencyRefs:[],horizon:'H0',uncertainty:'MODEL_CONDITIONAL_UNADMITTED',detail,protectedReceipt:null,appendAuthorityGranted:false};return {...body,eventId:`s5-event:${digest(body)}`};}
function request(e:any,parents:any[]=[]){return {event:e,parents,references:[{id:e.revisionRef,owner:'S5',version:'test-cost-v1',contentDigest:digest(e.detail),content:e.detail}]};}
async function challenge(id:string,fn:()=>Promise<any>){try{results.push({id,status:'PASS',observed:await fn()});}catch(error){results.push({id,status:'FAIL',error:error instanceof Error?{message:error.message,stack:error.stack}:String(error)});}await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.s6.ledger-e2e.v1',results,sourceDigests,node:process.version,domain:'DISPOSABLE_TEST_AUTHORITY',qualification:'Separate local process; protected files share host OS identity. No production admission or business truth.',rerun:'node --import=tsx scripts/s6/run-ledger-e2e.mts'},null,2)+'\n');console.log(JSON.stringify(results.at(-1)));}
let first:any,initialHistory:{journal:Buffer;head:Buffer};
async function readThroughOwnerTransport(owner:string,id:string,credential:string,ownerRights:string){
 const tokenPath=join(root,owner+'-read.token');await writeFile(tokenPath,credential,{mode:0o600});
 const readPolicy={schema:'finnor.s6.owner-transport-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',validAfter:new Date(Date.now()-1000).toISOString(),validUntil:releaseBody.validUntil,routes:[{semanticOwner:owner,tenantId:tenant,principalId:principal,rightsRefs:[ownerRights],originKeys:[{id:'readback-test',publicKey,validAfter:new Date(Date.now()-1000).toISOString(),validUntil:releaseBody.validUntil,revoked:false}],tokenPath,tokenSha256:createHash('sha256').update(credential).digest('hex'),ledger:{endpoint:base,acceptedReceipts:[{signerPublicKey:publicKey,releaseId:releaseBody.releaseId,verifierDigest:digest(sourceDigests),policyDigest:digest(policy)}]},requestTimeoutMs:10000,leaseMs:30000}]};
 const path=join(root,'owner-read.json');await writeFile(path,JSON.stringify({policy:readPolicy,signature:sign(null,Buffer.from(canonical(readPolicy)),reviewer.privateKey).toString('base64')}),{mode:0o600});process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG=path;process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT=reviewerPublic;
 return (await import('../../packages/governed-execution/src/owner-transport.js')).readOwnerTransportEvent({semanticOwner:owner,tenantId:tenant,principalId:principal},id);
}
let requestProposal:any,methodAdmission:any,obligationReceipt:any;
try{
 await start();
 await challenge('authenticated-immutable-append-and-independent-signature',async()=>{const input=event(1);const r=await call('/append',request(input));assert.equal(r.status,200,JSON.stringify(r));const {signature,...body}=r.body.receipt;assert(verify(null,Buffer.from(canonical(body)),publicKey,Buffer.from(signature,'base64')));assert.equal(body.eventDigest,digest(input));assert.equal(body.eventId,input.eventId);assert.equal(body.sequence,1);assert.equal(input.protectedReceipt,null);first={input,receipt:r.body.receipt};return first;});
 initialHistory={journal:await readFile(join(config.protectedDirectory,'commitments.jsonl')),head:await readFile(join(config.protectedDirectory,'head.json'))};
 await challenge('concurrent-retry-and-changed-content',async()=>{assert(first);const replies=await Promise.all(Array.from({length:40},()=>call('/append',request(first.input))));assert(replies.every(r=>r.status===200));assert(replies.every(r=>digest(r.body.receipt)===digest(first.receipt)));const bad=structuredClone(first.input);bad.detail.quantity='900';const rejected=await call('/append',request(bad));assert.equal(rejected.status,409);return {acceptedSequences:replies.map(r=>r.body.receipt.sequence),rejected};});
 await challenge('typed-detail-digest-cannot-borrow-canonical-revision-preimage',async()=>{
  const prepared=event(9100),subject={schema:'finnor.s6.test-subject.v1',revision:1,meaning:'Separate canonical subject; synthetic authenticated byte-contract fixture'};
  const input={event:prepared,parents:[],references:[{id:prepared.revisionRef,owner:'S5',version:'test-subject-v1',contentDigest:digest(subject),content:subject}]};
  assert.notEqual(prepared.contentDigest,digest(subject));
  const accepted=await call('/append',input);assert.equal(accepted.status,200,JSON.stringify(accepted));
  const before=await call('/health');assert.equal(before.status,200);
  const changed=structuredClone(input);changed.event.detail.quantity='910099';changed.event.contentDigest=digest(subject);
  const {eventId:oldIdentity,...changedBody}=changed.event;changed.event.eventId=`s5-event:${digest(changedBody)}`;
  const rejected=await call('/append',changed),after=await call('/health');
  const evidence={input,accepted,changed,rejected,before,after,qualification:'SYNTHETIC_TYPED_S5_BYTE_CONTRACT; ACTUAL_AUTHENTICATED_SEPARATE_PROCESS_APPEND; NO_NATIVE_BUSINESS_SETTLEMENT'};
  await writeFile(join(output,'typed-detail-digest.json'),JSON.stringify(evidence,null,2)+'\n');
  assert.equal(rejected.status,409,JSON.stringify(evidence));assert.equal(rejected.body.error,'EVENT_CONTENT_PREIMAGE_INVALID');assert.equal(after.body.sequence,before.body.sequence);
  return evidence;
 });
 await challenge('forged-tenant-owner-and-evaluator-seal',async()=>{const wrong=event(2);wrong.tenantId=randomUUID();const foreign=await call('/append',request(wrong));assert.equal(foreign.status,403);const seal=await call('/append',{...request(event(3)),sealed:true});assert.equal(seal.status,403);const unknown=await call('/append',request(event(4)),'hostile-token');assert.equal(unknown.status,401);return {foreign,seal,unknown};});
 await challenge('typed-causal-parent-cannot-smuggle-order-claims',async()=>{const e=event(9001);e.preparedParentRefs=[first.input.eventId];e.causalParents=[{eventId:first.input.eventId,sequence:first.receipt.sequence+99,checkpointDigest:'0'.repeat(64)}];const {eventId,...body}=e;e.eventId=`s5-event:${digest(body)}`;const rejected=await call('/append',request(e,[first.receipt]));assert.equal(rejected.status,400,JSON.stringify(rejected));return {input:e,parentReceipt:first.receipt,rejected};});
 await challenge('typed-parent-arrays-cannot-be-omitted',async()=>{const e=event(9002);delete e.causalParents;delete e.preparedParentRefs;const {eventId,...body}=e;e.eventId=`s5-event:${digest(body)}`;const rejected=await call('/append',request(e));assert.equal(rejected.status,400,JSON.stringify(rejected));return {input:e,rejected};});
 await challenge('forged-parent-and-exact-reference-order',async()=>{const e=event(5);e.preparedParentRefs=[first.input.eventId];const {eventId,...body}=e;e.eventId=`s5-event:${digest(body)}`;const forged=structuredClone(first.receipt);forged.sequence=900;const denied=await call('/append',request(e,[forged]));assert.equal(denied.status,409);const accepted=await call('/append',request(e,[first.receipt]));assert.equal(accepted.status,200,JSON.stringify(accepted));return {denied,accepted};});
 await challenge('unknown-reference-and-content-preimage',async()=>{const absent=event(7);absent.dependencyRefs=['missing-authoritative-source'];const {eventId,...body}=absent;absent.eventId=`s5-event:${digest(body)}`;const denied=await call('/append',request(absent));assert.equal(denied.status,409);const invalid=request(event(8));invalid.references[0]!.content={quantity:'FORGED'};const corrupt=await call('/append',invalid);assert.equal(corrupt.status,409);return {denied,corrupt};});
 await challenge('sealed-evaluator-read-and-encrypted-ordinary-content',async()=>{const e=event(9);const accepted=await call('/append',{...request(e),sealed:true},evaluatorToken);assert.equal(accepted.status,200,JSON.stringify(accepted));const normal=await call('/events/'+encodeURIComponent(e.eventId));assert.equal(normal.status,403);const evaluator=await call('/events/'+encodeURIComponent(e.eventId),undefined,evaluatorToken);assert.equal(evaluator.status,200);assert.equal(digest(evaluator.body.event),digest(e));const contents=await Promise.all((await readdir(config.contentDirectory)).map(f=>readFile(join(config.contentDirectory,f),'utf8')));assert(!contents.some(c=>c.includes(e.eventId)));return {accepted,normal,evaluator};});
 await challenge('bounded-distinct-concurrency',async()=>{const before=Date.now();const replies=await Promise.all(Array.from({length:128},(_,n)=>call('/append',request(event(100+n)))));assert(replies.every(r=>r.status===200),JSON.stringify(replies.filter(r=>r.status!==200)));assert.equal(new Set(replies.map(r=>r.body.receipt.sequence)).size,128);const elapsedMs=Date.now()-before;assert(elapsedMs<30000);return {count:128,elapsedMs,sequences:replies.map(r=>r.body.receipt.sequence)};});
 await challenge('actual-s1-prepared-envelope-preserves-qualification',async()=>{const now=new Date().toISOString();const view=createBeliefView({tenantId:tenant,principalId:principal,root:{entityType:'external_organization',entityId:randomUUID()},validAt:now,knowledgeAt:now,rightsRevision:1,rightsEvaluatedAt:now,claims:[],sourceCuts:[],dependencyRefs:[],episodeId:'ledger-test',coverage:{status:'COMPLETE',canonicalStatus:'COMPLETE',absenceClaimsPermitted:false,omittedScope:[],reasons:['EMPTY_DISPOSABLE_OWNER_INPUT'],truncated:false}});const {evaluatedAt,...normalizedRights}=view.rights;const content={schema:view.schema,semanticOwner:view.semanticOwner,interpretationVersion:view.interpretationVersion,tenantId:view.tenantId,principalId:view.principalId,root:view.root,validAt:view.validAt,knowledgeAt:view.knowledgeAt,rights:normalizedRights,sourceCuts:view.sourceCuts,claims:view.claims,contradictions:view.contradictions,coverage:view.coverage,dependencyDigest:view.dependencyDigest,resolution:view.resolution};const e=view.experience.event;assert.equal(digest(content),e.contentDigest);const accepted=await call('/append',{event:e,parents:[],references:[{id:e.revisionRef,owner:'S1',version:view.interpretationVersion,contentDigest:e.contentDigest,content},{id:e.freshnessRef,owner:'S1',version:'source-cut-v1',contentDigest:digest(view.sourceCuts),content:view.sourceCuts}]},s1Token);assert.equal(accepted.status,200,JSON.stringify(accepted));assert.equal(view.experience.receipt,null);assert.equal(view.experience.appendAuthorityGranted,false);assert.equal(accepted.body.receipt.semanticOwner,'S1');return {prepared:view.experience,accepted};});
 await challenge('typed-S1-S2-consumer-readback-preserves-view-and-protocol-digests',async()=>{
  const s1=results.find(row=>row.id==='actual-s1-prepared-envelope-preserves-qualification'&&row.status==='PASS')?.observed;assert(s1,'Actual prepared S1 event is required');
  const s1Read=await readThroughOwnerTransport('S1',s1.prepared.event.eventId,s1Token,s1Rights);assert.deepEqual(s1Read.event,s1.prepared.event);assert.deepEqual(s1Read.receipt,s1.accepted.body.receipt);assert.equal(s1Read.event.detail,undefined);
  const now=new Date().toISOString(),content={schema:'finnor.s2.test-protocol-content.v1',meaning:'Synthetic canonical protocol preimage; no native design or scientific admission'},reference={id:'typed-s2-protocol:'+digest(content),owner:'S2',version:'test-protocol-v1',contentDigest:digest(content),content};
  const prepared=prepareS2ExperienceEvent({schema:'finnor.s2.experience.v1',semanticOwner:'S2',episodeId:'ledger-test',type:'PROPOSAL',tenantId:tenant,principalId:principal,rightsRef:rights,preparedParentRefs:[],causalParents:[],revisionRef:reference.id,contentDigest:reference.contentDigest,validAt:now,knowledgeAt:now,dependencyRefs:[],freshnessRef:reference.id,uncertainty:'MODEL_CONDITIONAL_NO_FIELD_CALIBRATION',horizon:'H1',provenanceRefs:[],modelComputeRef:null,detail:{selection:'SUPPLIED_UNADMITTED'}});
  assert.notEqual(digest(prepared.detail),prepared.contentDigest);const accepted=await call('/append',{event:prepared,parents:[],references:[reference]},s2Token);assert.equal(accepted.status,200,JSON.stringify(accepted));
  const s2Read=await readThroughOwnerTransport('S2',prepared.eventId,s2Token,rights);assert.deepEqual(s2Read.event,prepared);assert.deepEqual(s2Read.receipt,accepted.body.receipt);assert.equal(s2Read.receipt.protectedExecution,false);
  const proof={s1,s1Read,reference,prepared,accepted,s2Read,qualification:'ACTUAL_S1_PREPARATION_AND_SYNTHETIC_TYPED_S2_EVENT; ACTUAL_SEPARATE_PROCESS_AUTHENTICATED_APPEND_AND_CONSUMER; NO_NATIVE_S2_DESIGN_OR_SCIENTIFIC_ADMISSION'};await writeFile(join(output,'typed-s1-s2-readback.json'),JSON.stringify(proof,null,2)+'\n');return proof;
 });
 await challenge('actual-obligation-request-independent-method-verification',async()=>{
  assert(nativeObligation,'Actual owner obligation evidence is required');
  const {ref,...content}=nativeObligation;const registered=await call('/references',{reference:{...ref,content},rightsRefs:[nativeObligation.rightsRef]},s6Token);assert.equal(registered.status,200,JSON.stringify(registered));obligationReceipt=registered.body.receipt;
  const proposalCase=nativeResults.results.find((r:any)=>r.id==='concrete-request-proposal-preserves-exact-upstream-meaning-without-admission'&&r.status==='PASS');assert(proposalCase);const binding={...proposalCase.observed.input.bindings[0]};
  const channel=nativeObligation.intervention.channels[0];assert.equal(channel.operation,'PRICE_CHANGE');assert.equal(channel.unit,'fraction');assert.equal(channel.doses[0],0.15);
  const verifierSources=sourceDigests;
  const body={schema:'finnor.s8.method-admission.v1',domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:nativeObligation.tenantId,principalId:nativeObligation.principalId,rightsRef:nativeObligation.rightsRef,obligationRef:ref,effectRef:nativeObligation.effectRef,compiler:proposalCase.observed.proposed.body.ir.compiler,verifierSourceDigests:verifierSources,validAfter:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+600000).toISOString(),semantic:{exposureId:channel.exposureId,target:channel.target,operation:'PRICE_CHANGE',unit:'fraction',intendedExposure:'REGISTERED_DOSE',permittedRefinements:[],doseRange:[-1,1]},request:{kind:'CONDITIONAL_JSON_FIELDS_REPLACE',providerOrigin:binding.providerOrigin,applicationAccountId:binding.applicationAccountId,recordKey:binding.recordKey,field:binding.field,expectedVersion:binding.expectedVersion},qualification:'DISPOSABLE_MECHANICAL_MAPPING_TEST_NOT_PRODUCTION_ADMISSION_OR_SCIENTIFIC_TRUTH'};
  const methodRef={owner:'S8',id:`method:${digest(body)}`,version:'json-field-replace-v1',contentDigest:digest(body)};methodAdmission={ref:methodRef,body,signature:sign(null,Buffer.from(canonical(body)),methodIssuer.privateKey).toString('base64')};binding.methodRef=methodRef;
  const {POST}=await import('../../apps/api/app/api/obligations/[operation]/route.js');const response=await POST(new Request('http://localhost/api/obligations/compile-request',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':nativeObligation.tenantId,'x-user-id':nativeObligation.principalId},body:JSON.stringify({obligationRef:ref,bindings:[binding]})}),{params:Promise.resolve({operation:'compile-request'})});assert.equal(response.status,200);requestProposal=await response.json();
  const checked=await call('/verify-request',{ref:requestProposal.ref,ir:requestProposal.ir,admissions:[methodAdmission]},s6Token);assert.equal(checked.status,200,JSON.stringify(checked));assert.equal(checked.body.executionAuthorityGranted,false);assert.equal(checked.body.status,'MECHANICALLY_VERIFIED_UNADMITTED');const {signature,...assessment}=checked.body.assessment;assert(verify(null,Buffer.from(canonical(assessment)),publicKey,Buffer.from(signature,'base64')));assert.deepEqual(assessment.requestRef,requestProposal.ref);assert.deepEqual(assessment.effectRef,nativeObligation.effectRef);return {obligationRef:ref,obligationReceipt,proposal:requestProposal,admission:methodAdmission,checked};
 });
 await challenge('request-substitution-and-unqualified-methods-refused',async()=>{
  assert(requestProposal&&methodAdmission,'Native request compilation and independent method admission must succeed before substitution challenges');const rejected:any[]=[];
  const mutations=[(ir:any)=>ir.members[0].semantic.dose=900,(ir:any)=>ir.members[0].request.changes.priceAdjustmentFraction=null,(ir:any)=>ir.members[0].request.applicationAccountId=randomUUID(),(ir:any)=>ir.members[0].request.recordKey='foreign-record',(ir:any)=>ir.members[0].request.expectedVersion='producer-selected-stale-version',(ir:any)=>ir.members[0].semantic.unit='USD',(ir:any)=>ir.consumptionRef.contentDigest='0'.repeat(64),(ir:any)=>ir.deadline.authorityExpiresAt=new Date(Date.now()+900000).toISOString(),(ir:any)=>ir.compiler.version='producer-invented-v9',(ir:any)=>ir.members.push(structuredClone(ir.members[0])),(ir:any)=>ir.members=[],(ir:any)=>ir.members[0].request.authorization='secret-header'];
  for(const mutate of mutations){const ir=structuredClone(requestProposal.ir);mutate(ir);const ref={...requestProposal.ref,id:`request-ir:${digest(ir)}`,contentDigest:digest(ir)};const r=await call('/verify-request',{ref,ir,admissions:[methodAdmission]},s6Token);assert(r.status>=400,JSON.stringify(r));rejected.push({ir,ref,response:r});}
  for(const mutate of [(body:any)=>body.validUntil=new Date(Date.now()-1000).toISOString(),(body:any)=>body.verifierSourceDigests[0].sha256='0'.repeat(64),(body:any)=>body.request.recordKey='signed-wrong-record']){const body=structuredClone(methodAdmission.body);mutate(body);const methodRef={...methodAdmission.ref,id:`method:${digest(body)}`,contentDigest:digest(body)},admission={ref:methodRef,body,signature:sign(null,Buffer.from(canonical(body)),methodIssuer.privateKey).toString('base64')},ir=structuredClone(requestProposal.ir);ir.members[0].methodRef=methodRef;const ref={...requestProposal.ref,id:`request-ir:${digest(ir)}`,contentDigest:digest(ir)},r=await call('/verify-request',{ref,ir,admissions:[admission]},s6Token);assert(r.status>=400);rejected.push({ir,admission,response:r});}
  const forged={...methodAdmission,signature:sign(null,Buffer.from(canonical(methodAdmission.body)),reviewer.privateKey).toString('base64')},signatureDenied=await call('/verify-request',{ref:requestProposal.ref,ir:requestProposal.ir,admissions:[forged]},s6Token);assert.equal(signatureDenied.status,403);
  const foreign=await call('/verify-request',{ref:requestProposal.ref,ir:requestProposal.ir,admissions:[methodAdmission]});assert.equal(foreign.status,403);return {rejected,signatureDenied,foreign};
 });
 await challenge('sigkill-restart-preserves-accepted-receipt',async()=>{await stop('SIGKILL');
 const promotedPolicy={...policy,domain:'REVIEWED_PROTECTED_DOMAIN',witness:{...(policy as any).witness,endpoint:witnessEndpoint.replace('http:','https:')}},promotedReleaseBody={...releaseBody,policyDigest:digest(promotedPolicy)},promotedConfig={...config,policy:promotedPolicy,release:{...promotedReleaseBody,signature:sign(null,Buffer.from(canonical(promotedReleaseBody)),reviewer.privateKey).toString('base64')}};
 let promotionFailure:any;try{await writeFile(join(root,'config.json'),JSON.stringify(promotedConfig),{mode:0o600});await assert.rejects(start(),/INDEPENDENT_SUBSTRATE_ADMISSION_REQUIRED/);promotionFailure=logs;}finally{await stop();await writeFile(join(root,'config.json'),JSON.stringify(config),{mode:0o600});}
 await writeFile(join(output,'production-promotion-refusal.json'),JSON.stringify({promotedPolicy,promotionFailure,qualification:'Signed reviewer policy plus witness cannot self-promote local same-UID substrate'},null,2));
 await start();const retried=await call('/append',request(first.input));assert.equal(retried.status,200,JSON.stringify(retried));assert.equal(digest(retried.body.receipt),digest(first.receipt));return {signal:'SIGKILL',retried};});
 for(const fault of ['content-persistence','head-persistence'] as const)await challenge('storage-failure-sigkill-recovery-'+fault,async()=>{
  const e=event(fault==='content-persistence'?10001:10002),input={...request(e),sealed:true};
  const journalPath=join(config.protectedDirectory,'commitments.jsonl'),headPath=join(config.protectedDirectory,'head.json');
  const before={journal:await readFile(journalPath,'utf8'),head:JSON.parse(await readFile(headPath,'utf8'))};
  const blockedDirectory=fault==='content-persistence'?config.contentDirectory:config.protectedDirectory;
  let failed:any;try{await chmod(blockedDirectory,0o500);failed=await call('/append',input,evaluatorToken);}finally{await chmod(blockedDirectory,0o700);}
  const after={journal:await readFile(journalPath,'utf8'),head:JSON.parse(await readFile(headPath,'utf8'))};
  await writeFile(join(output,'storage-failure-'+fault+'.json'),JSON.stringify({inputs:input,fault,failed,before,after,signal:'SIGKILL_AFTER_FAILED_REQUEST_BEFORE_RESTART',qualification:'Actual OS directory permission fault; no crash-during-syscall claim'},null,2)+'\n');
  assert.equal(failed.status,503,JSON.stringify(failed));
  assert.deepEqual(after.head,before.head,'Failed persistence must not acknowledge a new checkpoint');
  const lines=after.journal.trim().split('\n').map((line:string)=>JSON.parse(line));
  let pending:any=null;
  if(fault==='content-persistence')assert.equal(after.journal,before.journal,'Content failure reached the journal');
  else{
   pending=lines.at(-1);assert.equal(lines.length,before.head.sequence+1,'Head fault did not follow durable journal persistence');
   const {signature,...body}=pending;assert(verify(null,Buffer.from(canonical(body)),publicKey,Buffer.from(signature,'base64')));
   assert.equal(body.eventId,e.eventId);assert.equal(body.requestDigest,digest(input));assert.equal(body.previousCheckpoint,before.head.checkpointDigest);
  }
  await stop('SIGKILL');await start();
  const retried=await call('/append',input,evaluatorToken);assert.equal(retried.status,200,JSON.stringify(retried));
  const {signature,...body}=retried.body.receipt;assert(verify(null,Buffer.from(canonical(body)),publicKey,Buffer.from(signature,'base64')));
  assert.equal(body.sequence,before.head.sequence+1);assert.equal(body.eventDigest,digest(e));assert.equal(body.requestDigest,digest(input));
  if(pending)assert.deepEqual(retried.body.receipt,pending,'Recovery replaced the durable pre-reply receipt');
  const readback=await call('/events/'+encodeURIComponent(e.eventId),undefined,evaluatorToken);assert.equal(readback.status,200);assert.deepEqual(readback.body.event,e);assert.deepEqual(readback.body.receipt,retried.body.receipt);
  const duplicate=await call('/append',input,evaluatorToken);assert.deepEqual(duplicate.body.receipt,retried.body.receipt);
  const changed=structuredClone(input);changed.event.detail.quantity='99999';const refused=await call('/append',changed,evaluatorToken);assert.equal(refused.status,409);
  const finalHead=JSON.parse(await readFile(headPath,'utf8'));assert.equal(finalHead.sequence,before.head.sequence+1);
  const evidence={fault,failed,before,after,pending,retried,readback,duplicate,refused,finalHead};
  await writeFile(join(output,'storage-failure-'+fault+'.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
 });
 await challenge('ordinary-storage-tamper-blocks-audit-and-append',async()=>{const files=await readdir(config.contentDirectory);assert(files.length>=2);const path=join(config.contentDirectory,files[0]!);const original=await readFile(path);await writeFile(path,'{}');const health=await call('/health'),blocked=await call('/append',request(event(6)));assert.equal(health.status,503);assert.equal(blocked.status,503);await writeFile(path,original);assert.equal((await call('/health')).status,200);return {health,blocked,restored:true};});
 await challenge('protected-journal-truncation-is-not-history',async()=>{
  await stop();const journal=join(config.protectedDirectory,'commitments.jsonl'),headPath=join(config.protectedDirectory,'head.json');
  const bytes=await readFile(journal),head=await readFile(headPath);
  await writeFile(journal,bytes.toString().split('\n').slice(0,1).join('\n')+'\n');let refused=false;try{await start();}catch{refused=true;}await stop();assert(refused);await writeFile(journal,bytes);
  let rollbackRefused=false;try{
   await writeFile(journal,initialHistory.journal);await writeFile(headPath,initialHistory.head);
   try{await start();}catch{rollbackRefused=true;}await stop();
  }finally{await writeFile(journal,bytes);await writeFile(headPath,head);}
  const rollbackEvidence={startupRefused:refused,rollbackRefused,priorHead:JSON.parse(head.toString()),rolledBackHead:JSON.parse(initialHistory.head.toString()),witnessHead:JSON.parse(await readFile(witnessHeadPath,'utf8'))};
  await writeFile(join(output,'whole-state-rollback.json'),JSON.stringify(rollbackEvidence,null,2)+'\n');
  assert(rollbackRefused,'Both signed head and journal were rolled back but startup accepted the old history');
  await start();const failures:any[]=[];
  for(const mode of ['UNAVAILABLE','NONCE_REPLAY','HEAD_FORK']){
   await writeFile(witnessModePath,JSON.stringify({mode}),{mode:0o600});
   try{const health=await call('/health'),append=await call('/append',request(event(10003)));failures.push({mode,health,append});assert.equal(health.status,503);assert.equal(append.status,503);assert.deepEqual(await readFile(journal),bytes);}
   finally{await writeFile(witnessModePath,JSON.stringify({mode:'NORMAL'}),{mode:0o600});}
  }
  const pending=event(10004),pendingInput=request(pending);await writeFile(witnessModePath,JSON.stringify({mode:'LOST_REPLY'}),{mode:0o600});
  const lost=await call('/append',pendingInput);assert.equal(lost.status,503);
  const durable=JSON.parse((await readFile(journal,'utf8')).trim().split('\n').at(-1)!);assert.equal(durable.eventId,pending.eventId);
  await stop('SIGKILL');await start();const recovered=await call('/append',pendingInput);assert.equal(recovered.status,200);assert.deepEqual(recovered.body.receipt,durable);
  const readback=await call('/events/'+encodeURIComponent(pending.eventId));assert.equal(readback.status,200);assert.deepEqual(readback.body.event,pending);assert.deepEqual(readback.body.receipt,durable);
  return {...rollbackEvidence,failures,lost,durable,recovered,readback,priorBytes:bytes.length,qualification:'PINNED_PROTOCOL_AND_SEPARATE_PROCESS_PERSISTENCE; PRODUCTION_NONROLLBACKABLE_DEPLOYMENT_REMAINS_EXTERNAL'};
 });
}finally{await stop();
 if(witnessProcess.exitCode===null&&witnessProcess.signalCode===null)await new Promise<void>(done=>{witnessProcess.once('exit',()=>done());witnessProcess.kill('SIGTERM');});
 await writeFile(join(output,'witness-transcript.jsonl'),await readFile(witnessTranscriptPath).catch(()=>Buffer.alloc(0)));
 await writeFile(join(output,'witness-process.json'),JSON.stringify({pid:witnessProcess.pid,exitCode:witnessProcess.exitCode,signal:witnessProcess.signalCode,ledgerId,endpoint:witnessEndpoint,qualification:'DISPOSABLE_SAME_UID_PROTOCOL_ORACLE; NOT_PRODUCTION_NONROLLBACKABLE_SUBSTRATE'},null,2)+'\n');
 const {closePool}=await import('@finnor/db');await closePool();await writeFile(join(output,'process.log'),logs);await writeFile(join(output,'test-authority.json'),JSON.stringify({release,policyDigest:digest(policy),publicKey,reviewerPublic,methodIssuerPublic:methodIssuer.publicKey.export({type:'spki',format:'pem'}).toString(),root,secretMaterialRetainedInDisposableDirectoryOnly:true},null,2)+'\n');manifest.finishedAt=new Date().toISOString();manifest.sourcesUnchanged=digest(await snapshot())===digest(manifest.sourceDigests);manifest.authorityScope={domain:'DISPOSABLE_TEST_AUTHORITY',owners:policy.owners.map(({tokenHash,...owner})=>owner)};await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');if(!manifest.sourcesUnchanged)process.exitCode=2;}
assert(results.length>=7);if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
