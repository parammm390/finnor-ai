import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runInterfaceAcquisitionJob} from '../../packages/private-equity/src/interface-synthesis/worker';
import {runEvidenceDerivationJob} from '../../packages/private-equity/src/evidence-execution/worker';
import {runHarnessProgramJob} from '../../packages/private-equity/src/program-synthesis/worker';
import {runComputeSearchUnitJob} from '../../packages/private-equity/src/compute-search/worker';
import {runProcedureInductionJob} from '../../packages/private-equity/src/procedure-induction/worker';
import {reconcileAnalyticalExecutorJob} from '../../packages/private-equity/src/program-synthesis/isolated-custody';
import {closePool,getPool} from '@finnor/db';
const handlers={run_interface_acquisition_v1:runInterfaceAcquisitionJob,
 run_evidence_derivation_v1:runEvidenceDerivationJob,run_harness_program_v1:runHarnessProgramJob,
 run_compute_search_unit_v1:runComputeSearchUnitJob,run_procedure_induction_v1:runProcedureInductionJob,
 reconcile_analytical_executor_v1:reconcileAnalyticalExecutorJob};
if(!process.env.DATABASE_URL||new URL(process.env.DATABASE_URL).username!=='finnor_worker')throw Error('P5_RESTRICTED_PHYSICAL_WORKER_REQUIRED');
const identity=(await getPool().query(`SELECT current_user AS role,r.rolsuper,r.rolbypassrls,
 pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
if(identity?.role!=='finnor_worker'||identity.rolsuper||identity.rolbypassrls||identity.app_inherits_worker)throw Error('P5_WORKER_ROLE_SEPARATION_REQUIRED');
const leaseSeconds=Number(process.env.FINNOR_NATIVE_WORKER_LEASE_SECONDS??3);
if(!Number.isInteger(leaseSeconds)||leaseSeconds<3||leaseSeconds>300)throw Error('DISPOSABLE_WORKER_LEASE_BOUND');
const queue=new JobQueue('p5-physical-'+process.pid,leaseSeconds);
queue.register('run_interface_acquisition_v1',runInterfaceAcquisitionJob,PRODUCTION_JOB_CONTRACTS.run_interface_acquisition_v1);
const registered=new Set(['run_interface_acquisition_v1']);
if(process.send){
 let work=Promise.resolve();
 process.on('message',(message:any)=>{work=work.then(async()=>{
  const startedAt=new Date().toISOString();
  try{
   for(const type of message.registered??[]){if(!(type in handlers))throw Error('P5_UNKNOWN_PRODUCTION_HANDLER');
    if(!registered.has(type)){queue.register(type,handlers[type as keyof typeof handlers],PRODUCTION_JOB_CONTRACTS[type as keyof typeof handlers]);registered.add(type);}}
   let value:any;
   if(message.operation==='identity')value={pid:process.pid,parentPid:process.ppid,identity};
   else if(message.operation==='tick')value=await queue.tick();
   else if(message.operation==='recover')value=await queue.recoverExpiredRunningJobs(message.leaseSeconds);
   else if(message.operation==='close'){await closePool();value={closed:true};}
   else throw Error('P5_UNKNOWN_FIXTURE_OPERATION');
   process.send?.({type:'observation',pid:process.pid,parentPid:process.ppid,identity,operation:message.operation,
    registered:[...registered],startedAt,completedAt:new Date().toISOString(),result:value});
   process.send?.({id:message.id,value});
   if(message.operation==='close')process.disconnect();
  }catch(error){process.send?.({id:message.id,error:{message:String((error as Error).message),stack:(error as Error).stack,
    code:(error as any).code??null,cause:(error as any).cause?.message??null}});}
 });});
 process.once('SIGTERM',()=>{void closePool().finally(()=>process.exit(0));});
}else{await queue.tick();await closePool();}
