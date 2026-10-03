/** Commodity local isolation adapter. Output is untrusted; this cannot admit an effect. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,writeFile,readFile,rm,readdir,lstat} from 'node:fs/promises';
import {tmpdir,release} from 'node:os';
import {join,dirname} from 'node:path';
import {s6AdapterContract} from './adapter-contract.js';
export interface IsolatedNodeRequest {script:string;input:unknown;wallTimeMs:number;protectedExecution?:boolean;requiredLimits?:{cpuTimeMs?:number;totalMemoryBytes?:number;threads?:number;diskBytes?:number}}
export interface IsolatedNodeResult {stdout:string;stderr:string;exitCode:number|null;signal:string|null;termination:'EXITED'|'WALL_TIME_LIMIT'|'OUTPUT_LIMIT';provenance:Record<string,unknown>}
let active=0;
const digest=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const quote=(v:string)=>JSON.stringify(v);
async function scratchUsage(path:string):Promise<{bytes:number;files:number;complete:boolean}>{let bytes=0,files=0,complete=true;async function visit(path:string){for(const name of await readdir(path)){if(files>=10000){complete=false;return;}const child=join(path,name),st=await lstat(child);files++;if(st.isDirectory())await visit(child);else bytes+=st.size;}}await visit(path);return {bytes,files,complete};}
/** A trusted supervisor chooses this profile; workers cannot supply a profile or inherited env/FDs.
 * Seatbelt qualification is empirical and local. Hard total memory/CPU/pid/disk quotas are absent.
 * There is no consequential broker callback, database/client credential or receipt signing interface. */
export async function launchIsolatedNodeExecutor(request:IsolatedNodeRequest):Promise<IsolatedNodeResult>{
 if(request.protectedExecution===true)throw new Error('EXECUTOR_PROTECTED_CLASS_UNADMITTED');
 if(request.requiredLimits&&Object.keys(request.requiredLimits).length)throw new Error('EXECUTOR_RESOURCE_BOUND_UNAVAILABLE');
 if(process.platform!=='darwin')throw new Error('ISOLATION_SUBSTRATE_UNAVAILABLE');
 const input=JSON.stringify(request.input);if(typeof request.script!=='string'||Buffer.byteLength(request.script)>1024*1024||input===undefined||Buffer.byteLength(input)>1024*1024||!Number.isInteger(request.wallTimeMs)||request.wallTimeMs<1||request.wallTimeMs>10000)throw new Error('EXECUTOR_ENVELOPE_INVALID');
 if(active>=4)throw new Error('EXECUTOR_CONCURRENCY_LIMIT');active++;
 let scratch:string|undefined;
 try{
  scratch=await realpath(await mkdtemp(join(tmpdir(),'finnor-isolated-node-')));const node=await realpath(process.execPath),scriptPath=join(scratch,'worker.mjs');
  const profile=['(version 1)','(deny default)','(import "dyld-support.sb")','(allow syscall*)',`(allow process-exec (literal ${quote(node)}))`,'(deny process-fork)','(allow sysctl-read)',
   `(allow file-read* (literal ${quote(node)}) (subpath "/System/Library") (subpath "/usr/lib") (subpath ${quote(scratch)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
   `(allow file-write* (subpath ${quote(scratch)}) (literal "/dev/null"))`,
   // Read only directory metadata needed to resolve the exact runtime/scratch paths.
   `(allow file-read-metadata ${[...new Set([node,scratch].flatMap(path=>{const result:string[]=[];for(let parent=dirname(path);;parent=dirname(parent)){result.push(parent);if(parent==='/')break;}return result;}))].map(path=>`(literal ${quote(path)})`).join(' ')})`
  ].join('\n');
  const profilePath=join(scratch,'enforced.sb');await writeFile(scriptPath,request.script,{mode:0o400});await writeFile(profilePath,profile,{mode:0o400});
  const begun=performance.now(),startedAt=new Date().toISOString(),cpu=process.cpuUsage();const chunks:{stdout:Buffer[];stderr:Buffer[]}={stdout:[],stderr:[]};let total=0,termination:IsolatedNodeResult['termination']='EXITED';
  const child=spawn('/usr/bin/sandbox-exec',['-f',profilePath,node,'--max-old-space-size=128',scriptPath],{cwd:scratch,env:{HOME:scratch,TMPDIR:scratch,LANG:'C',TZ:'UTC',NODE_ENV:'production'},stdio:['pipe','pipe','pipe'],detached:true});
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}};
  const timer=setTimeout(()=>{termination='WALL_TIME_LIMIT';kill();},request.wallTimeMs);
  function consume(stream:'stdout'|'stderr',chunk:Buffer){const take=Math.min(chunk.length,131072-total);if(take>0){chunks[stream].push(chunk.subarray(0,take));total+=take;}if(take<chunk.length&&termination==='EXITED'){termination='OUTPUT_LIMIT';kill();}}
  child.stdout!.on('data',b=>consume('stdout',Buffer.from(b)));child.stderr!.on('data',b=>consume('stderr',Buffer.from(b)));child.stdin!.on('error',()=>undefined);child.stdin!.end(input);
  const finished=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));}).finally(()=>{clearTimeout(timer);kill();});
  const elapsedMs=performance.now()-begun,usage=process.cpuUsage(cpu),disk=await scratchUsage(scratch);
  const compute={schema:'finnor.model-compute-invocation.v1',semanticOwner:'S6',id:'model-compute:'+digest(JSON.stringify({startedAt,input:digest(input),script:digest(request.script),output:digest(Buffer.concat(chunks.stdout)),exitCode:finished.code})),tenantId:null,principalId:null,rightsRef:null,identityQualification:'CALLER_IDENTITY_UNATTESTED_NO_CONSEQUENTIAL_AUTHORITY',inputRef:digest(input),outputRefs:[digest(Buffer.concat(chunks.stdout)),digest(Buffer.concat(chunks.stderr))],requestedRoute:'LOCAL_MACOS_SEATBELT',actualRoute:'LOCAL_MACOS_SEATBELT',fallbacks:[],model:null,backend:{name:'node',version:process.version,runtimeDigest:digest(await readFile(node))},harness:{platform:process.platform,architecture:process.arch,scriptDigest:digest(request.script),profileDigest:digest(profile),deterministicReplayClaimed:false},attempts:[{startedAt,finishedAt:new Date().toISOString(),status:termination,exitCode:finished.code,signal:finished.signal}],usage:{elapsedMs,supervisorCpuUserMicros:usage.user,supervisorCpuSystemMicros:usage.system,scratch:disk,outputBytes:total,accountingScope:'SUPERVISOR_INTERVAL_NOT_CHILD_OR_CONTAINER_PEAK'},cost:{money:null,pricebookRef:null,status:'UNMETERED',externalCalls:0},admission:{status:'UNADMITTED_PROTECTED_EXECUTION',receipt:null}};
  return {stdout:Buffer.concat(chunks.stdout).toString(),stderr:Buffer.concat(chunks.stderr).toString(),exitCode:finished.code,signal:finished.signal,termination,provenance:{schema:'finnor.s6.executor-provenance.v1',compute,contract:s6AdapterContract('LOCAL_MACOS_SEATBELT'),substrate:'LOCAL_MACOS_SEATBELT',platform:process.platform,osRelease:release(),node:process.version,nodeDigest:digest(await readFile(node)),scriptDigest:digest(request.script),inputDigest:digest(input),profile,profileDigest:digest(profile),inheritedDyldProfileDigest:digest(await readFile('/System/Library/Sandbox/Profiles/dyld-support.sb')),elapsedMs,supervisorCpuMicros:usage.user+usage.system,accountingScope:'SUPERVISOR_INTERVAL_NOT_CHILD_OR_CONTAINER_USAGE',scratch:disk,cost:{money:null,status:'UNMETERED'},limits:{wallTimeMs:request.wallTimeMs,outputBytes:131072,nodeOldSpaceMiB:128,totalMemory:'UNENFORCED',cpu:'UNENFORCED',pids:'PROCESS_CREATION_DENIED_THREADS_AND_GLOBAL_PIDS_UNENFORCED',diskBytes:'UNENFORCED'},authority:'NONE_OUTPUT_UNTRUSTED',productionAdmission:'UNSUPPORTED_PENDING_RESOURCE_AND_RELEASE_QUALIFICATION'}};
 }finally{active--;if(scratch)await rm(scratch,{recursive:true,force:true});}
}
