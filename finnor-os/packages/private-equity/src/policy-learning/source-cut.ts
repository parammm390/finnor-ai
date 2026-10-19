import {readFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {LEARNING_SOURCE_PATHS,X5_MIGRATION_HEAD} from './source-paths';
import emitted from './source-manifest.generated';
import {sha,fail} from './contracts';
export async function learningSourceRoot(){
 for(let p=resolve(process.cwd()),i=0;i<7;i++,p=resolve(p,'..')){
  try{await access(resolve(p,LEARNING_SOURCE_PATHS[0]!));return p;}catch{/* Trusted fixed source paths only. */}
 }
 fail('X5_SOURCE_CLOSURE_UNAVAILABLE',503);
}
async function readCut(){
 const root=await learningSourceRoot(),files=await Promise.all(LEARNING_SOURCE_PATHS.map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')})));
 if(sha(files)!==sha(emitted.files))fail('X5_EMITTED_SOURCE_CHANGED_REBUILD_REQUIRED',503);
 return {schema:'finnor.x5.runtime-cut.v1' as const,files,sourceDigest:sha(files),lockDigest:files.find(f=>f.path==='finnor-os/package-lock.json')!.sha256,
  migrationHead:X5_MIGRATION_HEAD,schemaDigest:files.find(f=>f.path.endsWith('/'+X5_MIGRATION_HEAD))!.sha256,
  checkerDigest:files.find(f=>f.path.endsWith('/policy-learning/evaluation.ts'))!.sha256,node:process.version,platform:process.platform,architecture:process.arch,imageDigest:null};
}
const loaded=readCut();void loaded.catch(()=>undefined);
export type LearningEnvironment=Awaited<ReturnType<typeof readCut>>;
export async function currentLearningEnvironment(){
 if(process.versions.node.split('.')[0]!=='22')fail('X5_NODE_22_REQUIRED',503);
 const [initial,current]=await Promise.all([loaded,readCut()]);
 if(sha(initial)!==sha(current))fail('X5_LOADED_SOURCE_CHANGED_RESTART_REQUIRED',503);
 return current;
}
