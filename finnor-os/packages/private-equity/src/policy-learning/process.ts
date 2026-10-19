import {fork} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {learningSourceRoot} from './source-cut';
import {X5_LIMITS,fail} from './contracts';
import type {ChildResources} from './types';
export interface PhysicalChildResult{ok:boolean;result?:unknown;error?:string;resources:ChildResources}
/** Fixed trusted process only. Candidate data has no code/path/network surface.
 * RSS is sampled, not a claim of cgroup-level aggregate memory containment. */
export async function runLearningChild(input:unknown,deadline:number,current:()=>Promise<boolean>):Promise<PhysicalChildResult>{
 if(Buffer.byteLength(JSON.stringify(input))>X5_LIMITS.ipcBytes)fail('X5_CHILD_INPUT_BOUND');
 const root=await learningSourceRoot();
 return new Promise((yes,no)=>{
  const started=performance.now();
  const child=fork(resolve(root,'finnor-os/packages/private-equity/src/policy-learning/core-child.mts'),[],{
   cwd:resolve(root,'finnor-os'),execPath:process.execPath,execArgv:['--import=tsx','--max-old-space-size=256'],
   env:{PATH:process.env.PATH,TZ:'UTC',NODE_ENV:'production'},serialization:'json',stdio:['ignore','pipe','pipe','ipc'],
  });
  let result:PhysicalChildResult|undefined,reason:string|undefined,output=0,peak=0,checking=false,done=false;
  const kill=(code:string)=>{reason??=code;child.kill('SIGKILL');};
  const timer=setTimeout(()=>kill('X5_PHYSICAL_CHILD_DEADLINE'),Math.max(1,Math.min(X5_LIMITS.childWallMs,deadline-Date.now())));
  const monitor=setInterval(()=>{
   if(checking||done)return;checking=true;
   void Promise.all([current(),child.pid?readFile('/proc/'+child.pid+'/status','utf8').catch(()=>null):Promise.resolve(null)])
    .then(([valid,status])=>{if(done)return;if(!valid)kill('X5_CHILD_CANCELLED_OR_FENCED');const rss=status?.match(/^VmRSS:\s+(\d+)\s+kB/m);if(rss)peak=Math.max(peak,Number(rss[1])*1024);if(peak>384*1024*1024)kill('X5_CHILD_OBSERVED_RSS_BOUND');})
    .catch((error:unknown)=>{
     const code=error&&typeof error==='object'&&'code'in error?error.code:null;
     kill(typeof code==='string'&&/^[A-Z0-9_]{1,100}$/.test(code)?'X5_CHILD_CURRENTNESS_'+code:'X5_CHILD_CURRENTNESS_UNAVAILABLE');
    }).finally(()=>checking=false);
  },100);
  const capture=(b:Buffer)=>{output+=b.length;if(output>X5_LIMITS.childOutput)kill('X5_CHILD_LOG_BOUND');};
  child.stdout!.on('data',capture);child.stderr!.on('data',capture);
  child.once('message',(message:unknown)=>{
   if(Buffer.byteLength(JSON.stringify(message))>X5_LIMITS.ipcBytes){kill('X5_CHILD_RESULT_BOUND');return;}
   result=message as PhysicalChildResult;
  });
  const finish=()=>{done=true;clearTimeout(timer);clearInterval(monitor);};
  child.once('error',e=>{finish();no(e);});
  child.once('exit',(code,signal)=>{
   if(done)return;finish();
   if(reason||!result||code!==0||signal||!result.ok||result.resources?.pid!==child.pid){
    no(Object.assign(new Error(reason??result?.error??'X5_PHYSICAL_CHILD_INTERRUPTED'),{
     physicalPid:child.pid,exitCode:code,signal,supervisorWallMs:performance.now()-started,sampledPeakRSSBytes:peak,outputBytes:output,unknownCostPossible:true,
    }));return;
   }
   yes({...result,resources:{...result.resources,supervisorWallMs:performance.now()-started,sampledPeakRSSBytes:peak,outputBytes:output,exitCode:code}});
  });
  child.send(JSON.parse(JSON.stringify(input)));
 });
}
