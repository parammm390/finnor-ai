import {z} from 'zod';
import {sha,fail,X5_LIMITS,PolicySchema} from './contracts';
import {trainController,loadController} from './controller';

const started=performance.now(),cpu=process.cpuUsage();
process.once('message',(input:unknown)=>{
 let result:unknown;
 try{
  if(Buffer.byteLength(JSON.stringify(input))>X5_LIMITS.ipcBytes)fail('X5_CHILD_INPUT_BOUND');
  const header=z.object({operation:z.enum(['TRAIN','INFER']),deadline:z.number().int().positive()}).passthrough().parse(input);
  if(header.deadline<=Date.now())fail('X5_ORIGINAL_DEADLINE_EXPIRED');
  if(header.operation==='TRAIN'){
   const request=z.object({operation:z.literal('TRAIN'),deadline:z.number(),samples:z.unknown()}).strict().parse(input);
   result=trainController(request.samples,Math.min(request.deadline,Date.now()+X5_LIMITS.childWallMs));
  }else{
   const request=z.object({operation:z.literal('INFER'),deadline:z.number(),checkpoint:z.unknown(),expectedDigest:z.string(),policy:PolicySchema,policyDigest:z.string(),features:z.unknown()}).strict().parse(input);
   if(sha(request.policy)!==request.policyDigest)fail('X5_PROCEDURE_SUBSTITUTION');
   result={...loadController(request.checkpoint,request.expectedDigest).infer(request.features),loadedPolicyDigest:sha(request.policy)};
  }
  const usage=process.resourceUsage(),elapsed=process.cpuUsage(cpu);
  const output={ok:true,result,resources:{pid:process.pid,wallMs:performance.now()-started,cpuMicros:elapsed.user+elapsed.system,peakProcessRSSBytes:usage.maxRSS*1024,node:process.version,platform:process.platform,architecture:process.arch,heapLimitMiB:256,aggregatePeakMemory:null}};
  if(Buffer.byteLength(JSON.stringify(output))>X5_LIMITS.ipcBytes)fail('X5_CHILD_RESULT_BOUND');
  process.send?.(output,()=>process.exit(0));
 }catch(error){
  process.send?.({ok:false,error:error instanceof Error?error.message:'X5_CHILD_FAILURE',resources:{pid:process.pid,wallMs:performance.now()-started,unknownCostPossible:true}},()=>process.exit(1));
 }
});
