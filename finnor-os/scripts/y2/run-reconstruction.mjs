/** Independent packet-only source, two fresh lockfile installations, real
 * emitted owner campaign and mounted browser replay. No deployment authority. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,renameSync,symlinkSync,realpathSync,lstatSync,readdirSync,existsSync,statfsSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute,sep} from 'node:path';
const checkout=resolve(import.meta.dirname,'../../..'),backend=join(checkout,'finnor-os'),
 evidence=process.env.FINNOR_Y2_RECONSTRUCTION_EVIDENCE,packet=process.env.FINNOR_Y2_SOURCE_PACKET,temporary=process.env.FINNOR_Y2_TMPDIR;
assert([evidence,packet,temporary].every(v=>v&&isAbsolute(v)),'ABSOLUTE_Y2_RECONSTRUCTION_PATHS_REQUIRED');
assert.equal(process.versions.node.split('.')[0],'22');
mkdirSync(evidence,{recursive:true});mkdirSync(temporary,{recursive:true});
// Reuse the unchanged Y1 generic complete-tree/exact-commit packet codec. This
// schema identifies that codec, not a claim that Y2 is Y1 or production-active.
const source=JSON.parse(readFileSync(join(packet,'source.json'),'utf8')),commands=[],meters=[],started=Date.now();
assert.equal(source.schema,'finnor.y1.source-preimage.v1');
const env={...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH,NODE_OPTIONS:'--max-old-space-size=4096',
 TMPDIR:temporary,NEXT_TELEMETRY_DISABLED:'1'};
delete env.NODE_PATH;
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),
 git=(...args)=>{const r=spawnSync('git',['-C',checkout,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
assert.equal(git('rev-parse','HEAD'),source.commit);assert.equal(git('rev-parse','HEAD^{tree}'),source.tree);
assert.equal(git('status','--porcelain','--untracked-files=all'),'');
const locks=['package-lock.json','finnor-os/package-lock.json'].map(path=>({path,sha256:hash(join(checkout,path))})),
 roots=[...new Set([checkout,evidence,packet,temporary])];
// Frozen before this reconstruction: 30 minutes, 3.5 GiB owned storage,
// 128 MiB free storage, 12 minutes/command. No post-failure threshold changes.
const bounds={wallMs:1800000,ownedBytes:3758096384,minimumFreeBytes:134217728,stepMs:720000};
let installs=0,workspaceLinks=0,passed=false;
function meter(step){
 const r=spawnSync('du',['-s','-B1',...roots],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const ownedBytes=r.stdout.trim().split('\n').reduce((s,line)=>s+Number(line.split(/\s/)[0]),0),
  free=roots.map(path=>{const s=statfsSync(path);return {path,bytes:Number(s.bavail)*Number(s.bsize)};});
 meters.push({step,atMs:Date.now()-started,ownedBytes,free});
 assert(ownedBytes<=bounds.ownedBytes,'Y2_FROZEN_RECONSTRUCTION_STORAGE_BOUND');
 assert(free.every(v=>v.bytes>=bounds.minimumFreeBytes),'Y2_FROZEN_RECONSTRUCTION_FREE_STORAGE_BOUND');
 assert(Date.now()-started<bounds.wallMs,'Y2_FROZEN_RECONSTRUCTION_WALL_BOUND');
}
function run(name,command,args,cwd=backend,extra={}){
 meter(name);const log=join(evidence,String(commands.length+1).padStart(2,'0')+'-'+name+'.log'),fd=openSync(log,'wx'),at=Date.now();
 let r;try{r=spawnSync(command,args,{cwd,env:{...env,...extra},stdio:['ignore',fd,fd],
  timeout:Math.min(bounds.stepMs,bounds.wallMs-(Date.now()-started))});}finally{closeSync(fd);}
 commands.push({name,command,args,cwd,exitCode:r.status,signal:r.signal,wallMs:Date.now()-at,log,logSha256:hash(log)});
 assert.equal(r.status,0,'Y2_RECONSTRUCTION_STEP_FAILED:'+name);console.log('Y2_RECONSTRUCTION_STEP_PASS',name);
}
try{
 // Only this task's disposable dependency directories may be moved. Both npm
 // ci calls replace them completely before any build or verifier can use them.
 const recycle=process.env.FINNOR_Y2_RECYCLE_TASK_DEPENDENCIES;
 if(recycle){
  assert(isAbsolute(recycle));assert.notEqual(realpathSync(recycle),checkout);
  for(const sub of ['node_modules','finnor-os/node_modules']){
   const old=join(recycle,sub),target=join(checkout,sub);
   assert(lstatSync(old).isDirectory()&&!lstatSync(old).isSymbolicLink());assert(!existsSync(target));
   renameSync(old,target);symlinkSync(target,old,'dir');
  }
 }
 const ci=['ci','--ignore-scripts','--no-audit','--no-fund',...(process.env.FINNOR_Y2_NPM_OFFLINE==='1'?['--offline']:[])];
 run('root-fresh-npm-ci','npm',ci,checkout);installs++;
 run('backend-fresh-npm-ci','npm',ci);installs++;
 for(const lock of locks)assert.equal(hash(join(checkout,lock.path)),lock.sha256);
 const namespace=join(backend,'node_modules/@finnor');
 for(const name of readdirSync(namespace)){
  const path=join(namespace,name);if(!lstatSync(path).isSymbolicLink())continue;
  assert(realpathSync(path).startsWith(checkout+sep),'Y2_FOREIGN_WORKSPACE_DEPENDENCY');workspaceLinks++;
 }
 assert(workspaceLinks>0);
 run('locked-native-dependency-rebuild','npm',['rebuild','--offline','fs-ext','embedded-postgres','@embedded-postgres/'+process.platform+'-'+process.arch]);
 run('migration-bundle','npm',['run','db:bundle']);
 run('generated-and-owner-preflight','npm',['run','release:generated-preflight'],checkout);
 run('emitted-api-build','npm',['run','build','--workspace','@finnor/api']);
 run('emitted-worker-build',process.execPath,['--import=tsx','scripts/y2/build-runtime.mts']);
 run('backend-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
 run('campaign-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','scripts/y2/tsconfig.json']);
 const installed=join(evidence,'installed');
 run('installed-native-owner-campaign',process.execPath,['--import=tsx','scripts/y2/run-installed.mts'],backend,
  {FINNOR_Y2_BUILT_API:'1',FINNOR_Y2_EVIDENCE_DIR:installed});
 run('mounted-emitted-browser-campaign',process.execPath,['scripts/y2/run-mounted-campaign.mjs'],backend,
  {FINNOR_Y2_EVIDENCE_DIR:join(evidence,'mounted')});
 run('frontend-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],checkout);
 assert.equal(git('status','--porcelain','--untracked-files=all'),'','Y2_RECONSTRUCTION_GENERATED_SOURCE_DRIFT');
 meter('complete');passed=true;
}finally{
 const result={schema:'finnor.y2.clean-reconstruction.v1',status:passed?'PASS_FRESH_LOCKFILE_RECONSTRUCTION':'FAILED_RETAINED',
  commit:source.commit,tree:source.tree,sourcePacket:packet,checkout,commands,meters,bounds,wallMs:Date.now()-started,locks,
  sourceCodec:'REUSED_UNCHANGED_Y1_EXACT_COMMIT_AND_COMPLETE_TREE_PREIMAGE',freshLockfileInstalls:installs,
  borrowedDependenciesUsedForBuild:installs===2?false:'BUILD_NOT_REACHED',workspaceLinksWithinCheckout:workspaceLinks>0,
  workspaceLinkCount:workspaceLinks,compilerOutputStorageShared:false,temporaryStorageIncludedInMeters:true,
  installedEvidence:join(evidence,'installed'),browserEvidence:join(evidence,'mounted'),protectedQualification:false,
  productionActivated:false,realEconomicEffects:0,unknownCosts:{moneyUsd:null,humanSeconds:null,aggregateConcurrentPeakMemoryBytes:null}};
 writeFileSync(join(evidence,'reconstruction.json'),JSON.stringify(result,null,2)+'\n');
}
console.log('Y2_FRESH_RECONSTRUCTION_PASS');
