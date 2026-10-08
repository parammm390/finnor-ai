import { appendFile } from "node:fs/promises";
/** Existing repository gates against private disposable services; test support. */
import EmbeddedPostgres from 'embedded-postgres';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {mkdtemp,mkdir,writeFile,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const output=resolve('../scope-5/scope-evidence',`repository-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(output,{recursive:true});
const dir=await mkdtemp(join(tmpdir(),'finnor-s5-repository-'));
async function availablePort(){return await new Promise<number>((yes,no)=>{
 const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{
  const port=(server.address() as {port:number}).port;server.close(error=>error?no(error):yes(port));
 });
});}
const port=await availablePort();
const db=new EmbeddedPostgres({databaseDir:dir,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','HOME','TMPDIR'].includes(k)));
Object.assign(env,{NODE_ENV:'test',CI:'1',LOG_LEVEL:'silent',AUTH_DEV_BYPASS:'1',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',DATABASE_URL:`postgres://finnor:finnor@127.0.0.1:${port}/finnor`,FINNOR_S3_PYTHON:'/tmp/finnor-s3-python/bin/python',FINNOR_S5_PYTHON:'/tmp/finnor-s3-python/bin/python'});
type Result={name:string;args:string[];exitCode:number|null;signal:string|null;elapsedMs:number};
const results:Result[]=[];let redis:ChildProcess|undefined,redisDescription='NOT_STARTED';
let failure:string|null=null;const cleanup:Record<string,unknown>={status:'NOT_STARTED'};
async function save(status:'RUNNING'|'PASS'|'FAIL'){
 await writeFile(join(output,'manifest.json'),JSON.stringify({schema:'finnor.s5.repository-checks.v1',status,output,results,failure,cleanup,postgres:'18.4 embedded; managed platform extensions explicitly omitted',redis:redisDescription,commandsScope:'Existing CI/dependency proof; not production or hosted environment certification'},null,2));
}
async function command(name:string,args:string[],deadline=600000){
 const file=await open(join(output,`${name}.log`),'w'),started=performance.now();
 try{
  const result=await new Promise<{exitCode:number|null;signal:string|null}>(yes=>{
   const child=spawn('npm',args,{env,stdio:['ignore',file.fd,file.fd]});
   const timer=setTimeout(()=>child.kill('SIGKILL'),deadline);
   child.once('error',e=>{clearTimeout(timer);yes({exitCode:1,signal:e.message});});
   child.once('close',(exitCode,signal)=>{clearTimeout(timer);yes({exitCode,signal});});
  });
  results.push({name,args,...result,elapsedMs:performance.now()-started});
  console.log(JSON.stringify(results.at(-1)));await save('RUNNING');return result.exitCode===0;
 }finally{await file.close();}
}
function exited(child:ChildProcess){return child.exitCode!==null||child.signalCode!==null;}
async function waitForExit(child:ChildProcess,timeoutMs:number){
 if(exited(child))return;
 await new Promise<void>((yes,no)=>{
  const finish=()=>{clearTimeout(timer);child.removeListener('exit',finish);yes();};
  const timer=setTimeout(()=>{child.removeListener('exit',finish);no(Error('Owned service termination deadline exhausted'));},timeoutMs);
  child.once('exit',finish);if(exited(child))finish();
 });
}
async function terminateOwned(child:ChildProcess|undefined,signal:NodeJS.Signals){
 if(!child||exited(child))return;
 child.kill(signal);
 try{await waitForExit(child,5000);}catch{
  child.kill('SIGKILL');await waitForExit(child,5000);
 }
}
await save('RUNNING');
try{
 const executable=process.env.FINNOR_S5_REDIS_EXECUTABLE??'/tmp/finnor-s5-validation-tools/redis/src/redis-server';
 const redisPort=await availablePort(),redisLog=await open(join(output,'redis.log'),'w');
 try{
  redis=spawn(executable,['--bind','127.0.0.1','--port',String(redisPort),'--save','','--appendonly','no','--dir',dir],{env,stdio:['ignore',redisLog.fd,redisLog.fd]});
  redis.on('error',()=>undefined);
  for(let i=0;i<100;i++){
   if(redis.pid===undefined||exited(redis))throw Error(`Owned Redis stopped before readiness: exit=${redis.exitCode}, signal=${redis.signalCode}`);
   const ready=await new Promise<boolean>(yes=>{const socket=createConnection({host:'127.0.0.1',port:redisPort});socket.once('connect',()=>{socket.destroy();yes(true);});socket.once('error',()=>yes(false));});
   if(ready){
    if(redis.pid===undefined||exited(redis))throw Error(`Owned Redis stopped at readiness: exit=${redis.exitCode}, signal=${redis.signalCode}`);
    env.REDIS_URL=`redis://127.0.0.1:${redisPort}`;redisDescription=spawnSync(executable,['--version'],{encoding:'utf8'}).stdout.trim()+`; owned ephemeral localhost process pid=${redis.pid}`;break;
   }
   await new Promise(r=>setTimeout(r,20));
  }
 }finally{await redisLog.close();}
 if(redisDescription==='NOT_STARTED')throw Error('Disposable Redis did not start');
 await db.initialise();await appendFile(join(dir,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await db.start();await db.createDatabase('finnor');
 if(await command('migration',['run','db:migrate'])&&await command('seed',['run','db:seed'])&&await command('fixture-seam',['exec','tsx','--','scripts/install-vertical-fixture-seam.ts'])&&await command('langgraph',['run','setup:langgraph'])){
  await command('planner-evals',['run','test:planner-evals']);
  await command('retained-budget-compute',['test','--','tests/integration/provider-circuit-breaker-budget.test.ts','tests/integration/scope3-compute-plane.test.ts']);
  await command('backend-ci-tests',['test','--','--exclude','tests/integration/phase6-conversation-context-kernel.test.ts']);
 }
}catch(error){failure=error instanceof Error?error.message:String(error);}
finally{
 // The installed embedded-postgres stop() hangs if its server already exited.
 // This test driver observes only its own instance's actual child process.
 const server=(db as unknown as {process?:ChildProcess}).process;
 cleanup.postgresBeforeStop=server?{exitCode:server.exitCode,signalCode:server.signalCode}:{started:false};
 const errors:string[]=[];
 try{await terminateOwned(redis,'SIGTERM');}catch(error){errors.push(String(error));}
 try{await terminateOwned(server,'SIGINT');}catch(error){errors.push(String(error));}
 if((!redis||exited(redis))&&(!server||exited(server))){
  try{await rm(dir,{recursive:true,force:true});cleanup.disposableDirectoryRemoved=true;}catch(error){errors.push(String(error));}
 }else{errors.push('Owned service still alive; disposable directory retained');cleanup.disposableDirectoryRemoved=false;}
 cleanup.status=errors.length?'FAIL':'PASS';cleanup.errors=errors;
}
const status=results.length===7&&results.every(r=>r.exitCode===0)&&failure===null&&cleanup.status==='PASS'?'PASS':'FAIL';
await save(status);
await new Promise<void>((yes,no)=>process.stdout.write(JSON.stringify({output,status,results,cleanup})+'\n',error=>error?no(error):yes()));
// Explicit after confirmed cleanup/persistence: async-exit-hook's beforeExit(0)
// must never convert failed command evidence into an outer success.
process.exit(status==='PASS'?0:1);
