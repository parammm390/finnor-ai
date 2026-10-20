/** Task-owned ordinary queue worker. IPC only schedules bounded queue ticks;
 * handlers still require actual durable claims, leases and delivery fences. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {compileLearnedPolicyJob} from '../../packages/private-equity/src/policy-learning/worker';
import {buildEnterpriseApplicationJob} from '../../packages/private-equity/src/enterprise-applications/worker';
import {closePool} from '@finnor/db';
import {z} from 'zod';
const request=z.object({operation:z.enum(['TICK','STOP']),id:z.number().int().positive()}).strict();
const nativeFactory=process.env.FINNOR_X_PHASE_NATIVE_WORKER==='1';
const queueReady=(async()=>{
 if(nativeFactory)return (await import('../../apps/worker/src/index')).createWorker();
 const queue=new JobQueue('x5-physical-'+process.pid);
 queue.register('compile_learned_policy_v1',compileLearnedPolicyJob,PRODUCTION_JOB_CONTRACTS.compile_learned_policy_v1);
 queue.register('build_enterprise_application_v1',buildEnterpriseApplicationJob,PRODUCTION_JOB_CONTRACTS.build_enterprise_application_v1);
 return queue;
})();
let work=Promise.resolve();
process.on('message',(value:unknown)=>{
 work=work.then(async()=>{
  const input=request.parse(value),at=performance.now();
  if(input.operation==='STOP'){await closePool();process.disconnect();return;}
  const queue=await queueReady;
  await queue.recoverExpiredRunningJobs();const claimed=await queue.tick();
  process.send?.({id:input.id,pid:process.pid,wallMs:performance.now()-at,ordinaryQueueTick:true,claimed,
   productionWorkerFactory:nativeFactory,workerId:queue.instanceId,effectiveLeaseSeconds:queue.leaseSeconds,workloadClass:queue.workloadClass});
 }).catch(async()=>{
  process.exitCode=1;await closePool();if(process.connected)process.disconnect();
 });
});
process.once('disconnect',()=>{void work.finally(()=>closePool());});
if(!process.connected)throw Error('TASK_OWNED_WORKER_CONTROL_REQUIRED');
