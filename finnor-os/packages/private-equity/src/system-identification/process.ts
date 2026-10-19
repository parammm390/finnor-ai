import {fork} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {identificationSourceRoot} from './source-cut';
import {LIMITS,fail} from './contracts';
export interface IdentificationChildResources{pid:number;wallMs:number;cpuMicros:number;peakProcessRSSBytes:number;supervisorWallMs:number;sampledPeakRSSBytes:number;outputBytes:number;exitCode:number;node:string;platform:string;architecture:string;heapLimitMiB:256;aggregatePeakMemory:null}
/** Trusted fixed interpreter only. The interpreter has no guest IO opcode.
 * OS-administrator protection is explicitly NOT established by a child process. */
export async function runIdentificationChild<T>(input:Record<string,unknown>,deadline:number,current:()=>Promise<boolean>):Promise<{result:T;resources:IdentificationChildResources}>{
 if(Buffer.byteLength(JSON.stringify(input))>LIMITS.ipcBytes)fail('X4_CHILD_INPUT_BOUND');
 const root=await identificationSourceRoot();
 return new Promise((yes,no)=>{
  const started=performance.now(),child=fork(resolve(root,'finnor-os/packages/private-equity/src/system-identification/core-child.generated.mjs'),[],{
   cwd:resolve(root,'finnor-os'),execPath:process.execPath,execArgv:['--max-old-space-size=256'],
   env:{PATH:process.env.PATH,TZ:'UTC',NODE_ENV:'production'},serialization:'json',stdio:['ignore','pipe','pipe','ipc'],
  });
  let result:any,reason:string|undefined,output=0,peak=0,checking=false,done=false;
  const kill=(code:string)=>{reason??=code;child.kill('SIGKILL');};
  const timer=setTimeout(()=>kill('X4_PHYSICAL_CHILD_DEADLINE'),Math.max(1,Math.min(30000,deadline-Date.now())));
  const monitor=setInterval(()=>{
   if(checking||done)return;checking=true;
   void Promise.all([current(),child.pid?readFile('/proc/'+child.pid+'/status','utf8').catch(()=>null):Promise.resolve(null)])
    .then(([valid,status])=>{if(done)return;if(!valid)kill('X4_CHILD_CANCELLED_OR_FENCED');const rss=status?.match(/^VmRSS:\s+(\d+)\s+kB/m);if(rss)peak=Math.max(peak,Number(rss[1])*1024);if(peak>384*1024*1024)kill('X4_CHILD_OBSERVED_RSS_BOUND');})
    .catch(()=>kill('X4_CHILD_CURRENTNESS_UNAVAILABLE')).finally(()=>checking=false);
  },250);
  const capture=(b:Buffer)=>{output+=b.length;if(output>LIMITS.childOutput)kill('X4_CHILD_LOG_BOUND');};
  child.stdout!.on('data',capture);child.stderr!.on('data',capture);
  child.once('message',(value:unknown)=>{if(Buffer.byteLength(JSON.stringify(value))>LIMITS.ipcBytes)kill('X4_CHILD_RESULT_BOUND');else result=value;});
  const finish=()=>{done=true;clearTimeout(timer);clearInterval(monitor);};
  child.once('error',()=>{finish();no(Error('X4_CHILD_START_FAILED'));});
  child.once('exit',(code,signal)=>{
   if(done)return;finish();
   if(reason||code!==0||signal||!result?.ok||result.resources?.pid!==child.pid){
    no(Object.assign(Error(reason??result?.error??'X4_CHILD_INTERRUPTED'),{physicalPid:child.pid,exitCode:code,signal,supervisorWallMs:performance.now()-started,sampledPeakRSSBytes:peak,outputBytes:output,unknownCostPossible:true}));return;
   }
   yes({result:result.result,resources:{...result.resources,supervisorWallMs:performance.now()-started,sampledPeakRSSBytes:peak,outputBytes:output,exitCode:code}});
  });
  child.send({...input,deadline});
 });
}
