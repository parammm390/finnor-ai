/** Real browser E2E using a named, task-owned session. Never copies tokens,
 * cookies or browser storage. Run against run-browser.mts's disposable fixture. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {readFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {artifact,repo} from './environment.mts';

const evidence=resolve(process.env.FINNOR_X3_EVIDENCE_DIR!);
assert(process.env.FINNOR_X3_EVIDENCE_DIR);
const f=JSON.parse(await readFile(join(evidence,'fixture.json'),'utf8'));
assert([f.base,f.control].every(s=>/^http:\/\/127\.0\.0\.1:\d+$/.test(s)));
const session=process.env.AGENT_BROWSER_SESSION??spawnSync('agent-browser',['session','id','--scope','worktree','--prefix','x3'],{cwd:repo,encoding:'utf8'}).stdout.trim();
assert(session);
const focused=process.env.FINNOR_X3_BROWSER_FOCUS==='rotation-pagination';
const steps:any[]=[],env={...process.env,AGENT_BROWSER_SESSION:session};
let passed=false;
function browser(...args:string[]){
 const r=spawnSync('agent-browser',args,{cwd:repo,env,encoding:'utf8',timeout:60000});
 if(r.status!==0)throw Error('BROWSER_'+args[0]+':'+r.stdout+r.stderr);
 return r.stdout;
}
function inspect(expression:string){const r=JSON.parse(browser('--json','eval',expression));assert(r.success,JSON.stringify(r));return r.data.result;}
async function control(path:string,method='POST'){
 const r=await fetch(f.control+path,{method,headers:{connection:'close'},signal:AbortSignal.timeout(45000)}),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body as any;
}
const panel='.ct-enterprise-application';
const selectRecord=panel+' > label:nth-of-type(2) select';
function press(selector:string){browser('focus',selector);browser('press','Enter');}
function signIn(email:string,url:string){
 browser('open',f.base+'/centropy/login');browser('wait','input[type="email"]');
 browser('fill','input[type="email"]',email);browser('fill','input[type="password"]','x3-disposable-only');
 browser('wait','button[type="submit"]:not([disabled])');press('button[type="submit"]');
 browser('wait','--url','**/centropy');browser('open',url);browser('wait','--text','Enterprise application');
 browser('find','role','button','click','--name','Focus Enterprise application');browser('wait',panel);
}
function signOut(){
 press('details.ct-account > summary');browser('find','role','button','click','--name','Sign out');
 browser('wait','--text','Your investment context stays private.');
 assert.equal(inspect(`document.querySelectorAll('${panel} form[data-application-action]').length`),0);
 browser('find','role','link','click','--name','Sign in','--exact');browser('wait','--url','**/centropy/login');
}
function runAction(action:string){const button=panel+' form[data-application-action="'+action+'"] button[type="submit"]';browser('wait',button+':not([disabled])');press(button);}
async function delivery(){const r=await control('/worker');assert.equal(r.code,0,JSON.stringify(r));}
async function installed(){await delivery();await delivery();browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);}
function fillRecordInput(memo:string){
 const create=panel+' form[data-application-action="create"]',previous=inspect(`document.querySelector('${selectRecord}')?.value??''`);
 browser('wait',create+' button[type="submit"]:not([disabled])');
 browser('fill',create+' [data-application-field="memo"]',memo);browser('fill',create+' [data-application-field="remediation"]',f.recordInput.remediation);browser('fill',create+' [data-application-field="support"]',JSON.stringify(f.support));
 return previous;
}
function recordInput(memo:string){
 const previous=fillRecordInput(memo);
 press(panel+' form[data-application-action="create"] button[type="submit"]');
 browser('wait','--fn',`document.querySelector('${panel} article pre')?.textContent.includes(${JSON.stringify(memo)})===true&&document.querySelector('${selectRecord}')?.value!==${JSON.stringify(previous)}`);
}
function state(){return inspect(`({status:document.querySelector('${panel}')?.dataset.applicationStatus,applicationId:document.querySelector('${panel}')?.dataset.applicationId,record:document.querySelector('${panel} article')?.innerText??null,forms:Array.from(document.querySelectorAll('${panel} form[data-application-action]')).map(x=>x.dataset.applicationAction),injected:window.x3Injected===true,guestElements:document.querySelectorAll('${panel} img,${panel} script').length})`);}
async function heldResponse(){
 const until=Date.now()+15000;while(!(await control('/delay-status','GET')).waiting){assert(Date.now()<until,'DELAYED_OWNER_RESPONSE_NOT_OBSERVED');await new Promise(yes=>setTimeout(yes,50));}
}
function beginBoundary(operation:string){
 inspect(`(()=>{window.x3BoundaryObservation={messages:[],records:[],completedReads:[]};const capture=()=>{const text=document.querySelector('${panel} > p[role="status"]')?.textContent;const rows=window.x3BoundaryObservation.messages;if(text&&rows.at(-1)!==text){rows.push(text);if(rows.length>64)rows.shift();}const record={selected:document.querySelector('${selectRecord}')?.value??null,values:document.querySelector('${panel} article > pre')?.textContent??null};const records=window.x3BoundaryObservation.records;if(JSON.stringify(records.at(-1))!==JSON.stringify(record)){records.push(record);if(records.length>64)records.shift();}};window.x3BoundaryObserver=new MutationObserver(capture);window.x3BoundaryObserver.observe(document.querySelector('${panel}'),{subtree:true,childList:true,characterData:true});window.x3BoundaryResources=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.name.includes(${JSON.stringify('company-brain/'+operation)})){const rows=window.x3BoundaryObservation.completedReads;rows.push({responseEnd:entry.responseEnd});if(rows.length>64)rows.shift();}});window.x3BoundaryResources.observe({type:'resource'});capture();return true;})()`);
}
function endBoundary(){
 browser('wait','--fn','window.x3BoundaryObservation.completedReads.length>0');
 inspect('(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>{window.x3BoundaryObservation.framesSettled=true}));return true;})()');
 browser('wait','--fn','window.x3BoundaryObservation.framesSettled===true');
 return inspect('(()=>{window.x3BoundaryObserver.disconnect();window.x3BoundaryResources.disconnect();return window.x3BoundaryObservation;})()');
}
async function receipts(name:string){
 const source=(await readFile(join(evidence,name),'utf8')).trim();
 return source?source.split('\n').map(line=>JSON.parse(line)):[];
}
/** Separate fresh-fixture mode: supplements rather than changes the original
 * 21-record/two-build campaign or any frozen independently authored case. */
async function focusedCases(){
 await control('/auth-short-lived');signOut();signIn(f.email,f.url);
 // Only future issuance changes. Supabase must rotate the actual short-lived
 // browser session automatically; no token/storage APIs or synthetic response.
 await control('/auth-long-lived');
 const authBefore=await control('/auth-status','GET'),memo='Committed creation spanning automatic token rotation';
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 fillRecordInput(memo);await control('/delay-command');beginBoundary('application-command');runAction('create');await heldResponse();
 const committed=await control('/observe','GET');assert.equal(committed.records.length,1);
 const original=committed.records[0];assert.equal(original.values.memo,memo);
 const held=(await receipts('held-owner-responses.jsonl')).find(row=>row.path==='/api/company-brain/application-command'&&row.output?.record?.id===original.id);
 assert(held);assert.equal(held.ownerStatus,200);assert.equal(held.output.decision.allowed,true);
 const authAtCommit=await control('/auth-status','GET');assert.equal(authAtCommit.refreshes,authBefore.refreshes,'Creation must commit before automatic rotation');
 const until=Date.now()+45000;let auth=authAtCommit;
 while(auth.refreshes===authBefore.refreshes||auth.refreshedApiSuccesses===authBefore.refreshedApiSuccesses){
  assert(Date.now()<until,'Automatic signed refresh and refreshed API use were not observed');
  await new Promise(yes=>setTimeout(yes,250));auth=await control('/auth-status','GET');
 }
 assert.equal(inspect('window.x3BoundaryObservation.completedReads.length'),0,'Original mutation response settled before automatic rotation');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 assert.equal(inspect(`document.querySelector('${selectRecord}')?.value`),'','Old mutation must not restore selection after token rotation');
 await control('/release-error');const boundary=endBoundary();
 recordInput(memo);
 const retried=await control('/observe','GET');assert.equal(retried.records.length,1);assert.equal(retried.records[0].id,original.id);
 assert.equal(inspect(`document.querySelector('${selectRecord}').value`),original.id);
 const replay=(await receipts('http.jsonl')).find(row=>row.path==='/api/company-brain/application-command'&&row.input?.input?.memo===memo&&row.output?.replayed===true);
 assert(replay,'Retry must replay the committed original invocation');assert.equal(replay.input.idempotencyKey,held.input.idempotencyKey);
 assert.equal(replay.bearer,true);assert.equal(replay.authBypass,false);assert.equal(replay.transport,'ACTUAL_BUILT_NEXT_API');
 assert.equal(retried.events.filter((event:any)=>event.kind==='BUSINESS_COMMAND'&&event.record_id===original.id).length,1);
 steps.push({id:'uncertain-committed-create-spans-real-automatic-refresh-and-replays-original-key',recordId:original.id,authBefore,authAtCommit,authAfter:auth,boundary,idempotencyKeyRetained:true,committedRecords:1,committedCommands:1,observed:state()});
 await artifact(evidence,'browser-focused-rotation.json',{steps:[steps.at(-1)],heldReceipt:'held-owner-responses.jsonl',failedTransportReceipt:'http-fixture-errors.jsonl',replayReceipt:'http.jsonl'});

 for(let i=1;i<21;i++)recordInput('Focused UUID pagination seed '+i);
 const seeded=await control('/observe','GET');assert.equal(seeded.records.length,21);
 const cursor=seeded.records[19].id;
 browser('find','role','button','click','--name','Next record page');
 browser('wait','--fn',`Array.from(document.querySelectorAll('${panel} button')).some(node=>node.textContent==='First record page')&&document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 const trials:any[]=[];let outsideRecord:any;
 // UUIDs remain real owner-generated values. A finite campaign fails rather
 // than fabricating a record ID or claiming an unobserved off-page case.
 for(let attempt=1;attempt<=8;attempt++){
  const value='Created outside current UUID page trial '+attempt;recordInput(value);
  const observed=await control('/observe','GET'),record=observed.records.find((row:any)=>row.values.memo===value);assert(record);
  assert.equal(observed.records.length,21+attempt);
  const pageIds=observed.records.filter((row:any)=>row.id>cursor).slice(0,20).map((row:any)=>row.id),outside=!pageIds.includes(record.id);
  const mounted=inspect(`({selected:document.querySelector('${selectRecord}').value,options:Array.from(document.querySelector('${selectRecord}').options).filter(option=>option.value).map(option=>({id:option.value,outside:option.textContent.includes('(selected outside this page)')})),values:JSON.parse(document.querySelector('${panel} article > pre').textContent)})`);
  assert.equal(mounted.selected,record.id);assert.deepEqual(mounted.values,record.values);
  assert.deepEqual(mounted.options.filter((option:any)=>!option.outside).map((option:any)=>option.id),pageIds);
  assert(pageIds.length<=20);assert.equal(mounted.options.filter((option:any)=>option.outside).length,outside?1:0);
  trials.push({attempt,recordId:record.id,outside,pageIds,mounted});
  if(outside){outsideRecord=record;break;}
 }
 assert(outsideRecord,'No owner-generated creation fell outside the current page within the finite campaign');
 const recordReads=(await receipts('http.jsonl')).filter(row=>row.path==='/api/company-brain/application-record'&&row.input?.recordId===outsideRecord.id);
 assert(recordReads.length>0);
 for(const row of recordReads){assert.equal(row.status,200);assert.equal(row.bearer,true);assert.equal(row.authBypass,false);assert.equal(row.transport,'ACTUAL_BUILT_NEXT_API');assert.equal(row.output.id,outsideRecord.id);}
 steps.push({id:'real-owner-created-record-selected-outside-unchanged-twenty-record-page',cursor,trials,recordId:outsideRecord.id,authorizedRecordReads:recordReads.length,observed:state()});

 browser('find','role','button','click','--name','First record page');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 const targets=(await control('/observe','GET')).records.slice(0,2);
 for(const failed of [false,true]){
  if(inspect(`document.querySelector('${selectRecord}').value`)!==''){
   beginBoundary('application-read');browser('select',selectRecord,'');endBoundary();
  }
  await control('/delay-record');browser('select',selectRecord,targets[0].id);await heldResponse();
  const delayed=(await receipts('held-owner-responses.jsonl')).filter(row=>row.path==='/api/company-brain/application-record').at(-1);
  assert.equal(delayed?.output?.id,targets[0].id);
  browser('select',selectRecord,targets[1].id);
  browser('wait','--fn',`document.querySelector('${selectRecord}')?.value===${JSON.stringify(targets[1].id)}&&document.querySelector('${panel} article > pre')?.textContent.includes(${JSON.stringify(targets[1].values.memo)})===true`);
  beginBoundary('application-record');await control(failed?'/release-error':'/release');const fence=endBoundary();
  for(const rendered of fence.records){assert.equal(rendered.selected,targets[1].id);assert(rendered.values,'The new selection must not be cleared, even transiently');assert.deepEqual(JSON.parse(rendered.values),targets[1].values);}
  assert.equal(inspect(`document.querySelector('${selectRecord}').value`),targets[1].id);
  assert.deepEqual(inspect(`JSON.parse(document.querySelector('${panel} article > pre').textContent)`),targets[1].values);
  assert.equal(state().applicationId,seeded.applications[0].id);
  steps.push({id:failed?'delayed-record-read-failure-cannot-clear-new-selection':'delayed-record-read-success-cannot-replace-new-selection',fromRecord:targets[0].id,toRecord:targets[1].id,boundary:fence,observed:state()});
 }
 const sql=await control('/observe','GET');assert.equal(sql.records.length,21+trials.length);assert.equal(sql.applications.length,1);assert.equal(sql.applications[0].build_count,1);
 browser('screenshot',join(evidence,'mounted-rotation-pagination.png'));
 await artifact(evidence,'browser-focused-results.json',{status:'PASS_LOCAL_BROWSER_FOCUSED_ROTATION_PAGINATION',session,steps,sqlReadback:'sql-readback.json',qualification:f.qualification,protectedAdmission:false,productionActive:false});
}
try{
 signIn(f.email,f.url);
 let sql=await control('/observe','GET');
 steps.push({id:'actual-login-and-mounted-work',existingApplications:sql.applications.length,authBypass:false});
 assert.equal(sql.applications.length,0,'A full browser campaign starts from zero applications');
 browser('wait',panel+' > details:first-of-type > summary');
  press(panel+' > details:first-of-type > summary');browser('find','label','Business specification JSON','fill',JSON.stringify(f.specification));
  browser('find','role','button','click','--name','Construct application');browser('wait','--text','QUEUED');await installed();
  press(panel+' > details:first-of-type > summary');
  press(panel+' > details:last-of-type > summary');
  const mountedPackage=inspect(`JSON.parse(document.querySelector('${panel} > details:last-of-type pre').textContent)`);
  assert.equal(mountedPackage.envelope.artifact_id,mountedPackage.id);
  assert.equal(mountedPackage.envelope.kind,'EnterpriseApplicationPackage');
  assert.equal(mountedPackage.envelope.content_digest_basis,'IMMUTABLE_X3_RELEASE_BODY_V1');
  assert.equal(mountedPackage.envelope.lifecycle_state.releaseState,'INSTALLED_DEVELOPMENT');
  assert.equal(mountedPackage.envelope.admitted_domain_ref.kind,'UNKNOWN');
  assert.equal(mountedPackage.envelope.attributable_human_work_refs.kind,'UNKNOWN');
  steps.push({id:'mounted-complete-common-envelope',artifactId:mountedPackage.id,contentDigest:mountedPackage.envelope.content_digest,sourceRefs:mountedPackage.envelope.source_refs.length,productionActive:false});
  press(panel+' > details:last-of-type > summary');
  if(focused){
   await focusedCases();passed=true;console.log('X3_MOUNTED_BROWSER_FOCUSED_CHECKS_PASS');
  }else{
  recordInput(f.recordInput.memo);recordInput(f.recordInput.memo);
  const duplicate=await control('/observe','GET');assert.equal(duplicate.records.length,2);assert(duplicate.records.every((record:any)=>record.values.memo===f.recordInput.memo));
  steps.push({id:'consecutive-identical-creation-uses-new-logical-invocations',recordIds:duplicate.records.map((record:any)=>record.id)});
  runAction('document');browser('wait','--text','EVIDENCED · CURRENT');
  runAction('close');browser('wait','--text','ROLE_DENIED');
  steps.push({id:'construct-create-transition-and-role-denial',observed:state()});
  await control('/grant-reviewer');browser('wait',panel+' form[data-application-action="close"] button:not([disabled])');
  runAction('close');browser('wait','--text','SELF_APPROVAL_DENIED');
  steps.push({id:'definitive-refusal-does-not-cache-role-denial-after-current-grant',observed:state()});await control('/remove-reviewer');
  const operatedRecordId=inspect(`document.querySelector('${selectRecord}').value`),originalApplication=state().applicationId,refreshStarted=Date.now(),refreshDeadline=Date.now()+120000;
  let auth=await control('/auth-status','GET');
  while(auth.refreshes<=f.authBaseline.refreshes||auth.refreshedApiSuccesses<=f.authBaseline.refreshedApiSuccesses){
   assert(Date.now()<refreshDeadline,'ACTUAL_BROWSER_REFRESH_EXCHANGE_NOT_OBSERVED');
   await new Promise(yes=>setTimeout(yes,1000));auth=await control('/auth-status','GET');
  }
  await control('/auth-long-lived');
  browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
  browser('select',selectRecord,operatedRecordId);browser('wait','--text','EVIDENCED · CURRENT');
  assert.equal(state().applicationId,originalApplication);
  steps.push({id:'actual-browser-token-refresh-retains-installed-record',auth,wallMs:Date.now()-refreshStarted,recordId:operatedRecordId,applicationId:originalApplication,observed:state()});
  signOut();signIn(f.reviewerEmail,f.reviewerUrl);
  browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
  browser('select',selectRecord,operatedRecordId);runAction('close');browser('wait','--text','CLOSED · CURRENT');
  const reviewed=await control('/observe','GET');
  assert.equal(reviewed.records.find((record:any)=>record.id===operatedRecordId)?.state,'CLOSED');
  assert(reviewed.events.some((event:any)=>event.record_id===operatedRecordId&&event.kind==='BUSINESS_COMMAND'&&event.actor_id===f.reviewer&&event.body.result.decision.outcome==='CLOSED'));
  steps.push({id:'genuine-independent-partner-sign-in-and-business-action',principalId:f.reviewer,recordId:operatedRecordId,auth:reviewed.auth,observed:state()});
  signOut();signIn(f.email,f.url);
  browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
  browser('select',selectRecord,operatedRecordId);browser('wait','--text','CLOSED · CURRENT');
  assert.equal(state().applicationId,originalApplication);
  steps.push({id:'genuine-logout-fresh-analyst-sign-in-retains-partner-result',principalId:f.principal,recordId:operatedRecordId,observed:state()});
   const reconnectBefore=await control('/observe','GET');let offline:ReturnType<typeof state>|undefined;
   browser('wait',panel+' > button:first-of-type:not([disabled])');browser('set','offline','on');
   try{
    assert.equal(inspect('navigator.onLine'),false);press(panel+' > button:first-of-type');
    browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationId==='none'`);
    offline=state();assert.equal(offline.record,null);assert.equal(offline.forms.length,0);
   }finally{browser('set','offline','off');}
   browser('open',f.url);browser('wait','--text','Enterprise application');
   browser('find','role','button','click','--name','Focus Enterprise application');
   browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
   browser('select',selectRecord,operatedRecordId);browser('wait','--text','CLOSED · CURRENT');
   const reconnected=await control('/observe','GET');assert.equal(state().applicationId,originalApplication);
   assert.equal(reconnected.applications[0].head_release_id,reconnectBefore.applications[0].head_release_id);
   assert.equal(reconnected.events.length,reconnectBefore.events.length);assert.equal(reconnected.records.length,reconnectBefore.records.length);
   steps.push({id:'real-network-disconnect-clears-forms-and-reconnect-reload-retains-canonical-result',offline,recordId:operatedRecordId,headReleaseId:reconnected.applications[0].head_release_id,observed:state()});
  const historyButton=panel+' > button:nth-of-type(2)';
  browser('wait',historyButton+':not([disabled])');press(historyButton);browser('wait','--text','Canonical application history');
  const history=inspect(`JSON.parse(Array.from(document.querySelectorAll('${panel} > details')).find(d=>d.querySelector('summary')?.textContent==='Canonical application history').querySelector('pre').textContent)`);
  const historyCommands=history.events.filter((event:any)=>event.kind==='BUSINESS_COMMAND').length;
  assert(historyCommands>=2);assert(JSON.stringify(history).includes(JSON.stringify(f.recordInput.memo)));
  steps.push({id:'mounted-immutable-history-retains-literal-and-commands',committedCommands:historyCommands});
  press(panel+' > details:has(select) > summary');browser('find','label','Replacement business specification','fill',JSON.stringify(f.replacement));
  browser('find','label','Explicit additive migration JSON','fill','[]');
  const maintenanceForm=panel+' > details:has(select) form';
  browser('wait','--fn',`document.querySelector(${JSON.stringify(maintenanceForm)})?.checkValidity()===true&&!document.querySelector(${JSON.stringify(maintenanceForm+' button[type="submit"]')})?.disabled`);
  const maintenanceBefore=inspect(`Array.from(document.querySelectorAll(${JSON.stringify(maintenanceForm)})).map(f=>({valid:f.checkValidity(),buttonDisabled:f.querySelector('button[type="submit"]')?.disabled,fields:Array.from(f.querySelectorAll('textarea,select')).map(x=>({tag:x.tagName,valid:x.checkValidity(),length:x.value.length}))}))`);
  await artifact(evidence,'browser-maintenance-before-submit.json',maintenanceBefore);
  inspect(`(()=>{const f=document.querySelector(${JSON.stringify(maintenanceForm)});f.addEventListener('submit',e=>{window.x3MaintenanceSubmit={trusted:e.isTrusted,valid:f.checkValidity(),at:Date.now()};});return true;})()`);
  press(maintenanceForm+' button[type="submit"]');browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='QUEUED'`);await installed();
  browser('wait','--text','Document revised remediation');steps.push({id:'declaration-only-browser-maintenance-preserves-record',observed:state()});
  const unknownReasons={uncertainText:'The narrative is not supplied',uncertainFlag:'The confirmation has not been observed',uncertainCategory:'No supported classification is known'};
  browser('wait',panel+' form[data-application-action="create"] button[type="submit"]:not([disabled])');
  for(const [id,reason] of Object.entries(unknownReasons)){
   const title={uncertainText:'Unresolved text',uncertainFlag:'Unresolved boolean',uncertainCategory:'Unresolved category'}[id as keyof typeof unknownReasons];
   browser('check',panel+' form[data-application-action="create"] input[aria-label="Use UNKNOWN for '+title+'"]');
   browser('fill',panel+' form[data-application-action="create"] [data-application-unknown-reason="'+id+'"]',reason);
  }
  recordInput('Explicit UNKNOWN scalar values');
  const unknownSql=await control('/observe','GET'),unknownRecord=unknownSql.records.find((record:any)=>record.values.memo==='Explicit UNKNOWN scalar values');assert(unknownRecord);
  for(const [id,reason] of Object.entries(unknownReasons))assert.deepEqual(unknownRecord.values[id],{kind:'UNKNOWN',reason});
  steps.push({id:'generated-text-boolean-enum-explicit-unknown',recordId:unknownRecord.id,values:unknownRecord.values});
  const historyTargets=unknownSql.records.slice(0,2);
  for(const failed of [false,true]){
   browser('select',selectRecord,historyTargets[0].id);await control('/delay-history');
   browser('wait',historyButton+':not([disabled])');press(historyButton);await heldResponse();
   browser('select',selectRecord,historyTargets[1].id);browser('wait',panel+' article');beginBoundary('application-history');
   await control(failed?'/release-error':'/release');const boundary=endBoundary(),selected=state();
   assert.equal(inspect(`document.querySelector('${selectRecord}')?.value`),historyTargets[1].id);
   assert.equal(selected.applicationId,unknownSql.applications[0].id);assert(selected.record);
   assert.equal(inspect(`Array.from(document.querySelectorAll('${panel} > details > summary')).some(summary=>summary.textContent==='Canonical application history')`),false);
   assert(!boundary.messages.includes('History is unavailable in the current scope.'));
   steps.push({id:failed?'stale-history-transport-failure-cannot-clear-new-record':'stale-history-success-cannot-appear-for-new-record',fromRecord:historyTargets[0].id,toRecord:historyTargets[1].id,boundary,observed:selected});
  }
 const before=state();assert.equal(before.injected,false);assert.equal(before.guestElements,0);
 const beforeReload=await control('/observe','GET');assert(beforeReload.records.length>0);
 browser('open',f.url);browser('wait','--text','Enterprise application');browser('find','role','button','click','--name','Focus Enterprise application');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 browser('select',selectRecord,beforeReload.records[0].id);browser('wait',panel+' article');
 steps.push({id:'full-browser-reload-preserves-canonical-record',observed:state()});
 for(let i=beforeReload.records.length;i<21;i++)recordInput('Pagination seed '+i);
 browser('find','role','button','click','--name','Next record page');
 browser('wait','--fn',`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent==='First record page')&&document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 const page=inspect(`({options:document.querySelector('${selectRecord}')?.options.length,firstPage:Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent==='First record page')})`);
 assert.equal(page.options,2);assert.equal(page.firstPage,true);steps.push({id:'twenty-one-real-records-and-next-page',observed:page});
 browser('find','role','button','click','--name','First record page');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 const screenshots=join(evidence,'screenshots');await mkdir(screenshots,{recursive:true});
 browser('screenshot',join(screenshots,'mounted.png'));
 const raceBefore=await control('/observe','GET'),raceRecord=raceBefore.records.find((record:any)=>record.state==='OPEN'&&record.release_id===raceBefore.applications[0].head_release_id);
 assert(raceRecord);browser('select',selectRecord,raceRecord.id);
 browser('wait','--fn',`JSON.parse(document.querySelector('${panel} article > details > pre')?.textContent??'null')?.reference.id===${JSON.stringify(raceRecord.id)}`);
 await control('/delay');runAction('document');
 await heldResponse();
 const raceCommitted=await control('/observe','GET');
 assert.equal(raceCommitted.records.find((record:any)=>record.id===raceRecord.id)?.state,'EVIDENCED');
 assert(raceCommitted.events.some((event:any)=>event.record_id===raceRecord.id&&event.kind==='BUSINESS_COMMAND'&&event.body.result.decision.outcome==='EVIDENCED'));
 const heldMutation=inspect(`({busy:document.querySelector('${panel} > button:first-of-type')?.disabled,message:document.querySelector('${panel} > p[role="status"]')?.textContent})`);
 assert.equal(heldMutation.busy,true);assert.notEqual(heldMutation.message,'EVIDENCED');
 browser('pushstate',f.otherUrl);browser('wait','--text','X3 separate Work');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationId==='none'`);
 const pending=state();assert.equal(pending.record,null);assert.equal(pending.forms.length,0);
 beginBoundary('application-list');
 await control('/release');browser('wait','--text','No application is installed for this Work');
 const boundary=endBoundary();
 assert(!boundary.messages.includes('EVIDENCED'),'Old mutation status must not reach the new Work, even transiently');
 const after=state();assert.equal(after.applicationId,'none');assert.equal(after.record,null);
 steps.push({id:'spa-work-switch-fences-delayed-committed-mutation-refresh',pending,after,recordId:raceRecord.id,committedState:'EVIDENCED',heldMutation,boundary});
 browser('pushstate',f.url);browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 await control('/revoke');press(panel+' > button:first-of-type');
 browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationId==='none'`);
 const revoked=state();assert.equal(revoked.record,null);assert.equal(revoked.forms.length,0);
 steps.push({id:'canonical-identity-revocation-clears-business-forms',observed:revoked});
 sql=await control('/observe','GET');assert.equal(sql.records.length,21);assert.equal(sql.applications.length,1);assert.equal(sql.applications[0].build_count,2);
 await artifact(evidence,'browser-results.json',{status:'PASS_LOCAL_BROWSER',session,steps,sqlReadback:'sql-readback.json',screenshots,qualification:f.qualification,protectedAdmission:false,productionActive:false});
 passed=true;
 console.log('X3_MOUNTED_BROWSER_CHECKS_PASS');
 }
}catch(error){
 let observed:unknown;
 try{observed=inspect(`({url:location.href,text:document.body.innerText.slice(0,12000),maintenanceSubmit:window.x3MaintenanceSubmit??null,forms:Array.from(document.querySelectorAll('${panel} form')).map(f=>({action:f.dataset.applicationAction??'construction-or-maintenance',valid:f.checkValidity(),buttonDisabled:f.querySelector('button[type="submit"]')?.disabled,fields:Array.from(f.querySelectorAll('textarea,select,input')).map(x=>({tag:x.tagName,valid:x.checkValidity(),length:x.value.length}))}))})`);}catch{observed='BROWSER_STATE_UNAVAILABLE';}
 await artifact(evidence,'browser-failure.json',{error:String(error),session,steps,observed});throw error;
}
finally{if(passed||process.env.FINNOR_X3_KEEP_BROWSER_FIXTURE_ON_FAILURE!=='1'){browser('close');await control('/stop').catch(()=>undefined);}}
