/** Signed browser E2E of the actual mounted Work. Delays hold real owner
 * responses. No response bodies, admissions, actions or outcomes are mocked. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {artifact,repo,hash} from '../x3/environment.mts';
import {digest} from '../../packages/private-equity/src/interaction-synthesis/contracts';

assert(process.env.FINNOR_Y3_EVIDENCE_DIR,'EXPLICIT_Y3_BROWSER_EVIDENCE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y3_EVIDENCE_DIR),
 f=JSON.parse(await readFile(join(evidence,'browser-fixture.json'),'utf8'));
assert([f.base,f.control].every((s:string)=>/^http:\/\/127\.0\.0\.1:\d+$/.test(s)));
const session=process.env.AGENT_BROWSER_SESSION??spawnSync('agent-browser',
 ['session','id','--scope','worktree','--prefix','y3'],{cwd:repo,encoding:'utf8'}).stdout.trim();
assert(session,'NAMED_Y3_BROWSER_SESSION_REQUIRED');
const env={...process.env,AGENT_BROWSER_SESSION:session},panel='section[aria-label="Dynamic interaction protocol"]',
 steps:any[]=[],screenshots=join(evidence,'screenshots');
let passed=false;
function browser(...args:string[]){
 const r=spawnSync('agent-browser',args,{cwd:repo,env,encoding:'utf8',timeout:90000});
 if(r.status!==0)throw Error('Y3_BROWSER_'+args[0]+':'+r.stdout+r.stderr);return r.stdout;
}
function inspect(js:string){
 const result=JSON.parse(browser('--json','eval',js));assert(result.success,JSON.stringify(result));return result.data.result;
}
const wait=(js:string)=>browser('wait','--fn',js);
function click(name:string){
 wait(`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent?.trim().startsWith(${JSON.stringify(name)})&&!b.disabled)`);
 browser('find','role','button','click','--name',name);
}
const fill=(label:string,value:unknown)=>browser('find','label',label,'fill',typeof value==='string'?value:JSON.stringify(value));
function enter(selector:string){browser('focus',selector);browser('press','Enter');}
async function control(path:string,method='POST'){
 const r=await fetch(f.control+path,{method,headers:{connection:'close'},signal:AbortSignal.timeout(180000)}),
  value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value as any;
}
function state(){
 return inspect(`(()=>{const p=document.querySelector('${panel}');return {
 workId:p?.dataset.interactionWork??null,protocolId:p?.dataset.interactionProtocol??null,
 message:p?.querySelector('p[role=status]')?.textContent??null,
 response:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Exact interaction owner response')?.parentElement?.querySelector('pre')?.textContent??null,
 local:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Your lawful observations and next actions')?.parentElement?.querySelector('pre')?.textContent??null,
 run:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Original run and canonical readback')?.parentElement?.querySelector('pre')?.textContent??null,
 retry:Array.from(p?.querySelectorAll('button')??[]).some(b=>b.textContent==='Retry original interaction request'),
 downloads:Array.from(p?.querySelectorAll('button')??[]).filter(b=>b.textContent==='Download checked interaction artifact').length,
 ownerDetails:Array.from(p?.querySelectorAll('summary')??[]).some(s=>s.textContent==='Constructed policy, exact incentive and global-belief checks'),
 textareas:p?.querySelectorAll('textarea').length??0}})()`);
}
function latest(){const raw=state().response;assert(raw,'VISIBLE_OWNER_RESPONSE_REQUIRED');return JSON.parse(raw);}
function mount(workId=f.workId){
 browser('wait',panel);
 wait(`document.querySelector('${panel}')?.dataset.interactionWork===${JSON.stringify(workId)}&&Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent==='Reload interaction protocol'&&!b.disabled)`);
}
function current(workId=f.workId){
 mount(workId);
 wait(`document.querySelector('${panel}')?.dataset.interactionProtocol!=='none'&&document.querySelector('${panel} > p[role=status]')?.textContent?.startsWith('CHECKED.')===true`);
}
function choose(id:string){
 browser('find','label','Interaction','select',id,'--exact');
 wait(`document.querySelector('${panel}')?.dataset.interactionProtocol===${JSON.stringify(id)}`);current();
}
function signIn(email:string,url:string,workId=f.workId){
 browser('open','--allowed-domains','127.0.0.1',f.base+'/centropy/login');browser('wait','input[type="email"]');
 browser('fill','input[type="email"]',email);browser('fill','input[type="password"]','r1-disposable-only');
 browser('wait','button[type="submit"]:not([disabled])');enter('button[type="submit"]');
 browser('wait','--url','**/centropy');browser('open',url);mount(workId);
}
function signOut(){
 enter('details.ct-account > summary');browser('find','role','button','click','--name','Sign out','--exact');
 browser('wait','--text','Your investment context stays private.');
 assert.equal(inspect(`document.querySelectorAll('${panel} pre').length`),0);
}
function problem(input:any){
 const summary=panel+' > details:first-of-type > summary';
 if(!inspect(`document.querySelector('${summary}')?.parentElement?.open===true`))enter(summary);
 fill('Original problem, fixed Y1 lowering and canonical source bindings JSON',input);
}
async function constructed(id:string){
 for(let i=0;i<6;i++){
  const sql=await control('/observe','GET'),row=sql.protocols.find((v:any)=>v.id===id);
  if(row?.status==='CHECKED')return;
  assert(!row||['QUEUED','CONSTRUCTING','CHECKING'].includes(row.status),'Y3_NATIVE_CONSTRUCTION_'+row?.status);
  await control('/worker');
 }
 throw Error('Y3_MOUNTED_NATIVE_CONSTRUCTION_NOT_CHECKED');
}
async function held(){
 const end=Date.now()+20000;
 while(!(await control('/delay-status','GET')).waiting){
  assert(Date.now()<end,'ACTUAL_Y3_OWNER_REPLY_NOT_HELD');await new Promise(yes=>setTimeout(yes,30));
 }
}
async function receipts(name:string){
 try{return (await readFile(join(evidence,name),'utf8')).trim().split('\n').filter(Boolean).map(v=>JSON.parse(v));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
function boundary(operation:string){
 inspect(`(()=>{window.y3Boundary={states:[],completed:[]};const capture=()=>{const p=document.querySelector('${panel}'),value={
 workId:p?.dataset.interactionWork??null,protocolId:p?.dataset.interactionProtocol??null,
 privatePre:p?.querySelectorAll('pre').length??0};
 if(JSON.stringify(window.y3Boundary.states.at(-1))!==JSON.stringify(value))window.y3Boundary.states.push(value)};
 window.y3DOM=new MutationObserver(capture);window.y3DOM.observe(document.body,{subtree:true,childList:true,characterData:true});
 window.y3Network=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.name.includes(${JSON.stringify('company-brain/'+operation)}))window.y3Boundary.completed.push({responseEnd:entry.responseEnd})});
 window.y3Network.observe({type:'resource'});capture();return true})()`);
}
function endBoundary(){
 wait('window.y3Boundary.completed.length>0');
 inspect('(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>window.y3Boundary.settled=true));return true})()');
 wait('window.y3Boundary.settled===true');
 return inspect('(()=>{window.y3DOM.disconnect();window.y3Network.disconnect();return window.y3Boundary})()');
}
try{
 await mkdir(screenshots,{recursive:true});
 signIn(f.email,f.url);assert.equal(state().protocolId,'none');
 problem(f.input);click('Queue dynamic synthesis');
 wait(`document.querySelector('${panel}')?.dataset.interactionProtocol!=='none'`);
 const original=state().protocolId;await constructed(original);current();
 const downloadPath=join(evidence,'checked-interaction-protocol.json');
 browser('download',panel+' > button:nth-of-type(3)',downloadPath);
 const bytes=await readFile(downloadPath),download=JSON.parse(bytes.toString());
 assert.equal(download.envelope.id,original);assert.equal(download.envelope.status,'CHECKED');
 assert.equal(download.envelope.independentChecks[0].globalBeliefConsistency,true);
 const downloaded=(await receipts('http.jsonl')).find((r:any)=>r.path.endsWith('/interaction-artifact')&&r.output.protocolId===original);
 assert(downloaded);assert.equal(downloaded.transport,'ACTUAL_BUILT_NEXT_API');assert.equal(hash(bytes),downloaded.output.sha256);
 const accessibility=JSON.parse(browser('--json','a11y','--selector',panel)),
  violations=accessibility.data?.violations??accessibility.data?.result?.violations;
 assert(accessibility.success&&Array.isArray(violations),'ACTUAL_SCOPED_ACCESSIBILITY_AUDIT_REQUIRED');
 await artifact(evidence,'mounted-accessibility.json',accessibility);assert.equal(violations.length,0,JSON.stringify(violations));
 browser('scrollintoview',panel+' h4');browser('screenshot',join(screenshots,'y3-mounted-checked.png'));
 steps.push({id:'mounted-original-models-native-synthesis-global-beliefs-and-download',protocolId:original,download:{bytes:bytes.length,sha256:hash(bytes)}});

 await control('/delay-local?protocolId='+original);boundary('interaction-local');click('Reload interaction protocol');await held();
 browser('pushstate',f.otherUrl);mount(f.otherWorkId);assert.equal(state().protocolId,'none');
 await control('/release');const switched=endBoundary();assert.equal(state().protocolId,'none');
 assert(switched.states.filter((v:any)=>v.workId===f.otherWorkId).every((v:any)=>v.protocolId==='none'&&v.privatePre===0));
 problem(f.otherInput);click('Queue dynamic synthesis');wait(`document.querySelector('${panel}')?.dataset.interactionProtocol!=='none'`);
 const other=state().protocolId;await constructed(other);current(f.otherWorkId);
 steps.push({id:'spa-Work-switch-fences-delayed-participant-projection',switched,other});

 browser('pushstate',f.url);current();choose(original);await control('/delay-read?protocolId='+original);
 click('Reload interaction protocol');await held();signOut();signIn(f.peerEmail,f.peerUrl);current();
 assert.equal(state().ownerDetails,false);assert.equal(state().downloads,0);
 await control('/release');current();assert.equal(state().ownerDetails,false);assert.equal(state().response,null);
 steps.push({id:'logout-and-signed-peer-change-hide-owner-private-models-and-download',observed:state()});
 signOut();signIn(f.outsiderEmail,f.outsiderUrl);mount();assert.equal(state().protocolId,'none');
 steps.push({id:'nonparticipant-cannot-inspect-protocol',observed:state()});
 signOut();signIn(f.email,f.url);current();choose(original);

 for(const failed of [false,true]){
  await control('/auth-short-lived');signOut();signIn(f.email,f.url);await control('/auth-long-lived');current();
  const beforeAuth=await control('/auth-status','GET'),before=await control('/observe','GET');
  problem(f.input);await control('/delay-submit');boundary('interaction-submit');click('Queue dynamic synthesis');await held();
  const accepted=await control('/observe','GET'),row=accepted.protocols.filter((v:any)=>v.work_id===f.workId).at(-1);
  assert(row);assert.equal(accepted.protocols.length,before.protocols.length+1);await constructed(row.id);
  if(!failed){
   inspect("(()=>{window.dispatchEvent(new Event('focus'));return true})()");
   current();assert(state().retry);
   assert.equal(inspect(`Array.from(document.querySelectorAll('${panel} button')).find(b=>b.textContent==='Retry original interaction request')?.disabled`),false);
   steps.push({id:'focus-during-held-native-mutation-releases-busy-latch-without-dropping-original',observed:state()});
  }
  const end=Date.now()+110000;let afterAuth:any;
  do{
   afterAuth=await control('/auth-status','GET');assert(Date.now()<end,'REAL_SIGNED_AUTOMATIC_REFRESH_NOT_OBSERVED');
   if(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses)
    await new Promise(yes=>setTimeout(yes,150));
  }while(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses);
  assert.equal(inspect('window.y3Boundary.completed.length'),0);current();assert(state().retry);assert.equal(state().response,null);
  await control(failed?'/release-error':'/release');const late=endBoundary();
  assert.equal(state().response,null);assert(state().retry);click('Retry original interaction request');
  wait(`document.querySelector('${panel}')?.textContent.includes('"replayed": true')===true`);current();
  const after=await control('/observe','GET'),matching=after.protocols.filter((v:any)=>v.idempotency_key===row.idempotency_key);
  assert.equal(matching.length,1);assert.equal(matching[0].id,row.id);
  assert.equal(after.episodes.find((v:any)=>v.work_id===f.workId).deadline_at,before.episodes.find((v:any)=>v.work_id===f.workId).deadline_at);
  const replay=(await receipts('http.jsonl')).find((v:any)=>v.path.endsWith('/interaction-submit')&&v.output.protocolId===row.id&&v.output.replayed),
   heldReply=(await receipts('held-owner-responses.jsonl')).find((v:any)=>v.path.endsWith('/interaction-submit')&&v.output.protocolId===row.id);
  assert(replay&&heldReply);assert.deepEqual(replay.input,heldReply.input);
  steps.push({id:failed?'delayed-error-across-real-token-refresh-original-replay':'delayed-success-across-real-token-refresh-original-replay',
   beforeAuth,afterAuth,late,replay,oneOriginalRequest:true});
 }

 problem(f.input);await control('/delay-submit');click('Queue dynamic synthesis');await held();
 const offlineAccepted=(await control('/observe','GET')).protocols.filter((v:any)=>v.work_id===f.workId).at(-1);
 browser('set','offline','on');wait('navigator.onLine===false');
 wait(`document.querySelector('${panel}')?.querySelectorAll('pre').length===0&&document.querySelector('${panel}')?.querySelectorAll('textarea').length===0`);
 assert.equal(state().protocolId,'none');
 await constructed(offlineAccepted.id);await control('/release-error');
 browser('set','offline','off');wait('navigator.onLine===true');current();assert(state().retry);
 click('Retry original interaction request');wait(`document.querySelector('${panel}')?.textContent.includes('"replayed": true')===true`);
 current();const afterOffline=await control('/observe','GET');
 assert.equal(afterOffline.protocols.filter((v:any)=>v.idempotency_key===offlineAccepted.idempotency_key).length,1);
 steps.push({id:'offline-in-flight-clears-private-state-and-recovers-original-without-stuck-busy',observed:state(),protocolId:offlineAccepted.id});

 choose(original);click('Request typed interaction development admission');
 wait(`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent==='Publish exact interaction terms')`);
 fill('Original canonical reservation reference and expected revision JSON',{reservationRef:f.reservation.origin.ref,expectedRevision:f.reservation.revision});
 click('Publish exact interaction terms');
 wait(`document.querySelector('${panel}')?.textContent.includes('"finnor.s4.interaction-terms.v1"')===true`);
 const terms=latest();click('Accept exact protocol terms');
 wait(`document.querySelector('${panel}')?.textContent.includes('"finnor.s4.interaction-consent.v1"')===true`);
 signOut();signIn(f.peerEmail,f.peerUrl);current();choose(original);assert.equal(state().ownerDetails,false);
 click('Accept exact protocol terms');wait(`document.querySelector('${panel}')?.textContent.includes('"decision": "ACCEPT"')===true`);
 signOut();signIn(f.email,f.url);current();choose(original);click('Start consented local continuation');
 wait(`document.querySelector('${panel}')?.textContent.includes('NEEDS_LAWFUL_OBSERVATION')===true`);
 fill('Available observation, classification and canonical fact source JSON',f.observation);
 click('Record participant-local observation');
 wait(`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent?.trim().startsWith('Record engage,'))`);
 click('Record engage,');wait(`document.querySelector('${panel}')?.textContent.includes('NOT_YOUR_TURN')===true`);
 signOut();signIn(f.peerEmail,f.peerUrl);current();choose(original);
 wait(`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent?.trim().startsWith('Record accept,'))`);
 const peerLocal=JSON.parse(state().local);assert(!peerLocal.observations.some((v:any)=>v.key==='private-type'));
 click('Record accept,');wait(`document.querySelector('${panel}')?.textContent.includes('Continuation: READY')===true`);
 click('Consent to this exact internal effect');wait(`document.querySelector('${panel}')?.textContent.includes('"scope": "EFFECT"')===true`);
 signOut();signIn(f.email,f.url);current();choose(original);
 click('Consent to this exact internal effect');wait(`document.querySelector('${panel}')?.textContent.includes('"scope": "EFFECT"')===true`);
 click('Lower consented intent through fixed Y1 owners');
 wait(`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent==='Queue guarded original internal effect')`);
 const lowered=latest();assert(lowered.programmeId);
 click('Queue guarded original internal effect');
 for(let i=0;i<6;i++){
  await control('/worker');const sql=await control('/observe','GET'),obligation=sql.obligations.find((v:any)=>v.programme_id===lowered.programmeId);
  if(obligation&&sql.effects.some((v:any)=>v.id===obligation.effect_id&&v.status==='verified'))break;
  assert(i<5,'MOUNTED_NATIVE_EFFECT_DID_NOT_REACH_CANONICAL_OBSERVATION');
 }
 click('Reload interaction protocol');
 wait(`document.querySelector('${panel}')?.textContent.includes('Canonical native outcome: OBSERVED.')===true`);
 const observed=JSON.parse(state().run);assert.equal(observed.nativeProgramme.status,'OBSERVED');
 assert.equal(observed.nativeProgramme.observedGoalDigest,digest({available:'1',committed:'4'}));
 assert(observed.nativeProgramme.obligations[0].verification.canonicalObservationRef);
 browser('screenshot',join(screenshots,'y3-mounted-observed.png'));
 steps.push({id:'mounted-two-principal-terms-local-knowledge-separate-effect-consents-fixed-native-effect-and-S7-readback',
  protocolId:original,terms,peerLocal,lowered,observed});

 browser('pushstate',f.otherUrl);current(f.otherWorkId);
 await control('/steer-other');click('Reload interaction protocol');
 wait(`document.querySelector('${panel} > p[role=status]')?.textContent?.startsWith('INVALIDATED.')===true`);
 assert.equal(state().downloads,0);
 assert.equal(inspect(`Array.from(document.querySelectorAll('${panel} button')).filter(b=>b.textContent==='Publish exact interaction terms'||b.textContent==='Accept exact protocol terms').length`),0);
 steps.push({id:'Work-revision-invalidates-use-without-rebinding-old-consents',observed:state()});
 await control('/revoke');click('Reload interaction protocol');
 wait(`document.querySelector('${panel}')?.dataset.interactionProtocol==='none'||document.querySelector('${panel} > p[role=status]')?.textContent?.startsWith('INVALIDATED.')===true`);
 assert.equal(state().downloads,0);
 steps.push({id:'rights-revision-fences-mounted-private-results-and-new-use',observed:state()});
 const sql=await control('/observe','GET');assert.equal(sql.effects.length,1);assert.equal(sql.effects[0].status,'verified');
 assert.equal(sql.obligations.length,1);assert.equal(sql.bindings.length,1);
 assert(sql.consents.some((c:any)=>c.principal_id===f.peer&&c.scope==='TERMS'));
 assert(sql.consents.some((c:any)=>c.principal_id===f.peer&&c.scope==='EFFECT'));
 await artifact(evidence,'browser-results.json',{schema:'finnor.y3.mounted-campaign.v1',status:'PASS_MOUNTED_EMITTED_Y3_DEVELOPMENT',
  session,steps,sql,screenshots,qualification:f.qualification,protectedQualification:false,productionActivated:false,
  financialEfficacyEstablished:false,sourceParity:'UNKNOWN'});
 passed=true;console.log('Y3_MOUNTED_BROWSER_CHECKS_PASS',steps.length);
}catch(error){
 await artifact(evidence,'browser-failure.json',{error:String(error),stack:(error as Error).stack,steps,state:state()});throw error;
}finally{
 try{browser('set','offline','off');browser('close');}finally{if(passed)await control('/stop');}
}
