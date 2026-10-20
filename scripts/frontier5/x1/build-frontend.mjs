import { spawn,spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, statfsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, cp } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {frontendTracingLayout} from './frontend-tracing-root.mjs';

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
const layout=frontendTracingLayout(repo);
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
  tracingLayout:layout,
  elapsedMs:Date.now()-started,coordinatorCpuMicros:process.cpuUsage(cpuBefore),humanSeconds:null,
  monetaryCost:null,aggregatePeakMemoryBytes:null},null,2)+'\n',{flag:'wx',mode:0o600});
if(guardFailure||ending.code!==0||ending.signal)throw Error(guardFailure??'X1_FRONTEND_BUILD_FAILED');
const {projectPath}=layout,runtime=join(output,'runtime');
await rename(join(buildDir,'standalone'),runtime);
await cp(join(buildDir,'static'),join(runtime,projectPath,'.next-x1-install/static'),{recursive:true,errorOnExist:true,force:false});
await cp(join(repo,'public'),join(runtime,projectPath,'public'),{recursive:true,errorOnExist:true,force:false});
// Finalization verifies copied dependency bytes, normalizes only internal links,
// checks the actual compiled public auth origin and accepts only Next's exact
// generated type-input changes. The original successful compile is retained.
const remainingMs=limits.finalBuildWallSeconds*1000-(Date.now()-started);
if(remainingMs<=0)throw Error('X1_FINAL_BUILD_WALL_BOUND');
const finalized=spawnSync(process.execPath,['--max-old-space-size=512',join(repo,'scripts/frontier5/x1/finalize-frontend.mjs'),
  '--output',output,'--origin',origin.origin],{cwd:repo,stdio:'inherit',timeout:remainingMs,
  env:{...process.env,NODE_OPTIONS:''}});
if(finalized.error||finalized.signal||finalized.status!==0)throw Error('X1_FRONTEND_FINALIZATION_FAILED');
const manifest=JSON.parse(await readFile(join(output,'x1-frontend-installation.json'),'utf8'));
if(manifest.source.commit!==source.commit||manifest.source.tree!==source.tree)throw Error('X1_FRONTEND_BUILD_CUT_CHANGED');
console.log(JSON.stringify({event:'X1_FRONTEND_COMPILED_AND_FINALIZED',output,source,buildId:manifest.buildId,
  actualFiles:manifest.files.length,links:manifest.links.length,outputBytes:manifest.outputBytes,
  elapsedMs:Date.now()-started,productionActive:false}));
