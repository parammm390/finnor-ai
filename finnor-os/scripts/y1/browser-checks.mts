/** Actual emitted WORLD Work, real password sign-in and automatic signed token
 * refresh. Controls delay genuine owner replies, never fabricate their bodies. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {artifact,repo,hash} from '../x3/environment.mts';
import {digest} from '../../packages/private-equity/src/economic-action-theory/contracts';
assert(process.env.FINNOR_Y1_EVIDENCE_DIR,'EXPLICIT_Y1_BROWSER_EVIDENCE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y1_EVIDENCE_DIR),f=JSON.parse(await readFile(join(evidence,'browser-fixture.json'),'utf8'));
assert([f.base,f.control].every((v:string)=>/^http:\/\/127\.0\.0\.1:\d+$/.test(v)));
const session=process.env.AGENT_BROWSER_SESSION??spawnSync('agent-browser',['session','id','--scope','worktree','--prefix','y1'],{cwd:repo,encoding:'utf8'}).stdout.trim();
assert(session,'NAMED_Y1_BROWSER_SESSION_REQUIRED');
const env={...process.env,AGENT_BROWSER_SESSION:session},panel='section[aria-label="Economic action theory"]',steps:any[]=[];
let passed=false;
function browser(...args:string[]){
 const r=spawnSync('agent-browser',args,{cwd:repo,env,encoding:'utf8',timeout:90000});
 if(r.status!==0)throw Error('Y1_BROWSER_'+args[0]+':'+r.stdout+r.stderr);return r.stdout;
}
function inspect(js:string){const result=JSON.parse(browser('--json','eval',js));assert(result.success,JSON.stringify(result));return result.data.result;}
function wait(js:string){browser('wait','--fn',js);}
function click(name:string){
 wait(`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent?.trim().startsWith(${JSON.stringify(name)})&&!b.disabled)`);
 browser('find','role','button','click','--name',name);
}
function enter(selector:string){browser('focus',selector);browser('press','Enter');}
async function control(path:string,method='POST'){
 const response=await fetch(f.control+path,{method,headers:{connection:'close'},signal:AbortSignal.timeout(180000)});
 const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value as any;
}
async function construct(theoryId:string){
 for(let i=0;i<5;i++){
  const native=await control('/observe','GET'),row=native.theories.find((v:any)=>v.id===theoryId);
  if(row?.status==='CHECKED')return;
  assert(!row||['QUEUED','CONSTRUCTING','CHECKING','CANDIDATE'].includes(row.status),'Y1_MOUNTED_CONSTRUCTION_'+row?.status);
  await control('/worker');
 }
 const native=await control('/observe','GET');
 assert.equal(native.theories.find((v:any)=>v.id===theoryId)?.status,'CHECKED','Y1_MOUNTED_NATIVE_CONSTRUCTION_DID_NOT_REACH_CHECKED');
}
function state(){return inspect(`(()=>{const p=document.querySelector('${panel}');return {
 workId:p?.dataset.economicWork??null,theoryId:p?.dataset.economicTheory??null,
 message:p?.querySelector('p[role=status]')?.textContent??null,
 owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Exact owner response')?.parentElement?.querySelector('pre')?.textContent??null,
 retry:Array.from(p?.querySelectorAll('button')??[]).some(b=>b.textContent==='Retry original economic request'),
 downloads:Array.from(p?.querySelectorAll('button')??[]).filter(b=>b.textContent==='Download checked economic artifact').length}})()`);}
function latest(){const value=state().owner;assert(value,'VISIBLE_EXACT_OWNER_RESPONSE_REQUIRED');return JSON.parse(value);}
function mount(workId:string){
 browser('wait',panel);
 wait(`document.querySelector('${panel}')?.dataset.economicWork===${JSON.stringify(workId)}&&Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent==='Reload economic theory'&&!b.disabled)`);
}
function current(workId=f.workId){
 mount(workId);wait(`document.querySelector('${panel}')?.dataset.economicTheory!=='none'&&document.querySelector('${panel} > p[role=status]')?.textContent?.startsWith('CHECKED.')===true`);
}
function signIn(email:string,url:string){
 browser('open','--allowed-domains','127.0.0.1',f.base+'/centropy/login');browser('wait','input[type="email"]');
 browser('fill','input[type="email"]',email);browser('fill','input[type="password"]','r1-disposable-only');
 browser('wait','button[type="submit"]:not([disabled])');enter('button[type="submit"]');
 browser('wait','--url','**/centropy');browser('open',url);mount(url===f.otherUrl?f.otherWorkId:f.workId);
}
function signOut(){
 enter('details.ct-account > summary');browser('find','role','button','click','--name','Sign out','--exact');
 browser('wait','--text','Your investment context stays private.');
 assert.equal(inspect(`document.querySelectorAll('${panel} textarea').length`),0);
}
function problem(value:any){
 const details=panel+' > details:first-of-type';
 if(!inspect(`document.querySelector('${details}')?.open===true`))enter(details+' > summary');
 browser('fill',details+' form textarea',JSON.stringify(value));
}
async function held(){
 const end=Date.now()+20000;
 while(!(await control('/delay-status','GET')).waiting){assert(Date.now()<end,'Y1_ACTUAL_OWNER_REPLY_NOT_HELD');await new Promise(yes=>setTimeout(yes,40));}
}
async function receipts(name:string){
 try{return (await readFile(join(evidence,name),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
function boundary(operation:string){
 inspect(`(()=>{window.y1Boundary={states:[],completed:[]};const capture=()=>{const p=document.querySelector('${panel}'),v={
 workId:p?.dataset.economicWork??null,theoryId:p?.dataset.economicTheory??null,
 owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Exact owner response')?.parentElement?.querySelector('pre')?.textContent??null};
 if(JSON.stringify(window.y1Boundary.states.at(-1))!==JSON.stringify(v))window.y1Boundary.states.push(v)};
 window.y1DOM=new MutationObserver(capture);window.y1DOM.observe(document.body,{subtree:true,childList:true,characterData:true});
 window.y1Network=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.name.includes(${JSON.stringify('company-brain/'+operation)}))window.y1Boundary.completed.push({responseEnd:entry.responseEnd})});
 window.y1Network.observe({type:'resource'});capture();return true})()`);
}
function endBoundary(){
 wait('window.y1Boundary.completed.length>0');
 inspect('(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>window.y1Boundary.settled=true));return true})()');
 wait('window.y1Boundary.settled===true');
 return inspect('(()=>{window.y1DOM.disconnect();window.y1Network.disconnect();return window.y1Boundary})()');
}
try{
 signIn(f.email,f.url);assert.equal(state().theoryId,'none');
 problem(f.problem);click('Queue economic construction');
 wait(`document.querySelector('${panel}')?.dataset.economicTheory!=='none'`);
 const original=state().theoryId;await construct(original);current();
 // A completed native PlanGraph legitimately closes Work. Download while its
 // cut is current; do not keep a finished Work artificially executable.
 const downloads=join(evidence,'downloads'),screenshots=join(evidence,'screenshots');await mkdir(downloads,{recursive:true});await mkdir(screenshots,{recursive:true});
 const downloaded=join(downloads,'checked-economic-theory.json');
 browser('download',panel+' > button:nth-of-type(3)',downloaded);
 const bytes=await readFile(downloaded),theory=JSON.parse(bytes.toString());
 assert.equal(theory.envelope.id,original);assert.equal(theory.envelope.status,'CHECKED');
 const receipt=(await receipts('http.jsonl')).find((v:any)=>v.path.endsWith('/economic-theory-artifact')&&v.output.theoryId===original);
 assert(receipt);assert.equal(hash(bytes),receipt.output.sha256);assert.equal(receipt.transport,'ACTUAL_BUILT_NEXT_API');
 browser('scrollintoview',panel+' h4');browser('screenshot',join(screenshots,'y1-mounted-checked.png'));

 for(const failed of [false,true]){
  await control('/auth-short-lived');signOut();signIn(f.email,f.url);await control('/auth-long-lived');current();
  const beforeAuth=await control('/auth-status','GET'),before=await control('/observe','GET');
  problem(f.problem);await control('/delay-submit');boundary('economic-theory-submit');click('Queue economic construction');await held();
  const accepted=await control('/observe','GET'),row=accepted.theories.filter((v:any)=>v.work_id===f.workId).at(-1);
  assert(row);assert.equal(accepted.theories.length,before.theories.length+1);await construct(row.id);
  const end=Date.now()+110000;let afterAuth:any;
  do{
   afterAuth=await control('/auth-status','GET');assert(Date.now()<end,'Y1_REAL_AUTOMATIC_SIGNED_REFRESH_NOT_OBSERVED');
   if(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses)await new Promise(yes=>setTimeout(yes,150));
  }while(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses);
  assert.equal(inspect('window.y1Boundary.completed.length'),0);current();assert(state().retry);assert.equal(state().owner,null);
  await control(failed?'/release-error':'/release');const late=endBoundary();
  assert.equal(state().owner,null);assert(state().retry);click('Retry original economic request');
  wait(`document.querySelector('${panel}')?.textContent.includes('"replayed": true')===true`);current();
  const after=await control('/observe','GET'),matching=after.theories.filter((v:any)=>v.idempotency_key===row.idempotency_key);
  assert.equal(matching.length,1);assert.equal(matching[0].id,row.id);
  const replies=await receipts('http.jsonl'),replay=replies.find((v:any)=>v.path.endsWith('/economic-theory-submit')&&v.output.theoryId===row.id&&v.output.replayed===true),
   heldReply=(await receipts('held-owner-responses.jsonl')).find((v:any)=>v.path.endsWith('/economic-theory-submit')&&v.output.theoryId===row.id);
  assert(replay&&heldReply);assert.deepEqual(replay.input,heldReply.input);
  assert.equal(after.episodes.find((v:any)=>v.work_id===f.workId).deadline_at,before.episodes.find((v:any)=>v.work_id===f.workId).deadline_at);
  steps.push({id:failed?'held-error-across-real-token-refresh-exact-original-replay':'held-success-across-real-token-refresh-exact-original-replay',
   theoryId:row.id,beforeAuth,afterAuth,late,heldReply,replay,oneOriginalRequest:true});
 }

 await control('/delay-read');boundary('economic-theory-read');click('Reload economic theory');await held();
 browser('pushstate',f.otherUrl);mount(f.otherWorkId);assert.equal(state().theoryId,'none');
 await control('/release');const switched=endBoundary();assert.equal(state().workId,f.otherWorkId);assert.equal(state().theoryId,'none');
 assert(switched.states.filter((v:any)=>v.workId===f.otherWorkId).every((v:any)=>v.theoryId==='none'&&v.owner===null));
 problem(f.otherProblem);click('Queue economic construction');
 wait(`document.querySelector('${panel}')?.dataset.economicWork===${JSON.stringify(f.otherWorkId)}&&document.querySelector('${panel}')?.dataset.economicTheory!=='none'`);
 await construct(state().theoryId);current(f.otherWorkId);
 const otherId=state().theoryId;assert.notEqual(otherId,original);
 steps.push({id:'spa-Work-switch-fences-actual-delayed-private-read-and-constructs-separate-Work',switched,otherId});

 browser('pushstate',f.url);current();await control('/delay-read');click('Reload economic theory');await held();
 signOut();signIn(f.peerEmail,f.peerUrl);assert.equal(state().theoryId,'none');await control('/release');
 mount(f.workId);assert.equal(state().theoryId,'none');assert.equal(state().owner,null);assert.equal(state().downloads,0);
 steps.push({id:'signed-principal-change-hides-old-private-theory-and-download',observed:state()});
 signOut();signIn(f.email,f.url);current();
 browser('select',panel+' > label select',original);
 wait(`document.querySelector('${panel}')?.dataset.economicTheory===${JSON.stringify(original)}`);
 current();
 click('Request typed development admission');
 wait(`document.querySelectorAll('${panel} > form').length===2`);
 browser('fill',panel+' > form:nth-of-type(1) textarea',JSON.stringify({initialState:{available:'3',committed:'2'},
  bindings:f.problem.quantities.map((q:any)=>({quantityId:q.id,resourceRef:f.resource.ref}))}));
 click('Reserve inside canonical S5 portfolio');
 wait(`document.querySelector('${panel}')?.textContent.includes('"economic-rights-reservation:')===true`);
 const heldReservation=latest();
 click('Inspect canonical reservation');
 wait(`document.querySelector('${panel}')?.textContent.includes('"economic-rights-reservation:')===true`);
 browser('fill',panel+' > form:nth-of-type(2) textarea',JSON.stringify({reservationRef:heldReservation.origin.ref,
  expectedRevision:heldReservation.revision,goalState:{available:'1',committed:'4'},parameters:{amount:'2'}}));
 click('Compose economic programme');
 wait(`document.querySelector('${panel}')?.textContent.includes('"finnor.s4.economic-programme.v1"')===true`);
 const programme=latest();click('Inspect original economic programme');
 wait(`document.querySelector('${panel}')?.textContent.includes('Programme: PREPARED')===true`);
 click('Queue guarded internal programme');
 // Fair native queue selection may first serve the retained prior probe.
 for(let i=0;i<5;i++){
  await control('/worker');const native=await control('/observe','GET');
  const own=native.obligations.find((v:any)=>v.programme_id===programme.id);
  if(own&&native.effects.some((v:any)=>v.id===own.effect_id&&v.status==='verified'))break;
  assert(i<4,'Y1_MOUNTED_NATIVE_PROGRAMME_DID_NOT_REACH_OBSERVATION');
 }
 click('Inspect original economic programme');
 wait(`document.querySelector('${panel}')?.textContent.includes('Programme: OBSERVED')===true`);
 const observed=latest(),sql=await control('/observe','GET');
 assert.equal(sql.reservations.length,1);assert.equal(sql.obligations.length,1);assert.equal(sql.effects.length,1);
 assert.equal(sql.effects[0].status,'verified');assert.equal(observed.observedGoalDigest,digest(programme.goalState));
 browser('screenshot',join(screenshots,'y1-mounted-observed.png'));
 steps.push({id:'mounted-construct-admit-reserve-compose-native-effect-canonical-observation-and-download',
  theoryId:original,programme,observed,download:{sha256:hash(bytes),bytes:bytes.length},sql});
 browser('pushstate',f.otherUrl);current(f.otherWorkId);
 await control('/steer-other');click('Reload economic theory');
 wait(`document.querySelector('${panel} > p[role=status]')?.textContent?.startsWith('INVALIDATED.')===true`);
 assert.equal(state().downloads,0);assert.equal(inspect(`document.querySelectorAll('${panel} > form').length`),0);
 steps.push({id:'mounted-current-Work-invalidation-disables-use-and-download',observed:state()});
 const final=await control('/observe','GET');
 assert.equal(final.effects.length,1);assert.equal(final.effects[0].status,'verified');assert.equal(final.obligations.length,1);
 await artifact(evidence,'browser-results.json',{status:'PASS_MOUNTED_EMITTED_Y1_DEVELOPMENT',session,steps,sql:final,
  screenshots,qualification:f.qualification,protectedQualification:false,productionActivated:false,financialEfficacy:false,
  rerun:'FINNOR_Y1_EVIDENCE_DIR=<new absolute directory> node --import=tsx scripts/y1/run-mounted.mts; then scripts/y1/browser-checks.mts in that directory'});
 passed=true;console.log('Y1_MOUNTED_BROWSER_CHECKS_PASS');
}catch(error){
 await artifact(evidence,'browser-failure.json',{error:String(error),stack:(error as Error).stack,steps,state:state()});throw error;
}finally{
 try{browser('close');}finally{if(passed)await control('/stop');}
}
