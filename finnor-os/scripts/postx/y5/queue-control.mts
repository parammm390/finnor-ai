import {createWorker} from '../../../apps/worker/src/index';
import {closePool} from '@finnor/db';
import {z} from 'zod';
if(!process.connected)throw Error('Y5_CONTROLLED_QUEUE_PARENT_REQUIRED');
const queue=createWorker(),input=z.object({id:z.number().int().positive(),operation:z.enum(['TICK','RECOVER','STOP'])}).strict();
let work=Promise.resolve();
process.on('message',(raw:unknown)=>{
 work=work.then(async()=>{
  const request=input.parse(raw),started=performance.now();
  if(request.operation==='STOP'){await closePool();process.disconnect();return;}
  const result=request.operation==='RECOVER'?await queue.recoverExpiredRunningJobs():await queue.tick();
  process.send?.({id:request.id,result,pid:process.pid,wallMs:performance.now()-started,productionWorkerFactory:true,
   leaseSeconds:queue.leaseSeconds,workerId:queue.instanceId});
 }).catch(async error=>{
  process.send?.({id:(raw as {id?:number})?.id,error:(error instanceof Error?error.message:String(error))
   .replace(/postgres(?:ql)?:\/\/\S+/gi,'[private connection]').replace(/Bearer \S+/gi,'[private bearer]')});
  process.exitCode=1;await closePool();if(process.connected)process.disconnect();
 });
});
process.once('disconnect',()=>{void work.finally(()=>closePool());});
process.send?.({kind:'READY',pid:process.pid,productionWorkerFactory:true,leaseSeconds:queue.leaseSeconds});
