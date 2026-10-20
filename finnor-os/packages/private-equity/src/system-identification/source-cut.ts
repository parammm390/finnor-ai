import {readFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {IDENTIFICATION_SOURCE_PATHS,X4_MIGRATION_HEAD} from './source-paths';
import stamp from './source-manifest.generated';
import {sha,fail,type IdentificationEnvironment} from './contracts';
export async function identificationSourceRoot(){
 for(let p=resolve(process.cwd()),i=0;i<7;i++,p=resolve(p,'..')){
  try{await access(resolve(p,IDENTIFICATION_SOURCE_PATHS[0]!));return p;}catch{/* Fixed trusted paths, never a request path. */}
 }
 return fail('X4_SOURCE_CLOSURE_UNAVAILABLE',503);
}
async function cut():Promise<IdentificationEnvironment>{
 const root=await identificationSourceRoot(),files=await Promise.all(IDENTIFICATION_SOURCE_PATHS.map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')})));
 if(sha(files)!==sha(stamp.files))fail('X4_EMITTED_SOURCE_CHANGED_REBUILD_REQUIRED',503);
 const body={schema:'finnor.x4.runtime-cut.v1' as const,files,sourceDigest:sha(files),
  checkerDigest:files.find(f=>f.path.endsWith('/identification-checker.ts'))!.sha256,instrumentDigest:files.find(f=>f.path.endsWith('/system-identification/instrument.ts'))!.sha256,
  lockDigest:files.find(f=>f.path==='finnor-os/package-lock.json')!.sha256,schemaDigest:files.find(f=>f.path.endsWith('/'+X4_MIGRATION_HEAD))!.sha256,
  migrationHead:X4_MIGRATION_HEAD,node:process.version,platform:process.platform,architecture:process.arch,imageDigest:null};
 return {...body,runtimeDigest:sha(body)};
}
const loaded=cut();void loaded.catch(()=>undefined);
export async function currentIdentificationEnvironment(){
 if(process.versions.node.split('.')[0]!=='22')fail('X4_NODE_22_REQUIRED',503);
 const [initial,current]=await Promise.all([loaded,cut()]);
 if(sha(initial)!==sha(current))fail('X4_LOADED_SOURCE_CHANGED_RESTART_REQUIRED',503);
 return current;
}
