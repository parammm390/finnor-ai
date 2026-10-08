import {DatabaseExecutionDeadlineError,executionDeadlineMilliseconds,withDatabaseExecutionDeadline} from '@finnor/db';

export class DeliberationDeadlineError extends Error {
 constructor(){super('M2_WHOLE_EXECUTION_DEADLINE_EXHAUSTED');}
}
/** Transport attenuation is a time limit, never a compute/funding grant. */
export function deliberationTransportDeadline(request:Request){
 const raw=request.headers.get('x-deliberation-deadline-ms');
 if(raw===null)return 30000;
 const value=Number(raw);
 if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<1||value>30000)
  throw Error('M2_INVALID_TRANSPORT_DEADLINE');
 return value;
}
export async function inDeliberationDeadline<T>(milliseconds:number,invoke:()=>Promise<T>):Promise<T>{
 const outer=executionDeadlineMilliseconds(),started=performance.now();
 const deadline=started+Math.min(milliseconds,outer??milliseconds);
 return withDatabaseExecutionDeadline(deadline,async()=>{
  try{
   const result=await invoke();
   executionDeadlineMilliseconds();
   if(performance.now()>=deadline)throw new DeliberationDeadlineError();
   return result;
  }catch(error){
   let expired=performance.now()>=deadline;
   try{executionDeadlineMilliseconds();}catch{expired=true;}
   if(expired||error instanceof DatabaseExecutionDeadlineError)throw new DeliberationDeadlineError();
   throw error;
  }
 });
}
