/** IPC requests only an ordinary native queue tick. No direct Y1 handler call. */
import {createWorker} from '../../apps/worker/src/index';
import {closePool} from '@finnor/db';
import {z} from 'zod';
const Request=z.object({id:z.number().int().positive(),operation:z.enum(['TICK','STOP'])}).strict();
const queue=createWorker();let chain=Promise.resolve();
process.on('message',raw=>{
 chain=chain.then(async()=>{
  const request=Request.parse(raw),started=performance.now();
  if(request.operation==='STOP'){await closePool();process.disconnect();return;}
  const recovered=await queue.recoverExpiredRunningJobs(),claimed=await queue.tick();
  process.send?.({id:request.id,pid:process.pid,productionWorkerFactory:true,recovered,claimed,
   workerId:queue.instanceId,leaseSeconds:queue.leaseSeconds,wallMs:performance.now()-started});
 }).catch(async(error)=>{
  const message=(error as Error).message;
  process.send?.({id:(raw as {id?:number})?.id,error:/^[A-Z0-9_ :.-]{1,256}$/.test(message)?message:'NATIVE_QUEUE_FAILURE'});
  process.exitCode=1;await closePool();if(process.connected)process.disconnect();
 });
});
process.once('disconnect',()=>{void chain.finally(()=>closePool());});
if(!process.connected)throw Error('Y1_DISPOSABLE_WORKER_CONTROL_REQUIRED');
