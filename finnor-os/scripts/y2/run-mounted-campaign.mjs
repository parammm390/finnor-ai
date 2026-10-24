/** Own only this fixture and browser session. No polling of OS processes. */
import {strict as assert} from 'node:assert';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
const backend=resolve(import.meta.dirname,'../..'),evidence=process.env.FINNOR_Y2_EVIDENCE_DIR;
assert(evidence&&isAbsolute(evidence),'ABSOLUTE_Y2_MOUNTED_EVIDENCE_REQUIRED');
mkdirSync(evidence,{recursive:true});
const fd=openSync(join(evidence,'mounted-fixture.log'),'wx');
const fixture=spawn(process.execPath,['--import=tsx','scripts/y2/run-mounted.mts'],{cwd:backend,env:process.env,stdio:['ignore','pipe','pipe']});
const closed=new Promise(yes=>fixture.once('close',yes));
for(const stream of [fixture.stdout,fixture.stderr])stream.on('data',bytes=>writeFileSync(fd,bytes));
try{
 await new Promise((yes,no)=>{
  const timer=setTimeout(()=>no(Error('Y2_MOUNTED_READY_DEADLINE')),240000);
  fixture.once('error',e=>{clearTimeout(timer);no(e);});
  fixture.once('exit',code=>{clearTimeout(timer);no(Error('Y2_MOUNTED_EARLY_EXIT:'+code));});
  let output='';fixture.stdout.on('data',bytes=>{output+=bytes;if(output.includes('Y2_MOUNTED_FIXTURE_READY')){clearTimeout(timer);yes();}});
 });
 console.log('Y2_MOUNTED_BROWSER_START');
 const browserLog=openSync(join(evidence,'browser-driver.log'),'wx');
 let result;try{result=spawnSync(process.execPath,['--import=tsx','scripts/y2/browser-checks.mts'],
  {cwd:backend,env:process.env,stdio:['ignore',browserLog,browserLog],timeout:600000});}finally{closeSync(browserLog);}
 writeFileSync(join(evidence,'browser-process.json'),JSON.stringify({exitCode:result.status,signal:result.signal,error:result.error?.message??null})+'\n',{flag:'wx'});
 if(result.status===null&&existsSync(join(evidence,'browser-session.json'))){
  const {session}=JSON.parse(readFileSync(join(evidence,'browser-session.json'),'utf8'));
  assert(typeof session==='string'&&session.length>0&&session.length<=256);
  spawnSync('agent-browser',['close'],{cwd:backend,env:{...process.env,AGENT_BROWSER_SESSION:session},timeout:30000,stdio:'ignore'});
 }
 assert.equal(result.status,0,'Y2_MOUNTED_BROWSER_CAMPAIGN_FAILED');
 assert.equal(await closed,0,'Y2_MOUNTED_FIXTURE_FAILED');
 console.log('Y2_MOUNTED_CAMPAIGN_PASS');
}finally{
 if(fixture.exitCode===null&&fixture.signalCode===null){
  // Let the fixture close its clients before PostgreSQL. Sending SIGTERM first
  // also invokes embedded-postgres's own process-exit cleanup out of order.
  const file=join(evidence,'browser-fixture.json');let requested=false;
  if(existsSync(file)){
   const {control}=JSON.parse(readFileSync(file,'utf8'));assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(control));
   try{requested=(await fetch(control+'/stop',{method:'POST',signal:AbortSignal.timeout(3000)})).ok;}catch{}
  }
  await new Promise(yes=>{
   const timer=setTimeout(()=>fixture.kill('SIGKILL'),15000);
   fixture.once('close',()=>{clearTimeout(timer);yes();});if(!requested)fixture.kill('SIGTERM');
  });
 }
 closeSync(fd);
}
