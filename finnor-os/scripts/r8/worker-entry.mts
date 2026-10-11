/** Isolated supported ordinary worker entry, using the production registered
 * queue and handler. No fake execution context or accepted receipt is supplied. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS,closePool,type ProductionJobContract} from '@finnor/db';
import {runSolverSynthesisJob} from '../../packages/private-equity/src/r8/worker';
const queue=new JobQueue(undefined,Number(process.env.WORKER_JOB_LEASE_SECONDS??300),'HEAVY');
const contract=(PRODUCTION_JOB_CONTRACTS as Partial<Record<string,ProductionJobContract>>).run_solver_synthesis_v1;
if(!contract)throw Error('R8_SHARED_PRODUCTION_JOB_CONTRACT_NOT_INSTALLED');
queue.register('run_solver_synthesis_v1',runSolverSynthesisJob,contract);
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
console.log(JSON.stringify({status:'READY',pid:process.pid,handler:'run_solver_synthesis_v1',schema:1,protected:false}));
let recovery:Promise<void>|null=null;
const recoverExpired=()=>{
 if(controller.signal.aborted||recovery)return;
 recovery=queue.recoverExpiredRunningJobs().then(recovered=>{
  if(recovered)console.log(JSON.stringify({operation:'CANONICAL_EXPIRED_LEASE_RECOVERY',recovered}));
 }).catch(error=>{console.error(error);controller.abort(error);}).finally(()=>{recovery=null;});
};
recoverExpired();
const recoveryTimer=setInterval(recoverExpired,30000);
try{await queue.runLoop(200,controller.signal,1);}
finally{clearInterval(recoveryTimer);if(recovery)await recovery;await closePool();}
