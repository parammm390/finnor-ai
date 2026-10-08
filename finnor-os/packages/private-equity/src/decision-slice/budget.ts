import { AsyncLocalStorage } from 'node:async_hooks';
import { DecisionSliceError } from './contracts';
import { DatabaseExecutionDeadlineError, withDatabaseExecutionDeadline, executionDeadlineMilliseconds } from '@finnor/db';
const episode=new AsyncLocalStorage<{deadline:number;startedAt:number}>();
export function episodeDeadline(fallback=30000):number{return episode.getStore()?.deadline??performance.now()+fallback;}
export function checkEpisode():void{
  const deadline=episode.getStore()?.deadline;
  if(deadline!==undefined&&performance.now()>=deadline)throw new DecisionSliceError('LIMIT_EXCEEDED','Whole M1 request deadline exhausted');
}
/** Native work can reserve cleanup time only inside the existing owner grant.
 * Exiting this scope restores the original deadline, never a renewed window. */
export async function withinM1Deadline<T>(deadline:number,invoke:()=>Promise<T>):Promise<T>{
  const current=episode.getStore();
  if(!current||!Number.isFinite(deadline)||deadline>current.deadline)
    throw new DecisionSliceError('LIMIT_EXCEEDED','Native subdeadline cannot extend the original M1 episode');
  checkEpisode();
  return episode.run({...current,deadline},()=>withDatabaseExecutionDeadline(deadline,async()=>{
    const result=await invoke();checkEpisode();return result;
  }));
}
export async function inM1Episode<T>(deadlineMs:number,invoke:()=>Promise<T>):Promise<T>{
  const current=episode.getStore();
  if(current)checkEpisode();
  const startedAt=current?.startedAt??performance.now(),deadline=Math.min(current?.deadline??Infinity,startedAt+deadlineMs);
  return episode.run({deadline,startedAt},()=>withDatabaseExecutionDeadline(deadline,async()=>{
    try{const result=await invoke();checkEpisode();return result;}
    catch(error){
      if(error instanceof DatabaseExecutionDeadlineError||performance.now()>=deadline)
        throw new DecisionSliceError('LIMIT_EXCEEDED','Whole M1 request deadline exhausted');
      throw error;
    }
  }));
}
/** The transport may attenuate but never extend the request's execution grant. */
export function m1TransportDeadline(request:Request):number{
  const header=request.headers.get('x-decision-slice-deadline-ms');
  if(header===null)return 30000;
  const value=Number(header);
  if(!/^\d+$/.test(header)||!Number.isSafeInteger(value)||value<1||value>30000)
    throw new DecisionSliceError('INVALID_REQUEST','Invalid decision request deadline');
  return value;
}
export async function readM1BodyChunk(reader:ReadableStreamDefaultReader<Uint8Array>):Promise<ReadableStreamReadResult<Uint8Array>>{
  const left=executionDeadlineMilliseconds();if(left===null)return reader.read();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{
        void reader.cancel(new DatabaseExecutionDeadlineError()).catch(()=>undefined);
        reject(new DecisionSliceError('LIMIT_EXCEEDED','Whole M1 request deadline exhausted'));
      },left);
    })]);
  }finally{if(timer)clearTimeout(timer);}
}
