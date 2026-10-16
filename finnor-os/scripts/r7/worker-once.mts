/** Separate physical process using the real durable queue/handler contract. */
import { closePool, PRODUCTION_JOB_CONTRACTS } from '@finnor/db';
import { JobQueue } from '../../apps/worker/src/queue';
import { runDecisionAtlasJob } from '../../packages/private-equity/src/r7/worker';
const queue=process.env.FINNOR_R7_WORKER_REGISTRY==='PRODUCTION_ALL'
  ?(await import('../../apps/worker/src/index')).createWorker()
  :new JobQueue('r7-disposable-worker:'+process.pid,3);
if(process.env.FINNOR_R7_WORKER_REGISTRY!=='PRODUCTION_ALL')
  queue.register('run_decision_atlas_v1',runDecisionAtlasJob,PRODUCTION_JOB_CONTRACTS.run_decision_atlas_v1);
await queue.recoverExpiredRunningJobs();
await queue.tick();
await closePool();
