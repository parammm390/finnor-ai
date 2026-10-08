import {AsyncLocalStorage} from 'node:async_hooks';
import {withDatabaseExecutionDeadline,DatabaseExecutionDeadlineError,executionDeadlineMilliseconds} from '@finnor/db';
import {CapitalProgramV2Error} from './v2-contracts';
const budget=new AsyncLocalStorage<{deadline:number}>();
export function m3Deadline():number{return budget.getStore()?.deadline??performance.now()+30000;}
export function m3CheckTime():void{if(performance.now()>=m3Deadline())throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Whole capital programme deadline exhausted');}
export function m3Remaining():number{m3CheckTime();return Math.max(1,Math.floor(m3Deadline()-performance.now()));}
export async function inM3Episode<T>(milliseconds:number,invoke:()=>Promise<T>):Promise<T>{
  const deadline=Math.min(budget.getStore()?.deadline??Infinity,performance.now()+milliseconds);
  return budget.run({deadline},()=>withDatabaseExecutionDeadline(deadline,async()=>{
    try{const result=await invoke();m3CheckTime();return result;}
    catch(error){if(error instanceof DatabaseExecutionDeadlineError||performance.now()>=deadline)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Whole capital programme deadline exhausted');throw error;}
  }));
}
export function m3TransportDeadline(request:Request):number{
  const header=request.headers.get('x-capital-program-deadline-ms');if(header===null)return 30000;
  if(!/^\d+$/.test(header)||!Number.isSafeInteger(Number(header))||Number(header)<1||Number(header)>30000)
    throw new CapitalProgramV2Error('INVALID_REQUEST','Invalid capital programme request deadline');
  return Number(header);
}
export async function readM3Body(request:Request):Promise<unknown>{
  const limit=65536;if(Number(request.headers.get('content-length'))>limit){await request.body?.cancel().catch(()=>undefined);throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Capital programme request exceeds 64 KiB');}
  if(!request.body)throw new CapitalProgramV2Error('INVALID_REQUEST','Capital programme requires a JSON body');
  const reader=request.body.getReader(),bytes=new Uint8Array(limit);let size=0;
  try{
    while(true){let timer:ReturnType<typeof setTimeout>|undefined;
      const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          // Cancelling first can synchronously resolve read() with done=true,
          // racing the deadline into a misleading partial-JSON refusal.
          reject(new CapitalProgramV2Error('LIMIT_EXCEEDED','Whole capital programme transport deadline exhausted'));
          void reader.cancel().catch(()=>undefined);
        },executionDeadlineMilliseconds()??m3Remaining());
      })]).finally(()=>{if(timer)clearTimeout(timer);});
      if(chunk.done)break;if(chunk.value.length>limit-size){await reader.cancel();throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Capital programme request exceeds 64 KiB');}
      bytes.set(chunk.value,size);size+=chunk.value.length;
    }
    m3CheckTime();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));
  }catch(error){if(error instanceof CapitalProgramV2Error)throw error;throw new CapitalProgramV2Error('INVALID_REQUEST','Capital programme body must be valid JSON');}
  finally{reader.releaseLock();}
}
