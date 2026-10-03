import {strict as assert} from 'node:assert';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {launchIsolatedNodeExecutor} from '../../packages/governed-execution/src/executor.js';
const root=await realpath(await mkdtemp(join(tmpdir(),'finnor-s6-executor-'))),output=resolve(process.env.FINNOR_S6_EXECUTOR_EVIDENCE_DIR??'../scope-6/scope-evidence/executor-local');await mkdir(dirname(output),{recursive:true});await mkdir(output);
const secretPath=join(root,'protected-key'),outside=join(root,'outside-write');const sentinel=randomUUID();await writeFile(secretPath,sentinel,{mode:0o600});await writeFile(outside,'UNCHANGED');
let connections=0;const listener=createServer(socket=>{connections++;socket.end('FORBIDDEN');});await new Promise<void>(done=>listener.listen(0,'127.0.0.1',done));const port=(listener.address() as any).port;
const sourcePaths=['packages/governed-execution/src/executor.ts','packages/governed-execution/src/adapter-contract.ts','packages/governed-execution/src/protocol.ts','scripts/s6/run-executor-e2e.mts'];
async function sourceSnapshot(){return Promise.all(sourcePaths.map(async path=>({path:resolve(path),sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));}
const sourcesBefore=await sourceSnapshot(),source=(await readFile(sourcePaths[0]!)).toString();const results:any[]=[];
async function challenge(id:string,fn:()=>Promise<any>){try{results.push({id,status:'PASS',observed:await fn()});}catch(e){results.push({id,status:'FAIL',error:String(e)});}await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.s6.executor-e2e.v1',results,node:process.version,sourceDigest:createHash('sha256').update(source).digest('hex'),sourcesBefore,rerun:'FINNOR_S6_EXECUTOR_EVIDENCE_DIR=<new-evidence-directory> node --import=tsx scripts/s6/run-executor-e2e.mts',qualification:'Actual local Seatbelt process challenges; no production admission or hard CPU/pid/disk/total-memory quotas'},null,2)+'\n');console.log(JSON.stringify({id,status:results.at(-1).status}));}
try{
 await challenge('positive-computation-and-scratch-only-write',async()=>{const r=await launchIsolatedNodeExecutor({script:"import {writeFile} from 'node:fs/promises';await writeFile('result','scratch');console.log(JSON.stringify({value:7*6,credential:process.env.DATABASE_URL??null}));",input:{obligation:'untrusted-test-input'},wallTimeMs:10000});await writeFile(join(output,'execution-'+randomUUID()+'.json'),JSON.stringify(r,null,2));assert.equal(r.exitCode,0,JSON.stringify(r));assert.deepEqual(JSON.parse(r.stdout),{value:42,credential:null});return r;});
 await challenge('hostile-secret-files-network-write-and-child',async()=>{const script=`import {readFile,writeFile,symlink} from 'node:fs/promises';import {connect} from 'node:net';import {spawnSync} from 'node:child_process';const attempts=[];for(const [name,fn] of [['secret',()=>readFile(${JSON.stringify(secretPath)},'utf8')],['host-write',()=>writeFile(${JSON.stringify(outside)},'COMPROMISED')],['parent-write',()=>writeFile('../escaped','COMPROMISED')],['symlink',async()=>{await symlink(${JSON.stringify(secretPath)},'key-link');return readFile('key-link','utf8');}],['network',()=>new Promise((yes,no)=>{const s=connect(${port},'127.0.0.1');s.once('connect',()=>{s.end();yes('CONNECTED')});s.once('error',no);})]]){try{attempts.push({name,result:await fn()});}catch(e){attempts.push({name,error:e.code??String(e)});}}const child=spawnSync(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(outside)},'CHILD_COMPROMISED')`)}],{encoding:'utf8'});console.log(JSON.stringify({attempts,child:{status:child.status,stderr:child.stderr}}));`;
  const r=await launchIsolatedNodeExecutor({script,input:{obligation:'untrusted-test-input'},wallTimeMs:10000});await writeFile(join(output,'execution-'+randomUUID()+'.json'),JSON.stringify(r,null,2));assert.equal(r.exitCode,0,JSON.stringify(r));const observed=JSON.parse(r.stdout);assert(observed.attempts.every((a:any)=>a.error),r.stdout);assert.notEqual(observed.child.status,0);assert.equal(await readFile(outside,'utf8'),'UNCHANGED');assert(!r.stdout.includes(sentinel));assert.equal(connections,0);return {execution:r,observer:{connections,outside:'UNCHANGED'}};});
 await challenge('detached-child-cannot-outlive-supervisor',async()=>{
  const marker='finnor-s6-detached-'+randomUUID(),childCode=`const marker=${JSON.stringify(marker)};setInterval(()=>{},1000);`;
  const script=`import {spawn} from 'node:child_process';const denied=e=>{console.log(JSON.stringify({spawnDenied:true,error:e.code}));process.exit(0);};try{const child=spawn(process.execPath,['--eval',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});child.once('error',denied);child.once('spawn',()=>{console.log(JSON.stringify({pid:child.pid}));child.unref();});setInterval(()=>{},1000);}catch(e){denied(e);}`;
  const execution=await launchIsolatedNodeExecutor({script,input:{obligation:'disposable-detached-process-challenge'},wallTimeMs:1000});
  const observation=execution.stdout.trim()?JSON.parse(execution.stdout.trim()):null;
  let osLookup:any=null,osCensus:any=null,aliveOwnedChild=false,cleanup:string|null=null,cleanupObservation:any=null;
  try{
   assert(observation,'Independent lifecycle challenge never reached process creation');
   if(observation.pid!==undefined){
    assert(Number.isSafeInteger(observation.pid)&&observation.pid>1,'Invalid producer PID lookup candidate');
    const ps=spawnSync('/bin/ps',['-p',String(observation.pid),'-o','pid=,ppid=,pgid=,uid=,command='],{encoding:'utf8',timeout:3000});
    osLookup={exitCode:ps.status,stdout:ps.stdout.trim(),stderr:ps.stderr.trim()};
    assert(ps.status===0||ps.status===1,'OS lookup failed');
    aliveOwnedChild=ps.status===0&&ps.stdout.includes(marker);
    assert(!ps.stdout.trim()||aliveOwnedChild,'PID lookup was not the marked test-owned process');
   }else{
    assert.equal(observation.spawnDenied,true,'No independent process or definite spawn refusal');
    assert(['EPERM','EACCES'].includes(observation.error),'Unexpected process creation failure');
    assert.equal(execution.exitCode,0,'Challenge did not report the attempted spawn refusal');
   }
   const census=spawnSync('/bin/ps',['-axo','pid=,ppid=,pgid=,uid=,command='],{encoding:'utf8',timeout:3000});
   osCensus={exitCode:census.status,markedProcesses:census.stdout.split('\n').filter(line=>line.includes(marker)),stderr:census.stderr.trim()};
   assert.equal(census.status,0,'Independent OS process census failed');
   assert.equal(osCensus.markedProcesses.length,aliveOwnedChild?1:0,'Independent census disagreed with exact-PID observation');
  }finally{
   if(aliveOwnedChild){
    process.kill(observation.pid,'SIGKILL');cleanup='SIGKILL_CONFIRMED_TEST_OWNED_DESCENDANT_NOT_PRODUCTION_PROOF';
    for(let check=0;check<10;check++){
     const ps=spawnSync('/bin/ps',['-p',String(observation.pid),'-o','pid=,stat=,uid=,command='],{encoding:'utf8',timeout:3000});
     cleanupObservation={exitCode:ps.status,stdout:ps.stdout.trim(),stderr:ps.stderr.trim()};
     if(ps.status===1||/\sZ\S*\s/.test(ps.stdout))break;
     await new Promise(done=>setTimeout(done,100));
    }
   }
   await writeFile(join(output,'detached-child-lifecycle.json'),JSON.stringify({schema:'finnor.s6.executor-lifecycle-challenge.v1',inputs:{script,childCode,marker,wallTimeMs:1000},execution,observation,osLookup,osCensus,aliveOwnedChild,cleanup,cleanupObservation,qualification:'Actual confined worker plus independent host process lookup; no aggregate hard quota or production admission'},null,2)+'\n');
  }
  assert.equal(aliveOwnedChild,false,'Detached Node child survived its supervisor wall limit');
  return {execution,observation,osLookup,osCensus,aliveOwnedChild,cleanup,cleanupObservation};
 });
 await challenge('wall-time-and-output-resource-bound',async()=>{const timed=await launchIsolatedNodeExecutor({script:'while(true){}',input:{},wallTimeMs:250});await writeFile(join(output,'timeout-execution.json'),JSON.stringify(timed,null,2));assert.equal(timed.termination,'WALL_TIME_LIMIT');const flooded=await launchIsolatedNodeExecutor({script:"import {once} from 'node:events';while(true){if(!process.stdout.write('x'.repeat(65536)))await once(process.stdout,'drain');}",input:{},wallTimeMs:10000});await writeFile(join(output,'flooded-execution.json'),JSON.stringify(flooded,null,2));assert.equal(flooded.termination,'OUTPUT_LIMIT');assert(flooded.stdout.length+flooded.stderr.length<=131072);
  const requirements={cpuTimeMs:10,totalMemoryBytes:1048576,threads:1,diskBytes:1};
  await assert.rejects(()=>launchIsolatedNodeExecutor({script:"console.log('unsupported hard quota must refuse before execution')",input:{},wallTimeMs:10000,requiredLimits:requirements} as any),/EXECUTOR_RESOURCE_BOUND_UNAVAILABLE/);
  await assert.rejects(()=>launchIsolatedNodeExecutor({script:"console.log('no protected promotion')",input:{},wallTimeMs:10000,protectedExecution:true} as any),/EXECUTOR_PROTECTED_CLASS_UNADMITTED/);
  return {timed,flooded:{...flooded,stdoutLength:flooded.stdout.length,stdout:undefined},unsupportedRequirements:requirements,refusedBeforeExecution:true};});
}finally{await new Promise<void>(done=>listener.close(()=>done()));}
const sourcesAfter=await sourceSnapshot(),sourcesUnchanged=JSON.stringify(sourcesBefore)===JSON.stringify(sourcesAfter);
await writeFile(join(output,'source-freeze.json'),JSON.stringify({sourcesBefore,sourcesAfter,sourcesUnchanged},null,2)+'\n');
if(results.some(r=>r.status==='FAIL')||!sourcesUnchanged)process.exitCode=1;
