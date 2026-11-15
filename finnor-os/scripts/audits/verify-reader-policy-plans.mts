import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createNativeOwnerDatabase} from '../s7/native-owner-database.mjs';

const output=process.argv[2];assert(typeof output==='string'&&output.startsWith('/'),'External evidence directory required');
await mkdir(output,{recursive:true});
const database=await createNativeOwnerDatabase();
const {migrate}=await import('../../packages/db/migrate');
const replayed=await migrate(`postgres://finnor:finnor@127.0.0.1:${database.port}/finnor`);
assert.equal(replayed.length,0,'Migration replay must be empty');
const results:Array<{role:string;table:string;status:'PASS'|'FAIL';code?:string;permission?:string}>=[];
const tenant=randomUUID(),principal=randomUUID();
try{
 const roles=(await database.admin.query<{rolname:string}>(`SELECT rolname FROM pg_roles
  WHERE rolname LIKE 'finnor\\_%' ESCAPE '\\' AND NOT rolsuper AND NOT rolbypassrls ORDER BY rolname`)).rows;
 for(const {rolname:role} of roles){
  assert(/^[a-z_][a-z0-9_]*$/.test(role));
  const tables=(await database.admin.query<{name:string}>(`SELECT c.relname name FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os' AND c.relkind IN ('r','p')
   AND has_table_privilege($1,c.oid,'SELECT') ORDER BY c.relname`,[role])).rows;
  await database.admin.query('BEGIN');
  try{
   await database.admin.query(`SET LOCAL ROLE ${role}`);
   await database.admin.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[tenant,principal]);
   for(const {name:table} of tables){
    assert(/^[a-z_][a-z0-9_]*$/.test(table));
    await database.admin.query('SAVEPOINT reader_policy_plan');
    try{await database.admin.query(`EXPLAIN (FORMAT JSON) SELECT * FROM finnor_os."${table}" LIMIT 0`);results.push({role,table,status:'PASS'});}
    catch(error){const failure=error as Error&{code?:string};results.push({role,table,status:'FAIL',code:failure.code,
     permission:/^permission denied for (?:function|table|schema) ([a-zA-Z0-9_.]+)$/.exec(failure.message)?.[1]});await database.admin.query('ROLLBACK TO SAVEPOINT reader_policy_plan');}
    finally{await database.admin.query('RELEASE SAVEPOINT reader_policy_plan');}
   }
  }finally{await database.admin.query('ROLLBACK');}
 }
 const privacy:Array<{role:string;visible:boolean;expected:boolean}>=[];
 await database.admin.query('BEGIN');
 try{
  await database.admin.query("SET app.test_vertical_mode='explicit'");
  await database.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Reader policy privacy fixture')",[tenant,randomUUID()]);
  await database.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[principal,tenant,principal+'@test.invalid']);
  const body={schema:'CONTROLLED_PRIVACY_PROBE',owner:'Y4_CONFIDENTIAL_RELEASE',value:randomUUID()};
  const digest=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  await database.admin.query("INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,'{}'::jsonb)",[tenant,principal,digest,JSON.stringify(body)]);
  // Temporary predicate access probes its nested decision without a source-table
  // or business grant. All fixture rows and this grant are rolled back.
  await database.admin.query('GRANT EXECUTE ON FUNCTION finnor_os.y4_s5_visible(uuid,text) TO finnor_v1_checker');
  for(const role of ['finnor_app','finnor_closing_checker','finnor_closing_broker','finnor_v1_checker']){
   await database.admin.query(`SET LOCAL ROLE ${role}`);
   await database.admin.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[tenant,principal]);
   const visible=(await database.admin.query('SELECT finnor_os.y4_s5_visible($1,$2) visible',[tenant,digest])).rows[0].visible as boolean;
   privacy.push({role,visible,expected:role==='finnor_app'});
   await database.admin.query('RESET ROLE');
  }
 }finally{await database.admin.query('ROLLBACK');}
 const persisted=(await database.admin.query('SELECT count(*)::int count FROM finnor_os.tenants WHERE id=$1',[tenant])).rows[0].count;
 assert.equal(persisted,0,'Controlled privacy rows must be rolled back');
 const failures=results.filter(row=>row.status==='FAIL');
 const privacyFailures=privacy.filter(row=>row.visible!==row.expected);
 const root=resolve(import.meta.dirname,'../../..');
 const sourcePath='finnor-os/packages/db/migrations/postz_z1_shared_work.sql';
 await writeFile(join(output,'result.json'),JSON.stringify({schema:'finnor.native-reader-policy-plans.v1',status:failures.length||privacyFailures.length?'FAIL':'PASS',
  source:Object.fromEntries(await Promise.all([sourcePath,'finnor-os/packages/db/migrations/postz_zzz_native_reader_policy_acl.sql','finnor-os/scripts/audits/verify-reader-policy-plans.mts'].map(async path=>[path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')]))),
  migrationsApplied:database.migrations.length,migrationReplay:replayed.length,roleCount:new Set(results.map(row=>row.role)).size,planCount:results.length,failures,results,privacy,privacyFailures,persistedProbeTenants:persisted,
  qualification:'Actual PostgreSQL all-role query planning and four controlled confidential-recipient predicate probes. Test rows and temporary grants rolled back; no settlement or phase qualification.',
  rerun:'From finnor-os: node --import=tsx scripts/audits/verify-reader-policy-plans.mts <absolute external evidence directory>'},null,2));
 assert(results.length>0);assert.equal(failures.length,0,'Every existing reader entitlement must remain plannable');
 assert.equal(privacyFailures.length,0,'Native readers cannot become confidential recipients by spoofing an owner');
}finally{await database.stop();}
