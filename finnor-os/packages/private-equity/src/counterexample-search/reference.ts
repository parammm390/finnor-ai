import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { remainingMs,checkBudget } from './budget';
import { ChallengeError,assertBounded } from './contracts';
const path=fileURLToPath(new URL('./reference.py',import.meta.url));
const loadedIdentity=readFile(path).then(bytes=>createHash('sha256').update(bytes).digest('hex'));
void loadedIdentity.catch(()=>undefined);
export interface ReferenceResult {status:'CHECKED'|'UNRESOLVED';checker?:string;observed?:unknown;trace?:unknown;
  reason?:string;feasible?:boolean;value?:string;witnesses?:Array<{constraintId:string;scenarioId:string;period:number;used:string;maximum:string;margin:string}>;
  optimum?:string|null;selected?:string[];reasons?:string[];invocation?:unknown}
/** Only this installed trusted script can run. No callback, code, argv or environment from the candidate. */
export async function independentReference(body:unknown,signal?:AbortSignal):Promise<ReferenceResult>{
  checkBudget();assertBounded(body,4194304);
  const python=process.env.FINNOR_M4_PYTHON;if(!python)return {status:'UNRESOLVED',reason:'REFERENCE_RUNTIME_UNAVAILABLE'};
  const scriptSha256=await loadedIdentity;
  if(createHash('sha256').update(await readFile(path)).digest('hex')!==scriptSha256)
    throw new ChallengeError('STALE_INPUT','Loaded independent checker changed');
  const executable=await realpath(python),deadline=Math.min(remainingMs(),10000),started=performance.now();
  const env=Object.fromEntries(['PATH','LANG','HOME','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]!])) as NodeJS.ProcessEnv;
  return new Promise<ReferenceResult>((yes,no)=>{
    // Next requires NODE_ENV for Node apps; this trusted Python child keeps its scrubbed dictionary.
    const child=spawn(executable,[path],{env,stdio:['pipe','pipe','pipe'],detached:true});
    let output='',stderr='',reason:string|null=null,settled=false;
    const kill=(why:string)=>{reason=why;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')no(e);}};
    const timer=setTimeout(()=>kill('REFERENCE_DEADLINE_EXHAUSTED'),deadline);
    const cancel=()=>kill('CANCELLED');signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    child.stdout.on('data',b=>{output+=b;if(Buffer.byteLength(output)>65536)kill('REFERENCE_OUTPUT_BOUND');});
    child.stderr.on('data',b=>{stderr+=b;if(Buffer.byteLength(stderr)>4096)kill('REFERENCE_STDERR_BOUND');});
    child.stdin.on('error',()=>undefined);
    child.on('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);settled=true;no(error);});
    child.on('close',(code,exitSignal)=>{
      clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(settled)return;settled=true;
      const invocation={scriptSha256,executable,wallMs:performance.now()-started,
        inputBytes:Buffer.byteLength(JSON.stringify(body)),outputBytes:Buffer.byteLength(output),exitCode:code,
        signal:exitSignal,childReaped:true,costUSD:null,aggregateMemoryCPU:'UNQUALIFIED'};
      if(reason||code!==0)return yes({status:'UNRESOLVED',reason:reason??'REFERENCE_PROCESS_FAILED',invocation});
      try{const parsed=JSON.parse(output) as ReferenceResult;
        if(!['CHECKED','UNRESOLVED'].includes(parsed.status))throw Error('Invalid checker status');
        yes({...parsed,invocation});
      }catch{no(new ChallengeError('CHECK_FAILED','Independent checker output is malformed'));}
    });
    child.stdin.end(JSON.stringify(body));
  });
}
