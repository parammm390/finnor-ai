/** IPC schedules ordinary durable queue ticks only. The production handler
 * still requires real JobQueue claims, deliveries and original owner fences. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {identifyDigitalSystemJob} from '../../packages/private-equity/src/system-identification/worker';
import {closePool} from '@finnor/db';
import {z} from 'zod';
const input=z.object({operation:z.enum(['TICK','STOP']),id:z.number().int().positive()}).strict();
const nativeFactory=process.env.FINNOR_X_PHASE_NATIVE_WORKER==='1';
const queueReady=(async()=>{
 if(nativeFactory)return (await import('../../apps/worker/src/index')).createWorker();
 const queue=new JobQueue('x4-physical-'+process.pid);
 queue.register('identify_digital_system_v1',identifyDigitalSystemJob,PRODUCTION_JOB_CONTRACTS.identify_digital_system_v1);
 return queue;
})();
let work=Promise.resolve();
process.on('message',(raw:unknown)=>{
 work=work.then(async()=>{
  const request=input.parse(raw),at=performance.now();
  if(request.operation==='STOP'){await closePool();process.disconnect();return;}
  const queue=await queueReady;
  await queue.recoverExpiredRunningJobs();const claimed=await queue.tick();
  process.send?.({id:request.id,pid:process.pid,wallMs:performance.now()-at,ordinaryQueueTick:true,claimed,
   productionWorkerFactory:nativeFactory,workerId:queue.instanceId,effectiveLeaseSeconds:queue.leaseSeconds,workloadClass:queue.workloadClass});
 }).catch(async error=>{
  const message=error instanceof Error?error.message:'X4_ORDINARY_QUEUE_DRIVER_FAILED';
  process.send?.({id:(raw as {id?:number})?.id,error:message.replace(/postgres(?:ql)?:\/\/\S+/gi,'[private connection]').replace(/Bearer \S+/gi,'[private bearer]')});
  process.exitCode=1;await closePool();if(process.connected)process.disconnect();
 });
});
process.once('disconnect',()=>{void work.finally(()=>closePool());});
if(!process.connected)throw Error('X4_TASK_OWNED_WORKER_CONTROL_REQUIRED');
await queueReady;
process.send?.({kind:'READY',pid:process.pid,ordinaryQueueRegistered:true,productionWorkerFactory:nativeFactory});
