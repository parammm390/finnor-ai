import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const [out]=process.argv.slice(2);
if(!out?.startsWith('/')||!process.env.AGENT_BROWSER_CDP||!process.env.AGENT_BROWSER_SESSION)throw Error('FRESH_OUTPUT_AND_ASSIGNED_BROWSER_REQUIRED');
await mkdir(out,{recursive:false,mode:0o700});
const repo=resolve(import.meta.dirname,'../../..'),privateDir=await mkdtemp(join(tmpdir(),'p6-private-mounted-'));
const {sourceCut}=await import('../p5/test-support.mts');
const before=await sourceCut(),env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','AGENT_BROWSER_CDP','AGENT_BROWSER_SESSION','FACTORY_DESKTOP_CDP_PORT'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[]));
const owned=[],receipt={startedAt:new Date().toISOString(),qualification:'MOUNTED_LOCAL_BEARER_NATIVE_WORK_NOT_GATE_P6',cleanup:[]};
let fixture;
function launch(label,args,extra={}){
 const log=createWriteStream(join(out,label+'.log'),{flags:'wx',mode:0o600});
 const child=spawn(process.execPath,args,{cwd:join(repo,'finnor-os'),env:{...env,...extra},stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 const closed=new Promise(yes=>child.once('close',(code,signal)=>{log.end();yes({code,signal})}));
 const item={label,child,closed};owned.push(item);return item;
}
async function wait(fn,ms){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150))}throw Error('MOUNTED_FIXTURE_READINESS_TIMEOUT')}
try{
 const native=launch('fixture',['--import=tsx',join(import.meta.dirname,'browser-fixture.mts')],{
  NODE_ENV:'test',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',FINNOR_P4_PROFILE:'ordinary_disposable',LOG_LEVEL:'silent',
  FINNOR_P6_EVIDENCE_DIR:join(out,'fixture'),FINNOR_P6_PRIVATE_DIR:privateDir});
 fixture=await wait(async()=>{if(native.child.exitCode!==null)throw Error('OWNED_FIXTURE_EXITED');try{return JSON.parse(await readFile(join(privateDir,'fixture.json'),'utf8'))}catch{return null}},240000);
 const frontend=launch('frontend',[join(repo,'finnor-os/scripts/p5/run-frontend.mjs'),join(privateDir,'frontend-env.json'),'4696']);
 await wait(async()=>{if(frontend.child.exitCode!==null)throw Error('OWNED_FRONTEND_EXITED');try{return(await fetch(fixture.frontendOrigin+'/centropy/login',{signal:AbortSignal.timeout(15000)})).ok}catch{return false}},90000);
 const browser=launch('browser',[join(import.meta.dirname,'run-mounted-browser.mjs'),join(privateDir,'fixture.json'),join(out,'browser')]);
 const deadline=setTimeout(()=>browser.child.kill('SIGKILL'),240000);
 const result=await browser.closed.finally(()=>clearTimeout(deadline));
 receipt.browserExit=result;
 const report=JSON.parse(await readFile(join(out,'browser/results.json'),'utf8'));
 receipt.steps=report.steps.map(({id,status})=>({id,status}));
 if(result.code!==0||receipt.steps.length!==5||receipt.steps.some(s=>s.status!=='PASS'))throw Error('MOUNTED_PROCEDURE_STORY_FAILED');
}catch(error){receipt.failure=error.message;process.exitCode=1}
finally{
 if(fixture)try{await fetch(fixture.controlOrigin+'/stop',{method:'POST',signal:AbortSignal.timeout(3000)});}catch{}
 for(const item of [...owned].reverse()){
  if(item.label!=='fixture'&&item.child.exitCode===null)item.child.kill('SIGTERM');
  const result=await Promise.race([item.closed,new Promise(yes=>setTimeout(()=>yes(null),10000))]);
  if(!result){item.child.kill('SIGKILL');await item.closed}
  receipt.cleanup.push({label:item.label,pid:item.child.pid,...result??{forcedOwnedKill:true}});
 }
 const after=await sourceCut();receipt.sourceUnchanged=JSON.stringify(before)===JSON.stringify(after);
 await writeFile(join(out,'source-check.json'),JSON.stringify({before,after,unchanged:receipt.sourceUnchanged},null,2));
 if(!receipt.sourceUnchanged)process.exitCode=1;
 await rm(privateDir,{recursive:true,force:true});receipt.privateEphemeralCredentialsRemoved=true;
 await writeFile(join(out,'result.json'),JSON.stringify({...receipt,finishedAt:new Date().toISOString(),exitCode:process.exitCode??0},null,2)+'\n');
 console.log(JSON.stringify({out,steps:receipt.steps,failure:receipt.failure,sourceUnchanged:receipt.sourceUnchanged,exitCode:process.exitCode??0}));
 process.exit(process.exitCode??0);
}
