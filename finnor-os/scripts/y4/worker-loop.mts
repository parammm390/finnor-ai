/** IPC schedules ordinary durable claims, never direct handler invocations. */
import {createWorker} from '../../apps/worker/src/index';
import {closePool} from '@finnor/db';
import {z} from 'zod';
import {verifyInstallation} from './installation.mts';
const custody=await verifyInstallation(),queue=createWorker();
const request=z.object({operation:z.enum(['TICK','STOP']),id:z.number().int().positive()}).strict();
let work=Promise.resolve();
process.on('message',(raw:unknown)=>{
 work=work.then(async()=>{
  const input=request.parse(raw);
  if(input.operation==='STOP'){await closePool();process.disconnect();return;}
  const start=performance.now();await queue.recoverExpiredRunningJobs();const claimed=await queue.tick();
  process.send?.({id:input.id,pid:process.pid,claimed,wallMs:performance.now()-start,custody,
   productionWorkerFactory:true,workerId:queue.instanceId,leaseSeconds:queue.leaseSeconds,workloadClass:queue.workloadClass});
 }).catch(async()=>{process.exitCode=1;await closePool();if(process.connected)process.disconnect();});
});
process.once('disconnect',()=>{void work.finally(()=>closePool());});
if(!process.connected)throw Error('Y4_TASK_WORKER_CONTROL_REQUIRED');
process.send?.({kind:'READY',pid:process.pid,custody,productionWorkerFactory:true,
 workerId:queue.instanceId,leaseSeconds:queue.leaseSeconds,workloadClass:queue.workloadClass,
 registeredTypes:queue.registeredTypes()});
