/** Minimal append verifier. Business reasoning, compilation and projections live outside this process. */
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, timingSafeEqual, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, open, rename, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, LedgerFault, referencePreimageDigest } from './protocol.js';
import { verifyGovernedRequest } from './request-verifier.js';
import {s6AdapterContract} from './adapter-contract.js';
export { canonical, LedgerFault } from './protocol.js';

type Json = null | boolean | number | string | Json[] | { [key:string]:Json };
type ObjectValue = { [key:string]:any };
function deny(status:number,code:string):never {throw new LedgerFault(status,code);}
const object=(v:any):ObjectValue=>v&&typeof v==='object'&&!Array.isArray(v)?v:deny(400,'EXPECTED_OBJECT');
const text=(v:any):string=>typeof v==='string'&&v.length>0&&v.length<=4096?v:deny(400,'EXPECTED_BOUNDED_TEXT');
const list=(v:any,maximum=256):any[]=>Array.isArray(v)&&v.length<=maximum?v:deny(400,'EXPECTED_BOUNDED_ARRAY');
const hex=(v:any):string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:deny(400,'EXPECTED_SHA256');
const instant=(v:any):string=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:deny(400,'EXPECTED_INSTANT');
const exactKeys=(v:ObjectValue,keys:string[])=>{if(Object.keys(v).some(k=>!keys.includes(k)))deny(400,'UNSUPPORTED_REQUEST_FIELD');};
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const bytesHash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const nativeRequire=createRequire(import.meta.url);
interface Owner { tokenHash:string; owner:string; tenantId:string; principalId:string; rightsRefs:string[]; append:boolean; read:boolean; sealedAppend:boolean; sealedRead:boolean; protectedExecution?:boolean; dispatch?:boolean }
interface Reference { id:string; owner:string; version:string; contentDigest:string; content:Json;digestEncoding?:'NATIVE_UTF8_SHA256_V1' }
interface Receipt extends ObjectValue { schema:string; kind:'EVENT'|'REFERENCE'; identity:string; tenantId:string; principalId:string; semanticOwner:string; rightsRefs:string[]; episodeId:string|null; sequence:number; previousCheckpoint:string|null; checkpointDigest:string; signature:string; sealed:boolean; contentFile:string; storedDigest:string; requestDigest:string; references:Array<Omit<Reference,'content'>> }
const preparedTypes:Record<string,string[]>={
 S1:['BELIEF_VIEW','BELIEF_INVALIDATION'],
 S2:['PROPOSAL','DESIGN_REJECTION','SELECTION','ALLOCATION_REFERENCE','COLLECTION','STOPPING','DEVIATION','COST','CORRECTION','INVALIDATION','COMPUTE'],
 S3:['HYPOTHESIS','IDENTIFICATION','FIT','MODEL_REVISION','SIMULATION','REFUTATION','VALIDITY_CHANGE','CORRECTION','HUMAN_OVERRIDE','REJECTION','COMPUTE'],
 S4:['POLICY_SEARCH','POLICY_REVISION','BRANCH_CHOICE','OBSERVATION','INVALIDATION','REJECTION','OVERRIDE','HANDOFF','COMPUTE'],
 S5:['REQUEST','CANDIDATE','REFUSAL','RESERVATION','INVALIDATION','REVISION','CONSUMPTION','RECONCILIATION','RELEASE','COST','OVERRIDE'],
 S6:['INTENT','ADMISSION_REFUSAL','ATTEMPT','ACKNOWLEDGMENT','OBSERVATION','VERIFICATION','RECONCILIATION','CANCELLATION','COST','CORRECTION']
};
interface State { receipt:Receipt }
interface Configuration { policy:ObjectValue; release:ObjectValue; signerPath:string; protectedDirectory:string; contentDirectory:string; sealedEncryptionKeyPath?:string; dispatchConfigPath?:string }
async function safeRead(path:string,secret=false):Promise<Buffer> {
 // Inspect and read the same descriptor. Ordinary content can be replaced or
 // grown concurrently; never follow a substituted symlink or allocate its size.
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const f=await fd.stat(),limit=path.endsWith('commitments.jsonl')?256*1024*1024:8*1024*1024;
  if(f.size>limit)deny(503,'STORED_BYTE_LIMIT');if(!f.isFile()||(secret&&((f.mode&0o077)!==0||f.uid!==process.getuid?.())))deny(503,'UNSAFE_PROTECTED_FILE');
  const chunks:Buffer[]=[];let total=0;
  for(;;){const chunk=Buffer.allocUnsafe(Math.min(65536,limit+1-total));const read=await fd.read(chunk,0,chunk.length,null);if(!read.bytesRead)break;total+=read.bytesRead;if(total>limit)deny(503,'STORED_BYTE_LIMIT');chunks.push(chunk.subarray(0,read.bytesRead));}
  return Buffer.concat(chunks,total);
 }finally{await fd.close();}
}
async function artifactDigest(path:string){
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const st=await fd.stat();if(!st.isFile()||st.size>512*1024*1024)deny(503,'RUNTIME_ARTIFACT_BOUND');
  const digest=createHash('sha256'),chunk=Buffer.alloc(1024*1024);let size=0;
  for(;;){const {bytesRead}=await fd.read(chunk,0,chunk.length,null);if(!bytesRead)break;size+=bytesRead;if(size>512*1024*1024)deny(503,'RUNTIME_ARTIFACT_BOUND');digest.update(chunk.subarray(0,bytesRead));}
  if(size!==st.size)deny(503,'RUNTIME_ARTIFACT_CHANGED_DURING_READ');return digest.digest('hex');
 }finally{await fd.close();}
}
async function directory(path:string,protectedPath:boolean) {
 await mkdir(path,{recursive:true,mode:0o700});const st=await lstat(path);
 if(st.isSymbolicLink()||!st.isDirectory()||(protectedPath&&((st.mode&0o077)!==0||st.uid!==process.getuid?.())))deny(503,'UNSAFE_PROTECTED_DIRECTORY');
 if(await realpath(path)!==resolve(path))deny(503,'DIRECTORY_SYMLINK_COMPONENT');
}
async function syncDirectory(path:string){const fd=await open(path,'r');try{await fd.sync();}finally{await fd.close();}}
async function atomic(path:string,bytes:string|Buffer){const tmp=path+'.'+randomUUID()+'.tmp';const fd=await open(tmp,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}await rename(tmp,path);await syncDirectory(dirname(path));}
const refKey=(tenant:string,id:string)=>canonical([tenant,id]);

export class ExperienceLedger {
 private readonly states=new Map<string,State>();private readonly refs=new Map<string,{reference:Omit<Reference,'content'>;receipt:Receipt}>();
 private readonly privateKey;private readonly publicKey;private readonly owners:Owner[];private readonly policyDigest:string;private readonly verifierDigest:string;
 private readonly journalPath:string;private readonly anchorPath:string;private readonly lockPath:string;
 private last:Receipt|null=null;private journalHash=bytesHash('');private anchor:any=null;private lockHandle:FileHandle|null=null;
 private readonly commitments:Receipt[]=[];private witnessedHead:ObjectValue|null=null;
 private flockSync:((fd:number,flags:'exnb')=>void)|null=null;
 private queue:Promise<unknown>=Promise.resolve();private queued=0;private sealedKey:Buffer|null=null;
 private constructor(private readonly config:Configuration,private readonly reviewerPublicKey:string,key:Buffer) {
  this.privateKey=createPrivateKey(key);this.publicKey=createPublicKey(config.policy.signerPublicKey);this.owners=config.policy.owners;
  this.policyDigest=hash(config.policy);this.verifierDigest=hash(config.release.sourceDigests);
  this.journalPath=join(config.protectedDirectory,'commitments.jsonl');this.anchorPath=join(config.protectedDirectory,'head.json');this.lockPath=join(config.protectedDirectory,'writer.lock');
 }
 static async open(configPath:string,pinnedReviewer:string):Promise<ExperienceLedger>{
  if(!pinnedReviewer)deny(503,'MISSING_PINNED_RELEASE_ROOT');
  const config=JSON.parse((await safeRead(configPath,true)).toString()) as Configuration;
  object(config);object(config.policy);object(config.release);text(config.signerPath);text(config.protectedDirectory);text(config.contentDirectory);
  if(config.policy.schema!=='finnor.s6.ledger-policy.v1'||!['finnor.s6.ledger-release.v2','finnor.s6.ledger-release.v3'].includes(config.release.schema)||!['DISPOSABLE_TEST_AUTHORITY','REVIEWED_PROTECTED_DOMAIN'].includes(config.policy.domain))deny(503,'UNSUPPORTED_LEDGER_POLICY');
  if(config.dispatchConfigPath&&config.release.schema!=='finnor.s6.ledger-release.v3')deny(503,'DISPATCH_RELEASE_VERSION_REQUIRED');
  if(!Number.isSafeInteger(config.policy.maxEntries)||config.policy.maxEntries<1||config.policy.maxEntries>100000)deny(503,'ENTRY_LIMIT_INVALID');
  const owners=list(config.policy.owners);const tokens=new Set<string>();
  for(const owner of owners){object(owner);hex(owner.tokenHash);if(tokens.has(owner.tokenHash))deny(503,'AMBIGUOUS_IDENTITY');tokens.add(owner.tokenHash);text(owner.owner);text(owner.tenantId);text(owner.principalId);list(owner.rightsRefs).forEach(text);if(owner.rightsRefs.length===0||['append','read','sealedAppend','sealedRead'].some(k=>typeof owner[k]!=='boolean')||['protectedExecution','dispatch'].some(k=>owner[k]!==undefined&&typeof owner[k]!=='boolean')||owner.owner!=='S6'&&(owner.protectedExecution===true||owner.dispatch===true))deny(503,'UNSCOPED_IDENTITY');}
  if(config.policy.witness){
   const witness=object(config.policy.witness);exactKeys(witness,['schema','ledgerId','endpoint','publicKey','timeoutMs']);
   if(witness.schema!=='finnor.s6.monotonic-witness-binding.v1'||witness.timeoutMs!==5000||createPublicKey(text(witness.publicKey)).asymmetricKeyType!=='ed25519')deny(503,'WITNESS_BINDING_INVALID');text(witness.ledgerId);
   const endpoint=new URL(text(witness.endpoint));
   if(endpoint.origin!==witness.endpoint||endpoint.username||endpoint.password||!(endpoint.protocol==='https:'||config.policy.domain==='DISPOSABLE_TEST_AUTHORITY'&&endpoint.protocol==='http:'&&['127.0.0.1','[::1]'].includes(endpoint.hostname)))deny(503,'WITNESS_ENDPOINT_UNSUPPORTED');
  }else if(config.policy.domain==='REVIEWED_PROTECTED_DOMAIN')deny(503,'INDEPENDENT_WITNESS_REQUIRED');
  const key=await safeRead(config.signerPath,true);const ledger=new ExperienceLedger(config,pinnedReviewer,key);
  if(createPublicKey(ledger.privateKey).export({type:'spki',format:'pem'}).toString()!==ledger.publicKey.export({type:'spki',format:'pem'}).toString())deny(503,'SIGNER_MISMATCH');
  await ledger.verifyRelease();
  if(!['darwin','linux'].includes(process.platform))deny(503,'WRITER_LOCK_PLATFORM_UNSUPPORTED');
  ledger.flockSync=nativeRequire('fs-ext').flockSync;
  if(typeof ledger.flockSync!=='function')deny(503,'WRITER_LOCK_SUBSTRATE_UNAVAILABLE');
  if(config.protectedDirectory===config.contentDirectory||resolve(config.contentDirectory).startsWith(resolve(config.protectedDirectory)+'/'))deny(503,'ORDINARY_STORE_INSIDE_PROTECTED_STATE');
  await directory(config.protectedDirectory,true);await directory(config.contentDirectory,false);
  if(config.sealedEncryptionKeyPath){ledger.sealedKey=await safeRead(config.sealedEncryptionKeyPath,true);if(ledger.sealedKey.length!==32)deny(503,'SEALED_KEY_INVALID');}
  try{await ledger.acquireLock();await ledger.recover();}catch(e){await ledger.close();throw e;}return ledger;
 }
 private async verifyRelease(){
  const {signature,...body}=this.config.release;
  if(hash(this.config.policy)!==body.policyDigest||Date.parse(instant(body.validUntil))<=Date.now()||!verify(null,Buffer.from(canonical(body)),this.reviewerPublicKey,Buffer.from(text(signature),'base64')))deny(503,'RELEASE_AUTHORITY_INVALID_OR_EXPIRED');
  if(this.config.policy.domain==='REVIEWED_PROTECTED_DOMAIN'){
   const admission=this.config.policy.substrateAdmission;if(!admission)deny(503,'INDEPENDENT_SUBSTRATE_ADMISSION_REQUIRED');
   exactKeys(object(admission),['statement','signature']);const statement=object(admission.statement);
   exactKeys(statement,['schema','releaseId','sourceDigest','runtimeDigest','runtimeArtifactDigest','enforcementPolicyDigest','signerPublicKeyDigest','reviewerPublicKeyDigest','methodPublicKeyDigest','serviceUid','serviceGid','ordinaryUids','witnessBindingDigest','evaluatorKeyDigest','evidencePath','evidenceDigest','validAfter','validUntil']);
   const methodRoot=text(this.config.policy.methodAdmissionPublicKey),{substrateAdmission:_admission,...enforcementPolicy}=this.config.policy;
   if(methodRoot===this.reviewerPublicKey||methodRoot===this.config.policy.signerPublicKey||!verify(null,Buffer.from(canonical(statement)),methodRoot,Buffer.from(text(admission.signature),'base64')))deny(503,'INDEPENDENT_SUBSTRATE_ADMISSION_SIGNATURE_INVALID');
   const ordinary=list(statement.ordinaryUids,16);if(!ordinary.length||ordinary.some(uid=>!Number.isSafeInteger(uid)||uid<0||uid===process.getuid?.())||statement.serviceUid!==process.getuid?.()||statement.serviceGid!==process.getgid?.())deny(503,'PROTECTED_SERVICE_IDENTITY_OR_ISOLATION_UNADMITTED');
   if(statement.schema!=='finnor.s8.s6-substrate-admission.v1'||statement.releaseId!==body.releaseId||statement.sourceDigest!==hash(body.sourceDigests)||statement.runtimeDigest!==hash(body.runtime)||statement.enforcementPolicyDigest!==hash(enforcementPolicy)||statement.signerPublicKeyDigest!==bytesHash(this.config.policy.signerPublicKey)||statement.reviewerPublicKeyDigest!==bytesHash(this.reviewerPublicKey)||statement.methodPublicKeyDigest!==bytesHash(methodRoot)||statement.witnessBindingDigest!==hash(this.config.policy.witness)||Date.parse(instant(statement.validAfter))>Date.now()||Date.parse(instant(statement.validUntil))<=Date.now()||Date.parse(statement.validUntil)>Date.parse(body.validUntil))deny(503,'SUBSTRATE_ADMISSION_BINDING_INVALID');
   if(process.env.NODE_OPTIONS||process.execArgv.some(arg=>/^(--import|--loader|--require|-r)(=|$)/.test(arg))||!import.meta.url.endsWith('/ledger.js'))deny(503,'RING0_RUNTIME_LOADER_UNADMITTED');
   const runtimeFiles=[await realpath(process.execPath),...['ledger.js','ledger-server.mjs','protocol.js','request-verifier.js','adapter-contract.js','dispatch-broker.js','broker-io.js'].map(name=>fileURLToPath(new URL(name,import.meta.url)))];
   const artifacts=list(body.runtimeArtifacts,16);if(artifacts.length!==runtimeFiles.length||statement.runtimeArtifactDigest!==hash(artifacts))deny(503,'RUNTIME_ARTIFACT_SET_UNADMITTED');
   for(const path of runtimeFiles){const artifact=artifacts.find(a=>resolve(text(a.path))===resolve(path));if(!artifact||hex(artifact.sha256)!==await artifactDigest(path))deny(503,'RUNTIME_ARTIFACT_DIGEST_MISMATCH');}
   if(!this.config.sealedEncryptionKeyPath||bytesHash(await safeRead(this.config.sealedEncryptionKeyPath,true))!==hex(statement.evaluatorKeyDigest)||!this.owners.some(owner=>owner.owner==='S8'&&owner.read&&owner.sealedRead&&!owner.append&&!owner.sealedAppend&&!owner.dispatch&&!owner.protectedExecution))deny(503,'INDEPENDENT_EVALUATOR_ACCESS_UNADMITTED');
   if(bytesHash(await safeRead(text(statement.evidencePath)))!==hex(statement.evidenceDigest))deny(503,'SUBSTRATE_QUALIFICATION_EVIDENCE_CHANGED');
  }
  for(const pin of list(body.compatibleHistory??[],8)){exactKeys(object(pin),['releaseId','verifierDigest','policyDigest']);text(pin.releaseId);hex(pin.verifierDigest);hex(pin.policyDigest);}
  const required=['ledger.ts','ledger-server.mts','protocol.ts','request-verifier.ts','adapter-contract.ts'].map(name=>fileURLToPath(new URL(name,import.meta.url)));
  if(this.config.release.schema==='finnor.s6.ledger-release.v3')required.push(...['dispatch-broker.ts','broker-io.ts'].map(name=>fileURLToPath(new URL(name,import.meta.url))));
  const fsExtDirectory=dirname(nativeRequire.resolve('fs-ext/package.json'));
  required.push(join(fsExtDirectory,'fs-ext.js'),join(fsExtDirectory,'build/Release/fs_ext.node'),join(fsExtDirectory,'package.json'));
  if(canonical(body.runtime)!==canonical({node:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch}))deny(503,'RELEASE_RUNTIME_MISMATCH');
  const sources=list(body.sourceDigests);if(sources.length!==required.length)deny(503,'RELEASE_SOURCE_SET_MISMATCH');
  for(const path of required){const source=sources.find(s=>resolve(text(s.path))===resolve(path));if(!source||bytesHash(await safeRead(path))!==source.sha256)deny(503,'RELEASE_SOURCE_DIGEST_MISMATCH');}
 }
 private async acquireLock(){
  const fd=await open(this.lockPath,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{
   const stat=await fd.stat();
   if(!stat.isFile()||stat.size>8*1024*1024||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())deny(503,'UNSAFE_WRITER_LOCK_FILE');
   try{this.flockSync!(fd.fd,'exnb');}catch(error:any){
    if(error.code==='EAGAIN'||error.code==='EWOULDBLOCK')deny(503,'WRITER_ALREADY_ACTIVE');
    throw error;
   }
   this.lockHandle=fd;
   const previous=(await fd.readFile()).toString();
   const header='FINNOR_S6_WRITER_KERNEL_V2\n';
   if(previous&&!previous.startsWith(header)){
    let metadata:any;try{metadata=JSON.parse(previous);}catch{deny(503,'WRITER_LOCK_MIGRATION_INVALID');}
    // A still-live v1 writer did not take a kernel lock. Refuse that migration;
    // v2 metadata is diagnostic only and never used as PID-based ownership.
    if(metadata.schema!=='finnor.s6.ledger-writer.v2'){
     if(metadata.schema!==undefined||!Number.isSafeInteger(metadata.pid)||metadata.pid<1)deny(503,'WRITER_LOCK_MIGRATION_INVALID');
     try{process.kill(metadata.pid,0);deny(503,'LEGACY_WRITER_STILL_ACTIVE');}catch(error:any){if(error.code!=='ESRCH')throw error;}
    }
   }
   const writeAt=async(bytes:Buffer,position:number)=>{let offset=0;while(offset<bytes.length){const written=await fd.write(bytes,offset,bytes.length-offset,position+offset);if(!written.bytesWritten)deny(503,'WRITER_METADATA_WRITE_FAILED');offset+=written.bytesWritten;}};
   // Preserve the kernel-protocol header during every later diagnostic update.
   // A torn first installation or unknown legacy format remains unavailable.
   if(!previous.startsWith(header)){await writeAt(Buffer.from(header),0);await fd.sync();}
   await fd.truncate(Buffer.byteLength(header));await fd.sync();
   const metadata=Buffer.from(canonical({schema:'finnor.s6.ledger-writer.v2',pid:process.pid,verifierDigest:this.verifierDigest}));
   await writeAt(metadata,Buffer.byteLength(header));
   await fd.sync();await syncDirectory(this.config.protectedDirectory);
  }catch(error){this.lockHandle=null;await fd.close();throw error;}
 }
 private signed<T extends ObjectValue>(body:T):T&{signature:string}{return {...body,signature:sign(null,Buffer.from(canonical(body)),this.privateKey).toString('base64')};}
 private verifiedSignature(value:ObjectValue){const {signature,...body}=value;if(!verify(null,Buffer.from(canonical(body)),this.publicKey,Buffer.from(text(signature),'base64')))deny(503,'COMMITMENT_SIGNATURE_INVALID');return body;}
 private async persistAnchor(){this.anchor=this.signed({schema:'finnor.s6.ledger-head.v1',sequence:this.last?.sequence??0,checkpointDigest:this.last?.checkpointDigest??null});await atomic(this.anchorPath,canonical(this.anchor));}
 private async loadContent(receipt:Receipt):Promise<ObjectValue>{
  if(receipt.contentFile!==bytesHash(canonical([receipt.kind,receipt.tenantId,receipt.identity]))+'.json')deny(503,'CONTENT_PATH_INVALID');
  const bytes=await safeRead(join(this.config.contentDirectory,receipt.contentFile));if(bytesHash(bytes)!==receipt.storedDigest)deny(503,'COMMITTED_CONTENT_CHANGED');
  let content:any=JSON.parse(bytes.toString());
  if(receipt.sealed){if(!this.sealedKey)deny(503,'SEALED_KEY_UNAVAILABLE');const envelope=object(content);const dec=createDecipheriv('aes-256-gcm',this.sealedKey,Buffer.from(envelope.iv,'base64'));dec.setAAD(Buffer.from(receipt.requestDigest));dec.setAuthTag(Buffer.from(envelope.tag,'base64'));content=JSON.parse(Buffer.concat([dec.update(Buffer.from(envelope.ciphertext,'base64')),dec.final()]).toString());}
  if(hash(content)!==receipt.requestDigest)deny(503,'CONTENT_PREIMAGE_MISMATCH');return object(content);
 }
 private async recover(){
  let anchor:any,bytes:Buffer;
  try{anchor=JSON.parse((await safeRead(this.anchorPath,true)).toString());}catch(e:any){if(e.code!=='ENOENT')throw e;anchor=null;}
  try{bytes=await safeRead(this.journalPath,true);}catch(e:any){if(e.code!=='ENOENT')throw e;bytes=Buffer.alloc(0);}
  if(!anchor&&bytes.length)deny(503,'ANCHOR_MISSING_FOR_HISTORY');
  if(anchor){this.verifiedSignature(anchor);if(anchor.schema!=='finnor.s6.ledger-head.v1'||!Number.isSafeInteger(anchor.sequence)||anchor.sequence<0)deny(503,'HEAD_INVALID');}
  const complete=bytes.lastIndexOf(10)+1;const tail=bytes.subarray(complete);const lines=bytes.subarray(0,complete).toString().split('\n').filter(Boolean);
  if(lines.length>this.config.policy.maxEntries)deny(503,'RECOVERY_ENTRY_LIMIT');
  for(const line of lines){const receipt=JSON.parse(line) as Receipt;const body=this.verifiedSignature(receipt);const {checkpointDigest,...preimage}=body;
   if(hash(preimage)!==checkpointDigest||receipt.sequence!==(this.last?.sequence??0)+1||receipt.previousCheckpoint!==(this.last?.checkpointDigest??null)||receipt.schema!=='finnor.s6.ledger-receipt.v1')deny(503,'JOURNAL_CHAIN_INVALID');
   const pins=[{releaseId:this.config.release.releaseId,verifierDigest:this.verifierDigest,policyDigest:this.policyDigest},...(this.config.release.compatibleHistory??[])];
   if(!pins.some(pin=>pin.releaseId===receipt.releaseId&&pin.verifierDigest===receipt.verifierDigest&&pin.policyDigest===receipt.policyDigest))deny(503,'HISTORICAL_RELEASE_UNADMITTED_HISTORY_RETAINED');
   const request=await this.loadContent(receipt);if(this.states.has(this.stateKey(receipt)))deny(503,'DUPLICATE_COMMITTED_IDENTITY');this.install(receipt,request);this.last=receipt;
   if(anchor&&receipt.sequence===anchor.sequence&&receipt.checkpointDigest!==anchor.checkpointDigest)deny(503,'HEAD_FORKED');
  }
  if(anchor&&((this.last?.sequence??0)<anchor.sequence||anchor.sequence===0&&anchor.checkpointDigest!==null))deny(503,'ACKNOWLEDGED_HISTORY_TRUNCATED');
  if(tail.length){if((this.last?.sequence??0)<(anchor?.sequence??0))deny(503,'ACKNOWLEDGED_HISTORY_TORN');const fd=await open(this.journalPath,'r+');try{await fd.truncate(complete);await fd.sync();}finally{await fd.close();}bytes=bytes.subarray(0,complete);}
  if(!bytes.length){const fd=await open(this.journalPath,'a',0o600);await fd.sync();await fd.close();}
  this.journalHash=bytesHash(bytes);this.anchor=anchor;await this.ensureWitness();await this.persistAnchor();
 }
 private stateKey(receipt:Pick<Receipt,'kind'|'tenantId'|'identity'>){return canonical([receipt.kind,receipt.tenantId,receipt.identity]);}
 private install(receipt:Receipt,request:ObjectValue){this.states.set(this.stateKey(receipt),{receipt});this.commitments.push(receipt);for(const reference of receipt.references){const key=refKey(receipt.tenantId,reference.id);const prior=this.refs.get(key);if(prior&&hash(prior.reference)!==hash(reference))deny(503,'REFERENCE_HISTORY_CONFLICT');this.refs.set(key,{reference,receipt});}}
 async close(){const fd=this.lockHandle;this.lockHandle=null;if(fd)await fd.close();}
 authenticate(token:string):Owner{const d=bytesHash(token);const owner=this.owners.find(o=>timingSafeEqual(Buffer.from(o.tokenHash,'hex'),Buffer.from(d,'hex')));return owner??deny(401,'UNAUTHENTICATED_OWNER');}
 /** A fresh signed nonce response prevents replay; the external witness owns
  * monotonic persistence. This client never supplies a rollback/reset operation. */
 private async witnessRequest(operation:'READ'|'ADVANCE',expectedHead:{sequence:number;checkpointDigest:string|null}|null,steps:ObjectValue[],deadlineAt:number){
  const witness=this.config.policy.witness,remaining=deadlineAt-Date.now();if(remaining<=0)deny(503,'WITNESS_DEADLINE_EXCEEDED');
  const nonce=randomBytes(32).toString('hex'),body={schema:'finnor.s6.witness-request.v1',ledgerId:witness.ledgerId,signerDigest:hash(this.config.policy.signerPublicKey),operation,nonce,expectedHead,steps};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
  try{
   const response=await fetch(witness.endpoint+'/commitment',{method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:controller.signal,body:canonical(this.signed(body))});
   if(!response.ok)deny(503,'WITNESS_UNAVAILABLE');const reader=response.body?.getReader();if(!reader)deny(503,'WITNESS_RESPONSE_UNAVAILABLE');
   const chunks:Uint8Array[]=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();deny(503,'WITNESS_RESPONSE_BOUND');}chunks.push(part.value);}
   const answer=object(JSON.parse(Buffer.concat(chunks).toString())),{signature,...claim}=answer;
   exactKeys(claim,['schema','ledgerId','signerDigest','operation','nonce','sequence','checkpointDigest','acknowledgedAt']);
   if(claim.schema!=='finnor.s6.witness-response.v1'||claim.ledgerId!==body.ledgerId||claim.signerDigest!==body.signerDigest||claim.operation!==operation||claim.nonce!==nonce||!Number.isSafeInteger(claim.sequence)||claim.sequence<0||claim.sequence>this.config.policy.maxEntries||(claim.sequence===0?claim.checkpointDigest!==null:!(/^[a-f0-9]{64}$/.test(claim.checkpointDigest)))||!verify(null,Buffer.from(canonical(claim)),witness.publicKey,Buffer.from(text(signature),'base64')))deny(503,'WITNESS_RESPONSE_INVALID');
   instant(claim.acknowledgedAt);this.witnessedHead=answer;return {sequence:claim.sequence as number,checkpointDigest:claim.checkpointDigest as string|null};
  }catch(error){if(error instanceof LedgerFault)throw error;deny(503,'WITNESS_UNAVAILABLE');}finally{clearTimeout(timer);}
 }
 private async ensureWitness(){
  if(!this.config.policy.witness)return;
  const deadlineAt=Date.now()+5000;let head=await this.witnessRequest('READ',null,[],deadlineAt);
  const localSequence=this.last?.sequence??0,localCheckpoint=this.last?.checkpointDigest??null;
  if(head.sequence>localSequence)deny(503,'WITNESSED_HISTORY_ROLLED_BACK');
  if(head.checkpointDigest!==(head.sequence===0?null:this.commitments[head.sequence-1]?.checkpointDigest))deny(503,'WITNESSED_HISTORY_FORKED');
  while(head.sequence<localSequence){
   const steps=this.commitments.slice(head.sequence,Math.min(localSequence,head.sequence+256)).map(receipt=>({sequence:receipt.sequence,previousCheckpoint:receipt.previousCheckpoint,checkpointDigest:receipt.checkpointDigest}));
   const next=await this.witnessRequest('ADVANCE',head,steps,deadlineAt),last=steps.at(-1)!;
   if(next.sequence!==last.sequence||next.checkpointDigest!==last.checkpointDigest)deny(503,'WITNESS_ADVANCE_CONFLICT');head=next;
  }
  if(head.sequence!==localSequence||head.checkpointDigest!==localCheckpoint)deny(503,'WITNESS_HISTORY_CONFLICT');
 }
 private async integrity(){await this.verifyRelease();const journal=await safeRead(this.journalPath,true),anchor=JSON.parse((await safeRead(this.anchorPath,true)).toString());if(bytesHash(journal)!==this.journalHash||hash(anchor)!==hash(this.anchor))deny(503,'PROTECTED_HISTORY_CHANGED');for(const state of this.states.values())await this.loadContent(state.receipt);await this.ensureWitness();}
 private serialized<T>(fn:()=>Promise<T>):Promise<T>{if(this.queued>=256)return Promise.reject(new LedgerFault(429,'APPEND_BACKLOG_LIMIT'));this.queued++;const next=this.queue.then(fn,fn);this.queue=next.catch(()=>undefined);return next.finally(()=>{this.queued--;});}
 async health(owner:Owner){if(!owner.read)deny(403,'READ_NOT_AUTHORIZED');return this.serialized(async()=>{await this.integrity();return {status:'AVAILABLE',sequence:this.last?.sequence??0,checkpointDigest:this.last?.checkpointDigest??null,domain:this.config.policy.domain,nonrollbackableWitness:this.config.policy.witness?'PINNED_PROTOCOL_VERIFIED_DEPLOYMENT_QUALIFICATION_EXTERNAL':'REQUIRED_EXTERNAL_DEPENDENCY',witness:this.witnessedHead};});}
 async verifyRequest(owner:Owner,input:unknown){
  if(owner.owner!=='S6'||!owner.read)deny(403,'REQUEST_VERIFICATION_NOT_AUTHORIZED');
  return this.serialized(async()=>{
   await this.integrity();
   const request=object(input),ir=object(request.ir),ref=object(ir.obligationRef);
   const accepted=this.refs.get(refKey(owner.tenantId,text(ref.id)));
   if(!accepted||hash(accepted.reference)!==hash(ref)||accepted.reference.owner!=='S6'||accepted.receipt.sealed&&!owner.sealedRead||accepted.receipt.rightsRefs.some(r=>!owner.rightsRefs.includes(r)))deny(409,'ACCEPTED_OBLIGATION_REFERENCE_UNAVAILABLE');
   const stored=await this.loadContent(accepted.receipt);
   const reference=accepted.receipt.kind==='REFERENCE'?stored.reference:list(stored.references).find(r=>r.id===ref.id);
   if(!reference||hash(reference.content)!==ref.contentDigest)deny(503,'ACCEPTED_OBLIGATION_PREIMAGE_UNAVAILABLE');
   const verified=await verifyGovernedRequest(request,{...reference.content,ref},{owner,domain:this.config.policy.domain,methodAdmissionPublicKey:this.config.policy.methodAdmissionPublicKey,verifierSourceDigests:this.config.release.sourceDigests});
   const assessment=this.signed({schema:'finnor.s6.request-verification.v1',...verified,tenantId:owner.tenantId,principalId:owner.principalId,checkedAt:new Date().toISOString(),checkpointDigest:this.last?.checkpointDigest??null,releaseId:this.config.release.releaseId,verifierDigest:this.verifierDigest,executionAuthorityGranted:false,qualification:'MECHANICAL_BINDING_ONLY_CURRENT_OWNER_AND_CONSEQUENTIAL_EGRESS_ENFORCEMENT_REQUIRED'});
   return {status:'MECHANICALLY_VERIFIED_UNADMITTED',executionAuthorityGranted:false,assessment};
  });
 }
 private scope(owner:Owner,event:ObjectValue,sealed:boolean){if(!owner.append||sealed&&!owner.sealedAppend)deny(403,'APPEND_NOT_AUTHORIZED');if(event.tenantId!==owner.tenantId||event.principalId!==owner.principalId||event.semanticOwner!==owner.owner)deny(403,'SEMANTIC_OWNER_IDENTITY_MISMATCH');const rights=event.rightsRefs??(event.rightsRef?[event.rightsRef]:[]);list(rights).forEach(text);if(!rights.length||rights.some((r:string)=>!owner.rightsRefs.includes(r)))deny(403,'RIGHTS_NOT_AUTHORIZED');return [...new Set<string>(rights)].sort();}
 private validateReferences(owner:Owner,refs:any[],rightsRefs:string[],sealed:boolean):Reference[]{
  const ids=new Set<string>();return refs.map(raw=>{const ref=object(raw);exactKeys(ref,['id','owner','version','contentDigest','content','digestEncoding']);text(ref.id);text(ref.version);hex(ref.contentDigest);if(ids.has(ref.id)||ref.owner!==owner.owner)deny(403,'REFERENCE_OWNER_OR_IDENTITY_MISMATCH');ids.add(ref.id);if(referencePreimageDigest(ref as Reference)!==ref.contentDigest)deny(409,'REFERENCE_PREIMAGE_INVALID');const prior=this.refs.get(refKey(owner.tenantId,ref.id));const {content,...commitment}=ref;
   if(prior&&(hash(prior.reference)!==hash(commitment)||prior.receipt.sealed!==sealed||prior.receipt.rightsRefs.some(r=>!rightsRefs.includes(r))))deny(409,'REFERENCE_IDENTITY_IMMUTABLE');return ref as Reference;});
 }
 async registerReference(owner:Owner,input:any){const request=object(input);exactKeys(request,['reference','relatedReferences','rightsRefs','sealed']);const sealed=request.sealed===true;if(request.sealed!==undefined&&typeof request.sealed!=='boolean')deny(400,'SEAL_INVALID');const rights=this.scope(owner,{tenantId:owner.tenantId,principalId:owner.principalId,semanticOwner:owner.owner,rightsRefs:request.rightsRefs},sealed);return this.serialized(async()=>{await this.integrity();const related=list(request.relatedReferences??[],255),refs=this.validateReferences(owner,[request.reference,...related],rights,sealed);return this.commit(owner,request,'REFERENCE',refs[0]!.id,null,rights,refs,sealed);});}
 async append(owner:Owner,input:any){const request=object(input);exactKeys(request,['event','parents','references','sealed']);const event=object(request.event),sealed=request.sealed===true;if(request.sealed!==undefined&&typeof request.sealed!=='boolean')deny(400,'SEAL_INVALID');const rights=this.scope(owner,event,sealed);
  if(event.detail?.schema==='finnor.s6.protected-execution.v1'&&owner.protectedExecution!==true)deny(403,'PROTECTED_EXECUTION_APPEND_NOT_AUTHORIZED');
  return this.serialized(async()=>{await this.integrity();const identity=text(event.eventId);const existing=this.states.get(canonical(['EVENT',owner.tenantId,identity]));if(existing){if(hash(request)!==existing.receipt.requestDigest)deny(409,'EVENT_IDENTITY_IMMUTABLE');return {receipt:existing.receipt};}
   const ownerNumber=/^S([1-8])$/.exec(owner.owner)?.[1];if(!ownerNumber||event.schema!==`finnor.s${ownerNumber}.experience.v1`||!preparedTypes[owner.owner]?.includes(event.type)||!['H0','H1'].includes(event.horizon)||(Object.hasOwn(event,'protectedReceipt')&&event.protectedReceipt!==null)||(Object.hasOwn(event,'appendAuthorityGranted')&&event.appendAuthorityGranted!==false))deny(400,'UNSUPPORTED_PREPARED_EVENT');text(event.type);text(event.uncertainty);text(event.episodeId);text(event.revisionRef);hex(event.contentDigest);instant(event.knowledgeAt);instant(event.validAt);
   const {eventId,...body}=event;if(identity!==`s${ownerNumber}-event:${hash(body)}`)deny(409,'EVENT_IDENTITY_PREIMAGE_INVALID');
   const refs=this.validateReferences(owner,list(request.references),rights,sealed);const local=new Map(refs.map(r=>[r.id,r]));
   const resolveRef=(id:string)=>{const localRef=local.get(text(id));if(localRef)return localRef;const accepted=this.refs.get(refKey(owner.tenantId,id));if(!accepted||accepted.receipt.sealed&&!owner.sealedRead||accepted.receipt.rightsRefs.some(r=>!owner.rightsRefs.includes(r)))deny(409,'UNCOMMITTED_OR_UNAUTHORIZED_REFERENCE');return accepted.reference;};
   const revision=resolveRef(event.revisionRef);
   // S3–S5 bind contentDigest to detail; revisionRef names a distinct subject.
   // A subject commitment cannot authenticate a malformed detail digest.
   if(['S3','S4','S5'].includes(owner.owner)){
    object(event.detail);if(hash(event.detail)!==event.contentDigest)deny(409,'EVENT_CONTENT_PREIMAGE_INVALID');
   }else if(event.detail!==undefined?hash(event.detail)!==event.contentDigest&&revision.contentDigest!==event.contentDigest:revision.contentDigest!==event.contentDigest)deny(409,'EVENT_CONTENT_PREIMAGE_INVALID');
   const parents=list(request.parents);const supplied=new Set<string>();for(const parent of parents){const p=object(parent);const accepted=this.states.get(canonical(['EVENT',owner.tenantId,p.eventId]));if(!accepted||hash(p)!==hash(accepted.receipt)||p.sealed&&!owner.sealedRead||p.rightsRefs.some((r:string)=>!owner.rightsRefs.includes(r)))deny(409,'PARENT_RECEIPT_INVALID');if(supplied.has(p.eventId))deny(409,'DUPLICATE_PARENT');supplied.add(p.eventId);}
   // S1 v1 has causalParents but no preparedParentRefs; S2–S6 declare both.
   const expectedParents=list(owner.owner==='S1'?(event.preparedParentRefs??[]):event.preparedParentRefs).map(parent=>text(parent));for(const parent of expectedParents){if(!supplied.has(parent))resolveRef(parent);}
   const causal=list(event.causalParents).map(parent=>text(parent));for(const parent of causal){if(!supplied.has(parent))deny(409,'CAUSAL_PARENT_RECEIPT_MISSING');if(parents.find(p=>p.eventId===parent)?.episodeId!==event.episodeId)deny(409,'CAUSAL_PARENT_EPISODE_INVALID');}
   if([...supplied].some(id=>!expectedParents.includes(id)&&!causal.includes(id)))deny(409,'UNBOUND_PARENT');
   for(const dependency of list(event.dependencyRefs,owner.owner==='S1'?5002:256))resolveRef(text(dependency));if(event.freshnessRef)resolveRef(text(event.freshnessRef));for(const freshness of list(event.freshnessRefs??[]))resolveRef(text(freshness));for(const provenance of list(event.provenanceRefs??[],owner.owner==='S1'?1000:256)){const supplied=typeof provenance==='string'?null:object(provenance);const ref=resolveRef(typeof provenance==='string'?provenance:text(supplied!.revisionId??supplied!.id));if(supplied&&supplied.contentDigest&&ref.contentDigest!==supplied.contentDigest)deny(409,'PROVENANCE_REVISION_DIGEST_MISMATCH');}if(event.modelComputeRef)resolveRef(typeof event.modelComputeRef==='string'?event.modelComputeRef:text(object(event.modelComputeRef).id));
   return this.commit(owner,request,'EVENT',identity,event.episodeId,rights,refs,sealed);
  });
 }
 private async commit(owner:Owner,request:ObjectValue,kind:Receipt['kind'],identity:string,episodeId:string|null,rightsRefs:string[],refs:Reference[],sealed:boolean){
  const key=canonical([kind,owner.tenantId,identity]),requestDigest=hash(request),existing=this.states.get(key);if(existing){if(existing.receipt.requestDigest!==requestDigest)deny(409,'IDENTITY_IMMUTABLE');return {receipt:existing.receipt};}
  if(this.states.size>=this.config.policy.maxEntries)deny(429,'ENTRY_LIMIT');if(sealed&&!this.sealedKey)deny(503,'SEALED_KEY_UNAVAILABLE');
  let bytes=Buffer.from(canonical(request));if(sealed){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.sealedKey!,iv);cipher.setAAD(Buffer.from(requestDigest));const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);bytes=Buffer.from(canonical({schema:'finnor.s6.sealed-content.v1',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));}
  const contentFile=bytesHash(key)+'.json';await atomic(join(this.config.contentDirectory,contentFile),bytes);
  const preimage={schema:'finnor.s6.ledger-receipt.v1',kind,identity,...(kind==='EVENT'?{eventId:identity,eventDigest:hash(request.event)}:{}),tenantId:owner.tenantId,principalId:owner.principalId,semanticOwner:owner.owner,protectedExecution:owner.protectedExecution===true,rightsRefs,episodeId,sequence:(this.last?.sequence??0)+1,previousCheckpoint:this.last?.checkpointDigest??null,sealed,requestDigest,contentFile,storedDigest:bytesHash(bytes),references:refs.map(({content,...r})=>r),parentCheckpoints:(request.parents??[]).map((p:Receipt)=>p.checkpointDigest),releaseId:this.config.release.releaseId,verifierDigest:this.verifierDigest,policyDigest:this.policyDigest,appendAt:new Date().toISOString()};
  const receipt=this.signed({...preimage,checkpointDigest:hash(preimage)}) as Receipt;
  const fd=await open(this.journalPath,'a',0o600);try{await fd.writeFile(canonical(receipt)+'\n');await fd.sync();}finally{await fd.close();}
  this.install(receipt,request);this.last=receipt;this.journalHash=bytesHash(await safeRead(this.journalPath,true));await this.persistAnchor();await this.ensureWitness();return {receipt};
 }
 async read(owner:Owner,identity:string){if(!owner.read)deny(403,'READ_NOT_AUTHORIZED');return this.serialized(async()=>{await this.integrity();const state=this.states.get(canonical(['EVENT',owner.tenantId,identity]));if(!state)deny(404,'EVENT_NOT_FOUND');if(state.receipt.sealed&&!owner.sealedRead||state.receipt.rightsRefs.some(r=>!owner.rightsRefs.includes(r)))deny(403,'EVALUATOR_OR_RIGHTS_NOT_AUTHORIZED');return {event:(await this.loadContent(state.receipt)).event,receipt:state.receipt};});}
 async readReference(owner:Owner,id:string){
  if(!owner.read)deny(403,'READ_NOT_AUTHORIZED');text(id);
  return this.serialized(async()=>{
   await this.integrity();const accepted=this.refs.get(refKey(owner.tenantId,id));if(!accepted)deny(404,'REFERENCE_NOT_FOUND');
   if(accepted.receipt.sealed&&!owner.sealedRead||accepted.receipt.rightsRefs.some(r=>!owner.rightsRefs.includes(r)))deny(403,'EVALUATOR_OR_RIGHTS_NOT_AUTHORIZED');
   const committed=await this.loadContent(accepted.receipt);
   const reference=accepted.receipt.kind==='REFERENCE'?[committed.reference,...list(committed.relatedReferences??[],255)].find(r=>r.id===id):list(committed.references).find(r=>r.id===id);
   if(!reference||referencePreimageDigest(reference)!==accepted.reference.contentDigest)deny(503,'ACCEPTED_REFERENCE_PREIMAGE_UNAVAILABLE');
   return {reference,receipt:accepted.receipt};
  });
 }
 releaseIdentity(){return {releaseId:this.config.release.releaseId,verifierDigest:this.verifierDigest,policyDigest:this.policyDigest,sourceDigests:this.config.release.sourceDigests,runtime:this.config.release.runtime,domain:this.config.policy.domain};}
 private async collectObligationHistory(owner:Owner,obligationId:string){
   const result:Array<{event:ObjectValue;receipt:Receipt}>=[];
   for(const state of this.states.values()){
    const receipt=state.receipt;if(receipt.kind!=='EVENT'||receipt.tenantId!==owner.tenantId||receipt.principalId!==owner.principalId||receipt.semanticOwner!=='S6'||receipt.protectedExecution!==true||receipt.sealed&&!owner.sealedRead||receipt.rightsRefs.some(r=>!owner.rightsRefs.includes(r)))continue;
    const event=object((await this.loadContent(receipt)).event);
    if(event.detail?.schema!=='finnor.s6.protected-execution.v1'||event.detail.obligationRef?.id!==obligationId)continue;
    result.push({event,receipt});if(result.length>512)deny(429,'OBLIGATION_HISTORY_BOUND');
   }
   return result.sort((a,b)=>a.receipt.sequence-b.receipt.sequence);
 }
 /** Projection over authenticated accepted history, not an additional effect ledger. */
 async readObligationHistory(owner:Owner,obligationId:string){
  if(owner.owner!=='S6'||!owner.read)deny(403,'EXECUTION_HISTORY_READ_NOT_AUTHORIZED');text(obligationId);
  return this.serialized(async()=>{await this.integrity();return this.collectObligationHistory(owner,obligationId);});
 }
 /** Read-only S6-owned contract for future semantic consumers. Its signature
  * authenticates accepted bytes and access qualification, never attribution. */
 async readExecutionHandoff(owner:Owner,obligationId:string){
  if(!owner.read||!['S6','S7','S8'].includes(owner.owner)||owner.owner!=='S6'&&(owner.append||owner.protectedExecution||owner.dispatch||owner.sealedAppend))deny(403,'CONSUMER_HANDOFF_REQUIRES_ATTENUATED_READER');text(obligationId);
  return this.serialized(async()=>{
   await this.integrity();const accepted=this.refs.get(refKey(owner.tenantId,obligationId));
   if(!accepted||accepted.reference.owner!=='S6'||accepted.receipt.principalId!==owner.principalId)deny(404,'OBLIGATION_HANDOFF_NOT_FOUND');
   if(accepted.receipt.sealed&&!owner.sealedRead||accepted.receipt.rightsRefs.some(r=>!owner.rightsRefs.includes(r)))deny(403,'EVALUATOR_OR_RIGHTS_NOT_AUTHORIZED');
   const content=await this.loadContent(accepted.receipt),reference=[content.reference,...list(content.relatedReferences??[],255)].find(r=>r?.id===obligationId);
   if(!reference||referencePreimageDigest(reference)!==accepted.reference.contentDigest)deny(503,'OBLIGATION_HANDOFF_PREIMAGE_INVALID');
   const obligation={...reference.content,ref:accepted.reference};delete obligation.ref.content;
   if(obligation.tenantId!==owner.tenantId||obligation.principalId!==owner.principalId||!owner.rightsRefs.includes(obligation.rightsRef))deny(403,'HANDOFF_OBLIGATION_SCOPE_INVALID');
   const history=await this.collectObligationHistory(owner,obligationId),intent=history.find(row=>row.event.type==='INTENT');
   const refs=[obligation.ref,obligation.mandateRef,obligation.policyRef,obligation.decisionRef,obligation.allocationRef,obligation.reservationRef,obligation.consumptionRef,obligation.interventionRef,intent?.event.detail.requestRef].filter(Boolean).map(ref=>{
    const original=this.refs.get(refKey(owner.tenantId,ref.id));
    return original&&!original.receipt.sealed&&original.receipt.rightsRefs.every(r=>owner.rightsRefs.includes(r))?{reference:original.reference,receipt:original.receipt}:{reference:ref,receipt:null,qualification:'OWNER_PREIMAGE_OR_AUTHORIZED_ACCESS_PENDING'};
   });
   const handoff={schema:'finnor.s6.consumer-handoff.v1',semanticOwner:'S6',version:'s6-consumer-handoff-v1',consumer:{semanticOwner:owner.owner,tenantId:owner.tenantId,principalId:owner.principalId,rightsRefs:owner.rightsRefs,sealedRead:owner.sealedRead,appendAuthorityGranted:false},obligation,obligationReceipt:accepted.receipt,request:intent?.event.detail.request??null,methodAdmissions:intent?.event.detail.request?.admissions??[],executorContract:s6AdapterContract('CONDITIONAL_JSON_RECORD_V1'),history,attempts:history.filter(row=>row.event.type==='ATTEMPT'),exposure:history.filter(row=>['ATTEMPT','ACKNOWLEDGMENT'].includes(row.event.type)),observations:history.filter(row=>row.event.type==='OBSERVATION'),settlements:history.filter(row=>row.event.type==='VERIFICATION'),costs:history.map(row=>({eventId:row.event.eventId,costs:row.event.detail.costs,funding:row.event.detail.funding??null})),references:refs,checkpoint:{sequence:this.last?.sequence??0,checkpointDigest:this.last?.checkpointDigest??null},release:this.releaseIdentity(),witness:this.witnessedHead??null,evaluatorAccess:{sealedContentIncluded:owner.sealedRead,independentReleaseEstablished:false},horizons:{accepted:history.map(row=>({eventId:row.event.eventId,horizon:row.event.horizon})),futureH1H2Attribution:'NOT_ESTABLISHED_BY_S6_TRANSPORT'},attributionGranted:false,resourceReleaseGranted:false,executionAuthorityGranted:false,knowledgeAt:new Date().toISOString()};
   if(Buffer.byteLength(canonical(handoff))>8*1024*1024)deny(413,'CONSUMER_HANDOFF_BYTE_BOUND');
   return {handoff,signature:this.signed(handoff).signature};
  });
 }
}
