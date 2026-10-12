import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createReadStream, existsSync, statfsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, lstat, readlink, rename, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo=fileURLToPath(new URL('../../../',import.meta.url)),args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--output'||args[2]!=='--origin'||!args[1].startsWith('/')||existsSync(args[1]))
  throw Error('X1_NEW_FRONTEND_OUTPUT_AND_LOOPBACK_ORIGIN_REQUIRED');
const output=resolve(args[1]),origin=new URL(args[3]);
if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||Number(origin.port)<1024
  ||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)
  throw Error('X1_EXACT_LOOPBACK_FRONTEND_ORIGIN_REQUIRED');
const limits=JSON.parse(await readFile(join(repo,'scope-frontier5/x1-institutional-programme-compiler/verification-plan.json'),'utf8')).limits;
const free=()=>{const s=statfsSync(repo,{bigint:true});return s.bavail*s.bsize;};
if(free()<BigInt(limits.finalBuildMinimumFreeBytes))throw Error('X1_FINAL_BUILD_CAPACITY_REFUSED');
await new Promise((yes,no)=>{const socket=createServer();socket.once('error',no);
  socket.listen(Number(origin.port),'127.0.0.1',()=>socket.close(yes));});
const git=(...argv)=>execFileSync('git',argv,{cwd:repo,encoding:'utf8',timeout:5000,maxBuffer:16*1024*1024}).trimEnd();
const source={commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),dirty:git('status','--porcelain=v1','-uall')};
if(source.dirty.split('\n').filter(Boolean).some(line=>line.slice(3)!=='AGENTS.md'))throw Error('X1_FRONTEND_BUILD_COMMITTED_SOURCE_REQUIRED');
const buildDir=join(repo,'.next-x1-install');
if(existsSync(buildDir))throw Error('X1_FRONTEND_BUILD_DIRECTORY_ALREADY_EXISTS');
await mkdir(output,{mode:0o700});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(path){const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex');}
const sourcePreimages=[];
for(const path of git('ls-files','-z').split('\0').filter(Boolean)){
  if(/^(?:src\/|scripts\/centropy\/|scripts\/frontier5\/|public\/)/.test(path)
    ||['package.json','package-lock.json','next.config.mjs','tsconfig.json','tailwind.config.ts','postcss.config.mjs'].includes(path))
    sourcePreimages.push({path,sha256:await fileHash(join(repo,path))});
}
const started=Date.now(),cpuBefore=process.cpuUsage(),resources=[];
const child=spawn(process.execPath,['--max-old-space-size=1536',join(repo,'node_modules/next/dist/bin/next'),'build','--webpack'],{
  cwd:repo,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=1536',CI:'1',NEXT_TELEMETRY_DISABLED:'1',
    FINNOR_X1_FRONTEND_INSTALL:'1',FINNOR_BUILD_ID:'x1-'+source.commit,
    NEXT_PUBLIC_SUPABASE_URL:origin.origin,NEXT_PUBLIC_SUPABASE_ANON_KEY:'disposable-local-auth',
    NEXT_PUBLIC_CENTROPY_TEST_MODE:'0',CENTROPY_TEST_MODE:'0'}});
let logBytes=0,guardFailure=null;
for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{
  logBytes+=bytes.length;if(logBytes>limits.smallCheckOutputBytes){guardFailure='X1_FRONTEND_BUILD_LOG_BOUND';child.kill('SIGTERM');}
  else process.stdout.write(bytes);
});
const stop=reason=>{guardFailure??=reason;child.kill('SIGTERM');};
const timer=setTimeout(()=>stop('X1_FINAL_BUILD_WALL_BOUND'),limits.finalBuildWallSeconds*1000);
const guard=setInterval(()=>{
  try{
    const rows=execFileSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
    const owned=new Set([process.pid]);for(;;){const n=owned.size;for(const r of rows)if(owned.has(r[1]))owned.add(r[0]);if(owned.size===n)break;}
    const rss=rows.filter(r=>owned.has(r[0])).reduce((sum,r)=>sum+r[2]*1024,0),available=free();
    resources.push({at:new Date().toISOString(),elapsedMs:Date.now()-started,sampledOwnedRssBytes:rss,freeBytes:String(available)});
    if(rss>limits.localSampledProcessMemoryStopBytes)stop('X1_FRONTEND_BUILD_MEMORY_BOUND');
    if(available<BigInt(limits.liveMinimumFreeBytes))stop('X1_FRONTEND_BUILD_FREE_SPACE_BOUND');
  }catch(error){stop('X1_FRONTEND_BUILD_RESOURCE_OBSERVER_FAILED:'+error.message);}
},2000);
const ending=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',(code,signal)=>yes({code,signal}));});
clearTimeout(timer);clearInterval(guard);
await writeFile(join(output,'build-resources.json'),JSON.stringify({source,resources,ending,guardFailure,logBytes,
  elapsedMs:Date.now()-started,coordinatorCpuMicros:process.cpuUsage(cpuBefore),humanSeconds:null,
  monetaryCost:null,aggregatePeakMemoryBytes:null},null,2)+'\n',{flag:'wx',mode:0o600});
if(guardFailure||ending.code!==0||ending.signal)throw Error(guardFailure??'X1_FRONTEND_BUILD_FAILED');
let tracingRoot=repo;
const nextRoot=dirname(createRequire(import.meta.url).resolve('next/package.json'));
while(relative(tracingRoot,nextRoot)==='..'||relative(tracingRoot,nextRoot).startsWith('..'+sep))tracingRoot=dirname(tracingRoot);
const projectPath=relative(tracingRoot,repo),runtime=join(output,'runtime');
await rename(join(buildDir,'standalone'),runtime);
await cp(join(buildDir,'static'),join(runtime,projectPath,'.next-x1-install/static'),{recursive:true,errorOnExist:true,force:false});
await cp(join(repo,'public'),join(runtime,projectPath,'public'),{recursive:true,errorOnExist:true,force:false});
const files=[],links=[];let outputBytes=0;
async function scan(directory){for(const item of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,item.name),r=relative(output,path),s=await lstat(path);
  if(s.isSymbolicLink()){
    const target=await readlink(path),actual=resolve(dirname(path),target);
    if(!actual.startsWith(runtime+sep))throw Error('X1_FRONTEND_LINK_OUTSIDE_INSTALLATION:'+r);
    links.push({path:r,target});
  }else if(s.isDirectory())await scan(path);
  else if(s.isFile()){
    outputBytes+=s.size;if(outputBytes>limits.finalBuildOutputBytes)throw Error('X1_FINAL_BUILD_OUTPUT_BOUND');
    files.push({path:r,bytes:s.size,mode:s.mode&0o7777,sha256:await fileHash(path)});
  }else throw Error('X1_FRONTEND_SPECIAL_FILE_REFUSED');
}}
await scan(runtime);
const hostBytes=await readFile(join(repo,'scripts/frontier5/x1/frontend-host.mjs'));
await writeFile(join(output,'frontend-host.mjs'),hostBytes,{flag:'wx',mode:0o444});
files.push({path:'frontend-host.mjs',bytes:hostBytes.length,mode:0o444,sha256:sha(hostBytes)});outputBytes+=hostBytes.length;
const server=join('runtime',projectPath,'server.js');
if(!files.some(row=>row.path===server))throw Error('X1_ACTUAL_STANDALONE_SERVER_REQUIRED');
const buildId=(await readFile(join(runtime,projectPath,'.next-x1-install/BUILD_ID'),'utf8')).trim();
if(buildId!=='x1-'+source.commit)throw Error('X1_FRONTEND_BUILD_ID_MISMATCH');
if(git('rev-parse','HEAD')!==source.commit||git('status','--porcelain=v1','-uall')!==source.dirty)
  throw Error('X1_FRONTEND_BUILD_SOURCE_CHANGED');
const manifest={schema:'finnor.x1.frontend-installation.v1',mode:'DEVELOPMENT_ONLY',source,sourcePreimages,
  runtime:{node:process.version,platform:process.platform,arch:process.arch,nodeBinarySha256:await fileHash(process.execPath)},
  nextVersion:JSON.parse(await readFile(createRequire(import.meta.url).resolve('next/package.json'),'utf8')).version,
  buildId,frontendOrigin:origin.origin,entrypoint:server,files,links,outputBytes,elapsedMs:Date.now()-started,limits,
  authTransport:'SAME_ORIGIN_AUTH_V1_TO_EXISTING_DISPOSABLE_AUTH_OWNER',productionActive:false,
  protectedQualification:false,executionAuthorityGranted:false,monetaryCost:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
await writeFile(join(output,'x1-frontend-installation.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o444});
console.log(JSON.stringify({event:'X1_FRONTEND_COMPILED',output,source,buildId,entrypoint:server,
  actualFiles:files.length,links:links.length,outputBytes,elapsedMs:manifest.elapsedMs,productionActive:false}));
