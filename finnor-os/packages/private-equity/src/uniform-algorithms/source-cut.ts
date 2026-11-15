import {readFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {UNIFORM_SOURCE_PATHS} from './source-paths';
import emitted from './source-manifest.generated';
import {hash,digest,fail} from './contracts';
export async function uniformSourceRoot(){
 for(let p=resolve(process.cwd()),i=0;i<8;i++,p=resolve(p,'..')){
  try{await access(resolve(p,UNIFORM_SOURCE_PATHS[0]));return p;}catch{}
 }
 return fail('Y5_SOURCE_CLOSURE_UNAVAILABLE',503);
}
async function readCut(){
 const root=await uniformSourceRoot(),files:Array<Readonly<{path:string;sha256:string}>>=Array(UNIFORM_SOURCE_PATHS.length);
 let cursor=0,failed=false,failure:unknown;
 await Promise.all(Array.from({length:Math.min(16,UNIFORM_SOURCE_PATHS.length)},async()=>{
  for(;;){
   const index=cursor++;if(index>=UNIFORM_SOURCE_PATHS.length)return;
   const path=UNIFORM_SOURCE_PATHS[index]!;
   try{files[index]=Object.freeze({path,sha256:hash(await readFile(resolve(root,path)))});}
   catch(error){if(!failed){failed=true;failure=error;}}
  }
 }));
 if(failed)throw failure;
 if(digest(files)!==digest(emitted.files))fail('Y5_EMITTED_SOURCE_CHANGED_REBUILD_REQUIRED',503);
 return Object.freeze({schema:'finnor.y5.source-cut.v1' as const,files:Object.freeze(files),sourceDigest:digest(files),node:process.version,platform:process.platform,architecture:process.arch,
  independentReleaseQualification:false as const});
}
let running:ReturnType<typeof readCut>|null=null,queued:ReturnType<typeof readCut>|null=null;
function completeRehash():ReturnType<typeof readCut>{
 if(queued)return queued;
 const previous=running;
 const next:ReturnType<typeof readCut>=(previous??Promise.resolve()).catch(()=>undefined).then(()=>{
  if(queued===next)queued=null;
  return readCut();
 });
 queued=next;running=next;
 const settled=()=>{if(running===next)running=null;};
 void next.then(settled,settled);
 return next;
}
let loaded:ReturnType<typeof readCut>|null=null;
export async function currentUniformEnvironment(){
 loaded??=completeRehash();
 const initial=await loaded,current=await completeRehash();
 if(digest(initial)!==digest(current))fail('Y5_LOADED_SOURCE_CHANGED_RESTART_REQUIRED',503);
 return current;
}
export type UniformEnvironment=Awaited<ReturnType<typeof readCut>>;
