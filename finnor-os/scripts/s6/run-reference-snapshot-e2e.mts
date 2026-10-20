/** Preregistered real HTTP boundary. Synthetic custody, no native/business admission. */
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,symlink,unlink} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {createServer,type Server} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {canonical} from '../../packages/governed-execution/src/protocol';
import * as transport from '../../packages/governed-execution/src/owner-transport';

const configuredOut=process.env.FINNOR_S6_REFERENCE_EVIDENCE_DIR;
assert(configuredOut&&isAbsolute(configuredOut),'NEW_ABSOLUTE_PRIVATE_EVIDENCE_REQUIRED');
const out=configuredOut;
await mkdir(out,{mode:0o700});
const privateDir=join(out,'private');await mkdir(privateDir,{mode:0o700});
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const bytesHash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const pem=(key:ReturnType<typeof generateKeyPairSync>['publicKey'])=>key.export({type:'spki',format:'pem'}).toString();
const signer=generateKeyPairSync('ed25519'),reviewer=generateKeyPairSync('ed25519'),witnessKey=generateKeyPairSync('ed25519');
const fsExt=dirname(createRequire(import.meta.url).resolve('fs-ext/package.json'));
const sourcePaths=['ledger.ts','ledger-server.mts','protocol.ts','request-verifier.ts','adapter-contract.ts']
 .map(name=>resolve('packages/governed-execution/src',name))
 .concat(['fs-ext.js','build/Release/fs_ext.node','package.json'].map(name=>join(fsExt,name)));
const sourceDigests=await Promise.all(sourcePaths.map(async path=>({path,sha256:bytesHash(await readFile(path))})));
const runPaths=[...sourcePaths,resolve('packages/governed-execution/src/owner-transport.ts'),
 resolve('packages/capability-evolution/src/lifecycle.ts'),resolve('scripts/s6/run-reference-snapshot-e2e.mts')];
const snapshot=async()=>Promise.all(runPaths.map(async path=>({path,sha256:bytesHash(await readFile(path))})));
const beginning=await snapshot(),cases:any[]=[],children:ChildProcess[]=[];
const tenantId=randomUUID(),principalId=randomUUID(),rights='snapshot-fixture-rights';
const identity={semanticOwner:'S8',tenantId,principalId};
const credentials=Object.fromEntries(['full','unsealed','noRights','disabled','foreign'].map(name=>[name,randomBytes(32).toString('hex')]));
const modePath=join(privateDir,'witness-mode.json'),transcript=join(privateDir,'witness-transcript.jsonl');
const childLog:Record<string,string>={};let base='',proxy:Server|undefined,mode='NORMAL',replay:any;
let failed=false,ownedStopped=true;
const receipt:any={schema:'finnor.s6.reference-snapshot-e2e.v1',status:'FAIL',startedAt:new Date().toISOString(),
 node:process.version,command:process.argv,beginning,cases,
 qualification:'SYNTHETIC_REFERENCE_CUSTODY_SEPARATE_HTTP_PROCESSES_NO_NATIVE_OR_PROTECTED_ADMISSION',
 businessExecutionProof:false,rerun:'FINNOR_S6_REFERENCE_EVIDENCE_DIR=<new-absolute-directory> node --import=tsx scripts/s6/run-reference-snapshot-e2e.mts'};
const store=async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value),{mode:0o600});
async function boot(name:string,args:string[],extra:Record<string,string>={}){
 const child=spawn(process.execPath,['--import=tsx',...args],{cwd:process.cwd(),
  env:{PATH:process.env.PATH,HOME:privateDir,...extra},stdio:['ignore','pipe','pipe']});
 children.push(child);childLog[name]='';
 return await new Promise<string>((yes,no)=>{
  const timer=setTimeout(()=>{child.kill('SIGTERM');no(Error(name+'_BOOT_TIMEOUT'));},15000);
  child.stdout!.on('data',b=>{childLog[name]+=b;for(const line of childLog[name]!.split('\n'))try{
   const row=JSON.parse(line);if(row.status==='READY'){clearTimeout(timer);yes('http://127.0.0.1:'+row.port);}
  }catch{}});
  child.stderr!.on('data',b=>{childLog[name]+=b;});
  child.once('exit',()=>{clearTimeout(timer);no(Error(name+'_BOOT_EXIT'));});
 });
}
async function stop(child:ChildProcess){
 if(child.exitCode!==null||child.signalCode!==null)return;
 await new Promise<void>((yes,no)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('OWNED_PROCESS_STOP_BOUND'));},5000);
  child.once('exit',()=>{clearTimeout(timer);yes();});child.kill('SIGTERM');
 });
}
const head=async()=>({journal:bytesHash(await readFile(join(privateDir,'protected/commitments.jsonl'))),
 head:bytesHash(await readFile(join(privateDir,'protected/head.json')))});
async function call(path:string,body?:unknown,credential=credentials.full!){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',
  headers:{authorization:'Bearer '+credential,'content-type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
 return {status:response.status,body:await response.json() as any};
}
async function challenge(id:string,fn:()=>Promise<unknown>){
 const before=await head(),start=performance.now();
 try{const observed=await fn();const after=await head();assert.deepEqual(after,before,'READ_MUTATED_COMMITTED_HEAD');
  cases.push({id,status:'PASS',observed,before,after,elapsedMs:performance.now()-start});}
 catch(error){cases.push({id,status:'FAIL',predicate:error instanceof Error?error.message:'UNKNOWN'});throw error;}
 finally{await store(join(out,'results.json'),receipt);}
}
try{
 await store(modePath,{mode:'NORMAL'});
 await writeFile(join(privateDir,'witness.pem'),witnessKey.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const ledgerId=randomUUID();
 await store(join(privateDir,'witness.json'),{ledgerId,signerDigest:hash(pem(signer.publicKey)),ledgerPublicKey:pem(signer.publicKey),
  signerPath:join(privateDir,'witness.pem'),modePath,headPath:join(privateDir,'witness-head.json'),transcriptPath:transcript});
 const witness=await boot('witness',['scripts/s6/monotonic-witness-fixture.mts',join(privateDir,'witness.json')]);
 const owner={owner:'S8',tenantId,principalId,rightsRefs:[rights],append:false,read:true,sealedAppend:false,sealedRead:true};
 const policy={schema:'finnor.s6.ledger-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',signerPublicKey:pem(signer.publicKey),maxEntries:128,
  witness:{schema:'finnor.s6.monotonic-witness-binding.v1',ledgerId,endpoint:witness,publicKey:pem(witnessKey.publicKey),timeoutMs:5000},
  owners:[
   {...owner,tokenHash:bytesHash(credentials.full!),append:true,sealedAppend:true},
   {...owner,tokenHash:bytesHash(credentials.unsealed!),sealedRead:false},
   {...owner,tokenHash:bytesHash(credentials.noRights!),rightsRefs:['other-rights']},
   {...owner,tokenHash:bytesHash(credentials.disabled!),read:false},
   {...owner,tokenHash:bytesHash(credentials.foreign!),tenantId:randomUUID()},
  ]};
 const releaseBody={schema:'finnor.s6.ledger-release.v2',releaseId:'disposable-reference-snapshot-'+randomUUID(),
  sourceDigests,runtime:{node:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch},
  policyDigest:hash(policy),validUntil:new Date(Date.now()+3600000).toISOString()};
 await writeFile(join(privateDir,'signer.pem'),signer.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 await writeFile(join(privateDir,'sealed.key'),randomBytes(32),{mode:0o600});
 await store(join(privateDir,'ledger.json'),{policy,release:{...releaseBody,signature:sign(null,Buffer.from(canonical(releaseBody)),reviewer.privateKey).toString('base64')},
  signerPath:join(privateDir,'signer.pem'),sealedEncryptionKeyPath:join(privateDir,'sealed.key'),
  protectedDirectory:join(privateDir,'protected'),contentDirectory:join(privateDir,'content'),port:0});
 base=await boot('ledger',['packages/governed-execution/src/ledger-server.mts'],{
  FINNOR_S6_LEDGER_CONFIG:join(privateDir,'ledger.json'),FINNOR_S6_LEDGER_RELEASE_ROOT:pem(reviewer.publicKey)});
 const reference=(id:string,content:unknown)=>({id,owner:'S8',version:'disposable-snapshot-v1',contentDigest:hash(content),content});
 const plain=reference('snapshot:plain',{fixture:'plain'}),related=reference('snapshot:related',{fixture:'related'}),
  sealed=reference('snapshot:sealed',{fixture:'sealed'}),native={id:'snapshot:native',owner:'S8',version:'disposable-native-text-v1',
   content:'{"fixture": "native-text"}',digestEncoding:'NATIVE_UTF8_SHA256_V1',contentDigest:bytesHash('{"fixture": "native-text"}')};
 const registered=await call('/references',{reference:plain,relatedReferences:[related],rightsRefs:[rights]});
 assert.equal(registered.status,200);
 const sealedResult=await call('/references',{reference:sealed,rightsRefs:[rights],sealed:true});assert.equal(sealedResult.status,200);
 const nativeResult=await call('/references',{reference:native,rightsRefs:[rights]});assert.equal(nativeResult.status,200);
 const missing='snapshot:genuinely-absent',ids=[plain.id,related.id],nonce=()=>randomBytes(32).toString('hex');
 await challenge('original-single-reference-wire-and-native-encoding',async()=>{
  for(const item of [plain,related,sealed,native]){
   const r=await call('/references/'+encodeURIComponent(item.id));assert.equal(r.status,200);assert.deepEqual(r.body.reference,item);
  }
  const absent=await call('/references/'+encodeURIComponent(missing));assert.equal(absent.status,404);
  return {present:4,missingStatus:absent.status,originalReceiptDigest:hash(registered.body.receipt)};
 });
 await challenge('one-integrity-pass-for-ordered-pair',async()=>{
  const before=(await readFile(transcript,'utf8')).trim().split('\n').length;
  const result=await call('/reference-snapshot',{ids,nonce:nonce()});assert.equal(result.status,200);
  const after=(await readFile(transcript,'utf8')).trim().split('\n').length;assert.equal(after-before,1);
  return {status:result.status,witnessReads:after-before,snapshotDigest:hash(result.body)};
 });
 proxy=createServer(async(req,res)=>{
  try{
   const chunks:Buffer[]=[];let length=0;for await(const raw of req){length+=raw.length;assert(length<=8*1024*1024);chunks.push(Buffer.from(raw));}
   const response=await fetch(base+(req.url??'/'),{method:req.method,headers:{authorization:req.headers.authorization??'','content-type':'application/json'},
    ...(chunks.length?{body:Buffer.concat(chunks)}:{}),signal:AbortSignal.timeout(10000)});
   const answer:any=await response.json();
   if(answer.snapshot){
    if(mode==='CAPTURE')replay=structuredClone(answer);
    else if(mode==='REPLAY'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(replay));return;}
    else if(mode!=='NORMAL'){
     const {signature,...body}=answer.snapshot;
     if(mode==='UNSIGNED')body.sequence+=1;
     if(mode==='OMIT')delete body.results;
     if(mode==='ORDER')body.results.reverse();
     if(mode==='SCOPE')body.principalId=randomUUID();
     if(mode==='RIGHTS')body.rightsRefs=['other-rights'];
     if(mode==='RELEASE')body.releaseId='unaccepted-release';
     if(mode==='IDS')body.ids.reverse();
     if(mode==='TIME')body.checkedAt='2000-01-01T00:00:00.000Z';
     if(mode==='AUTHORITY')body.executionAuthorityGranted=true;
     if(mode==='RECEIPT')body.results[0].receipt.requestDigest='0'.repeat(64);
     answer.snapshot={...body,signature:mode==='UNSIGNED'?signature:sign(null,Buffer.from(canonical(body)),signer.privateKey).toString('base64')};
    }
   }
   res.writeHead(response.status,{'content-type':'application/json'});res.end(JSON.stringify(answer));
  }catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"FIXTURE_PROXY_UNAVAILABLE"}');}
 });
 await new Promise<void>(done=>proxy!.listen(0,'127.0.0.1',done));
 await writeFile(join(privateDir,'token'),credentials.full!,{mode:0o600});
 const after=new Date(Date.now()-1000).toISOString();
 const route={...identity,rightsRefs:[rights],originKeys:[{id:'fixture-only',publicKey:pem(reviewer.publicKey),validAfter:after,
  validUntil:releaseBody.validUntil,revoked:false}],tokenPath:join(privateDir,'token'),tokenSha256:bytesHash(credentials.full!),
  ledger:{endpoint:'http://127.0.0.1:'+(proxy.address() as any).port,acceptedReceipts:[{signerPublicKey:pem(signer.publicKey),
   releaseId:releaseBody.releaseId,verifierDigest:hash(sourceDigests),policyDigest:hash(policy)}]},requestTimeoutMs:5000,leaseMs:10000};
 const transportPolicy={schema:'finnor.s6.owner-transport-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',validAfter:after,validUntil:releaseBody.validUntil,routes:[route]};
 await store(join(privateDir,'owner.json'),{policy:transportPolicy,signature:sign(null,Buffer.from(canonical(transportPolicy)),reviewer.privateKey).toString('base64')});
 process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG=join(privateDir,'owner.json');process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT=pem(reviewer.publicKey);
 const read=(transport as any).readOwnerTransportReferenceSnapshot;assert.equal(typeof read,'function');
 await challenge('client-present-absent-reversed-sealed-and-native-originals',async()=>{
  for(const requested of [ids,[...ids].reverse(),[missing,plain.id],[missing],[sealed.id,native.id]]){
   const r=await read(identity,requested);assert.deepEqual(r.results.map((v:any)=>v?.reference.id??null),
    requested.map(id=>id===missing?null:id));assert.equal(r.executionAuthorityGranted,false);
  }return {cases:5};
 });
 for(const [name,credential,requested,status] of [
  ['unauthenticated','invalid-token',ids,401],['disabled',credentials.disabled!,ids,403],
  ['no-rights',credentials.noRights!,ids,403],['sealed-without-access',credentials.unsealed!,[sealed.id,missing],403],
  ['foreign-tenant',credentials.foreign!,ids,200],
 ] as const)await challenge(name,async()=>{
  const r=await call('/reference-snapshot',{ids:requested,nonce:nonce()},credential);assert.equal(r.status,status);
  if(name==='foreign-tenant')assert.deepEqual(r.body.snapshot.results,[null,null]);return {status:r.status};
 });
 const malformed=[{}, {ids:[],nonce:nonce()}, {ids:[plain.id,plain.id],nonce:nonce()},
  {ids:[...ids,missing],nonce:nonce()}, {ids:[1],nonce:nonce()}, {ids:[''],nonce:nonce()},
  {ids:['a'.repeat(4097)],nonce:nonce()}, {ids,nonce:'bad'}, {ids,nonce:nonce(),extra:true}];
 for(const [i,input] of malformed.entries())await challenge('malformed-'+i,async()=>{
  const r=await call('/reference-snapshot',input);assert.equal(r.status,400);return {status:r.status,inputDigest:hash(input)};
 });
 for(const tamper of ['UNSIGNED','OMIT','ORDER','SCOPE','RIGHTS','RELEASE','IDS','TIME','AUTHORITY','RECEIPT','REPLAY']){
  await challenge('client-response-'+tamper.toLowerCase(),async()=>{
   if(tamper==='REPLAY'){mode='CAPTURE';await read(identity,ids);assert(replay);}
   mode=tamper;try{await assert.rejects(()=>read(identity,ids));}finally{mode='NORMAL';}
   return {rejected:true};
  });
 }
 for(const fault of ['same-size','symlink','missing','oversized','unrelated-missing-lookup']){
  await challenge('storage-'+fault,async()=>{
   const path=join(privateDir,'content',fault==='unrelated-missing-lookup'?nativeResult.body.receipt.contentFile:registered.body.receipt.contentFile);
   const original=await readFile(path),saved=path+'.fixture-saved';
   try{
    if(fault==='symlink'||fault==='missing'){await rename(path,saved);if(fault==='symlink')await symlink(saved,path);}
    else if(fault==='oversized')await writeFile(path,Buffer.alloc(8*1024*1024+1),{mode:0o600});
    else{const changed=Buffer.from(original);changed[0]=changed[0]!^1;await writeFile(path,changed,{mode:0o600});}
    const r=await call('/reference-snapshot',{ids:fault==='unrelated-missing-lookup'?[missing]:ids,nonce:nonce()});
    assert.equal(r.status,503);return {status:r.status,originalDigest:bytesHash(original)};
   }finally{
    if(fault==='symlink')await unlink(path);
    if(fault==='symlink'||fault==='missing')await rename(saved,path);
    else await writeFile(path,original,{mode:0o600});
   }
  });
 }
 for(const witnessMode of ['UNAVAILABLE','NONCE_REPLAY','HEAD_FORK'])await challenge('witness-'+witnessMode.toLowerCase(),async()=>{
  await store(modePath,{mode:witnessMode});
  try{const r=await call('/reference-snapshot',{ids:[missing],nonce:nonce()});assert.equal(r.status,503);return {status:r.status};}
  finally{await store(modePath,{mode:'NORMAL'});}
 });
 await challenge('restored-read-and-ending-head',async()=>{const r=await read(identity,[plain.id,missing]);assert(r.results[0]);return {restored:true};});
}catch(error){failed=true;receipt.failure=error instanceof Error?error.message:'UNKNOWN';}
finally{
 if(proxy)try{await new Promise<void>((yes,no)=>proxy!.close(error=>error?no(error):yes()));}catch{ownedStopped=false;}
 for(const child of children.reverse())try{await stop(child);}catch{ownedStopped=false;}
 receipt.ending=await snapshot();if(hash(beginning)!==hash(receipt.ending)){failed=true;receipt.sourceChanged=true;}
 receipt.childDiagnostics=Object.fromEntries(Object.entries(childLog).map(([name,log])=>[name,{
  sha256:bytesHash(log),codes:[...log.matchAll(/(?:Error|LedgerFault): ([A-Z][A-Z0-9_]{1,80})/g)].map(match=>match[1]),
 }]));
 if(!ownedStopped)failed=true;
 receipt.ownedProcessesStopped=ownedStopped;receipt.finishedAt=new Date().toISOString();receipt.status=failed?'FAIL':'PASS';
 await writeFile(join(out,'results.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:receipt.status,cases:cases.length,ownedProcessesStopped:ownedStopped,evidence:out}));
}
process.exit(failed?1:0);
