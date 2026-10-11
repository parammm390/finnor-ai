import { compilePolicyAtlas } from '../../../epistemic-runtime/src/policy-atlas/compiler';
import { evaluateFiniteFamily } from '../../../epistemic-runtime/src/policy-atlas/query';
import { AtlasError } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { Worker } from 'node:worker_threads';
const parent=Number(process.env.FINNOR_R7_PARENT_PID),deadlineAt=Number(process.env.FINNOR_R7_CHILD_DEADLINE_AT);
if(!Number.isSafeInteger(parent)||parent<=1||!Number.isSafeInteger(deadlineAt)||deadlineAt<=Date.now())
  process.exit(73);
const watchdog=new Worker(new URL('./child-watchdog.mjs',import.meta.url),{workerData:{parentPid:parent,deadlineAt}});
const started=performance.now();
let bytes=0;const input:Buffer[]=[];
try{
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>33554432)throw new AtlasError('INPUT_BYTE_LIMIT');input.push(chunk);}
  const frame=JSON.parse(Buffer.concat(input).toString('utf8'));
  if(frame.mode==='FULL_FAMILY_BATCH'&&(!Array.isArray(frame.points)||frame.points.length<1||frame.points.length>128))
    throw new AtlasError('FULL_FAMILY_BATCH_BOUND');
  const data=frame.mode==='BUILD'?compilePolicyAtlas(frame.source,frame.checkerDigest,frame.budget):
    frame.mode==='FULL_FAMILY'?evaluateFiniteFamily(frame.source,frame.values,frame.feasiblePolicyIds?new Set(frame.feasiblePolicyIds):null):
    frame.mode==='FULL_FAMILY_BATCH'?frame.points.map((p:{values:string[];feasiblePolicyIds:string[]|null})=>
      evaluateFiniteFamily(frame.source,p.values,p.feasiblePolicyIds?new Set(p.feasiblePolicyIds):null)):null;
  if(!data)throw new AtlasError('UNSUPPORTED_CHILD_MODE');
  const usage=process.resourceUsage();
  process.stdout.write(JSON.stringify({ok:true,data,usage:{wallMs:performance.now()-started,
    cpuMicros:usage.userCPUTime+usage.systemCPUTime,peakRSSBytes:usage.maxRSS*1024}}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,predicate:error instanceof AtlasError?error.code:'CHILD_PROTOCOL_OR_MODEL_FAILURE'}));}
finally{await watchdog.terminate();}
