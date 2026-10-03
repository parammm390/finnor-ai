/** Actual concurrent daemon starts; no production seam and no fixture receipts. */
import {strict as assert} from 'node:assert';
import {createHash,generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,realpath,open,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';

const output=resolve(process.env.FINNOR_S6_WRITER_EVIDENCE_DIR??'../scope-6/scope-evidence/ledger-writer-'+Date.now());
await mkdir(dirname(output),{recursive:true});await mkdir(output);
const root=await realpath(await mkdtemp(join(tmpdir(),'finnor-s6-writer-')));
const canonical=(value:any):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort((a,b)=>a.localeCompare(b)).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const compiledRoot=process.env.FINNOR_S6_COMPILED_RING0_DIR?resolve(process.env.FINNOR_S6_COMPILED_RING0_DIR):null;
const sourceRoot=compiledRoot?join(compiledRoot,'packages/governed-execution/src'):resolve('packages/governed-execution/src');
const runtimeRequire=compiledRoot?createRequire(join(compiledRoot,'package.json')):createRequire(import.meta.url),fsExtDirectory=dirname(runtimeRequire.resolve('fs-ext/package.json'));
const sourcePaths=[...['ledger.ts','ledger-server.mts','protocol.ts','request-verifier.ts','adapter-contract.ts'].map(name=>join(sourceRoot,name)),join(fsExtDirectory,'fs-ext.js'),join(fsExtDirectory,'build/Release/fs_ext.node'),join(fsExtDirectory,'package.json')];
const compiledFiles=compiledRoot?['ledger.js','ledger-server.mjs','protocol.js','request-verifier.js','adapter-contract.js','dispatch-broker.js','broker-io.js'].map(name=>join(sourceRoot,name)):[];
const snapshotPaths=[...sourcePaths,...compiledFiles,'scripts/s6/run-ledger-writer-e2e.mts','package-lock.json'];
const snapshot=()=>Promise.all(snapshotPaths.map(async path=>({path,sha256:hash(await readFile(path))})));
const sourcesBefore=await snapshot(),sourceDigests=sourcesBefore.slice(0,sourcePaths.length);
const signer=generateKeyPairSync('ed25519'),reviewer=generateKeyPairSync('ed25519'),token=randomUUID()+randomUUID();
const publicKey=signer.publicKey.export({type:'spki',format:'pem'}).toString(),reviewerPublic=reviewer.publicKey.export({type:'spki',format:'pem'}).toString();
await writeFile(join(root,'signer.pem'),signer.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
const policy={schema:'finnor.s6.ledger-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',owners:[{tokenHash:hash(token),owner:'S5',tenantId:randomUUID(),principalId:randomUUID(),rightsRefs:['disposable-writer-rights'],append:true,read:true,sealedAppend:false,sealedRead:false}],signerPublicKey:publicKey,maxEntries:100000};
const body={schema:'finnor.s6.ledger-release.v2',releaseId:'disposable-writer-candidate',sourceDigests,runtime:{node:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch},policyDigest:hash(canonical(policy)),validUntil:new Date(Date.now()+3600000).toISOString()};
const release={...body,signature:sign(null,Buffer.from(canonical(body)),reviewer.privateKey).toString('base64')};
await writeFile(join(output,'test-authority.json'),JSON.stringify({root,policy,release,publicKey,reviewerPublic,qualification:'DISPOSABLE_TEST_AUTHORITY_ONLY_NO_INDEPENDENT_PRODUCTION_RELEASE'},null,2)+'\n');
type Candidate={process:ChildProcess;logs:string;status:string;port:number|null;startupError:string|null};
async function candidate(configPath:string):Promise<Candidate>{
 const processHandle=spawn(process.execPath,compiledRoot?[join(sourceRoot,'ledger-server.mjs')]:['--import=tsx',join(sourceRoot,'ledger-server.mts')],{cwd:process.cwd(),env:{PATH:process.env.PATH!,HOME:root,FINNOR_S6_LEDGER_CONFIG:configPath,FINNOR_S6_LEDGER_RELEASE_ROOT:reviewerPublic},stdio:['ignore','pipe','pipe']});
 const value:Candidate={process:processHandle,logs:'',status:'STARTING',port:null,startupError:null};
 return await new Promise(resolveCandidate=>{
  const timeout=setTimeout(()=>{value.status='BOOT_TIMEOUT';processHandle.kill('SIGKILL');resolveCandidate(value);},15000);
  const collect=(chunk:Buffer)=>{value.logs+=chunk.toString();for(const line of value.logs.split('\n')){try{const state=JSON.parse(line);if(state.status==='READY'){clearTimeout(timeout);value.status='READY';value.port=state.port;resolveCandidate(value);}}catch{}}};
  processHandle.stdout!.on('data',collect);processHandle.stderr!.on('data',collect);
  processHandle.once('error',error=>{clearTimeout(timeout);value.status='SPAWN_ERROR';value.startupError=String(error);resolveCandidate(value);});
  processHandle.once('exit',()=>{clearTimeout(timeout);if(value.status==='STARTING'){value.status='BOOT_EXIT';resolveCandidate(value);}});
 });
}
async function stop(value:Candidate){
 if(value.process.exitCode!==null||value.process.signalCode!==null)return;
 await new Promise<void>((done,reject)=>{const timeout=setTimeout(()=>reject(Error('TEST_CHILD_CLEANUP_TIMEOUT:'+value.process.pid)),5000);value.process.once('close',()=>{clearTimeout(timeout);done();});value.process.kill('SIGKILL');});
}
function describe(value:Candidate){return {pid:value.process.pid,status:value.status,port:value.port,exitCode:value.process.exitCode,signal:value.process.signalCode,startupError:value.startupError,logs:value.logs};}
async function configuration(name:string){
 const directory=join(root,name),protectedDirectory=join(directory,'protected'),contentDirectory=join(directory,'ordinary');
 await mkdir(protectedDirectory,{recursive:true,mode:0o700});await mkdir(contentDirectory,{mode:0o700});
 const config={policy,release,signerPath:join(root,'signer.pem'),protectedDirectory,contentDirectory,port:0},configPath=join(directory,'config.json');
 await writeFile(configPath,JSON.stringify(config),{mode:0o600});return {directory,protectedDirectory,contentDirectory,configPath};
}
const rounds:any[]=[],began=Date.now();let failure:string|null=null,diagnosticRecovery:any=null;
try{
 let stalePid=999999;try{process.kill(stalePid,0);throw Error('STALE_PID_IS_LIVE');}catch(error:any){if(error.code!=='ESRCH')throw error;}
 for(let round=0;round<32;round++){
  assert(Date.now()-began<300000,'Registered writer stress time budget exceeded');
  const {protectedDirectory,configPath}=await configuration('round-'+round);
  const stale=canonical({pid:stalePid,padding:'x'.repeat(3*1024*1024)});
  await writeFile(join(protectedDirectory,'writer.lock'),stale,{mode:0o600});
  const candidates=await Promise.all(Array.from({length:4},()=>candidate(configPath)));
  let health:any[]=[];let lockAfter:string|null=null;
  try{
   for(const value of candidates.filter(value=>value.status==='READY')){
    const response=await fetch(`http://127.0.0.1:${value.port}/health`,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});health.push({pid:value.process.pid,status:response.status,body:await response.json()});
   }
   try{lockAfter=await readFile(join(protectedDirectory,'writer.lock'),'utf8');}catch(error){lockAfter=String(error);}
  }finally{await Promise.all(candidates.map(stop));}
  let successor:any=null;
  if(candidates.filter(value=>value.status==='READY').length===1){
   const next=await candidate(configPath);
   try{if(next.status==='READY'){const response=await fetch(`http://127.0.0.1:${next.port}/health`,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});successor={status:response.status,body:await response.json()};}else successor={status:'BOOT_FAILED'};}finally{await stop(next);successor={...successor,process:describe(next)};}
  }
  const observed={round,inputs:{configPath,stalePid,staleLockBytes:Buffer.byteLength(stale),staleLockSha256:hash(stale),candidates:4},candidates:candidates.map(describe),health,lockAfter,successor};rounds.push(observed);
  await writeFile(join(output,'round-'+round+'.json'),JSON.stringify(observed,null,2)+'\n');
  assert.equal(candidates.filter(value=>value.status==='READY').length,1,'More or fewer than one actual ledger daemon acquired the state directory');
  assert.equal(health[0].status,200,'The sole writer is unavailable');assert.equal(health[0].body.sequence,0);
  assert.equal(successor?.status,200,'SIGKILL did not permit the sole successor on the same retained inode');
  console.log(JSON.stringify({round,ready:health.length,status:'PASS'}));
 }
 const faultBegan=Date.now(),{protectedDirectory,configPath}=await configuration('torn-diagnostics');
 const lockPath=join(protectedDirectory,'writer.lock'),journalPath=join(protectedDirectory,'commitments.jsonl'),headPath=join(protectedDirectory,'head.json');
 const owner=policy.owners[0]!,detail={record:'writer-diagnostic-recovery',money:null,qualification:'SYNTHETIC_BYTE_CONTRACT_NOT_ECONOMIC_CONSUMPTION'};
 const eventBody={schema:'finnor.s5.experience.v1',semanticOwner:'S5',episodeId:'writer-diagnostics',type:'COST',tenantId:owner.tenantId,principalId:owner.principalId,rightsRef:owner.rightsRefs[0],revisionRef:'writer-diagnostic-record',contentDigest:hash(canonical(detail)),knowledgeAt:new Date().toISOString(),validAt:new Date().toISOString(),preparedParentRefs:[],causalParents:[],dependencyRefs:[],horizon:'H0',uncertainty:'MODEL_CONDITIONAL_UNADMITTED',detail,protectedReceipt:null,appendAuthorityGranted:false};
 const event={...eventBody,eventId:'s5-event:'+hash(canonical(eventBody))},input={event,parents:[],references:[{id:event.revisionRef,owner:'S5',version:'test-writer-record-v1',contentDigest:event.contentDigest,content:detail}]};
 const call=async(value:Candidate,path:string,payload?:unknown)=>{
  const response=await fetch(`http://127.0.0.1:${value.port}${path}`,{method:payload===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(payload===undefined?{}:{body:canonical(payload)}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.json() as any};
 };
 const initial=await candidate(configPath);let contenders:Candidate[]=[];
 try{
  assert.equal(initial.status,'READY',initial.logs);
  const accepted=await call(initial,'/append',input);assert.equal(accepted.status,200,JSON.stringify(accepted));
  const {signature,...receiptBody}=accepted.body.receipt;assert(verify(null,Buffer.from(canonical(receiptBody)),publicKey,Buffer.from(signature,'base64')));assert.equal(receiptBody.sequence,1);assert.equal(receiptBody.eventId,event.eventId);
  const priorLock=await readFile(lockPath),priorInode=await lstat(lockPath),priorJournal=await readFile(journalPath),priorHead=await readFile(headPath);
  await stop(initial);assert.equal(initial.process.signalCode,'SIGKILL');
  const truncatedLength=priorLock.length-12;assert(truncatedLength>32);
  const descriptor=await open(lockPath,'r+');try{await descriptor.truncate(truncatedLength);await descriptor.sync();}finally{await descriptor.close();}
  const torn=await readFile(lockPath),tornInode=await lstat(lockPath);assert.equal(tornInode.ino,priorInode.ino);assert.equal(tornInode.dev,priorInode.dev);
  assert.equal(hash(await readFile(journalPath)),hash(priorJournal));assert.equal(hash(await readFile(headPath)),hash(priorHead));
  diagnosticRecovery={inputs:input,configPath,initial:describe(initial),accepted,fault:'SIGKILL_REAP_THEN_DESCRIPTOR_TRUNCATION_OF_DIAGNOSTIC_TAIL',inode:{dev:priorInode.dev,ino:priorInode.ino},diagnostics:{before:priorLock.toString(),after:torn.toString()},journalSha256:hash(priorJournal),headSha256:hash(priorHead),contenders:[]};
  await writeFile(join(output,'torn-diagnostics.json'),JSON.stringify(diagnosticRecovery,null,2)+'\n');
  contenders=await Promise.all(Array.from({length:4},()=>candidate(configPath)));
  diagnosticRecovery.contenders=contenders.map(describe);
  await writeFile(join(output,'torn-diagnostics.json'),JSON.stringify(diagnosticRecovery,null,2)+'\n');
  assert.equal(contenders.filter(value=>value.status==='READY').length,1,'Torn diagnostics stranded or duplicated actual writer ownership');
  const next=contenders.find(value=>value.status==='READY')!,health=await call(next,'/health'),read=await call(next,'/events/'+encodeURIComponent(event.eventId)),retry=await call(next,'/append',input);
  assert.equal(health.status,200);assert.equal(health.body.sequence,1);assert.equal(read.status,200);assert.equal(retry.status,200);assert.deepEqual(read.body.receipt,accepted.body.receipt);assert.deepEqual(retry.body.receipt,accepted.body.receipt);assert.deepEqual(read.body.event,event);
  const afterInode=await lstat(lockPath);assert.equal(afterInode.ino,priorInode.ino);assert.equal(afterInode.dev,priorInode.dev);assert.equal(hash(await readFile(journalPath)),hash(priorJournal));
  assert(Date.now()-faultBegan<120000,'Registered diagnostic-recovery time budget exceeded');
  Object.assign(diagnosticRecovery,{health,read,retry,elapsedMs:Date.now()-faultBegan,status:'PASS'});
  console.log(JSON.stringify({case:'torn-diagnostics',status:'PASS'}));
 }finally{
  await stop(initial);await Promise.all(contenders.map(stop));
  if(diagnosticRecovery){diagnosticRecovery.initial=describe(initial);diagnosticRecovery.contenders=contenders.map(describe);await writeFile(join(output,'torn-diagnostics.json'),JSON.stringify(diagnosticRecovery,null,2)+'\n');}
 }
}catch(error){failure=String(error);process.exitCode=1;}
const sourcesAfter=await snapshot(),sourcesUnchanged=canonical(sourcesBefore)===canonical(sourcesAfter);if(!sourcesUnchanged)process.exitCode=2;
await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.s6.ledger-writer-e2e.v1',status:failure?'FAIL':'PASS',failure,rounds,diagnosticRecovery,sourcesBefore,sourcesAfter,sourcesUnchanged,compiledRoot,compiledFiles,node:process.version,elapsedMs:Date.now()-began,resources:{...process.resourceUsage(),scope:'SUPERVISOR_ONLY_NOT_AGGREGATE_DAEMON_QUOTA'},rerun:'FINNOR_S6_WRITER_EVIDENCE_DIR=<new-evidence-directory> node --import=tsx scripts/s6/run-ledger-writer-e2e.mts',qualification:'Actual local daemon contention and independent HTTP; test release/shared OS identity; bounded stress is not a universal concurrency proof'},null,2)+'\n');
console.log(JSON.stringify({output,status:failure?'FAIL':'PASS',failure,sourcesUnchanged}));
