/** Explicit disk-heavy verifier for a packet-reconstructed checkout. It does
 * not recycle, delete or borrow any existing source/dependency/database tree. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,realpathSync,lstatSync,readdirSync,existsSync,statfsSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute,sep} from 'node:path';
const checkout=resolve(import.meta.dirname,'../../..'),backend=join(checkout,'finnor-os'),
 evidence=process.env.FINNOR_Y3_RECONSTRUCTION_EVIDENCE,packet=process.env.FINNOR_Y3_SOURCE_PACKET,temporary=process.env.FINNOR_Y3_TMPDIR;
assert([evidence,packet,temporary].every(v=>v&&isAbsolute(v)),'ABSOLUTE_RECONSTRUCTION_EVIDENCE_PACKET_AND_TEMP_REQUIRED');
assert.equal(process.env.FINNOR_Y3_ALLOW_DISK_HEAVY_VERIFICATION,'1','EXPLICIT_DISK_HEAVY_VERIFICATION_OPT_IN_REQUIRED');
assert.equal(process.versions.node.split('.')[0],'22');
assert(!existsSync(join(checkout,'node_modules'))&&!existsSync(join(backend,'node_modules')),'NEW_DEPENDENCY_FREE_CHECKOUT_REQUIRED');
assert(!existsSync(join(checkout,'.next'))&&!existsSync(join(backend,'apps/api/.next')),'NO_BORROWED_BUILD_OUTPUT');
assert(!existsSync(join(checkout,'.git/objects/info/alternates')),'NO_DONOR_GIT_ALTERNATES');
mkdirSync(evidence,{recursive:true});mkdirSync(temporary,{recursive:true});
const source=JSON.parse(readFileSync(join(packet,'source.json'),'utf8')),
 plan=JSON.parse(readFileSync(join(checkout,'scope-postx/y3-dynamic-interaction-synthesizer/verification-plan.json'),'utf8')),
 commands=[],meters=[],started=Date.now(),
 hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),
 git=(...args)=>{const r=spawnSync('git',['-C',checkout,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
assert.equal(source.schema,'finnor.y3.source-preimage.v1');
assert.equal(git('rev-parse','HEAD'),source.commit);assert.equal(git('rev-parse','HEAD^{tree}'),source.tree);
assert.equal(git('status','--porcelain','--untracked-files=all'),'');
assert.equal(resolve(checkout,git('rev-parse','--git-common-dir')),join(checkout,'.git'),'STANDALONE_RECONSTRUCTED_GIT_REQUIRED');
assert.equal(readFileSync(join(checkout,'.git/shallow'),'utf8').trim(),source.commit);
const locks=['package-lock.json','finnor-os/package-lock.json'].map(path=>({path,sha256:hash(join(checkout,path))}));
const roots=[checkout,temporary,evidence,packet].map(path=>realpathSync(path)).sort().filter((path,index,all)=>
 !all.some((parent,i)=>i!==index&&path.startsWith(parent+sep))).filter((path,index,all)=>all.indexOf(path)===index);
const env={PATH:dirname(process.execPath)+':'+process.env.PATH,HOME:process.env.HOME,TMPDIR:temporary,
 NODE_ENV:'test',NODE_OPTIONS:'--max-old-space-size=4096',NEXT_TELEMETRY_DISABLED:'1'};
let installs=0,workspaceLinks=0,passed=false,mathEvidence=null;
function meter(step){
 const result=spawnSync('du',['-s','-B1',...roots],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const ownedBytes=result.stdout.trim().split('\n').reduce((sum,line)=>sum+Number(line.split(/\s/)[0]),0),
  free=roots.map(path=>{const s=statfsSync(path);return {path,bytes:Number(s.bavail)*Number(s.bsize)};});
 meters.push({step,atMs:Date.now()-started,ownedBytes,free});
 assert(ownedBytes<=plan.limits.taskStorageBytes,'FROZEN_TASK_STORAGE_BOUND');
 assert(free.every(v=>v.bytes>=134217728),'MINIMUM_FREE_STORAGE_BOUND');
 assert(Date.now()-started<plan.limits.campaignWallMs,'FROZEN_CAMPAIGN_WALL_BOUND');
}
function run(name,command,args,cwd=backend,extra={}){
 meter(name);
 const log=join(evidence,String(commands.length+1).padStart(2,'0')+'-'+name+'.log'),fd=openSync(log,'wx'),at=Date.now();
 let result,overBound=false;try{
  result=spawnSync(command,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe'],maxBuffer:plan.limits.outputBytes,
   timeout:Math.min(plan.limits.commandWallMs,plan.limits.campaignWallMs-(Date.now()-started))});
  const output=Buffer.concat([Buffer.from('[stdout]\n'),result.stdout??Buffer.alloc(0),Buffer.from('\n[stderr]\n'),result.stderr??Buffer.alloc(0)]);
  overBound=output.length>plan.limits.outputBytes;writeFileSync(fd,output.subarray(0,plan.limits.outputBytes));
 }finally{closeSync(fd);}
 commands.push({name,command,args,cwd,exitCode:result.status,signal:result.signal,wallMs:Date.now()-at,log,sha256:hash(log),outputBoundExceeded:overBound});
 assert(!overBound,'FROZEN_COMMAND_OUTPUT_BOUND');
 assert.equal(result.status,0,'RECONSTRUCTION_STEP_FAILED:'+name);meter(name+'-complete');
 console.log('Y3_RECONSTRUCTION_STEP_PASS',name);
}
try{
 const ci=['ci','--ignore-scripts','--no-audit','--no-fund','--offline'];
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
 run('migration-bundle','npm',['run','db:bundle']);run('openapi','npm',['run','openapi']);
 for(const name of ['centropy:client:check','centropy:manifest:check','centropy:forms:check','centropy:coverage:check'])
  run(name.replaceAll(':','-'),'npm',['run',name],checkout);
 run('owner-domain-boundary','npm',['run','release:pe-domain-boundary']);run('native-action-manifest','npm',['run','release:manifest']);
 run('zero-water-resurrection','npm',['run','release:p8-zero-resurrection'],checkout);
 run('emitted-api-build',process.execPath,['--import=tsx','scripts/y3/build-api.mts'],backend,{FINNOR_Y3_ALLOW_DISK_HEAVY_VERIFICATION:'1'});
 run('emitted-worker-build',process.execPath,['--import=tsx','scripts/y3/build-runtime.mts']);
 run('backend-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
 run('verification-script-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','scripts/y3/tsconfig.json']);
 run('exact-math-campaign',process.execPath,['--import=tsx','scripts/y3/run-math.mts'],backend,{FINNOR_Y3_MATH_OUTPUT:join(evidence,'math')});
 const mathDirectories=readdirSync(join(evidence,'math')).filter(path=>path.startsWith('math-'));
 assert.equal(mathDirectories.length,1);mathEvidence=join(evidence,'math',mathDirectories[0],'report.json');
 const mathematics=JSON.parse(readFileSync(mathEvidence,'utf8'));
 assert.equal(mathematics.status,'PASS');assert.equal(mathematics.results.length,20);
 run('installed-native-owner-campaign',process.execPath,['--import=tsx','scripts/y3/run-installed.mts'],backend,
  {FINNOR_Y3_BUILT_API:'1',FINNOR_Y3_EVIDENCE_DIR:join(evidence,'installed')});
 run('frontend-typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],checkout);
 run('emitted-frontend-build','npm',['run','build'],checkout,{NODE_ENV:'production',
  NEXT_PUBLIC_OS_API_URL:'http://127.0.0.1:1',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:1',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'y3-disposable-unconnected-build-only'});
 assert.equal(git('status','--porcelain','--untracked-files=all'),'','RECONSTRUCTION_GENERATED_SOURCE_DRIFT');
 meter('complete');passed=true;
}finally{
 const report={schema:'finnor.y3.clean-reconstruction.v1',status:passed?'PASS_FRESH_LOCKFILE_RECONSTRUCTION':'FAILED_RETAINED',
  commit:source.commit,tree:source.tree,sourcePacket:packet,checkout,commands,meters,wallMs:Date.now()-started,locks,
  freshLockfileInstalls:installs,borrowedDependenciesUsedForBuild:installs===2?false:'BUILD_NOT_REACHED',
  workspaceLinksWithinCheckout:workspaceLinks>0,workspaceLinkCount:workspaceLinks,noGitAlternates:true,
  temporaryStorageRoot:temporary,temporaryStorageIncludedInMeters:true,retainedDatabases:true,
  installedEvidence:join(evidence,'installed'),mathematicalEvidence:mathEvidence,
  frontendQualification:'EMITTED_BUILD_ONLY_NO_RECONSTRUCTED_BROWSER_PROOF',browserEvidence:null,
  protectedQualification:false,productionActivated:false,sourceParity:'UNKNOWN',realEconomicEffects:0,
  unknownCosts:{moneyUsd:null,humanSeconds:null,aggregateConcurrentPeakMemoryBytes:null}};
 writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log('Y3_FRESH_RECONSTRUCTION_PASS');
