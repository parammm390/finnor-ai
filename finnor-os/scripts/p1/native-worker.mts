/** Actual existing JobQueue delivery in a fresh native worker process. */
import {JobQueue} from '../../apps/worker/src/queue';
import {closePool} from '@finnor/db';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runHarnessProgramJob} from '../../packages/private-equity/src/program-synthesis/worker';
import {runEvidenceDerivationJob} from '../../packages/private-equity/src/evidence-execution/worker';
import {runObjectiveIteration} from '../../apps/worker/src/handlers/run-objective-iteration';
import {runWorkforceAssignment} from '../../apps/worker/src/handlers/run-workforce-assignment';
import {processWorkEventWaitDeadlineHandler} from '../../apps/worker/src/handlers/process-work-event-wait-deadline';
if(process.env.NODE_ENV!=='test'||!process.env.DATABASE_URL)throw Error('DISPOSABLE_NATIVE_WORKER_REQUIRED');
const queue=new JobQueue('p1-cold-worker-'+process.pid,3);
queue.register('run_harness_program_v1',runHarnessProgramJob,PRODUCTION_JOB_CONTRACTS.run_harness_program_v1);
queue.register('run_evidence_derivation_v1',runEvidenceDerivationJob,PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
queue.register('run_objective_iteration',runObjectiveIteration,PRODUCTION_JOB_CONTRACTS.run_objective_iteration);
queue.register('run_workforce_assignment',runWorkforceAssignment,PRODUCTION_JOB_CONTRACTS.run_workforce_assignment);
queue.register('process_work_event_wait_deadline',processWorkEventWaitDeadlineHandler,PRODUCTION_JOB_CONTRACTS.process_work_event_wait_deadline);
const iterations=Number(process.env.FINNOR_P1_WORKER_TICKS??20);if(!Number.isInteger(iterations)||iterations<1||iterations>100)throw Error('DISPOSABLE_TICK_BOUND');
try{let worked=0;for(let i=0;i<iterations;i++){if(await queue.tick())worked++;await new Promise(r=>setTimeout(r,30));}console.log(JSON.stringify({schema:'finnor.p1.cold-worker.v1',pid:process.pid,node:process.version,iterations,worked,supervisorResources:process.resourceUsage(),billingUSD:null,qualification:'REAL_DURABLE_NATIVE_QUEUE_WORKER_NO_RESOURCE_ADMISSION'}));}finally{await closePool();}
