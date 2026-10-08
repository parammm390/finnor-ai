/** Registered real Canvas trajectory. Only this assigned blank/owned pane is used. */
import {spawnSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
const [file,out]=process.argv.slice(2);if(!file?.startsWith('/')||!out?.startsWith('/'))throw Error('ABSOLUTE_PRIVATE_FIXTURE_AND_FRESH_OUTPUT_REQUIRED');
const fixture=JSON.parse(await readFile(file,'utf8')),output=resolve(out);await mkdir(output,{recursive:false,mode:0o700});
if(!process.env.AGENT_BROWSER_CDP||!process.env.AGENT_BROWSER_SESSION)throw Error('ASSIGNED_FACTORY_BROWSER_REQUIRED');
const commands=[],steps=[],startedAt=new Date().toISOString();
let viewport=null;
function cli(...args){
 if(args.includes('fill')||args[0]==='keyboard'||args[0]==='press'){
  const checked=spawnSync('agent-browser',['--cdp',process.env.AGENT_BROWSER_CDP,'--json','eval',"({origin:location.origin,hasFocus:document.hasFocus()})"],{encoding:'utf8',timeout:15000});
  let boundary;try{boundary=JSON.parse(checked.stdout).data.result;}catch{boundary=null;}
  if(checked.status!==0||!boundary?.hasFocus||boundary.origin!==fixture.frontendOrigin)throw Error('NATIVE_KEYBOARD_CONFINEMENT_PRECONDITION_FAILED');
 }
 const argv=['--cdp',process.env.AGENT_BROWSER_CDP,'--json',...args],r=spawnSync('agent-browser',argv,{encoding:'utf8',timeout:45000});
 let data;try{data=JSON.parse(r.stdout);}catch{data={success:false,error:'INVALID_CLI_JSON'};}
 const secretInput=args.includes('fill')||(args[0]==='keyboard'&&['inserttext','type'].includes(args[1]));
 commands.push({operation:args[0],arguments:secretInput?['SCOPED_INPUT_REDACTED']:args.slice(1),exitCode:r.status,success:data.success,at:new Date().toISOString()});
 if(r.status!==0||data.success===false)throw Error('FACTORY_BROWSER_COMMAND_FAILED:'+args[0]+':'+(data.error??r.stderr).slice(0,500));
 return data.data??data;
}
const read=expression=>{const data=cli('eval',expression);return data.result??data;};
const dom=()=>read("(()=>{const p=document.querySelector('.ct-interface');return {present:!!p,work:p?.dataset.interfaceWork,id:p?.dataset.interfaceId,status:p?.dataset.interfaceStatus,text:p?.innerText??'',url:location.href}})()");
function openCanvas(url){
 cli('open',url);
 cli('wait','--fn',"Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Canvas')");
 cli('find','role','button','click','--name','Canvas');
}
async function wait(fn,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,200));}throw Error('MOUNTED_BROWSER_OBSERVER_TIMEOUT');}
async function control(path,method='POST'){const r=await fetch(fixture.controlOrigin+path,{method,headers:{'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});assert.ok(r.ok);return r.json();}
async function save(){await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.p5.mounted-browser-results.v1',startedAt,finishedAt:new Date().toISOString(),viewport,steps,commands,
 qualification:'FACTORY_CDP_POINTER_KEYBOARD_SCREENSHOTS_LOCAL_BEARER_AUTH_NOT_TRUSTED_OS_OR_GATE_P5',driverSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex')},null,2)+'\n',{mode:0o600});}
async function step(id,fn){
 try{steps.push({id,status:'PASS',observed:await fn()});}catch(error){steps.push({id,status:'FAIL',predicate:error.message});throw error;}
 finally{
  try{steps.at(-1).renderedDiagnostic=read("({url:location.origin+location.pathname,text:document.body.innerText.slice(0,2048),policyViolations:window.__p5PolicyObservations??[]})");}catch(error){steps.at(-1).diagnosticFailure=error.message;}
  try{cli('screenshot',join(output,id+'.png'));await writeFile(join(output,id+'.snapshot.json'),JSON.stringify(cli('snapshot','-i'),null,2),{mode:0o600});}
  catch(error){steps.at(-1).captureFailure=error.message;steps.at(-1).status='FAIL';process.exitCode=1;}
  await save();
 }
}
try{
 const tabs=cli('tab','list').tabs;assert.ok(tabs.every(t=>t.url==='about:blank'||t.url.startsWith(fixture.frontendOrigin)),'Refuse to navigate a peer/user target');
 cli('set','viewport','760','900');
 viewport=read("({width:innerWidth,height:innerHeight})");assert.equal(viewport.width,760);assert.equal(viewport.height,900);
 await step('sign-in-and-mounted-native-work',async()=>{
  cli('open',fixture.frontendOrigin+'/centropy/login');
  cli('wait','--fn',"Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Sign in'&&!b.disabled)");
  cli('eval',"window.__p5PolicyObservations=[];document.addEventListener('securitypolicyviolation',e=>{let origin;try{origin=new URL(e.blockedURI).origin}catch{origin='NON_URL_RESOURCE'}window.__p5PolicyObservations.push({directive:e.effectiveDirective,blockedOrigin:origin,disposition:e.disposition})});'OBSERVATION_ONLY'");
  cli('focus','#centropy-login-email');cli('press','Meta+A');cli('keyboard','inserttext',fixture.email);
  cli('focus','#centropy-login-password');cli('press','Meta+A');cli('keyboard','inserttext',fixture.password);
  const form=read("({emailPresent:!!document.querySelector('input[type=email]')?.value,passwordPresent:!!document.querySelector('input[type=password]')?.value,valid:document.querySelector('form')?.checkValidity(),focused:document.activeElement?.getAttribute('type'),width:innerWidth,height:innerHeight,bodyWidth:document.body.getBoundingClientRect().width})");
  const digestExpression="async()=>{const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');return {email:await hash(document.querySelector('input[type=email]').value),password:await hash(document.querySelector('input[type=password]').value)}}";
  const inputDigests=read(`(${digestExpression})()`);
  form.emailExact=inputDigests.email===createHash('sha256').update(fixture.email).digest('hex');
  form.passwordExact=inputDigests.password===createHash('sha256').update(fixture.password).digest('hex');
  await writeFile(join(output,'login-input-diagnostic.json'),JSON.stringify(form,null,2)+'\n',{mode:0o600});
  assert.ok(form.emailPresent&&form.passwordPresent&&form.valid&&form.emailExact&&form.passwordExact,'NATIVE_LOGIN_FIELDS_NOT_FILLED_EXACTLY_OR_INVALID');
  cli('focus','input[type=password]');cli('press','Enter');
  await wait(()=>read("location.pathname==='/centropy'"));openCanvas(fixture.url);
  const d=await wait(()=>{const d=dom();return d.work===fixture.workId?d:null;});assert.equal(d.id,'none');return d;
 });
 await step('original-request-real-queue-and-independent-target',async()=>{
  cli('scrollintoview','.ct-interface');cli('find','label','Disposable access reference','fill',fixture.accessId);cli('find','label','Application account','fill','test-account');cli('find','label','Record identifier','fill','C_01');cli('find','label','Exact field','fill','price');cli('find','label','Exact value','fill','20.00');cli('find','label','Currency','fill','USD');cli('find','label','Strong prior revision','fill','"v1"');
  cli('find','role','button','click','--name','Acquire and practice interface');
  const d=await wait(()=>{const d=dom();return d.status==='PRACTICED'?d:null;},65000),oracle=await control('/observation','GET');
  assert.equal(oracle.target.records.C_01.price,2000);assert.equal(oracle.target.records.C_010.price,1000);assert.equal(oracle.target.writes.length,1);
  assert.equal(d.id,oracle.acquisitions[0].id);assert.ok(d.text.includes('Admission is pending'));assert.ok(d.text.includes('USD cost is unknown'));return {dom:d,oracle};
 });
 await step('keyboard-module-witness-and-durable-reload',async()=>{
  const snapshot=cli('snapshot','-i'),reference=Object.entries(snapshot.refs).find(([,value])=>value.role==='button'&&value.name==='Inspect interface evidence')?.[0];
  assert.ok(reference,'The current exact evidence button must be accessible');cli('focus','@'+reference);cli('press','Space');
  assert.equal(read("document.activeElement?.hasAttribute('data-interface-proof')"),true);
  const old=dom();openCanvas(fixture.url);const d=await wait(()=>{const d=dom();return d.id===old.id&&d.status==='PRACTICED'?d:null;});assert.equal((await control('/observation','GET')).target.writes.length,1);return d;
 });
 await step('delayed-response-isolated-from-another-thread',async()=>{
  await control('/delay');await wait(async()=> (await control('/delay-status','GET')).waiting,20000);openCanvas(fixture.otherUrl);
  const empty=await wait(()=>{const d=dom();return d.work==='none'?d:null;});await control('/release');assert.equal(dom().id,'none');assert.ok(!dom().text.includes('C_01'));openCanvas(fixture.url);await wait(()=>dom().status==='PRACTICED');return empty;
 });
 await step('interface-drift-quarantines-old-evidence',async()=>{
  await control('/drift');const d=await wait(()=>{const d=dom();return d.status==='QUARANTINED'?d:null;});assert.ok(d.text.includes('Quarantined'));assert.ok(!d.text.includes('Inspect interface evidence'));assert.equal((await control('/observation','GET')).target.writes.length,1);return d;
 });
  await step('lost-observation-retains-original-responsibility',async()=>{
   await control('/observer-unavailable');
   cli('find','label','Disposable access reference','fill',fixture.accessId);cli('find','label','Application account','fill','test-account');cli('find','label','Record identifier','fill','C_01');cli('find','label','Exact field','fill','price');cli('find','label','Exact value','fill','30.00');cli('find','label','Currency','fill','USD');cli('find','label','Strong prior revision','fill','"v2"');
   cli('find','role','button','click','--name','Acquire and practice interface');
   const d=await wait(()=>{const d=dom();return d.status==='UNKNOWN'?d:null;},65000),oracle=await control('/observation','GET');
   assert.equal(oracle.target.records.C_01.price,3000);assert.equal(oracle.target.records.C_010.price,1000);assert.equal(oracle.target.writes.length,2);
   assert.ok(d.text.includes('Original responsibility is retained'));assert.ok(d.text.includes('Recovery reads the original operation only'));assert.ok(d.text.includes('Admission is pending'));
   assert.ok(!d.text.includes('Exact value and operation history matched'));return {dom:d,oracle};
  });
  await step('read-only-reconciliation-never-replays-mutation',async()=>{
   await control('/observer-restored');cli('find','role','button','click','--name','Read-only reconcile original attempt');
   const d=await wait(()=>{const d=dom();return d.status==='PRACTICED'?d:null;},45000),oracle=await control('/observation','GET');
   assert.equal(oracle.target.writes.length,2);assert.equal(oracle.target.records.C_01.price,3000);assert.equal(oracle.target.records.C_010.price,1000);
   assert.ok(d.text.includes('Exact value and operation history matched'));return {dom:d,oracle};
  });
 await step('revoked-access-clears-private-target',async()=>{
  await control('/revoke');const d=await wait(()=>{const d=dom();return !d.present||d.id==='none'?d:null;});assert.ok(!d.text.includes('C_01'));assert.ok(!d.text.includes('Inspect interface evidence'));return d;
 });
}catch(error){console.log(JSON.stringify({status:'FAIL',predicate:error.message}));process.exitCode=1;}
finally{await save();console.log(JSON.stringify({output,steps:steps.map(({id,status})=>({id,status}))}));}
