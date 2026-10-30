/** Failure-first executable process E2E, never an authenticated owner replay. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {OwnedNativeGroups,observeProcessGroup,stopProcessGroup} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/process-groups.ts';
import {nativeIdentity} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native.ts';
import {sha} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts.ts';
const args=process.argv.slice(2),arg=(name:string)=>args[args.indexOf(name)+1]!;
const repository=arg('--repository'),evidence=arg('--evidence');
await mkdir(evidence,{recursive:false,mode:0o700});
const nonce=randomBytes(16).toString('hex'),channelId='offline-process-only-'+nonce;
const child=spawn(process.execPath,['--import','tsx',join(repository,'finnor-os/scripts/project-z/z4/process-control-child.mts'),channelId,nonce],
 {cwd:join(repository,'finnor-os'),env:{PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,
 RAYON_NUM_THREADS:'2'},detached:true,stdio:['ignore','pipe','pipe','ipc']});
const groups=new OwnedNativeGroups(child,channelId,nonce),stdout:Buffer[]=[],stderr:Buffer[]=[];
child.stdout!.on('data',(x:Buffer)=>stdout.push(x));child.stderr!.on('data',(x:Buffer)=>stderr.push(x));
const terminal=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
 child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
});
let failure:string|undefined,alteredIdentityRefused=false,rustPid:number|undefined,physical:Awaited<typeof terminal>|undefined;
try{
 child.on('message',message=>{try{groups.accept(message);}catch{failure='Z4_OFFLINE_PROCESS_MESSAGE_FAILED';groups.stop();}});
 const end=Date.now()+15000;
 while(Date.now()<end&&!failure){
  const group=[...groups.active.values()][0];
  if(group){
   const altered={...group,startTicks:String(BigInt(group.startTicks)+1n)};
   try{stopProcessGroup(altered);}catch(error){alteredIdentityRefused=(error as Error).message==='Z4_OWNED_PROCESS_IDENTITY_CHANGED';}
   const ids=(await readFile('/proc/'+group.pid+'/task/'+group.pid+'/children','utf8')).trim().split(/\s+/).filter(Boolean);
   if(ids.length){rustPid=Number(ids[0]);break;}
  }
  await delay(10);
 }
 if(!rustPid||!alteredIdentityRefused)throw Error('Z4_REAL_NATIVE_DESCENDANT_OR_PID_FALSIFIER_MISSING');
 const group=[...groups.active.values()][0]!,rust=observeProcessGroup(rustPid,group.pid,false);
 groups.stop();
 process.kill(-child.pid!,'SIGKILL');
 physical=await terminal;
 if(physical.signal!=='SIGKILL')throw Error('Z4_REAL_NODE_SIGKILL_REQUIRED');
 let live=true;
 for(let i=0;i<100;i++){
  try{const value=await readFile('/proc/'+rust.pid+'/stat','utf8');const fields=value.slice(value.lastIndexOf(')')+2).split(/\s+/);
   live=fields[0]!=='Z'&&fields[19]===rust.startTicks;}catch{live=false;}
  if(!live)break;await delay(10);
 }
 if(live)throw Error('Z4_NATIVE_DESCENDANT_STILL_LIVE');
}catch(error){failure=(error as Error).message;}
finally{
 groups.stop();try{process.kill(-child.pid!,'SIGKILL');}catch{}
 physical??=await terminal;
 await writeFile(join(evidence,'stdout.log'),Buffer.concat(stdout),{flag:'wx',mode:0o600});
 await writeFile(join(evidence,'stderr.log'),Buffer.concat(stderr),{flag:'wx',mode:0o600});
}
const report={schema:'finnor.z4.offline-process-control.v1',status:failure?'FAILED':'PASSED_OFFLINE_PROCESS_CONTROL_ONLY',
 fixture:true,nativeOwner:'NOT_RUN',databaseCallsAttempted:0,authCallsAttempted:0,grantReceiptsAuthored:0,
 identity:await nativeIdentity(),node:process.version,nodePid:child.pid,rustPid,physical,alteredIdentityRefused,
 groups:groups.receipts,stdoutSha256:sha(Buffer.concat(stdout)),stderrSha256:sha(Buffer.concat(stderr)),failure};
if(!failure){
 const ordinary=spawn(process.execPath,['--import','tsx',join(repository,'finnor-os/scripts/project-z/z4/process-control-child.mts'),
  channelId,nonce,'--ordinary-parent-death'],{cwd:join(repository,'finnor-os'),
  env:{PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,RAYON_NUM_THREADS:'2'},
  detached:true,stdio:['ignore','pipe','pipe','ipc']});
 const out:Buffer[]=[],err:Buffer[]=[];
 ordinary.stdout!.on('data',(x:Buffer)=>out.push(x));ordinary.stderr!.on('data',(x:Buffer)=>err.push(x));
 const terminal=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
  ordinary.once('error',reject);ordinary.once('close',(code,signal)=>resolve({code,signal}));
 });
 let supervisor:ReturnType<typeof observeProcessGroup>|undefined,rust:ReturnType<typeof observeProcessGroup>|undefined;
 const live=async(group:ReturnType<typeof observeProcessGroup>)=>{
  try{const s=await readFile('/proc/'+group.pid+'/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).split(/\s+/);
   return f[0]!=='Z'&&f[19]===group.startTicks;}catch{return false;}
 };
 const observation:{nodePid?:number;supervisor?:typeof supervisor;rust?:typeof rust;
  physical?:Awaited<typeof terminal>;controllerNativeSignalsBeforeObservation:number;
  supervisorStopped?:boolean;rustStopped?:boolean;failure?:string}={
   nodePid:ordinary.pid,controllerNativeSignalsBeforeObservation:0};
 try{
  const end=Date.now()+15000;
  while(Date.now()<end&&!rust){
   const ids=(await readFile('/proc/'+ordinary.pid+'/task/'+ordinary.pid+'/children','utf8')).trim().split(/\s+/).filter(Boolean);
   if(ids.length){
    supervisor=observeProcessGroup(Number(ids[0]),ordinary.pid);
    const nested=(await readFile('/proc/'+supervisor.pid+'/task/'+supervisor.pid+'/children','utf8')).trim().split(/\s+/).filter(Boolean);
    if(nested.length)rust=observeProcessGroup(Number(nested[0]),supervisor.pid,false);
   }
   if(!rust)await delay(10);
  }
  if(!supervisor||!rust)throw Error('Z4_ORDINARY_REAL_NATIVE_DESCENDANT_REQUIRED');
  observation.supervisor=supervisor;observation.rust=rust;
  process.kill(-ordinary.pid!,'SIGKILL');
  observation.physical=await terminal;
  if(observation.physical.signal!=='SIGKILL')throw Error('Z4_ORDINARY_NODE_SIGKILL_REQUIRED');
  for(let i=0;i<100&&(await live(supervisor)||await live(rust));i++)await delay(10);
  observation.supervisorStopped=!await live(supervisor);observation.rustStopped=!await live(rust);
  if(!observation.supervisorStopped||!observation.rustStopped)throw Error('Z4_ORDINARY_PARENT_LEFT_NATIVE_LIVE');
 }catch(error){
  observation.failure=(error as Error).message;report.failure=observation.failure;report.status='FAILED';
 }finally{
  if(supervisor)stopProcessGroup(supervisor);
  try{process.kill(-ordinary.pid!,'SIGKILL');}catch{}
  observation.physical??=await terminal;
  await writeFile(join(evidence,'ordinary-stdout.log'),Buffer.concat(out),{flag:'wx',mode:0o600});
  await writeFile(join(evidence,'ordinary-stderr.log'),Buffer.concat(err),{flag:'wx',mode:0o600});
  await writeFile(join(evidence,'ordinary-parent-death.json'),JSON.stringify(observation,null,2)+'\n',{flag:'wx',mode:0o600});
 }
}
await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:report.status,physical,alteredIdentityRefused}));
if(report.status==='FAILED')process.exitCode=1;
