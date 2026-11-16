import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {finiteFailureObservation, finiteRequestFailure} from './failure-observation';

const evidence=process.argv[2];
assert(evidence?.startsWith('/'));
const secret='PRIVATE_PAYLOAD_MUST_NOT_ENTER_PUBLIC_RECEIPT';
const server=createServer((_request,_response)=>{});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert(address&&typeof address!=='string');
let aborted:unknown;
try{await fetch(`http://127.0.0.1:${address.port}`,{signal:AbortSignal.timeout(30)});}catch(error){aborted=error;}
server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
let refused:unknown;
try{await fetch(`http://127.0.0.1:${address.port}`);}catch(error){refused=error;}
const timeout=finiteRequestFailure(aborted,'/api/closing/resume','POST',31);
const connection=finiteRequestFailure(refused,'/api/closing/resume','POST',2);
const actionId='00000000-0000-4000-8000-000000000001';
let actionFailure:unknown;
try{await fetch(`http://127.0.0.1:${address.port}/api/actions/${actionId}/confirm`,{method:'POST'});}catch(error){actionFailure=error;}
const confirmation=finiteRequestFailure(actionFailure,`/api/actions/${actionId}/confirm`,'POST',3);
assert.equal(confirmation.path,'/api/actions/:id/confirm');
assert(!JSON.stringify(confirmation).includes(actionId));
assert.equal(finiteRequestFailure(refused,'/api/actions/'+secret+'/confirm','POST',3).path,null);
assert.equal(timeout.code,'OWNER_REQUEST_TIMEOUT');
assert.equal(connection.code,'OWNER_REQUEST_TRANSPORT_FAILED');
assert(connection.causeCodes.includes('ECONNREFUSED'));
const child=spawn(process.execPath,['-e','process.exit(23)']);
const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const rows=[{name:'api',exit:{...exit,at:new Date().toISOString()}}];
const original=Object.assign(new Error(secret),{cause:{code:secret,message:secret}});
const observed=finiteFailureObservation(original,rows,connection);
rows[0]!.exit.code=0;
assert.equal(observed.processes[0]?.exit?.code,23,'failure must freeze the pre-cleanup observation');
assert.equal(observed.code,'OWNER_REQUEST_TRANSPORT_FAILED');
assert(!JSON.stringify(observed).includes(secret));
assert.equal(finiteRequestFailure(original,'/private/'+secret,'POST',-1).path,null);
assert.equal(finiteFailureObservation(original,[]).code,'OWNER_RUNTIME_FAILED');
const receipt={schema:'finnor.v3.failure-observation-e2e.v1',status:'PASS',timeout,connection,confirmation,observed,
 qualification:'ACTUAL_LOCAL_HTTP_AND_CHILD_EXIT_FAILURE_DIAGNOSTICS_ONLY_NOT_W2_ACCEPTANCE'};
await writeFile(evidence,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:receipt.status,timeout:timeout.code,connection:connection.causeCodes}));
