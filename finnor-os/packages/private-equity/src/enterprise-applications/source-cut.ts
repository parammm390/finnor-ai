import {readFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {applicationDigest,ApplicationFault} from './contracts';
import {APPLICATION_SOURCE_PATHS as paths,X3_MIGRATION_HEAD} from './source-paths';
import emittedSource from './source-manifest.generated';
export {X3_MIGRATION_HEAD};
const bytesHash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export async function applicationSourceRoot(){
 for(let base=resolve(process.cwd()),i=0;i<7;i++,base=resolve(base,'..')){
  try{await access(resolve(base,paths[0]!));return base;}catch{/* Fixed trusted source paths only. */}
 }
 throw new ApplicationFault('APPLICATION_SOURCE_CLOSURE_UNAVAILABLE','The complete installed source closure is required',503);
}
async function readCut(){
 const root=await applicationSourceRoot();
 const files=await Promise.all(paths.map(async path=>({path,sha256:bytesHash(await readFile(resolve(root,path)))})));
 if(applicationDigest(files)!==applicationDigest(emittedSource.files))
  throw new ApplicationFault('APPLICATION_EMITTED_SOURCE_CHANGED','Rebuild and replace the host after source or renderer changes',503);
 return {files,sourceDigest:applicationDigest(files),lockDigest:files.find(f=>f.path==='finnor-os/package-lock.json')!.sha256,
  checkerDigest:files.find(f=>f.path.endsWith('/checker.ts'))!.sha256,
  schemaDigest:files.find(f=>f.path.endsWith('/'+X3_MIGRATION_HEAD))!.sha256,
  migrationHead:X3_MIGRATION_HEAD,node:process.version,platform:process.platform,architecture:process.arch,
  imageDigest:null,profile:'PE_FIRM_TYPED_APPLICATION_V1' as const};
}
const loaded=readCut();void loaded.catch(()=>undefined);
export type ApplicationEnvironment=Awaited<ReturnType<typeof readCut>>;
export function assertApplicationEnvironment(expected:ApplicationEnvironment,current:ApplicationEnvironment){
 if(applicationDigest(expected)!==applicationDigest(current))
  throw new ApplicationFault('APPLICATION_DEPENDENCY_OR_DEPLOYMENT_CHANGED','Build and check a maintenance release for the current host before new decisions',409);
}
export async function currentApplicationEnvironment(){
 if(process.versions.node.split('.')[0]!=='22')throw new ApplicationFault('APPLICATION_NODE_22_REQUIRED','The application profile requires Node 22',503);
 const [initial,current]=await Promise.all([loaded,readCut()]);
 if(applicationDigest(initial)!==applicationDigest(current))throw new ApplicationFault('APPLICATION_LOADED_SOURCE_CHANGED','Replace the process before using changed source bytes',503);
 return current;
}
