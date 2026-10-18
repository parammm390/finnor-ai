/** Physical ordinary worker, one bounded claim. Never a direct handler call. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {buildEnterpriseApplicationJob} from '../../packages/private-equity/src/enterprise-applications/worker';
import {closePool} from '@finnor/db';
const queue=new JobQueue('x3-physical-'+process.pid,1);
queue.register('build_enterprise_application_v1',buildEnterpriseApplicationJob,PRODUCTION_JOB_CONTRACTS.build_enterprise_application_v1);
await queue.recoverExpiredRunningJobs();
await queue.tick();
await closePool();
