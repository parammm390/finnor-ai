/** Database boundary probes against genuine completed campaign records. Every
 * attempted mutation is rolled back, including an unexpected success. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {artifact,hash} from '../x3/environment.mts';
export async function identificationDatabaseProofs(f:{e:any;evidence:string;tenant:string;identificationId:string}){
 const {e,evidence,tenant,identificationId}=f,client=new pg.Client({connectionString:e.appUrl}),proofs:any[]=[];
 const before=(await e.admin.query('SELECT to_jsonb(a) body FROM finnor_os.x4_identifications a WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0].body;
 const tables=(await e.admin.query("SELECT tablename FROM pg_tables WHERE schemaname='finnor_os' AND (tablename LIKE 'x4_%' OR tablename='s5_identification_charges') ORDER BY tablename")).rows.map((v:any)=>v.tablename as string);
 assert.equal(tables.length,12);
 await client.connect();
 async function fails(id:string,code:string,sql:string,args:unknown[]){
  await client.query('BEGIN');
  try{
   await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
   let caught:any;try{await client.query(sql,args);}catch(error){caught=error;}
   assert(caught,'Unexpectedly accepted '+id);assert.equal(caught.code,code,id+':'+caught.message);
   proofs.push({id,expectedSQLState:code,observedSQLState:caught.code,reason:caught.message,rolledBack:true});
  }finally{await client.query('ROLLBACK');}
 }
 try{
  for(const [id,set] of Object.entries({
   deadline:'deadline_at=deadline_at+interval \'1 second\'',grant:'max_experiments=max_experiments+1',counter:'experiment_count=experiment_count-1',
   storage:'data_bytes=data_bytes-1',generation:'generation=generation-1',input:"work_input_digest=repeat('0',64)",
  }))await fails('immutable-original-'+id,'P0001','UPDATE finnor_os.x4_identifications SET '+set+' WHERE tenant_id=$1 AND id=$2',[tenant,identificationId]);
  await fails('retained-storage-cap','23514','UPDATE finnor_os.x4_identifications SET data_bytes=16777217 WHERE tenant_id=$1 AND id=$2',[tenant,identificationId]);
  await fails('immutable-consent-even-with-row-lock-privilege','P0001',"UPDATE finnor_os.x4_consents SET body_digest=repeat('0',64) WHERE tenant_id=$1 AND id=$2",[tenant,before.consent_id]);
  await fails('immutable-preregistered-protocol','P0001',"UPDATE finnor_os.x4_experiments SET protocol_digest=repeat('0',64) WHERE tenant_id=$1 AND identification_id=$2",[tenant,identificationId]);
  await fails('terminal-observation-cannot-rewrite','P0001',"UPDATE finnor_os.x4_experiments SET result=result WHERE tenant_id=$1 AND identification_id=$2 AND status='OBSERVED'",[tenant,identificationId]);
  await fails('terminal-decision-use-cannot-reopen','P0001',"UPDATE finnor_os.x4_uses SET status='QUEUED' WHERE tenant_id=$1 AND identification_id=$2 AND status IN('COMPLETE','WAIT')",[tenant,identificationId]);
  await fails('append-only-scientific-model','42501',"UPDATE finnor_os.x4_models SET body_digest=repeat('0',64) WHERE tenant_id=$1 AND identification_id=$2",[tenant,identificationId]);
  await fails('append-only-original-charge','42501','DELETE FROM finnor_os.s5_identification_charges WHERE tenant_id=$1 AND identification_id=$2',[tenant,identificationId]);
  await fails('retained-immutable-history','42501','DELETE FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2',[tenant,identificationId]);
  await client.query('BEGIN');
  try{
   await client.query("SELECT set_config('app.tenant_id',$1,true)",[randomUUID()]);
   for(const table of tables){assert(/^(x4_[a-z_]+|s5_identification_charges)$/.test(table));assert.equal((await client.query('SELECT count(*)::int n FROM finnor_os.'+table)).rows[0].n,0);}
   proofs.push({id:'actual-app-role-cross-tenant-read-forced-RLS',tables,rowsVisible:0});
  }finally{await client.query('ROLLBACK');}
  await client.query('BEGIN');
  try{
   await client.query("SELECT set_config('app.tenant_id',$1,true)",[randomUUID()]);
   let caught:any;try{await client.query("INSERT INTO finnor_os.x4_events(tenant_id,identification_id,actor_id,kind,idempotency_key,body) VALUES($1,$2,$3,'UNAUTHORIZED_NEGATIVE_INPUT',$4,'{}')",[tenant,identificationId,before.owner_id,randomUUID()]);}catch(error){caught=error;}
   assert.equal(caught?.code,'42501');proofs.push({id:'actual-app-role-cross-tenant-write-forced-RLS',observedSQLState:caught.code,rolledBack:true});
  }finally{await client.query('ROLLBACK');}
  const after=(await e.admin.query('SELECT to_jsonb(a) body FROM finnor_os.x4_identifications a WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0].body;
  assert.deepEqual(after,before);
  await artifact(evidence,'database-boundary-proofs.json',{schema:'finnor.x4.database-boundary-proof.v1',allPassed:true,proofs,beforeDigest:hash(JSON.stringify(before)),afterDigest:hash(JSON.stringify(after)),
   genuineTerminalRowsFrom:'ACTUAL_AUTHENTICATED_PHYSICAL_CAMPAIGN_ONLY',terminalRowsInsertedByProbes:0,committedMutationsByProbes:0,qualification:'REAL_DISPOSABLE_POSTGRES_APP_ROLE_NOT_HOSTED_QUALIFICATION'});
 }finally{await client.end();}
}
