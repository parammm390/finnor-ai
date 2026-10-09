import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {controlBytesDigest} from '@finnor/epistemic-runtime';
export async function executeR1Native(input:{stage:'PRODUCE'|'S4_EVALUATE'|'ORIGINAL_FALLBACK';modelBytes:string;deadlineAt:number;maxSteps:number;reuse?:unknown},signal:AbortSignal,onProcess:(pid:number)=>Promise<void>):Promise<any>{
 if(Date.now()>=input.deadlineAt||signal.aborted)throw Error('R1_ORIGINAL_NATIVE_DEADLINE_OR_CANCELLED');
 const nonce=randomUUID(),child=spawn(process.execPath,['--max-old-space-size=256','--import','tsx',fileURLToPath(new URL('./native-child.mts',import.meta.url))],{env:{NODE_ENV:process.env.NODE_ENV,PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
 return new Promise((resolve,reject)=>{
  let output=Buffer.alloc(0),failure:string|null=null;const kill=(why:string)=>{failure??=why;child.kill('SIGKILL');};
  const timer=setTimeout(()=>kill('R1_ORIGINAL_NATIVE_DEADLINE'),Math.max(1,input.deadlineAt-Date.now()));
  const abort=()=>kill('R1_NATIVE_CANCELLED_OR_FENCED');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  child.stdout.on('data',(b:Buffer)=>{if(output.length+b.length>8*1024*1024)kill('R1_NATIVE_OUTPUT_BOUND');else output=Buffer.concat([output,b]);});
  child.stderr.on('data',()=>undefined);child.stdin.on('error',()=>{failure??='R1_NATIVE_INPUT_TRANSPORT_FAILED';});child.on('error',()=>{failure??='R1_NATIVE_EXECUTABLE_UNAVAILABLE';});
  child.on('close',(code)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(failure||code!==0){reject(Error(failure??'R1_NATIVE_PROCESS_TERMINATED'));return;}
   try{const r=JSON.parse(output.toString('utf8'));if(r.schema!=='finnor.r1.native-return.v1'||r.nonce!==nonce||r.stage!==input.stage||r.modelDigest!==controlBytesDigest(input.modelBytes)||r.pid!==child.pid)throw Error('R1_NATIVE_RETURN_BINDING');resolve(r);}catch{reject(Error('R1_NATIVE_RETURN_BINDING'));}
  });
  if(!child.pid){kill('R1_NATIVE_PID_REQUIRED');return;}
  onProcess(child.pid).then(()=>{if(!failure)child.stdin.end(JSON.stringify({...input,nonce}));},()=>kill('R1_NATIVE_DURABLE_SUBMISSION_FENCED'));
 });
}
