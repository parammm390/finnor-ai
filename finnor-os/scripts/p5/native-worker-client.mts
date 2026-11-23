/** Fixture control for a separate restricted production queue consumer. */
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import type {JobQueue} from '../../apps/worker/src/queue';
const handlers:Record<string,string>={run_interface_acquisition_v1:'runInterfaceAcquisitionJob',
 run_evidence_derivation_v1:'runEvidenceDerivationJob',run_harness_program_v1:'runHarnessProgramJob',
 run_compute_search_unit_v1:'runComputeSearchUnitJob',run_objective_iteration:'runObjectiveIteration',
 run_workforce_assignment:'runWorkforceAssignment',process_work_event_wait_deadline:'processWorkEventWaitDeadlineHandler'};
export async function physicalNativeQueue(databaseUrl:string,directory:string,profile:'P5'|'P2'='P5',
 settings?:{priorityAgingSeconds:number;leaseSeconds?:number;workloadClass?:'INTERACTIVE'}){
 if(new URL(databaseUrl).username!=='finnor_worker')throw Error('P5_RESTRICTED_WORKER_CONNECTION_REQUIRED');
 if(settings&&(!Number.isSafeInteger(settings.priorityAgingSeconds)||settings.priorityAgingSeconds<1||settings.priorityAgingSeconds>86400))
  throw Error('EXPLICIT_ORIGINAL_QUEUE_AGING_CONFIGURATION_REQUIRED');
 if(settings?.leaseSeconds!==undefined&&(!Number.isSafeInteger(settings.leaseSeconds)||settings.leaseSeconds<3||settings.leaseSeconds>60))
  throw Error('EXPLICIT_ORIGINAL_QUEUE_LEASE_CONFIGURATION_REQUIRED');
 if(settings?.workloadClass!==undefined&&settings.workloadClass!=='INTERACTIVE')
  throw Error('EXPLICIT_ORIGINAL_INTERACTIVE_QUEUE_CLASS_REQUIRED');
 const nativeEnvironment=Object.fromEntries(['FINNOR_M1_PROFILE','FINNOR_M1_STORE','FINNOR_S3_MODEL_STORE','FINNOR_S4_POLICY_STORE',
  'FINNOR_S3_PYTHON','FINNOR_S5_PYTHON','FINNOR_TEST_PYTHON','FINNOR_TEST_MANAGED_EXTENSIONS','P3_GOVERNORS']
  .flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
 const worker=spawn(process.execPath,['--max-old-space-size=768',
  ...(profile==='P2'?['--import='+fileURLToPath(new URL('../postz-w1/read-network-guard.mjs',import.meta.url))]:[]),
  '--import=tsx',fileURLToPath(new URL('./physical-worker.mts',import.meta.url))],{
  cwd:fileURLToPath(new URL('../../',import.meta.url)),
  env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',DATABASE_URL:databaseUrl,
   AUTH_DEV_BYPASS:profile==='P2'?'0':'1',FINNOR_P4_PROFILE:'ordinary_disposable',FINNOR_NATIVE_QUEUE_PROFILE:profile,
   ...(profile==='P2'?nativeEnvironment:{}),...(settings?{FINNOR_PRIORITY_AGING_SECONDS:String(settings.priorityAgingSeconds),
    ...(settings.leaseSeconds===undefined?{}:{FINNOR_NATIVE_QUEUE_LEASE_SECONDS:String(settings.leaseSeconds)}),
    ...(settings.workloadClass?{FINNOR_WORKLOAD_CLASS:settings.workloadClass}:{})}:{})},stdio:['ignore','pipe','pipe','ipc']});
 const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void}>(),
  registered=new Set(profile==='P5'?['run_interface_acquisition_v1']:[]);
 let trace=Promise.resolve(),outputBytes=0;
 const record=(value:unknown)=>{trace=trace.then(()=>appendFile(join(directory,'physical-worker-'+worker.pid+'.jsonl'),JSON.stringify(value)+'\n',{mode:0o600}));void trace.catch(()=>undefined);};
 const fail=(error:Error)=>{for(const p of pending.values())p.reject(error);pending.clear();};
 worker.on('message',(message:any)=>{if(message.type==='observation'){record(message);return;}
  const p=pending.get(message.id);if(!p)return;pending.delete(message.id);
  if(message.error)p.reject(Object.assign(new Error(message.error.message),{cause:message.error}));else p.resolve(message.value);});
 worker.on('error',fail);worker.on('exit',(code,signal)=>{record({type:'worker-exit',pid:worker.pid,code,signal,at:new Date().toISOString()});fail(Error('P5_PHYSICAL_WORKER_EXIT:'+code+':'+signal));});
 const closed=new Promise<void>(resolve=>worker.once('close',()=>resolve()));
 for(const stream of [worker.stdout,worker.stderr])stream?.on('data',(chunk:Buffer)=>{
  outputBytes+=chunk.length;if(outputBytes>2*1024*1024){fail(Error('P5_ORIGINAL_WORKER_OUTPUT_BOUND_EXCEEDED'));return;}
  trace=trace.then(()=>appendFile(join(directory,'physical-worker-'+worker.pid+'.log'),chunk,{mode:0o600}));void trace.catch(()=>undefined);});
 const rpc=async(operation:string,extra:Record<string,unknown>={}):Promise<any>=>{
  let timer:ReturnType<typeof setTimeout>|undefined,timedOut=false;
  const request=new Promise<any>((resolve,reject)=>{
   if(!worker.connected)return reject(Error('P5_PHYSICAL_WORKER_DISCONNECTED'));
   const id=randomUUID();pending.set(id,{resolve,reject});worker.send({id,operation,registered:[...registered],
    ...(profile==='P2'?{endpointConfig:process.env.FINNOR_P2_ENDPOINT_CONFIG??null}:{}),...extra},
    error=>{if(error){pending.delete(id);reject(error);}});
  });
  try{return await Promise.race([request,new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>{timedOut=true;reject(Error('OWNED_PHYSICAL_WORKER_RPC_BOUND:'+operation));},
    operation==='identity'||operation==='close'?10000:180000);
  })]);}
  catch(error){if(timedOut){try{await stopOwned();}finally{await Promise.allSettled([request]);}}throw error;}
  finally{if(timer)clearTimeout(timer);}
 };
 const register=(...args:Parameters<JobQueue['register']>)=>{
  const [type,handler,contract]=args;
  if(handlers[type]!==handler.name||JSON.stringify(contract)!==JSON.stringify(PRODUCTION_JOB_CONTRACTS[type as keyof typeof PRODUCTION_JOB_CONTRACTS]))
   throw Error('P5_FIXTURE_REQUIRES_EXACT_REGISTERED_PRODUCTION_HANDLER_AND_CONTRACT');
  registered.add(type);
 };
 async function stopOwned(){
  if(worker.exitCode===null&&worker.signalCode===null){
   worker.kill('SIGCONT');worker.kill('SIGTERM');
   const timer=setTimeout(()=>worker.kill('SIGKILL'),5000);
   try{await closed;}finally{clearTimeout(timer);}
  }else await closed;
  await trace;
 }
 let identity:any;
 try{identity=await rpc('identity');}catch(error){await stopOwned();throw error;}
 return {register,tick:()=>rpc('tick'),recoverExpiredRunningJobs:(leaseSeconds=3)=>rpc('recover',{leaseSeconds}),
  registeredTypes:()=>[...registered].sort(),identity,pid:worker.pid,close:async()=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    if(worker.connected)await Promise.race([rpc('close'),new Promise<never>((_,reject)=>{
     timer=setTimeout(()=>reject(Error('OWNED_PHYSICAL_WORKER_CLOSE_BOUND_EXCEEDED')),10000);
    })]);
   }finally{if(timer)clearTimeout(timer);await stopOwned();}
  }};
}
