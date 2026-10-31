import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,realpath,stat,readlink,lstat} from 'node:fs/promises';
import {createReadStream,constants,type BigIntStats} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {UniformNativeReceipt} from '../../../shared-types/src/algorithm-theory';
import {hash} from './syntax';

const sourceDirectory=dirname(fileURLToPath(import.meta.url));
const repo=resolve(sourceDirectory,'../../../../..');
export const specificationPath=join(sourceDirectory,'Specification.lean');
const archiveDigest='9019fcd34e93fddf0ecf9d40d28f05a86ba563ac3b701a9c5116ce1c96379360';
const expectedInventoryDigest='70fd8542a051a0cae60f61fa30154d6743c490f1b6b069fc599d50f6c73b667a';
// Each check re-resolves the claim in a database transaction, while the owner's compute lease lasts 90 seconds.
const heartbeatMs=1000;
export interface NativeBudget {deadlineAt:number;scratch:string;current?:()=>Promise<boolean>}
export interface ToolIdentity {root:string;archiveDigest:string;inventoryDigest:string;identityDigest:string}
// Every call re-stats every pinned file; bytes are re-hashed only when kernel-maintained
// identity metadata (device, inode, mode, size, mtime, ctime) differs from that file's last match.
// Calls run one at a time, so a call made during a cold full hash reuses its fingerprints
// instead of hashing the toolchain again, while still starting its own pass after it was made.
// A file's fingerprint is kept as soon as its bytes match, so a pass that fails or runs out of time
// on a cold file cache leaves the next pass only the files it had not reached.
let verifiedRuntime:{root:string;identityDigest:string;fingerprints:Map<string,string>}|null=null;
let runtimeVerification:Promise<unknown>=Promise.resolve();
const fingerprint=(info:BigIntStats)=>[info.dev,info.ino,info.mode,info.size,info.mtimeNs,info.ctimeNs].join(':');
export function toolIdentity(deadlineAt=Date.now()+30000):Promise<ToolIdentity>{
 const next=runtimeVerification.catch(()=>undefined).then(()=>verifyToolIdentity(deadlineAt));
 runtimeVerification=next;return next;
}
/** The first full pass hashes the whole toolchain, which takes seconds on a warm file cache and far longer on a cold
 * one. A process that starts it before its first request keeps that cost out of the request's deadline. Requests still
 * call toolIdentity themselves, so this moves verification earlier and never stands in for it. */
export function prewarmToolIdentity(){void toolIdentity(Date.now()+300000).catch(()=>undefined);}
async function verifyToolIdentity(deadlineAt:number):Promise<ToolIdentity>{
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Y5_NATIVE_HOST_UNSUPPORTED');
 const root=resolve(process.env.FINNOR_Y5_TOOLCHAIN_ROOT??join(repo,'.y5-tools/lean-4.34.1-darwin_aarch64'));
 const bytes=await readFile(join(root,'finnor-runtime-identity.json'));
 const identity=JSON.parse(bytes.toString()) as {archiveSha256:string;inventoryDigest:string;files:{path:string;sha256:string;kind:string}[]};
 if(identity.archiveSha256!==archiveDigest||identity.inventoryDigest!==expectedInventoryDigest)throw Error('Y5_RUNTIME_IDENTITY');
 if(hash(JSON.stringify(identity.files))!==identity.inventoryDigest)throw Error('Y5_RUNTIME_INVENTORY');
 const identityDigest=hash(bytes);
 const fingerprints=verifiedRuntime?.root===root&&verifiedRuntime.identityDigest===identityDigest?verifiedRuntime.fingerprints:new Map<string,string>();
 verifiedRuntime={root,identityDigest,fingerprints};
 for(let offset=0;offset<identity.files.length;offset+=8){
  if(Date.now()>=deadlineAt)throw Error('Y5_RUNTIME_VERIFICATION_DEADLINE');
  await Promise.all(identity.files.slice(offset,offset+8).map(async pin=>{
   const file=resolve(root,pin.path);if(!file.startsWith(root+'/'))throw Error('Y5_RUNTIME_INVENTORY');
   const info=await lstat(file,{bigint:true});
   let actual:string;
   if(pin.kind==='SYMLINK'){
    if(!info.isSymbolicLink()||!(await realpath(file)).startsWith(root+'/'))throw Error('Y5_RUNTIME_BYTES_CHANGED');
    actual=hash(await readlink(file));
   }else{
    if(!info.isFile()||info.isSymbolicLink())throw Error('Y5_RUNTIME_BYTES_CHANGED');
    const before=fingerprint(info);
    if(fingerprints.get(pin.path)===before)return;
    const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);actual=h.digest('hex');
    if(fingerprint(await lstat(file,{bigint:true}))!==before)throw Error('Y5_RUNTIME_BYTES_CHANGED');
    if(actual===pin.sha256)fingerprints.set(pin.path,before);
   }
   if(actual!==pin.sha256)throw Error('Y5_RUNTIME_BYTES_CHANGED');
  }));
 }
 return {root,archiveDigest,inventoryDigest:identity.inventoryDigest,identityDigest};
}
export async function prepareScratch(path:string){
 const absolute=resolve(path);await mkdir(absolute,{recursive:true,mode:0o700});
 if(await realpath(absolute)!==absolute)throw Error('Y5_SCRATCH_SYMLINK');
 await writeFile(join(absolute,'.finnor-y5-owned'),'Y5 disposable native artifacts\n',{
  flag:constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,mode:0o600});
 return absolute;
}
let active=0;
export async function withNativeCapacity<T>(f:()=>Promise<T>):Promise<T>{
 if(active)throw Error('Y5_NATIVE_CAPACITY_UNAVAILABLE');active++;
 try{return await f();}finally{active--;}
}
export async function native(tool:ToolIdentity,args:string[],budget:NativeBudget,logName:string):Promise<UniformNativeReceipt>{
 if(!Number.isFinite(budget.deadlineAt))throw Error('Y5_NATIVE_DEADLINE_ARGUMENT');
 if(Date.now()>=budget.deadlineAt||budget.current&&!await budget.current())throw Error('Y5_ORIGINAL_DEADLINE_OR_FENCE');
 const directory=await prepareScratch(budget.scratch);
 if(!/^[a-zA-Z0-9-]+$/.test(logName)||args.some(a=>a.includes('\0')))throw Error('Y5_NATIVE_ARGUMENT');
 const binary=args[0]==='leanchecker'?'leanchecker':'lean',actual=[...(binary==='lean'?['-j','1']:[]),...args.slice(1)];
 if(!['lean','leanchecker'].includes(args[0]??''))throw Error('Y5_NATIVE_BINARY_ARGUMENT');
 if(binary==='leanchecker'){
  if(args.length!==2||!['Candidate','Total'].includes(args[1]!))throw Error('Y5_NATIVE_REPLAY_ARGUMENT');
  const object=join(directory,args[1]+'.olean');
  const info=await lstat(object).catch(()=>null),prefix=await lstat(join(directory,args[1]!)).catch(error=>{
   if(error.code==='ENOENT')return null;throw error;
  });
  if(!info?.isFile()||info.isSymbolicLink()||prefix||await realpath(object)!==object)throw Error('Y5_NATIVE_REPLAY_ARGUMENT');
 }
 const sandboxPolicyPath=join(sourceDirectory,'native-sandbox.sb');
 if(await realpath(sandboxPolicyPath)!==sandboxPolicyPath)throw Error('Y5_NATIVE_SANDBOX_POLICY_SYMLINK');
 const sandboxPolicyDigest=hash(await readFile(sandboxPolicyPath));
 let receipt:UniformNativeReceipt|null=null,reason:string|null=null,physicalPid=0,diagnosticBytes=0;
 const deadlineAt=Math.min(Date.now()+30000,budget.deadlineAt);
 const child=spawn(process.execPath,[join(sourceDirectory,'native-supervisor.mjs')],{
  cwd:directory,detached:true,stdio:['ignore','pipe','pipe','ipc'],
  env:{NODE_ENV:'development',PATH:join(tool.root,'bin')+':/usr/bin:/bin',HOME:directory,TMPDIR:directory,LANG:'C.UTF-8',
   LEAN_PATH:directory,LEAN_SYSROOT:tool.root},
 });
 const stop=(why:string)=>{reason??=why;if(child.connected)child.send({kind:'Y5_STOP',reason:why},()=>undefined);};
 for(const stream of [child.stdout,child.stderr])stream?.on('data',(b:Buffer)=>{diagnosticBytes+=b.length;if(diagnosticBytes>16384)stop('Y5_GUARDIAN_PROTOCOL_OUTPUT');});
 child.on('message',(message:any)=>{
  if(message?.guardianPid===child.pid&&message.kind==='Y5_STARTED')physicalPid=message.pid;
  if(message?.kind==='Y5_CLOSED'&&message.receipt?.guardianPid===child.pid&&message.receipt.childCloseObserved===true){
   receipt=message.receipt;reason??=message.stopReason;
  }
 });
 const timer=setTimeout(()=>stop('Y5_NATIVE_DEADLINE'),Math.max(1,deadlineAt-Date.now()));
 let checking=false;
 const heartbeat=setInterval(async()=>{if(checking||!budget.current)return;checking=true;try{if(!await budget.current())stop('Y5_CLAIM_CANCELLED');}catch{stop('Y5_CURRENTNESS_UNAVAILABLE');}finally{checking=false;}},heartbeatMs);
 try{
  await new Promise<void>(accept=>{
   child.once('error',()=>{reason??='Y5_NATIVE_GUARDIAN_SPAWN_FAILED';});
   child.once('close',()=>accept());
   child.send({kind:'Y5_START',config:{root:tool.root,directory,binary,args:actual,deadlineAt,logName,
    sandboxPolicyPath,sandboxPolicyDigest,callerPid:process.pid}},()=>undefined);
  });
 }finally{clearTimeout(timer);clearInterval(heartbeat);}
 if(!receipt){
  if(physicalPid)try{process.kill(-physicalPid,'SIGKILL');}catch{}
  throw Object.assign(Error('Y5_NATIVE_GUARDIAN_LOST_PHYSICAL_COMPLETION_UNKNOWN'),{physicalCompletion:'UNKNOWN',guardianPid:child.pid,physicalPid});
 }
 if(reason)throw Object.assign(Error(reason),{receipt});
 return receipt as UniformNativeReceipt;
}
export async function installSpecification(budget:NativeBudget,source:string,tool:ToolIdentity){
 const directory=await prepareScratch(budget.scratch);
 if((await stat(directory)).isDirectory()!==true)throw Error('Y5_SCRATCH_UNAVAILABLE');
 await writeFile(join(directory,'Specification.lean'),source,{mode:0o600});
 const result=await native(tool,['lean','-M','2048','-T','200000','-o','Specification.olean','Specification.lean'],budget,'specification-build');
 if(result.exitCode!==0)throw Object.assign(Error('Y5_SPECIFICATION_BUILD'),{receipt:result});
 return result;
}
