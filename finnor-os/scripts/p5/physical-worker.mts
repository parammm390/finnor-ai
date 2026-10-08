import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runInterfaceAcquisitionJob} from '../../packages/private-equity/src/interface-synthesis/worker';
import {closePool} from '@finnor/db';
const queue=new JobQueue('p5-physical-'+process.pid,3);
queue.register('run_interface_acquisition_v1',runInterfaceAcquisitionJob,PRODUCTION_JOB_CONTRACTS.run_interface_acquisition_v1);
await queue.tick();
await closePool();
