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
 run_compute_search_unit_v1:'runComputeSearchUnitJob',run_procedure_induction_v1:'runProcedureInductionJob',
 reconcile_analytical_executor_v1:'reconcileAnalyticalExecutorJob'};
export async function physicalNativeQueue(databaseUrl:string,directory:string,options:{leaseSeconds?:number;environment?:Record<string,string>}={}){
 if(new URL(databaseUrl).username!=='finnor_worker')throw Error('P5_RESTRICTED_WORKER_CONNECTION_REQUIRED');
 const worker=spawn(process.execPath,['--max-old-space-size=768','--import=tsx',fileURLToPath(new URL('./physical-worker.mts',import.meta.url))],{
  cwd:fileURLToPath(new URL('../../',import.meta.url)),
  env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',DATABASE_URL:databaseUrl,
   AUTH_DEV_BYPASS:'1',FINNOR_P4_PROFILE:'ordinary_disposable',
   ...Object.fromEntries(Object.entries(options.environment??{}).filter(([key])=>['FINNOR_P4_PROFILE','FINNOR_ENVIRONMENT','FINNOR_P1_EXECUTOR','DAYTONA_API_KEY','DAYTONA_API_URL','FINNOR_DAYTONA_PROFILE','FINNOR_DAYTONA_PROTOCOL_FIXTURE','FINNOR_M1_PROFILE','FINNOR_M1_STORE','FINNOR_S3_MODEL_STORE','FINNOR_S3_PYTHON','FINNOR_S4_POLICY_STORE','FINNOR_S5_PYTHON','P3_GOVERNORS'].includes(key))),
   FINNOR_NATIVE_WORKER_LEASE_SECONDS:String(options.leaseSeconds??3)},stdio:['ignore','pipe','pipe','ipc']});
 const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void}>(),registered=new Set(['run_interface_acquisition_v1']);
 let trace=Promise.resolve(),outputBytes=0;
 const record=(value:unknown)=>{trace=trace.then(()=>appendFile(join(directory,'physical-worker-'+worker.pid+'.jsonl'),JSON.stringify(value)+'\n',{mode:0o600}));};
 const fail=(error:Error)=>{for(const p of pending.values())p.reject(error);pending.clear();};
 worker.on('message',(message:any)=>{if(message.type==='observation'){record(message);return;}
  const p=pending.get(message.id);if(!p)return;pending.delete(message.id);
  if(message.error)p.reject(Object.assign(new Error(message.error.message),{cause:message.error}));else p.resolve(message.value);});
 worker.on('error',fail);worker.on('exit',(code,signal)=>{record({type:'worker-exit',pid:worker.pid,code,signal,at:new Date().toISOString()});fail(Error('P5_PHYSICAL_WORKER_EXIT:'+code+':'+signal));});
 for(const stream of [worker.stdout,worker.stderr])stream?.on('data',(chunk:Buffer)=>{
  outputBytes+=chunk.length;if(outputBytes>2*1024*1024){fail(Error('P5_ORIGINAL_WORKER_OUTPUT_BOUND_EXCEEDED'));return;}
  trace=trace.then(()=>appendFile(join(directory,'physical-worker-'+worker.pid+'.log'),chunk,{mode:0o600}));});
 const rpc=(operation:string,extra:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{
  if(!worker.connected)return reject(Error('P5_PHYSICAL_WORKER_DISCONNECTED'));
  const id=randomUUID();pending.set(id,{resolve,reject});worker.send({id,operation,registered:[...registered],...extra},error=>{if(error){pending.delete(id);reject(error);}});
 });
 const register=(...args:Parameters<JobQueue['register']>)=>{
  const [type,handler,contract]=args;
  if(handlers[type]!==handler.name||JSON.stringify(contract)!==JSON.stringify(PRODUCTION_JOB_CONTRACTS[type as keyof typeof PRODUCTION_JOB_CONTRACTS]))
   throw Error('P5_FIXTURE_REQUIRES_EXACT_REGISTERED_PRODUCTION_HANDLER_AND_CONTRACT');
  registered.add(type);
 };
 await rpc('identity');
 return {register,tick:()=>rpc('tick'),recoverExpiredRunningJobs:(leaseSeconds=3)=>rpc('recover',{leaseSeconds}),
  pid:worker.pid,close:async()=>{
   try{if(worker.connected)await rpc('close');}
   finally{if(worker.exitCode===null&&worker.signalCode===null){const done=new Promise<void>(resolve=>worker.once('close',()=>resolve()));
    worker.kill('SIGTERM');const timer=setTimeout(()=>worker.kill('SIGKILL'),5000);await done;clearTimeout(timer);}await trace;}
  }};
}
