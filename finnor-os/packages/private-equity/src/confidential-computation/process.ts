import {spawn} from 'node:child_process';
import {readFile,realpath,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {canonical,sha,fail} from './contracts';

const assets=process.env.FINNOR_Y4_ASSETS??'';
const names=['profile.json','backend-identity.json','compiler.py','correspondence.py','secure_runtime.py',
 'participant.py','backend.py','public_driver.py','contracts.ts','artifact.ts','process.ts','store.ts','service.ts','worker.ts','consumer.ts','owner-consumer.ts','api.ts','operational-query.ts','plan.ts',
 '../enterprise-control.ts','../enterprise-allocation.ts','../allocation-store.ts','../enterprise-obligations.ts','admission.ts','../bounded-reference.ts',
 '../../../capability-evolution/src/confidential-port.ts','../../../capability-evolution/src/confidential-consumer.ts',
 '../../../capability-evolution/src/lifecycle.ts','../../../capability-evolution/src/source-closure.ts',
 '../../../capability-evolution/src/consumer-transport.ts','../../../db/migrations/postx_y4_confidential_owner_consumption.sql',
 '../../../db/migrations/postx_y4_runtime_owner_integrity.sql',
 '../../../db/migrations/postx_y4_runtime_recipient_recovery.sql','../../../db/migration-head.ts',
 '../../../../apps/worker/src/queue.ts'];
async function identity(){
 if(!isAbsolute(assets))fail('Y4_ABSOLUTE_INSTALLED_ASSET_DIRECTORY_REQUIRED');
 const files=await Promise.all(names.map(async name=>({name,sha256:createHash('sha256').update(await readFile(join(assets,name))).digest('hex')})));
 return {schema:'finnor.y4.installed-source-cut.v1',files,node:process.version,platform:process.platform,
  arch:process.arch,backend:JSON.parse(await readFile(join(assets,'backend-identity.json'),'utf8')),
  profile:JSON.parse(await readFile(join(assets,'profile.json'),'utf8'))};
}
let loaded:ReturnType<typeof identity>|undefined;
export async function currentEnvironment(){
 loaded??=identity();
 const pinned=await loaded,current=await identity();
 if(sha(pinned)!==sha(current))fail('Y4_LOADED_SOURCE_CLOSURE_CHANGED');
 return current;
}
export async function runPublicChild(request:Record<string,unknown>,deadlineAt:number,
 heartbeat:()=>Promise<boolean>=async()=>true):Promise<Record<string,any>>{
 const binary=process.env.FINNOR_Y4_PYTHON??'/usr/bin/python3';
 if(!isAbsolute(binary)||deadlineAt<=Date.now())fail('Y4_ORIGINAL_DEADLINE_EXPIRED');
 await realpath(binary);
 const input=canonical(request);
 if(Buffer.byteLength(input)>1048576)fail('Y4_PUBLIC_CHILD_REQUEST_BOUND');
 const child=spawn(binary,['-B',join(assets,'public_driver.py')],{
  env:{NODE_ENV:process.env.NODE_ENV??'test',PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',
   FINNOR_Y4_SUPERVISOR_PID:String(process.pid)},stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32',
 });
 let output='',bytes=0,settled=false,ticking=false,failed:string|null=null,
  killTimer:ReturnType<typeof setTimeout>|undefined;
 const stop=(code:string)=>{
  if(failed)return;failed=code;
  // Python's signal handler stops every participant, whose handler stops its
  // separate native process group. Do not kill only the queue's caller.
  child.kill('SIGTERM');
  killTimer=setTimeout(()=>{if(!settled)child.kill('SIGKILL');},7000);
 };
 const deadline=setTimeout(()=>stop('Y4_ORIGINAL_DEADLINE_EXPIRED'),Math.max(1,deadlineAt-Date.now()));
 const timer=setInterval(async()=>{
  if(ticking||settled)return;ticking=true;
  try{if(!await heartbeat())stop('Y4_AUTHORITY_OR_PHYSICAL_FENCE_LOST');}
  catch{stop('Y4_CURRENTNESS_UNAVAILABLE');}finally{ticking=false;}
 },500);
 const result=new Promise<Record<string,any>>((resolve,reject)=>{
  child.stdout.on('data',(chunk:Buffer)=>{
   bytes+=chunk.length;if(bytes>4*1024*1024){stop('Y4_PUBLIC_CHILD_OUTPUT_BOUND');return;}
   output+=chunk.toString('utf8');
  });
  child.on('error',()=>{settled=true;reject(Error('Y4_CHILD_START_FAILED'));});
  child.on('close',(code,signal)=>{
   settled=true;
   if(failed||code!==0||signal){
    let predicate='Y4_PUBLIC_OR_NATIVE_PREMISE_UNPASSED';
    try{const refused=JSON.parse(output);
     if(refused.status==='REFUSED'&&/^[A-Z][A-Z0-9_]{1,120}$/.test(refused.predicate))
      predicate='Y4_BRIDGE_'+refused.predicate;
    }catch{/* Never forward paths, values, traceback or arbitrary child text. */}
    reject(Error(failed??predicate));return;
   }
   try{resolve(JSON.parse(output) as Record<string,any>);}catch{reject(Error('Y4_PUBLIC_RECEIPT_DECODE_FAILED'));}
  });
 });
 child.stdin.on('error',()=>stop('Y4_PUBLIC_CHILD_INPUT_CLOSED'));
 child.stdin.end(input);
 try{return await result;}finally{clearInterval(timer);if(killTimer)clearTimeout(killTimer);clearTimeout(deadline);}
}
export async function runtimeConfiguration(tenantId:string,participants:Array<{id:string;institutionId:string}>){
 const backend=process.env.FINNOR_Y4_BACKEND,configuration=process.env.FINNOR_Y4_PARTICIPANT_REGISTRY,
  scratch=process.env.FINNOR_Y4_SCRATCH;
 if(!backend||!configuration||!scratch||![backend,configuration,scratch].every(isAbsolute))
  fail('Y4_PARTICIPANT_LOCAL_RUNTIME_NOT_INSTALLED');
 const registry=JSON.parse(await readFile(configuration,'utf8')) as Array<{
  tenantId:string;institutionId:string;participantId:string;principalId:string;authorityPath:string;stateDirectory:string}>;
 const agents=participants.map(p=>{
  const matches=registry.filter(a=>a.tenantId===tenantId&&a.institutionId===p.institutionId&&a.participantId===p.id);
  if(matches.length!==1||![matches[0]!.stateDirectory,matches[0]!.authorityPath].every(isAbsolute))
   fail('Y4_EXACT_PARTICIPANT_INSTALLATION_REQUIRED');
  return matches[0]!;
 });
 await mkdir(scratch,{recursive:true,mode:0o700});
 return {backend,agents,scratch};
}
