import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {closePool,getPool} from '@finnor/db';
// Identity attests the restricted process, not unrequested handler modules.
// Load the actual production export before registration, never a proxy handler.
const handlers={
 run_interface_acquisition_v1:{name:'runInterfaceAcquisitionJob',
  load:async()=>(await import('../../packages/private-equity/src/interface-synthesis/worker')).runInterfaceAcquisitionJob},
 run_evidence_derivation_v1:{name:'runEvidenceDerivationJob',
  load:async()=>(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob},
 run_harness_program_v1:{name:'runHarnessProgramJob',
  load:async()=>(await import('../../packages/private-equity/src/program-synthesis/worker')).runHarnessProgramJob},
 run_compute_search_unit_v1:{name:'runComputeSearchUnitJob',
  load:async()=>(await import('../../packages/private-equity/src/compute-search/worker')).runComputeSearchUnitJob},
 run_objective_iteration:{name:'runObjectiveIteration',
  load:async()=>(await import('../../apps/worker/src/handlers/run-objective-iteration')).runObjectiveIteration},
 run_workforce_assignment:{name:'runWorkforceAssignment',
  load:async()=>(await import('../../apps/worker/src/handlers/run-workforce-assignment')).runWorkforceAssignment},
 process_work_event_wait_deadline:{name:'processWorkEventWaitDeadlineHandler',
  load:async()=>(await import('../../apps/worker/src/handlers/process-work-event-wait-deadline')).processWorkEventWaitDeadlineHandler}
};
if(!process.env.DATABASE_URL||new URL(process.env.DATABASE_URL).username!=='finnor_worker')throw Error('P5_RESTRICTED_PHYSICAL_WORKER_REQUIRED');
const identity=(await getPool().query(`SELECT current_user AS role,r.rolsuper,r.rolbypassrls,
 pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
if(identity?.role!=='finnor_worker'||identity.rolsuper||identity.rolbypassrls||identity.app_inherits_worker)throw Error('P5_WORKER_ROLE_SEPARATION_REQUIRED');
const leaseSeconds=Number(process.env.FINNOR_NATIVE_QUEUE_LEASE_SECONDS??'3');
if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<3||leaseSeconds>60)throw Error('ORIGINAL_PHYSICAL_QUEUE_LEASE_BOUND');
const queue=new JobQueue('p5-physical-'+process.pid,leaseSeconds);
const profile=process.env.FINNOR_NATIVE_QUEUE_PROFILE??'P5';
if(profile!=='P5'&&profile!=='P2')throw Error('SUPPORTED_PHYSICAL_QUEUE_PROFILE_REQUIRED');
if(profile==='P2'&&process.env.AUTH_DEV_BYPASS!=='0')throw Error('P2_PHYSICAL_WORKER_AUTH_BYPASS_FORBIDDEN');
const registered=new Set<string>();
async function register(type:string){
 if(!Object.hasOwn(handlers,type))throw Error('P5_UNKNOWN_PRODUCTION_HANDLER');
 if(registered.has(type))return;
 const entry=handlers[type as keyof typeof handlers],handler=await entry.load();
 if(typeof handler!=='function'||handler.name!==entry.name)throw Error('P5_EXACT_PRODUCTION_HANDLER_EXPORT_REQUIRED');
 queue.register(type,handler,PRODUCTION_JOB_CONTRACTS[type as keyof typeof handlers]);
 registered.add(type);
}
if(profile==='P5')await register('run_interface_acquisition_v1');
if(process.send){
 let work=Promise.resolve();
 process.on('message',(message:any)=>{work=work.then(async()=>{
  const startedAt=new Date().toISOString();
  try{
   if(profile==='P2'){
    if(typeof message.endpointConfig==='string')process.env.FINNOR_P2_ENDPOINT_CONFIG=message.endpointConfig;
    else delete process.env.FINNOR_P2_ENDPOINT_CONFIG;
   }
   for(const type of message.registered??[]){
    if(!Object.hasOwn(handlers,type))throw Error('P5_UNKNOWN_PRODUCTION_HANDLER');
    if(message.operation!=='close')await register(type);
   }
   let value:any;
   if(message.operation==='identity')value={pid:process.pid,parentPid:process.ppid,identity,authBypass:process.env.AUTH_DEV_BYPASS,
    scheduler:{tenantInflightLimit:queue.tenantInflightLimit,priorityAgingSeconds:queue.priorityAgingSeconds,workloadClass:queue.workloadClass,leaseSeconds}};
   else if(message.operation==='tick'){
    if(!registered.size)throw Error('P5_REGISTERED_PRODUCTION_HANDLER_REQUIRED');
    value=await queue.tick();
   }
   else if(message.operation==='recover')value=await queue.recoverExpiredRunningJobs(message.leaseSeconds);
   else if(message.operation==='close'){await closePool();value={closed:true};}
   else throw Error('P5_UNKNOWN_FIXTURE_OPERATION');
   process.send?.({type:'observation',pid:process.pid,parentPid:process.ppid,identity,operation:message.operation,
    registered:[...registered],startedAt,completedAt:new Date().toISOString(),result:value,
    resources:process.resourceUsage(),transport:(globalThis as any).__FINNOR_W1_READ_NETWORK_METER??null,
    completeChildUsage:null,costUSD:null});
   process.send?.({id:message.id,value});
   if(message.operation==='close')process.disconnect();
  }catch(error){process.send?.({id:message.id,error:{message:String((error as Error).message),stack:(error as Error).stack,
    code:(error as any).code??null,cause:(error as any).cause?.message??null}});}
 });});
 process.once('SIGTERM',()=>{void closePool().finally(()=>process.exit(0));});
}else{
 if(!registered.size)throw Error('P5_REGISTERED_PRODUCTION_HANDLER_REQUIRED');
 await queue.tick();await closePool();
}
