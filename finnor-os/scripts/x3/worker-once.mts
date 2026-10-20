/** Physical ordinary worker, one bounded claim. Never a direct handler call. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {buildEnterpriseApplicationJob} from '../../packages/private-equity/src/enterprise-applications/worker';
import {closePool} from '@finnor/db';
const queue=new JobQueue('x3-physical-'+process.pid);
console.log('X3_WORKER_RUNTIME',JSON.stringify({workerId:queue.instanceId,effectiveLeaseSeconds:queue.leaseSeconds,workloadClass:queue.workloadClass}));
queue.register('build_enterprise_application_v1',buildEnterpriseApplicationJob,PRODUCTION_JOB_CONTRACTS.build_enterprise_application_v1);
await queue.recoverExpiredRunningJobs();
await queue.tick();
await closePool();
