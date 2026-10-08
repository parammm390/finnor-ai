import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rename, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
export const repo=resolve(import.meta.dirname,'../../..');
export const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function atomic(path:string,value:unknown){
 await writeFile(path+'.pending',JSON.stringify(value,null,2)+'\n',{mode:0o600});
 await rename(path+'.pending',path);
}
export async function sourceCut(){
 const paths:string[]=[];
 async function walk(relative:string){
  for(const entry of await readdir(join(repo,relative),{withFileTypes:true}).catch(()=>[])){
   const name=relative+'/'+entry.name;
   if(entry.isDirectory()&&!['node_modules','.next'].includes(entry.name))await walk(name);
   else if(entry.isFile()&&(/\.(ts|tsx|mts|cts|mjs|cjs|js|sql)$/.test(name)||entry.name==='package.json'))paths.push(name);
  }
 }
 for(const path of ['finnor-os/packages','finnor-os/apps/api','finnor-os/apps/worker',
 'finnor-os/scripts/p5','finnor-os/scripts/s7','finnor-os/scripts/s8','scripts/centropy','src'])await walk(path);
 paths.push('finnor-os/apps/api/app/api/company-brain/[operation]/route.ts','finnor-os/apps/worker/src/index.ts',
 'finnor-os/apps/worker/src/queue.ts','finnor-os/packages/db/compute-contract.ts','finnor-os/packages/db/migration-head.ts',
 'finnor-os/packages/shared-types/src/evidence-execution.ts','finnor-os/packages/private-equity/src/index.ts','finnor-os/packages/db/migrations/0162_p5_interface_acquisition.sql',
 'finnor-os/packages/db/migrations-bundle.ts','finnor-os/scripts/generate-openapi.ts','finnor-os/openapi.json','scripts/centropy/generate-capability-manifest.mjs',
 'src/lib/centropy/capability-manifest.generated.json','src/lib/jarvis/openapi-types.ts','finnor-os/scripts/p3/interface-worker.mts','package.json','package-lock.json','finnor-os/package.json','finnor-os/package-lock.json',
 'scripts/centropy/generate-openapi-client.mjs','src/components/centropy/lib/api.ts','src/components/centropy/lib/centropy-auth.tsx','src/components/centropy/product/contracts.ts',
 'src/components/centropy/shell/CentropyWorkspace.tsx','src/components/centropy/shell/centropy.css',
 'src/app/api/centropy/[...path]/route.ts','src/app/api/centropy/[...path]/proxy-config.ts','src/lib/centropy/supabase-browser.ts',
 'finnor-os/apps/api/lib/auth.ts','finnor-os/packages/security/src/auth.ts','tailwind.config.ts','next.config.mjs',
 'tsconfig.json','finnor-os/tsconfig.json','finnor-os/tsconfig.base.json');
 return await Promise.all([...new Set(paths)].sort().map(async path=>{
  const currentPath=path==='src/lib/jarvis/openapi-types.ts'?'src/lib/centropy/openapi-types.ts':path;
  const provenance=currentPath===path?{}:{originalPath:path,relocation:'PUBLISHED_CENTROPY_CLIENT_GENERATED_FROM_JOINED_BACKEND_OPENAPI'};
  try{return {path:currentPath,...provenance,sha256:sha(await readFile(join(repo,currentPath))),present:true};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {path:currentPath,...provenance,sha256:null,present:false};}
 }));
}
export async function evidence(kind:string){
 const directory=resolve(process.env.FINNOR_P5_EVIDENCE_DIR??join(repo,'scope-pm/phase-10-p5-interface-synthesis/evidence',kind+'-'+new Date().toISOString().replace(/[:.]/g,'-')));
 await mkdir(directory,{recursive:true});
 const before=await sourceCut();
 await writeFile(join(directory,'freeze.json'),JSON.stringify({kind,startedAt:new Date().toISOString(),node:process.version,
  source:before,oracle:'independent target file/SQL and original predicates; no product expected-value helpers',
  novelty:'PUBLIC_DEVELOPMENT_NOT_SEALED',dollars:null},null,2),{flag:'wx',mode:0o600});
 const results:any[]=[];
 const save=()=>atomic(join(directory,'results.json'),{qualification:'ORDINARY_PUBLIC_DEVELOPMENT_NOT_ORIGINAL_GATE_P5',results});
 const story=async(id:string,families:string[],fn:()=>Promise<unknown>)=>{
  if(process.env.FINNOR_P5_CASE_FILTER&&!process.env.FINNOR_P5_CASE_FILTER.split(',').some(f=>id.includes(f))){
   results.push({id,families,status:'NOT_RUN'});await save();return;
  }
  const started=Date.now();
  try{results.push({id,families,status:'PASS',observed:await fn(),elapsedMs:Date.now()-started});}
  catch(error){const cause=(error as {cause?:{code?:string;constraint?:string}}).cause;results.push({id,families,status:'FAIL',predicate:String((error as Error).message),cause: cause?{code:cause.code??null,constraint:cause.constraint??null}:null,elapsedMs:Date.now()-started});}
  await save();
  console.log(JSON.stringify({id,status:results.at(-1).status,predicate:results.at(-1).predicate}));
 };
 const finish=async()=>{
  const after=await sourceCut();const unchanged=JSON.stringify(before)===JSON.stringify(after);
  const sourceComplete=after.every(f=>f.present);
  await atomic(join(directory,'source-check.json'),{unchanged,sourceComplete,missing:after.filter(f=>!f.present),before,after});
  await save();
  const registration=JSON.parse(await readFile(join(repo,'scope-pm/phase-10-p5-interface-synthesis/registration.json'),'utf8'));
  await atomic(join(directory,'selection.json'),{families:registration.families.map((f:any)=>({id:f.id,runs:results.filter(r=>r.families.includes(f.id)).map(r=>({id:r.id,status:r.status})),gate:'NOT_RUN'})),sourceUnchanged:unchanged,sourceComplete});
  process.exitCode=unchanged&&sourceComplete&&results.some(r=>r.status==='PASS')&&!results.some(r=>r.status==='FAIL')?0:1;
  console.log(JSON.stringify({directory,pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,excluded:results.filter(r=>r.status==='NOT_RUN').length,unchanged,sourceComplete}));
 };
 return {directory,story,finish,results};
}
export async function target(output:string){
 const directory=await mkdtemp(join(tmpdir(),'p5-independent-target-')),statePath=join(directory,'state.json');
 const child=spawn(process.execPath,[join(import.meta.dirname,'target.mjs'),statePath],{env:{PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC'},stdio:['ignore','pipe','pipe']});
 const port=await new Promise<number>((yes,no)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('TARGET_START_TIMEOUT'));},5000);
  child.once('error',error=>{clearTimeout(timer);no(error);});
  child.once('exit',()=>{clearTimeout(timer);no(Error('TARGET_EXITED'));});
  child.stdout.once('data',bytes=>{clearTimeout(timer);yes(JSON.parse(bytes.toString()).port);});
 });
 const origin='http://127.0.0.1:'+port;
 const reference=async()=>JSON.parse(await readFile(statePath,'utf8'));
 const control=async(change:unknown)=>{const r=await fetch(origin+'/control',{method:'POST',body:JSON.stringify(change)});if(!r.ok)throw Error('TARGET_CONTROL_FAILED');};
 const close=async()=>{
  if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(yes=>{child.once('close',()=>yes());child.kill('SIGTERM');});
  await atomic(join(output,'target-'+port+'.json'),{pid:child.pid,exitCode:child.exitCode,signal:child.signalCode,state:await reference(),ownedPath:statePath});
 };
 return {origin,reference,control,close,statePath,pid:child.pid};
}
