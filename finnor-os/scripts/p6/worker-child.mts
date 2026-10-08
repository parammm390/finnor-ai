/** Actual short-lease native queue delivery for physical interruption proof. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runProcedureInductionJob} from '../../packages/private-equity/src/procedure-induction/worker';
import {closePool} from '@finnor/db';
import {codeIdentity} from '../../packages/private-equity/src/evidence-execution/store';
if(process.env.NODE_ENV!=='test'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')
  throw Error('DISPOSABLE_CHILD_ONLY');
const lease=Number(process.env.FINNOR_P6_TEST_LEASE_SECONDS??3);
if(![3,10,60].includes(lease))throw Error('REGISTERED_DISPOSABLE_LEASE_PROFILE_REQUIRED');
const queue=new JobQueue('p6-physical-worker:'+process.pid,lease);
queue.register('run_procedure_induction_v1',runProcedureInductionJob,PRODUCTION_JOB_CONTRACTS.run_procedure_induction_v1);
if(process.env.FINNOR_P6_CHILD_PROGRAMME==='1'){
  queue.register('run_harness_program_v1',
    (await import('../../packages/private-equity/src/program-synthesis/worker')).runHarnessProgramJob,
    PRODUCTION_JOB_CONTRACTS.run_harness_program_v1);
  queue.register('run_evidence_derivation_v1',
    (await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,
    PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
}
if(process.env.FINNOR_P6_AWAIT_START==='1'){
  if(!process.send)throw Error('PHYSICAL_WORKER_IPC_REQUIRED');
  const identity=await codeIdentity();
  process.send({schema:'finnor.p6.physical-worker-ready.v1',pid:process.pid,
    codeDigest:identity.digest,leaseSeconds:lease,registeredTypes:queue.registeredTypes()});
  await new Promise<void>((yes,no)=>{
    const timer=setTimeout(()=>no(Error('PHYSICAL_WORKER_START_BOUND_EXHAUSTED')),60000);
    process.once('message',message=>{
      clearTimeout(timer);
      if((message as {kind?:string})?.kind!=='start-native-polling')
        no(Error('PHYSICAL_WORKER_START_SIGNAL_INVALID'));
      else yes();
    });
  });
}
try{for(let i=0;i<30;i++){await queue.tick();await new Promise(r=>setTimeout(r,50));}}
finally{await closePool();process.exit(0);}
