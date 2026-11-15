/** Owns a real, unchanged physical-worker.mts child, including its OS exit. */
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appendFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';

const handlerNames:Record<string,string>={
 run_harness_program_v1:'runHarnessProgramJob',run_evidence_derivation_v1:'runEvidenceDerivationJob',
 run_compute_search_unit_v1:'runComputeSearchUnitJob',run_objective_iteration:'runObjectiveIteration',
 run_workforce_assignment:'runWorkforceAssignment',process_work_event_wait_deadline:'processWorkEventWaitDeadlineHandler',
};
export async function recoveryWorker(databaseUrl:string,directory:string,label:string,deadline:number){
 const url=new URL(databaseUrl),tsx=process.env.FINNOR_W1_RECOVERY_TSX;
 if(url.username!=='finnor_worker'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))
  throw Error('EXISTING_LOOPBACK_RESTRICTED_WORKER_REQUIRED');
 if(!tsx||!isAbsolute(tsx))throw Error('ABSOLUTE_RUNNER_TSX_REQUIRED');
 const applicationName='w1-recovery-'+randomUUID();url.searchParams.set('application_name',applicationName);
 const pass=Object.fromEntries(['FINNOR_M1_PROFILE','FINNOR_M1_STORE','FINNOR_S3_MODEL_STORE','FINNOR_S4_POLICY_STORE',
  'FINNOR_S3_PYTHON','FINNOR_S5_PYTHON','FINNOR_TEST_PYTHON','FINNOR_TEST_MANAGED_EXTENSIONS','P3_GOVERNORS']
  .flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
 const launchedAt=new Date().toISOString(),launchStart=performance.now();
 const child=spawn(process.execPath,['--max-old-space-size=768',
  '--import='+fileURLToPath(new URL('./read-network-guard.mjs',import.meta.url)),
  '--import='+tsx,fileURLToPath(new URL('../p5/physical-worker.mts',import.meta.url))],{
  cwd:fileURLToPath(new URL('../../',import.meta.url)),
  env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',
   DATABASE_URL:url.toString(),AUTH_DEV_BYPASS:'0',FINNOR_P4_PROFILE:'ordinary_disposable',
   FINNOR_NATIVE_QUEUE_PROFILE:'P2',...pass},stdio:['ignore','pipe','pipe','ipc'],
 });
 if(!child.pid)throw Error('PHYSICAL_CHILD_PID_REQUIRED');
 const pid=child.pid,registered=new Set<string>(),events:any[]=[];
 const path=join(directory,'worker-'+pid+'.jsonl');
 const secrets=[databaseUrl,url.toString(),decodeURIComponent(url.password)].filter(Boolean);
 const safe=(value:string)=>secrets.reduce((text,secret)=>text.split(secret).join('[REDACTED]'),value);
 const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 let trace=Promise.resolve(),output='',outputBytes=0,exited:any=null;
 const record=(event:any)=>{events.push(event);trace=trace.then(()=>appendFile(path,JSON.stringify(event)+'\n',{mode:0o600}));};
 const fail=(error:Error)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 record({type:'launch',pid,parentPid:process.pid,label,applicationName,launchedAt,executable:process.execPath,
  loader:tsx,worker:'finnor-os/scripts/p5/physical-worker.mts',profile:'P2',costUSD:null,completeChildUsage:null});
 const closed=new Promise<any>((resolve,reject)=>{
  child.once('error',error=>{fail(error);reject(error);});
  child.once('close',(code,signal)=>{
   exited={type:'worker-exit',pid,parentPid:process.pid,code,signal,at:new Date().toISOString()};
   record(exited);fail(Error('OWNED_PHYSICAL_WORKER_EXIT:'+code+':'+signal));resolve(exited);
  });
 });
 // Observe a spawn failure immediately even when a caller is awaiting an RPC.
 void closed.catch(()=>undefined);
 child.on('message',(message:any)=>{
  if(message.type==='observation'){record(message);return;}
  const p=pending.get(message.id);if(!p)return;
  pending.delete(message.id);clearTimeout(p.timer);
  if(message.error)p.reject(Error(safe(message.error.message)));else p.resolve(message.value);
 });
 for(const stream of [child.stdout,child.stderr])stream?.on('data',(chunk:Buffer)=>{
  outputBytes+=chunk.length;
  if(outputBytes>2*1024*1024){record({type:'output-bound-exceeded',pid,at:new Date().toISOString()});child.kill('SIGKILL');return;}
  output+=chunk.toString();
 });
 const rpc=(operation:string,extra:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{
  if(!child.connected||exited)return reject(Error('OWNED_WORKER_NOT_CONNECTED'));
  const id=randomUUID();
  const remaining=Math.max(1,Math.min(40000,deadline-performance.now()));
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('PHYSICAL_RPC_OR_OBSERVER_BOUND:'+operation));child.kill('SIGKILL');},remaining);
  pending.set(id,{resolve,reject,timer});
  record({type:'rpc-request',pid,id,operation,registered:[...registered].sort(),at:new Date().toISOString()});
  child.send({id,operation,registered:[...registered],endpointConfig:null,...extra},error=>{
   if(error){const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);p.reject(error);}}
  });
 });
 const flush=async()=>{await trace;await writeFile(join(directory,'worker-'+pid+'.log'),safe(output),{mode:0o600});};
 const identity=await rpc('identity').catch(async error=>{
  if(!exited)child.kill('SIGKILL');await closed.catch(()=>undefined);await flush();throw error;
 });
 record({type:'cold-start',pid,identity,launchWallMs:performance.now()-launchStart,costUSD:null,completeChildUsage:null});
 const finish=async()=>{
  if(!exited){
   const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
   try{if(child.connected)await rpc('close');else child.kill('SIGTERM');await closed;}
   finally{clearTimeout(timer);}
  }
  await flush();
 };
 return {
  pid,identity,applicationName,events,
  register(type:string,handler:Function,contract:unknown){
   if(handlerNames[type]!==handler.name||
    JSON.stringify(contract)!==JSON.stringify(PRODUCTION_JOB_CONTRACTS[type as keyof typeof PRODUCTION_JOB_CONTRACTS]))
    throw Error('EXACT_PRODUCTION_HANDLER_AND_CONTRACT_REQUIRED');
   registered.add(type);
  },
  registeredTypes:()=>[...registered].sort(),tick:()=>rpc('tick'),
  recoverExpiredRunningJobs:()=>rpc('recover',{leaseSeconds:3}),
  async killExact(){
   if(exited)throw Error('VICTIM_ALREADY_EXITED');
   const request={type:'kill-request',pid,parentPid:process.pid,signal:'SIGKILL',at:new Date().toISOString()};
   record(request);const accepted=child.kill('SIGKILL');
   if(!accepted)throw Error('SIGKILL_NOT_ACCEPTED');
   const exit=await Promise.race([closed,new Promise<never>((_,reject)=>{
     const t=setTimeout(()=>reject(Error('SIGKILL_EXIT_5S_BOUND')),5000);
     closed.finally(()=>clearTimeout(t)).catch(()=>undefined);
    })]);
   if(exit.pid!==pid||exit.signal!=='SIGKILL'||exit.code!==null)throw Error('EXACT_SIGKILL_EXIT_REQUIRED');
   await flush();return {request,accepted,exit};
  },
  close:finish,flush,
 };
}
