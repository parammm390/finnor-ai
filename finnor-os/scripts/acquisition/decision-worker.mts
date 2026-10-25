import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runAcquisitionDecisionJob} from '../../packages/private-equity/src/acquisition/decision';
import {closePool} from '@finnor/db';
const queue=new JobQueue('acquisition-e2e-'+process.pid,120);
queue.register('evaluate_acquisition_v1',runAcquisitionDecisionJob,PRODUCTION_JOB_CONTRACTS.evaluate_acquisition_v1);
try{await queue.tick();}finally{await closePool();}
