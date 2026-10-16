/** Relocated local artifact, with traced sources and lock-matching dependencies.
 * No original checkout path or caller-selected source digest is a runtime input. */
import {strict as assert} from 'node:assert';
import {constants} from 'node:fs';
import {copyFile,mkdir,readFile,readdir,writeFile,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,relative,dirname,sep} from 'node:path';
import {once} from 'node:events';
import type {verificationBudget} from './verification-budget.mts';

export async function runtimeArtifact(repo:string,directory:string,output:string,budget?:ReturnType<typeof verificationBudget>){
 budget?.assertCurrent();
 const destination=join(await realpath(directory),'relocated-v2-artifact'),api=join(repo,'finnor-os/apps/api'),next=join(api,'.next');
 await mkdir(destination,{recursive:true});
 const files=new Set<string>();
 const emitted=(await readdir(next,{recursive:true})).filter(file=>!file.startsWith('cache/')&&!file.startsWith('dev/')&&!file.endsWith('/'));
 for(const name of emitted){
  const path=join(next,name);
  // readdir(recursive) includes directories, which have no filename extension.
  if(!/\.[a-z0-9]+$/i.test(name)&&name!=='BUILD_ID')continue;
  files.add(path);
  if(name.endsWith('.nft.json')){
   const trace=JSON.parse(await readFile(path,'utf8'));
   for(const file of trace.files as string[])files.add(resolve(dirname(path),file));
  }
 }
 for(const path of ['package.json','package-lock.json','finnor-os/package.json','finnor-os/package-lock.json','finnor-os/tsconfig.json','finnor-os/tsconfig.base.json','finnor-os/apps/api/next.config.mjs'])files.add(join(repo,path));
 const inventory:Array<{path:string;sha256:string;bytes:number}>=[];
 for(const source of [...files].sort()){
  budget?.assertCurrent();
  const path=relative(repo,source);
  assert(!path.startsWith('..'+sep)&&!path.startsWith(sep),'ARTIFACT_FILE_OUTSIDE_PINNED_REPOSITORY');
  if(path.startsWith('finnor-os/node_modules/'))continue;
  const bytes=await readFile(source),target=join(destination,path);
  await mkdir(dirname(target),{recursive:true});await copyFile(source,target,constants.COPYFILE_FICLONE);
  inventory.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
 }
 // Workspace symlinks remain relative to this new tree, not to the source tree.
 // These copied dependencies are deliberately not called a clean install.
 const deps=spawn('/bin/cp',['-cR',join(repo,'finnor-os/node_modules'),join(destination,'finnor-os/node_modules')],{stdio:'ignore'});
 const stopCopy=()=>deps.kill('SIGKILL');budget?.signal.addEventListener('abort',stopCopy,{once:true});
 const [code]=await once(deps,'exit');budget?.signal.removeEventListener('abort',stopCopy);budget?.assertCurrent();assert.equal(code,0,'LOCK_MATCHING_DEPENDENCY_COPY_FAILED');
 const sourceCustody=await realpath(join(destination,'finnor-os/node_modules/@finnor/source-custody'));
 assert(sourceCustody.startsWith(destination+sep),'ARTIFACT_SOURCE_CUSTODY_ESCAPED_RELOCATION');
 const workerEntry=join(destination,'finnor-os/packaged-worker-probe.mts');
 await writeFile(workerEntry,`import {createWorker} from './apps/worker/src/index.ts';
import {closePool,getPool} from './packages/db/index.ts';
const queue=createWorker();
try{
 const role=(await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
 if(role.current_user!=='finnor_worker'||role.rolsuper||role.rolbypassrls)throw Error('ORDINARY_PACKAGED_WORKER_ROLE_REQUIRED');
 if(!queue.registeredTypes().includes('advance_primary_diligence_v1'))throw Error('FINAL_PACKAGED_V2_HANDLER_MISSING');
 await queue.recoverExpiredRunningJobs();const claimed=await queue.tick();
 console.log(JSON.stringify({workerRole:role,registeredV2:true,claimed}));
}finally{await closePool();}
process.exit(0);
`);
 await writeFile(join(output,'packaged-asset-inventory.json'),JSON.stringify({schema:'finnor.v2.relocated-artifact.v1',inventory,dependencies:'APFS_COW_LOCK_MATCHING_COPY_NOT_CLEAN_INSTALL',sourceFallback:false,LinuxImageProof:'NOT_RUN'},null,2)+'\n');
 return {directory:destination,apiDirectory:join(destination,'finnor-os/apps/api'),workerEntry,inventory};
}

export async function artifactWorker(artifact:Awaited<ReturnType<typeof runtimeArtifact>>,workerUrl:string,output:string,budget?:ReturnType<typeof verificationBudget>){
 budget?.assertCurrent();
 const cwd=join(artifact.directory,'finnor-os'),env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:workerUrl,NODE_ENV:'development',TSX_TSCONFIG_PATH:join(cwd,'tsconfig.json')};
 delete env.AUTH_DEV_BYPASS;
 const child=spawn(process.execPath,['--import=tsx',artifact.workerEntry],{cwd,env,stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',b=>{if(log.length<65536)log+=b.toString();});child.stderr.on('data',b=>{if(log.length<65536)log+=b.toString();});
 const stop=()=>child.kill('SIGKILL'),timer=setTimeout(stop,budget?.remainingMs(90000)??90000);budget?.signal.addEventListener('abort',stop,{once:true});
 try{
  const [code,signal]=await once(child,'exit');
  const safe=log.replace(/Bearer [^\s"]+/g,'Bearer [REDACTED]').replace(/postgres(?:ql)?:\/\/[^@\s]+@/g,'postgres://[REDACTED]@');
  await writeFile(join(output,'packaged-worker.log'),safe);
  budget?.assertCurrent();
  assert.equal(code,0,`PACKAGED_WORKER_EXIT_${code}_${signal}: ${safe.slice(-2000)}`);
 }finally{clearTimeout(timer);budget?.signal.removeEventListener('abort',stop);}
}
