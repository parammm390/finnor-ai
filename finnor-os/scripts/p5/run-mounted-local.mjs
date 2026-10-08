import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {strict as assert} from 'node:assert';

const [destination]=process.argv.slice(2);
if(!destination?.startsWith('/')||!process.env.AGENT_BROWSER_CDP||!process.env.AGENT_BROWSER_SESSION)throw Error('ABSOLUTE_FRESH_OUTPUT_AND_ASSIGNED_BROWSER_REQUIRED');
const root=resolve(import.meta.dirname,'../../..'),out=resolve(destination),startedAt=new Date().toISOString();
await mkdir(out,{recursive:false,mode:0o700});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','AGENT_BROWSER_CDP','AGENT_BROWSER_SESSION','FACTORY_DESKTOP_CDP_PORT'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]));
const owned=[],observed={startedAt,qualification:'LOCAL_BEARER_API_RLS_QUEUE_FACTORY_CDP_NOT_ORIGINAL_GATE_P5',frontendPreparationMs:null,browserDeadlineMs:150000,steps:null,fixtureSourceUnchanged:null,fixtureSourceComplete:null,cleanup:[]};
let privateFixture=null,fixtureStopped=false;
function launch(label,args,extra={}){
 const log=createWriteStream(join(out,label+'.log'),{flags:'wx',mode:0o600});
 const processHandle=spawn(process.execPath,args,{cwd:join(root,'finnor-os'),env:{...env,...extra},stdio:['ignore','pipe','pipe']});
 processHandle.stdout.pipe(log,{end:false});processHandle.stderr.pipe(log,{end:false});
 const result=new Promise(yes=>processHandle.once('close',(code,signal)=>{log.end();yes({code,signal});}));
 const record={label,processHandle,result};owned.push(record);return record;
}
async function wait(predicate,limit=30000){
 const until=Date.now()+limit;
 while(Date.now()<until){const value=await predicate();if(value)return value;await new Promise(yes=>setTimeout(yes,150));}
 throw Error('MOUNTED_LOCAL_READINESS_TIMEOUT');
}
try{
 const fixtureDir=join(out,'fixture'),fixtureFile=join(fixtureDir,'private-fixture.json');
 const fixture=launch('fixture',['--import=tsx',join(import.meta.dirname,'run-browser-fixture.mts')],{FINNOR_P5_EVIDENCE_DIR:fixtureDir,FINNOR_P5_FRONTEND_ORIGIN:'http://127.0.0.1:4695'});
 privateFixture=await wait(async()=>{assert.equal(fixture.processHandle.exitCode,null,'Native fixture exited');try{return JSON.parse(await readFile(fixtureFile,'utf8'));}catch{return null;}},45000);
 const frontendStarted=Date.now();
 const frontend=launch('frontend',[join(import.meta.dirname,'run-frontend.mjs'),join(fixtureDir,'frontend-env.json'),'4695']);
 try{await wait(async()=>{assert.equal(frontend.processHandle.exitCode,null,'Owned frontend exited');try{return(await fetch(privateFixture.frontendOrigin+'/centropy/login',{signal:AbortSignal.timeout(15000)})).ok;}catch{return false;}},90000);}
 finally{observed.frontendPreparationMs=Date.now()-frontendStarted;}
 const browser=launch('browser',[join(import.meta.dirname,'run-mounted-browser.mjs'),fixtureFile,join(out,'browser')]);
 const result=await Promise.race([browser.result,new Promise((_,no)=>{const timeout=setTimeout(()=>no(Error('MOUNTED_LOCAL_DEADLINE')),150000);timeout.unref();})]);
 const receipt=JSON.parse(await readFile(join(out,'browser/results.json'),'utf8'));
 observed.steps=receipt.steps.map(({id,status})=>({id,status}));
 assert.equal(result.code,0,'Mounted browser driver failed');
 assert.equal(observed.steps.length,8,'Original mounted story count changed');
 assert.ok(observed.steps.every(step=>step.status==='PASS'),'Mounted browser predicate failed');
}catch(error){observed.failure=error.message;process.exitCode=1;}
finally{
 if(privateFixture)try{const response=await fetch(privateFixture.controlOrigin+'/stop',{method:'POST',body:'{}',signal:AbortSignal.timeout(3000)});fixtureStopped=response.ok;observed.cleanup.push({action:'stop-owned-fixture',status:response.status});}catch{observed.cleanup.push({action:'stop-owned-fixture',status:'SIGNAL_FALLBACK'});}
 for(const record of [...owned].reverse()){
  if(!(record.label==='fixture'&&fixtureStopped)&&record.processHandle.exitCode===null&&record.processHandle.signalCode===null)record.processHandle.kill('SIGTERM');
  const result=await Promise.race([record.result,new Promise(yes=>{const timeout=setTimeout(()=>yes(null),10000);timeout.unref();})]);
  if(!result){record.processHandle.kill('SIGKILL');await record.result;}
  observed.cleanup.push({label:record.label,pid:record.processHandle.pid,result:result??{forcedOwnedKill:true}});
 }
 try{const source=JSON.parse(await readFile(join(out,'fixture/source-check.json'),'utf8'));observed.fixtureSourceUnchanged=source.unchanged;observed.fixtureSourceComplete=source.sourceComplete;}catch{observed.fixtureSourceUnchanged=false;observed.fixtureSourceComplete=false;}
 if(!observed.fixtureSourceUnchanged||!observed.fixtureSourceComplete)process.exitCode=1;
 await writeFile(join(out,'result.json'),JSON.stringify({...observed,finishedAt:new Date().toISOString(),exitCode:process.exitCode??0},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({out,steps:observed.steps,fixtureSourceUnchanged:observed.fixtureSourceUnchanged,fixtureSourceComplete:observed.fixtureSourceComplete,failure:observed.failure,exitCode:process.exitCode??0}));
}
