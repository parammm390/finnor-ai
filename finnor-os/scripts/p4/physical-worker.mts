/** A separate actual JobQueue process for physical kill/recovery challenges. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runEvidenceDerivationJob} from '../../packages/private-equity/src/evidence-execution/worker';
import {closePool} from '@finnor/db';
const q=new JobQueue('p4-physical-'+process.pid,3);
q.register('run_evidence_derivation_v1',runEvidenceDerivationJob,PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
try{await q.recoverExpiredRunningJobs();await q.tick();}finally{await closePool();}
