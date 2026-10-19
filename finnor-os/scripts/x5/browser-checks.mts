/** Real emitted Work UI. No browser storage/token APIs, mocked responses or
 * synthetic auth events. The fixture can delay only actual owner replies. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {readFile,mkdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {artifact,repo} from '../x3/environment.mts';

assert(process.env.FINNOR_X5_EVIDENCE_DIR,'EXPLICIT_EVIDENCE_DIRECTORY_REQUIRED');
const evidence=resolve(process.env.FINNOR_X5_EVIDENCE_DIR);
const f=JSON.parse(await readFile(join(evidence,'browser-fixture.json'),'utf8'));
assert([f.base,f.control].every((value:string)=>/^http:\/\/127\.0\.0\.1:\d+$/.test(value)));
const derived=process.env.AGENT_BROWSER_SESSION??spawnSync('agent-browser',['session','id','--scope','worktree','--prefix','x5'],{cwd:repo,encoding:'utf8'}).stdout.trim();
assert(derived,'NAMED_BROWSER_SESSION_REQUIRED');
const env={...process.env,AGENT_BROWSER_SESSION:derived},steps:any[]=[],panel='.ct-learned-policy';
const rights=panel+' > details:first-of-type',compile=panel+' > details:nth-of-type(2) form',execute=panel+' > form';
let passed=false;
function browser(...args:string[]){
 const r=spawnSync('agent-browser',args,{cwd:repo,env,encoding:'utf8',timeout:60000});
 if(r.status!==0)throw Error('BROWSER_'+args[0]+':'+r.stdout+r.stderr);
 return r.stdout;
}
function inspect(expression:string){const r=JSON.parse(browser('--json','eval',expression));assert(r.success,JSON.stringify(r));return r.data.result;}
function click(name:string){browser('wait','--fn',`Array.from(document.querySelectorAll('button')).some(b=>(b.textContent?.trim()===${JSON.stringify(name)}||b.getAttribute('aria-label')===${JSON.stringify(name)})&&!b.disabled)`);return browser('find','role','button','click','--name',name);}
function press(selector:string){browser('focus',selector);browser('press','Enter');}
async function control(path:string,method='POST'){
 const response=await fetch(f.control+path,{method,headers:{connection:'close'},signal:AbortSignal.timeout(45000)}),body=await response.json();
 assert.equal(response.status,200,JSON.stringify(body));return body as any;
}
function focus(){
 const target='button[aria-label="Focus Enterprise application"]';
 browser('wait','--text','Enterprise application');browser('wait',target+':not(:disabled)');
 browser('scrollintoview',target);
 browser('wait','--fn',`(()=>{const button=document.querySelector(${JSON.stringify(target)});if(!button||button.matches(':disabled'))return false;const r=button.getBoundingClientRect();return r.width>0&&r.height>0&&button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
 click('Focus Enterprise application');browser('wait',panel);
}
function navigate(url:string){
 browser('pushstate',url);browser('wait','--text',url===f.otherUrl?'X5 learned policy Work 1':'X5 learned policy Work 0');focus();
}
function signIn(email:string,url:string){
 browser('open','--allowed-domains','127.0.0.1',f.base+'/centropy/login');browser('wait','input[type="email"]');
 browser('fill','input[type="email"]',email);browser('fill','input[type="password"]','r1-disposable-only');
 browser('wait','button[type="submit"]:not([disabled])');press('button[type="submit"]');
 browser('wait','--url','**/centropy');browser('open',url);focus();
}
function signOut(){
 press('details.ct-account > summary');click('Sign out');browser('wait','--text','Your investment context stays private.');
 assert.equal(inspect(`document.querySelectorAll('${panel} form').length`),0);
 browser('find','role','link','click','--name','Sign in','--exact');browser('wait','--url','**/centropy/login');
}
function state(){return inspect(`(()=>{const p=document.querySelector('${panel}');return {workId:p?.dataset.learningWork,compilationId:p?.dataset.learningId,message:p?.querySelector('p[role=status]')?.textContent,executeForms:p?.querySelectorAll(':scope > form').length??0,retry:Array.from(p?.querySelectorAll('button')??[]).some(b=>b.textContent==='Retry original owner request'),owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Latest owner response')?.parentElement?.querySelector('pre')?.textContent??null}})()`);}
function current(workId:string){
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.learningWork===${JSON.stringify(workId)}&&document.querySelector('${panel}')?.dataset.learningId!=='none'&&document.querySelector('${panel}')?.textContent.includes('current development release')===true&&document.querySelector('${execute} button')?.disabled===false`);
}
function openDetails(selector:string){browser('wait',selector+' > summary');if(!inspect(`document.querySelector('${selector}')?.open===true`))press(selector+' > summary');}
function latest(){const owner=state().owner;assert(owner);return JSON.parse(owner);}
async function receipts(name:string){
 try{return (await readFile(join(evidence,name),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
async function held(){
 const until=Date.now()+15000;
 while(!(await control('/delay-status','GET')).waiting){assert(Date.now()<until,'ACTUAL_OWNER_RESPONSE_NOT_HELD');await new Promise(yes=>setTimeout(yes,40));}
}
function boundary(operation:string){
 inspect(`(()=>{window.x5Boundary={states:[],completed:[]};const capture=()=>{const p=document.querySelector('${panel}'),s={workId:p?.dataset.learningWork,compilationId:p?.dataset.learningId,message:p?.querySelector('p[role=status]')?.textContent,owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Latest owner response')?.parentElement?.querySelector('pre')?.textContent??null};if(JSON.stringify(window.x5Boundary.states.at(-1))!==JSON.stringify(s))window.x5Boundary.states.push(s)};window.x5DOM=new MutationObserver(capture);window.x5DOM.observe(document.body,{subtree:true,childList:true,characterData:true});window.x5Network=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.name.includes(${JSON.stringify('company-brain/'+operation)}))window.x5Boundary.completed.push({responseEnd:entry.responseEnd})});window.x5Network.observe({type:'resource'});capture();return true})()`);
}
function endBoundary(){
 browser('wait','--fn','window.x5Boundary.completed.length>0');
 inspect('(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>window.x5Boundary.settled=true));return true})()');
 browser('wait','--fn','window.x5Boundary.settled===true');
 return inspect('(()=>{window.x5DOM.disconnect();window.x5Network.disconnect();return window.x5Boundary})()');
}
function fillExecute(record:any){
 browser('wait',execute+' button:not([disabled])');
 browser('fill',execute+' label:nth-of-type(1) input',f.sourceApplicationId);
 browser('fill',execute+' label:nth-of-type(2) input',record.id);
 browser('select',execute+' label:nth-of-type(4) select','RETENTION');
}
async function compileWork(workId:string,selection:any[]){
 openDetails(panel+' > details:nth-of-type(2)');
 browser('fill',compile+' textarea',JSON.stringify(selection));browser('fill',compile+' input',f.knowledgeCut);
 click('Inspect canonical accepted experience');browser('wait','--fn',`document.querySelector('${panel}')?.textContent.includes('"acceptedCount": 8')===true`);
 const experience=latest();assert.equal(experience.acceptedCount,8);
 click('Compile and train under original Work');browser('wait','--fn',`document.querySelector('${panel}')?.dataset.learningId!=='none'&&document.querySelector('${panel}')?.textContent.includes('QUEUED')===true`);
 await control('/worker');current(workId);
 const observed=state();assert.equal(observed.workId,workId);return {observed,experience};
}
try{
 signIn(f.email,f.url);
 assert.equal(state().compilationId,'none');
 openDetails(rights);
 browser('fill',rights+' form label:nth-of-type(1) input',f.sourceApplicationId);
 browser('fill',rights+' form label:nth-of-type(2) input',f.validUntil);
 browser('fill',rights+' form label:nth-of-type(3) input',f.knowledgeCut);
 click('Grant explicit training consent');browser('wait','--fn',`document.querySelector('${panel}')?.textContent.includes('"consentId"')===true`);
 const consent=latest();assert(consent.consentId);
 const selection=f.experience.map((v:any)=>({...v,consentId:consent.consentId}));
 const first=await compileWork(f.workId,selection),firstId=first.observed.compilationId;
 navigate(f.otherUrl);
 const second=await compileWork(f.otherWorkId,selection),secondId=second.observed.compilationId;
 assert.notEqual(firstId,secondId);
 steps.push({id:'visible-consent-canonical-experience-and-two-original-Work-compilations',consent,first,second,additionalEligibleAssignments:0});
 navigate(f.url);current(f.workId);
 const screenshots=join(evidence,'screenshots');await mkdir(screenshots,{recursive:true});
 browser('scrollintoview',panel+' h4');
 browser('screenshot',join(screenshots,basename(evidence)+'-mounted-current.png'));

 // Both success and transport-error releases span an actual automatically
 // refreshed signed browser session. New token issuance is long-lived, only
 // after the real short-lived login, so no artificial refresh event is used.
 for(const failed of [false,true]){
  await control('/auth-short-lived');signOut();signIn(f.email,f.url);await control('/auth-long-lived');current(f.workId);
  const beforeAuth=await control('/auth-status','GET'),record=await control('/fresh');fillExecute(record);
  await control('/delay-execute');boundary('learning-execute');click('Run guarded next step');await held();
  const committed=await control('/observe','GET'),use=committed.uses.find((v:any)=>v.request.recordId===record.id);assert(use);
  const heldReceipt=(await receipts('held-owner-responses.jsonl')).find((v:any)=>v.path.endsWith('/learning-execute')&&v.input.recordId===record.id);assert(heldReceipt);
  assert.equal(heldReceipt.ownerStatus,202);assert.equal((await control('/auth-status','GET')).refreshes,beforeAuth.refreshes);
  await control('/worker');
  const until=Date.now()+45000;let afterAuth:any;
  do{
   afterAuth=await control('/auth-status','GET');
   assert(Date.now()<until,'REAL_AUTOMATIC_SIGNED_REFRESH_NOT_OBSERVED');
   if(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses)await new Promise(yes=>setTimeout(yes,150));
  }while(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses);
  assert.equal(inspect('window.x5Boundary.completed.length'),0,'The original reply must remain held through refresh');
  current(f.workId);assert(state().retry);assert.equal(state().owner,null);
  await control(failed?'/release-error':'/release');const late=endBoundary();
  assert.equal(state().owner,null);assert(state().retry);
  click('Retry original owner request');browser('wait','--fn',`document.querySelector('${panel}')?.textContent.includes('"replayed": true')===true`);
  const retried=await control('/observe','GET'),matching=retried.uses.filter((v:any)=>v.request.recordId===record.id);
  assert.equal(matching.length,1);assert.equal(matching[0].id,use.id);
  const reconciliations=retried.events.filter((v:any)=>v.kind==='BUSINESS_COMMAND'&&v.record_id===record.id&&v.body.input.actionId==='reconcile');
  assert.equal(reconciliations.length,1);
  assert.equal(retried.deliveries.filter((v:any)=>v.use_id===use.id&&v.outcome==='completed').length,1);
  const replay=(await receipts('http.jsonl')).find((v:any)=>v.path.endsWith('/learning-execute')&&v.output?.useId===use.id&&v.output?.replayed===true);
  assert(replay);assert.deepEqual(replay.input,heldReceipt.input);assert.equal(replay.transport,'ACTUAL_BUILT_NEXT_API');assert.equal(replay.authBypass,false);
  const approved=await control('/approve');assert.equal(approved.record.authorPrincipalId,f.principal);assert(approved.record.approvals.every((v:any)=>v.principalId!==f.principal));
  steps.push({id:failed?'held-error-across-automatic-refresh-exact-replay':'held-success-across-automatic-refresh-exact-replay',
   recordId:record.id,useId:use.id,beforeAuth,afterAuth,late,heldReceipt,replay,approved,oneUse:true,oneNativeReconciliation:true});
  await artifact(evidence,'browser-progress.json',{steps,complete:false});
 }
 for(const failed of [false,true]){
  current(f.workId);await control('/delay-list');click('Reload learned policy');await held();
  navigate(f.otherUrl);current(f.otherWorkId);assert.equal(state().compilationId,secondId);
  boundary('learning-list');await control(failed?'/release-error':'/release');const late=endBoundary();
  for(const value of late.states){assert.equal(value.workId,f.otherWorkId);assert.equal(value.compilationId,secondId);}
  current(f.otherWorkId);assert.equal(state().compilationId,secondId);navigate(f.url);current(f.workId);
  steps.push({id:failed?'late-Work-list-error-does-not-clear-new-policy':'late-Work-list-success-does-not-resurrect-old-policy',late,from:firstId,to:secondId});
 }
 const interrupted=await control('/fresh');fillExecute(interrupted);await control('/delay-execute');click('Run guarded next step');await held();await control('/worker');
 signOut();signIn(f.partnerEmail,f.partnerUrl);await control('/release-error');
 assert.equal(state().retry,false);assert.equal(state().owner,null);
 const differentPrincipal=state();signOut();signIn(f.email,f.url);current(f.workId);assert.equal(state().retry,false);
 steps.push({id:'logout-and-different-current-principal-cannot-resume-old-request',recordId:interrupted.id,differentPrincipal,restored:state()});
 browser('open',f.url);focus();current(f.workId);assert.equal(state().retry,false);
 openDetails(rights);
 browser('fill',rights+' > label:nth-of-type(1) input',consent.consentId);
 browser('fill',rights+' > label:nth-of-type(2) input','Visible owner revocation after mounted proof');
 click('Revoke derived use, retain audit');
 browser('wait','--fn',`document.querySelector('${panel}')?.textContent.includes('not current')===true&&document.querySelectorAll('${execute}').length===0`);
 const revokedFirst=state();assert.equal(revokedFirst.compilationId,firstId);
 navigate(f.otherUrl);
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.learningId===${JSON.stringify(secondId)}&&document.querySelector('${panel}')?.textContent.includes('not current')===true`);
 assert.equal(state().executeForms,0);
 const sql=await control('/observe','GET');
 assert(sql.consents.find((v:any)=>v.id===consent.consentId)?.revoked_at);
 for(const id of [firstId,secondId]){const row=sql.compilations.find((v:any)=>v.id===id);assert.equal(row.attempt_count,1);assert(row.head_release_id);}
 browser('screenshot',join(screenshots,basename(evidence)+'-mounted-revoked.png'));
 steps.push({id:'reload-and-visible-consent-revocation-withholds-both-dependent-policies',revokedFirst,revokedOther:state()});
 await artifact(evidence,'browser-results.json',{status:'PASS_MOUNTED_EMITTED_X5_LOCAL_DEVELOPMENT',session:derived,steps,
  sqlReadback:'browser-sql-readback.json',qualification:f.qualification,extraEligibleScientificAssignments:0,protectedAdmission:false,productionActive:false,credentialsRetained:false});
 passed=true;
}catch(error){
 let visibleState:unknown;try{visibleState=state();}catch{/* Preserve the original browser failure. */}
 try{browser('screenshot',join(evidence,'browser-failure.png'));}catch{/* Do not mask the original exception. */}
 await artifact(evidence,'browser-FAILED.json',{error:String(error),stack:(error as Error).stack,visibleState,steps});throw error;
}finally{
 browser('close');
 await control('/stop');
 console.log('X5_BROWSER_RESULT',passed?'PASS_LOCAL_DEVELOPMENT':'FAIL_RETAINED');
}
