import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';

const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?'['+value.map(canonical).join(',')+']'
 :'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';

export async function reviewPublicationRace(input:{admin:pg.Client;tenant:string;principal:string;
 requestId:string;workId:string;submit:{workId:string;workInputId:string;grantIds:string[]};
 expectedRequestText:string;release:()=>Promise<void>;assertLive:()=>void;
 api:(operation:string,body:unknown)=>Promise<{status:number;body:any}>;
 save:(name:string,value:unknown)=>Promise<unknown>;results:any[]}){
 const {admin,tenant,principal,requestId,workId,save,api}=input;
 const wait=async<T,>(read:()=>Promise<T|undefined>,label:string,count=240)=>{
  for(let i=0;i<count;i++){input.assertLive();const value=await read();if(value)return value;
   await new Promise(resolve=>setTimeout(resolve,250));}throw Error('PUBLICATION_RACE_BOUNDARY_NOT_REACHED:'+label);};
 const publisher=await wait(async()=>(await admin.query(`SELECT pid,query,wait_event,pg_blocking_pids(pid) blockers
  FROM pg_stat_activity WHERE datname=current_database() AND usename='finnor_worker' AND wait_event_type='Lock'
   AND query LIKE '%INSERT INTO finnor_os.x1_compiler_artifacts%'`)).rows[0],'actual-parent-artifact-insert');
 const original=(await admin.query('SELECT * FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2',[tenant,requestId])).rows[0];
 assert.equal(original.status,'RUNNING');assert.equal(original.artifact_id,null);
 const episode=(await admin.query('SELECT * FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2',[tenant,original.episode_id])).rows[0];
 assert.ok(episode.parent_reservation);
 const children=(await admin.query("SELECT id,status,idempotency_key FROM finnor_os.p1_requests WHERE tenant_id=$1 AND work_id=$2",[tenant,workId])).rows;
 assert.equal(children.length,1);assert.equal(children[0].idempotency_key,'x1-compiler:'+requestId);
 let responseSettled=false;
 const pending=api('institution-revise',{...input.submit,parentRequestId:requestId,idempotencyKey:'x1-publication-race:'+randomUUID()})
  .then(response=>{responseSettled=true;return response;});
 const acceptance=await wait(async()=>(await admin.query(`SELECT pid,query,wait_event,pg_blocking_pids(pid) blockers
  FROM pg_stat_activity WHERE datname=current_database() AND usename='finnor_app' AND wait_event_type='Lock'
   AND query LIKE '%pg_advisory_xact_lock%' AND $1=ANY(pg_blocking_pids(pid))`,[publisher.pid])).rows[0],
 'authenticated-revision-waits-for-live-publisher',40);
 assert.equal(responseSettled,false);
 const before=(await admin.query('SELECT id,revision,status FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision',[tenant,workId])).rows;
 assert.equal(before.length,1);
 assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.x1_compiler_artifacts WHERE tenant_id=$1',[tenant])).rows[0].n,0);
 await save('concurrent-initial-publication-physical-overlap.json',{publisher,acceptance,original,episode,children,before,responseSettled,
  actualAuthenticatedRevisionPending:true,productionSerializerUnchanged:true});
 await input.release();const revision=await pending;
 assert.equal(revision.status,202,JSON.stringify(revision));assert.equal(revision.body.revision,original.revision+1);
 const next=(await admin.query('SELECT * FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2',[tenant,revision.body.requestId])).rows[0];
 assert.equal(next.parent_request_id,requestId);assert.equal(next.episode_id,episode.id);
 const completed=await wait(async()=>{const response=await api('institution-read',{requestId:next.id});
  assert.equal(response.status,200);return response.body.status==='OBSERVED'?response:undefined;},'new-revision-independent-native-completion');
 const old=await api('institution-read',{requestId});assert.equal(old.status,200);assert.equal(old.body.status,'INVALIDATED');
 assert.equal(old.body.reason,'X1_COMPILER_REVISION_SUPERSEDED');assert.equal(old.body.artifact,null);
 const artifacts=(await admin.query(`SELECT id,request_id,body,body_digest FROM finnor_os.x1_compiler_artifacts
  WHERE tenant_id=$1 AND request_id=ANY($2::uuid[]) ORDER BY request_id`,[tenant,[requestId,next.id]])).rows;
 assert.equal(artifacts.length,2);
 for(const row of artifacts)assert.equal(createHash('sha256').update(canonical(row.body)).digest('hex'),row.body_digest);
 const prior=artifacts.find(row=>row.request_id===requestId),current=artifacts.find(row=>row.request_id===next.id);
 const binding=current.body.envelope.parent_artifact_refs;assert.equal(binding.length,1);
 assert.equal(binding[0].ref,prior.id);assert.equal(binding[0].digest,prior.body_digest);
 const requests=(await admin.query('SELECT * FROM finnor_os.pe_requests WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
 assert.equal(requests.length,1);assert.equal(requests[0].request_text,input.expectedRequestText);
 const ending=(await admin.query('SELECT * FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2',[tenant,episode.id])).rows[0];
 for(const key of ['parent_reservation','parent_demand','original_deadline','wall_deadline'])assert.deepEqual(ending[key],episode[key]);
 assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1',[tenant])).rows[0].n,1);
 const jobs=(await admin.query('SELECT id,type,status,attempts,last_error FROM finnor_os.jobs WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
 await save('concurrent-publication-independent-ending.json',{publisher,acceptance,revision,next,completed,old,artifacts,canonical:requests,episode,ending,jobs,
  originalParentRetained:true,independentlyObservedBusinessAssignments:1,protectedQualification:false});
 input.results.push({id:'E-concurrent-initial-publication-and-authenticated-revision',status:'PASS',
  observed:{oldRequestId:requestId,newRequestId:next.id,actualSqlOverlap:true,immutableArtifacts:2,canonicalRequests:1,
   oldProjection:old.body.status,newProjection:completed.body.status,originalParentRetained:true},
  basis:'PHYSICAL_RESTRICTED_PUBLISHER_AND_AUTHENTICATED_REVISION_SQL_SERIALIZATION_SAME_PARENT_NATIVE_OBSERVER'});
}
