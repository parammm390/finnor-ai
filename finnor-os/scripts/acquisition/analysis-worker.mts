import {JobQueue} from '../../apps/worker/src/queue';
import {closePool} from '@finnor/db';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runAcquisitionDecisionJob} from '../../packages/private-equity/src/acquisition/decision';
import {runHarnessProgramJob} from '../../packages/private-equity/src/program-synthesis/worker';
import {runEvidenceDerivationJob} from '../../packages/private-equity/src/evidence-execution/worker';
import {reconcileAnalyticalExecutorJob} from '../../packages/private-equity/src/program-synthesis/isolated-custody';
import {runProcedureInductionJob} from '../../packages/private-equity/src/procedure-induction/worker';
import {runComputeSearchUnitJob} from '../../packages/private-equity/src/compute-search/worker';
if(process.env.NODE_ENV!=='test'||!process.env.DATABASE_URL)throw Error('DISPOSABLE_NATIVE_WORKER_REQUIRED');
// Exercise the production default lease; each registered contract must bound it.
const queue=new JobQueue('acquisition-analysis-worker-'+process.pid);
queue.register('evaluate_acquisition_v1',runAcquisitionDecisionJob,PRODUCTION_JOB_CONTRACTS.evaluate_acquisition_v1);
queue.register('run_harness_program_v1',runHarnessProgramJob,PRODUCTION_JOB_CONTRACTS.run_harness_program_v1);
queue.register('run_evidence_derivation_v1',runEvidenceDerivationJob,PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
queue.register('reconcile_analytical_executor_v1',reconcileAnalyticalExecutorJob,PRODUCTION_JOB_CONTRACTS.reconcile_analytical_executor_v1);
queue.register('run_procedure_induction_v1',runProcedureInductionJob,PRODUCTION_JOB_CONTRACTS.run_procedure_induction_v1);
queue.register('run_compute_search_unit_v1',runComputeSearchUnitJob,PRODUCTION_JOB_CONTRACTS.run_compute_search_unit_v1);
const ticks=Number(process.env.FINNOR_ACQUISITION_WORKER_TICKS??40);
if(!Number.isInteger(ticks)||ticks<1||ticks>100)throw Error('DISPOSABLE_TICK_BOUND');
try{for(let i=0;i<ticks;i++){await queue.recoverExpiredRunningJobs();await queue.tick();await new Promise(r=>setTimeout(r,100));}}finally{await closePool();}
