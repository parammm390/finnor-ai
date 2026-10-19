#!/usr/bin/env node
/** Run from a fresh clone of the delivery bundle, using ordinary lock installs.
 * No donor node_modules, stored scientific rows, credentials or receipts. */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),os=join(root,'finnor-os');
assert.equal(process.versions.node.split('.')[0],'22','Use the supported Node 22 runtime');
const index=process.argv.indexOf('--evidence-dir');
const evidence=index<0?join(tmpdir(),'finnor-x4-reconstruction-'+randomUUID()):process.argv[index+1];
assert(evidence&&isAbsolute(evidence),'--evidence-dir must name a fresh absolute directory');
await mkdir(evidence,{recursive:false});
const sha=value=>createHash('sha256').update(value).digest('hex');
const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const initialStatus=git('status','--porcelain');assert.equal(initialStatus,'','Reconstruct from a clean fresh clone');
const report={schema:'finnor.x4.reconstruction.v1',status:'RUNNING',commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),
 root,node:process.version,abi:process.versions.modules,platform:process.platform,architecture:process.arch,startedAt:new Date().toISOString(),steps:[],
 qualification:'SAME_HOST_FRESH_ORDINARY_LOCK_INSTALL_AND_EMITTED_RUNTIME_NOT_CLEAN_OS_IMAGE_OR_PROTECTED_CUSTODY',
 borrowedDependencies:false,terminalScientificRowsInserted:0,protectedAdmission:false,productionActive:false};
const env={PATH:dirname(process.execPath)+':'+(process.env.PATH??'/usr/bin:/bin'),HOME:process.env.HOME,LANG:process.env.LANG??'C.UTF-8',
 TMPDIR:process.env.TMPDIR,CI:'1',NEXT_TELEMETRY_DISABLED:'1',NODE_OPTIONS:'--max-old-space-size=4096'};
const locks=['package-lock.json','finnor-os/package-lock.json'];
report.lockDigests=await Promise.all(locks.map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
async function run(id,cwd,command,args,extra={},timeoutMs=600000){
 const log=join(evidence,id+'.log'),output=createWriteStream(log,{flags:'wx'}),started=Date.now();
 const child=spawn(command,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
 let timedOut=false,killer;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');killer=setTimeout(()=>child.kill('SIGKILL'),5000);},timeoutMs);
 let result;
 try{result=await new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});}
 finally{clearTimeout(timer);clearTimeout(killer);await new Promise((yes,no)=>{output.once('error',no);output.end(yes);});}
 const step={id,command:[command,...args],cwd,log,wallMs:Date.now()-started,...result,timedOut};report.steps.push(step);
 await writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log('X4_RECONSTRUCTION_STEP',id,result.code,timedOut?'TIMEOUT':'');
 assert.equal(result.code,0,id+' failed; inspect '+log);assert.equal(timedOut,false);
}
try{
 await run('01-root-lock-install',root,'npm',['ci','--no-audit','--no-fund']);
 await run('02-backend-lock-install',os,'npm',['ci','--no-audit','--no-fund']);
 for(const n of ['3','5','4'])await run('03-source-stamp-x'+n,os,process.execPath,['--import=tsx','scripts/x'+n+'/stamp-source.mts','--check']);
 await run('04-backend-types',os,process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json','--pretty','false']);
 await run('05-campaign-types',os,process.execPath,['node_modules/typescript/bin/tsc','-p','scripts/x4/tsconfig.json','--pretty','false']);
 await run('06-frontend-types',root,process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--pretty','false']);
 await run('07-ui-lint',root,process.execPath,['node_modules/eslint/bin/eslint.js',
  'src/components/centropy/canvas/IdentifiedSystemPanel.tsx','src/components/centropy/canvas/CanvasDocument.tsx',
  'src/components/centropy/canvas/canvas-compose.ts','src/components/centropy/canvas/canvas-contract.ts']);
 await run('08-generated-contracts',root,'npm',['run','release:generated-preflight']);
 await run('09-emitted-api-build',join(os,'apps/api'),process.execPath,[join(os,'node_modules/next/dist/bin/next'),'build'],
  {FINNOR_BUILD_ID:'x4-reconstruction-'+report.commit.slice(0,12)},900000);
 await run('10-source-trace-and-native-ABI',os,process.execPath,['--import=tsx','scripts/x4/audit-source.mts'],
  {FINNOR_X4_EVIDENCE_DIR:join(evidence,'source-audit')});
 await run('11-emitted-frontend-build',root,process.execPath,['node_modules/next/dist/bin/next','build'],
  {NEXT_PUBLIC_OS_API_URL:'http://127.0.0.1:1',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:2',NEXT_PUBLIC_SUPABASE_ANON_KEY:'x4-disposable-reconstruction-public-key'},900000);
 await run('12-emitted-physical-owner-campaign',os,process.execPath,['--import=tsx','scripts/x4/run-installed.mts'],
  {FINNOR_X4_BUILT_API:'1',FINNOR_X4_SECURITY_PROOFS:'1',FINNOR_X4_DATABASE_PROOFS:'1',FINNOR_X4_S8:'1',FINNOR_X4_REPEAT_REPLICA:'1',
   FINNOR_X4_EVIDENCE_DIR:join(evidence,'installed')},600000);
 const receipt=JSON.parse(await readFile(join(evidence,'installed/receipt.json'),'utf8'));assert.equal(receipt.allPassed,true);
 const afterLocks=await Promise.all(locks.map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
 assert.deepEqual(afterLocks,report.lockDigests);report.finalTrackedDiff=git('diff','--stat');assert.equal(report.finalTrackedDiff,'');
 report.status='PASS_FRESH_ORDINARY_INSTALL_EMITTED_DEVELOPMENT';report.finishedAt=new Date().toISOString();
 report.sourceAudit=JSON.parse(await readFile(join(evidence,'source-audit/release-source-audit.json'),'utf8'));
 report.receipt=receipt;
}catch(error){report.status='FAILED_RETAINED';report.error=String(error);report.stack=error.stack;process.exitCode=1;}
await writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n');
console.log('X4_RECONSTRUCTION_RESULT',report.status,evidence);
