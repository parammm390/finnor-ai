import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {evidence,target} from './test-support.mts';
import {nativeFixture} from './native-fixture.mts';
const run=await evidence('ui-safety'),e=await nativeFixture();
const operation=()=>({meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()});
async function acquire(f:Awaited<ReturnType<typeof target>>){
 const w=await e.work(f.origin,'UI');
 const accepted=await e.api('interface-acquire',{schema:'finnor.p5.acquisition-request.v1',root:e.root,workId:w.workId,sourceAccessId:w.accessId,substrate:'UI',operation:operation(),idempotencyKey:randomUUID(),mode:'ordinary_disposable'});
 assert.equal(accepted.status,202,JSON.stringify(accepted));
 return {...w,acquisitionId:accepted.body.acquisitionId};
}
try{
 for(const mode of ['ui-discovery-write','ui-wrong-extra','ui-duplicate'])await run.story(mode,['P5-06','P5-07','P5-08','P5-11','P5-17','P5-34'],async()=>{
  const f=await target(run.directory);try{
   await f.control({mode});const a=await acquire(f),current=await e.finish(a.acquisitionId),reference=await f.reference();
   assert.equal(reference.records.C_010.price,1000,'No forbidden decoy wire write');
   if(mode==='ui-discovery-write'){assert.equal(reference.writes.length,0);assert.ok(['FAILED','QUARANTINED'].includes(current.status));}
   else {assert.equal(reference.writes.length,1);assert.equal(current.status,'DISCREPANCY');assert.equal(reference.requests.filter((r:any)=>r.method==='PATCH').length,1,'Exactly one permitted mutation wire request');}
   const events=(await e.admin.query("SELECT kind,body FROM finnor_os.p5_events WHERE acquisition_id=$1 AND kind LIKE '%REFUSED%' ORDER BY created_at",[a.acquisitionId])).rows;
   assert.ok(events.length,'Retain refused discovery/extra egress evidence');assert.equal(current.admission,null);
   return {current,reference,events};
  }finally{await f.close();}
 });
 await run.story('ui-only-drift-quarantines-current-reader',['P5-02','P5-16','P5-17','P5-34'],async()=>{
  const f=await target(run.directory);try{
   const a=await acquire(f),practiced=await e.finish(a.acquisitionId);assert.equal(practiced.status,'PRACTICED',JSON.stringify(practiced));
   await f.control({boundary:'autosave'});
   const read=await e.api('interface-read',{acquisitionId:a.acquisitionId});assert.equal(read.body.status,'QUARANTINED');assert.equal(read.body.capability,null);
   const exported=await e.api('interface-module',{acquisitionId:a.acquisitionId,kind:'ADAPTER'});assert.equal(exported.status,422);
   assert.equal((await f.reference()).writes.length,1,'Currentness check is read-only');
   return {practiced,read,exported,reference:await f.reference()};
  }finally{await f.close();}
 });
}finally{await e.close();await run.finish();}
