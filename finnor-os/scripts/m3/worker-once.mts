import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS,closePool} from '@finnor/db';
import {runCapitalProgramJob} from '../../packages/private-equity/src/capital-program/worker';
const queue=new JobQueue('m3-disposable-physical-worker',3);
queue.register('run_capital_program_v2',runCapitalProgramJob,PRODUCTION_JOB_CONTRACTS.run_capital_program_v2);
await queue.tick();await closePool();
