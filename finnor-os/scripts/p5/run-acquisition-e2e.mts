// Original predicates and complete real target stories, written before product code.
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {evidence,target,atomic} from './test-support.mts';
import {join} from 'node:path';
const run=await evidence('acquisition');
const original=(value:string|null='20.00')=>({meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',
 unit:'currency',currency:'USD',value,tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()});
let compiler:any,runtime:any,ui:any;
await run.story('producer-before-implementation',[],async()=>{
 compiler=await import('../../packages/private-equity/src/interface-synthesis/compiler');
 runtime=await import('../../packages/private-equity/src/interface-synthesis/runtime');
 ui=await import('../../packages/private-equity/src/interface-synthesis/ui');
 return {resolved:true};
});
const modes=[
 ['exact-api-alpha','normal','alpha','VERIFIED',['P5-03','P5-08','P5-18']],
 ['permitted-variant-beta','normal','beta','VERIFIED',['P5-03']],
 ['twenty-is-not-two-hundred','times-ten','alpha','DISCREPANCY',['P5-10']],
 ['wrong-record-write','wrong-write','alpha','DISCREPANCY',['P5-11']],
 ['corrected-wrong-effect-still-violation','wrong-then-correct','alpha','DISCREPANCY',['P5-11']],
 ['read-different-record','wrong-entity','alpha','DISCREPANCY',['P5-19']],
 ['other-operation-is-not-settlement','wrong-operation','alpha','DISCREPANCY',['P5-19']],
 ['stale-version-is-not-settlement','stale-version','alpha','DISCREPANCY',['P5-19']],
 ['explicit-null','normal','alpha','VERIFIED',['P5-15']],
 ['missing-is-not-null','missing','alpha','DISCREPANCY',['P5-15']],
 ['empty-is-not-null','empty','alpha','DISCREPANCY',['P5-15']],
 ['currency-is-not-inferred','wrong-currency','alpha','DISCREPANCY',['P5-13']],
 ['partial-ack-needs-independent-read','partial','alpha','VERIFIED',['P5-18']],
 ['real-lost-response-reconciliation','lost-response','alpha','VERIFIED',['P5-24']],
 ['unknown-with-no-read-access','no-observer','alpha','UNKNOWN',['P5-25']]
] as const;
for(const [id,mode,variant,status,families] of modes)await run.story(id,[...families],async()=>{
 assert.ok(compiler&&runtime,'Producer unavailable, original case not executed');
 const f=await target(run.directory);try{
  await f.control({variant});
  const source=await (await fetch(f.origin+'/docs')).json();
  const request=original(id.includes('null')?null:'20.00');
  const generated=compiler.synthesizeApi(source,request);
  assert.equal((await f.reference()).writes.length,0,'Discovery cannot write');
  assert.notEqual(generated.adapterModule.digest,generated.observerModule.digest);
  assert.ok(!generated.adapterModule.bytes.includes(request.entity),'Generated executable must parameterize entity');
  await f.control({mode});
  const events:any[]=[];
  const port={origin:f.origin,account:request.account,expiresAt:new Date(Date.now()+30000).toISOString(),disposable:true,
   authorize:async()=>true,record:async(e:any)=>{events.push(e);await atomic(join(run.directory,'frontier-'+request.operationId+'.json'),events);}};
  const result=await runtime.practiceHttp(generated,request,port);
  assert.equal(result.status,status,JSON.stringify(result));
  const reference=await f.reference();
  assert.equal(reference.writes.length,mode==='wrong-then-correct'?2:1,'Physical count from independently persisted target');
  if(status==='VERIFIED'){
   assert.equal(reference.records.C_01.price,request.value===null?null:2000);
   assert.equal(reference.records.C_010.price,1000);
   assert.equal(result.observation.operationId,request.operationId);
  }
  assert.equal(events.filter(e=>e.stage==='POSSIBLE_EGRESS').length,1);
  const recovered=await runtime.practiceHttp(generated,request,port,result.attempt);
  assert.equal((await f.reference()).writes.length,reference.writes.length,'Recovery must never repeat possible mutation');
  return {request,generated,result,recovered,reference,events};
 }finally{await f.close();}
});
await run.story('bounded-untrusted-discovery-and-exact-codecs',['P5-06','P5-07','P5-12','P5-13','P5-14','P5-26','P5-29','P5-34'],async()=>{
 assert.ok(compiler&&runtime,'Producer unavailable');
 const f=await target(run.directory);try{
  const doc=await (await fetch(f.origin+'/docs')).json(),op=original(),proposal=compiler.synthesizeApi(doc,op);
  for(const value of ['20,00','20.001','1e2','NaN',' 20','900719925474099100']){
   assert.throws(()=>compiler.synthesizeApi(doc,{...op,value}),/P5_DECIMAL/);
  }
  assert.throws(()=>compiler.synthesizeApi(doc,{...op,currency:'EUR'}),/P5_UNIT/);
  assert.throws(()=>compiler.synthesizeApi(doc,{...op,unit:'date'}),/P5_/);
  const remote=structuredClone(doc);remote.paths['/ledgers/{ledger}/entries/{entry}'].patch.requestBody.content['application/json'].schema={$ref:'https://unapproved.invalid/secret'};
  assert.throws(()=>compiler.synthesizeApi(remote,op),/P5_SCHEMA_REF/);
  const duplicate=structuredClone(doc);duplicate.paths['/other/{ledger}/{entry}']=structuredClone(duplicate.paths['/ledgers/{ledger}/entries/{entry}']);
  assert.throws(()=>compiler.synthesizeApi(duplicate,op),/P5_OPERATION_AMBIGUOUS/);
  const port={origin:f.origin,account:op.account,expiresAt:new Date(Date.now()+30000).toISOString(),disposable:true,authorize:async()=>true,record:async()=>{}};
  const corrupt=structuredClone(proposal);corrupt.adapterModule.bytes+=' ';
  await assert.rejects(()=>runtime.practiceHttp(corrupt,op,port),/P5_MODULE/);
  await assert.rejects(()=>runtime.practiceHttp(proposal,{...op,entity:'C_010'},port),/P5_BINDING/);
  await assert.rejects(()=>runtime.practiceHttp(proposal,op,{...port,origin:'http://example.com'}),/P5_DISPOSABLE/);
  const malicious=structuredClone(doc);malicious.authorization='DO_NOT_COPY_SECRET';
  assert.throws(()=>compiler.synthesizeApi(malicious,op),/P5_SECRET/);
  assert.equal((await f.reference()).writes.length,0,'Every refusal precedes egress');
  return {refused:'ambiguous/lossy decimals; currency/date; remote refs; duplicate operations; corrupt bytes; target conflict; external origin; secrets',reference:await f.reference()};
 }finally{await f.close();}
});
await run.story('revocation-between-mutation-and-read',['P5-20','P5-21','P5-28'],async()=>{
 assert.ok(compiler&&runtime,'Producer unavailable');
 const f=await target(run.directory);try{
  const op=original(),generated=compiler.synthesizeApi(await (await fetch(f.origin+'/docs')).json(),op),events:any[]=[];
  const port={origin:f.origin,account:op.account,expiresAt:new Date(Date.now()+30000).toISOString(),disposable:true,
   authorize:async()=>(await f.reference()).writes.length===0,record:async(e:any)=>events.push(e)};
  const result=await runtime.practiceHttp(generated,op,port);
  assert.equal(result.status,'UNKNOWN');assert.equal((await f.reference()).writes.length,1);
  assert.equal((await f.reference()).requests.filter((r:any)=>r.path.includes('/entries/')&&r.method==='GET').length,0);
  assert.equal(result.attempt.possibleEgress,true);
  return {result,events,reference:await f.reference(),qualification:'Revoked access retains original responsibility, no key or credential carried by generated code'};
 }finally{await f.close();}
});
for(const [variant,boundary] of [['alpha','submit'],['beta','submit'],['beta','autosave']] as const)await run.story('real-ui-'+variant+'-'+boundary,['P5-04','P5-08','P5-16','P5-17','P5-18'],async()=>{
 assert.ok(compiler&&runtime&&ui,'Producer unavailable');
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:true});
 const f=await target(run.directory);try{
  await f.control({variant,boundary,layout:'reversed'});
  const page=await browser.newPage();await page.goto(f.origin+'/ui');
  const op=original(),doc=await (await fetch(f.origin+'/docs')).json(),observer=compiler.synthesizeApi(doc,op);
  const proposal=await ui.synthesizeUi(page,op,observer);
  const events:any[]=[];
  const port={origin:f.origin,account:op.account,expiresAt:new Date(Date.now()+30000).toISOString(),disposable:true,
   authorize:async()=>true,record:async(e:any)=>events.push(e)};
  const result=await ui.practiceUi(page,proposal,op,port);
  assert.equal(result.status,'VERIFIED',JSON.stringify(result));
  const reference=await f.reference();
  assert.equal(reference.writes.length,1);
  assert.equal(reference.records.C_01.price,2000);
  assert.equal(reference.records.C_010.price,1000);
  await page.screenshot({path:join(run.directory,variant+'-'+boundary+'.png')});
  await f.control({layout:'duplicate'});await page.reload();
  await assert.rejects(()=>ui.synthesizeUi(page,{...op,priorRevision:'"v2"'},observer),/P5_UI_AMBIGUOUS/);
  return {proposal,result,events,reference,qualification:'HEADLESS_PLAYWRIGHT_REAL_APPLICATION_NOT_TRUSTED_OS_UI_OR_WITHHELD_GATE'};
 }finally{await browser.close();await f.close();}
});
await run.finish();
