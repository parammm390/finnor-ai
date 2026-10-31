import {readFile,writeFile,access,readdir} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import ts from 'typescript';
import {UNIFORM_SOURCE_PATHS} from '../../../packages/private-equity/src/uniform-algorithms/source-paths';
import {hash,jsonHash} from '../../../packages/epistemic-runtime/src/uniform-algorithms/syntax';
const root=resolve(import.meta.dirname,'../../../..');
const pathsFile='finnor-os/packages/private-equity/src/uniform-algorithms/source-paths.ts';
const output='finnor-os/packages/private-equity/src/uniform-algorithms/source-manifest.generated.ts';
const check=process.argv.includes('--check');
if(process.argv.slice(2).some(arg=>arg!=='--check'))throw Error('Y5_SOURCE_GENERATOR_ARGUMENT');
const optionsFor=(file:string)=>{
 const configPath=resolve(root,file.startsWith('src/')?'tsconfig.json':'finnor-os/tsconfig.json');
 const config=ts.readConfigFile(configPath,ts.sys.readFile);
 if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
 return ts.parseJsonConfigFileContent(config.config,ts.sys,dirname(configPath)).options;
};
const backendOptions=optionsFor('finnor-os/'),frontendOptions=optionsFor('src/');
// The planner replay manifest hashes this generator's output, so pinning it here would make each hash depend on the other.
const hashCycle=new Set(['finnor-os/packages/orchestration/src/capabilities/planner-replay-manifest.json']);
const paths=new Set<string>(UNIFORM_SOURCE_PATHS);
if(paths.size!==UNIFORM_SOURCE_PATHS.length||paths.has(output))throw Error('Y5_SOURCE_PATH_DUPLICATE_OR_SELF_HASH');
for(const path of hashCycle)paths.delete(path);
async function inventory(directory:string){
 for(const entry of await readdir(resolve(root,directory),{withFileTypes:true})){
  const path=directory+'/'+entry.name;
  if(entry.isDirectory())await inventory(path);
  else if(entry.isFile()&&path!==output)paths.add(path);
  else if(!entry.isFile())throw Error('Y5_SOURCE_SYMLINK_OR_SPECIAL_FILE:'+path);
 }
}
await inventory('finnor-os/packages/private-equity/src/uniform-algorithms');
await inventory('finnor-os/packages/epistemic-runtime/src/uniform-algorithms');
const queue=[...paths];
const nextGeneratedDeclarations=new Set(['next-env.d.ts','finnor-os/apps/api/next-env.d.ts']);
const add=(absolute:string)=>{
 const path=relative(root,absolute).replaceAll('\\','/');
 if(path.startsWith('../')||isAbsolute(path))throw Error('Y5_SOURCE_DEPENDENCY_OUTSIDE_ROOT:'+path);
 if(path===output||hashCycle.has(path))return;
 if(!paths.has(path)){paths.add(path);queue.push(path);}
};
for(let index=0;index<queue.length;index++){
 const file=queue[index]!;
 await access(resolve(root,file));
 if(!/\.(?:[cm]?[jt]sx?)$/.test(file))continue;
 const source=await readFile(resolve(root,file),'utf8');
 for(const match of source.matchAll(/['"]([^'"\n]+\.(?:[cm]?[jt]sx?|json|css|py|sql|lean))['"]/g)){
  const literal=match[1]!;
  if(isAbsolute(literal)||literal.includes('://'))continue;
  for(const candidate of [resolve(root,dirname(file),literal),resolve(root,literal)]){
   const local=relative(root,candidate);
   // Next rewrites these during builds and the installed builder records that
   // change; a real import of one is still traversed and fails closed below.
   if(nextGeneratedDeclarations.has(local))continue;
   if(!local.startsWith('../')&&!isAbsolute(local)&&!local.split(/[\\/]/).includes('node_modules')&&ts.sys.fileExists(candidate))add(candidate);
  }
 }
 for(const imported of ts.preProcessFile(source,true,true).importedFiles){
  const spec=imported.fileName;
  if(!spec.startsWith('.')&&!spec.startsWith('@/')&&!spec.startsWith('@finnor/'))continue;
  let direct=false;
  if(spec.startsWith('.')){
   const absolute=resolve(root,dirname(file),spec);
   if(ts.sys.fileExists(absolute)){add(absolute);direct=true;}
  }
  const found=ts.resolveModuleName(spec,resolve(root,file),file.startsWith('src/')?frontendOptions:backendOptions,ts.sys).resolvedModule;
  if(found){
   if(found.resolvedFileName.includes('/node_modules/'))throw Error('Y5_FIRST_PARTY_RESOLVED_TO_DEPENDENCY:'+file+':'+spec);
   add(found.resolvedFileName);
  }else if(!direct)throw Error('Y5_SOURCE_IMPORT_UNRESOLVED:'+file+':'+spec);
 }
}
const kept=UNIFORM_SOURCE_PATHS.filter(path=>!hashCycle.has(path));
const ordered=[...kept,...[...paths].filter(path=>!kept.includes(path as typeof UNIFORM_SOURCE_PATHS[number])).sort()];
if(check&&ordered.length!==UNIFORM_SOURCE_PATHS.length)
 throw Error('Y5_SOURCE_PATHS_STALE:'+JSON.stringify(ordered.slice(UNIFORM_SOURCE_PATHS.length)));
if(!check&&ordered.length!==UNIFORM_SOURCE_PATHS.length)
 await writeFile(resolve(root,pathsFile),'// Complete first-party import closure; generated additions retain the original v1 paths.\nexport const UNIFORM_SOURCE_PATHS='+JSON.stringify(ordered,null,2)+' as const;\n');
const files:{path:string;sha256:string}[]=[];
for(let index=0;index<ordered.length;index+=16)
 files.push(...await Promise.all(ordered.slice(index,index+16).map(async path=>({path,sha256:hash(await readFile(resolve(root,path)))}))));
const document='// Generated by scripts/postx/y5/generate-source.mts. Do not edit.\nexport default '+JSON.stringify({schema:'finnor.y5.emitted-source.v1',files,sourceDigest:jsonHash(files)},null,2)+' as const;\n';
if(check){
 if(await readFile(resolve(root,output),'utf8')!==document)throw Error('Y5_EMITTED_SOURCE_STALE');
}else await writeFile(resolve(root,output),document);
console.log(JSON.stringify({status:check?'CURRENT':'GENERATED',sourceDigest:jsonHash(files),files:files.length,
 closure:'LOCAL_STATIC_IMPORTS_EXISTING_LITERAL_ASSETS_AND_OWNED_ENGINE_OWNER_FILES',selfHashException:output,hashCycleExceptions:[...hashCycle],
 qualification:'SOURCE_INVENTORY_NOT_RUNTIME_OR_PROTECTED_QUALIFICATION'}));
