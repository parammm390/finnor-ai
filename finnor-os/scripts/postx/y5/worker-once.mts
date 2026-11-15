import {createWorker} from '../../../apps/worker/src/index';
import {closePool,getPool} from '@finnor/db';
const jobId=process.argv[2];
if(!jobId||!/^[a-f0-9-]{36}$/.test(jobId))throw Error('Y5_ORIGINAL_JOB_REQUIRED');
const queue=createWorker();
try{
 await queue.recoverExpiredRunningJobs();
 for(let ticks=0;ticks<64;ticks++){
  const row=(await getPool().query("SELECT type,status FROM finnor_os.jobs WHERE id=$1",[jobId])).rows[0];
  if(!row||row.type!=='discover_uniform_algorithm_v1')throw Error('Y5_ORIGINAL_JOB_REQUIRED');
  if(row.status==='completed')break;
  if(row.status!=='queued'||!await queue.tick())throw Error('Y5_ORIGINAL_JOB_NOT_READY:'+row.status);
 }
 const row=(await getPool().query("SELECT status,attempts,claim_fence FROM finnor_os.jobs WHERE id=$1",[jobId])).rows[0];
 console.log(JSON.stringify({jobId,...row,productionWorkerFactory:true}));
 if(row?.status!=='completed')throw Error('Y5_ORIGINAL_JOB_NOT_COMPLETED');
}finally{await closePool();}
