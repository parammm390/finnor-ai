/** Real mounted owner controls. No owner response, model, policy or signed
 * identity is synthesized in the browser. Every step has native readback. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {artifact,repo,hash} from '../x3/environment.mts';
assert(process.env.FINNOR_Y2_EVIDENCE_DIR,'EXPLICIT_Y2_BROWSER_EVIDENCE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y2_EVIDENCE_DIR),f=JSON.parse(await readFile(join(evidence,'browser-fixture.json'),'utf8'));
assert([f.base,f.control].every((v:string)=>/^http:\/\/127\.0\.0\.1:\d+$/.test(v)));
const session=process.env.AGENT_BROWSER_SESSION??spawnSync('agent-browser',['session','id','--scope','worktree','--prefix','y2'],{cwd:repo,encoding:'utf8'}).stdout.trim();
assert(session,'NAMED_Y2_BROWSER_SESSION_REQUIRED');
writeFileSync(join(evidence,'browser-session.json'),JSON.stringify({session,ownedByThisCampaign:true})+'\n',{flag:'wx'});
const env={...process.env,AGENT_BROWSER_SESSION:session},panel='section[aria-label="Strategic response model"]',steps:any[]=[];
let passed=false,diagnosed=false;
function browser(...args:string[]){
 const r=spawnSync('agent-browser',args,{cwd:repo,env,encoding:'utf8',timeout:90000});
 if(r.status!==0){
  if(!diagnosed){diagnosed=true;const diagnosis=spawnSync('agent-browser',['doctor','--offline','--quick'],{cwd:repo,env,encoding:'utf8',timeout:30000});
   writeFileSync(join(evidence,'browser-doctor.log'),diagnosis.stdout+diagnosis.stderr,{flag:'wx'});}
  throw Error('Y2_BROWSER_'+args[0]+':'+r.stdout+r.stderr);
 }
 return r.stdout;
}
function inspect(js:string){const r=JSON.parse(browser('--json','eval',js));assert(r.success,JSON.stringify(r));return r.data.result;}
function wait(js:string){browser('wait','--fn',js);}
function click(name:string){
 wait(`Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent?.trim().startsWith(${JSON.stringify(name)})&&!b.disabled)`);
 browser('find','role','button','click','--name',name);
}
function enter(selector:string){browser('focus',selector);browser('press','Enter');}
async function control(path:string,method='POST'){
 const r=await fetch(f.control+path,{method,headers:{connection:'close'},signal:AbortSignal.timeout(180000)});
 const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value as any;
}
function state(){return inspect(`(()=>{const p=document.querySelector('${panel}');return {
 workId:p?.dataset.responseWork??null,root:p?.dataset.responseRoot??null,modelId:p?.dataset.responseModel??null,
 message:p?.querySelector('p[role=status]')?.textContent??null,
 owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Exact strategic owner response')?.parentElement?.querySelector('pre')?.textContent??null,
 retry:Array.from(p?.querySelectorAll('button')??[]).some(b=>b.textContent==='Retry original response request'),
 downloads:Array.from(p?.querySelectorAll('button')??[]).filter(b=>b.textContent==='Download checked response artifact').length}})()`);}
function latest(){const value=state().owner;assert(value,'VISIBLE_EXACT_STRATEGIC_OWNER_RESPONSE_REQUIRED');return JSON.parse(value);}
function waitOwner(predicate:string){
 wait(`(()=>{const p=document.querySelector('${panel}'),raw=Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Exact strategic owner response')?.parentElement?.querySelector('pre')?.textContent;
  if(!raw)return false;try{const v=JSON.parse(raw);return ${predicate}}catch{return false}})()`);
}
function mount(workId=f.workId,root=f.root){
 browser('wait',panel);
 wait(`document.querySelector('${panel}')?.dataset.responseWork===${JSON.stringify(workId)}&&document.querySelector('${panel}')?.dataset.responseRoot===${JSON.stringify(root.entityType+':'+root.entityId)}&&Array.from(document.querySelectorAll('${panel} button')).some(b=>b.textContent==='Reload strategic response'&&!b.disabled)`);
}
function status(value:string){
 wait(`document.querySelector('${panel}')?.dataset.responseModel!=='none'&&document.querySelector('${panel} > p[role=status]')?.textContent?.startsWith(${JSON.stringify(value+'.')})===true`);
}
function signIn(email:string,url:string,workId=f.workId){
 browser('open','--allowed-domains','127.0.0.1',f.base+'/centropy/login');browser('wait','input[type="email"]');
 browser('fill','input[type="email"]',email);browser('fill','input[type="password"]','r1-disposable-only');
 browser('wait','button[type="submit"]:not([disabled])');enter('button[type="submit"]');
 browser('wait','--url','**/centropy');browser('open',url);mount(workId);
}
function signOut(){
 enter('details.ct-account > summary');browser('find','role','button','click','--name','Sign out','--exact');
 browser('wait','--text','Your investment context stays private.');assert.equal(inspect(`document.querySelectorAll('${panel} textarea').length`),0);
}
function problem(value:any){
 const details=panel+' > details:first-of-type';
 if(!inspect(`document.querySelector('${details}')?.open===true`))enter(details+' > summary');
 browser('fill',details+' form textarea',JSON.stringify(value));
}
async function settled(id:string,kind:'models'|'uses',expected='CHECKED'){
 for(let i=0;i<8;i++){
  const sql=await control('/observe','GET'),row=sql[kind].find((r:any)=>r.id===id);
  if(row?.status===expected)return row;
  assert(!row||['QUEUED','FITTING','EVALUATING','CHECKING'].includes(row.status),'Y2_MOUNTED_'+kind+'_'+row?.status);
  await control('/worker');
 }
 throw Error('Y2_MOUNTED_NATIVE_DID_NOT_REACH_'+expected);
}
async function queueLearn(input:any,expected='CHECKED'){
 const prior=state().modelId;problem(input);click('Queue response learning');
 waitOwner(`typeof v.modelId==='string'&&v.modelId!==${JSON.stringify(prior)}&&v.replayed===false`);
 const accepted=latest();assert(accepted.modelId);await settled(accepted.modelId,'models',expected);click('Reload strategic response');status(expected);return accepted;
}
async function admission(){
 const modelId=state().modelId;click('Request response model-set development admission');
 waitOwner(`v.domain==='STRATEGIC_RESPONSE_MODEL_SET'&&v.modelId===${JSON.stringify(modelId)}`);
 wait(`document.querySelectorAll('${panel} > form').length===2`);
 const value=latest();assert.equal(value.domain,'STRATEGIC_RESPONSE_MODEL_SET');assert.equal(value.executionAuthorityGranted,false);return value;
}
async function queueUse(kind:'PREDICT'|'DECISION',input:any,expected='CHECKED'){
 const previous=state().owner,prior=previous?JSON.parse(previous).useId:null;
 browser('fill',panel+' > form:nth-of-type('+(kind==='PREDICT'?1:2)+') textarea',JSON.stringify(input));
 click(kind==='PREDICT'?'Queue coupled strategic prediction':'Queue checked S4 strategic programme');
 waitOwner(`typeof v.useId==='string'&&v.useId!==${JSON.stringify(prior??null)}`);
 const accepted=latest();assert(accepted.useId);await settled(accepted.useId,'uses',expected);click('Reload strategic response');
 click('Inspect '+kind.toLowerCase()+' '+accepted.useId);
 waitOwner(`v.useId===${JSON.stringify(accepted.useId)}&&v.kind===${JSON.stringify(kind)}&&v.status===${JSON.stringify(expected)}`);
 return {accepted,view:latest()};
}
async function held(){
 const end=Date.now()+20000;
 while(!(await control('/delay-status','GET')).waiting){assert(Date.now()<end,'Y2_ACTUAL_OWNER_REPLY_NOT_HELD');await new Promise(yes=>setTimeout(yes,40));}
}
async function receipts(name:string){
 try{return (await readFile(join(evidence,name),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
function boundary(operation:string){
 inspect(`(()=>{window.y2Boundary={states:[],completed:[]};const capture=()=>{const p=document.querySelector('${panel}'),v={
 workId:p?.dataset.responseWork??null,root:p?.dataset.responseRoot??null,modelId:p?.dataset.responseModel??null,
 owner:Array.from(p?.querySelectorAll('summary')??[]).find(s=>s.textContent==='Exact strategic owner response')?.parentElement?.querySelector('pre')?.textContent??null};
 if(JSON.stringify(window.y2Boundary.states.at(-1))!==JSON.stringify(v))window.y2Boundary.states.push(v)};
 window.y2DOM=new MutationObserver(capture);window.y2DOM.observe(document.body,{subtree:true,childList:true,characterData:true});
 window.y2Network=new PerformanceObserver(list=>{for(const e of list.getEntries())if(e.name.includes(${JSON.stringify('company-brain/'+operation)}))window.y2Boundary.completed.push({responseEnd:e.responseEnd})});
 window.y2Network.observe({type:'resource'});capture();return true})()`);
}
function endBoundary(){
 wait('window.y2Boundary.completed.length>0');
 inspect('(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>window.y2Boundary.settled=true));return true})()');wait('window.y2Boundary.settled===true');
 return inspect('(()=>{window.y2DOM.disconnect();window.y2Network.disconnect();return window.y2Boundary})()');
}
try{
 signIn(f.email,f.url);assert.equal(state().modelId,'none');
 const original=(await queueLearn(f.input)).modelId;
 const screenshots=join(evidence,'screenshots'),downloads=join(evidence,'downloads');await mkdir(screenshots,{recursive:true});await mkdir(downloads,{recursive:true});
 const downloaded=join(downloads,'checked-strategic-response.json');
 browser('download',panel+' > button:nth-of-type(3)',downloaded);
 const bytes=await readFile(downloaded),model=JSON.parse(bytes.toString());assert.equal(model.envelope.id,original);
 assert.equal(model.envelope.status,'CHECKED');assert.equal(model.body.hypotheses.length,6);
 const receipt=(await receipts('http.jsonl')).find(r=>r.path.endsWith('/response-model-artifact')&&r.output.modelId===original);
 assert(receipt);assert.equal(receipt.output.sha256,hash(bytes));assert.equal(receipt.transport,'ACTUAL_BUILT_NEXT_API');
 browser('scrollintoview',panel+' h4');browser('screenshot',join(screenshots,'y2-mounted-checked.png'));
 const admitted=await admission(),predicted=await queueUse('PREDICT',{query:f.query});
 assert.equal(predicted.view.artifact.result.trajectories.length,6);
 const originalDecision=await control('/decision?modelId='+original,'GET'),before=await queueUse('DECISION',originalDecision),
  policy=before.view.artifact.result.policy;
 assert.deepEqual(policy.certificate.valueBounds,[0,0]);assert.equal(policy.nodes.find((n:any)=>n.id===policy.rootNodeId).actionId,'stop');
 assert.deepEqual(policy.mandate,originalDecision.mandate);
 steps.push({id:'mounted-learn-inspect-download-admit-predict-and-canonical-S4-incumbent',modelId:original,admitted,
  prediction:predicted,decision:before,download:{bytes:bytes.length,sha256:hash(bytes)}});

 await control('/checker-unavailable');const unknownUse=await queueUse('PREDICT',{query:f.query},'UNKNOWN');
 await control('/checker-available');click('Resume original response use');
 waitOwner(`v.useId===${JSON.stringify(unknownUse.accepted.useId)}&&v.status==='QUEUED'`);
 await settled(unknownUse.accepted.useId,'uses');
 click('Inspect predict '+unknownUse.accepted.useId);
 waitOwner(`v.useId===${JSON.stringify(unknownUse.accepted.useId)}&&v.status==='CHECKED'`);
 const recoveredUse=latest();assert.equal(recoveredUse.attempts,2);assert.equal(recoveredUse.deadlineAt,unknownUse.view.deadlineAt);
 steps.push({id:'mounted-unknown-prediction-resumes-original-use',before:unknownUse.view,after:recoveredUse});

 for(const failed of [false,true]){
  await control('/auth-short-lived');signOut();signIn(f.email,f.url);await control('/auth-long-lived');status('CHECKED');
  const beforeAuth=await control('/auth-status','GET'),beforeSql=await control('/observe','GET');
  problem(f.input);await control('/delay-submit');boundary('response-model-submit');click('Queue response learning');await held();
  const acceptedSql=await control('/observe','GET'),row=acceptedSql.models.filter((v:any)=>v.work_id===f.workId).at(-1);
  assert(row);assert.equal(acceptedSql.models.length,beforeSql.models.length+1);await settled(row.id,'models');
  const end=Date.now()+110000;let afterAuth:any;
  do{
   afterAuth=await control('/auth-status','GET');assert(Date.now()<end,'Y2_REAL_AUTOMATIC_SIGNED_REFRESH_NOT_OBSERVED');
   if(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses)await new Promise(yes=>setTimeout(yes,150));
  }while(afterAuth.refreshes===beforeAuth.refreshes||afterAuth.refreshedApiSuccesses===beforeAuth.refreshedApiSuccesses);
  assert.equal(inspect('window.y2Boundary.completed.length'),0);status('CHECKED');assert(state().retry);assert.equal(state().owner,null);
  await control(failed?'/release-error':'/release');const late=endBoundary();assert.equal(state().owner,null);assert(state().retry);
  click('Retry original response request');waitOwner(`v.modelId===${JSON.stringify(row.id)}&&v.replayed===true`);status('CHECKED');
  const afterSql=await control('/observe','GET'),matching=afterSql.models.filter((v:any)=>v.idempotency_key===row.idempotency_key);assert.equal(matching.length,1);
  const replay=(await receipts('http.jsonl')).find(v=>v.path.endsWith('/response-model-submit')&&v.output.modelId===row.id&&v.output.replayed===true),
   heldReply=(await receipts('held-owner-responses.jsonl')).find(v=>v.path.endsWith('/response-model-submit')&&v.output.modelId===row.id);
  assert(replay&&heldReply);assert.deepEqual(replay.input,heldReply.input);
  assert.equal(afterSql.episodes.find((v:any)=>v.work_id===f.workId).deadline_at,beforeSql.episodes.find((v:any)=>v.work_id===f.workId).deadline_at);
  steps.push({id:failed?'real-token-refresh-late-error-exact-original-replay':'real-token-refresh-late-success-exact-original-replay',modelId:row.id,beforeAuth,afterAuth,late,replay,heldReply});
 }

 const mainSelected=state().modelId;
 await control('/delay-read?modelId='+mainSelected);boundary('response-model-read');click('Reload strategic response');await held();
 browser('pushstate',f.otherUrl);mount(f.otherWorkId);assert.equal(state().modelId,'none');
 await control('/release');const switched=endBoundary();assert.equal(state().modelId,'none');
 assert(switched.states.filter((v:any)=>v.workId===f.otherWorkId).every((v:any)=>v.modelId==='none'&&v.owner===null));
 const other=(await queueLearn(f.otherInput)).modelId;await admission();
 const afterInput=await control('/decision?modelId='+other,'GET'),after=await queueUse('DECISION',afterInput),
  afterPolicy=after.view.artifact.result.policy;
 assert.deepEqual(afterPolicy.certificate.valueBounds,[18,18]);assert.equal(afterPolicy.nodes.find((n:any)=>n.id===afterPolicy.rootNodeId).actionId,'coordinate');
 assert.deepEqual(afterPolicy.mandate,afterInput.mandate);assert.equal(afterPolicy.admission.executionAuthorityGranted,false);
 browser('screenshot',join(screenshots,'y2-mounted-strategic-programme.png'));
 steps.push({id:'SPA-Work-fence-and-supported-coordination-with-original-S4-mandate',switched,modelId:other,decision:after});

 await control('/checker-unavailable');const unknown=await queueLearn(f.otherInput,'UNKNOWN');
 await control('/checker-available');click('Inspect executable response fallback');
 waitOwner(`v.modelId===${JSON.stringify(unknown.modelId)}&&v.eligible===true`);const comparison=latest();
 const fallback=await queueUse('PREDICT',{query:f.query});assert.equal(fallback.accepted.fallbackUsed,true);assert.equal(fallback.accepted.executedModelId,other);
 const deadline=fallback.view.deadlineAt;click('Resume original response learning');
 waitOwner(`v.modelId===${JSON.stringify(unknown.modelId)}&&v.status==='QUEUED'`);
 await settled(unknown.modelId,'models');click('Reload strategic response');status('CHECKED');
 const resumed=(await control('/observe','GET')).models.find((v:any)=>v.id===unknown.modelId);
 assert.equal(resumed.episode_id,fallback.view.originalEpisodeId);
 steps.push({id:'mounted-executable-compatible-fallback-and-original-model-resume',unknown,comparison,fallback,resumedModelId:resumed.id,deadline});
 const cancelled=await (async()=>{
  problem(f.otherInput);click('Queue response learning');waitOwner(`typeof v.modelId==='string'&&v.modelId!==${JSON.stringify(unknown.modelId)}&&v.replayed===false`);
  const accepted=latest();click('Cancel new response use, retain commitments');status('CANCELLED');await control('/worker');
  const sql=await control('/observe','GET');assert.equal(sql.models.find((v:any)=>v.id===accepted.modelId).status,'CANCELLED');return accepted;
 })();
 assert.equal(state().downloads,0);
 steps.push({id:'mounted-queued-model-cancellation-without-checker-publication',cancelled});
 browser('select',panel+' > label select',other);status('CHECKED');
 browser('fill',panel+' > form:nth-of-type(1) textarea',JSON.stringify({query:f.query}));click('Queue coupled strategic prediction');
 waitOwner(`typeof v.useId==='string'`);const cancelUse=latest();
 click('Inspect predict '+cancelUse.useId);waitOwner(`v.useId===${JSON.stringify(cancelUse.useId)}`);
 click('Cancel new programme use, retain commitments');waitOwner(`v.useId===${JSON.stringify(cancelUse.useId)}&&v.status==='CANCELLED'`);
 await control('/worker');
 click('Inspect predict '+cancelUse.useId);
 waitOwner(`v.useId===${JSON.stringify(cancelUse.useId)}&&v.status==='CANCELLED'`);
 steps.push({id:'mounted-original-use-cancellation',accepted:cancelUse,view:latest()});
 await control('/steer-other');click('Reload strategic response');status('INVALIDATED');assert.equal(state().downloads,0);
 assert.equal(inspect(`document.querySelectorAll('${panel} > form').length`),0);
 steps.push({id:'mounted-canonical-Work-invalidation-fences-new-use',observed:state()});

 browser('pushstate',f.url);mount();status('CHECKED');const currentMain=state().modelId;
 await control('/delay-artifact?modelId='+currentMain);boundary('response-model-artifact');
 inspect('(()=>{window.y2BlobCalls=0;const create=URL.createObjectURL.bind(URL);URL.createObjectURL=(...a)=>{window.y2BlobCalls++;return create(...a)};return true})()');
 click('Download checked response artifact');await held();browser('pushstate',f.rootSwitchUrl);
 // This Work belongs to the original canonical root. The real WORLD graph
 // correctly removes its entire record under the other root.
 wait(`document.querySelector('select[aria-label="Choose WORLD root"]')?.value===${JSON.stringify(f.otherRoot.entityType+':'+f.otherRoot.entityId)}&&document.querySelector('${panel}')===null`);
 assert.equal(state().modelId,null);
 await control('/release');const rootBoundary=endBoundary();assert.equal(state().modelId,null);assert.equal(state().owner,null);assert.equal(inspect('window.y2BlobCalls'),0);
 const removed=rootBoundary.states.findIndex((v:any)=>v.workId===null);assert(removed>=0);
 assert(rootBoundary.states.slice(removed).every((v:any)=>v.modelId===null&&v.owner===null));
 steps.push({id:'SPA-root-change-fences-late-artifact-before-blob-creation',rootBoundary,observed:state()});
 browser('pushstate',f.url);mount();status('CHECKED');
 await control('/delay-read?modelId='+state().modelId);click('Reload strategic response');await held();
 signOut();signIn(f.peerEmail,f.peerUrl);assert.equal(state().modelId,'none');await control('/release');mount();
 assert.equal(state().owner,null);assert.equal(state().downloads,0);
 steps.push({id:'signed-principal-change-hides-late-private-model-and-download',observed:state()});
 const sql=await control('/observe','GET');
 assert(sql.deliveries.length>0);assert(sql.uses.some((v:any)=>v.kind==='DECISION'&&v.artifact?.result?.policy));
 await artifact(evidence,'browser-results.json',{status:'PASS_MOUNTED_EMITTED_Y2_DEVELOPMENT',session,steps,sql,screenshots,
  qualification:f.qualification,protectedQualification:false,productionActivated:false,financialEfficacy:false,
  rerun:'FINNOR_Y2_EVIDENCE_DIR=<new absolute directory> node --import=tsx scripts/y2/run-mounted.mts; then scripts/y2/browser-checks.mts in that directory'});
 passed=true;console.log('Y2_MOUNTED_BROWSER_CHECKS_PASS');
}catch(error){
 let observed:unknown;try{observed=state();}catch{observed='BROWSER_STATE_UNAVAILABLE';}
 await artifact(evidence,'browser-failure.json',{error:String(error),stack:(error as Error).stack,steps,state:observed});throw error;
}finally{try{browser('close');}finally{if(passed)await control('/stop');}}
