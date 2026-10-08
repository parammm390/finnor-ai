/** Failure-first real Canvas trajectory. DOM reads are observations only. */
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
const [file,out]=process.argv.slice(2);
if(!file?.startsWith('/')||!out?.startsWith('/'))throw Error('ABSOLUTE_PRIVATE_FIXTURE_AND_FRESH_OUTPUT_REQUIRED');
const f=JSON.parse(await readFile(file,'utf8'));await mkdir(out,{recursive:false});
const cdp=process.env.AGENT_BROWSER_CDP,session=process.env.AGENT_BROWSER_SESSION;
if(!cdp||!session)throw Error('ASSIGNED_BROWSER_REQUIRED');
const steps=[],commands=[];let screenshotAvailable=true;
function cli(...args){
 if(['fill','keyboard','press'].includes(args[0])||args.includes('fill')){
  const r=spawnSync('agent-browser',['--cdp',cdp,'--json','eval','({origin:location.origin,focused:document.hasFocus()})'],{encoding:'utf8',timeout:15000});
  const scope=JSON.parse(r.stdout).data.result;
  assert.equal(scope.origin,f.frontendOrigin);
  // Global keyboard commands require an actually focused pane. Scoped fill
  // commands target only the inspected frame/element and do not use OS focus.
  if(['keyboard','press'].includes(args[0]))assert.equal(scope.focused,true);
 }
 const r=spawnSync('agent-browser',['--cdp',cdp,'--json',...args],{encoding:'utf8',timeout:args[0]==='screenshot'?10000:45000});
 const value=JSON.parse(r.stdout||'{}');
 commands.push({operation:args[0],exitCode:r.status,signal:r.signal,success:value.success,
   timedOut:r.error?.code==='ETIMEDOUT'});
 if(r.status!==0||!value.success)throw Error('BROWSER_COMMAND_FAILED:'+args[0]+':'+String(value.error??'').slice(0,256));
 return value.data;
}
const read=expr=>cli('eval',expr).result;
function nativeFill(selector,value){
 cli('click',selector);
 cli('focus',selector);
 assert.equal(read("document.activeElement?.value===''"),true,'FRESH_EMPTY_CONTROL_REQUIRED');
 cli('keyboard','type',value);
}
function nativeLabelFill(label,value){
 const refs=Object.entries(cli('snapshot','-i').refs).filter(([,r])=>r.role==='textbox'&&r.name===label);
 assert.equal(refs.length,1,'EXACT_ACCESSIBLE_TEXTBOX_REQUIRED:'+label);
 nativeFill('@'+refs[0][0],value);
}
function activate(name){
 cli('wait','--fn',`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(name)}&&!b.disabled)`);
 const selector=read(`(()=>{const buttons=Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()===${JSON.stringify(name)});if(buttons.length!==1)return null;let node=buttons[0],parts=[];while(node&&node!==document.documentElement){parts.unshift(node.tagName.toLowerCase()+':nth-child('+(Array.from(node.parentElement.children).indexOf(node)+1)+')');node=node.parentElement;}return 'html>'+parts.join('>')})()`);
 assert.ok(selector,'EXACT_ACCESSIBLE_BUTTON_REQUIRED:'+name);
 cli('focus',selector);
 assert.equal(read('document.activeElement?.textContent?.trim()'),name,'EXACT_BUTTON_FOCUS_REQUIRED');
 cli('press','Enter');
}
const dom=()=>read("(()=>{const p=document.querySelector('.ct-procedure');return {present:!!p,work:p?.dataset.procedureWork,id:p?.dataset.procedureId,state:p?.dataset.procedureState,text:p?.innerText??''}})()");
async function wait(fn,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,200));}throw Error('MOUNTED_PROCEDURE_OBSERVER_TIMEOUT');}
async function save(){await writeFile(join(out,'results.json'),JSON.stringify({schema:'finnor.p6.mounted-results.v1',steps,commands,
 qualification:'LOCAL_BEARER_NATIVE_WORK_UI_NOT_GATE_P6'},null,2)+'\n');}
async function story(id,fn){try{steps.push({id,status:'PASS',observed:await fn()});}catch(error){steps.push({id,status:'FAIL',predicate:error.message});throw error;}finally{
 try{steps.at(-1).renderedDiagnostic=read("(()=>{const form=document.querySelector('form'),button=document.querySelector('button[type=submit]');return {url:location.origin+location.pathname,text:document.body.innerText.slice(0,4096),emailPresent:!!document.querySelector('input[type=email]')?.value,passwordPresent:!!document.querySelector('input[type=password]')?.value,formAssociated:button?.form===form,buttonDisabled:button?.disabled,activeButton:document.activeElement?.textContent?.trim(),listenerCounts:typeof getEventListeners==='function'?Object.fromEntries(['submit','click','input','keydown'].map(k=>[k,getEventListeners(document)[k]?.length??0])):null}})()");}catch{}
 if(screenshotAvailable)try{cli('screenshot',join(out,id+'.png'));}catch{screenshotAvailable=false;steps.at(-1).captureFailure=true;}
 else steps.at(-1).captureUnavailable=true;
 try{await writeFile(join(out,id+'.snapshot.json'),JSON.stringify(cli('snapshot','-i'),null,2));}catch{steps.at(-1).snapshotFailure=true;}
 await save();
}}
function canvas(url){cli('open',url);cli('wait','--fn',"Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Canvas')");
 activate('Canvas');cli('wait','--fn',"!!document.querySelector('.ct-procedure')");}
function ensureCanvas(){if(!dom().present)canvas(f.url);}
try{
 assert.ok(cli('tab','list').tabs.every(t=>t.url==='about:blank'||t.url.startsWith(f.frontendOrigin)),'REFUSE_PEER_OR_USER_PANE');
 await story('authenticated-native-Work-and-procedure-form',async()=>{
  cli('open',f.frontendOrigin+'/centropy/login');
  cli('wait','--fn',"!!document.querySelector('#centropy-login-email')&&document.querySelector('button[type=submit]')?.disabled===false");
  nativeFill('#centropy-login-email',f.email);
  nativeFill('#centropy-login-password',f.password);
  const hashes=await read("(async()=>{const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');return {email:await hash(document.querySelector('input[type=email]').value),password:await hash(document.querySelector('input[type=password]').value)}})()");
  const inputDiagnostic={emailExact:hashes.email===createHash('sha256').update(f.email).digest('hex'),
    passwordExact:hashes.password===createHash('sha256').update(f.password).digest('hex'),
    formValid:read("document.querySelector('form')?.checkValidity()"),
    handlers:read("(()=>{const form=document.querySelector('form'),email=document.querySelector('input[type=email]'),props=n=>n?.[Object.keys(n).find(k=>k.startsWith('__reactProps$'))];return {formSubmit:typeof props(form)?.onSubmit,emailChange:typeof props(email)?.onChange,formCount:document.forms.length,submitDisabled:document.querySelector('button[type=submit]')?.disabled}})()")};
  await writeFile(join(out,'login-input-diagnostic.json'),JSON.stringify(inputDiagnostic,null,2));
  assert.ok(inputDiagnostic.emailExact&&inputDiagnostic.passwordExact&&inputDiagnostic.formValid,'SCOPED_LOGIN_INPUTS_NOT_EXACT_OR_VALID');
  activate('Sign in');
  await wait(()=>read("location.pathname==='/centropy'"));canvas(f.url);
  const d=await wait(()=>{const d=dom();return d.work===f.workId?d:null;});assert.ok(d.text.includes('No protected admission'));return d;
 });
 await story('induction-through-mounted-form-and-durable-queue',async()=>{
  ensureCanvas();
  nativeLabelFill('Source programme identifiers',f.programIds.join(','));
  activate('Induce executable procedure');
  const d=await wait(()=>{const d=dom();return d.state==='PROPOSED'?d:null;},90000);
  assert.ok(d.id&&d.id!=='none');assert.ok(d.text.includes('USD cost remains unknown'));assert.ok(d.text.includes('adverse'));return d;
 });
 await story('accessible-evidence-select-and-durable-reload',async()=>{
  ensureCanvas();
  activate('Inspect procedure evidence');
  await wait(()=>read("document.activeElement?.hasAttribute('data-procedure-proof')===true"));
  activate('Select for disposable execution');
  await wait(()=>read("!!document.querySelector('[data-selected-procedure]')"));
  nativeLabelFill('Desired analytical outcome','Compute the exact new net value after a recorded USD5 adjustment');
  nativeLabelFill('Observable calculations','net = price - debt - USD(5)');
  if(!read("!!document.querySelector('[data-selected-procedure]')")){
   await wait(()=>read("Array.from(document.querySelectorAll('.ct-procedure button')).some(b=>b.textContent.trim()==='Select for disposable execution'&&!b.disabled)"));
   activate('Select for disposable execution');
   await wait(()=>read("!!document.querySelector('[data-selected-procedure]')"));
  }
  await writeFile(join(out,'selected-procedure-pre-submit.json'),JSON.stringify({dom:dom(),selected:read("document.querySelector('[data-selected-procedure]')?.getAttribute('data-selected-procedure')"),scope:read("Array.from(document.querySelectorAll('.ct-program label')).find(l=>l.textContent.startsWith('Execution scope'))?.querySelector('select')?.value")},null,2));
  activate('Construct and check method');
  const result=await wait(()=>{if(!dom().present)activate('Canvas');return read("Array.from(document.querySelectorAll('.ct-program .ct-evidence__values button')).some(b=>b.textContent.trim()==='75')")},90000);
  assert.equal(result,true);
  const response=await fetch(f.controlOrigin+'/observation');assert.equal(response.status,200);
  const observation=await response.json();
  await writeFile(join(out,'selected-execution-observation.json'),JSON.stringify(observation,null,2));
  assert.ok(observation.events.some(e=>e.kind==='P6_EXECUTABLE_TRANSFER'),'MOUNTED_SUBMISSION_DID_NOT_EXECUTE_SELECTED_PROCEDURE');
  const old=dom();canvas(f.url);
  const d=await wait(()=>{const d=dom();return d.id===old.id?d:null;});return {dom:d,newValue:'75',observation};
 });
 await story('immutable-counterexample-from-mounted-control',async()=>{
  ensureCanvas();
  nativeLabelFill('Procedure correction or failure','New convention requires independent reassessment');
  activate('Record counterexample and invalidate');
  const d=await wait(()=>{const d=dom();return d.state==='INVALIDATED'?d:null;});
  assert.ok(!d.text.includes('Select for disposable execution'));return d;
 });
 await story('other-Work-never-displays-prior-procedure',async()=>{
  canvas(f.otherUrl);const d=await wait(()=>{const d=dom();return d.work==='none'?d:null;});
  assert.equal(d.id,'none');assert.ok(!d.text.includes('New convention'));return d;
 });
}catch(error){process.exitCode=1;console.log(JSON.stringify({predicate:error.message}));}
finally{await save();console.log(JSON.stringify({out,steps:steps.map(({id,status})=>({id,status}))}));}
