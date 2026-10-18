/** Independent mounted join of the actual X3 record, S6 readback and S5 result.
 * No tokens, cookies, browser storage, or synthetic network responses. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {artifact,repo} from './environment.mts';

assert(process.env.FINNOR_X3_EVIDENCE_DIR);
const evidence=resolve(process.env.FINNOR_X3_EVIDENCE_DIR),f=JSON.parse(await readFile(join(evidence,'effect-browser-fixture.json'),'utf8'));
assert([f.base,f.control].every(value=>/^http:\/\/127\.0\.0\.1:\d+$/.test(value)));
const session=process.env.AGENT_BROWSER_SESSION??spawnSync('agent-browser',['session','id','--scope','worktree','--prefix','x3-effect'],{cwd:repo,encoding:'utf8'}).stdout.trim();
assert(session);const steps:any[]=[],env={...process.env,AGENT_BROWSER_SESSION:session};
function browser(...args:string[]){
 const response=spawnSync('agent-browser',args,{cwd:repo,env,encoding:'utf8',timeout:60000});
 if(response.status!==0)throw Error('BROWSER_'+args[0]+':'+response.stdout+response.stderr);
 return response.stdout;
}
function inspect(expression:string){const value=JSON.parse(browser('--json','eval',expression));assert(value.success);return value.data.result;}
function press(selector:string){browser('focus',selector);browser('press','Enter');}
function verifiedWork(){
 browser('wait','.ct-world-work__proof[data-state="verified"]');
 const state=inspect(`({proof:Array.from(document.querySelectorAll('.ct-world-work__proof[data-state="verified"]')).map(node=>node.innerText),actions:Array.from(document.querySelectorAll('.ct-world-work__action-head')).map(node=>node.innerText),errors:Array.from(document.querySelectorAll('.ct-world-work [role="alert"]')).map(node=>node.innerText)})`);
 assert.equal(state.errors.length,0);assert(state.proof.some((text:string)=>text.includes(f.expected.semanticHash)&&text.includes('EXACT_TARGET_FIELD_OPERATION_READBACK')));
 assert(state.actions.some((text:string)=>text.includes('completed')));return state;
}
let passed=false;
try{
 const startedAt=new Date().toISOString();
 browser('open',f.base+'/centropy/login');browser('wait','input[type="email"]');
 browser('fill','input[type="email"]',f.email);browser('fill','input[type="password"]','x3-disposable-only');
 browser('wait','button[type="submit"]:not([disabled])');press('button[type="submit"]');browser('wait','--url','**/centropy');
 browser('open',f.applicationUrl);browser('wait','--text','Enterprise application');
 browser('find','role','button','click','--name','Focus Enterprise application');
 const panel='.ct-enterprise-application';browser('wait','--fn',`document.querySelector('${panel}')?.dataset.applicationStatus==='INSTALLED'`);
 assert.equal(inspect(`document.querySelector('${panel}').dataset.applicationId`),f.expected.applicationId);
 browser('select',panel+' > label:nth-of-type(2) select',f.expected.recordId);
 browser('wait','--fn',`document.querySelector('${panel} article[aria-label="Persisted application record"] > pre')?.textContent.includes('0.15')===true`);
 browser('find','role','button','click','--name','Inspect immutable history','--exact');
 browser('wait','--text','Canonical application history');
 const history=inspect(`JSON.parse(Array.from(document.querySelectorAll('${panel} > details')).find(node=>node.querySelector('summary')?.textContent==='Canonical application history').querySelector('pre').textContent)`);
 const bindings=history.events.filter((event:any)=>event.kind==='S6_BOUND'&&event.record_id===f.expected.recordId);
 assert.equal(bindings.length,1);assert.deepEqual(bindings[0].body.obligationRef,f.expected.obligationRef);
 steps.push({id:'actual-same-installed-application-and-immutable-s6-binding',applicationId:f.expected.applicationId,recordId:f.expected.recordId,obligationRef:f.expected.obligationRef,historyEventId:bindings[0].id});
 browser('open',f.worldUrl);browser('wait','section[aria-label="Selected WORLD object"]');
 if(inspect(`Array.from(document.querySelectorAll('button')).some(node=>node.textContent.trim()==='Work record')`))browser('find','role','button','click','--name','Work record','--exact');
 steps.push({id:'same-work-mounted-canonical-settlement',observed:verifiedWork()});
 browser('find','role','button','click','--name','Refresh Work record');steps.push({id:'same-work-refresh-retains-exact-observed-effect',observed:verifiedWork()});
 browser('reload');steps.push({id:'same-work-reload-retains-exact-observed-effect',observed:verifiedWork()});
 const observedUntil=new Date().toISOString();
 const observations=(await readFile(join(evidence,'http.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.at>=startedAt&&row.at<=observedUntil&&row.method==='GET'&&row.path==='/api/works/'+f.expected.workId);
 assert(observations.length>=2,'Actual mounted Work GETs were not retained');
 for(const observation of observations){
  assert.equal(observation.status,200);assert.equal(observation.bearer,true);assert.equal(observation.authBypass,false);assert.equal(observation.transport,'ACTUAL_BUILT_NEXT_API');
  const aggregate=observation.output.work;assert.equal(aggregate.work.id,f.expected.workId);assert.equal(aggregate.read.complete,true);
  const action=aggregate.actions.find((row:any)=>row.id===f.expected.actionId),effect=aggregate.businessEffects.find((row:any)=>row.id===f.expected.effectId);
  assert(action,'Canonical Work omitted the exact domain action');assert(effect,'Canonical Work omitted the exact business effect');
  assert.equal(action.status,'completed');assert.equal(effect.status,'verified');assert.equal(effect.domainActionId,f.expected.actionId);assert.equal(effect.semanticHash,f.expected.semanticHash);
  assert.equal(effect.verification.settlementEventId,f.expected.settlementEventId);assert.deepEqual(effect.verification,f.expected.verification);
 }
 browser('screenshot',join(evidence,'mounted-observed-effect.png'));
 await artifact(evidence,'effect-browser-results.json',{status:'PASS_SAME_WORK_MOUNTED_EFFECT',session,startedAt,observedUntil,expected:f.expected,steps,observations,
  qualification:'ACTUAL_GENERATED_APPLICATION_AND_S5_CANONICAL_RESULT_JOINED_TO_INDEPENDENT_LOOPBACK_TLS_READBACK; DISPOSABLE_AUTHORITY_NOT_PROTECTED_ADMISSION',freshProviderReadOnEachRender:false});
 passed=true;console.log('X3_SAME_WORK_MOUNTED_EFFECT_PASS');
}catch(error){
 await artifact(evidence,'effect-browser-failure.json',{error:String(error),stack:(error as Error).stack,session,steps});
 throw error;
}finally{
 try{browser('close');}catch{}
 await fetch(f.control+'/stop',{method:'POST',headers:{connection:'close'},signal:AbortSignal.timeout(5000)}).catch(()=>undefined);
 if(!passed)console.error('X3_SAME_WORK_MOUNTED_EFFECT_FAILED');
}
