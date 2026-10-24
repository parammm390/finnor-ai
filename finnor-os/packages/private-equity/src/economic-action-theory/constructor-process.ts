import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { PROFILE, fail, type EconomicProblem, type ConstructionResult } from './contracts';
import { assetRoot } from './process';

/** Preserve the original episode deadline while allowing physical lease heartbeats. */
export async function constructEconomicTheoryAsync(problem:EconomicProblem, deadlineAt:number,
 signal?:AbortSignal):Promise<ConstructionResult> {
 const request=JSON.stringify(problem);
 if(Buffer.byteLength(request)>PROFILE.maxRequestBytes)fail('Y1_CONSTRUCTOR_INPUT_BOUND');
 const timeout=Math.min(PROFILE.maxCheckerWallMs,deadlineAt-Date.now());
 if(timeout<=0)fail('Y1_ORIGINAL_DEADLINE_EXPIRED');
 if(signal?.aborted)fail('Y1_CONSTRUCTOR_ABORTED');
 return new Promise((resolve,reject)=>{
  const worker=new Worker(join(assetRoot(),'constructor-thread.mjs'),{
   workerData:{request,deadlineAt:Date.now()+timeout,maxOutputBytes:PROFILE.maxArtifactBytes},
   execArgv:[],env:{NODE_ENV:'production'},
   resourceLimits:{maxOldGenerationSizeMb:PROFILE.maxCheckerMemoryBytes/(1024*1024)},
  });
  let finished=false;
  const finish=(error:Error|null,result?:ConstructionResult)=>{
   if(finished)return;finished=true;
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   void worker.terminate();
   if(error)reject(error);else resolve(result!);
  };
  const abort=()=>finish(new Error('Y1_CONSTRUCTOR_ABORTED'));
  const timer=setTimeout(()=>finish(new Error('Y1_CONSTRUCTOR_TIMEOUT')),timeout);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  worker.once('error',error=>finish(error));
  worker.once('exit',()=>{if(!finished)finish(new Error('Y1_CONSTRUCTOR_PROCESS_FAILED'));});
  worker.once('message',(output:unknown)=>{
   if(typeof output!=='string'||Buffer.byteLength(output)>PROFILE.maxArtifactBytes)
    return finish(new Error('Y1_CONSTRUCTOR_OUTPUT_BOUND'));
   try{finish(null,JSON.parse(output) as ConstructionResult);}catch{finish(new Error('Y1_CONSTRUCTOR_REPLY_MALFORMED'));}
  });
 });
}
