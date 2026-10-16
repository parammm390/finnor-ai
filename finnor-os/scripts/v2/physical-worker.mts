/** Uses final worker registration and real queue claims in a separate process. */
import {createWorker} from '../../apps/worker/src/index';
import {closePool,getPool} from '@finnor/db';
process.env.WORKER_JOB_LEASE_SECONDS='3';
const queue=createWorker();
try{
 const role=(await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
 if(role.current_user!=='finnor_worker'||role.rolsuper||role.rolbypassrls)throw Error('ORDINARY_SEPARATE_WORKER_ROLE_REQUIRED');
 if(!queue.registeredTypes().includes('advance_primary_diligence_v1'))throw Error('FINAL_V2_HANDLER_NOT_REGISTERED');
 await queue.recoverExpiredRunningJobs();
 const claimed=await queue.tick();
 console.log(JSON.stringify({workerRole:role,registeredV2:true,claimed}));
}finally{await closePool();}
process.exit(0);
