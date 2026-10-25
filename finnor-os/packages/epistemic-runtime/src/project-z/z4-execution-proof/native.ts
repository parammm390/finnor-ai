import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {BACKEND,PROFILE,canonical,digestSchema,fail,sha} from './contracts';
import {observeProcessGroup,type OwnedProcessGroup,type ProcessGroupNotice} from './process-groups';
import {runtimePath} from './runtime-paths';

const nativeDirectory=runtimePath(import.meta.url,'../../../native/z4-execution-proof',
 'finnor-os/packages/epistemic-runtime/native/z4-execution-proof');
const identitySchema=z.object({
 schema:z.literal('finnor.z4.native-build.v1'),profile:z.literal(PROFILE),backend:z.literal(BACKEND),
 binarySha256:digestSchema,binaryBytes:z.number().int().positive(),
 sourceFiles:z.array(z.object({path:z.string(),sha256:digestSchema}).strict()).min(5).max(128),
 sourceDigest:digestSchema,cargoLockSha256:digestSchema,rustc:z.string(),target:z.literal('x86_64-unknown-linux-gnu'),
 diagnosticBinarySha256:digestSchema,
}).strict();
async function bytes(path:string,max:number):Promise<Buffer>{
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();if(!s.isFile()||s.size>max)fail('Z4_INSTALLED_ASSET_BOUND');return await f.readFile();}
 finally{await f.close();}
}
const hashBytes=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
// Keep the ordinary worker lifecycle independent of the replay IPC controller.
// runpy preserves the supervisor's implementation, limits and child meters.
const parentBoundPython=`
import ctypes,json,os,runpy,signal,subprocess,sys
libc=ctypes.CDLL(None,use_errno=True)
def bind_parent(expected):
    if libc.prctl(1,signal.SIGKILL,0,0,0)!=0:
        raise RuntimeError("parent guard unavailable")
    if os.getppid()!=expected:
        os.kill(os.getpid(),signal.SIGKILL)
try:
    bind_parent(int(sys.argv[1]))
except Exception:
    print(json.dumps({"ok":False,"code":"Z4_PARENT_LIFECYCLE_GUARD_FAILED","native":None,"meters":None}))
    sys.exit(1)
class ParentBoundPopen(subprocess.Popen):
    def __init__(self,*args,**kwargs):
        previous=kwargs.get("preexec_fn")
        parent=os.getpid()
        def start():
            bind_parent(parent)
            if previous:
                previous()
        kwargs["preexec_fn"]=start
        super().__init__(*args,**kwargs)
subprocess.Popen=ParentBoundPopen
sys.argv=sys.argv[2:]
runpy.run_path(sys.argv[0],run_name="__main__")
`;
export async function nativeIdentity(){
 const base=await realpath(nativeDirectory);
 if(base!==nativeDirectory)fail('Z4_NATIVE_ASSET_SYMLINK');
 const i=identitySchema.parse(JSON.parse((await bytes(resolve(base,'build-identity.json'),65536)).toString('utf8')));
 const binary=await bytes(resolve(base,'bin/z4-proof'),64*1024*1024);
 if(binary.length!==i.binaryBytes||hashBytes(binary)!==i.binarySha256)fail('Z4_INSTALLED_BINARY_CHANGED');
 if(hashBytes(await bytes(resolve(base,'bin/z4-field-falsifier'),64*1024*1024))!==i.diagnosticBinarySha256)fail('Z4_DIAGNOSTIC_BINARY_CHANGED');
 const seen=new Set<string>();
 for(const item of i.sourceFiles){
  if(!/^(?:src\/[a-z_-]+\.rs|Cargo\.(?:toml|lock)|rust-toolchain\.toml|supervise\.py)$/.test(item.path)||seen.has(item.path))fail('Z4_NATIVE_SOURCE_SET');
  seen.add(item.path);
  if(hashBytes(await bytes(resolve(base,item.path),4*1024*1024))!==item.sha256)fail('Z4_NATIVE_SOURCE_CHANGED');
 }
 for(const p of ['Cargo.toml','Cargo.lock','rust-toolchain.toml','supervise.py','src/main.rs','src/model.rs','src/plan.rs','src/proof.rs','src/field_falsifier.rs'])
  if(!seen.has(p))fail('Z4_NATIVE_SOURCE_SET');
 if(sha(i.sourceFiles)!==i.sourceDigest||hashBytes(await bytes(resolve(base,'Cargo.lock'),1024*1024))!==i.cargoLockSha256)fail('Z4_NATIVE_SOURCE_IDENTITY');
 return i;
}
export interface NativeMeters {exitCode:number|null;timedOut:boolean;wallMs:number;cpuMicros:number;peakRSSBytes:number;inputBytes:number;outputBytes:number;stderrBytes:number;usd:null;aggregateProcessRSS:null;humanSeconds:null}
export interface NativeReceipt<T=unknown>{data:T;meters:NativeMeters;binarySha256:string;sourceDigest:string;operation:string}
export class NativeFailure extends Error {
 constructor(code:string,readonly meters:NativeMeters|null,
  readonly physical?:{pid:number|null;exitCode:number|null;signal:NodeJS.Signals|null}){super(code);}
}
export async function runNative<T=unknown>(operation:'identity'|'plan'|'commit'|'interpret'|'prove'|'verify',input:unknown,
 limits:{deadlineAt:string;maxMemoryBytes:number;current?:()=>Promise<boolean>;signal?:AbortSignal;
 cpuSeconds?:number|((operation:string)=>number);charge?:(operation:string,cpuSeconds:number)=>Promise<void>;
 capacity?:(operation:string)=>Promise<()=>Promise<void>>;
 processGroup?:(notice:ProcessGroupNotice)=>Promise<void>;
 observed?:(receipt:NativeReceipt|{operation:string;failure:string;meters:NativeMeters|null})=>Promise<void>}):Promise<NativeReceipt<T>>{
 const remaining=Date.parse(limits.deadlineAt)-Date.now();
 if(!Number.isFinite(remaining)||remaining<=0)fail('Z4_ORIGINAL_DEADLINE_EXHAUSTED');
 if(!Number.isSafeInteger(limits.maxMemoryBytes)||limits.maxMemoryBytes<128*1024*1024||limits.maxMemoryBytes>2*1024*1024*1024)fail('Z4_PROCESS_MEMORY_BOUND');
 if(limits.signal?.aborted||limits.current&&!await limits.current())fail('Z4_JOB_OR_REQUEST_FENCED');
 const identity=await nativeIdentity(),payload=Buffer.from(canonical(input));
 if(payload.length>8*1024*1024)fail('Z4_PROCESS_INPUT_BOUND');
 const cpuSeconds=(typeof limits.cpuSeconds==='function'?limits.cpuSeconds(operation):limits.cpuSeconds)??Math.min(900,Math.ceil(remaining/1000));
 if(!Number.isSafeInteger(cpuSeconds)||cpuSeconds<1||cpuSeconds>900)fail('Z4_PROCESS_CPU_BOUND');
 await limits.charge?.(operation,cpuSeconds);
 const releaseCapacity=await limits.capacity?.(operation);
 try{
 if(limits.signal?.aborted||limits.current&&!await limits.current())fail('Z4_JOB_OR_REQUEST_FENCED');
 const timeout=Math.min(900000,Date.parse(limits.deadlineAt)-Date.now()),script=resolve(nativeDirectory,'supervise.py');
 if(timeout<=0)fail('Z4_ORIGINAL_DEADLINE_EXHAUSTED');
 const receipt=await new Promise<NativeReceipt<T>>((done,reject)=>{
  const child=spawn('/usr/bin/python3',['-c',parentBoundPython,String(process.pid),script,operation,
   String(Math.floor(timeout)),String(limits.maxMemoryBytes),String(cpuSeconds)],{
   cwd:nativeDirectory,env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1',NODE_ENV:'production'},stdio:['pipe','pipe','pipe'],detached:true,
  });
  const output:Buffer[]=[];let size=0,errSize=0,stopped:string|null=null,checking=false,killTimer:ReturnType<typeof setTimeout>|undefined;
  const stop=(code:string)=>{
   if(stopped)return;stopped=code;
   try{process.kill(-child.pid!,'SIGTERM');}catch{}
   killTimer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},1000);killTimer.unref();
  };
  const abort=()=>stop('Z4_PROCESS_CANCELLED');limits.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop('Z4_PROCESS_TIMEOUT'),timeout+2000);timer.unref();
  const heartbeat=limits.current?setInterval(()=>{
   if(checking)return;checking=true;
   void limits.current!().then(ok=>{if(!ok)stop('Z4_JOB_OR_REQUEST_FENCED');},()=>stop('Z4_JOB_OR_REQUEST_FENCED')).finally(()=>{checking=false;});
  },500):undefined;
  heartbeat?.unref();
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>12*1024*1024)stop('Z4_PROCESS_OUTPUT_BOUND');else output.push(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>{errSize+=chunk.length;if(errSize>65536)stop('Z4_PROCESS_OUTPUT_BOUND');});
  let group:OwnedProcessGroup|undefined;
  child.stdin.on('error',()=>{});
  child.once('spawn',()=>{
   void(async()=>{
    if(limits.processGroup){
     group=observeProcessGroup(child.pid!,process.pid);
     await limits.processGroup({stage:'START',group});
    }
    if(stopped)child.stdin.destroy();else child.stdin.end(payload);
   })().catch(()=>stop('Z4_PROCESS_OBSERVATION_FAILED'));
  });
  child.once('error',()=>{stop('Z4_NATIVE_LAUNCH_FAILED');});
  child.once('close',(code,signal)=>{void(async()=>{
   clearTimeout(timer);if(killTimer)clearTimeout(killTimer);if(heartbeat)clearInterval(heartbeat);
   limits.signal?.removeEventListener('abort',abort);
   try{
    if(group)await limits.processGroup?.({stage:'CLOSE',group});
    const physical={pid:child.pid??null,exitCode:code,signal};
    if(stopped)throw new NativeFailure(stopped,null,physical);
    const body=JSON.parse(Buffer.concat(output).toString('utf8')) as {ok:boolean;code:string;native:{ok:boolean;body:T}|null;meters:NativeMeters|null};
    if(code!==0||body.ok!==true||body.native?.ok!==true||!body.meters)
     throw new NativeFailure(/^Z4_[A-Z0-9_]{1,156}$/.test(body.code)?body.code:'Z4_NATIVE_FAILED',body.meters,physical);
    done({data:body.native.body,meters:body.meters,binarySha256:identity.binarySha256,sourceDigest:identity.sourceDigest,operation});
   }catch(e){reject(e instanceof NativeFailure?e:new NativeFailure('Z4_NATIVE_PROTOCOL_FAILED',null));}
  })();});
 }).catch(async(error:unknown)=>{
  await limits.observed?.({operation,failure:error instanceof NativeFailure?error.message:'Z4_NATIVE_FAILED',meters:error instanceof NativeFailure?error.meters:null});
  throw error;
 });
 await limits.observed?.(receipt);
 return receipt;
 }finally{await releaseCapacity?.();}
}
