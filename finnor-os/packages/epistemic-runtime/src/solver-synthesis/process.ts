import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,realpath,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {bytesHash} from './contracts';

export interface ScientificProcessObserver {
 started:(group:number,identity:Record<string,unknown>)=>Promise<void>;
 closed:(group:number,result:Record<string,unknown>)=>Promise<void>;
}
interface ProcessClose {code:number|null;signal:string|null;identity:Record<string,unknown>;stderr:string;signalRefusal:string|null;physicalGroupClosed:true}
const observers=new AsyncLocalStorage<ScientificProcessObserver>();
export const withScientificProcessObserver=<T>(observer:ScientificProcessObserver,run:()=>Promise<T>)=>observers.run(observer,run);

/** One serial JSON-lines operation at a time, bounded frames and original wall.
 * The supported ordinary macOS path enforces Seatbelt. Linux remains refused
 * until an independently packaged and qualified isolation adapter is supplied. */
export class JsonProcess {
 private buffer='';private stderr='';private waiter:{resolve:(value:unknown)=>void;reject:(e:Error)=>void}|null=null;
 private failure:Error|null=null;private signalFailure:Error|null=null;private timer:NodeJS.Timeout;private abort:()=>void;
 readonly finished:Promise<{code:number|null;signal:string|null}>;
 private constructor(readonly child:ChildProcessWithoutNullStreams,private scratch:string,readonly identity:Record<string,unknown>,readonly deadlineAt:number,private signal?:AbortSignal,private observer=observers.getStore()) {
  this.finished=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  child.once('error',error=>this.fail(error));child.once('close',code=>{if(this.waiter)this.fail(Error('R8_CHILD_CLOSED:'+code+':'+this.stderr.slice(-4096)));});
  child.stdin.on('error',error=>this.fail(error));
  child.stderr.on('data',(chunk:Buffer)=>{if(this.stderr.length+chunk.length>131072)this.fail(Error('R8_STDERR_BOUND'));else this.stderr+=chunk.toString();});
  child.stdout.on('data',(chunk:Buffer)=>{
   if(this.buffer.length+chunk.length>1048576){this.fail(Error('R8_CHILD_FRAME_BOUND'));return;}this.buffer+=chunk.toString();
   let end:number;while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
    if(!line)continue;const waiter=this.waiter;this.waiter=null;if(!waiter){this.fail(Error('R8_UNSOLICITED_CHILD_FRAME'));return;}
    try{waiter.resolve(JSON.parse(line));}catch{waiter.reject(Error('R8_CHILD_JSON_INVALID'));this.fail(Error('R8_CHILD_JSON_INVALID'));}
   }
  });
  this.timer=setTimeout(()=>this.fail(Error('R8_ORIGINAL_DEADLINE_EXHAUSTED')),Math.max(1,deadlineAt-Date.now()));
  this.abort=()=>this.fail(Error('R8_CANCELLED_OR_CAPACITY_LOST'));signal?.addEventListener('abort',this.abort,{once:true});
  if(signal?.aborted)this.abort();
 }
 static async open(input:{executable:string;args:string[];environment?:Record<string,string>;readPaths:string[];deadlineAt:number;signal?:AbortSignal}):Promise<JsonProcess> {
  if(process.platform!=='darwin')throw Error('R8_SCIENTIFIC_ISOLATION_SUBSTRATE_UNQUALIFIED');
  if(input.signal?.aborted)throw Error('R8_CANCELLED_OR_CAPACITY_LOST');
  if(!Number.isFinite(input.deadlineAt)||input.deadlineAt<=Date.now()||input.deadlineAt-Date.now()>3600000)throw Error('R8_ORIGINAL_DEADLINE_REQUIRED');
  const scratch=await realpath(await mkdtemp(join(tmpdir(),'finnor-r8-process-')));
  try{
   const executable=await realpath(input.executable),readPaths=await Promise.all(input.readPaths.map(path=>realpath(path)));
   const q=(v:string)=>JSON.stringify(v),metadata=new Set<string>();
   for(const path of [executable,scratch,...readPaths])for(let parent=dirname(path);;parent=dirname(parent)){metadata.add(parent);if(parent==='/')break;}
   const profile=['(version 1)','(deny default)','(import "dyld-support.sb")','(allow syscall*)','(allow sysctl-read)',
    // The trusted supervisor may kill its own group on actual parent death.
    // Generated ASTs cannot signal or call hosts. The unsandboxed parent owns
    // the same group and observes physical close before releasing capacity.
    '(allow process-fork)','(allow signal)',
    `(allow process-exec ${[executable,...readPaths].map(path=>`(subpath ${q(path)})`).join(' ')})`,
    `(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath ${q(scratch)}) ${[executable,...readPaths].map(path=>`(subpath ${q(path)})`).join(' ')} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
    `(allow file-read-metadata ${[...metadata].map(path=>`(literal ${q(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${q(scratch)}) (literal "/dev/null"))`,
   ].join('\n');
   const policy=join(scratch,'enforced.sb');await writeFile(policy,profile,{mode:0o400});
   const identity={executable,executableDigest:bytesHash(await readFile(executable)),args:input.args,profileDigest:bytesHash(profile),readPaths,substrate:'MACOS_SEATBELT_ORDINARY_SCIENTIFIC',memory:'PROCESS_MEASURED_NO_HARD_AGGREGATE_QUOTA',credentials:'SCRUBBED_NO_NETWORK_NO_OWNER_SIGNER'};
   // Filesystem and executable-identity reads spend the same original wall.
   // Cancellation/deadline may have changed while those awaits were in flight.
   if(input.signal?.aborted)throw Error('R8_CANCELLED_OR_CAPACITY_LOST');
   if(Date.now()>=input.deadlineAt)throw Error('R8_ORIGINAL_DEADLINE_EXHAUSTED');
   const child=spawn('/usr/bin/sandbox-exec',['-f',policy,executable,...input.args],{cwd:scratch,
    env:{HOME:scratch,TMPDIR:scratch,LANG:'C',TZ:'UTC',NODE_ENV:'production',...input.environment,
     PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:join(scratch,'empty-python-cache')},
    stdio:['pipe','pipe','pipe'],detached:true});
   const session=new JsonProcess(child,scratch,identity,input.deadlineAt,input.signal);
   try{if(child.pid)await session.observer?.started(child.pid,session.identity);}
   catch(error){session.kill();await session.close();throw error;}
   return session;
  }catch(error){await rm(scratch,{recursive:true,force:true});throw error;}
 }
 private fail(error:Error){if(!this.failure)this.failure=error;const waiter=this.waiter;this.waiter=null;waiter?.reject(error);this.kill();}
 private kill(){if(this.child.pid)try{process.kill(-this.child.pid,'SIGKILL');}catch(error){
  if((error as NodeJS.ErrnoException).code!=='ESRCH')this.signalFailure=new Error('R8_PHYSICAL_GROUP_SIGNAL_REFUSED:'+String(error),{cause:error});
  // Event/timer callbacks cannot throw a control-plane process crash. A refusal
  // is retained, never proof of release; physicalClose still requires ESRCH.
 }}
 async request(value:unknown):Promise<unknown> {
  if(this.failure)throw this.failure;if(this.waiter)throw Error('R8_SERIAL_TRANSPORT_REQUIRED');
  if(Date.now()>=this.deadlineAt)throw Error('R8_ORIGINAL_DEADLINE_EXHAUSTED');
  const bytes=JSON.stringify(value)+'\n';if(Buffer.byteLength(bytes)>262144)throw Error('R8_REQUEST_FRAME_BOUND');
  const response=new Promise<unknown>((resolve,reject)=>{this.waiter={resolve,reject};});
  // Exactly one bounded frame can be queued. Waiting for drain before exposing
  // the response promise stranded deadline rejections (and made them unhandled)
  // when a scientific child stopped reading. The same failure fence owns write.
  this.child.stdin.write(bytes,error=>{if(error)this.fail(error);});
  return response;
 }
 private closing:Promise<ProcessClose>|null=null;
 close():Promise<ProcessClose> {
  if(!this.closing)this.closing=this.physicalClose();return this.closing;
 }
 private async physicalClose() {
  clearTimeout(this.timer);this.signal?.removeEventListener('abort',this.abort);this.child.stdin.end();
  // Let a normal supervisor reap its child, including Rosette's solver shutdown.
  // The old one-second kill could interrupt that cleanup during real contention.
  // Observation may continue for the registered grace, but child work still
  // receives its signal at the unchanged original deadline (or earlier).
  const closeDeadline=Date.now()+5000,killDeadline=Math.min(this.deadlineAt,closeDeadline);
  const unobserved=(cause:unknown)=>new Error('R8_PHYSICAL_GROUP_CLOSE_UNOBSERVED:'+
   (this.signalFailure?.message??this.failure?.message??'NORMAL_CHILD_SHUTDOWN')+':'+this.stderr.slice(-4096),{cause});
  const killer=setTimeout(()=>this.kill(),Math.max(1,killDeadline-Date.now()));
  let timeout:NodeJS.Timeout|undefined;
  const limit=new Promise<never>((_resolve,reject)=>{
   timeout=setTimeout(()=>reject(unobserved(Error('R8_CHILD_EXIT_NOT_OBSERVED'))),Math.max(1,closeDeadline-Date.now()));
  });
  let result:{code:number|null;signal:string|null};
  try{result=await Promise.race([this.finished,limit]);}
  finally{clearTimeout(killer);clearTimeout(timeout);}
  this.kill();
  if(this.child.pid)try{await observeProcessGroupClosed(this.child.pid,closeDeadline);}
  catch(error){throw unobserved(error);}
  const observed:ProcessClose={...result,identity:this.identity,stderr:this.stderr,signalRefusal:this.signalFailure?.message??null,physicalGroupClosed:true};
  if(this.child.pid)await this.observer?.closed(this.child.pid,{...observed});
  await rm(this.scratch,{recursive:true,force:true});
  return observed;
 }
}
/** No unknown/recycled group is killed by recovery. A live group is a retained
 * physical liability until its owner supervisor closes or the deadline expires. */
export async function observeProcessGroupClosed(group:number,deadlineAt:number){
 if(!Number.isSafeInteger(group)||group<1)throw Error('R8_PROCESS_GROUP_IDENTITY');
 for(;;){
  try{process.kill(-group,0);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}
  if(Date.now()>=deadlineAt)throw Error('R8_PHYSICAL_GROUP_CLOSE_UNOBSERVED');
  await new Promise(resolve=>setTimeout(resolve,20));
 }
}

/** Fixed one-shot scientific supervisor also emits measured actual child usage. */
export async function runScientific(input:{python:string;supervisor:string;executable:string;args:string[];environment:Record<string,string>;readPaths:string[];request:unknown;deadlineAt:number;signal?:AbortSignal}) {
 const session=await JsonProcess.open({executable:input.python,args:[input.supervisor,String(input.deadlineAt),input.executable,...input.args],environment:input.environment,readPaths:[...input.readPaths,input.supervisor,input.executable],deadlineAt:input.deadlineAt,signal:input.signal});
 try{
  // One-shot engines emit one JSON document. Normalize its framing in trusted
  // engines themselves; no caller executable string is evaluated.
  const response=await session.request(input.request);
  const resource=await session.close();if(resource.code!==0)throw Error('R8_SCIENTIFIC_EXIT:'+resource.stderr.slice(-4096));
  return {response,resource};
 }catch(error){await session.close();throw error;}
}
