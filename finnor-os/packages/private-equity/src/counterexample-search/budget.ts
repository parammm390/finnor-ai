import { AsyncLocalStorage } from 'node:async_hooks';
import { withDatabaseExecutionDeadline, DatabaseExecutionDeadlineError } from '@finnor/db';
import { ChallengeError } from './contracts';
const episodes=new AsyncLocalStorage<{deadline:number;signal?:AbortSignal}>();
export function remainingMs():number{
  const e=episodes.getStore();if(e?.signal?.aborted)throw new ChallengeError('CANCELLED','Challenge cancellation or capacity fence observed');
  const left=(e?.deadline??performance.now()+30000)-performance.now();
  if(left<=0)throw new ChallengeError('LIMIT_EXCEEDED','Parent challenge deadline exhausted');
  return Math.max(1,Math.floor(left));
}
export function checkBudget():void{remainingMs();}
export async function inChallengeEpisode<T>(ms:number,invoke:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const parent=episodes.getStore(),deadline=Math.min(parent?.deadline??Infinity,performance.now()+Math.min(ms,30000));
  return episodes.run({deadline,signal:signal??parent?.signal},()=>withDatabaseExecutionDeadline(deadline,async()=>{
    try{const value=await invoke();checkBudget();return value;}
    catch(e){if(e instanceof DatabaseExecutionDeadlineError)throw new ChallengeError('LIMIT_EXCEEDED','Parent challenge database deadline exhausted');throw e;}
  }));
}
export function transportDeadline(req:Request):number{
  const s=req.headers.get('x-challenge-deadline-ms');if(s===null)return 30000;
  if(!/^\d+$/.test(s)||!Number.isSafeInteger(Number(s))||Number(s)<1||Number(s)>30000)
    throw new ChallengeError('INVALID_REQUEST','Invalid challenge transport deadline');
  return Number(s);
}
export async function readChallengeBody(request:Request):Promise<unknown>{
  const limit=65536;
  if(Number(request.headers.get('content-length'))>limit){
    void request.body?.cancel().catch(()=>undefined);
    throw new ChallengeError('LIMIT_EXCEEDED','Challenge request exceeds 64 KiB');
  }
  if(!request.body)throw new ChallengeError('INVALID_REQUEST','Challenge requires a JSON body');
  const reader=request.body.getReader(),bytes=new Uint8Array(limit);let size=0;
  try{
    while(true){
      let timer:ReturnType<typeof setTimeout>|undefined;
      const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          reject(new ChallengeError('LIMIT_EXCEEDED','Whole challenge transport deadline exhausted'));
          void reader.cancel().catch(()=>undefined);
        },remainingMs());
      })]).finally(()=>{if(timer)clearTimeout(timer);});
      checkBudget();
      if(chunk.done)break;
      if(chunk.value.length>limit-size){
        void reader.cancel().catch(()=>undefined);
        throw new ChallengeError('LIMIT_EXCEEDED','Challenge request exceeds 64 KiB');
      }
      bytes.set(chunk.value,size);size+=chunk.value.length;
    }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));
  }catch(error){
    if(error instanceof ChallengeError)throw error;
    throw new ChallengeError('INVALID_REQUEST','Challenge body must be valid JSON');
  }finally{reader.releaseLock();}
}
