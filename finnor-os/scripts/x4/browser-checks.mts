/** Actual emitted Work, signed browser authentication, native owner replies and
 * real network changes. No storage writes or synthetic authentication events. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {artifact,repo} from '../x3/environment.mts';
assert(process.env.FINNOR_X4_EVIDENCE_DIR);
const evidence=resolve(process.env.FINNOR_X4_EVIDENCE_DIR),f=JSON.parse(await readFile(join(evidence,'browser-fixture.json'),'utf8'));
assert([f.base,f.control].every((v:string)=>/^http:\/\/127\.0\.0\.1:\d+$/.test(v)));
const session=process.env.AGENT_BROWSER_SESSION??spawnSync('agent-browser',['session','id','--scope','worktree','--prefix','x4'],{cwd:repo,encoding:'utf8'}).stdout.trim();
assert(session);
const env={...process.env,AGENT_BROWSER_SESSION:session},panel='.ct-identified-system',steps:any[]=[];
const rights=panel+' > fieldset:first-of-type > details:first-of-type',registration=panel+' > fieldset:first-of-type > details:nth-of-type(2) form';
const useButton='Resolve model for actual guarded decision use';
let passed=false;
function browser(...args:string[]){
 const r=spawnSync('agent-browser',args,{cwd:repo,env,encoding:'utf8',timeout:65000});if(r.status!==0)throw Error('BROWSER_'+args[0]+':'+r.stdout+r.stderr);return r.stdout;
}
function inspect(expression:string){const r=JSON.parse(browser('--json','eval',expression));assert(r.success,JSON.stringify(r));return r.data.result;}
function click(name:string){
 browser('wait','--fn',`Array.from(document.querySelectorAll('button')).some(b=>(b.textContent?.trim()===${JSON.stringify(name)}||b.getAttribute('aria-label')===${JSON.stringify(name)})&&!b.matches(':disabled'))`);
 browser('find','role','button','click','--name',name,'--exact');
}
function press(selector:string){browser('wait',selector+':not(:disabled)');browser('focus',selector);browser('press','Enter');}
function details(selector:string){browser('wait',selector+' > summary');if(!inspect(`document.querySelector('${selector}')?.open===true`))press(selector+' > summary');}
function focus(){browser('wait','--text','Autonomous system identification');click('Focus Autonomous system identification');browser('wait',panel);}
function signIn(email:string,url:string){
 browser('open','--allowed-domains','127.0.0.1',f.base+'/centropy/login');browser('wait','input[type=email]');
 browser('fill','input[type=email]',email);browser('fill','input[type=password]','r1-disposable-only');
 browser('wait','button[type=submit]:not([disabled])');press('button[type=submit]');browser('wait','--url','**/centropy');browser('open',url);focus();
}
function signOut(){
 press('details.ct-account > summary');click('Sign out');browser('wait','--text','Your investment context stays private.');
 assert.equal(inspect(`document.querySelectorAll('${panel} fieldset,${panel} pre').length`),0);
}
function navigate(url:string){browser('pushstate',url);browser('wait','--text',url===f.otherUrl?'X4 identified system Work 1':'X4 identified system Work 0');focus();}
function state(){return inspect(`(()=>{const p=document.querySelector('${panel}');return {workId:p?.dataset.identificationWork,id:p?.dataset.identificationId,message:p?.querySelector('p[role=status]')?.textContent,forms:p?.querySelectorAll('fieldset').length??0,retry:Array.from(p?.querySelectorAll('button')??[]).some(b=>b.textContent==='Retry original identification request'),owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Latest identification owner response')?.parentElement?.querySelector('pre')?.textContent??null,preCount:p?.querySelectorAll('pre').length??0}})()`);}
function current(){
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.identificationId===${JSON.stringify(f.identificationId)}&&document.querySelector('${panel}')?.textContent.includes('DEVELOPMENT_READY')===true&&Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent===${JSON.stringify(useButton)}&&!b.disabled)`);
}
function latest(){const value=state().owner;assert(value);return JSON.parse(value);}
async function control(path:string,method='POST'){
 const r=await fetch(f.control+path,{method,headers:{connection:'close'},signal:AbortSignal.timeout(45000)}),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body as any;
}
async function held(){
 const until=Date.now()+15000;while(!(await control('/delay-status','GET')).waiting){assert(Date.now()<until,'ACTUAL_OWNER_REPLY_NOT_HELD');await new Promise(yes=>setTimeout(yes,50));}
}
async function receipts(name:string){
 try{
  const content=await readFile(join(evidence,name),'utf8');
  // A live reader may catch the final append in progress. Only the unfinished
  // tail is deferred; every newline-terminated record must still parse exactly.
  return content.slice(0,content.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(v=>JSON.parse(v));
 }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
}
function boundary(operation:string,interval?:{start:number;end:number}){
 inspect(`(()=>{window.x4Boundary={states:[],completed:[]};const capture=()=>{const p=document.querySelector('${panel}'),s={workId:p?.dataset.identificationWork,id:p?.dataset.identificationId,owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Latest identification owner response')?.parentElement?.querySelector('pre')?.textContent??null};if(JSON.stringify(window.x4Boundary.states.at(-1))!==JSON.stringify(s))window.x4Boundary.states.push(s)};window.x4DOM=new MutationObserver(capture);window.x4DOM.observe(document.body,{subtree:true,childList:true,characterData:true});const interval=${JSON.stringify(interval??null)};window.x4Network=new PerformanceObserver(list=>{for(const e of list.getEntries())if(e.name.includes(${JSON.stringify('company-brain/'+operation)})&&(!interval||(e.startTime>=interval.start&&e.startTime<=interval.end)))window.x4Boundary.completed.push({startTime:e.startTime,responseEnd:e.responseEnd})});window.x4Network.observe({type:'resource'});capture();return true})()`);
}
function endBoundary(){
 browser('wait','--fn','window.x4Boundary.completed.length>0');inspect('(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>window.x4Boundary.settled=true));return true})()');browser('wait','--fn','window.x4Boundary.settled===true');
 return inspect('(()=>{window.x4DOM.disconnect();window.x4Network.disconnect();return window.x4Boundary})()');
}
const screenshots=join(repo,'scope-x4/evidence');
try{
 signIn(f.email,f.url);current();
 details(panel+' > details:nth-of-type(5)');
 const model=inspect(`JSON.parse(document.querySelector('${panel} > details:nth-of-type(5) pre').textContent)`);
 assert.equal(model.id,f.modelId);assert.equal(model.protectedAdmission,false);assert.equal(model.productionActive,false);
 click('Read retained lifecycle and failed attempts');browser('wait','--text','Retained immutable history, newest page first');
 const history=inspect(`JSON.parse(Array.from(document.querySelectorAll('${panel} > details')).find(d=>d.querySelector('summary')?.textContent==='Retained immutable history, newest page first').querySelector('pre').textContent)`);
 assert(history.length>0&&history.length<=25);
 steps.push({id:'mounted-current-scientific-model-full-envelope-and-actual-history',observed:state(),modelId:model.id,historyIds:history.map((v:any)=>v.id)});
 await mkdir(screenshots,{recursive:true});browser('scrollintoview',panel+' h4');browser('screenshot',join(screenshots,basename(evidence)+'-mounted-current.png'));
 const audit=JSON.parse(browser('--json','a11y','--selector',panel));await artifact(evidence,'browser-accessibility.json',audit);
 const violations=audit.data?.violations??audit.data?.result?.violations;assert(Array.isArray(violations),'An actual axe violation array is required');
 assert(!violations.some((v:any)=>['critical','serious'].includes(v.impact)),JSON.stringify(violations));
 // Hold a real read past the actual four-second polling interval. A poll must
 // not supersede that useful response merely because the owner is slow.
 await control('/delay-read');click('Reload identified system');await held();
 const slowRead=(await receipts('held-owner-responses.jsonl')).filter((v:any)=>v.path.endsWith('/identification-read')).at(-1);assert(slowRead);
 await new Promise(yes=>setTimeout(yes,5200));
 const overlapping=(await receipts('http.jsonl')).filter((v:any)=>v.path.endsWith('/identification-list')&&v.input?.workId===f.workId&&Date.parse(v.at)>Date.parse(slowRead.at));
 assert.equal(overlapping.length,0,'Polling must be single-flight while an actual owner read is held');
 assert.equal(state().id,'none');await control('/release');current();
 steps.push({id:'slow-real-owner-read-survives-polling-interval',heldRead:slowRead,overlappingPolls:overlapping.length,observed:state()});

 // A second real Work gets its own visible consent and question. It stays
 // honestly QUEUED, not an invented additional scientific completion.
 navigate(f.otherUrl);browser('wait','--fn',`document.querySelector('${panel}')?.dataset.identificationId==='none'&&document.querySelector('${panel} fieldset')!==null`);
 details(rights);
 browser('fill',rights+' label:nth-of-type(1) textarea',JSON.stringify(f.domain));
 for(const [index,value] of [[2,f.sourceTargetId],[3,f.replicationTargetId],[4,f.replicator],[5,f.validUntil]] as const)browser('fill',rights+` label:nth-of-type(${index}) input`,value);
 click('Grant explicit experiment rights');browser('wait','--fn',`document.querySelector('${panel}')?.textContent.includes('"consentId"')===true`);
 const consent=latest();assert(consent.consentId);
 browser('wait',panel+' > fieldset:first-of-type:not(:disabled)');
 details(panel+' > fieldset:first-of-type > details:nth-of-type(2)');
 browser('fill',registration+' label:nth-of-type(1) textarea','Why does this permitted export omit records, and which controlled complete export should the owner request?');
 for(const [index,value] of [[2,'Role-bound disposable export service'],[3,'Wait for complete checked export before test reconciliation.'],[5,f.workstreamId],[6,f.investmentCaseId]] as const)browser('fill',registration+` label:nth-of-type(${index}) input`,value);
 assert.equal(inspect(`document.querySelector('${registration}').checkValidity()`),true,'The real registered question form must satisfy native validation');
 press(registration+' button');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.identificationId!=='none'&&document.querySelector('${panel}')?.textContent.includes('QUEUED')===true`);
 const secondId=state().id;assert.notEqual(secondId,f.identificationId);
 steps.push({id:'keyboard-and-pointer-real-consent-and-second-Work-question-intake',consent,observed:state(),additionalScientificCompletions:0});
 navigate(f.url);current();
 for(const failed of [false,true]){
  await control('/auth-short-lived');signOut();signIn(f.email,f.url);await control('/auth-long-lived');current();
  const beforeAuth=await control('/auth-status','GET'),before=await control('/observe','GET');
  await control('/delay-use');boundary('identification-use');click(useButton);await held();
  const committed=await control('/observe','GET'),added=committed.uses.filter((v:any)=>!before.uses.some((b:any)=>b.id===v.id));assert.equal(added.length,1);
  const original=(await receipts('held-owner-responses.jsonl')).find((v:any)=>v.output?.useId===added[0].id);assert(original);assert.equal(original.ownerStatus,202);
  const until=Date.now()+45000;let afterAuth:any;
  do{afterAuth=await control('/auth-status','GET');assert(Date.now()<until,'REAL_AUTOMATIC_SIGNED_REFRESH_NOT_OBSERVED');
   if(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses)await new Promise(yes=>setTimeout(yes,120));
  }while(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses);
  assert.equal(inspect('window.x4Boundary.completed.length'),0,'Original owner reply must remain held through actual token refresh');current();assert(state().retry);assert.equal(state().owner,null);
  await control(failed?'/release-error':'/release');const late=endBoundary();assert.equal(state().owner,null);assert(state().retry);
  click('Retry original identification request');browser('wait','--fn',`document.querySelector('${panel}')?.textContent.includes('"replayed": true')===true`);
  const replay=(await receipts('http.jsonl')).find((v:any)=>v.output?.useId===added[0].id&&v.output?.replayed===true);
  assert(replay);assert.deepEqual(replay.input,original.input);assert.equal(replay.transport,'ACTUAL_BUILT_NEXT_API');assert.equal(replay.authBypass,false);
  const after=await control('/observe','GET');assert.equal(after.uses.filter((v:any)=>v.id===added[0].id).length,1);assert.equal(after.effects.length,before.effects.length);
  steps.push({id:failed?'held-error-across-actual-token-refresh-exact-replay':'held-success-across-actual-token-refresh-exact-replay',beforeAuth,afterAuth,original,replay,late,
   originalUseId:added[0].id,additionalPhysicalExperiments:0,queuedAcknowledgmentIsNotCompletion:true});await artifact(evidence,'browser-progress.json',{steps,complete:false});
 }
 for(const failed of [false,true]){
  current();await control('/delay-list');const start=inspect('performance.now()');click('Reload identified system');await held();const end=inspect('performance.now()');
  navigate(f.otherUrl);browser('wait','--fn',`document.querySelector('${panel}')?.dataset.identificationId===${JSON.stringify(secondId)}`);
  boundary('identification-list',{start,end});await control(failed?'/release-error':'/release');const late=endBoundary();
  for(const s of late.states){assert.equal(s.workId,f.otherWorkId);assert.equal(s.id,secondId);}
  steps.push({id:failed?'late-old-Work-list-error-fenced':'late-old-Work-list-success-fenced',late});navigate(f.url);current();
 }
 await control('/delay-use');click(useButton);await held();
 signOut();signIn(f.outsiderEmail,f.outsiderUrl);await control('/release-error');
 browser('wait','--fn',`document.querySelector('${panel}')?.textContent.includes('cannot be verified')===true`);
 const outsider=state();assert.equal(outsider.id,'none');assert.equal(outsider.retry,false);assert.equal(outsider.owner,null);assert.equal(outsider.preCount,0);assert.equal(outsider.forms,0);
 signOut();signIn(f.email,f.url);current();assert.equal(state().retry,false);
 steps.push({id:'logout-and-unconsented-principal-cannot-read-or-resume-old-private-request',outsider,restored:state()});
 const beforeOffline=await control('/observe','GET');let offline:any;
 browser('set','offline','on');
 try{browser('wait','--fn',`navigator.onLine===false&&document.querySelector('${panel}')?.dataset.identificationId==='none'`);offline=state();assert.equal(offline.preCount,0);assert.equal(offline.forms,0);}
 finally{browser('set','offline','off');}
 current();const afterOffline=await control('/observe','GET');assert.equal(afterOffline.effects.length,beforeOffline.effects.length);assert.deepEqual(afterOffline.models,beforeOffline.models);
 steps.push({id:'actual-network-disconnect-clears-private-derivatives-and-reconnect-rereads-owner',offline,reconnected:state(),noAdditionalEffect:true});
 browser('open',f.url);focus();current();assert.equal(state().retry,false);
 details(rights);browser('fill',rights+' label:nth-of-type(6) input',f.consentId);browser('fill',rights+' label:nth-of-type(7) input','Visible explicit rights revocation after mounted privacy proof');
 click('Revoke future use, retain evidence and effects');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.identificationId===${JSON.stringify(f.identificationId)}&&document.querySelector('${panel}')?.textContent.includes('not current')===true`);
 const revoked=state(),sql=await control('/observe','GET');
 assert(sql.revocations.some((v:any)=>v.consent_id===f.consentId));assert.equal(sql.models.length,1);
 assert.equal(sql.identifications.find((v:any)=>v.id===f.identificationId).use_count,4);assert.equal(sql.effects.length,beforeOffline.effects.length);
 browser('screenshot',join(screenshots,basename(evidence)+'-mounted-revoked.png'));
 await writeFile(join(evidence,'browser-accessible-tree.txt'),browser('snapshot','-i','-s',panel));
 steps.push({id:'reload-and-visible-rights-revocation-preserves-audit-and-original-spend',revoked});
 await artifact(evidence,'browser-results.json',{status:'PASS_MOUNTED_EMITTED_X4_DEVELOPMENT',session,steps,qualification:f.qualification,protectedAdmission:false,productionActive:false,
  sourceOfTruth:'ACTUAL_OWNER_AND_SQL_READBACK_NOT_BROWSER_STATE',extraEligibleScientificAssignments:0,credentialsRetained:false});passed=true;
}catch(error){
 let observed:unknown;try{observed=state();await writeFile(join(evidence,'browser-failed-tree.txt'),browser('snapshot','-i'));}catch{}
 await artifact(evidence,'browser-FAILED.json',{error:String(error),stack:(error as Error).stack,observed,steps});throw error;
}finally{
 browser('close');await control('/stop');console.log('X4_BROWSER_RESULT',passed?'PASS_DEVELOPMENT':'FAIL_RETAINED');
}
