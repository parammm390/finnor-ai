import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evidence,target,atomic} from './test-support.mts';
import {synthesizeApi} from '../../packages/private-equity/src/interface-synthesis/compiler';
import {practiceHttp} from '../../packages/private-equity/src/interface-synthesis/runtime';
const run=await evidence('observation'),documents=await target(run.directory);
const documentation=await (await fetch(documents.origin+'/docs')).json();
await documents.close();
for(const numeric of [false,true])await run.story(numeric?'numeric-readback-identity-is-not-string-identity':'exact-string-identity-positive-control',['P5-08','P5-09','P5-18','P5-19'],async()=>{
 const directory=await mkdtemp(join(tmpdir(),'p5-strict-observer-')),file=join(directory,'state.json'),operationId=randomUUID();
 const initial={account:'11',records:{'22':{value:1000,revision:'"v1"',operationId:null},'222':{value:1000,revision:'"v1"',operationId:null}},writes:[]};
 await writeFile(file,JSON.stringify(initial),{mode:0o600});
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   const state=JSON.parse(await readFile(file,'utf8'));
   if(req.url==='/docs'){res.end(JSON.stringify(documentation));return;}
   if(req.url==='/ledgers/11/entries/22'){
    if(req.method==='PATCH'){
     let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('TEST_REQUEST_BOUND');}
     const body=JSON.parse(raw);
     assert.equal(req.headers['if-match'],state.records['22'].revision);assert.deepEqual(body,{quoted_minor:2000});assert.equal(req.headers['x-operation-id'],operationId);
     state.records['22']={value:body.quoted_minor,revision:'"v2"',operationId};
     state.writes.push({account:'11',entity:'22',field:'price',unit:'currency',currency:'USD',value:2000,operationId,revision:'"v2"',at:new Date().toISOString()});
     await writeFile(file,JSON.stringify(state),{mode:0o600});res.end('{}');return;
    }
    const row=state.records['22'];
    res.end(JSON.stringify({ledger_id:numeric?11:'11',entity_id:numeric?22:'22',settled_minor:row.value,etag:row.revision,operation_id:row.operationId,unit:'currency',currency:'USD'}));return;
   }
   if(req.url==='/history/11/'+operationId){res.end(JSON.stringify({account:'11',operationId,writes:state.writes}));return;}
   res.writeHead(404);res.end('{}');
  }catch{res.writeHead(422);res.end('{}');}
 });
 await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const origin='http://127.0.0.1:'+address.port,events:any[]=[];
 try{
  const operation={meaning:'set-record-field',account:'11',entity:'22',field:'price',unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId};
  const generated=synthesizeApi(await (await fetch(origin+'/docs')).json(),operation);
  const result=await practiceHttp(generated,operation,{origin,account:'11',expiresAt:new Date(Date.now()+30000).toISOString(),disposable:true,authorize:async()=>true,record:async event=>{events.push(event);}});
  const independent=JSON.parse(await readFile(file,'utf8'));
  await atomic(join(run.directory,numeric?'numeric-identity.json':'string-identity.json'),{operation,result,independent,events,file});
  assert.equal(independent.records['22'].value,2000);assert.equal(independent.records['222'].value,1000);assert.equal(independent.writes.length,1);
  assert.equal(result.status,numeric?'DISCREPANCY':'VERIFIED',JSON.stringify({numeric,status:result.status,reason:result.reason}));
  return {operation,result,independent,events,file};
 }finally{server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
});
await run.finish();
