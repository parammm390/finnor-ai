import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const driver=fileURLToPath(import.meta.url);
const owner='finnor-os/packages/private-equity/src/uniform-algorithms/';
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(v:unknown):string=>{
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b))
  .map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';
 return JSON.stringify(v);
};
const save=async(path:string,body:unknown)=>fs.writeFile(path,JSON.stringify(body,null,2)+'\n');
const describe=(error:unknown)=>({name:(error as Error)?.name,message:String(error),
 code:(error as {code?:string})?.code,status:(error as {status?:number})?.status});
async function pool<T>(items:readonly T[],run:(item:T,index:number)=>Promise<void>){
 let cursor=0;await Promise.all(Array.from({length:16},async()=>{for(;;){
  const index=cursor++;if(index>=items.length)return;await run(items[index]!,index);
 }}));
}
async function child(phase:string,root:string,evidence:string){
 root=await fs.realpath(root);
 process.chdir(root);
 const {UNIFORM_SOURCE_PATHS:paths}=await import(pathToFileURL(join(root,owner,'source-paths.ts')).href);
 const actual=await import(pathToFileURL(join(root,owner,'source-cut.ts')).href);
 const emitted=(await import(pathToFileURL(join(root,owner,'source-manifest.generated.ts')).href)).default;
 const selected=new Set<string>(paths.map((p:string)=>join(root,p)));
 const originalRead=fs.readFile;let active=0,maximum=0,reads=0;
 const counts=new Map<string,number>(),steps:unknown[]=[];
 let gatePath:string|null=null,gateEntered:(()=>void)|null=null,releaseGate:(()=>void)|null=null;
 let firstCompleted=false;
 const first=join(root,paths[0]),middle=join(root,paths[Math.floor(paths.length/2)]),missing=join(root,paths[1]);
 fs.readFile=(async(...args:Parameters<typeof fs.readFile>)=>{
  const path=typeof args[0]==='string'?resolve(args[0]):'';
  if(!selected.has(path))return originalRead(...args);
  reads++;counts.set(path,(counts.get(path)??0)+1);active++;maximum=Math.max(maximum,active);
  try{
   if(path===gatePath){
    gatePath=null;assert(firstCompleted,'Earlier source must already have been read');
    const wait=new Promise<void>(yes=>{releaseGate=yes;});gateEntered?.();await wait;
   }
   const value=await originalRead(...args);if(path===first)firstCompleted=true;return value;
  }finally{active--;}
 }) as typeof fs.readFile;
 syncBuiltinESMExports();
 const reset=()=>{assert.equal(active,0);reads=0;maximum=0;counts.clear();firstCompleted=false;};
 const observation=()=>({reads,maximum,files:paths.length,allFilesReadExactlyOnce:
  counts.size===paths.length&&[...counts.values()].every(n=>n===1),
  perFileCounts:[...counts].map(([path,count])=>({path,count}))});
 const expectReject=async(promise:Promise<unknown>,code:string)=>{
  try{await promise;assert.fail('Expected '+code);}catch(error){assert.equal((error as {code?:string}).code,code);return describe(error);}
 };
 try{
  const initial=await actual.currentUniformEnvironment();steps.push({name:'initial_actual_boundary',...observation()});
  assert.equal(initial.files.length,paths.length);
  if(phase==='baseline')throw Error('BASELINE_DID_NOT_REPRODUCE_EMFILE');
  assert(maximum<=16,'Bounded source-read concurrency');
  assert(Object.isFrozen(initial)&&Object.isFrozen(initial.files)&&Object.isFrozen(initial.files[0]));
  assert.throws(()=>{initial.files[0].sha256='caller-mutation';});
  for(let i=0;i<2;i++){
   reset();await actual.currentUniformEnvironment();const found=observation();
   assert(found.allFilesReadExactlyOnce);assert(maximum<=16);steps.push({name:'sequential_full_rehash_'+i,...found});
  }
  reset();const overlapping=await Promise.all(Array.from({length:24},()=>actual.currentUniformEnvironment()));
  assert(overlapping.every(value=>value===overlapping[0]));assert(observation().allFilesReadExactlyOnce);
  assert(maximum<=16);steps.push({name:'24_overlapping_callers_one_not_started_scan',...observation()});
  const bytes=await originalRead(first),metadata=await fs.stat(first);
  const changed=Buffer.from(bytes);changed[changed.length-1]=changed[changed.length-1]===10?32:10;
  try{
   reset();const entered=new Promise<void>(yes=>{gateEntered=yes;});gatePath=middle;
   const earlier=actual.currentUniformEnvironment();
   const earlierObserved=earlier.then((v:unknown)=>({status:'fulfilled',value:v}), (e:unknown)=>({status:'rejected',error:describe(e)}));
   await entered;await fs.writeFile(first,changed);await fs.utimes(first,metadata.atime,metadata.mtime);
   const later=actual.currentUniformEnvironment();
   const laterObserved=expectReject(later,'Y5_EMITTED_SOURCE_CHANGED_REBUILD_REQUIRED');
   await new Promise<void>(yes=>setImmediate(yes));releaseGate!();
   const [a,b]=await Promise.all([earlierObserved,laterObserved]);
   steps.push({name:'late_caller_after_already_hashed_file_changed',earlierStatus:a.status,later:b,...observation()});
  }finally{await fs.writeFile(first,bytes);await fs.utimes(first,metadata.atime,metadata.mtime);}
  reset();await actual.currentUniformEnvironment();assert(observation().allFilesReadExactlyOnce);
  steps.push({name:'restored_after_overlap_failure',...observation()});
  try{
   await fs.writeFile(first,changed);await fs.utimes(first,metadata.atime,metadata.mtime);
   reset();const error=await expectReject(actual.currentUniformEnvironment(),'Y5_EMITTED_SOURCE_CHANGED_REBUILD_REQUIRED');
   steps.push({name:'sequential_same_size_restored_mtime_change',error,...observation()});
  }finally{await fs.writeFile(first,bytes);await fs.utimes(first,metadata.atime,metadata.mtime);}
  await fs.rename(missing,missing+'.withheld-by-exclusive-source-cut-fixture');
  try{
   reset();const error=await expectReject(actual.currentUniformEnvironment(),'ENOENT');
   assert.equal(active,0);steps.push({name:'missing_file_fails_and_drains',error,...observation()});
  }finally{await fs.rename(missing+'.withheld-by-exclusive-source-cut-fixture',missing);}
  reset();await actual.currentUniformEnvironment();assert(observation().allFilesReadExactlyOnce);
  steps.push({name:'restored_missing_source_fresh_scan',...observation()});
  const old=emitted.files[0].sha256;
  try{
   await fs.writeFile(first,changed);emitted.files[0].sha256=sha(changed);
   reset();const error=await expectReject(actual.currentUniformEnvironment(),'Y5_LOADED_SOURCE_CHANGED_RESTART_REQUIRED');
   steps.push({name:'changed_emitted_expectation_does_not_replace_loaded_identity',error,...observation()});
  }finally{emitted.files[0].sha256=old;await fs.writeFile(first,bytes);await fs.utimes(first,metadata.atime,metadata.mtime);}
  reset();await actual.currentUniformEnvironment();assert(observation().allFilesReadExactlyOnce);
  steps.push({name:'final_restored_complete_cut',...observation()});
  await save(evidence,{status:'PASS_BOUNDED_ACTUAL_SOURCE_CUT',phase,fdLimit:128,steps});
 }catch(error){
  const defect=phase==='baseline'&&(error as {code?:string}).code==='EMFILE';
  await save(evidence,{status:defect?'REPRODUCED_BASELINE_EMFILE':'FAIL',phase,fdLimit:128,error:describe(error),steps,observation:observation()});
  process.exitCode=defect?2:1;
 }finally{fs.readFile=originalRead;syncBuiltinESMExports();}
}
async function main(){
 const args=process.argv.slice(2);
 if(args[0]==='--child'){await child(args[1]!,args[2]!,args[3]!);return;}
 const phase=args[args.indexOf('--phase')+1],output=args[args.indexOf('--output')+1];
 if(!['baseline','bounded'].includes(phase??'')||!output||!isAbsolute(output)||
  args.length!==4||!args.includes('--phase')||!args.includes('--output'))throw Error('Use --phase baseline|bounded --output NEW_ABSOLUTE_DIRECTORY');
 await fs.mkdir(output,{recursive:false,mode:0o700});
 const root=resolve(dirname(driver),'../../../..'),fixture=join(output,'exclusive-fixture');
 await fs.mkdir(fixture,{mode:0o700});
 const {UNIFORM_SOURCE_PATHS:paths}=await import(pathToFileURL(join(root,owner,'source-paths.ts')).href);
 const inputFiles:{path:string;sha256:string;bytes:number}[]=Array(paths.length);
 await pool(paths,async(p:string,index)=>{
  const bytes=await fs.readFile(join(root,p)),destination=join(fixture,p);
  await fs.mkdir(dirname(destination),{recursive:true});await fs.writeFile(destination,bytes,{flag:'wx'});
  inputFiles[index]={path:p,sha256:sha(bytes),bytes:bytes.length};
 });
 for(const directory of ['node_modules','finnor-os/node_modules']){
  await fs.symlink(await fs.realpath(join(root,directory)),join(fixture,directory),'dir');
 }
 const files=inputFiles.map(({path,sha256})=>({path,sha256}));
 await fs.writeFile(join(fixture,owner,'source-manifest.generated.ts'),
  '// Exclusive verification fixture preparation, not source acceptance.\nexport default '+
  JSON.stringify({schema:'finnor.y5.emitted-source.v1',files,sourceDigest:sha(canonical(files))},null,2)+' as const;\n');
 const evidence=join(output,'child-evidence.json'),shell='ulimit -n 128; exec "$1" --import=tsx "$2" --child "$3" "$4" "$5"';
 await save(join(output,'preparation.json'),{status:'PREPARATION_NOT_VERIFICATION',phase,root,fixture,
  driverSha256:sha(await fs.readFile(driver)),sourceCutSha256:sha(await fs.readFile(join(root,owner,'source-cut.ts'))),
  files:inputFiles,totalBytes:inputFiles.reduce((n,f)=>n+f.bytes,0),fdLimit:128,
  childCommand:['/bin/sh','-c',shell,'source-cut-fd128',process.execPath,driver,phase,fixture,evidence],
  rerun:`cd ${JSON.stringify(join(root,'finnor-os'))} && node --import=tsx scripts/postx/y5/verify-source-cut.mts --phase ${phase} --output NEW_ABSOLUTE_DIRECTORY`});
 const result=await new Promise<{code:number|null;signal:string|null;stdout:string;stderr:string}>(yes=>{
  const command=spawn('/bin/sh',['-c',shell,'source-cut-fd128',process.execPath,driver,phase!,fixture,evidence],{
   cwd:join(root,'finnor-os'),env:process.env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';command.stdout.on('data',b=>stdout+=b);command.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>command.kill('SIGKILL'),90000);
  command.once('error',e=>{stderr+=String(e);});command.once('close',(code,signal)=>{
   clearTimeout(timer);yes({code,signal,stdout,stderr});
  });
 });
 await fs.writeFile(join(output,'child.stdout.log'),result.stdout);await fs.writeFile(join(output,'child.stderr.log'),result.stderr);
 let observed;try{observed=JSON.parse(await fs.readFile(evidence,'utf8'));}catch{observed={status:'MISSING_CHILD_EVIDENCE'};}
 const expected=phase==='baseline'?'REPRODUCED_BASELINE_EMFILE':'PASS_BOUNDED_ACTUAL_SOURCE_CUT';
 const status=observed.status===expected&&result.code===(phase==='baseline'?2:0)?expected:'FAIL';
 await save(join(output,'summary.json'),{status,phase,files:paths.length,childExit:result.code,signal:result.signal,evidence,preparation:join(output,'preparation.json')});
 console.log(JSON.stringify({status,output,files:paths.length,childExit:result.code}));
 if(status==='FAIL')process.exitCode=1;
}
await main();
