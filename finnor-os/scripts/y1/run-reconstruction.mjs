/** Repeat the real installed and mounted path from a packet-only checkout. */
import {strict as assert} from 'node:assert';
import {spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,renameSync,symlinkSync,realpathSync,lstatSync,readdirSync,existsSync,statfsSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute,sep} from 'node:path';
const checkout=resolve(import.meta.dirname,'../../..'),backend=join(checkout,'finnor-os'),
 evidence=process.env.FINNOR_Y1_RECONSTRUCTION_EVIDENCE,packet=process.env.FINNOR_Y1_SOURCE_PACKET,
 temporary=process.env.FINNOR_Y1_TMPDIR;
assert([evidence,packet,temporary].every(v=>v&&isAbsolute(v)),'ABSOLUTE_RECONSTRUCTION_EVIDENCE_SOURCE_PACKET_AND_TEMP_REQUIRED');
assert.equal(process.versions.node.split('.')[0],'22');
mkdirSync(evidence,{recursive:true});
mkdirSync(temporary,{recursive:true});
const source=JSON.parse(readFileSync(join(packet,'source.json'),'utf8')),commands=[],meters=[],started=Date.now();
const env={...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH,NODE_OPTIONS:'--max-old-space-size=4096',TMPDIR:temporary,NEXT_TELEMETRY_DISABLED:'1'};
delete env.NODE_PATH;
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),
 git=(...args)=>{const r=spawnSync('git',['-C',checkout,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
assert.equal(git('rev-parse','HEAD'),source.commit);assert.equal(git('rev-parse','HEAD^{tree}'),source.tree);
assert.equal(git('status','--porcelain','--untracked-files=all'),'');
let installs=0,workspaceLinks=0,passed=false,fixture;
const locks=['package-lock.json','finnor-os/package-lock.json'].map(path=>({path,sha256:hash(join(checkout,path))}));
const storageRoots=[...new Set([...(process.env.FINNOR_Y1_STORAGE_ROOTS??checkout).split(':'),temporary])];
assert(storageRoots.every(isAbsolute));
function meter(step){
 const result=spawnSync('du',['-s','-B1',...storageRoots],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const ownedBytes=result.stdout.trim().split('\n').reduce((sum,line)=>sum+Number(line.split(/\s/)[0]),0);
 const free=storageRoots.map(path=>{const s=statfsSync(path);return {path,bytes:Number(s.bavail)*Number(s.bsize)};});
 meters.push({step,atMs:Date.now()-started,ownedBytes,free});
 assert(ownedBytes<=3758096384,'FROZEN_OWNED_STORAGE_BOUND');assert(free.every(v=>v.bytes>=134217728),'FROZEN_FREE_STORAGE_BOUND');
 assert(Date.now()-started<1800000,'FROZEN_RECONSTRUCTION_WALL_BOUND');
}
function run(name,command,args,cwd=backend,extra={}){
 meter(name);
 const log=join(evidence,String(commands.length+1).padStart(2,'0')+'-'+name+'.log'),fd=openSync(log,'wx'),at=Date.now();
 let result;try{result=spawnSync(command,args,{cwd,env:{...env,...extra},stdio:['ignore',fd,fd],timeout:Math.min(720000,1800000-(Date.now()-started))});}finally{closeSync(fd);}
 commands.push({name,command,args,cwd,exitCode:result.status,signal:result.signal,wallMs:Date.now()-at,log,logSha256:hash(log)});
 assert.equal(result.status,0,'RECONSTRUCTION_STEP_FAILED:'+name);
 console.log('Y1_RECONSTRUCTION_STEP_PASS',name);
}
try{
 // Recycle only this task's disposable install location. npm ci then removes
 // and replaces both trees before any producer, build or verifier is run.
 const recycle=process.env.FINNOR_Y1_RECYCLE_TASK_DEPENDENCIES;
 if(recycle){
  assert(isAbsolute(recycle));assert.notEqual(realpathSync(recycle),checkout);
  for(const sub of ['node_modules','finnor-os/node_modules']){
   const old=join(recycle,sub),target=join(checkout,sub);
   assert(lstatSync(old).isDirectory()&&!lstatSync(old).isSymbolicLink());assert(!existsSync(target));
   renameSync(old,target);symlinkSync(target,old,'dir');
  }
 }
 const ci=['ci','--ignore-scripts','--no-audit','--no-fund',...(process.env.FINNOR_Y1_NPM_OFFLINE==='1'?['--offline']:[])];
 run('root-fresh-npm-ci','npm',ci,checkout);installs++;
 run('backend-fresh-npm-ci','npm',ci);installs++;
 for(const lock of locks)assert.equal(hash(join(checkout,lock.path)),lock.sha256);
 const namespace=join(backend,'node_modules/@finnor');
 for(const name of readdirSync(namespace)){
  const path=join(namespace,name);if(!lstatSync(path).isSymbolicLink())continue;
  assert(realpathSync(path).startsWith(checkout+sep),'FOREIGN_WORKSPACE_DEPENDENCY');workspaceLinks++;
 }
 assert(workspaceLinks>0);
 run('native-locked-dependency-rebuild','npm',['rebuild','--offline','fs-ext','embedded-postgres',
  '@embedded-postgres/'+process.platform+'-'+process.arch]);
 run('migration-bundle','npm',['run','db:bundle']);
 run('openapi','npm',['run','openapi']);
 for(const name of ['centropy:client:check','centropy:manifest:check','centropy:forms:check','centropy:coverage:check'])
  run(name.replaceAll(':','-'),'npm',['run',name],checkout);
 run('owner-domain-boundary','npm',['run','release:pe-domain-boundary']);
 run('native-action-manifest','npm',['run','release:manifest']);
 run('zero-water-resurrection','npm',['run','release:p8-zero-resurrection'],checkout);
 // Only generated output storage may be reused to respect the frozen disk
 // budget. Source, Git objects and installed dependency trees stay independent.
 const outputOwner=process.env.FINNOR_Y1_REBUILD_OUTPUT_OWNER;
 if(outputOwner){
  assert(isAbsolute(outputOwner));assert.notEqual(realpathSync(outputOwner),checkout);
  for(const sub of ['.next','finnor-os/apps/api/.next']){
   const target=join(checkout,sub),old=join(outputOwner,sub);
   assert(lstatSync(old).isDirectory()&&!lstatSync(old).isSymbolicLink());
   if(existsSync(target))assert(lstatSync(target).isSymbolicLink()&&realpathSync(target)===realpathSync(old),'FOREIGN_GENERATED_OUTPUT_STORAGE');
   else symlinkSync(old,target,'dir');
  }
 }
 run('emitted-api-build','npm',['run','build','--workspace','@finnor/api']);
 run('emitted-worker-build',process.execPath,['--import=tsx','scripts/y1/build-runtime.mts']);
 run('backend-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
 run('verification-script-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','scripts/y1/tsconfig.json']);
 const installedEvidence=join(evidence,'installed');
 run('installed-native-owner-campaign',process.execPath,['--import=tsx','scripts/y1/run-installed.mts'],backend,
  {FINNOR_Y1_BUILT_API:'1',FINNOR_Y1_EVIDENCE_DIR:installedEvidence});
 const browserEvidence=join(evidence,'mounted'),log=join(evidence,'mounted-fixture.log'),fd=openSync(log,'wx');
 fixture=spawn(process.execPath,['--import=tsx','scripts/y1/run-mounted.mts'],{cwd:backend,env:{...env,FINNOR_Y1_EVIDENCE_DIR:browserEvidence},stdio:['ignore','pipe','pipe']});
 for(const stream of [fixture.stdout,fixture.stderr])stream.on('data',data=>writeFileSync(fd,data));
 const at=Date.now();
 await new Promise((yes,no)=>{
  const timer=setTimeout(()=>no(Error('RECONSTRUCTED_MOUNTED_READY_DEADLINE')),240000);
  fixture.once('error',error=>{clearTimeout(timer);no(error);});
  fixture.once('exit',code=>{clearTimeout(timer);no(Error('RECONSTRUCTED_MOUNTED_EARLY_EXIT:'+code));});
  let output='';fixture.stdout.on('data',data=>{output+=data;if(output.includes('Y1_MOUNTED_FIXTURE_READY')){clearTimeout(timer);yes();}});
 });
 run('mounted-browser-campaign',process.execPath,['--import=tsx','scripts/y1/browser-checks.mts'],backend,{FINNOR_Y1_EVIDENCE_DIR:browserEvidence});
 const code=await new Promise(yes=>fixture.once('close',yes));closeSync(fd);assert.equal(code,0);
 commands.push({name:'emitted-mounted-frontend-fixture',exitCode:code,wallMs:Date.now()-at,log,logSha256:hash(log)});
 run('frontend-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],checkout);
 assert.equal(git('status','--porcelain','--untracked-files=all'),'','RECONSTRUCTION_GENERATED_SOURCE_DRIFT');
 meter('complete');
 passed=true;
}finally{
 if(fixture?.pid&&fixture.exitCode===null&&fixture.signalCode===null)await new Promise(yes=>{
  const timer=setTimeout(()=>fixture.kill('SIGKILL'),15000);
  fixture.once('close',()=>{clearTimeout(timer);yes();});
  fixture.kill('SIGTERM');
 });
 const result={schema:'finnor.y1.clean-reconstruction.v1',status:passed?'PASS_FRESH_LOCKFILE_RECONSTRUCTION':'FAILED_RETAINED',
  commit:source.commit,tree:source.tree,sourcePacket:packet,checkout,commands,meters,wallMs:Date.now()-started,locks,
  freshLockfileInstalls:installs,borrowedDependenciesUsedForBuild:installs===2?false:'BUILD_NOT_REACHED',
  workspaceLinksWithinCheckout:workspaceLinks>0,workspaceLinkCount:workspaceLinks,
  generatedOutputStorageRebuiltAt:process.env.FINNOR_Y1_REBUILD_OUTPUT_OWNER??checkout,
  compilerOutputStorageShared:!!process.env.FINNOR_Y1_REBUILD_OUTPUT_OWNER,
  temporaryStorageRoot:temporary,temporaryStorageIncludedInMeters:true,
  installedEvidence:join(evidence,'installed'),browserEvidence:join(evidence,'mounted'),
  protectedQualification:false,productionActivated:false,realEconomicEffects:0,
  unknownCosts:{moneyUsd:null,humanSeconds:null,aggregateConcurrentPeakMemoryBytes:null}};
 writeFileSync(join(evidence,'reconstruction.json'),JSON.stringify(result,null,2)+'\n');
}
console.log('Y1_FRESH_RECONSTRUCTION_PASS');
