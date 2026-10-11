import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {ControlQuotient,ControlQuotientReceipt} from '@finnor/shared-types';
import {controlBytesDigest,R1_LIMITS,type ExactControlBudget} from './exact';
const path=fileURLToPath(new URL('./checker.py',import.meta.url));
const loaded=readFile(path).then(controlBytesDigest);
/** The checker process is isolated from producer modules and bounded by the
 * original deadline. It cannot append, reserve, settle or admit its result. */
export async function checkControlQuotient(modelBytes:string,candidate:ControlQuotient,budget:ExactControlBudget & {onProcess?:(pid:number)=>void|Promise<void>}):Promise<ControlQuotientReceipt>{
 const checkerDigest=await loaded,candidateBytes=JSON.stringify(candidate),started=performance.now();
 const refusal=(predicate:string):ControlQuotientReceipt=>({schema:'finnor.r1.independent-check.v1',checkerVersion:'r1-python-fraction-v1',status:'UNKNOWN',predicate,modelDigest:controlBytesDigest(modelBytes),candidateDigest:controlBytesDigest(candidateBytes),checkerDigest,profile:'finite-information-rational-v1',relationComplete:false,probabilityLawQualified:false,causalQualification:'UNQUALIFIED',executionAuthorityGranted:false,steps:0,pythonVersion:'UNAVAILABLE',elapsedMs:performance.now()-started,transportElapsedMs:performance.now()-started,physical:null});
 if(Buffer.byteLength(modelBytes)>R1_LIMITS.inputBytes||Buffer.byteLength(candidateBytes)>6*1024*1024||!Number.isSafeInteger(budget.maxSteps)||budget.maxSteps<1||budget.maxSteps>R1_LIMITS.steps)return refusal('CHECKER_INPUT_OR_ORIGINAL_BOUND');
 if(Date.now()>=budget.deadlineAt)return refusal('ORIGINAL_R1_DEADLINE');
 if(controlBytesDigest(await readFile(path))!==checkerDigest)return refusal('LOADED_CHECKER_SOURCE_CHANGED');
 const input=JSON.stringify({modelBytes,candidate,candidateBytes,maxSteps:budget.maxSteps,deadlineAt:Math.floor(budget.deadlineAt)});
 return new Promise(resolve=>{
  const child=spawn(process.env.FINNOR_R1_PYTHON??'/usr/bin/python3',['-I',path],{env:{NODE_ENV:process.env.NODE_ENV,PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
  let output=Buffer.alloc(0),failure:string|null=null;
  const kill=(predicate:string)=>{failure??=predicate;child.kill('SIGKILL');};
  const timer=setTimeout(()=>kill('CHECKER_ORIGINAL_DEADLINE'),Math.max(1,budget.deadlineAt-Date.now()));
  const abort=()=>kill('CHECKER_CANCELLED');budget.signal?.addEventListener('abort',abort,{once:true});
  if(budget.signal?.aborted)abort();
  child.stdout.on('data',(b:Buffer)=>{if(output.length+b.length>65536)kill('CHECKER_OUTPUT_BYTE_BOUND');else output=Buffer.concat([output,b]);});
  child.stderr.on('data',()=>undefined);
  child.on('error',()=>{failure??='CHECKER_EXECUTABLE_UNAVAILABLE';});
  child.stdin.on('error',()=>{failure??='CHECKER_INPUT_TRANSPORT_FAILED';});
  child.on('close',(code,signal)=>{
   clearTimeout(timer);budget.signal?.removeEventListener('abort',abort);
   if(failure||code!==0){resolve(refusal(failure??(signal?'CHECKER_PROCESS_TERMINATED':'CHECKER_PROCESS_FAILURE')));return;}
   try{const r:ControlQuotientReceipt=JSON.parse(output.toString('utf8'));
    if(r.schema!=='finnor.r1.independent-check.v1'||r.checkerVersion!=='r1-python-fraction-v1'||r.modelDigest!==controlBytesDigest(modelBytes)||r.candidateDigest!==controlBytesDigest(candidateBytes)||r.checkerDigest!==checkerDigest||r.executionAuthorityGranted!==false||r.probabilityLawQualified!==false||r.causalQualification!=='UNQUALIFIED'||r.relationComplete!==(r.status==='COMPLETE'))throw Error('CHECKER_RECEIPT_BINDING');
    if(!r.physical||r.physical.pid!==child.pid||r.physical.parentPid!==process.pid||!/^[a-f0-9]{64}$/.test(r.physical.executableDigest)||r.physical.aggregateSimultaneousPeakKnown!==false||r.physical.usd!==null)throw Error('CHECKER_PHYSICAL_BINDING');
    resolve({...r,transportElapsedMs:performance.now()-started});
   }catch{resolve(refusal('CHECKER_RECEIPT_BINDING'));}
  });
  // The durable owner records SUBMITTED before releasing original input bytes.
  Promise.resolve(child.pid?budget.onProcess?.(child.pid):undefined).then(()=>{if(!failure)child.stdin.end(input);},()=>kill('CHECKER_DURABLE_SUBMISSION_FENCED'));
 });
}
