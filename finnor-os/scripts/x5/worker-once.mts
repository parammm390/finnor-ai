/** Actual ordinary queue claim; no direct handler calls or acceptance mocks. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {compileLearnedPolicyJob} from '../../packages/private-equity/src/policy-learning/worker';
import {buildEnterpriseApplicationJob} from '../../packages/private-equity/src/enterprise-applications/worker';
import {closePool} from '@finnor/db';
const queue=new JobQueue('x5-physical-'+process.pid);
queue.register('compile_learned_policy_v1',compileLearnedPolicyJob,PRODUCTION_JOB_CONTRACTS.compile_learned_policy_v1);
queue.register('build_enterprise_application_v1',buildEnterpriseApplicationJob,PRODUCTION_JOB_CONTRACTS.build_enterprise_application_v1);
await queue.recoverExpiredRunningJobs();
await queue.tick();
await closePool();
