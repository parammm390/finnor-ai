import {spawn,execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {writeFile,readFile,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
let config,child,started=performance.now(),timer,memoryTimer,stopping=null,closed=false,finishing=false,bytes=0,code=null,signal=null,sampling=false;
const memory={scope:'CALLER_PROCESS_AND_DESCENDANTS_NOT_FULL_EPISODE',intervalMs:250,samples:0,failures:0,
 peakResidentSumBytes:null,observedLimitBytes:17179869184,hardEnforcement:false};
const ownDirectory=dirname(fileURLToPath(import.meta.url));
const safeWrite=(path,body)=>writeFile(path,body,{mode:0o600,flag:constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW});
const stdout=[],stderr=[];
const send=message=>new Promise(yes=>{if(!process.connected)return yes(false);process.send(message,error=>yes(!error));});
function stop(reason){
 if(stopping)return;stopping=reason;
 if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
 else if(config)void finish();
}
async function finish(){
 if(finishing||!config)return;finishing=true;clearTimeout(timer);clearInterval(memoryTimer);
 const receipt={command:[config.binary,...config.args],pid:child?.pid??0,exitCode:code,signal,
  wallMs:performance.now()-started,outputBytes:bytes,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString(),
  memoryLimitMiB:config.binary==='lean'?2048:null,
  memoryEnforcement:config.binary==='lean'?'LEAN_OPTION':'DEADLINE_ONLY_REPLAY_MEMORY_UNQUALIFIED',
  aggregatePeakBytes:null,isolation:'DARWIN_SEATBELT_DENY_NETWORK_SCOPED_FILESYSTEM',sandboxPolicyDigest:config.sandboxPolicyDigest,
  memorySample:{...memory},
  supervision:'INDEPENDENT_IPC_DEADLINE_GUARDIAN',guardianPid:process.pid,childCloseObserved:closed};
 try{await safeWrite(join(config.directory,config.logName+'.json'),JSON.stringify({...receipt,stopReason:stopping},null,2)+'\n');}
 catch{stopping??='Y5_NATIVE_RECEIPT_PERSISTENCE_FAILED';}
 await send({kind:'Y5_CLOSED',receipt,stopReason:stopping});
 if(process.connected)process.disconnect();
}
function sampleMemory(){
 if(sampling||finishing||!config)return;sampling=true;
 execFile('/bin/ps',['-A','-o','pid=,ppid=,rss='],{timeout:2000,maxBuffer:1048576,encoding:'utf8'},(error,output)=>{
  try{
   if(error)throw error;
   const rows=output.trim().split('\n').map(line=>{
    const parts=line.trim().split(/\s+/);if(parts.length!==3||parts.some(p=>!/^\d+$/.test(p)))throw Error('memory snapshot');
    return parts.map(Number);
   });
   if(!rows.some(r=>r[0]===config.callerPid))throw Error('caller no longer observable');
   const pids=new Set([config.callerPid]);let changed=true;
   while(changed){changed=false;for(const [pid,ppid] of rows)if(pids.has(ppid)&&!pids.has(pid)){pids.add(pid);changed=true;}}
   const bytes=rows.reduce((sum,[pid,,rss])=>sum+(pids.has(pid)?rss*1024:0),0);
   memory.samples++;memory.peakResidentSumBytes=Math.max(memory.peakResidentSumBytes??0,bytes);
   if(bytes>memory.observedLimitBytes)stop('Y5_NATIVE_OBSERVED_MEMORY_BUDGET');
  }catch{memory.failures++;}finally{sampling=false;}
 });
}
process.on('disconnect',()=>{
 if(!config){process.exitCode=1;return;}
 if(!finishing)stop('Y5_PARENT_LOST');
});
for(const event of ['SIGTERM','SIGINT','SIGHUP'])process.on(event,()=>stop('Y5_GUARDIAN_TERMINATED'));
process.on('message',async message=>{
 if(message?.kind==='Y5_STOP'){
  if(['Y5_NATIVE_DEADLINE','Y5_CLAIM_CANCELLED','Y5_CURRENTNESS_UNAVAILABLE','Y5_GUARDIAN_PROTOCOL_OUTPUT'].includes(message.reason))stop(message.reason);
  return;
 }
 if(config||message?.kind!=='Y5_START')return;
 const c=message.config;
 if(!c||typeof c.root!=='string'||typeof c.directory!=='string'||!isAbsolute(c.root)||!isAbsolute(c.directory)||!['lean','leanchecker'].includes(c.binary)||
  !Array.isArray(c.args)||c.args.length>32||c.args.some(a=>typeof a!=='string'||a.length>4096||a.includes('\0'))||
  !/^[a-zA-Z0-9-]+$/.test(c.logName)||!Number.isFinite(c.deadlineAt)||c.deadlineAt>Date.now()+30000||
  c.sandboxPolicyPath!==join(ownDirectory,'native-sandbox.sb')||!/^[a-f0-9]{64}$/.test(c.sandboxPolicyDigest??'')||
  !Number.isSafeInteger(c.callerPid)||c.callerPid!==process.ppid){
  process.exitCode=1;if(process.connected)process.disconnect();return;
 }
 config=c;started=performance.now();
 if(c.deadlineAt<=Date.now()||!process.connected){stop('Y5_NATIVE_DEADLINE');return;}
 try{
  if(process.platform!=='darwin'||await realpath(c.sandboxPolicyPath)!==c.sandboxPolicyPath||
   createHash('sha256').update(await readFile(c.sandboxPolicyPath)).digest('hex')!==c.sandboxPolicyDigest)throw Error('policy changed');
  if(c.binary==='leanchecker'){
   if(c.args.length!==1||!['Candidate','Total'].includes(c.args[0]))throw Error('replay target');
   const object=join(c.directory,c.args[0]+'.olean'),info=await lstat(object);
   const prefix=await lstat(join(c.directory,c.args[0])).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(!info.isFile()||info.isSymbolicLink()||prefix||await realpath(object)!==object)throw Error('replay object');
  }
 }catch{stop('Y5_NATIVE_SANDBOX_UNAVAILABLE_OR_CHANGED');return;}
 if(stopping||finishing)return;
 if(c.deadlineAt<=Date.now()||!process.connected){stop('Y5_NATIVE_DEADLINE');return;}
 const binary=join(c.root,'bin',c.binary);
 child=spawn('/usr/bin/sandbox-exec',['-D','TOOL_ROOT='+c.root,'-D','SCRATCH='+c.directory,'-D','NATIVE_BINARY='+binary,'-f',c.sandboxPolicyPath,binary,...c.args],
  {cwd:c.directory,detached:true,stdio:['ignore','pipe','pipe'],
  env:{NODE_ENV:'development',PATH:join(c.root,'bin')+':/usr/bin:/bin',HOME:c.directory,TMPDIR:c.directory,LANG:'C.UTF-8',
   LEAN_PATH:c.directory,LEAN_SYSROOT:c.root}});
 const capture=(target,chunk)=>{bytes+=chunk.length;if(bytes>1048576){stop('Y5_OUTPUT_BOUND');return;}target.push(chunk);};
 child.stdout.on('data',chunk=>capture(stdout,chunk));child.stderr.on('data',chunk=>capture(stderr,chunk));
 child.once('error',()=>{stopping??='Y5_NATIVE_SPAWN_FAILED';});
 child.once('close',(exitCode,exitSignal)=>{code=exitCode;signal=exitSignal;closed=true;void finish();});
 timer=setTimeout(()=>stop('Y5_NATIVE_DEADLINE'),Math.max(1,c.deadlineAt-Date.now()));
 sampleMemory();memoryTimer=setInterval(sampleMemory,memory.intervalMs);
 const witness={kind:'Y5_STARTED',pid:child.pid??0,guardianPid:process.pid,deadlineAt:c.deadlineAt};
 try{await safeWrite(join(c.directory,c.logName+'.started.json'),JSON.stringify(witness)+'\n');}
 catch{stop('Y5_NATIVE_RECEIPT_PERSISTENCE_FAILED');}
 await send(witness);
});
